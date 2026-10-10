import { determinant3, invert3 } from '../data/model.js';

// Display geometry of a closed surface mesh in a periodic cell, after OVITO
// 3.9.4's SurfaceMeshVis: vertices are wrapped into the displayed cell, faces
// that pass through a periodic boundary are split there, and the solid cross
// sections on those boundaries are closed with cap polygons. The analysis
// mesh itself is never changed.

const MAX_VERTEX_KEY = 0x4000000;
// Reduced coordinates this close to a periodic cell face are put on it. Atoms
// of an ideal lattice often lie on a face up to rounding; without this they
// would wrap to either side at random and the cut would zigzag between them.
const FACE_SNAP = 1e-9;

function grown(array, length) {
  if (length <= array.length) return array;
  const next = new array.constructor(Math.max(length, Math.ceil(array.length * 1.5) + 64));
  next.set(array);
  return next;
}

function validateMesh(mesh) {
  const { vertices, triangles } = mesh ?? {};
  if (!ArrayBuffer.isView(vertices) || vertices.length % 3 || !ArrayBuffer.isView(triangles) || triangles.length % 3) {
    throw new Error('A surface mesh needs XYZ vertices and triangle indices.');
  }
  const count = vertices.length / 3;
  if (count >= MAX_VERTEX_KEY) throw new Error('The surface mesh has too many vertices to display.');
  for (const vertex of triangles) if (vertex >= count) throw new Error('A surface mesh triangle refers to a missing vertex.');
  return count;
}

/** Fractional coordinates relative to the displayed cell: the periodic
 * display origin moves the content, as it does for atoms. */
function reducedCoordinates(vertices, cell, origin, capacity) {
  const inverse = invert3(cell.vectors), o = cell.origin, count = vertices.length / 3;
  const shift = [0, 1, 2].map(axis => cell.pbc[axis] ? origin[axis] : 0);
  const reduced = new Float64Array(capacity * 3);
  for (let vertex = 0; vertex < count; vertex += 1) {
    const x = vertices[vertex * 3] - o[0], y = vertices[vertex * 3 + 1] - o[1], z = vertices[vertex * 3 + 2] - o[2];
    for (let axis = 0; axis < 3; axis += 1) {
      let value = x * inverse[axis] + y * inverse[3 + axis] + z * inverse[6 + axis] - shift[axis];
      if (cell.pbc[axis]) { const face = Math.round(value); if (Math.abs(value - face) < FACE_SNAP) value = face; }
      reduced[vertex * 3 + axis] = value;
    }
  }
  return reduced;
}

/** Area-weighted vertex normals. Edges use the minimum image, so faces that
 * connect atoms across a periodic boundary contribute their true shape. */
function accumulateNormals(reduced, triangles, triangleCount, cell, normals) {
  const h = cell.vectors, pbc = cell.pbc, e1 = [0, 0, 0], e2 = [0, 0, 0];
  const edge = (from, to, output) => {
    let a = reduced[to * 3] - reduced[from * 3], b = reduced[to * 3 + 1] - reduced[from * 3 + 1], c = reduced[to * 3 + 2] - reduced[from * 3 + 2];
    if (pbc[0]) a -= Math.floor(a + 0.5);
    if (pbc[1]) b -= Math.floor(b + 0.5);
    if (pbc[2]) c -= Math.floor(c + 0.5);
    output[0] = a * h[0] + b * h[3] + c * h[6]; output[1] = a * h[1] + b * h[4] + c * h[7]; output[2] = a * h[2] + b * h[5] + c * h[8];
  };
  let area = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = triangles[triangle * 3], b = triangles[triangle * 3 + 1], c = triangles[triangle * 3 + 2];
    edge(a, b, e1); edge(a, c, e2);
    const x = e1[1] * e2[2] - e1[2] * e2[1], y = e1[2] * e2[0] - e1[0] * e2[2], z = e1[0] * e2[1] - e1[1] * e2[0];
    area += Math.hypot(x, y, z) / 2;
    for (const vertex of [a, b, c]) { normals[vertex * 3] += x; normals[vertex * 3 + 1] += y; normals[vertex * 3 + 2] += z; }
  }
  return area;
}

function normalize(normals, count) {
  for (let vertex = 0; vertex < count; vertex += 1) {
    const x = normals[vertex * 3], y = normals[vertex * 3 + 1], z = normals[vertex * 3 + 2], length = Math.hypot(x, y, z);
    if (length > 0) { normals[vertex * 3] = x / length; normals[vertex * 3 + 1] = y / length; normals[vertex * 3 + 2] = z / length; }
  }
}

/** Surface area of a periodic mesh from minimum-image edges. */
export function surfaceMeshArea(mesh, cell) {
  const count = validateMesh(mesh);
  const reduced = reducedCoordinates(mesh.vertices, cell, [0, 0, 0], count);
  return accumulateNormals(reduced, mesh.triangles, mesh.triangles.length / 3, cell, new Float64Array(count * 3));
}

// ---------------------------------------------------------------------------
// Polygon triangulation for cap faces. Loops are closed point lists in the
// plane; counterclockwise loops bound solid, clockwise loops are holes in it.
// Only the given points are used, so caps share every vertex with the cut
// surface and with the neighboring cap, and no gaps open between them.

function loopArea(pu, pv, loop) {
  let area = 0;
  for (let index = 0, last = loop.length - 1; index < loop.length; last = index++) {
    area += pu[loop[last]] * pv[loop[index]] - pu[loop[index]] * pv[loop[last]];
  }
  return area / 2;
}

function pointInLoop(pu, pv, loop, u, v) {
  let inside = false;
  for (let index = 0, last = loop.length - 1; index < loop.length; last = index++) {
    const u1 = pu[loop[index]], v1 = pv[loop[index]], u2 = pu[loop[last]], v2 = pv[loop[last]];
    if ((v1 > v) !== (v2 > v) && u < (u2 - u1) * (v - v1) / (v2 - v1) + u1) inside = !inside;
  }
  return inside;
}

const cross = (au, av, bu, bv, cu, cv) => (bu - au) * (cv - av) - (bv - av) * (cu - au);

class Ring {
  constructor(pu, pv) { this.pu = pu; this.pv = pv; this.point = []; this.previous = []; this.next = []; }
  add(point, after = -1) {
    const node = this.point.length;
    this.point.push(point);
    if (after < 0) { this.previous.push(node); this.next.push(node); }
    else {
      const following = this.next[after];
      this.previous.push(after); this.next.push(following);
      this.next[after] = node; this.previous[following] = node;
    }
    return node;
  }
  fromLoop(loop) {
    let last = -1, first = -1;
    for (const point of loop) { last = this.add(point, last); if (first < 0) first = last; }
    return first;
  }
  u(node) { return this.pu[this.point[node]]; }
  v(node) { return this.pv[this.point[node]]; }
  area(a, b, c) { return cross(this.u(a), this.v(a), this.u(b), this.v(b), this.u(c), this.v(c)); }
  /** Whether the segment from `node` toward (u, v) starts inside the polygon. */
  locallyInside(node, u, v) {
    const a = this.previous[node], c = this.next[node], bu = this.u(node), bv = this.v(node);
    const first = cross(bu, bv, this.u(c), this.v(c), u, v), second = cross(bu, bv, u, v, this.u(a), this.v(a));
    return this.area(a, node, c) >= 0 ? first >= 0 && second >= 0 : first >= 0 || second >= 0;
  }
}

/** Connect a hole to the outer ring with a two-way bridge (Eberly, "Triangulation
 * by Ear Clipping"): from the rightmost hole point to a visible ring point. */
function bridgeHole(ring, outerStart, holeStart) {
  let m = holeStart;
  for (let node = ring.next[holeStart]; node !== holeStart; node = ring.next[node]) if (ring.u(node) > ring.u(m)) m = node;
  const mu = ring.u(m), mv = ring.v(m);
  // Nearest edge to the right that runs upward past the hole point.
  let best = -1, bestU = Infinity, node = outerStart;
  do {
    const following = ring.next[node], av = ring.v(node), bv = ring.v(following);
    if (av <= mv && bv >= mv && av !== bv) {
      const u = ring.u(node) + (mv - av) * (ring.u(following) - ring.u(node)) / (bv - av);
      if (u >= mu && u < bestU) { bestU = u; best = ring.u(node) > ring.u(following) ? node : following; }
    }
    node = following;
  } while (node !== outerStart);
  if (best < 0) return outerStart;
  // The hit point is visible from the hole point. Unless it is a ring point
  // itself, connect to the higher-u end of the hit edge, or to the ring point
  // inside the triangle (hole point, hit, that end) closest in angle to the ray.
  const pu = ring.u(best), pv = ring.v(best);
  let chosen = best;
  if (bestU !== pu || mv !== pv) {
    const corners = pv > mv ? [mu, mv, bestU, mv, pu, pv] : [mu, mv, pu, pv, bestU, mv];
    let tangent = Infinity, distance = Infinity;
    node = outerStart;
    do {
      const u = ring.u(node), v = ring.v(node);
      if (u > mu && (u !== pu || v !== pv)
          && cross(corners[0], corners[1], corners[2], corners[3], u, v) >= 0 && cross(corners[2], corners[3], corners[4], corners[5], u, v) >= 0
          && cross(corners[4], corners[5], corners[0], corners[1], u, v) >= 0) {
        const slope = Math.abs(v - mv) / (u - mu), length = (u - mu) ** 2 + (v - mv) ** 2;
        // Of two points in the same direction, the nearer one hides the other.
        if ((slope < tangent || (slope === tangent && length < distance)) && ring.locallyInside(node, mu, mv)) {
          chosen = node; tangent = slope; distance = length;
        }
      }
      node = ring.next[node];
    } while (node !== outerStart);
  }
  // Several ring nodes can share the chosen point after earlier bridges.
  if (!ring.locallyInside(chosen, mu, mv)) {
    for (node = ring.next[chosen]; node !== chosen; node = ring.next[node]) {
      if (ring.u(node) === ring.u(chosen) && ring.v(node) === ring.v(chosen) && ring.locallyInside(node, mu, mv)) { chosen = node; break; }
    }
  }
  // chosen → hole point → around the hole → hole point copy → chosen copy.
  const holePoints = [];
  node = m;
  do { holePoints.push(ring.point[node]); node = ring.next[node]; } while (node !== m);
  let last = chosen;
  for (const point of holePoints) last = ring.add(point, last);
  last = ring.add(ring.point[m], last);
  ring.add(ring.point[chosen], last);
  return outerStart;
}

function clipEars(ring, start, triangles) {
  let remaining = 0, node = start;
  do { remaining += 1; node = ring.next[node]; } while (node !== start);
  const emit = (a, b, c) => { triangles.push(ring.point[a], ring.point[b], ring.point[c]); };
  const remove = current => {
    const a = ring.previous[current], c = ring.next[current];
    ring.next[a] = c; ring.previous[c] = a; remaining -= 1;
    return c;
  };
  // 0: no point may touch the ear; 1: points on its outline are allowed;
  // 2: any convex corner; 3: any corner. Later modes only finish input that
  // is not a simple polygon (touching or crossing contours).
  let mode = 0, sinceEar = 0;
  node = start;
  while (remaining > 3) {
    const a = ring.previous[node], c = ring.next[node];
    const au = ring.u(a), av = ring.v(a), bu = ring.u(node), bv = ring.v(node), cu = ring.u(c), cv = ring.v(c);
    const area = cross(au, av, bu, bv, cu, cv);
    let ear = mode === 3 || area > 0;
    if (ear && mode < 2) {
      const minimumU = Math.min(au, bu, cu), maximumU = Math.max(au, bu, cu), minimumV = Math.min(av, bv, cv), maximumV = Math.max(av, bv, cv);
      for (let other = ring.next[c]; other !== a; other = ring.next[other]) {
        const u = ring.u(other), v = ring.v(other);
        if (u < minimumU || u > maximumU || v < minimumV || v > maximumV) continue;
        if ((u === au && v === av) || (u === bu && v === bv) || (u === cu && v === cv)) continue;
        const first = cross(au, av, bu, bv, u, v), second = cross(bu, bv, cu, cv, u, v), third = cross(cu, cv, au, av, u, v);
        if (mode === 0 ? first >= 0 && second >= 0 && third >= 0 : first > 0 && second > 0 && third > 0) { ear = false; break; }
      }
    }
    if (ear) {
      // A forced corner of invalid input still gets an outward triangle.
      if (area > 0) emit(a, node, c);
      else if (area < 0) emit(a, c, node);
      node = remove(node);
      sinceEar = 0; mode = 0;
    } else {
      node = c;
      if (++sinceEar > remaining) { mode += 1; sinceEar = 0; }
    }
  }
  if (remaining === 3 && ring.area(ring.previous[node], node, ring.next[node]) !== 0) emit(ring.previous[node], node, ring.next[node]);
}

/** Triangles (point index triples, counterclockwise) filling the solid side
 * of the oriented loops. */
export function triangulateLoops(pu, pv, loops) {
  const outers = [], holes = [];
  for (const source of loops) {
    // Repeated positions carry no area and confuse corner tests.
    const loop = source.filter((point, index) => {
      const previous = source[(index + source.length - 1) % source.length];
      return pu[point] !== pu[previous] || pv[point] !== pv[previous];
    });
    if (loop.length < 3) continue;
    const area = loopArea(pu, pv, loop);
    if (area > 0) outers.push({ loop, area, holes: [] });
    else if (area < 0) holes.push({ loop, area });
  }
  // A hole belongs to the smallest solid loop around it.
  outers.sort((first, second) => first.area - second.area);
  for (const hole of holes) {
    const owner = outers.find(outer => pointInLoop(pu, pv, outer.loop, pu[hole.loop[0]], pv[hole.loop[0]]));
    owner?.holes.push(hole.loop);
  }
  const triangles = [];
  for (const outer of outers) {
    const ring = new Ring(pu, pv);
    const start = ring.fromLoop(outer.loop);
    const rightmost = loop => loop.reduce((maximum, point) => Math.max(maximum, pu[point]), -Infinity);
    for (const hole of outer.holes.map(loop => ({ loop, key: rightmost(loop) })).sort((first, second) => second.key - first.key)) {
      // Each hole is a separate ring in the same node arrays until bridged.
      bridgeHole(ring, start, ring.fromLoop(hole.loop));
    }
    clipEars(ring, start, triangles);
  }
  return triangles;
}

// Arc position on the unit square, clockwise from the origin corner: up the
// u = 0 edge, along v = 1, down u = 1 and back along v = 0 (as upstream).
const squareArc = (u, v) => u === 0 ? v : v === 1 ? u + 1 : u === 1 ? 3 - v : (4 - u) % 4;
const SQUARE_CORNERS = [[0, 0], [0, 1], [1, 1], [1, 0]];

/** Close contours that end on the boundary of the cell face. The solid lies
 * to the left of each contour, so the outline continues counterclockwise
 * along the face boundary to the next contour that starts there. */
function closeOpenContours(points, open, periodicU, periodicV) {
  const { u: pu, v: pv } = points, loops = [];
  const line = point => periodicU && pu[point] === 0 ? 0 : periodicV && pv[point] === 1 ? 1
    : periodicU && pu[point] === 1 ? 2 : periodicV && pv[point] === 0 ? 3 : -1;
  const ends = [];
  for (const contour of open) {
    const first = contour[0], last = contour.at(-1), end = { contour, entryLine: line(first), exitLine: line(last),
      entry: squareArc(pu[first], pv[first]), exit: squareArc(pu[last], pv[last]) };
    // A contour that stops inside the face comes from an open mesh.
    if (end.entryLine < 0 || end.exitLine < 0) continue;
    // One that returns to the boundary point where it started is a loop.
    if (pu[first] === pu[last] && pv[first] === pv[last]) loops.push(contour);
    else ends.push(end);
  }
  const wrapAround = periodicU && periodicV, visited = new Set();
  for (const first of ends) {
    if (visited.has(first)) continue;
    const loop = [];
    let current = first;
    do {
      loop.push(...current.contour);
      visited.add(current);
      let following = null, distance = Infinity;
      for (const candidate of ends) {
        // With one periodic direction the two boundary lines are not joined.
        if (!wrapAround && candidate.entryLine !== current.exitLine) continue;
        let gap = current.exit - candidate.entry;
        if (gap < 0) gap += wrapAround ? 4 : Infinity;
        // Of contours that start at the same boundary point, continue with one
        // that is not part of an outline yet.
        if (gap < distance || (gap === distance && visited.has(following) && !visited.has(candidate))) { distance = gap; following = candidate; }
      }
      if (!following) break;
      if (wrapAround) {
        const exitCorner = Math.floor(current.exit), entryCorner = Math.floor(following.entry);
        if (exitCorner >= 0 && exitCorner < 4 && entryCorner >= 0 && entryCorner < 4
            && (exitCorner !== entryCorner || current.exit < following.entry)) {
          for (let corner = exitCorner; ;) {
            pu.push(SQUARE_CORNERS[corner][0]); pv.push(SQUARE_CORNERS[corner][1]);
            loop.push(pu.length - 1);
            corner = (corner + 3) % 4;
            if (corner === entryCorner) break;
          }
        }
      }
      current = following;
    } while (!visited.has(current));
    loops.push(loop);
  }
  return loops;
}

/** Whether a periodic cell face that no surface contour reaches lies inside
 * the solid. Lines through the cell along the face's axis are followed from
 * the lower face to the upper one; the first and the last surface triangle
 * they meet tell whether the cell is solid just above the lower face and
 * just below the upper face. Both must hold: a surface lying in the face
 * itself bounds the solid on one side only and needs no cap. */
function faceInsideSolid(reduced, triangles, triangleCount, axis, orientation) {
  if (!triangleCount) return null;
  const uAxis = (axis + 1) % 3, vAxis = (axis + 2) % 3, samples = Math.min(9, triangleCount);
  let votes = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    // A point inside a surface triangle, off its medians and edges.
    const target = Math.floor((sample + 0.5) * triangleCount / samples) * 3;
    const [a, b, c] = [triangles[target] * 3, triangles[target + 1] * 3, triangles[target + 2] * 3];
    const u = 0.5 * reduced[a + uAxis] + 0.3 * reduced[b + uAxis] + 0.2 * reduced[c + uAxis];
    const v = 0.5 * reduced[a + vAxis] + 0.3 * reduced[b + vAxis] + 0.2 * reduced[c + vAxis];
    let first = Infinity, last = -Infinity, firstFacing = 0, lastFacing = 0;
    for (let index = 0; index < triangleCount * 3; index += 3) {
      const p = triangles[index] * 3, q = triangles[index + 1] * 3, r = triangles[index + 2] * 3;
      const pu = reduced[p + uAxis] - u, pv = reduced[p + vAxis] - v, qu = reduced[q + uAxis] - u, qv = reduced[q + vAxis] - v;
      const ru = reduced[r + uAxis] - u, rv = reduced[r + vAxis] - v;
      // Barycentric weights of the line in the triangle's projection.
      const w0 = qu * rv - qv * ru, w1 = ru * pv - rv * pu, w2 = pu * qv - pv * qu, total = w0 + w1 + w2;
      if (total === 0 || (w0 < 0 || w1 < 0 || w2 < 0) && (w0 > 0 || w1 > 0 || w2 > 0)) continue;
      const height = (w0 * reduced[p + axis] + w1 * reduced[q + axis] + w2 * reduced[r + axis]) / total;
      // Surface in the face itself decides nothing about the cell interior.
      if (height <= 1e-9 || height >= 1 - 1e-9) continue;
      // The projected winding is the axis component of the outward normal.
      const facing = total * orientation;
      if (height < first) { first = height; firstFacing = facing; }
      if (height > last) { last = height; lastFacing = facing; }
    }
    // Leaving the solid upward first, and entering it upward last.
    if (first !== Infinity) votes += firstFacing > 0 && lastFacing < 0 ? 1 : -1;
  }
  return votes === 0 ? null : votes > 0;
}

/**
 * Display triangles for a closed surface mesh in `cell`.
 *
 * mesh: { vertices: XYZ, triangles } with outward face normals; `reverse`
 * flips the faces first (OVITO shows the DXA defect mesh that way).
 * origin: the periodic display origin, in fractions of the cell vectors.
 * spaceFilling: whether a mesh without any triangle encloses everything.
 *
 * Returns positions and normals per vertex and one index list: the surface
 * triangles first, then the caps of each periodic cell face. `capRanges`
 * lists those faces as { axis, side, first, count } in index units.
 */
export function buildSurfaceDisplayMesh(mesh, cell, { origin = [0, 0, 0], caps = true, reverse = false, spaceFilling = false } = {}) {
  const sourceVertices = validateMesh(mesh), sourceTriangles = mesh.triangles.length / 3;
  if (origin?.length !== 3 || !Array.from(origin).every(Number.isFinite)) throw new Error('The periodic display origin needs three finite fractions.');
  const periodic = Array.from(cell.pbc, Boolean), h = cell.vectors, cellOrigin = cell.origin;
  const orientation = determinant3(h) < 0 ? -1 : 1;
  let vertexCount = sourceVertices, triangleCount = sourceTriangles;
  const capacity = Math.ceil(sourceVertices * 1.25) + 64;
  let reduced = reducedCoordinates(mesh.vertices, cell, origin, capacity);
  let normals = new Float32Array(capacity * 3), flags = new Uint8Array(capacity);
  let triangles = new Uint32Array(Math.ceil(sourceTriangles * 1.5) * 3 + 96);
  if (reverse) {
    for (let index = 0; index < sourceTriangles * 3; index += 3) {
      triangles[index] = mesh.triangles[index]; triangles[index + 1] = mesh.triangles[index + 2]; triangles[index + 2] = mesh.triangles[index + 1];
    }
  } else triangles.set(mesh.triangles);
  {
    const sums = new Float64Array(sourceVertices * 3);
    accumulateNormals(reduced, triangles, sourceTriangles, cell, sums);
    normalize(sums, sourceVertices);
    normals.set(sums);
  }

  // A facet lying in a periodic cell face belongs to the side of its solid:
  // an upward facet closes solid below the face and is shown on the upper
  // face, a downward one on the lower face. Other vertices on a face go to the
  // lower one.
  let upperFace = new Uint8Array(capacity);
  for (let axis = 0; axis < 3; axis += 1) {
    if (!periodic[axis]) continue;
    const uAxis = (axis + 1) % 3, vAxis = (axis + 2) % 3;
    const image = (from, to, component) => {
      const delta = reduced[to * 3 + component] - reduced[from * 3 + component];
      return periodic[component] ? delta - Math.floor(delta + 0.5) : delta;
    };
    for (let index = 0; index < sourceTriangles * 3; index += 3) {
      const a = triangles[index], b = triangles[index + 1], c = triangles[index + 2];
      if (!Number.isInteger(reduced[a * 3 + axis]) || !Number.isInteger(reduced[b * 3 + axis]) || !Number.isInteger(reduced[c * 3 + axis])) continue;
      const normal = image(a, b, uAxis) * image(a, c, vAxis) - image(a, b, vAxis) * image(a, c, uAxis);
      if (normal * orientation > 0) { upperFace[a] |= 1 << axis; upperFace[b] |= 1 << axis; upperFace[c] |= 1 << axis; }
    }
  }

  // Wrap and split one periodic direction after the other, as upstream.
  for (let axis = 0; axis < 3; axis += 1) {
    if (!periodic[axis]) continue;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const wrapped = reduced[vertex * 3 + axis] - Math.floor(reduced[vertex * 3 + axis]);
      reduced[vertex * 3 + axis] = wrapped === 0 && (upperFace[vertex] & (1 << axis)) ? 1 : wrapped;
    }
    const cuts = new Map(), bit = 1 << (axis * 2);
    // The two new vertices on an edge from a low to a high vertex: the first
    // lies on the lower cell face next to `low`, the second on the upper face.
    const cut = (low, high) => {
      const key = low * MAX_VERTEX_KEY + high;
      let first = cuts.get(key);
      if (first !== undefined) return first;
      first = vertexCount; vertexCount += 2;
      reduced = grown(reduced, vertexCount * 3); normals = grown(normals, vertexCount * 3); flags = grown(flags, vertexCount);
      upperFace = grown(upperFace, vertexCount);
      // A cut through an edge of an in-face facet stays on that facet's side.
      upperFace[first] = upperFace[first + 1] = upperFace[low] & upperFace[high];
      const delta = [0, 1, 2].map(component => reduced[high * 3 + component] - reduced[low * 3 + component]);
      delta[axis] -= 1;
      for (let later = axis + 1; later < 3; later += 1) if (periodic[later]) delta[later] -= Math.floor(delta[later] + 0.5);
      const fraction = delta[axis] !== 0 ? reduced[low * 3 + axis] / -delta[axis] : 0.5;
      let length = 0;
      for (let component = 0; component < 3; component += 1) {
        const value = component === axis ? 0 : reduced[low * 3 + component] + delta[component] * fraction;
        reduced[first * 3 + component] = value; reduced[first * 3 + 3 + component] = component === axis ? 1 : value;
        const normal = normals[low * 3 + component] * (1 - fraction) + normals[high * 3 + component] * fraction;
        normals[first * 3 + component] = normal; length += normal * normal;
      }
      length = Math.sqrt(length) || 1;
      for (let component = 0; component < 3; component += 1) {
        normals[first * 3 + component] /= length; normals[first * 3 + 3 + component] = normals[first * 3 + component];
      }
      const inherited = flags[low] & flags[high];
      flags[first] = inherited | bit; flags[first + 1] = inherited | (bit << 1);
      cuts.set(key, first);
      return first;
    };
    const corner = [0, 0, 0], long = [false, false, false], nearStart = [0, 0, 0], nearEnd = [0, 0, 0];
    const before = triangleCount;
    for (let triangle = 0; triangle < before; triangle += 1) {
      for (let index = 0; index < 3; index += 1) corner[index] = triangles[triangle * 3 + index];
      let crossing = 0;
      for (let index = 0; index < 3; index += 1) {
        long[index] = Math.abs(reduced[corner[(index + 1) % 3] * 3 + axis] - reduced[corner[index] * 3 + axis]) >= 0.5;
        if (long[index]) crossing += 1;
      }
      if (!crossing) continue;
      if (crossing !== 2) throw new Error('The surface mesh cannot be wrapped into the cell: the cell is too small for its faces.');
      const proper = long[0] ? long[1] ? 2 : 1 : 0, second = (proper + 1) % 3, third = (proper + 2) % 3;
      for (const index of [second, third]) {
        const start = corner[index], end = corner[(index + 1) % 3];
        if (reduced[end * 3 + axis] > reduced[start * 3 + axis]) { const first = cut(start, end); nearStart[index] = first; nearEnd[index] = first + 1; }
        else { const first = cut(end, start); nearStart[index] = first + 1; nearEnd[index] = first; }
      }
      triangles = grown(triangles, (triangleCount + 2) * 3);
      triangles.set([corner[proper], corner[second], nearEnd[third]], triangle * 3);
      triangles.set([corner[second], nearStart[second], nearEnd[third], nearEnd[second], corner[third], nearStart[third]], triangleCount * 3);
      triangleCount += 2;
    }
  }

  // Cap polygons, built once per periodic direction on the lower cell face.
  const capPoints = [], capTriangles = [];
  if (caps && periodic.some(Boolean)) {
    const edges = [[], [], []];
    for (let index = 0; index < triangleCount * 3; index += 3) {
      for (let side = 0; side < 3; side += 1) {
        const from = triangles[index + side], to = triangles[index + (side + 1) % 3], shared = flags[from] & flags[to] & 0b010101;
        if (!shared) continue;
        for (let axis = 0; axis < 3; axis += 1) if (shared & (1 << (axis * 2))) edges[axis].push(from, to);
      }
    }
    for (let axis = 0; axis < 3; axis += 1) {
      if (!periodic[axis]) continue;
      const uAxis = (axis + 1) % 3, vAxis = (axis + 2) % 3, points = { u: [], v: [] };
      const next = new Map(), incoming = new Set(), pointOf = new Map();
      for (let index = 0; index < edges[axis].length; index += 2) { next.set(edges[axis][index], edges[axis][index + 1]); incoming.add(edges[axis][index + 1]); }
      const point = vertex => {
        let index = pointOf.get(vertex);
        if (index === undefined) {
          index = points.u.length; pointOf.set(vertex, index);
          points.u.push(reduced[vertex * 3 + uAxis]); points.v.push(reduced[vertex * 3 + vAxis]);
        }
        return index;
      };
      const open = [], loops = [], visited = new Set();
      const walk = start => {
        const contour = [];
        for (let vertex = start; vertex !== undefined && !visited.has(vertex); vertex = next.get(vertex)) { visited.add(vertex); contour.push(point(vertex)); }
        // In a left-handed cell the solid is on the other side of each edge.
        return orientation < 0 ? contour.reverse() : contour;
      };
      for (const start of next.keys()) if (!incoming.has(start)) open.push(walk(start));
      for (const start of next.keys()) if (!visited.has(start)) loops.push(walk(start));
      const periodicU = periodic[uAxis], periodicV = periodic[vAxis];
      if (open.length) loops.push(...closeOpenContours(points, open, periodicU, periodicV));
      else if (periodicU && periodicV) {
        // No contour reaches the outline of the face: it is entirely solid
        // or entirely empty there. The largest loop surrounds the others.
        let inside;
        if (loops.length) {
          let largest = 0;
          for (const loop of loops) { const area = loopArea(points.u, points.v, loop); if (Math.abs(area) > Math.abs(largest)) largest = area; }
          inside = largest < 0;
        } else inside = triangleCount ? faceInsideSolid(reduced, triangles, triangleCount, axis, orientation) === true : Boolean(spaceFilling);
        if (inside) {
          const first = points.u.length;
          points.u.push(0, 1, 1, 0); points.v.push(0, 0, 1, 1);
          loops.push([first, first + 1, first + 2, first + 3]);
        }
      }
      const filled = triangulateLoops(points.u, points.v, loops);
      if (filled.length) { capPoints[axis] = points; capTriangles[axis] = filled; }
    }
  }

  // Assemble Cartesian positions: surface vertices, then both caps per axis.
  let capVertexCount = 0, capIndexCount = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    if (!capTriangles[axis]) continue;
    capVertexCount += capPoints[axis].u.length * 2; capIndexCount += capTriangles[axis].length * 2;
  }
  const totalVertices = vertexCount + capVertexCount;
  const positions = new Float64Array(totalVertices * 3), outputNormals = new Float32Array(totalVertices * 3);
  const indices = new Uint32Array(triangleCount * 3 + capIndexCount);
  const cartesian = (a, b, c, vertex) => {
    positions[vertex * 3] = cellOrigin[0] + a * h[0] + b * h[3] + c * h[6];
    positions[vertex * 3 + 1] = cellOrigin[1] + a * h[1] + b * h[4] + c * h[7];
    positions[vertex * 3 + 2] = cellOrigin[2] + a * h[2] + b * h[5] + c * h[8];
  };
  for (let vertex = 0; vertex < vertexCount; vertex += 1) cartesian(reduced[vertex * 3], reduced[vertex * 3 + 1], reduced[vertex * 3 + 2], vertex);
  outputNormals.set(normals.subarray(0, vertexCount * 3));
  indices.set(triangles.subarray(0, triangleCount * 3));
  const capRanges = [];
  let vertexCursor = vertexCount, indexCursor = triangleCount * 3;
  for (let axis = 0; axis < 3; axis += 1) {
    if (!capTriangles[axis]) continue;
    const uAxis = (axis + 1) % 3, vAxis = (axis + 2) % 3, { u: pu, v: pv } = capPoints[axis], filled = capTriangles[axis];
    // Outward normal of the upper face: along the cell vector's side.
    const a = [h[uAxis * 3], h[uAxis * 3 + 1], h[uAxis * 3 + 2]], b = [h[vAxis * 3], h[vAxis * 3 + 1], h[vAxis * 3 + 2]];
    let normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const length = Math.hypot(...normal) * orientation;
    normal = normal.map(value => value / length);
    for (let side = 0; side < 2; side += 1) {
      const firstVertex = vertexCursor, firstIndex = indexCursor, coordinates = [0, 0, 0];
      for (let index = 0; index < pu.length; index += 1) {
        coordinates[axis] = side; coordinates[uAxis] = pu[index]; coordinates[vAxis] = pv[index];
        cartesian(coordinates[0], coordinates[1], coordinates[2], vertexCursor);
        for (let component = 0; component < 3; component += 1) outputNormals[vertexCursor * 3 + component] = (side ? normal[component] : -normal[component]) || 0;
        vertexCursor += 1;
      }
      // Loops are counterclockwise seen from inside the cell at the lower
      // face; both caps face out of the cell.
      const flip = (side === 0) === (orientation > 0);
      for (let index = 0; index < filled.length; index += 3) {
        indices[indexCursor++] = firstVertex + filled[index];
        indices[indexCursor++] = firstVertex + filled[index + (flip ? 2 : 1)];
        indices[indexCursor++] = firstVertex + filled[index + (flip ? 1 : 2)];
      }
      capRanges.push({ axis, side, first: firstIndex, count: indexCursor - firstIndex });
    }
  }
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 1) {
    const axis = index % 3;
    if (positions[index] < minimum[axis]) minimum[axis] = positions[index];
    if (positions[index] > maximum[axis]) maximum[axis] = positions[index];
  }
  return { positions, normals: outputNormals, indices, vertexCount: totalVertices, surfaceVertexCount: vertexCount,
    surfaceIndexCount: triangleCount * 3, capRanges, capIndexCount, minimum, maximum };
}

/** Signed volume enclosed by display triangles (divergence theorem); with
 * caps the wrapped mesh is closed and this is the solid volume in the cell. */
export function displayMeshVolume(display, { caps = true } = {}) {
  const { positions, indices } = display, end = caps ? indices.length : display.surfaceIndexCount;
  let volume = 0;
  for (let index = 0; index < end; index += 3) {
    const a = indices[index] * 3, b = indices[index + 1] * 3, c = indices[index + 2] * 3;
    volume += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      + positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return volume / 6;
}

/** Total area of display triangles in [first, first + count). */
export function displayMeshArea(display, first = 0, count = display.indices.length) {
  const { positions, indices } = display;
  let area = 0;
  for (let index = first; index < first + count; index += 3) {
    const a = indices[index] * 3, b = indices[index + 1] * 3, c = indices[index + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}

/** Edges used by exactly one triangle; none for a closed mesh. Vertices
 * closer than `tolerance` count as one: caps repeat the cut vertices with
 * their own normals, and a cut through a vertex leaves copies of it that
 * differ by rounding. */
export function displayMeshOpenEdges(display, { caps = true, tolerance = 1e-7 } = {}) {
  const { positions, indices } = display, end = caps ? indices.length : display.surfaceIndexCount;
  const ids = new Map(), welded = new Int32Array(display.vertexCount).fill(-1);
  const id = vertex => {
    if (welded[vertex] >= 0) return welded[vertex];
    // A coordinate near a grid boundary is also looked up in the next cell.
    const cells = [0, 1, 2].map(axis => {
      const scaled = positions[vertex * 3 + axis] / tolerance, cell = Math.round(scaled), rest = scaled - cell;
      return Math.abs(rest) > 0.25 ? [cell, cell + Math.sign(rest)] : [cell];
    });
    let found;
    for (const x of cells[0]) for (const y of cells[1]) for (const z of cells[2]) found ??= ids.get(`${x},${y},${z}`);
    if (found === undefined) { found = ids.size; ids.set(`${cells[0][0]},${cells[1][0]},${cells[2][0]}`, found); }
    welded[vertex] = found;
    return found;
  };
  const edges = new Map();
  for (let index = 0; index < end; index += 3) {
    const corners = [id(indices[index]), id(indices[index + 1]), id(indices[index + 2])];
    if (corners[0] === corners[1] || corners[1] === corners[2] || corners[2] === corners[0]) continue;
    for (let side = 0; side < 3; side += 1) {
      const from = corners[side], to = corners[(side + 1) % 3], forward = `${from}>${to}`, backward = `${to}>${from}`;
      if (edges.get(backward) > 0) edges.set(backward, edges.get(backward) - 1);
      else edges.set(forward, (edges.get(forward) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const count of edges.values()) open += count;
  return open;
}
