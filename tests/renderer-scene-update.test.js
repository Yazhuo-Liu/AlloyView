import assert from 'node:assert/strict';
import test from 'node:test';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

function fixture() {
  let next = 0;
  const resources = new Map(), draws = [], cancelledMeshes = [];
  const gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2, FLOAT: 3, UNSIGNED_BYTE: 4,
    createBuffer() { const buffer = { id: ++next }; resources.set(buffer, null); return buffer; },
    createVertexArray() { return { id: ++next }; }, bindVertexArray() {},
    enableVertexAttribArray() {}, disableVertexAttribArray() {}, vertexAttribPointer() {}, vertexAttribDivisor() {},
    bindBuffer(target, buffer) { this.bound = buffer; },
    bufferData(target, value) { resources.set(this.bound, typeof value === 'number' ? value : value.byteLength); },
    isContextLost: () => false,
  };
  const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
    gl, canvas: { parentElement: null }, contextListeners: new Set(),
    frame: { frameIndex: 0 }, atomCount: 1, displayAtomCount: 1,
    displayPositions: Float32Array.of(1, 2, 3), atomColors: Uint8Array.of(0, 128, 255),
    visibility: Uint8Array.of(255), atomRadii: Float32Array.of(.7), selectedAtoms: Int32Array.of(-1), sliceSelectedAtoms: Int32Array.of(-1),
    trajectoryLines: { vertices: Float32Array.of(0, 0, 0, 1, 1, 1) },
    yaw: -.62, pitch: .38, pan: [0, 0, 0], target: [0, 0, 0], frameTimes: [], lastStatsAt: 0, onStats() {},
    requestRender() {}, onProjectionChange() {},
    render(timestamp) { draws.push({ frame: this.frame, yaw: this.yaw, buffer: this.positionBuffer }); },
    surfaceMeshLayer: { entries: new Map(), clear() { cancelledMeshes.push('clear'); }, detach() { cancelledMeshes.push('detach'); } },
  });
  renderer.initializeSceneBuffers();
  renderer.uploadFrameBuffers = () => {};
  return { renderer, resources, draws, cancelledMeshes };
}

test('scene update holds complete old buffers with the live camera, then commits target atomically', () => {
  const { renderer: r, draws, resources, cancelledMeshes } = fixture();
  const oldFrame = r.frame, oldBuffer = r.positionBuffer, oldLayer = r.surfaceMeshLayer;
  const token = r.beginSceneUpdate();
  const allocated = resources.size;
  assert.ok(token); assert.equal(r.presentationPending, true); assert.equal(r.presentedFrame, oldFrame);
  assert.notEqual(r.positionBuffer, oldBuffer); assert.equal(r.surfaceMeshLayer, null);
  assert.deepEqual(cancelledMeshes, [], 'old world geometry has not been cleared');
  const target = r.frame = { frameIndex: 9 };
  r.yaw = .5;
  WebGLRenderer.prototype.render.call(r, 10);
  assert.deepEqual(draws, [{ frame: oldFrame, yaw: .5, buffer: oldBuffer }]);
  assert.equal(r.pick(1, 1), -1, 'old pixels cannot select target-frame indexes');
  assert.throws(() => r.captureImage(), /requested frame/);
  assert.equal(r.commitSceneUpdate(token), true);
  assert.equal(r.frame, target); assert.equal(r.presentedFrame, target); assert.equal(r.presentationPending, false);
  assert.equal(r.sceneSpare.frame, null); assert.equal(r.sceneSpare.surfaceMeshLayer, oldLayer);
  assert.ok(cancelledMeshes.includes('clear'), 'old large mesh allocations released only after commit');
  assert.equal(resources.size, allocated, 'commit does not allocate a third bank');
  assert.equal(r.commitSceneUpdate(token), false, 'a token commits once');
});

test('replacement and cancellation retain the actually presented frame and reuse two resource banks', async () => {
  const { renderer: r, resources } = fixture(), oldFrame = r.frame, oldBuffer = r.positionBuffer;
  const token1 = r.beginSceneUpdate(), targetBuffer = r.positionBuffer;
  r.frame = { frameIndex: 10 };
  const count = resources.size;
  const token2 = r.beginSceneUpdate();
  assert.equal(resources.size, count); assert.equal(r.positionBuffer, targetBuffer);
  assert.equal(r.presentedFrame, oldFrame);
  assert.equal(r.commitSceneUpdate(token1), false); assert.equal(r.cancelSceneUpdate(token1), false);
  r.frame = { frameIndex: 150 };
  assert.deepEqual(await r.selectInRectangle({}), [], 'selection cannot use unpublished geometry');
  assert.equal(r.cancelSceneUpdate(token2), true);
  assert.equal(r.frame, oldFrame); assert.equal(r.positionBuffer, oldBuffer);
  assert.equal(r.sceneSpare.frame, null);
  const token3 = r.beginSceneUpdate();
  assert.equal(r.positionBuffer, targetBuffer); assert.equal(resources.size, count);
  r.frame = { frameIndex: 4 };
  r.commitSceneUpdate(token3);
  assert.equal(r.frame.frameIndex, 4);
});

test('source close clears the retained presentation, and context loss discards invalid banks without resetting clients', () => {
  for (const action of ['close', 'context-loss']) {
    const { renderer: r, cancelledMeshes } = fixture();
    const client = r.surfaceGeometryClient = {};
    const token = r.beginSceneUpdate(), targetFrame = r.frame = { frameIndex: 3 };
    if (action === 'close') {
      r.clearFrame();
      assert.equal(r.frame, null); assert.equal(r.presentedFrame, null); assert.equal(r.sceneSpare.frame, null);
      assert.ok(cancelledMeshes.includes('clear'));
    } else {
      r.handleContextLost({ preventDefault() {} });
      assert.equal(r.contextLost, true); assert.equal(r.sceneSpare, null);
      assert.equal(r.frame, targetFrame, 'target CPU descriptors remain available for restoration');
      assert.ok(cancelledMeshes.includes('detach'));
    }
    assert.equal(r.presentationPending, false); assert.equal(r.commitSceneUpdate(token), false);
    assert.equal(r.surfaceGeometryClient, client);
  }
});

test('presentation barrier waits for a committed draw and rejects abort, supersession, close and context loss', async () => {
  const { renderer: r } = fixture(), frame = r.frame;
  let ready = false;
  const pending = r.whenPresented(frame).then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, false, 'a queued draw is not an actual presentation');
  r.completePresentation(); await pending;
  assert.equal(ready, true); assert.equal(await r.whenPresented(frame), frame);

  const token = r.beginSceneUpdate();
  const target = r.frame = { frameIndex: 20 };
  let targetReady = false;
  const targetDraw = r.whenPresented(target).then(() => { targetReady = true; });
  r.completePresentation(); await Promise.resolve();
  assert.equal(targetReady, false, 'old-scene draws cannot satisfy target presentation');
  r.commitSceneUpdate(token); await Promise.resolve();
  assert.equal(targetReady, false, 'commit still waits for its next actual render');
  r.completePresentation(); await targetDraw; assert.equal(targetReady, true);

  for (const reason of ['abort', 'supersede', 'close', 'context-loss']) {
    const { renderer: view } = fixture(), controller = new AbortController();
    const barrier = view.whenPresented(view.frame, { signal: controller.signal });
    const rejection = assert.rejects(barrier, error => error.name === 'AbortError');
    if (reason === 'abort') controller.abort();
    else if (reason === 'supersede') view.beginSceneUpdate();
    else if (reason === 'close') view.clearFrame();
    else view.handleContextLost();
    await rejection;
    assert.equal(view.presentationWaiters.size, 0, `${reason} releases subscribers`);
  }
  await assert.rejects(r.whenPresented({ frameIndex: -1 }), error => error.name === 'AbortError');
});
