import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVoronoi, calculateVoronoiGeometry } from '../src/analysis/voronoi.js';
import { createVoronoiCellMesh, VoronoiCellLayer } from '../src/render/voronoi-cell-layer.js';
import { createCell } from '../src/data/model.js';

const points = [[.079, .184, .727], [.342, .781, .091], [.674, .382, .523],
  [.928, .864, .217], [.164, .538, .837], [.743, .153, .952], [.418, .427, .338]];
const vectors = [1.9, .2, .1, .6, 1.4, .2, -.1, .3, 1.7];

function frame(matrix = vectors, pbc = [true, true, true], origin = [0, 0, 0]) {
  return { fractional: Float64Array.from(points.flat()), cell: createCell({ vectors: matrix, pbc, origin }) };
}

function near(actual, expected, message, tolerance = 2e-10) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} ≈ ${expected}`);
}

function faceRecords(result, atom, factor = 1) {
  const records = [];
  for (let face = result.faceOffsets[atom]; face < result.faceOffsets[atom + 1]; face++) {
    records.push({ neighbor: result.faceNeighbors[face], order: result.faceOrders[face],
      boundary: result.faceBoundary[face], area: result.faceAreas[face] / factor });
  }
  return records.sort((a, b) => a.neighbor - b.neighbor || a.order - b.order || a.area - b.area);
}

test('Voronoi measures and every individual face remain invariant under rigid rotation and origin translation', async () => {
  // An exact proper rotation cycles Cartesian axes. Fractions, finite-domain
  // boundaries and periodic self images remain the same sites in a rotated cell.
  const rotated = vectors.flatMap((_value, index) => index % 3 ? []
    : [vectors[index + 2], vectors[index], vectors[index + 1]]);
  for (const pbc of [[true, true, true], [true, false, true], [false, false, false]]) {
    const source = frame(vectors, pbc), original = source.fractional.slice();
    const first = await calculateVoronoi(source), second = await calculateVoronoi(frame(rotated, pbc, [1234, -91, .714]));
    assert.deepEqual(source.fractional, original);
    assert.deepEqual(second.voronoiCoordination, first.voronoiCoordination);
    assert.deepEqual(second.voronoiBoundaryFaces, first.voronoiBoundaryFaces);
    assert.deepEqual(second.voronoiIndices, first.voronoiIndices);
    for (let atom = 0; atom < points.length; atom++) {
      near(second.atomicVolume[atom], first.atomicVolume[atom], `atom ${atom} volume`);
      near(second.voronoiSurfaceArea[atom], first.voronoiSurfaceArea[atom], `atom ${atom} surface`);
      const expected = faceRecords(first, atom), actual = faceRecords(second, atom);
      assert.equal(actual.length, expected.length);
      for (let face = 0; face < actual.length; face++) {
        assert.deepEqual([actual[face].neighbor, actual[face].order, actual[face].boundary],
          [expected[face].neighbor, expected[face].order, expected[face].boundary]);
        near(actual[face].area, expected[face].area, `atom ${atom} face ${face}`);
      }
    }
    near(second.summary.volumeError, 0, 'domain conservation');
  }
});

test('uniform length scaling preserves Voronoi topology and scales areas and volumes dimensionally', async () => {
  const scale = 7.25, areaScale = scale ** 2, volumeScale = scale ** 3;
  const first = await calculateVoronoi(frame(), { relativeFaceAreaThreshold: .015, faceAreaThreshold: .006 });
  const second = await calculateVoronoi(frame(vectors.map(value => value * scale)),
    { relativeFaceAreaThreshold: .015, faceAreaThreshold: .006 * areaScale });
  assert.deepEqual(second.voronoiCoordination, first.voronoiCoordination);
  assert.deepEqual(second.voronoiIndices, first.voronoiIndices);
  for (let atom = 0; atom < points.length; atom++) {
    near(second.atomicVolume[atom] / volumeScale, first.atomicVolume[atom], `atom ${atom} volume`);
    near(second.voronoiSurfaceArea[atom] / areaScale, first.voronoiSurfaceArea[atom], `atom ${atom} surface`);
    const actual = faceRecords(second, atom, areaScale), expected = faceRecords(first, atom);
    assert.equal(actual.length, expected.length);
    actual.forEach((face, index) => near(face.area, expected[index].area, `atom ${atom} face ${index}`));
  }
  near(second.summary.volumeError, 0, 'scaled domain conservation');
});

test('every periodic atomic interface has the same polygon-order population from its two adjacent cells', async () => {
  const result = await calculateVoronoi(frame());
  const interfaces = new Map();
  for (let atom = 0; atom < points.length; atom++) {
    for (let face = result.faceOffsets[atom]; face < result.faceOffsets[atom + 1]; face++) {
      assert.equal(result.faceBoundary[face], 0);
      const key = `${atom}:${result.faceNeighbors[face]}:${result.faceOrders[face]}`;
      const values = interfaces.get(key) ?? [];
      values.push(result.faceAreas[face]); interfaces.set(key, values);
    }
  }
  for (const [key, areas] of interfaces) {
    const [first, second, order] = key.split(':'), other = interfaces.get(`${second}:${first}:${order}`);
    assert.ok(other, `missing reciprocal interface ${key}`);
    assert.equal(other.length, areas.length, `reciprocal ${order}-gon count for ${first}/${second}`);
    areas.sort((a, b) => a - b); other.sort((a, b) => a - b);
    areas.forEach((area, index) => near(area, other[index], `reciprocal ${key} face ${index}`));
  }
});

function triangleMeasures(a, b, c) {
  const ab = b.map((value, axis) => value - a[axis]), ac = c.map((value, axis) => value - a[axis]);
  const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0]];
  return { normal, area: Math.hypot(...normal) / 2, signedVolume: normal.reduce((sum, value, axis) => sum + value * a[axis], 0) / 6 };
}

test('selected-cell polygon meshes are closed convex polyhedra with exact scientific volume and surface area', async () => {
  const cases = [[true, true, true], [true, false, true], [false, false, false]]
    .map(pbc => ({ input: frame(vectors, pbc, [32, -17, .125]), atoms: [0, 3, 6] }));
  // The local atom origin lies on the x=0 face, so dot(normal, vertex)
  // cannot distinguish inward/outward winding on that boundary polygon.
  cases.push({ input: { fractional: Float64Array.from([0, .5, .5]),
    cell: createCell({ vectors: [2, 0, 0, 0, 2, 0, 0, 0, 2], pbc: [false, false, false] }) }, atoms: [0] });
  for (const { input, atoms } of cases) {
    const result = await calculateVoronoi(input);
    for (const atomIndex of atoms) {
      const geometry = await calculateVoronoiGeometry(input, { atomIndex });
      const vertexCount = geometry.vertices.length / 3, faceCount = geometry.faceOffsets.length - 1;
      assert.equal(faceCount, result.faceOffsets[atomIndex + 1] - result.faceOffsets[atomIndex]);
      const usedVertices = new Set(), edges = new Map(); let area = 0, volume = 0;
      for (let face = 0; face < faceCount; face++) {
        const corners = Array.from(geometry.faceVertices.subarray(geometry.faceOffsets[face], geometry.faceOffsets[face + 1]));
        assert.ok(corners.length >= 3);
        const sourceFace = result.faceOffsets[atomIndex] + face;
        assert.equal(corners.length, result.faceOrders[sourceFace]);
        assert.equal(geometry.faceNeighbors[face], result.faceNeighbors[sourceFace]);
        assert.equal(geometry.faceBoundary[face], result.faceBoundary[sourceFace]);
        let faceArea = 0;
        const a = Array.from(geometry.vertices.subarray(corners[0] * 3, corners[0] * 3 + 3));
        for (let corner = 1; corner + 1 < corners.length; corner++) {
          const b = Array.from(geometry.vertices.subarray(corners[corner] * 3, corners[corner] * 3 + 3));
          const c = Array.from(geometry.vertices.subarray(corners[corner + 1] * 3, corners[corner + 1] * 3 + 3));
          const measures = triangleMeasures(a, b, c);
          faceArea += measures.area; volume += Math.abs(measures.signedVolume);
        }
        near(faceArea, result.faceAreas[sourceFace], `atom ${atomIndex} face ${face} area`); area += faceArea;
        for (let corner = 0; corner < corners.length; corner++) {
          const first = corners[corner], second = corners[(corner + 1) % corners.length];
          assert.ok(first >= 0 && first < vertexCount); usedVertices.add(first);
          const key = [first, second].sort((a, b) => a - b).join(':');
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      assert.equal(usedVertices.size, vertexCount, 'no orphaned geometric vertices');
      assert.ok([...edges.values()].every(count => count === 2), 'every cell edge belongs to exactly two polygon faces');
      assert.equal(vertexCount - edges.size + faceCount, 2, 'Euler characteristic of a convex closed cell');
      near(volume, result.atomicVolume[atomIndex], `atom ${atomIndex} tessellation volume`);
      near(area, result.voronoiSurfaceArea[atomIndex], `atom ${atomIndex} tessellation surface`);
      // The rendering conversion duplicates polygon corners to retain flat
      // normals, then adds unique outline segments. Triangle winding must point
      // away from an interior point without changing the exact polygons,
      // including atoms lying exactly on a nonperiodic cell boundary.
      const mesh = createVoronoiCellMesh(geometry);
      const interior = [0, 0, 0];
      geometry.vertices.forEach((value, index) => { interior[index % 3] += value / vertexCount; });
      let renderedVolume = 0;
      for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
        const corners = Array.from(mesh.indices.subarray(triangle, triangle + 3), index => Array.from(mesh.values.subarray(index * 6, index * 6 + 3)));
        const measures = triangleMeasures(...corners);
        const outward = corners[0].map((value, axis) => value - interior[axis]);
        assert.ok(measures.normal.reduce((sum, value, axis) => sum + value * outward[axis], 0) > 0,
          'rendered cell triangle winds away from the vertex centroid');
        for (const index of mesh.indices.subarray(triangle, triangle + 3)) {
          const normal = mesh.values.subarray(index * 6 + 3, index * 6 + 6);
          assert.ok(normal.reduce((sum, value, axis) => sum + value * outward[axis], 0) > 0,
            'each rendered triangle normal points away from the vertex centroid');
          assert.ok(normal.reduce((sum, value, axis) => sum + value * measures.normal[axis], 0) > 0,
            'stored normals agree with triangle winding');
        }
        renderedVolume += measures.signedVolume;
      }
      near(renderedVolume, result.atomicVolume[atomIndex], `atom ${atomIndex} rendered volume`, 2e-7);
      assert.equal(mesh.edgeCount, edges.size * 2, 'each unique edge supplies two outline endpoints');
    }
  }
});

test('selected-cell vertices stay local when periodic atoms are unwrapped by lattice translations', async () => {
  const input = frame(), atomIndex = 2;
  const original = await calculateVoronoiGeometry(input, { atomIndex });
  const shifted = { ...input, fractional: input.fractional.slice(), cell: createCell({ vectors, origin: [56, -14, 81] }) };
  for (let atom = 0; atom < points.length; atom++) for (let axis = 0; axis < 3; axis++) {
    shifted.fractional[atom * 3 + axis] += [3, -4, 2][axis];
  }
  const moved = await calculateVoronoiGeometry(shifted, { atomIndex });
  assert.deepEqual(moved.faceOffsets, original.faceOffsets);
  assert.deepEqual(moved.faceVertices, original.faceVertices);
  for (let index = 0; index < original.vertices.length; index++) near(moved.vertices[index], original.vertices[index], `local vertex ${index}`);
  for (let axis = 0; axis < 3; axis++) near(moved.center[axis] - shifted.cell.origin[axis], original.center[axis], `wrapped cell center ${axis}`);
});

test('a nearly tangent diagonal neighbor retains its real triangular face and analytic corner-cut volume', async () => {
  // Six neighbors define [-1,1]^3 about the central atom. A diagonal site at
  // (2-epsilon)^3 cuts a tetrahedron with three axis edges 1.5*epsilon. Its
  // triangular face is physically real even when its area is below 1e-11.
  for (const epsilon of [.001, .00001, .000001]) {
    const points = [[5, 5, 5], [7, 5, 5], [3, 5, 5], [5, 7, 5], [5, 3, 5], [5, 5, 7],
      [5, 5, 3], [7 - epsilon, 7 - epsilon, 7 - epsilon]];
    const input = { fractional: Float64Array.from(points.flat(), value => value / 10),
      cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
    const result = await calculateVoronoi(input, { endAtom: 1 });
    const edge = 1.5 * epsilon, capArea = Math.sqrt(3) / 2 * edge ** 2;
    assert.equal(result.voronoiCoordination[0], 7);
    assert.equal(result.voronoiIndices[0], '<1,3,3,0>');
    const cap = result.faceNeighbors.findIndex(neighbor => neighbor === 7);
    assert.ok(cap >= 0); assert.equal(result.faceOrders[cap], 3);
    assert.ok(Math.abs(result.faceAreas[cap] - capArea) < capArea * 2e-5, `tiny real face ${result.faceAreas[cap]} ≈ ${capArea}`);
    near(result.atomicVolume[0], 8 - edge ** 3 / 6, 'analytic truncated cube volume');
    near(result.voronoiSurfaceArea[0], 24 + (Math.sqrt(3) - 3) / 2 * edge ** 2, 'analytic truncated cube area');
  }
});

test('selected-cell camera bounds include faces outside the simulation box and follow displayed origin and replicas', async () => {
  const input = { fractional: new Float64Array(3), cell: createCell({ vectors: [2, 0, 0, 0, 2, 0, 0, 0, 2] }) };
  const geometry = await calculateVoronoiGeometry(input, { atomIndex: 0 });
  const layer = { geometry, options: { enabled: true } };
  const renderer = { atomCount: 1, displayPositions: new Float64Array(3),
    minimumOffset: [0, 0, 0], maximumOffset: [2, 0, 4] };
  const minimum = [0, 0, 0], maximum = [4, 2, 6];
  VoronoiCellLayer.prototype.extendBounds.call(layer, renderer, minimum, maximum);
  minimum.forEach(value => near(value, -1, 'periodic site cell extends beyond origin'));
  assert.deepEqual(maximum, [4, 2, 6]);
  // A shifted periodic display origin wraps the same atom to x=1.5. Local
  // geometry stays unchanged while the upper cell face reaches x=2.5.
  renderer.displayPositions[0] = 1.5;
  const movedMinimum = [0, 0, 0], movedMaximum = [4, 2, 6];
  VoronoiCellLayer.prototype.extendBounds.call(layer, renderer, movedMinimum, movedMaximum);
  near(movedMaximum[0], 4.5, 'replicated translated polyhedron bound');
  assert.deepEqual(movedMinimum, [0, -1, -1]);
  assert.equal(geometry.atomIndex, 0); assert.equal(geometry.center[0], 0);
  layer.options.enabled = false;
  const disabledMinimum = [0, 0, 0], disabledMaximum = [4, 2, 6];
  VoronoiCellLayer.prototype.extendBounds.call(layer, renderer, disabledMinimum, disabledMaximum);
  assert.deepEqual(disabledMinimum, [0, 0, 0]); assert.deepEqual(disabledMaximum, [4, 2, 6]);
});
