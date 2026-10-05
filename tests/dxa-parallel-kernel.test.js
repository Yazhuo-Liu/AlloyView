import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { calculateDxa, releaseDxaKernels, warmupDxa } from '../src/analysis/dxa.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

after(releaseDxaKernels);

test('DXA prewarming grows one existing pthread pool without replacing its shared heap', async () => {
  const controls = [];
  const collect = control => controls.push(control);
  const initial = await warmupDxa({ atomCount: 4096, workerCount: 1, onControl: collect });
  assert.equal(initial.sharedMemory, true);
  assert.equal(initial.poolSize, 0);
  const grown = await warmupDxa({ atomCount: 8192, workerCount: 4, onControl: collect });
  assert.equal(grown.poolSize, 3);
  assert.equal(grown.kernelGeneration, initial.kernelGeneration);
  assert.equal(controls[0].cancelPointer, controls[1].cancelPointer);
  assert.equal(controls[0].cancelBuffer, controls[1].cancelBuffer, 'pool growth uses the identical shared-memory object');
  const reduced = await warmupDxa({ atomCount: 4096, workerCount: 1 });
  assert.equal(reduced.poolSize, 3, 'inactive slots stay available for the next larger structure');
  assert.equal(reduced.kernelGeneration, initial.kernelGeneration);
});

test('DXA cancellation observes the shared word and retains the warmed module for recovery', async () => {
  let control;
  const initial = await warmupDxa({ atomCount: 8640, workerCount: 4, onControl: value => { control = value; } });
  await assert.rejects(calculateDxa(fccScrewFrame(), {}, {
    workerCount: 4,
    onControl: value => { control = value; },
    onProgress: progress => {
      if (progress.phase === 'Periodic Delaunay tessellation') {
        Atomics.store(new Int32Array(control.cancelBuffer), control.cancelPointer / 4, 1);
      }
    },
  }), { name: 'AbortError' });
  const recovered = await calculateDxa(crystalFrame('fcc', 4), {}, { workerCount: 1 });
  assert.equal(recovered.segments.length, 0);
  assert.equal(recovered.kernelGeneration, initial.kernelGeneration);
  assert.equal(recovered.poolSize, initial.poolSize);
  assert.equal(recovered.sharedMemory, true);
});

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
