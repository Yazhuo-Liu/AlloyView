import { MAX_BONDS, MAX_NEIGHBORS_PER_ATOM } from '../bonds.js';
import { NeighborSearch, atomRange } from '../neighbors.js';
import { checkSignal, GpuUnavailableError, readGpuBuffers, yieldWorker } from './runtime.js';
import { BONDS_COUNT_SHADER, BONDS_WRITE_SHADER, BOND_ATOM_WORDS, BOND_RECORD_WORDS } from './bonds-shaders.js';
import { validateAnalysisInput } from '../errors.js';

export const MAX_GPU_BOND_PAIR_CUTOFFS = 256;
export const MAX_GPU_BOND_CORRECTION_ATOMS = 16_384;

export function prepareGpuBondParameters(frame, parameters = {}) {
  const { cutoff, pairCutoffs = [], maxBonds = MAX_BONDS } = parameters;
  const atomCount = frame.fractional.length / 3;
  const range = atomRange(atomCount, parameters);
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('Bond cutoff must be positive and finite.');
  if (!Number.isInteger(maxBonds) || maxBonds < 1 || maxBonds > MAX_BONDS) throw new Error(`Bond output is limited to ${MAX_BONDS.toLocaleString('en-US')} edges.`);
  if (!ArrayBuffer.isView(frame.types) || frame.types.length !== atomCount) throw new Error('Bonds require one element type per atom.');
  if (!Array.isArray(pairCutoffs)) throw new Error('Element-pair cutoffs must be an array.');
  if (pairCutoffs.length > MAX_GPU_BOND_PAIR_CUTOFFS) throw new GpuUnavailableError(`GPU bonds support up to ${MAX_GPU_BOND_PAIR_CUTOFFS} element-pair cutoffs.`);
  if (frame.types.some(value => !Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    throw new GpuUnavailableError('The element types exceed the GPU integer encoding.');
  }
  const overrides = new Map();
  let maximumCutoff = cutoff;
  const settings = new Uint32Array(4 + pairCutoffs.length * 4), floatSettings = new Float32Array(settings.buffer);
  settings[0] = pairCutoffs.length; floatSettings[1] = cutoff; settings[2] = maxBonds;
  for (let index = 0; index < pairCutoffs.length; index++) {
    const { first, second, cutoff: value } = pairCutoffs[index];
    if (![first, second].every(type => Number.isInteger(type) && type >= 0) || !Number.isFinite(value) || value < 0) {
      throw new Error('Invalid element-pair cutoff.');
    }
    if (first > 0xffffffff || second > 0xffffffff || !Number.isFinite(Math.fround(value))) {
      throw new GpuUnavailableError('The element-pair cutoff exceeds the GPU numeric range.');
    }
    const a = Math.min(first, second), b = Math.max(first, second), key = `${a}:${b}`;
    if (overrides.has(key)) throw new Error('Each element pair can have only one cutoff.');
    overrides.set(key, value); maximumCutoff = Math.max(maximumCutoff, value);
    settings.set([a, b], 4 + index * 4); floatSettings[6 + index * 4] = value;
  }
  return { ...range, atomCount, cutoff, maximumCutoff, maxBonds, overrides, settings };
}

/** A sparse exact correction uses the CPU's wrapped-coordinate image graph,
 * and keeps every repeated/self image rather than collapsing atom IDs. */
export function correctGpuBondAtom(frame, prepared, atom, search = new NeighborSearch(frame)) {
  const neighbors = search.within(atom, prepared.maximumCutoff, MAX_NEIGHBORS_PER_ATOM + 1);
  if (neighbors.length > MAX_NEIGHBORS_PER_ATOM) throw new Error('Too many bond neighbors; reduce the cutoff.');
  let coordination = 0;
  const edges = [];
  for (const neighbor of neighbors) {
    const first = frame.types[atom], second = frame.types[neighbor.atom];
    const pairCutoff = prepared.overrides.get(first <= second ? `${first}:${second}` : `${second}:${first}`) ?? prepared.cutoff;
    if (!pairCutoff || neighbor.distanceSquared > pairCutoff ** 2 || neighbor.distanceSquared <= 1e-24) continue;
    coordination++;
    if (neighbor.atom < atom || (neighbor.atom === atom && !positiveShift(neighbor.imageA, neighbor.imageB, neighbor.imageC))) continue;
    edges.push(neighbor);
  }
  return { coordination, neighborCount: neighbors.length, edges };
}

/** GPU count + compact-write passes reuse the resident fractional linked cells.
 * The small CPU prefix scan allocates exactly the accepted bounded edge count. */
export async function analyzeGpuBonds(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  checkSignal(signal);
  const prepared = validateAnalysisInput(() => prepareGpuBondParameters(frame, parameters));
  const { atomCount, startAtom, endAtom, maximumCutoff, maxBonds } = prepared;
  const context = await runtime.prepareNeighbors(frame, maximumCutoff, { signal });
  const buffers = [], create = bytes => { const buffer = runtime.createBuffer(bytes); buffers.push(buffer); return buffer; };
  const upload = values => { const buffer = runtime.storageBuffer(values); buffers.push(buffer); return buffer; };
  const progress = (phase, completedAtoms) => onProgress({ phase, workerCount: 1, completedAtoms,
    totalAtoms: endAtom - startAtom, prepared: 1, initialized: 1 });
  try {
    const settingsBuffer = upload(prepared.settings), atomBuffer = create(atomCount * BOND_ATOM_WORDS * 4);
    progress('indexing', 0);
    await runtime.run(BONDS_COUNT_SHADER, runtime.neighborBindings(context, [settingsBuffer, atomBuffer]), endAtom - startAtom,
      { signal, startAtom, endAtom, onProgress: ({ completedAtoms }) => progress('analyzing', Math.floor((completedAtoms - startAtom) / 2)) });
    const atomData = await runtime.read(atomBuffer, Uint32Array, atomCount * BOND_ATOM_WORDS, { signal });
    const corrections = new Map();
    let search;
    for (let atom = startAtom; atom < endAtom; atom++) {
      const base = atom * BOND_ATOM_WORDS;
      if (atomData[base + 2]) {
        if (corrections.size >= MAX_GPU_BOND_CORRECTION_ATOMS) throw new GpuUnavailableError('Too many bond environments are near cutoff boundaries for GPU precision correction.');
        search ??= new NeighborSearch(frame);
        const corrected = correctGpuBondAtom(frame, prepared, atom, search);
        corrections.set(atom, corrected.edges);
        atomData[base] = corrected.coordination; atomData[base + 1] = corrected.edges.length; atomData[base + 3] = corrected.neighborCount;
        if (corrections.size % 256 === 0) { await yieldWorker(); checkSignal(signal); }
      }
      if (atomData[base + 3] > MAX_NEIGHBORS_PER_ATOM) throw new Error('Too many bond neighbors; reduce the cutoff.');
    }
    const coordination = new Uint32Array(endAtom - startAtom);
    let count = 0, coordinationSum = 0;
    const histogramCounts = new Map();
    for (let atom = startAtom; atom < endAtom; atom++) {
      const base = atom * BOND_ATOM_WORDS, value = atomData[base];
      coordination[atom - startAtom] = value; coordinationSum += value;
      histogramCounts.set(value, (histogramCounts.get(value) ?? 0) + 1);
      atomData[base + 4] = count; count += atomData[base + 1];
      if (count > maxBonds) throw new Error(`Bond output exceeds ${maxBonds.toLocaleString('en-US')} edges; reduce the cutoff.`);
      if (atom && atom % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
    }
    const indices = new Uint32Array(count * 2), vectors = new Float32Array(count * 3), shifts = new Int32Array(count * 3);
    if (count) {
      runtime.write(atomBuffer, atomData);
      const recordBuffer = create(count * BOND_RECORD_WORDS * 4), diagnosticsBuffer = create(16);
      await runtime.run(BONDS_WRITE_SHADER, runtime.neighborBindings(context, [settingsBuffer, atomBuffer, recordBuffer, diagnosticsBuffer]), endAtom - startAtom,
        { signal, startAtom, endAtom, onProgress: ({ completedAtoms }) => progress('analyzing', Math.floor((endAtom - startAtom + completedAtoms - startAtom) / 2)) });
      const [diagnostics, records] = await readGpuBuffers(runtime, [{ buffer: diagnosticsBuffer, Type: Uint32Array, length: 4 },
        { buffer: recordBuffer, Type: Uint32Array, length: count * BOND_RECORD_WORDS }], { signal });
      if (diagnostics[0]) throw new GpuUnavailableError('GPU bond count and compact output disagree; using CPU workers.');
      const floatRecords = new Float32Array(records.buffer), signedRecords = new Int32Array(records.buffer);
      for (let edge = 0; edge < count; edge++) {
        const base = edge * BOND_RECORD_WORDS;
        indices[edge * 2] = records[base]; indices[edge * 2 + 1] = records[base + 1];
        for (let component = 0; component < 3; component++) {
          vectors[edge * 3 + component] = floatRecords[base + 2 + component];
          shifts[edge * 3 + component] = signedRecords[base + 5 + component];
        }
        if (edge && edge % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
      }
      for (const [atom, edges] of corrections) {
        let offset = atomData[atom * BOND_ATOM_WORDS + 4];
        for (const edge of edges) {
          indices.set([atom, edge.atom], offset * 2); vectors.set([edge.x, edge.y, edge.z], offset * 3);
          shifts.set([edge.imageA, edge.imageB, edge.imageC], offset * 3); offset++;
        }
      }
    }
    checkSignal(signal); progress('complete', endAtom - startAtom);
    return { startAtom, endAtom, indices, vectors, shifts, count, coordination,
      histogram: [...histogramCounts].sort((a, b) => a[0] - b[0]).map(([coordination, count]) => ({ coordination, count })),
      meanCoordination: coordinationSum / coordination.length, gpuCorrectionAtoms: corrections.size, warning: null };
  } finally { runtime.disposeBuffers(buffers); }
}

function positiveShift(a, b, c) { return a ? a > 0 : b ? b > 0 : c > 0; }
