import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDxa } from '../src/analysis/dxa.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

for (const [kind, lattice, structure] of [
  ['fcc', 'fcc', 1], ['bcc', 'bcc', 3], ['hcp', 'hcp', 2],
  ['diamond', 'cubicDiamond', 4], ['hex-diamond', 'hexDiamond', 5],
]) {
  test(`real DXA Wasm recognizes perfect ${kind} without false dislocation lines`, async () => {
    const frame = crystalFrame(kind, 4);
    const result = await calculateDxa(frame, { lattice });
    assert.equal(result.backend, 'cpu');
    assert.equal(result.segments.length, 0);
    assert.equal(result.totalLength, 0);
    assert.equal(result.density, 0);
    assert.ok(result.atomStructureTypes.every(value => value === structure));
    assert.equal(result.atomStructureTypes.length, frame.ids.length);
  });
}

test('real DXA extracts a periodic FCC screw dislocation with its Burgers vector', async () => {
  const frame = fccScrewFrame();
  const before = frame.fractional.slice();
  const progress = [];
  const result = await calculateDxa(frame, {}, { onProgress: update => progress.push(update) });
  assert.deepEqual(frame.fractional, before, 'source coordinates remain intact');
  assert.equal(result.segments.length, 1);
  assert.equal(result.counts.perfect, 1);
  const segment = result.segments[0];
  assert.equal(segment.familyId, 'perfect');
  assert.ok(Math.abs(Math.hypot(...segment.spatialBurgersVector) - frame.expected.burgersMagnitude) < 1e-8);
  assert.ok(Math.abs(segment.spatialBurgersVector[0]) < 1e-8);
  assert.ok(Math.abs(segment.spatialBurgersVector[1]) < 1e-8);
  // DXA estimates the core by a coarsened polyline, so its slight curvature
  // depends on triangulation and tie ordering. Compare physical length within
  // 0.001 Å, rather than requiring the estimated line to be perfectly straight.
  assert.ok(Math.abs(result.totalLength - frame.expected.totalLength) < 1e-3);
  assert.ok(segment.points.length >= 6);
  assert.ok(segment.isInfinite, 'the line winds through the periodic Z boundary');
  assert.ok(Math.abs(result.density - result.totalLength / result.volume) < 1e-15);
  assert.ok(progress.some(update => /Burgers/.test(update.phase)), 'the actual tracing stage reports progress');
});

test('rotated perfect FCC control and a failed thin cell do not poison a reused DXA kernel', async () => {
  const control = fccScrewFrame({ screw: false });
  assert.equal((await calculateDxa(control)).segments.length, 0);
  const thin = crystalFrame('fcc', 1);
  await assert.rejects(calculateDxa(thin), /too short|too small|extend|replicat/i);
  const recovered = await calculateDxa(crystalFrame('fcc', 4), { gpuEnabled: true });
  assert.equal(recovered.segments.length, 0);
  assert.equal(recovered.backend, 'cpu');
  assert.equal(Object.hasOwn(recovered.parameters, 'gpuEnabled'), false, 'legacy GPU preferences do not change recovered CPU execution');
});

test('real DXA preserves a strained translated triclinic FCC lattice and an isolated vacancy', async () => {
  const frame = crystalFrame('fcc', 4);
  frame.cell = createCell({ vectors: [16, 0, 0, 1.2, 16, 0, .6, .8, 16],
    origin: [100, -200, 300], triclinic: true });
  const strained = await calculateDxa(frame);
  assert.equal(strained.segments.length, 0);
  assert.ok(strained.atomStructureTypes.every(value => value === 1));
  const vacancy = { ...frame, fractional: frame.fractional.slice(3), positions: frame.positions.slice(3),
    ids: frame.ids.slice(1), types: frame.types.slice(1) };
  const defective = await calculateDxa(vacancy);
  assert.equal(defective.segments.length, 0, 'a local vacancy is not a dislocation line');
  assert.ok(defective.atomStructureTypes.includes(0));
  assert.ok(defective.atomStructureTypes.includes(1));
});
