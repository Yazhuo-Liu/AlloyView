import { calculateCoordination } from '../analysis/coordination.js';
import { calculateCna } from '../analysis/cna.js';
import { calculateCentrosymmetry } from '../analysis/centrosymmetry.js';
import { calculatePtm, warmupPtm } from '../analysis/ptm.js';
import { calculateAtomicStrain } from '../analysis/atomic-strain.js';
import { calculateBonds } from '../analysis/bonds.js';
import { calculateBondStatistics } from '../analysis/bond-statistics.js';
import { calculateVoronoi, calculateVoronoiGeometry, calculateVoronoiGeometryBatch, mergeVoronoiPartials,
  warmupVoronoi, prepareVoronoiFrame } from '../analysis/voronoi.js';
import { calculateRdf } from '../analysis/rdf.js';
import { calculateLocalShearCoordination, calculateLocalShearMetrics, finalizeLocalShear } from '../analysis/local-shear.js';
import { calculateReferenceStrain } from '../analysis/reference-strain.js';
import { calculatePreparedDisplacements } from '../analysis/displacement.js';

// One immutable source snapshot and linked-cell index per resident Worker.
// Chunk messages reuse these arrays; results never transfer source buffers.
let voronoiResident;

self.addEventListener('message', async ({ data }) => {
  if (data.kind === 'voronoiRelease') { voronoiResident = null; return; }
  const { id, fractional, cell, kind, types, residentFrameKey, ...parameters } = data;
  try {
    let frame = { fractional, cell, types }, frameUploaded = false;
    if (['voronoi', 'voronoiGeometry', 'voronoiGeometryBatch', 'voronoiPrepare'].includes(kind) && residentFrameKey !== undefined) {
      if (fractional) {
        voronoiResident = { key: residentFrameKey, frame, context: null };
        frameUploaded = true;
      } else if (voronoiResident?.key !== residentFrameKey) throw new Error('The resident Voronoi source is unavailable.');
      const retained = voronoiResident;
      frame = retained.frame;
      parameters.context = retained.context;
      parameters.onContext = context => { retained.context = context; };
    }
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
    if (kind === 'warmup') {
      const modules = parameters.modules ?? ['ptm'], initializedModules = {};
      // Voronoi is ready before the larger PTM fitter starts initializing.
      for (const module of ['voronoi', 'ptm']) if (modules.includes(module)) {
        initializedModules[module] = await (module === 'voronoi' ? warmupVoronoi : warmupPtm)({ onPhase });
      }
      result = { warmed: true, modules, initializedModules,
        kernelReused: Object.values(initializedModules).every(module => module.kernelReused) };
    }
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
    } else if (kind === 'bondStatistics') {
      result = calculateBondStatistics(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'voronoiPrepare') {
      result = await prepareVoronoiFrame(frame, { ...parameters, onPhase });
      result.frameUploaded = frameUploaded;
    } else if (kind === 'voronoi') {
      result = await calculateVoronoi(frame, { ...parameters, onPhase, onAtoms });
      result.frameUploaded = frameUploaded;
    } else if (kind === 'voronoiGeometry') {
      result = await calculateVoronoiGeometry(frame, { ...parameters, onPhase, onAtoms });
      result.frameUploaded = frameUploaded;
    } else if (kind === 'voronoiGeometryBatch') {
      result = await calculateVoronoiGeometryBatch(frame, { ...parameters, onPhase, onAtoms });
      result.frameUploaded = frameUploaded;
    } else if (kind === 'voronoiFinalize') {
      onPhase('finalizing');
      result = mergeVoronoiPartials(parameters.partials, parameters.atomCount, { bins: parameters.bins, consumePartials: true });
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
    const fields = [...Object.values(result), ...(kind === 'voronoiGeometryBatch' ? result.cells.flatMap(cell => Object.values(cell)) : [])];
    const buffers = [...new Set(fields.filter(ArrayBuffer.isView).map((value) => value.buffer))];
    self.postMessage({ id, ok: true, result }, buffers);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
