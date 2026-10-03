import { calculateCoordination } from '../analysis/coordination.js';
import { calculateCna } from '../analysis/cna.js';
import { calculateCentrosymmetry } from '../analysis/centrosymmetry.js';
import { calculatePtm } from '../analysis/ptm.js';
import { calculateAtomicStrain } from '../analysis/atomic-strain.js';

self.addEventListener('message', async ({ data }) => {
  const { id, fractional, cell, kind, types, ...parameters } = data;
  try {
    const frame = { fractional, cell, types };
    const onPhase = (phase) => self.postMessage({ id, phase });
    const onAtoms = (processedAtoms, totalAtoms) => self.postMessage({ id, phase: 'analyzing', processedAtoms, totalAtoms });
    let result;
    if (kind === 'ptm') result = await calculatePtm(frame, { ...parameters, onPhase, onAtoms });
    else if (kind === 'strain') {
      if (parameters.ptmInput) onPhase('analyzing');
      result = await calculateAtomicStrain(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'coordination') {
      onPhase('analyzing');
      result = calculateCoordination(frame, parameters.cutoff, parameters);
    } else if (kind === 'cna') {
      onPhase('analyzing');
      result = calculateCna(frame, parameters);
    } else if (kind === 'centrosymmetry') {
      onPhase('analyzing');
      result = calculateCentrosymmetry(frame, parameters);
    } else throw new Error(`Unknown analysis kind: ${kind}`);
    const buffers = [...new Set(Object.values(result).filter(ArrayBuffer.isView).map((value) => value.buffer))];
    self.postMessage({ id, ok: true, result }, buffers);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
