import { asBytes, byteParserStatistics, decodeText, isByteInput } from './ascii-rows.js';

export const PARSER_CHECKPOINT_MASK = 1023;

/** Preserve byte fast-path statistics, exact text fallback and error messages.
 * Parsers run these generators through runCooperativeSteps/Async from
 * shared/cooperative-steps.js; numeric loops checkpoint once per 1,024 rows. */
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
