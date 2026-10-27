import { isosurfaceSteps, volumeSliceSteps, validateVolumeValuesSteps, prepareVolumetricRenderGeometrySteps,
  volumeSliceCsvSteps } from '../analysis/volumetric.js';
import { runCooperativeStepsAsync } from '../shared/cooperative-steps.js';

let resident = null, active = null, gpuRuntime = null, gpuModule = null;
self.addEventListener('message', ({ data }) => {
  if (data.type === 'cancel') { if (active?.id === data.id) active.controller.abort(); return; }
  if (active) { self.postMessage({ id: data.id, ok: false, error: 'The volume Worker is busy.' }); return; }
  void run(data);
});

async function gpuResources(signal) {
  const { GpuRuntime } = await import('../analysis/gpu/runtime.js');
  gpuModule ??= await import('../analysis/gpu/volumetric.js');
  if (gpuRuntime?.lost || gpuRuntime?.closed) { gpuModule.releaseGpuVolumetric(gpuRuntime); gpuRuntime.close?.(); gpuRuntime = null; }
  gpuRuntime ??= new GpuRuntime();
  await gpuRuntime.initialize(signal);
  return { runtime: gpuRuntime, module: gpuModule };
}

async function run(data) {
  const task = active = { id: data.id, controller: new AbortController() };
  const options = { signal: task.controller.signal };
  const progress = update => self.postMessage({ id: data.id, progress: update });
  try {
    let result;
    if (data.type === 'clear') {
      resident = null;
      if (gpuRuntime) gpuModule?.releaseGpuVolumetric(gpuRuntime);
      result = { cleared: true };
    } else if (data.type === 'release-gpu') {
      if (gpuRuntime) { gpuModule?.releaseGpuVolumetric(gpuRuntime); gpuRuntime.close(); gpuRuntime = null; }
      result = { gpuReady: false };
    } else if (data.type === 'prepare') {
      if (resident?.key !== data.key) {
        await runCooperativeStepsAsync(validateVolumeValuesSteps(data.dataset), options);
        resident = { key: data.key, dataset: data.dataset };
      }
      result = { ready: true };
    } else if (data.type === 'warm-gpu') {
      const { runtime, module } = await gpuResources(options.signal);
      if (module.warmGpuVolumetric) await module.warmGpuVolumetric(runtime, options);
      if (data.key !== undefined && resident?.key === data.key && module.prepareGpuVolumetric) {
        await module.prepareGpuVolumetric(runtime, resident.dataset, options);
      }
      result = { gpuReady: true };
    } else if (data.type === 'csv') {
      result = await runCooperativeStepsAsync(volumeSliceCsvSteps(data.result, data.options), options);
    } else if (data.type === 'analyze') {
      if (!resident || resident.key !== data.key) throw new Error('The volumetric grid is not resident in its Worker.');
      const { dataset } = resident;
      if (data.useGpu) {
        const { runtime, module } = await gpuResources(options.signal);
        result = await module.analyzeGpuIsosurface(runtime, dataset, data.parameters, { ...options, onProgress: progress });
      } else if (data.parameters.kind === 'slice') result = await runCooperativeStepsAsync(volumeSliceSteps(dataset, data.parameters, { trusted: true }), options);
      else result = await runCooperativeStepsAsync(isosurfaceSteps(dataset, { ...data.parameters, onProgress: progress }, { trusted: true }), options);
      if (result.kind === 'isosurface' || result.vertices) {
        result.kind = 'isosurface';
        result = await runCooperativeStepsAsync(prepareVolumetricRenderGeometrySteps(result, dataset), options);
      }
    } else throw new Error('Unknown volumetric Worker request.');
    const buffers = new Set();
    for (const object of [result, result?.renderGeometry]) if (object) for (const value of Object.values(object)) {
      if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
    }
    self.postMessage({ id: data.id, ok: true, result, residentKey: resident?.key ?? null }, [...buffers]);
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: error.message, name: error.name,
      gpuUnavailable: Boolean(data.useGpu || data.type === 'warm-gpu') && error.name !== 'AbortError' && !error.volumetricResourceLimit,
      residentKey: resident?.key ?? null });
  } finally { if (active === task) active = null; }
}
