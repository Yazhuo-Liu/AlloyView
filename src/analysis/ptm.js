import createPtm from './ptm-kernel.mjs';
import { NeighborSearch, atomRange } from './neighbors.js';
import { STRUCTURE_TYPES } from './cna.js';
import { cellFaceHeights } from '../data/model.js';

export const PTM_MAX_NEIGHBORS = 18;

export const PTM_TYPES = Object.freeze([...STRUCTURE_TYPES,
  { id: 5, label: 'SC', description: 'Simple cubic', color: [160, 20, 254] },
  { id: 6, label: 'Diamond', description: 'Cubic diamond', color: [19, 160, 254] },
  { id: 7, label: 'Hex. diamond', description: 'Hexagonal diamond', color: [254, 137, 0] },
  { id: 8, label: 'Graphene', description: 'Graphene coordination', color: [160, 120, 254] },
]);

// PTM's chemical ordering of a matched environment. It needs exactly two
// species around an atom; environments with one species are "Pure" and
// those with three or more species are "Other".
export const PTM_ORDERING_TYPES = Object.freeze([
  { id: 0, label: 'Other', description: 'Unmatched, or no binary ordering', color: [242, 242, 242] },
  { id: 1, label: 'Pure', description: 'All neighbors share the central species', color: [180, 180, 180] },
  { id: 2, label: 'L1₀', description: 'Tetragonal binary order (CuAu type)', color: [129, 245, 104] },
  { id: 3, label: 'L1₂ (A-site)', description: 'Cu₃Au order, central atom on a majority site', color: [76, 160, 255] },
  { id: 4, label: 'L1₂ (B-site)', description: 'Cu₃Au order, central atom on a minority site', color: [255, 160, 76] },
  { id: 5, label: 'B2', description: 'CsCl order', color: [230, 70, 70] },
  { id: 6, label: 'Zincblende', description: 'SiC order on a diamond lattice', color: [130, 90, 220] },
  { id: 7, label: 'Hex. BN', description: 'Boron-nitride order on graphene', color: [210, 210, 60] },
].map(Object.freeze));

export const PTM_FIELDS = Object.freeze({ structures: [Uint8Array, 1], rmsd: [Float32Array, 1],
  scales: [Float64Array, 1], deformation: [Float64Array, 9], distances: [Float32Array, 1],
  orientations: [Float64Array, 4], orderings: [Uint8Array, 1] });
// One packed kernel record: see alloy_ptm_atom in wasm/ptm.cpp.
const PTM_RECORD_DOUBLES = 18;

// The generated module targets browsers without static Node imports. Node's
// scientific tests supply the same binary directly (fetch cannot read file:).
let nodeBinary;
let kernelPromise;
let residentModule;
let neighborContext = null;
async function kernelOptions() {
  if (typeof process !== 'object' || !process.versions?.node) return {};
  nodeBinary ??= import('node:fs/promises').then(({ readFile }) => readFile(new URL('./ptm-kernel.wasm', import.meta.url)));
  return { wasmBinary: await nodeBinary };
}

function getKernel() {
  if (!kernelPromise) {
    kernelPromise = (async () => {
      let module;
      module = await createPtm({ ...await kernelOptions(), fetchNeighbors(atom, requested, points, indices) {
        const { search, cache, preparedNeighbors } = neighborContext;
        if (preparedNeighbors) {
          const localAtom = atom - (preparedNeighbors.startAtom ?? 0);
          const count = Math.min(requested, preparedNeighbors.counts[localAtom]);
          const row = localAtom * PTM_MAX_NEIGHBORS;
          module.HEAPF64.set(preparedNeighbors.vectors.subarray(row * 3, (row + count) * 3), points >> 3);
          module.HEAPU32.set(preparedNeighbors.indices.subarray(row, row + count), indices >> 2);
          return count;
        }
        let neighbors = cache.get(atom);
        if (!neighbors) {
          neighbors = search.nearest(atom, 18);
          // Degenerate/coincident environments must not enter the Voronoi sorter.
          if (neighbors.some((n) => n.distanceSquared < 1e-20)) neighbors = [];
          if (cache.size >= 512) cache.delete(cache.keys().next().value);
          cache.set(atom, neighbors);
        }
        const count = Math.min(requested, neighbors.length);
        // Read the heap views per call: Wasm memory growth replaces them.
        const heapF64 = module.HEAPF64, heapU32 = module.HEAPU32, point = points >> 3, index = indices >> 2;
        for (let i = 0; i < count; i += 1) {
          const n = neighbors[i];
          heapF64[point + i * 3] = n.x; heapF64[point + i * 3 + 1] = n.y; heapF64[point + i * 3 + 2] = n.z;
          heapU32[index + i] = n.atom;
        }
        return count;
      } });
      if (module._alloy_ptm_init() !== 0) throw new Error('PTM initialization failed.');
      residentModule = module;
      return module;
    })().catch((error) => {
      kernelPromise = undefined;
      throw error;
    });
  }
  return kernelPromise;
}

export function ptmKernelMemoryBytes() { return residentModule?.HEAPU8.byteLength ?? 0; }

/** Initialize the resident module without inventing a frame or running a fit. */
export async function warmupPtm({ onPhase = () => {} } = {}) {
  const kernelReused = Boolean(kernelPromise);
  onPhase('initializing');
  const module = await getKernel();
  return { warmed: true, kernelReused, wasmMemoryBytes: module.HEAPU8.byteLength };
}

export async function calculatePtm(frame, { rmsdCutoff = .1, flags = 31, preparedNeighbors, types = frame.types,
  onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  validatePtmParameters({ rmsdCutoff, flags });
  const prepared = preparedNeighbors === undefined ? null : validatePreparedPtmNeighbors(frame, preparedNeighbors,
    { ...range, flags, validateValues: true });
  const startedAt = performance.now();
  const kernelReused = Boolean(kernelPromise);
  onPhase('initializing');
  const module = await getKernel();
  onPhase('indexing');
  const search = prepared ? null : new NeighborSearch(frame);
  const { startAtom, endAtom } = atomRange(prepared ? frame.fractional.length / 3 : search.count, range);
  const count = endAtom - startAtom;
  const result = Object.fromEntries(Object.entries(PTM_FIELDS).map(([name, [Type, stride]]) => [name,
    Type === Uint8Array ? new Type(count * stride) : new Type(count * stride).fill(NaN)]));
  const cache = new Map();
  const output = module._malloc(PTM_RECORD_DOUBLES * 8);
  if (!output) throw new Error('PTM output allocation failed.');
  // Species of every atom a neighborhood may reach; only ordering uses them.
  const sourceCount = prepared ? frame.fractional.length / 3 : search.count;
  const typePointer = ArrayBuffer.isView(types) && types.length === sourceCount ? module._malloc(sourceCount * 4) : 0;
  if (typePointer) {
    module.HEAP32.set(types, typePointer >> 2);
    module._alloy_ptm_set_types(typePointer, sourceCount);
  }
  neighborContext = { search, cache, preparedNeighbors: prepared };
  try {
    onPhase('analyzing');
    onAtoms(0, count);
    let lastProgressAt = performance.now();
    for (let atom = startAtom; atom < endAtom; atom += 1) {
      const index = atom - startAtom;
      // Report real completed atoms while fitting, rather than leaving a long
      // range at 0 / workers until its final result. Throttle messages to avoid
      // competing with the renderer on fast/small analyses.
      if (index && index % 128 === 0 && performance.now() - lastProgressAt >= 150) {
        onAtoms(index, count);
        lastProgressAt = performance.now();
      }
      const error = module._alloy_ptm_atom(atom, flags, output);
      if (error) throw new Error(`PTM failed for atom ${atom + 1} (code ${error}).`);
      const data = module.HEAPF64.subarray(output >> 3, (output >> 3) + PTM_RECORD_DOUBLES);
      result.rmsd[index] = data[1]; // Retain best-fit RMSD even for rejected fits.
      if (!data[0] || (rmsdCutoff > 0 && data[1] > rmsdCutoff)) continue;
      result.structures[index] = data[0];
      result.scales[index] = data[2];
      result.distances[index] = data[3];
      result.deformation.set(data.subarray(4, 13), index * 9);
      result.orientations.set(data.subarray(13, 17), index * 4);
      result.orderings[index] = typePointer ? data[17] : 0;
    }
    onAtoms(count, count);
  } finally {
    module._free(output);
    if (typePointer) { module._alloy_ptm_set_types(0, 0); module._free(typePointer); }
    // The reusable module must not retain coordinates from a closed source.
    neighborContext = null;
  }
  return { ...result, startAtom, endAtom, kernelReused, elapsedMs: performance.now() - startedAt };
}

export function validatePtmParameters({ rmsdCutoff = .1, flags = 31 } = {}) {
  if (!Number.isFinite(rmsdCutoff) || rmsdCutoff < 0) throw new Error('PTM RMSD threshold must be finite and non-negative.');
  if (!Number.isInteger(flags) || flags < 1 || flags > 255) throw new Error('Select at least one PTM template.');
}

/** Diamond and graphene request neighbors of neighbors outside a worker's
 * atom range. Those flags require the full table; ordinary templates permit
 * contiguous slices. Zero rows represent degenerate or isolated atoms.
 * Trusted GPU results may receive schema-only preflight on the main thread;
 * calculatePtm always validates scientific values in the fitting worker.
 */
export function validatePreparedPtmNeighbors(frame, table,
  { startAtom, endAtom, flags = 31, validateValues = true } = {}) {
  const count = frame.fractional?.length / 3;
  if (!Number.isInteger(count) || count < 1) throw new Error('Analysis requires at least one atom.');
  const tableStart = table?.startAtom ?? 0, tableEnd = table?.endAtom ?? tableStart + (table?.counts?.length ?? 0);
  const fit = atomRange(count, { startAtom, endAtom });
  if (table?.maxNeighbors !== PTM_MAX_NEIGHBORS || !(table.counts instanceof Uint8Array)
      || !(table.indices instanceof Uint32Array) || !(table.vectors instanceof Float64Array)
      || !Number.isInteger(tableStart) || !Number.isInteger(tableEnd) || tableStart < 0 || tableEnd > count || tableEnd < tableStart
      || table.counts.length !== tableEnd - tableStart || table.indices.length !== table.counts.length * PTM_MAX_NEIGHBORS
      || table.vectors.length !== table.counts.length * PTM_MAX_NEIGHBORS * 3
      || (table.sourceAtomCount !== undefined && table.sourceAtomCount !== count)
      || tableStart > fit.startAtom || tableEnd < fit.endAtom) {
    throw new Error('PTM prepared neighbors must contain a complete typed nearest-18 table for the source frame.');
  }
  if ((flags & 224) && (tableStart !== 0 || tableEnd !== count)) {
    throw new Error('Diamond and graphene PTM require the full source prepared-neighbor table.');
  }
  const heights = cellFaceHeights(frame.cell);
  if (heights.some(height => !Number.isFinite(height) || height <= 0)) throw new Error('Neighbor search requires a finite, non-singular cell.');
  if (!validateValues) return table;
  for (const value of frame.fractional) if (!Number.isFinite(value)) throw new Error('PTM requires finite source coordinates.');
  const required = frame.cell.pbc.some(Boolean) ? PTM_MAX_NEIGHBORS : Math.min(PTM_MAX_NEIGHBORS, count - 1);
  for (let atom = 0; atom < table.counts.length; atom++) {
    const length = table.counts[atom];
    if (length !== 0 && length !== required) throw new Error('PTM prepared neighbors contain an incomplete nearest-neighbor row.');
    for (let neighbor = 0; neighbor < length; neighbor++) {
      const index = atom * PTM_MAX_NEIGHBORS + neighbor, offset = index * 3;
      if (table.indices[index] >= count) throw new Error('PTM prepared-neighbor atom indices are outside the source frame.');
      const x = table.vectors[offset], y = table.vectors[offset + 1], z = table.vectors[offset + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('PTM prepared neighbors require finite Cartesian vectors.');
      if (x * x + y * y + z * z < 1e-20) throw new Error('PTM prepared neighbors must omit coincident environments.');
    }
  }
  return table;
}
