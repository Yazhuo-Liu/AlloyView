// Triangle-mesh files for the displayed surface: the mesh wrapped into the
// cell at the current periodic origin, with or without its cap polygons.
// Coordinates are Cartesian ångströms in the structure's frame.

export const MESH_EXPORT_FORMATS = Object.freeze([
  Object.freeze({ id: 'stl', label: 'STL (binary)', extension: 'stl', type: 'model/stl' }),
  Object.freeze({ id: 'ply', label: 'PLY (binary)', extension: 'ply', type: 'application/octet-stream' }),
  Object.freeze({ id: 'obj', label: 'OBJ (text)', extension: 'obj', type: 'text/plain' }),
]);

/** Triangles of a display mesh as { positions, normals, indices, parts }:
 * `parts` is 0 for the surface and 1 for a cap triangle. Vertices that no
 * exported triangle uses are dropped; `translation` moves every vertex. */
export function exportTriangles(display, { caps = true, translation = [0, 0, 0] } = {}) {
  if (!display?.positions || !display.indices) throw new Error('There is no surface mesh to export.');
  const end = caps ? display.indices.length : display.surfaceIndexCount;
  const remap = new Int32Array(display.vertexCount).fill(-1), indices = new Uint32Array(end);
  let count = 0;
  for (let index = 0; index < end; index += 1) {
    const vertex = display.indices[index];
    if (remap[vertex] < 0) remap[vertex] = count++;
    indices[index] = remap[vertex];
  }
  const positions = new Float64Array(count * 3), normals = new Float32Array(count * 3);
  for (let vertex = 0; vertex < remap.length; vertex += 1) {
    const target = remap[vertex];
    if (target < 0) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      positions[target * 3 + axis] = display.positions[vertex * 3 + axis] + translation[axis];
      normals[target * 3 + axis] = display.normals[vertex * 3 + axis];
    }
  }
  const parts = new Uint8Array(end / 3);
  parts.fill(1, display.surfaceIndexCount / 3);
  return { positions, normals, indices, parts, vertexCount: count, triangleCount: end / 3 };
}

function faceNormal(positions, a, b, c) {
  const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
  const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, length = Math.hypot(x, y, z);
  return length > 0 ? [x / length, y / length, z / length] : [0, 0, 0];
}

/** Binary STL: 80-byte header, triangle count, then one facet normal and
 * three float32 corners per triangle. Degenerate triangles are left out. */
export function meshToStl(mesh, { title = 'AlloyView surface mesh' } = {}) {
  const { positions, indices } = mesh, facets = [];
  for (let index = 0; index < indices.length; index += 3) {
    const normal = faceNormal(positions, indices[index], indices[index + 1], indices[index + 2]);
    if (normal[0] || normal[1] || normal[2]) facets.push(index, normal);
  }
  const count = facets.length / 2, buffer = new ArrayBuffer(84 + count * 50), view = new DataView(buffer);
  // The header must not begin with "solid", which marks ASCII STL.
  const header = new TextEncoder().encode(`binary ${title}`.replace(/[^\x20-\x7e]/g, '?')).subarray(0, 80);
  new Uint8Array(buffer, 0, 80).set(header);
  view.setUint32(80, count, true);
  let offset = 84;
  for (let facet = 0; facet < count; facet += 1) {
    const first = facets[facet * 2], normal = facets[facet * 2 + 1];
    for (const value of normal) { view.setFloat32(offset, value, true); offset += 4; }
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[first + corner] * 3;
      for (let axis = 0; axis < 3; axis += 1) { view.setFloat32(offset, positions[vertex + axis], true); offset += 4; }
    }
    offset += 2;
  }
  return buffer;
}

/** Binary little-endian PLY with double positions, float normals and a
 * `part` byte per face (0 surface, 1 cap). */
export function meshToPly(mesh, { comments = [] } = {}) {
  const { positions, normals, indices, parts, vertexCount, triangleCount } = mesh;
  const header = ['ply', 'format binary_little_endian 1.0', 'comment AlloyView surface mesh, coordinates in angstrom',
    ...comments.map(comment => `comment ${String(comment).replace(/[^\x20-\x7e]/g, '?')}`),
    `element vertex ${vertexCount}`, 'property double x', 'property double y', 'property double z',
    'property float nx', 'property float ny', 'property float nz',
    `element face ${triangleCount}`, 'property list uchar uint vertex_indices', 'property uchar part', 'end_header', ''].join('\n');
  const prefix = new TextEncoder().encode(header);
  const buffer = new ArrayBuffer(prefix.length + vertexCount * 36 + triangleCount * 14), view = new DataView(buffer);
  new Uint8Array(buffer, 0, prefix.length).set(prefix);
  let offset = prefix.length;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) { view.setFloat64(offset, positions[vertex * 3 + axis], true); offset += 8; }
    for (let axis = 0; axis < 3; axis += 1) { view.setFloat32(offset, normals[vertex * 3 + axis], true); offset += 4; }
  }
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    view.setUint8(offset, 3); offset += 1;
    for (let corner = 0; corner < 3; corner += 1) { view.setUint32(offset, indices[triangle * 3 + corner], true); offset += 4; }
    view.setUint8(offset, parts[triangle]); offset += 1;
  }
  return buffer;
}

/** Wavefront OBJ text with vertex normals; caps form a second group. */
export function meshToObj(mesh, { title = 'AlloyView surface mesh' } = {}) {
  const { positions, normals, indices, parts, vertexCount, triangleCount } = mesh;
  const lines = [`# ${String(title).replace(/[^\x20-\x7e]/g, '?')}`, '# coordinates in angstrom'];
  // String() gives the shortest text that reads back as the same double.
  const number = value => String(Number(value));
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    lines.push(`v ${number(positions[vertex * 3])} ${number(positions[vertex * 3 + 1])} ${number(positions[vertex * 3 + 2])}`);
  }
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    lines.push(`vn ${normals[vertex * 3].toFixed(6)} ${normals[vertex * 3 + 1].toFixed(6)} ${normals[vertex * 3 + 2].toFixed(6)}`);
  }
  let part = -1;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (parts[triangle] !== part) { part = parts[triangle]; lines.push(`g ${part ? 'caps' : 'surface'}`); }
    const [a, b, c] = [indices[triangle * 3] + 1, indices[triangle * 3 + 1] + 1, indices[triangle * 3 + 2] + 1];
    lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
  }
  return `${lines.join('\n')}\n`;
}

/** { blob, filename } for one of MESH_EXPORT_FORMATS. */
export function createMeshExport(display, format, { caps = true, translation, stem = 'surface', title } = {}) {
  const entry = MESH_EXPORT_FORMATS.find(item => item.id === format);
  if (!entry) throw new Error('Choose STL, PLY or OBJ for the mesh export.');
  const mesh = exportTriangles(display, { caps, translation });
  if (!mesh.triangleCount) throw new Error('The surface mesh has no triangles to export.');
  const data = format === 'stl' ? meshToStl(mesh, { title }) : format === 'ply' ? meshToPly(mesh, { comments: title ? [title] : [] }) : meshToObj(mesh, { title });
  return { blob: new Blob([data], { type: entry.type }), filename: `${stem}.${entry.extension}`, ...mesh };
}
