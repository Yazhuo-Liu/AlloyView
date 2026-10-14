import assert from 'node:assert/strict';
import test from 'node:test';

import { cartesianToFractional, createCell, fractionalToCartesian, wrapFractional } from '../src/data/model.js';
import { prepareSequenceBaseline, unwrapSequenceFrame } from '../src/data/trajectory.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';

const encode = text => new TextEncoder().encode(text);

function dump(columns, rows, { pbc = 'pp ff pp', tilted = true } = {}) {
  return `ITEM: TIMESTEP\n11\nITEM: NUMBER OF ATOMS\n${rows.length}\nITEM: BOX BOUNDS ${tilted ? 'xy xz yz ' : ''}${pbc}\n`
    + (tilted ? '-5 15 2.75\n-3 17 -1.5\n4 24 3.25\n' : '-5 15\n-3 17\n4 24\n')
    + `ITEM: ATOMS ${columns}\n${rows.join('\n')}\n`;
}

function assertExact(actual, expected) {
  assert.equal(actual.constructor, expected.constructor);
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    assert.ok(Object.is(actual[index], expected[index]), `offset ${index}: ${actual[index]} !== ${expected[index]}`);
  }
}

// The existing data-model conversions provide an independent, unfused oracle.
// In particular, image addition rounds before the final Cartesian transform.
function checkCoordinates(frame, source, { scaled = false, images = null, explicit = null, explicitScaled = false } = {}) {
  const values = Float32Array.from(source.flat());
  const sourceFractional = scaled ? values : cartesianToFractional(values, frame.cell);
  const fractional = wrapFractional(sourceFractional, frame.cell.pbc);
  assertExact(frame.fractional, fractional);
  assertExact(frame.positions, fractionalToCartesian(fractional, frame.cell));
  if (explicit) {
    const unwrapped = Float32Array.from(explicit.flat());
    assertExact(frame.unwrappedPositions, explicitScaled ? fractionalToCartesian(unwrapped, frame.cell) : unwrapped);
  } else if (images) {
    const imageFractional = Float32Array.from(sourceFractional, (value, index) => value + images.flat()[index]);
    assertExact(frame.unwrappedPositions, fractionalToCartesian(imageFractional, frame.cell));
  } else assert.equal(frame.unwrappedPositions, null);
}

test('fused dump coordinates retain every Float32 rounding point, mixed PBC and authoritative unwrapped columns', () => {
  const coordinates = [[-12.123456789, 123.987654321, 33.0000001], [0, -0, -1000.4444444], [20.3333333, 8.7654321, 4.123456789]];
  const images = [[-2, 3, 1], [2147483647, -2147483648, 7], [11, 13, -17]];
  const explicit = [[1.2345678901, 20.123456, -0], [33.333333, -44.444444, 55.555555], [-111, 2.0000001, -300.00001]];
  for (const tilted of [false, true]) for (const pbc of ['pp pp pp', 'pp ff pp', 'ff pp ff', 'ff ff ff']) {
    for (const sourceColumns of ['x y z', 'xs ys zs', 'xu yu zu', 'xsu ysu zsu']) {
      const scaled = sourceColumns.startsWith('xs');
      const sourceIsUnwrapped = sourceColumns.startsWith('xu') || sourceColumns.startsWith('xsu');
      for (const withImages of [false, true]) for (const extra of sourceIsUnwrapped ? [''] : ['', 'xu yu zu', 'xsu ysu zsu']) {
        const columns = `id type ${sourceColumns}${withImages ? ' ix iy iz' : ''}${extra ? ` ${extra}` : ''} energy`;
        const rows = coordinates.map((values, index) => [9007199254740987 + index, [4, 1, 4][index], ...values,
          ...(withImages ? images[index] : []), ...(extra ? explicit[index] : []), -0.123456789]
          .map(value => Object.is(value, -0) ? '-0' : value).join(' '));
        const text = dump(columns, rows, { tilted, pbc });
        for (const input of [text, encode(text)]) {
          const frame = parseLammpsFrame(input);
          assertExact(frame.ids, Float64Array.from([9007199254740987, 9007199254740988, 9007199254740989]));
          assert.deepEqual(frame.typeLabels, ['Type 1', 'Type 4']);
          assert.deepEqual([...frame.types], [1, 0, 1]);
          checkCoordinates(frame, coordinates, { scaled,
            images: withImages ? images : null,
            explicit: sourceIsUnwrapped ? coordinates : extra ? explicit : null,
            explicitScaled: sourceIsUnwrapped ? scaled : extra.startsWith('xsu') });
        }
      }
    }
  }
});

test('dense and sparse dump type identifiers preserve numeric sorting, element mapping and capacity errors', () => {
  const values = [9007199254740991, 1, 65536, 4294967297, 127, 65535, 1];
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  for (const withElements of [false, true]) {
    const text = dump(`id type${withElements ? ' element' : ''} xs ys zs`, values.map((value, index) =>
      `${index + 1} ${value}${withElements ? ` E${sorted.indexOf(value)}` : ''} .1 .2 .3`));
    for (const input of [text, encode(text)]) {
      const frame = parseLammpsFrame(input);
      assert.deepEqual(frame.typeLabels, sorted.map((value, index) => withElements ? `E${index}` : `Type ${value}`));
      assert.deepEqual([...frame.types], values.map(value => sorted.indexOf(value)));
    }
  }
  const conflict = dump('id type element xs ys zs', ['1 9007199254740991 Fe .1 .2 .3', '2 9007199254740991 Ni .1 .2 .3']);
  for (const input of [conflict, encode(conflict)]) {
    assert.throws(() => parseLammpsFrame(input), {
      message: 'LAMMPS dump parsing failed: Type 9007199254740991 maps to both element “Fe” and “Ni”.',
    });
  }
  const rows = Array.from({ length: 65536 }, (_, index) => `${index + 1} ${index + 1} .1 .2 .3`);
  const accepted = parseLammpsFrame(encode(dump('id type xs ys zs', rows.slice(1))));
  assert.equal(accepted.typeLabels.length, 65535);
  assert.equal(accepted.types.at(-1), 65534);
  assert.throws(() => parseLammpsFrame(encode(dump('id type xs ys zs', rows))), {
    message: 'LAMMPS dump parsing failed: The file contains more than 65,535 atom types, which the current data layout cannot represent.',
  });
});

test('same-order CFG continuity and late reordered rows produce the identical ID-resolved state', () => {
  const cell = createCell({ origin: [-11.11, 22.22, -33.33], vectors: [10.12345, 0, 0, 1.56789, 11.98765, 0, -2.22222, 3.456789, 12.34567], pbc: [true, false, true] });
  const ids = Float64Array.from([9007199254740991, 77, 0, 219, 1]);
  const previous = Float32Array.from([.98, 4.25, .1, .1, -.4, .98, .7, 5.67, .05, .3, -.8, .4, .5, .7, .9]);
  const fractional = Float32Array.from([.02, 4.30, .09, .11, -.3, .02, .7, 5.7, .98, .3, -.75, .42, .51, .71, .91]);
  const frame = (frameIds, values) => ({ ids: frameIds, idSource: 'explicit', fractional: values, positions: fractionalToCartesian(values, cell), cell });
  const state = prepareSequenceBaseline(frame(ids, previous));
  const sameOrder = frame(ids.slice(), fractional.slice());
  const sameState = unwrapSequenceFrame(sameOrder, state, 1);
  const order = [0, 1, 2, 4, 3]; // A late mismatch must not corrupt earlier rows.
  const reordered = frame(Float64Array.from(order, atom => ids[atom]), Float32Array.from(order.flatMap(atom => [...fractional.slice(atom * 3, atom * 3 + 3)])));
  const reorderedState = unwrapSequenceFrame(reordered, state, 1);
  for (const name of ['unwrappedFractional', 'wrappedFractional']) {
    assertExact(reorderedState[name], reorderedState[name].constructor.from(order.flatMap(atom => [...sameState[name].slice(atom * 3, atom * 3 + 3)])));
  }
  for (const name of ['unwrappedPositions', 'imageFlags']) {
    assertExact(reordered[name], reordered[name].constructor.from(order.flatMap(atom => [...sameOrder[name].slice(atom * 3, atom * 3 + 3)])));
  }
  assert.deepEqual([...sameOrder.imageFlags], [1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0]);
  const replaced = frame(Float64Array.from([9007199254740991, 77, 0, 219, 3]), fractional.slice());
  assert.throws(() => unwrapSequenceFrame(replaced, state, 1), { message: 'CFG sequence frame 2 contains atom ID 3, which is absent from the preceding image.' });
  assert.equal(replaced.unwrappedPositions, undefined);
});

test('same-order CFG continuity preserves Float64 sources and rejects image overflow before publishing output', () => {
  const cell = createCell({ vectors: [10, 0, 0, 2, 12, 0, -3, 1, 14], pbc: [true, false, true] });
  const ids = Float64Array.from([9007199254740991]);
  const first = { ids, idSource: 'explicit', cell, fractional: Float64Array.from([.25 + 1e-12, 10000.1 + 1e-9, .75 - 1e-12]) };
  first.positions = fractionalToCartesian(first.fractional, cell, new Float64Array(3));
  const state = prepareSequenceBaseline(first);
  const current = { ids: ids.slice(), idSource: 'explicit', cell, fractional: Float64Array.from([.26 + 1e-12, 10000.2 + 1e-9, .76 - 1e-12]) };
  current.positions = fractionalToCartesian(current.fractional, cell, new Float64Array(3));
  const originalPositions = current.positions.slice(), originalFractional = current.fractional.slice();
  const expected = Float64Array.from(current.fractional, (value, axis) => {
    let step = value - state.wrappedFractional[axis];
    if (cell.pbc[axis]) step -= Math.round(step);
    return state.unwrappedFractional[axis] + step;
  });
  const actual = unwrapSequenceFrame(current, state, 1);
  assertExact(actual.unwrappedFractional, expected);
  assertExact(current.positions, originalPositions);
  assertExact(current.fractional, originalFractional);
  assert.equal(current.positions.constructor, Float64Array);
  assertExact(current.unwrappedPositions, fractionalToCartesian(expected, cell));
  const invalid = { ...current, unwrappedPositions: null, imageFlags: null };
  const overflowing = { ...state, unwrappedFractional: Float64Array.from([2147483648.25, 0, 0]) };
  assert.throws(() => unwrapSequenceFrame(invalid, overflowing, 1), { message: 'CFG sequence frame 2 exceeds the supported image-flag range.' });
  assert.equal(invalid.unwrappedPositions, null);
  assert.equal(invalid.imageFlags, null);
});
