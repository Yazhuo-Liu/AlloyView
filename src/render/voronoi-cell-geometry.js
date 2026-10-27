/** Pure Voronoi cell geometry: polyhedron meshes, packed cell batches and the
 * periodic copies a batch needs for a given set of display positions. This
 * module touches no WebGL or DOM state, so analysis Workers build batches with
 * it while voronoi-cell-layer.js owns the GPU upload and drawing. */
export const NO_NEIGHBOR = 0xffffffff;

/** Local Cartesian vertices remain independent of
 * display wrapping, periodic origin, replication and scientific atom arrays.
 *
 * With `shared`, a face shared with another analyzed cell is kept only by the
 * lower-index cell, and an edge only by the lowest-index cell around it. Each
 * kept face records that neighbor; each kept edge records up to two other
 * cells and their image offsets, so the renderer can still draw a copy for a
 * cell displayed in another periodic image, hidden owner or shrunken view. */
export function createVoronoiCellMesh(cell, { shared = false } = {}) {
  if (!Number.isInteger(cell?.atomIndex) || cell.atomIndex < 0) throw new Error('A Voronoi cell needs a valid atom index.');
  const { vertices, faceOffsets, faceVertices } = cell, atom = cell.atomIndex;
  if (!vertices || vertices.length % 3 || !Array.from(vertices).every(Number.isFinite)
    || !faceOffsets || faceOffsets.length < 2 || faceOffsets[0] !== 0
    || faceOffsets.at(-1) !== faceVertices?.length) throw new Error('Invalid Voronoi cell geometry.');
  // The atom may lie on a nonperiodic boundary. Use a point inside the
  // convex polyhedron to orient faces, rather than the local atom origin.
  const interior = [0, 0, 0];
  for (let index = 0; index < vertices.length; index++) interior[index % 3] += vertices[index] / (vertices.length / 3);
  const faceCount = faceOffsets.length - 1, neighbors = new Int32Array(faceCount).fill(-1), offsets = new Array(faceCount);
  const values = [], vertexNeighbors = [], indices = [], faces = [], edges = new Map();
  for (let face = 0; face < faceCount; face++) {
    const start = faceOffsets[face], end = faceOffsets[face + 1];
    if (end - start < 3 || end < start) throw new Error('Voronoi cell faces require at least three corners.');
    const corners = Array.from(faceVertices.subarray(start, end));
    if (corners.some(index => !Number.isInteger(index) || index < 0 || index * 3 >= vertices.length)) throw new Error('Invalid Voronoi face vertex.');
    const points = corners.map(index => Array.from(vertices.subarray(index * 3, index * 3 + 3)));
    // Newell's normal stays well defined for tiny or nearly collinear faces,
    // whose bisector offset below would otherwise be imprecise.
    let normal = [0, 0, 0];
    points.forEach((point, corner) => {
      const next = points[(corner + 1) % points.length];
      normal[0] += (point[1] - next[1]) * (point[2] + next[2]);
      normal[1] += (point[2] - next[2]) * (point[0] + next[0]);
      normal[2] += (point[0] - next[0]) * (point[1] + next[1]);
    });
    const length = Math.hypot(...normal);
    if (!(length > 0)) throw new Error('A Voronoi cell face is degenerate.');
    normal = normal.map(value => value / length);
    const inward = normal.reduce((sum, value, axis) => sum + value * (points[0][axis] - interior[axis]), 0) < 0;
    if (inward) normal = normal.map(value => -value);
    for (let corner = 0; corner < corners.length; corner++) {
      const a = corners[corner], b = corners[(corner + 1) % corners.length], key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = edges.get(key) ?? { a, b, faces: [] };
      entry.faces.push(face); edges.set(key, entry);
    }
    const neighbor = shared ? cell.faceNeighbors?.[face] ?? -1 : -1;
    if (neighbor >= 0 && neighbor !== atom) {
      // The neighbor's image lies across the bisector plane, at twice the
      // plane's distance from this atom along the outward normal. Radical
      // faces are not midway; their cells carry the actual image vectors.
      const distance = normal.reduce((sum, value, axis) => sum + value * points[0][axis], 0);
      const vector = cell.neighborVectors?.subarray(face * 3, face * 3 + 3);
      neighbors[face] = neighbor;
      offsets[face] = vector?.every(Number.isFinite) ? Array.from(vector) : normal.map(value => 2 * distance * value);
      if (neighbor < atom) continue;
    }
    const first = values.length / 6, firstIndex = indices.length;
    for (const point of points) { values.push(...point, ...normal); vertexNeighbors.push(neighbors[face] < 0 ? NO_NEIGHBOR : neighbors[face]); }
    for (let corner = 1; corner + 1 < points.length; corner++) {
      if (inward) indices.push(first, first + corner + 1, first + corner);
      else indices.push(first, first + corner, first + corner + 1);
    }
    faces.push({ firstIndex, indexCount: indices.length - firstIndex, neighbor: neighbors[face] < 0 ? NO_NEIGHBOR : neighbors[face] });
  }
  const faceVertexCount = values.length / 6, edgeIds = [], edgeRecords = [];
  for (const { a, b, faces: adjacent } of edges.values()) {
    // Faces toward a boundary or this cell's own periodic image add no other
    // displayed cell. Rare edges shared by more than three cells may be drawn
    // by two owners; none is ever omitted.
    const others = adjacent.filter(face => neighbors[face] >= 0);
    if (others.some(face => neighbors[face] < atom)) continue;
    const [first, second] = others;
    values.push(...vertices.subarray(a * 3, a * 3 + 3), ...(first === undefined ? [0, 0, 0] : offsets[first]),
      ...vertices.subarray(b * 3, b * 3 + 3), ...(second === undefined ? [0, 0, 0] : offsets[second]));
    const record = { a: first === undefined ? NO_NEIGHBOR : neighbors[first], b: second === undefined ? NO_NEIGHBOR : neighbors[second] };
    edgeIds.push(atom, record.a, record.b, 0); edgeRecords.push(record);
  }
  return { values: Float32Array.from(values), vertexNeighbors: Uint32Array.from(vertexNeighbors), edgeIds: Uint32Array.from(edgeIds),
    indices: Uint32Array.from(indices), faces, edges: edgeRecords,
    vertexCount: faceVertexCount, indexCount: indices.length, edgeCount: edgeRecords.length * 2 };
}

/** Pack a bounded group of cells into one face/outline draw buffer, storing
 * each shared face and edge once. Atom IDs stay integer attributes so display
 * transforms and masks need no mesh rebuild. `cellIds` holds two integers per
 * vertex slot: (owner, neighbor) for faces and (owner, other, other, 0) across
 * an edge's two slots. */
export function createVoronoiCellBatch(cells) {
  const meshes = cells.map(cell => createVoronoiCellMesh(cell, { shared: true }));
  const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.vertexCount, 0);
  const edgeCount = meshes.reduce((sum, mesh) => sum + mesh.edgeCount, 0);
  const indexCount = meshes.reduce((sum, mesh) => sum + mesh.indexCount, 0);
  const values = new Float32Array((vertexCount + edgeCount) * 6), cellIds = new Uint32Array((vertexCount + edgeCount) * 2);
  const indices = new Uint32Array(indexCount);
  const bounds = new Float64Array(cells.length * 7), cellRanges = new Uint32Array(cells.length * 5);
  const foreignFaces = [], foreignEdges = [];
  let vertex = 0, edge = vertexCount, index = 0;
  cells.forEach((cell, cellIndex) => {
    const mesh = meshes[cellIndex];
    // A cell's owned faces and edges are contiguous; the faces and edges its
    // neighbors own on its behalf are listed separately. Together they let a
    // selection emphasize the whole polyhedron without extracting geometry.
    cellRanges.set([cell.atomIndex, index, mesh.indexCount, edge, mesh.edgeCount], cellIndex * 5);
    values.set(mesh.values.subarray(0, mesh.vertexCount * 6), vertex * 6);
    values.set(mesh.values.subarray(mesh.vertexCount * 6), edge * 6);
    for (let offset = 0; offset < mesh.vertexCount; offset++) {
      cellIds[(vertex + offset) * 2] = cell.atomIndex; cellIds[(vertex + offset) * 2 + 1] = mesh.vertexNeighbors[offset];
    }
    cellIds.set(mesh.edgeIds, edge * 2);
    for (const face of mesh.faces) if (face.neighbor !== NO_NEIGHBOR) foreignFaces.push(face.neighbor, index + face.firstIndex, face.indexCount);
    mesh.edges.forEach(({ a, b }, offset) => {
      if (a !== NO_NEIGHBOR) foreignEdges.push(a, edge + offset * 2, 1);
      if (b !== NO_NEIGHBOR) foreignEdges.push(b, edge + offset * 2, 2);
    });
    for (const value of mesh.indices) indices[index++] = value + vertex;
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (let point = 0; point < cell.vertices.length; point += 3) for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], cell.vertices[point + axis]);
      maximum[axis] = Math.max(maximum[axis], cell.vertices[point + axis]);
    }
    bounds.set([cell.atomIndex, ...minimum, ...maximum], cellIndex * 7);
    vertex += mesh.vertexCount; edge += mesh.edgeCount;
  });
  return { values, cellIds, indices, bounds, cellRanges, foreignFaces: Uint32Array.from(foreignFaces),
    foreignEdges: Uint32Array.from(foreignEdges), vertexCount, indexCount, edgeCount, cellCount: cells.length };
}

// Display positions differ by at least a cell vector across a periodic
// boundary, so this tolerance only absorbs float32 rounding.
export const SAME_IMAGE_TOLERANCE = 0.02;

// Whether `other` minus its image offset (`scale` times the vector at
// `values[start]`) is displayed at `atom`'s position.
function sameImage(positions, atom, other, values, start, scale = 1) {
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(positions[other * 3 + axis] - scale * values[start + axis] - positions[atom * 3 + axis]) >= SAME_IMAGE_TOLERANCE) return false;
  }
  return true;
}

/** The shared faces and edges whose other cell is displayed in a different
 * periodic image than their owner, for the given display positions. Only these
 * need a second copy at true cell size; every other stored copy serves all of
 * its cells. Copies are compact standalone records, so all chunks' copies can
 * share one small buffer and a few draws: face triangle corners as
 * (position, normal) with (owner, neighbor) IDs, and edges drawn from their
 * first other cell followed by those drawn from their second. */
export function periodicCopies(mesh, positions) {
  const { values, cellIds, indices, foreignFaces, foreignEdges } = mesh, corners = [], edges = [[], []];
  for (let entry = 0; entry < foreignFaces.length; entry += 3) {
    const neighbor = foreignFaces[entry], first = foreignFaces[entry + 1], count = foreignFaces[entry + 2];
    const vertex = indices[first], base = vertex * 6;
    // The offset is twice the face's bisector distance along its normal.
    const distance = 2 * (values[base] * values[base + 3] + values[base + 1] * values[base + 4] + values[base + 2] * values[base + 5]);
    if (!sameImage(positions, cellIds[vertex * 2], neighbor, values, base + 3, distance)) {
      for (let index = first; index < first + count; index++) corners.push(indices[index]);
    }
  }
  for (let entry = 0; entry < foreignEdges.length; entry += 3) {
    const other = foreignEdges[entry], slot = foreignEdges[entry + 1], which = foreignEdges[entry + 2];
    if (!sameImage(positions, cellIds[slot * 2], other, values, slot * 6 + (which === 1 ? 3 : 9))) edges[which - 1].push(slot);
  }
  const faceValues = new Float32Array(corners.length * 6), faceIds = new Uint32Array(corners.length * 2);
  corners.forEach((vertex, index) => {
    faceValues.set(values.subarray(vertex * 6, vertex * 6 + 6), index * 6);
    faceIds.set(cellIds.subarray(vertex * 2, vertex * 2 + 2), index * 2);
  });
  const slots = [...edges[0], ...edges[1]];
  const edgeValues = new Float32Array(slots.length * 12), edgeIds = new Uint32Array(slots.length * 4);
  slots.forEach((slot, index) => {
    edgeValues.set(values.subarray(slot * 6, slot * 6 + 12), index * 12);
    edgeIds.set(cellIds.subarray(slot * 2, slot * 2 + 4), index * 4);
  });
  return { faceValues, faceIds, cornerCount: corners.length, edgeValues, edgeIds,
    firstEdgeCount: edges[0].length, secondEdgeCount: edges[1].length };
}
