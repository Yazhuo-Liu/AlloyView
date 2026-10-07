import { determinant3 } from '../data/model.js';

let kernelPromise, kernelModule, kernelGeneration = 0, resident;
const FIELDS = ['vertices', 'tetrahedra', 'edges', 'transitions'];
const WIDTHS = [0, 12, 12, 14, 16, 16];

async function getKernel(onPhase = () => {}) {
  const reused = Boolean(kernelPromise);
  if (!kernelPromise) {
    onPhase('initializing');
    kernelPromise = (async () => {
      const { default: createDxa } = await import('./dxa-kernel.mjs');
      const options = {};
      if (typeof process === 'object' && process.versions?.node) {
        const { readFile } = await import('node:fs/promises');
        options.wasmBinary = await readFile(new URL('./dxa-kernel.wasm', import.meta.url));
      }
      const module = await createDxa(options);
      kernelModule = module;
      kernelGeneration++;
      return module;
    })().catch(error => { kernelPromise = undefined; throw error; });
  }
  return { module: await kernelPromise, kernelReused: reused };
}

export function dxaCpuKernelMemoryBytes() { return kernelModule?.HEAPU8.byteLength ?? 0; }

export async function warmupDxaCpuStages({ onPhase } = {}) {
  const { module, kernelReused } = await getKernel(onPhase);
  return { kernelReused, kernelGeneration, wasmMemoryBytes: module.HEAPU8.byteLength };
}

export function validateDxaLocalInput(input) {
  const count = input?.atomCount;
  if (!Number.isSafeInteger(count) || count < 1 || !(input.coordinates instanceof Float64Array)
      || input.coordinates.length !== count * 3 || !Number.isInteger(input.lattice) || !WIDTHS[input.lattice]
      || typeof input.perfectOnly !== 'boolean') throw new Error('CPU DXA local input has invalid dimensions or crystal settings.');
  const cell = input.cell;
  if (cell?.vectors?.length !== 9 || cell?.origin?.length !== 3 || cell?.pbc?.length !== 3
      || ![...cell.vectors, ...cell.origin].every(Number.isFinite)
      || !Number.isFinite(determinant3(cell.vectors)) || Math.abs(determinant3(cell.vectors)) < 1e-12) {
    throw new Error('CPU DXA local recognition requires a finite nonsingular cell.');
  }
  return { atomCount: count, neighborWidth: WIDTHS[input.lattice] };
}

export function validateDxaSnapshot(input) {
  for (const [count, field, Type, stride] of [['vertexCount', 'vertices', Float64Array, 3],
    ['tetrahedronCount', 'tetrahedra', Uint32Array, 16], ['edgeCount', 'edges', Uint32Array, 8],
    ['transitionCount', 'transitions', Float64Array, 20]]) {
    if (!Number.isSafeInteger(input?.[count]) || input[count] < 1 || !(input[field] instanceof Type)
        || input[field].length !== input[count] * stride) throw new Error('CPU DXA interface tables have invalid dimensions.');
  }
  if (!Number.isFinite(input.alpha) || input.alpha < 0) throw new Error('CPU DXA interface alpha must be finite and nonnegative.');
  return input.tetrahedronCount;
}

function checkedRange(start, end, count) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > count) {
    throw new Error('CPU DXA task has an invalid range.');
  }
}

function nativeError(module, name) {
  const pointer = module[name]();
  return new Error(pointer ? module.UTF8ToString(pointer) : 'CPU DXA stage failed.');
}

function allocate(module, values) {
  const pointer = module._malloc(values.byteLength);
  if (!pointer) throw new Error('Insufficient memory for a CPU DXA stage input.');
  new values.constructor(module.HEAPU8.buffer, pointer, values.length).set(values);
  return pointer;
}

function disposeResident(module) {
  if (!resident) return;
  if (resident.kind === 'local') module._alloy_dxa_local_dispose();
  for (const pointer of resident.pointers ?? []) module._free(pointer);
  resident = undefined;
}

export async function releaseDxaCpuStageData(key) {
  if (kernelPromise) {
    const module = await kernelPromise;
    if (key === undefined || resident?.key === key) disposeResident(module);
  }
}

/** Each Worker initializes one full binary64 geometry/index and only copies
 * its assigned output rows. Subsequent chunks carry the immutable resident key.
 */
export async function calculateDxaLocalRange(input, { residentKey, startAtom, endAtom, onPhase = () => {} } = {}) {
  const { module, kernelReused } = await getKernel(onPhase);
  module._alloy_dxa_reset_cancel();
  let frameUploaded = false;
  if (input) {
    const dimensions = validateDxaLocalInput(input);
    disposeResident(module);
    let coordinates = 0, cellPointer = 0;
    try {
      coordinates = allocate(module, input.coordinates);
      cellPointer = allocate(module, Float64Array.from([...input.cell.vectors, ...input.cell.origin]));
      const pbc = input.cell.pbc.reduce((bits, value, axis) => bits | (value ? 1 << axis : 0), 0);
      onPhase('indexing');
      if (!module._alloy_dxa_local_prepare(coordinates, input.atomCount, cellPointer, pbc, input.lattice, input.perfectOnly ? 1 : 0)) {
        throw nativeError(module, '_alloy_dxa_local_error');
      }
      resident = { key: residentKey, kind: 'local', ...dimensions };
      frameUploaded = true;
    } finally {
      if (coordinates) module._free(coordinates);
      if (cellPointer) module._free(cellPointer);
    }
  }
  if (!resident || resident.key !== residentKey || resident.kind !== 'local') throw new Error('The resident CPU DXA geometry is unavailable.');
  checkedRange(startAtom, endAtom, resident.atomCount);
  onPhase('analyzing');
  if (!module._alloy_dxa_local_identify(startAtom, endAtom)) throw nativeError(module, '_alloy_dxa_local_error');
  const width = module._alloy_dxa_local_neighbor_width(), count = endAtom - startAtom;
  const types = module._alloy_dxa_local_structures_ptr(), neighbors = module._alloy_dxa_local_neighbors_ptr();
  if (!types || !neighbors || width !== resident.neighborWidth) throw new Error('CPU DXA local output is incomplete.');
  return { startAtom, endAtom, structures: module.HEAP32.slice(types / 4 + startAtom, types / 4 + endAtom),
    neighbors: module.HEAP32.slice(neighbors / 4 + startAtom * width, neighbors / 4 + endAtom * width),
    neighborWidth: width, maxNeighborDistance: module._alloy_dxa_local_max_distance(),
    kernelReused, frameUploaded, kernelGeneration, wasmMemoryBytes: module.HEAPU8.byteLength, count };
}

/** Binary64 native alpha/sliver/elastic tests read one immutable full topology.
 * Its packed buffers stay private to this Worker until the next snapshot/key.
 */
export async function calculateDxaTetrahedraRange(input, { residentKey, startAtom, endAtom, onPhase = () => {} } = {}) {
  const { module, kernelReused } = await getKernel(onPhase);
  module._alloy_dxa_reset_cancel();
  let frameUploaded = false;
  if (input) {
    validateDxaSnapshot(input);
    disposeResident(module);
    const pointers = [];
    try {
      for (const name of FIELDS) pointers.push(allocate(module, input[name]));
      resident = { key: residentKey, kind: 'tetrahedra', pointers, alpha: input.alpha,
        vertexCount: input.vertexCount, tetrahedronCount: input.tetrahedronCount,
        edgeCount: input.edgeCount, transitionCount: input.transitionCount };
      frameUploaded = true;
    } catch (error) { for (const pointer of pointers) module._free(pointer); throw error; }
  }
  if (!resident || resident.key !== residentKey || resident.kind !== 'tetrahedra') throw new Error('The resident CPU DXA interface tables are unavailable.');
  checkedRange(startAtom, endAtom, resident.tetrahedronCount);
  const count = endAtom - startAtom, output = module._malloc(count * 4);
  if (!output) throw new Error('Insufficient memory for CPU DXA interface labels.');
  try {
    onPhase('analyzing');
    const [vertices, tetrahedra, edges, transitions] = resident.pointers;
    if (!module._alloy_dxa_classify_range(vertices, resident.vertexCount, tetrahedra, resident.tetrahedronCount,
      edges, resident.edgeCount, transitions, resident.transitionCount, resident.alpha, startAtom, endAtom, output)) {
      throw nativeError(module, '_alloy_dxa_classify_error');
    }
    return { startAtom, endAtom, regions: module.HEAP32.slice(output / 4, output / 4 + count),
      kernelReused, frameUploaded, kernelGeneration, wasmMemoryBytes: module.HEAPU8.byteLength };
  } finally { module._free(output); }
}
