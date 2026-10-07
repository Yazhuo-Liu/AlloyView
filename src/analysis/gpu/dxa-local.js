import { checkSignal, GpuUnavailableError, yieldWorker } from './runtime.js';
import { prepareGpuDxaLocalNeighbors } from './dxa-local-neighbors.js';
import { DXA_LOCAL_SHADER, DXA_LOCAL_WORKGROUP_SIZE, DXA_LOCAL_SETTINGS_WORDS,
  DXA_LOCAL_ROW_WORDS, DXA_LOCAL_TEMPLATE_WORDS, DXA_LOCAL_NEIGHBOR_ROW_WORDS } from './dxa-local-shaders.js';

export const GPU_DXA_LOCAL_BATCH_ATOMS = 2048;
export const DXA_LOCAL_GPU_STAGES = ['local-neighbors', 'local-structures', 'local-correspondence'];
const MISSING = 0xffff_ffff;

/** The complete nearest shells stay on the GPU through CNA and exact graph
 * correspondence. Only types and ideal-ordered atom indices cross back into
 * the retained native session for crystal mapping and dislocation tracing.
 */
export async function analyzeGpuDxaLocalStructures(runtime, frame, input, { signal, onProgress = () => {} } = {}) {
  const startedAt = performance.now();
  checkSignal(signal);
  const { atomCount, neighborWidth, requiredNeighbors } = validateGpuDxaLocalInput(frame, input);
  await runtime.initialize(signal);
  const workspaceBytes = preflightGpuDxaLocalMemory(runtime, atomCount, { reserve: false });
  const owned = [], own = buffer => { owned.push(buffer); return buffer; };
  const releasePins = runtime.pinFrames?.([frame]);
  let nearest;
  const report = (phase, completedAtoms = 0) => onProgress({ phase, backend: 'gpu', workerCount: 1,
    completedAtoms, totalAtoms: atomCount });
  try {
    // Allocate the smaller output first so preparing the resident nearest table
    // accounts for it when reserving the remaining device memory.
    runtime.reserveWorkspace?.(workspaceBytes);
    const outputBuffer = own(runtime.createBuffer(atomCount * DXA_LOCAL_ROW_WORDS * 4));
    const settings = prepareGpuDxaLocalSettings(frame, input, atomCount);
    const settingsBuffer = own(runtime.storageBuffer(settings));
    const templatesBuffer = own(runtime.storageBuffer(input.templates));
    nearest = await prepareGpuDxaLocalNeighbors(runtime, frame,
      { coordinates: input.coordinates, inverse: input.inverse, requiredNeighbors }, { signal, onProgress });
    const bindings = [settingsBuffer, nearest.tableBuffer, templatesBuffer, outputBuffer];
    report('dxa-local-structures');
    await runtime.runSequence(DXA_LOCAL_SHADER, bindings, atomCount, { batch: GPU_DXA_LOCAL_BATCH_ATOMS, signal,
      workgroupSize: DXA_LOCAL_WORKGROUP_SIZE, setRange: (start, end) => runtime.write(settingsBuffer, new Uint32Array([start, end]), 4),
      onProgress: end => report('dxa-local-structures', end) });
    report('dxa-local-readback');
    const rows = await runtime.read(outputBuffer, Uint32Array, atomCount * DXA_LOCAL_ROW_WORDS, { signal });
    const structures = new Int32Array(atomCount), neighbors = new Int32Array(atomCount * neighborWidth).fill(-1);
    const view = new DataView(rows.buffer, rows.byteOffset, rows.byteLength);
    let maxNeighborDistance = 0;
    for (let atom = 0; atom < atomCount; atom++) {
      const offset = atom * DXA_LOCAL_ROW_WORDS, status = rows[offset + 19], type = rows[offset];
      if (status >= 1 && status <= 3) throw new GpuUnavailableError('The simulation cell is too small for DXA local structure analysis.');
      if (status) throw new GpuUnavailableError(status === 4
        ? 'The exact DXA crystal correspondence exceeds the GPU per-atom search budget.'
        : 'The GPU returned an incomplete DXA local structure row.');
      if (type > 5 || (type && !allowedStructure(input, type))) throw new GpuUnavailableError('The GPU returned an invalid DXA crystal type.');
      structures[atom] = type;
      const cutoff = view.getFloat64((offset + 17) * 4, true);
      if (!Number.isFinite(cutoff) || cutoff < 0 || (type ? cutoff === 0 : cutoff !== 0)) {
        throw new GpuUnavailableError('The GPU returned an invalid DXA neighbor cutoff.');
      }
      maxNeighborDistance = Math.max(maxNeighborDistance, cutoff);
      const count = type ? input.templates[(type - 1) * DXA_LOCAL_TEMPLATE_WORDS] : 0;
      for (let index = 0; index < 16; index++) {
        const other = rows[offset + 1 + index];
        if (index >= count) {
          if (other !== MISSING) throw new GpuUnavailableError('The GPU returned an invalid unused DXA neighbor.');
        } else {
          if (other >= atomCount || other === atom) throw new GpuUnavailableError('The GPU returned an invalid ordered DXA neighbor.');
          for (let previous = 0; previous < index; previous++) {
            if (rows[offset + 1 + previous] === other) throw new GpuUnavailableError('The DXA crystal neighborhood contains ambiguous periodic images.');
          }
          neighbors[atom * neighborWidth + index] = other;
        }
      }
      if (atom && atom % 16_384 === 0) { await yieldWorker(); checkSignal(signal); }
    }
    checkSignal(signal);
    report('complete', atomCount);
    return { structures, neighbors, neighborWidth, width: neighborWidth, maxNeighborDistance,
      gpuStages: [...DXA_LOCAL_GPU_STAGES], arithmetic: 'ieee754-f64', gpuRadiusAttempts: nearest.gpuRadiusAttempts,
      elapsedMs: performance.now() - startedAt, uploadedBytes: nearest.uploadedBytes + settings.byteLength + input.templates.byteLength,
      readbackBytes: nearest.readbackBytes + rows.byteLength };
  } finally { nearest?.dispose(); runtime.disposeBuffers(owned); releasePins?.(); }
}

/** Schema validation is inexpensive enough for the client. Coordinates are
 * checked cooperatively by the worker's nearest-shell preparation.
 */
export function validateGpuDxaLocalInput(frame, input) {
  const atomCount = frame?.fractional?.length / 3;
  if (!Number.isSafeInteger(atomCount) || atomCount < 1 || atomCount >= MISSING
    || !(input?.coordinates instanceof Float64Array) || input.coordinates.length !== atomCount * 3
    || !(input.templates instanceof Uint32Array) || input.templates.length !== 5 * DXA_LOCAL_TEMPLATE_WORDS
    || !(input.inverse instanceof Float64Array) || input.inverse.length !== 9
    || !Number.isInteger(input.lattice) || input.lattice < 1 || input.lattice > 5
    || typeof input.identifyPlanarDefects !== 'boolean') throw new Error('GPU DXA requires complete native local structure inputs.');
  for (const array of [input.coordinates, input.templates, input.inverse]) {
    if (!(array.buffer instanceof ArrayBuffer)) throw new Error('GPU DXA local inputs must own transferable ArrayBuffers.');
  }
  if (input.inverse.some(value => !Number.isFinite(value))) throw new Error('GPU DXA inverse cell must be finite.');
  for (let type = 0; type < 5; type++) {
    const offset = type * DXA_LOCAL_TEMPLATE_WORDS, count = [12, 12, 14, 16, 16][type], mask = (1 << count) - 1;
    if (input.templates[offset] !== count) throw new Error('GPU DXA ideal templates have invalid neighbor counts.');
    for (let index = 0; index < 16; index++) {
      const bonds = input.templates[offset + 17 + index], signature = input.templates[offset + 1 + index];
      if (signature > [0, 1, 1, 1, 2][type]) throw new Error('GPU DXA ideal templates have invalid CNA signatures.');
      if (bonds & ~mask || bonds & (1 << index) || (index >= count && (bonds || signature))) {
        throw new Error('GPU DXA ideal templates have invalid bonds.');
      }
      for (let other = 0; other < count; other++) {
        if (Boolean(bonds & (1 << other)) !== Boolean(input.templates[offset + 17 + other] & (1 << index))) {
          throw new Error('GPU DXA ideal template bonds must be symmetric.');
        }
      }
    }
  }
  const neighborWidth = input.lattice >= 4 ? 16 : input.lattice === 3 ? 14 : 12;
  return { atomCount, neighborWidth, requiredNeighbors: input.lattice >= 4 ? 16 : neighborWidth + 1 };
}

export function prepareGpuDxaLocalSettings(frame, input, atomCount = frame.fractional.length / 3) {
  const words = new Uint32Array(DXA_LOCAL_SETTINGS_WORDS), view = new DataView(words.buffer);
  const pbc = frame.cell.pbc.reduce((bits, periodic, axis) => bits | (periodic ? 1 << axis : 0), 0);
  words.set([atomCount, 0, atomCount, input.lattice, input.identifyPlanarDefects ? 1 : 0, pbc]);
  for (let index = 0; index < 9; index++) view.setFloat64(32 + index * 8, input.inverse[index], true);
  view.setFloat64(104, 0.5 + 1e-12, true);
  view.setFloat64(112, Math.fround(1e-12), true);
  return words;
}

export function preflightGpuDxaLocalMemory(runtime, atomCount, { reserve = true } = {}) {
  // Includes one readback staging buffer; nearest shells never need staging.
  const sizes = [atomCount * DXA_LOCAL_NEIGHBOR_ROW_WORDS * 4, atomCount * 36,
    atomCount * DXA_LOCAL_ROW_WORDS * 4, atomCount * DXA_LOCAL_ROW_WORDS * 4, 128, 660, 88, 16, 16];
  const limit = Math.min(runtime.device?.limits.maxBufferSize ?? Infinity,
    runtime.device?.limits.maxStorageBufferBindingSize ?? Infinity);
  if (sizes.some(size => size > limit)) throw new GpuUnavailableError('The DXA local tables exceed GPU buffer limits; using CPU workers.');
  const bytes = sizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isSafeInteger(bytes) || bytes > (runtime.budgetBytes ?? Infinity)) {
    throw new GpuUnavailableError('The DXA local tables exceed the GPU memory budget; using CPU workers.');
  }
  if (reserve) runtime.reserveWorkspace?.(bytes);
  return bytes;
}

function allowedStructure(input, type) {
  if (input.lattice <= 2) return type === input.lattice || (input.identifyPlanarDefects && (type === 1 || type === 2));
  if (input.lattice === 3) return type === 3;
  return type === input.lattice || (input.identifyPlanarDefects && (type === 4 || type === 5));
}
