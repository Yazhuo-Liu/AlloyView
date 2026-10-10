import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell } from '../src/data/model.js';
import { MESH_EXPORT_FORMATS, createMeshExport, exportTriangles, meshToObj, meshToPly, meshToStl } from '../src/io/mesh-export.js';
import {
  buildSurfaceDisplayMesh, displayMeshArea, displayMeshOpenEdges, displayMeshVolume, surfaceMeshArea, triangulateLoops,
} from '../src/render/surface-mesh-geometry.js';

const near = (value, expected, tolerance = 1e-9, message = '') => assert.ok(Math.abs(value - expected) <= tolerance * Math.max(1, Math.abs(expected)),
  `${message} ${value} != ${expected}`);
const boundsNear = (display, minimum, maximum) => {
  for (let axis = 0; axis < 3; axis += 1) { near(display.minimum[axis], minimum[axis], 1e-12, 'minimum'); near(display.maximum[axis], maximum[axis], 1e-12, 'maximum'); }
};

/** A box [low, high] with outward faces: 8 vertices, 12 triangles. */
function boxMesh(low, high) {
  const vertices = [];
  for (let corner = 0; corner < 8; corner += 1) vertices.push(corner & 1 ? high[0] : low[0], corner & 2 ? high[1] : low[1], corner & 4 ? high[2] : low[2]);
  const quads = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
  const triangles = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return { vertices: Float64Array.from(vertices), triangles: Uint32Array.from(triangles) };
}

function polygonArea(pu, pv, triangles) {
  let area = 0;
  for (let index = 0; index < triangles.length; index += 3) {
    const [a, b, c] = [triangles[index], triangles[index + 1], triangles[index + 2]];
    const signed = ((pu[b] - pu[a]) * (pv[c] - pv[a]) - (pv[b] - pv[a]) * (pu[c] - pu[a])) / 2;
    assert.ok(signed > 0, 'cap triangles are counterclockwise and not degenerate');
    area += signed;
  }
  return area;
}

test('loops are triangulated with holes, islands in holes and concave outlines, using only their points', () => {
  // Unit square with a square hole, an island inside the hole, and a separate L shape.
  const pu = [0, 4, 4, 0, 1, 1, 3, 3, 1.5, 2.5, 2.5, 1.5, 6, 9, 9, 8, 8, 6];
  const pv = [0, 0, 4, 4, 1, 3, 3, 1, 1.5, 1.5, 2.5, 2.5, 0, 0, 3, 3, 1, 1];
  const loops = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15, 16, 17]];
  const triangles = triangulateLoops(pu, pv, loops);
  near(polygonArea(pu, pv, triangles), 16 - 4 + 1 + 5);
  assert.ok(triangles.every(point => point < pu.length));
  assert.equal(triangles.length / 3, (4 + 4 + 2 - 2) + 2 + 4, 'n − 2 triangles per ring, two more per bridged hole');
  // Two holes whose rightmost points see each other past the first bridge.
  const u = [0, 10, 10, 0, 2, 2, 4, 4, 6, 6, 8, 8], v = [0, 0, 6, 6, 2, 4, 4, 2, 2, 4, 4, 2];
  near(polygonArea(u, v, triangulateLoops(u, v, [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]])), 60 - 8);
  // A comb: many reflex corners.
  const combU = [0], combV = [0];
  for (let tooth = 0; tooth < 6; tooth += 1) { combU.push(tooth + 1, tooth + 1, tooth + 0.5, tooth + 0.5); combV.push(0, 3, 3, 1); }
  combU.push(0); combV.push(3);
  const comb = triangulateLoops(combU, combV, [combU.map((_, index) => index).filter(index => index !== 0 || true)]);
  assert.ok(comb.length > 0);
  // A hole without a surrounding solid loop, a degenerate loop and a repeated point are ignored.
  assert.deepEqual(triangulateLoops(pu, pv, [[4, 5, 6, 7]]), []);
  assert.deepEqual(triangulateLoops([0, 1, 2], [0, 0, 0], [[0, 1, 2]]), []);
  near(polygonArea([0, 1, 1, 1, 0], [0, 0, 0, 1, 1], triangulateLoops([0, 1, 1, 1, 0], [0, 0, 0, 1, 1], [[0, 1, 2, 3, 4]])), 1);
  // Collinear points on an outline stay vertices of the triangulation.
  const withMidpoints = triangulateLoops([0, 1, 2, 2, 2, 1, 0, 0], [0, 0, 0, 1, 2, 2, 2, 1], [[0, 1, 2, 3, 4, 5, 6, 7]]);
  near(polygonArea([0, 1, 2, 2, 2, 1, 0, 0], [0, 0, 0, 1, 2, 2, 2, 1], withMidpoints), 4);
  assert.deepEqual([...new Set(withMidpoints)].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('a box inside the cell is drawn unchanged; a box across a periodic face is cut and capped', () => {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const inside = buildSurfaceDisplayMesh(boxMesh([2, 3, 4], [5, 7, 6]), cell);
  assert.equal(inside.surfaceIndexCount, 36);
  assert.equal(inside.capRanges.length, 0);
  near(displayMeshVolume(inside), 3 * 4 * 2);
  near(displayMeshArea(inside), 2 * (12 + 6 + 8));
  boundsNear(inside, [2, 3, 4], [5, 7, 6]);
  assert.equal(displayMeshOpenEdges(inside), 0);
  // The same box reaching 2 Å beyond the upper a face. Mesh vertices are
  // stored wrapped, as atom positions are: x = 8 and x = 12 − 10 = 2.
  const crossing = boxMesh([8, 3, 4], [12, 7, 6]);
  for (let vertex = 0; vertex < 8; vertex += 1) if (crossing.vertices[vertex * 3] > 10) crossing.vertices[vertex * 3] -= 10;
  near(surfaceMeshArea(crossing, cell), 2 * (16 + 8 + 8), 1e-12, 'minimum-image area');
  const display = buildSurfaceDisplayMesh(crossing, cell);
  assert.deepEqual(display.capRanges.map(range => [range.axis, range.side]), [[0, 0], [0, 1]]);
  near(displayMeshArea(display, 0, display.surfaceIndexCount), 2 * (16 + 8 + 8));
  for (const range of display.capRanges) near(displayMeshArea(display, range.first, range.count), 4 * 2, 1e-12, 'cap is the 4 × 2 cross section');
  near(displayMeshVolume(display), 4 * 4 * 2);
  assert.equal(displayMeshOpenEdges(display), 0);
  boundsNear(display, [0, 3, 4], [10, 7, 6]);
  // Normals: smooth on the surface, exactly ∓a on the two caps.
  for (const range of display.capRanges) {
    const vertex = display.indices[range.first];
    assert.deepEqual(Array.from(display.normals.subarray(vertex * 3, vertex * 3 + 3)), [range.side ? 1 : -1, 0, 0]);
  }
  // A display origin of 0.5 a moves the cut into the cell interior: no caps.
  const shifted = buildSurfaceDisplayMesh(crossing, cell, { origin: [0.5, 0, 0] });
  assert.equal(shifted.capRanges.length, 0);
  boundsNear(shifted, [3, 3, 4], [7, 7, 6]);
  near(displayMeshVolume(shifted), 32);
  // An open axis is neither wrapped nor capped, and ignores the origin there.
  const open = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, true, true] });
  const free = buildSurfaceDisplayMesh(boxMesh([8, 3, 4], [12, 7, 6]), open, { origin: [0.5, 0, 0] });
  assert.equal(free.capRanges.length, 0);
  boundsNear(free, [8, 3, 4], [12, 7, 6]);
  assert.throws(() => buildSurfaceDisplayMesh(crossing, cell, { origin: [0, NaN, 0] }), /origin/);
  assert.throws(() => buildSurfaceDisplayMesh({ vertices: new Float64Array(9), triangles: Uint32Array.of(0, 1, 3) }, cell), /missing vertex/);
});

test('a box across an edge and a corner of the cell is closed by caps on every crossed face', () => {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const wrap = mesh => { for (let index = 0; index < mesh.vertices.length; index += 1) mesh.vertices[index] -= 10 * Math.floor(mesh.vertices[index] / 10); return mesh; };
  const edge = buildSurfaceDisplayMesh(wrap(boxMesh([8, 9, 4], [12, 11, 6])), cell);
  assert.deepEqual(edge.capRanges.map(range => [range.axis, range.side]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
  near(displayMeshVolume(edge), 4 * 2 * 2);
  assert.equal(displayMeshOpenEdges(edge), 0);
  near(displayMeshArea(edge, edge.surfaceIndexCount, edge.capIndexCount), 2 * (2 * 2) + 2 * (4 * 2));
  const corner = buildSurfaceDisplayMesh(wrap(boxMesh([8, 9, 7], [12, 11, 12])), cell);
  assert.equal(corner.capRanges.length, 6);
  near(displayMeshVolume(corner), 4 * 2 * 5);
  assert.equal(displayMeshOpenEdges(corner), 0);
  near(displayMeshArea(corner, corner.surfaceIndexCount, corner.capIndexCount), 2 * (2 * 5 + 4 * 5 + 4 * 2));
});

test('a reversed mesh is the solid outside the box: caps fill the cell faces around it', () => {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  // A box-shaped hole in the middle: every face of the cell is solid.
  const hole = buildSurfaceDisplayMesh(boxMesh([3, 3, 3], [7, 7, 7]), cell, { reverse: true });
  assert.equal(hole.capRanges.length, 6);
  near(displayMeshArea(hole, hole.surfaceIndexCount, hole.capIndexCount), 600);
  near(displayMeshVolume(hole), 1000 - 64);
  assert.equal(displayMeshOpenEdges(hole), 0);
  // The same hole through the a faces: those caps are frames around it.
  const through = boxMesh([8, 3, 3], [12, 7, 7]);
  for (let vertex = 0; vertex < 8; vertex += 1) if (through.vertices[vertex * 3] > 10) through.vertices[vertex * 3] -= 10;
  const frame = buildSurfaceDisplayMesh(through, cell, { reverse: true });
  near(displayMeshVolume(frame), 1000 - 64);
  assert.equal(displayMeshOpenEdges(frame), 0);
  for (const range of frame.capRanges) near(displayMeshArea(frame, range.first, range.count), range.axis === 0 ? 100 - 16 : 100, 1e-12);
  // No triangle at all: the caller says whether the solid fills the cell.
  const none = { vertices: new Float64Array(0), triangles: new Uint32Array(0) };
  assert.equal(buildSurfaceDisplayMesh(none, cell).indices.length, 0);
  const full = buildSurfaceDisplayMesh(none, cell, { spaceFilling: true });
  assert.equal(full.capRanges.length, 6);
  near(displayMeshVolume(full), 1000);
  assert.equal(buildSurfaceDisplayMesh(none, cell, { spaceFilling: true, caps: false }).indices.length, 0);
});

test('tilted and left-handed cells keep outward caps and exact volumes', () => {
  for (const vectors of [[10, 0, 0, 3, 9, 0, 1, 2, 8], [0, 10, 0, 10, 0, 0, 0, 0, 10], [10, 0, 0, 3, 9, 0, -1, -2, -8]]) {
    const cell = createCell({ vectors, origin: [5, -3, 2], triclinic: true });
    const volume = Math.abs(vectors[0] * (vectors[4] * vectors[8] - vectors[5] * vectors[7]) - vectors[1] * (vectors[3] * vectors[8] - vectors[5] * vectors[6])
      + vectors[2] * (vectors[3] * vectors[7] - vectors[4] * vectors[6]));
    // A parallelepiped in reduced coordinates [0.8, 1.2] × [0.2, 0.6] × [0.9, 1.3], wrapped.
    const reduced = boxMesh([0.8, 0.2, 0.9], [1.2, 0.6, 1.3]);
    const vertices = new Float64Array(24);
    for (let vertex = 0; vertex < 8; vertex += 1) {
      const f = [0, 1, 2].map(axis => reduced.vertices[vertex * 3 + axis] - Math.floor(reduced.vertices[vertex * 3 + axis]));
      for (let axis = 0; axis < 3; axis += 1) vertices[vertex * 3 + axis] = cell.origin[axis] + f[0] * vectors[axis] + f[1] * vectors[3 + axis] + f[2] * vectors[6 + axis];
    }
    // In a left-handed cell the reduced box has inward faces: flip them.
    const leftHanded = vectors[0] * (vectors[4] * vectors[8] - vectors[5] * vectors[7]) - vectors[1] * (vectors[3] * vectors[8] - vectors[5] * vectors[6])
      + vectors[2] * (vectors[3] * vectors[7] - vectors[4] * vectors[6]) < 0;
    const display = buildSurfaceDisplayMesh({ vertices, triangles: reduced.triangles }, cell, { reverse: leftHanded });
    assert.deepEqual(display.capRanges.map(range => [range.axis, range.side]), [[0, 0], [0, 1], [2, 0], [2, 1]]);
    near(displayMeshVolume(display), 0.4 * 0.4 * 0.4 * volume, 1e-9, 'parallelepiped volume');
    assert.equal(displayMeshOpenEdges(display), 0);
    // Each cap's geometric normal agrees with its stored outward normal.
    for (const range of display.capRanges) {
      const [a, b, c] = [0, 1, 2].map(corner => display.indices[range.first + corner] * 3);
      const p = display.positions, u = [0, 1, 2].map(axis => p[b + axis] - p[a + axis]), w = [0, 1, 2].map(axis => p[c + axis] - p[a + axis]);
      const normal = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      assert.ok(normal.reduce((sum, value, axis) => sum + value * display.normals[a + axis], 0) > 0, 'cap winding matches its normal');
    }
  }
});

test('mesh exports are valid STL, PLY and OBJ files of the displayed triangles', async () => {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const crossing = boxMesh([8, 3, 4], [12, 7, 6]);
  for (let vertex = 0; vertex < 8; vertex += 1) if (crossing.vertices[vertex * 3] > 10) crossing.vertices[vertex * 3] -= 10;
  const display = buildSurfaceDisplayMesh(crossing, cell);
  const all = exportTriangles(display), surface = exportTriangles(display, { caps: false });
  assert.equal(all.triangleCount, display.indices.length / 3);
  assert.equal(surface.triangleCount, display.surfaceIndexCount / 3);
  assert.ok(surface.vertexCount < all.vertexCount, 'cap vertices are dropped with the caps');
  assert.deepEqual([...new Set(all.parts)], [0, 1]);
  assert.deepEqual([...new Set(surface.parts)], [0]);
  const moved = exportTriangles(display, { translation: [1, 2, 3] });
  assert.equal(moved.positions[0], all.positions[0] + 1);
  assert.equal(moved.positions[2], all.positions[2] + 3);
  // Binary STL: header, count and 50 bytes per facet with unit normals.
  const stl = meshToStl(all, { title: 'test mesh' }), view = new DataView(stl);
  const header = new TextDecoder().decode(new Uint8Array(stl, 0, 80));
  assert.ok(header.startsWith('binary test mesh') && !header.startsWith('solid'));
  const facets = view.getUint32(80, true);
  assert.equal(stl.byteLength, 84 + facets * 50);
  assert.ok(facets > 0 && facets <= all.triangleCount);
  let stlArea = 0, stlVolume = 0;
  for (let facet = 0; facet < facets; facet += 1) {
    const offset = 84 + facet * 50, values = Array.from({ length: 12 }, (_, index) => view.getFloat32(offset + index * 4, true));
    const [normal, a, b, c] = [values.slice(0, 3), values.slice(3, 6), values.slice(6, 9), values.slice(9, 12)];
    near(Math.hypot(...normal), 1, 1e-6);
    const u = b.map((value, axis) => value - a[axis]), w = c.map((value, axis) => value - a[axis]);
    const crossed = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    assert.ok(crossed.reduce((sum, value, axis) => sum + value * normal[axis], 0) > 0, 'facet normal follows the right-hand rule');
    stlArea += Math.hypot(...crossed) / 2;
    stlVolume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    assert.equal(view.getUint16(offset + 48, true), 0);
  }
  near(stlArea, displayMeshArea(display), 1e-6);
  near(stlVolume, 32, 1e-5, 'the capped STL is a closed solid');
  // PLY: header and element sizes; first vertex and last face read back.
  const ply = meshToPly(all, { comments: ['from a test'] }), text = new TextDecoder().decode(new Uint8Array(ply));
  const headerEnd = text.indexOf('end_header\n') + 'end_header\n'.length;
  const lines = text.slice(0, headerEnd).trim().split('\n');
  assert.deepEqual(lines.slice(0, 2), ['ply', 'format binary_little_endian 1.0']);
  assert.ok(lines.includes('comment from a test') && lines.includes(`element vertex ${all.vertexCount}`) && lines.includes(`element face ${all.triangleCount}`));
  assert.equal(ply.byteLength, headerEnd + all.vertexCount * 36 + all.triangleCount * 14);
  const body = new DataView(ply, headerEnd);
  assert.equal(body.getFloat64(0, true), all.positions[0]);
  near(body.getFloat32(24, true), all.normals[0], 1e-7);
  const lastFace = all.vertexCount * 36 + (all.triangleCount - 1) * 14;
  assert.equal(body.getUint8(lastFace), 3);
  assert.equal(body.getUint32(lastFace + 1, true), all.indices.at(-3));
  assert.equal(body.getUint8(lastFace + 13), 1, 'cap faces are marked');
  // OBJ: vertex, normal and face counts; indices are one-based and in range.
  const obj = meshToObj(all, { title: 'test' }).split('\n');
  assert.equal(obj.filter(line => line.startsWith('v ')).length, all.vertexCount);
  assert.equal(obj.filter(line => line.startsWith('vn ')).length, all.vertexCount);
  const faces = obj.filter(line => line.startsWith('f '));
  assert.equal(faces.length, all.triangleCount);
  assert.deepEqual(obj.filter(line => line.startsWith('g ')), ['g surface', 'g caps']);
  for (const face of faces) for (const corner of face.split(' ').slice(1)) {
    const [vertex, , normal] = corner.split('/').map(Number);
    assert.ok(vertex >= 1 && vertex <= all.vertexCount && normal === vertex);
  }
  assert.deepEqual(obj.find(line => line.startsWith('v ')).split(' ').slice(1).map(Number), Array.from(all.positions.subarray(0, 3)));
  // The download wrapper names files and rejects unknown formats and empty meshes.
  for (const format of MESH_EXPORT_FORMATS) {
    const file = createMeshExport(display, format.id, { stem: 'sample-frame-1-surface' });
    assert.equal(file.filename, `sample-frame-1-surface.${format.extension}`);
    assert.ok(file.blob.size > 0);
    assert.equal(file.blob.type, format.type);
  }
  assert.equal((await createMeshExport(display, 'stl').blob.arrayBuffer()).byteLength, stl.byteLength);
  assert.throws(() => createMeshExport(display, 'vtk'), /STL, PLY or OBJ/);
  assert.throws(() => createMeshExport(buildSurfaceDisplayMesh({ vertices: new Float64Array(0), triangles: new Uint32Array(0) }, cell), 'stl'), /no triangles/);
  assert.throws(() => exportTriangles(null), /no surface mesh/);
});
