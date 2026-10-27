import { yieldToEventLoop } from './task-yield.js';

/** Synchronous callers and cancellable Worker callers execute the same
 * generator. Numeric loops checkpoint by yielding once per batch of rows; only
 * the async driver yields to the event loop, and only after its time budget
 * expires. File parsers, diffraction and volumetric preparation share these
 * drivers, so cancellation and yielding behave the same everywhere. */
export function runCooperativeSteps(steps) {
  for (;;) {
    const result = steps.next();
    if (result.done) return result.value;
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Frame parsing cancelled.', 'AbortError');
}

const yieldStep = () => typeof globalThis.setImmediate === 'function'
  ? new Promise(resolve => globalThis.setImmediate(resolve)) : yieldToEventLoop();

export async function runCooperativeStepsAsync(steps, { signal, budgetMs = 8,
  now = () => performance.now(), yieldControl = yieldStep } = {}) {
  checkAbort(signal);
  let deadline = now() + budgetMs;
  try {
    for (;;) {
      checkAbort(signal);
      const result = steps.next();
      if (result.done) { checkAbort(signal); return result.value; }
      if (now() >= deadline) {
        await yieldControl();
        checkAbort(signal);
        deadline = now() + budgetMs;
      }
    }
  } finally {
    // Release partial arrays and scanner state on cancellation. Abort is
    // checked outside the iterator, so a byte fallback cannot swallow it.
    steps.return?.();
  }
}
