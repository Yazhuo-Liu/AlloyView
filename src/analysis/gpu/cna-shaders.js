import { makeNeighborShader } from './neighbors.js';

export const CNA_RESULT_WORDS = 4;
export const CNA_FLAG_PRECISION = 1;
export const CNA_FLAG_BUDGET = 2;
export const CNA_FLAG_CP_GRAPH = 4;
export const CNA_FLAG_BCC_GRAPH = 8;
export const CNA_FLAG_SHELL12 = 16;
export const CNA_FLAG_SHELL14 = 32;
export const CNA_MAX_CANDIDATES = 50_000;

// A central atom has at most fourteen participants in a supported CNA graph.
// Bit masks keep the common-neighbor graph and its connected components local
// to one invocation; bonds compare explicit local image vectors without PBC.
const CLASSIFIER = `
struct CnaResult { structure: u32, flags: u32, resolved: u32, neighbors: u32 };
@group(0) @binding(5) var<storage, read_write> results: array<CnaResult>;
@group(0) @binding(6) var<storage, read> settings: array<u32>;
fn cnaClassify(vectors: ptr<function, array<vec3f, 15>>, count: u32, radius: f32, tolerance: f32) -> vec2u {
  if (count != 12u && count != 14u) { return vec2u(0u); }
  let radius2 = radius * radius;
  // Adaptive graph radii may exceed the finite search sphere, or tiny local
  // shells may underflow even when the global query is representable.
  if (radius <= 0.0 || radius2 <= 0.0 || radius2 + tolerance > 3.402823e38f) { return vec2u(0u, 1u); }
  var bonds: array<u32, 14>;
  var uncertain = 0u;
  for (var i = 0u; i < count; i++) {
    for (var j = i + 1u; j < count; j++) {
      let delta = (*vectors)[i] - (*vectors)[j];
      let squared = dot(delta, delta);
      if (abs(squared - radius2) <= tolerance) { uncertain = 1u; }
      if (squared <= radius2) { bonds[i] |= 1u << j; bonds[j] |= 1u << i; }
    }
  }
  var signature421 = 0u; var signature422 = 0u; var signature555 = 0u;
  var signature666 = 0u; var signature444 = 0u;
  for (var i = 0u; i < count; i++) {
    let shellMask = bonds[i]; let commonCount = countOneBits(shellMask);
    if ((count == 12u && commonCount != 4u && commonCount != 5u)
        || (count == 14u && commonCount != 4u && commonCount != 6u)) { return vec2u(0u, uncertain); }
    var bondCount = 0u; var longestChain = 0u; var remaining = shellMask;
    while (remaining != 0u) {
      var frontier = remaining & (~remaining + 1u); var visited = 0u; var componentBonds = 0u;
      while (frontier != 0u) {
        let bit = frontier & (~frontier + 1u); let node = firstTrailingBit(bit);
        frontier &= ~bit; visited |= bit;
        let adjacent = bonds[node] & shellMask;
        componentBonds += countOneBits(adjacent); frontier |= adjacent & ~visited;
      }
      remaining &= ~visited; componentBonds /= 2u;
      bondCount += componentBonds; longestChain = max(longestChain, componentBonds);
    }
    if (commonCount == 4u && bondCount == 2u && longestChain == 1u) { signature421++; }
    if (commonCount == 4u && bondCount == 2u && longestChain == 2u) { signature422++; }
    if (commonCount == 5u && bondCount == 5u && longestChain == 5u) { signature555++; }
    if (commonCount == 6u && bondCount == 6u && longestChain == 6u) { signature666++; }
    if (commonCount == 4u && bondCount == 4u && longestChain == 4u) { signature444++; }
  }
  var structure = 0u;
  if (count == 12u) {
    if (signature421 == 12u) { structure = 1u; }
    else if (signature421 == 6u && signature422 == 6u) { structure = 2u; }
    else if (signature555 == 12u) { structure = 4u; }
  } else if (signature666 == 8u && signature444 == 6u) { structure = 3u; }
  return vec2u(structure, uncertain);
}
fn cnaBefore(squared: f32, id: u32, vector: vec3f, oldSquared: f32, oldId: u32, old: vec3f) -> bool {
  if (squared != oldSquared) { return squared < oldSquared; }
  if (id != oldId) { return id < oldId; }
  if (vector.x != old.x) { return vector.x < old.x; }
  if (vector.y != old.y) { return vector.y < old.y; }
  return vector.z < old.z;
}
`;

export const CNA_FIXED_SHADER = makeNeighborShader({
  mode: 'images', declarations: CLASSIFIER,
  initialize: `
    var vectors: array<vec3f, 15>; var participants = 0u; var uncertain = 0u; var candidates = 0u;
  `,
  candidateVisit: `
    candidates++;
    if (candidates > ${CNA_MAX_CANDIDATES}u) { results[atom] = CnaResult(0u, 2u, 1u, participants); return; }
    if (abs(distanceSquared - config.cutoff2) <= config.distanceTolerance) { uncertain = 1u; }
  `,
  visit: `
    if (participants < 15u) { vectors[participants] = vector; participants++; }
  `,
  finish: `
    let classified = cnaClassify(&vectors, participants, sqrt(config.cutoff2), config.distanceTolerance * 4.0);
    results[atom] = CnaResult(classified.x, uncertain | classified.y, 1u, participants);
  `,
});

export const CNA_ADAPTIVE_SHADER = makeNeighborShader({
  mode: 'images', declarations: CLASSIFIER,
  initialize: `
    if (results[atom].resolved != 0u) { return; }
    var vectors: array<vec3f, 15>; var distances: array<f32, 15>; var ids: array<u32, 15>;
    var kept = 0u; var candidates = 0u;
  `,
  candidateVisit: `
    candidates++;
    if (candidates > ${CNA_MAX_CANDIDATES}u) { results[atom] = CnaResult(0u, 2u, 1u, kept); return; }
  `,
  visit: `
    var insertion = kept;
    for (var index = 0u; index < kept; index++) {
      if (cnaBefore(distanceSquared, other, vector, distances[index], ids[index], vectors[index])) { insertion = index; break; }
    }
    if (insertion < 15u) {
      var index = min(kept, 14u);
      while (index > insertion) { distances[index] = distances[index - 1u]; ids[index] = ids[index - 1u]; vectors[index] = vectors[index - 1u]; index--; }
      distances[insertion] = distanceSquared; ids[insertion] = other; vectors[insertion] = vector; kept = min(kept + 1u, 15u);
    }
  `,
  finish: `
    let needed = settings[0];
    // A shell touching the search sphere is retried at the next GPU radius.
    // This excludes a rounded query boundary from nearest-shell membership.
    if (kept < needed || (needed > 0u && distances[needed - 1u] > config.cutoff2 - config.distanceTolerance)) {
      results[atom] = CnaResult(0u, 0u, 0u, kept); return;
    }
    if (needed < 12u) { results[atom] = CnaResult(0u, 0u, 1u, kept); return; }
    var closePackedRadius = 0.0;
    for (var index = 0u; index < 12u; index++) { closePackedRadius += sqrt(distances[index]); }
    closePackedRadius *= 0.10059223176554562; // (1 + sqrt(2)) / 24
    var classified = cnaClassify(&vectors, 12u, closePackedRadius, config.distanceTolerance * 4.0);
    var uncertain = classified.y;
    var reasons = select(0u, ${CNA_FLAG_CP_GRAPH}u, classified.y != 0u);
    var closePackedTie = 0u;
    if (kept > 12u && distances[12u] - distances[11u] <= config.distanceTolerance * 2.0) { closePackedTie = 1u; }
    if (classified.x == 0u && needed == 14u) {
      var bccRadius = 0.0;
      for (var index = 0u; index < 14u; index++) {
        var weight = 1.0; if (index < 8u) { weight = 1.1547005383792515; }
        bccRadius += sqrt(distances[index]) * weight;
      }
      bccRadius *= 0.08622191294189625; // (1 + sqrt(2)) / 28
      let bcc = cnaClassify(&vectors, 14u, bccRadius, config.distanceTolerance * 4.0);
      classified.x = bcc.x; uncertain |= bcc.y;
      if (bcc.y != 0u) { reasons |= ${CNA_FLAG_BCC_GRAPH}u; }
      // Certify that choosing four tied outer neighbors cannot recognize a
      // different close-packed graph. All eight degree-six inner vertices are
      // retained and the four degree-four outer vertices rule out ICO. Their
      // sixteen inner/outer edges make the inner average degree five, ruling
      // out the degree-four FCC/HCP signatures. This argument requires the
      // graph to be identical at both radii, including unselected vertices.
      if (closePackedTie != 0u && bcc.x == 3u && bcc.y == 0u
          && distances[8u] - distances[7u] > config.distanceTolerance * 2.0) {
        var safeOuterTie = true; var degree: array<u32, 14>;
        for (var i = 0u; i < 14u; i++) {
          for (var j = i + 1u; j < 14u; j++) {
            let delta = vectors[i] - vectors[j]; let squared = dot(delta, delta);
            let cpEdge = squared <= closePackedRadius * closePackedRadius;
            let bccEdge = squared <= bccRadius * bccRadius;
            if (cpEdge != bccEdge || abs(squared - closePackedRadius * closePackedRadius) <= config.distanceTolerance * 4.0) { safeOuterTie = false; }
            if (bccEdge) {
              degree[i]++; degree[j]++;
              if (i >= 8u && j >= 8u) { safeOuterTie = false; }
            }
          }
        }
        for (var i = 0u; i < 14u; i++) {
          if (degree[i] != select(4u, 6u, i < 8u)) { safeOuterTie = false; }
        }
        if (safeOuterTie) { closePackedTie = 0u; }
      }
      if (kept > 14u && distances[14u] - distances[13u] <= config.distanceTolerance * 2.0) { uncertain = 1u; reasons |= ${CNA_FLAG_SHELL14}u; }
    }
    if (closePackedTie != 0u) { reasons |= ${CNA_FLAG_SHELL12}u; }
    results[atom] = CnaResult(classified.x, uncertain | closePackedTie | reasons, 1u, kept);
  `,
});
