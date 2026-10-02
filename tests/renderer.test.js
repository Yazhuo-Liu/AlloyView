import assert from 'node:assert/strict';
import test from 'node:test';

import { axisDirectionsFromView, drawLegendOverlay, WebGLRenderer } from '../src/render/webgl-renderer.js';

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

test('display coordinates can change without replacing the analysis frame', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  const frame = { positions: new Float32Array(6) };
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
