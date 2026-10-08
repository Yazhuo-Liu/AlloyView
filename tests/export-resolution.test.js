import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_EXPORT_RESOLUTION, EXPORT_TILE_BYTES, normalizeExportResolution, resolveExportSize,
  validateExportSize, planExportTiles, tileProjection, exportTileLimit } from '../src/render/export-resolution.js';
import { orthographic, perspective, transformPoint } from '../src/render/math.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { captureOffscreen } from '../src/render/offscreen-export.js';

test('export presets and scaled sizes resolve against the current view without changing it', () => {
  assert.deepEqual(normalizeExportResolution(), DEFAULT_EXPORT_RESOLUTION);
  assert.deepEqual(resolveExportSize({}, 640, 480), { width: 640, height: 480 });
  assert.deepEqual(resolveExportSize({ mode: '1080p' }, 640, 480), { width: 1920, height: 1080 });
  assert.deepEqual(resolveExportSize({ mode: '4k' }, 640, 480), { width: 3840, height: 2160 });
  assert.deepEqual(resolveExportSize({ mode: '2x' }, 640, 480), { width: 1280, height: 960 });
  assert.deepEqual(resolveExportSize({ mode: '4x' }, 640, 480), { width: 2560, height: 1920 });
  assert.deepEqual(resolveExportSize({ mode: 'custom', width: 6000, height: 4000 }, 640, 480), { width: 6000, height: 4000 });
});

test('export dimensions reject excess memory, noninteger values and unsupported settings', () => {
  assert.deepEqual(validateExportSize(16384, 1), { width: 16384, height: 1 });
  for (const [width, height] of [[0, 1], [1, 0], [-1, 1], [1.5, 5], [NaN, 5], [16385, 1], ['640', 480]]) {
    assert.throws(() => validateExportSize(width, height), /whole numbers/);
  }
  assert.throws(() => validateExportSize(6000, 6000), /32 megapixels/);
  assert.throws(() => resolveExportSize({ mode: '4x' }, 4000, 4000), /32 megapixels/);
  assert.throws(() => normalizeExportResolution({ mode: 'huge' }), /supported/);
  assert.throws(() => normalizeExportResolution({ lockAspect: 'true' }), /aspect lock/);
  assert.throws(() => normalizeExportResolution({ magic: true }), /Unknown/);
});

test('resolution recipes are validated and older recipes retain current viewport exports', () => {
  const resolution = { mode: 'custom', width: 2345, height: 1234, lockAspect: false };
  const recipe = createConfiguration({ settings: { display: { png: { resolution } } } });
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.display.png.resolution, resolution);
  delete recipe.settings.display.png.resolution;
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.display.png.resolution, DEFAULT_EXPORT_RESOLUTION);
  recipe.settings.display.png.resolution = { ...resolution, width: 20000 };
  assert.throws(() => parseConfiguration(JSON.stringify(recipe)), /settings\.display\.png\.resolution/);
});

test('tile cores cover an irregular image once while gutters stay inside the render target', () => {
  const width = 257, height = 143, tiles = planExportTiles(width, height, 64, 48);
  const coverage = new Uint8Array(width * height);
  assert.equal(tiles.length, 20);
  for (const tile of tiles) {
    assert.ok(tile.renderWidth <= 64 && tile.renderHeight <= 48);
    assert.ok(tile.readX >= 0 && tile.readY >= 0);
    assert.ok(tile.readX + tile.width <= tile.renderWidth && tile.readY + tile.height <= tile.renderHeight);
    assert.ok(tile.renderX >= 0 && tile.renderY >= 0);
    assert.ok(tile.renderX + tile.renderWidth <= width && tile.renderY + tile.renderHeight <= height);
    for (let y = tile.y; y < tile.y + tile.height; y++) for (let x = tile.x; x < tile.x + tile.width; x++) coverage[y * width + x]++;
  }
  assert.ok(coverage.every(count => count === 1));
  assert.equal(planExportTiles(100, 100, 100, 100).length, 1, 'an image within the limit stays in one framebuffer');
  assert.throws(() => planExportTiles(100, 100, 3, 3), /cannot allocate/);
});

test('cropped perspective and parallel projections preserve full-image coordinates and depth', () => {
  const width = 1600, height = 900, tiles = planExportTiles(width, height, 512, 256);
  const projections = [perspective(0.7, width / height, 0.1, 100), orthographic(-16, 16, -9, 9, 0.1, 100)];
  for (const projection of projections) for (const tile of tiles) for (const point of [[0, 0, -10], [3, -2, -15], [-4, 2, -9]]) {
    const before = transformPoint(projection, ...point), after = transformPoint(tileProjection(projection, width, height, tile), ...point);
    const x = (before[0] / before[3] + 1) * width / 2, y = (before[1] / before[3] + 1) * height / 2;
    const tileX = (after[0] / after[3] + 1) * tile.renderWidth / 2 + tile.renderX;
    const tileY = (after[1] / after[3] + 1) * tile.renderHeight / 2 + tile.renderY;
    assert.ok(Math.abs(x - tileX) < 0.0002 && Math.abs(y - tileY) < 0.0002);
    assert.equal(after[2], before[2]); assert.equal(after[3], before[3]);
  }
});

test('tile limits honor both GPU axes and the multisample working memory budget', () => {
  const gl = { MAX_RENDERBUFFER_SIZE: 1, MAX_VIEWPORT_DIMS: 2,
    getParameter(key) { return key === 1 ? 16384 : [4096, 1024]; } };
  const limit = exportTileLimit(gl, 4);
  assert.equal(limit.height, 1024);
  assert.ok(limit.width ** 2 * (8 * 4 + 12) <= EXPORT_TILE_BYTES);
  assert.deepEqual(exportTileLimit(gl, 4, 100), { width: 100, height: 100 });
});

test('offscreen capture releases all allocated targets and restores GL bindings after a drawing failure', () => {
  let next = 0;
  const allocated = new Set(), removed = new Set(), calls = [];
  const keys = ['MAX_RENDERBUFFER_SIZE', 'MAX_VIEWPORT_DIMS', 'DRAW_FRAMEBUFFER_BINDING', 'READ_FRAMEBUFFER_BINDING',
    'RENDERBUFFER_BINDING', 'VIEWPORT', 'SCISSOR_BOX', 'SCISSOR_TEST', 'RENDERBUFFER', 'RGBA8', 'SAMPLES',
    'DEPTH_COMPONENT24', 'FRAMEBUFFER', 'FRAMEBUFFER_COMPLETE', 'NO_ERROR', 'COLOR_ATTACHMENT0', 'DEPTH_ATTACHMENT',
    'DRAW_FRAMEBUFFER', 'READ_FRAMEBUFFER'];
  const gl = Object.fromEntries(keys.map((name, index) => [name, index + 1]));
  Object.assign(gl, { isContextLost: () => false, isEnabled: () => true,
    getParameter(key) {
      if (key === this.MAX_RENDERBUFFER_SIZE) return 4096;
      if (key === this.MAX_VIEWPORT_DIMS) return [4096, 4096];
      if (key === this.VIEWPORT) return [1, 2, 640, 480];
      if (key === this.SCISSOR_BOX) return [3, 4, 10, 20];
      return `saved-${key}`;
    },
    getInternalformatParameter: () => [4],
    createFramebuffer() { const resource = `frame-${next++}`; allocated.add(resource); return resource; },
    createRenderbuffer() { const resource = `buffer-${next++}`; allocated.add(resource); return resource; },
    deleteFramebuffer(resource) { removed.add(resource); }, deleteRenderbuffer(resource) { removed.add(resource); },
    checkFramebufferStatus() { return this.FRAMEBUFFER_COMPLETE; }, getError() { return this.NO_ERROR; },
  });
  for (const name of ['bindFramebuffer', 'bindRenderbuffer', 'renderbufferStorageMultisample', 'renderbufferStorage',
    'framebufferRenderbuffer', 'disable', 'enable', 'viewport', 'scissor']) gl[name] = (...args) => calls.push([name, ...args]);
  assert.throws(() => captureOffscreen(gl, {}, 320, 240, () => { throw new Error('drawing failed'); }), /drawing failed/);
  assert.deepEqual(removed, allocated);
  assert.ok(calls.some(call => call[0] === 'bindFramebuffer' && call[1] === gl.DRAW_FRAMEBUFFER && call[2] === `saved-${gl.DRAW_FRAMEBUFFER_BINDING}`));
  assert.ok(calls.some(call => call[0] === 'bindFramebuffer' && call[1] === gl.READ_FRAMEBUFFER && call[2] === `saved-${gl.READ_FRAMEBUFFER_BINDING}`));
  assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(['viewport', 1, 2, 640, 480])));
  assert.deepEqual(calls.at(-1), ['enable', gl.SCISSOR_TEST]);
});
