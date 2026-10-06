import { buildStatisticsTable, csvChunks } from '../statistics-export.js';

let snapshot = null;
self.addEventListener('message', event => {
  const { id, type, payload } = event.data;
  try {
    if (type === 'clear') { snapshot = null; self.postMessage({ id, ok: true, result: null }); return; }
    if (type !== 'export') throw new Error('Unknown statistics export request.');
    if (payload.snapshot) snapshot = payload.snapshot;
    const table = buildStatisticsTable(snapshot, payload.kind);
    // Blob parts are bounded chunks, avoiding an additional all-rows array and
    // a giant joined string for per-atom and per-face output. Blobs themselves
    // are shared by structured cloning rather than copying their byte storage.
    const parts = [];
    for (const chunk of csvChunks(table)) parts.push(new Blob([chunk]));
    const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
    self.postMessage({ id, ok: true, result: { blob, filename: table.filename, kind: table.kind } });
  } catch (error) { self.postMessage({ id, ok: false, error: error.message || String(error) }); }
});
