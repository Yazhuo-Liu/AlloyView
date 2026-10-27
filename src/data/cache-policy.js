import { retainedIdBytes } from './replication-ids.js';

/** Analyses that keep a private per-ID table beside a frame (such as the
 * numeric reference mapping) register an estimator here, so their retained
 * bytes are charged to the frame that owns the IDs without this module
 * depending on any analysis. Each estimator receives a frame's `ids` and
 * returns the bytes it retains for them, or 0. */
const retainedIdBytesEstimators = new Set();
export function registerRetainedIdBytes(estimator) {
  retainedIdBytesEstimators.add(estimator);
  return () => { retainedIdBytesEstimators.delete(estimator); };
}

const MEBIBYTE = 1024 ** 2;
const GIBIBYTE = 1024 ** 3;

export function estimateFrameBytes(frame) {
  let bytes = 0;
  for (const size of frameMemoryUsage(frame).values()) bytes += size;
  return bytes;
}

/** Retained allocations, keyed by their owner, let caches charge a shared
 * backing buffer once even when several frames/properties refer to it. */
export function frameMemoryUsage(frame) {
  const buffers = new Set(), visited = new Set(), pending = [frame];
  const allocations = new Map();
  // Numeric correspondence lookups are weakly keyed by the reference IDs.
  // Their private snapshot/table remains live beside an otherwise unchanged
  // frame, so include it without exposing it as a scientific property.
  let idBytes = 0;
  if (frame?.ids) for (const estimate of retainedIdBytesEstimators) idBytes += estimate(frame.ids);
  // Physical replication retains the parsed source for switching back, and
  // uses stable compound IDs stored as strings rather than a typed ID buffer.
  const knownIdBytes = frame?.ids ? retainedIdBytes(frame.ids) : undefined;
  if (knownIdBytes !== undefined) idBytes += knownIdBytes;
  else if (Array.isArray(frame?.ids)) {
    for (const id of frame.ids) idBytes += 16 + (typeof id === 'string' ? id.length * 2 : 8);
  }
  if (idBytes) allocations.set(frame.ids, idBytes);
  // Source storage is distinct from ID lookups/compound ID storage. Keep the
  // opaque source estimate against the frame that owns it.
  const sourceBytes = Math.max(0, Number(frame?.processingSourceBytes) || 0);
  if (sourceBytes) allocations.set(frame, sourceBytes);
  const includeBuffer = (buffer) => {
    if (buffers.has(buffer)) return;
    buffers.add(buffer);
    allocations.set(buffer, buffer.byteLength);
  };
  // Analysis caches can nest arrays below result/metadata records, Maps and
  // Sets. Walk their containers, but never enumerate per-atom typed elements.
  // A view retains its complete backing allocation, even when it is a slice.
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    if (value === frame?.ids && (knownIdBytes !== undefined || Array.isArray(value))) continue;
    if (ArrayBuffer.isView(value)) { includeBuffer(value.buffer); continue; }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)) {
      includeBuffer(value); continue;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) pending.push(key, entry);
    } else if (value instanceof Set || Array.isArray(value)) {
      for (const entry of value) if (entry && typeof entry === 'object') pending.push(entry);
    } else {
      for (const entry of Object.values(value)) if (entry && typeof entry === 'object') pending.push(entry);
    }
  }
  return allocations;
}

export function chooseFrameCachePolicy(frame, frameCount, environment = {}) {
  const count = Math.max(1, Math.trunc(frameCount));
  const estimatedFrameBytes = Math.max(1, Math.ceil(estimateFrameBytes(frame) * 1.35));
  const heapLimit = finitePositive(environment.heapLimit);
  const heapUsed = finitePositive(environment.heapUsed);
  const deviceMemoryGiB = finitePositive(environment.deviceMemoryGiB);
  const budgets = [512 * MEBIBYTE];
  if (heapLimit) budgets.push(heapLimit * 0.22);
  if (heapLimit && heapUsed && heapUsed < heapLimit) budgets.push((heapLimit - heapUsed) * 0.40);
  if (deviceMemoryGiB) budgets.push(deviceMemoryGiB * GIBIBYTE * 0.12);
  const budgetBytes = Math.max(1, Math.floor(Math.min(...budgets)));
  // The displayed frame is always admitted. Neighbours are optional: three
  // enormous frames must not bypass a small device's memory budget.
  const capacity = Math.max(1, Math.floor(budgetBytes / estimatedFrameBytes));
  const limit = Math.min(count, capacity);
  return {
    limit,
    fullTrajectory: limit === count,
    estimatedFrameBytes,
    budgetBytes,
  };
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
