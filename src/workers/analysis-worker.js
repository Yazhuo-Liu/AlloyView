import { calculateCoordination } from '../analysis/coordination.js';
import { calculateCna } from '../analysis/cna.js';
import { calculateCentrosymmetry } from '../analysis/centrosymmetry.js';
import { calculatePtm } from '../analysis/ptm.js';
import { calculateAtomicStrain } from '../analysis/atomic-strain.js';

self.addEventListener('message', async ({ data }) => {
  const { id, fractional, cell, kind, types, ...parameters } = data;
  try {
    const frame = { fractional, cell, types };
    let result;
    if (kind === 'coordination') result = calculateCoordination(frame, parameters.cutoff, parameters);
    else if (kind === 'cna') result = calculateCna(frame, parameters);
    else if (kind === 'centrosymmetry') result = calculateCentrosymmetry(frame, parameters);
    else if (kind === 'ptm') result = await calculatePtm(frame, parameters);
    else if (kind === 'strain') result = await calculateAtomicStrain(frame, parameters);
    else throw new Error(`Unknown analysis kind: ${kind}`);
    const buffers = [...new Set(Object.values(result).filter(ArrayBuffer.isView).map((value) => value.buffer))];
    self.postMessage({ id, ok: true, result }, buffers);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
