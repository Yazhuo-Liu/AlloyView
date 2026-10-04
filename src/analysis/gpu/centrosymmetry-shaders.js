import { makeNeighborShader } from './neighbors.js';
import { CSP_F64_WGSL } from './csp-f64.js';

export const CSP_RESULT_WORDS = 8;
export const CSP_CANDIDATE_LIMIT = 50_000;

/** Original IEEE64 coordinates and cells preserve the CPU's strict distance
 * and Cartesian-vector ordering. Greedy disjoint pairing depends on that
 * ordering, even for equal-looking shells in a perfect HCP crystal. */
export const CSP_SHADER = makeNeighborShader({
  mode: 'images',
  declarations: `
${CSP_F64_WGSL}
struct CspSettings {
  required: u32, requested: u32, mode: u32, nanBits: u32,
  cells: array<vec2u, 9>,
};
struct CspResult {
  value: f32, flags: u32, resolved: u32, participants: u32,
  structure: u32, shellCount: u32, inferred: u32, incomplete: u32,
};
@group(0) @binding(5) var<storage, read_write> results: array<CspResult>;
@group(0) @binding(6) var<storage, read> originalCoordinates: array<vec2u>;
@group(0) @binding(7) var<storage, read> settings: CspSettings;
@group(0) @binding(8) var<storage, read> structures: array<u32>;
fn cspExactVector(atom: u32, other: u32, image: vec3i) -> array<vec2u, 3> {
  var fractional: array<vec2u, 3>;
  for (var axis = 0u; axis < 3u; axis++) {
    let difference = f64Subtract(originalCoordinates[other * 3u + axis], originalCoordinates[atom * 3u + axis]);
    fractional[axis] = f64Add(difference, f64FromInt(-image[axis]));
  }
  var vector: array<vec2u, 3>;
  for (var axis = 0u; axis < 3u; axis++) {
    let first = f64Multiply(fractional[0], settings.cells[axis]);
    let second = f64Multiply(fractional[1], settings.cells[3u + axis]);
    let third = f64Multiply(fractional[2], settings.cells[6u + axis]);
    vector[axis] = f64Add(f64Add(first, second), third);
  }
  return vector;
}
fn cspSquared(vector: array<vec2u, 3>) -> vec2u {
  return f64Add(f64Add(f64Multiply(vector[0], vector[0]), f64Multiply(vector[1], vector[1])), f64Multiply(vector[2], vector[2]));
}
fn cspBefore(distance: vec2u, id: u32, vector: array<vec2u, 3>, oldDistance: vec2u, oldId: u32, old: array<vec2u, 3>) -> bool {
  if (!f64Equal(distance, oldDistance)) { return f64Less(distance, oldDistance); }
  if (id != oldId) { return id < oldId; }
  for (var axis = 0u; axis < 3u; axis++) {
    if (!f64Equal(vector[axis], old[axis])) { return f64Less(vector[axis], old[axis]); }
  }
  return false;
}
`,
  initialize: `
    if (results[atom].resolved != 0u) { return; }
    var vectors: array<array<vec2u, 3>, 33>;
    var distances: array<vec2u, 33>; var ids: array<u32, 33>;
    var kept = 0u; var candidates = 0u; let capacity = min(33u, settings.required + 1u);
  `,
  candidateVisit: `
    candidates++;
    if (candidates > ${CSP_CANDIDATE_LIMIT}u) {
      results[atom] = CspResult(bitcast<f32>(settings.nanBits), 1u, 1u, kept, 0u, 0u, 0u, 0u); return;
    }
    // Once a full candidate shell exists, a vector beyond its worst exact
    // distance plus the conservative f32 error bound cannot enter that shell.
    // Tied/near-tied candidates retain exact binary64 comparison.
    if (distanceSquared <= config.cutoff2 + config.distanceTolerance
        && (kept < capacity || distanceSquared <= f64ToFloat(distances[capacity - 1u]) + config.distanceTolerance)) {
      let exactVector = cspExactVector(atom, other, vec3i(imageA, imageB, imageC));
      let exactSquared = cspSquared(exactVector);
      var insertion = kept;
      for (var index = 0u; index < kept; index++) {
        if (cspBefore(exactSquared, other, exactVector, distances[index], ids[index], vectors[index])) { insertion = index; break; }
      }
      if (insertion < capacity) {
        var index = min(kept, capacity - 1u);
        while (index > insertion) {
          distances[index] = distances[index - 1u]; ids[index] = ids[index - 1u]; vectors[index] = vectors[index - 1u]; index--;
        }
        distances[insertion] = exactSquared; ids[insertion] = other; vectors[insertion] = exactVector;
        kept = min(kept + 1u, capacity);
      }
    }
  `,
  finish: `
    let required = settings.required;
    if (kept < required || (required > 0u && f64ToFloat(distances[required - 1u]) > config.cutoff2 - config.distanceTolerance)) {
      results[atom] = CspResult(bitcast<f32>(settings.nanBits), 0u, 0u, kept, 0u, 0u, 0u, 0u); return;
    }
    var shellCount = settings.requested; var structure = 0u; var inferred = 0u;
    if (settings.mode != 0u) {
      structure = structures[atom]; shellCount = 0u;
      if (structure == 1u || structure == 2u) { shellCount = 12u; }
      else if (structure == 3u) { shellCount = 8u; }
      else if (structure == 0u) {
        var closePackedVotes = 0u; var bccVotes = 0u;
        for (var index = 0u; index < min(required, kept); index++) {
          let localStructure = structures[ids[index]];
          if (localStructure == 1u || localStructure == 2u) { closePackedVotes++; }
          else if (localStructure == 3u) { bccVotes++; }
        }
        if (closePackedVotes != bccVotes) {
          shellCount = select(8u, 12u, closePackedVotes > bccVotes); inferred = 1u;
        }
      }
    }
    var value = bitcast<f32>(settings.nanBits); var incomplete = 0u;
    if (shellCount != 0u) {
      if (kept < shellCount) { incomplete = 1u; }
      else {
        var denominator = vec2u(0u); var numerator = vec2u(0u); var used = 0u;
        for (var index = 0u; index < shellCount; index++) { denominator = f64Add(denominator, distances[index]); }
        denominator = f64Add(denominator, denominator);
        if (f64Less(vec2u(0u), denominator)) {
          for (var first = 0u; first < shellCount; first++) {
            if ((used & (1u << first)) != 0u) { continue; }
            var best = 32u; var minimum = vec2u(0u, 0x7ff00000u);
            for (var second = first + 1u; second < shellCount; second++) {
              if ((used & (1u << second)) != 0u) { continue; }
              var pair: array<vec2u, 3>;
              for (var axis = 0u; axis < 3u; axis++) { pair[axis] = f64Add(vectors[first][axis], vectors[second][axis]); }
              let cost = cspSquared(pair);
              if (f64Less(cost, minimum)) {
                minimum = cost; best = second;
                // Squared costs are nonnegative. CPU strict comparison would
                // retain this first zero for every later candidate as well.
                if (f64Equal(minimum, vec2u(0u))) { break; }
              }
            }
            if (best == 32u) {
              results[atom] = CspResult(value, 2u, 1u, kept, structure, shellCount, inferred, 1u); return;
            }
            used |= (1u << first) | (1u << best); numerator = f64Add(numerator, minimum);
          }
          value = f64Ratio(numerator, denominator);
        } else { incomplete = 1u; }
      }
    }
    results[atom] = CspResult(value, 0u, 1u, kept, structure, shellCount, inferred, incomplete);
  `,
});

// One compiled kernel handles every even manual shell and per-atom Auto shell.
export const CSP_NEAREST_SHADER = CSP_SHADER;
export const CSP_PAIR_SHADER = CSP_SHADER;
