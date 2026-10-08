import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-export-resolution-'));
const trajectory = resolve(directory, 'export-fixture.xyz');
const frame = step => ['8', `Lattice="6 0 0 0 6 0 0 0 6" Properties=species:S:1:pos:R:3:id:I:1:q:R:1 pbc="T T T" Step=${step}`,
  ...Array.from({ length: 8 }, (_, atom) => `Fe ${1 + (atom & 1) * 2} ${1 + (atom >> 1 & 1) * 2} ${1 + (atom >> 2 & 1) * 2} ${atom + 1} ${atom + step}`), ''].join('\n');
await writeFile(trajectory, frame(0) + frame(100));

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(Navigator.prototype,"hardwareConcurrency",{configurable:true,get:()=>4});' });
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
      throw new Error(`${label}: ${await evaluate('document.getElementById("toast")?.textContent')}`);
    }
    await waitFor('document.readyState==="complete" && document.getElementById("export-resolution")', 'Application startup');
    await evaluate(`(${installChecks.toString()})()`);
    await evaluate('if(document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true")document.getElementById("enable-gpu-computing").click()');
    const { root: dom } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: dom.nodeId, selector: '#file-input' });
    await call('DOM.setFileInputFiles', { nodeId, files: [trajectory] });
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    await waitFor('exportChecks.renderer?.frame.ids.length===8 && document.getElementById("loading").hidden', 'Fixture load');
    const change = (id, value) => evaluate(`exportChecks.change(${JSON.stringify(id)},${JSON.stringify(value)})`);
    async function download(id) {
      await evaluate(`exportChecks.beginDownload();document.getElementById(${JSON.stringify(id)}).click()`);
      try { await waitFor('Boolean(exportChecks.download?.blob)', `${id} download`); return await evaluate('exportChecks.finishDownload()'); }
      finally { await evaluate('exportChecks.restoreDownload()'); }
    }
    assert.equal(await evaluate('exportChecks.defaultEquivalent()'), true, 'Current viewport preserves existing capture bytes');
    const camera = await evaluate('exportChecks.camera()');
    await change('export-resolution', '1080p');
    const hd = await download('export-png'); assert.deepEqual(hd.size, [1920, 1080]);
    assert.equal(await evaluate('exportChecks.camera()'), camera, 'HD export restores interactive matrices and camera');
    await change('export-resolution', '4k');
    const fourK = await download('export-png'); assert.deepEqual(fourK.size, [3840, 2160]);
    const sheet = await download('export-multiview'); assert.deepEqual(sheet.size, [3840, 2160], 'chosen size describes the final six-view sheet');
    assert.equal(await evaluate('exportChecks.camera()'), camera, 'six views restore the original camera');

    await change('export-resolution', 'custom');
    await change('export-aspect-lock', false); await change('export-width', 513); await change('export-height', 347);
    const jpg = await download('export-jpg'); assert.deepEqual(jpg.size, [513, 347]); assert.equal(jpg.type, 'image/jpeg');
    await change('compare-view', true); await waitFor('exportChecks.comparison?.frame', 'Second view');
    const second = await download('export-comparison-png'); assert.deepEqual(second.size, [513, 347]);
    await change('export-series-first', 1); await change('export-series-last', 2); await change('export-series-step', 1);
    const archive = await download('export-frame-series');
    assert.equal(archive.images.length, 2); assert.ok(archive.images.every(image => image.size[0] === 513 && image.size[1] === 347));
    await waitFor('document.getElementById("export-series-status").textContent.includes("Exported 2 frames") && exportChecks.renderer.frame.frameIndex===0', 'Frame export restoration');

    // Incomplete custom edits never poison preset exports or locked dimensions.
    await change('export-width', ''); await change('export-resolution', '1080p');
    assert.deepEqual((await download('export-png')).size, [1920, 1080]);
    await change('export-resolution', 'custom'); await change('export-width', '');
    await change('export-aspect-lock', true); await change('export-width', 800);
    const locked = await evaluate('[document.getElementById("export-width").valueAsNumber,document.getElementById("export-height").valueAsNumber]');
    const viewport = await evaluate('[exportChecks.renderer.canvas.width,exportChecks.renderer.canvas.height]');
    assert.equal(locked[1], Math.round(800 * viewport[1] / viewport[0]));
    await change('export-aspect-lock', false); await change('export-width', 6000); await change('export-height', 6000);
    await evaluate('document.getElementById("export-jpg").click()');
    assert.match(await evaluate('document.getElementById("toast").textContent'), /32 megapixels/);
    await change('export-width', 513); await change('export-height', 347);
    const recipeDownload = await download('export-configuration'), recipe = JSON.parse(recipeDownload.text);
    assert.deepEqual(recipe.settings.display.png.resolution, { mode: 'custom', width: 513, height: 347, lockAspect: false });
    await change('export-resolution', '4k');
    await evaluate(`exportChecks.importRecipe(${JSON.stringify(recipeDownload.text)})`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'Resolution recipe');
    assert.equal(await evaluate('document.getElementById("export-resolution").value'), 'custom');
    assert.deepEqual((await download('export-png')).size, [513, 347]);

    await evaluate('exportChecks.prepareLayers()');
    const comparisons = [];
    for (const projection of ['perspective', 'orthographic']) for (const transparent of [false, true]) {
      const result = await evaluate(`exportChecks.compareTiles(${JSON.stringify(projection)},${transparent})`);
      assert.ok(result.changedFraction < 0.004, JSON.stringify(result));
      assert.ok(result.seamChangedFraction < 0.02, JSON.stringify(result));
      assert.ok(result.tiles > 1 && result.samples >= 2); assert.equal(result.glError, 0);
      comparisons.push(result);
    }
    const alpha = await evaluate('exportChecks.transparentWhite()');
    assert.ok(alpha.partialPixels > 100, JSON.stringify(alpha));
    assert.ok(alpha.changedFraction < 0.006, JSON.stringify(alpha));
    const outlines = await evaluate('exportChecks.scaledOutlines()');
    assert.ok(outlines.changedPixels > 100, JSON.stringify(outlines));
    const large = await evaluate('exportChecks.largeImage()', { timeoutMs: 180_000 });
    assert.deepEqual(large.size, [6000, 4000]); assert.ok(large.tiles > 1); assert.equal(large.glError, 0);
    assert.equal(await evaluate('exportChecks.renderer.renderViewport==null && exportChecks.renderer.gl.getParameter(exportChecks.renderer.gl.DRAW_FRAMEBUFFER_BINDING)==null'), true);
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('if(document.querySelector("[data-tool-button=display]").getAttribute("aria-expanded")!=="true")document.querySelector("[data-tool-button=display]").click();document.getElementById("export-resolution").closest("details").open=true;document.getElementById("export-resolution").scrollIntoView({block:"center"})');
    await delay(150);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'mobile export controls fit the screen');
    return { hd: hd.size, fourK: fourK.size, sheet: sheet.size, jpg: jpg.size, second: second.size,
      trajectoryImages: archive.images, comparisons, alpha, outlines, large };
  }, { software: true, requireGpu: false });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }

async function installChecks() {
  const app = document.querySelector('script[type="module"][src]').src;
  const [{ WebGLRenderer }, { colorsByType }] = await Promise.all([import(new URL('./render/webgl-renderer.js', app)), import(new URL('./render/palette.js', app))]);
  const checks = window.exportChecks = {};
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) { checks[this.canvas.id === 'viewport' ? 'renderer' : 'comparison'] = this; return setFrame.apply(this, args); };
  checks.change = (id, value) => {
    const element = document.getElementById(id); if (typeof value === 'boolean') element.checked = value; else element.value = String(value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.camera = () => JSON.stringify(checks.renderer.getCameraState());
  const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  checks.defaultEquivalent = () => {
    const r = checks.renderer, a = r.captureImage(), b = r.captureImage({ resolution: { mode: 'current' } });
    const aa = pixels(a), bb = pixels(b); return a.width === b.width && a.height === b.height && aa.every((value, index) => value === bb[index]);
  };
  const oldUrl = URL.createObjectURL, oldClick = HTMLAnchorElement.prototype.click;
  checks.beginDownload = () => {
    checks.download = null;
    URL.createObjectURL = function(blob) { checks.download = { blob }; return oldUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = function() { if (checks.download) checks.download.filename = this.download; };
  };
  checks.restoreDownload = () => { URL.createObjectURL = oldUrl; HTMLAnchorElement.prototype.click = oldClick; };
  const imageSize = async blob => { const image = await createImageBitmap(blob), size = [image.width, image.height]; image.close(); return size; };
  checks.finishDownload = async () => {
    const { blob, filename } = checks.download;
    const result = { filename, type: blob.type, bytes: blob.size };
    if (blob.type.startsWith('image/')) result.size = await imageSize(blob);
    else if (blob.type.includes('json')) result.text = await blob.text();
    else if (blob.type === 'application/zip') {
      const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer); result.images = [];
      for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
        const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)), start = offset + 30 + nameLength + extra;
        result.images.push({ name, size: await imageSize(new Blob([bytes.subarray(start, start + length)], { type: 'image/png' })) }); offset = start + length;
      }
    }
    return result;
  };
  checks.importRecipe = text => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], 'export-settings.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.prepareLayers = () => {
    const r = checks.renderer;
    r.setBonds({ indices: new Uint32Array([0, 1, 0, 2, 0, 4]), vectors: new Float32Array([2, 0, 0, 0, 2, 0, 0, 0, 2]) }, { radius: .1 });
    r.setVectors(new Float32Array(Array.from({ length: 24 }, (_, index) => index % 3 === 2 ? 1 : .2)), { color: '#eeaa22', radius: .06 });
    r.setDislocationNetwork({ segments: [{ family: 'other', points: [1, 1, 4, 3, 1, 4, 3, 3, 4, 1, 3, 4, 1, 1, 4] }] }, { radius: .1 });
    const vertices = new Float64Array(Array.from({ length: 24 }, (_, index) => ((index / 3 | 0) >> index % 3 & 1) ? 1 : -1));
    r.setVoronoiCellGeometry({ atomIndex: 0, vertices, faceOffsets: new Uint32Array([0, 4, 8, 12, 16, 20, 24]),
      faceVertices: new Uint32Array([0, 2, 3, 1, 4, 5, 7, 6, 0, 1, 5, 4, 2, 6, 7, 3, 0, 4, 6, 2, 1, 3, 7, 5]) }, { enabled: true, opacity: .5 });
    r.setSelected(0); r.setSlices([{ id: 'test', normal: [1, 0, 0], position: 5 }]); r.setSliceOutlines(true);
    r.resetCamera(); r.render();
  };
  checks.compareTiles = (projection, transparent) => {
    const r = checks.renderer; r.setProjection(projection);
    const options = { resolution: { mode: 'custom', width: 801, height: 607 }, includeBackground: !transparent,
      includeAxes: true, legend: colorsByType(r.frame).legend };
    const single = r.captureImage(options), tiled = r.captureImage({ ...options, tileSize: 132 });
    const aa = pixels(single), bb = pixels(tiled), stats = r.lastExportStats;
    let changed = 0, maxDifference = 0, seamChanged = 0, seamPixels = 0;
    for (let pixel = 0; pixel < aa.length / 4; pixel++) {
      let difference = 0;
      for (let channel = 0; channel < 4; channel++) difference = Math.max(difference, Math.abs(aa[pixel * 4 + channel] - bb[pixel * 4 + channel]));
      maxDifference = Math.max(maxDifference, difference); if (difference > 5) changed++;
      const x = pixel % 801, bottomY = 606 - (pixel / 801 | 0), seam = x % 128 < 2 || bottomY % 128 < 2;
      if (seam) { seamPixels++; if (difference > 5) seamChanged++; }
    }
    return { projection, transparent, tiles: stats.tiles, samples: stats.samples, maxDifference,
      changedFraction: changed / (aa.length / 4), seamChangedFraction: seamChanged / seamPixels, glError: r.gl.getError() };
  };
  checks.transparentWhite = () => {
    const r = checks.renderer; r.setBackground('#ffffff');
    const resolution = { mode: 'custom', width: 801, height: 607 };
    const opaque = r.captureImage({ resolution }), transparent = r.captureImage({ resolution, includeBackground: false });
    const composited = document.createElement('canvas'); composited.width = opaque.width; composited.height = opaque.height;
    const context = composited.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, opaque.width, opaque.height); context.drawImage(transparent, 0, 0);
    const aa = pixels(opaque), bb = pixels(composited), tt = pixels(transparent);
    let changed = 0, partialPixels = 0, maxDifference = 0;
    for (let pixel = 0; pixel < aa.length / 4; pixel++) {
      let difference = 0; for (let channel = 0; channel < 3; channel++) difference = Math.max(difference, Math.abs(aa[pixel * 4 + channel] - bb[pixel * 4 + channel]));
      if (difference > 5) changed++; maxDifference = Math.max(maxDifference, difference);
      if (tt[pixel * 4 + 3] > 0 && tt[pixel * 4 + 3] < 255) partialPixels++;
    }
    return { partialPixels, maxDifference, changedFraction: changed / (aa.length / 4) };
  };
  checks.scaledOutlines = () => {
    const r = checks.renderer, resolution = { mode: 'custom', width: 1500, height: 1400 };
    r.setCellVisible(true); r.setSliceOutlines(true); const withEdges = pixels(r.captureImage({ resolution }));
    r.setCellVisible(false); r.setSliceOutlines(false); const noEdges = pixels(r.captureImage({ resolution }));
    let changedPixels = 0;
    for (let pixel = 0; pixel < withEdges.length / 4; pixel++) if ([0, 1, 2].some(channel => Math.abs(withEdges[pixel * 4 + channel] - noEdges[pixel * 4 + channel]) > 10)) changedPixels++;
    r.setCellVisible(true); r.setSliceOutlines(true); return { changedPixels, glError: r.gl.getError() };
  };
  checks.largeImage = async () => {
    const r = checks.renderer, started = performance.now();
    const image = r.captureImage({ resolution: { mode: 'custom', width: 6000, height: 4000 }, includeAxes: true, legend: colorsByType(r.frame).legend });
    const blob = await new Promise(resolve => image.toBlob(resolve, 'image/png'));
    const result = { size: [image.width, image.height], pngBytes: blob.size, tiles: r.lastExportStats.tiles,
      elapsedMs: performance.now() - started, glError: r.gl.getError() };
    image.width = image.height = 1; return result;
  };
}
