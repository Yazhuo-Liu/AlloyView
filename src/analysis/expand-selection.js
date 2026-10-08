import { NeighborSearch } from './neighbors.js';

export const EXPAND_SELECTION_MODES = Object.freeze(['cutoff', 'nearest']);
export const MAX_EXPAND_ITERATIONS = 100;
export const MAX_EXPAND_NEIGHBORS = 256;

const abortError = () => new DOMException('Selection expansion was cancelled.', 'AbortError');

export function normalizeExpansionOptions({ mode = 'cutoff', cutoff, count, iterations = 1 } = {}) {
  if (!EXPAND_SELECTION_MODES.includes(mode)) throw new Error('Choose expansion by cutoff distance or by nearest neighbors.');
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_EXPAND_ITERATIONS) {
    throw new Error(`Iterations must be a whole number from 1 to ${MAX_EXPAND_ITERATIONS}.`);
  }
  if (mode === 'cutoff') {
    if (typeof cutoff !== 'number' || !Number.isFinite(cutoff) || cutoff <= 0) throw new Error('The expansion cutoff must be a positive distance in Å.');
    return { mode, cutoff, iterations };
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_EXPAND_NEIGHBORS) {
    throw new Error(`The neighbor count must be a whole number from 1 to ${MAX_EXPAND_NEIGHBORS}.`);
  }
  return { mode, count, iterations };
}

/** OVITO-style Expand selection over periodic images. Each iteration adds
 * every atom within `cutoff` of, or among the `count` nearest neighbors of, an
 * atom selected in the previous iteration. Only that frontier needs a neighbor
 * query: earlier atoms' neighbors are already selected. The result does not
 * depend on visiting order. `pause` lets callers yield between blocks. */
export async function expandSelection(frame, selected, options = {}, {
  search = null, signal, pause = null, onProgress = () => {}, blockSize = 2048,
} = {}) {
  const { mode, cutoff, count, iterations } = normalizeExpansionOptions(options);
  if (signal?.aborted) throw abortError();
  const atomCount = frame.fractional.length / 3;
  if (!selected || selected.length !== atomCount) throw new Error('The selection mask does not match the frame.');
  const result = new Uint8Array(atomCount);
  let frontier = [];
  for (let atom = 0; atom < atomCount; atom++) if (selected[atom]) { result[atom] = 1; frontier.push(atom); }
  if (!frontier.length || frontier.length === atomCount) return { mask: result, added: 0, iterationsRun: 0 };
  search ??= new NeighborSearch(frame);
  let added = 0, iteration = 0;
  for (; iteration < iterations && frontier.length; iteration++) {
    const next = [], frontierSize = frontier.length;
    for (let index = 0; index < frontierSize; index++) {
      const neighbors = mode === 'cutoff' ? search.within(frontier[index], cutoff) : search.nearest(frontier[index], count);
      for (const neighbor of neighbors) {
        if (result[neighbor.atom]) continue;
        result[neighbor.atom] = 1;
        next.push(neighbor.atom);
      }
      if ((index + 1) % blockSize === 0) {
        onProgress({ iteration: iteration + 1, iterations, processed: index + 1, frontier: frontierSize });
        if (pause) await pause();
        if (signal?.aborted) throw abortError();
      }
    }
    added += next.length;
    frontier = next;
    onProgress({ iteration: iteration + 1, iterations, processed: frontierSize, frontier: frontierSize });
  }
  return { mask: result, added, iterationsRun: iteration };
}
