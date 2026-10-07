import { referenceFactors } from './atomic-strain.js';
import { STRAIN_STRUCTURES } from './lattice.js';
import { determinant3 } from '../data/model.js';
import { yieldToMain } from '../task-yield.js';

const IDEAL_CA = Math.sqrt(8 / 3);
const CHUNK_SIZE = 32768;
const supported = new Set(STRAIN_STRUCTURES);

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Lattice estimation cancelled.', 'AbortError');
}

/** Geometry-derived editable references, without guessing chemical identity.
 * The caller supplies a complete PTM fit from the shared analysis pool: CNA
 * labels alone have no length scale. This reduction performs no neighbor search.
 * Cubic a is volume-equivalent; hexagonal a is basal-area-equivalent and c is
 * the fitted axial length. They describe this frame, including bulk strain,
 * rather than predicting the material's unstrained lattice at its temperature.
 * Results are indexed by the frame's numeric atom types; no reference is mutated.
 */
export async function estimateLatticeReferences(frame, ptm, { rmsdCutoff = .1, minSamples = 4,
  minDominantFraction = .8, minRecognizedFraction = .1, signal, onProgress = () => {} } = {}) {
  const count = frame?.fractional?.length / 3;
  if (!Number.isInteger(count) || count < 1 || frame.types?.length !== count) {
    throw new Error('Lattice estimation requires a complete frame with numeric atom types.');
  }
  if (ptm?.structures?.length !== count || ptm.rmsd?.length !== count || ptm.scales?.length !== count
      || ptm.deformation?.length !== count * 9 || (ptm.startAtom ?? 0) !== 0 || (ptm.endAtom ?? count) !== count) {
    throw new Error('Lattice estimation requires a complete PTM geometric fit, including scales and deformation.');
  }
  if (!Number.isFinite(rmsdCutoff) || rmsdCutoff < 0 || !Number.isInteger(minSamples) || minSamples < 1
      || !Number.isFinite(minDominantFraction) || minDominantFraction <= .5 || minDominantFraction > 1
      || !Number.isFinite(minRecognizedFraction) || minRecognizedFraction <= 0 || minRecognizedFraction > 1) {
    throw new Error('Invalid lattice-estimation confidence thresholds.');
  }
  checkAbort(signal);
  const groups = [];
  onProgress(0, count);
  for (let atom = 0; atom < count; atom += 1) {
    if (atom && atom % CHUNK_SIZE === 0) {
      onProgress(atom, count);
      await yieldToMain();
      checkAbort(signal);
    }
    const type = frame.types[atom];
    if (!Number.isInteger(type) || type < 0 || type > 65535) {
      throw new Error('Lattice estimation requires non-negative integer atom types.');
    }
    const group = groups[type] ??= { totalCount: 0, recognizedCount: 0,
      phaseCounts: Object.fromEntries(Array.from({ length: 9 }, (_, id) => [id, 0])), samples: new Map() };
    group.totalCount += 1;
    const rmsd = ptm.rmsd[atom];
    const id = ptm.structures[atom];
    const structure = Number.isInteger(id) && id >= 1 && id <= 8 && Number.isFinite(rmsd) && rmsd >= 0
      && (!rmsdCutoff || rmsd <= rmsdCutoff) ? id : 0;
    group.phaseCounts[structure] += 1;
    if (!structure) continue;
    group.recognizedCount += 1;
    if (!supported.has(structure)) continue;
    const scale = ptm.scales[atom];
    if (!Number.isFinite(scale) || scale <= 0) continue;
    const F = ptm.deformation.subarray(atom * 9, atom * 9 + 9);
    const volume = determinant3(F);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    // referenceFactors uses PTM's mean template radius, which differs between
    // FCC, BCC, diamond and hexagonal diamond; nearest-distance shortcuts do not.
    const unit = referenceFactors(structure, { a: 1, c: IDEAL_CA }, scale)[0];
    let a, c;
    if (structure === 2 || structure === 7) {
      const basalArea = Math.hypot(F[3] * F[7] - F[6] * F[4],
        F[6] * F[1] - F[0] * F[7], F[0] * F[4] - F[3] * F[1]);
      a = unit * Math.sqrt(basalArea);
      c = unit * IDEAL_CA * Math.hypot(F[2], F[5], F[8]);
    } else a = unit * Math.cbrt(volume);
    if (!Number.isFinite(a) || a <= 0 || (c !== undefined && (!Number.isFinite(c) || c <= 0))) continue;
    const samples = group.samples.get(structure) ?? { a: [], ...(c === undefined ? {} : { c: [] }) };
    samples.a.push(a);
    if (c !== undefined) samples.c.push(c);
    group.samples.set(structure, samples);
  }
  const estimates = Array.from({ length: Math.max(groups.length, frame.typeLabels?.length ?? 0) }, (_, type) => {
    const group = groups[type];
    return { type, element: '', status: 'insufficient', structure: null, a: null, sampleCount: 0,
      totalCount: group?.totalCount ?? 0, recognizedCount: group?.recognizedCount ?? 0,
      phaseCounts: group?.phaseCounts ?? Object.fromEntries(Array.from({ length: 9 }, (_, id) => [id, 0])),
      dominantFraction: 0, reason: 'insufficient-crystalline-atoms' };
  });
  for (const estimate of estimates) {
    checkAbort(signal);
    const group = groups[estimate.type];
    if (!group?.recognizedCount) continue;
    const phases = Object.entries(group.phaseCounts).filter(([id]) => Number(id) > 0)
      .sort((a, b) => b[1] - a[1]);
    const [id, dominantCount] = phases[0];
    const structure = Number(id);
    const samples = group.samples.get(structure);
    estimate.dominantFraction = dominantCount / group.recognizedCount;
    estimate.sampleCount = samples?.a.length ?? 0;
    if (group.recognizedCount < minSamples || group.recognizedCount / group.totalCount < minRecognizedFraction) continue;
    if (estimate.dominantFraction < minDominantFraction) {
      estimate.status = 'ambiguous';
      estimate.reason = 'mixed-phases';
      continue;
    }
    if (!supported.has(structure)) { estimate.reason = 'unsupported-phase'; continue; }
    if (estimate.sampleCount < minSamples) continue;
    estimate.a = await median(samples.a, signal);
    if (samples.c) estimate.c = await median(samples.c, signal);
    estimate.structure = structure;
    estimate.status = 'estimated';
    delete estimate.reason;
  }
  checkAbort(signal);
  onProgress(count, count);
  return estimates;
}

// Exact medians without O(N log N) sorting. Three-way partitioning also avoids
// quadratic behavior for perfect crystals with millions of identical values.
async function median(values, signal) {
  const upperIndex = Math.floor(values.length / 2);
  let left = 0, right = values.length - 1, work = 0;
  let upper;
  while (left <= right) {
    const middle = (left + right) >> 1;
    const pivot = [values[left], values[middle], values[right]].sort((a, b) => a - b)[1];
    let lower = left, current = left, higher = right;
    while (current <= higher) {
      if (values[current] < pivot) {
        [values[lower], values[current]] = [values[current], values[lower]];
        lower += 1;
        current += 1;
      } else if (values[current] > pivot) {
        [values[current], values[higher]] = [values[higher], values[current]];
        higher -= 1;
      } else current += 1;
      if (++work % CHUNK_SIZE === 0) { await yieldToMain(); checkAbort(signal); }
    }
    if (upperIndex < lower) right = lower - 1;
    else if (upperIndex > higher) left = higher + 1;
    else { upper = pivot; break; }
  }
  if (values.length % 2) return upper;
  // Quickselect puts every value below the upper median in the preceding
  // partition, so its maximum is the lower median, including duplicate pivots.
  let lower = values[0];
  for (let i = 1; i < upperIndex; i += 1) {
    lower = Math.max(lower, values[i]);
    if (++work % CHUNK_SIZE === 0) { await yieldToMain(); checkAbort(signal); }
  }
  return (lower + upper) / 2;
}
