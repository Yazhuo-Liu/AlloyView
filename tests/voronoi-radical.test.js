import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { calculateVoronoi, calculateVoronoiGeometry, calculateVoronoiGeometryBatch, VORONOI_FIELDS } from '../src/analysis/voronoi.js';
import { validateVoronoiRadii, radicalReach, voronoiRadiiForTypes, voronoiRadiiFingerprint } from '../src/analysis/voronoi-radii.js';
import { compactVoronoiRadii, prepareVoronoiSelection } from '../src/analysis/voronoi-selection.js';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { createVoronoiCellMesh } from '../src/render/voronoi-cell-layer.js';
import { createCell } from '../src/data/model.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import { crystalFrame } from './helpers/crystals.js';

const OUTPUTS = [...Object.keys(VORONOI_FIELDS), 'faceOffsets', 'faceAreas', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted'];

function near(actual, expected, message, tolerance = 1e-10) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} ≈ ${expected}`);
}

function assertIdentical(actual, expected, label) {
  for (const field of OUTPUTS) {
    assert.equal(actual[field].length, expected[field].length, `${label} ${field} length`);
    for (let index = 0; index < expected[field].length; index++) {
      if (!Object.is(actual[field][index], expected[field][index])) assert.fail(`${label} ${field}[${index}]: ${actual[field][index]} vs ${expected[field][index]}`);
    }
  }
  assert.deepEqual(actual.voronoiIndices, expected.voronoiIndices, `${label} indices`);
}

function boxFrame(points, size = 10, pbc = [false, false, false]) {
  return { fractional: Float64Array.from(points.flat(), value => value / size), types: new Uint16Array(points.length),
    typeLabels: ['X'], cell: createCell({ vectors: [size, 0, 0, 0, size, 0, 0, 0, size], pbc }) };
}

// An independent half-space reference: clip a large cube by every radical
// plane from every periodic image within `images` cells, without Voro++, a
// neighbor search or any completeness bound.
function bruteForceRadical(frame, radii, atom, images = 1) {
  const vectors = frame.cell.vectors, count = frame.fractional.length / 3;
  const cartesian = index => [0, 1, 2].map(axis => frame.fractional[index * 3] * vectors[axis]
    + frame.fractional[index * 3 + 1] * vectors[3 + axis] + frame.fractional[index * 3 + 2] * vectors[6 + axis]);
  const center = cartesian(atom), half = 4 * Math.max(...[0, 3, 6].map(offset => Math.hypot(...vectors.slice(offset, offset + 3))));
  let faces = cube(half).map(polygon => ({ polygon, neighbor: -1 }));
  const range = axis => frame.cell.pbc[axis] ? images : 0;
  for (let other = 0; other < count; other++) {
    const position = cartesian(other);
    for (let a = -range(0); a <= range(0); a++) for (let b = -range(1); b <= range(1); b++) for (let c = -range(2); c <= range(2); c++) {
      if (other === atom && !a && !b && !c) continue;
      const d = [0, 1, 2].map(axis => position[axis] + a * vectors[axis] + b * vectors[3 + axis] + c * vectors[6 + axis] - center[axis]);
      const squared = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
      faces = clip(faces, d, (squared + radii[atom] ** 2 - radii[other] ** 2) / 2, other);
      if (!faces.length) return { volume: 0, neighbors: new Map() };
    }
  }
  // Nonperiodic walls of the simulation cell (orthogonal fixtures only).
  for (let axis = 0; axis < 3; axis++) if (!frame.cell.pbc[axis]) {
    const length = vectors[axis * 4], normal = [0, 0, 0];
    normal[axis] = 1; faces = clip(faces, normal, length - center[axis], -1);
    normal[axis] = -1; faces = clip(faces, normal, center[axis], -1);
  }
  let volume = 0;
  const neighbors = new Map();
  for (const { polygon, neighbor } of faces) {
    let area = [0, 0, 0];
    for (let index = 1; index + 1 < polygon.length; index++) {
      const cross = crossProduct(polygon[index], polygon[index + 1]);
      volume += (polygon[0][0] * cross[0] + polygon[0][1] * cross[1] + polygon[0][2] * cross[2]) / 6;
      const triangle = crossProduct(subtract(polygon[index], polygon[0]), subtract(polygon[index + 1], polygon[0]));
      area = area.map((value, axis) => value + triangle[axis] / 2);
    }
    if (neighbor >= 0) neighbors.set(neighbor, (neighbors.get(neighbor) ?? 0) + Math.hypot(...area));
  }
  return { volume, neighbors };
}
const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
const crossProduct = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function cube(half) {
  const corner = (x, y, z) => [x * half, y * half, z * half];
  return [[corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1), corner(1, -1, -1)],
    [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
    [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
    [corner(-1, 1, -1), corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1)],
    [corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)],
    [corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(1, -1, 1)]];
}
function clip(faces, normal, offset, neighbor) {
  const output = [], cap = [], distance = point => normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2] - offset;
  for (const { polygon, neighbor: owner } of faces) {
    const kept = [];
    for (let index = 0; index < polygon.length; index++) {
      const first = polygon[index], second = polygon[(index + 1) % polygon.length], a = distance(first), b = distance(second);
      if (a <= 0) kept.push(first);
      if ((a <= 0) !== (b <= 0)) {
        const point = first.map((value, axis) => value + a / (a - b) * (second[axis] - value));
        kept.push(point); cap.push(point);
      }
    }
    if (kept.length >= 3) output.push({ polygon: kept, neighbor: owner });
  }
  if (cap.length >= 3) {
    const middle = [0, 1, 2].map(axis => cap.reduce((sum, point) => sum + point[axis], 0) / cap.length);
    const length = Math.hypot(...normal), unit = normal.map(value => value / length);
    const helper = Math.abs(unit[0]) > .8 ? [0, 1, 0] : [1, 0, 0], u = crossProduct(unit, helper), v = crossProduct(unit, u);
    // (u, v, n) is right handed: counterclockwise about the outward normal n.
    const angle = point => { const relative = subtract(point, middle); return Math.atan2(relative.reduce((sum, value, axis) => sum + value * v[axis], 0),
      relative.reduce((sum, value, axis) => sum + value * u[axis], 0)); };
    output.push({ polygon: cap.sort((a, b) => angle(a) - angle(b)), neighbor });
  }
  return output;
}

test('equal radii reproduce standard Voronoi output and geometry bit for bit', async () => {
  const distorted = crystalFrame('fcc', 3, 3.52);
  distorted.cell = createCell({ vectors: [10.56, .17, -.09, .4, 10.62, .15, -.11, .04, 10.46], triclinic: true });
  for (let index = 0; index < distorted.fractional.length; index++) distorted.fractional[index] += .013 * Math.sin(index * 1.791);
  const mixed = crystalFrame('bcc', 3, 2.86);
  mixed.cell = createCell({ vectors: mixed.cell.vectors, pbc: [true, false, true] });
  const hea = parseLammpsFrame(await readFile(new URL('../examples/hea-fcc-screw.dump', import.meta.url), 'utf8'), 'hea-fcc-screw.dump');
  const cases = [['FCC', crystalFrame('fcc', 3, 3.52), {}], ['HCP', crystalFrame('hcp', 3, 2.5), {}], ['triclinic', distorted, {}],
    ['mixed boundaries', mixed, { faceAreaThreshold: .2, relativeFaceAreaThreshold: .01 }],
    ['HEA example with free surfaces', hea, { startAtom: 0, endAtom: 1500 }]];
  for (const [label, frame, options] of cases) {
    const count = frame.fractional.length / 3;
    for (const radius of [0, 1.37]) {
      const standard = await calculateVoronoi(frame, options), radical = await calculateVoronoi(frame, { ...options, radii: new Float64Array(count).fill(radius) });
      assertIdentical(radical, standard, `${label} r=${radius}`);
      assert.equal(radical.tessellation, 'radical'); assert.equal(radical.summary.emptyCellCount, 0);
      assert.equal(standard.tessellation, undefined, 'standard results keep their previous fields');
      const atomIndex = options.startAtom ?? Math.floor(count / 2);
      const first = await calculateVoronoiGeometry(frame, { atomIndex }), second = await calculateVoronoiGeometry(frame, { atomIndex, radii: new Float64Array(count).fill(radius) });
      for (const field of ['vertices', 'faceOffsets', 'faceVertices', 'faceNeighbors', 'faceBoundary', 'center']) assert.deepEqual(second[field], first[field], `${label} geometry ${field}`);
    }
  }
});

test('two atoms meet on the analytic radical plane, which may leave an atom outside or without its cell', async () => {
  for (const [first, second] of [[1.5, .5], [.5, 1.5], [0, 2], [1.2, 1.2], [0, 4.2]]) {
    const result = await calculateVoronoi(boxFrame([[3, 5, 5], [7, 5, 5]]), { radii: Float64Array.of(first, second) });
    const plane = 3 + (16 + first ** 2 - second ** 2) / 8;
    near(result.atomicVolume[0], plane * 100, `left cell for ${first}/${second}`);
    near(result.atomicVolume[1], (10 - plane) * 100, `right cell for ${first}/${second}`);
    near(result.faceAreas[result.faceOffsets[0] + Array.from(result.faceNeighbors.subarray(0, result.faceOffsets[1])).indexOf(1)], 100, 'shared face area');
    assert.equal(result.voronoiCoordination[0], 1); assert.equal(result.voronoiBoundaryFaces[0], 5);
    near(result.summary.volumeError, 0, 'domain conservation');
  }
  // r₂² > d² + 2d·3 moves the plane behind the left wall: the left cell is empty.
  const empty = await calculateVoronoi(boxFrame([[3, 5, 5], [7, 5, 5]]), { radii: Float64Array.of(0, 6.5) });
  assert.equal(empty.atomicVolume[0], 0); assert.equal(empty.voronoiSurfaceArea[0], 0); assert.equal(empty.voronoiCoordination[0], 0);
  assert.equal(empty.faceOffsets[1], 0); assert.equal(empty.voronoiIndices[0], '<0,0,0,0>');
  near(empty.atomicVolume[1], 1000, 'the dominating cell fills the domain');
  assert.equal(empty.voronoiCoordination[1], 0, 'no face toward the empty site');
  assert.equal(empty.summary.emptyCellCount, 1); assert.equal(empty.emptyCellCount, 1);
});

test('CsCl and NaCl radical volumes follow their analytic polyhedra', async () => {
  const a = 4, large = 1.6, small = 1, cscl = crystalFrame('bcc', 3, a); cscl.typeLabels = ['Cs', 'Cl'];
  for (let atom = 0; atom < cscl.types.length; atom++) cscl.types[atom] = atom % 2;
  const result = await calculateVoronoi(cscl, { radii: voronoiRadiiForTypes(cscl, [{ label: 'Cs', radius: large }, { label: 'Cl', radius: small }]) });
  // The Cs cell is the cube |xᵢ| ≤ a/2 cut by eight radical {111} planes at
  // |x|+|y|+|z| ≤ √3·h, h = (d² + r_Cs² − r_Cl²)/(2d), d = a√3/2.
  const d = a * Math.sqrt(3) / 2, h = (d * d + large ** 2 - small ** 2) / (2 * d), t = 3 * a / 2 - Math.sqrt(3) * h;
  const corner = t ** 3 / 6 - 3 * Math.max(0, t - a / 2) ** 3 / 6, cesium = a ** 3 - 8 * corner;
  for (let atom = 0; atom < cscl.types.length; atom++) {
    near(result.atomicVolume[atom], atom % 2 ? a ** 3 - cesium : cesium, `CsCl atom ${atom}`, 1e-9);
    assert.equal(result.voronoiCoordination[atom], 14); assert.equal(result.voronoiIndices[atom], '<0,6,0,8>');
  }
  const standard = await calculateVoronoi(cscl);
  assert.ok(result.atomicVolume[0] > standard.atomicVolume[0] && result.atomicVolume[1] < standard.atomicVolume[1], 'the larger ion gains volume');
  const spacing = 2.82, sodium = 1.02, chloride = 1.81, rock = crystalFrame('sc', 4, spacing); rock.typeLabels = ['Na', 'Cl'];
  for (let atom = 0; atom < rock.types.length; atom++) rock.types[atom] = Math.round(4 * (rock.fractional[atom * 3] + rock.fractional[atom * 3 + 1] + rock.fractional[atom * 3 + 2])) % 2;
  const salt = await calculateVoronoi(rock, { radii: voronoiRadiiForTypes(rock, [{ label: 'Na', radius: sodium }, { label: 'Cl', radius: chloride }]) });
  // The smaller ion keeps the cube bounded by its six radical {100} faces.
  const halfWidth = (spacing ** 2 + sodium ** 2 - chloride ** 2) / (2 * spacing);
  for (let atom = 0; atom < rock.types.length; atom++) {
    near(salt.atomicVolume[atom], rock.types[atom] ? 2 * spacing ** 3 - (2 * halfWidth) ** 3 : (2 * halfWidth) ** 3, `NaCl atom ${atom}`, 1e-9);
  }
  assert.ok(salt.voronoiCoordination.every((value, atom) => rock.types[atom] ? value > 6 : value === 6));
  near(salt.summary.volumeError, 0, 'NaCl domain conservation');
});

test('radical cells beyond the unweighted 2R bound match an independent half-space reference', async () => {
  // A large solute in a small-atom lattice cuts cells from beyond twice their
  // farthest vertex and empties its nearest neighbors.
  const lattice = crystalFrame('sc', 4, 2), radii = new Float64Array(64).fill(.5); radii[21] = 3.2;
  const result = await calculateVoronoi(lattice, { radii });
  let reached = 0;
  for (let atom = 0; atom < 64; atom++) {
    const reference = bruteForceRadical(lattice, radii, atom);
    near(result.atomicVolume[atom], reference.volume, `atom ${atom} volume`, 1e-9);
    const faces = new Map();
    for (let face = result.faceOffsets[atom]; face < result.faceOffsets[atom + 1]; face++) {
      faces.set(result.faceNeighbors[face], (faces.get(result.faceNeighbors[face]) ?? 0) + result.faceAreas[face]);
    }
    for (const [neighbor, area] of reference.neighbors) if (area > 1e-9) near(faces.get(neighbor) ?? 0, area, `atom ${atom} face to ${neighbor}`, 1e-8);
    if (reference.neighbors.has(21) && atom !== 21) {
      const distance = Math.min(...[-1, 0, 1].flatMap(a => [-1, 0, 1].flatMap(b => [-1, 0, 1].map(c => Math.hypot(
        ...[0, 1, 2].map(axis => (lattice.fractional[21 * 3 + axis] - lattice.fractional[atom * 3 + axis] + [a, b, c][axis]) * 8))))));
      if (distance > 2 * Math.sqrt(3) * (1 + 1e-9)) reached++;
    }
  }
  assert.ok(reached > 0, 'the solute cuts cells farther than the unweighted completeness bound');
  assert.ok(result.summary.emptyCellCount > 0, 'the solute empties adjacent cells');
  near(result.summary.volumeError, 0, 'radical domain conservation');
  // Triclinic periodic and finite-domain random radii.
  const skew = crystalFrame('fcc', 2, 3.52);
  skew.cell = createCell({ vectors: [7.04, .37, -.19, .4, 7.12, .25, -.21, .14, 6.96], triclinic: true });
  for (let index = 0; index < skew.fractional.length; index++) skew.fractional[index] += .02 * Math.sin(index * 2.17);
  const random = Float64Array.from({ length: 32 }, (_, atom) => .9 + .6 * Math.abs(Math.sin(atom * 1.3)));
  const skewed = await calculateVoronoi(skew, { radii: random });
  for (let atom = 0; atom < 32; atom++) near(skewed.atomicVolume[atom], bruteForceRadical(skew, random, atom, 2).volume, `triclinic atom ${atom}`, 1e-9);
  near(skewed.summary.volumeError, 0, 'triclinic conservation');
  const open = boxFrame([[2.2, 3.1, 4.4], [6.3, 2.9, 5.1], [4.1, 7.2, 3.3], [7.7, 7.4, 6.6], [3.3, 4.8, 8.1], [5.2, 5.1, 5.3]]);
  const openRadii = Float64Array.of(1.4, .3, 2.2, 0, 1.1, 1.9), finite = await calculateVoronoi(open, { radii: openRadii });
  for (let atom = 0; atom < 6; atom++) near(finite.atomicVolume[atom], bruteForceRadical(open, openRadii, atom).volume, `finite atom ${atom}`, 1e-9);
});

test('radical face areas are reciprocal and every neighbor pair shares one interface', async () => {
  const frame = crystalFrame('bcc', 3, 2.86);
  for (let index = 0; index < frame.fractional.length; index++) frame.fractional[index] += .01 * Math.cos(index * 3.1);
  const radii = Float64Array.from({ length: 54 }, (_, atom) => 1 + .4 * Math.abs(Math.sin(atom * .7)));
  const result = await calculateVoronoi(frame, { radii }), sums = new Map();
  for (let atom = 0; atom < 54; atom++) for (let face = result.faceOffsets[atom]; face < result.faceOffsets[atom + 1]; face++) {
    const key = [atom, result.faceNeighbors[face]].sort((a, b) => a - b).join(':'), entry = sums.get(key) ?? [0, 0];
    entry[atom < result.faceNeighbors[face] ? 0 : 1] += result.faceAreas[face]; sums.set(key, entry);
  }
  for (const [key, [first, second]] of sums) if (!key.split(':').every((value, _, values) => value === values[0])) near(first, second, `interface ${key}`, 1e-9);
});

test('radii are validated, compacted with type subsets and fingerprinted', async () => {
  const frame = crystalFrame('bcc', 2, 3); frame.typeLabels = ['A', 'B'];
  for (let atom = 0; atom < 16; atom++) frame.types[atom] = atom % 2;
  for (const radii of [new Float64Array(15).fill(1), Float64Array.of(...new Array(15).fill(1), -1), Float64Array.of(...new Array(15).fill(1), NaN),
    Float64Array.of(...new Array(15).fill(1), Infinity)]) {
    await assert.rejects(calculateVoronoi(frame, { radii }), /Radical Voronoi/);
  }
  assert.throws(() => validateVoronoiRadii('1,2', 2), /numeric array/);
  const radii = Float64Array.from({ length: 16 }, (_, atom) => atom % 2 ? 1 : 1.4);
  radii[1] = NaN; // excluded atoms need no valid radius
  const subset = await calculateVoronoi(frame, { radii, selectedTypes: ['A'] });
  const selection = prepareVoronoiSelection(frame, ['A']);
  const compact = await calculateVoronoi(selection.frame, { radii: compactVoronoiRadii(radii, selection) });
  for (let index = 0; index < 8; index++) assert.ok(Object.is(subset.atomicVolume[index * 2], compact.atomicVolume[index]));
  assert.ok(Number.isNaN(subset.atomicVolume[1]));
  assert.equal(compactVoronoiRadii(null, selection), null);
  assert.throws(() => compactVoronoiRadii(new Float64Array(3), selection), /one radius per source atom/);
  assert.notEqual(voronoiRadiiFingerprint(Float64Array.of(1, 2)), voronoiRadiiFingerprint(Float64Array.of(2, 1)));
  assert.equal(voronoiRadiiFingerprint(Float64Array.of(1, 2)), voronoiRadiiFingerprint([1, 2]));
  assert.equal(voronoiRadiiFingerprint(null), null);
  assert.equal(radicalReach(1.5, 0), 3, 'equal radii keep the 2R bound');
  near(radicalReach(1, 3), 3, 'R + √(R² + Δ)');
  assert.throws(() => voronoiRadiiForTypes({ fractional: new Float64Array(3), types: Uint16Array.of(4), typeLabels: ['A'] }), /labeled type/);
});

test('radical cell geometry carries actual neighbor image vectors and skips empty cells', async () => {
  const frame = crystalFrame('bcc', 3, 4), radii = Float64Array.from({ length: 54 }, (_, atom) => atom % 2 ? 1 : 1.6);
  const geometry = await calculateVoronoiGeometry(frame, { atomIndex: 0, radii });
  assert.equal(geometry.faceNeighbors.length, 14);
  for (let face = 0; face < 14; face++) {
    const vector = geometry.neighborVectors.subarray(face * 3, face * 3 + 3), distance = Math.hypot(...vector);
    near(distance, geometry.faceNeighbors[face] % 2 ? 2 * Math.sqrt(3) : 4, `face ${face} image distance`, 1e-12);
    // Every face vertex lies on that neighbor's radical plane.
    const plane = (distance ** 2 + radii[0] ** 2 - radii[geometry.faceNeighbors[face]] ** 2) / 2;
    for (let corner = geometry.faceOffsets[face]; corner < geometry.faceOffsets[face + 1]; corner++) {
      const vertex = geometry.vertices.subarray(geometry.faceVertices[corner] * 3, geometry.faceVertices[corner] * 3 + 3);
      near(vertex[0] * vector[0] + vertex[1] * vector[1] + vertex[2] * vector[2], plane, 'vertex on radical plane', 1e-9);
    }
  }
  // The display uses the image vectors, not twice the plane distance.
  const mesh = createVoronoiCellMesh(geometry, { shared: true });
  assert.ok(mesh.edges.length > 0);
  const standard = await calculateVoronoiGeometry(frame, { atomIndex: 0 });
  assert.equal(standard.neighborVectors, undefined);
  const crowded = crystalFrame('bcc', 3, 3), crowdedRadii = Float64Array.from({ length: 54 }, (_, atom) => atom % 2 ? 0 : 2.6);
  const empty = await calculateVoronoiGeometry(crowded, { atomIndex: 1, radii: crowdedRadii });
  assert.equal(empty.empty, true); assert.equal(empty.faceOffsets.length, 1); assert.equal(empty.vertices.length, 0);
  const batch = await calculateVoronoiGeometryBatch(crowded, { radii: crowdedRadii });
  assert.equal(batch.cells.length, 27); assert.equal(batch.emptyCellCount, 27);
  assert.ok(batch.cells.every(cell => cell.atomIndex % 2 === 0));
});

function nodeFactory(messages) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transferables) { messages.push(data); worker.postMessage(data, transferables); }, terminate() { worker.terminate(); } };
  };
}

test('parallel radical workers equal the direct kernel and keep identical radii resident', async () => {
  const messages = [], pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 } }, workerFactory: nodeFactory(messages) });
  const frame = crystalFrame('bcc', 6, 4); frame.typeLabels = ['Cs', 'Cl'];
  for (let atom = 0; atom < frame.types.length; atom++) frame.types[atom] = atom % 2;
  frame.fractional[0] += .002;
  const radii = Float64Array.from(frame.types, type => type ? 1 : 1.6);
  try {
    const direct = await calculateVoronoi(frame, { radii, bins: 31 });
    const first = await pool.analyze(frame, { kind: 'voronoi', radii, bins: 31 });
    assertIdentical(first, direct, 'pool');
    assert.deepEqual(first.summary, direct.summary); assert.deepEqual(first.volumeHistogram, direct.volumeHistogram);
    assert.equal(first.tessellation, 'radical'); assert.equal(first.emptyCellCount, 0);
    const sent = messages.filter(message => message.kind === 'voronoi' && message.radii).length;
    assert.ok(sent >= 1 && sent <= first.workerCount, 'each Worker receives the radii at most once');
    messages.length = 0;
    const second = await pool.analyze(frame, { kind: 'voronoi', radii: radii.slice(), bins: 31 });
    assertIdentical(second, direct, 'repeated pool');
    assert.equal(messages.filter(message => message.radii).length, 0, 'unchanged radii stay resident');
    const standard = await pool.analyze(frame, { kind: 'voronoi', bins: 31 });
    assertIdentical(standard, await calculateVoronoi(frame, { bins: 31 }), 'standard after radical');
    assert.equal(standard.tessellation, undefined);
    const changed = radii.slice(); changed[3] = 1.2;
    assertIdentical(await pool.analyze(frame, { kind: 'voronoi', radii: changed, bins: 31 }), await calculateVoronoi(frame, { radii: changed, bins: 31 }), 'changed radii');
    const subset = await pool.analyze(frame, { kind: 'voronoi', radii, selectedTypes: ['Cs'] });
    const directSubset = await calculateVoronoi(frame, { radii, selectedTypes: ['Cs'] });
    for (let atom = 0; atom < frame.types.length; atom++) assert.ok(Object.is(subset.atomicVolume[atom], directSubset.atomicVolume[atom]));
    const geometry = await pool.analyze(frame, { kind: 'voronoiGeometry', atomIndex: 1, radii });
    assert.deepEqual(geometry.vertices, (await calculateVoronoiGeometry(frame, { atomIndex: 1, radii })).vertices);
    const crowded = crystalFrame('bcc', 4, 3), crowdedRadii = Float64Array.from({ length: 128 }, (_, atom) => atom % 2 ? 0 : 2.6);
    const empty = await pool.analyze(crowded, { kind: 'voronoi', radii: crowdedRadii });
    assert.equal(empty.summary.emptyCellCount, 64); near(empty.summary.volumeError, 0, 'pool conservation');
    const batch = await pool.analyze(crowded, { kind: 'voronoiGeometryBatch', radii: crowdedRadii });
    assert.equal(batch.cells.length, 64); assert.equal(batch.emptyCellCount, 64);
    await assert.rejects(pool.analyze(frame, { kind: 'voronoi', radii: radii.subarray(1) }), /one radius per source atom/);
  } finally { pool.close(); }
});
