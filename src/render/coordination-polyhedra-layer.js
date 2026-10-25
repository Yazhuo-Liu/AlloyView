import { parsePrimitiveColor } from './atom-primitives.js';
import { createVoronoiCellBatch, VoronoiAllCellLayer } from './voronoi-cell-layer.js';

const geometryCache = new WeakMap();
const validatedGeometry = new WeakMap();

export function normalizeCoordinationPolyhedraOptions(options = {}, previous = {}) {
  const color = options.color ?? previous.color ?? '#3b82f6';
  parsePrimitiveColor(color);
  const opacity = Number(options.opacity ?? previous.opacity ?? .35);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Coordination polyhedron opacity must be between zero and one.');
  const visible = options.visible ?? previous.visible ?? true;
  const showEdges = options.showEdges ?? previous.showEdges ?? true;
  if (typeof visible !== 'boolean' || typeof showEdges !== 'boolean') throw new Error('Coordination polyhedron visibility and edges must be boolean.');
  return { visible, color, opacity, showEdges };
}

/** Workers return already packed local hulls. Direct kernel callers may supply
 * cells instead; pack those once and share that immutable geometry between the
 * main view, second view and context restoration. Polyhedra are anchored to
 * their central atom, with real neighbor vectors retained across cell faces. */
export function coordinationPolyhedraGeometry(result, atomCount) {
  if (result == null) return null;
  if (typeof result !== 'object') throw new Error('Invalid coordination polyhedron result.');
  let geometry = result.geometry;
  if (!geometry) {
    if (!Array.isArray(result.cells)) throw new Error('Coordination polyhedra require hull cells or packed geometry.');
    const cached = geometryCache.get(result);
    if (cached?.cells === result.cells) geometry = cached.geometry;
    else {
      const chunks = [];
      for (let start = 0; start < result.cells.length; start += 256) {
        // Coordination hulls have no Voronoi face ownership: each hull must
        // remain complete even when two selected centers share neighbors.
        const cells = result.cells.slice(start, start + 256).map(cell => ({ ...cell, faceNeighbors: undefined }));
        const chunk = createVoronoiCellBatch(cells);
        if (!chunk.values.every(Number.isFinite)) throw new Error('Coordination polyhedron coordinates exceed the renderer numeric range.');
        chunks.push(chunk);
      }
      geometry = { chunks, cellCount: result.cells.length, complete: true };
      geometryCache.set(result, { cells: result.cells, geometry });
    }
  }
  if (!geometry || typeof geometry !== 'object' || !Number.isInteger(atomCount) || atomCount < 0) throw new Error('Invalid coordination polyhedron geometry.');
  // Worker packing already checks numerical values; main-thread preflight
  // checks array layout and source ownership, without rescanning every vertex.
  if (validatedGeometry.get(geometry) === atomCount) return geometry;
  if (!Array.isArray(geometry.chunks)
    || !Number.isInteger(geometry.cellCount) || geometry.cellCount < 0) throw new Error('Invalid coordination polyhedron geometry.');
  let cells = 0;
  for (const chunk of geometry.chunks) {
    if (!(chunk.values instanceof Float32Array) || !(chunk.indices instanceof Uint32Array)
      || !(chunk.cellIds instanceof Uint32Array) || !(chunk.bounds instanceof Float64Array)
      || !(chunk.cellRanges instanceof Uint32Array) || !(chunk.foreignFaces instanceof Uint32Array)
      || !(chunk.foreignEdges instanceof Uint32Array) || chunk.foreignFaces.length || chunk.foreignEdges.length
      || !Number.isInteger(chunk.cellCount) || chunk.cellCount < 0
      || !Number.isInteger(chunk.vertexCount) || chunk.vertexCount < 0
      || !Number.isInteger(chunk.edgeCount) || chunk.edgeCount < 0
      || chunk.values.length !== (chunk.vertexCount + chunk.edgeCount) * 6
      || chunk.cellIds.length !== (chunk.vertexCount + chunk.edgeCount) * 2
      || chunk.indices.length !== chunk.indexCount || chunk.indexCount % 3
      || chunk.bounds.length !== chunk.cellCount * 7 || chunk.cellRanges.length !== chunk.cellCount * 5) {
      throw new Error('Invalid packed coordination polyhedron geometry.');
    }
    for (let cell = 0; cell < chunk.cellCount; cell++) {
      const atom = chunk.cellRanges[cell * 5];
      if (atom >= atomCount || chunk.bounds[cell * 7] !== atom) throw new Error('A coordination polyhedron is outside the current frame.');
    }
    cells += chunk.cellCount;
  }
  if (cells !== geometry.cellCount) throw new Error('The coordination polyhedron count does not match its geometry.');
  validatedGeometry.set(geometry, atomCount);
  return geometry;
}

/** Independent buffers, shared shaders: scientific hulls are not Voronoi
 * tessellation cells, but their local polygon rendering uses the same robust
 * clipping, face lighting, edge ribbons and selected-center highlighting. */
export class CoordinationPolyhedraLayer extends VoronoiAllCellLayer {
  setPolyhedra(geometry, options) {
    this.showEdges = options.showEdges;
    this.setGeometry(geometry, { allEnabled: options.visible, color: options.color,
      opacity: options.opacity, style: 'xray', scale: 1 });
  }
}
