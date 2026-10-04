import { makeNeighborShader } from './neighbors.js';
import { MAX_NEIGHBORS_PER_ATOM } from '../bonds.js';

export const BOND_ATOM_WORDS = 5;
export const BOND_RECORD_WORDS = 8;

const PARAMETERS = `
@group(0) @binding(5) var<storage, read> settings: array<u32>;
@group(0) @binding(6) var<storage, read_write> atomData: array<u32>;
fn pairCutoff(first: u32, second: u32) -> f32 {
  let a = min(first, second); let b = max(first, second);
  for (var entry = 0u; entry < settings[0]; entry++) {
    let offset = 4u + entry * 4u;
    if (settings[offset] == a && settings[offset + 1u] == b) { return bitcast<f32>(settings[offset + 2u]); }
  }
  return bitcast<f32>(settings[1]);
}
fn positiveImage(a: i32, b: i32, c: i32) -> bool {
  if (a != 0) { return a > 0; }
  if (b != 0) { return b > 0; }
  return c > 0;
}
`;

export const BONDS_COUNT_SHADER = makeNeighborShader({
  mode: 'images', declarations: PARAMETERS,
  initialize: 'var coordination = 0u; var edgeCount = 0u; var correction = 0u; var neighborCount = 0u;',
  candidateVisit: `
let selectedCutoff = pairCutoff(types[atom], types[other]);
let selectedSquared = selectedCutoff * selectedCutoff;
if (abs(distanceSquared - config.cutoff2) <= config.distanceTolerance
    || (selectedCutoff > 0.0 && (abs(distanceSquared - selectedSquared) <= config.distanceTolerance || distanceSquared <= 8e-24))) {
  correction = 1u;
}`,
  visit: `
neighborCount++;
if (neighborCount > ${MAX_NEIGHBORS_PER_ATOM}u) { atomData[atom * ${BOND_ATOM_WORDS}u + 3u] = neighborCount; return; }
if (selectedCutoff > 0.0 && distanceSquared <= selectedSquared && distanceSquared > 1e-24) {
  coordination++;
  if (other > atom || (other == atom && positiveImage(-imageA, -imageB, -imageC))) { edgeCount++; }
}`,
  finish: `let base = atom * ${BOND_ATOM_WORDS}u;
atomData[base] = coordination; atomData[base + 1u] = edgeCount;
atomData[base + 2u] = correction; atomData[base + 3u] = neighborCount;`,
});

export const BONDS_WRITE_SHADER = makeNeighborShader({
  mode: 'images',
  declarations: `${PARAMETERS}
@group(0) @binding(7) var<storage, read_write> records: array<u32>;
@group(0) @binding(8) var<storage, read_write> diagnostics: array<atomic<u32>>;`,
  initialize: `let atomBase = atom * ${BOND_ATOM_WORDS}u;
if (atomData[atomBase + 2u] != 0u) { return; }
var cursor = atomData[atomBase + 4u];
let limit = cursor + atomData[atomBase + 1u];`,
  visit: `
let selectedCutoff = pairCutoff(types[atom], types[other]);
if (selectedCutoff > 0.0 && distanceSquared <= selectedCutoff * selectedCutoff && distanceSquared > 1e-24
    && (other > atom || (other == atom && positiveImage(-imageA, -imageB, -imageC)))) {
  if (cursor >= limit) { atomicStore(&diagnostics[0], 1u); return; }
  let base = cursor * ${BOND_RECORD_WORDS}u;
  records[base] = atom; records[base + 1u] = other;
  records[base + 2u] = bitcast<u32>(vector.x); records[base + 3u] = bitcast<u32>(vector.y); records[base + 4u] = bitcast<u32>(vector.z);
  records[base + 5u] = bitcast<u32>(-imageA); records[base + 6u] = bitcast<u32>(-imageB); records[base + 7u] = bitcast<u32>(-imageC);
  cursor++;
}`,
  finish: 'if (cursor != limit) { atomicStore(&diagnostics[0], 1u); }',
});
