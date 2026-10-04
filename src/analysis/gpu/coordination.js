import { minimumImageDistanceSquared } from '../coordination.js';
import { makeNeighborShader } from './neighbors.js';
import { checkSignal, GpuUnavailableError, yieldWorker } from './runtime.js';

const CORRECTION_CAPACITY = 65_536;
const SHADER = makeNeighborShader({
  declarations: `
@group(0) @binding(5) var<storage, read_write> coordination: array<u32>;
@group(0) @binding(6) var<storage, read_write> candidates: array<u32>;
@group(0) @binding(7) var<storage, read_write> corrections: array<atomic<u32>>;
`,
  initialize: 'var count = 0u; var candidateCount = 0u;',
  visit: `
candidateCount++;
if (distanceSquared <= config.cutoff2) { count++; }
if (abs(distanceSquared - config.cutoff2) <= config.distanceTolerance) {
  let correction = atomicAdd(&corrections[0], 1u);
  if (correction < ${CORRECTION_CAPACITY}u) {
    atomicStore(&corrections[4u + correction * 2u], atom);
    atomicStore(&corrections[5u + correction * 2u], other);
    atomicStore(&corrections[4u + ${CORRECTION_CAPACITY * 2}u + correction], select(0u, 1u, distanceSquared <= config.cutoff2));
  } else { atomicStore(&corrections[1], 1u); }
}`,
  finish: 'coordination[atom] = count; candidates[atom] = candidateCount;',
});

/** Distinct atom-ID cutoff coordination, with sparse f64 CPU correction of
 * distances too close to the cutoff for an f32 decision. */
export async function analyzeGpuCoordination(runtime, frame, parameters, { signal, onProgress = () => {} } = {}) {
  const cutoff = Number(parameters.cutoff);
  const context = await runtime.prepareNeighbors(frame, cutoff, { signal });
  const { atomCount } = context;
  onProgress({ phase: 'indexing', completedAtoms: 0, totalAtoms: atomCount });
  const owned = [];
  const create = (bytes) => { const buffer = runtime.createBuffer(bytes); owned.push(buffer); return buffer; };
  try {
    const coordinationBuffer = create(atomCount * 4);
    const candidateBuffer = create(atomCount * 4);
    const correctionBuffer = create((4 + CORRECTION_CAPACITY * 3) * 4);
    await runtime.run(SHADER, runtime.neighborBindings(context, [coordinationBuffer, candidateBuffer, correctionBuffer]), atomCount,
      { signal, onProgress: (progress) => onProgress({ ...progress, phase: 'analyzing' }) });
    const coordination = await runtime.read(coordinationBuffer, Uint32Array, atomCount, { signal });
    const candidates = await runtime.read(candidateBuffer, Uint32Array, atomCount, { signal });
    const correctionHeader = await runtime.read(correctionBuffer, Uint32Array, 4, { signal });
    if (correctionHeader[1] || correctionHeader[0] > CORRECTION_CAPACITY) {
      throw new GpuUnavailableError('Too many coordination distances are near the cutoff for reliable GPU precision.');
    }
    if (correctionHeader[0]) {
      const corrections = await runtime.read(correctionBuffer, Uint32Array, 4 + CORRECTION_CAPACITY * 3, { signal });
      const bounds = context.faceHeights.map((height) => cutoff / height + 1e-12), cutoffSquared = cutoff * cutoff;
      for (let index = 0; index < correctionHeader[0]; index++) {
        const atom = corrections[4 + index * 2], other = corrections[5 + index * 2];
        const actual = minimumImageDistanceSquared(frame.fractional, atom, other, frame.cell, bounds) <= cutoffSquared ? 1 : 0;
        const approximate = corrections[4 + CORRECTION_CAPACITY * 2 + index];
        coordination[atom] += actual - approximate;
        if (index && index % 8192 === 0) { await yieldWorker(); checkSignal(signal); }
      }
    }
    const histogramCounts = new Map();
    let totalCoordination = 0, totalCandidates = 0;
    for (let atom = 0; atom < atomCount; atom++) {
      const value = coordination[atom]; totalCoordination += value; totalCandidates += candidates[atom];
      histogramCounts.set(value, (histogramCounts.get(value) ?? 0) + 1);
      if (atom && atom % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
    }
    const smallAxes = context.faceHeights.map((height, axis) => frame.cell.pbc[axis] && height < cutoff * 2 ? 'abc'[axis] : '').filter(Boolean);
    return { coordination, histogram: [...histogramCounts].sort((a, b) => a[0] - b[0]).map(([coordination, count]) => ({ coordination, count })),
      meanCoordination: totalCoordination / atomCount, acceptedPairs: totalCoordination / 2, candidatePairs: totalCandidates / 2,
      bins: context.dimensions, precisionCorrections: correctionHeader[0], warning: smallAxes.length
        ? `The cell height along periodic axis ${smallAxes.join(', ')} is less than twice the cutoff. Results count the closest image of each unique atom ID and do not count multiple periodic images of the same atom.` : null };
  } finally { runtime.disposeBuffers(owned); }
}
