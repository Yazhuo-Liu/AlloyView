import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell } from '../src/data/model.js';

import { axisDirectionsFromView, drawAxesOverlay, drawLegendOverlay, WebGLRenderer } from '../src/render/webgl-renderer.js';

test('cell box visibility is renderer state and requests a redraw', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  let redraws = 0;
  renderer.requestRender = () => { redraws += 1; };

  renderer.setCellVisible(false);
  assert.equal(renderer.cellVisible, false);
  assert.equal(redraws, 1);

  renderer.setCellVisible(true);
  assert.equal(renderer.cellVisible, true);
  assert.equal(redraws, 2);
});

test('closing a frame releases atom data and GPU buffers while retaining the renderer', () => {
  const r = Object.create(WebGLRenderer.prototype), sizes = new Map();
  Object.assign(r, { frame: {}, displayPositions: new Float32Array(300), atomCount: 100,
    displayAtomCount: 400, atomRadii: new Float32Array(100), visibility: new Uint8Array(100),
    selectionVisibility: new Uint8Array(100),
    sceneBounds: {}, displayCell: {}, selected: 9, requestRender() {}, onProjectionChange() {},
    interactions: { reset() {} } });
  let bound;
  r.gl = { ARRAY_BUFFER: 1, STATIC_DRAW: 2, bindBuffer(target, buffer) { bound = buffer; },
    bufferData(target, size) { sizes.set(bound, size); } };
  for (const name of ['positionBuffer', 'colorBuffer', 'fractionalBuffer', 'visibilityBuffer', 'radiusBuffer', 'cellBuffer']) r[name] = {};
  r.clearFrame();
  assert.equal(r.frame, null); assert.equal(r.displayPositions, null); assert.equal(r.atomRadii, null);
  assert.equal(r.selectionVisibility, null);
  assert.equal(r.atomCount, 0); assert.equal(r.displayAtomCount, 0); assert.equal(r.sceneBounds, null);
  assert.equal(r.selected, -1); assert.equal(r.projectionMode, 'perspective');
  assert.equal(sizes.size, 6); assert.ok([...sizes.values()].every(size => size === 0));
});

test('display coordinates can change without replacing the analysis frame', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  const frame = { positions: new Float32Array(6), cell: createCell({ vectors: [8, 0, 0, 0, 8, 0, 0, 0, 8] }) };
  const unwrapped = new Float32Array([0, 0, 0, 4, 5, 6]);
  const uploads = [];
  let redraws = 0;
  renderer.frame = frame;
  renderer.atomCount = 2;
  renderer.positionBuffer = {};
  renderer.gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88E4,
    bindBuffer(target, buffer) { uploads.push(['bind', target, buffer]); },
    bufferData(target, data, usage) { uploads.push(['data', target, data, usage]); },
    finish() {},
  };
  renderer.requestRender = () => { redraws += 1; };

  renderer.setDisplayPositions(unwrapped);

  assert.equal(renderer.frame, frame);
  assert.equal(renderer.displayPositions, unwrapped);
  assert.equal(uploads[1][2], unwrapped);
  assert.equal(redraws, 1);
});

test('per-atom visibility mask uploads without replacing the analysis frame', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  const uploads = [];
  renderer.frame = {};
  renderer.atomCount = 3;
  renderer.visibilityBuffer = {};
  renderer.gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88E8,
    bindBuffer(target, buffer) { uploads.push(['bind', target, buffer]); },
    bufferData(target, data, usage) { uploads.push(['data', target, data, usage]); },
  };
  renderer.requestRender = () => {};
  const mask = new Uint8Array([255, 0, 255]);

  renderer.setVisibility(mask);
  assert.equal(renderer.visibility, mask);
  assert.equal(uploads[1][2], mask);
  assert.throws(() => renderer.setVisibility(new Uint8Array(2)), /does not match/);
});

test('selection visibility reaches attached primitives while malformed masks leave renderer state unchanged', () => {
  const renderer = Object.create(WebGLRenderer.prototype), uploads = [], primitiveMasks = [];
  const frame = { properties: { energy: new Float64Array([1, 2, 100]) } };
  Object.assign(renderer, { frame, atomCount: 3, visibilityBuffer: {}, requestRender() {},
    gl: { ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, bindBuffer() {}, bufferData(target, data) { uploads.push(data); } },
    primitiveLayer: { updatePositions(owner, regenerateShifts) {
      primitiveMasks.push([owner.visibility, owner.selectionVisibility, regenerateShifts]);
    } },
  });
  const mask = new Uint8Array([255, 0, 0]), selections = new Uint8Array([255, 255, 0]);
  renderer.setVisibility(mask, { selectionVisibility: selections });
  assert.equal(renderer.frame, frame);
  assert.deepEqual([...frame.properties.energy], [1, 2, 100]);
  assert.equal(renderer.selectionVisibility, selections);
  assert.deepEqual(primitiveMasks, [[mask, selections, false]]);
  assert.deepEqual(uploads, [mask]);
  assert.throws(() => renderer.setVisibility(null, { selectionVisibility: new Uint8Array(2) }), /selection visibility mask/);
  assert.equal(renderer.visibility, mask);
  assert.equal(renderer.selectionVisibility, selections);
  assert.equal(uploads.length, 1, 'invalid masks do not change GPU buffers');
  renderer.setVisibility(mask);
  assert.equal(renderer.selectionVisibility, null, 'a regular visibility update clears selection-specific hiding');
  assert.deepEqual(primitiveMasks[1], [mask, null, false]);
});

test('transparent PNG export uses a transparent render and restores the viewport', () => {
  const originalDocument = globalThis.document;
  const renderOptions = [];
  let exportedImage;
  let exportedType;

  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext(type) {
          assert.equal(type, '2d');
          return {
            createImageData(width, height) {
              return { data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData(image) { exportedImage = image; },
          };
        },
        toBlob(callback, type) {
          exportedType = type;
          callback(null);
        },
      };
    },
  };

  try {
    const renderer = Object.create(WebGLRenderer.prototype);
    renderer.canvas = { width: 1, height: 2 };
    renderer.gl = {
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      readPixels(x, y, width, height, format, type, pixels) {
        assert.deepEqual([x, y, width, height, format, type], [0, 0, 1, 2, 0x1908, 0x1401]);
        // WebGL returns bottom-to-top; the exported 2D image must be top-to-bottom.
        pixels.set([10, 20, 30, 40, 50, 60, 70, 80]);
      },
    };
    renderer.render = (timestamp, options) => { renderOptions.push(options); };

    renderer.exportPng('transparent.png', { includeBackground: false });

    assert.deepEqual(renderOptions, [
      { transparentBackground: true, trackStats: false },
      { trackStats: false },
    ]);
    assert.equal(exportedType, 'image/png');
    assert.deepEqual([...exportedImage.data], [50, 60, 70, 80, 10, 20, 30, 40]);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('PNG scalar legend overlay uses the selected color map and visible range', () => {
  const texts = [];
  const stops = [];
  const context = {
    save() {},
    restore() {},
    fillRect() {},
    strokeRect() {},
    fillText(value) { texts.push(value); },
    createLinearGradient() {
      return { addColorStop(position, color) { stops.push([position, color]); } };
    },
  };

  drawLegendOverlay(context, {
    kind: 'scalar',
    title: 'coordination',
    unit: '',
    minimum: 8,
    maximum: 12,
    schemeLabel: 'Viridis',
    colorStops: [[0, 68, 1, 84], [1, 253, 231, 37]],
  }, 640, 480);

  assert.deepEqual(texts, ['coordination', 'Viridis', '8', '12']);
  assert.deepEqual(stops, [[0, 'rgb(68 1 84)'], [1, 'rgb(253 231 37)']]);
});

test('PNG atom-type legend overlay draws the current type swatches', () => {
  const texts = [];
  const arcs = [];
  const context = {
    save() {},
    restore() {},
    fillRect() {},
    strokeRect() {},
    fillText(value) { texts.push(value); },
    beginPath() {},
    arc(...values) { arcs.push(values); },
    fill() {},
  };

  drawLegendOverlay(context, {
    kind: 'types',
    title: 'Atom type',
    items: [
      { label: 'Al', color: [201, 198, 181] },
      { label: 'Ni', color: [214, 194, 151] },
    ],
  }, 640, 480);

  assert.deepEqual(texts, ['Atom type', 'Al', 'Ni']);
  assert.equal(arcs.length, 2);
});

test('empty scalar PNG legends keep their title, unit and palette without inventing a gradient or numeric range', () => {
  for (const includeBackground of [true, false]) {
    const texts = [], rectangles = [];
    const context = { save() {}, restore() {}, strokeRect() {},
      fillRect(...values) { rectangles.push(values); },
      fillText(value) { texts.push(value); },
      createLinearGradient() { assert.fail('a scalar without visible finite values has no color gradient'); },
    };
    drawLegendOverlay(context, { kind: 'scalar', title: 'atomicVolume', unit: 'Å³',
      minimum: null, maximum: null, emptyRange: true, schemeLabel: 'Viridis',
      colorStops: [[0, 68, 1, 84], [1, 253, 231, 37]] }, 640, 480, 1, { includeBackground });
    assert.deepEqual(texts, ['atomicVolume [Å³]', 'Viridis', 'No visible finite values']);
    assert.equal(rectangles.length, includeBackground ? 1 : 0, 'only the optional panel background is painted');
  }
});

test('transparent PNG legends keep text and color keys without a panel background', () => {
  for (const legend of [
    { kind: 'types', title: 'Atom type', items: [{ label: 'Al', color: [201, 198, 181] }] },
    { kind: 'scalar', title: 'coordination', minimum: 8, maximum: 12, colorStops: [[0, 0, 0, 0], [1, 255, 255, 255]] },
  ]) {
    const rectangles = [];
    const texts = [];
    let swatches = 0;
    const context = {
      save() {}, restore() {}, beginPath() {}, arc() {},
      fill() { swatches += 1; },
      fillRect(...args) { rectangles.push(args); },
      strokeRect() {},
      fillText(value) { texts.push(value); },
      createLinearGradient() { return { addColorStop() {} }; },
    };
    drawLegendOverlay(context, legend, 640, 480, 1, { includeBackground: false });
    assert.equal(texts[0], legend.title);
    if (legend.kind === 'types') {
      assert.equal(swatches, 1);
      assert.deepEqual(texts, ['Atom type', 'Al']);
      assert.deepEqual(rectangles, []);
    } else {
      assert.deepEqual(texts, ['coordination', '8', '12']);
      assert.equal(rectangles.length, 1);
      assert.equal(rectangles[0][3], 10); // Only the color bar is filled.
    }
  }
});

test('standard views set a constrained camera orientation and orthographic projection', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  renderer.pan = [2, 3, 4];
  renderer.requestRender = () => {};
  let projection;
  renderer.onProjectionChange = (value) => { projection = value; };

  renderer.setView('front');
  assert.equal(renderer.yaw, 0);
  assert.equal(renderer.pitch, 0);
  assert.deepEqual(renderer.pan, [0, 0, 0]);
  assert.equal(renderer.projectionMode, 'orthographic');
  assert.equal(projection, 'orthographic');

  renderer.setView('top');
  assert.equal(renderer.pitch, Math.PI / 2);
  assert.deepEqual(renderer.cameraOrientation().upHint, [0, 1, 0]);
});

test('projection changes notify the segmented control', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  renderer.requestRender = () => {};
  let projection;
  renderer.onProjectionChange = (value) => { projection = value; };

  renderer.setProjection('orthographic');
  assert.equal(renderer.projectionMode, 'orthographic');
  assert.equal(projection, 'orthographic');
  assert.throws(() => renderer.setProjection('fish-eye'), /Unknown projection mode/);
});

test('light backgrounds switch the cell box to a darker contrast color', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  renderer.requestRender = () => {};

  renderer.setBackground('#ffffff');
  assert.deepEqual(renderer.cellColor, [0.22, 0.34, 0.38]);
  renderer.setBackground('#000000');
  assert.deepEqual(renderer.cellColor, [0.62, 0.78, 0.81]);
});

test('axis tripod directions use global Cartesian axes in screen space', () => {
  const axes = axisDirectionsFromView(new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]));
  assert.deepEqual(axes.x, { x: 1, y: -0, depth: 0 });
  assert.deepEqual(axes.y, { x: 0, y: -1, depth: 0 });
  assert.deepEqual(axes.z, { x: 0, y: -0, depth: 1 });
});

test('PNG arrows follow camera rotation, draw XYZ labels and leave the background transparent', () => {
  const lines = [], labels = [];
  const context = { save() {}, restore() {}, beginPath() {}, arc() {}, moveTo() {},
    lineTo(x, y) { lines.push([x, y]); }, stroke() {}, strokeText() {},
    fillText(label, x, y) { labels.push([label, x, y]); },
    fillRect() { assert.fail('axes must not create an opaque background'); } };
  const axes = axisDirectionsFromView(new Float32Array([
    0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]));
  drawAxesOverlay(context, axes, 640, 480);
  assert.deepEqual(labels.map(item => item[0]), ['X', 'Y', 'Z']);
  assert.ok(labels[0][2] < 415, 'rotated X points upward');
  assert.ok(labels[1][1] < 575, 'rotated Y points left');
  assert.ok(lines.length >= 4);
});
