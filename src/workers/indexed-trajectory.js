import { indexLammpsDump } from '../io/lammps-dump.js';
import { indexXyz } from '../io/xyz.js';
import { indexPdb } from '../io/pdb.js';
import { decompressToFile } from '../io/gzip.js';

/** Publish only complete frames. The first one can be parsed/displayed while
 * bounded indexing reads continue, with no final-frame EOF guess. */
export async function openIndexedTrajectory(inputFiles, format, { parse, onProgress = () => {}, onIndex = () => {}, signal, indexChunkSize = 4 * 1024 * 1024 } = {}) {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const files = [...inputFiles].sort((a, b) => collator.compare(a.name, b.name));
  let resolveFirst, rejectFirst;
  const first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  const startedAt = performance.now();
  const source = { format: files.length > 1 ? `${format}-sequence` : format, baseFormat: format,
    descriptors: [], frameCount: 0, indexComplete: false, indexMs: 0, indexError: null };
  const snapshot = () => ({ format: source.format, frameCount: source.frameCount,
    indexComplete: source.indexComplete, indexMs: source.indexMs, error: source.indexError?.message });
  const publish = () => { source.indexMs = performance.now() - startedAt; onIndex(snapshot()); };
  source.indexPromise = (async () => {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      if (signal?.aborted) throw new DOMException('Trajectory indexing cancelled.', 'AbortError');
      const file = await decompressToFile(files[fileIndex]);
      const options = { signal, chunkSize: indexChunkSize, onFrame: descriptor => {
        const frameDescriptor = { ...descriptor, file, format, index: source.descriptors.length };
        source.descriptors.push(frameDescriptor);
        source.frameCount = source.descriptors.length;
        if (source.frameCount === 1) resolveFirst(frameDescriptor);
      } };
      const progress = ({ loaded, total }) => {
        onProgress({ loaded: fileIndex + (total ? loaded / total : 0), total: files.length,
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
  const frame = await parse(descriptor);
  return { source, result: { ...snapshot(), frame } };
}
