import { accumulateSpatialBins } from '../analysis/spatial-binning.js';

// Reduced coordinates of the most recent frame stay here, so changing the
// quantity, bins or selection sends only the per-atom values and mask.
// Cancellation terminates this Worker; it never polls for messages.
let resident = null;

self.addEventListener('message', ({ data }) => {
  const { id, type, frameKey, fractional, cell, request } = data;
  try {
    if (type !== 'bin') throw new Error(`Unknown binning request: ${type}`);
    if (resident?.key !== frameKey) {
      if (!fractional || !cell) throw new Error('The binning frame is unavailable in its Worker.');
      resident = { key: frameKey, frame: { fractional, cell } };
    }
    const result = accumulateSpatialBins(resident.frame, request);
    const transfer = ['counts', 'valid', 'skipped', 'sum', 'min', 'max', 'm2', 'densitySum']
      .filter(name => result[name]).map(name => result[name].buffer);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
