import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

function fixture() {
  const cell = createCell({ vectors: [8, 0, 0, 2, 8, 0, 1, -1, 8] });
  const fractional = new Float64Array([.2, .3, .4, .5, .3, .4]);
  const frame = { cell, ids: Uint32Array.from([1, 2]), fractional,
    positions: fractionalToCartesian(fractional, cell), properties: [{ name: 'energy', data: new Float64Array([1, 2]) }] };
  const r = Object.create(WebGLRenderer.prototype), events = [], uploads = [];
  const canvas = new EventTarget();
  canvas.parentElement = { append(node) { this.notice = node; } };
  canvas.ownerDocument = { createElement() { return { style: {}, setAttribute() {} }; } };
  Object.assign(r, { canvas, contextLost: false, contextListeners: new Set(), frame,
    atomCount: 2, atomColors: new Uint8Array(6), atomRadii: new Float32Array([.7, .8]),
    displayPositions: frame.positions, rawDisplayPositions: frame.positions, displayFractional: fractional,
    periodicOrigin: [0, 0, 0], coordinateMode: 'wrapped', repetitions: [1, 1, 1],
    visibility: new Uint8Array([255, 0]), selectionVisibility: new Uint8Array([255, 0]),
    selected: 1, selectedAtoms: Int32Array.from([0, 1]), sliceSelectedAtoms: Int32Array.from([0, 1, -1]),
    target: [2, 3, 4], pan: [1, -2, 3], yaw: .47, pitch: -.3, roll: .2,
    distance: 12, orthographicScale: 6, projectionMode: 'orthographic', radiusScale: .75,
    sliceMode: 'planes', slices: [{ enabled: true }], sliceCount: 1,
    atomVectorFields: [], bondOptions: { visible: true, radius: .08 }, vectorOptions: {},
    frameTimes: [1, 2, 3], requestRender() { events.push('request'); }, cancelSelectionGesture() { events.push('selection cancelled'); },
    interactions: { reset() { events.push('gesture reset'); } },
    onProjectionChange() {} });
  r.gl = new Proxy({ isContextLost: () => Boolean(r.driverLost) }, {
    get(target, key) {
      if (key in target) return target[key];
      throw new Error(`No GL access is allowed while lost: ${String(key)}`);
    },
  });
  r.installContextEvents();
  r.addContextListener(status => events.push(status.state));
  return { r, frame, events, uploads };
}

test('native context loss opts into restoration, pauses rendering and refuses exports before formatting', () => {
  const { r, frame, events } = fixture();
  const mesh = { vertices: new Float64Array(9), triangles: new Uint32Array(3) };
  r.surfaceMeshLayer = { entries: new Map([['surface', { id: 'surface', mesh, options: { visible: true } }]]) };
  r.primitiveLayer = {}; r.scalarColorTexture = {}; r.ambientOcclusionBuffer = {};
  r.driverLost = true;
  const lost = new Event('webglcontextlost', { cancelable: true });
  assert.equal(r.canvas.dispatchEvent(lost), false); assert.equal(lost.defaultPrevented, true);
  assert.equal(r.contextLost, true); assert.equal(r.frame, frame);
  assert.equal(r.primitiveLayer, null); assert.equal(r.surfaceMeshLayer, null);
  assert.equal(r.surfaceMeshes()[0].mesh, mesh);
  assert.match(r.contextNotice.textContent, /Drawing and image export are paused/);
  assert.equal(r.contextNotice.hidden, false);
  r.render(); r.resize();
  assert.equal(r.pick(0, 0), -1);
  r.onBeforeCapture = () => assert.fail('export preflight must reject before UI formatting or AO');
  for (const options of [{}, { includeBackground: false }, { resolution: { mode: 'custom', width: 320, height: 240 } }]) {
    assert.throws(() => r.captureImage(options), /graphics context is unavailable/);
  }
  assert.throws(() => r.captureOffscreenImage({}), /graphics context is unavailable/);
  assert.deepEqual(events, ['selection cancelled', 'gesture reset', 'lost']);
});

test('display changes during loss retain latest CPU data and frame changes drop obsolete attached geometry', () => {
  const { r, frame } = fixture(); r.handleContextLost();
  const colors = Uint8Array.from([1, 2, 3, 4, 5, 6]), radii = new Float32Array([.5, .6]);
  r.setColors(colors); r.setAtomRadii(radii); r.setVisibility(new Uint8Array([0, 255]));
  const bond = { indices: Uint32Array.from([0, 1]), vectors: Float32Array.from([2.4, 0, 0]), shifts: new Int32Array(3), count: 1 };
  const vectors = Float32Array.from([1, 0, 0, 0, 1, 0]);
  r.setBonds(bond, { radius: .15 }); r.setVectorFields([{ id: 'force', vectors, options: { scale: 2 } }]);
  r.setSurfaceMesh('surface', { vertices: new Float64Array(9), triangles: new Uint32Array(3) });
  assert.equal(r.atomColors, colors); assert.equal(r.atomRadii, radii);
  assert.equal(r.atomBonds.indices, bond.indices); assert.equal(r.atomVectorFields[0].vectors, vectors);
  assert.equal(r.bondOptions.radius, .15); assert.equal(r.atomVectorFields[0].options.scale, 2);
  assert.deepEqual([...r.visibility], [0, 255]);
  const next = { ...frame, ids: Uint32Array.from([3, 4]), properties: [{ name: 'energy', data: new Float64Array([3, 4]) }] };
  r.setFrame(next, colors, next.positions, radii);
  assert.equal(r.frame, next); assert.equal(r.frame.properties[0].data[0], 3);
  assert.equal(r.atomBonds, null); assert.deepEqual(r.atomVectorFields, []); assert.deepEqual(r.surfaceMeshes(), []);
  assert.equal(r.contextLost, true);
});

test('a frame arriving before the queued context event cannot clear invalid GL resources', () => {
  const { r, frame } = fixture();
  const mesh = { vertices: new Float64Array(9), triangles: new Uint32Array(3) };
  r.surfaceMeshLayer = { entries: new Map([['surface', { id: 'surface', mesh, options: {} }]]),
    clear() { assert.fail('the lost layer cannot receive GL clear calls'); } };
  r.driverLost = true;
  const next = { ...frame, ids: Uint32Array.from([3, 4]) };
  r.setFrame(next, r.atomColors, next.positions, r.atomRadii);
  assert.equal(r.contextLost, true); assert.equal(r.frame, next); assert.deepEqual(r.surfaceMeshes(), []);
  // Even after an early CPU update, the native event must opt into recovery.
  const event = new Event('webglcontextlost', { cancelable: true });
  assert.equal(r.canvas.dispatchEvent(event), false); assert.equal(event.defaultPrevented, true);
  r.clearFrame(); assert.equal(r.frame, null);
});

test('restoration uploads retained arrays without resetting analyses, visibility, picks or the camera', () => {
  const { r, frame, events, uploads } = fixture();
  const camera = JSON.stringify([r.target, r.pan, r.yaw, r.pitch, r.roll, r.distance, r.orthographicScale, r.projectionMode]);
  const colors = r.atomColors, radii = r.atomRadii, visibility = r.visibility, selection = r.selectionVisibility;
  const vectors = Float32Array.from([1, 2, 3, 4, 5, 6]);
  r.atomVectorFields = [{ id: 'force', vectors, options: { scale: 2 } }];
  r.handleContextLost();
  r.initializeGl = () => { uploads.push('new programs and buffers'); };
  r.uploadFrameBuffers = () => { uploads.push([r.displayPositions, r.atomColors, r.visibility, r.atomRadii]); };
  r.setVectorFields = fields => { uploads.push(['vectors', fields]); r.atomVectorFields = fields; };
  r.updateSceneBounds = () => { uploads.push('bounds'); };
  r.driverLost = false; r.canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(r.contextLost, false); assert.equal(r.frame, frame); assert.equal(r.frame.properties[0].data[1], 2);
  assert.equal(r.atomColors, colors); assert.equal(r.atomRadii, radii); assert.equal(r.visibility, visibility);
  assert.equal(r.selectionVisibility, selection); assert.equal(r.selected, 1);
  assert.deepEqual([...r.selectedAtoms], [0, 1]); assert.deepEqual([...r.sliceSelectedAtoms], [0, 1, -1]);
  assert.equal(camera, JSON.stringify([r.target, r.pan, r.yaw, r.pitch, r.roll, r.distance, r.orthographicScale, r.projectionMode]));
  assert.equal(uploads[1][0], frame.positions); assert.equal(uploads[2][1][0].vectors, vectors);
  assert.equal(r.contextNotice.hidden, true); assert.ok(events.includes('restored'));
  assert.deepEqual(r.frameTimes, []);
});

test('a failed restore remains visibly unavailable and retains CPU inputs for recovery', () => {
  const { r, frame, events } = fixture(); r.handleContextLost();
  r.initializeGl = () => { throw new Error('GPU memory unavailable'); };
  r.driverLost = false; r.canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(r.frame, frame); assert.equal(r.contextLost, true); assert.equal(r.contextNotice.hidden, false);
  assert.match(r.contextNotice.textContent, /GPU memory unavailable/); assert.ok(events.includes('error'));
  assert.throws(() => r.captureImage(), /graphics context is unavailable/);
});
