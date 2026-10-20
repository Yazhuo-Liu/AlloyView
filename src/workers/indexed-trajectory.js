import { indexLammpsDump } from '../io/lammps-dump.js';
import { indexXyz } from '../io/xyz.js';
import { indexPdb } from '../io/pdb.js';
import { isGzipFile, streamGzipBytes } from '../io/gzip.js';
import { yieldToEventLoop } from '../shared/task-yield.js';

// Blob storage owns decoded bytes; the JS heap retains only small range
// descriptors. Frame Files reference their own ranges rather than repeated
// snapshots of the growing prefix. Binary search keeps random reads bounded.
class GrowingBlob {
  constructor() { this.size = 0; this.sealedSize = 0; this.parts = []; this.pending = []; }
  append(bytes) {
    for (let offset = 0; offset < bytes.length;) {
      const count = Math.min(bytes.length - offset, 8 * 1024 ** 2 - (this.size - this.sealedSize));
      this.pending.push(bytes.subarray(offset, offset + count));
      this.size += count; offset += count;
      if (this.size - this.sealedSize === 8 * 1024 ** 2) this.seal(this.size);
    }
  }
  seal(end) {
    if (end <= this.sealedSize) return;
    const ranges = [];
    let remaining = end - this.sealedSize, consumed = 0;
    for (const bytes of this.pending) {
      const count = Math.min(remaining, bytes.length);
      ranges.push(bytes.subarray(0, count)); remaining -= count;
      if (count < bytes.length) { this.pending[consumed] = bytes.subarray(count); break; }
      consumed++;
      if (!remaining) break;
    }
    this.pending.splice(0, consumed);
    this.parts.push({ start: this.sealedSize, end, blob: new Blob(ranges) });
    this.sealedSize = end;
  }
  slice(start, end) {
    // Usually one Blob per complete frame. Large frames are sealed in bounded
    // 8 MiB blocks, rather than making a Blob for every 16–64 KiB gzip chunk.
    this.seal(end);
    let lower = 0, upper = this.parts.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (this.parts[middle].end <= start) lower = middle + 1;
      else upper = middle;
    }
    const ranges = [];
    for (let index = lower; index < this.parts.length && this.parts[index].start < end; index++) {
      const part = this.parts[index];
      ranges.push(part.blob.slice(Math.max(0, start - part.start), Math.min(part.blob.size, end - part.start)));
    }
    return new Blob(ranges);
  }
}

/** Publish only complete frames. The first one can be parsed/displayed while
 * bounded indexing reads continue, with no final-frame EOF guess. */
export async function openIndexedTrajectory(inputFiles, format, { parse, onProgress = () => {}, onIndex = () => {}, signal, indexChunkSize = 4 * 1024 * 1024 } = {}) {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const files = [...inputFiles].sort((a, b) => collator.compare(a.name, b.name));
  let resolveFirst, rejectFirst;
  const first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  let releaseFirstParse, firstParseFinished = false;
  const firstParsed = new Promise(resolve => { releaseFirstParse = resolve; });
  const waitForFirstParse = () => new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Trajectory indexing cancelled.', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    firstParsed.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
  });
  const startedAt = performance.now();
  const source = { format: files.length > 1 ? `${format}-sequence` : format, baseFormat: format,
    descriptors: [], frameCount: 0, indexComplete: false, indexMs: 0, indexError: null };
  const snapshot = () => ({ format: source.format, frameCount: source.frameCount,
    indexComplete: source.indexComplete, indexMs: source.indexMs, error: source.indexError?.message });
  const publish = () => { source.indexMs = performance.now() - startedAt; onIndex(snapshot()); };
  source.indexPromise = (async () => {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      if (signal?.aborted) throw new DOMException('Trajectory indexing cancelled.', 'AbortError');
      const input = files[fileIndex];
      const compressed = await isGzipFile(input);
      const file = compressed ? new GrowingBlob() : input;
      let compressedRead = 0;
      async function* decodedChunks() {
        let yieldedAt = performance.now();
        for await (const bytes of streamGzipBytes(input, { signal,
          onCompressedProgress: ({ loaded }) => { compressedRead = loaded; } })) {
          file.append(bytes);
          yield bytes;
          // Already-buffered stream reads can form one long microtask chain.
          // Give the first parser its actual Blob-read/Worker ACK before more
          // indexing, then yield bounded work to cancellation/foreground tasks.
          if (source.frameCount && !firstParseFinished) await waitForFirstParse();
          if (performance.now() - yieldedAt >= 8) {
            await yieldToEventLoop(); yieldedAt = performance.now();
          }
        }
      }
      const options = { signal, chunkSize: indexChunkSize, ...(compressed ? { chunks: decodedChunks() } : {}), onFrame: descriptor => {
        const frameFile = compressed ? new File([file.slice(descriptor.start, descriptor.end)], input.name,
          { lastModified: input.lastModified }) : file;
        const frameDescriptor = { ...descriptor, file: frameFile, format, index: source.descriptors.length,
          ...(compressed ? { start: 0, end: descriptor.end - descriptor.start } : {}) };
        source.descriptors.push(frameDescriptor);
        source.frameCount = source.descriptors.length;
        if (source.frameCount === 1) resolveFirst(frameDescriptor);
      } };
      const progress = ({ loaded, total }) => {
        const fraction = compressed ? (input.size ? compressedRead / input.size : 0) : (total ? loaded / total : 0);
        onProgress({ loaded: fileIndex + fraction, total: files.length,
          stage: files.length > 1 ? 'series-index' : 'index' });
        publish();
      };
      if (format === 'lammps-dump') await indexLammpsDump(file, progress, options);
      else if (format === 'xyz') await indexXyz(file, progress, options);
      else await indexPdb(file, progress, options);
      publish();
    }
    source.indexComplete = true;
    publish();
    return snapshot();
  })().catch(error => {
    source.indexError = error;
    source.indexComplete = true;
    rejectFirst(error);
    publish();
    throw error;
  });
  // Indexing can fail after the first frame has already reached the viewer.
  // Report that through onIndex without an unhandled background rejection.
  source.indexPromise.catch(() => {});
  const descriptor = await first;
  let frame;
  try { frame = await parse(descriptor); }
  finally { firstParseFinished = true; releaseFirstParse(); }
  return { source, result: { ...snapshot(), frame } };
}
