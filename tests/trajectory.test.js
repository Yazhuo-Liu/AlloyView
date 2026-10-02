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
