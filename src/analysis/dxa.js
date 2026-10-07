import { cartesianToFractional, determinant3, fractionalToCartesian } from '../data/model.js';
import { cpuWorkerLimit } from './cpu-budget.js';

export const DXA_LATTICES = Object.freeze([
  { id: 'fcc', label: 'FCC', kernelId: 1 },
  { id: 'bcc', label: 'BCC', kernelId: 3 },
  { id: 'hcp', label: 'HCP', kernelId: 2 },
  { id: 'cubicDiamond', label: 'Cubic diamond', kernelId: 4 },
  { id: 'hexDiamond', label: 'Hexagonal diamond', kernelId: 5 },
].map(Object.freeze));

export const DXA_DEFAULTS = Object.freeze({ lattice: 'fcc', trialCircuitLength: 14,
  circuitStretchability: 9, onlyPerfectDislocations: false, lineSmoothingIterations: 1,
  linePointInterval: 2.5 });

// Reference prototypes use OVITO's ideal crystal coordinates. Hexagonal
// prototypes are Cartesian coordinates, rather than Miller-Bravais indices.
// Source: OVITO v3.9.4 DislocationAnalysisModifier and BurgersVectorFamily.
const other = { id: 'other', label: 'Other', color: [230, 76, 76], vector: [0, 0, 0] };
const cubic = [
  { id: 'perfect', label: '1/2 ⟨110⟩ (Perfect)', color: [51, 51, 255], vector: [.5, .5, 0] },
  { id: 'shockley', label: '1/6 ⟨112⟩ (Shockley)', color: [0, 220, 90], vector: [1 / 6, 1 / 6, 1 / 3] },
  { id: 'stairRod', label: '1/6 ⟨110⟩ (Stair-rod)', color: [230, 30, 220], vector: [1 / 6, 1 / 6, 0] },
  { id: 'hirth', label: '1/3 ⟨100⟩ (Hirth)', color: [230, 205, 0], vector: [1 / 3, 0, 0] },
  { id: 'frank', label: '1/3 ⟨111⟩ (Frank)', color: [0, 200, 220], vector: [1 / 3, 1 / 3, 1 / 3] },
];
const hexagonal = [
  { id: 'a', label: '1/3 ⟨1−210⟩ (a)', color: [0, 220, 90], vector: [Math.sqrt(.5), 0, 0] },
  { id: 'c', label: '⟨0001⟩ (c)', color: [51, 51, 255], vector: [0, 0, Math.sqrt(4 / 3)] },
  { id: 'basal', label: '⟨1−100⟩', color: [230, 30, 220], vector: [0, Math.sqrt(1.5), 0] },
  { id: 'basalPartial', label: '1/3 ⟨1−100⟩', color: [255, 128, 0], vector: [0, Math.sqrt(1.5) / 3, 0] },
  { id: 'ca', label: '1/3 ⟨1−213⟩ (c+a)', color: [230, 205, 0], vector: [Math.sqrt(.5), 0, Math.sqrt(4 / 3)] },
];
const freezeFamilies = families => Object.freeze([...families, other].map(family => Object.freeze({ ...family,
  color: Object.freeze([...family.color]), vector: Object.freeze([...family.vector]) })));
export const DXA_FAMILIES = Object.freeze({
  fcc: freezeFamilies(cubic),
  bcc: freezeFamilies([
    { id: 'half111', label: '1/2 ⟨111⟩', color: [0, 220, 90], vector: [.5, .5, .5] },
    { id: '100', label: '⟨100⟩', color: [255, 76, 204], vector: [1, 0, 0] },
    { id: '110', label: '⟨110⟩', color: [51, 128, 255], vector: [1, 1, 0] },
  ]),
  hcp: freezeFamilies(hexagonal),
  cubicDiamond: freezeFamilies(cubic.filter(family => family.id !== 'hirth')),
  hexDiamond: freezeFamilies(hexagonal.filter(family => family.id !== 'ca')),
});

export function validateDxaParameters(parameters = {}) {
  const settings = { ...DXA_DEFAULTS, ...parameters };
  if (!DXA_LATTICES.some(lattice => lattice.id === settings.lattice)) throw new Error('Choose a supported DXA input crystal lattice.');
  for (const [name, minimum, maximum] of [['trialCircuitLength', 3, 100], ['circuitStretchability', 0, 100],
    ['lineSmoothingIterations', 0, 100]]) {
    if (!Number.isInteger(settings[name]) || settings[name] < minimum || settings[name] > maximum) {
      throw new Error(`DXA ${name} must be an integer between ${minimum} and ${maximum}.`);
    }
  }
  if (typeof settings.onlyPerfectDislocations !== 'boolean') throw new Error('DXA perfect-dislocation selection must be a checkbox value.');
  if (!Number.isFinite(settings.linePointInterval) || settings.linePointInterval < 0 || settings.linePointInterval > 1e6) throw new Error('DXA line coarsening distance must be finite and between 0 and 1000000.');
  return settings;
}

export function classifyBurgersVector(vector, lattice, tolerance = 1e-3) {
  if (!DXA_FAMILIES[lattice]) throw new Error('Unknown DXA crystal lattice.');
  if (vector?.length !== 3 || !Array.from(vector).every(Number.isFinite)) throw new Error('A Burgers vector requires three finite crystal coordinates.');
  const candidate = Array.from(vector, Math.abs);
  const matches = reference => reference.every((value, index) => Math.abs(candidate[index] - value) <= tolerance);
  for (const family of DXA_FAMILIES[lattice]) {
    if (family.id === 'other') continue;
    if (lattice === 'hcp' || lattice === 'hexDiamond') {
      // D6h equivalence: reflections/sign reversals plus 60 degree rotations.
      // Comparing only lengths incorrectly merges differently oriented basal
      // families, while sorting xyz incorrectly exchanges the c axis.
      for (let rotation = 0; rotation < 6; rotation++) {
        const angle = rotation * Math.PI / 3, [x, y, z] = family.vector;
        const reference = [Math.abs(x * Math.cos(angle) - y * Math.sin(angle)),
          Math.abs(x * Math.sin(angle) + y * Math.cos(angle)), Math.abs(z)];
        if (matches(reference)) return family.id;
      }
    } else {
      const reference = family.vector.map(Math.abs).sort((a, b) => a - b);
      if (candidate.toSorted((a, b) => a - b).every((value, index) => Math.abs(value - reference[index]) <= tolerance)) return family.id;
    }
  }
  return 'other';
}

export function validateDxaFrame(frame, { validateCoordinates = true } = {}) {
  const coordinates = frame?.fractional ?? frame?.positions;
  const count = coordinates?.length / 3;
  if (!Number.isInteger(count) || count < 4) throw new Error('DXA requires a three-dimensional structure with at least four atoms.');
  const cell = frame.cell;
  if (cell?.vectors?.length !== 9 || cell?.origin?.length !== 3 || cell?.pbc?.length !== 3
      || !Array.from(cell.vectors).every(Number.isFinite) || !Array.from(cell.origin).every(Number.isFinite)
      || !Number.isFinite(determinant3(cell.vectors)) || Math.abs(determinant3(cell.vectors)) < 1e-12) {
    throw new Error('DXA requires a finite, non-singular three-dimensional cell.');
  }
  if (validateCoordinates) for (const coordinate of coordinates) {
    if (!Number.isFinite(coordinate)) throw new Error('DXA requires finite atom coordinates.');
  }
  return count;
}

/** A conservative preflight, not an exact allocation promise. DXA owns a
 * global tetrahedral/half-edge workspace in addition to input and JSON copies.
 * Do not split or truncate a frame to meet a budget: topology would change.
 */
export function estimateDxaMemory(count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('DXA requires a valid atom count.');
  return 32 * 1024 ** 2 + count * 3_072;
}

export function preflightDxaMemory(count, budgetBytes = 1.5 * 1024 ** 3) {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) throw new Error('DXA memory budget must be positive and finite.');
  const estimateBytes = estimateDxaMemory(count);
  if (estimateBytes > budgetBytes) {
    throw new Error(`DXA estimates ${(estimateBytes / 1024 ** 2).toFixed(0)} MiB of working memory, exceeding the ${(budgetBytes / 1024 ** 2).toFixed(0)} MiB budget. Reduce the analyzed structure or real replication.`);
  }
  return estimateBytes;
}

/** Wrapped source positions preserve full triclinic vectors and cell origin.
 * Explicit atom images in the input must not create extra periodic atoms.
 */
export function dxaCartesianCoordinates(frame) {
  const count = validateDxaFrame(frame);
  const fractional = frame.fractional ? Float64Array.from(frame.fractional)
    : cartesianToFractional(frame.positions, frame.cell, new Float64Array(count * 3));
  for (let index = 0; index < fractional.length; index++) {
    if (frame.cell.pbc[index % 3]) fractional[index] -= Math.floor(fractional[index]);
  }
  return fractionalToCartesian(fractional, frame.cell, new Float64Array(count * 3));
}

const DXA_STAGES = 11;
const DXA_GPU_STAGES = Object.freeze(['tetrahedron-alpha', 'elastic-compatibility']);
const DXA_GPU_LOCAL_STAGES = Object.freeze(['local-neighbors', 'local-structures', 'local-correspondence']);
const DXA_GPU_SNAPSHOT_LIMIT = 512 * 1024 ** 2;
let kernelPromise, kernelProgress, poolGrowth = Promise.resolve();
let kernelGeneration = 0, kernelThreadingFallback;
let activeDxaCalculation = false;

function sharedDxaAvailable(environment = globalThis) {
  return typeof environment.SharedArrayBuffer === 'function'
    && (Boolean(environment.process?.versions?.node) || environment.crossOriginIsolated === true);
}

/** Leave two reported logical processors available for the interface and host.
 * Explicit Node requests are useful for scientific parity checks. Browsers use
 * only the concurrency they expose; the actual number of physical cores may
 * differ from that privacy-sensitive value.
 */
export function dxaWorkerCount(count, requested, environment = globalThis) {
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
    throw new Error('DXA worker count must be a positive integer.');
  }
  if (!sharedDxaAvailable(environment) || count < 2048) return 1;
  const node = Boolean(environment.process?.versions?.node);
  // A client supplies its already resolved global budget. A Worker may report
  // a different privacy-limited core count, so do not clamp that budget again.
  const maximum = requested ?? cpuWorkerLimit(environment);
  const threads = requested ?? (node ? 1 : Math.min(maximum, Math.ceil(count / 4096)));
  return Math.min(threads, maximum, Math.max(1, Math.floor(count / 1024)));
}

async function getKernel() {
  if (!kernelPromise) {
    kernelPromise = (async () => {
      const wantsThreading = sharedDxaAvailable();
      async function initialize(threaded) {
        const { default: createDxa } = threaded
          ? await import('./dxa-kernel-threaded.mjs') : await import('./dxa-kernel.mjs');
        let options = {};
        if (typeof process === 'object' && process.versions?.node) {
          const { readFile } = await import('node:fs/promises');
          options.wasmBinary = await readFile(new URL(threaded ? './dxa-kernel-threaded.wasm' : './dxa-kernel.wasm', import.meta.url));
        }
        const moduleOptions = { ...options, dxaPoolSize: 0,
          onDxaProgress: (...update) => kernelProgress?.(...update) };
        try {
          const module = await createDxa(moduleOptions);
          module.dxaShared = threaded;
          kernelGeneration++;
          return module;
        } catch (error) {
          moduleOptions.PThread?.terminateAllThreads();
          throw error;
        }
      }
      try { return await initialize(wantsThreading); }
      catch (error) {
        if (!wantsThreading) throw error;
        // Only startup may fall back: an established module is never replaced
        // merely because the requested parallelism changes.
        kernelThreadingFallback = error.message || String(error);
        return initialize(false);
      }
    })().catch(error => { kernelPromise = undefined; throw error; });
  }
  return kernelPromise;
}

function cancellationControl(module) {
  if (!module.dxaShared) return undefined;
  return { cancelBuffer: module.HEAPU8.buffer, cancelPointer: module._alloy_dxa_cancel_ptr() };
}

function checkDxaCancellation(module) {
  const pointer = module._alloy_dxa_cancel_ptr();
  const canceled = module.dxaShared ? Atomics.load(module.HEAP32, pointer / 4) : module.HEAP32[pointer / 4];
  if (canceled) throw new DOMException('The DXA calculation was cancelled.', 'AbortError');
}

function kernelMetadata(module, workerCount) {
  return { workerCount, poolSize: module.dxaShared
    ? module.PThread.unusedWorkers.length + module.PThread.runningWorkers.length : 0,
  kernelGeneration, wasmMemoryBytes: module.HEAPU8.byteLength,
  sharedMemory: Boolean(module.dxaShared), threadingFallback: kernelThreadingFallback };
}

async function growPool(module, workerCount) {
  if (!module.dxaShared || workerCount < 2) return;
  const growth = poolGrowth.then(async () => {
    const pool = module.PThread;
    const pending = [];
    while (pool.unusedWorkers.length + pool.runningWorkers.length < workerCount - 1) {
      pool.allocateUnusedWorker();
      const worker = pool.unusedWorkers.at(-1);
      // Emscripten's loader resolves only on success; reject startup errors as
      // well, and remove a failed slot so a future request can retry growth.
      pending.push(new Promise((resolve, reject) => {
        const loaded = pool.loadWasmModuleToWorker(worker);
        const runtimeErrorHandler = worker.onerror;
        worker.onerror = event => {
          worker.terminate();
          const index = pool.unusedWorkers.indexOf(worker);
          if (index >= 0) pool.unusedWorkers.splice(index, 1);
          reject(new Error(event.message || 'The DXA pthread worker could not start.'));
        };
        loaded.then(value => {
          // Once started, preserve Emscripten's fatal runtime handling rather
          // than mistaking a crashed numerical thread for a startup failure.
          worker.onerror = runtimeErrorHandler;
          resolve(value);
        }, reject);
      }));
    }
    const outcomes = await Promise.allSettled(pending);
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  });
  poolGrowth = growth.catch(() => {});
  return growth;
}

/** Initialize the one persistent kernel and grow its existing pthread pool.
 * The returned diagnostics describe the same heap on later calculations.
 * Callers may share its cancellation word, but never transfer the shared heap.
 */
export async function warmupDxa(options = {}) {
  if (activeDxaCalculation) throw new Error('A DXA calculation is already using the native workspace.');
  return initializeDxa(options);
}

async function initializeDxa({ atomCount = 1, workerCount: requestedWorkers,
  memoryBudgetBytes, onProgress = () => {}, onControl = () => {}, resetCancellation = true } = {}) {
  if (!Number.isSafeInteger(atomCount) || atomCount < 1) throw new Error('DXA warmup requires a valid atom count.');
  const estimateBytes = preflightDxaMemory(atomCount, memoryBudgetBytes);
  let workerCount = dxaWorkerCount(atomCount, requestedWorkers);
  // Pthreads share the large scientific workspace but each slot needs a
  // two-MiB stack. Keep that incremental allocation inside the same budget.
  const stackSlots = Math.floor(((memoryBudgetBytes ?? 1.5 * 1024 ** 3) - estimateBytes) / (2 * 1024 ** 2));
  workerCount = Math.min(workerCount, Math.max(1, stackSlots + 1));
  onProgress({ phase: 'initializing', completedStages: 0, totalStages: DXA_STAGES,
    backend: 'cpu', workerCount, totalAtoms: atomCount });
  const module = await getKernel();
  if (resetCancellation) module._alloy_dxa_reset_cancel();
  const control = cancellationControl(module);
  if (control) onControl(control);
  if (!module.dxaShared) workerCount = 1;
  checkDxaCancellation(module);
  onProgress({ phase: 'warming', completedStages: 0, totalStages: DXA_STAGES,
    backend: 'cpu', workerCount, totalAtoms: atomCount });
  await growPool(module, workerCount);
  checkDxaCancellation(module);
  return kernelMetadata(module, workerCount);
}

/** Explicit shutdown for benchmarks and clients that are themselves closing.
 * Frame changes, replication and normal cancellation retain this one heap.
 */
export async function releaseDxaKernels() {
  if (activeDxaCalculation) throw new Error('Finish or cancel the active DXA calculation before releasing its native workspace.');
  const pending = kernelPromise;
  kernelPromise = undefined;
  await poolGrowth;
  poolGrowth = Promise.resolve();
  if (pending) {
    try { (await pending).PThread?.terminateAllThreads(); } catch { /* Failed startup already cleaned up. */ }
  }
  kernelThreadingFallback = undefined;
}

/** Executes full DXA, optionally dispatching local crystal correspondence
 * and immutable tetrahedron classification to the shared WebGPU backend.
 * Browser callers should use DxaClient to keep synchronous work off the UI.
 */
export async function calculateDxa(frame, parameters = {}, options = {}) {
  if (activeDxaCalculation) throw new Error('A DXA calculation is already using the native workspace.');
  activeDxaCalculation = true;
  try { return await performDxaCalculation(frame, parameters, options); }
  finally { activeDxaCalculation = false; }
}

async function performDxaCalculation(frame, parameters = {}, { onProgress = () => {}, onControl = () => {}, resetCancellation = true,
  memoryBudgetBytes, workerCount: requestedWorkers, classifyDxa, signal, gpuSnapshotBudgetBytes, gpuBufferLimitBytes,
  verifyGpuClassification = false, identifyDxa, verifyGpuLocalStructures = false } = {}) {
  checkSignal(signal);
  const settings = validateDxaParameters(parameters), count = validateDxaFrame(frame);
  const memoryEstimateBytes = preflightDxaMemory(count, memoryBudgetBytes);
  let workerCount = dxaWorkerCount(count, requestedWorkers);
  const startedAt = performance.now();
  const report = update => onProgress({ backend: 'cpu', workerCount, ...update });
  const ready = await initializeDxa({ atomCount: count, workerCount: requestedWorkers,
    memoryBudgetBytes, onProgress: report, onControl, resetCancellation });
  workerCount = ready.workerCount;
  const module = await getKernel();
  checkSignal(signal);
  module._alloy_dxa_set_threads(workerCount);
  report({ phase: 'indexing', completedStages: 0, totalStages: DXA_STAGES, totalAtoms: count });
  const positions = dxaCartesianCoordinates(frame);
  const coordinates = module._malloc(positions.byteLength), cellPointer = module._malloc(12 * 8);
  if (!coordinates || !cellPointer) {
    if (coordinates) module._free(coordinates);
    if (cellPointer) module._free(cellPointer);
    throw new Error('DXA could not allocate its input; reduce the analyzed structure or real replication.');
  }
  const stageTimings = [];
  let stagePhase, stageStarted, stageBackend;
  const beginStage = (phase, completedStages, totalStages = DXA_STAGES, backend = 'cpu') => {
    const now = performance.now();
    if (stagePhase) stageTimings.push({ phase: stagePhase, elapsedMs: now - stageStarted, backend: stageBackend });
    stagePhase = completedStages < totalStages ? phase : undefined;
    stageStarted = now;
    stageBackend = backend;
    report({ phase, completedStages, totalStages, totalAtoms: count, backend });
  };
  kernelProgress = beginStage;
  let gpuResult, gpuLocalResult, gpuSnapshotBytes = 0, gpuLocalInputBytes = 0, fallbackReason;
  const stageFallbacks = [];
  let regionsPointer = 0, localStructuresPointer = 0, localNeighborsPointer = 0, stagedSession = false;
  try {
    module.HEAPF64.set(positions, coordinates / 8);
    module.HEAPF64.set(frame.cell.vectors, cellPointer / 8);
    module.HEAPF64.set(frame.cell.origin, cellPointer / 8 + 9);
    const pbc = frame.cell.pbc.reduce((bits, enabled, axis) => bits | (enabled ? 1 << axis : 0), 0);
    report({ phase: 'analyzing', completedStages: 0, totalStages: DXA_STAGES, totalAtoms: count });
    const argumentsList = [coordinates, count, cellPointer, pbc,
      DXA_LATTICES.find(lattice => lattice.id === settings.lattice).kernelId,
      settings.trialCircuitLength, settings.circuitStretchability, settings.onlyPerfectDislocations ? 1 : 0,
      settings.lineSmoothingIterations, settings.linePointInterval];
    let output;
    // The WebGPU stages emulate binary64 arithmetic. With several native
    // threads, CPU local identification and classification finish sooner.
    const gpuStagesAvailable = typeof classifyDxa === 'function' || typeof identifyDxa === 'function';
    const gpuSkipped = Boolean(settings.gpuEnabled && gpuStagesAvailable && workerCount > 1);
    if (settings.gpuEnabled && gpuStagesAvailable && !gpuSkipped) {
      stagedSession = true;
      const budgetBytes = gpuSnapshotBudgetBytes ?? Math.min(DXA_GPU_SNAPSHOT_LIMIT,
        Math.floor((memoryBudgetBytes ?? 1.5 * 1024 ** 3) * .35));
      if (typeof identifyDxa === 'function') {
        if (!module._alloy_dxa_prepare(...argumentsList)) throw nativeDxaError(module);
        try {
          const input = exportDxaLocalInput(module, count, argumentsList[4], !settings.onlyPerfectDislocations, budgetBytes);
          gpuLocalInputBytes = input.coordinates.byteLength + input.templates.byteLength + input.inverse.byteLength;
          let referenceStructures, referenceNeighbors, referenceMaxNeighborDistance, verificationInput;
          if (verifyGpuLocalStructures) {
            if (!module._alloy_dxa_identify_local_cpu()) throw nativeDxaError(module);
            const types = module._alloy_dxa_local_types_ptr(), neighbors = module._alloy_dxa_local_neighbors_ptr();
            if (!types || !neighbors) throw nativeDxaError(module);
            referenceStructures = module.HEAP32.slice(types / 4, types / 4 + count);
            referenceNeighbors = module.HEAP32.slice(neighbors / 4, neighbors / 4 + count * input.neighborWidth);
            referenceMaxNeighborDistance = module._alloy_dxa_local_max_distance();
            verificationInput = { neighborWidth: input.neighborWidth, templates: input.templates.slice() };
          }
          checkSignal(signal);
          checkDxaCancellation(module);
          // This progress is posted before the RPC. The host can therefore
          // cancel a serial Wasm session while it awaits the GPU checkpoint.
          beginStage('GPU local neighbors and crystal correspondence', 0, DXA_STAGES, 'gpu');
          const local = await withSignal(identifyDxa(input, { signal, referenceStructures, referenceNeighbors, referenceMaxNeighborDistance,
            referenceWidth: referenceNeighbors ? input.neighborWidth : undefined,
            onProgress: progress => report({ completedStages: 0, totalStages: DXA_STAGES,
              ...progress, backend: 'gpu', totalAtoms: count }) }), signal);
          checkSignal(signal);
          checkDxaCancellation(module);
          validateDxaLocalResult(local, count, input.neighborWidth);
          if (referenceStructures) verifyDxaLocalResult(local, verificationInput, referenceStructures,
            referenceNeighbors, referenceMaxNeighborDistance);
          localStructuresPointer = module._malloc(local.structures.byteLength);
          localNeighborsPointer = module._malloc(local.neighbors.byteLength);
          if (!localStructuresPointer || !localNeighborsPointer) throw new Error('DXA could not allocate the GPU crystal correspondence.');
          module.HEAP32.set(local.structures, localStructuresPointer / 4);
          module.HEAP32.set(local.neighbors, localNeighborsPointer / 4);
          gpuLocalResult = local;
        } catch (error) {
          if (error?.name === 'AbortError' || signal?.aborted) throw error;
          checkDxaCancellation(module);
          fallbackReason = error?.message || String(error);
          stageFallbacks.push({ stage: 'local', reason: fallbackReason });
          report({ phase: 'GPU local analysis unavailable; continuing crystal identification on CPU', completedStages: 0,
            totalStages: DXA_STAGES, totalAtoms: count, fallbackReason });
        } finally {
          // Packing arrays are independent of the persistent native session.
          // Their owned JS copies were transferred without exposing its heap.
          module._alloy_dxa_release_local_input();
        }
        try {
          checkSignal(signal);
          checkDxaCancellation(module);
          let mapped = module._alloy_dxa_build_mapping(gpuLocalResult ? localStructuresPointer : 0,
            gpuLocalResult ? localNeighborsPointer : 0, gpuLocalResult?.neighborWidth ?? 0,
            gpuLocalResult?.maxNeighborDistance ?? 0);
          if (!mapped && gpuLocalResult) {
            const error = nativeDxaError(module);
            if (error.name === 'AbortError') throw error;
            // Import validation happens before changing native structures.
            // Only that failure retains a prepared local session; failures
            // during topology construction dispose it and remain fatal.
            if (module._alloy_dxa_local_neighbor_width() > 0) {
              gpuLocalResult = undefined;
              fallbackReason = error.message;
              stageFallbacks.push({ stage: 'local', reason: fallbackReason });
              report({ phase: 'GPU local correspondence rejected; continuing crystal identification on CPU', completedStages: 0,
                totalStages: DXA_STAGES, totalAtoms: count, fallbackReason });
              mapped = module._alloy_dxa_build_mapping(0, 0, 0, 0);
            }
          }
          if (!mapped) throw nativeDxaError(module);
        } finally {
          if (localStructuresPointer) module._free(localStructuresPointer);
          if (localNeighborsPointer) module._free(localNeighborsPointer);
          localStructuresPointer = localNeighborsPointer = 0;
        }
      } else {
        if (!module._alloy_dxa_begin(...argumentsList)) throw nativeDxaError(module);
      }
      checkSignal(signal);
      checkDxaCancellation(module);
      try {
        if (typeof classifyDxa !== 'function') throw new Error('WebGPU tetrahedron classification is unavailable in this browser or context.');
        const snapshot = exportDxaSnapshot(module, budgetBytes, gpuBufferLimitBytes);
        gpuSnapshotBytes = snapshot.vertices.byteLength + snapshot.tetrahedra.byteLength
          + snapshot.edges.byteLength + snapshot.transitions.byteLength;
        let referenceRegions;
        if (verifyGpuClassification) {
          const pointer = module._alloy_dxa_cpu_regions_ptr();
          if (!pointer) throw nativeDxaError(module);
          referenceRegions = module.HEAP32.slice(pointer / 4, pointer / 4 + snapshot.tetrahedronCount);
        }
        const tetrahedronCount = snapshot.tetrahedronCount;
        checkSignal(signal);
        checkDxaCancellation(module);
        beginStage('GPU tetrahedron and elastic classification', 7, DXA_STAGES, 'gpu');
        const classified = await withSignal(classifyDxa(snapshot, { signal, referenceRegions,
          onProgress: progress => report({ completedStages: 7, totalStages: DXA_STAGES,
            ...progress, backend: 'gpu', totalAtoms: count,
            totalTetrahedra: progress.totalTetrahedra ?? progress.totalAtoms ?? tetrahedronCount,
            completedTetrahedra: progress.completedTetrahedra ?? progress.completedAtoms ?? 0 }) }), signal);
        checkSignal(signal);
        checkDxaCancellation(module);
        if (!(classified?.regions instanceof Int32Array) || classified.regions.length !== tetrahedronCount
          || classified.regions.some(value => value !== -1 && value !== 0)) {
          throw new Error('WebGPU DXA returned invalid tetrahedron regions.');
        }
        if (referenceRegions && !classified.regions.every((value, index) => value === referenceRegions[index])) {
          throw new Error('WebGPU DXA classification differs from the native numerical reference.');
        }
        regionsPointer = module._malloc(classified.regions.byteLength);
        if (!regionsPointer) throw new Error('DXA could not allocate the GPU tetrahedron classification.');
        module.HEAP32.set(classified.regions, regionsPointer / 4);
        gpuResult = classified;
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        checkDxaCancellation(module);
        fallbackReason = error?.message || String(error);
        stageFallbacks.push({ stage: 'tetrahedra', reason: fallbackReason });
        report({ phase: 'GPU unavailable; continuing DXA on CPU', completedStages: 7,
          totalStages: DXA_STAGES, totalAtoms: count, fallbackReason });
      }
      checkSignal(signal);
      checkDxaCancellation(module);
      // A failed GPU dispatch reuses the already mapped native topology and
      // any successful GPU local correspondence, without restarting DXA.
      output = module._alloy_dxa_finish(gpuResult ? regionsPointer : 0,
        gpuResult ? gpuResult.regions.length : 0);
    } else {
      if (gpuSkipped) fallbackReason = `${workerCount} CPU threads run DXA faster than its WebGPU binary64 stages.`;
      else if (settings.gpuEnabled) fallbackReason = 'WebGPU DXA is unavailable in this browser or context.';
      output = module._alloy_dxa_analyze(...argumentsList);
    }
    if (!output) {
      throw nativeDxaError(module);
    }
    checkSignal(signal);
    report({ phase: 'collecting', completedStages: DXA_STAGES, totalStages: DXA_STAGES, totalAtoms: count });
    const result = normalizeDxaResult(JSON.parse(module.UTF8ToString(output)), frame.cell, settings, count);
    const usedGpu = Boolean(gpuLocalResult || gpuResult);
    const gpuResults = [gpuLocalResult, gpuResult].filter(Boolean);
    const gpuTotal = key => gpuResults.length ? gpuResults.reduce((sum, value) => sum + (value[key] ?? 0), 0) : undefined;
    return { ...result, elapsedMs: performance.now() - startedAt, memoryEstimateBytes,
      stageTimings, ...kernelMetadata(module, workerCount), threaded: Boolean(module.dxaShared),
      engine: `${workerCount > 1 ? `Wasm CPU · ${workerCount} threads` : 'Wasm CPU'}${usedGpu ? ' + WebGPU' : ''}`,
      backend: usedGpu ? 'hybrid' : 'cpu',
      gpuStages: [...(gpuLocalResult ? DXA_GPU_LOCAL_STAGES : []), ...(gpuResult ? DXA_GPU_STAGES : [])],
      gpuElapsedMs: gpuTotal('elapsedMs'), gpuArithmetic: gpuResult?.arithmetic ?? gpuLocalResult?.arithmetic,
      gpuUploadedBytes: gpuTotal('uploadedBytes'), gpuReadbackBytes: gpuTotal('readbackBytes'),
      gpuSnapshotBytes, gpuLocalInputBytes, gpuFallback: Boolean(settings.gpuEnabled && !usedGpu && !gpuSkipped), gpuSkipped,
      stageFallbacks, gpuFallbackReason: !usedGpu ? fallbackReason : undefined, fallbackReason };
  } finally {
    kernelProgress = null;
    if (stagedSession) module._alloy_dxa_dispose();
    if (regionsPointer) module._free(regionsPointer);
    if (localStructuresPointer) module._free(localStructuresPointer);
    if (localNeighborsPointer) module._free(localNeighborsPointer);
    module._free(coordinates);
    module._free(cellPointer);
  }
}

function nativeDxaError(module) {
  const pointer = module._alloy_dxa_last_error();
  const message = pointer ? module.UTF8ToString(pointer) : 'DXA analysis failed.';
  if (module.HEAP32[module._alloy_dxa_cancel_ptr() / 4] || /was canceled/.test(message)) {
    return new DOMException('The DXA calculation was cancelled.', 'AbortError');
  }
  return new Error(message);
}

function exportDxaLocalInput(module, count, lattice, identifyPlanarDefects, budgetBytes) {
  const inputBytes = count * 3 * 8 + 5 * 33 * 4 + 9 * 8;
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1 || budgetBytes > 0xffff_ffff) {
    throw new Error('The WebGPU DXA snapshot budget must be a positive 32-bit byte count.');
  }
  if (inputBytes > budgetBytes) throw new Error('The DXA local input exceeds the WebGPU snapshot memory budget.');
  const positions = module._alloy_dxa_local_positions_ptr();
  const templates = module._alloy_dxa_local_templates_ptr();
  const inverse = module._alloy_dxa_local_inverse_ptr();
  if (!positions || !templates || !inverse) throw nativeDxaError(module);
  return { coordinates: module.HEAPF64.slice(positions / 8, positions / 8 + count * 3),
    templates: module.HEAPU32.slice(templates / 4, templates / 4 + 5 * 33),
    inverse: module.HEAPF64.slice(inverse / 8, inverse / 8 + 9), atomCount: count, lattice,
    identifyPlanarDefects, neighborWidth: module._alloy_dxa_local_neighbor_width() };
}

function validateDxaLocalResult(result, count, width) {
  if (!(result?.structures instanceof Int32Array) || result.structures.length !== count
    || result.structures.some(value => value < 0 || value > 5)
    || !(result.neighbors instanceof Int32Array) || result.neighbors.length !== count * width
    || result.neighborWidth !== width || result.neighbors.some(value => value < -1 || value >= count)
    || !Number.isFinite(result.maxNeighborDistance) || result.maxNeighborDistance < 0
    || (result.structures.some(value => value !== 0) ? result.maxNeighborDistance === 0 : result.maxNeighborDistance !== 0)) {
    throw new Error('WebGPU DXA returned invalid local crystal correspondence.');
  }
  if ((result.elapsedMs !== undefined && (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0))
    || ['uploadedBytes', 'readbackBytes'].some(key => result[key] !== undefined
      && (!Number.isSafeInteger(result[key]) || result[key] < 0))) {
    throw new Error('WebGPU DXA returned invalid local performance metrics.');
  }
}

function verifyDxaLocalResult(result, input, structures, neighbors, maximumDistance) {
  const fail = () => { throw new Error('WebGPU DXA local correspondence differs from the native numerical reference.'); };
  if (!result.structures.every((type, index) => type === structures[index])
    || Math.abs(result.maxNeighborDistance - maximumDistance) > 8 * Number.EPSILON * Math.max(1, maximumDistance)) fail();
  const permutation = new Int32Array(16), width = input.neighborWidth;
  for (let atom = 0; atom < structures.length; atom++) {
    const type = structures[atom];
    if (!type) continue;
    const template = (type - 1) * 33, count = input.templates[template], row = atom * width;
    for (let index = 0; index < count; index++) {
      const id = result.neighbors[row + index];
      let mapped = -1;
      for (let reference = 0; reference < count; reference++) if (neighbors[row + reference] === id) { mapped = reference; break; }
      if (mapped < 0) fail();
      for (let previous = 0; previous < index; previous++) if (permutation[previous] === mapped) fail();
      permutation[index] = mapped;
    }
    // Exactly degenerate neighbor distances can choose a different ideal
    // crystal orientation. Accept template automorphisms, while requiring
    // the same atom set, CNA signatures and every ideal adjacency relation.
    for (let index = 0; index < count; index++) {
      if (input.templates[template + 1 + index] !== input.templates[template + 1 + permutation[index]]) fail();
      const actualMask = input.templates[template + 17 + index], referenceMask = input.templates[template + 17 + permutation[index]];
      for (let other = 0; other < count; other++) {
        if (((actualMask >>> other) & 1) !== ((referenceMask >>> permutation[other]) & 1)) fail();
      }
    }
  }
}

function exportDxaSnapshot(module, budgetBytes, bufferLimitBytes = Infinity) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1 || budgetBytes > 0xffff_ffff) {
    throw new Error('The WebGPU DXA snapshot budget must be a positive 32-bit byte count.');
  }
  // The GPU Worker rejects any table larger than one device buffer. Checking
  // the native counts first avoids packing and copying a snapshot it refuses.
  const tableBytes = Math.max(module._alloy_dxa_vertex_count() * 24, module._alloy_dxa_tet_count() * 64,
    module._alloy_dxa_edge_count() * 32, module._alloy_dxa_transition_count() * 160);
  if (tableBytes > bufferLimitBytes) throw new Error('The DXA tables exceed GPU buffer limits; using CPU workers.');
  const workspaceBytes = module._alloy_dxa_tet_count() * 12 + 32;
  if (module._alloy_dxa_snapshot_bytes() + workspaceBytes > budgetBytes) {
    throw new Error('The DXA topology and GPU workspace exceed the WebGPU snapshot memory budget.');
  }
  try {
    if (!module._alloy_dxa_export(budgetBytes)) throw nativeDxaError(module);
    const vertexCount = module._alloy_dxa_vertex_count(), tetrahedronCount = module._alloy_dxa_tet_count();
    const edgeCount = module._alloy_dxa_edge_count(), transitionCount = module._alloy_dxa_transition_count();
    // These arrays own their storage. Never transfer or expose the persistent
    // Wasm heap, which is shared with all retained native pthreads.
    const copy = (heap, pointer, length) => heap.slice(pointer / heap.BYTES_PER_ELEMENT,
      pointer / heap.BYTES_PER_ELEMENT + length);
    return { vertexCount, tetrahedronCount, edgeCount, transitionCount, alpha: module._alloy_dxa_alpha(),
      vertices: copy(module.HEAPF64, module._alloy_dxa_vertex_ptr(), vertexCount * 3),
      tetrahedra: copy(module.HEAPU32, module._alloy_dxa_tet_ptr(), tetrahedronCount * 16),
      edges: copy(module.HEAPU32, module._alloy_dxa_edge_ptr(), edgeCount * 8),
      transitions: copy(module.HEAPF64, module._alloy_dxa_transition_ptr(), transitionCount * 20) };
  } finally {
    // The immutable transfer copies outlive native packing arrays. Free the
    // latter before awaiting GPU work so interface construction can reuse it.
    module._alloy_dxa_release_snapshot();
  }
}

function checkSignal(signal) {
  if (signal?.aborted) throw new DOMException('The DXA calculation was cancelled.', 'AbortError');
}

function withSignal(promise, signal) {
  if (!signal) return promise;
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('The DXA calculation was cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function normalizeDxaResult(raw, cell, parameters = {}, atomCount) {
  const settings = validateDxaParameters(parameters);
  if (!Array.isArray(raw?.segments)) throw new Error('DXA returned an invalid dislocation network.');
  const counts = Object.fromEntries(DXA_FAMILIES[settings.lattice].map(family => [family.id, 0]));
  const familyLengths = Object.fromEntries(Object.keys(counts).map(id => [id, 0]));
  const segmentIds = new Set();
  const segments = raw.segments.map((segment, index) => {
    const points = Float64Array.from(Array.isArray(segment.points?.[0]) ? segment.points.flat() : segment.points ?? []);
    if (points.length < 6 || points.length % 3 || !Array.from(points).every(Number.isFinite)) throw new Error('DXA returned invalid dislocation line coordinates.');
    const burgersVector = Array.from(segment.burgersVector ?? []), spatialBurgersVector = Array.from(segment.spatialBurgersVector ?? []);
    if (spatialBurgersVector.length !== 3 || !spatialBurgersVector.every(Number.isFinite)) throw new Error('DXA returned an invalid spatial Burgers vector.');
    const inputStructure = DXA_LATTICES.find(lattice => lattice.id === settings.lattice).kernelId;
    const classifiedFamily = classifyBurgersVector(burgersVector, settings.lattice);
    // A related phase may have no valid orientation transition into the input
    // crystal. Never interpret its local vector as belonging to another frame.
    const familyId = segment.structureType !== undefined && segment.structureType !== inputStructure ? 'other' : classifiedFamily;
    const id = segment.id ?? index;
    if (!Number.isSafeInteger(id) || id < 0 || segmentIds.has(id)) throw new Error('DXA returned duplicate or invalid segment identifiers.');
    segmentIds.add(id);
    let polylineLength = 0;
    for (let point = 3; point < points.length; point += 3) polylineLength += Math.hypot(points[point] - points[point - 3], points[point + 1] - points[point - 2], points[point + 2] - points[point - 1]);
    const length = segment.length ?? polylineLength;
    if (!Number.isFinite(length) || length < 0) throw new Error('DXA returned an invalid dislocation length.');
    counts[familyId]++; familyLengths[familyId] += length;
    return { ...segment, id, points, burgersVector, spatialBurgersVector, familyId, family: familyId, length };
  });
  const totalLength = segments.reduce((total, segment) => total + segment.length, 0);
  const volume = Math.abs(determinant3(cell.vectors));
  if (!Number.isFinite(volume) || volume <= 0) throw new Error('DXA requires a positive analyzed volume.');
  let atomStructureTypes, structureCounts = {};
  if (raw.atomStructureTypes !== undefined) {
    if (!Array.isArray(raw.atomStructureTypes) || (atomCount !== undefined && raw.atomStructureTypes.length !== atomCount)
        || raw.atomStructureTypes.some(value => !Number.isInteger(value) || value < 0 || value > 5)) throw new Error('DXA returned invalid atom structure identifiers.');
    atomStructureTypes = Uint8Array.from(raw.atomStructureTypes);
    for (const id of atomStructureTypes) structureCounts[id] = (structureCounts[id] ?? 0) + 1;
  }
  return { ...raw, segments, totalLength, volume, density: totalLength / volume, counts, familyLengths, atomStructureTypes, structureCounts,
    parameters: settings, cell: { vectors: Float64Array.from(cell.vectors), origin: Float64Array.from(cell.origin), pbc: Array.from(cell.pbc, Boolean) } };
}

/** Split unwrapped Cartesian polylines at periodic cell faces. Each output
 * piece lies in the primary triclinic cell; open axes retain their coordinates.
 * The source length/network topology are never altered by this display helper.
 */
export function splitPeriodicPolyline(points, cell) {
  if (points?.length < 6 || points.length % 3 || !Array.from(points).every(Number.isFinite)) return [];
  if (!cell.pbc.some(Boolean)) return [Float64Array.from(points)];
  const fractional = cartesianToFractional(points, cell, new Float64Array(points.length));
  const pieces = [], tolerance = 1e-10;
  let current = [];
  const append = (from, to) => {
    const start = fractionalToCartesian(from, cell, new Float64Array(3));
    const end = fractionalToCartesian(to, cell, new Float64Array(3));
    if (Math.hypot(...end.map((value, axis) => value - start[axis])) < tolerance) return;
    const last = current.slice(-3);
    if (last.length && Math.hypot(...last.map((value, axis) => value - start[axis])) > tolerance) {
      pieces.push(Float64Array.from(current)); current = [];
    }
    if (!current.length) current.push(...start);
    current.push(...end);
  };
  for (let point = 3; point < fractional.length; point += 3) {
    const from = Array.from(fractional.subarray(point - 3, point)), to = Array.from(fractional.subarray(point, point + 3));
    const times = [0, 1];
    for (let axis = 0; axis < 3; axis++) {
      if (!cell.pbc[axis] || Math.abs(to[axis] - from[axis]) < 1e-15) continue;
      const minimum = Math.min(from[axis], to[axis]), maximum = Math.max(from[axis], to[axis]);
      if (maximum - minimum > 100_000) throw new Error('Dislocation line crosses too many periodic images to display.');
      for (let face = Math.floor(minimum) + 1; face < maximum; face++) {
        const time = (face - from[axis]) / (to[axis] - from[axis]);
        if (time > 1e-12 && time < 1 - 1e-12) times.push(time);
      }
    }
    times.sort((a, b) => a - b);
    const unique = times.filter((value, index) => !index || value - times[index - 1] > 1e-12);
    for (let interval = 1; interval < unique.length; interval++) {
      const lo = unique[interval - 1], hi = unique[interval], middle = (lo + hi) / 2;
      const image = from.map((value, axis) => cell.pbc[axis] ? Math.floor(value + (to[axis] - value) * middle) : 0);
      append(from.map((value, axis) => value + (to[axis] - value) * lo - image[axis]),
        from.map((value, axis) => value + (to[axis] - value) * hi - image[axis]));
    }
  }
  if (current.length >= 6) pieces.push(Float64Array.from(current));
  return pieces;
}
