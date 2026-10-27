import { THERMAL_PROPERTY_NAMES } from '../crystal/thermal-ellipsoids.js';
import { MAX_STRUCTURE_EXPORT_ATOMS, MAX_STRUCTURE_EXPORT_BYTES } from './structure-export.js';
import { runCooperativeStepsAsync } from '../shared/cooperative-steps.js';

const properties = new Set(['occupancy', 'Uiso', 'uiso', 'U_iso_or_equiv', 'Biso', 'biso', 'bfactor',
  ...THERMAL_PROPERTY_NAMES, 'B_iso_or_equiv', 'selectiveDynamicsX', 'selectiveDynamicsY', 'selectiveDynamicsZ']);
const abortError = () => new DOMException('Structure export cancelled.', 'AbortError');
const failure = message => new Error(`Structure export: ${message}`);
const sameKey = (left, right) => left?.length === right.length && right.every((value, index) => Object.is(value, left[index]));

/** One retained formatter Worker shares the application's CPU admission budget.
 * Source arrays are immutable between revisions, as for analysis snapshots;
 * in-place geometry/property edits must increment the corresponding revision
 * or call clearSnapshot(). Only the last acknowledged frame is cached. */
export class StructureExportClient {
  constructor({ cpuBudget = null, workerFactory = () => new Worker(
    new URL('../workers/structure-export-worker.js', import.meta.url), { type: 'module' }),
  timeoutMs = 120_000, maxQueued = 8 } = {}) {
    this.cpuBudget = cpuBudget; this.workerFactory = workerFactory;
    this.timeoutMs = timeoutMs; this.maxQueued = maxQueued;
    this.worker = null; this.queue = []; this.active = null;
    this.nextId = 1; this.generation = 0; this.cached = null; this.closed = false;
    this.frameIds = new WeakMap(); this.nextFrameId = 1;
  }

  export(frame, options = {}, { signal } = {}) {
    return this.enqueue('export', { frame, options: { format: options.format, stem: options.stem,
      title: options.title, maxBytes: options.maxBytes } }, signal);
  }

  exportPolyhedra(frame, result, options = {}, { signal } = {}) {
    return this.enqueue('export-polyhedra', { frame, result,
      options: { stem: options.stem, maxBytes: options.maxBytes } }, signal);
  }

  /** Source barriers reject obsolete downloads immediately, but retain a busy
   * Worker's lease until cancellation is acknowledged. The clear command is
   * ordered before any subsequently requested export. */
  clearSnapshot() {
    if (this.closed) return Promise.resolve();
    this.generation++; this.cached = null;
    for (const task of [...this.queue]) if (task.type !== 'clear') this.cancel(task);
    if (this.active?.type !== 'clear') this.cancel(this.active);
    // Clearing is also used from frame-navigation teardown. A failed Worker
    // has already been retired, so cleanup must not reject source loading.
    return this.enqueue('clear', {}).catch(() => {});
  }

  dispose() {
    if (this.closed) return;
    this.closed = true; this.cached = null; this.generation++;
    for (const task of this.queue.splice(0)) { task.controller.abort(); this.settle(task, abortError()); }
    if (this.active) {
      const task = this.active;
      task.controller.abort(); this.settle(task, abortError());
      this.dropWorker(); this.finish(task);
    } else this.dropWorker();
  }

  enqueue(type, input, signal) {
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    if (type !== 'clear' && this.queue.length >= this.maxQueued) return Promise.reject(failure('too many queued downloads.'));
    return new Promise((resolve, reject) => {
      const task = { id: this.nextId++, type, ...input, resolve, reject, signal,
        generation: this.generation, controller: new AbortController(), settled: false, posted: false };
      task.abort = () => this.cancel(task);
      signal?.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task); this.pump();
    });
  }

  settle(task, error, result) {
    if (task.settled) return;
    task.settled = true; task.signal?.removeEventListener('abort', task.abort);
    if (error) task.reject(error); else task.resolve(result);
  }

  cancel(task) {
    if (!task || task.settled) return;
    task.controller.abort(); this.settle(task, abortError());
    const index = this.queue.indexOf(task);
    if (index >= 0) this.queue.splice(index, 1);
    else if (task === this.active && task.posted) {
      try { this.worker.postMessage({ type: 'cancel', id: task.id }); }
      catch (error) { this.workerFailed(this.worker, error); }
    }
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.addEventListener('message', event => this.reply(worker, event.data));
    worker.addEventListener('error', event => this.workerFailed(worker, failure(event.message || 'formatter Worker failed.')));
    worker.addEventListener('messageerror', () => this.workerFailed(worker, failure('formatter Worker returned an unreadable message.')));
    return worker;
  }

  dropWorker() {
    const worker = this.worker;
    this.worker = null; this.cached = null;
    worker?.terminate();
  }

  workerFailed(worker, error) {
    if (worker !== this.worker) return;
    this.dropWorker();
    if (this.active) {
      const task = this.active;
      task.controller.abort(); this.settle(task, error); this.finish(task);
    }
  }

  async pump() {
    if (this.active || this.closed || !this.queue.length) return;
    const task = this.active = this.queue.shift();
    try {
      if (task.type === 'clear' && !this.worker) {
        this.settle(task, null); this.finish(task); return;
      }
      if (task.type !== 'clear' && this.cpuBudget) {
        const lease = await this.cpuBudget.acquire(1, { signal: task.controller.signal, owner: this });
        if (this.active !== task || task.controller.signal.aborted) { lease.release(); throw abortError(); }
        task.lease = lease;
      }
      let payload = {}, transfer = [];
      if (task.type === 'export') {
        if (!task.frame || typeof task.frame !== 'object') throw failure('a loaded crystal is required.');
        if (!this.frameIds.has(task.frame)) this.frameIds.set(task.frame, this.nextFrameId++);
        task.key = snapshotKey(task.frame, this.frameIds.get(task.frame));
        if (this.cached && sameKey(this.cached.key, task.key)) task.snapshotId = this.cached.id;
        else {
          payload.snapshot = await runCooperativeStepsAsync(copySnapshot(task.frame), { signal: task.controller.signal });
          task.snapshotId = task.id;
          transfer = snapshotTransfers(payload.snapshot);
        }
        payload.snapshotId = task.snapshotId;
      } else if (task.type === 'export-polyhedra') {
        payload.rows = await runCooperativeStepsAsync(copyPolyhedraRows(task.frame, task.result), { signal: task.controller.signal });
      }
      if (this.active !== task || task.controller.signal.aborted) throw abortError();
      const worker = this.ensureWorker();
      task.posted = true;
      task.timer = setTimeout(() => this.workerFailed(worker, failure('formatter Worker timed out.')), this.timeoutMs);
      worker.postMessage({ type: task.type, id: task.id, options: task.options, ...payload }, transfer);
      // Keep only the cache identity, not an unrelated full polyhedra graph.
      task.frame = null; task.result = null;
    } catch (error) {
      if (this.active !== task) return;
      if (task.posted) this.dropWorker();
      this.settle(task, error); this.finish(task);
    }
  }

  reply(worker, message) {
    const task = this.active;
    if (worker !== this.worker || !task || message?.id !== task.id) return;
    if (typeof message.ok !== 'boolean' || message.ok && task.type !== 'clear'
        && !(message.result?.blob instanceof Blob)) {
      this.workerFailed(worker, failure('formatter Worker returned a malformed result.')); return;
    }
    if (task.type === 'export' && message.snapshotId === task.snapshotId && task.generation === this.generation) {
      this.cached = { id: task.snapshotId, key: task.key };
    }
    const error = message.ok ? null : message.name === 'AbortError' ? abortError()
      : failure(message.error || 'formatting failed.');
    this.settle(task, error, message.result); this.finish(task);
  }

  finish(task) {
    clearTimeout(task.timer); task.lease?.release(); task.lease = null;
    task.signal?.removeEventListener('abort', task.abort);
    task.frame = null; task.result = null; task.key = null;
    if (this.active === task) { this.active = null; this.pump(); }
  }
}

function snapshotKey(frame, identity) {
  if (!frame) throw failure('a loaded crystal is required.');
  // Weak identity avoids retaining unrelated analysis graphs through a frame.
  const key = [identity, frame.geometryRevision, frame.propertyRevision, frame.types, frame.positions, frame.fractional,
    frame.comment, frame.title, frame.crystal?.disordered, ...(frame.cell?.vectors ?? []),
    ...(frame.cell?.origin ?? []), ...(frame.cell?.pbc ?? []), ...(frame.typeLabels ?? [])];
  for (const property of frame.properties ?? []) if (properties.has(property.name)) {
    key.push(property.name, property.data, property.categories);
  }
  return key;
}

function* copySnapshot(frame) {
  const count = frame.types?.length;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STRUCTURE_EXPORT_ATOMS
      || frame.positions?.length !== 3 * count || frame.fractional?.length !== 3 * count
      || !Array.isArray(frame.typeLabels) || frame.typeLabels.length > 65_536) throw failure('a complete bounded crystal is required.');
  const selected = (frame.properties ?? []).filter(property => properties.has(property.name));
  if (selected.some(property => property.data?.length !== count)) throw failure('an exported property has the wrong atom count.');
  const arrays = [frame.types, frame.positions, frame.fractional, ...selected.map(property => property.data)];
  const bytes = arrays.reduce((sum, array) => sum + array.length * (array.BYTES_PER_ELEMENT || 8), 0);
  if (bytes > MAX_STRUCTURE_EXPORT_BYTES) throw failure('the private snapshot exceeds the memory budget.');
  const copies = [];
  for (const array of arrays) {
    if (!Array.isArray(array) && (!ArrayBuffer.isView(array) || array instanceof DataView)
        || typeof array[0] !== 'number') throw failure('exported coordinates and properties must be numeric arrays.');
    const copy = Array.isArray(array) ? new Float64Array(array.length) : new array.constructor(array.length);
    for (let start = 0; start < array.length; start += 65_536) {
      yield;
      const end = Math.min(array.length, start + 65_536);
      if (Array.isArray(array)) {
        for (let index = start; index < end; index++) {
          if (typeof array[index] !== 'number') throw failure('exported coordinates and properties must be numeric arrays.');
          copy[index] = array[index];
        }
      } else copy.set(array.subarray(start, end), start);
    }
    copies.push(copy);
  }
  return { types: copies[0], positions: copies[1], fractional: copies[2], typeLabels: [...frame.typeLabels],
    cell: frame.cell && { vectors: Array.from(frame.cell.vectors ?? []), origin: Array.from(frame.cell.origin ?? []), pbc: Array.from(frame.cell.pbc ?? []) },
    properties: selected.map((property, index) => ({ name: property.name, data: copies[index + 3], categories: !!property.categories })),
    crystal: { disordered: !!frame.crystal?.disordered }, comment: frame.comment, title: frame.title };
}

function snapshotTransfers(snapshot) {
  return [snapshot.types.buffer, snapshot.positions.buffer, snapshot.fractional.buffer,
    ...snapshot.properties.map(property => property.data.buffer)];
}

function* copyPolyhedraRows(frame, result) {
  const cells = result?.cells, count = frame?.types?.length;
  if (!Array.isArray(cells) || cells.length > MAX_STRUCTURE_EXPORT_ATOMS || !Number.isSafeInteger(count)) {
    throw failure('completed coordination polyhedra are required.');
  }
  // Row arrays include object/slot overhead, not merely nine doubles. Bound
  // the private snapshot before cloning anything, then account for labels.
  let bytes = cells.length * 192;
  if (bytes > MAX_STRUCTURE_EXPORT_BYTES) throw failure('the polyhedra snapshot exceeds the memory budget.');
  const rows = [];
  for (let index = 0; index < cells.length; index++) {
    if ((index & 1023) === 0) yield;
    const cell = cells[index], atom = cell.atomIndex;
    if (!Number.isSafeInteger(atom) || atom < 0 || atom >= count) throw failure('a polyhedron has an invalid central atom.');
    const id = frame.ids?.[atom] ?? atom + 1;
    const label = frame.typeLabels?.[frame.types[atom]] ?? String(frame.types[atom]);
    if (!['number', 'string'].includes(typeof id) || typeof label !== 'string') throw failure('polyhedra need numeric or text atom IDs and element labels.');
    bytes += (typeof id === 'string' ? id.length * 2 : 0) + label.length * 2;
    if (bytes > MAX_STRUCTURE_EXPORT_BYTES) throw failure('the polyhedra snapshot exceeds the memory budget.');
    rows.push([atom, id, label,
      cell.coordination, cell.volume, cell.surfaceArea, cell.bondLengthMin, cell.bondLengthMax, cell.bondLengthMean]);
  }
  return rows;
}
