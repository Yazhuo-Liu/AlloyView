import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGpuLocalShear, MAX_GPU_SHEAR_COORDINATION, reduceShearMoments, shearCoordinationStatistics,
  shearNeighborMoments } from '../src/analysis/gpu/local-shear.js';
import { makeShearCoordinationShader, makeShearMetricsShader } from '../src/analysis/gpu/local-shear-shaders.js';
import { calculateLocalShear, calculateLocalShearMetrics, calculateLocalShearCoordination, modalCoordination } from '../src/analysis/local-shear.js';
import { crystalFrame } from './helpers/crystals.js';

test('GPU geometric shear global reduction preserves AtomEye normalization of complete neighbor shells', () => {
  const frame = crystalFrame('sc', 3, 1);
  frame.cell.vectors[0] *= 1.2;
  frame.fractional[0] += .05;
  const cutoff = 1.3;
  const counts = calculateLocalShearCoordination(frame, { cutoff });
  const mode = modalCoordination(counts.histogram);
  const moments = calculateLocalShearMetrics(frame, { cutoff, coordinationMode: mode });
  const partials = Float32Array.from([...moments.metricSum, moments.normalizationSum, moments.normalizationParticipants]);
  const reduced = reduceShearMoments(partials, frame.types.length);
  const reference = calculateLocalShear(frame, { cutoff });
  assert.ok(Math.abs(reduced.normalization - reference.normalization) < 1e-6);
  for (let component = 0; component < 6; component += 1) {
    assert.ok(Math.abs(reduced.meanMetric[component] - reference.meanMetric[component]) < 1e-6);
  }
});

test('GPU geometric shear reduction counts normalization participants instead of all atoms', () => {
  // The first workgroup includes a complete three-neighbor shell; the second
  // contributes tensor moments but has no complete shell for normalization.
  const result = reduceShearMoments(new Float32Array([2, 0, 0, 3, 0, 4, 18, 3, 1, 0, 0, 1, 0, 1, 0, 0]), 3);
  assert.equal(result.normalization, 2);
  assert.deepEqual(result.meanMetric, [.5, 0, 0, 2 / 3, 0, 5 / 6]);
  const empty = reduceShearMoments(new Float32Array(8), 1);
  assert.ok(Number.isNaN(empty.normalization));
  assert.ok(empty.meanMetric.every(Number.isNaN));
  assert.throws(() => reduceShearMoments(Float32Array.from([Infinity, 0, 0, 0, 0, 0, 0, 0]), 1), { name: 'GpuUnsupportedError' });
});

test('GPU geometric shear coordination preserves modal ties and rejects CPU neighbor limits', () => {
  const result = shearCoordinationStatistics(new Uint32Array([12, 12, 8, 8, 0]));
  assert.equal(result.coordinationSum, 40);
  assert.equal(modalCoordination(result.histogram), 8);
  assert.throws(() => shearCoordinationStatistics(new Uint32Array([100_001])), /Too many geometric shear neighbors/);
});

test('GPU shear cutoff diagnostics examine rejected candidates as well as accepted neighbors', () => {
  // Catch a lost generator hook: accepting a slightly misplaced f32 neighbor
  // and missing a slightly misplaced f32 neighbor both require correction.
  const shader = makeShearCoordinationShader();
  const check = shader.indexOf('uncertainCutoff = true');
  const acceptance = shader.indexOf('if (distanceSquared <= config.cutoff2)');
  assert.ok(check >= 0 && acceptance > check, 'Cutoff uncertainty must be detected before the acceptance branch.');
});

test('GPU sparse shear corrections preserve CPU neighbor selection and incomplete-shell normalization', () => {
  const neighbors = [
    { atom: 8, x: 0, y: 2, z: 0, distanceSquared: 4 },
    { atom: 4, x: 2, y: 0, z: 0, distanceSquared: 4 },
    { atom: 2, x: 0, y: 0, z: 1, distanceSquared: 1 },
  ];
  assert.deepEqual([...shearNeighborMoments(neighbors, 2)], [2, 0, 0, 0, 0, .5, 5, 2]);
  assert.deepEqual([...shearNeighborMoments(neighbors, 4)], [4 / 3, 0, 0, 4 / 3, 0, 1 / 3, 0, 0]);
});

test('GPU geometric shear returns silent NaN for zero modal coordination and disposes buffers', async () => {
  const runtime = emptyRuntime(new Uint32Array([0, 0]));
  const frame = crystalFrame('sc', 2);
  const result = await analyzeGpuLocalShear(runtime, frame, { cutoff: .01 });
  assert.equal(result.coordinationMode, 0);
  assert.equal(result.averageCoordination, 0);
  assert.ok(result.localShear.every(Number.isNaN));
  assert.equal(result.warning, null);
  assert.equal(runtime.runs, 1);
  assert.equal(runtime.disposed.length, 2);
});

test('GPU geometric shear requests CPU fallback for large modal shells without truncation', async () => {
  const runtime = emptyRuntime(new Uint32Array([MAX_GPU_SHEAR_COORDINATION + 1]));
  await assert.rejects(analyzeGpuLocalShear(runtime, crystalFrame('sc', 1), { cutoff: 30 }), { name: 'GpuUnsupportedError' });
  assert.equal(runtime.runs, 1);
  assert.equal(runtime.disposed.length, 2);
  assert.throws(() => makeShearMetricsShader(65), /Invalid GPU/);
});

test('GPU geometric shear cancellation interrupts reductions and releases allocated buffers', async () => {
  const controller = new AbortController();
  const runtime = emptyRuntime(new Uint32Array([12]));
  runtime.read = async () => { controller.abort(); return new Uint32Array([12]); };
  await assert.rejects(analyzeGpuLocalShear(runtime, crystalFrame('sc', 1), { cutoff: 3 }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(runtime.disposed.length, 2);
});

function emptyRuntime(coordination) {
  return {
    runs: 0, reads: 0, disposed: [],
    async prepareNeighbors() { return { atomCount: coordination.length }; },
    createBuffer(bytes) { return { bytes }; },
    neighborBindings(_context, outputs) { return outputs; },
    async run() { this.runs += 1; },
    async read() { this.reads += 1; return this.reads === 1 ? coordination : new Uint32Array(coordination.length); },
    disposeBuffers(buffers) { this.disposed.push(...buffers); },
  };
}
