import { CSP_F64_WGSL } from './csp-f64.js';

// Alpha and elastic-compatibility algorithms adapted from OVITO DXA.
// Copyright 2023 OVITO GmbH, Germany. MIT license: licenses/DXA-MIT.txt.

export const DXA_WORKGROUP_SIZE = 64;
export const DXA_SETTINGS_BYTES = 32;

function f64Literal(value) {
  const bytes = new ArrayBuffer(8), view = new DataView(bytes);
  view.setFloat64(0, value, true);
  return `vec2u(${view.getUint32(0, true)}u, ${view.getUint32(4, true)}u)`;
}

/** Compare the rounded binary64 positive quotient to a binary64 threshold.
 * Instead of approximating division, compare the exact rational number with
 * the midpoint between the threshold and its preceding representable value.
 * A 53-bit denominator times that 54-bit midpoint fits four integer limbs.
 * This preserves nearest-even decisions, including underflow and overflow.
 */
export const DXA_RATIO_WGSL = /* wgsl */`
fn dxaWideTop(value: vec4u) -> u32 {
  var top = 0u;
  for (var word = 0u; word < 4u; word += 1u) {
    if (value[word] != 0u) { top = word * 32u + 31u - countLeadingZeros(value[word]); }
  }
  return top;
}
fn dxaWideLeft(value: vec4u, shift: u32) -> vec4u {
  let whole = shift / 32u;
  let part = shift % 32u;
  var result = vec4u(0u);
  for (var word = 0u; word < 4u; word += 1u) {
    if (word >= whole) {
      result[word] = value[word - whole] << part;
      if (part != 0u && word > whole) { result[word] |= value[word - whole - 1u] >> (32u - part); }
    }
  }
  return result;
}
fn dxaWideLess(a: vec4u, b: vec4u) -> bool {
  for (var index = 4u; index > 0u; index -= 1u) {
    let word = index - 1u;
    if (a[word] != b[word]) { return a[word] < b[word]; }
  }
  return false;
}
fn dxaPositiveRatioLess(numerator: vec2u, denominator: vec2u, threshold: vec2u) -> bool {
  if (f64IsNan(numerator) || f64IsNan(denominator) || f64IsNan(threshold)
      || (threshold.y & 2147483648u) != 0u || f64IsZero(threshold)) { return false; }
  let ne = (numerator.y >> 20u) & 2047u;
  let de = (denominator.y >> 20u) & 2047u;
  let te = (threshold.y >> 20u) & 2047u;
  // The alpha-shape operands are nonnegative squared quantities. Infinity /
  // infinity and 0 / 0 are NaN; a nonzero / 0 or infinity / finite is infinity.
  if (f64IsZero(denominator) || ne == 2047u) { return false; }
  if (de == 2047u || f64IsZero(numerator)) { return true; }

  let n = f64Significand(numerator);
  let d = f64Significand(denominator);
  // Treat +infinity as the conceptual next value 2^1024. Its midpoint with
  // max-finite is also the correctly rounded division overflow threshold.
  let m = select(f64Significand(threshold), vec2u(0u, 1048576u), te == 2047u);
  var midpoint = f64WordsSubtract(f64WordsLeft(m, 1u), vec2u(1u, 0u));
  var midpointExponent = i32(max(te, 1u)) - 1076;
  // At a normal binade boundary the previous spacing is half the next one.
  // The smallest normal shares its spacing with preceding subnormal values.
  if (te > 1u && all(m == vec2u(0u, 1048576u))) {
    midpoint = f64WordsSubtract(f64WordsLeft(m, 2u), vec2u(1u, 0u));
    midpointExponent -= 1;
  }
  let left = vec4u(n, 0u, 0u);
  let right = f64WideProduct(d, midpoint);
  let leftTop = dxaWideTop(left);
  let rightTop = dxaWideTop(right);
  let leftExponent = i32(max(ne, 1u)) - 1075 + i32(leftTop);
  let rightExponent = i32(max(de, 1u)) - 1075 + midpointExponent + i32(rightTop);
  if (leftExponent != rightExponent) { return leftExponent < rightExponent; }
  let alignedLeft = dxaWideLeft(left, 127u - leftTop);
  let alignedRight = dxaWideLeft(right, 127u - rightTop);
  if (all(alignedLeft == alignedRight)) {
    // Midpoint rounds to the predecessor exactly when its significand is even.
    return (threshold.x & 1u) != 0u;
  }
  return dxaWideLess(alignedLeft, alignedRight);
}
`;

const COMMON = /* wgsl */`
${CSP_F64_WGSL}
struct DxaSettings {
  alpha: vec2u, count: u32, start: u32,
  end: u32, vertexCount: u32, edgeCount: u32, transitionCount: u32,
};
fn dxaAbs(value: vec2u) -> vec2u { return vec2u(value.x, value.y & 2147483647u); }
fn dxaNegate(value: vec2u) -> vec2u { return vec2u(value.x, value.y ^ 2147483648u); }
fn dxaWithin(value: vec2u, tolerance: vec2u) -> bool {
  return !f64IsNan(value) && !f64Less(tolerance, dxaAbs(value));
}
`;

/** Completed Delaunay coordinates and adjacency remain unchanged. Alpha
 * status is -1 infinite, 0 outside, 1 inside, or 2 indeterminate sliver.
 */
export const DXA_ALPHA_SHADER = /* wgsl */`
${COMMON}
${DXA_RATIO_WGSL}
@group(0) @binding(0) var<storage, read> settings: DxaSettings;
@group(0) @binding(1) var<storage, read> vertices: array<vec2u>;
@group(0) @binding(2) var<storage, read> tetrahedra: array<u32>;
@group(0) @binding(3) var<storage, read_write> alphaStatus: array<i32>;

fn dxaDeterminant(a: array<vec2u, 3>, b: array<vec2u, 3>, c: array<vec2u, 3>) -> vec2u {
  let m02 = f64Subtract(f64Multiply(a[0], c[1]), f64Multiply(c[0], a[1]));
  let m01 = f64Subtract(f64Multiply(a[0], b[1]), f64Multiply(b[0], a[1]));
  let m12 = f64Subtract(f64Multiply(b[0], c[1]), f64Multiply(c[0], b[1]));
  return f64Add(f64Subtract(f64Multiply(m01, c[2]), f64Multiply(m02, b[2])), f64Multiply(m12, a[2]));
}
fn dxaSquared(value: array<vec2u, 3>) -> vec2u {
  return f64Add(f64Add(f64Multiply(value[0], value[0]), f64Multiply(value[1], value[1])), f64Multiply(value[2], value[2]));
}
@compute @workgroup_size(${DXA_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let cell = settings.start + gid.x;
  if (cell >= settings.count || cell >= settings.end) { return; }
  let base = cell * 16u;
  alphaStatus[cell] = -1;
  if (tetrahedra[base + 14u] == 0u) { return; }
  var vectors: array<array<vec2u, 3>, 3>;
  for (var vertex = 0u; vertex < 4u; vertex += 1u) {
    if (tetrahedra[base + vertex] >= settings.vertexCount) { alphaStatus[cell] = 0; return; }
  }
  for (var vertex = 0u; vertex < 3u; vertex += 1u) {
    for (var axis = 0u; axis < 3u; axis += 1u) {
      vectors[vertex][axis] = f64Subtract(vertices[tetrahedra[base + vertex + 1u] * 3u + axis], vertices[tetrahedra[base] * 3u + axis]);
    }
  }
  let q = vectors[0]; let r = vectors[1]; let s = vectors[2];
  let q2 = dxaSquared(q); let r2 = dxaSquared(r); let s2 = dxaSquared(s);
  let nx = dxaDeterminant(array<vec2u, 3>(q[1], q[2], q2), array<vec2u, 3>(r[1], r[2], r2), array<vec2u, 3>(s[1], s[2], s2));
  let ny = dxaDeterminant(array<vec2u, 3>(q[0], q[2], q2), array<vec2u, 3>(r[0], r[2], r2), array<vec2u, 3>(s[0], s[2], s2));
  let nz = dxaDeterminant(array<vec2u, 3>(q[0], q[1], q2), array<vec2u, 3>(r[0], r[1], r2), array<vec2u, 3>(s[0], s[1], s2));
  let den = dxaDeterminant(q, r, s);
  let numerator = f64Add(f64Add(f64Multiply(nx, nx), f64Multiply(ny, ny)), f64Multiply(nz, nz));
  let denominator = f64Multiply(f64Multiply(${f64Literal(4)}, den), den);
  if (f64Less(dxaAbs(denominator), ${f64Literal(1e-9)}) && f64Less(dxaAbs(numerator), ${f64Literal(1e-9)})) {
    alphaStatus[cell] = 2;
  } else {
    alphaStatus[cell] = select(0, 1, dxaPositiveRatioLess(numerator, denominator, settings.alpha));
  }
}
`;

/** The six oriented edge references use bit 31 for reversed orientation.
 * Transition matrices retain the CPU column-major binary64 representation.
 * All alpha results must be complete before this second dispatch sequence.
 */
export const DXA_REGION_SHADER = /* wgsl */`
${COMMON}
@group(0) @binding(0) var<storage, read> settings: DxaSettings;
@group(0) @binding(1) var<storage, read> tetrahedra: array<u32>;
@group(0) @binding(2) var<storage, read> edges: array<u32>;
@group(0) @binding(3) var<storage, read> transitions: array<vec2u>;
@group(0) @binding(4) var<storage, read> alphaStatus: array<i32>;
@group(0) @binding(5) var<storage, read_write> regions: array<i32>;

fn dxaMatrix(id: u32, reverse: bool) -> array<vec2u, 9> {
  var matrix: array<vec2u, 9>;
  let offset = id * 20u + select(0u, 9u, reverse);
  for (var index = 0u; index < 9u; index += 1u) { matrix[index] = transitions[offset + index]; }
  return matrix;
}
fn dxaTransform(matrix: array<vec2u, 9>, vector: array<vec2u, 3>) -> array<vec2u, 3> {
  var result: array<vec2u, 3>;
  for (var row = 0u; row < 3u; row += 1u) {
    result[row] = f64Add(f64Add(f64Multiply(matrix[row], vector[0]), f64Multiply(matrix[3u + row], vector[1])), f64Multiply(matrix[6u + row], vector[2]));
  }
  return result;
}
fn dxaMatrixProduct(a: array<vec2u, 9>, b: array<vec2u, 9>) -> array<vec2u, 9> {
  var result: array<vec2u, 9>;
  for (var column = 0u; column < 3u; column += 1u) {
    for (var row = 0u; row < 3u; row += 1u) {
      result[column * 3u + row] = f64Add(f64Add(f64Multiply(a[row], b[column * 3u]),
        f64Multiply(a[3u + row], b[column * 3u + 1u])), f64Multiply(a[6u + row], b[column * 3u + 2u]));
    }
  }
  return result;
}
@compute @workgroup_size(${DXA_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let cell = settings.start + gid.x;
  if (cell >= settings.count || cell >= settings.end) { return; }
  regions[cell] = -1;
  let status = alphaStatus[cell];
  if (status == -1 || status == 0) { return; }
  let base = cell * 16u;
  if (status == 2) {
    for (var face = 0u; face < 4u; face += 1u) {
      let neighbor = tetrahedra[base + 4u + face];
      if (neighbor >= settings.count) { return; }
      if (alphaStatus[neighbor] == -1 || alphaStatus[neighbor] == 0) { return; }
    }
  }
  var vectors: array<array<vec2u, 3>, 6>;
  var transitionIds: array<u32, 6>;
  var reversals: array<bool, 6>;
  var selfFlags: array<bool, 6>;
  for (var index = 0u; index < 6u; index += 1u) {
    let oriented = tetrahedra[base + 8u + index];
    let edge = oriented & 2147483647u;
    if (edge >= settings.edgeCount) { return; }
    let id = edges[edge * 8u + 6u];
    if (id >= settings.transitionCount) { return; }
    transitionIds[index] = id;
    reversals[index] = (oriented & 2147483648u) != 0u;
    selfFlags[index] = !f64IsZero(transitions[id * 20u + 18u]);
    for (var axis = 0u; axis < 3u; axis += 1u) {
      vectors[index][axis] = vec2u(edges[edge * 8u + axis * 2u], edges[edge * 8u + axis * 2u + 1u]);
    }
    if (reversals[index]) {
      for (var axis = 0u; axis < 3u; axis += 1u) { vectors[index][axis] = dxaNegate(vectors[index][axis]); }
      if (!selfFlags[index]) { vectors[index] = dxaTransform(dxaMatrix(id, false), vectors[index]); }
    }
  }
  let circuits = array<vec3u, 4>(vec3u(0u, 4u, 2u), vec3u(1u, 5u, 2u), vec3u(0u, 3u, 1u), vec3u(3u, 5u, 4u));
  for (var face = 0u; face < 4u; face += 1u) {
    let circuit = circuits[face];
    var second = vectors[circuit.y];
    if (!selfFlags[circuit.x]) { second = dxaTransform(dxaMatrix(transitionIds[circuit.x], !reversals[circuit.x]), second); }
    for (var axis = 0u; axis < 3u; axis += 1u) {
      let burgers = f64Subtract(f64Add(vectors[circuit.x][axis], second[axis]), vectors[circuit.z][axis]);
      if (!dxaWithin(burgers, ${f64Literal(1e-3)})) { return; }
    }
  }
  for (var face = 0u; face < 4u; face += 1u) {
    let circuit = circuits[face];
    if (!selfFlags[circuit.x] || !selfFlags[circuit.y] || !selfFlags[circuit.z]) {
      let t1 = dxaMatrix(transitionIds[circuit.x], reversals[circuit.x]);
      let t2 = dxaMatrix(transitionIds[circuit.y], reversals[circuit.y]);
      let t3reverse = dxaMatrix(transitionIds[circuit.z], !reversals[circuit.z]);
      let frank = dxaMatrixProduct(dxaMatrixProduct(t3reverse, t2), t1);
      for (var column = 0u; column < 3u; column += 1u) {
        for (var row = 0u; row < 3u; row += 1u) {
          let identity = select(vec2u(0u), ${f64Literal(1)}, row == column);
          if (!dxaWithin(f64Subtract(identity, frank[column * 3u + row]), ${f64Literal(1e-4)})) { return; }
        }
      }
    }
  }
  regions[cell] = 0;
}
`;
