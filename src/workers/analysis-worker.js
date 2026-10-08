import { calculateCoordination, createCoordinationIndex } from '../analysis/coordination.js';
import { calculateCna } from '../analysis/cna.js';
import { calculateCentrosymmetry } from '../analysis/centrosymmetry.js';
import { calculatePtm, warmupPtm, ptmKernelMemoryBytes, releasePtmFrame } from '../analysis/ptm.js';
import { calculateAtomicStrain } from '../analysis/atomic-strain.js';
import { calculateBonds } from '../analysis/bonds.js';
import { calculateBondStatistics } from '../analysis/bond-statistics.js';
import { calculateVoronoi, calculateVoronoiGeometry, calculateVoronoiGeometryBatch, mergeVoronoiPartials,
  warmupVoronoi, prepareVoronoiFrame, voronoiKernelMemoryBytes } from '../analysis/voronoi.js';
import { calculateRdf } from '../analysis/rdf.js';
import { calculateLocalShearCoordination, calculateLocalShearMetrics, finalizeLocalShear } from '../analysis/local-shear.js';
import { calculateReferenceStrain, prepareReferenceStrainContext } from '../analysis/reference-strain.js';
import { calculatePreparedDisplacements } from '../analysis/displacement.js';
import { calculateClusterEdges, finalizeClusters } from '../analysis/clusters.js';
import { calculateDxaLocalRange, calculateDxaTetrahedraRange, releaseDxaCpuStageData, warmupDxaCpuStages, dxaCpuKernelMemoryBytes } from '../analysis/dxa-cpu-stages.js';

import { NeighborSearch } from '../analysis/neighbors.js';

const CPU_INPUT_FIELDS = ['structureInput', 'referenceFractional', 'referenceMapping', 'metricInput',
  'currentPositions', 'referencePositions', 'ptmInput', 'preparedNeighbors', 'referenceCell', 'referenceNeighborIndex', 'clusterSelection'];
let cpuResident, cpuAnalysis;
const cpuResidents = new Map(), cpuAnalyses = new Map();

// One immutable source snapshot and linked-cell index per resident Worker.
// Chunk messages reuse these arrays; results never transfer source buffers.
let voronoiResident;

function residentInputBytes() {
  const buffers = new Set(), visited = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (ArrayBuffer.isView(value)) { buffers.add(value.buffer); return; }
    if (value instanceof Map) { for (const child of value.values()) visit(child); }
    else for (const child of Object.values(value)) visit(child);
  };
  visit(cpuResidents); visit(cpuAnalyses); visit(voronoiResident);
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

self.addEventListener('message', async ({ data }) => {
  if (data.kind === 'cpuRelease') { for (const retained of cpuResidents.values()) releasePtmFrame(retained.frame); cpuResident = null; cpuAnalysis = null; cpuResidents.clear(); cpuAnalyses.clear(); return; }
  if (data.kind === 'voronoiRelease') { voronoiResident = null; return; }
  if (data.kind === 'dxaRelease') { await releaseDxaCpuStageData(data.dxaResidentKey); return; }
  const { id, fractional, cell, kind, types, residentFrameKey, cpuFrameKey, cpuAnalysisKey, cpuNeighborIndex,
    cpuCoordinationIndex, ...parameters } = data;
  try {
    let frame = { fractional, cell, types }, frameUploaded = false, cpuIndexBuilt = false, cpuIndexReused = false;
    if (cpuFrameKey !== undefined) {
      cpuResident = cpuResidents.get(cpuFrameKey);
      cpuIndexReused = Boolean(cpuResident);
      if (!cpuIndexReused) {
        if (!fractional || !cell) throw new Error('The resident CPU source is unavailable.');
        frame.immutableAnalysisFrame = true;
        cpuResident = { key: cpuFrameKey, frame, search: null, coordinationIndex: null };
        frameUploaded = true;
      }
      cpuResidents.delete(cpuFrameKey); cpuResidents.set(cpuFrameKey, cpuResident);
      if (cpuResidents.size > 2) {
        const evictedKey = cpuResidents.keys().next().value; releasePtmFrame(cpuResidents.get(evictedKey).frame); cpuResidents.delete(evictedKey);
        for (const [key, analysis] of cpuAnalyses) if (analysis.frameKey === evictedKey) cpuAnalyses.delete(key);
      }
      frame = cpuResident.frame;
      if (cpuNeighborIndex && !cpuResident.search) cpuResident.search = NeighborSearch.fromIndex(cpuNeighborIndex);
      if (cpuCoordinationIndex && cpuResident.coordinationIndex?.cutoff !== cpuCoordinationIndex.cutoff) cpuResident.coordinationIndex = cpuCoordinationIndex;
      if (cpuAnalysisKey !== undefined) {
        cpuAnalysis = cpuAnalyses.get(cpuAnalysisKey);
        if (!cpuAnalysis) {
          cpuAnalysis = { key: cpuAnalysisKey, frameKey: cpuFrameKey, inputs: Object.fromEntries(CPU_INPUT_FIELDS
            .filter(name => parameters[name] !== undefined).map(name => [name, parameters[name]])), referenceContext: null };
        }
        cpuAnalyses.delete(cpuAnalysisKey); cpuAnalyses.set(cpuAnalysisKey, cpuAnalysis);
        if (cpuAnalyses.size > 2) cpuAnalyses.delete(cpuAnalyses.keys().next().value);
        if (parameters.preparedNeighbors) cpuAnalysis.inputs.preparedNeighbors = parameters.preparedNeighbors;
        Object.assign(parameters, cpuAnalysis.inputs);
      }
      if (kind === 'coordination' || (kind === 'cpuPrepare' && parameters.cutoff !== undefined)) {
        if (cpuResident.coordinationIndex?.cutoff !== parameters.cutoff) {
          cpuResident.coordinationIndex = createCoordinationIndex(frame, parameters.cutoff, { sharedMemory: parameters.sharedIndex });
          cpuIndexBuilt = true;
        }
        parameters.coordinationIndex = cpuResident.coordinationIndex;
      } else if (!parameters.preparedNeighbors && !['warmup', 'displacement', 'localShearFinalize', 'clustersFinalize'].includes(kind)
          && !(kind === 'strain' && parameters.ptmInput) && kind !== 'referenceStrain') {
        if (!cpuResident.search) { cpuResident.search = new NeighborSearch(frame, { sharedMemory: parameters.sharedIndex }); cpuIndexBuilt = true; }
      }
      frame.neighborSearch = cpuResident.search;
      if (kind === 'centrosymmetry' && parameters.mode === 'auto' && !parameters.structureInput) {
        frame.adaptiveCnaClassifications ??= new Uint8Array(frame.fractional.length / 3).fill(255);
      }
      if (kind === 'referenceStrain' && !cpuAnalysis.referenceContext) {
        const referenceSearch = parameters.referenceNeighborIndex ? NeighborSearch.fromIndex(parameters.referenceNeighborIndex) : undefined;
        cpuAnalysis.referenceContext = prepareReferenceStrainContext(frame, { ...parameters, referenceSearch });
      }
      if (kind === 'referenceStrain') parameters.preparedContext = cpuAnalysis.referenceContext;
    }
    if (['voronoi', 'voronoiGeometry', 'voronoiGeometryBatch', 'voronoiPrepare'].includes(kind) && residentFrameKey !== undefined) {
      if (fractional || (cpuFrameKey !== undefined && voronoiResident?.key !== residentFrameKey)) {
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
    if (kind === 'cpuPrepare') {
      result = { neighborIndex: cpuResident.search?.exportIndex(), coordinationIndex: cpuResident.coordinationIndex,
        indexBuilt: cpuIndexBuilt };
    }
    else if (kind === 'warmup') {
      const modules = parameters.modules ?? ['ptm'], initializedModules = {};
      // Voronoi is ready before the larger PTM fitter starts initializing.
      for (const module of ['voronoi', 'ptm', 'dxa']) if (modules.includes(module)) {
        initializedModules[module] = await (module === 'voronoi' ? warmupVoronoi : module === 'dxa' ? warmupDxaCpuStages : warmupPtm)({ onPhase });
      }
      result = { warmed: true, modules, initializedModules,
        kernelReused: Object.values(initializedModules).every(module => module.kernelReused) };
    }
    else if (kind === 'dxaLocal' || kind === 'dxaTetrahedra') {
      result = await (kind === 'dxaLocal' ? calculateDxaLocalRange : calculateDxaTetrahedraRange)(parameters.dxaStageInput,
        { residentKey: parameters.dxaResidentKey, startAtom: parameters.startAtom, endAtom: parameters.endAtom, onPhase });
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
    } else if (kind === 'clusterEdges') {
      result = calculateClusterEdges(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'clustersFinalize') {
      result = finalizeClusters(frame, { ...parameters, onPhase });
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
    result = { ...result, ...(cpuFrameKey !== undefined ? { frameUploaded, indexBuilt: cpuIndexBuilt, indexReused: cpuIndexReused } : {}), nativeHeapBytes: { ptm: ptmKernelMemoryBytes(), voronoi: voronoiKernelMemoryBytes(),
      dxa: dxaCpuKernelMemoryBytes() }, residentInputBytes: residentInputBytes() };
    const fields = [...Object.values(result), ...(kind === 'voronoiGeometryBatch' ? result.cells.flatMap(cell => Object.values(cell)) : [])];
    const buffers = [...new Set(fields.filter(ArrayBuffer.isView).map((value) => value.buffer).filter(buffer => buffer instanceof ArrayBuffer))];
    self.postMessage({ id, ok: true, result }, buffers);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
