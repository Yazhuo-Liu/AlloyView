/** Double-single arithmetic preserves PTM's Float64 scale and deformation.
 * Ordinary f32 matrix products create artificial strain in ideal crystals;
 * retaining the residual keeps the CPU's 1e-12 numerical-zero convention.
 */
export const ATOMIC_STRAIN_SHADER = `
@group(0) @binding(0) var<storage, read> parameters: array<u32>;
@group(0) @binding(1) var<storage, read> validAtoms: array<u32>;
@group(0) @binding(2) var<storage, read> factors: array<vec4f>;
@group(0) @binding(3) var<storage, read> deformation: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> strainValues: array<f32>;
@group(0) @binding(5) var<storage, read_write> diagnostics: array<atomic<u32>>;

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
  let residual = fma(a.x, b.x, -product) + a.x * b.y + a.y * b.x + a.y * b.y;
  let high = product + residual;
  return vec2f(high, residual - (high - product));
}
fn dsValue(a: vec2f) -> f32 { return a.x + a.y; }
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
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  let count = parameters[0];
  if (index >= count) { return; }
  let atom = index + parameters[1];
  let undefinedValue = bitcast<f32>(parameters[2]);
  for (var field = 0u; field < 9u; field += 1u) { strainValues[field * count + index] = undefinedValue; }
  if (validAtoms[atom] == 0u) { atomicAdd(&diagnostics[0], 1u); return; }
  let atomFactors = factors[atom];
  var matrix: array<vec2f, 9>;
  for (var component = 0u; component < 9u; component += 1u) {
    var factor = atomFactors.xy;
    if (component % 3u == 2u) { factor = atomFactors.zw; }
    matrix[component] = dsMultiply(deformation[atom * 9u + component], factor);
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
