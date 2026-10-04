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
  const cachedCartesianFrames = [...runtime.frames].filter(([frameId]) => frames.has(frameId))
    .map(([frameId, frame]) => ({ frameId, variants: [...(frame.cartesian?.keys() ?? [])] }));
  return { cacheStatus: { ...cacheStatus, cachedFrameIds }, cachedFrameIds, cachedCartesianFrames };
}

async function run(data, controller) {
  const startedAt = performance.now();
  let releasePins;
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
    let referenceFrame, parameters = data.parameters;
    if (data.type === 'analyze' && ['referenceStrain', 'displacement'].includes(parameters.kind)) {
      if (data.referenceFrame) frames.set(data.referenceFrameId, data.referenceFrame);
      referenceFrame = frames.get(data.referenceFrameId);
      if (!referenceFrame) throw new Error('The GPU reference frame cache was released; retry this request with its reference input.');
      parameters = { ...parameters, referenceFrame, referenceFrameIndex: data.referenceFrameIndex,
        referenceFractional: referenceFrame.fractional, referenceCell: referenceFrame.cell };
    }
    if (data.type === 'analyze' && Number.isInteger(data.frameIndex)) runtime.configureCache({ currentIndex: data.frameIndex });
    if (data.type === 'analyze') releasePins = runtime.pinFrames([frame, referenceFrame]);
    const previousUploads = runtime.inputUploads;
    if (parameters?.kind === 'displacement') {
      const variant = parameters.minimumImage === false ? 'unwrapped-cartesian' : 'cartesian';
      for (const [source, name] of [[frame, 'currentPositions'], [referenceFrame, 'referencePositions']]) {
        source.cartesianPositions ??= new Map();
        if (parameters[name] !== undefined) source.cartesianPositions.set(variant, parameters[name]);
        const positions = source.cartesianPositions.get(variant);
        if (!positions) throw new Error('The GPU Cartesian coordinate cache was released; retry with its source positions.');
        parameters = { ...parameters, [name]: positions };
      }
      await runtime.prepareCartesianFrame(frame, parameters.currentPositions,
        { signal: controller.signal, frameIndex: data.frameIndex, variant });
      await runtime.prepareCartesianFrame(referenceFrame, parameters.referencePositions,
        { signal: controller.signal, frameIndex: data.referenceFrameIndex, variant });
    } else {
      await runtime.uploadFrame(frame, { signal: controller.signal, frameIndex: data.frameIndex });
      if (referenceFrame) await runtime.uploadFrame(referenceFrame, { signal: controller.signal, frameIndex: data.referenceFrameIndex });
    }
    const analyze = () => runtime.withErrors(async () => {
      if (parameters.kind === 'coordination') return analyzeGpuCoordination(runtime, frame, parameters, { signal: controller.signal, onProgress: progress });
      if (parameters.kind === 'rdf') return analyzeGpuRdf(runtime, frame, parameters, { signal: controller.signal, onProgress: progress });
      if (parameters.kind === 'cna') {
        const { analyzeGpuCna } = await import('./cna.js');
        const result = await analyzeGpuCna(runtime, frame, parameters, { signal: controller.signal, onProgress: progress });
        checkSignal(controller.signal);
        if ((parameters.mode ?? 'adaptive') === 'adaptive') runtime.cacheAdaptiveCna(frame, result.structures);
        return result;
      }
      if (parameters.kind === 'centrosymmetry') {
        const { analyzeGpuCentrosymmetry } = await import('./centrosymmetry.js');
        return analyzeGpuCentrosymmetry(runtime, frame, parameters, { signal: controller.signal, onProgress: progress });
      }
      if (parameters.kind === 'displacement') {
        const { analyzeGpuDisplacement } = await import('./displacement.js');
        return analyzeGpuDisplacement(runtime, frame, parameters, { signal: controller.signal, onProgress: progress });
      }
      if (parameters.kind === 'referenceStrain') {
        const { analyzeGpuReferenceStrain } = await import('./reference-strain.js');
        return analyzeGpuReferenceStrain(runtime, frame, parameters, { signal: controller.signal, onProgress: progress });
      }
      if (parameters.kind === 'bonds') {
        const { analyzeGpuBonds } = await import('./bonds.js');
        return analyzeGpuBonds(runtime, frame, parameters, { signal: controller.signal, onProgress: progress });
      }
      if (parameters.kind === 'strain') {
        const { analyzeGpuAtomicStrain } = await import('./atomic-strain.js');
        return analyzeGpuAtomicStrain(runtime, frame, parameters, { signal: controller.signal, onProgress: progress });
      }
      if (parameters.kind === 'localShear') {
        const { analyzeGpuLocalShear } = await import('./local-shear.js');
        return analyzeGpuLocalShear(runtime, frame, parameters, { signal: controller.signal, onProgress: progress });
      }
      throw new Error(`The ${parameters.kind} analysis uses CPU workers.`);
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
    if (data.type === 'analyze') { releasePins?.(); releasePins = null; runtime.finishAnalysis(); }
    progress({ phase: 'complete', completedAtoms: frame.fractional.length / 3, totalAtoms: frame.fractional.length / 3 });
    if (data.type === 'prepare-frame') {
      self.postMessage({ id: data.id, ok: true, ...cacheState() });
      return;
    }
    const buffers = [...new Set(Object.values(result).filter(ArrayBuffer.isView).map((value) => value.buffer))];
    self.postMessage({ id: data.id, ok: true, result: { ...result, backend: 'gpu',
      engine: parameters.kind === 'strain' ? 'webgpu-strain-tensor' : parameters.kind === 'cna' ? `webgpu-cna-${parameters.mode ?? 'adaptive'}`
        : parameters.kind === 'referenceStrain' ? 'webgpu-reference-strain'
          : parameters.kind === 'centrosymmetry' ? `webgpu-centrosymmetry-${parameters.mode ?? 'manual'}`
            : parameters.kind === 'displacement' ? 'webgpu-displacement' : 'webgpu', workerCount: 1,
      sharedMemory: false, elapsedMs: performance.now() - startedAt, adapter: runtime.adapterInfo,
      inputReused: !data.frame, ...(referenceFrame ? { referenceInputReused: !data.referenceFrame } : {}),
      gpuInputReused: runtime.inputUploads === previousUploads }, ...cacheState() }, buffers);
  } catch (error) {
    if (data.type === 'analyze') { releasePins?.(); releasePins = null; runtime.finishAnalysis(); }
    self.postMessage({ id: data.id, ok: false, error: error.message || String(error), name: error.name, ...cacheState() });
  } finally { releasePins?.(); controllers.delete(data.id); }
}
