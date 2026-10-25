import { estimateFrameBytes, frameMemoryUsage } from './cache-policy.js';

export class FrameCache {
  constructor(limit = 3, { byteBudget = Infinity, estimate = estimateFrameBytes } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('The cache limit must be a positive integer.');
    this.limit = limit;
    this.frames = new Map();
    this.byteBudget = checkedBudget(byteBudget);
    this.estimate = estimate;
    this.pinnedIndex = null;
    this.allocations = new Map();
    this.resources = new Map();
    this.retainedBytes = 0;
  }

  get size() { return this.frames.size; }
  get bytes() { return this.retainedBytes; }

  setLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('The cache limit must be a positive integer.');
    this.limit = limit;
    this.trim();
  }

  setByteBudget(bytes) { this.byteBudget = checkedBudget(bytes); this.trim(); }

  /** Only the current display may exceed the byte budget. A pinned index can
   * be set before the frame arrives; speculative neighbours never evict it. */
  pin(index = null) { this.pinnedIndex = index; this.trim(); }

  has(index) { return this.frames.has(index); }

  get(index) {
    const frame = this.frames.get(index);
    if (!frame) return undefined;
    this.frames.delete(index);
    this.frames.set(index, frame);
    return frame;
  }

  set(index, frame) {
    if (this.frames.has(index)) this.delete(index);
    this.frames.set(index, frame);
    this.charge(index, frame);
    this.trim();
    return frame;
  }

  /** Analysis arrays can be attached after parsing. Reassess without moving
   * the frame in LRU order, then enforce the real retained-byte limit. */
  reassess(index) {
    const indices = arguments.length ? [index] : [...this.frames.keys()];
    for (const key of indices) {
      if (!this.frames.has(key)) continue;
      this.uncharge(key); this.charge(key, this.frames.get(key));
    }
    this.trim();
    return this.bytes;
  }

  charge(index, frame) {
    const allocations = this.estimate === estimateFrameBytes ? frameMemoryUsage(frame)
      : new Map([[frame, Math.max(0, Number(this.estimate(frame)) || 0)]]);
    this.allocations.set(index, allocations);
    for (const [allocation, bytes] of allocations) {
      let resource = this.resources.get(allocation);
      if (!resource) this.resources.set(allocation, resource = { owners: new Map(), bytes: 0 });
      const previous = resource.bytes;
      resource.owners.set(index, bytes);
      resource.bytes = Math.max(previous, bytes);
      this.retainedBytes += resource.bytes - previous;
    }
  }

  uncharge(index) {
    for (const [allocation] of this.allocations.get(index) ?? []) {
      const resource = this.resources.get(allocation);
      const previous = resource.bytes;
      resource.owners.delete(index);
      if (!resource.owners.size) { this.resources.delete(allocation); resource.bytes = 0; }
      else { resource.bytes = 0; for (const bytes of resource.owners.values()) resource.bytes = Math.max(resource.bytes, bytes); }
      this.retainedBytes += resource.bytes - previous;
    }
    this.allocations.delete(index);
  }

  delete(index) {
    if (!this.frames.has(index)) return false;
    this.uncharge(index);
    return this.frames.delete(index);
  }

  trim() {
    while (this.frames.size > this.limit || this.bytes > this.byteBudget) {
      let oldest, found = false;
      for (const index of this.frames.keys()) if (index !== this.pinnedIndex) { oldest = index; found = true; break; }
      if (!found) break;
      this.delete(oldest);
    }
  }

  clear() {
    this.frames.clear(); this.allocations.clear(); this.resources.clear();
    this.retainedBytes = 0; this.pinnedIndex = null;
  }

  keys() { return [...this.frames.keys()]; }
}

function checkedBudget(bytes) {
  if (!(bytes === Infinity || Number.isFinite(bytes) && bytes >= 0)) throw new Error('The cache byte budget must be non-negative.');
  return bytes;
}
