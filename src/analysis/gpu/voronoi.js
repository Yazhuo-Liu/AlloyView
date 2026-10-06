import { determinant3 } from '../../data/model.js';
import { atomRange } from '../neighbors.js';
import { VORONOI_FIELDS, validateVoronoiParameters, initialGeometry, finalizeVoronoiStatistics, calculateVoronoi, createVoronoiContext } from '../voronoi.js';
import { prepareVoronoiSelection, voronoiSelectionRange, expandVoronoiResult } from '../voronoi-selection.js';
import { GpuRuntime, checkSignal, GpuUnavailableError, yieldWorker } from './runtime.js';
import { GPU_VORONOI_MAX_FACES, GPU_VORONOI_MAX_FACE_VERTICES, GPU_VORONOI_STATE_WORDS, GPU_VORONOI_MAX_PLANES,
  VORONOI_INITIALIZE_SHADER, VORONOI_CLIP_SHADER } from './voronoi-shaders.js';

export const GPU_VORONOI_BATCH_ATOMS = 512;
export const GPU_VORONOI_SETTINGS_BYTES = 336;
export const MAX_GPU_VORONOI_CORRECTIONS = 2048;

/** Temporary convex geometry depends on the batch, not on trajectory size.
 * One resident workspace survives repeated runs alongside the shared device. */
export function voronoiGpuWorkspaceBytes(capacity = GPU_VORONOI_BATCH_ATOMS) {
  return capacity * (GPU_VORONOI_MAX_FACES * GPU_VORONOI_MAX_FACE_VERTICES * 16
    + GPU_VORONOI_MAX_FACES * 16 + GPU_VORONOI_STATE_WORDS * 4 + GPU_VORONOI_MAX_PLANES * 32) + GPU_VORONOI_SETTINGS_BYTES;
}

/** Hardware adapters receive more independent cell workgroups when buffer and
 * memory limits allow it. Software/mobile budgets remain bounded as well. */
export function voronoiGpuBatchSize(runtime, atomCount) {
  const adapter = runtime.adapterInfo ?? {};
  const software = adapter.isFallbackAdapter || /swiftshader|software|llvmpipe/i.test(`${adapter.vendor ?? ''} ${adapter.architecture ?? ''}`);
  const target = software || !runtime.device ? GPU_VORONOI_BATCH_ATOMS : 2048;
  const perAtom = voronoiGpuWorkspaceBytes(1) - GPU_VORONOI_SETTINGS_BYTES;
  const retained = runtime.voronoiWorkspace ? voronoiGpuWorkspaceBytes(runtime.voronoiWorkspace.capacity) : 0;
  const available = runtime.budgetBytes === undefined ? Infinity : runtime.budgetBytes - runtime.allocatedBytes + retained;
  // Allow staging for the complete face descriptors and state readbacks.
  const byBudget = Math.floor((available - GPU_VORONOI_SETTINGS_BYTES) / (perAtom + GPU_VORONOI_MAX_FACES * 16 + GPU_VORONOI_STATE_WORDS * 4));
  const limits = runtime.device?.limits, storageLimit = limits ? Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize) : Infinity;
  const byBinding = Math.floor(storageLimit / (GPU_VORONOI_MAX_FACES * GPU_VORONOI_MAX_FACE_VERTICES * 16));
  const maximum = Math.min(target, atomCount, byBudget, byBinding);
  if (maximum < 1) throw new GpuUnavailableError('The GPU cannot reserve one complete Voronoi cell workspace; using exact CPU workers.');
  return maximum < 32 ? maximum : Math.floor(maximum / 32) * 32;
}

function workspace(runtime, capacity) {
  if (runtime.voronoiWorkspace?.capacity >= capacity) return runtime.voronoiWorkspace;
  const previous = runtime.voronoiWorkspace;
  if (previous) runtime.disposeBuffers(previous.buffers);
  runtime.voronoiWorkspace = null;
  runtime.reserveWorkspace(voronoiGpuWorkspaceBytes(capacity));
  const buffers = [], allocate = bytes => { const buffer = runtime.createBuffer(bytes); buffers.push(buffer); return buffer; };
  try {
    const geometry = allocate(capacity * GPU_VORONOI_MAX_FACES * GPU_VORONOI_MAX_FACE_VERTICES * 16);
    const faces = allocate(capacity * GPU_VORONOI_MAX_FACES * 16);
    const states = allocate(capacity * GPU_VORONOI_STATE_WORDS * 4);
    const settings = allocate(GPU_VORONOI_SETTINGS_BYTES);
    const planes = allocate(capacity * GPU_VORONOI_MAX_PLANES * 32);
    return runtime.voronoiWorkspace = { capacity, geometry, faces, states, settings, planes, buffers };
  } catch (error) { runtime.disposeBuffers(buffers); throw error; }
}

function orthogonal(vectors) {
  for (let first = 0; first < 3; first++) for (let second = first + 1; second < 3; second++) {
    let dot = 0; for (let axis = 0; axis < 3; axis++) dot += vectors[first * 3 + axis] * vectors[second * 3 + axis];
    if (dot !== 0) return false;
  }
  return true;
}

export function prepareGpuVoronoi(frame, parameters = {}) {
  validateVoronoiParameters(parameters);
  const count = frame.fractional.length / 3;
  if (!Number.isInteger(count) || count < 1) throw new Error('Voronoi requires at least one atom.');
  const { startAtom, endAtom } = atomRange(count, parameters);
  const cellVolume = Math.abs(determinant3(frame.cell.vectors)), scale = Math.cbrt(cellVolume / count);
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('Voronoi requires a finite nonsingular cell.');
  const geometry = initialGeometry(frame.cell);
  for (let atom = 0; atom < count; atom++) for (let axis = 0; axis < 3; axis++) {
    const value = frame.fractional[atom * 3 + axis];
    if (!Number.isFinite(value)) throw new Error(`Atom ${atom + 1} has a non-finite fractional coordinate.`);
    if (!frame.cell.pbc[axis] && (value < -1e-10 || value > 1 + 1e-10)) {
      throw new Error(`Voronoi requires nonperiodic atom ${atom + 1} to lie inside the simulation cell.`);
    }
  }
  const coefficients = [...geometry.normals.flat(), ...geometry.lengths, ...geometry.inverseNormals, scale];
  if (coefficients.some(value => !Number.isFinite(Math.fround(value)))
      || Math.max(...Array.from(geometry.inverseNormals, Math.abs)) > 128) {
    throw new GpuUnavailableError('The Voronoi seed geometry exceeds GPU numeric precision; using exact CPU workers.');
  }
  const exactSingleSite = count === 1 && frame.cell.pbc.every(Boolean) && orthogonal(frame.cell.vectors);
  return { count, startAtom, endAtom, cellVolume, scale, geometry, exactSingleSite,
    faceAreaThreshold: parameters.faceAreaThreshold ?? 0,
    relativeFaceAreaThreshold: parameters.relativeFaceAreaThreshold ?? 0, bins: parameters.bins ?? 50 };
}

/** GPU-native incremental half-space intersection. Every invocation constructs
 * one complete cell; linked-cell images are neither uploaded nor downloaded.
 * Six rigorous seed bounds and twice-farthest-vertex coverage prove that no
 * relevant atomic plane is omitted. Resource/numeric failures are explicit. */
export async function analyzeGpuVoronoi(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  checkSignal(signal);
  const selection = prepareVoronoiSelection(frame, parameters.selectedTypes);
  if (selection.isAll) return expandVoronoiResult(await analyzeGpuVoronoiCells(runtime, frame, parameters, { signal, onProgress }), selection);
  // The normal client compacts before transferring input. Direct/runtime users
  // receive the same scientific behavior, with a separate resident cache key.
  if (selection.frame.gpuFrameId === undefined) selection.frame.gpuFrameId = -++GpuRuntime.frameSerial;
  const release = runtime.pinFrames?.([selection.frame]);
  try {
    const result = await analyzeGpuVoronoiCells(runtime, selection.frame,
      { ...parameters, ...voronoiSelectionRange(selection, parameters), selectedTypes: null }, { signal, onProgress });
    return expandVoronoiResult(result, selection);
  } finally { release?.(); }
}

async function analyzeGpuVoronoiCells(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  checkSignal(signal);
  const prepared = prepareGpuVoronoi(frame, parameters);
  const { count, startAtom, endAtom, cellVolume, scale, geometry, exactSingleSite,
    faceAreaThreshold, relativeFaceAreaThreshold, bins } = prepared;
  await runtime.initialize(signal);
  const size = endAtom - startAtom, kernelReused = Boolean(runtime.voronoiWorkspace);
  const scratch = workspace(runtime, voronoiGpuBatchSize(runtime, size));
  const settingsWords = new Uint32Array(GPU_VORONOI_SETTINGS_BYTES / 4), settingsFloats = new Float32Array(settingsWords.buffer);
  for (let axis = 0; axis < 3; axis++) {
    settingsFloats.set([...geometry.normals[axis], geometry.lengths[axis]], axis * 4);
    settingsFloats.set(Array.from(geometry.inverseNormals).slice(axis * 3, axis * 3 + 3), 12 + axis * 4);
  }
  for (let axis = 0; axis < 3; axis++) {
    const height = frame.cell.pbc[axis] ? geometry.lengths[axis] / (2 * scale) : 1 / (geometry.lengths[axis] * scale);
    for (let component = 0; component < 4; component++) {
      const value = component < 3 ? geometry.normals[axis][component] : height, high = Math.fround(value);
      settingsFloats[36 + axis * 8 + component] = high; settingsFloats[40 + axis * 8 + component] = value - high;
      if (component < 3) {
        const coefficient = frame.cell.vectors[axis * 3 + component] / scale, upper = Math.fround(coefficient);
        settingsFloats[60 + axis * 8 + component] = upper; settingsFloats[64 + axis * 8 + component] = coefficient - upper;
      }
    }
  }
  settingsFloats[24] = scale; settingsWords[28] = Number(exactSingleSite);
  const result = Object.fromEntries(Object.entries(VORONOI_FIELDS).map(([name, [Type]]) => [name, new Type(size)]));
  const faceOffsets = new Uint32Array(size + 1), faceAreas = [], faceOrders = [], faceNeighbors = [],
    faceBoundary = [], faceAccepted = [], voronoiIndices = new Array(size);
  let candidateCount = 0, dispatches = 0, correctionAtoms = 0;
  const correctionLimit = Math.min(MAX_GPU_VORONOI_CORRECTIONS, Math.max(16, Math.floor(size * .1)));
  const needsCorrection = new Map(), correctionReasons = { geometry: 0, threshold: 0, coverage: 0 }, correctionPrecisionCodes = {};
  const correctCell = async (atom, reason) => {
    if (++correctionAtoms > correctionLimit) {
      const pending = {};
      for (const reason of needsCorrection.values()) pending[reason] = (pending[reason] ?? 0) + 1;
      throw new GpuUnavailableError(`Too many Voronoi cells need exact recovery (${JSON.stringify(pending)}; precision ${JSON.stringify(correctionPrecisionCodes)}); using parallel CPU workers.`);
    }
    checkSignal(signal);
    let cached = runtime.voronoiCpuContext;
    if (!cached || cached.context.frame.fractional !== frame.fractional || cached.context.frame.cell !== frame.cell) {
      cached = runtime.voronoiCpuContext = { frameKey: runtime.frameKey?.(frame), context: createVoronoiContext(frame) };
    }
    onProgress({ phase: 'precisionCorrection', completedAtoms: atom - startAtom, totalAtoms: size,
      correctionAtoms, correctionLimit });
    const local = await calculateVoronoi(frame, { startAtom: atom, endAtom: atom + 1, context: cached.context,
      skipStatistics: true, faceAreaThreshold, relativeFaceAreaThreshold, bins });
    checkSignal(signal); correctionReasons[reason]++;
    const row = atom - startAtom;
    for (const name of Object.keys(VORONOI_FIELDS)) result[name][row] = local[name][0];
    for (let face = 0; face < local.faceAreas.length; face++) {
      faceAreas.push(local.faceAreas[face]); faceOrders.push(local.faceOrders[face]); faceNeighbors.push(local.faceNeighbors[face]);
      faceBoundary.push(local.faceBoundary[face]); faceAccepted.push(local.faceAccepted[face]);
    }
    voronoiIndices[row] = local.voronoiIndices[0]; faceOffsets[row + 1] = faceAreas.length;
    candidateCount += local.candidateCount;
    // Let cancel messages reach this persistent worker between exact cells.
    await yieldWorker(); checkSignal(signal);
  };
  onProgress({ phase: 'analyzing', completedAtoms: 0, totalAtoms: size });
  const initialRadius = exactSingleSite ? Math.min(...geometry.lengths) * .45 : scale * 2.5;
  for (let begin = startAtom; begin < endAtom; begin += scratch.capacity) {
    checkSignal(signal);
    const end = Math.min(endAtom, begin + scratch.capacity), batchCount = end - begin;
    settingsWords[26] = begin; settingsFloats[25] = 0;
    let radius = initialRadius, context = await runtime.prepareNeighbors(frame, radius, { signal });
    runtime.write(scratch.settings, settingsWords);
    let bindings = runtime.neighborBindings(context, [scratch.settings, scratch.geometry, scratch.faces, scratch.states, scratch.planes]);
    await runtime.run(VORONOI_INITIALIZE_SHADER, bindings, batchCount,
      { signal, startAtom: begin, endAtom: end, batchSize: 0, workgroupSize: 32 }); dispatches++;
    let states;
    for (let attempt = 0; attempt < 32; attempt++) {
      if (!exactSingleSite) {
        try { context = await runtime.prepareNeighbors(frame, radius, { signal }); }
        catch (error) {
          if (error.name !== 'GpuUnavailableError' || !states) throw error;
          // Dense/slab images may exceed the common GPU traversal bounds only
          // for a few exterior cells. Completed cells keep their GPU geometry;
          // recover the remaining cells exactly instead of restarting them all.
          for (let row = 0; row < batchCount; row++) {
            if (!states[row * GPU_VORONOI_STATE_WORDS + 2] && !needsCorrection.has(begin + row)) needsCorrection.set(begin + row, 'coverage');
          }
          break;
        }
        bindings = runtime.neighborBindings(context, [scratch.settings, scratch.geometry, scratch.faces, scratch.states, scratch.planes]);
        runtime.write(scratch.settings, settingsWords);
        await runtime.run(VORONOI_CLIP_SHADER, bindings, batchCount,
          { signal, startAtom: begin, endAtom: end, batchSize: 0, workgroupSize: 32 }); dispatches++;
      }
      states = await runtime.read(scratch.states, Uint32Array, batchCount * GPU_VORONOI_STATE_WORDS, { signal });
      const floats = new Float32Array(states.buffer);
      let remaining = 0, farthest = 0;
      for (let row = 0; row < batchCount; row++) {
        const offset = row * GPU_VORONOI_STATE_WORDS, flags = states[offset + 1];
        if (flags & 4 && !(flags & 1)) {
          if (!needsCorrection.has(begin + row)) {
            const code = states[offset + 15], reason = ({ 1: 'edgeProof', 2: 'capPrecision', 3: 'adjacentPrecision',
              4: 'closingPrecision', 6: 'nearContact', 10: 'illConditionedProof', 11: 'weakTurn', 12: 'nativeMarginalContact' })[code] ?? `code${code}`;
            correctionPrecisionCodes[reason] = (correctionPrecisionCodes[reason] ?? 0) + 1;
            needsCorrection.set(begin + row, 'geometry');
          }
          continue;
        }
        if (flags) {
          const reason = flags & 1 ? 'face or polygon capacity' : flags & 4 ? 'geometric precision' : 'degenerate geometry';
          throw new GpuUnavailableError(`Voronoi atom ${begin + row + 1} exceeds GPU ${reason}; using exact CPU workers.`);
        }
        if (!states[offset + 2]) { remaining++; farthest = Math.max(farthest, floats[offset + 6] * scale); }
      }
      if (!remaining) break;
      if (attempt === 31) throw new GpuUnavailableError('GPU Voronoi neighbor coverage did not complete; using exact CPU workers.');
      settingsFloats[25] = radius;
      radius = Math.min(radius * 1.8, Math.max(radius * (1 + 1e-4), 2 * farthest * (1 + 1e-4)));
    }
    const descriptors = await runtime.read(scratch.faces, Uint32Array, batchCount * GPU_VORONOI_MAX_FACES * 4, { signal });
    const descriptorFloats = new Float32Array(descriptors.buffer), descriptorSigned = new Int32Array(descriptors.buffer),
      stateFloats = new Float32Array(states.buffer);
    for (let atom = begin; atom < end; atom++) {
      const row = atom - begin, output = atom - startAtom, offset = row * GPU_VORONOI_STATE_WORDS;
      candidateCount += states[offset + 3];
      if (needsCorrection.has(atom)) { await correctCell(atom, needsCorrection.get(atom)); continue; }
      const volume = stateFloats[offset + 4] * scale ** 3, surface = stateFloats[offset + 5] * scale ** 2;
      let ambiguousThreshold = false;
      for (let face = 0; face < states[offset]; face++) {
        const base = (row * GPU_VORONOI_MAX_FACES + face) * 4, area = descriptorFloats[base + 2] * scale ** 2;
        if (descriptorSigned[base + 1] >= 0 && ((faceAreaThreshold > 0 && Math.abs(area - faceAreaThreshold) <= 2e-5 * Math.max(area, faceAreaThreshold, scale ** 2))
            || (relativeFaceAreaThreshold > 0 && Math.abs(area / surface - relativeFaceAreaThreshold) <= 2e-5))) {
          ambiguousThreshold = true; break;
        }
      }
      if (ambiguousThreshold) { await correctCell(atom, 'threshold'); continue; }
      result.atomicVolume[output] = volume; result.voronoiSurfaceArea[output] = surface;
      const orders = new Map();
      for (let face = 0; face < states[offset]; face++) {
        const base = (row * GPU_VORONOI_MAX_FACES + face) * 4, area = descriptorFloats[base + 2] * scale ** 2,
          order = descriptors[base], neighbor = descriptorSigned[base + 1], boundary = neighbor < 0;
        const accepted = !boundary && area > faceAreaThreshold && area / surface > relativeFaceAreaThreshold;
        faceAreas.push(area); faceOrders.push(order); faceNeighbors.push(boundary ? -1 : neighbor);
        faceBoundary.push(Number(boundary)); faceAccepted.push(Number(accepted));
        if (boundary) result.voronoiBoundaryFaces[output]++;
        if (accepted) {
          result.voronoiCoordination[output]++;
          result.voronoiMaxFaceOrder[output] = Math.max(result.voronoiMaxFaceOrder[output], order);
          orders.set(order, (orders.get(order) ?? 0) + 1);
        }
      }
      const maximum = Math.max(6, ...orders.keys());
      voronoiIndices[output] = `<${Array.from({ length: maximum - 2 }, (_, index) => orders.get(index + 3) ?? 0).join(',')}>`;
      faceOffsets[output + 1] = faceAreas.length;
    }
    onProgress({ phase: 'analyzing', completedAtoms: end - startAtom, totalAtoms: size, done: end - startAtom, total: size });
    if (end < endAtom) await yieldWorker();
  }
  checkSignal(signal);
  const output = { ...result, faceOffsets, faceAreas: Float64Array.from(faceAreas), faceOrders: Uint32Array.from(faceOrders),
    faceNeighbors: Int32Array.from(faceNeighbors), faceBoundary: Uint8Array.from(faceBoundary), faceAccepted: Uint8Array.from(faceAccepted),
    voronoiIndices, startAtom, endAtom, sourceAtomCount: count, cellVolume,
    boundaryMode: frame.cell.pbc.every(Boolean) ? 'periodic' : 'finite-cell', faceAreaThreshold, relativeFaceAreaThreshold,
    candidateCount, kernelReused, gpuDispatches: dispatches, gpuBatchCapacity: scratch.capacity, gpuCorrectionAtoms: correctionAtoms, gpuCorrectionLimit: correctionLimit, gpuCorrectionReasons: correctionReasons, gpuCorrectionPrecisionCodes: correctionPrecisionCodes,
    engine: correctionAtoms ? 'webgpu-voronoi+exact-cell-correction' : 'webgpu-voronoi',
    autoRangeRelativeTolerance: { atomicVolume: 32 * 2 ** -23, voronoiSurfaceArea: 32 * 2 ** -23 } };
  return { ...output, ...finalizeVoronoiStatistics(output, { bins }) };
}
