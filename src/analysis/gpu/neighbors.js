/** Shared WGSL linked-cell traversal. Each invocation owns one central atom;
 * atom images remain explicit so triclinic cells and thin periodic boxes use
 * the same geometry as the CPU kernels. */
export const NEIGHBOR_BINDINGS_WGSL = `
struct NeighborConfig {
  count: u32, dimX: u32, dimY: u32, dimZ: u32,
  cellA: vec4f, cellB: vec4f, cellC: vec4f,
  pbc: vec4u, heights: vec4f,
  cutoff2: f32, distanceTolerance: f32, startAtom: u32, endAtom: u32,
  padding: vec4u,
};
@group(0) @binding(0) var<uniform> config: NeighborConfig;
@group(0) @binding(1) var<storage, read> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> heads: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read> next: array<i32>;
@group(0) @binding(4) var<storage, read> types: array<u32>;
fn neighborBin(value: i32, dimension: u32, periodic: u32) -> i32 {
  let d = i32(dimension);
  if (periodic != 0u) { return ((value % d) + d) % d; }
  if (value < 0 || value >= d) { return -1; }
  return value;
}
fn flattenBin(value: vec3i) -> u32 {
  return (u32(value.x) * config.dimY + u32(value.y)) * config.dimZ + u32(value.z);
}
fn positionBin(value: vec3f) -> vec3i {
  let dimensions = vec3u(config.dimX, config.dimY, config.dimZ);
  return vec3i(min(dimensions - vec3u(1u), vec3u(clamp(value, vec3f(0.0), vec3f(1.0)) * vec3f(dimensions))));
}
fn toCartesian(value: vec3f) -> vec3f {
  return value.x * config.cellA.xyz + value.y * config.cellB.xyz + value.z * config.cellC.xyz;
}
fn fractionalHigh(atom: u32) -> vec3f { return positions[atom * 2u].xyz; }
// Error-free subtraction plus a low residual retains the source coordinate
// precision in large cells without requiring unsupported shader f64.
fn deltaResidual(other: u32, atom: u32, highDelta: vec3f) -> vec3f {
  let first = fractionalHigh(other); let second = fractionalHigh(atom);
  let recoveredSecond = first - highDelta;
  let subtractionError = (first - (highDelta + recoveredSecond)) + (recoveredSecond - second);
  return subtractionError + positions[other * 2u + 1u].xyz - positions[atom * 2u + 1u].xyz;
}
`;

export function makeNeighborShader({ declarations = '', initialize = '', candidateVisit = '', visit = '', finish = '', mode = 'nearest' } = {}) {
  if (!['nearest', 'images'].includes(mode)) throw new Error('Unknown GPU neighbor traversal mode.');
  const imageVisit = mode === 'images' ? `
            if (other != atom || imageA != 0 || imageB != 0 || imageC != 0) {
              let vector = toCartesian((delta - vec3f(f32(imageA), f32(imageB), f32(imageC))) + lowDelta);
              let distanceSquared = dot(vector, vector);
              ${candidateVisit}
              if (distanceSquared <= config.cutoff2) { ${visit} }
            }` : `
            let candidateVector = toCartesian((delta - vec3f(f32(imageA), f32(imageB), f32(imageC))) + lowDelta);
            let candidateSquared = dot(candidateVector, candidateVector);
            if (candidateSquared < closestSquared) { closestSquared = candidateSquared; closestVector = candidateVector; }`;
  return `${NEIGHBOR_BINDINGS_WGSL}
${declarations}
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let atom = gid.x + config.startAtom;
  if (atom >= config.endAtom || atom >= config.count) { return; }
  ${initialize}
  let centerBin = positionBin(fractionalHigh(atom));
  var visitedBins: array<u32, 27>;
  var visitedCount = 0u;
  for (var dx = -1; dx <= 1; dx++) {
    let x = neighborBin(centerBin.x + dx, config.dimX, config.pbc.x);
    if (x < 0) { continue; }
    for (var dy = -1; dy <= 1; dy++) {
      let y = neighborBin(centerBin.y + dy, config.dimY, config.pbc.y);
      if (y < 0) { continue; }
      for (var dz = -1; dz <= 1; dz++) {
        let z = neighborBin(centerBin.z + dz, config.dimZ, config.pbc.z);
        if (z < 0) { continue; }
        let bin = flattenBin(vec3i(x, y, z));
        var duplicate = false;
        for (var seen = 0u; seen < visitedCount; seen++) { if (visitedBins[seen] == bin) { duplicate = true; break; } }
        if (duplicate) { continue; }
        visitedBins[visitedCount] = bin; visitedCount++;
        for (var linked = atomicLoad(&heads[bin]); linked >= 0; linked = next[u32(linked)]) {
          let other = u32(linked);
          ${mode === 'nearest' ? 'if (other == atom) { continue; }' : ''}
          let delta = fractionalHigh(other) - fractionalHigh(atom);
          let lowDelta = deltaResidual(other, atom, delta);
          let bound = sqrt(config.cutoff2 + config.distanceTolerance) / config.heights.xyz + vec3f(1e-6);
          var minimum = vec3i(0); var maximum = vec3i(0);
          if (config.pbc.x != 0u) { minimum.x = i32(ceil(delta.x - bound.x)); maximum.x = i32(floor(delta.x + bound.x)); }
          if (config.pbc.y != 0u) { minimum.y = i32(ceil(delta.y - bound.y)); maximum.y = i32(floor(delta.y + bound.y)); }
          if (config.pbc.z != 0u) { minimum.z = i32(ceil(delta.z - bound.z)); maximum.z = i32(floor(delta.z + bound.z)); }
          var closestSquared = 3.402823e38f; var closestVector = vec3f(0.0);
          for (var imageA = minimum.x; imageA <= maximum.x; imageA++) {
            for (var imageB = minimum.y; imageB <= maximum.y; imageB++) {
              for (var imageC = minimum.z; imageC <= maximum.z; imageC++) { ${imageVisit} }
            }
          }
          ${mode === 'nearest' ? `let vector = closestVector; let distanceSquared = closestSquared;
          ${visit}` : ''}
        }
      }
    }
  }
  ${finish}
}`;
}
