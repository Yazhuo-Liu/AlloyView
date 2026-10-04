import { makeNeighborShader } from './neighbors.js';

export const SHEAR_WORKGROUP_SIZE = 128;

export function makeShearCoordinationShader() {
  return makeNeighborShader({
    mode: 'images',
    declarations: `@group(0) @binding(5) var<storage, read_write> coordination: array<u32>;
@group(0) @binding(6) var<storage, read_write> correctionFlags: array<u32>;`,
    initialize: 'var neighborCount = 0u; var uncertainCutoff = false;',
    candidateVisit: 'if (abs(distanceSquared - config.cutoff2) <= config.distanceTolerance) { uncertainCutoff = true; }',
    visit: 'neighborCount += 1u;',
    finish: 'coordination[atom] = neighborCount; correctionFlags[atom] = select(0u, 1u, uncertainCutoff);',
  });
}

/** Only the modal number of nearest neighbors contributes to AtomEye's tensor.
 * Keeping that many sorted candidates avoids an arbitrary neighborhood cap.
 */
export function makeShearMetricsShader(mode) {
  if (!Number.isInteger(mode) || mode < 1 || mode > 64) throw new Error('Invalid GPU geometric shear coordination.');
  return makeNeighborShader({
    mode: 'images',
    declarations: `
@group(0) @binding(5) var<storage, read_write> metrics: array<f32>;
@group(0) @binding(6) var<storage, read_write> normalizationSums: array<f32>;
@group(0) @binding(7) var<storage, read_write> normalizationCounts: array<u32>;
@group(0) @binding(8) var<storage, read_write> correctionFlags: array<u32>;
fn shearBefore(distance: f32, id: u32, value: vec3f, previousDistance: f32, previousId: u32, previous: vec3f) -> bool {
  if (distance != previousDistance) { return distance < previousDistance; }
  if (id != previousId) { return id < previousId; }
  if (value.x != previous.x) { return value.x < previous.x; }
  if (value.y != previous.y) { return value.y < previous.y; }
  return value.z < previous.z;
}`,
    initialize: `
var kept = 0u;
var closestRejected = 3.402823e38f;
var distances: array<f32, ${mode}>;
var ids: array<u32, ${mode}>;
var vectors: array<vec3f, ${mode}>;`,
    visit: `
var insertion = kept;
for (var candidate = 0u; candidate < kept; candidate += 1u) {
  if (shearBefore(distanceSquared, other, vector, distances[candidate], ids[candidate], vectors[candidate])) {
    insertion = candidate;
    break;
  }
}
if (insertion < ${mode}u) {
  if (kept == ${mode}u) { closestRejected = min(closestRejected, distances[${mode - 1}]); }
  var destination = min(kept, ${mode - 1}u);
  loop {
    if (destination <= insertion) { break; }
    distances[destination] = distances[destination - 1u];
    ids[destination] = ids[destination - 1u];
    vectors[destination] = vectors[destination - 1u];
    destination -= 1u;
  }
  distances[insertion] = distanceSquared;
  ids[insertion] = other;
  vectors[insertion] = vector;
  kept = min(kept + 1u, ${mode}u);
} else { closestRejected = min(closestRejected, distanceSquared); }`,
    finish: `
var first = vec3f(0.0);
var second = vec3f(0.0);
var squaredSum = 0.0;
for (var candidate = 0u; candidate < kept; candidate += 1u) {
  let neighbor = vectors[candidate];
  first += vec3f(neighbor.x * neighbor.x, neighbor.x * neighbor.y, neighbor.x * neighbor.z);
  second += vec3f(neighbor.y * neighbor.y, neighbor.y * neighbor.z, neighbor.z * neighbor.z);
  squaredSum += distances[candidate];
}
if (kept > 0u) { first /= f32(kept); second /= f32(kept); }
let offset = atom * 6u;
metrics[offset] = first.x; metrics[offset + 1u] = first.y; metrics[offset + 2u] = first.z;
metrics[offset + 3u] = second.x; metrics[offset + 4u] = second.y; metrics[offset + 5u] = second.z;
normalizationSums[atom] = select(0.0, squaredSum, kept == ${mode}u);
normalizationCounts[atom] = select(0u, kept, kept == ${mode}u);
if (kept == ${mode}u && closestRejected <= distances[${mode - 1}] + config.distanceTolerance) {
  correctionFlags[atom] = 1u;
}`,
  });
}

/** A separate reduction keeps the six per-atom moments on the device. */
export const SHEAR_REDUCTION_SHADER = `
@group(0) @binding(0) var<storage, read> parameters: array<u32>;
@group(0) @binding(1) var<storage, read> metrics: array<f32>;
@group(0) @binding(2) var<storage, read> normalizationSums: array<f32>;
@group(0) @binding(3) var<storage, read> normalizationCounts: array<u32>;
@group(0) @binding(4) var<storage, read_write> partials: array<f32>;
var<workgroup> firstParts: array<vec4f, ${SHEAR_WORKGROUP_SIZE}>;
var<workgroup> secondParts: array<vec4f, ${SHEAR_WORKGROUP_SIZE}>;
@compute @workgroup_size(${SHEAR_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u, @builtin(local_invocation_id) localId: vec3u,
  @builtin(workgroup_id) groupId: vec3u) {
  let atom = globalId.x;
  let lane = localId.x;
  var first = vec4f(0.0);
  var second = vec4f(0.0);
  if (atom < parameters[0]) {
    let offset = atom * 6u;
    first = vec4f(metrics[offset], metrics[offset + 1u], metrics[offset + 2u], metrics[offset + 3u]);
    second = vec4f(metrics[offset + 4u], metrics[offset + 5u], normalizationSums[atom], f32(normalizationCounts[atom]));
  }
  firstParts[lane] = first;
  secondParts[lane] = second;
  workgroupBarrier();
  var stride = ${SHEAR_WORKGROUP_SIZE / 2}u;
  loop {
    if (stride == 0u) { break; }
    if (lane < stride) {
      firstParts[lane] += firstParts[lane + stride];
      secondParts[lane] += secondParts[lane + stride];
    }
    workgroupBarrier();
    stride /= 2u;
  }
  if (lane == 0u) {
    let offset = groupId.x * 8u;
    for (var component = 0u; component < 4u; component += 1u) {
      partials[offset + component] = firstParts[0][component];
      partials[offset + 4u + component] = secondParts[0][component];
    }
}
}`;

/** Double-precision sparse corrections are uploaded once, not one GPU write
 * per atom. Only uncertain cutoff/sorted-shell boundaries use this path.
 */
export const SHEAR_CORRECTION_SHADER = `
@group(0) @binding(0) var<storage, read> parameters: array<u32>;
@group(0) @binding(1) var<storage, read> atoms: array<u32>;
@group(0) @binding(2) var<storage, read> corrections: array<f32>;
@group(0) @binding(3) var<storage, read_write> metrics: array<f32>;
@group(0) @binding(4) var<storage, read_write> normalizationSums: array<f32>;
@group(0) @binding(5) var<storage, read_write> normalizationCounts: array<u32>;
@compute @workgroup_size(${SHEAR_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let item = gid.x;
  if (item >= parameters[0]) { return; }
  let atom = atoms[item];
  for (var component = 0u; component < 6u; component += 1u) {
    metrics[atom * 6u + component] = corrections[item * 8u + component];
  }
  normalizationSums[atom] = corrections[item * 8u + 6u];
  normalizationCounts[atom] = u32(corrections[item * 8u + 7u]);
}`;

export const SHEAR_FINALIZE_SHADER = `
@group(0) @binding(0) var<storage, read> parameters: array<u32>;
@group(0) @binding(1) var<storage, read> metrics: array<f32>;
@group(0) @binding(2) var<storage, read_write> localShear: array<f32>;
@compute @workgroup_size(${SHEAR_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let atom = globalId.x;
  if (atom >= parameters[0]) { return; }
  let normalization = bitcast<f32>(parameters[2]);
  if (!(normalization > 0.0)) {
    localShear[atom] = bitcast<f32>(parameters[3]);
    return;
  }
  var tensor: array<f32, 6>;
  for (var component = 0u; component < 6u; component += 1u) {
    tensor[component] = metrics[atom * 6u + component] / normalization;
    if (parameters[1] != 0u) { tensor[component] -= bitcast<f32>(parameters[4u + component]); }
  }
  let dx = tensor[0] - tensor[3];
  let dy = tensor[0] - tensor[5];
  let dz = tensor[3] - tensor[5];
  localShear[atom] = sqrt(tensor[1] * tensor[1] + tensor[2] * tensor[2] + tensor[4] * tensor[4]
    + (dx * dx + dy * dy + dz * dz) / 6.0) / 2.0;
}`;
