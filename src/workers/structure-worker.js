import { calculateCoordination } from '../analysis/coordination.js';
import { cellFaceHeights, frameTransferables } from '../data/model.js';
import { prepareSequenceBaseline, unwrapSequenceFrame } from '../data/trajectory.js';
import { isReadableLocalFile, normalizeLocalFiles } from '../io/local-files.js';
import { detectStructureFormatHeader, inferStructureFormatFromPath } from '../io/file-sequences.js';
import { assertGzipSupported, decompressToFile, readStructureHeader } from '../io/gzip.js';
import { indexLammpsDump, readLammpsFrame } from '../io/lammps-dump.js';
import { indexLammpsDumpSeries, readLammpsSeriesFrame } from '../io/lammps-series.js';
import { indexXyz, readXyzFrame } from '../io/xyz.js';
import { indexPdb, readPdbFrame } from '../io/pdb.js';
import { parseLammpsData } from '../io/lammps-data.js';
import { parsePoscar } from '../io/poscar.js';
import { FrameParserPool } from '../data/frame-parser-pool.js';
import { openIndexedTrajectory } from './indexed-trajectory.js';
import { TrajectoryProcessor } from './trajectory-processor.js';

const SINGLE_FRAME_PARSERS = { 'lammps-data': parseLammpsData, poscar: parsePoscar };

let source = null;
let wasmModulePromise;
let parserPool = null;
let parserBackgroundCount;
let trajectory = null;
let loadController = null;
let useCpuBudget = false;
let nextLeaseId = 1;
const leases = new Map();
const frameRequests = new Map();

function acquireParserCpu({ background, signal, priority }) {
  if (!useCpuBudget) return Promise.resolve(null);
  const leaseId = nextLeaseId++;
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (!leases.delete(leaseId)) return;
      self.postMessage({ event: 'cpu-cancel', leaseId });
      reject(new DOMException('Frame parsing cancelled.', 'AbortError'));
    };
    leases.set(leaseId, { resolve, reject, signal, abort });
    signal.addEventListener('abort', abort, { once: true });
    self.postMessage({ event: 'cpu-acquire', leaseId, background, priority });
  });
}

function getParserPool() {
  if (!parserPool) parserPool = new FrameParserPool({ acquire: acquireParserCpu, backgroundCount: parserBackgroundCount,
    promote: ({ signal, priority }) => {
      for (const [leaseId, lease] of leases) if (lease.signal === signal) self.postMessage({ event: 'cpu-promote', leaseId, priority });
    } });
  return parserPool;
}

self.addEventListener('message', async (event) => {
  const { id, type, payload = {} } = event.data;
  if (type === 'cpu-granted' || type === 'cpu-denied') {
    const pending = leases.get(payload.leaseId);
    if (!pending) {
      if (type === 'cpu-granted') self.postMessage({ event: 'cpu-release', leaseId: payload.leaseId });
      return;
    }
    leases.delete(payload.leaseId);
    pending.signal.removeEventListener('abort', pending.abort);
    if (type === 'cpu-granted') pending.resolve({ release: () => self.postMessage({ event: 'cpu-release', leaseId: payload.leaseId }) });
    else pending.reject(Object.assign(new Error(payload.error), { name: payload.name ?? 'Error' }));
    return;
  }
  // Speculative ownership lives on the page, where all consumers are known.
  // A legacy blanket notice cannot distinguish a time-series read from a
  // prefetch which another consumer has joined; accept it without cancelling
  // unrelated work. Current clients cancel the last owner's request by ID.
  if (type === 'cancel-prefetch') return;
  if (type === 'cancel-frame') {
    frameRequests.get(payload.id)?.controller.abort();
    return;
  }
  if (type === 'promote-frame') {
    const task = frameRequests.get(payload.id);
    if (task) {
      task.background = false; task.priority = 20;
      parserPool?.promote(task.controller.signal);
    }
    return;
  }
  let task, requestLoadController;
  try {
    if (type === 'load') {
      loadController?.abort();
      for (const request of frameRequests.values()) request.controller.abort();
      parserPool?.close(); parserPool = null;
      trajectory?.close(); trajectory = null;
      requestLoadController = loadController = new AbortController();
      useCpuBudget = Boolean(payload.cpuBudget);
      parserBackgroundCount = payload.parserConcurrency;
      const result = await loadSource(payload.files ?? payload.file, id, payload.incremental, requestLoadController);
      if (requestLoadController.signal.aborted || requestLoadController !== loadController) throw new DOMException('Structure source closed.', 'AbortError');
      getParserPool().setAtomCount(result.frame.ids.length);
      self.postMessage({ id, ok: true, result }, frameTransferables(result.frame));
      return;
    }
    if (type === 'index-complete') {
      assertSource();
      await source.indexPromise;
      self.postMessage({ id, ok: true, result: { frameCount: source.frameCount ?? source.offsets?.length ?? source.files?.length, indexComplete: true } });
      return;
    }
    if (type === 'frame') {
      assertSource();
      task = { controller: new AbortController(), background: Boolean(payload.background) };
      frameRequests.set(id, task);
      const frame = await readSourceFrame(source, payload.index, id, task);
      if (task.controller.signal.aborted) throw new DOMException('Frame parsing cancelled.', 'AbortError');
      if (payload.trajectory) {
        await trajectoryProcessor().prepare(frame, payload.index, { ...payload.trajectory, signal: task.controller.signal,
          background: task.background, onProgress: progress => { if (!task.background) self.postMessage({ id, event: 'progress', ...progress }); } });
        if (task.controller.signal.aborted) throw new DOMException('Frame parsing cancelled.', 'AbortError');
      }
      self.postMessage({ id, ok: true, result: { frame, index: payload.index } }, trajectoryTransferables(frame));
      return;
    }
    if (type === 'trajectory-unwrap' || type === 'trajectory-lines') {
      assertSource();
      task = { controller: new AbortController(), background: Boolean(payload.background) };
      frameRequests.set(id, task);
      const onProgress = progress => self.postMessage({ id, event: 'progress', ...progress });
      if (type === 'trajectory-unwrap') {
        const inferred = await trajectoryProcessor().inferredUnwrap(payload.index, { smoothing: payload.smoothing,
          signal: task.controller.signal, background: task.background, onProgress });
        if (task.controller.signal.aborted) throw new DOMException('Trajectory processing cancelled.', 'AbortError');
        self.postMessage({ id, ok: true, result: { inferredUnwrap: inferred } },
          inferred ? [inferred.imageFlags.buffer, inferred.unwrappedPositions.buffer] : []);
      } else {
        const lines = await trajectoryProcessor().lines(payload, { signal: task.controller.signal, onProgress });
        if (task.controller.signal.aborted) throw new DOMException('Trajectory processing cancelled.', 'AbortError');
        self.postMessage({ id, ok: true, result: lines }, [lines.vertices.buffer, lines.lineOffsets.buffer, lines.frames.buffer]);
      }
      return;
    }
    if (type === 'analyze-coordination') {
      const result = await calculateWithAvailableEngine(payload);
      self.postMessage({ id, ok: true, result }, [result.coordination.buffer]);
      return;
    }
    throw new Error(`Unknown Worker request: ${type}`);
  } catch (error) {
    if (type === 'load') requestLoadController?.abort();
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error), name: error.name });
  } finally {
    if (task && frameRequests.get(id) === task) {
      task.controller.abort(); // Also cancel unneeded CFG read-ahead after a malformed frame.
      frameRequests.delete(id);
    }
  }
});

function trajectoryTransferables(frame) {
  const transferables = frameTransferables(frame);
  if (frame.inferredUnwrap) transferables.push(frame.inferredUnwrap.imageFlags.buffer, frame.inferredUnwrap.unwrappedPositions.buffer);
  return [...new Set(transferables)];
}

/** Created per source on first use; frames it reads are raw parser output. */
function trajectoryProcessor() {
  if (!trajectory) {
    const current = source;
    trajectory = new TrajectoryProcessor({
      readFrame: (index, { signal, background, priority }) => readSourceFrame(current, index, null,
        { background, priority, controller: { signal } }),
      getFrameCount: options => sourceFrameCount(current, options),
    });
  }
  return trajectory;
}

/** Frames known so far; waits for progressive indexing to reach `atLeast`. */
async function sourceFrameCount(current, { atLeast = 0, signal } = {}) {
  while (current.descriptors && !current.indexComplete && current.descriptors.length < atLeast) {
    if (signal?.aborted) throw new DOMException('Trajectory processing cancelled.', 'AbortError');
    await Promise.race([current.indexPromise.catch(() => {}), new Promise(resolve => setTimeout(resolve, 50))]);
  }
  if (current.descriptors) return current.descriptors.length;
  if (current.format === 'cfg-sequence') return current.files.length;
  return current.frameCount ?? current.offsets?.length ?? 1;
}

async function readSourceFrame(current, index, requestId, task) {
  const options = { get background() { return task.background; }, signal: task.controller.signal,
    get priority() { return task.priority ?? (task.background ? -20 : 20); } };
  if (current.descriptors) {
    if (!current.descriptors[index] && !current.indexComplete) await current.indexPromise;
    const descriptor = current.descriptors[index];
    if (!Number.isInteger(index) || !descriptor) throw new Error(`Trajectory frame ${index} is outside the available range.`);
    return getParserPool().parse(descriptor, options);
  }
  if (current.format === 'cfg-sequence') return readCfgSequenceFrame(current, index, requestId, options);
  if (current.format === 'cfg' || SINGLE_FRAME_PARSERS[current.format]) {
    if (index !== 0) throw new Error('A single structure contains only one frame.');
    return getParserPool().parse({ format: current.format, file: current.file, index }, options);
  }
  let chunk = current;
  let localIndex = index;
  if (current.chunks) {
    for (const candidate of current.chunks) { if (candidate.firstFrame <= index) chunk = candidate; else break; }
    localIndex -= chunk.firstFrame;
  }
  const format = current.baseFormat ?? current.format.replace('-sequence', '');
  const offsets = chunk.offsets ?? chunk.indexed?.offsets;
  const descriptors = chunk.indexed?.frames;
  const count = current.frameCount ?? current.offsets?.length;
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`Trajectory frame ${index} is outside the available range.`);
  const descriptor = descriptors?.[localIndex] ?? { start: offsets[localIndex], end: offsets[localIndex + 1] ?? chunk.file.size };
  return getParserPool().parse({ ...descriptor, format, file: chunk.file, index,
    header: descriptor.header ?? chunk.indexed?.header }, options);
}

async function loadSource(inputFiles, requestId, incremental = false, controller = loadController) {
  const files = normalizeLocalFiles(inputFiles);
  if (files.length === 0 || files.some((file) => !isReadableLocalFile(file))) {
    throw new Error('No valid local file was provided.');
  }
  // gzip files are detected by content and decompressed here (see gzip.js):
  // trajectories read in random order once into a Blob, single-frame files
  // whenever they are read.
  for (const file of files) await assertGzipSupported(file);
  if (files.length > 1) {
    const formats = [];
    for (const file of files) {
      const header = await readStructureHeader(file);
      formats.push(detectStructureFormatHeader(header) ?? inferStructureFormatFromPath(file.name));
    }
    if (controller.signal.aborted) throw new DOMException('Structure source closed.', 'AbortError');
    if (formats.every((format) => format === 'cfg')) return loadCfgSequence(files, requestId, controller);
    if (incremental && formats.every(format => format === formats[0]) && ['lammps-dump', 'xyz', 'pdb'].includes(formats[0])) return loadProgressive(files, formats[0], requestId, controller);
    if (formats.every((format) => format === 'lammps-dump')) return loadLammpsDumpSequence(await decompressFiles(files), requestId);
    if (formats.every((format) => format === 'xyz')) return loadIndexedTextSource(await decompressFiles(files), 'xyz', requestId);
    if (formats.every((format) => format === 'pdb')) return loadIndexedTextSource(await decompressFiles(files), 'pdb', requestId);
    throw new Error('A numbered file sequence must contain a single format: CFG, LAMMPS text dump, XYZ, or PDB. LAMMPS data and POSCAR files open one at a time.');
  }
  const [inputFile] = files;
  const header = await readStructureHeader(inputFile);
  const format = detectStructureFormatHeader(header) ?? inferStructureFormatFromPath(inputFile.name);
  if (controller.signal.aborted) throw new DOMException('Structure source closed.', 'AbortError');
  if (incremental && ['lammps-dump', 'xyz', 'pdb'].includes(format)) return loadProgressive(files, format, requestId, controller);
  if (format === 'lammps-dump') {
    const file = await decompressToFile(inputFile);
    const { offsets, indexMs } = await indexLammpsDump(file, ({ loaded, total }) => {
      self.postMessage({ id: requestId, event: 'progress', loaded, total, stage: 'index' });
    });
    source = { file, format: 'lammps-dump', offsets };
    const frame = await readLammpsFrame(file, offsets, 0, file.name);
    return { format: source.format, frameCount: offsets.length, indexMs, frame };
  }
  if (format === 'cfg') {
    const startedAt = performance.now();
    source = { file: inputFile, format: 'cfg', offsets: [0] };
    const frame = await getParserPool().parse({ format, file: inputFile, index: 0 }, { signal: controller.signal });
    return { format: source.format, frameCount: 1, indexMs: performance.now() - startedAt - frame.parseMs, frame };
  }
  if (format === 'xyz' || format === 'pdb') return loadIndexedTextSource(await decompressFiles(files), format, requestId);
  if (SINGLE_FRAME_PARSERS[format]) {
    const file = inputFile;
    const startedAt = performance.now();
    source = { file, format, offsets: [0] };
    const frame = await getParserPool().parse({ format, file, index: 0 }, { signal: controller.signal });
    return { format, frameCount: 1, indexMs: performance.now() - startedAt - frame.parseMs, frame };
  }
  throw new Error('Unrecognized file format. Supported structures are AtomEye CFG, LAMMPS text dump and data files, XYZ / Extended XYZ, PDB, and VASP POSCAR, uncompressed or gzip-compressed.');
}

async function loadProgressive(files, format, requestId, controller = loadController) {
  const opened = await openIndexedTrajectory(files, format, {
    signal: controller.signal,
    parse: descriptor => getParserPool().parse(descriptor, { signal: controller.signal }),
    onProgress: progress => self.postMessage({ id: requestId, event: 'progress', ...progress }),
    onIndex: result => { if (controller === loadController && !controller.signal.aborted) self.postMessage({ event: 'source-info', loadId: requestId, result }); },
  });
  if (controller.signal.aborted) throw new DOMException('Structure source closed.', 'AbortError');
  source = opened.source;
  return opened.result;
}

async function decompressFiles(files) {
  const decompressed = [];
  for (const file of files) decompressed.push(await decompressToFile(file));
  return decompressed;
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

async function loadCfgSequence(inputFiles, requestId, controller = loadController) {
  const startedAt = performance.now();
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const files = [...inputFiles].sort((left, right) => collator.compare(left.name, right.name));
  for (let index = 0; index < files.length; index += 1) {
    if (controller.signal.aborted) throw new DOMException('Structure source closed.', 'AbortError');
    const header = await readStructureHeader(files[index], 4096);
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
  const first = await getParserPool().parse({ format: 'cfg', file: files[0], index: 0 }, { signal: controller.signal });
  const continuity = prepareSequenceBaseline(first);
  source = { files, format: 'cfg-sequence', continuity, checkpoints: new Map() };
  rememberContinuity(source, continuity);
  return {
    format: source.format,
    frameCount: files.length,
    indexMs: Math.max(0, performance.now() - startedAt - first.parseMs),
    frame: first,
  };
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

async function readCfgSequenceFrame(sequenceSource, index, requestId, options = {}) {
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
    frame = await getParserPool().parse({ format: 'cfg', file: sequenceSource.files[0], index: 0 }, options);
    continuity = prepareSequenceBaseline(frame);
    rememberContinuity(sequenceSource, continuity);
    if (index === 0) {
      sequenceSource.continuity = continuity;
      return frame;
    }
  }

  // Read/parse ahead in parallel, but unwrap in original frame order. This
  // preserves ID matching and checkpoint arithmetic across boundary crossings.
  const ahead = Math.max(1, getParserPool().backgroundCount + 1);
  const parsed = new Map();
  const enqueue = current => {
    const promise = getParserPool().parse({ format: 'cfg', file: sequenceSource.files[current], index: current },
      { ...options, background: options.background || current !== start, priority: options.background ? -20 : 20 });
    promise.catch(() => {});
    parsed.set(current, promise);
  };
  for (let current = start; current <= Math.min(index, start + ahead - 1); current++) enqueue(current);
  for (let current = start; current <= index; current += 1) {
    if (options.signal?.aborted) throw new DOMException('Frame parsing cancelled.', 'AbortError');
    frame = await parsed.get(current);
    parsed.delete(current);
    continuity = unwrapSequenceFrame(frame, continuity, current);
    rememberContinuity(sequenceSource, continuity);
    if (current + ahead <= index) enqueue(current + ahead);
    self.postMessage({ id: requestId, event: 'progress', loaded: current - start + 1,
      total: index - start + 1, stage: 'sequence-unwrap' });
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
