import { determinant3 } from './model.js';

export const VOLUMETRIC_LIMITS = Object.freeze({
  samplesPerDataset: 8 * 1024 * 1024,
  totalSamples: 32 * 1024 * 1024,
  datasets: 64,
  textCharacters: 256 * 1024 * 1024,
});

/** A grid stores samples at origin + i*a + j*b + k*c, with x-fastest data:
 * index = i + nx*(j + ny*k). `steps` contains the three Cartesian row vectors,
 * in Å per sample. A periodic axis has n voxels (the last wraps to sample 0);
 * an open axis has n-1 voxels and never invents a periodic continuation. */
export function validateVolumetricDataset(dataset, { scanValues = false } = {}) {
  const dimensions = dataset?.dimensions;
  if (!Array.isArray(dimensions) || dimensions.length !== 3
      || dimensions.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('A volumetric grid needs three positive integer dimensions.');
  }
  const count = dimensions.reduce((product, value) => product * value, 1);
  if (!Number.isSafeInteger(count) || count > VOLUMETRIC_LIMITS.samplesPerDataset) {
    throw new Error('The volumetric grid exceeds the sample budget.');
  }
  if (!ArrayBuffer.isView(dataset.values) || dataset.values instanceof DataView
      || ![Float32Array, Float64Array].some(Type => dataset.values instanceof Type)
      || dataset.values.length !== count) throw new Error('The volumetric sample count does not match its dimensions.');
  if (dataset.origin?.length !== 3 || dataset.steps?.length !== 9
      || [...dataset.origin, ...dataset.steps].some(value => !Number.isFinite(value))
      || !Number.isFinite(determinant3(dataset.steps)) || determinant3(dataset.steps) === 0) {
    throw new Error('A volumetric grid needs a finite nonsingular step matrix and origin.');
  }
  if (!Array.isArray(dataset.periodic) || dataset.periodic.length !== 3
      || dataset.periodic.some(value => typeof value !== 'boolean')) throw new Error('The grid needs three explicit periodic flags.');
  if (scanValues && !dataset.values.every(Number.isFinite)) throw new Error('Volumetric values must be finite.');
  return dataset;
}

export function volumetricCellDimensions(dataset) {
  return dataset.dimensions.map((count, axis) => dataset.periodic[axis] ? count : Math.max(0, count - 1));
}

export function volumetricSampleIndex(dataset, x, y, z) {
  const [nx, ny] = dataset.dimensions;
  return x + nx * (y + ny * z);
}

export function volumetricGridPosition(dataset, x, y, z, output = new Float64Array(3)) {
  const { origin: o, steps: h } = dataset;
  output[0] = o[0] + x * h[0] + y * h[3] + z * h[6];
  output[1] = o[1] + x * h[1] + y * h[4] + z * h[7];
  output[2] = o[2] + x * h[2] + y * h[5] + z * h[8];
  return output;
}

/** Read-only, bounded descriptor useful for Worker caches and configuration
 * identities. It intentionally does not scan or copy the sample array. */
export function volumetricDatasetMetadata(dataset) {
  validateVolumetricDataset(dataset);
  return { id: dataset.id, name: dataset.name, kind: dataset.kind, unit: dataset.unit,
    dimensions: [...dataset.dimensions], origin: [...dataset.origin], steps: [...dataset.steps],
    periodic: [...dataset.periodic], statistics: dataset.statistics && { ...dataset.statistics } };
}
