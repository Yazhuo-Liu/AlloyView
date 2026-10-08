/** Atom IDs are identified by their text: 7 and "7" name the same atom, while
 * "07" and " 7" do not. A number's text is canonical, so a numeric ID can only
 * match text that parses back to that same number. These helpers key numeric
 * IDs by number and keep only non-canonical text as strings, which gives the
 * same answers as comparing `String(id)` without converting every frame ID. */

/** The number whose text is exactly `String(id)`, or undefined. */
export function canonicalAtomNumber(id) {
  if (typeof id === 'number') return id;
  const key = String(id), value = Number(key);
  return key !== '' && String(value) === key ? value : undefined;
}

/** A membership set over atom IDs. Sets compare with SameValueZero, so -0
 * matches 0 and NaN matches NaN, exactly as their text does. */
export function atomIdSet(ids) {
  const numbers = new Set(), texts = new Set();
  for (const id of ids) {
    const value = canonicalAtomNumber(id);
    if (value === undefined) texts.add(String(id));
    else numbers.add(value);
  }
  return { numbers, texts, size: numbers.size + texts.size };
}

export function hasAtomId(set, id) {
  if (typeof id === 'number') return set.numbers.has(id);
  const value = canonicalAtomNumber(id);
  return value === undefined ? set.texts.has(String(id)) : set.numbers.has(value);
}

/** Membership over a frame's IDs. A numeric typed array is sorted once and
 * searched, which is several times cheaper than inserting a million numbers
 * into a Set; other arrays use `atomIdSet`. */
export function frameAtomIdLookup(ids) {
  if (!ArrayBuffer.isView(ids) || ids instanceof BigInt64Array || ids instanceof BigUint64Array) {
    const set = atomIdSet(ids);
    return id => hasAtomId(set, id);
  }
  const sorted = Float64Array.from(ids).sort();
  // Typed-array sorting puts NaN last; -0 and 0 compare equal below.
  const hasNaN = sorted.length > 0 && Number.isNaN(sorted[sorted.length - 1]);
  return id => {
    const value = canonicalAtomNumber(id);
    if (value === undefined) return false;
    if (Number.isNaN(value)) return hasNaN;
    let low = 0, high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle] < value) low = middle + 1; else high = middle;
    }
    return low < sorted.length && sorted[low] === value;
  };
}

/** Map from atom ID key to the first index, or to every index of a repeated ID. */
export function atomIndicesById(ids) {
  const map = new Map();
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index], value = canonicalAtomNumber(id);
    const key = value === undefined ? String(id) : value, existing = map.get(key);
    if (existing === undefined) map.set(key, index);
    else if (typeof existing === 'number') map.set(key, [existing, index]);
    else existing.push(index);
  }
  return map;
}

/** Look up an ID (or its text) in an `atomIndicesById` map. */
export function atomIndexEntry(map, id) {
  const value = canonicalAtomNumber(id);
  return map.get(value === undefined ? String(id) : value);
}
