import { calculatePtm } from './ptm.js';
import { atomRange } from './neighbors.js';
import { validateReferences } from './lattice.js';
import { determinant3 } from '../data/model.js';

export const STRAIN_FIELDS = Object.freeze(['atomicShearStrain', 'atomicHydrostaticStrain', 'atomicVolumeChange',
  'strainE11', 'strainE22', 'strainE33', 'strainE12', 'strainE13', 'strainE23']);

// Dimensionless roundoff floor; avoids amplifying numerical zero in color maps.
const numericalZero = value => Math.abs(value) < 1e-12 ? 0 : value;

/** Local elastic strain relative to an ideal PTM lattice, not trajectory strain.
 * Restore the absolute scale removed by PTM before computing E=(FᵀF-I)/2.
 */
export async function calculateAtomicStrain(frame, { references, ptmInput = null, sourceRange = null, onAtoms = () => {}, ...parameters }) {
  if (sourceRange) {
    const rows = sourceRange.endAtom - sourceRange.startAtom;
    if (!ptmInput || !Number.isSafeInteger(sourceRange.totalAtoms) || sourceRange.totalAtoms < 1
        || !Number.isSafeInteger(sourceRange.startAtom) || !Number.isSafeInteger(sourceRange.endAtom)
        || sourceRange.startAtom < 0 || sourceRange.endAtom > sourceRange.totalAtoms || rows < 0
        || !ArrayBuffer.isView(frame.types) || frame.types.length !== rows
        || !(ptmInput.structures instanceof Uint8Array) || ptmInput.structures.length !== rows
        || !(ptmInput.scales instanceof Float64Array) || ptmInput.scales.length !== rows
        || !(ptmInput.deformation instanceof Float64Array) || ptmInput.deformation.length !== rows * 9) {
      throw new Error('Cached PTM source rows are incomplete or have an invalid source range.');
    }
  }
  validateReferences(references, frame.types);
  const startedAt = performance.now();
  const { startAtom, endAtom } = atomRange(sourceRange?.totalAtoms ?? frame.fractional.length / 3,
    { ...parameters, startAtom: parameters.startAtom ?? sourceRange?.startAtom, endAtom: parameters.endAtom ?? sourceRange?.endAtom });
  if (sourceRange && (startAtom < sourceRange.startAtom || endAtom > sourceRange.endAtom)) throw new Error('The strain atom range is outside its source rows.');
  const count = endAtom - startAtom;
  const ptm = ptmInput ?? await calculatePtm(frame, { ...parameters, onAtoms });
  const result = Object.fromEntries(STRAIN_FIELDS.map((name) => [name, new Float32Array(count).fill(NaN)]));
  // Reuse private tensor scratch; every valid row overwrites all nine values.
  const F = new Float64Array(9), E = new Float64Array(9);
  let incomplete = 0;
  let lastProgressAt = performance.now();
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const i = atom - startAtom;
    if (ptmInput && i && i % 1024 === 0 && performance.now() - lastProgressAt >= 150) {
      onAtoms(i, count);
      lastProgressAt = performance.now();
    }
    const p = ptmInput ? atom - (sourceRange?.startAtom ?? 0) : i;
    const type = ptm.structures[p];
    const reference = references[frame.types[atom - (sourceRange?.startAtom ?? 0)]];
    if (type !== reference.structure || !Number.isFinite(ptm.scales[p])) { incomplete += 1; continue; }
    const radiusPerA = referenceRadiusPerA(type);
    const factor = 1 / (ptm.scales[p] * reference.a * radiusPerA);
    const axialFactor = type === 2 || type === 7 ? factor * Math.sqrt(8 / 3) * reference.a / reference.c : factor;
    const offset = p * 9;
    for (let k = 0; k < 9; k += 1) F[k] = ptm.deformation[offset + k] * (k % 3 === 2 ? axialFactor : factor);
    const volume = determinant3(F);
    if (!Number.isFinite(volume) || volume <= 0) { incomplete += 1; continue; }
    for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
      let value = 0;
      for (let k = 0; k < 3; k += 1) value += F[k * 3 + row] * F[k * 3 + column];
      E[row * 3 + column] = numericalZero((value - (row === column ? 1 : 0)) / 2);
    }
    const hydrostatic = (E[0] + E[4] + E[8]) / 3;
    let deviatoricNorm = 0;
    for (let k = 0; k < 9; k += 1) deviatoricNorm += (E[k] - (k % 4 === 0 ? hydrostatic : 0)) ** 2;
    // OVITO/AtomEye von Mises shear invariant: sqrt((dev E : dev E) / 2).
    result.atomicShearStrain[i] = Math.sqrt(deviatoricNorm / 2);
    result.atomicHydrostaticStrain[i] = hydrostatic;
    result.atomicVolumeChange[i] = numericalZero(volume - 1);
    result.strainE11[i] = E[0]; result.strainE22[i] = E[4]; result.strainE33[i] = E[8];
    result.strainE12[i] = E[1]; result.strainE13[i] = E[2]; result.strainE23[i] = E[5];
  }
  if (ptmInput) onAtoms(count, count);
  return { ...result, ...(ptmInput ? {} : ptm), incomplete, startAtom, endAtom, elapsedMs: performance.now() - startedAt };
}

export function referenceFactors(type, reference, scale) {
  const factor = 1 / (scale * reference.a * referenceRadiusPerA(type));
  return [factor, factor, type === 2 || type === 7 ? factor * Math.sqrt(8 / 3) * reference.a / reference.c : factor];
}

function referenceRadiusPerA(type) {
  if (type === 1) return 1 / Math.SQRT2;
  if (type === 2) return 1;
  if (type === 3) return (4 * Math.sqrt(3) + 6) / 14;
  if (type === 5) return 1;
  if (type === 6) return (Math.sqrt(3) + 6 * Math.SQRT2) / 16;
  if (type === 7) return (Math.sqrt(6) + 12) / 16;
  throw new Error('Unsupported elastic reference structure.');
}
