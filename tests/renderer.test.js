import assert from 'node:assert/strict';
import test from 'node:test';

import { WebGLRenderer } from '../src/render/webgl-renderer.js';

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
