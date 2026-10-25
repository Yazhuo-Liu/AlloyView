import { createStructureExportAsync, MAX_STRUCTURE_EXPORT_BYTES, MAX_STRUCTURE_EXPORT_ATOMS } from '../io/structure-export.js';
import { runParserStepsAsync } from '../io/cooperative-parser.js';

let snapshot = null, snapshotId = null, active = null;
self.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'cancel') {
    if (active?.id === message.id) active.controller.abort();
    return;
  }
  void handle(message);
});

async function handle(message) {
  if (!message || !Number.isSafeInteger(message.id)) return;
  const id = message.id;
  if (active) { self.postMessage({ id, ok: false, error: 'The formatter is already busy.' }); return; }
  const task = active = { id, controller: new AbortController() };
  try {
    let result;
    if (message.type === 'clear') { snapshot = null; snapshotId = null; }
    else if (message.type === 'export') {
      if (message.snapshot) { snapshot = message.snapshot; snapshotId = message.snapshotId; }
      if (!snapshot || snapshotId !== message.snapshotId) throw new Error('The requested structure snapshot is no longer available.');
      result = await createStructureExportAsync(snapshot, message.options, { signal: task.controller.signal });
    } else if (message.type === 'export-polyhedra') {
      result = await runParserStepsAsync(polyhedraCsv(message.rows, message.options), { signal: task.controller.signal });
    } else throw new Error('Unknown structure export command.');
    self.postMessage({ id, ok: true, result, snapshotId });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message, name: error.name, snapshotId });
  } finally { if (active === task) active = null; }
}

function* polyhedraCsv(rows, { stem = 'structure', maxBytes = MAX_STRUCTURE_EXPORT_BYTES } = {}) {
  if (!Array.isArray(rows) || rows.length > MAX_STRUCTURE_EXPORT_ATOMS) throw new Error('Invalid polyhedra rows.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STRUCTURE_EXPORT_BYTES) throw new Error('Invalid CSV text budget.');
  const parts = [], encoder = new TextEncoder();
  let bytes = 0;
  const append = text => {
    bytes += encoder.encode(text).length;
    if (bytes > maxBytes) throw new Error('The polyhedra CSV exceeds the export text budget.');
    parts.push(text);
  };
  append('atom_index,atom_id,element,coordination,volume_A3,surface_area_A2,bond_length_min_A,bond_length_max_A,bond_length_mean_A\r\n');
  for (let start = 0; start < rows.length; start += 1024) {
    yield;
    let text = '';
    for (let index = start; index < Math.min(rows.length, start + 1024); index++) {
      const row = rows[index];
      if (!Array.isArray(row) || row.length !== 9) throw new Error('Incomplete polyhedron statistics.');
      if (!Number.isSafeInteger(row[3]) || row[3] < 0 || row.slice(4).some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('Polyhedron statistics must contain finite physical measurements.');
      }
      text += row.map(value => {
        const string = String(value);
        return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
      }).join(',') + '\r\n';
    }
    append(text);
  }
  const safeStem = String(stem).split(/[\\/]/).at(-1).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'structure';
  return { blob: new Blob(parts, { type: 'text/csv;charset=utf-8' }), filename: `${safeStem}-polyhedra.csv`,
    format: 'csv', atomCount: rows.length, cellCount: rows.length };
}
