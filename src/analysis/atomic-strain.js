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
export async function calculateAtomicStrain(frame, { references, ptmInput = null, ...parameters }) {
  validateReferences(references, frame.types);
  const startedAt = performance.now();
  const { startAtom, endAtom } = atomRange(frame.fractional.length / 3, parameters);
  const count = endAtom - startAtom;
  const ptm = ptmInput ?? await calculatePtm(frame, parameters);
  const result = Object.fromEntries(STRAIN_FIELDS.map((name) => [name, new Float32Array(count).fill(NaN)]));
  let incomplete = 0;
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const i = atom - startAtom;
    const p = ptmInput ? atom : i;
    const type = ptm.structures[p];
    const reference = references[frame.types[atom]];
    if (type !== reference.structure || !Number.isFinite(ptm.scales[p])) { incomplete += 1; continue; }
    const factors = referenceFactors(type, reference, ptm.scales[p]);
    const F = Float64Array.from(ptm.deformation.subarray(p * 9, p * 9 + 9), (value, k) => value * factors[k % 3]);
    const volume = determinant3(F);
    if (!Number.isFinite(volume) || volume <= 0) { incomplete += 1; continue; }
    const E = new Float64Array(9);
    for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
      let value = 0;
      for (let k = 0; k < 3; k += 1) value += F[k * 3 + row] * F[k * 3 + column];
      E[row * 3 + column] = numericalZero((value - (row === column ? 1 : 0)) / 2);
    }
    const hydrostatic = (E[0] + E[4] + E[8]) / 3;
    const deviatoricNorm = E.reduce((sum, value, k) => sum + (value - (k % 4 === 0 ? hydrostatic : 0)) ** 2, 0);
    // OVITO/AtomEye von Mises shear invariant: sqrt((dev E : dev E) / 2).
    result.atomicShearStrain[i] = Math.sqrt(deviatoricNorm / 2);
    result.atomicHydrostaticStrain[i] = hydrostatic;
    result.atomicVolumeChange[i] = numericalZero(volume - 1);
    for (const [name, k] of [['strainE11', 0], ['strainE22', 4], ['strainE33', 8],
      ['strainE12', 1], ['strainE13', 2], ['strainE23', 5]]) result[name][i] = E[k];
  }
  return { ...result, ...(ptmInput ? {} : ptm), incomplete, startAtom, endAtom, elapsedMs: performance.now() - startedAt };
}

function referenceFactors(type, reference, scale) {
  let radiusPerA;
  if (type === 1) radiusPerA = 1 / Math.SQRT2;
  else if (type === 2) radiusPerA = 1;
  else if (type === 3) radiusPerA = (4 * Math.sqrt(3) + 6) / 14;
  else if (type === 5) radiusPerA = 1;
  else if (type === 6) radiusPerA = (Math.sqrt(3) + 6 * Math.SQRT2) / 16;
  else if (type === 7) radiusPerA = (Math.sqrt(6) + 12) / 16;
  else throw new Error('Unsupported elastic reference structure.');
  const factor = 1 / (scale * reference.a * radiusPerA);
  return [factor, factor, [2, 7].includes(type) ? factor * Math.sqrt(8 / 3) * reference.a / reference.c : factor];
}
