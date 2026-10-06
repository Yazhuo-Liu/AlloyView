import { makeNeighborShader } from './neighbors.js';

export const MAX_GPU_BOND_STATISTICS_NEIGHBORS = 128;
export const BOND_STATISTICS_ATOM_WORDS = 14;
export const BOND_STATISTICS_CORRECTION_WORDS = 12;
export const BOND_STATISTICS_FLAG_PRECISION = 1;
export const BOND_STATISTICS_FLAG_NEIGHBORS = 2;

// Q_l is evaluated with the spherical-harmonic addition theorem. This uses
// the same unordered neighbor pairs as the angle distribution, rather than
// computing 22 complex spherical harmonics for every bond.
export const BOND_STATISTICS_SHADER = makeNeighborShader({
  mode: 'images',
  declarations: `
@group(0) @binding(5) var<storage, read> settings: array<u32>;
@group(0) @binding(6) var<storage, read_write> atomData: array<u32>;
@group(0) @binding(7) var<storage, read_write> histogram: array<atomic<u32>>;
struct Corrections {
  count: atomic<u32>, overflow: atomic<u32>, padding: vec2u,
  records: array<u32>,
};
@group(0) @binding(8) var<storage, read_write> corrections: Corrections;
struct Moment { count: u32, minimum: f32, maximum: f32, mean: f32, m2: f32 };
fn emptyMoment() -> Moment { return Moment(0u, 3.402823e38f, -3.402823e38f, 0.0, 0.0); }
fn addSample(source: Moment, value: f32) -> Moment {
  let count = source.count + 1u;
  let delta = value - source.mean;
  let mean = source.mean + delta / f32(count);
  return Moment(count, min(source.minimum, value), max(source.maximum, value), mean,
    source.m2 + delta * (value - mean));
}
fn writeMoment(offset: u32, moment: Moment) {
  atomData[offset] = moment.count;
  atomData[offset + 1u] = bitcast<u32>(moment.minimum);
  atomData[offset + 2u] = bitcast<u32>(moment.maximum);
  atomData[offset + 3u] = bitcast<u32>(moment.mean);
  atomData[offset + 4u] = bitcast<u32>(moment.m2);
}
fn selectedCutoff(first: u32, second: u32) -> f32 {
  let a = min(first, second); let b = max(first, second);
  for (var entry = 0u; entry < settings[0]; entry++) {
    let offset = 12u + entry * 4u;
    if (settings[offset] == a && settings[offset + 1u] == b) { return bitcast<f32>(settings[offset + 2u]); }
  }
  return bitcast<f32>(settings[4]);
}
fn positiveImage(value: vec3i) -> bool {
  if (value.x != 0) { return value.x > 0; }
  if (value.y != 0) { return value.y > 0; }
  return value.z > 0;
}
fn recordCorrection(kind: u32, atom: u32, first: u32, second: u32, firstShift: vec3i, secondShift: vec3i) {
  let cursor = atomicAdd(&corrections.count, 1u);
  if (cursor >= settings[3]) { atomicStore(&corrections.overflow, 1u); return; }
  let base = cursor * ${BOND_STATISTICS_CORRECTION_WORDS}u;
  corrections.records[base] = kind; corrections.records[base + 1u] = atom;
  corrections.records[base + 2u] = first; corrections.records[base + 3u] = second;
  for (var component = 0u; component < 3u; component++) {
    corrections.records[base + 4u + component] = bitcast<u32>(firstShift[component]);
    corrections.records[base + 7u + component] = bitcast<u32>(secondShift[component]);
  }
}
fn shellIsAmbiguous(shell: f32, bins: u32, margin: f32) -> bool {
  let edge = round(shell);
  return edge > 0.0 && edge < f32(bins) && abs(shell - edge) <= margin;
}
// WGSL's native acos permits substantial implementation error on some
// adapters. Reduce atan to |x| <= tan(pi/8), then use its alternating series;
// the truncation error is below 3e-9 radians before f32 roundoff.
fn preciseAngle(cosine: f32) -> f32 {
  var x = sqrt(max(0.0, (1.0 - abs(cosine)) / (1.0 + abs(cosine))));
  var offset = 0.0;
  if (x > 0.414213562373095) { x = (x - 1.0) / (x + 1.0); offset = 0.7853981633974483; }
  let squared = x * x;
  var polynomial = 1.0 / 17.0;
  polynomial = -1.0 / 15.0 + squared * polynomial;
  polynomial = 1.0 / 13.0 + squared * polynomial;
  polynomial = -1.0 / 11.0 + squared * polynomial;
  polynomial = 1.0 / 9.0 + squared * polynomial;
  polynomial = -1.0 / 7.0 + squared * polynomial;
  polynomial = 1.0 / 5.0 + squared * polynomial;
  polynomial = -1.0 / 3.0 + squared * polynomial;
  polynomial = 1.0 + squared * polynomial;
  let positive = 2.0 * (offset + x * polynomial);
  return select(positive, 3.141592653589793 - positive, cosine < 0.0) * 57.29577951308232;
}
`,
  initialize: `
  var neighborVectors: array<vec3f, ${MAX_GPU_BOND_STATISTICS_NEIGHBORS}>;
  var neighborIds: array<u32, ${MAX_GPU_BOND_STATISTICS_NEIGHBORS}>;
  var neighborShifts: array<vec3i, ${MAX_GPU_BOND_STATISTICS_NEIGHBORS}>;
  var neighborCount = 0u; var flags = 0u;
  let outputBase = (atom - config.startAtom) * ${BOND_STATISTICS_ATOM_WORDS}u;
`,
  candidateVisit: `
  let pairCutoff = selectedCutoff(types[atom], types[other]);
  if (pairCutoff > 0.0 && (abs(distanceSquared - pairCutoff * pairCutoff) <= config.distanceTolerance
      || distanceSquared <= 8e-24)) { flags |= ${BOND_STATISTICS_FLAG_PRECISION}u; }
`,
  visit: `
  if (pairCutoff > 0.0 && distanceSquared <= pairCutoff * pairCutoff && distanceSquared > 1e-24) {
    if (neighborCount >= ${MAX_GPU_BOND_STATISTICS_NEIGHBORS}u) {
      atomData[outputBase + 3u] = ${BOND_STATISTICS_FLAG_NEIGHBORS}u; return;
    }
    neighborVectors[neighborCount] = vector;
    neighborIds[neighborCount] = other;
    neighborShifts[neighborCount] = vec3i(-imageA, -imageB, -imageC);
    neighborCount++;
  }
`,
  finish: `
  atomData[outputBase] = neighborCount; atomData[outputBase + 3u] = flags;
  if (flags != 0u) { return; }
  let lengthBins = settings[1]; let angleBins = settings[2];
  let lengthMinimum = bitcast<f32>(settings[6]); let lengthMaximum = bitcast<f32>(settings[7]);
  let lengthExtent = lengthMaximum - lengthMinimum;
  var lengthMoment = emptyMoment(); var angleMoment = emptyMoment();
  var q4Sum = f32(neighborCount); var q6Sum = f32(neighborCount);
  for (var first = 0u; first < neighborCount; first++) {
    let firstVector = neighborVectors[first]; let firstLength = length(firstVector);
    if (neighborIds[first] > atom || (neighborIds[first] == atom && positiveImage(neighborShifts[first]))) {
      let shell = (firstLength - lengthMinimum) / lengthExtent * f32(lengthBins);
      let distanceMargin = config.distanceTolerance / max(firstLength, 1e-12) + firstLength * 0.000002;
      let margin = distanceMargin / lengthExtent * f32(lengthBins);
      if (abs(firstLength - lengthMinimum) <= distanceMargin || abs(firstLength - lengthMaximum) <= distanceMargin
          || shellIsAmbiguous(shell, lengthBins, margin)) {
        recordCorrection(0u, atom, neighborIds[first], 0u, neighborShifts[first], vec3i(0));
      } else {
        if (firstLength >= lengthMinimum && firstLength <= lengthMaximum) {
          let bin = min(lengthBins - 1u, u32(max(0.0, floor(shell)))); atomicAdd(&histogram[bin], 1u);
        }
        lengthMoment = addSample(lengthMoment, firstLength);
      }
    }
    for (var second = first + 1u; second < neighborCount; second++) {
      let secondVector = neighborVectors[second];
      let cosine = clamp(dot(firstVector, secondVector) / (firstLength * length(secondVector)), -1.0, 1.0);
      let squared = cosine * cosine; let fourth = squared * squared; let sixth = fourth * squared;
      q4Sum += (35.0 * fourth - 30.0 * squared + 3.0) * 0.25;
      q6Sum += (231.0 * sixth - 315.0 * fourth + 105.0 * squared - 5.0) * 0.125;
      let angle = preciseAngle(cosine);
      let shell = angle / 180.0 * f32(angleBins);
      // Angle conversion is least conditioned near +/-1; those endpoints belong to the
      // first/last bins regardless. Interior shell ties get exact f64 bins.
      let margin = f32(angleBins) * 0.000004 / max(sqrt(max(0.0, 1.0 - squared)), 0.001);
      if (abs(cosine) >= 0.999999 || shellIsAmbiguous(shell, angleBins, margin)) {
        recordCorrection(1u, atom, neighborIds[first], neighborIds[second], neighborShifts[first], neighborShifts[second]);
      } else {
        let bin = min(angleBins - 1u, u32(max(0.0, floor(shell))));
        atomicAdd(&histogram[lengthBins + bin], 1u); angleMoment = addSample(angleMoment, angle);
      }
    }
  }
  let denominator = f32(neighborCount) * f32(neighborCount);
  atomData[outputBase + 1u] = select(0x7fc00000u, bitcast<u32>(sqrt(clamp(q4Sum / max(1.0, denominator), 0.0, 1.0))), neighborCount > 0u);
  atomData[outputBase + 2u] = select(0x7fc00000u, bitcast<u32>(sqrt(clamp(q6Sum / max(1.0, denominator), 0.0, 1.0))), neighborCount > 0u);
  writeMoment(outputBase + 4u, lengthMoment); writeMoment(outputBase + 9u, angleMoment);
`,
});
