import { buildSurfaceDisplayMesh } from '../render/surface-mesh-geometry.js';
import { createMeshExport } from '../io/mesh-export.js';

const sources = new Map();
const cancelled = new Set();
let completed = 0;
self.postMessage({ type: 'ready' });
const residentBytes = source => source ? source.mesh.vertices.byteLength + source.mesh.triangles.byteLength
  + source.cell.origin.buffer.byteLength + source.cell.vectors.buffer.byteLength
  + (source.display?.positions.byteLength ?? 0) + (source.display?.normals.byteLength ?? 0)
  + (source.display?.indices.byteLength ?? 0) + (source.values?.byteLength ?? 0) : 0;

/** No native analysis, WebGPU context or per-edit Worker is created. Only the
 * latest prepared recipe of each bounded resident source is kept here. */
self.addEventListener('message', ({ data }) => {
  const { id, type, sourceId } = data;
  if (type === 'drop') { sources.delete(sourceId); return; }
  if (type === 'cancel') { if (id > completed) cancelled.add(id); return; }
  let sourceReady = false;
  try {
    if (data.mesh) sources.set(sourceId, { mesh: data.mesh, cell: data.cell, key: null, display: null, values: null });
    const source = sources.get(sourceId);
    if (!source) throw new Error('The surface source is no longer resident.');
    sourceReady = true;
    const checkCancelled = () => {
      if (cancelled.has(id) || (data.cancelWord && Atomics.load(data.cancelWord, 0))) {
        throw new DOMException('Surface geometry preparation was cancelled.', 'AbortError');
      }
    };
    checkCancelled();
    const key = JSON.stringify(data.settings), startedAt = performance.now();
    if (source.key !== key) {
      const display = buildSurfaceDisplayMesh(source.mesh, source.cell, { ...data.settings, checkCancelled });
      const values = new Float32Array(display.vertexCount * 6);
      for (let vertex = 0; vertex < display.vertexCount; vertex++) {
        if ((vertex & 1023) === 0) checkCancelled();
        const first = vertex * 3, target = vertex * 6;
        values.set(display.positions.subarray(first, first + 3), target);
        values.set(display.normals.subarray(first, first + 3), target + 3);
      }
      source.key = key; source.display = display; source.values = values;
    }
    checkCancelled();
    if (type === 'export') {
      const file = createMeshExport(source.display, data.format, data.exportOptions);
      checkCancelled();
      // Formatting and compaction remain on the Worker; the page receives only
      // the finished file and small metadata, rather than another atom mesh.
      self.postMessage({ id, ok: true, sourceReady, residentBytes: residentBytes(source), result: { blob: file.blob, filename: file.filename,
        vertexCount: file.vertexCount, triangleCount: file.triangleCount } });
    } else {
      // Retain the prepared geometry for export and repeated views. Transfer
      // private copies once; both renderers share this one page-side result.
      const display = { ...source.display, positions: source.display.positions.slice(), normals: source.display.normals.slice(),
        indices: source.display.indices.slice() }, values = source.values.slice();
      self.postMessage({ id, ok: true, sourceReady, residentBytes: residentBytes(source), result: { display, values, buildMs: performance.now() - startedAt } },
        [display.positions.buffer, display.normals.buffer, display.indices.buffer, values.buffer]);
    }
  } catch (error) {
    self.postMessage({ id, ok: false, sourceReady, residentBytes: residentBytes(sources.get(sourceId)), error: { name: error.name, message: error.message || String(error) } });
  } finally { cancelled.delete(id); completed = Math.max(completed, id); }
});
