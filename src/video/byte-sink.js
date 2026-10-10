/** Append-only byte store for encoded video. Chunks collect in memory and are
 * folded into Blobs once they exceed a threshold, so a long movie does not
 * keep every encoded frame in the script heap: browsers hold large Blobs
 * outside it and may move them to disk. */
export const DEFAULT_SINK_THRESHOLD = 8 * 1024 * 1024;

export class ByteSink {
  constructor({ threshold = DEFAULT_SINK_THRESHOLD, BlobClass = globalThis.Blob } = {}) {
    this.threshold = threshold; this.BlobClass = BlobClass;
    this.parts = []; this.pending = []; this.pendingBytes = 0; this.size = 0; this.flushes = 0;
  }

  write(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('ByteSink.write needs a Uint8Array.');
    if (!bytes.length) return;
    this.pending.push(bytes); this.pendingBytes += bytes.length; this.size += bytes.length;
    if (this.pendingBytes >= this.threshold) this.flush();
  }

  flush() {
    if (!this.pending.length) return;
    if (this.BlobClass) { this.parts.push(new this.BlobClass(this.pending)); this.flushes++; }
    else this.parts.push(...this.pending);
    this.pending = []; this.pendingBytes = 0;
  }

  /** Blob or Uint8Array parts in write order, for a final Blob. */
  finish() { this.flush(); return this.parts; }
}

export function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0), result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export const asciiBytes = text => Uint8Array.from(text, character => character.charCodeAt(0) & 0x7f);
