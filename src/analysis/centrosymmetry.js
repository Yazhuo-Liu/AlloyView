import { NeighborSearch, atomRange } from './neighbors.js';
import { classifyAdaptiveEnvironment } from './cna.js';

export const CSP_SUMMARY_FIELDS = Object.freeze(['fcc', 'hcp', 'bcc', 'other', 'ico', 'inferred', 'unresolved']);
const TYPE_NAMES = ['other', 'fcc', 'hcp', 'bcc', 'ico'];
const NEIGHBOR_COUNTS = [0, 12, 12, 8, 0];
const preparedContexts = new WeakMap();

/** AtomEye-style normalized, disjoint greedy opposite-vector pairing.
 * This is dimensionless, not the conventional CSP in square angstroms.
 * Auto selects a shell independently for each atom using adaptive CNA. A
 * defective Other atom can inherit a unique local neighbor-count vote, retaining the
 * defect's CSP instead of suppressing it by requiring perfect CNA recognition.
 * Ideal HCP is not centrosymmetric and its finite baseline is preserved.
 */
export function calculateCentrosymmetry(frame, {
  mode = 'manual', neighbors = 12, structureInput,
  onPhase = () => {}, onAtoms = () => {}, ...range
} = {}) {
  const startedAt = performance.now();
  const result = calculatePreparedCentrosymmetry(prepareCentrosymmetryContext(frame, { mode, neighbors, structureInput }),
    { ...range, onPhase, onAtoms });
  return { ...result, elapsedMs: performance.now() - startedAt };
}

export function validateCentrosymmetryParameters({ mode = 'manual', neighbors = 12 } = {}) {
  if (!['manual', 'auto'].includes(mode)) throw new Error('Unknown central-symmetry mode.');
  if (mode === 'manual' && (!Number.isInteger(neighbors) || neighbors < 2 || neighbors > 32 || neighbors % 2 !== 0)) {
    throw new Error('Central symmetry requires an even neighbor count between 2 and 32.');
  }
}

/** Validate complete CNA labels once for the immutable resident input set. */
export function prepareCentrosymmetryContext(frame, { mode = 'manual', neighbors = 12, structureInput } = {}) {
  validateCentrosymmetryParameters({ mode, neighbors });
  const count = frame.fractional.length / 3;
  if (structureInput !== undefined && (!(structureInput instanceof Uint8Array)
      || structureInput.length !== count || structureInput.some((type) => type > 4))) {
    throw new Error('Auto central symmetry requires complete adaptive CNA structure IDs.');
  }
  const context = Object.freeze({});
  preparedContexts.set(context, { frame, mode, neighbors, structureInput });
  return context;
}

export function calculatePreparedCentrosymmetry(context, { onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  const startedAt = performance.now();
  const retained = preparedContexts.get(context);
  if (!retained) throw new Error('The prepared central-symmetry context is invalid.');
  const { frame, mode, neighbors, structureInput } = retained;
  onPhase('indexing');
  const search = frame.neighborSearch ?? new NeighborSearch(frame);
  const { startAtom, endAtom } = atomRange(search.count, range);
  const count = endAtom - startAtom;
  const centrosymmetry = new Float32Array(count).fill(NaN);
  const auto = mode === 'auto';
  const cspStructureTypes = auto ? new Uint8Array(count) : null;
  const cspNeighborCounts = auto ? new Uint8Array(count) : null;
  const cspSummary = auto ? Object.fromEntries(CSP_SUMMARY_FIELDS.map((name) => [name, 0])) : null;
  // A range owns central atoms only. Neighbor classification is allowed across
  // every range boundary and cached by original atom ID, including PBC images.
  const classifications = auto && !structureInput ? (frame.adaptiveCnaClassifications ?? new Uint8Array(search.count).fill(255)) : structureInput;
  const classifyAtom = (atom, shell) => {
    if (classifications[atom] !== 255) return classifications[atom];
    const type = classifyAdaptiveEnvironment(shell ?? search.nearest(atom, 14));
    classifications[atom] = type;
    return type;
  };
  let incomplete = 0;
  let lastProgress = startedAt - 150;
  onPhase('analyzing');
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    let shell;
    let shellCount = neighbors;
    if (auto) {
      shell = search.nearest(atom, 14);
      const type = classifyAtom(atom, shell);
      cspStructureTypes[atom - startAtom] = type;
      cspSummary[TYPE_NAMES[type]] += 1;
      shellCount = NEIGHBOR_COUNTS[type];
      if (type === 0) {
        const votes = [0, 0, 0, 0];
        for (const neighbor of shell) {
          const localType = classifyAtom(neighbor.atom);
          if (localType > 0 && localType < 4) votes[localType] += 1;
        }
        // FCC and HCP share the same CSP shell, so their votes reinforce one
        // another even at stacking faults. Only an 8-versus-12 tie is unclear.
        const closePackedVotes = votes[1] + votes[2];
        const bccVotes = votes[3];
        if (closePackedVotes !== bccVotes) {
          shellCount = closePackedVotes > bccVotes ? 12 : 8;
          cspSummary.inferred += 1;
        }
      }
      cspNeighborCounts[atom - startAtom] = shellCount;
    } else shell = search.nearest(atom, shellCount);
    if (shellCount) {
      if (shell.length < shellCount) incomplete += 1;
      else {
        const value = normalizedCentrosymmetry(shell.slice(0, shellCount));
        centrosymmetry[atom - startAtom] = value;
        if (!Number.isFinite(value)) incomplete += 1;
      }
    }
    if (auto && !Number.isFinite(centrosymmetry[atom - startAtom])) cspSummary.unresolved += 1;
    const processed = atom - startAtom + 1;
    if (processed % 128 === 0) {
      const now = performance.now();
      if (now - lastProgress >= 150) {
        onAtoms(processed, count);
        lastProgress = now;
      }
    }
  }
  onAtoms(count, count);
  return { centrosymmetry, ...(auto ? { cspStructureTypes, cspNeighborCounts, cspSummary } : {}),
    incomplete, startAtom, endAtom, elapsedMs: performance.now() - startedAt };
}

/** Exact reference for a bounded GPU correction or standalone local shell. */
export function normalizedCentrosymmetry(shell) {
  const denominator = 2 * shell.reduce((sum, n) => sum + n.distanceSquared, 0);
  if (denominator <= 0) return NaN;
  const used = new Uint8Array(shell.length);
  let sum = 0;
  for (let i = 0; i < shell.length; i += 1) {
    if (used[i]) continue;
    let best = -1;
    let minimum = Infinity;
    for (let j = i + 1; j < shell.length; j += 1) {
      if (used[j]) continue;
      const x = shell[i].x + shell[j].x;
      const y = shell[i].y + shell[j].y;
      const z = shell[i].z + shell[j].z;
      const value = x * x + y * y + z * z;
      if (value < minimum) { minimum = value; best = j; }
    }
    used[i] = used[best] = 1;
    sum += minimum;
  }
  return sum / denominator;
}
