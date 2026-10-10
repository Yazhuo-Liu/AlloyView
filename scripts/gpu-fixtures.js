import { crystalFrame } from '../tests/helpers/crystals.js';
import { cartesianToFractional, createCell, fractionalToCartesian, wrapFractional, wrappedSourceRepetitions } from '../src/data/model.js';
import { replicateFrame } from '../src/data/replicate.js';
import { createReferenceMapping } from '../src/analysis/reference-strain.js';
import { calculateCna } from '../src/analysis/cna.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { calculatePtm } from '../src/analysis/ptm.js';

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

/** Parameters as the application prepares them for one current/reference pair. */
function referenceStrainFixture(label, reference, frame = cloneFrame(reference), cutoff = 2.8, expectations = {}) {
  return { label, frame, reference, parameters: { kind: 'referenceStrain', cutoff, referenceFractional: reference.fractional,
    referenceCell: reference.cell, referenceMapping: createReferenceMapping(frame, reference),
    sourceRepetitions: wrappedSourceRepetitions(frame, reference) }, ...expectations };
}

/** Ready-to-run scientific cases. All matrices are physical Cartesian F, not
 * cell-storage matrices. Missing or undefined fits intentionally have NaN. */
export function referenceStrainFixtures() {
  const fixtures = [];
  const add = (...fixture) => fixtures.push(referenceStrainFixture(...fixture));
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

/** Normalized AtomEye CSP has a finite intrinsic HCP baseline. Cached and fresh
 * auto cases share a comparison group so a browser can check all classifications,
 * inferred shell sizes and summaries, not just the scalar values. */
export function cspFixtures() {
  const fixtures = [];
  const add = (label, frame, parameters = {}, expectations = {}) => fixtures.push({ label, frame,
    parameters: { kind: 'centrosymmetry', mode: 'manual', neighbors: 12, ...parameters }, ...expectations });
  const autoPair = (label, frame, expectations = {}) => {
    const cacheComparisonGroup = label;
    add(`${label} / fresh CNA`, cloneFrame(frame), { mode: 'auto' }, { ...expectations, cacheComparisonGroup });
    add(`${label} / cached CNA`, cloneFrame(frame), { mode: 'auto', structureInput: calculateCna(frame).structures },
      { ...expectations, cacheComparisonGroup });
  };
  for (const [kind, lattice, structure, neighbors] of [['fcc', 3.52, 1, 12], ['bcc', 2.86, 3, 8], ['hcp', 2.5, 2, 12]]) {
    for (const repeat of [1, 2]) {
      const frame = crystalFrame(kind, repeat, lattice);
      const scalar = kind === 'hcp' ? { expectedFiniteBaseline: true } : { expectedValue: 0 };
      const label = `${kind.toUpperCase()} ${repeat === 1 ? 'primitive periodic images' : 'ideal'}`;
      add(`${label} manual CSP`, cloneFrame(frame), { neighbors }, scalar);
      autoPair(`${label} auto CSP`, frame, { ...scalar, expectedStructure: structure, expectedNeighborCount: neighbors,
        expectedSummaryEntries: { [kind]: frame.ids.length, inferred: 0, unresolved: 0 } });
    }
  }
  for (let neighbors = 2; neighbors <= 32; neighbors += 2) {
    add(`Primitive SC manual ${neighbors}-neighbor CSP`, crystalFrame('sc', 1, 2), { neighbors },
      neighbors === 6 ? { expectedValue: 0 } : { expectedFiniteNormalized: true });
  }
  const ico = icosahedralFrame();
  add('Icosahedral center manual CSP', cloneFrame(ico), { neighbors: 12 }, { expectedCenterValue: 0 });
  autoPair('Icosahedral center auto CSP remains unresolved', ico,
    { expectedNaNAtoms: Array.from({ length: ico.ids.length }, (_, atom) => atom), expectedCenterStructure: 4,
      expectedCenterNeighborCount: 0, expectedSummaryEntries: { ico: 1, other: 12, inferred: 0, unresolved: 13 } });
  autoPair('SC auto CSP remains Other', crystalFrame('sc', 1, 2),
    { expectedNaNAtoms: [0], expectedStructure: 0, expectedNeighborCount: 0, expectedSummaryEntries: { other: 1, unresolved: 1 } });
  add('Open ICO insufficient manual shell', cloneFrame(ico), { neighbors: 16 },
    { expectedNaNAtoms: Array.from({ length: ico.ids.length }, (_, atom) => atom), expectedIncomplete: ico.ids.length });
  const coincident = pointFrame([[6, 6, 6], [6, 6, 6], [6, 6, 6]]);
  add('Coincident manual CSP has zero denominator', coincident, { neighbors: 2 },
    { expectedNaNAtoms: [0, 1, 2], expectedIncomplete: 3 });
  for (const [kind, lattice, neighbors] of [['fcc', 3.52, 12], ['bcc', 2.86, 8]]) {
    const source = crystalFrame(kind, 3, lattice);
    const vacancy = reorderFrame(source, Array.from({ length: source.ids.length - 1 }, (_, atom) => atom + 1));
    add(`${kind.toUpperCase()} vacancy manual CSP`, cloneFrame(vacancy), { neighbors }, { expectedSomePositive: true });
    autoPair(`${kind.toUpperCase()} vacancy inferred auto CSP`, vacancy,
      { expectedSomePositive: true, expectedNeighborCount: neighbors, expectedMinimumInferred: 1, expectedSummaryEntries: { unresolved: 0 } });
  }
  const distorted = crystalFrame('fcc', 3, 3.52);
  distorted.fractional[0] += .009;
  distorted.fractional[4] -= .007;
  distorted.positions = fractionalToCartesian(distorted.fractional, distorted.cell);
  add('Distorted FCC manual CSP', cloneFrame(distorted), {}, { expectedSomePositive: true });
  autoPair('Distorted FCC auto CSP', distorted, { expectedSomePositive: true });
  const mixedPbc = crystalFrame('fcc', 3, 3.52);
  mixedPbc.cell = createCell({ ...mixedPbc.cell, pbc: [true, false, true] });
  add('Mixed periodic/open manual CSP', cloneFrame(mixedPbc));
  autoPair('Mixed periodic/open auto CSP', mixedPbc);
  const sheared = transformFrame(crystalFrame('fcc', 2, 3.52), [1.04, .12, .03, 0, .98, .05, 0, 0, 1.02]);
  add('Triclinic sheared manual CSP', sheared, {}, { expectedValue: 0 });
  const tie = crystalFrame('bcc', 2, 2.86);
  tie.fractional[3] += 1e-10;
  tie.positions = fractionalToCartesian(tie.fractional, tie.cell);
  add('BCC nearly tied manual CSP shell', cloneFrame(tie), { neighbors: 8 }, { expectedFiniteNormalized: true });
  autoPair('BCC nearly tied auto CSP shell', tie, { expectedStructure: 3, expectedNeighborCount: 8 });
  const sparseSource = cnaFixtures().find(fixture => fixture.label === 'Sparse isolated center requires adaptive radius growth').frame;
  add('Sparse center manual CSP requires radius growth', cloneFrame(sparseSource), { neighbors: 14 }, { expectedFiniteNormalized: true });
  autoPair('Sparse center auto CSP', sparseSource);
  const phases = [['fcc', 3.52, 4], ['bcc', 2.86, 22], ['hcp', 2.5, 44]];
  const mixedPoints = [], phaseOffsets = [];
  for (const [kind, lattice, offset] of phases) {
    phaseOffsets.push(mixedPoints.length);
    const phase = crystalFrame(kind, 3, lattice);
    for (let atom = 0; atom < phase.ids.length; atom += 1) mixedPoints.push(
      Array.from(phase.positions.subarray(atom * 3, atom * 3 + 3), (value, axis) => value + (axis === 0 ? offset : 4)));
  }
  const mixedPhases = pointFrame(mixedPoints, { cell: createCell({ vectors: [64, 0, 0, 0, 64, 0, 0, 0, 64], pbc: [false, false, false] }) });
  autoPair('Coexisting FCC/BCC/HCP auto CSP', mixedPhases, {
    expectedAtoms: [{ atom: phaseOffsets[0] + 52, structure: 1, neighbors: 12 },
      { atom: phaseOffsets[1] + 26, structure: 3, neighbors: 8 }, { atom: phaseOffsets[2] + 26, structure: 2, neighbors: 12 }],
  });
  const votingFrame = crystalFrame('fcc', 3, 3.52);
  const votingShell = new NeighborSearch(votingFrame).nearest(0, 14);
  const sharedShellLabels = new Uint8Array(votingFrame.ids.length);
  votingShell.forEach((neighbor, index) => { sharedShellLabels[neighbor.atom] = index < 7 ? 1 : 2; });
  add('Cached FCC/HCP labels combine twelve-neighbor votes', cloneFrame(votingFrame), { mode: 'auto', structureInput: sharedShellLabels },
    { expectedCenterStructure: 0, expectedCenterNeighborCount: 12, expectedCenterValue: 0, expectedMinimumInferred: 1 });
  const tiedLabels = sharedShellLabels.slice();
  votingShell.slice(7).forEach(neighbor => { tiedLabels[neighbor.atom] = 3; });
  add('Cached FCC/BCC labels tie eight/twelve-neighbor votes', cloneFrame(votingFrame), { mode: 'auto', structureInput: tiedLabels },
    { expectedCenterStructure: 0, expectedCenterNeighborCount: 0, expectedNaNAtoms: [0] });
  return fixtures;
}

/** Expected Cartesian vectors are supplied explicitly, independent of the
 * minimum-image implementation. Float64 magnitudes are evaluated from the
 * application's rounded Float32 vectors, preserving zeros and unmatched NaNs
 * even when their combined length exceeds the Float32 numeric range. */
function displacementFixture(label, reference, frame, expectedVectors, options = {}, expectations = {}) {
  const vectors = Float64Array.from(expectedVectors);
  const expectedMapping = reference.idSource === 'row-order' && frame.idSource === 'row-order'
    ? Int32Array.from({ length: frame.ids.length }, (_, atom) => atom) : createReferenceMapping(frame, reference);
  const f32Vectors = Float32Array.from(vectors);
  return { label, frame, reference, options: { minimumImage: true, ...options }, expectedVectors: vectors, expectedMapping,
    expectedMappingMode: reference.idSource === 'row-order' ? 'row-order' : 'id',
    expectedMagnitudes: Float64Array.from({ length: frame.ids.length }, (_, atom) => Math.hypot(...f32Vectors.subarray(atom * 3, atom * 3 + 3))),
    ...expectations };
}

export function displacementFixtures() {
  const fixtures = [];
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const add = (...fixture) => fixtures.push(displacementFixture(...fixture));
  const reference = pointFrame([[1, 2, 3], [4, 5, 6]], { cell });
  add('Matched zero displacements', cloneFrame(reference), cloneFrame(reference), [0, 0, 0, 0, 0, 0]);
  add('Cartesian translation and origin change', cloneFrame(reference), transformFrame(reference, undefined, { translation: [.25, -.5, .125] }),
    [.25, -.5, .125, .25, -.5, .125]);
  const orderedReference = pointFrame([[1, 2, 3], [4, 5, 6], [7, 8, 9]], { cell, ids: [11, 22, 33] });
  add('Stable IDs reordered with an unmatched added atom', orderedReference,
    pointFrame([[8, 8, 9], [1, 3, 3], [0, 0, 0]], { cell, ids: [33, 11, 44] }), [1, 0, 0, 0, 1, 0, NaN, NaN, NaN]);
  add('Deleted current atom retains surviving stable IDs', cloneFrame(orderedReference), reorderFrame(orderedReference, [0, 2]), [0, 0, 0, 0, 0, 0]);
  add('Stable string IDs reorder displacements', pointFrame([[1, 2, 3], [4, 5, 6]], { cell, ids: ['Fe:a', 'Ni:b'] }),
    pointFrame([[4.25, 5, 6], [1, 2.5, 3]], { cell, ids: ['Ni:b', 'Fe:a'] }), [.25, 0, 0, 0, .5, 0]);
  const wrappedReference = pointFrame([[9.5, 2, 3]], { cell }), wrappedCurrent = pointFrame([[.5, 2, 3]], { cell });
  add('Wrapped boundary crossing', cloneFrame(wrappedReference), cloneFrame(wrappedCurrent), [1, 0, 0]);
  add('Wrapped positions without minimum images', cloneFrame(wrappedReference), cloneFrame(wrappedCurrent), [-9, 0, 0], { minimumImage: false });
  wrappedReference.unwrappedPositions = Float64Array.from([19.5, 2, 3]);
  wrappedCurrent.unwrappedPositions = Float64Array.from([30.5, 2, 3]);
  add('Minimum images use wrapped positions despite unwrapped data', cloneFrame(wrappedReference), cloneFrame(wrappedCurrent), [1, 0, 0]);
  add('Unwrapped positions preserve full image motion', wrappedReference, wrappedCurrent, [11, 0, 0], { minimumImage: false });
  const referenceCell = createCell({ ...cell, origin: [10, 20, 30], pbc: [false, false, false] });
  const currentCell = createCell({ ...cell, origin: [11, 22, 33], vectors: [12, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] });
  add('Cell deformation and origin displacement contribute directly', pointFrame([[12.5, 22.5, 32.5]], { cell: referenceCell }),
    pointFrame([[14, 24.5, 35.5]], { cell: currentCell }), [1.5, 2, 3]);
  add('Current cell determines periodic displacement image', pointFrame([[1, 1, 1]], { cell }),
    pointFrame([[11, 1, 1]], { cell: createCell({ ...cell, vectors: [12, 0, 0, 0, 10, 0, 0, 0, 10] }) }), [-2, 0, 0]);
  const skew = createCell({ vectors: [10, 0, 0, 9, 1, 0, 0, 0, 10], pbc: [true, true, false], triclinic: true });
  add('Triclinic minimum image follows Cartesian distance', pointFrame([[0, 0, 0]], { cell: skew }),
    pointFrame([[9.31, .49, 1]], { cell: skew }), [.31, -.51, 1]);
  add('Changed triclinic cell uses current metric', pointFrame([[0, 0, 0]], { cell }),
    pointFrame([[9.31, .49, 1]], { cell: skew }), [.31, -.51, 1]);
  const mixed = createCell({ ...cell, pbc: [true, false, false] });
  add('Mixed PBC retains open-axis motion', pointFrame([[1, 1, 1]], { cell: mixed }),
    pointFrame([[10, 8, 9]], { cell: mixed }), [-1, 7, 8]);
  const rotated = createCell({ vectors: [6, 8, 0, -8, 6, 0, 0, 0, 10], pbc: [true, false, true] });
  add('Rotated orthogonal basis and mixed PBC', pointFrame([[-2, 5, 9]], { cell: rotated }),
    pointFrame([[1.8, 13.4, 1]], { cell: rotated }), [-2.2, .4, 2]);
  add('Positive half-box uses CPU rounding convention', pointFrame([[0, 0, 0]], { cell }), pointFrame([[5, 0, 0]], { cell }), [-5, 0, 0]);
  add('Negative half-box uses CPU rounding convention', pointFrame([[5, 0, 0]], { cell }), pointFrame([[0, 0, 0]], { cell }), [-5, 0, 0]);
  add('Half-box values around the rounding tie', pointFrame([[0, 0, 0], [0, 0, 0]], { cell }),
    pointFrame([[5 - 1e-8, 0, 0], [5 + 1e-8, 0, 0]], { cell }), [5 - 1e-8, 0, 0, -5 + 1e-8, 0, 0]);
  const generatedReference = pointFrame([[1, 0, 0], [4, 0, 0]], { cell });
  generatedReference.idSource = 'row-order'; generatedReference.sourceFormat = 'cfg';
  const generatedCurrent = pointFrame([[2, 0, 0], [4, 2, 0]], { cell, ids: [999, 998] });
  generatedCurrent.idSource = 'row-order'; generatedCurrent.sourceFormat = 'xyz';
  add('Generated IDs permit equal-count row-order matching', generatedReference, generatedCurrent, [1, 0, 0, 0, 2, 0]);
  const largeOrigin = 1e8;
  const largeCell = createCell({ ...cell, origin: [largeOrigin, largeOrigin, largeOrigin], pbc: [false, false, false] });
  const tinyReference = pointFrame([[largeOrigin + 1, largeOrigin + 2, largeOrigin + 3]], { cell: largeCell });
  const tinyCurrent = cloneFrame(tinyReference);
  tinyCurrent.positions[0] += 1e-8;
  tinyCurrent.fractional = cartesianToFractional(tinyCurrent.positions, tinyCurrent.cell, new Float64Array(3));
  const representedShift = tinyCurrent.positions[0] - tinyReference.positions[0];
  add('Large origin preserves a genuine tiny Cartesian displacement', tinyReference, tinyCurrent, [representedShift, 0, 0], {},
    { requirePositiveTinyDisplacement: true, tinyRelativeTolerance: 1e-3 });
  const hugeCell = createCell({ vectors: [3.3e38, 0, 0, 0, 3.3e38, 0, 0, 0, 3.3e38], pbc: [false, false, false] });
  add('Finite Float32 displacement components retain a Float64 magnitude', pointFrame([[0, 0, 0]], { cell: hugeCell }),
    pointFrame([[3e38, 3e38, 3e38]], { cell: hugeCell }), [3e38, 3e38, 3e38], { minimumImage: false },
    { expectedMagnitudeExceedsFloat32: true });
  const wideCell = createCell({ vectors: [1.1e6, 0, 0, 0, 1.1e6, 0, 0, 0, 1.1e6], pbc: [false, false, false] });
  const wideSource = pointFrame([[0, 0, 0], [1e6 + .0123, 0, 0]], { cell: wideCell });
  add('Million-Angstrom frame compared to itself preserves exact zeros', wideSource, wideSource, [0, 0, 0, 0, 0, 0],
    { minimumImage: false }, { expectedCorrectionAtoms: 0 });
  const wideCurrent = cloneFrame(wideSource);
  wideCurrent.positions[3] += 1e-8;
  wideCurrent.fractional = cartesianToFractional(wideCurrent.positions, wideCurrent.cell, new Float64Array(wideCurrent.positions.length));
  const wideShift = wideCurrent.positions[3] - wideSource.positions[3];
  add('Separate million-Angstrom frames preserve one tiny displacement', wideSource, wideCurrent, [0, 0, 0, wideShift, 0, 0],
    { minimumImage: false }, { expectedCorrectionAtoms: 1, requirePositiveTinyDisplacement: true,
      expectedTinyDisplacementAtom: 1, tinyRelativeTolerance: 1e-3 });
  const batchedCount = 20_000;
  const batchedSource = pointFrame(Array.from({ length: batchedCount }, (_, atom) => [atom === 0 ? 0 : 1e6 + .0123 + atom, 0, 0]),
    { cell: wideCell });
  add('Twenty-thousand wide-coordinate self displacements stay zero across batches', batchedSource, batchedSource,
    new Float64Array(batchedCount * 3), { minimumImage: false },
    { expectedCorrectionAtoms: 0, expectedProgressAtoms: [16_384, batchedCount] });
  return fixtures;
}

/** Validation fixtures are kept out of the success list so GPU tests can demand
 * an actual GPU backend for every supported scientific displacement case. */
export function displacementValidationFixtures() {
  const fixtures = [];
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const reference = pointFrame([[1, 1, 1], [2, 2, 2]], { cell });
  const add = (label, frame, old = cloneFrame(reference), expectedError, options = {}) => fixtures.push(
    { label, frame, reference: old, options: { minimumImage: true, ...options }, expectedError });
  const generated = cloneFrame(reference); generated.idSource = 'row-order';
  add('Explicit and generated displacement IDs cannot mix', cloneFrame(generated), cloneFrame(reference), 'explicit atom IDs.*generated row IDs');
  add('Generated displacement rows require equal atom counts', reorderFrame(generated, [0]), cloneFrame(generated), 'same atom count');
  const duplicate = cloneFrame(reference); duplicate.ids[0] = duplicate.ids[1];
  add('Duplicate explicit displacement IDs are rejected', duplicate, undefined, 'unique integer atom IDs');
  const fractionalId = cloneFrame(reference); fractionalId.ids = Float64Array.from([1.5, 2]);
  add('Fractional displacement IDs are rejected', fractionalId, undefined, 'unique integer atom IDs');
  const missingIds = cloneFrame(reference); delete missingIds.ids;
  add('Missing explicit displacement IDs are rejected', missingIds, undefined, 'an atom ID for every atom');
  const nonfinite = cloneFrame(reference); nonfinite.positions[0] = NaN;
  add('Nonfinite displacement positions are rejected', nonfinite, undefined, 'finite atom coordinates');
  const shortCoordinates = cloneFrame(reference); shortCoordinates.positions = new Float64Array(2);
  add('Incomplete displacement coordinate rows are rejected', shortCoordinates, undefined, 'atom count');
  add('Displacement minimum-image option must be boolean', cloneFrame(reference), undefined, 'boolean', { minimumImage: 'yes' });
  return fixtures;
}

/** Two-frame sources that store wrapped coordinates only, replicated as the
 * application does for **Replicate atoms for analysis**. The current frame is
 * an affine deformation of the reference plus a uniform reduced shift, so its
 * expected displacement and deformation gradient are known without any image
 * search. Atoms that cross a source cell face jump by a source cell vector in
 * every copy; the enlarged cell's own lattice cannot remove that jump. */
async function replicatedWrappedSources() {
  const fcc = crystalFrame('fcc', 2, 3.52), hcp = crystalFrame('hcp', 3, 2.5);
  const mixed = crystalFrame('fcc', 2, 3.52);
  mixed.cell = createCell({ ...mixed.cell, pbc: [true, false, true] });
  const affine = [1.02, .012, .003, 0, .98, .005, 0, 0, 1.04];
  const sources = [];
  // offset places reference atoms beside the faces that shift then carries them across.
  for (const [label, crystal, cutoff, repetitions, matrix, offset, shift] of [
    ['uniform shift across a face, 2x1x1', fcc, 2.8, [2, 1, 1], IDENTITY, [0, 0, 0], [-.02, 0, 0]],
    ['crossings in both directions, 2x3x2', fcc, 2.8, [2, 3, 2], IDENTITY, [.23, .02, .23], [.03, -.04, .05]],
    ['triclinic cell, 3x1x2', hcp, 2.7, [3, 1, 2], IDENTITY, [.1, 0, .15], [.07, -.05, .03]],
    ['changed triclinic cell, 3x2x1', hcp, 2.7, [3, 2, 1], affine, [0, .2, 0], [-.04, .06, .05]],
    ['mixed periodic and open axes, 3x1x2', mixed, 2.8, [3, 1, 2], [1.01, 0, 0, 0, 1, 0, 0, 0, .99], [.2, 0, 0], [.06, 0, -.04]],
  ]) {
    const source = transformFrame(crystal, IDENTITY, { fractionalShift: offset });
    const moved = transformFrame(source, matrix, { fractionalShift: shift });
    const wrapped = cloneFrame(moved);
    wrapped.fractional = wrapFractional(moved.fractional, moved.cell.pbc, new Float64Array(moved.fractional.length));
    wrapped.positions = fractionalToCartesian(wrapped.fractional, wrapped.cell, new Float64Array(wrapped.fractional.length));
    const [reference, frame] = await Promise.all([source, wrapped].map(input => replicateFrame(input, repetitions)));
    // Copy (i, j, k) of an atom moves with its source atom and with the cell.
    const count = source.ids.length, expectedVectors = new Float64Array(frame.ids.length * 3);
    let copy = 0;
    for (let k = 0; k < repetitions[2]; k += 1) for (let j = 0; j < repetitions[1]; j += 1) for (let i = 0; i < repetitions[0]; i += 1) {
      for (let atom = 0; atom < count; atom += 1) for (let axis = 0; axis < 3; axis += 1) {
        let value = moved.cell.origin[axis] - source.cell.origin[axis];
        for (const [direction, image] of [i, j, k].entries()) {
          value += (moved.fractional[atom * 3 + direction] + image) * moved.cell.vectors[direction * 3 + axis]
            - (source.fractional[atom * 3 + direction] + image) * source.cell.vectors[direction * 3 + axis];
        }
        expectedVectors[(copy * count + atom) * 3 + axis] = value;
      }
      copy += 1;
    }
    sources.push({ label: `Replicated wrapped source: ${label}`, reference, frame, cutoff, matrix, expectedVectors });
  }
  return sources;
}

export async function replicatedDisplacementFixtures() {
  return (await replicatedWrappedSources()).map(({ label, reference, frame, expectedVectors }) =>
    displacementFixture(label, reference, frame, expectedVectors, {}, { expectedCorrectionAtoms: 0 }));
}

export async function replicatedReferenceStrainFixtures() {
  return (await replicatedWrappedSources()).map(({ label, reference, frame, cutoff, matrix }) =>
    referenceStrainFixture(label, reference, frame, cutoff, { expectedF: matrix, expectedCorrectionAtoms: 0 }));
}

function clonePtmInput(input) {
  return Object.fromEntries(Object.entries(input).map(([name, value]) => [name, ArrayBuffer.isView(value) ? value.slice() : value]));
}

function diagonalElasticFields(x, y = x, z = x) {
  const diagonal = [x, y, z].map(value => (value * value - 1) / 2);
  const hydrostatic = diagonal.reduce((sum, value) => sum + value, 0) / 3;
  return { atomicShearStrain: Math.sqrt(diagonal.reduce((sum, value) => sum + (value - hydrostatic) ** 2, 0) / 2),
    atomicHydrostaticStrain: hydrostatic, atomicVolumeChange: x * y * z - 1,
    strainE11: diagonal[0], strainE22: diagonal[1], strainE33: diagonal[2], strainE12: 0, strainE13: 0, strainE23: 0 };
}

/** Real CPU PTM fits provide cached tensor inputs. Analytic scalar invariants
 * remain independent of the local PTM template orientation; individual tensor
 * expectations are used only for isotropic or hexagonal-axis scaling. */
export async function idealStrainFixtures() {
  const fixtures = [], ideals = new Map();
  const reference = (structure, a) => ({ structure, a, ...([2, 7].includes(structure) ? { c: Math.sqrt(8 / 3) * a } : {}) });
  const add = async (label, frame, references, expectations = {}, { ptmInput, flags = 255, freshFlags } = {}) => {
    const fitted = ptmInput ?? await calculatePtm(frame, { flags, rmsdCutoff: .1 });
    const parameters = { kind: 'strain', references, flags, rmsdCutoff: .1, ptmInput: clonePtmInput(fitted) };
    const fixture = { label, frame, parameters, ...expectations };
    if (freshFlags !== undefined) fixture.freshParameters = { kind: 'strain', references, flags: freshFlags, rmsdCutoff: .1 };
    fixtures.push(fixture);
    return fixture;
  };
  for (const [kind, structure, lattice] of [['fcc', 1, 3.52], ['bcc', 3, 2.86], ['hcp', 2, 2.5], ['sc', 5, 2.4]]) {
    for (const repeat of [1, 2]) {
      const fixture = await add(`Exact-zero ${kind.toUpperCase()} ideal strain / repeat ${repeat}`, crystalFrame(kind, repeat, lattice),
        [reference(structure, lattice)], { expectedZeroStrain: true, expectedStructure: structure }, { freshFlags: 31 });
      ideals.set(`${kind}-${repeat}`, fixture);
    }
  }
  for (const [kind, structure, lattice] of [['diamond', 6, 5.43], ['hex-diamond', 7, 2.5]]) {
    await add(`Exact-zero ${kind} ideal strain`, crystalFrame(kind, 2, lattice), [reference(structure, lattice)],
      { expectedZeroStrain: true, expectedStructure: structure }, { freshFlags: 255 });
  }
  const dilation = 1.04;
  for (const kind of ['fcc', 'bcc', 'hcp', 'sc']) {
    const ideal = ideals.get(`${kind}-2`);
    await add(`Isotropic ${kind.toUpperCase()} lattice stretch`, transformFrame(ideal.frame, [dilation, 0, 0, 0, dilation, 0, 0, 0, dilation]),
      ideal.parameters.references, { expectedStructure: ideal.expectedStructure, expectedFields: diagonalElasticFields(dilation) });
  }
  const angle = .71;
  const rotation = [Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 1];
  for (const kind of ['fcc', 'hcp']) {
    const ideal = ideals.get(`${kind}-2`);
    await add(`Rigidly rotated ${kind.toUpperCase()} ideal lattice`, transformFrame(ideal.frame, rotation), ideal.parameters.references,
      { expectedStructure: ideal.expectedStructure, expectedZeroStrain: true });
  }
  const gamma = .06;
  for (const kind of ['fcc', 'hcp']) {
    const ideal = ideals.get(`${kind}-2`);
    await add(`Finite ${kind.toUpperCase()} simple-shear invariants`, transformFrame(ideal.frame, [1, gamma, 0, 0, 1, 0, 0, 0, 1]),
      ideal.parameters.references, { expectedStructure: ideal.expectedStructure, expectedFields: {
        atomicHydrostaticStrain: gamma ** 2 / 6,
        atomicShearStrain: Math.sqrt(gamma ** 2 / 4 + gamma ** 4 / 12), atomicVolumeChange: 0,
      } });
  }
  const bcc = ideals.get('bcc-2'), fcc = ideals.get('fcc-2'), hcp = ideals.get('hcp-2');
  const tinyStretch = 1 + 1e-8, tinyE = (tinyStretch * tinyStretch - 1) / 2;
  await add('Genuine tiny uniaxial ideal-lattice strain', transformFrame(bcc.frame, [tinyStretch, 0, 0, 0, 1, 0, 0, 0, 1]),
    bcc.parameters.references, { expectedStructure: 3, tinyRelativeTolerance: 1e-3, expectedTinyFields: {
      atomicHydrostaticStrain: tinyE / 3, atomicShearStrain: tinyE / Math.sqrt(3), atomicVolumeChange: tinyStretch - 1,
    } });
  const tinyGamma = 1e-8;
  await add('Genuine tiny simple-shear ideal-lattice strain', transformFrame(fcc.frame, [1, tinyGamma, 0, 0, 1, 0, 0, 0, 1]),
    fcc.parameters.references, { expectedStructure: 1, tinyRelativeTolerance: 1e-3,
      expectedTinyFields: { atomicShearStrain: Math.sqrt(tinyGamma ** 2 / 4 + tinyGamma ** 4 / 12) } });
  const mixedTypes = cloneFrame(fcc.frame);
  mixedTypes.types = Uint16Array.from(mixedTypes.types, (_, atom) => atom % 2);
  mixedTypes.typeLabels = ['Ni', 'X'];
  const editedA = 3.4;
  await add('Per-species edited reference lattice constant', mixedTypes, [reference(1, 3.52), reference(1, editedA)], {
    expectedFieldsByType: { 0: diagonalElasticFields(1), 1: diagonalElasticFields(3.52 / editedA) },
    expectedZeroAtoms: Array.from({ length: mixedTypes.ids.length }, (_, atom) => atom).filter(atom => atom % 2 === 0),
  }, { ptmInput: fcc.parameters.ptmInput });
  await add('Per-species mismatched structure leaves only those atoms undefined', cloneFrame(mixedTypes), [reference(1, 3.52), reference(3, 2.86)], {
    expectedNaNAtoms: Array.from({ length: mixedTypes.ids.length }, (_, atom) => atom).filter(atom => atom % 2 === 1),
    expectedZeroAtoms: Array.from({ length: mixedTypes.ids.length }, (_, atom) => atom).filter(atom => atom % 2 === 0),
  }, { ptmInput: fcc.parameters.ptmInput });
  const editedC = Math.sqrt(8 / 3) * 2.5 * 1.03;
  await add('Edited hexagonal reference a and c', cloneFrame(hcp.frame), [{ structure: 2, a: 2.45, c: editedC }], {
    expectedFields: diagonalElasticFields(2.5 / 2.45, 2.5 / 2.45, 1 / 1.03),
  }, { ptmInput: hcp.parameters.ptmInput });
  await add('Whole-frame reference structure mismatch stays NaN', cloneFrame(fcc.frame), [reference(3, 2.86)], {
    expectedNaNAtoms: Array.from({ length: fcc.frame.ids.length }, (_, atom) => atom),
  }, { ptmInput: fcc.parameters.ptmInput });
  for (const [label, mutate] of [
    ['Invalid cached structure', input => { input.structures[0] = 0; }],
    ['Nonfinite cached PTM scale', input => { input.scales[0] = NaN; }],
    ['Zero cached PTM scale', input => { input.scales[0] = 0; }],
    ['Nonfinite cached PTM deformation', input => { input.deformation[0] = NaN; }],
  ]) {
    const cache = clonePtmInput(fcc.parameters.ptmInput);
    mutate(cache);
    await add(`${label} leaves only its atom NaN`, cloneFrame(fcc.frame), fcc.parameters.references,
      { expectedNaNAtoms: [0], expectedZeroAtoms: Array.from({ length: fcc.frame.ids.length - 1 }, (_, atom) => atom + 1) },
      { ptmInput: cache });
  }
  const negative = clonePtmInput(fcc.parameters.ptmInput);
  negative.scales = Float64Array.from(negative.scales, value => -value);
  negative.deformation = Float64Array.from(negative.deformation, value => -value);
  await add('Signed PTM scale and deformation preserve a positive ideal fit', cloneFrame(fcc.frame), fcc.parameters.references,
    { expectedZeroStrain: true }, { ptmInput: negative });
  const undefinedWithHuge = clonePtmInput(fcc.parameters.ptmInput);
  undefinedWithHuge.deformation[0] = NaN; undefinedWithHuge.deformation[1] = 1e40;
  await add('Nonfinite cached fit remains NaN alongside an unsupported finite component', cloneFrame(fcc.frame), fcc.parameters.references,
    { expectedNaNAtoms: [0], expectedZeroAtoms: Array.from({ length: fcc.frame.ids.length - 1 }, (_, atom) => atom + 1) },
    { ptmInput: undefinedWithHuge });
  const mismatchedWithHuge = clonePtmInput(fcc.parameters.ptmInput);
  mismatchedWithHuge.deformation[0] = 1e40;
  await add('Phase mismatch remains NaN alongside an unsupported finite component', cloneFrame(fcc.frame), [reference(3, 2.86)],
    { expectedNaNAtoms: Array.from({ length: fcc.frame.ids.length }, (_, atom) => atom) }, { ptmInput: mismatchedWithHuge });
  const subnormal = clonePtmInput(fcc.parameters.ptmInput);
  subnormal.scales = Float64Array.from(subnormal.scales, value => value * 1e-40);
  subnormal.deformation = Float64Array.from(subnormal.deformation, value => value * 1e-40);
  await add('Valid subnormal PTM encoding uses explicit CPU numeric fallback', cloneFrame(fcc.frame), fcc.parameters.references,
    { expectedZeroStrain: true, allowGpuFallback: true, expectedFallbackReason: 'precision|range|encoding|floating' }, { ptmInput: subnormal });
  return fixtures;
}
