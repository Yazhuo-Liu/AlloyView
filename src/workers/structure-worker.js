import { calculateCoordination } from '../analysis/coordination.js';
import { cellFaceHeights, frameTransferables } from '../data/model.js';
import { prepareSequenceBaseline, unwrapSequenceFrame } from '../data/trajectory.js';
import { parseCfg } from '../io/cfg.js';
import { isReadableLocalFile, normalizeLocalFiles } from '../io/local-files.js';
import { detectStructureFormatHeader, inferStructureFormatFromPath } from '../io/file-sequences.js';
import { indexLammpsDump, readLammpsFrame } from '../io/lammps-dump.js';
import { indexLammpsDumpSeries, readLammpsSeriesFrame } from '../io/lammps-series.js';
import { indexXyz, readXyzFrame } from '../io/xyz.js';
import { indexPdb, readPdbFrame } from '../io/pdb.js';
import { parseLammpsData } from '../io/lammps-data.js';
import { parsePoscar } from '../io/poscar.js';

const SINGLE_FRAME_PARSERS = { 'lammps-data': parseLammpsData, poscar: parsePoscar };

let source = null;
let wasmModulePromise;

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data;
  try {
    if (type === 'load') {
      // Older cached clients sent `file`, including an array during the
      // transition to sequences. Accept both versions of the load message.
      const result = await loadSource(payload.files ?? payload.file, id);
      self.postMessage({ id, ok: true, result }, frameTransferables(result.frame));
      return;
    }
    if (type === 'frame') {
      assertSource();
      let frame;
      if (source.format === 'lammps-dump') {
        frame = await readLammpsFrame(source.file, source.offsets, payload.index, source.file.name);
      } else if (source.format === 'lammps-dump-sequence') {
        frame = await readLammpsSeriesFrame(source, payload.index);
      } else if (source.format === 'cfg-sequence') {
        frame = await queueCfgSequenceFrame(payload.index, id);
      } else if (['xyz', 'xyz-sequence', 'pdb', 'pdb-sequence'].includes(source.format)) {
        frame = await readIndexedTextFrame(source, payload.index);
      } else if (SINGLE_FRAME_PARSERS[source.format] && payload.index === 0) {
        frame = SINGLE_FRAME_PARSERS[source.format](await source.file.text(), source.file.name);
      } else {
        throw new Error('A single CFG file contains only one frame. Select multiple numbered CFG files to load a sequence.');
      }
      self.postMessage({ id, ok: true, result: { frame, index: payload.index } }, frameTransferables(frame));
      return;
    }
    if (type === 'analyze-coordination') {
      const result = await calculateWithAvailableEngine(payload);
      self.postMessage({ id, ok: true, result }, [result.coordination.buffer]);
      return;
    }
    throw new Error(`Unknown Worker request: ${type}`);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

async function loadSource(inputFiles, requestId) {
  const files = normalizeLocalFiles(inputFiles);
  if (files.length === 0 || files.some((file) => !isReadableLocalFile(file))) {
    throw new Error('No valid local file was provided.');
  }
  if (files.length > 1) {
    const formats = [];
    for (const file of files) {
      const header = await file.slice(0, 64 * 1024).text();
      formats.push(detectStructureFormatHeader(header) ?? inferStructureFormatFromPath(file.name));
    }
    if (formats.every((format) => format === 'cfg')) return loadCfgSequence(files, requestId);
    if (formats.every((format) => format === 'lammps-dump')) return loadLammpsDumpSequence(files, requestId);
    if (formats.every((format) => format === 'xyz')) return loadIndexedTextSource(files, 'xyz', requestId);
    if (formats.every((format) => format === 'pdb')) return loadIndexedTextSource(files, 'pdb', requestId);
    throw new Error('A numbered file sequence must contain a single format: CFG, LAMMPS text dump, XYZ, or PDB. LAMMPS data and POSCAR files open one at a time.');
  }
  const [file] = files;
  const header = await file.slice(0, 64 * 1024).text();
  const format = detectStructureFormatHeader(header) ?? inferStructureFormatFromPath(file.name);
  if (format === 'lammps-dump') {
    const { offsets, indexMs } = await indexLammpsDump(file, ({ loaded, total }) => {
      self.postMessage({ id: requestId, event: 'progress', loaded, total, stage: 'index' });
    });
    source = { file, format: 'lammps-dump', offsets };
    const frame = await readLammpsFrame(file, offsets, 0, file.name);
    return { format: source.format, frameCount: offsets.length, indexMs, frame };
  }
  if (format === 'cfg') {
    const startedAt = performance.now();
    const text = await file.text();
    source = { file, format: 'cfg', offsets: [0] };
    const frame = parseCfg(text, file.name);
    return { format: source.format, frameCount: 1, indexMs: performance.now() - startedAt - frame.parseMs, frame };
  }
  if (format === 'xyz' || format === 'pdb') return loadIndexedTextSource(files, format, requestId);
  if (SINGLE_FRAME_PARSERS[format]) {
    const startedAt = performance.now();
    const text = await file.text();
    source = { file, format, offsets: [0] };
    const frame = SINGLE_FRAME_PARSERS[format](text, file.name);
    return { format, frameCount: 1, indexMs: performance.now() - startedAt - frame.parseMs, frame };
  }
  throw new Error('Unrecognized file format. Supported structures are AtomEye CFG, LAMMPS text dump and data files, XYZ / Extended XYZ, PDB, and VASP POSCAR.');
}

async function loadIndexedTextSource(inputFiles, format, requestId) {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const files = [...inputFiles].sort((left, right) => collator.compare(left.name, right.name));
  const chunks = [];
  let frameCount = 0;
  let indexMs = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const onProgress = ({ loaded, total }) => self.postMessage({ id: requestId, event: 'progress',
      loaded: fileIndex + (total ? loaded / total : 0), total: files.length, stage: files.length > 1 ? 'series-index' : 'index' });
    const indexed = format === 'xyz' ? await indexXyz(file, onProgress) : await indexPdb(file, onProgress);
    chunks.push({ file, indexed, firstFrame: frameCount });
    frameCount += format === 'xyz' ? indexed.offsets.length : indexed.frames.length;
    indexMs += indexed.indexMs;
  }
  const indexedSource = { format: files.length > 1 ? `${format}-sequence` : format, baseFormat: format, chunks, frameCount };
  const frame = await readIndexedTextFrame(indexedSource, 0);
  source = indexedSource;
  return { format: source.format, frameCount, indexMs, frame };
}

async function readIndexedTextFrame(indexedSource, index) {
  if (!Number.isInteger(index) || index < 0 || index >= indexedSource.frameCount) throw new Error(`Trajectory frame ${index} is outside the available range.`);
  let chunk = indexedSource.chunks[0];
  for (let current = 1; current < indexedSource.chunks.length; current += 1) {
    if (indexedSource.chunks[current].firstFrame > index) break;
    chunk = indexedSource.chunks[current];
  }
  const localIndex = index - chunk.firstFrame;
  const frame = indexedSource.baseFormat === 'xyz'
    ? await readXyzFrame(chunk.file, chunk.indexed.offsets, localIndex, chunk.file.name)
    : await readPdbFrame(chunk.file, chunk.indexed, localIndex, chunk.file.name);
  frame.frameIndex = index;
  return frame;
}

async function loadLammpsDumpSequence(inputFiles, requestId) {
  const indexed = await indexLammpsDumpSeries(inputFiles, ({ loaded, total }) => {
    self.postMessage({ id: requestId, event: 'progress', loaded, total, stage: 'series-index' });
  });
  source = { format: 'lammps-dump-sequence', ...indexed };
  const frame = await readLammpsSeriesFrame(source, 0);
  return { format: source.format, frameCount: source.frameCount, indexMs: source.indexMs, frame };
}

async function loadCfgSequence(inputFiles, requestId) {
  const startedAt = performance.now();
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const files = [...inputFiles].sort((left, right) => collator.compare(left.name, right.name));
  for (let index = 0; index < files.length; index += 1) {
    const header = await files[index].slice(0, 4096).text();
    const format = detectStructureFormatHeader(header) ?? inferStructureFormatFromPath(files[index].name);
    if (format !== 'cfg') {
      throw new Error(`Multi-file trajectories currently require AtomEye CFG files; “${files[index].name}” is not CFG.`);
    }
    self.postMessage({
      id: requestId,
      event: 'progress',
      loaded: index + 1,
      total: files.length,
      stage: 'sequence-index',
    });
  }
  const first = parseCfg(await files[0].text(), files[0].name);
  const continuity = prepareSequenceBaseline(first);
  source = { files, format: 'cfg-sequence', continuity, checkpoints: new Map(), frameQueue: Promise.resolve() };
  rememberContinuity(source, continuity);
  return {
    format: source.format,
    frameCount: files.length,
    indexMs: Math.max(0, performance.now() - startedAt - first.parseMs),
    frame: first,
  };
}

function queueCfgSequenceFrame(index, requestId) {
  const sequenceSource = source;
  const task = sequenceSource.frameQueue.then(() => readCfgSequenceFrame(sequenceSource, index, requestId));
  sequenceSource.frameQueue = task.catch(() => {});
  return task;
}

// Each sequence frame is unwrapped against the state of the frame before it.
// Keeping recent states lets a repeated, backward or prefetch request resume
// from the nearest earlier frame instead of re-parsing from the first file.
// A state owns copies of its IDs and coordinates (about 44 bytes per atom).
const SEQUENCE_CHECKPOINT_BYTES = 256 * 1024 ** 2;

function rememberContinuity(sequenceSource, state) {
  const { checkpoints } = sequenceSource;
  checkpoints.delete(state.index);
  checkpoints.set(state.index, state);
  const bytes = state.ids.byteLength + state.wrappedFractional.byteLength + state.unwrappedFractional.byteLength;
  const limit = Math.max(2, Math.floor(SEQUENCE_CHECKPOINT_BYTES / bytes));
  while (checkpoints.size > limit) checkpoints.delete(checkpoints.keys().next().value);
}

async function readCfgSequenceFrame(sequenceSource, index, requestId) {
  if (!Number.isInteger(index) || index < 0 || index >= sequenceSource.files.length) {
    throw new Error(`CFG sequence frame ${index} is outside the available range.`);
  }

  let continuity = null;
  for (const state of sequenceSource.checkpoints.values()) {
    if (state.index < index && (!continuity || state.index > continuity.index)) continuity = state;
  }
  let start = continuity ? continuity.index + 1 : 1;
  let frame = null;
  if (!continuity) {
    frame = parseCfg(await sequenceSource.files[0].text(), sequenceSource.files[0].name);
    continuity = prepareSequenceBaseline(frame);
    rememberContinuity(sequenceSource, continuity);
    if (index === 0) {
      sequenceSource.continuity = continuity;
      return frame;
    }
  }

  for (let current = start; current <= index; current += 1) {
    const file = sequenceSource.files[current];
    frame = parseCfg(await file.text(), file.name);
    continuity = unwrapSequenceFrame(frame, continuity, current);
    rememberContinuity(sequenceSource, continuity);
    self.postMessage({
      id: requestId,
      event: 'progress',
      loaded: current - start + 1,
      total: index - start + 1,
      stage: 'sequence-unwrap',
    });
  }
  sequenceSource.continuity = continuity;
  return frame;
}

function assertSource() {
  if (!source) throw new Error('Open a structure or trajectory file first.');
}

async function calculateWithAvailableEngine(payload) {
  const wasm = await loadOptionalWasm();
  if (!wasm) {
    const result = calculateCoordination(payload, payload.cutoff);
    return { ...result, engine: 'js-worker' };
  }
  const startedAt = performance.now();
  const count = payload.fractional.length / 3;
  const fractionalBytes = payload.fractional.byteLength;
  const cellValues = Float64Array.from(payload.cell.vectors);
  const pbcValues = Uint8Array.from(payload.cell.pbc, Number);
  const outputBytes = count * Uint32Array.BYTES_PER_ELEMENT;
  const fractionalPointer = wasm._malloc(fractionalBytes);
  const cellPointer = wasm._malloc(cellValues.byteLength);
  const pbcPointer = wasm._malloc(pbcValues.byteLength);
  const outputPointer = wasm._malloc(outputBytes);
  try {
    wasm.HEAPF32.set(payload.fractional, fractionalPointer / Float32Array.BYTES_PER_ELEMENT);
    wasm.HEAPF64.set(cellValues, cellPointer / Float64Array.BYTES_PER_ELEMENT);
    wasm.HEAPU8.set(pbcValues, pbcPointer);
    const status = wasm._alloy_coordination(
      count,
      fractionalPointer,
      cellPointer,
      pbcPointer,
      payload.cutoff,
      outputPointer,
    );
    if (status !== 0) throw new Error(`The Wasm coordination core returned error code ${status}.`);
    const coordination = wasm.HEAPU32.slice(
      outputPointer / Uint32Array.BYTES_PER_ELEMENT,
      outputPointer / Uint32Array.BYTES_PER_ELEMENT + count,
    );
    return {
      coordination,
      elapsedMs: performance.now() - startedAt,
      candidatePairs: null,
      acceptedPairs: null,
      bins: null,
      engine: 'wasm-worker',
      warning: wasmCellWarning(payload.cell, payload.cutoff),
    };
  } finally {
    wasm._free(fractionalPointer);
    wasm._free(cellPointer);
    wasm._free(pbcPointer);
    wasm._free(outputPointer);
  }
}

function wasmCellWarning(cell, cutoff) {
  const axes = Array.from(cellFaceHeights(cell), (height, axis) => (
    cell.pbc[axis] && height < 2 * cutoff ? axis : -1
  ))
    .filter((axis) => axis >= 0);
  return axes.length > 0
    ? `The cell height along periodic axis ${axes.map((axis) => 'abc'[axis]).join(', ')} is less than twice the cutoff. Results count the closest image of each unique atom ID and do not count multiple periodic images of the same atom.`
    : null;
}

async function loadOptionalWasm() {
  if (!wasmModulePromise) {
    wasmModulePromise = import('../../wasm/coordination.mjs')
      .then(({ default: createModule }) => createModule())
      .catch(() => null);
  }
  return wasmModulePromise;
}
