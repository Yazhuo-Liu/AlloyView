import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { calculateDxa, releaseDxaKernels } from '../src/analysis/dxa.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

after(releaseDxaKernels);

for (const [kind, lattice, type] of [
  ['fcc', 'fcc', 1], ['bcc', 'bcc', 3], ['hcp', 'hcp', 2],
  ['diamond', 'cubicDiamond', 4], ['hex-diamond', 'hexDiamond', 5],
]) {
  test(`shared-memory DXA preserves perfect ${kind} through parallel periodic geometry`, async () => {
    const frame = crystalFrame(kind, 11);
    const result = await calculateDxa(frame, { lattice }, { workerCount: 2 });
    assert.equal(result.threaded, true, result.threadingFallback);
    assert.equal(result.workerCount, 2);
    assert.equal(result.totalLength, 0);
    assert.equal(result.segments.length, 0);
    assert.ok(result.atomStructureTypes.every(value => value === type));
    assert.ok(result.stageTimings.some(stage => stage.phase === 'Periodic Delaunay tessellation'));
    assert.ok(result.stageTimings.every(stage => Number.isFinite(stage.elapsedMs) && stage.elapsedMs >= 0));
  });
}

test('parallel DXA preserves FCC screw Burgers vector, winding, connectivity and every atom label', async () => {
  const frame = fccScrewFrame();
  const serial = await calculateDxa(frame, {}, { workerCount: 1 });
  for (const workerCount of [2, 4]) {
    const result = await calculateDxa(frame, {}, { workerCount });
    assert.equal(result.workerCount, workerCount, result.threadingFallback);
    assert.deepEqual(result.atomStructureTypes, serial.atomStructureTypes);
    assert.equal(result.segments.length, 1);
    assert.equal(result.counts.perfect, 1);
    const line = result.segments[0], reference = serial.segments[0];
    for (const key of ['burgersVector', 'spatialBurgersVector']) {
      assert.ok(line[key].every((value, axis) => Math.abs(value - reference[key][axis]) < 1e-9));
    }
    assert.deepEqual(line.junctions, reference.junctions);
    assert.equal(line.isInfinite, true);
    const winding = Math.abs(line.points.at(-1) - line.points[2]);
    assert.ok(Math.abs(winding - frame.expected.totalLength) < 1e-8);
    // Parallel insertion can choose a different core polyline. Preserve the
    // exact physical winding and bound the added curvature, rather than
    // requiring arc length to equal a perfectly straight analytic line.
    assert.ok(result.totalLength >= winding - 1e-8);
    assert.ok(result.totalLength < 1.001 * winding);
    assert.ok(Math.abs(result.totalLength - serial.totalLength) / winding < 1e-3);
  }
});
