import { analyzeCrystalSymmetry, warmCrystalSymmetry } from '../analysis/crystal-symmetry.js';

// Global native symmetry detection is synchronous. Requests are serialized by
// the client; a cancelled result is discarded there, with its CPU lease held
// until this acknowledgement. Ordinary cancellation retains the Wasm heap.
self.addEventListener('message', async ({ data }) => {
  const { id, type, frame, options } = data;
  try {
    const result = type === 'warm' ? await warmCrystalSymmetry() : type === 'analyze'
      ? await analyzeCrystalSymmetry(frame, options) : (() => { throw new Error('Unknown crystal symmetry request.'); })();
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
});
