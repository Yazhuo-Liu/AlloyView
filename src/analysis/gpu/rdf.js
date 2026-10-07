import { rdfNormalization, finalizeRdf } from '../rdf.js';
import { MAX_NEIGHBORS_PER_ATOM } from '../bonds.js';
import { cellFaceHeights } from '../../data/model.js';
import { makeNeighborShader } from './neighbors.js';
import { GpuUnavailableError, yieldWorker } from './runtime.js';

const U32_MAX = 0xffff_ffff;
const MAX_BATCH_ATOMS = 16_384;
const MAX_CORRECTIONS = 65_536;
const F32_EPSILON = 2 ** -23;

// RDF's half-face-height radius excludes contributing duplicate/self images.
// The closest-image traversal therefore visits each directed atom pair once.
// Pairs close to shell boundaries are returned to JS for double-precision
// classification instead of letting f32 round a pair into the wrong shell.
export const RDF_SHADER = makeNeighborShader({
  mode: 'nearest',
  declarations: `
struct RdfSettings {
  bins: u32, firstType: u32, secondType: u32, correctionCapacity: u32,
  cutoff: f32, margin: f32, maximumNeighbors: u32, padding: u32,
};
struct RdfCorrections {
  count: atomic<u32>, overflow: atomic<u32>, neighborLimit: atomic<u32>, padding: u32,
  pairs: array<vec2u>,
};
@group(0) @binding(5) var<storage, read_write> histogram: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read> settings: RdfSettings;
@group(0) @binding(7) var<storage, read_write> corrections: RdfCorrections;
`,
  initialize: `
  if (settings.firstType != 0xffffffffu && types[atom] != settings.firstType) { return; }
  var neighbors = 0u;
`,
  visit: `
  if (distanceSquared <= (settings.cutoff + settings.margin) * (settings.cutoff + settings.margin)) {
    neighbors++;
    if (neighbors > settings.maximumNeighbors) {
      atomicStore(&corrections.neighborLimit, 1u);
      return;
    }
    if (settings.secondType == 0xffffffffu || types[other] == settings.secondType) {
      let distance = sqrt(distanceSquared);
      let shell = distance / settings.cutoff * f32(settings.bins);
      let shellMargin = settings.margin / settings.cutoff * f32(settings.bins) + f32(settings.bins) * 0.000004;
      let ambiguous = distance >= settings.cutoff - settings.margin || abs(shell - round(shell)) <= shellMargin;
      if (ambiguous) {
        let index = atomicAdd(&corrections.count, 1u);
        if (index < settings.correctionCapacity) {
          corrections.pairs[index] = vec2u(atom, other);
        } else {
          atomicStore(&corrections.overflow, 1u);
        }
      } else {
        let bin = u32(floor(shell));
        if (bin < settings.bins) { atomicAdd(&histogram[bin], 1u); }
      }
    }
  }
`,
});

export async function analyzeGpuRdf(runtime, frame, parameters, { signal, onProgress = () => {} } = {}) {
  const { cutoff: requestedCutoff, bins: requestedBins = 100, firstType: requestedFirst = null, secondType: requestedSecond = null } = parameters;
  const normalization = rdfNormalization(frame, { cutoff: requestedCutoff, bins: requestedBins,
    firstType: requestedFirst, secondType: requestedSecond });
  const count = frame.fractional.length / 3;
  const { cutoff, bins, firstType, secondType } = normalization;
  if ([firstType, secondType].some((type) => type !== null && type >= U32_MAX)
      || frame.types.some((type) => !Number.isInteger(type) || type < 0 || type > U32_MAX)) {
    throw new GpuUnavailableError('The RDF element types cannot be represented exactly on this GPU backend.');
  }
  const margin = rdfPrecisionMargin(frame, cutoff);
  const context = await runtime.prepareNeighbors(frame, cutoff + margin * 1.125, { signal });
  const batchSize = rdfGpuBatchSize(count);
  const correctionCapacity = Math.min(MAX_CORRECTIONS, Math.max(1024, batchSize * 4));
  const settingsData = new ArrayBuffer(32);
  const unsigned = new Uint32Array(settingsData);
  const floats = new Float32Array(settingsData);
  unsigned.set([bins, firstType ?? U32_MAX, secondType ?? U32_MAX, correctionCapacity]);
  floats[4] = cutoff;
  floats[5] = margin;
  unsigned[6] = MAX_NEIGHBORS_PER_ATOM;
  const allocated = [];
  let correctedPairs = 0;
  try {
    const histogram = runtime.createBuffer(bins * 4);
    allocated.push(histogram);
    const settings = runtime.storageBuffer(new Uint8Array(settingsData));
    allocated.push(settings);
    const corrections = runtime.createBuffer(16 + correctionCapacity * 8);
    allocated.push(corrections);
    const bindings = runtime.neighborBindings(context, [histogram, settings, corrections]);
    const counts = new Float64Array(bins);
    for (let startAtom = 0; startAtom < count; startAtom += batchSize) {
      signal?.throwIfAborted();
      const endAtom = Math.min(count, startAtom + batchSize);
      await runtime.zeroBuffer(histogram);
      await runtime.zeroBuffer(corrections);
      await runtime.run(RDF_SHADER, bindings, endAtom - startAtom, { signal, context, startAtom, endAtom });
      const batchCounts = await runtime.read(histogram, Uint32Array, bins, { signal });
      const diagnostics = await runtime.read(corrections, Uint32Array, 4, { signal });
      if (diagnostics[1]) throw new GpuUnavailableError('Too many RDF pairs lie on floating-point shell boundaries.');
      if (diagnostics[2]) throw new GpuUnavailableError('The RDF neighborhood exceeds the GPU safety limit.');
      for (let bin = 0; bin < bins; bin += 1) counts[bin] += batchCounts[bin];
      if (diagnostics[0]) {
        const records = await runtime.read(corrections, Uint32Array, 4 + diagnostics[0] * 2, { signal });
        await correctGpuRdfPairs(frame, normalization, records.subarray(4), counts, { signal });
        correctedPairs += diagnostics[0];
      }
      onProgress({ phase: 'analyzing', completedAtoms: endAtom, totalAtoms: count, done: endAtom, total: count });
    }
    return { startAtom: 0, endAtom: count, ...finalizeRdf(counts, normalization), correctedPairs };
  } finally {
    runtime.disposeBuffers(allocated);
  }
}

/** Bound every atomic histogram to u32 while accumulating batches in f64. */
export function rdfGpuBatchSize(atomCount) {
  return Math.max(1, Math.min(MAX_BATCH_ATOMS, atomCount,
    Math.floor(U32_MAX / Math.min(MAX_NEIGHBORS_PER_ATOM, Math.max(1, atomCount - 1)))));
}

export function rdfPrecisionMargin(frame, cutoff) {
  const h = frame.cell.vectors;
  const longest = Math.max(Math.hypot(h[0], h[1], h[2]), Math.hypot(h[3], h[4], h[5]), Math.hypot(h[6], h[7], h[8]));
  const squared = Math.max(1e-8, cutoff * longest * 32 * F32_EPSILON + cutoff ** 2 * 64 * F32_EPSILON);
  return Math.sqrt(cutoff ** 2 + squared) - cutoff;
}

/** Correct only ambiguous pairs; no second CPU linked-cell build is needed. */
export async function correctGpuRdfPairs(frame, normalization, pairs, counts, { signal } = {}) {
  const { cutoff, bins, firstType, secondType } = normalization;
  const h = frame.cell.vectors;
  const bounds = Array.from(cellFaceHeights(frame.cell), (height) => cutoff / height + 1e-12);
  const coordinates = frame.fractional;
  for (let index = 0; index < pairs.length; index += 2) {
    if (index % 8192 === 0) {
      signal?.throwIfAborted();
      if (index) await yieldWorker();
    }
    const atom = pairs[index], other = pairs[index + 1];
    if (atom === other || (firstType !== null && frame.types[atom] !== firstType)
        || (secondType !== null && frame.types[other] !== secondType)) continue;
    const difference = [0, 1, 2].map((axis) => {
      const first = coordinates[atom * 3 + axis], second = coordinates[other * 3 + axis];
      return (second - Math.floor(second)) - (first - Math.floor(first));
    });
    const ranges = difference.map((value, axis) => [Math.ceil(-bounds[axis] - value), Math.floor(bounds[axis] - value)]);
    let closest = Infinity;
    for (let a = ranges[0][0]; a <= ranges[0][1]; a += 1) {
      for (let b = ranges[1][0]; b <= ranges[1][1]; b += 1) {
        for (let c = ranges[2][0]; c <= ranges[2][1]; c += 1) {
          const da = difference[0] + a, db = difference[1] + b, dc = difference[2] + c;
          const x = da * h[0] + db * h[3] + dc * h[6];
          const y = da * h[1] + db * h[4] + dc * h[7];
          const z = da * h[2] + db * h[5] + dc * h[8];
          closest = Math.min(closest, x * x + y * y + z * z);
        }
      }
    }
    if (closest <= cutoff * cutoff) {
      const bin = Math.floor(Math.sqrt(closest) / cutoff * bins);
      if (bin < bins) counts[bin] += 1;
    }
  }
  signal?.throwIfAborted();
}
