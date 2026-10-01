export class FrameCache {
  constructor(limit = 3) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('The cache limit must be a positive integer.');
    this.limit = limit;
    this.frames = new Map();
  }

  get size() { return this.frames.size; }

  has(index) { return this.frames.has(index); }

  get(index) {
    const frame = this.frames.get(index);
    if (!frame) return undefined;
    this.frames.delete(index);
    this.frames.set(index, frame);
    return frame;
  }

  set(index, frame) {
    if (this.frames.has(index)) this.frames.delete(index);
    this.frames.set(index, frame);
    while (this.frames.size > this.limit) {
      const oldest = this.frames.keys().next().value;
      this.frames.delete(oldest);
    }
    return frame;
  }

  clear() { this.frames.clear(); }

  keys() { return [...this.frames.keys()]; }
}
