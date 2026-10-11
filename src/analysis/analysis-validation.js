import { atomRange } from './neighbors.js';
import { validatePtmParameters } from './ptm.js';
import { validateVoronoiParameters } from './voronoi.js';
import { validateRdfParameters } from './rdf.js';
import { validateBondStatisticsSchema } from './bond-statistics.js';
import { validateCentrosymmetryParameters } from './centrosymmetry.js';
import { MAX_BONDS } from './bonds.js';
import { analysisValidationError } from './errors.js';
import { determinant3 } from '../data/model.js';

/** Cheap preconditions shared by both routes. Full source-array validation
 * remains in the owning Worker; this does not scan a million atoms on the UI
 * thread or repeat scientific preparation for every chunk. */
export function validateAnalysisParameters(frame, parameters = {}) {
  try {
    const count = frame?.fractional?.length / 3;
    if (!ArrayBuffer.isView(frame?.fractional) || frame.fractional instanceof DataView
        || !Number.isInteger(count) || count < 1) throw new Error('Analysis requires at least one atom.');
    const cell = frame.cell;
    if (cell?.vectors?.length !== 9 || cell?.pbc?.length !== 3
        || !Array.from(cell.vectors).every(Number.isFinite)
        || !Number.isFinite(determinant3(cell.vectors)) || determinant3(cell.vectors) === 0) {
      throw new Error('Neighbor search requires a finite, non-singular cell.');
    }
    const { kind } = parameters;
    if (typeof kind !== 'string') throw new Error('Unknown analysis kind.');
    if (kind === 'displacement') {
      const { startAtom = 0, endAtom = count } = parameters;
      if (!Number.isInteger(startAtom) || !Number.isInteger(endAtom) || startAtom < 0 || endAtom > count || endAtom < startAtom) {
        throw new Error('The displacement atom range is invalid.');
      }
    } else atomRange(count, parameters);
    if (['strain', 'bonds', 'rdf', 'bondStatistics', 'clusterEdges'].includes(kind)
        && (!ArrayBuffer.isView(frame.types) || frame.types instanceof DataView || frame.types.length !== count)) {
      throw new Error('Analysis requires one element type per atom.');
    }
    if (parameters.structureInput !== undefined && (kind !== 'centrosymmetry' || parameters.mode !== 'auto'
        || !(parameters.structureInput instanceof Uint8Array) || parameters.structureInput.length !== count)) {
      throw new Error('Auto central symmetry requires complete adaptive CNA structure IDs.');
    }
    if (kind === 'ptm' || (kind === 'strain' && !parameters.ptmInput)) validatePtmParameters(parameters);
    else if (kind === 'cna') {
      const { mode = 'adaptive', cutoff = 3 } = parameters;
      if (!['adaptive', 'fixed'].includes(mode)) throw new Error('Unknown CNA mode.');
      if (mode === 'fixed' && (!Number.isFinite(cutoff) || cutoff <= 0)) throw new Error('CNA cutoff must be positive and finite.');
    } else if (kind === 'centrosymmetry') validateCentrosymmetryParameters(parameters);
    else if (kind === 'rdf') validateRdfParameters(frame, parameters);
    else if (kind === 'bondStatistics') validateBondStatisticsSchema(frame, parameters);
    else if (kind.startsWith('voronoi') && kind !== 'voronoiFinalize') validateVoronoiParameters(parameters);
    else if (['coordination', 'referenceStrain', 'localShear', 'localShearCoordination', 'localShearMetrics', 'bonds', 'clusterEdges'].includes(kind)) {
      if (!Number.isFinite(parameters.cutoff) || parameters.cutoff <= 0) throw new Error('The cutoff radius must be a finite value greater than zero.');
      if (kind === 'bonds' || kind === 'clusterEdges') {
        const { maxBonds = MAX_BONDS, pairCutoffs = [] } = parameters;
        if (!Number.isInteger(maxBonds) || maxBonds < 1 || maxBonds > MAX_BONDS) throw new Error(`Bond output is limited to ${MAX_BONDS.toLocaleString('en-US')} edges.`);
        if (!Array.isArray(pairCutoffs)) throw new Error('Element-pair cutoffs must be an array.');
        const keys = new Set();
        for (const entry of pairCutoffs) {
          if (!entry || ![entry.first, entry.second].every(value => Number.isInteger(value) && value >= 0)
              || !Number.isFinite(entry.cutoff) || entry.cutoff < 0) throw new Error('Invalid element-pair cutoff.');
          const key = [entry.first, entry.second].sort((a, b) => a - b).join(':');
          if (keys.has(key)) throw new Error('Each element pair can have only one cutoff.');
          keys.add(key);
        }
      }
    } else if (kind === 'displacement' && parameters.minimumImage !== undefined && typeof parameters.minimumImage !== 'boolean') {
      throw new Error('The minimum-image option must be a boolean.');
    }
  } catch (error) { throw analysisValidationError(error); }
}
