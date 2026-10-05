import { makeNeighborShader } from './neighbors.js';
import { CSP_F64_WGSL } from './csp-f64.js';

export const DXA_LOCAL_NEIGHBOR_LIMIT = 16;
export const DXA_LOCAL_NEIGHBOR_ROW_WORDS = 2 + DXA_LOCAL_NEIGHBOR_LIMIT * 7;
export const DXA_LOCAL_NEIGHBOR_CANDIDATE_LIMIT = 50_000;

/** The native DXA query subtracts Cartesian positions after constructing its
 * image shift. Keeping that operation order matters at binary64 boundaries;
 * PTM's fractional difference followed by a matrix product is not equivalent.
 * All rows stay resident for the subsequent local crystal correspondence pass.
 */
export const DXA_LOCAL_NEIGHBORS_SHADER = makeNeighborShader({
  mode: 'images',
  declarations: `
${CSP_F64_WGSL}
struct DxaNeighborSettings {
  required: u32, count: u32, padding0: u32, padding1: u32,
  cells: array<vec2u, 9>,
};
@group(0) @binding(5) var<storage, read_write> rows: array<u32>;
@group(0) @binding(6) var<storage, read> originalCoordinates: array<u32>;
@group(0) @binding(7) var<storage, read> settings: DxaNeighborSettings;
@group(0) @binding(8) var<storage, read_write> status: array<atomic<u32>>;
fn dxaNeighborExactVector(atom: u32, other: u32, image: vec3i) -> array<vec2u, 3> {
  var result: array<vec2u, 3>;
  // The broad phase uses delta - image. Native query's image has the opposite
  // sign, then computes other - (central - shift) rather than delta + shift.
  // Native NN performs another inverse-cell wrap. At an exact fractional
  // boundary its Cartesian position can therefore differ by a whole image
  // from the application frame used by the cached broad-phase grid.
  let atomBase = atom * 9u; let otherBase = other * 9u;
  let atomImage = vec3i(bitcast<i32>(originalCoordinates[atomBase + 6u]),
    bitcast<i32>(originalCoordinates[atomBase + 7u]), bitcast<i32>(originalCoordinates[atomBase + 8u]));
  let otherImage = vec3i(bitcast<i32>(originalCoordinates[otherBase + 6u]),
    bitcast<i32>(originalCoordinates[otherBase + 7u]), bitcast<i32>(originalCoordinates[otherBase + 8u]));
  let nativeImage = -image - otherImage + atomImage;
  for (var axis = 0u; axis < 3u; axis++) {
    let shift = f64Add(f64Add(f64Multiply(settings.cells[axis], f64FromInt(nativeImage.x)),
      f64Multiply(settings.cells[3u + axis], f64FromInt(nativeImage.y))),
      f64Multiply(settings.cells[6u + axis], f64FromInt(nativeImage.z)));
    let center = vec2u(originalCoordinates[atomBase + axis * 2u], originalCoordinates[atomBase + axis * 2u + 1u]);
    let neighbor = vec2u(originalCoordinates[otherBase + axis * 2u], originalCoordinates[otherBase + axis * 2u + 1u]);
    let query = f64Subtract(center, shift);
    result[axis] = f64Subtract(neighbor, query);
  }
  return result;
}
fn dxaNeighborSquared(vector: array<vec2u, 3>) -> vec2u {
  return f64Add(f64Add(f64Multiply(vector[0], vector[0]), f64Multiply(vector[1], vector[1])),
    f64Multiply(vector[2], vector[2]));
}
fn dxaNeighborBefore(distance: vec2u, id: u32, vector: array<vec2u, 3>,
    oldDistance: vec2u, oldId: u32, oldVector: array<vec2u, 3>) -> bool {
  if (!f64Equal(distance, oldDistance)) { return f64Less(distance, oldDistance); }
  if (id != oldId) { return id < oldId; }
  for (var axis = 0u; axis < 3u; axis++) {
    if (!f64Equal(vector[axis], oldVector[axis])) { return f64Less(vector[axis], oldVector[axis]); }
  }
  return false;
}
`,
  initialize: `
    let row = atom * ${DXA_LOCAL_NEIGHBOR_ROW_WORDS}u;
    if (rows[row + 1u] != 0u) { return; }
    rows[row] = 0u;
    if (settings.required == 0u) {
      rows[row + 1u] = 1u; atomicAdd(&status[0], 1u); return;
    }
    var vectors: array<array<vec2u, 3>, ${DXA_LOCAL_NEIGHBOR_LIMIT}>;
    var distances: array<vec2u, ${DXA_LOCAL_NEIGHBOR_LIMIT}>;
    var ids: array<u32, ${DXA_LOCAL_NEIGHBOR_LIMIT}>;
    var kept = 0u; var candidates = 0u;
  `,
  candidateVisit: `
    candidates++;
    if (candidates > ${DXA_LOCAL_NEIGHBOR_CANDIDATE_LIMIT}u) {
      atomicStore(&status[1], 1u); return;
    }
    if (distanceSquared <= config.cutoff2 + config.distanceTolerance
        && (kept < settings.required
          || distanceSquared <= f64ToFloat(distances[settings.required - 1u]) + config.distanceTolerance)) {
      let exactVector = dxaNeighborExactVector(atom, other, vec3i(imageA, imageB, imageC));
      let exactSquared = dxaNeighborSquared(exactVector);
      // Native NearestNeighborFinder excludes exactly coincident candidates.
      // A small nonzero distance must still be retained, including subnormals.
      if (!f64IsZero(exactSquared)) {
        var insertion = kept;
        for (var index = 0u; index < kept; index++) {
          if (dxaNeighborBefore(exactSquared, other, exactVector, distances[index], ids[index], vectors[index])) {
            insertion = index; break;
          }
        }
        if (insertion < settings.required) {
          var index = min(kept, settings.required - 1u);
          while (index > insertion) {
            distances[index] = distances[index - 1u]; ids[index] = ids[index - 1u];
            vectors[index] = vectors[index - 1u]; index--;
          }
          distances[insertion] = exactSquared; ids[insertion] = other; vectors[insertion] = exactVector;
          kept = min(kept + 1u, settings.required);
        }
      }
    }
  `,
  finish: `
    if (kept < settings.required
        || f64ToFloat(distances[settings.required - 1u]) > config.cutoff2 - config.distanceTolerance) { return; }
    rows[row] = kept;
    for (var index = 0u; index < kept; index++) {
      let offset = row + 2u + index * 7u;
      rows[offset] = ids[index];
      for (var axis = 0u; axis < 3u; axis++) {
        rows[offset + 1u + axis * 2u] = vectors[index][axis].x;
        rows[offset + 2u + axis * 2u] = vectors[index][axis].y;
      }
    }
    rows[row + 1u] = 1u; atomicAdd(&status[0], 1u);
  `,
});
