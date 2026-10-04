import { crystalFrame } from '../tests/helpers/crystals.js';
import { cartesianToFractional, createCell, fractionalToCartesian } from '../src/data/model.js';
import { createReferenceMapping } from '../src/analysis/reference-strain.js';

const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function copyArray(value) {
  return ArrayBuffer.isView(value) ? value.slice() : Array.from(value);
}

/** Independent arrays let precision/ordering tests modify a fixture without
 * changing another test's source frame or cached GPU input. */
export function cloneFrame(frame) {
  const output = { ...frame, cell: createCell(frame.cell), typeLabels: [...(frame.typeLabels ?? [])],
    properties: (frame.properties ?? []).map(property => ({ ...property, data: copyArray(property.data) })) };
  for (const name of ['ids', 'types', 'fractional', 'positions', 'unwrappedPositions', 'imageFlags']) {
    if (frame[name]) output[name] = copyArray(frame[name]);
  }
  return output;
}

/** Select or reorder rows, preserving explicit atom IDs and every per-atom
 * array. An omitted row represents a vacancy rather than an ID renumbering. */
export function reorderFrame(frame, order) {
  const indices = Array.from(order);
  const count = frame.ids.length;
  if (new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw new Error('Fixture order must contain unique valid atom indices.');
  }
  const output = cloneFrame(frame);
  const select = (values, stride) => {
    const selected = ArrayBuffer.isView(values) ? new values.constructor(indices.length * stride) : new Array(indices.length * stride);
    indices.forEach((source, target) => {
      for (let k = 0; k < stride; k += 1) selected[target * stride + k] = values[source * stride + k];
    });
    return selected;
  };
  for (const name of ['ids', 'types']) if (frame[name]) output[name] = select(frame[name], 1);
  for (const name of ['fractional', 'positions', 'unwrappedPositions', 'imageFlags']) {
    if (frame[name]) output[name] = select(frame[name], 3);
  }
  output.properties = (frame.properties ?? []).map(property => ({ ...property, data: select(property.data, 1) }));
  return output;
}

function transformVector(matrix, vector, translation = [0, 0, 0]) {
  return Array.from({ length: 3 }, (_, row) => translation[row]
    + matrix[row * 3] * vector[0] + matrix[row * 3 + 1] * vector[1] + matrix[row * 3 + 2] * vector[2]);
}

/** Apply x' = F x + t with a row-major F. The model stores cell vectors as
 * consecutive Cartesian a,b,c vectors, so each of those vectors is transformed
 * separately. An explicit origin only changes the coordinate representation.
 * transformCell:false keeps the original box for open-boundary stretch tests. */
export function transformFrame(frame, matrix = IDENTITY, {
  translation = [0, 0, 0], origin, fractionalShift = [0, 0, 0], transformCell = true,
} = {}) {
  if (matrix.length !== 9 || !Array.from(matrix).every(Number.isFinite)
      || [translation, fractionalShift, ...(origin ? [origin] : [])].some(vector => vector.length !== 3 || !Array.from(vector).every(Number.isFinite))) {
    throw new Error('Fixture transformations require finite 3D vectors and a 3×3 matrix.');
  }
  const output = cloneFrame(frame);
  const vectors = transformCell ? Array.from({ length: 3 }, (_, vector) => transformVector(matrix,
    frame.cell.vectors.subarray(vector * 3, vector * 3 + 3))).flat() : frame.cell.vectors;
  output.cell = createCell({ ...frame.cell, vectors,
    origin: origin ?? (transformCell ? transformVector(matrix, frame.cell.origin, translation) : frame.cell.origin),
    triclinic: frame.cell.triclinic || matrix.some((value, k) => k % 4 !== 0 && value !== 0) });
  if (transformCell && origin === undefined) {
    // Transforming the cell vectors and its origin with the same affine map
    // leaves fractional coordinates exactly unchanged. An inverse round-trip
    // can otherwise turn an open-boundary zero into a tiny negative value.
    output.fractional = Float64Array.from(frame.fractional);
  } else {
    // Reexpress physical positions only when the new origin or box differs
    // from the affine-transformed cell. Use canonical f64 geometry, not the
    // rounded Float32 drawing buffer.
    const source = fractionalToCartesian(frame.fractional, frame.cell, new Float64Array(frame.fractional.length));
    const positions = new Float64Array(source.length);
    for (let atom = 0; atom < frame.ids.length; atom += 1) positions.set(
      transformVector(matrix, source.subarray(atom * 3, atom * 3 + 3), translation), atom * 3);
    output.fractional = cartesianToFractional(positions, output.cell, new Float64Array(positions.length));
  }
  for (let k = 0; k < output.fractional.length; k += 1) output.fractional[k] += fractionalShift[k % 3];
  output.positions = fractionalToCartesian(output.fractional, output.cell, new Float64Array(output.fractional.length));
  if (frame.unwrappedPositions) {
    output.unwrappedPositions = new Float64Array(frame.unwrappedPositions.length);
    for (let atom = 0; atom < frame.ids.length; atom += 1) output.unwrappedPositions.set(
      transformVector(matrix, frame.unwrappedPositions.subarray(atom * 3, atom * 3 + 3), translation), atom * 3);
  }
  return output;
}

/** Cartesian point clouds in an open box, useful for incomplete shells and
 * singular local covariance without periodic images filling the missing rows. */
export function pointFrame(points, {
  cell = createCell({ vectors: [12, 0, 0, 0, 12, 0, 0, 0, 12], pbc: [false, false, false] }),
  ids, types, typeLabels = ['X'],
} = {}) {
  if (!Array.isArray(points) || points.some(point => point.length !== 3)) throw new Error('Fixture points must be finite 3D coordinates.');
  const positions = Float64Array.from(points.flat());
  const count = positions.length / 3;
  if (!Number.isInteger(count) || count < 1 || !positions.every(Number.isFinite)) throw new Error('Fixture points must be finite 3D coordinates.');
  if ((ids && ids.length !== count) || (types && types.length !== count)) throw new Error('Fixture IDs and types must match the point count.');
  return { positions, fractional: cartesianToFractional(positions, cell, new Float64Array(positions.length)),
    cell: createCell(cell), ids: ids ? copyArray(ids) : Uint32Array.from({ length: count }, (_, atom) => atom + 1),
    types: types ? copyArray(types) : new Uint16Array(count), typeLabels: [...typeLabels], properties: [], idSource: 'explicit' };
}

/** A central atom and exactly 12 icosahedral vertices. Its center is ICO even
 * though an open cluster cannot supply the adaptive algorithm's full 14 rows. */
export function icosahedralFrame({ radius = 2, cellSize = 12 } = {}) {
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(cellSize) || cellSize <= radius * 2) {
    throw new Error('The icosahedral fixture requires a positive radius inside its open cell.');
  }
  const phi = (1 + Math.sqrt(5)) / 2;
  const scale = radius / Math.hypot(1, phi);
  const center = cellSize / 2;
  const vertices = [];
  for (const first of [-1, 1]) for (const second of [-1, 1]) {
    vertices.push([0, first, second * phi], [first, second * phi, 0], [second * phi, 0, first]);
  }
  const points = [[center, center, center], ...vertices.map(vertex => vertex.map(value => center + value * scale))];
  return pointFrame(points, { cell: createCell({ vectors: [cellSize, 0, 0, 0, cellSize, 0, 0, 0, cellSize], pbc: [false, false, false] }) });
}

export function cnaFixtures() {
  const fixtures = [];
  const add = (label, frame, parameters = {}, expectations = {}) => fixtures.push({ label, frame,
    parameters: { kind: 'cna', mode: 'adaptive', ...parameters }, ...expectations });
  for (const [kind, lattice, structure, cutoff] of [['fcc', 3.52, 1, 3.1], ['bcc', 2.86, 3, 3.1], ['hcp', 2.5, 2, 2.7]]) {
    add(`Ideal ${kind.toUpperCase()}`, crystalFrame(kind, 2, lattice), {}, { expectedStructure: structure });
    add(`Primitive ${kind.toUpperCase()} repeated/self images`, crystalFrame(kind, 1, lattice), {}, { expectedStructure: structure });
    add(`Fixed ideal ${kind.toUpperCase()}`, crystalFrame(kind, 2, lattice), { mode: 'fixed', cutoff }, { expectedStructure: structure });
    add(`Fixed primitive ${kind.toUpperCase()} repeated/self images`, crystalFrame(kind, 1, lattice), { mode: 'fixed', cutoff }, { expectedStructure: structure });
  }
  // Exceed the 4096-environment precision-correction budget while keeping a
  // perfect BCC shell. Ordinary shell ties must remain a native GPU case.
  add('Large ideal BCC without precision fallback', crystalFrame('bcc', 13, 2.86), {}, { expectedStructure: 3 });
  const ico = icosahedralFrame();
  add('Open ICO with only twelve neighbors', ico, {}, { expectedCenter: 4 });
  add('Fixed-cutoff ICO', cloneFrame(ico), { mode: 'fixed', cutoff: 2.3 }, { expectedCenter: 4 });
  add('Incomplete eleven-neighbor shell', reorderFrame(ico, Array.from({ length: 12 }, (_, atom) => atom)), {}, { expectedCenter: 0 });
  const distorted = crystalFrame('fcc', 3, 3.52);
  for (let k = 0; k < distorted.fractional.length; k += 1) distorted.fractional[k] += .0003 * Math.sin(k * 1.7);
  distorted.positions = fractionalToCartesian(distorted.fractional, distorted.cell);
  add('Distorted FCC', distorted, {}, { expectedStructure: 1 });
  add('Fixed distorted FCC', cloneFrame(distorted), { mode: 'fixed', cutoff: 3.1 }, { expectedStructure: 1 });
  const vacancy = reorderFrame(crystalFrame('fcc', 2, 3.52), Array.from({ length: 31 }, (_, atom) => atom + 1));
  add('FCC vacancy', vacancy);
  add('Fixed FCC vacancy', cloneFrame(vacancy), { mode: 'fixed', cutoff: 3.1 });
  const mixed = crystalFrame('fcc', 3, 3.52);
  mixed.cell = createCell({ ...mixed.cell, pbc: [true, false, true] });
  add('FCC mixed periodic/open boundaries', mixed);
  add('Fixed FCC mixed periodic/open boundaries', cloneFrame(mixed), { mode: 'fixed', cutoff: 3.1 });
  const dense = crystalFrame('fcc', 2, 1);
  const sparse = pointFrame([[1, 1, 1], ...Array.from({ length: dense.ids.length }, (_, atom) =>
    Array.from(dense.positions.subarray(atom * 3, atom * 3 + 3), coordinate => coordinate + 15))], {
    cell: createCell({ vectors: [20, 0, 0, 0, 20, 0, 0, 0, 20], pbc: [false, false, false] }),
  });
  add('Sparse isolated center requires adaptive radius growth', sparse, {}, { expectedCenter: 0, expectedMinimumRadiusAttempts: 2 });
  const bcc = crystalFrame('bcc', 2, 2.86);
  const reversed = reorderFrame(bcc, Array.from({ length: bcc.ids.length }, (_, atom) => bcc.ids.length - atom - 1));
  add('BCC reversed equal-distance shell order', reversed, {}, { expectedStructure: 3 });
  const nearTie = cloneFrame(bcc);
  nearTie.fractional[3] += 1e-10;
  nearTie.positions = fractionalToCartesian(nearTie.fractional, nearTie.cell);
  add('BCC nearly tied nearest shells', nearTie, {}, { expectedStructure: 3 });
  for (const delta of [-1e-10, 0, 1e-10]) add(`FCC fixed cutoff at first shell ${delta}`, crystalFrame('fcc', 2, 3.52),
    { mode: 'fixed', cutoff: 3.52 / Math.SQRT2 + delta });
  const edge = 4 / Math.sqrt(10 + 2 * Math.sqrt(5));
  for (const delta of [-1e-10, 0, 1e-10]) add(`ICO bond-radius boundary ${delta}`, cloneFrame(ico),
    { mode: 'fixed', cutoff: 2 * edge + delta });
  return fixtures;
}

/** Direct GPU calls retain start/end ranges, unlike the Worker pool's complete
 * frame jobs. This large-coordinate case exercises a finite neighbor query
 * whose adaptive graph radius squared exceeds the Float32 numeric range. */
export function cnaDirectFixtures() {
  const side = 3.1e19, center = side / 2, radius = 1.79e19;
  const phi = (1 + Math.sqrt(5)) / 2;
  const scale = radius / Math.hypot(1, phi);
  const points = [[0, 0, 0]];
  for (const first of [-1, 1]) for (const second of [-1, 1]) {
    for (const vertex of [[0, first, second * phi], [first, second * phi, 0], [second * phi, 0, first]]) {
      points.push(vertex.map(value => value * scale));
    }
  }
  const q = 1.795e19 / Math.sqrt(3);
  points.push([q, q, q], [-q, -q, -q]);
  for (const vertex of [[-.4, -.4, -.4], [-.4, -.4, .4], [-.4, .4, -.4], [.4, -.4, -.4], [.4, .4, -.4], [.4, .4, .4]]) {
    points.push(vertex.map(value => value * side));
  }
  const frame = pointFrame(points.map(point => point.map(value => value + center)), {
    cell: createCell({ vectors: [side, 0, 0, 0, side, 0, 0, 0, side], pbc: [false, false, false] }),
  });
  return [{ label: 'Adaptive CNA graph-radius Float32 overflow correction', frame,
    parameters: { kind: 'cna', mode: 'adaptive', startAtom: 0, endAtom: 1 }, expectedCenter: 4, expectedCorrectionAtoms: 1 }];
}

/** Ready-to-run scientific cases. All matrices are physical Cartesian F, not
 * cell-storage matrices. Missing or undefined fits intentionally have NaN. */
export function referenceStrainFixtures() {
  const fixtures = [];
  const add = (label, reference, frame = cloneFrame(reference), cutoff = 2.8, expectations = {}) => fixtures.push({ label, frame, reference,
    parameters: { kind: 'referenceStrain', cutoff, referenceFractional: reference.fractional,
      referenceCell: reference.cell, referenceMapping: createReferenceMapping(frame, reference) }, ...expectations });
  const fcc = crystalFrame('fcc', 2, 3.52);
  for (const [kind, lattice, cutoff] of [['fcc', 3.52, 2.8], ['bcc', 2.86, 3.05], ['hcp', 2.5, 2.7], ['sc', 2, 2.1]]) {
    const reference = crystalFrame(kind, kind === 'sc' ? 1 : 2, lattice);
    add(`Undeformed ${kind.toUpperCase()} reference`, reference, undefined, cutoff, { expectedF: IDENTITY });
  }
  const primitive = crystalFrame('fcc', 1, 3.52);
  add('Primitive FCC reference multiple images', primitive, undefined, 2.8, { expectedF: IDENTITY });
  for (const delta of [-1e-10, 0, 1e-10]) add(`Reference cutoff at first FCC shell ${delta}`, cloneFrame(fcc), undefined,
    3.52 / Math.SQRT2 + delta, delta < 0
      ? { expectedNaNAtoms: Array.from({ length: fcc.ids.length }, (_, atom) => atom) } : { expectedF: IDENTITY });
  for (const [label, F] of [
    ['Anisotropic stretch', [1.04, 0, 0, 0, .97, 0, 0, 0, 1.02]],
    ['Finite simple shear', [1, .2, 0, 0, 1, 0, 0, 0, 1]],
    ['Shear and dilation', [1.02, .12, .03, 0, .98, .05, 0, 0, 1.04]],
  ]) add(label, cloneFrame(fcc), transformFrame(fcc, F), 2.8, { expectedF: F });
  const tinyStretch = 1 + 1e-8;
  const tinyStretchF = [tinyStretch, 0, 0, 0, 1, 0, 0, 0, 1];
  const tinyStretchE11 = (tinyStretch * tinyStretch - 1) / 2;
  const tinyBcc = crystalFrame('bcc', 2, 2.86);
  add('Genuine tiny uniaxial reference strain', tinyBcc, transformFrame(tinyBcc, tinyStretchF), 3.05, {
    expectedF: tinyStretchF, tinyRelativeTolerance: 1e-3,
    expectedTinyFields: { referenceE11: tinyStretchE11, referenceVolumeChange: tinyStretch - 1,
      referenceHydrostaticStrain: tinyStretchE11 / 3, referenceShearStrain: tinyStretchE11 / Math.sqrt(3) },
  });
  const tinyGamma = 1e-8;
  const tinyShearF = [1, tinyGamma, 0, 0, 1, 0, 0, 0, 1];
  add('Genuine tiny shear reference strain', cloneFrame(fcc), transformFrame(fcc, tinyShearF), 2.8, {
    expectedF: tinyShearF, tinyRelativeTolerance: 1e-3,
    expectedTinyFields: { referenceE12: tinyGamma / 2,
      referenceShearStrain: Math.sqrt(tinyGamma ** 2 / 4 + tinyGamma ** 4 / 12) },
  });
  const angle = .83;
  const rotation = [Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 1];
  add('Rigid rotation', cloneFrame(fcc), transformFrame(fcc, rotation), 2.8, { expectedF: rotation, expectedZeroStrain: true });
  const hcp = crystalFrame('hcp', 2, 2.5);
  const affine = [1.02, .12, .03, 0, .98, .05, 0, 0, 1.04];
  add('Triclinic HCP shear', hcp, transformFrame(hcp, affine), 2.7, { expectedF: affine });
  const shiftedReference = transformFrame(fcc, IDENTITY, { translation: [8.5, -3.25, 1.75] });
  add('Changed origin and affine translation', shiftedReference,
    transformFrame(shiftedReference, affine, { translation: [7.5, 2.25, -5], origin: [-12, 3, 7] }), 2.8, { expectedF: affine });
  const crossed = transformFrame(hcp, affine, { fractionalShift: [.49, -.23, .18] });
  for (let atom = 0; atom < crossed.ids.length; atom += 1) for (let axis = 0; axis < 3; axis += 1) {
    if (atom % 3 === axis) crossed.fractional[atom * 3 + axis] += atom % 2 ? 2 : -3;
  }
  crossed.positions = fractionalToCartesian(crossed.fractional, crossed.cell, new Float64Array(crossed.fractional.length));
  add('Triclinic crossings and atom-specific lattice images', cloneFrame(hcp), crossed, 2.7, { expectedF: affine });
  const skewCell = createCell({ vectors: [10, 0, 0, 9, 1, 0, 0, 0, 10], pbc: [true, true, false], triclinic: true });
  const skew = pointFrame([[9.5, .5, 5], [9.6, .5, 5], [9.4, .5, 5], [9.5, .6, 5], [9.5, .4, 5],
    [9.5, .5, 5.1], [9.5, .5, 4.9]], { cell: skewCell });
  const skewCurrent = cloneFrame(skew);
  skewCurrent.fractional[3] += .49;
  skewCurrent.fractional[4] += .49;
  skewCurrent.positions = fractionalToCartesian(skewCurrent.fractional, skewCurrent.cell, new Float64Array(skewCurrent.fractional.length));
  // The shortest change is (.49,-.51,0) fractional = (.31,-.51,0)
  // Cartesian. Component rounding incorrectly selects (.49,.49,0).
  // Six orthogonal reference neighbors give F[:,x] = e_x + delta/(2*.1).
  add('Skew cell Cartesian minimum-image motion', skew, skewCurrent, .15,
    { expectedCenterF: [2.55, 0, 0, -2.55, 1, 0, 0, 0, 1], allowFallback: true });
  const mixed = crystalFrame('fcc', 3, 3.52);
  mixed.cell = createCell({ ...mixed.cell, pbc: [true, false, true] });
  add('Mixed periodic/open affine reference', mixed, transformFrame(mixed, affine), 2.8, { expectedF: affine });
  const open = cloneFrame(fcc);
  open.cell = createCell({ ...open.cell, pbc: [false, false, false] });
  const stretch = [1.8, 0, 0, 0, 1.8, 0, 0, 0, 1.8];
  add('Open positions stretched in unchanged cell', open, transformFrame(open, stretch, { transformCell: false }), 2.8,
    { expectedF: stretch, allowFallback: true });
  const deformed = transformFrame(fcc, affine);
  add('Reordered stable IDs', cloneFrame(fcc), reorderFrame(deformed,
    Array.from({ length: fcc.ids.length }, (_, atom) => fcc.ids.length - atom - 1)), 2.8, { expectedF: affine });
  const changedId = cloneFrame(deformed);
  changedId.ids[0] = 100_000;
  add('Added ID and missing reference atom', cloneFrame(fcc), changedId, 2.8,
    { expectedF: affine, expectedNaNAtoms: [0] });
  add('Deleted current atom', cloneFrame(fcc), reorderFrame(deformed,
    Array.from({ length: fcc.ids.length - 1 }, (_, atom) => atom + 1)), 2.8, { expectedF: affine });
  add('Insufficient reference neighbors', cloneFrame(fcc), undefined, .1,
    { expectedNaNAtoms: Array.from({ length: fcc.ids.length }, (_, atom) => atom) });
  const plane = pointFrame([[5, 5, 6], [6, 5, 6], [5, 6, 6], [6, 6, 6]]);
  add('Coplanar reference covariance', plane, undefined, 2,
    { expectedNaNAtoms: [0, 1, 2, 3] });
  const thin = pointFrame([[6, 6, 6], [7, 6, 6], [5, 6, 6], [6, 7, 6], [6, 5, 6], [6, 6, 6 + 1e-7], [6, 6, 6 - 1e-7]]);
  add('Ill-conditioned reference covariance', thin, undefined, 2.1,
    { expectedNaNAtoms: [0, 1, 2, 3, 4, 5, 6] });
  const reflection = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
  add('Nonpositive deformation volume', cloneFrame(fcc), transformFrame(fcc, reflection), 2.8,
    { expectedNaNAtoms: Array.from({ length: fcc.ids.length }, (_, atom) => atom) });
  return fixtures;
}
