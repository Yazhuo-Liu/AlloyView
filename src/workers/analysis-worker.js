import { calculateCoordination, createCoordinationIndex } from '../analysis/coordination.js';
import { calculateCna } from '../analysis/cna.js';
import { calculateCentrosymmetry, prepareCentrosymmetryContext, calculatePreparedCentrosymmetry } from '../analysis/centrosymmetry.js';
import { calculatePtm, warmupPtm, ptmKernelMemoryBytes, releasePtmFrame } from '../analysis/ptm.js';
import { calculateAtomicStrain } from '../analysis/atomic-strain.js';
import { calculateBonds } from '../analysis/bonds.js';
import { calculateBondStatistics, prepareBondStatisticsContext, calculatePreparedBondStatistics } from '../analysis/bond-statistics.js';
import { calculateVoronoi, calculateVoronoiGeometry, calculateVoronoiGeometryBatch, mergeVoronoiPartials,
  warmupVoronoi, prepareVoronoiFrame, voronoiKernelMemoryBytes } from '../analysis/voronoi.js';
import { calculateRdf, prepareRdfContext, calculatePreparedRdf } from '../analysis/rdf.js';
import { calculateLocalShearCoordination, calculateLocalShearMetrics, finalizeLocalShear } from '../analysis/local-shear.js';
import { calculateReferenceStrain, prepareReferenceStrainContext } from '../analysis/reference-strain.js';
import { calculatePreparedDisplacements, prepareDisplacementCalculation } from '../analysis/displacement.js';
import { calculateClusterEdges, finalizeClusters } from '../analysis/clusters.js';
import { assignWignerSeitzSites, prepareWignerSeitzContext } from '../analysis/wigner-seitz.js';
import { calculateDxaLocalRange, calculateDxaTetrahedraRange, releaseDxaCpuStageData, warmupDxaCpuStages, dxaCpuKernelMemoryBytes } from '../analysis/dxa-cpu-stages.js';

import { NeighborSearch } from '../analysis/neighbors.js';
import { createAtomProgressThrottle } from '../analysis/progress.js';

const atomProgressDue = createAtomProgressThrottle();
import { fatalAnalysisError } from '../analysis/errors.js';

const CPU_INPUT_FIELDS = ['structureInput', 'referenceFractional', 'referenceMapping', 'metricInput',
  'currentPositions', 'referencePositions', 'ptmInput', 'preparedNeighbors', 'referenceCell', 'referenceNeighborIndex', 'clusterSelection', 'rdfNormalization'];
let cpuResident, cpuAnalysis;
const cpuResidents = new Map(), cpuAnalyses = new Map();

// One immutable source snapshot and linked-cell index per resident Worker.
// Chunk messages reuse these arrays; results never transfer source buffers.
// Radical radii are retained the same way under their own pool key.
let voronoiResident, voronoiRadii;

function inputBuffers(value) {
  const buffers = new Set(), visited = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (ArrayBuffer.isView(value)) { buffers.add(value.buffer); return; }
    if (value instanceof Map) { for (const child of value.values()) visit(child); }
    else for (const child of Object.values(value)) visit(child);
  };
  visit(value);
  return [...buffers];
}

function residentInputMemory() {
  const buffers = inputBuffers([cpuResidents, cpuAnalyses, voronoiResident, voronoiRadii]);
  const sharedBytes = value => inputBuffers(value).filter(buffer => !(buffer instanceof ArrayBuffer)).reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const privateBytes = value => inputBuffers(value).filter(buffer => buffer instanceof ArrayBuffer).reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const cpuGroups = [...[...cpuResidents].map(([key, value]) => [`frame:${key}`, sharedBytes(value)]),
    ...[...cpuAnalyses].map(([key, value]) => [`analysis:${key}`, sharedBytes(value)])];
  const otherGroups = [...(voronoiResident ? [[`frame:${voronoiResident.cpuFrameKey ?? `voronoi-${voronoiResident.key}`}`, sharedBytes(voronoiResident)]] : []),
    ...(voronoiRadii ? [[`radii:${voronoiRadii.key}`, sharedBytes(voronoiRadii)]] : [])];
  const totalBytes = value => inputBuffers(value).reduce((sum, buffer) => sum + buffer.byteLength, 0);
  return { residentInputBytes: buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0),
    residentSharedInputBytes: sharedBytes([cpuResidents, cpuAnalyses, voronoiResident, voronoiRadii]),
    cpuFramePrivateBytes: [...cpuResidents].map(([key, value]) => [key, privateBytes(value)]),
    residentSharedGroups: [...cpuGroups, ...otherGroups],
    cpuResidentInputBytes: totalBytes([cpuResidents, cpuAnalyses]), cpuResidentSharedInputBytes: sharedBytes([cpuResidents, cpuAnalyses]),
    otherResidentInputBytes: totalBytes([voronoiResident, voronoiRadii]), otherResidentSharedInputBytes: sharedBytes([voronoiResident, voronoiRadii]),
    cpuResidentSharedGroups: cpuGroups, otherResidentSharedGroups: otherGroups };
}

self.addEventListener('message', async ({ data }) => {
  if (data.kind === 'cpuRelease') { for (const retained of cpuResidents.values()) releasePtmFrame(retained.frame); cpuResident = null; cpuAnalysis = null; cpuResidents.clear(); cpuAnalyses.clear(); return; }
  if (data.kind === 'voronoiRelease') { voronoiResident = null; voronoiRadii = null; return; }
  if (data.kind === 'dxaRelease') { await releaseDxaCpuStageData(data.dxaResidentKey); return; }
  const { id, fractional, cell, kind, types, residentFrameKey, cpuFrameKey, cpuAnalysisKey, cpuNeighborIndex,
    cpuCoordinationIndex, ...parameters } = data;
  try {
    let frame = { fractional, cell, types }, frameUploaded = false, cpuIndexBuilt = false, cpuIndexReused = false, inputPreparations = 0;
    if (cpuFrameKey !== undefined) {
      cpuResident = cpuResidents.get(cpuFrameKey);
      cpuIndexReused = Boolean(cpuResident);
      if (!cpuIndexReused) {
        if (!fractional || !cell) throw new Error('The resident CPU source is unavailable.');
        frame.immutableAnalysisFrame = true;
        cpuResident = { key: cpuFrameKey, frame, search: null, coordinationIndex: null,
          ownsCoordinates: fractional instanceof Float64Array && fractional.buffer instanceof ArrayBuffer };
        frameUploaded = true;
      }
      cpuResidents.delete(cpuFrameKey); cpuResidents.set(cpuFrameKey, cpuResident);
      const residentLimit = parameters.cpuResidentFrameLimit === 1 ? 1 : 2;
      while (cpuResidents.size > residentLimit) {
        const evictedKey = cpuResidents.keys().next().value; releasePtmFrame(cpuResidents.get(evictedKey).frame); cpuResidents.delete(evictedKey);
        for (const [key, analysis] of cpuAnalyses) if (analysis.frameKey === evictedKey) cpuAnalyses.delete(key);
      }
      frame = cpuResident.frame;
      if (cpuNeighborIndex && !cpuResident.search) cpuResident.search = NeighborSearch.fromIndex(cpuNeighborIndex);
      if (cpuCoordinationIndex && cpuResident.coordinationIndex?.cutoff !== cpuCoordinationIndex.cutoff) cpuResident.coordinationIndex = cpuCoordinationIndex;
      if (cpuAnalysisKey !== undefined) {
        cpuAnalysis = cpuAnalyses.get(cpuAnalysisKey);
        if (!cpuAnalysis || cpuAnalysis.frameKey !== cpuFrameKey) {
          cpuAnalysis = { key: cpuAnalysisKey, frameKey: cpuFrameKey, inputs: Object.fromEntries(CPU_INPUT_FIELDS
            .filter(name => parameters[name] !== undefined).map(name => [name, parameters[name]])), referenceContext: null };
        }
        cpuAnalyses.delete(cpuAnalysisKey); cpuAnalyses.set(cpuAnalysisKey, cpuAnalysis);
        while (cpuAnalyses.size > residentLimit) cpuAnalyses.delete(cpuAnalyses.keys().next().value);
        for (const name of CPU_INPUT_FIELDS) if (parameters[name] !== undefined && parameters[name] !== cpuAnalysis.inputs[name]) {
          cpuAnalysis.inputs[name] = parameters[name];
          cpuAnalysis.preparedCalculations = null; cpuAnalysis.referenceContext = null; cpuAnalysis.wignerSeitzContext = null;
        }
        Object.assign(parameters, cpuAnalysis.inputs);
      }
      if (kind === 'coordination' || (kind === 'cpuPrepare' && parameters.cutoff !== undefined)) {
        if (cpuResident.coordinationIndex?.cutoff !== parameters.cutoff) {
          cpuResident.coordinationIndex = createCoordinationIndex(frame, parameters.cutoff, { sharedMemory: parameters.sharedIndex });
          cpuIndexBuilt = true;
        }
        parameters.coordinationIndex = cpuResident.coordinationIndex;
      } else if (!parameters.preparedNeighbors && !['warmup', 'displacement', 'localShearFinalize', 'clustersFinalize', 'wignerSeitzAssign'].includes(kind)
          && !(kind === 'strain' && parameters.ptmInput) && kind !== 'referenceStrain') {
        if (!cpuResident.search) { cpuResident.search = new NeighborSearch(frame, { sharedMemory: parameters.sharedIndex,
          reuseCoordinates: cpuResident.ownsCoordinates && !parameters.sharedIndex }); cpuIndexBuilt = true; }
      }
      frame.neighborSearch = cpuResident.search;
      if (cpuAnalysisKey !== undefined && ['bondStatistics', 'centrosymmetry', 'rdf', 'displacement'].includes(kind)) {
        // Only immutable resident snapshots enter this route. Each complete
        // input set is scanned once, not once for every central-atom chunk.
        const signature = JSON.stringify([kind, parameters.cutoff, parameters.pairCutoffs, parameters.lengthBins,
          parameters.angleBins, parameters.mode, parameters.neighbors, parameters.bins, parameters.firstType,
          parameters.secondType, parameters.minimumImage, parameters.mappingMode, parameters.sourceRepetitions]);
        cpuAnalysis.preparedCalculations ??= new Map();
        let context = cpuAnalysis.preparedCalculations.get(signature);
        if (!context) {
          context = kind === 'bondStatistics' ? prepareBondStatisticsContext(frame, parameters)
            : kind === 'centrosymmetry' ? prepareCentrosymmetryContext(frame, parameters)
              : kind === 'rdf' ? prepareRdfContext(frame, parameters, parameters.rdfNormalization)
                : prepareDisplacementCalculation(frame, parameters);
          cpuAnalysis.preparedCalculations.set(signature, context); inputPreparations = 1;
        }
        parameters.preparedContext = context;
      }
      if (kind === 'centrosymmetry' && parameters.mode === 'auto' && !parameters.structureInput) {
        frame.adaptiveCnaClassifications ??= new Uint8Array(frame.fractional.length / 3).fill(255);
      }
      if (kind === 'referenceStrain' && !cpuAnalysis.referenceContext) {
        const referenceSearch = parameters.referenceNeighborIndex ? NeighborSearch.fromIndex(parameters.referenceNeighborIndex) : undefined;
        cpuAnalysis.referenceContext = prepareReferenceStrainContext(frame, { ...parameters, referenceSearch });
      }
      if (kind === 'referenceStrain') parameters.preparedContext = cpuAnalysis.referenceContext;
      // The reference site index is built once per Worker and calculation.
      if (kind === 'wignerSeitzAssign') {
        if (!cpuAnalysis.wignerSeitzContext) { self.postMessage({ id, phase: 'indexing' }); cpuAnalysis.wignerSeitzContext = prepareWignerSeitzContext(frame, parameters); }
        parameters.preparedContext = cpuAnalysis.wignerSeitzContext;
      }
    }
    if (['voronoi', 'voronoiGeometry', 'voronoiGeometryBatch', 'voronoiPrepare'].includes(kind) && residentFrameKey !== undefined) {
      if (fractional || (cpuFrameKey !== undefined && voronoiResident?.key !== residentFrameKey)) {
        voronoiResident = { key: residentFrameKey, frame, context: null, cpuFrameKey };
        frameUploaded = true;
      } else if (voronoiResident?.key !== residentFrameKey) throw new Error('The resident Voronoi source is unavailable.');
      const retained = voronoiResident;
      frame = retained.frame;
      parameters.context = retained.context;
      parameters.onContext = context => { retained.context = context; };
      if (parameters.radiiKey !== undefined) {
        if (parameters.radii) voronoiRadii = { key: parameters.radiiKey, radii: parameters.radii };
        else if (voronoiRadii?.key !== parameters.radiiKey) throw new Error('The resident Voronoi radii are unavailable.');
        parameters.radii = voronoiRadii.radii;
        delete parameters.radiiKey;
      }
    }
    const onPhase = (phase) => self.postMessage({ id, phase });
    const onAtoms = (processedAtoms, totalAtoms) => {
      // Neighbor loops can finish a 256-atom block in less than a millisecond.
      // Ranges share a clock, so each short chunk does not reset the throttle.
      const final = processedAtoms === totalAtoms && (cpuAnalysisKey === undefined
        || (parameters.endAtom ?? frame.fractional.length / 3) === frame.fractional.length / 3);
      if (!atomProgressDue(cpuAnalysisKey === undefined ? `task:${id}` : `analysis:${cpuAnalysisKey}`, { final })) return;
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
      result = cpuFrameKey !== undefined && parameters.preparedContext
        ? calculatePreparedCentrosymmetry(parameters.preparedContext, { ...parameters, onPhase, onAtoms })
        : calculateCentrosymmetry(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'bonds') {
      result = calculateBonds(frame, { ...parameters, onPhase, onAtoms });
    } else if (kind === 'bondStatistics') {
      result = cpuFrameKey !== undefined && parameters.preparedContext
        ? calculatePreparedBondStatistics(parameters.preparedContext, { ...parameters, onPhase, onAtoms })
        : calculateBondStatistics(frame, { ...parameters, onPhase, onAtoms });
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
      result = cpuFrameKey !== undefined && parameters.preparedContext
        ? calculatePreparedRdf(parameters.preparedContext, { ...parameters, onPhase, onAtoms })
        : calculateRdf(frame, { ...parameters, onPhase, onAtoms });
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
    } else if (kind === 'wignerSeitzAssign') {
      onPhase('analyzing');
      result = assignWignerSeitzSites(frame, { ...parameters, onAtoms });
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
    result = { ...result, ...(cpuFrameKey !== undefined ? { frameUploaded, indexBuilt: cpuIndexBuilt, indexReused: cpuIndexReused, inputPreparations } : {}), nativeHeapBytes: { ptm: ptmKernelMemoryBytes(), voronoi: voronoiKernelMemoryBytes(),
      dxa: dxaCpuKernelMemoryBytes() }, ...residentInputMemory() };
    const fields = [...Object.values(result), ...(kind === 'voronoiGeometryBatch' ? result.cells.flatMap(cell => Object.values(cell)) : [])];
    const buffers = [...new Set(fields.filter(ArrayBuffer.isView).map((value) => value.buffer).filter(buffer => buffer instanceof ArrayBuffer))];
    self.postMessage({ id, ok: true, result }, buffers);
  } catch (error) {
    const fatal = fatalAnalysisError(error);
    // A controlled rejection is an ACK just like a successful chunk. Tell
    // the pool which caches actually survived: a rejected new frame may have
    // evicted an old one before a scientific precondition failed.
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error),
      name: error?.name, fatal, errorKind: error?.analysisErrorKind ?? 'scientific',
      ...(!fatal ? { residentState: {
        cpuFrameKeys: [...cpuResidents.keys()], cpuAnalysisFrames: [...cpuAnalyses].map(([key, value]) => [key, value.frameKey]),
        voronoiFrameKey: voronoiResident?.key, voronoiRadiiKey: voronoiRadii?.key,
      }, result: { nativeHeapBytes: { ptm: ptmKernelMemoryBytes(), voronoi: voronoiKernelMemoryBytes(),
        dxa: dxaCpuKernelMemoryBytes() }, ...residentInputMemory() } } : {}) });
  }
});
