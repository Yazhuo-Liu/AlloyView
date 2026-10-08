import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { calculateDxa, dxaCodeWarmupFrame, releaseDxaKernels, warmupDxa } from '../src/analysis/dxa.js';
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
  const vectors = frame.cell.vectors;
  // Upstream perturbs each tessellation point by epsilon = 1e-10*|a+b+c|.
  // A circuit center anchors at an unperturbed atom and integrates perturbed
  // edges, so each center differs by at most 2*epsilon per component. Two
  // periodic endpoint centers may differ by 4*epsilon; PDEL can change their
  // representative anchors. Include a small arithmetic-rounding allowance.
  const closureTolerance = 4e-10 * Math.hypot(...[0, 1, 2].map(axis =>
    vectors[axis] + vectors[axis + 3] + vectors[axis + 6]))
    + 32 * Number.EPSILON * Math.hypot(...vectors);
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
    const direction = Math.sign(line.points.at(-1) - line.points[2]);
    for (let axis = 0; axis < 3; axis++) {
      const delta = line.points[line.points.length - 3 + axis] - line.points[axis];
      assert.ok(Math.abs(delta - direction * vectors[6 + axis]) <= closureTolerance,
        JSON.stringify({ workerCount, axis, delta, expected: direction * vectors[6 + axis], closureTolerance }));
    }
    const winding = Math.abs(line.points.at(-1) - line.points[2]);
    assert.ok(Math.abs(winding - frame.expected.totalLength) <= closureTolerance);
    // Parallel insertion can choose a different core polyline. Preserve the
    // physical winding within its perturbation bound and bound added curvature, rather than
    // requiring arc length to equal a perfectly straight analytic line.
    assert.ok(result.totalLength >= winding - closureTolerance);
    assert.ok(result.totalLength < 1.001 * winding);
    assert.ok(Math.abs(result.totalLength - serial.totalLength) / winding < 1e-3);
  }
});

const science = ({ segments, atomStructureTypes, totalLength, counts }) => ({ segments, atomStructureTypes, totalLength, counts });

test('the code warm-up fixture is a real dislocation and warms each kernel path once without changing results', async () => {
  await releaseDxaKernels();
  const fixture = await calculateDxa(dxaCodeWarmupFrame(), {}, { workerCount: 2 });
  assert.equal(fixture.workerCount, 2); assert.equal(fixture.segments.length, 1); assert.equal(fixture.counts.perfect, 1);
  assert.equal(fixture.atomStructureTypes.length, 2560);
  await releaseDxaKernels();
  const frame = fccScrewFrame();
  const fresh = await calculateDxa(frame, {}, { workerCount: 1 });
  await releaseDxaKernels();
  const ready = await warmupDxa({ atomCount: 30000, workerCount: 2, warmCode: true });
  assert.deepEqual(ready.warmedKernelPaths, ['parallel']); assert.ok(ready.codeWarmupMs > 0);
  assert.equal(ready.workerCount, 2); assert.equal(ready.poolSize, 1);
  const again = await warmupDxa({ atomCount: 30000, workerCount: 2, warmCode: true });
  assert.equal(again.codeWarmupMs, undefined, 'a warmed path is not run again');
  const serial = await warmupDxa({ atomCount: 30000, workerCount: 1, warmCode: true });
  assert.deepEqual(serial.warmedKernelPaths.toSorted(), ['parallel', 'serial']);
  const warmed = await calculateDxa(frame, {}, { workerCount: 1 });
  assert.deepEqual(science(warmed), science(fresh), 'one-thread output is identical after the warm-up');
  assert.equal(warmed.kernelGeneration, ready.kernelGeneration);
});

test('a cancelled code warm-up rejects, keeps the kernel and leaves its path unwarmed', async () => {
  await releaseDxaKernels();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(warmupDxa({ atomCount: 30000, workerCount: 2, warmCode: true, signal: controller.signal }), { name: 'AbortError' });
  const ready = await warmupDxa({ atomCount: 30000, workerCount: 2 });
  assert.deepEqual(ready.warmedKernelPaths, []);
  const recovered = await calculateDxa(crystalFrame('fcc', 4), {}, { workerCount: 1 });
  assert.equal(recovered.kernelGeneration, ready.kernelGeneration);
  assert.deepEqual(recovered.warmedKernelPaths, ['serial'], 'a completed analysis marks its own path');
});
