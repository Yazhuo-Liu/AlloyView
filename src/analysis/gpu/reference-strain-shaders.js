import { makeNeighborShader } from './neighbors.js';
import { DOUBLE_SINGLE_WGSL } from './atomic-strain-shaders.js';

export const MAX_GPU_REFERENCE_IMAGE_CANDIDATES = 256;
export const MAX_GPU_REFERENCE_ATOM_CANDIDATES = 50_000;

const declarations = `
struct ReferenceSettings {
  count: u32, startAtom: u32, endAtom: u32, nanBits: u32,
  pbc: vec4u, heights: vec4f,
  currentA: vec4f, currentB: vec4f, currentC: vec4f,
  cells: array<vec2f, 18>, imageScale: vec4f,
};
@group(0) @binding(4) var<storage, read> currentPositions: array<vec4f>;
@group(0) @binding(5) var<storage, read> inverseMapping: array<i32>;
@group(0) @binding(6) var<storage, read> settings: ReferenceSettings;
@group(0) @binding(7) var<storage, read_write> strainValues: array<f32>;
@group(0) @binding(8) var<storage, read_write> flags: array<u32>;
${DOUBLE_SINGLE_WGSL}
fn referenceCoordinate(atomIndex: u32, axis: u32) -> vec2f {
  return vec2f(positions[atomIndex * 2u][axis], positions[atomIndex * 2u + 1u][axis]);
}
fn currentCoordinate(atomIndex: u32, axis: u32) -> vec2f {
  return vec2f(currentPositions[atomIndex * 2u][axis], currentPositions[atomIndex * 2u + 1u][axis]);
}
fn referenceCartesian(fractional: array<vec2f, 3>, current: bool) -> array<vec2f, 3> {
  var result: array<vec2f, 3>;
  let offset = select(0u, 9u, current);
  for (var row = 0u; row < 3u; row += 1u) {
    result[row] = vec2f(0.0);
    for (var column = 0u; column < 3u; column += 1u) {
      result[row] = dsAdd(result[row], dsMultiply(fractional[column], settings.cells[offset + column * 3u + row]));
    }
  }
  return result;
}
fn referenceSquaredLength(fractional: array<vec2f, 3>) -> vec2f {
  let cartesian = referenceCartesian(fractional, true);
  var result = vec2f(0.0);
  for (var axis = 0u; axis < 3u; axis += 1u) { result = dsAdd(result, dsMultiply(cartesian[axis], cartesian[axis])); }
  return result;
}
struct ReferenceImage {
  fractional: array<vec2f, 3>, uncertain: bool, candidates: u32,
};
// Image shifts count periods of the image lattice. One current cell vector
// spans imageScale periods: 1, or the repeat count of a replicated wrapped
// frame, whose images are resolved in its source lattice (settings.heights).
fn referenceImageShift(shift: i32, axis: u32) -> vec2f {
  let whole = vec2f(f32(shift), 0.0);
  if (settings.imageScale[axis] == 1.0) { return whole; }
  return dsDivide(whole, vec2f(settings.imageScale[axis], 0.0));
}
fn referenceMinimumImage(change: array<vec2f, 3>) -> ReferenceImage {
  var result: ReferenceImage;
  result.candidates = 0u;
  var shifts = vec3i(0);
  var periods = vec3f(0.0);
  for (var axis = 0u; axis < 3u; axis += 1u) {
    periods[axis] = dsValue(change[axis]) * settings.imageScale[axis];
    if (settings.pbc[axis] != 0u) { shifts[axis] = -i32(floor(periods[axis] + 0.5)); }
    result.fractional[axis] = dsAdd(change[axis], referenceImageShift(shifts[axis], axis));
  }
  var best = referenceSquaredLength(result.fractional);
  let radius = sqrt(max(0.0, dsValue(best)));
  var minimum = vec3i(0); var maximum = vec3i(0);
  for (var axis = 0u; axis < 3u; axis += 1u) {
    if (settings.pbc[axis] != 0u) {
      let bound = radius / settings.heights[axis] + 1e-6 * settings.imageScale[axis];
      minimum[axis] = i32(ceil(-bound - periods[axis]));
      maximum[axis] = i32(floor(bound - periods[axis]));
    }
  }
  let spans = maximum - minimum + vec3i(1);
  if (any(spans > vec3i(${MAX_GPU_REFERENCE_IMAGE_CANDIDATES}))
    || spans.x * spans.y * spans.z > ${MAX_GPU_REFERENCE_IMAGE_CANDIDATES}) {
    result.uncertain = true; return result;
  }
  result.uncertain = false;
  for (var a = minimum.x; a <= maximum.x; a += 1) {
    for (var b = minimum.y; b <= maximum.y; b += 1) {
      for (var c = minimum.z; c <= maximum.z; c += 1) {
        result.candidates += 1u;
        let candidateShift = vec3i(a, b, c);
        if (all(candidateShift == shifts)) { continue; }
        var candidate: array<vec2f, 3>;
        for (var axis = 0u; axis < 3u; axis += 1u) { candidate[axis] = dsAdd(change[axis], referenceImageShift(candidateShift[axis], axis)); }
        let distance = referenceSquaredLength(candidate);
        let difference = dsValue(dsSubtract(distance, best));
        if (abs(difference) <= max(1e-20, abs(dsValue(best)) * 1e-6)) { result.uncertain = true; }
        if (difference < 0.0) { best = distance; shifts = candidateShift; result.fractional = candidate; }
      }
    }
  }
  return result;
}
`;

const initialize = `
let mappedAtom = inverseMapping[atom];
if (mappedAtom < 0) { return; }
let currentAtom = u32(mappedAtom);
if (currentAtom < settings.startAtom || currentAtom >= settings.endAtom) { return; }
flags[currentAtom] = 0u;
var covariance: array<vec2f, 9>;
var crossCovariance: array<vec2f, 9>;
for (var component = 0u; component < 9u; component += 1u) {
  covariance[component] = vec2f(0.0); crossCovariance[component] = vec2f(0.0);
}
var neighborCount = 0u;
var squaredLengths = vec2f(0.0);
var imageCandidates = 0u;
var imageWork = 0u;
var referenceNeighborCount = 0u;`;

const visit = `
referenceNeighborCount += 1u;
if (referenceNeighborCount > 100000u) { flags[currentAtom] = 2u; return; }
let mappedOther = inverseMapping[other];
if (mappedOther < 0) { continue; }
var referenceFractional: array<vec2f, 3>;
var change: array<vec2f, 3>;
let imageShift = vec3i(imageA, imageB, imageC);
for (var axis = 0u; axis < 3u; axis += 1u) {
  let referenceDifference = dsSubtract(referenceCoordinate(other, axis), referenceCoordinate(atom, axis));
  referenceFractional[axis] = dsAdd(referenceDifference, vec2f(-f32(imageShift[axis]), 0.0));
  let currentDifference = dsSubtract(currentCoordinate(u32(mappedOther), axis), currentCoordinate(currentAtom, axis));
  change[axis] = dsSubtract(currentDifference, referenceDifference);
}
let resolved = referenceMinimumImage(change);
imageWork += resolved.candidates;
if (imageWork > ${MAX_GPU_REFERENCE_ATOM_CANDIDATES}u) { flags[currentAtom] = 2u; return; }
if (resolved.uncertain) { flags[currentAtom] = 2u; return; }
var currentFractional: array<vec2f, 3>;
for (var axis = 0u; axis < 3u; axis += 1u) { currentFractional[axis] = dsAdd(referenceFractional[axis], resolved.fractional[axis]); }
let r = referenceCartesian(referenceFractional, false);
let s = referenceCartesian(currentFractional, true);
for (var axis = 0u; axis < 3u; axis += 1u) { squaredLengths = dsAdd(squaredLengths, dsMultiply(s[axis], s[axis])); }
for (var row = 0u; row < 3u; row += 1u) {
  for (var column = 0u; column < 3u; column += 1u) {
    covariance[row * 3u + column] = dsAdd(covariance[row * 3u + column], dsMultiply(r[row], r[column]));
    crossCovariance[row * 3u + column] = dsAdd(crossCovariance[row * 3u + column], dsMultiply(s[row], r[column]));
  }
}
neighborCount += 1u;`;

const finish = `
if (neighborCount < 3u) { return; }
let scale = max(dsValue(covariance[0]), max(dsValue(covariance[4]), dsValue(covariance[8])));
if (!(scale > 0.0) || !(scale < 3.402823e38)) { flags[currentAtom] = 2u; return; }
var normalized: array<vec2f, 9>;
for (var component = 0u; component < 9u; component += 1u) { normalized[component] = dsDivide(covariance[component], vec2f(scale, 0.0)); }
let determinant = strainDeterminant(normalized);
// Near-rank-deficient fits receive the exact CPU singularity decision.
if (dsValue(determinant) <= 1e-10) { flags[currentAtom] = 2u; return; }
let denominator = dsMultiply(vec2f(scale, 0.0), determinant);
var inverse: array<vec2f, 9>;
inverse[0] = dsDivide(dsSubtract(dsMultiply(normalized[4], normalized[8]), dsMultiply(normalized[5], normalized[7])), denominator);
inverse[1] = dsDivide(dsSubtract(dsMultiply(normalized[2], normalized[7]), dsMultiply(normalized[1], normalized[8])), denominator);
inverse[2] = dsDivide(dsSubtract(dsMultiply(normalized[1], normalized[5]), dsMultiply(normalized[2], normalized[4])), denominator);
inverse[3] = dsDivide(dsSubtract(dsMultiply(normalized[5], normalized[6]), dsMultiply(normalized[3], normalized[8])), denominator);
inverse[4] = dsDivide(dsSubtract(dsMultiply(normalized[0], normalized[8]), dsMultiply(normalized[2], normalized[6])), denominator);
inverse[5] = dsDivide(dsSubtract(dsMultiply(normalized[2], normalized[3]), dsMultiply(normalized[0], normalized[5])), denominator);
inverse[6] = dsDivide(dsSubtract(dsMultiply(normalized[3], normalized[7]), dsMultiply(normalized[4], normalized[6])), denominator);
inverse[7] = dsDivide(dsSubtract(dsMultiply(normalized[1], normalized[6]), dsMultiply(normalized[0], normalized[7])), denominator);
inverse[8] = dsDivide(dsSubtract(dsMultiply(normalized[0], normalized[4]), dsMultiply(normalized[1], normalized[3])), denominator);
var matrix: array<vec2f, 9>;
for (var row = 0u; row < 3u; row += 1u) {
  for (var column = 0u; column < 3u; column += 1u) {
    var value = vec2f(0.0);
    for (var k = 0u; k < 3u; k += 1u) { value = dsAdd(value, dsMultiply(crossCovariance[row * 3u + k], inverse[k * 3u + column])); }
    matrix[row * 3u + column] = numericalZero(value);
    if (!(abs(dsValue(value)) < 1e8)) { flags[currentAtom] = 2u; return; }
  }
}
let volume = strainDeterminant(matrix);
if (abs(dsValue(volume)) < 1e-10) { flags[currentAtom] = 2u; return; }
if (!(dsValue(volume) > 0.0)) { return; }
var tensor: array<vec2f, 6>;
tensor[0] = numericalZero(dsMultiply(dsSubtract(dotColumns(matrix, 0u, 0u), vec2f(1.0, 0.0)), vec2f(0.5, 0.0)));
tensor[1] = numericalZero(dsMultiply(dsSubtract(dotColumns(matrix, 1u, 1u), vec2f(1.0, 0.0)), vec2f(0.5, 0.0)));
tensor[2] = numericalZero(dsMultiply(dsSubtract(dotColumns(matrix, 2u, 2u), vec2f(1.0, 0.0)), vec2f(0.5, 0.0)));
tensor[3] = numericalZero(dsMultiply(dotColumns(matrix, 0u, 1u), vec2f(0.5, 0.0)));
tensor[4] = numericalZero(dsMultiply(dotColumns(matrix, 0u, 2u), vec2f(0.5, 0.0)));
tensor[5] = numericalZero(dsMultiply(dotColumns(matrix, 1u, 2u), vec2f(0.5, 0.0)));
let third = vec2f(0.3333333432674408, -9.934107758624577e-9);
let hydrostatic = numericalZero(dsMultiply(dsAdd(dsAdd(tensor[0], tensor[1]), tensor[2]), third));
var norm = vec2f(0.0);
for (var diagonal = 0u; diagonal < 3u; diagonal += 1u) {
  let deviation = dsSubtract(tensor[diagonal], hydrostatic);
  norm = dsAdd(norm, dsMultiply(deviation, deviation));
}
for (var offDiagonal = 3u; offDiagonal < 6u; offDiagonal += 1u) { norm = dsAdd(norm, dsMultiply(dsMultiply(tensor[offDiagonal], tensor[offDiagonal]), vec2f(2.0, 0.0))); }
let count = settings.endAtom - settings.startAtom;
let index = currentAtom - settings.startAtom;
let shear = sqrt(max(0.0, dsValue(norm)) / 2.0);
strainValues[index] = select(shear, 0.0, abs(shear) < 1e-12);
strainValues[count + index] = dsValue(hydrostatic);
strainValues[count * 2u + index] = dsValue(numericalZero(dsSubtract(volume, vec2f(1.0, 0.0))));
for (var component = 0u; component < 6u; component += 1u) { strainValues[count * (component + 3u) + index] = dsValue(tensor[component]); }
for (var component = 0u; component < 9u; component += 1u) { strainValues[count * (component + 9u) + index] = dsValue(matrix[component]); }
// D²min = Σ|d|² − 2 Σ F∘C + Σ (F A Fᵀ)ᵢᵢ, as nonAffineSquaredDisplacement on the CPU.
var fc = vec2f(0.0);
for (var component = 0u; component < 9u; component += 1u) { fc = dsAdd(fc, dsMultiply(matrix[component], crossCovariance[component])); }
var faf = vec2f(0.0);
for (var row = 0u; row < 3u; row += 1u) {
  for (var column = 0u; column < 3u; column += 1u) {
    var fa = vec2f(0.0);
    for (var k = 0u; k < 3u; k += 1u) { fa = dsAdd(fa, dsMultiply(matrix[row * 3u + k], covariance[k * 3u + column])); }
    faf = dsAdd(faf, dsMultiply(fa, matrix[row * 3u + column]));
  }
}
let residual = dsValue(dsAdd(dsSubtract(squaredLengths, dsMultiply(fc, vec2f(2.0, 0.0))), faf));
strainValues[count * 18u + index] = select(max(0.0, residual), 0.0, abs(residual) <= dsValue(squaredLengths) * 1e-10);
flags[currentAtom] = 1u;`;

// Binding 4 is the current-frame coordinate buffer rather than unused species.
export const REFERENCE_STRAIN_SHADER = makeNeighborShader({ mode: 'images', declarations, initialize, visit, finish,
  candidateVisit: `imageCandidates += 1u;
  if (imageCandidates > ${MAX_GPU_REFERENCE_ATOM_CANDIDATES}u) { flags[currentAtom] = 2u; return; }
  if (inverseMapping[other] >= 0 && abs(distanceSquared - config.cutoff2) <= config.distanceTolerance) {
    flags[currentAtom] = 2u; return;
  }`,
}).replace('@group(0) @binding(4) var<storage, read> types: array<u32>;', '');

export const REFERENCE_STRAIN_CLEAR_SHADER = `
@group(0) @binding(0) var<storage, read> parameters: array<u32>;
@group(0) @binding(1) var<storage, read_write> strainValues: array<f32>;
@compute @workgroup_size(128) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let atom = gid.x; if (atom >= parameters[0]) { return; }
  let undefinedValue = bitcast<f32>(parameters[1]);
  for (var field = 0u; field < 19u; field += 1u) { strainValues[field * parameters[0] + atom] = undefinedValue; }
}`;
