import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DxaClient } from '../src/analysis/dxa-client.js';
import { calculateDxa } from '../src/analysis/dxa.js';
import {
  SURFACE_MESH_DEFAULTS, calculateSurfaceMesh, normalizeSurfaceMeshResult, suggestProbeRadius, surfaceMeshRegions,
  validateSurfaceMask, validateSurfaceMeshParameters,
} from '../src/analysis/surface-mesh.js';
import { determinant3 } from '../src/data/model.js';
import {
  buildSurfaceDisplayMesh, displayMeshArea, displayMeshOpenEdges, displayMeshVolume, surfaceMeshArea,
} from '../src/render/surface-mesh-geometry.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccBlock, periodicDistance, sphereArea, sphereVolume, subsetFrame, withCell } from './helpers/surfaces.js';

const A = 4, N = 12, L = A * N, CENTER = [L / 2, L / 2, L / 2], RADIUS = 3.5;
const fcc = fccBlock(N, A);
const relative = (value, expected) => Math.abs(value - expected) / Math.abs(expected);
const close = (value, expected, tolerance, message) => assert.ok(relative(value, expected) <= tolerance,
  `${message ?? 'value'}: ${value} differs from ${expected} by ${relative(value, expected).toExponential(2)} > ${tolerance}`);

test('surface parameters and atom masks are validated before any native work', async () => {
  assert.deepEqual(validateSurfaceMeshParameters(), { ...SURFACE_MESH_DEFAULTS });
  assert.deepEqual(validateSurfaceMeshParameters({ radius: 2.5, smoothingLevel: 0, ignored: 1 }), { radius: 2.5, smoothingLevel: 0 });
  for (const invalid of [{ radius: 0 }, { radius: -1 }, { radius: NaN }, { radius: '3' }, { radius: 1e7 }, { smoothingLevel: -1 },
    { smoothingLevel: 1.5 }, { smoothingLevel: 101 }]) assert.throws(() => validateSurfaceMeshParameters(invalid), /radius|smoothing/);
  assert.equal(validateSurfaceMask(null, 4), null);
  assert.throws(() => validateSurfaceMask(new Uint8Array(3), 4), /mask/);
  assert.throws(() => validateSurfaceMask([1, 1, 1, 1], 4), /mask/);
  await assert.rejects(calculateSurfaceMesh(fcc, { radius: -2 }), /radius/);
  await assert.rejects(calculateSurfaceMesh(fcc, {}, { mask: new Uint8Array(5) }), /mask/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(calculateSurfaceMesh(fcc, {}, { signal: controller.signal }), { name: 'AbortError' });
});

test('the suggested probe radius is about 1.3 nearest-neighbor distances of the elements', () => {
  const copper = suggestProbeRadius({ ...fcc, typeLabels: ['Cu'] });
  // Cu: 2 × 1.28 Å metallic radius, padded twice by 15% and rounded to 0.05 Å.
  assert.equal(copper.cutoff, 2.95);
  assert.equal(copper.radius, 3.4);
  assert.match(copper.message, /3\.40 Å/);
  const unknown = suggestProbeRadius(fcc);
  assert.equal(unknown.radius, 3.45, 'unknown elements use the 3 Å fallback cutoff');
});

test('a fully periodic perfect crystal is solid everywhere and has no surface', async () => {
  for (const [kind, repeat, lattice, radius] of [['fcc', 6, 4, 3.5], ['bcc', 8, 2.87, 3], ['hcp', 8, 3, 3.5]]) {
    const frame = crystalFrame(kind, repeat, lattice);
    const result = await calculateSurfaceMesh(frame, { radius, smoothingLevel: 8 });
    const volume = Math.abs(determinant3(frame.cell.vectors));
    assert.equal(result.faceCount, 0, `${kind} has no surface`);
    assert.equal(result.vertexCount, 0);
    assert.equal(result.spaceFilling, true);
    assert.equal(result.surfaceArea, 0);
    assert.deepEqual([result.filledRegionCount, result.emptyRegionCount, result.voidRegionCount, result.surfaceComponentCount], [1, 0, 0, 0]);
    close(result.filledVolume, volume, 1e-10, `${kind} solid volume`);
    assert.equal(result.emptyVolume, 0);
    assert.equal(result.filledFraction, 1);
    assert.equal(result.inputCount, frame.ids.length);
    assert.equal(result.backend, 'cpu');
    assert.equal(result.workerCount, 1);
  }
});

test('a simple-cubic block in an open cell is an exact cube', async () => {
  const lattice = 3, cells = 7, side = (cells - 1) * lattice;
  const frame = crystalFrame('sc', cells, lattice);
  frame.cell = { ...frame.cell, pbc: [false, false, false] };
  const result = await calculateSurfaceMesh(frame, { radius: 3.2, smoothingLevel: 0 });
  close(result.surfaceArea, 6 * side * side, 1e-9, 'cube area');
  close(result.filledVolume, side ** 3, 1e-9, 'cube volume');
  assert.deepEqual([result.filledRegionCount, result.emptyRegionCount, result.voidRegionCount, result.surfaceComponentCount], [1, 1, 0, 1]);
  const [solid, exterior] = surfaceMeshRegions(result);
  assert.deepEqual([solid.kind, exterior.kind], ['filled', 'exterior']);
  close(exterior.volume, (cells * lattice) ** 3 - side ** 3, 1e-9, 'exterior volume inside the cell');
  close(solid.surfaceArea, result.surfaceArea, 1e-12);
  close(exterior.surfaceArea, result.surfaceArea, 1e-12);
  assert.equal(result.voidVolume, 0, 'space that reaches an open boundary is not a void');
  // A closed surface of genus zero: V − E + F = 2 with E = 3F/2.
  assert.equal(result.vertexCount - result.faceCount / 2, 2);
  assert.ok(result.vertexAtoms.every(atom => atom < frame.ids.length));
  close(surfaceMeshArea(result, frame.cell), result.surfaceArea, 1e-12, 'area from the returned triangles');
});

test('a spherical nanoparticle matches the sphere within the lattice resolution', async () => {
  const radius = 18;
  const frame = subsetFrame(fcc, position => Math.hypot(...position.map((value, axis) => value - CENTER[axis])) <= radius, [false, false, false]);
  const sharp = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel: 0 });
  // The surface passes through the centers of the outermost atoms, which lie
  // between R − a/2 and R from the center.
  assert.ok(sharp.filledVolume > sphereVolume(radius - A / 2) && sharp.filledVolume < sphereVolume(radius), `volume ${sharp.filledVolume}`);
  assert.ok(sharp.surfaceArea > sphereArea(radius - A / 2) && sharp.surfaceArea < sphereArea(radius), `area ${sharp.surfaceArea}`);
  // Isoperimetric quotient A³ / (36π V²): 1 for a sphere, larger for a faceted one.
  const quotient = result => result.surfaceArea ** 3 / (36 * Math.PI * result.filledVolume ** 2);
  assert.ok(quotient(sharp) > 1 && quotient(sharp) < 1.1, `faceted sphere quotient ${quotient(sharp)}`);
  close(sharp.filledVolume, 20501.333333, 1e-8, 'reference solid volume');
  close(sharp.surfaceArea, 3722.347, 1e-6, 'reference surface area');
  assert.deepEqual([sharp.filledRegionCount, sharp.emptyRegionCount, sharp.voidRegionCount, sharp.surfaceComponentCount], [1, 1, 0, 1]);
  assert.equal(sharp.vertexCount - sharp.faceCount / 2, 2);
  close(sharp.filledVolume + sharp.emptyVolume, L ** 3, 1e-10, 'solid plus empty volume');
  // Smoothing rounds the facets: less area, the same topology and volumes.
  const smooth = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel: 8 });
  assert.ok(smooth.surfaceArea < sharp.surfaceArea && smooth.surfaceArea > 0.95 * sharp.surfaceArea);
  assert.ok(quotient(smooth) < quotient(sharp));
  assert.equal(smooth.filledVolume, sharp.filledVolume, 'volumes come from the tessellation, not the smoothed mesh');
  assert.deepEqual(smooth.triangles, sharp.triangles);
  // In a periodic cell the same particle is surrounded by a void.
  const periodic = await calculateSurfaceMesh({ ...frame, cell: { ...frame.cell, pbc: [true, true, true] } }, { radius: RADIUS, smoothingLevel: 0 });
  close(periodic.surfaceArea, sharp.surfaceArea, 1e-12);
  close(periodic.voidVolume, sharp.emptyVolume, 1e-10);
  assert.equal(periodic.voidRegionCount, 1);
});

test('a periodic slab has two planar surfaces of area 2A wherever it lies in the cell', async () => {
  const thickness = L / 2 - A / 2;
  for (const keep of [position => position[2] >= L / 4 - 1e-9 && position[2] < 3 * L / 4 - 1e-9,
    position => position[2] < L / 4 - 1e-9 || position[2] >= 3 * L / 4 - 1e-9]) {
    const frame = subsetFrame(fcc, keep);
    for (const smoothingLevel of [0, 8]) {
      const result = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel });
      close(result.surfaceArea, 2 * L * L, 1e-10, 'slab area');
      close(result.filledVolume, L * L * thickness, 1e-10, 'slab volume');
      close(result.emptyVolume, L * L * (L - thickness), 1e-10, 'gap volume');
      assert.deepEqual([result.filledRegionCount, result.emptyRegionCount, result.voidRegionCount, result.surfaceComponentCount], [1, 1, 1, 2],
        'one slab and one gap, joined through the periodic boundary, with two surface sheets');
      close(result.filledFraction, thickness / L, 1e-10);
      close(result.specificSurfaceArea, 2 / L, 1e-10);
    }
  }
  // With an open direction normal to the slab, the two gaps are exterior space.
  const open = subsetFrame(fcc, position => position[2] >= L / 4 - 1e-9 && position[2] < 3 * L / 4 - 1e-9, [true, true, false]);
  const result = await calculateSurfaceMesh(open, { radius: RADIUS, smoothingLevel: 0 });
  close(result.surfaceArea, 2 * L * L, 1e-10);
  assert.equal(result.voidRegionCount, 0);
  assert.equal(result.voidVolume, 0);
  assert.ok(surfaceMeshRegions(result).filter(region => !region.filled).every(region => region.exterior));
});

test('spherical voids in a periodic crystal are closed regions with the missing volume', async () => {
  const voidRadius = 10;
  for (const center of [CENTER, [0, 0, 0], [L / 2, 0, 0]]) {
    const frame = subsetFrame(fcc, position => periodicDistance(position, center, L) > voidRadius);
    const result = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel: 0 });
    assert.deepEqual([result.filledRegionCount, result.emptyRegionCount, result.voidRegionCount, result.surfaceComponentCount], [1, 1, 1, 1]);
    // The void surface passes through atoms between Rv and Rv + a/2 from its center.
    assert.ok(result.voidVolume > sphereVolume(voidRadius) && result.voidVolume < sphereVolume(voidRadius + A / 2), `void volume ${result.voidVolume}`);
    assert.ok(result.surfaceArea > sphereArea(voidRadius) && result.surfaceArea < sphereArea(voidRadius + A / 2), `void area ${result.surfaceArea}`);
    close(result.voidVolume, 4618.666667, 1e-8, 'the same void volume at the center, a corner and an edge of the cell');
    assert.equal(result.voidVolume, result.emptyVolume);
    close(result.filledVolume + result.emptyVolume, L ** 3, 1e-10, 'solid plus void fills the cell');
    assert.equal(result.cellVolume, L ** 3);
    close(result.voidFraction, result.voidVolume / L ** 3, 1e-10);
  }
  // Two separate voids are two regions, each with its own volume and area.
  const second = [L / 4, L / 4, L / 4];
  const frame = subsetFrame(fcc, position => periodicDistance(position, CENTER, L) > 8 && periodicDistance(position, second, L) > 6);
  const result = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel: 0 });
  assert.deepEqual([result.filledRegionCount, result.emptyRegionCount, result.voidRegionCount, result.surfaceComponentCount], [1, 2, 2, 2]);
  const voids = surfaceMeshRegions(result).filter(region => region.kind === 'void').sort((first, second) => second.volume - first.volume);
  assert.ok(voids[0].volume > sphereVolume(8) && voids[0].volume < sphereVolume(8 + A / 2));
  assert.ok(voids[1].volume > sphereVolume(6) && voids[1].volume < sphereVolume(6 + A / 2));
  close(voids[0].volume + voids[1].volume, result.voidVolume, 1e-12);
  close(voids[0].surfaceArea + voids[1].surfaceArea, result.surfaceArea, 1e-12);
  // Every face names the solid region it bounds and the void on its other side.
  const regions = new Set();
  for (let face = 0; face < result.faceCount; face += 1) {
    assert.equal(result.faceRegions[face * 2], 0);
    regions.add(result.faceRegions[face * 2 + 1]);
  }
  assert.deepEqual([...regions].sort(), voids.map(region => region.id).sort());
  // A single vacancy stays filled at this radius; a small radius opens it.
  const vacancy = subsetFrame(fcc, (_, atom) => atom !== 1234);
  assert.equal((await calculateSurfaceMesh(vacancy, { radius: RADIUS, smoothingLevel: 0 })).faceCount, 0);
  const opened = await calculateSurfaceMesh(vacancy, { radius: 2.4, smoothingLevel: 0 });
  assert.equal(opened.voidRegionCount, 1);
  assert.ok(opened.voidVolume > 0 && opened.voidVolume < 2 * A ** 3);
});

test('triclinic cells: volumes, regions and the wrapped surface are consistent', async () => {
  const vectors = [L, 0, 0, 0.15 * L, L, 0, 0.05 * L, 0.1 * L, L], origin = [-7, 3, 11];
  const sheared = withCell(fcc, vectors, { origin }), volume = Math.abs(determinant3(vectors));
  const perfect = await calculateSurfaceMesh(sheared, { radius: 4, smoothingLevel: 0 });
  assert.equal(perfect.faceCount, 0);
  close(perfect.filledVolume, volume, 1e-10, 'sheared crystal volume');
  // A slab between two lattice planes normal to c* and a void across a corner.
  const fractional = (frame, atom, axis) => frame.fractional[atom * 3 + axis];
  const cases = {
    slab: subsetFrame(sheared, (_, atom) => fractional(sheared, atom, 2) >= 0.25 - 1e-9 && fractional(sheared, atom, 2) < 0.75 - 1e-9),
    void: subsetFrame(sheared, (_, atom) => Math.hypot(...[0, 1, 2].map(axis => {
      const value = fractional(sheared, atom, axis);
      return (value - Math.round(value)) * L;
    })) > 10),
  };
  for (const [name, frame] of Object.entries(cases)) {
    const result = await calculateSurfaceMesh(frame, { radius: 4, smoothingLevel: 0 });
    close(result.filledVolume + result.emptyVolume, volume, 1e-10, `${name}: solid plus empty volume`);
    assert.equal(result.filledRegionCount, 1);
    assert.equal(result.voidRegionCount, 1);
    for (const displayOrigin of [[0, 0, 0], [0.31, 0.62, 0.17]]) {
      const display = buildSurfaceDisplayMesh(result, frame.cell, { origin: displayOrigin });
      assert.equal(displayMeshOpenEdges(display), 0, `${name}: the capped mesh is closed`);
      close(displayMeshVolume(display), result.filledVolume, 1e-9, `${name}: capped volume`);
      close(displayMeshArea(display, 0, display.surfaceIndexCount), result.surfaceArea, 1e-10, `${name}: wrapped area`);
    }
    if (name === 'slab') {
      // Two planes spanned by a and b: area 2 |a × b|; thickness 22 lattice planes.
      const ab = Math.hypot(vectors[1] * vectors[5] - vectors[2] * vectors[4], vectors[2] * vectors[3] - vectors[0] * vectors[5], vectors[0] * vectors[4] - vectors[1] * vectors[3]);
      close(result.surfaceArea, 2 * ab, 1e-10, 'triclinic slab area');
      close(result.filledVolume, volume * (0.5 - 0.5 / N), 1e-10, 'triclinic slab volume');
    }
  }
});

test('periodic caps close the solid exactly for any display origin', async () => {
  const thickness = L / 2 - A / 2;
  const slab = subsetFrame(fcc, position => position[2] >= L / 4 - 1e-9 && position[2] < 3 * L / 4 - 1e-9);
  const result = await calculateSurfaceMesh(slab, { radius: RADIUS, smoothingLevel: 0 });
  const display = buildSurfaceDisplayMesh(result, slab.cell);
  // The slab meets the four side faces of the cell; each cap is its cross section.
  assert.deepEqual(display.capRanges.map(range => [range.axis, range.side]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
  for (const range of display.capRanges) close(displayMeshArea(display, range.first, range.count), L * thickness, 1e-10, 'cap area');
  assert.equal(displayMeshOpenEdges(display), 0);
  close(displayMeshVolume(display), result.filledVolume, 1e-10);
  // Cap vertices lie on their cell face and repeat the cut surface vertices.
  for (const range of display.capRanges) {
    for (let index = range.first; index < range.first + range.count; index += 1) {
      const vertex = display.indices[index];
      assert.equal(display.positions[vertex * 3 + range.axis], range.side ? L : 0);
      assert.ok(Math.abs(Math.abs(display.normals[vertex * 3 + range.axis]) - 1) < 1e-6);
      assert.equal(Math.sign(display.normals[vertex * 3 + range.axis]), range.side ? 1 : -1, 'caps face out of the cell');
    }
  }
  // Without caps the wrapped surface is open along the cell faces.
  const open = buildSurfaceDisplayMesh(result, slab.cell, { caps: false });
  assert.equal(open.capRanges.length, 0);
  assert.equal(open.indices.length, open.surfaceIndexCount);
  assert.ok(displayMeshOpenEdges(open) > 0);
  // Moving the slab across the c boundary adds the two full c faces minus nothing:
  // the solid now touches them over the whole cross section.
  const moved = buildSurfaceDisplayMesh(result, slab.cell, { origin: [0, 0, 0.5] });
  assert.equal(moved.capRanges.length, 6);
  close(displayMeshArea(moved, moved.surfaceIndexCount, moved.capIndexCount), 4 * L * thickness + 2 * L * L, 1e-10);
  close(displayMeshVolume(moved), result.filledVolume, 1e-10);
  assert.equal(displayMeshOpenEdges(moved), 0);
  // Voids, particles and rods through every kind of boundary crossing.
  const shapes = {
    voidAtCorner: subsetFrame(fcc, position => periodicDistance(position, [0, 0, 0], L) > 10),
    particleAtCorner: subsetFrame(fcc, position => periodicDistance(position, [0, 0, 0], L) <= 14),
    rod: subsetFrame(fcc, position => Math.hypot(position[0] - CENTER[0], position[1] - CENTER[1]) <= 12),
    rodOpenSides: subsetFrame(fcc, position => Math.hypot(position[0] - CENTER[0], position[1] - CENTER[1]) <= 12, [false, false, true]),
  };
  for (const [name, frame] of Object.entries(shapes)) {
    for (const smoothingLevel of [0, 8]) {
      const mesh = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel });
      for (const origin of [[0, 0, 0], [0.37, 0.11, 0.73], [0.5, 0.5, 0.5], [-0.2, 1.3, 0.05]]) {
        const wrapped = buildSurfaceDisplayMesh(mesh, frame.cell, { origin });
        assert.equal(displayMeshOpenEdges(wrapped), 0, `${name}: closed at origin ${origin}`);
        close(displayMeshArea(wrapped, 0, wrapped.surfaceIndexCount), mesh.surfaceArea, 1e-10, `${name}: wrapped area`);
        // Smoothing moves the surface slightly inside the unsmoothed solid.
        close(displayMeshVolume(wrapped), mesh.filledVolume, smoothingLevel ? 0.03 : 1e-9, `${name}: capped volume at origin ${origin}`);
      }
    }
  }
  // A void that touches no cell face: every periodic face is entirely solid.
  const centered = subsetFrame(fcc, position => periodicDistance(position, CENTER, L) > 10);
  const hollow = buildSurfaceDisplayMesh(await calculateSurfaceMesh(centered, { radius: RADIUS, smoothingLevel: 0 }), centered.cell);
  assert.equal(hollow.capRanges.length, 6);
  close(displayMeshArea(hollow, hollow.surfaceIndexCount, hollow.capIndexCount), 6 * L * L, 1e-12);
});

test('atoms and whole surfaces lying exactly on a periodic cell face are cut consistently', async () => {
  // Ideal lattices put atomic planes on the cell faces. A facet in a face is
  // shown on the side of its solid; atoms on a face go to the lower side.
  const sheared = withCell(fcc, [L, 0, 0, 0.15 * L, L, 0, 0.05 * L, 0.1 * L, L], { origin: [-7, 3, 11] });
  const fraction = (frame, atom, axis) => frame.fractional[atom * 3 + axis];
  const half = value => value < L / 2 - 1e-9, upper = value => value >= L / 2 - 1e-9 || value < 1e-9;
  const cases = [
    ['slab from the lower c face', subsetFrame(fcc, position => half(position[2])), RADIUS, [[0, 0], [0, 1], [1, 0], [1, 1]]],
    ['slab up to the upper c face', subsetFrame(fcc, position => upper(position[2])), RADIUS, [[0, 0], [0, 1], [1, 0], [1, 1]]],
    ['block in the lower corner', subsetFrame(fcc, position => position.every(half)), RADIUS, []],
    ['block in the upper corner', subsetFrame(fcc, position => position.every(upper)), RADIUS, []],
    ['tilted slab from the lower c face', subsetFrame(sheared, (_, atom) => fraction(sheared, atom, 2) < 0.5 - 1e-9), 4, [[0, 0], [0, 1], [1, 0], [1, 1]]],
    ['tilted slab up to the upper a face', subsetFrame(sheared, (_, atom) => fraction(sheared, atom, 0) >= 0.5 - 1e-9 || fraction(sheared, atom, 0) < 1e-9), 4,
      [[1, 0], [1, 1], [2, 0], [2, 1]]],
    ['tilted slab between lattice planes', subsetFrame(sheared, (_, atom) => fraction(sheared, atom, 2) >= 0.25 - 1e-9 && fraction(sheared, atom, 2) < 0.75 - 1e-9), 4,
      [[0, 0], [0, 1], [1, 0], [1, 1]]],
  ];
  for (const [name, frame, radius, caps] of cases) {
    const result = await calculateSurfaceMesh(frame, { radius, smoothingLevel: 0 });
    const display = buildSurfaceDisplayMesh(result, frame.cell);
    assert.equal(displayMeshOpenEdges(display), 0, `${name}: closed`);
    close(displayMeshVolume(display), result.filledVolume, 1e-9, `${name}: capped volume`);
    close(displayMeshArea(display, 0, display.surfaceIndexCount), result.surfaceArea, 1e-10, `${name}: wrapped area`);
    assert.deepEqual(display.capRanges.map(range => [range.axis, range.side]), caps, `${name}: capped faces`);
    // The displayed solid stays in one piece inside the cell.
    const inverse = [0, 1, 2].map(axis => (display.maximum[axis] - display.minimum[axis]));
    assert.ok(inverse.every(Number.isFinite));
  }
});

test('an atom mask gives the surface of the chosen atoms and maps vertices to the frame', async () => {
  const radius = 14, inside = atom => Math.hypot(...[0, 1, 2].map(axis => fcc.positions[atom * 3 + axis] - CENTER[axis])) <= radius;
  const mask = Uint8Array.from({ length: fcc.ids.length }, (_, atom) => inside(atom) ? 1 : 0);
  const subset = subsetFrame(fcc, (_, atom) => inside(atom));
  const masked = await calculateSurfaceMesh(fcc, { radius: RADIUS, smoothingLevel: 0 }, { mask });
  const direct = await calculateSurfaceMesh(subset, { radius: RADIUS, smoothingLevel: 0 });
  assert.equal(masked.inputCount, subset.ids.length);
  assert.equal(masked.atomCount, fcc.ids.length);
  assert.equal(masked.faceCount, direct.faceCount);
  close(masked.surfaceArea, direct.surfaceArea, 1e-12);
  close(masked.filledVolume, direct.filledVolume, 1e-12);
  assert.ok(masked.vertexAtoms.every(atom => mask[atom] === 1), 'vertices are atoms of the mask, by frame index');
  for (let vertex = 0; vertex < masked.vertexCount; vertex += 1) {
    const atom = masked.vertexAtoms[vertex];
    for (let axis = 0; axis < 3; axis += 1) assert.ok(Math.abs(masked.vertices[vertex * 3 + axis] - fcc.positions[atom * 3 + axis]) < 1e-9);
  }
  // No selected atom: one empty region, no surface.
  const empty = await calculateSurfaceMesh(fcc, { radius: RADIUS }, { mask: new Uint8Array(fcc.ids.length) });
  assert.deepEqual([empty.faceCount, empty.filledRegionCount, empty.emptyRegionCount, empty.inputCount], [0, 0, 1, 0]);
  close(empty.emptyVolume, L ** 3, 1e-12);
  assert.equal(empty.spaceFilling, false);
});

test('surface construction is deterministic, reports its stages and leaves the DXA kernel reusable', async () => {
  const frame = subsetFrame(fcc, position => periodicDistance(position, [0, 0, 0], L) > 10);
  const before = frame.fractional.slice(), progress = [];
  const first = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel: 4 }, { onProgress: update => progress.push(update) });
  assert.deepEqual(frame.fractional, before, 'source coordinates remain intact');
  const second = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel: 4 });
  for (const name of ['vertices', 'triangles', 'vertexAtoms', 'faceRegions', 'regionVolumes', 'regionAreas', 'regionFilled', 'regionExterior']) {
    assert.deepEqual(second[name], first[name], `${name} repeat bit for bit`);
  }
  for (const name of ['surfaceArea', 'filledVolume', 'emptyVolume', 'voidVolume']) assert.ok(Object.is(second[name], first[name]), name);
  assert.ok(progress.some(update => /Delaunay/.test(update.phase)) && progress.some(update => /regions/.test(update.phase)));
  assert.equal(progress.at(-1).completedStages, 6);
  assert.ok(first.stageTimings.length >= 5 && first.elapsedMs > 0);
  assert.equal(first.algorithm, 'OVITO alpha shape 3.9.4');
  // The two analyses share one kernel: a failed surface and a DXA run in between.
  await assert.rejects(calculateSurfaceMesh(frame, { radius: 25 }), /Simulation cell is too small, or radius parameter is too large/);
  assert.equal((await calculateDxa(crystalFrame('fcc', 4))).segments.length, 0);
  const third = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel: 4 });
  assert.deepEqual(third.vertices, first.vertices);
  // Smoothing levels share the unsmoothed topology.
  const sharp = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel: 0 });
  assert.deepEqual(sharp.triangles, first.triangles);
  assert.notDeepEqual(sharp.vertices, first.vertices);
});

test('kernel results with inconsistent arrays are rejected', () => {
  const cell = fcc.cell, raw = { vertexCount: 3, faceCount: 1, regionCount: 2, surfaceArea: 1, filledVolume: 2, emptyVolume: 3, voidVolume: 0, cellVolume: 5,
    vertices: new Float64Array(9), triangles: Uint32Array.of(0, 1, 2), vertexAtoms: Uint32Array.of(0, 1, 2),
    faceRegions: Int32Array.of(0, 1), regionData: Float64Array.of(2, 1, 1, 0, 3, 1, 0, 1) };
  const result = normalizeSurfaceMeshResult(raw, cell, {}, 10);
  assert.deepEqual(Array.from(result.regionVolumes), [2, 3]);
  assert.deepEqual([result.totalVolume, result.filledFraction, result.emptyFraction, result.specificSurfaceArea], [5, 0.4, 0.6, 0.2]);
  assert.equal(Object.hasOwn(result, 'regionData'), false);
  assert.deepEqual(surfaceMeshRegions(result).map(region => region.kind), ['filled', 'exterior']);
  for (const broken of [{ triangles: Uint32Array.of(0, 1, 3) }, { faceRegions: Int32Array.of(0, 2) }, { vertexAtoms: Uint32Array.of(0, 1, 10) },
    { vertexCount: 4 }, { surfaceArea: NaN }, { regionData: new Float64Array(7) }, { vertices: new Float32Array(9) }]) {
    assert.throws(() => normalizeSurfaceMeshResult({ ...raw, ...broken }, cell, {}, 10), /surface kernel/);
  }
});

function nodeWorkerFactory(created) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-dxa-worker.mjs', import.meta.url));
    created.push(worker);
    return {
      addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); },
      terminate() { void worker.terminate(); },
    };
  };
}

test('the DXA Worker returns the same surface as the direct kernel, and cancels cooperatively', async t => {
  const created = [], client = new DxaClient({ workerFactory: nodeWorkerFactory(created), codeWarmupMinAtoms: Infinity });
  t.after(() => client.close());
  const frame = subsetFrame(fcc, position => periodicDistance(position, [0, 0, 0], L) > 10);
  const mask = Uint8Array.from({ length: frame.ids.length }, (_, atom) => atom % 97 ? 1 : 0);
  for (const options of [{}, { mask }]) {
    const direct = await calculateSurfaceMesh(frame, { radius: RADIUS, smoothingLevel: 3 }, options);
    const progress = [];
    const remote = await client.surface(frame, { radius: RADIUS, smoothingLevel: 3 }, { ...options, onProgress: update => progress.push(update) });
    for (const name of ['vertices', 'triangles', 'vertexAtoms', 'faceRegions', 'regionVolumes', 'regionAreas', 'regionFilled', 'regionExterior']) {
      assert.deepEqual(remote[name], direct[name], `${name} equal through the Worker`);
    }
    for (const name of ['surfaceArea', 'filledVolume', 'emptyVolume', 'voidVolume', 'filledRegionCount', 'voidRegionCount', 'inputCount']) {
      assert.ok(Object.is(remote[name], direct[name]), name);
    }
    assert.ok(progress.some(update => update.phase === 'collecting'));
  }
  assert.equal(mask.length, frame.ids.length, 'the caller keeps its mask');
  assert.equal(created.length, 1, 'surface jobs reuse the DXA Worker');
  // A DXA extraction and a surface job queue on the same Worker and kernel.
  const [network, surface] = await Promise.all([client.analyze(crystalFrame('fcc', 4), {}), client.surface(frame, { radius: RADIUS })]);
  assert.equal(network.segments.length, 0);
  assert.equal(surface.voidRegionCount, 1);
  assert.equal(created.length, 1);
  // Cancellation through the shared word stops native work and keeps the Worker.
  const controller = new AbortController();
  const cancelled = client.surface(fccBlock(24, A), { radius: RADIUS }, { signal: controller.signal,
    onProgress: update => { if (/Delaunay/.test(update.phase ?? '')) controller.abort(); } });
  await assert.rejects(cancelled, { name: 'AbortError' });
  const after = await client.surface(frame, { radius: RADIUS, smoothingLevel: 3 });
  assert.equal(after.voidRegionCount, 1);
  assert.equal(created.length, 1, 'the kernel survives a cancelled surface job');
  await assert.rejects(client.surface(frame, { radius: 0 }), /radius/);
  await assert.rejects(client.surface(frame, {}, { mask: new Uint8Array(2) }), /mask/);
});
