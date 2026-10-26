import { validateVolumetricDataset, VOLUMETRIC_LIMITS } from './volumetric-grid.js';
import { yieldToMain } from '../shared/task-yield.js';

/** Validate all allocations before repeating either atoms or volume samples. */
export function volumetricReplicationPlan(frame, repetitions) {
  const datasets = frame.volumetric?.datasets ?? [];
  if (datasets.length > VOLUMETRIC_LIMITS.datasets) throw new Error('Too many volumetric datasets to replicate.');
  let samples = 0, bytes = 0;
  for (const dataset of datasets) {
    validateVolumetricDataset(dataset);
    for (let axis = 0; axis < 3; axis++) {
      if (repetitions[axis] === 1) continue;
      if (!dataset.periodic[axis]) throw new Error('Physical replication cannot repeat an open volumetric grid.');
      for (let component = 0; component < 3; component++) {
        const extent = dataset.steps[axis * 3 + component] * dataset.dimensions[axis];
        const cell = frame.cell.vectors[axis * 3 + component];
        if (Math.abs(extent - cell) > 1e-10 * Math.max(1, Math.abs(extent), Math.abs(cell))) {
          throw new Error('The periodic volumetric grid must span the simulation cell before physical replication.');
        }
      }
    }
    const count = dataset.values.length * repetitions.reduce((a, b) => a * b, 1);
    samples += count;
    if (!Number.isSafeInteger(count) || count > VOLUMETRIC_LIMITS.samplesPerDataset
        || samples > VOLUMETRIC_LIMITS.totalSamples) throw new Error('Physical replication exceeds the volumetric sample budget; reduce the repeat counts.');
    // Retain both immutable input and new output during Worker replication.
    bytes += dataset.values.byteLength + count * dataset.values.BYTES_PER_ELEMENT;
  }
  return { samples, bytes };
}

export async function replicateVolumetricData(frame, repetitions, { signal, yieldTask = yieldToMain } = {}) {
  if (!frame.volumetric) return undefined;
  volumetricReplicationPlan(frame, repetitions);
  const copies = repetitions.reduce((a, b) => a * b, 1), datasets = [];
  for (const dataset of frame.volumetric.datasets) {
    const dimensions = dataset.dimensions.map((n, axis) => n * repetitions[axis]);
    const [nx, ny, nz] = dataset.dimensions, [rx, ry] = dimensions;
    const values = new dataset.values.constructor(dataset.values.length * copies);
    for (let i = 0; i < values.length; i++) {
      if ((i & 16383) === 0) {
        if (signal?.aborted) throw new DOMException('Replication cancelled.', 'AbortError');
        await yieldTask();
        if (signal?.aborted) throw new DOMException('Replication cancelled.', 'AbortError');
      }
      const x = i % rx, y = Math.floor(i / rx) % ry, z = Math.floor(i / (rx * ry));
      values[i] = dataset.values[x % nx + nx * (y % ny + ny * (z % nz))];
    }
    const statistics = dataset.statistics && { ...dataset.statistics,
      sum: dataset.statistics.sum * copies, integral: dataset.statistics.integral * copies,
      sampleCount: values.length };
    if (statistics && ['sum', 'integral'].some(key => !Number.isFinite(statistics[key]))) {
      throw new Error('Replicated volumetric statistics exceed the numeric range.');
    }
    datasets.push({ ...dataset, dimensions, values, origin: new Float64Array(dataset.origin),
      steps: new Float64Array(dataset.steps), periodic: [...dataset.periodic], statistics });
  }
  return { ...frame.volumetric, datasets };
}
