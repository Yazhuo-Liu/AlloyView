import { calculateCoordination } from '../analysis/coordination.js';

self.addEventListener('message', (event) => {
  const { id, fractional, cell, cutoff, startAtom, endAtom } = event.data;
  try {
    const result = calculateCoordination({ fractional, cell }, cutoff, { startAtom, endAtom });
    self.postMessage({ id, ok: true, result }, [result.coordination.buffer]);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
