import createPtm from './ptm-kernel.mjs';
import { NeighborSearch, atomRange } from './neighbors.js';
import { STRUCTURE_TYPES } from './cna.js';

export const PTM_TYPES = Object.freeze([...STRUCTURE_TYPES,
  { id: 5, label: 'SC', description: 'Simple cubic', color: [160, 20, 254] },
  { id: 6, label: 'Diamond', description: 'Cubic diamond', color: [19, 160, 254] },
  { id: 7, label: 'Hex. diamond', description: 'Hexagonal diamond', color: [254, 137, 0] },
  { id: 8, label: 'Graphene', description: 'Graphene coordination', color: [160, 120, 254] },
]);

export const PTM_FIELDS = Object.freeze({ structures: [Uint8Array, 1], rmsd: [Float32Array, 1],
  scales: [Float64Array, 1], deformation: [Float64Array, 9], distances: [Float32Array, 1] });

// The generated module targets browsers without static Node imports. Node's
// scientific tests supply the same binary directly (fetch cannot read file:).
let nodeBinary;
async function kernelOptions() {
  if (typeof process !== 'object' || !process.versions?.node) return {};
  nodeBinary ??= import('node:fs/promises').then(({ readFile }) => readFile(new URL('./ptm-kernel.wasm', import.meta.url)));
  return { wasmBinary: await nodeBinary };
}

export async function calculatePtm(frame, { rmsdCutoff = .1, flags = 31, ...range } = {}) {
  if (!Number.isFinite(rmsdCutoff) || rmsdCutoff < 0) throw new Error('PTM RMSD threshold must be finite and non-negative.');
  if (!Number.isInteger(flags) || flags < 1 || flags > 255) throw new Error('Select at least one PTM template.');
  const startedAt = performance.now();
  const search = new NeighborSearch(frame);
  const { startAtom, endAtom } = atomRange(search.count, range);
  const count = endAtom - startAtom;
  const result = Object.fromEntries(Object.entries(PTM_FIELDS).map(([name, [Type, stride]]) => [name,
    name === 'structures' ? new Type(count * stride) : new Type(count * stride).fill(NaN)]));
  const cache = new Map();
  let module;
  module = await createPtm({ ...await kernelOptions(), fetchNeighbors(atom, requested, points, indices) {
    let neighbors = cache.get(atom);
    if (!neighbors) {
      neighbors = search.nearest(atom, 18);
      // Degenerate/coincident environments must not enter the Voronoi sorter.
      if (neighbors.some((n) => n.distanceSquared < 1e-20)) neighbors = [];
      if (cache.size >= 512) cache.delete(cache.keys().next().value);
      cache.set(atom, neighbors);
    }
    const count = Math.min(requested, neighbors.length);
    for (let i = 0; i < count; i += 1) {
      const n = neighbors[i];
      module.HEAPF64.set([n.x, n.y, n.z], (points >> 3) + i * 3);
      module.HEAPU32[(indices >> 2) + i] = n.atom;
    }
    return count;
  } });
  if (module._alloy_ptm_init() !== 0) throw new Error('PTM initialization failed.');
  const output = module._malloc(13 * 8);
  if (!output) throw new Error('PTM output allocation failed.');
  try {
    for (let atom = startAtom; atom < endAtom; atom += 1) {
      const error = module._alloy_ptm_atom(atom, flags, output);
      if (error) throw new Error(`PTM failed for atom ${atom + 1} (code ${error}).`);
      const data = module.HEAPF64.subarray(output >> 3, (output >> 3) + 13);
      const index = atom - startAtom;
      result.rmsd[index] = data[1]; // Retain best-fit RMSD even for rejected fits.
      if (!data[0] || (rmsdCutoff > 0 && data[1] > rmsdCutoff)) continue;
      result.structures[index] = data[0];
      result.scales[index] = data[2];
      result.distances[index] = data[3];
      result.deformation.set(data.subarray(4, 13), index * 9);
    }
  } finally { module._free(output); }
  return { ...result, startAtom, endAtom, elapsedMs: performance.now() - startedAt };
}
