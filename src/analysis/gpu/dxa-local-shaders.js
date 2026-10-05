import { CSP_F64_WGSL } from './csp-f64.js';
import { DXA_F64_WGSL } from './dxa-f64.js';

// Local structure and ordered ideal-neighbor correspondence adapted from OVITO DXA.
// Copyright 2023 OVITO GmbH, Germany. MIT license: licenses/DXA-MIT.txt.

export const DXA_LOCAL_WORKGROUP_SIZE = 32;
export const DXA_LOCAL_SETTINGS_WORDS = 32;
export const DXA_LOCAL_ROW_WORDS = 20;
export const DXA_LOCAL_TEMPLATE_WORDS = 33;
export const DXA_LOCAL_NEIGHBOR_ROW_WORDS = 114;

function binary64(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return `vec2u(${view.getUint32(0, true)}u, ${view.getUint32(4, true)}u)`;
}

/** Settings: count/start/end/lattice/identifyPlanarDefects/PBC at words 0..5,
 * column-major inverse cell as nine binary64 values at 8..25. Input rows are
 * [count, completion, sixteen (index, dx64, dy64, dz64) records]. Output rows are
 * [coordinationType, sixteen ideal-ordered indices, cutoff64, status].
 * Status 1..3 identifies an invalid half-cell span; 4 requests CPU fallback
 * when the exact graph search exceeds its per-dispatch work limit. Missing
 * neighbors and noncrystalline graphs produce Other without an error.
 */
export const DXA_LOCAL_SHADER = /* wgsl */`
${CSP_F64_WGSL}
${DXA_F64_WGSL}
@group(0) @binding(0) var<storage, read> settings: array<u32>;
@group(0) @binding(1) var<storage, read> nearest: array<u32>;
@group(0) @binding(2) var<storage, read> templates: array<u32>;
@group(0) @binding(3) var<storage, read_write> output: array<u32>;

fn localWords(offset: u32) -> vec2u {
  return vec2u(settings[offset], settings[offset + 1u]);
}
fn localNearestVector(atom: u32, neighbor: u32) -> array<vec2u, 3> {
  let offset = atom * ${DXA_LOCAL_NEIGHBOR_ROW_WORDS}u + 3u + neighbor * 7u;
  return array<vec2u, 3>(vec2u(nearest[offset], nearest[offset + 1u]),
    vec2u(nearest[offset + 2u], nearest[offset + 3u]),
    vec2u(nearest[offset + 4u], nearest[offset + 5u]));
}
fn localNearestIndex(atom: u32, neighbor: u32) -> u32 {
  return nearest[atom * ${DXA_LOCAL_NEIGHBOR_ROW_WORDS}u + 2u + neighbor * 7u];
}
fn localSquared(vector: array<vec2u, 3>) -> vec2u {
  return f64Add(f64Add(f64Multiply(vector[0], vector[0]),
    f64Multiply(vector[1], vector[1])), f64Multiply(vector[2], vector[2]));
}
fn localDifference(a: array<vec2u, 3>, b: array<vec2u, 3>) -> array<vec2u, 3> {
  return array<vec2u, 3>(f64Subtract(a[0], b[0]), f64Subtract(a[1], b[1]), f64Subtract(a[2], b[2]));
}
fn localAbs(value: vec2u) -> vec2u { return vec2u(value.x, value.y & 2147483647u); }
fn localLessEqual(a: vec2u, b: vec2u) -> bool { return f64Less(a, b) || f64Equal(a, b); }
fn localZero(vector: array<vec2u, 3>) -> bool {
  let tolerance = ${binary64(Math.fround(1e-12))};
  return localLessEqual(localAbs(vector[0]), tolerance)
    && localLessEqual(localAbs(vector[1]), tolerance)
    && localLessEqual(localAbs(vector[2]), tolerance);
}
// OVITO's longest chain is the number of bonds in the largest connected
// component, including loops and branches. Count every edge exactly once.
fn localBondSignature(commonMask: u32, bonds: array<u32, 16>) -> vec2u {
  var unvisited = commonMask;
  var total = 0u;
  var largest = 0u;
  loop {
    if (unvisited == 0u) { break; }
    var pending = 1u << firstTrailingBit(unvisited);
    var componentBonds = 0u;
    loop {
      if (pending == 0u) { break; }
      let index = firstTrailingBit(pending);
      let bit = 1u << index;
      pending &= ~bit;
      if ((unvisited & bit) == 0u) { continue; }
      unvisited &= ~bit;
      let adjacent = bonds[index] & commonMask;
      componentBonds += countOneBits(adjacent);
      pending |= adjacent & unvisited;
    }
    componentBonds /= 2u;
    total += componentBonds;
    largest = max(largest, componentBonds);
  }
  return vec2u(total, largest);
}

@compute @workgroup_size(${DXA_LOCAL_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let atom = settings[1] + gid.x;
  if (atom >= settings[0] || atom >= settings[2]) { return; }
  let row = atom * ${DXA_LOCAL_ROW_WORDS}u;
  output[row] = 0u;
  for (var index = 1u; index <= 16u; index += 1u) { output[row + index] = 4294967295u; }
  output[row + 17u] = 0u;
  output[row + 18u] = 0u;
  output[row + 19u] = 0u;
  if (nearest[atom * ${DXA_LOCAL_NEIGHBOR_ROW_WORDS}u + 1u] != 1u) {
    output[row + 19u] = 5u;
    return;
  }
  let lattice = settings[3];
  let diamond = lattice == 4u || lattice == 5u;
  let nn = select(select(12u, 14u, lattice == 3u), 16u, diamond);
  let count = nearest[atom * ${DXA_LOCAL_NEIGHBOR_ROW_WORDS}u];
  if (count < nn || lattice < 1u || lattice > 5u) { return; }

  var vectors: array<array<vec2u, 3>, 16>;
  var indices: array<u32, 16>;
  var bonds: array<u32, 16>;
  var signatures: array<u32, 16>;
  var cutoff = vec2u(0u);
  var scaling = vec2u(0u);
  if (!diamond) {
    let scaleCount = select(12u, 8u, lattice == 3u);
    for (var index = 0u; index < nn; index += 1u) {
      vectors[index] = localNearestVector(atom, index);
      indices[index] = localNearestIndex(atom, index);
      if (index < scaleCount) { scaling = f64Add(scaling, f64Sqrt(localSquared(vectors[index]))); }
    }
    scaling = f64Divide(scaling, f64FromInt(i32(scaleCount)));
    if (lattice == 3u) {
      cutoff = f64Multiply(f64Multiply(f64Divide(scaling, ${binary64(Math.sqrt(3) / 2)}),
        ${binary64(0.5)}), ${binary64(1 + Math.sqrt(2))});
    } else {
      // Emscripten's libc++ resolves sqrt(2.0f) to the float overload, then
      // performs 1.0f + sqrt(2.0f) in binary32 before promoting to FloatType.
      cutoff = f64Multiply(f64Multiply(scaling,
        ${binary64(Math.fround(1 + Math.fround(Math.sqrt(2))))}), ${binary64(0.5)});
    }
    let squaredCutoff = f64Multiply(cutoff, cutoff);
    if (count > nn && localLessEqual(localSquared(localNearestVector(atom, nn)), squaredCutoff)) { return; }
    for (var first = 0u; first < nn; first += 1u) {
      for (var second = first + 1u; second < nn; second += 1u) {
        if (localLessEqual(localSquared(localDifference(vectors[first], vectors[second])), squaredCutoff)) {
          bonds[first] |= 1u << second;
          bonds[second] |= 1u << first;
        }
      }
    }
  } else {
    var next = 4u;
    for (var first = 0u; first < 4u; first += 1u) {
      vectors[first] = localNearestVector(atom, first);
      indices[first] = localNearestIndex(atom, first);
      let neighborAtom = indices[first];
      if (neighborAtom >= settings[0]
          || nearest[neighborAtom * ${DXA_LOCAL_NEIGHBOR_ROW_WORDS}u] < 4u) { return; }
      for (var second = 0u; second < 4u; second += 1u) {
        let nextVector = localNearestVector(neighborAtom, second);
        let vector = array<vec2u, 3>(f64Add(vectors[first][0], nextVector[0]),
          f64Add(vectors[first][1], nextVector[1]), f64Add(vectors[first][2], nextVector[2]));
        let index = localNearestIndex(neighborAtom, second);
        if (index == atom && localZero(vector)) { continue; }
        if (next == 16u) { return; }
        indices[next] = index;
        vectors[next] = vector;
        bonds[first] |= 1u << next;
        bonds[next] |= 1u << first;
        next += 1u;
      }
      if (next != first * 3u + 7u) { return; }
    }
    for (var index = 4u; index < 16u; index += 1u) {
      scaling = f64Add(scaling, f64Sqrt(localSquared(vectors[index])));
    }
    scaling = f64Divide(scaling, ${binary64(12)});
    cutoff = f64Multiply(scaling, ${binary64(1.2071068)});
    let squaredCutoff = f64Multiply(cutoff, cutoff);
    for (var first = 4u; first < 16u; first += 1u) {
      for (var second = first + 1u; second < 16u; second += 1u) {
        if (localLessEqual(localSquared(localDifference(vectors[first], vectors[second])), squaredCutoff)) {
          bonds[first] |= 1u << second;
          bonds[second] |= 1u << first;
        }
      }
    }
  }

  var coordinationType = 0u;
  var firstSignature = 0u;
  var secondSignature = 0u;
  for (var index = 0u; index < nn; index += 1u) {
    let commonMask = bonds[index];
    let commonCount = countOneBits(commonMask);
    if (diamond && index < 4u) {
      if (commonCount != 3u) { return; }
      signatures[index] = 0u;
      continue;
    }
    let signature = localBondSignature(commonMask, bonds);
    if (lattice == 3u) {
      if (commonCount == 6u && all(signature == vec2u(6u, 6u))) {
        firstSignature += 1u;
        signatures[index] = 0u;
      } else if (commonCount == 4u && all(signature == vec2u(4u, 4u))) {
        secondSignature += 1u;
        signatures[index] = 1u;
      } else { return; }
    } else if (diamond) {
      if (commonCount != 5u || signature.x != 4u) { return; }
      if (signature.y == 3u) {
        firstSignature += 1u;
        signatures[index] = 1u;
      } else if (signature.y == 4u) {
        secondSignature += 1u;
        signatures[index] = 2u;
      } else { return; }
    } else {
      if (commonCount != 4u || signature.x != 2u) { return; }
      if (signature.y == 1u) {
        firstSignature += 1u;
        signatures[index] = 0u;
      } else if (signature.y == 2u) {
        secondSignature += 1u;
        signatures[index] = 1u;
      } else { return; }
    }
  }
  if (lattice == 3u) {
    if (firstSignature != 8u || secondSignature != 6u) { return; }
    coordinationType = 3u;
  } else if (diamond) {
    if (firstSignature == 12u && (settings[4] != 0u || lattice == 4u)) { coordinationType = 4u; }
    else if (firstSignature == 6u && secondSignature == 6u && (settings[4] != 0u || lattice == 5u)) { coordinationType = 5u; }
    else { return; }
  } else {
    if (firstSignature == 12u && (settings[4] != 0u || lattice == 1u)) { coordinationType = 1u; }
    else if (firstSignature == 6u && secondSignature == 6u && (settings[4] != 0u || lattice == 2u)) { coordinationType = 2u; }
    else { return; }
  }

  // Ascending depth-first search produces the same first lexicographic
  // permutation as OVITO's sorted-suffix next_permutation search. Signatures
  // and every already assigned edge constrain the exact graph isomorphism.
  let templateBase = (coordinationType - 1u) * ${DXA_LOCAL_TEMPLATE_WORDS}u;
  if (templates[templateBase] != nn) { output[row + 19u] = 4u; return; }
  var permutation: array<u32, 16>;
  var candidateStart: array<u32, 16>;
  var depth = 0u;
  var used = 0u;
  var iterations = 0u;
  loop {
    if (depth == nn) { break; }
    var accepted = false;
    for (var candidate = candidateStart[depth]; candidate < nn; candidate += 1u) {
      iterations += 1u;
      if (iterations > 1000000u) { output[row + 19u] = 4u; return; }
      let candidateBit = 1u << candidate;
      if ((used & candidateBit) != 0u
          || signatures[candidate] != templates[templateBase + 1u + depth]) { continue; }
      let expectedBonds = templates[templateBase + 17u + depth];
      var matches = true;
      for (var previous = 0u; previous < depth; previous += 1u) {
        let actual = (bonds[candidate] & (1u << permutation[previous])) != 0u;
        let expected = (expectedBonds & (1u << previous)) != 0u;
        if (actual != expected) { matches = false; break; }
      }
      if (!matches) { continue; }
      permutation[depth] = candidate;
      candidateStart[depth] = candidate + 1u;
      used |= candidateBit;
      depth += 1u;
      if (depth < nn) { candidateStart[depth] = 0u; }
      accepted = true;
      break;
    }
    if (accepted) { continue; }
    if (depth == 0u) { return; }
    depth -= 1u;
    used &= ~(1u << permutation[depth]);
  }

  for (var index = 0u; index < nn; index += 1u) {
    let vector = vectors[permutation[index]];
    for (var axis = 0u; axis < 3u; axis += 1u) {
      if ((settings[5] & (1u << axis)) == 0u) { continue; }
      let fraction = f64Add(f64Add(f64Multiply(localWords(8u + axis * 2u), vector[0]),
        f64Multiply(localWords(14u + axis * 2u), vector[1])),
        f64Multiply(localWords(20u + axis * 2u), vector[2]));
      if (localLessEqual(${binary64(0.5 + 1e-12)}, localAbs(fraction))) {
        output[row + 19u] = axis + 1u;
        return;
      }
    }
  }
  output[row] = coordinationType;
  for (var index = 0u; index < nn; index += 1u) {
    output[row + index + 1u] = indices[permutation[index]];
  }
  output[row + 17u] = cutoff.x;
  output[row + 18u] = cutoff.y;
}
`;
