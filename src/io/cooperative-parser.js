import { yieldToEventLoop } from '../shared/task-yield.js';
import { asBytes, byteParserStatistics, decodeText, isByteInput } from './ascii-rows.js';

export const PARSER_CHECKPOINT_MASK = 1023;

/** Synchronous public readers and cancellable Worker readers execute the same
 * generator. Numeric loops checkpoint once per 1,024 rows; only the async
 * driver yields to the event loop, and only after its time budget expires. */
export function runParserSteps(steps) {
  for (;;) {
    const result = steps.next();
    if (result.done) return result.value;
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Frame parsing cancelled.', 'AbortError');
}

const yieldParser = () => typeof globalThis.setImmediate === 'function'
  ? new Promise(resolve => globalThis.setImmediate(resolve)) : yieldToEventLoop();

export async function runParserStepsAsync(steps, { signal, budgetMs = 8,
  now = () => performance.now(), yieldControl = yieldParser } = {}) {
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
    // checked outside the iterator, so byte fallback cannot swallow it.
    steps.return?.();
  }
}

/** Preserve byte fast-path statistics, exact text fallback and error messages.
 * All numeric work inside both readers is shared with the synchronous API. */
export function* parseInputSteps(input, parseBytes, parseText) {
  if (!isByteInput(input)) return yield* parseText(input);
  const bytes = asBytes(input);
  byteParserStatistics.attempts++;
  let result = null;
  try { result = yield* parseBytes(bytes); } catch { result = null; }
  if (result) return result;
  byteParserStatistics.fallbacks++;
  yield;
  return yield* parseText(decodeText(bytes));
}

/** Match String(text).replace(BOM, '').split(/\r?\n/) without one long regex
 * split before the first numeric checkpoint. Empty final lines are retained. */
export function* splitParserLines(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const lines = [];
  let start = 0, end;
  while ((end = text.indexOf('\n', start)) >= 0) {
    lines.push(text.slice(start, end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end));
    start = end + 1;
    if ((lines.length & PARSER_CHECKPOINT_MASK) === 0) yield;
  }
  lines.push(text.slice(start));
  return lines;
}
