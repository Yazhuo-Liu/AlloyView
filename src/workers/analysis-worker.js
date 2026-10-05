import { calculateCoordination } from '../analysis/coordination.js';
import { calculateCna } from '../analysis/cna.js';
import { calculateCentrosymmetry } from '../analysis/centrosymmetry.js';
import { calculatePtm, warmupPtm } from '../analysis/ptm.js';
import { calculateAtomicStrain } from '../analysis/atomic-strain.js';
import { calculateBonds } from '../analysis/bonds.js';
import { calculateRdf } from '../analysis/rdf.js';
import { calculateLocalShearCoordination, calculateLocalShearMetrics, finalizeLocalShear } from '../analysis/local-shear.js';
import { calculateReferenceStrain } from '../analysis/reference-strain.js';
import { calculatePreparedDisplacements } from '../analysis/displacement.js';

self.addEventListener('message', async ({ data }) => {
  const { id, fractional, cell, kind, types, ...parameters } = data;
  try {
    const frame = { fractional, cell, types };
    const onPhase = (phase) => self.postMessage({ id, phase });
    let lastProgressAt = -Infinity;
    const onAtoms = (processedAtoms, totalAtoms) => {
      const now = performance.now();
      // Neighbor loops can finish a 256-atom block in less than a millisecond.
      // Keep the first and final updates, without flooding the main thread.
      if (processedAtoms !== totalAtoms && now - lastProgressAt < 80) return;
      lastProgressAt = now;
      self.postMessage({ id, phase: 'analyzing', processedAtoms, totalAtoms });
    };
    let result;
    if (kind === 'warmup') result = await warmupPtm({ onPhase });
    else if (kind === 'ptm') result = await calculatePtm(frame, { ...parameters, onPhase, onAtoms });
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
      result = calculateCentrosymmetry(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'bonds') {
      result = calculateBonds(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'rdf') {
      result = calculateRdf(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'referenceStrain') {
      result = calculateReferenceStrain(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'displacement') {
      onPhase('analyzing');
      const calculated = calculatePreparedDisplacements(frame, parameters,
        { onProgress: update => onAtoms(update.completed, update.total) });
      // The pool already owns this immutable mapping. Returning a shared
      // worker copy would duplicate it or transfer a SharedArrayBuffer.
      const { referenceMapping: _mapping, ...partial } = calculated;
      result = partial;
    } else if (kind === 'localShearCoordination') {
      result = calculateLocalShearCoordination(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'localShearMetrics') {
      result = calculateLocalShearMetrics(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'localShearFinalize') {
      onPhase('analyzing');
      const offset = (parameters.startAtom - (parameters.metricStartAtom ?? 0)) * 6;
      const metrics = parameters.metricInput.subarray(offset, offset + (parameters.endAtom - parameters.startAtom) * 6);
      result = finalizeLocalShear(metrics, { ...parameters, onAtoms });
    } else throw new Error(`Unknown analysis kind: ${kind}`);
    const buffers = [...new Set(Object.values(result).filter(ArrayBuffer.isView).map((value) => value.buffer))];
    self.postMessage({ id, ok: true, result }, buffers);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
