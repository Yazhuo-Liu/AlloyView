import test from 'node:test';
import assert from 'node:assert/strict';
import { atomIdSet, atomIndexEntry, atomIndicesById, canonicalAtomNumber, frameAtomIdLookup, hasAtomId } from '../src/data/atom-ids.js';
import { selectionGroupVisibility, summarizeSelectionGroups } from '../src/selection-groups.js';

const awkward = [7, '7', '07', ' 7', '7.0', 7.5, '7.5', -0, 0, '0', '-0', NaN, 'NaN', Infinity, 'Infinity', 1e21, '1e+21',
  '1e21', 2 ** 53 + 2, String(2 ** 53 + 2), 5n, '5', 2n ** 60n + 1n, '', 'abc', 'ABC', 0.1 + 0.2, String(0.1 + 0.2), '0.3'];

test('numeric keys reproduce text identity for atom IDs', () => {
  for (const id of awkward) {
    const value = canonicalAtomNumber(id);
    if (value !== undefined) assert.equal(String(value), String(id), `${String(id)} keeps its text`);
  }
  assert.equal(canonicalAtomNumber('07'), undefined);
  assert.equal(canonicalAtomNumber(''), undefined);
  for (const members of [awkward, awkward.slice(0, 9), ['07', 'abc'], []]) {
    const set = atomIdSet(members), texts = new Set(members.map(String));
    for (const probe of awkward) assert.equal(hasAtomId(set, probe), texts.has(String(probe)), `membership of ${String(probe)}`);
  }
});

test('sorted frame lookups match text membership for numeric ID arrays', () => {
  const numeric = awkward.filter(id => typeof id === 'number');
  for (const ids of [Float64Array.from(numeric), Float64Array.of(), Int32Array.of(-3, 0, 7, 7, 2), Float64Array.of(NaN, -0, 3)]) {
    const has = frameAtomIdLookup(ids), texts = new Set(Array.from(ids, String));
    for (const probe of [...awkward, -3, '-3', 2, '2.0']) assert.equal(has(probe), texts.has(String(probe)), `${String(probe)} in ${ids}`);
  }
  const mixed = frameAtomIdLookup(['07', 7, 'abc']);
  for (const probe of awkward) assert.equal(mixed(probe), ['07', '7', 'abc'].includes(String(probe)));
});

test('index maps find every atom whose ID text matches, including repeats', () => {
  const ids = [3, '3', 4, 4, '04', -0, 'x', NaN];
  const map = atomIndicesById(ids);
  for (const probe of [...ids, 0, '0', 'NaN', 5, '4']) {
    const expected = ids.flatMap((id, index) => String(id) === String(probe) ? [index] : []);
    const found = atomIndexEntry(map, probe);
    const actual = found === undefined ? [] : typeof found === 'number' ? [found] : found;
    assert.deepEqual(actual, expected, `indices of ${String(probe)}`);
  }
});

test('selection-group masks and summaries match text comparison on numeric frames', () => {
  const random = (seed => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)(9);
  const ids = Float64Array.from({ length: 5000 }, () => Math.floor(random() * 4000) - 100);
  const hidden = Array.from({ length: 300 }, () => {
    const value = Math.floor(random() * 4000) - 100;
    return random() < 0.3 ? String(value) : random() < 0.1 ? `0${Math.abs(value)}` : value;
  });
  const groups = Object.freeze([Object.freeze({ id: 'a', visible: false, atomIds: Object.freeze(hidden) }),
    Object.freeze({ id: 'b', visible: true, atomIds: Object.freeze([ids[0], '17']) })]);
  const frame = { ids };
  const texts = new Set(hidden.map(String));
  const mask = selectionGroupVisibility(frame, groups);
  for (let index = 0; index < ids.length; index += 1) {
    assert.equal(mask?.[index] ?? 255, texts.has(String(ids[index])) ? 0 : 255);
  }
  const frameTexts = new Set(Array.from(ids, String));
  assert.deepEqual(summarizeSelectionGroups(frame, { groups }).map(entry => entry.matchedCount),
    groups.map(group => group.atomIds.filter(id => frameTexts.has(String(id))).length));
});
