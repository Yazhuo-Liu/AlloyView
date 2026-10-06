import { NeighborSearch } from '../neighbors.js';
import { validateBondStatisticsParameters, createBondStatisticsAccumulators, calculateBondStatisticsAtom,
  addBondStatisticsSample, mergeBondStatisticsMoment, bondStatisticsHistogramBin, finalizeBondStatistics } from '../bond-statistics.js';
import { prepareGpuBondParameters } from './bonds.js';
import { checkSignal, GpuUnavailableError, yieldWorker } from './runtime.js';
import { BOND_STATISTICS_SHADER, BOND_STATISTICS_ATOM_WORDS, BOND_STATISTICS_CORRECTION_WORDS,
  BOND_STATISTICS_FLAG_PRECISION, BOND_STATISTICS_FLAG_NEIGHBORS, MAX_GPU_BOND_STATISTICS_NEIGHBORS } from './bond-statistics-shaders.js';

export const MAX_GPU_BOND_STATISTICS_CORRECTIONS = 16_384;
export const MAX_GPU_BOND_STATISTICS_PAIR_CORRECTIONS = 262_144;
export const GPU_BOND_STATISTICS_BATCH_ATOMS = 2048;

/** A shell can receive every pair. Bound both histogram and correction atomics
 * to u32 per dispatch, regardless of the overall frame's sample count. */
export function bondStatisticsGpuBatchSize(atomCount) {
  const samplesPerAtom = MAX_GPU_BOND_STATISTICS_NEIGHBORS
    + MAX_GPU_BOND_STATISTICS_NEIGHBORS * (MAX_GPU_BOND_STATISTICS_NEIGHBORS - 1) / 2;
  return Math.max(1, Math.min(atomCount, GPU_BOND_STATISTICS_BATCH_ATOMS, Math.floor(0xffff_ffff / samplesPerAtom)));
}

/** Linked cells and coordinates remain resident on the existing device. Each
 * invocation owns a central environment, so Q4/Q6 and angular enumeration
 * run entirely on the GPU. Only output rows/histograms and ambiguous shell
 * pairs cross back; precision corrections never download a neighbor graph. */
export async function analyzeGpuBondStatistics(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  checkSignal(signal);
  const prepared = validateBondStatisticsParameters(frame, parameters);
  // Reuse the Bonds numeric/type limits before sending settings to WGSL.
  prepareGpuBondParameters(frame, parameters);
  const { startAtom, endAtom, cutoff, maximumCutoff, lengthBins, angleBins } = prepared;
  if (![cutoff, maximumCutoff].every(value => Number.isFinite(Math.fround(value)) && Math.fround(value) > 0)) {
    throw new GpuUnavailableError('The bond statistics cutoffs exceed GPU numeric precision.');
  }
  const count = endAtom - startAtom;
  const context = await runtime.prepareNeighbors(frame, maximumCutoff, { signal });
  const output = createBondStatisticsAccumulators(prepared);
  const coordination = new Uint32Array(count), q4 = new Float32Array(count), q6 = new Float32Array(count);
  const allocated = [], allocate = bytes => { const buffer = runtime.createBuffer(bytes); allocated.push(buffer); return buffer; };
  const upload = values => { const buffer = runtime.storageBuffer(values); allocated.push(buffer); return buffer; };
  const initialBatch = bondStatisticsGpuBatchSize(count);
  const capacity = Math.min(MAX_GPU_BOND_STATISTICS_PAIR_CORRECTIONS, Math.max(1024, initialBatch * 128));
  let correctionAtoms = 0, correctedPairs = 0, search;
  try {
    const values = new Uint32Array(12 + (parameters.pairCutoffs?.length ?? 0) * 4), floats = new Float32Array(values.buffer);
    values.set([parameters.pairCutoffs?.length ?? 0, lengthBins, angleBins, capacity]);
    floats[4] = cutoff; floats[5] = maximumCutoff; floats[6] = 0; floats[7] = maximumCutoff;
    (parameters.pairCutoffs ?? []).forEach((entry, index) => {
      const offset = 12 + index * 4;
      values[offset] = Math.min(entry.first, entry.second); values[offset + 1] = Math.max(entry.first, entry.second);
      floats[offset + 2] = entry.cutoff;
    });
    const settings = upload(values), atomBuffer = allocate(initialBatch * BOND_STATISTICS_ATOM_WORDS * 4);
    const histogram = allocate((lengthBins + angleBins) * 4);
    const corrections = allocate(16 + capacity * BOND_STATISTICS_CORRECTION_WORDS * 4);
    const bindings = runtime.neighborBindings(context, [settings, atomBuffer, histogram, corrections]);
    let batchSize = initialBatch;
    for (let begin = startAtom; begin < endAtom;) {
      checkSignal(signal);
      const end = Math.min(endAtom, begin + batchSize);
      await runtime.zeroBuffer(histogram); await runtime.zeroBuffer(corrections);
      await runtime.run(BOND_STATISTICS_SHADER, bindings, end - begin,
        { signal, startAtom: begin, endAtom: end, batchSize: 0 });
      const diagnostics = await runtime.read(corrections, Uint32Array, 4, { signal });
      if (diagnostics[1]) {
        // Crystalline shell ties can fill the correction queue; reduce only
        // this dispatch, keeping the GPU device, buffers and neighbor index.
        if (batchSize === 1) throw new GpuUnavailableError('A bond environment exceeds the GPU precision correction capacity.');
        batchSize = Math.max(1, Math.floor(batchSize / 2)); continue;
      }
      const [atomWords, batchCounts] = await Promise.all([
        runtime.read(atomBuffer, Uint32Array, (end - begin) * BOND_STATISTICS_ATOM_WORDS, { signal }),
        runtime.read(histogram, Uint32Array, lengthBins + angleBins, { signal }),
      ]);
      for (let bin = 0; bin < lengthBins; bin++) output.lengthCounts[bin] += batchCounts[bin];
      for (let bin = 0; bin < angleBins; bin++) output.angleCounts[bin] += batchCounts[lengthBins + bin];
      const atomFloats = new Float32Array(atomWords.buffer);
      for (let atom = begin; atom < end; atom++) {
        const base = (atom - begin) * BOND_STATISTICS_ATOM_WORDS, row = atom - startAtom;
        const flags = atomWords[base + 3];
        if (flags & BOND_STATISTICS_FLAG_NEIGHBORS) {
          throw new GpuUnavailableError(`Bond statistics environments above ${MAX_GPU_BOND_STATISTICS_NEIGHBORS} neighbors use CPU workers.`);
        }
        if (flags & BOND_STATISTICS_FLAG_PRECISION) {
          if (++correctionAtoms > MAX_GPU_BOND_STATISTICS_CORRECTIONS) {
            throw new GpuUnavailableError('Too many bond environments are on GPU cutoff boundaries; using CPU workers.');
          }
          search ??= new NeighborSearch(frame);
          const local = calculateBondStatisticsAtom(search, atom, prepared, output);
          coordination[row] = local.coordination; q4[row] = local.q4; q6[row] = local.q6;
          if (correctionAtoms % 64 === 0) { await yieldWorker(); checkSignal(signal); }
        } else {
          coordination[row] = atomWords[base]; q4[row] = atomFloats[base + 1]; q6[row] = atomFloats[base + 2];
          mergeBondStatisticsMoment(output.moments.length, readMoment(atomWords, atomFloats, base + 4));
          mergeBondStatisticsMoment(output.moments.angle, readMoment(atomWords, atomFloats, base + 9));
          addBondStatisticsSample(output.moments.q4, q4[row]); addBondStatisticsSample(output.moments.q6, q6[row]);
        }
      }
      if (diagnostics[0]) {
        const records = await runtime.read(corrections, Uint32Array, 4 + diagnostics[0] * BOND_STATISTICS_CORRECTION_WORDS, { signal });
        await correctGpuBondStatisticsPairs(frame, prepared, records.subarray(4), output, { signal });
        correctedPairs += diagnostics[0];
      }
      begin = end;
      onProgress({ phase: 'analyzing', completedAtoms: begin - startAtom, totalAtoms: count,
        done: begin - startAtom, total: count, workerCount: 1 });
      if (begin < endAtom) await yieldWorker();
    }
    checkSignal(signal);
    return finalizeBondStatistics({ startAtom, endAtom, coordination, q4, q6, ...output,
      normalization: prepared.normalization, gpuCorrectionAtoms: correctionAtoms, correctedPairs });
  } finally { runtime.disposeBuffers(allocated); }
}

/** Recover only bin-boundary pairs with the exact wrapped f64 source vectors.
 * IDs and explicit image shifts distinguish repeated/self images in thin and
 * tilted periodic cells. This does not create a second neighbor index. */
export async function correctGpuBondStatisticsPairs(frame, prepared, records, output, { signal } = {}) {
  const signed = new Int32Array(records.buffer, records.byteOffset, records.length);
  for (let offset = 0; offset < records.length; offset += BOND_STATISTICS_CORRECTION_WORDS) {
    if (offset % (4096 * BOND_STATISTICS_CORRECTION_WORDS) === 0) {
      checkSignal(signal); if (offset) await yieldWorker();
    }
    const kind = records[offset], atom = records[offset + 1];
    const first = exactImageVector(frame, atom, records[offset + 2], signed.subarray(offset + 4, offset + 7));
    const firstSquared = first[0] ** 2 + first[1] ** 2 + first[2] ** 2;
    if (kind === 0) {
      const length = Math.sqrt(firstSquared);
      output.lengthCounts[bondStatisticsHistogramBin(length, prepared.maximumCutoff, prepared.lengthBins)]++;
      addBondStatisticsSample(output.moments.length, length);
    } else if (kind === 1) {
      const second = exactImageVector(frame, atom, records[offset + 3], signed.subarray(offset + 7, offset + 10));
      const secondSquared = second[0] ** 2 + second[1] ** 2 + second[2] ** 2;
      const cosine = Math.max(-1, Math.min(1, (first[0] * second[0] + first[1] * second[1] + first[2] * second[2])
        * ((1 / Math.sqrt(firstSquared)) * (1 / Math.sqrt(secondSquared)))));
      const angle = Math.acos(cosine) * 180 / Math.PI;
      output.angleCounts[bondStatisticsHistogramBin(angle, 180, prepared.angleBins)]++;
      addBondStatisticsSample(output.moments.angle, angle);
    } else throw new GpuUnavailableError('The GPU bond statistics correction record is invalid.');
  }
}

function exactImageVector(frame, atom, other, shift) {
  const difference = [0, 1, 2].map(axis => {
    const first = frame.fractional[atom * 3 + axis], second = frame.fractional[other * 3 + axis];
    return (frame.cell.pbc[axis] ? (second - Math.floor(second)) - (first - Math.floor(first)) : second - first) + shift[axis];
  });
  const h = frame.cell.vectors, [a, b, c] = difference;
  return [a * h[0] + b * h[3] + c * h[6], a * h[1] + b * h[4] + c * h[7], a * h[2] + b * h[5] + c * h[8]];
}

function readMoment(unsigned, floats, offset) {
  return { count: unsigned[offset], min: floats[offset + 1], max: floats[offset + 2],
    mean: floats[offset + 3], m2: Math.max(0, floats[offset + 4]) };
}
