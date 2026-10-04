import { GpuRuntime, checkSignal } from './runtime.js';
import { analyzeGpuCoordination } from './coordination.js';
import { analyzeGpuRdf } from './rdf.js';

const runtime = new GpuRuntime();
const controllers = new Map();
const frames = new Map();
let queue = Promise.resolve();

self.addEventListener('message', ({ data }) => {
  if (data.type === 'cancel') { controllers.get(data.id)?.abort(); return; }
  if (data.type !== 'analyze') return;
  const controller = new AbortController(); controllers.set(data.id, controller);
  queue = queue.then(() => run(data, controller)).catch(() => {});
});

async function run(data, controller) {
  const startedAt = performance.now();
  const progress = (update) => self.postMessage({ id: data.id, progress: { ...update, backend: 'gpu', workerCount: 1 } });
  try {
    checkSignal(controller.signal);
    progress({ phase: 'initializing', completedAtoms: 0, totalAtoms: data.frame?.fractional.length / 3 || 0 });
    await runtime.initialize(controller.signal);
    if (data.frame) {
      frames.set(data.frameId, data.frame);
      while (frames.size > 2) frames.delete(frames.keys().next().value);
    }
    const frame = frames.get(data.frameId);
    if (!frame) throw new Error('The GPU frame cache was released; use CPU workers for this request.');
    const previousUploads = runtime.inputUploads;
    const result = await runtime.withErrors(async () => {
      if (data.parameters.kind === 'coordination') return analyzeGpuCoordination(runtime, frame, data.parameters, { signal: controller.signal, onProgress: progress });
      if (data.parameters.kind === 'rdf') return analyzeGpuRdf(runtime, frame, data.parameters, { signal: controller.signal, onProgress: progress });
      if (data.parameters.kind === 'localShear') {
        const { analyzeGpuLocalShear } = await import('./local-shear.js');
        return analyzeGpuLocalShear(runtime, frame, data.parameters, { signal: controller.signal, onProgress: progress });
      }
      throw new Error(`The ${data.parameters.kind} analysis uses CPU workers.`);
    });
    checkSignal(controller.signal);
    progress({ phase: 'complete', completedAtoms: frame.fractional.length / 3, totalAtoms: frame.fractional.length / 3 });
    const buffers = [...new Set(Object.values(result).filter(ArrayBuffer.isView).map((value) => value.buffer))];
    self.postMessage({ id: data.id, ok: true, result: { ...result, backend: 'gpu', engine: 'webgpu', workerCount: 1,
      sharedMemory: false, elapsedMs: performance.now() - startedAt, adapter: runtime.adapterInfo,
      inputReused: !data.frame, gpuInputReused: runtime.inputUploads === previousUploads }, cachedFrameIds: [...frames.keys()] }, buffers);
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: error.message || String(error), name: error.name, cachedFrameIds: [...frames.keys()] });
  } finally { controllers.delete(data.id); }
}
