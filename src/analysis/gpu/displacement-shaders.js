import { DOUBLE_SINGLE_WGSL } from './atomic-strain-shaders.js';

export const MAX_GPU_DISPLACEMENT_IMAGE_CANDIDATES = 512;

/** Cartesian inputs are anchored high/low pairs, never drawing positions or
 * wrapped fractional coordinates. The current cell determines all images.
 */
export const DISPLACEMENT_SHADER = `
struct DisplacementSettings {
  count: u32, startAtom: u32, endAtom: u32, nanBits: u32,
  pbc: vec4u, options: vec4u, heights: vec4f,
  matrices: array<vec2f, 18>, anchorChange: array<vec2f, 3>,
};
@group(0) @binding(0) var<storage, read> settings: DisplacementSettings;
@group(0) @binding(1) var<storage, read> mapping: array<i32>;
@group(0) @binding(2) var<storage, read> currentPositions: array<vec4f>;
@group(0) @binding(3) var<storage, read> referencePositions: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> vectors: array<f32>;
@group(0) @binding(5) var<storage, read_write> magnitudes: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> flags: array<u32>;
${DOUBLE_SINGLE_WGSL}
fn displacementTransform(value: array<vec2f, 3>, inverse: bool) -> array<vec2f, 3> {
  var result: array<vec2f, 3>;
  let offset = select(0u, 9u, inverse);
  for (var row = 0u; row < 3u; row += 1u) {
    result[row] = vec2f(0.0);
    for (var column = 0u; column < 3u; column += 1u) {
      result[row] = dsAdd(result[row], dsMultiply(value[column], settings.matrices[offset + column * 3u + row]));
    }
  }
  return result;
}
fn displacementSquaredLength(fractional: array<vec2f, 3>) -> vec2f {
  let cartesian = displacementTransform(fractional, false);
  var squared = vec2f(0.0);
  for (var axis = 0u; axis < 3u; axis += 1u) { squared = dsAdd(squared, dsMultiply(cartesian[axis], cartesian[axis])); }
  return squared;
}
struct DisplacementImage { value: array<vec2f, 3>, uncertain: bool, };
fn displacementMinimumImage(change: array<vec2f, 3>) -> DisplacementImage {
  var result: DisplacementImage;
  result.uncertain = false;
  let fractional = displacementTransform(change, true);
  var shifts = vec3i(0);
  var image: array<vec2f, 3>;
  for (var axis = 0u; axis < 3u; axis += 1u) {
    let coordinate = dsValue(fractional[axis]);
    // Limit integer conversion and cancellation in exceptionally distant images.
    if (!(abs(coordinate) < 1048576.0)) { result.uncertain = true; return result; }
    if (settings.pbc[axis] != 0u) {
      // Math.round chooses the positive integer at a half boundary. A nearby
      // boundary receives the exact CPU decision rather than f32 rounding.
      if (abs(coordinate - floor(coordinate) - 0.5) <= 1e-6) { result.uncertain = true; return result; }
      shifts[axis] = -i32(floor(coordinate + 0.5));
    }
    image[axis] = dsAdd(fractional[axis], vec2f(f32(shifts[axis]), 0.0));
  }
  if (settings.options.y != 0u) { result.value = displacementTransform(image, false); return result; }
  var best = displacementSquaredLength(image);
  let bestValue = dsValue(best);
  if (!(bestValue >= 0.0) || !(bestValue < 3.402823e38)) { result.uncertain = true; return result; }
  let radius = sqrt(bestValue);
  var minimum = vec3i(0); var maximum = vec3i(0);
  for (var axis = 0u; axis < 3u; axis += 1u) {
    if (settings.pbc[axis] != 0u) {
      let bound = radius / settings.heights[axis];
      let padding = 1e-6 * (bound + abs(dsValue(fractional[axis])) + 1.0);
      let low = ceil(-bound - dsValue(fractional[axis]) - padding);
      let high = floor(bound - dsValue(fractional[axis]) + padding);
      if (!(abs(low) < 1048576.0) || !(abs(high) < 1048576.0)) { result.uncertain = true; return result; }
      minimum[axis] = i32(low); maximum[axis] = i32(high);
    }
  }
  let spans = maximum - minimum + vec3i(1);
  if (any(spans <= vec3i(0)) || any(spans > vec3i(${MAX_GPU_DISPLACEMENT_IMAGE_CANDIDATES}))
    || spans.x * spans.y * spans.z > ${MAX_GPU_DISPLACEMENT_IMAGE_CANDIDATES}) { result.uncertain = true; return result; }
  for (var a = minimum.x; a <= maximum.x; a += 1) {
    for (var b = minimum.y; b <= maximum.y; b += 1) {
      for (var c = minimum.z; c <= maximum.z; c += 1) {
        let candidateShift = vec3i(a, b, c);
        if (all(candidateShift == shifts)) { continue; }
        var candidate: array<vec2f, 3>;
        for (var axis = 0u; axis < 3u; axis += 1u) { candidate[axis] = dsAdd(fractional[axis], vec2f(f32(candidateShift[axis]), 0.0)); }
        let squared = displacementSquaredLength(candidate);
        let difference = dsValue(dsSubtract(squared, best));
        // The CPU's strict comparison fixes the sign of equally short images.
        if (abs(difference) <= max(1e-20, abs(dsValue(best)) * 1e-10)) { result.uncertain = true; }
        if (difference < 0.0) { best = squared; shifts = candidateShift; image = candidate; }
      }
    }
  }
  result.value = displacementTransform(image, false);
  return result;
}
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let atom = settings.options.z + gid.x;
  if (atom >= settings.options.w || atom >= settings.endAtom || atom >= settings.count) { return; }
  let index = atom - settings.startAtom;
  let undefinedValue = bitcast<f32>(settings.nanBits);
  for (var axis = 0u; axis < 3u; axis += 1u) { vectors[index * 3u + axis] = undefinedValue; }
  magnitudes[index] = vec4f(undefinedValue);
  flags[index] = 0u;
  let referenceAtom = mapping[atom];
  if (referenceAtom < 0) { return; }
  var change: array<vec2f, 3>;
  for (var axis = 0u; axis < 3u; axis += 1u) {
    let current = vec2f(currentPositions[atom * 2u][axis], currentPositions[atom * 2u + 1u][axis]);
    let reference = vec2f(referencePositions[u32(referenceAtom) * 2u][axis], referencePositions[u32(referenceAtom) * 2u + 1u][axis]);
    change[axis] = dsAdd(dsSubtract(current, reference), settings.anchorChange[axis]);
  }
  if (settings.options.x != 0u && any(settings.pbc.xyz != vec3u(0))) {
    let resolved = displacementMinimumImage(change);
    if (resolved.uncertain) { flags[index] = 2u; return; }
    change = resolved.value;
  }
  let sourceError = currentPositions[atom * 2u].w + referencePositions[u32(referenceAtom) * 2u].w;
  let lengthScale = max(abs(dsValue(change[0])), max(abs(dsValue(change[1])), abs(dsValue(change[2]))));
  let sharedIdentity = settings.pbc.w != 0u && u32(referenceAtom) == atom;
  if (!sharedIdentity && sourceError > 0.0 && lengthScale <= sourceError * 4096.0) {
    // Encoding must never erase or invent a tiny physical displacement in a
    // very large coordinate span. Identical source rows are exactly zero.
    flags[index] = 2u; return;
  }
  var rounded: array<f32, 3>;
  var scale = 0.0;
  for (var axis = 0u; axis < 3u; axis += 1u) {
    let value = dsValue(change[axis]);
    if (!(abs(value) < 3.402823e38)) { flags[index] = 2u; return; }
    rounded[axis] = value; vectors[index * 3u + axis] = value;
    scale = max(scale, abs(value));
  }
  if (scale == 0.0) { magnitudes[index] = vec4f(0.0); flags[index] = 1u; return; }
  // The scalar color property uses the same rounded vector components as the
  // arrows. Scaling keeps both tiny norms and finite norms above f32 max safe.
  var squared = vec2f(0.0);
  for (var axis = 0u; axis < 3u; axis += 1u) {
    let normalized = dsDivide(vec2f(rounded[axis], 0.0), vec2f(scale, 0.0));
    squared = dsAdd(squared, dsMultiply(normalized, normalized));
  }
  let root = sqrt(max(0.0, dsValue(squared)));
  let error = dsSubtract(squared, dsMultiply(vec2f(root, 0.0), vec2f(root, 0.0)));
  let norm = dsAdd(vec2f(root, 0.0), dsDivide(error, vec2f(2.0 * root, 0.0)));
  magnitudes[index] = vec4f(norm, scale, 0.0);
  flags[index] = 1u;
}`;
