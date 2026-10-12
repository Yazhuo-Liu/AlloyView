import { yieldToMain } from '../task-yield.js';

// This table stays bounded even for a corrupt, huge or fractional value.
// Float64 counters retain the old Map's numeric counts without u32 wrapping.
const COUNT_TABLE_LENGTH = 1024;
const abortError = () => new DOMException('Analysis cancelled.', 'AbortError');

/** Count ordinary coordination in a compact table. Preserve the old Map's
 * SameValueZero keys, stable numeric sorting (including NaN) and row-order
 * floating sum for unusual inputs instead of silently coercing them. */
export async function coordinationStatistics(values, signal) {
  if (signal?.aborted) throw abortError();
  const counts = new Float64Array(COUNT_TABLE_LENGTH), first = new Float64Array(COUNT_TABLE_LENGTH);
  let exceptional = null, sum = 0;
  for (let atom = 0; atom < values.length; atom++) {
    const value = values[atom];
    if (Number.isInteger(value) && value >= 0 && value < COUNT_TABLE_LENGTH) {
      if (!counts[value]) first[value] = atom;
      counts[value] += 1;
    } else {
      exceptional ??= new Map();
      const entry = exceptional.get(value);
      if (entry) entry[1] += 1; else exceptional.set(value, [atom, 1]);
    }
    sum += value;
    if (atom && atom % 65_536 === 0) { await yieldToMain(); if (signal?.aborted) throw abortError(); }
  }
  const rows = [];
  for (let value = 0; value < counts.length; value++) if (counts[value]) rows.push([value, counts[value], first[value]]);
  if (exceptional) {
    for (const [value, [index, count]] of exceptional) rows.push([value, count, index]);
    // NaN comparisons leave entries in their insertion positions. Restore
    // that order before applying exactly the previous stable comparator.
    rows.sort((a, b) => a[2] - b[2]);
    rows.sort((a, b) => a[0] - b[0]);
  }
  return { histogram: rows.map(([coordination, count]) => ({ coordination, count })), meanCoordination: sum / values.length };
}
