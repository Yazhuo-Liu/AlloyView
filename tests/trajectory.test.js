import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { prepareSequenceBaseline, unwrapSequenceFrame } from '../src/data/trajectory.js';
import { parseCfg } from '../src/io/cfg.js';

const root = new URL('../', import.meta.url);

test('CFG sequence unwrapping follows stable IDs through a periodic crossing and reorder', () => {
  const cell = createCell({
    vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10],
    pbc: [true, true, true],
  });
  const first = frame([10, 20], [0.95, 0.2, 0.3, 0.25, 0.4, 0.5], cell);
  const state = prepareSequenceBaseline(first);
  const second = frame([20, 10], [0.24, 0.4, 0.5, 0.05, 0.2, 0.3], cell);
  const next = unwrapSequenceFrame(second, state, 1);

  assertArrayClose(second.unwrappedPositions, [2.4, 4, 5, 10.5, 2, 3]);
  assert.deepEqual([...second.imageFlags], [0, 0, 0, 1, 0, 0]);
  assert.equal(second.unwrapSource, 'sequence minimum-image inference');
  assert.deepEqual([...next.ids], [20, 10]);
});

test('CFG sequence unwrapping rejects changing ID sets explicitly', () => {
  const cell = createCell({ vectors: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  const state = prepareSequenceBaseline(frame([1], [0.1, 0.2, 0.3], cell));
  assert.throws(
    () => unwrapSequenceFrame(frame([2], [0.2, 0.2, 0.3], cell), state, 1),
    /atom ID 2.*absent/,
  );
});

test('CFG sequence unwrapping rejects implicit row-order IDs', () => {
  const cell = createCell({ vectors: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  const input = frame([1], [0.1, 0.2, 0.3], cell);
  input.idSource = 'row-order';
  assert.throws(() => prepareSequenceBaseline(input), /requires an explicit per-atom id auxiliary/);
  const explicit = frame([1], [0.1, 0.2, 0.3], cell);
  const state = prepareSequenceBaseline(explicit);
  for (const unwrapped of [null, Float32Array.from(explicit.positions)]) {
    input.unwrappedPositions = unwrapped;
    assert.throws(() => unwrapSequenceFrame(input, state, 1), /frame 2 requires an explicit per-atom id auxiliary/);
  }
});

test('CFG sequence validates changed IDs before accepting authoritative out-of-cell coordinates', () => {
  const cfg = (rows) => `Number of particles = 2\nH0(1,1) = 10\nH0(1,2) = 0\nH0(1,3) = 0\nH0(2,1) = 0\nH0(2,2) = 10\nH0(2,3) = 0\nH0(3,1) = 0\nH0(3,2) = 0\nH0(3,3) = 10\n.NO_VELOCITY.\nentry_count = 4\nauxiliary[0] = id\n55.845\nFe\n${rows}`;
  const initial = parseCfg(cfg('0.9 0 0 1\n0.2 0 0 2\n'));
  const state = prepareSequenceBaseline(initial);
  const changed = parseCfg(cfg('1.1 0 0 3\n0.3 0 0 2\n'));
  assert.ok(changed.unwrappedPositions, 'parser preserves original out-of-cell data');
  assert.throws(() => unwrapSequenceFrame(changed, state, 1), /atom ID 3.*absent/);
  const reordered = parseCfg(cfg('0.3 0 0 2\n2.1 0 0 1\n'));
  const original = reordered.unwrappedPositions;
  const next = unwrapSequenceFrame(reordered, state, 1);
  assert.equal(reordered.unwrappedPositions, original, 'valid file image data stays authoritative');
  assert.deepEqual([...next.ids], [2, 1]);
  assertArrayClose(reordered.unwrappedPositions, [3, 0, 0, 21, 0, 0]);
});

test('fixed_end_climb NEB replicas unwrap continuously in numeric filename order', async () => {
  const directory = new URL('examples/fixed_end_climb/', root);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.cfg'))
    .sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]));
  assert.equal(names.length, 40);
  let current = parseCfg(await readFile(new URL(names[0], directory), 'utf8'), names[0]);
  let state = prepareSequenceBaseline(current);
  let maximumStep = 0;
  let previous = Float64Array.from(state.unwrappedFractional);
  for (let index = 1; index < names.length; index += 1) {
    current = parseCfg(await readFile(new URL(names[index], directory), 'utf8'), names[index]);
    state = unwrapSequenceFrame(current, state, index);
    for (let offset = 0; offset < state.unwrappedFractional.length; offset += 1) {
      maximumStep = Math.max(maximumStep, Math.abs(state.unwrappedFractional[offset] - previous[offset]));
    }
    previous = Float64Array.from(state.unwrappedFractional);
  }
  assert.equal(current.ids.length, 257);
  assert.equal([...current.imageFlags].filter(Boolean).length, 32);
  assert.equal(Math.max(...current.imageFlags, ...current.imageFlags.map((value) => -value)), 1);
  assert.ok(maximumStep < 0.002, `unexpected NEB fractional step ${maximumStep}`);
});

function frame(ids, fractionalValues, cell) {
  const fractional = Float32Array.from(fractionalValues);
  return {
    ids: Float64Array.from(ids),
    idSource: 'explicit',
    fractional,
    positions: fractionalToCartesian(fractional, cell),
    cell,
  };
}

function assertArrayClose(actual, expected, tolerance = 1e-5) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance);
  }
}
