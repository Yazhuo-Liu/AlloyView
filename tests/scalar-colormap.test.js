import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAppearance } from '../src/appearance.js';
import { colorsByProperty } from '../src/render/palette.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';
import { prepareScalarColorData, scalarColorSettings, scalarPreviewAtomVisible } from '../src/render/scalar-colormap.js';

const stops = [[0, 0, 0, 128], [0.5, 0, 255, 0], [1, 128, 0, 0]];

test('scalar preview preserves small differences around large offsets and tiny physical values without changing source arrays', () => {
  for (const data of [Float64Array.of(1e12, 1e12 + 0.001, 1e12 + 0.002), Float64Array.of(1e-300, 2e-300, 3e-300), Float64Array.of(-1e308, 0, 1e308)]) {
    const before = data.slice(), input = prepareScalarColorData(data);
    assert.deepEqual(data, before);
    assert.equal(input.data, data);
    assert.ok(input.safe);
    assert.ok(input.values.every(Number.isFinite));
    assert.ok(input.values[0] < input.values[1] && input.values[1] < input.values[2]);
  }
});

test('preview rejects collapsed or overflowing float32 ranges so exact CPU coloring remains available', () => {
  const data = Float64Array.of(0, 1e12, 1e12 + 0.001, 2e12), input = prepareScalarColorData(data);
  assert.equal(scalarColorSettings(input, { minimum: 1e12, maximum: 1e12 + 0.001, colorStops: stops }).safe, false);
  assert.equal(scalarColorSettings(input, { minimum: 0, maximum: 2e12, colorStops: stops }).safe, true);
  const extreme = prepareScalarColorData(Float64Array.of(-1e308, 1e308));
  assert.equal(scalarColorSettings(extreme, { minimum: -1e308, maximum: 1e308, colorStops: stops }).safe, false,
    'retain the established CPU behavior when its source span overflows');
  const tiny = prepareScalarColorData(Float64Array.of(1e-300, 2e-300));
  assert.equal(scalarColorSettings(tiny, { minimum: -1e300, maximum: 1e300, colorStops: stops }).safe, false);
  const undefinedInput = prepareScalarColorData(Float64Array.of(NaN, Infinity));
  assert.ok(Number.isFinite(undefinedInput.origin) && Number.isFinite(undefinedInput.scale));
});

test('range hiding during preview uses inclusive exact limits for picking and keeps NaN visible when hiding is off', () => {
  const input = prepareScalarColorData(Float64Array.of(-1, 0, 1, 2, NaN, Infinity));
  const preview = scalarColorSettings(input, { minimum: 0, maximum: 1, colorStops: stops });
  assert.deepEqual(Array.from(input.data, (_, atom) => scalarPreviewAtomVisible(preview, atom)), [false, true, true, false, false, false]);
  preview.hideOutside = false;
  assert.ok(Array.from(input.data, (_, atom) => scalarPreviewAtomVisible(preview, atom)).every(Boolean));
});

test('appearance marks explicit scalar overrides even when they equal the current scalar palette', () => {
  const frame = { ids: Uint32Array.of(7, 8, 9), types: Uint8Array.of(0, 0, 0), typeLabels: ['Ni'] };
  const colors = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
  const result = applyAppearance(frame, colors, null, { atoms: [{ id: 7, color: '#010203' }] }, {
    elementColors: false, trackColorOverrides: true,
    selectionGroups: [{ id: 'group', name: 'G', atomIds: ['8'], color: '#040506', visible: true }],
  });
  assert.deepEqual(result.colors, colors);
  assert.deepEqual([...result.colorOverrides], [255, 255, 0]);
  assert.equal(applyAppearance(frame, colors, null).colorOverrides, undefined, 'ordinary appearance edits allocate no extra mask');
});

function rendererFixture(data) {
  const uploads = [], renderer = Object.create(WebGLRenderer.prototype);
  let buffer;
  const gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2, DYNAMIC_DRAW: 3, FLOAT: 4, UNSIGNED_BYTE: 5, MAX_TEXTURE_SIZE: 6,
    TEXTURE0: 10, TEXTURE_2D: 7, R32F: 8, RED: 9,
    bindVertexArray() {}, bindBuffer(target, value) { buffer = value; },
    bufferData(target, values) { uploads.push({ buffer, values }); },
    vertexAttribPointer() {}, vertexAttribDivisor() {}, enableVertexAttribArray() {}, disableVertexAttribArray() {},
    getParameter() { return 4096; }, createTexture() { return {}; }, activeTexture() {}, bindTexture() {}, texParameteri() {},
    texImage2D(...args) { uploads.push({ texture: true, values: args.at(-1) }); },
  };
  Object.assign(renderer, { gl, frame: { fractional: new Float64Array(data.length * 3).fill(0.5) }, atomCount: data.length,
    sphereVao: {}, scalarColorBuffer: {}, colorOverrideBuffer: {}, colorBuffer: {}, visibility: new Uint8Array(data.length).fill(255),
    sliceAxis: 2, sliceMaximum: 1, repetitions: [1, 1, 1], requestRender() {}, cancelSelectionGesture() {} });
  return { renderer, uploads };
}

test('repeated range edits upload the scalar and override buffers once and commit the exact CPU palette', () => {
  const data = Float64Array.of(0, 0.4, 0.6, 1), { renderer, uploads } = rendererFixture(data);
  let commits = 0;
  const onCommit = () => {
    commits++;
    renderer.setColors(colorsByProperty({ name: 'value', data }, { minimum: 0.2, maximum: 0.8 }, 'viridis').colors);
  };
  const preview = renderer.setScalarColorPreview(data, { minimum: 0, maximum: 1, colorStops: stops, onCommit });
  const initialUploads = uploads.length;
  for (let index = 1; index <= 20; index++) renderer.setScalarColorPreview(data, {
    minimum: index / 100, maximum: 1 - index / 100, colorStops: stops, input: preview.input, onCommit,
  });
  assert.equal(uploads.length, initialUploads, 'all drag ticks only change uniforms');
  assert.equal(uploads.filter(upload => upload.buffer === renderer.colorBuffer).length, 0, 'no CPU color upload during dragging');
  assert.equal(renderer.isAtomVisible(0), false); assert.equal(renderer.isAtomVisible(1), true);
  renderer.finishScalarColorPreview(); renderer.finishScalarColorPreview();
  assert.equal(commits, 1, 'commit is idempotent after the exact palette clears the preview');
  assert.deepEqual(renderer.atomColors, colorsByProperty({ name: 'value', data }, { minimum: 0.2, maximum: 0.8 }, 'viridis').colors);
  assert.equal(renderer.scalarColorPreview, null);
  assert.equal(uploads.filter(upload => upload.buffer === renderer.colorBuffer).length, 1);
});

test('unsafe preview limits leave the exact palette intact and do not upload incomplete scalar data', () => {
  const data = Float64Array.of(0, 1e12, 1e12 + 0.001, 2e12), { renderer, uploads } = rendererFixture(data);
  const exact = colorsByProperty({ name: 'value', data }).colors;
  renderer.atomColors = exact;
  assert.equal(renderer.setScalarColorPreview(data, { minimum: 1e12, maximum: 1e12 + 0.001, colorStops: stops }), null);
  assert.equal(renderer.atomColors, exact); assert.equal(renderer.scalarColorPreview, null);
  assert.equal(uploads.length, 0);
});
