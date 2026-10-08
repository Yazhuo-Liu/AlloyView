import assert from 'node:assert/strict';
import test from 'node:test';
import { expandSelection, normalizeExpansionOptions } from '../src/analysis/expand-selection.js';
import { initializeExpressionControls } from '../src/expression-controls.js';
import { SelectionExpansionClient } from '../src/selection-expansion-client.js';
import { addSelectionGroup, normalizeSelectionGroups, setSelectionGroupMembers } from '../src/selection-groups.js';
import { isComputedProperty } from '../src/computed-properties.js';

function random(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let value = Math.imul(seed ^ (seed >>> 15), 1 | seed); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}

function randomFrame({ count = 120, vectors = [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc = [true, true, true], seed = 7 } = {}) {
  const next = random(seed);
  const fractional = Float64Array.from({ length: count * 3 }, next);
  const positions = new Float64Array(count * 3);
  for (let atom = 0; atom < count; atom++) for (let axis = 0; axis < 3; axis++) {
    positions[atom * 3 + axis] = [0, 1, 2].reduce((sum, row) => sum + fractional[atom * 3 + row] * vectors[row * 3 + axis], 0);
  }
  return { ids: Float64Array.from({ length: count }, (_, index) => 101 + index), idSource: 'explicit',
    types: Uint16Array.from({ length: count }, (_, index) => index % 2), typeLabels: ['Ni', 'Fe'], fractional, positions,
    cell: { origin: Float64Array.of(0, 0, 0), vectors: Float64Array.from(vectors), pbc, triclinic: vectors.some((value, index) => index % 4 && value) },
    properties: [{ name: 'energy', data: Float64Array.from({ length: count }, (_, index) => -index) }] };
}

/** All periodic images within two cells, independent of the binned search. */
function bruteCandidates(frame, atom) {
  const count = frame.fractional.length / 3, h = frame.cell.vectors, candidates = [];
  const range = axis => frame.cell.pbc[axis] ? [-2, -1, 0, 1, 2] : [0];
  for (let other = 0; other < count; other++) for (const a of range(0)) for (const b of range(1)) for (const c of range(2)) {
    if (other === atom && !a && !b && !c) continue;
    const d = [a, b, c].map((image, axis) => frame.fractional[other * 3 + axis] + image - frame.fractional[atom * 3 + axis]);
    const vector = [0, 1, 2].map(axis => d[0] * h[axis] + d[1] * h[3 + axis] + d[2] * h[6 + axis]);
    candidates.push({ atom: other, distance: Math.hypot(...vector) });
  }
  return candidates.sort((first, second) => first.distance - second.distance);
}

function bruteExpand(frame, selected, { mode, cutoff, count, iterations }) {
  const result = Uint8Array.from(selected);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const current = Uint8Array.from(result);
    for (let atom = 0; atom < current.length; atom++) {
      if (!current[atom]) continue;
      const candidates = bruteCandidates(frame, atom);
      const neighbors = mode === 'cutoff' ? candidates.filter(item => item.distance <= cutoff) : candidates.slice(0, count);
      for (const { atom: other } of neighbors) result[other] = 1;
    }
  }
  return result;
}

const seedMask = count => Uint8Array.from({ length: count }, (_, index) => index % 37 === 0 ? 1 : 0);

test('selection groups support intersection without reordering members', () => {
  let state = addSelectionGroup(normalizeSelectionGroups(), { atomIds: [5, 'a', 3, 9] });
  state = setSelectionGroupMembers(state, state.selectedGroupId, [9, 5, 77], { operation: 'intersect' });
  assert.deepEqual(state.groups[0].atomIds, [5, 9]);
  assert.throws(() => setSelectionGroupMembers(state, state.selectedGroupId, [], { operation: 'xor' }), /replace, add, remove or intersect/);
});

test('cutoff and nearest-neighbor expansion match periodic brute force in orthogonal and triclinic cells', async () => {
  for (const options of [
    { frame: randomFrame(), mode: 'cutoff', cutoff: 2.2, iterations: 1 },
    { frame: randomFrame(), mode: 'cutoff', cutoff: 1.6, iterations: 3 },
    { frame: randomFrame({ vectors: [10, 0, 0, 3, 9, 0, 2, 1.5, 8], seed: 11 }), mode: 'cutoff', cutoff: 2.4, iterations: 2 },
    { frame: randomFrame({ vectors: [9, 0, 0, -4, 8, 0, 1, -3, 9], pbc: [true, false, true], seed: 3 }), mode: 'cutoff', cutoff: 2.5, iterations: 1 },
    { frame: randomFrame({ vectors: [10, 0, 0, 3, 9, 0, 2, 1.5, 8], seed: 5 }), mode: 'nearest', count: 4, iterations: 2 },
    { frame: randomFrame({ count: 60, seed: 9 }), mode: 'nearest', count: 1, iterations: 1 },
  ]) {
    const { frame, ...settings } = options;
    const selected = seedMask(frame.ids.length);
    const progress = [];
    const result = await expandSelection(frame, selected, settings, { onProgress: update => progress.push(update), blockSize: 2 });
    const expected = bruteExpand(frame, selected, settings);
    assert.deepEqual(Array.from(result.mask), Array.from(expected), JSON.stringify(settings));
    assert.equal(result.added, expected.reduce((sum, value) => sum + value, 0) - selected.reduce((sum, value) => sum + value, 0));
    assert.ok(progress.length > 0);
    assert.ok(result.mask.some((value, index) => value && !selected[index]), 'the expansion adds atoms');
  }
});

test('expansion crosses periodic boundaries and validates its settings', async () => {
  const frame = randomFrame({ count: 4 });
  frame.fractional.set([0.02, 0.5, 0.5, 0.97, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.1, 0.9]);
  const result = await expandSelection(frame, Uint8Array.of(1, 0, 0, 0), { mode: 'cutoff', cutoff: 1 });
  assert.deepEqual(Array.from(result.mask), [1, 1, 0, 0], 'the 0.5 Å minimum image across x = 0 is a neighbor');
  const open = { ...frame, cell: { ...frame.cell, pbc: [false, true, true] } };
  assert.deepEqual(Array.from((await expandSelection(open, Uint8Array.of(1, 0, 0, 0), { mode: 'cutoff', cutoff: 1 })).mask), [1, 0, 0, 0]);
  assert.deepEqual((await expandSelection(frame, new Uint8Array(4), { mode: 'cutoff', cutoff: 3 })).added, 0);
  for (const [options, pattern] of [
    [{ mode: 'radius', cutoff: 1 }, /cutoff distance or by nearest/], [{ cutoff: 0 }, /positive distance/], [{ cutoff: NaN }, /positive distance/],
    [{ mode: 'nearest', count: 0 }, /from 1 to 256/], [{ mode: 'nearest', count: 2.5 }, /from 1 to 256/],
    [{ cutoff: 1, iterations: 0 }, /from 1 to 100/], [{ cutoff: 1, iterations: 101 }, /from 1 to 100/],
  ]) assert.throws(() => normalizeExpansionOptions(options), pattern);
  await assert.rejects(expandSelection(frame, new Uint8Array(3), { cutoff: 1 }), /does not match the frame/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(expandSelection(randomFrame(), seedMask(120), { cutoff: 3 }, { signal: controller.signal, pause: async () => {}, blockSize: 1 }), { name: 'AbortError' });
});

test('the selection Worker reuses its neighbor index and the client cancels by termination', async t => {
  const previousSelf = globalThis.self;
  let workerListener = null, reply = null;
  globalThis.self = { addEventListener: (type, callback) => { assert.equal(type, 'message'); workerListener = callback; }, postMessage: message => reply?.(message) };
  t.after(() => { globalThis.self = previousSelf; });
  await import('../src/workers/selection-worker.js');
  const messages = [], workers = [];
  const createWorker = () => {
    const listeners = new Map([['message', []], ['error', []]]);
    const worker = {
      terminated: false,
      addEventListener: (type, callback) => listeners.get(type).push(callback),
      postMessage(message, transfer) {
        assert.ok(transfer.includes(message.mask.buffer), 'the mask copy is transferred');
        messages.push(message);
        const data = structuredClone(message);
        setTimeout(() => {
          if (worker.terminated) return;
          reply = response => { if (!worker.terminated) for (const callback of listeners.get('message')) callback({ data: structuredClone(response) }); };
          void workerListener({ data });
        }, 0);
      },
      terminate() { worker.terminated = true; },
    };
    workers.push(worker);
    return worker;
  };
  let permits = 0;
  const cpuBudget = { acquire: async () => { permits++; return { release: () => { permits--; } }; } };
  const client = new SelectionExpansionClient({ cpuBudget, createWorker });
  const frame = randomFrame();
  const selected = seedMask(frame.ids.length);
  const expected = bruteExpand(frame, selected, { mode: 'cutoff', cutoff: 2, iterations: 1 });
  const first = await client.expand(frame, selected, { mode: 'cutoff', cutoff: 2 });
  assert.deepEqual(Array.from(first.mask), Array.from(expected));
  const second = await client.expand(frame, selected, { mode: 'nearest', count: 2 });
  assert.deepEqual(Array.from(second.mask), Array.from(bruteExpand(frame, selected, { mode: 'nearest', count: 2, iterations: 1 })));
  assert.ok(messages[0].fractional && messages[0].cell, 'the first request sends coordinates');
  assert.equal(messages[1].fractional, undefined, 'a second request on the frame sends only the mask');
  assert.equal(permits, 0, 'CPU permits are released');
  assert.equal(frame.fractional.length, frame.ids.length * 3, 'frame coordinates are copied, not transferred');

  const controller = new AbortController();
  const pending = client.expand(randomFrame({ seed: 99 }), selected, { cutoff: 2 }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(workers[0].terminated, true);
  assert.equal(permits, 0);
  const after = await client.expand(frame, selected, { cutoff: 2 });
  assert.deepEqual(Array.from(after.mask), Array.from(expected));
  assert.equal(workers.length, 2, 'a new Worker replaces the cancelled one');
  assert.ok(messages.at(-1).fractional, 'the new Worker receives coordinates again');
  await assert.rejects(client.expand(frame, selected, { cutoff: -1 }), /positive distance/);
});

function controlsHarness(target = randomFrame({ count: 12 })) {
  let current = target, groups = normalizeSelectionGroups();
  const changes = [], edits = [];
  const controls = initializeExpressionControls({
    getFrame: () => current, getSelectionGroups: () => groups,
    editSelectionGroups: transform => (groups = transform(groups)),
    onPropertiesChange: change => { changes.push(change); controls.sync(current); }, onEdit: () => edits.push(true),
    expansionClient: new SelectionExpansionClient({ createWorker: null }), documentRoot: null,
  });
  controls.setEnabled(true);
  return { controls, changes, edits, get groups() { return groups; }, set groups(value) { groups = value; },
    set frame(value) { current = value; }, get frame() { return current; } };
}

test('expression selections create, replace, add, subtract and intersect group members', () => {
  const h = controlsHarness();
  const ids = h.frame.ids;
  let result = h.controls.selectByExpression({ expression: 'Index < 4', target: 'new' });
  assert.equal(result.matched, 4);
  const id = result.groupId;
  assert.deepEqual(h.groups.groups[0].atomIds, Array.from(ids.slice(0, 4)));
  assert.equal(h.groups.groups[0].name, 'Expression: Index < 4');
  assert.equal(h.groups.selectedGroupId, id);
  h.controls.selectByExpression({ expression: 'Index >= 8', target: id, operation: 'add' });
  assert.deepEqual(h.groups.groups[0].atomIds, [...ids.slice(0, 4), ...ids.slice(8)]);
  h.controls.selectByExpression({ expression: 'Type == "Fe"', target: id, operation: 'remove' });
  assert.deepEqual(h.groups.groups[0].atomIds, [ids[0], ids[2], ids[8], ids[10]]);
  h.controls.selectByExpression({ expression: 'Index <= 2 || Index == 10', target: id, operation: 'intersect' });
  assert.deepEqual(h.groups.groups[0].atomIds, [ids[0], ids[2], ids[10]]);
  h.controls.selectByExpression({ expression: 'energy == -5', target: id, operation: 'replace' });
  assert.deepEqual(h.groups.groups[0].atomIds, [ids[5]]);
  assert.equal(h.edits.length, 0, 'group edits are reported by the selection controls');
  assert.throws(() => h.controls.selectByExpression({ expression: 'enrgy < 0', target: id }), /Did you mean energy\?/);
  assert.throws(() => h.controls.selectByExpression({ expression: 'Type == "Cu"', target: id }), /No atom type is named “Cu”/);
  assert.throws(() => h.controls.selectByExpression({ expression: '1', target: id, operation: 'xor' }), /Choose replace/);
  assert.deepEqual(h.groups.groups[0].atomIds, [ids[5]], 'failed expressions leave the group unchanged');
});

test('invert uses the frame atoms and expand adds periodic neighbors to the target group', async () => {
  const frame = randomFrame();
  const h = controlsHarness(frame);
  const { groupId } = h.controls.selectByExpression({ expression: 'Index % 37 == 0', target: 'new' });
  // An ID absent from this frame is dropped by inversion.
  h.groups = setSelectionGroupMembers(h.groups, groupId, ['absent'], { operation: 'add' });
  const inverted = h.controls.invertSelection({ target: groupId });
  assert.equal(inverted.count, frame.ids.length - 4);
  assert.equal(h.groups.groups[0].atomIds.includes('absent'), false);
  h.controls.invertSelection({ target: groupId });
  assert.deepEqual(h.groups.groups[0].atomIds, [101, 138, 175, 212]);

  const expected = bruteExpand(frame, seedMask(frame.ids.length), { mode: 'cutoff', cutoff: 2.2, iterations: 2 });
  const expanded = await h.controls.expandGroup({ target: groupId, mode: 'cutoff', cutoff: 2.2, iterations: 2 });
  assert.equal(expanded.added, expected.reduce((sum, value) => sum + value, 0) - 4);
  const members = new Set(h.groups.groups[0].atomIds);
  assert.deepEqual(Array.from(frame.ids, id => members.has(id) ? 1 : 0), Array.from(expected));
  await assert.rejects(h.controls.expandGroup({ target: 'missing', cutoff: 2 }), /existing group/);
  assert.throws(() => h.controls.invertSelection({ target: 'missing' }), /existing group/);

  // A result that arrives after the frame changed is discarded.
  const before = h.groups;
  const pending = h.controls.expandGroup({ target: groupId, mode: 'nearest', count: 3, iterations: 1 });
  h.frame = randomFrame({ seed: 2 });
  await assert.rejects(pending, /frame changed/);
  assert.equal(h.groups, before);
  h.frame = frame;
});

test('computed property editing validates names, dependencies and frame variables', () => {
  const h = controlsHarness();
  assert.throws(() => h.controls.saveProperty({ name: 'Position.X', expression: '1' }), /built-in expression variable/);
  assert.throws(() => h.controls.saveProperty({ name: 'energy', expression: '1' }), /already exists/);
  assert.throws(() => h.controls.saveProperty({ name: 'a', expression: 'enrgy * 2' }), /Unknown variable “enrgy” at column 1\. Did you mean energy\?/);
  assert.throws(() => h.controls.saveProperty({ name: 'a', expression: '' }), /Enter an expression/);
  h.controls.saveProperty({ name: 'a', unit: 'eV', expression: 'energy * 2' });
  h.controls.saveProperty({ name: 'b', expression: 'a + 1' });
  assert.deepEqual(h.controls.getState(), { properties: [{ name: 'a', unit: 'eV', expression: 'energy * 2' }, { name: 'b', unit: '', expression: 'a + 1' }] });
  assert.deepEqual(Array.from(h.frame.properties.find(property => property.name === 'b').data.slice(0, 3)), [1, -1, -3]);
  // Same name replaces explicitly; a forward reference is rejected.
  assert.throws(() => h.controls.saveProperty({ name: 'a', expression: 'b * 2' }), /defined after it/);
  h.controls.saveProperty({ name: 'A', unit: 'eV', expression: 'energy * 3' });
  assert.deepEqual(h.changes.at(-1), { reason: 'replace', name: 'A', removed: ['a'] });
  assert.deepEqual(Array.from(h.frame.properties.find(property => property.name === 'b').data.slice(0, 3)), [1, -2, -5]);
  h.controls.beginEdit('A');
  assert.throws(() => h.controls.saveProperty({ name: 'c', expression: '1' }), /“b” uses “A”/);
  h.controls.beginEdit('b');
  h.controls.saveProperty({ name: 'renamed', expression: 'A - 1' });
  assert.deepEqual(h.controls.getState().properties.map(property => property.name), ['A', 'renamed']);
  assert.throws(() => h.controls.removeProperty('A'), /“renamed” uses “A”/);
  h.controls.removeProperty('renamed');
  assert.deepEqual(h.changes.at(-1), { reason: 'remove', name: 'renamed', removed: ['renamed'] });
  assert.deepEqual(h.frame.properties.filter(isComputedProperty).map(property => property.name), ['A']);

  // Interactive definitions need their variables now; a later frame may lack
  // one, and Color by then keeps a placeholder.
  assert.throws(() => h.controls.saveProperty({ name: 'needsCsp', expression: 'CSP > 1' }), /CSP reads centralSymmetry; calculate it first/);
  h.frame.properties.push({ name: 'special', data: new Float64Array(12).fill(2) });
  h.controls.saveProperty({ name: 'q', unit: 'eV', expression: 'special * A' });
  assert.deepEqual(h.controls.pendingColorProperties(), []);
  const next = randomFrame({ count: 12, seed: 4 });
  h.frame = next;
  h.controls.sync(next);
  assert.deepEqual(next.properties.filter(isComputedProperty).map(property => property.name), ['A']);
  assert.deepEqual(h.controls.pendingColorProperties(), [{ name: 'q', label: 'q [eV]' }]);
  h.controls.setState({ properties: [] });
  h.controls.sync(next);
  assert.equal(next.properties.some(isComputedProperty), false);
  h.controls.reset();
  assert.deepEqual(h.controls.getState(), { properties: [] });
  h.controls.setEnabled(false);
  assert.throws(() => h.controls.saveProperty({ name: 'z', expression: '1' }), /Open a structure/);
});
