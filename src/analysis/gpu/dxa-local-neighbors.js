import { adaptiveCnaInitialRadius, MAX_GPU_CNA_RADIUS_ATTEMPTS } from './cna.js';
import { invert3 } from '../../data/model.js';
import { checkSignal, GpuUnavailableError, yieldWorker } from './runtime.js';
import { DXA_LOCAL_NEIGHBORS_SHADER, DXA_LOCAL_NEIGHBOR_LIMIT,
  DXA_LOCAL_NEIGHBOR_ROW_WORDS } from './dxa-local-neighbor-shaders.js';

export const GPU_DXA_LOCAL_NEIGHBOR_BATCH_ATOMS = 4096;

/** Prepare complete ordered nearest shells without reading their large table
 * back to JavaScript. The local CNA and ideal-template correspondence kernels
 * consume this same device buffer, including diamond neighbors of neighbors.
 * The caller owns the returned workspace and must dispose it after that pass.
 */
export async function prepareGpuDxaLocalNeighbors(runtime, frame,
  { coordinates, inverse, requiredNeighbors } = {}, { signal, onProgress = () => {} } = {}) {
  checkSignal(signal);
  const startedAt = performance.now(), count = frame?.fractional?.length / 3;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('DXA local neighbors require a complete source frame.');
  if (!(coordinates instanceof Float64Array) || coordinates.length !== count * 3
      || ![13, 15, 16].includes(requiredNeighbors)) throw new Error('Invalid prepared DXA local neighbor inputs.');
  const required = frame.cell.pbc.some(Boolean) ? requiredNeighbors : Math.min(requiredNeighbors, count - 1);
  await runtime.initialize(signal);
  const tableBytes = count * DXA_LOCAL_NEIGHBOR_ROW_WORDS * 4;
  const sourceBytes = count * 9 * 4;
  const limits = runtime.device?.limits;
  const bufferLimit = limits ? Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize) : Infinity;
  if (Math.max(tableBytes, sourceBytes) > bufferLimit) {
    throw new GpuUnavailableError('The DXA local neighbor table exceeds the GPU buffer limit.');
  }
  const packedSource = await prepareDxaLocalNeighborCoordinates(frame, coordinates, inverse, { signal });
  const owned = [], own = buffer => { owned.push(buffer); return buffer; };
  const releasePins = runtime.pinFrames?.([frame]);
  let retained = false;
  const dispose = () => { runtime.disposeBuffers(owned.splice(0)); releasePins?.(); };
  const report = (phase, completedAtoms = 0, processedAtoms) => onProgress({ phase, backend: 'gpu',
    completedAtoms, ...(processedAtoms === undefined ? {} : { processedAtoms }), totalAtoms: count, workerCount: 1 });
  try {
    report('dxa-local-neighbors-preparing');
    let radius = adaptiveCnaInitialRadius(frame);
    let context = await runtime.prepareNeighbors(frame, radius, { signal });
    runtime.reserveWorkspace?.(tableBytes + sourceBytes + 96 + 32);
    const tableBuffer = own(runtime.createBuffer(tableBytes));
    const sourceBuffer = own(runtime.storageBuffer(packedSource));
    const settingsBuffer = own(runtime.storageBuffer(prepareDxaLocalNeighborSettings(frame, required, count)));
    const statusBuffer = own(runtime.createBuffer(16));
    let completed = 0, radiusAttempts = 0;
    for (; radiusAttempts < MAX_GPU_CNA_RADIUS_ATTEMPTS; radiusAttempts++) {
      checkSignal(signal);
      if (radiusAttempts) context = await runtime.prepareNeighbors(frame, radius, { signal });
      // The neighbor context's configuration carries each dispatch's atom range.
      const bindings = runtime.neighborBindings(context, [tableBuffer, sourceBuffer, settingsBuffer, statusBuffer]);
      await runtime.runSequence(DXA_LOCAL_NEIGHBORS_SHADER, bindings, count, { batch: GPU_DXA_LOCAL_NEIGHBOR_BATCH_ATOMS, signal,
        setRange: (start, end) => runtime.write(bindings[0], new Uint32Array([start, end]), 104),
        onProgress: end => report('dxa-local-neighbors', completed, end) });
      const status = await runtime.read(statusBuffer, Uint32Array, 4, { signal });
      if (status[1]) throw new GpuUnavailableError('The DXA local neighbor candidate search exceeds the GPU per-atom budget.');
      completed = status[0];
      if (completed > count) throw new GpuUnavailableError('The GPU returned an invalid DXA local neighbor completion count.');
      report('dxa-local-neighbors', completed);
      if (completed === count) { radiusAttempts++; break; }
      radius *= 1.6;
      await yieldWorker(); checkSignal(signal);
    }
    if (completed !== count) throw new GpuUnavailableError('The GPU DXA local neighbor search could not resolve this cell geometry.');
    checkSignal(signal);
    retained = true;
    return { tableBuffer, rowWords: DXA_LOCAL_NEIGHBOR_ROW_WORDS,
      maxNeighbors: DXA_LOCAL_NEIGHBOR_LIMIT, requiredNeighbors: required, atomCount: count,
      gpuRadiusAttempts: radiusAttempts, uploadedBytes: sourceBytes + 88,
      readbackBytes: radiusAttempts * 16, elapsedMs: performance.now() - startedAt, dispose };
  } finally { if (!retained) dispose(); }
}

/** Align a cached fractional grid with native NN's second Cartesian wrap.
 * This only prepares immutable source coordinates and integer image aliases;
 * it performs no CPU neighbor search or local structure computation.
 */
export async function prepareDxaLocalNeighborCoordinates(frame, coordinates,
  inverse = invert3(frame.cell.vectors), { signal } = {}) {
  checkSignal(signal);
  if (!(inverse instanceof Float64Array) || inverse.length !== 9 || !inverse.every(Number.isFinite)) {
    throw new Error('DXA local neighbors require a finite inverse cell.');
  }
  const count = coordinates.length / 3, packed = new Uint32Array(count * 9), view = new DataView(packed.buffer);
  for (let atom = 0; atom < count; atom++) {
    const source = atom * 3, target = atom * 9;
    if (!Number.isFinite(coordinates[source]) || !Number.isFinite(coordinates[source + 1])
        || !Number.isFinite(coordinates[source + 2])) throw new Error('DXA local coordinates must be finite.');
    const x = coordinates[source] - frame.cell.origin[0];
    const y = coordinates[source + 1] - frame.cell.origin[1];
    const z = coordinates[source + 2] - frame.cell.origin[2];
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = coordinates[source + axis];
      view.setFloat64((target + axis * 2) * 4, coordinate, true);
      let canonical = frame.fractional[source + axis];
      if (!Number.isFinite(canonical)) throw new Error('DXA local fractional coordinates must be finite.');
      if (frame.cell.pbc[axis]) canonical -= Math.floor(canonical);
      const nativeFractional = (x * inverse[axis] + y * inverse[3 + axis]) + z * inverse[6 + axis];
      const difference = nativeFractional - canonical;
      const offset = frame.cell.pbc[axis] ? Math.round(difference) : 0;
      if (!Number.isSafeInteger(offset) || offset < -0x4000_0000 || offset > 0x3fff_ffff
          || Math.abs(difference - offset) > 1e-7) {
        throw new GpuUnavailableError('The DXA Cartesian origin exceeds the GPU neighbor precision budget.');
      }
      view.setInt32((target + 6 + axis) * 4, offset, true);
    }
    if (atom && atom % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
  }
  checkSignal(signal);
  return packed;
}

export function prepareDxaLocalNeighborSettings(frame, required, count) {
  const words = new Uint32Array(22), view = new DataView(words.buffer);
  words.set([required, count, 0, 0]);
  for (let component = 0; component < 9; component++) {
    view.setFloat64(16 + component * 8, frame.cell.vectors[component], true);
  }
  return words;
}
