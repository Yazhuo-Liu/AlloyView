// Lattice disorientation under crystal symmetry, for grain segmentation.
//
// A JavaScript port of the quaternion helpers of the Polyhedral Template
// Matching library (third_party/ptm/ptm_quat.cpp and ptm_map_templates.cpp,
// Copyright (c) 2022 PM Larsen, MIT license; see licenses/PTM-MIT.txt) and of
// PTMAlgorithm::calculate_disorientation and
// PTMAlgorithm::calculate_interfacial_disorientation of OVITO 3.9.4
// (PTMAlgorithm.h under third_party/grains/upstream, used under its MIT option;
// see licenses/GrainSegmentation-MIT.txt).
// Every expression keeps the upstream operand order, so results agree with
// the C++ code to the last bit wherever the math library does.
//
// Quaternions are (w, x, y, z), stored in arrays at an offset. Structure
// types are PTM's: 1 FCC, 2 HCP, 3 BCC, 4 ICO, 5 SC, 6 cubic diamond,
// 7 hexagonal diamond, 8 graphene.

const HALF_SQRT2 = Math.sqrt(2) / 2, HALF_SQRT3 = Math.sqrt(3) / 2;

/** The 24 proper rotations of a cubic lattice (ptm::generator_cubic). */
export const GENERATOR_CUBIC = Float64Array.from([
  1, 0, 0, 0,
  HALF_SQRT2, HALF_SQRT2, 0, 0,
  HALF_SQRT2, 0, HALF_SQRT2, 0,
  HALF_SQRT2, 0, 0, HALF_SQRT2,
  HALF_SQRT2, 0, 0, -HALF_SQRT2,
  HALF_SQRT2, 0, -HALF_SQRT2, 0,
  HALF_SQRT2, -HALF_SQRT2, 0, 0,
  .5, .5, .5, .5,
  .5, .5, .5, -.5,
  .5, .5, -.5, .5,
  .5, .5, -.5, -.5,
  .5, -.5, .5, .5,
  .5, -.5, .5, -.5,
  .5, -.5, -.5, .5,
  .5, -.5, -.5, -.5,
  0, 1, 0, 0,
  0, HALF_SQRT2, HALF_SQRT2, 0,
  0, HALF_SQRT2, 0, HALF_SQRT2,
  0, HALF_SQRT2, 0, -HALF_SQRT2,
  0, HALF_SQRT2, -HALF_SQRT2, 0,
  0, 0, 1, 0,
  0, 0, HALF_SQRT2, HALF_SQRT2,
  0, 0, HALF_SQRT2, -HALF_SQRT2,
  0, 0, 0, 1,
]);

/** The 12 proper rotations of a hexagonal lattice (ptm::generator_hcp_conventional). */
export const GENERATOR_HEXAGONAL = Float64Array.from([
  1, 0, 0, 0,
  HALF_SQRT3, 0, 0, .5,
  HALF_SQRT3, 0, 0, -.5,
  .5, 0, 0, HALF_SQRT3,
  .5, 0, 0, -HALF_SQRT3,
  0, 1, 0, 0,
  0, HALF_SQRT3, .5, 0,
  0, HALF_SQRT3, -.5, 0,
  0, .5, HALF_SQRT3, 0,
  0, .5, -HALF_SQRT3, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

const sqrt = Math.sqrt;
// The two rotations between the HCP and FCC templates of a coherent
// interface (map_hcp_to_fcc and map_fcc_to_hcp in ptm_quat.cpp).
const MAP_HCP_TO_FCC = Float64Array.from([
  +sqrt(-sqrt(6) / 3 - sqrt(2) / 2 + sqrt(3) / 3 + 1) / 2,
  +sqrt(-sqrt(2) / 2 - sqrt(3) / 3 + sqrt(6) / 3 + 1) / 2,
  +sqrt(-sqrt(6) / 3 - sqrt(3) / 3 + sqrt(2) / 2 + 1) / 2,
  +sqrt(+sqrt(3) / 3 + sqrt(2) / 2 + sqrt(6) / 3 + 1) / 2,

  +sqrt(-sqrt(3) / 3 + sqrt(6) / 6 + 1) / 2,
  -sqrt(-sqrt(6) / 6 + sqrt(3) / 3 + 1) / 2,
  +sqrt(+sqrt(6) / 6 + sqrt(3) / 3 + 1) / 2,
  -sqrt(-sqrt(3) / 3 - sqrt(6) / 6 + 1) / 2,
]);
const MAP_FCC_TO_HCP = Float64Array.from(MAP_HCP_TO_FCC, (value, index) => index % 4 === 0 ? -value : value);

export const RADIANS_TO_DEGREES = 180 / Math.PI;
/** std::numeric_limits<double>::max(): bonds between incompatible structures. */
export const NO_DISORIENTATION = Number.MAX_VALUE;

const CUBIC = 1, HEXAGONAL = 2;
const FAMILY = Uint8Array.from([0, CUBIC, HEXAGONAL, CUBIC, 0, CUBIC, CUBIC, HEXAGONAL, HEXAGONAL]);
/** 'cubic', 'hexagonal', or null for unmatched and icosahedral environments. */
export function symmetryFamily(structure) {
  const family = FAMILY[structure];
  return family === CUBIC ? 'cubic' : family === HEXAGONAL ? 'hexagonal' : null;
}

// Scratch quaternions; every exported function is synchronous.
const product = new Float64Array(4), relative = new Float64Array(4), candidate = new Float64Array(4);
const adjusted = new Float64Array(4), closest = new Float64Array(4);

/** b = r ⊗ a (ptm::quat_rot). `b` must not alias `r` or `a`. */
export function quaternionProduct(r, ro, a, ao, b, bo) {
  b[bo] = (r[ro] * a[ao] - r[ro + 1] * a[ao + 1] - r[ro + 2] * a[ao + 2] - r[ro + 3] * a[ao + 3]);
  b[bo + 1] = (r[ro] * a[ao + 1] + r[ro + 1] * a[ao] + r[ro + 2] * a[ao + 3] - r[ro + 3] * a[ao + 2]);
  b[bo + 2] = (r[ro] * a[ao + 2] - r[ro + 1] * a[ao + 3] + r[ro + 2] * a[ao] + r[ro + 3] * a[ao + 1]);
  b[bo + 3] = (r[ro] * a[ao + 3] + r[ro + 1] * a[ao + 2] - r[ro + 2] * a[ao + 1] + r[ro + 3] * a[ao]);
}

/** q ← q ⊗ g with w ≥ 0 (rotate_and_flip in ptm_quat.cpp). */
function rotateAndFlip(q, qo, generator, index) {
  quaternionProduct(q, qo, generator, index * 4, product, 0);
  const sign = product[0] < 0 ? -1 : 1;
  q[qo] = sign * product[0]; q[qo + 1] = sign * product[1]; q[qo + 2] = sign * product[2]; q[qo + 3] = sign * product[3];
}

/** Replace q by its symmetry equivalent q ⊗ g with the largest |w|, the first
 * such g on ties, and return the index of g. A null or non-finite quaternion
 * has no such operation: it is left unchanged and −1 is returned, where the
 * C++ code would read outside its table. */
export function rotateIntoFundamentalZone(generator, q, qo = 0) {
  const q0 = q[qo], q1 = q[qo + 1], q2 = q[qo + 2], q3 = q[qo + 3];
  let max = 0, best = -1;
  for (let i = 0, g = 0; g < generator.length; i += 1, g += 4) {
    const t = Math.abs(q0 * generator[g] - q1 * generator[g + 1] - q2 * generator[g + 2] - q3 * generator[g + 3]);
    if (t > max) { max = t; best = i; }
  }
  if (best < 0) return -1;
  rotateAndFlip(q, qo, generator, best);
  return best;
}

const clamp = t => { const lower = -1 < t ? t : -1; return lower < 1 ? lower : 1; };

function disorientation(generator, a, ao, b, bo) {
  candidate[0] = a[ao]; candidate[1] = -a[ao + 1]; candidate[2] = -a[ao + 2]; candidate[3] = -a[ao + 3];
  quaternionProduct(candidate, 0, b, bo, relative, 0);
  rotateIntoFundamentalZone(generator, relative, 0);
  const t = clamp(relative[0]);
  return Math.acos(2 * t * t - 1);
}

/** Smallest rotation angle, in radians, between two orientations of a cubic lattice. */
export function disorientationCubic(a, ao, b, bo) { return disorientation(GENERATOR_CUBIC, a, ao, b, bo); }
/** Smallest rotation angle, in radians, between two orientations of a hexagonal lattice. */
export function disorientationHexagonal(a, ao, b, bo) { return disorientation(GENERATOR_HEXAGONAL, a, ao, b, bo); }

/** Disorientation in degrees of two atoms of the same structure type, or
 * NO_DISORIENTATION for different types and for types without a lattice
 * (PTMAlgorithm::calculate_disorientation). */
export function latticeDisorientation(structureA, structureB, a, ao, b, bo) {
  if (structureA !== structureB) return NO_DISORIENTATION;
  const family = FAMILY[structureA];
  if (family === CUBIC) return disorientationCubic(a, ao, b, bo) * RADIANS_TO_DEGREES;
  if (family === HEXAGONAL) return disorientationHexagonal(a, ao, b, bo) * RADIANS_TO_DEGREES;
  return NO_DISORIENTATION;
}

/** Disorientation in degrees across a coherent cubic/hexagonal interface
 * (FCC–HCP stacking, or cubic–hexagonal diamond) between a parent-phase atom
 * and a defect-phase atom. `output` receives the defect atom's orientation
 * expressed as the equivalent parent-phase orientation closest to the parent
 * (PTMAlgorithm::calculate_interfacial_disorientation). */
export function interfacialDisorientation(parentIsCubic, parent, po, defect, dfo, output, oo = 0) {
  let minimum = Infinity;
  if (parentIsCubic) {
    // ptm::quat_disorientation_hexagonal_to_cubic
    for (let i = 0; i < 2; i += 1) {
      quaternionProduct(defect, dfo, MAP_HCP_TO_FCC, i * 4, adjusted, 0);
      const angle = disorientationCubic(parent, po, adjusted, 0);
      if (angle < minimum) { closest.set(adjusted); minimum = angle; }
    }
    if (minimum === Infinity) return Infinity;
    for (let k = 0; k < 4; k += 1) output[oo + k] = closest[k];
    rotateIntoFundamentalZone(GENERATOR_CUBIC, output, oo);
  } else {
    // ptm::quat_disorientation_cubic_to_hexagonal
    for (let j = 0; j < 24; j += 1) {
      quaternionProduct(defect, dfo, GENERATOR_CUBIC, j * 4, adjusted, 0);
      for (let i = 0; i < 2; i += 1) {
        quaternionProduct(adjusted, 0, MAP_FCC_TO_HCP, i * 4, product, 0);
        // `product` is reused by the fundamental-zone step, so keep a copy.
        const r0 = product[0], r1 = product[1], r2 = product[2], r3 = product[3];
        candidate[0] = parent[po]; candidate[1] = -parent[po + 1]; candidate[2] = -parent[po + 2]; candidate[3] = -parent[po + 3];
        relative[0] = candidate[0] * r0 - candidate[1] * r1 - candidate[2] * r2 - candidate[3] * r3;
        relative[1] = candidate[0] * r1 + candidate[1] * r0 + candidate[2] * r3 - candidate[3] * r2;
        relative[2] = candidate[0] * r2 - candidate[1] * r3 + candidate[2] * r0 + candidate[3] * r1;
        relative[3] = candidate[0] * r3 + candidate[1] * r2 - candidate[2] * r1 + candidate[3] * r0;
        rotateIntoFundamentalZone(GENERATOR_HEXAGONAL, relative, 0);
        const t = clamp(relative[0]), angle = Math.acos(2 * t * t - 1);
        if (angle < minimum) { closest[0] = r0; closest[1] = r1; closest[2] = r2; closest[3] = r3; minimum = angle; }
      }
    }
    if (minimum === Infinity) return Infinity;
    for (let k = 0; k < 4; k += 1) output[oo + k] = closest[k];
    rotateIntoFundamentalZone(GENERATOR_HEXAGONAL, output, oo);
  }
  return minimum * RADIANS_TO_DEGREES;
}

/** Replace q by its symmetry equivalent closest to `target` and return their
 * misorientation in radians, or Infinity for a structure without a lattice
 * (ptm_map_and_calculate_disorientation, with OVITO's grain segmentation
 * passing no lattice for icosahedral atoms). Both must be unit quaternions. */
export function mapOntoTarget(structure, target, to, q, qo) {
  const family = FAMILY[structure];
  if (!family) return Infinity;
  const generator = family === CUBIC ? GENERATOR_CUBIC : GENERATOR_HEXAGONAL;
  candidate[0] = -target[to]; candidate[1] = target[to + 1]; candidate[2] = target[to + 2]; candidate[3] = target[to + 3];
  quaternionProduct(candidate, 0, q, qo, relative, 0);
  const best = rotateIntoFundamentalZone(generator, relative, 0);
  if (best < 0) return Infinity;
  rotateAndFlip(q, qo, generator, best);
  const t = clamp(q[qo] * target[to] + q[qo + 1] * target[to + 1] + q[qo + 2] * target[to + 2] + q[qo + 3] * target[to + 3]);
  return Math.acos(2 * t * t - 1);
}
