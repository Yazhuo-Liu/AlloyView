import { useSoftwareAdapter, withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

const software = useSoftwareAdapter(true);
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => ({ adapter, softwareValidation: software,
  rows: await evaluate(`(${checks.toString()})()`, { timeoutMs: 240_000 }) }), { software });
console.log(JSON.stringify(report, null, 2));

async function checks() {
  const [{ GpuRuntime }, { analyzeGpuIsosurface, releaseGpuVolumetric, warmGpuVolumetric }, { calculateIsosurface }] = await Promise.all([
    import('./src/analysis/gpu/runtime.js'), import('./src/analysis/gpu/volumetric.js'), import('./src/analysis/volumetric.js'),
  ]);
  const runtime = new GpuRuntime(), rows = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const grid = (dimensions, field, extra = {}) => {
    const values = new Float64Array(dimensions.reduce((a, b) => a * b, 1));
    for (let z = 0; z < dimensions[2]; z++) for (let y = 0; y < dimensions[1]; y++) for (let x = 0; x < dimensions[0]; x++) values[x + dimensions[0] * (y + dimensions[1] * z)] = field(x, y, z);
    return { id: 'fixture', dimensions, values, origin: new Float64Array(3), steps: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), periodic: [false, false, false], ...extra };
  };
  const run = async (label, dataset, parameters, tolerance = 2e-5) => {
    const expected = calculateIsosurface(dataset, parameters), progress = [];
    const actual = await analyzeGpuIsosurface(runtime, dataset, parameters, { onProgress: value => progress.push(value) });
    check(actual.backend === 'gpu', label + ': GPU backend required');
    check(actual.triangleCount === expected.triangleCount, label + ': triangle count ' + actual.triangleCount + ' vs ' + expected.triangleCount);
    let maximumError = 0;
    for (let i = 0; i < actual.vertices.length; i++) maximumError = Math.max(maximumError, Math.abs(actual.vertices[i] - expected.vertices[i]));
    check(maximumError <= tolerance, label + ': vertex mismatch ' + maximumError);
    const areaError = Math.abs(actual.statistics.surfaceArea - expected.statistics.surfaceArea) / Math.max(1, expected.statistics.surfaceArea);
    check(areaError < 2e-5, label + ': area mismatch ' + areaError);
    check(progress.at(-1)?.phase === 'complete', label + ': missing completion');
    rows.push({ label, triangleCount: actual.triangleCount, maximumError, areaError, inputReused: actual.inputReused });
    return actual;
  };
  try {
    await warmGpuVolumetric(runtime);
    const linear = grid([5, 6, 7], (x, y, z) => x + y * 0.5 + z * 0.25);
    await run('Tilted plane', linear, { level: 2.3 });
    const repeated = await run('Resident grid with another level', linear, { level: 3.1 });
    check(repeated.inputReused, 'level edits must retain uploaded grid');
    await run('Exact sample and edge equality', linear, { level: 2 });
    await run('Two signed lobes', grid([11, 10, 9], (x, y, z) => (x - 5) * Math.exp(-((x - 5) ** 2 + (y - 4.5) ** 2 + (z - 4) ** 2) / 9)), { level: -0.325 });
    await run('Periodic triclinic volume', grid([7, 6, 5], (x, y, z) => Math.cos(x * 2 * Math.PI / 7) + Math.sin(y * 2 * Math.PI / 6) + 0.3 * Math.cos(z * 2 * Math.PI / 5),
      { periodic: [true, true, true], origin: Float64Array.from([2, -4, 7]), steps: Float64Array.from([0.7, 0.1, -0.1, 0.3, 0.9, 0.1, -0.1, 0.2, 0.8]) }), { level: 0.271 });
    await run('Left-handed grid', grid([4, 4, 4], (x, y, z) => x * x + y + z, { steps: Float64Array.from([-1, 0, 0, 0, 1, 0, 0, 0, 1]) }), { level: 3.3 });
    for (const level of [4, 4.84]) {
      const sphere = grid([7, 7, 7], (x, y, z) => -((x - 3) ** 2 + (y - 3) ** 2 + (z - 3) ** 2));
      const surface = await run('Exactly closed sphere at level ' + level, sphere, { level: -level });
      const edges = new Map(), vertices = new Set();
      for (let offset = 0; offset < surface.vertices.length; offset += 9) {
        const points = [0, 3, 6].map(start => Array.from(surface.vertices.subarray(offset + start, offset + start + 3)));
        const keys = points.map(point => point.join(','));
        for (const key of keys) vertices.add(key);
        for (let side = 0; side < 3; side++) {
          const key = [keys[side], keys[(side + 1) % 3]].sort().join('|');
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
        const a = points[1].map((value, axis) => value - points[0][axis]), b = points[2].map((value, axis) => value - points[0][axis]);
        const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        check(normal.reduce((sum, value, axis) => sum + value * (points[0][axis] - 3), 0) > 0, 'sphere normals must point outward');
      }
      check([...edges.values()].every(count => count === 2), 'shared GPU intersections must agree exactly without coordinate rounding');
      check(vertices.size - edges.size + surface.triangleCount === 2, 'closed GPU sphere must have Euler characteristic two');
    }
    await run('Large scalar offset, tiny physical difference', grid([4, 4, 4], (x, y, z) => 1e12 + (x + y * 0.5 + z * 0.25) / 1024), { level: 1e12 + 2.3 / 1024 });
    await run('Large coordinate origin', grid([4, 4, 4], (x, y, z) => x + y + z,
      { origin: Float64Array.from([1e12, -1e12, 1e12]) }), { level: 3.3 }, 2e-4);
    await run('Multiple bounded dispatch batches', grid([33, 27, 23], (x, y, z) => (x - 16) ** 2 + (y - 13) ** 2 + (z - 11) ** 2), { level: 50.33 });
    await run('Nonempty voxel range', linear, { level: 2.3, startCell: 17, endCell: 43 });
    for (const [label, dataset, level] of [
      ['Thin near-endpoint intersections', grid([2, 2, 2], x => x ? 1 : -1e-10), 0],
      ['Near-level scalar residual beyond paired precision', { ...grid([2, 2, 2], () => 0), values: Float64Array.from([0, 1, 1e-20, 0, 0, 0, 0, 0]) }, 5e-21],
    ]) {
      let rejected = false;
      try { await analyzeGpuIsosurface(runtime, dataset, { level }); }
      catch (error) { check(error.name === 'GpuUnavailableError', label + ': incorrect failure ' + error); rejected = true; }
      check(rejected, label + ': unsafe topology must request explicit CPU fallback');
      rows.push({ label, fallback: 'cpu-precision' });
    }
    await run('Empty and ranged outputs', linear, { level: 200, startCell: 1, endCell: 11 });
    releaseGpuVolumetric(runtime);
    const reloaded = await run('Source clear retains device and reloads samples', linear, { level: 2.3 });
    check(!reloaded.inputReused, 'source clear must discard uploaded samples');
  } finally { releaseGpuVolumetric(runtime); runtime.close(); }
  const { VolumetricClient } = await import('./src/analysis/volumetric-client.js');
  const client = new VolumetricClient({ cellsPerWorker: 32, chunkCells: 64 });
  try {
    const dataset = grid([7, 6, 5], (x, y, z) => x + y * 0.5 + z * 0.25), before = dataset.values.slice();
    const ready = await client.prepare(dataset, { useGpu: true });
    check(ready.gpuReady, 'retained Worker GPU preparation failed: ' + ready.fallbackReason);
    const first = await client.analyze(dataset, { level: 3.1 }, { useGpu: true });
    check(first.backend === 'gpu' && first.inputReused && first.gridUploads === 0, 'first analysis must reuse background GPU upload and Worker snapshot');
    check(first.renderGeometry?.positions.length === first.vertices.length, 'GPU result must contain worker-packed rendering geometry');
    const cpu = await client.analyze(dataset, { level: 3.1 }, { useGpu: false });
    check(cpu.backend === 'cpu' && cpu.triangleCount === first.triangleCount, 'retained CPU pool must preserve GPU topology');
    await client.releaseGpuResources();
    const reenabled = await client.analyze(dataset, { level: 3.1 }, { useGpu: true });
    check(reenabled.backend === 'gpu' && !reenabled.inputReused && reenabled.gridUploads === 0,
      'GPU-off must release device uploads while retaining CPU Worker snapshots');
    const fallback = await client.analyze(grid([2, 2, 2], x => x ? 1 : -1e-10), { level: 0 }, { useGpu: true });
    check(fallback.backend === 'cpu' && fallback.fallbackReason && fallback.triangleCount > 0,
      'unsafe numerical geometry must execute complete CPU fallback');
    const controller = new AbortController(); let cancelled = false;
    try {
      await client.analyze(dataset, { level: 3.1 }, { useGpu: true, signal: controller.signal,
        onProgress: progress => { if (progress.phase === 'gpu-dispatch') controller.abort(); } });
    } catch (error) { check(error.name === 'AbortError', 'GPU cancellation became a failure or fallback'); cancelled = true; }
    check(cancelled, 'running GPU analysis must acknowledge cancellation');
    const recovered = await client.analyze(dataset, { level: 3.1 }, { useGpu: true });
    check(recovered.backend === 'gpu', 'cancelled GPU Worker must remain reusable');
    await client.clear();
    const cleared = await client.analyze(dataset, { level: 3.1 }, { useGpu: true });
    check(!cleared.inputReused && cleared.gridUploads === 1, 'source clear must discard CPU and GPU grid ownership');
    check(dataset.values.every((value, index) => value === before[index]), 'Worker GPU path altered or detached source samples');
    rows.push({ label: 'Retained volume Worker integration', cpuWorkers: cpu.workerCount, backgroundUploadReused: first.inputReused,
      gpuOffReleased: !reenabled.inputReused, cancellationRecovered: true, explicitCpuFallback: fallback.fallbackReason });
  } finally { client.dispose(); }
  return rows;
}
