import { GpuRuntime, checkSignal } from './runtime.js';
import { analyzeGpuCoordination } from './coordination.js';
import { analyzeGpuRdf } from './rdf.js';

const runtime = new GpuRuntime();
const controllers = new Map();
// Double precision inputs stay available for the kernels' sparse corrections,
// and are evicted together with their actual GPU buffers.
const frames = new Map();
let queue = Promise.resolve();

self.addEventListener('message', ({ data }) => {
  if (data.type === 'cancel') { controllers.get(data.id)?.abort(); return; }
  if (!['analyze', 'warmup', 'configure-cache', 'prepare-frame', 'clear-frames'].includes(data.type)) return;
  const controller = new AbortController(); controllers.set(data.id, controller);
  queue = queue.then(() => run(data, controller)).catch(() => {});
});

function cacheState() {
  const cacheStatus = runtime.cacheStatus();
  const resident = new Set(cacheStatus.cachedFrameIds);
  for (const frameId of frames.keys()) if (!resident.has(frameId)) frames.delete(frameId);
  // The client may omit a payload only if both its f64 input and GPU upload exist.
  const cachedFrameIds = cacheStatus.cachedFrameIds.filter(frameId => frames.has(frameId));
  return { cacheStatus: { ...cacheStatus, cachedFrameIds }, cachedFrameIds };
}

async function run(data, controller) {
  const startedAt = performance.now();
  const progress = (update) => self.postMessage({ id: data.id, progress: { ...update, backend: 'gpu', workerCount: 1 } });
  try {
    checkSignal(controller.signal);
    if (data.type === 'clear-frames') {
      runtime.clearFrames(); frames.clear();
      self.postMessage({ id: data.id, ok: true, ...cacheState() });
      return;
    }
    if (data.type === 'configure-cache') {
      runtime.configureCache(data.options);
      self.postMessage({ id: data.id, ok: true, ...cacheState() });
      return;
    }
    progress({ phase: 'initializing', completedAtoms: 0, totalAtoms: data.frame?.fractional.length / 3 || 0 });
    if (data.type === 'warmup') {
      await runtime.warmup({ signal: controller.signal });
      checkSignal(controller.signal);
      self.postMessage({ id: data.id, ok: true, ...cacheState() });
      return;
    }
    await runtime.initialize(controller.signal);
    if (data.frame) frames.set(data.frameId, data.frame);
    const frame = frames.get(data.frameId);
    if (!frame) throw new Error('The GPU frame cache was released; retry this request with its input frame.');
    if (data.type === 'analyze' && Number.isInteger(data.frameIndex)) runtime.configureCache({ currentIndex: data.frameIndex });
    const previousUploads = runtime.inputUploads;
    await runtime.uploadFrame(frame, { signal: controller.signal, frameIndex: data.frameIndex });
    const analyze = () => runtime.withErrors(async () => {
      if (data.parameters.kind === 'coordination') return analyzeGpuCoordination(runtime, frame, data.parameters, { signal: controller.signal, onProgress: progress });
      if (data.parameters.kind === 'rdf') return analyzeGpuRdf(runtime, frame, data.parameters, { signal: controller.signal, onProgress: progress });
      if (data.parameters.kind === 'bonds') {
        const { analyzeGpuBonds } = await import('./bonds.js');
        return analyzeGpuBonds(runtime, frame, data.parameters, { signal: controller.signal, onProgress: progress });
      }
      if (data.parameters.kind === 'strain') {
        const { analyzeGpuAtomicStrain } = await import('./atomic-strain.js');
        return analyzeGpuAtomicStrain(runtime, frame, data.parameters, { signal: controller.signal, onProgress: progress });
      }
      if (data.parameters.kind === 'localShear') {
        const { analyzeGpuLocalShear } = await import('./local-shear.js');
        return analyzeGpuLocalShear(runtime, frame, data.parameters, { signal: controller.signal, onProgress: progress });
      }
      throw new Error(`The ${data.parameters.kind} analysis uses CPU workers.`);
    });
    let result;
    if (data.type === 'analyze') {
      try { result = await analyze(); }
      catch (error) {
        if (!runtime.recoverMemory(error)) throw error;
        checkSignal(controller.signal);
        // Kernels release their temporary buffers in finally before this retry.
        result = await analyze();
      }
    }
    checkSignal(controller.signal);
    if (data.type === 'analyze') runtime.finishAnalysis();
    progress({ phase: 'complete', completedAtoms: frame.fractional.length / 3, totalAtoms: frame.fractional.length / 3 });
    if (data.type === 'prepare-frame') {
      self.postMessage({ id: data.id, ok: true, ...cacheState() });
      return;
    }
    const buffers = [...new Set(Object.values(result).filter(ArrayBuffer.isView).map((value) => value.buffer))];
    self.postMessage({ id: data.id, ok: true, result: { ...result, backend: 'gpu',
      engine: data.parameters.kind === 'strain' ? 'webgpu-strain-tensor' : 'webgpu', workerCount: 1,
      sharedMemory: false, elapsedMs: performance.now() - startedAt, adapter: runtime.adapterInfo,
      inputReused: !data.frame, gpuInputReused: runtime.inputUploads === previousUploads }, ...cacheState() }, buffers);
  } catch (error) {
    if (data.type === 'analyze') runtime.finishAnalysis();
    self.postMessage({ id: data.id, ok: false, error: error.message || String(error), name: error.name, ...cacheState() });
  } finally { controllers.delete(data.id); }
}
