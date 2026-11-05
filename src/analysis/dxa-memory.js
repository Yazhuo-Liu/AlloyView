const GiB = 1024 ** 3;

// The wasm32 DXA kernel is built with this maximum linear-memory capacity.
// This is an address-space limit, not a claim about available physical RAM.
export const DXA_WASM_MEMORY_LIMIT = 4 * GiB;
// The whole-job budget includes JavaScript buffers and private Workers, which
// can occupy more RAM in total than any single native Wasm heap.
export const DXA_MAX_MEMORY_BUDGET = 16 * GiB;

/** Use up to 80% of the browser's approximate device-memory hint. Browsers
 * may round, clamp or omit that hint, so this cannot measure actual host RAM.
 * Without a usable hint, use the 16 GiB whole-job budget. JavaScript's heap
 * limit does not describe Wasm capacity or physical RAM and is not used here.
 * Explicit job budgets are validated by the caller and may also cover private
 * Workers; the native kernel must still obey its separate address-space limit.
 */
export function dxaMemoryBudget(environment = globalThis) {
  const deviceGiB = Number(environment.navigator?.deviceMemory);
  const bytes = Number.isFinite(deviceGiB) && deviceGiB > 0
    ? Math.min(DXA_MAX_MEMORY_BUDGET, deviceGiB * GiB * .8)
    : DXA_MAX_MEMORY_BUDGET;
  return Math.max(1, Math.floor(bytes));
}
