import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withWebGpuBrowser, useSoftwareAdapter } from '../lib/webgpu-browser.mjs';

// The fault hook exists only in this test's Blob worker. Production retains no
// device-destruction command; recovery is exercised through a real lost event.
const workerSource = await readFile(new URL('../../src/analysis/gpu/worker.js', import.meta.url), 'utf8');
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => ({ adapter,
  ...await evaluate(`(${run.toString()})(${JSON.stringify(workerSource)})`),
}), { software: useSoftwareAdapter() });
assert.equal(report.replacementWorkers, 2);
assert.equal(report.recoveredInputReused, false);
assert.equal(report.repeatInputReused, true);
assert.equal(report.repeatGpuInputReused, true);
assert.equal(report.sourceUnchanged, true);
assert.equal(report.validationRetainedDevice, true);
assert.equal(report.uncapturedValidationRetainedDevice, true);
console.log(JSON.stringify(report, null, 2));

async function run(source) {
  const [{ GpuRuntime }, { GpuAnalysisClient }, { crystalFrame }] = await Promise.all([
    import('./src/analysis/gpu/runtime.js'), import('./src/analysis/gpu/client.js'), import('./tests/helpers/crystals.js'),
  ]);
  const until = async (predicate, phase) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for actual WebGPU recovery: ' + phase);
  };
  const runtime = new GpuRuntime();
  let validationRetainedDevice, uncapturedValidationRetainedDevice, validationMessage;
  try {
    const device = await runtime.initialize();
    try {
      await runtime.withErrors(() => device.createBuffer({ size: 4, usage: 0 }));
      throw new Error('Invalid buffer unexpectedly passed its error scope.');
    } catch (error) {
      if (error.name !== 'GpuUnavailableError') throw error;
      validationMessage = error.message;
    }
    validationRetainedDevice = await runtime.initialize() === device && !runtime.lost;
    let received = false;
    device.addEventListener('uncapturederror', () => { received = true; }, { once: true });
    device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.STORAGE });
    device.queue.submit([]);
    await until(() => received, 'uncaptured validation');
    try {
      await runtime.initialize();
      throw new Error('Uncaptured validation did not fail its next operation.');
    } catch (error) {
      if (!error.gpuValidationError) throw error;
    }
    uncapturedValidationRetainedDevice = await runtime.initialize() === device && !runtime.lost;
  } finally { runtime.close(); }

  const base = new URL('./src/analysis/gpu/worker.js', location.href);
  source = source.replace(/from '([^']+)'/g, (_, path) => `from '${new URL(path, base).href}'`)
    .replace(/import\('([^']+)'\)/g, (_, path) => `import('${new URL(path, base).href}')`);
  source += `\nself.addEventListener('message', ({data}) => { if (data.type === 'test-destroy-device') runtime.device.destroy(); });\n`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const workers = [];
  const client = new GpuAnalysisClient({ workerFactory: () => {
    const worker = new Worker(url, { type: 'module' }); workers.push(worker); return worker;
  } });
  const frame = crystalFrame('fcc', 2, 3.52), coordinates = frame.fractional.slice(), types = frame.types.slice();
  try {
    const parameters = { kind: 'coordination', cutoff: 3.0 };
    const before = await client.analyze(frame, parameters, { frameIndex: 0 });
    if (!before.coordination.every(value => value === 12)) throw new Error('Initial GPU coordination was incorrect.');
    workers[0].postMessage({ type: 'test-destroy-device' });
    await until(() => client.worker === null, 'lost worker notification');
    if (client.cachedFrameIds.size || client.deviceWarmed || client.warmedUp) throw new Error('Lost device retained usable acknowledgements.');
    if (workers.length !== 1) throw new Error('Idle loss recreated a device without a request.');
    const recovered = await client.analyze(frame, parameters, { frameIndex: 0 });
    const repeated = await client.analyze(frame, parameters, { frameIndex: 0 });
    if (recovered.coordination.some((value, index) => value !== before.coordination[index])) throw new Error('Recovered GPU scientific result changed.');
    if (repeated.coordination.some((value, index) => value !== before.coordination[index])) throw new Error('Repeated GPU scientific result changed.');
    const sourceUnchanged = frame.fractional.length === coordinates.length
      && frame.fractional.every((value, index) => Object.is(value, coordinates[index]))
      && frame.types.every((value, index) => value === types[index]);
    return { validationRetainedDevice, uncapturedValidationRetainedDevice, validationMessage,
      replacementWorkers: workers.length, recoveredInputReused: recovered.inputReused,
      repeatInputReused: repeated.inputReused, repeatGpuInputReused: repeated.gpuInputReused,
      sourceUnchanged, meanCoordination: recovered.meanCoordination, cacheStatus: client.cacheStatus,
      note: 'Actual WebGPU device.destroy() loss and replacement, plus captured/uncaptured validation. Software adapters verify correctness and do not measure physical GPU performance.' };
  } finally { client.close(); URL.revokeObjectURL(url); }
}
