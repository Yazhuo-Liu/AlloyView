const MEBIBYTE = 1024 ** 2;
const GIBIBYTE = 1024 ** 3;

export function estimateFrameBytes(frame) {
  const buffers = new Set(), visited = new Set(), pending = [frame];
  let bytes = 0;
  // Physical replication retains the parsed source for switching back, and
  // uses stable compound IDs stored as strings rather than a typed ID buffer.
  bytes += Math.max(0, Number(frame?.processingSourceBytes) || 0);
  if (Array.isArray(frame?.ids)) {
    for (const id of frame.ids) bytes += 16 + (typeof id === 'string' ? id.length * 2 : 8);
  }
  const includeBuffer = (buffer) => {
    if (buffers.has(buffer)) return;
    buffers.add(buffer);
    bytes += buffer.byteLength;
  };
  // Analysis caches can nest arrays below result/metadata records, Maps and
  // Sets. Walk their containers, but never enumerate per-atom typed elements.
  // A view retains its complete backing allocation, even when it is a slice.
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
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
  return bytes;
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
  const budgetBytes = Math.max(estimatedFrameBytes, Math.floor(Math.min(...budgets)));
  const minimum = Math.min(count, 3);
  const capacity = Math.max(minimum, Math.floor(budgetBytes / estimatedFrameBytes));
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
