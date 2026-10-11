import { NeighborSearch } from '../neighbors.js';
import { validateBondStatisticsParameters, createBondStatisticsAccumulators, calculateBondStatisticsAtom,
  addBondStatisticsSample, mergeBondStatisticsMoment, bondStatisticsHistogramBin, finalizeBondStatistics } from '../bond-statistics.js';
import { prepareGpuBondParameters } from './bonds.js';
import { checkSignal, GpuUnavailableError, readGpuBuffers, yieldWorker } from './runtime.js';
import { validateAnalysisInput } from '../errors.js';
import { BOND_STATISTICS_SHADER, BOND_STATISTICS_ATOM_WORDS, BOND_STATISTICS_CORRECTION_WORDS,
  BOND_STATISTICS_FLAG_PRECISION, BOND_STATISTICS_FLAG_NEIGHBORS, MAX_GPU_BOND_STATISTICS_NEIGHBORS } from './bond-statistics-shaders.js';

export const MAX_GPU_BOND_STATISTICS_CORRECTIONS = 16_384;
// Queued exact-bin pair records per dispatch (48 bytes each). Hardware
// adapters keep twice the software queue, so 16k-atom batches fit about 32
// boundary pairs per atom before a dispatch is split.
export const MAX_GPU_BOND_STATISTICS_PAIR_CORRECTIONS = 262_144;
export const MAX_GPU_BOND_STATISTICS_HARDWARE_PAIR_CORRECTIONS = 524_288;
export const GPU_BOND_STATISTICS_BATCH_ATOMS = 16_384;

/** A shell can receive every pair. Bound both histogram and correction atomics
 * to u32 per dispatch, regardless of the overall frame's sample count. */
export function bondStatisticsGpuBatchSize(atomCount) {
  const samplesPerAtom = MAX_GPU_BOND_STATISTICS_NEIGHBORS
    + MAX_GPU_BOND_STATISTICS_NEIGHBORS * (MAX_GPU_BOND_STATISTICS_NEIGHBORS - 1) / 2;
  return Math.max(1, Math.min(atomCount, GPU_BOND_STATISTICS_BATCH_ATOMS, Math.floor(0xffff_ffff / samplesPerAtom)));
}

/** Choose the next dispatch from the observed boundary-pair density so its
 * correction queue is expected to fit; a dispatch that overflowed is split by
 * its requested record count (or halved when that count is unavailable). */
export function nextBondStatisticsBatch({ atoms, records, capacity, maximum, overflow }) {
  if (overflow) {
    const estimate = records > capacity ? Math.floor(atoms * capacity * 0.9 / records) : Math.floor(atoms / 2);
    return Math.max(1, Math.min(atoms - 1, estimate));
  }
  if (!records) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(capacity * 0.75 * atoms / records)));
}

/** Linked cells and coordinates remain resident on the existing device. Each
 * invocation owns a central environment, so Q4/Q6 and angular enumeration
 * run entirely on the GPU. Only output rows/histograms and ambiguous shell
 * pairs cross back; precision corrections never download a neighbor graph. */
export async function analyzeGpuBondStatistics(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  checkSignal(signal);
  const prepared = validateAnalysisInput(() => validateBondStatisticsParameters(frame, parameters));
  // Reuse the Bonds numeric/type limits before sending settings to WGSL.
  validateAnalysisInput(() => prepareGpuBondParameters(frame, parameters));
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
  const capacity = Math.min(runtime.softwareAdapter === false ? MAX_GPU_BOND_STATISTICS_HARDWARE_PAIR_CORRECTIONS
    : MAX_GPU_BOND_STATISTICS_PAIR_CORRECTIONS, Math.max(1024, initialBatch * 128));
  let correctionAtoms = 0, correctedPairs = 0, search, wrapped;
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
    // A batch shares one histogram, queue and row range. Its dispatches start
    // at the former 2,048 atoms and follow the measured dispatch time, since
    // dense environments make the angular enumeration quadratic per atom.
    let batchSize = initialBatch, recordDensity = 0, dispatchSize = 2048;
    const launch = async begin => {
      checkSignal(signal);
      const end = Math.min(endAtom, begin + batchSize);
      // Boundary-pair records usually follow the previous batch's density;
      // copying that much speculatively avoids a second mapping per batch.
      const expected = recordDensity ? Math.min(capacity, Math.ceil(recordDensity * (end - begin) * 1.25) + 1024) : 0;
      // Records are read only below the atomic count, so clearing the
      // 16-byte header resets the queue without rewriting all records.
      await runtime.zeroBuffer(histogram); await runtime.zeroBuffer(corrections, 0, 16);
      runtime.write(settings, new Uint32Array([begin]), 32);
      dispatchSize = await runtime.run(BOND_STATISTICS_SHADER, bindings, end - begin,
        { signal, startAtom: begin, endAtom: end, initialBatchSize: dispatchSize, wait: false }) ?? dispatchSize;
      // One mapping returns the queue header, rows and histogram together.
      const readback = readGpuBuffers(runtime, [
        { buffer: corrections, Type: Uint32Array, length: 4 },
        { buffer: atomBuffer, Type: Uint32Array, length: (end - begin) * BOND_STATISTICS_ATOM_WORDS },
        { buffer: histogram, Type: Uint32Array, length: lengthBins + angleBins },
        { buffer: corrections, Type: Uint32Array, offset: 16, length: expected * BOND_STATISTICS_CORRECTION_WORDS }], { signal });
      readback.catch(() => {});
      return { begin, end, expected, readback };
    };
    // Read a batch completely (splitting it if its correction queue
    // overflowed) before the next batch reuses the same GPU buffers.
    const collect = async batch => {
      for (;;) {
        const [diagnostics, atomWords, batchCounts, prefix] = await batch.readback;
        const atoms = batch.end - batch.begin;
        if (!diagnostics[1]) {
          const words = diagnostics[0] * BOND_STATISTICS_CORRECTION_WORDS;
          const records = !diagnostics[0] ? null : diagnostics[0] <= batch.expected ? prefix.subarray(0, words)
            : await runtime.read(corrections, Uint32Array, words, { signal, offset: 16 });
          recordDensity = diagnostics[0] / atoms;
          batchSize = nextBondStatisticsBatch({ atoms, records: diagnostics[0], capacity, maximum: initialBatch, overflow: false });
          return { ...batch, diagnostics, atomWords, batchCounts, records };
        }
        // Crystalline shell ties can fill the correction queue; reduce only
        // this dispatch, keeping the GPU device, buffers and neighbor index.
        if (atoms === 1) throw new GpuUnavailableError('A bond environment exceeds the GPU precision correction capacity.');
        batchSize = nextBondStatisticsBatch({ atoms, records: diagnostics[0], capacity, maximum: initialBatch, overflow: true });
        batch = await launch(batch.begin);
      }
    };
    // The GPU computes the next batch while this one is merged and its
    // boundary pairs are corrected on the CPU. Moments are merged in batch
    // order; counts and histograms are integers.
    for (let current = await collect(await launch(startAtom)); current;) {
      const { begin, end, diagnostics, atomWords, batchCounts, records } = current;
      const next = end < endAtom ? await launch(end) : null;
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
      if (records) {
        wrapped ??= wrappedFractional(frame);
        await correctGpuBondStatisticsPairs(frame, prepared, records, output, { signal, wrapped });
        correctedPairs += diagnostics[0];
      }
      onProgress({ phase: 'analyzing', completedAtoms: end - startAtom, totalAtoms: count,
        done: end - startAtom, total: count, workerCount: 1 });
      if (next) await yieldWorker();
      current = next ? await collect(next) : null;
    }
    checkSignal(signal);
    return finalizeBondStatistics({ startAtom, endAtom, coordination, q4, q6, ...output,
      normalization: prepared.normalization, gpuCorrectionAtoms: correctionAtoms, correctedPairs });
  } finally { runtime.disposeBuffers(allocated); }
}

/** Recover only bin-boundary pairs with the exact wrapped f64 source vectors.
 * IDs and explicit image shifts distinguish repeated/self images in thin and
 * tilted periodic cells. This does not create a second neighbor index. */
export async function correctGpuBondStatisticsPairs(frame, prepared, records, output, { signal, wrapped = wrappedFractional(frame) } = {}) {
  const signed = new Int32Array(records.buffer, records.byteOffset, records.length);
  // Millions of boundary pairs occur in near-perfect crystals with integer-
  // degree bins. Pre-wrapped coordinates and scalar locals avoid per-record
  // arrays and views; the f64 operations and their order are unchanged.
  const h = frame.cell.vectors, vectors = new Float64Array(6);
  const { maximumCutoff, lengthBins, angleBins } = prepared, { lengthCounts, angleCounts, moments } = output;
  for (let offset = 0; offset < records.length; offset += BOND_STATISTICS_CORRECTION_WORDS) {
    if (offset % (4096 * BOND_STATISTICS_CORRECTION_WORDS) === 0) {
      checkSignal(signal); if (offset) await yieldWorker();
    }
    const kind = records[offset], atom = records[offset + 1];
    if (kind !== 0 && kind !== 1) throw new GpuUnavailableError('The GPU bond statistics correction record is invalid.');
    exactImageVector(vectors, 0, wrapped, h, atom, records[offset + 2], signed[offset + 4], signed[offset + 5], signed[offset + 6]);
    const firstSquared = vectors[0] ** 2 + vectors[1] ** 2 + vectors[2] ** 2;
    if (kind === 0) {
      const length = Math.sqrt(firstSquared);
      lengthCounts[bondStatisticsHistogramBin(length, maximumCutoff, lengthBins)]++;
      addBondStatisticsSample(moments.length, length);
    } else {
      exactImageVector(vectors, 3, wrapped, h, atom, records[offset + 3], signed[offset + 7], signed[offset + 8], signed[offset + 9]);
      const secondSquared = vectors[3] ** 2 + vectors[4] ** 2 + vectors[5] ** 2;
      const cosine = Math.max(-1, Math.min(1, (vectors[0] * vectors[3] + vectors[1] * vectors[4] + vectors[2] * vectors[5])
        * ((1 / Math.sqrt(firstSquared)) * (1 / Math.sqrt(secondSquared)))));
      const angle = Math.acos(cosine) * 180 / Math.PI;
      angleCounts[bondStatisticsHistogramBin(angle, 180, angleBins)]++;
      addBondStatisticsSample(moments.angle, angle);
    }
  }
}

/** Source fractional coordinates, wrapped into [0, 1) on periodic axes. */
export function wrappedFractional(frame) {
  const source = frame.fractional, wrapped = new Float64Array(source.length);
  const periodic = [0, 1, 2].map(axis => Boolean(frame.cell.pbc[axis]));
  for (let index = 0; index < source.length; index++) {
    const value = source[index];
    wrapped[index] = periodic[index % 3] ? value - Math.floor(value) : value;
  }
  return wrapped;
}

/** Exact wrapped source difference plus the GPU image shift, in Cartesian f64. */
function exactImageVector(target, base, wrapped, h, atom, other, shiftA, shiftB, shiftC) {
  const a = (wrapped[other * 3] - wrapped[atom * 3]) + shiftA;
  const b = (wrapped[other * 3 + 1] - wrapped[atom * 3 + 1]) + shiftB;
  const c = (wrapped[other * 3 + 2] - wrapped[atom * 3 + 2]) + shiftC;
  target[base] = a * h[0] + b * h[3] + c * h[6];
  target[base + 1] = a * h[1] + b * h[4] + c * h[7];
  target[base + 2] = a * h[2] + b * h[5] + c * h[8];
}

function readMoment(unsigned, floats, offset) {
  return { count: unsigned[offset], min: floats[offset + 1], max: floats[offset + 2],
    mean: floats[offset + 3], m2: Math.max(0, floats[offset + 4]) };
}
