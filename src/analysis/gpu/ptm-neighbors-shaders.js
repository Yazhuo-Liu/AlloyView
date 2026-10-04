import { makeNeighborShader } from './neighbors.js';
import { CSP_F64_WGSL } from './csp-f64.js';

export const PTM_NEIGHBOR_LIMIT = 18;
export const PTM_NEIGHBOR_ROW_WORDS = 4 + PTM_NEIGHBOR_LIMIT * 7;
export const PTM_NEIGHBOR_CANDIDATE_LIMIT = 50_000;

/** Preserve the CPU nearest-18 ordering and original binary64 Cartesian
 * vectors. Voronoi ordering and correspondence fitting remain in CPU PTM.
 */
export const PTM_NEIGHBORS_SHADER = makeNeighborShader({
  mode: 'images',
  declarations: `
${CSP_F64_WGSL}
struct PtmNeighborSettings {
  required: u32, outputStart: u32, outputCount: u32, padding: u32,
  cells: array<vec2u, 9>, zeroCutoff: vec2u,
};
@group(0) @binding(5) var<storage, read_write> rows: array<u32>;
@group(0) @binding(6) var<storage, read> originalCoordinates: array<vec2u>;
@group(0) @binding(7) var<storage, read> settings: PtmNeighborSettings;
@group(0) @binding(8) var<storage, read_write> resolved: array<u32>;
fn ptmExactVector(atom: u32, other: u32, image: vec3i) -> array<vec2u, 3> {
  var fractional: array<vec2u, 3>;
  for (var axis = 0u; axis < 3u; axis++) {
    let difference = f64Subtract(originalCoordinates[other * 3u + axis], originalCoordinates[atom * 3u + axis]);
    fractional[axis] = f64Add(difference, f64FromInt(-image[axis]));
  }
  var vector: array<vec2u, 3>;
  for (var axis = 0u; axis < 3u; axis++) {
    vector[axis] = f64Add(f64Add(f64Multiply(fractional[0], settings.cells[axis]),
      f64Multiply(fractional[1], settings.cells[3u + axis])), f64Multiply(fractional[2], settings.cells[6u + axis]));
  }
  return vector;
}
fn ptmSquared(vector: array<vec2u, 3>) -> vec2u {
  return f64Add(f64Add(f64Multiply(vector[0], vector[0]), f64Multiply(vector[1], vector[1])), f64Multiply(vector[2], vector[2]));
}
fn ptmBefore(distance: vec2u, id: u32, vector: array<vec2u, 3>, oldDistance: vec2u, oldId: u32, old: array<vec2u, 3>) -> bool {
  if (!f64Equal(distance, oldDistance)) { return f64Less(distance, oldDistance); }
  if (id != oldId) { return id < oldId; }
  for (var axis = 0u; axis < 3u; axis++) {
    if (!f64Equal(vector[axis], old[axis])) { return f64Less(vector[axis], old[axis]); }
  }
  return false;
}
`,
  initialize: `
    let row = (atom - settings.outputStart) * ${PTM_NEIGHBOR_ROW_WORDS}u;
    rows[row] = 0u; rows[row + 1u] = 0u; rows[row + 2u] = 0u;
    if (resolved[atom] != 0u) { rows[row + 2u] = 2u; return; }
    if (settings.required == 0u) { resolved[atom] = 1u; rows[row + 2u] = 1u; return; }
    var vectors: array<array<vec2u, 3>, ${PTM_NEIGHBOR_LIMIT}>;
    var distances: array<vec2u, ${PTM_NEIGHBOR_LIMIT}>;
    var ids: array<u32, ${PTM_NEIGHBOR_LIMIT}>;
    var kept = 0u; var candidates = 0u;
  `,
  candidateVisit: `
    candidates++;
    if (candidates > ${PTM_NEIGHBOR_CANDIDATE_LIMIT}u) { rows[row + 1u] = 1u; return; }
    if (distanceSquared <= config.cutoff2 + config.distanceTolerance
        && (kept < settings.required || distanceSquared <= f64ToFloat(distances[settings.required - 1u]) + config.distanceTolerance)) {
      let exactVector = ptmExactVector(atom, other, vec3i(imageA, imageB, imageC));
      let exactSquared = ptmSquared(exactVector);
      var insertion = kept;
      for (var index = 0u; index < kept; index++) {
        if (ptmBefore(exactSquared, other, exactVector, distances[index], ids[index], vectors[index])) { insertion = index; break; }
      }
      if (insertion < settings.required) {
        var index = min(kept, settings.required - 1u);
        while (index > insertion) {
          distances[index] = distances[index - 1u]; ids[index] = ids[index - 1u]; vectors[index] = vectors[index - 1u]; index--;
        }
        distances[insertion] = exactSquared; ids[insertion] = other; vectors[insertion] = exactVector;
        kept = min(kept + 1u, settings.required);
      }
    }
  `,
  finish: `
    if (kept < settings.required || f64ToFloat(distances[settings.required - 1u]) > config.cutoff2 - config.distanceTolerance) { return; }
    resolved[atom] = 1u; rows[row + 2u] = 1u;
    if (f64Less(distances[0], settings.zeroCutoff)) { return; }
    rows[row] = kept;
    for (var index = 0u; index < kept; index++) {
      let offset = row + 4u + index * 7u; rows[offset] = ids[index];
      for (var axis = 0u; axis < 3u; axis++) {
        rows[offset + 1u + axis * 2u] = vectors[index][axis].x;
        rows[offset + 2u + axis * 2u] = vectors[index][axis].y;
      }
    }
  `,
});
