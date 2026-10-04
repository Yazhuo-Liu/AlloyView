import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell } from '../src/data/model.js';
import { normalizeSelectionRectangle, selectAtomsInRectangle } from '../src/render/box-selection.js';
import { orthographic, perspective } from '../src/render/math.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

function fixture(positions = [-.5, 0, -2, .5, 0, -2, 0, 0, -4, 0, 0, .2, 0, 0, -.5, 0, 0, -6, 2, 0, -2]) {
  const count = positions.length / 3;
  return Object.assign(Object.create(WebGLRenderer.prototype), {
    frame: { ids: Uint32Array.from({ length: count }, (_, index) => index + 1),
      fractional: new Float64Array(count * 3).fill(.5), cell: createCell({ vectors: [2, 0, 0, 0, 2, 0, 0, 0, 2] }) },
    displayPositions: Float64Array.from(positions), atomCount: count, visibility: new Uint8Array(count).fill(255),
    sliceMode: 'legacy', sliceAxis: 2, sliceMaximum: 1, repetitions: [1, 1, 1],
    replicas: [{ indices: [0, 0, 0], offset: [0, 0, 0] }],
    viewProjectionMatrix: orthographic(-1, 1, -1, 1, 1, 5),
    canvas: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) },
    updateMatrices() {}, selectionRevision: 0,
  });
}
const whole = { left: 0, top: 0, right: 1000, bottom: 1000 };

test('box selection normalizes reverse drags and selects all visible centers through depth occlusion', async () => {
  assert.deepEqual(normalizeSelectionRectangle({ left: 120, top: 80, right: 50, bottom: 60 }),
    { left: 50, top: 60, right: 120, bottom: 80 });
  const r = fixture();
  assert.deepEqual([...await selectAtomsInRectangle(r, { left: 120, top: 80, right: 50, bottom: 60 })], [0, 2]);
  assert.deepEqual([...await selectAtomsInRectangle(r, whole)], [0, 1, 2]);
  assert.deepEqual([...await selectAtomsInRectangle(r, { left: -20, top: -20, right: -10, bottom: -10 })], []);
});

test('perspective selection excludes centers behind the camera and outside near/far/viewport planes', async () => {
  const r = fixture();
  r.viewProjectionMatrix = perspective(Math.PI / 2, 2, 1, 5);
  assert.deepEqual([...await selectAtomsInRectangle(r, whole)], [0, 1, 2, 6]);
});

test('replica selection returns each original atom once and honors replica-specific planes', async () => {
  const r = fixture([-.5, 0, -2, .5, 0, -2]);
  r.repetitions = [2, 1, 1];
  r.replicas.push({ indices: [1, 0, 0], offset: [2, 0, 0] });
  r.viewProjectionMatrix = orthographic(-1, 3, -1, 1, 1, 5);
  assert.deepEqual([...await selectAtomsInRectangle(r, whole)], [0, 1]);
  r.sliceMode = 'planes';
  r.slices = [{ normal: [1, 0, 0], position: 1, enabled: true, side: 'positive' }];
  assert.deepEqual([...await selectAtomsInRectangle(r, { left: 130, top: 20, right: 180, bottom: 120 })], [0]);
  r.visibility[0] = 0;
  assert.deepEqual([...await selectAtomsInRectangle(r, whole)], [1]);
});

test('box selection applies legacy slice coordinates and conservative replica bounds', async () => {
  const r = fixture([-.5, 0, -2, .5, 0, -2]);
  r.frame.fractional[2] = .2; r.frame.fractional[5] = .8;
  r.sliceMaximum = .5;
  r.selectionSourceBounds = { minimum: [-.5, 0, -2], maximum: [.5, 0, -2] };
  r.replicas.push({ indices: [1, 0, 0], offset: [10, 0, 0] });
  assert.deepEqual([...await selectAtomsInRectangle(r, whole)], [0]);
});

test('selection yields and cancels when the source, camera, or abort signal changes', async () => {
  for (const change of ['source', 'camera', 'abort']) {
    const r = fixture(new Float64Array(300_000).fill(0));
    for (let atom = 0; atom < r.atomCount; atom++) r.displayPositions[atom * 3 + 2] = -2;
    const controller = new AbortController();
    let yields = 0;
    await assert.rejects(() => selectAtomsInRectangle(r, whole, {
      signal: controller.signal, workBudgetMs: 1,
      async yieldControl() {
        yields += 1;
        if (change === 'source') r.frame = { ...r.frame };
        else if (change === 'camera') r.yaw = .8;
        else controller.abort();
      },
    }), { name: 'AbortError' });
    assert.equal(yields, 1);
  }
});

test('renderer rectangle selection cancels a previous selection and validates screen bounds', async () => {
  const r = fixture();
  assert.deepEqual([...await r.selectInRectangle(whole)], [0, 1, 2]);
  assert.equal(r.selectionController, null);
  await assert.rejects(() => r.selectInRectangle({ left: NaN, top: 0, right: 1, bottom: 1 }), /finite/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => r.selectInRectangle(whole, { signal: controller.signal }), { name: 'AbortError' });
});
