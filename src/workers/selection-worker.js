import { expandSelection } from '../analysis/expand-selection.js';
import { NeighborSearch } from '../analysis/neighbors.js';

// The neighbor index of the most recent frame stays here, so repeated
// expansions of one frame send only the selection mask. Cancellation
// terminates this Worker; it never needs to poll for messages.
let resident = null;

self.addEventListener('message', async ({ data }) => {
  const { id, type, frameKey, fractional, cell, mask, options } = data;
  try {
    if (type !== 'expand') throw new Error(`Unknown selection request: ${type}`);
    if (resident?.key !== frameKey) {
      if (!fractional || !cell) throw new Error('The selection frame is unavailable in its Worker.');
      resident = null; // Release the previous index before building the next one.
      resident = { key: frameKey, frame: { fractional, cell }, search: new NeighborSearch({ fractional, cell }) };
    }
    let reportedAt = -Infinity;
    const result = await expandSelection(resident.frame, mask, options, {
      search: resident.search,
      onProgress: progress => {
        const now = performance.now();
        if (now - reportedAt < 80) return;
        reportedAt = now;
        self.postMessage({ id, progress });
      },
    });
    self.postMessage({ id, ok: true, result }, [result.mask.buffer]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
