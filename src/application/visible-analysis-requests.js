import { STRAIN_FIELDS } from '../analysis/atomic-strain.js';
import { validateReferences } from '../analysis/lattice.js';

const PTM_PROPERTIES = new Set(['ptmStructureType', 'ptmRmsd', 'ptmDistance', 'ptmOrderingType',
  'ptmOrientationW', 'ptmOrientationX', 'ptmOrientationY', 'ptmOrientationZ'].map(name => name.toLowerCase()));
const STRAIN_PROPERTIES = new Set([...STRAIN_FIELDS, 'idealStrainStructureType'].map(name => name.toLowerCase()));
const AUTO_CSP_PROPERTIES = new Set(['centralsymmetrystructuretype', 'centralsymmetryneighbors']);
const adaptiveCnaKey = JSON.stringify({ mode: 'adaptive' });

/** A snapshot of just the normal analyses needed by the requested appearance.
 * Dependency order and parameters match app.runStructureAnalysis(): Auto CSP
 * may borrow an enabled adaptive CNA; strain may borrow an enabled PTM fit.
 * Nothing estimates a missing lattice, enables a tool, or publishes a value.
 */
export function createVisibleAnalysisRequests({ frame, quantity = 'type', visibilitySource, hidden = false,
  analyses = {}, references = [], neighborLists = false, requiredProperties = [], gpuRequested, canReuseResult } = {}) {
  if (!frame) return [];
  const saved = Object.fromEntries(Object.entries(analyses).map(([kind, analysis]) => [kind, {
    enabled: Boolean(analysis?.enabled), cutoff: analysis?.cutoff,
    parameters: analysis?.parameters ? structuredClone(analysis.parameters) : null,
  }]));
  const savedReferences = references.map(reference => ({ ...reference }));
  const required = new Set(requiredProperties.filter(name => typeof name === 'string').map(name => name.toLowerCase()));
  if (quantity.startsWith('property:')) required.add(quantity.slice(9).toLowerCase());
  if ((typeof hidden === 'boolean' ? hidden : Boolean(hidden?.size ?? hidden?.length)) && visibilitySource) required.add(visibilitySource.toLowerCase());
  const needed = new Set();
  if (required.has('coordination') && saved.coordination?.enabled
      && Number.isFinite(saved.coordination.cutoff) && saved.coordination.cutoff > 0) needed.add('coordination');
  if (required.has('structuretype') && saved.cna?.enabled && saved.cna.parameters) needed.add('cna');
  if ((quantity.startsWith('builtin:ptm:') || [...required].some(name => PTM_PROPERTIES.has(name)))
      && saved.ptm?.enabled && saved.ptm.parameters) needed.add('ptm');
  if ((required.has('centralsymmetry') || saved.centrosymmetry?.parameters?.mode === 'auto'
      && [...required].some(name => AUTO_CSP_PROPERTIES.has(name))) && saved.centrosymmetry?.enabled
      && saved.centrosymmetry.parameters) needed.add('centrosymmetry');
  if ([...required].some(name => STRAIN_PROPERTIES.has(name)) && saved.strain?.enabled && saved.strain.parameters) {
    try { validateReferences(savedReferences, frame.types); needed.add('strain'); }
    catch { /* Background prediction must not estimate or request new lattice data. */ }
  }
  // PTM supplies orientations to a visible strain-derived orientation
  // view even if its own panel is off, through the ordinary strain controller.
  if (quantity.startsWith('builtin:ptm:') && !needed.has('ptm') && saved.strain?.enabled && saved.strain.parameters) {
    try { validateReferences(savedReferences, frame.types); needed.add('strain'); }
    catch { /* Keep this speculative path silent; foreground owns validation. */ }
  }
  if (needed.has('centrosymmetry') && saved.centrosymmetry.parameters.mode === 'auto'
      && saved.cna?.enabled && JSON.stringify(saved.cna.parameters) === adaptiveCnaKey) needed.add('cna');
  if (needed.has('strain') && saved.ptm?.enabled && saved.ptm.parameters) needed.add('ptm');

  const requests = [], stage = new Map();
  const add = (kind, parameters) => {
    stage.set(kind, requests.length);
    requests.push({ parameters, ...(typeof gpuRequested === 'boolean' ? {
      cachedResult: (_, currentFrame, inputs) => existingResult(currentFrame, kind, inputs, saved[kind], gpuRequested, canReuseResult),
    } : {}) });
  };
  if (needed.has('coordination')) add('coordination', { kind: 'coordination', cutoff: saved.coordination.cutoff });
  if (needed.has('cna')) add('cna', { kind: 'cna', ...saved.cna.parameters });
  if (needed.has('ptm')) add('ptm', { kind: 'ptm', ...saved.ptm.parameters, ...(neighborLists ? { neighborLists: true } : {}) });
  if (needed.has('centrosymmetry')) {
    const parameters = { kind: 'centrosymmetry', ...saved.centrosymmetry.parameters };
    add('centrosymmetry', parameters.mode !== 'auto' ? parameters : results => {
      const predicted = stage.has('cna') && JSON.stringify(saved.cna.parameters) === adaptiveCnaKey
        ? results[stage.get('cna')]?.structures : null;
      const existing = frame.properties?.find(property => property.name === 'structureType'
        && property.analysisKind === 'cna' && property.analysisKey === adaptiveCnaKey)?.data;
      const structures = predicted ?? existing;
      return { ...parameters, ...(structures ? { structureInput: structures } : {}) };
    });
  }
  if (needed.has('strain')) {
    const parameters = { kind: 'strain', ...saved.strain.parameters,
      references: savedReferences, ...(neighborLists ? { neighborLists: true } : {}) };
    parameters.flags |= savedReferences.reduce((flags, reference) => flags | (1 << (reference.structure - 1)), 0);
    add('strain', results => {
      let fit = frame.ptm, fitParameters;
      if (stage.has('ptm')) {
        fit = results[stage.get('ptm')];
        // A foreground cached PTM property can coexist with a broader fit
        // retained by strain. In that case the normal controller keeps it.
        try { fitParameters = fit?.key ? JSON.parse(fit.key) : saved.ptm.parameters; }
        catch { fitParameters = saved.ptm.parameters; }
      } else {
        try { fitParameters = fit?.key ? JSON.parse(fit.key) : null; }
        catch { fitParameters = null; }
      }
      const compatible = fit && fitParameters?.rmsdCutoff === parameters.rmsdCutoff
        && (fitParameters.flags & parameters.flags) === parameters.flags;
      return { ...parameters, ...(compatible ? { flags: fitParameters.flags, ptmInput: fit } : {}) };
    });
  }
  return requests;
}

// Revisit of an already calculated frame must not trigger speculative work
// which its normal foreground controller would immediately skip anyway.
function existingResult(frame, kind, inputs, analysis, gpuRequested, canReuseResult) {
  const names = { coordination: 'coordination', cna: 'structureType', centrosymmetry: 'centralSymmetry',
    ptm: 'ptmStructureType', strain: 'atomicShearStrain' };
  const property = frame.properties?.find(field => field.name === names[kind] && field.analysisKind === kind);
  if (!property || Boolean(property.analysisGpuRequested) !== gpuRequested) return undefined;
  if (kind === 'coordination') {
    if (property.analysisCutoff !== inputs.cutoff) return undefined;
  } else {
    let cached;
    try { cached = JSON.parse(property.analysisKey); } catch { return undefined; }
    const expected = kind === 'strain'
      ? { ...analysis.parameters, flags: inputs.flags, references: inputs.references } : analysis.parameters;
    if (!sameParameters(cached, expected)) return undefined;
  }
  const metadata = { backend: property.analysisBackend, engine: property.analysisEngine,
    gpuRequested: property.analysisGpuRequested, elapsedMs: property.analysisMs, fallbackReason: property.analysisFallbackReason };
  if (canReuseResult?.(frame, inputs, metadata) === false) return undefined;
  if (kind === 'cna') return { ...metadata, structures: property.data };
  if (kind === 'ptm') return frame.ptm ? { ...metadata, ...frame.ptm } : undefined;
  if (kind === 'coordination') return { ...metadata, coordination: property.data, histogram: property.histogram, meanCoordination: property.meanCoordination };
  if (kind === 'centrosymmetry') {
    const structures = frame.properties.find(field => field.name === 'centralSymmetryStructureType')?.data;
    const neighbors = frame.properties.find(field => field.name === 'centralSymmetryNeighbors')?.data;
    return { ...metadata, centrosymmetry: property.data, cspSummary: property.cspSummary,
      ...(structures ? { cspStructureTypes: structures } : {}), ...(neighbors ? { cspNeighborCounts: neighbors } : {}) };
  }
  return { ...metadata, ...frame.ptm, ...Object.fromEntries(STRAIN_FIELDS.map(name =>
    [name, frame.properties.find(field => field.name === name)?.data])) };
}

function sameParameters(first, second) {
  if (Object.is(first, second)) return true;
  if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false;
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length && keys.every(key =>
    Object.hasOwn(second, key) && sameParameters(first[key], second[key]));
}
