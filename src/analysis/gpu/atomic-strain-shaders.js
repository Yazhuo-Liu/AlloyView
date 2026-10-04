/** Double-single arithmetic preserves PTM's Float64 scale and deformation.
 * Ordinary f32 matrix products create artificial strain in ideal crystals;
 * retaining the residual keeps the CPU's 1e-12 numerical-zero convention.
 */
export const DOUBLE_SINGLE_WGSL = `
fn dsAdd(a: vec2f, b: vec2f) -> vec2f {
  let sum = a.x + b.x;
  let recovered = sum - a.x;
  let residual = (a.x - (sum - recovered)) + (b.x - recovered) + a.y + b.y;
  let high = sum + residual;
  return vec2f(high, residual - (high - sum));
}
fn dsSubtract(a: vec2f, b: vec2f) -> vec2f { return dsAdd(a, -b); }
fn dsMultiply(a: vec2f, b: vec2f) -> vec2f {
  let product = a.x * b.x;
  // WGSL permits a non-fused fma, which can discard the entire product error.
  // Split the significands instead. Bit truncation avoids the overflow of
  // multiplying a large input by the conventional Dekker splitter (4097).
  let aHigh = bitcast<f32>(bitcast<u32>(a.x) & 0xfffff000u);
  let aLow = a.x - aHigh;
  let bHigh = bitcast<f32>(bitcast<u32>(b.x) & 0xfffff000u);
  let bLow = b.x - bHigh;
  let productError = ((aHigh * bHigh - product) + aHigh * bLow + aLow * bHigh) + aLow * bLow;
  let residual = productError + a.x * b.y + a.y * b.x + a.y * b.y;
  let high = product + residual;
  return vec2f(high, residual - (high - product));
}
fn dsValue(a: vec2f) -> f32 { return a.x + a.y; }
fn dsDivide(a: vec2f, b: vec2f) -> vec2f {
  let quotient = a.x / b.x;
  let residual = dsSubtract(a, dsMultiply(vec2f(quotient, 0.0), b));
  return dsAdd(vec2f(quotient, 0.0), vec2f((residual.x + residual.y) / b.x, 0.0));
}
fn numericalZero(a: vec2f) -> vec2f {
  if (abs(dsValue(a)) < 1e-12) { return vec2f(0.0); }
  return a;
}
fn dotColumns(matrix: array<vec2f, 9>, row: u32, column: u32) -> vec2f {
  var sum = vec2f(0.0);
  for (var k = 0u; k < 3u; k += 1u) { sum = dsAdd(sum, dsMultiply(matrix[k * 3u + row], matrix[k * 3u + column])); }
  return sum;
}
fn strainDeterminant(matrix: array<vec2f, 9>) -> vec2f {
  let first = dsMultiply(matrix[0], dsSubtract(dsMultiply(matrix[4], matrix[8]), dsMultiply(matrix[5], matrix[7])));
  let second = dsMultiply(matrix[1], dsSubtract(dsMultiply(matrix[3], matrix[8]), dsMultiply(matrix[5], matrix[6])));
  let third = dsMultiply(matrix[2], dsSubtract(dsMultiply(matrix[3], matrix[7]), dsMultiply(matrix[4], matrix[6])));
  return dsAdd(dsSubtract(first, second), third);
}
`;

// These are CPU referenceFactors' binary64 constants, encoded once per shader,
// never precomputed per atom. Phase selection and all a/c/scale algebra run GPU.
const splitConstant = value => {
  const high = Math.fround(value), low = Math.fround(value - high);
  const literal = number => Number.isInteger(number) ? `${number}.0` : String(number);
  return `vec2f(${literal(high)}, ${literal(low)})`;
};
const radiusPerA = {
  1: 1 / Math.SQRT2, 2: 1, 3: (4 * Math.sqrt(3) + 6) / 14,
  5: 1, 6: (Math.sqrt(3) + 6 * Math.SQRT2) / 16, 7: (Math.sqrt(6) + 12) / 16,
};

export const ATOMIC_STRAIN_SHADER = `
struct IdealReference {
  element: u32, structure: u32, flags: u32, padding: u32,
  a: vec2f, c: vec2f,
}
@group(0) @binding(0) var<storage, read> parameters: array<u32>;
@group(0) @binding(1) var<storage, read> atomElements: array<u32>;
@group(0) @binding(2) var<storage, read> ptmMetadata: array<vec2u>;
@group(0) @binding(3) var<storage, read> ptmScales: array<vec2f>;
@group(0) @binding(4) var<storage, read> deformation: array<vec2f>;
@group(0) @binding(5) var<storage, read> references: array<IdealReference>;
@group(0) @binding(6) var<storage, read_write> strainValues: array<f32>;
@group(0) @binding(7) var<storage, read_write> diagnostics: array<atomic<u32>>;
${DOUBLE_SINGLE_WGSL}
fn supportedDs(value: vec2f) -> bool {
  let highBits = bitcast<u32>(value.x) & 0x7fffffffu;
  let lowBits = bitcast<u32>(value.y) & 0x7fffffffu;
  // A nonzero high component must be a normal finite f32. GPU flushing of
  // subnormal denominators/factors is an explicit fallback, never false NaN.
  return highBits < 0x7f800000u && lowBits < 0x7f800000u
    && (highBits >= 0x00800000u || (highBits == 0u && lowBits == 0u));
}
// Retain the divisor residual explicitly. Dividing a result of fused DS
// expressions through dsSubtract(a, dsMultiply(q,b)) can let a shader compiler
// reassociate away b.y, erasing real small hydrostatic strain. The high-only
// product error and each source residual enter this correction independently.
fn idealDivide(a: vec2f, b: vec2f) -> vec2f {
  let quotient = a.x / b.x;
  let highProduct = dsMultiply(vec2f(quotient, 0.0), vec2f(b.x, 0.0));
  let remainder = ((a.x - highProduct.x) - highProduct.y) + a.y - quotient * b.y;
  return vec2f(quotient, remainder / b.x);
}
fn referenceRadius(structure: u32) -> vec2f {
  switch structure {
    ${Object.entries(radiusPerA).map(([structure, radius]) => `case ${structure}u: { return ${splitConstant(radius)}; }`).join('\n    ')}
    default: { return vec2f(0.0); }
  }
}
fn referenceIndex(element: u32) -> u32 {
  var lower = 0u;
  var upper = parameters[3];
  loop {
    if (lower >= upper) { break; }
    let middle = lower + (upper - lower) / 2u;
    if (references[middle].element < element) { lower = middle + 1u; }
    else { upper = middle; }
  }
  return lower;
}
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  let count = parameters[0];
  if (index >= count) { return; }
  let atom = index + parameters[1];
  let undefinedValue = bitcast<f32>(parameters[2]);
  for (var field = 0u; field < 9u; field += 1u) { strainValues[field * count + index] = undefinedValue; }
  let refIndex = referenceIndex(atomElements[atom]);
  if (refIndex >= parameters[3]) { atomicStore(&diagnostics[1], 1u); return; }
  let reference = references[refIndex];
  if (reference.element != atomElements[atom]) { atomicStore(&diagnostics[1], 1u); return; }
  let metadata = ptmMetadata[atom];
  if (metadata.x != reference.structure || (metadata.y & 3u) != 0u) {
    atomicAdd(&diagnostics[0], 1u); return;
  }
  // Encoding an otherwise valid source outside the portable f32/DS range
  // requires a CPU fallback, including f64/f32 subnormal source scales.
  let scale = ptmScales[atom];
  if (all(scale == vec2f(0.0)) && (metadata.y & 4u) == 0u) { atomicAdd(&diagnostics[0], 1u); return; }
  if ((metadata.y & 12u) != 0u || reference.flags != 0u) { atomicStore(&diagnostics[1], 1u); return; }
  // Preserve CPU operation order: 1 / ((scale*a)*radius), then
  // ((factor*sqrt(8/3))*a)/c for the third reference column of hexagonal phases.
  let scaleA = dsMultiply(scale, reference.a);
  let radius = referenceRadius(metadata.x);
  let denominator = dsMultiply(scaleA, radius);
  if (!supportedDs(scaleA) || !supportedDs(denominator) || all(denominator == vec2f(0.0))) {
    atomicStore(&diagnostics[1], 1u); return;
  }
  let factor = idealDivide(vec2f(1.0, 0.0), denominator);
  var zFactor = factor;
  if (metadata.x == 2u || metadata.x == 7u) {
    let hexagonalFactor = dsMultiply(factor, ${splitConstant(Math.sqrt(8 / 3))});
    let scaledA = dsMultiply(hexagonalFactor, reference.a);
    if (!supportedDs(hexagonalFactor) || !supportedDs(scaledA)) { atomicStore(&diagnostics[1], 1u); return; }
    zFactor = idealDivide(scaledA, reference.c);
  }
  if (!supportedDs(factor) || !supportedDs(zFactor)) { atomicStore(&diagnostics[1], 1u); return; }
  var matrix: array<vec2f, 9>;
  for (var component = 0u; component < 9u; component += 1u) {
    let columnFactor = select(factor, zFactor, component % 3u == 2u);
    matrix[component] = dsMultiply(deformation[atom * 9u + component], columnFactor);
    if (!supportedDs(matrix[component]) || abs(dsValue(matrix[component])) > 1e8) {
      atomicStore(&diagnostics[1], 1u); return;
    }
  }
  let volume = strainDeterminant(matrix);
  if (abs(dsValue(volume)) < 1e-10) { atomicStore(&diagnostics[1], 1u); return; }
  if (!(dsValue(volume) > 0.0)) { atomicAdd(&diagnostics[0], 1u); return; }
  if (!(abs(dsValue(volume)) < 3.402823e38)) { atomicStore(&diagnostics[1], 1u); return; }
  var tensor: array<vec2f, 6>;
  tensor[0] = numericalZero(dsMultiply(dsSubtract(dotColumns(matrix, 0u, 0u), vec2f(1.0, 0.0)), vec2f(0.5, 0.0)));
  tensor[1] = numericalZero(dsMultiply(dsSubtract(dotColumns(matrix, 1u, 1u), vec2f(1.0, 0.0)), vec2f(0.5, 0.0)));
  tensor[2] = numericalZero(dsMultiply(dsSubtract(dotColumns(matrix, 2u, 2u), vec2f(1.0, 0.0)), vec2f(0.5, 0.0)));
  tensor[3] = numericalZero(dsMultiply(dotColumns(matrix, 0u, 1u), vec2f(0.5, 0.0)));
  tensor[4] = numericalZero(dsMultiply(dotColumns(matrix, 0u, 2u), vec2f(0.5, 0.0)));
  tensor[5] = numericalZero(dsMultiply(dotColumns(matrix, 1u, 2u), vec2f(0.5, 0.0)));
  let third = vec2f(0.3333333432674408, -9.934107758624577e-9);
  let hydrostatic = dsMultiply(dsAdd(dsAdd(tensor[0], tensor[1]), tensor[2]), third);
  var norm = vec2f(0.0);
  for (var diagonal = 0u; diagonal < 3u; diagonal += 1u) {
    let deviation = dsSubtract(tensor[diagonal], hydrostatic);
    norm = dsAdd(norm, dsMultiply(deviation, deviation));
  }
  for (var offDiagonal = 3u; offDiagonal < 6u; offDiagonal += 1u) {
    norm = dsAdd(norm, dsMultiply(dsMultiply(tensor[offDiagonal], tensor[offDiagonal]), vec2f(2.0, 0.0)));
  }
  strainValues[index] = sqrt(max(0.0, dsValue(norm)) / 2.0);
  strainValues[count + index] = dsValue(hydrostatic);
  strainValues[count * 2u + index] = dsValue(numericalZero(dsSubtract(volume, vec2f(1.0, 0.0))));
  for (var component = 0u; component < 6u; component += 1u) { strainValues[count * (component + 3u) + index] = dsValue(tensor[component]); }
}`;
