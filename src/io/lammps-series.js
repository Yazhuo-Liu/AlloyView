import { indexLammpsDump, readLammpsFrame } from './lammps-dump.js';

const naturalCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export async function indexLammpsDumpSeries(inputFiles, onProgress = () => {}) {
  const files = [...inputFiles].sort((left, right) => naturalCollator.compare(left.name, right.name));
  const chunks = [];
  let frameCount = 0;
  let indexMs = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const indexed = await indexLammpsDump(file, ({ loaded, total }) => {
      onProgress({
        loaded: fileIndex + (total > 0 ? loaded / total : 0),
        total: files.length,
        fileIndex,
        fileName: file.name,
      });
    });
    chunks.push({ file, offsets: indexed.offsets, firstFrame: frameCount });
    frameCount += indexed.offsets.length;
    indexMs += indexed.indexMs;
  }
  if (frameCount === 0) throw new Error('The numbered LAMMPS dump series contains no frames.');
  return { chunks, frameCount, indexMs };
}

export async function readLammpsSeriesFrame(series, frameIndex) {
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= series.frameCount) {
    throw new Error(`LAMMPS series frame ${frameIndex} is outside the available range.`);
  }
  let chunk = series.chunks[0];
  for (let index = 1; index < series.chunks.length; index += 1) {
    if (series.chunks[index].firstFrame > frameIndex) break;
    chunk = series.chunks[index];
  }
  return readLammpsFrame(
    chunk.file,
    chunk.offsets,
    frameIndex - chunk.firstFrame,
    chunk.file.name,
  );
}
