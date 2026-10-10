import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { axisAngleQuaternion, polycrystalFrame, stackedLayersFrame } from './polycrystal.js';

/** Small structures whose OVITO 3.9.4 results are stored in tests/fixtures.
 * scripts/research/ovito-grains-compare.mjs writes both the structure files
 * given to OVITO and the fixtures, from these same definitions. */
export const GRAIN_FIXTURES = Object.freeze({
  // Two FCC grains, 28° apart about z, with thermal-like noise.
  bicrystal: () => polycrystalFrame({ lattice: 'fcc', a: 3.52, box: [38, 23, 23], noise: .05, seed: 3,
    seeds: [[9.5, 11.5, 11.5], [28.5, 11.5, 11.5]], orientations: [axisAngleQuaternion([0, 0, 1], 0), axisAngleQuaternion([0, 0, 1], 28)] }),
  // FCC matrix with an intrinsic stacking fault, then a twin lamella.
  twinFault: () => stackedLayersFrame({ steps: [...Array(8).fill(1), -1, ...Array(7).fill(1), ...Array(8).fill(-1), ...Array(6).fill(1)],
    nearest: 2.49, nx: 6, ny: 4, noise: .03, seed: 21 }),
});

const TYPES = { Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array };

/** Read a fixture: every { type, gzip } entry becomes its typed array. */
export async function loadGrainFixture(name) {
  const fixture = JSON.parse(await readFile(new URL(`../fixtures/grains-ovito-${name}.json`, import.meta.url), 'utf8'));
  const decode = value => {
    if (value && typeof value === 'object' && typeof value.gzip === 'string') {
      const bytes = gunzipSync(Buffer.from(value.gzip, 'base64'));
      return new TYPES[value.type](bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
    return value;
  };
  return decode(fixture);
}

/** The grain engine's input from OVITO's own PTM output: (w, x, y, z)
 * orientations and 16-wide neighbor rows, on the structure's coordinates. */
export function ovitoGrainInput(fixture, frame) {
  const atoms = fixture.atoms, orientations = new Float64Array(atoms * 4), neighborIndices = new Uint32Array(atoms * 16);
  for (let atom = 0; atom < atoms; atom += 1) {
    orientations[atom * 4] = fixture.ptm.orientation[atom * 4 + 3];
    for (let k = 0; k < 3; k += 1) orientations[atom * 4 + 1 + k] = fixture.ptm.orientation[atom * 4 + k];
  }
  neighborIndices.set(fixture.ptm.neighborIndices);
  return { structures: fixture.ptm.structure, orientations, neighborCounts: fixture.ptm.neighborCounts, neighborIndices,
    neighborSpan: null, fractional: frame.fractional, cell: frame.cell };
}
