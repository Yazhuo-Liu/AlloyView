import { calculateCoordination } from '../analysis/coordination.js';
import { cellFaceHeights, frameTransferables } from '../data/model.js';
import { parseCfg } from '../io/cfg.js';
import { indexLammpsDump, readLammpsFrame } from '../io/lammps-dump.js';

let source = null;
let wasmModulePromise;

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data;
  try {
    if (type === 'load') {
      const result = await loadSource(payload.file, id);
      self.postMessage({ id, ok: true, result }, frameTransferables(result.frame));
      return;
    }
    if (type === 'frame') {
      assertSource();
      if (source.format !== 'lammps-dump') throw new Error('A CFG file contains only one frame.');
      const frame = await readLammpsFrame(source.file, source.offsets, payload.index, source.file.name);
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

async function loadSource(file, requestId) {
  if (!(file instanceof Blob)) throw new Error('No valid local file was provided.');
  const header = await file.slice(0, 64 * 1024).text();
  const trimmed = header.replace(/^\uFEFF/, '').trimStart();
  if (trimmed.startsWith('ITEM: TIMESTEP')) {
    const { offsets, indexMs } = await indexLammpsDump(file, ({ loaded, total }) => {
      self.postMessage({ id: requestId, event: 'progress', loaded, total, stage: 'index' });
    });
    source = { file, format: 'lammps-dump', offsets };
    const frame = await readLammpsFrame(file, offsets, 0, file.name);
    return { format: source.format, frameCount: offsets.length, indexMs, frame };
  }
  if (/^Number\s+of\s+particles\s*=/i.test(trimmed)) {
    const startedAt = performance.now();
    const text = await file.text();
    source = { file, format: 'cfg', offsets: [0] };
    const frame = parseCfg(text, file.name);
    return { format: source.format, frameCount: 1, indexMs: performance.now() - startedAt - frame.parseMs, frame };
  }
  throw new Error('Unrecognized file format. The file must begin with AtomEye “Number of particles =” or LAMMPS “ITEM: TIMESTEP”.');
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
