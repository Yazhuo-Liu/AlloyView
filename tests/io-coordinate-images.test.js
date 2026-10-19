import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCfg } from '../src/io/cfg.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import { replicateFrame } from '../src/data/replicate.js';
import { computeDisplacements } from '../src/analysis/displacement.js';
import { TrajectoryProcessor } from '../src/workers/trajectory-processor.js';

const encode = text => new TextEncoder().encode(text);
const near = (actual, expected, tolerance = 1e-5) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance,
    `coordinate ${index}: ${value} != ${expected[index]}`));
};
const cells = [
  { name: 'orthogonal', vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], bounds: '-2 8\n3 13\n-4 6' },
  { name: 'triclinic', vectors: [10, 0, 0, 2, 10, 0, 1, 3, 10], bounds: '-2 11 2\n3 16 1\n-4 6 3' },
];
const cartesian = (fractional, cell) => [-2, 3, -4].map((origin, axis) => origin
  + fractional[0] * cell.vectors[axis] + fractional[1] * cell.vectors[3 + axis] + fractional[2] * cell.vectors[6 + axis]);

function dump(raw, { cell = cells[0], pbc = 'pp pp pp', wrapped = 'xs', explicit = null, images = [0, 0, 0], explicitRaw = raw } = {}) {
  const columns = ['id', 'type'], values = [1, 1];
  for (const [kind, fractional] of [[wrapped, raw], [explicit, explicitRaw]]) {
    if (!kind) continue;
    columns.push(...['x', 'y', 'z'].map(axis => axis + kind.slice(1)));
    values.push(...(kind.startsWith('xs') ? fractional : cartesian(fractional, cell)));
  }
  columns.push('ix', 'iy', 'iz'); values.push(...images);
  return `ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n1\nITEM: BOX BOUNDS ${cell.name === 'triclinic' ? 'xy xz yz ' : ''}${pbc}\n${cell.bounds}\nITEM: ATOMS ${columns.join(' ')}\n${values.join(' ')}\n`;
}

async function unchangedBySmoothing(frame) {
  const processor = new TrajectoryProcessor({ readFrame: async () => structuredClone(frame), getFrameCount: async () => 2 });
  try {
    const smoothed = structuredClone(frame);
    await processor.prepare(smoothed, 0, { smoothing: 1 });
    near(smoothed.unwrappedPositions, frame.unwrappedPositions);
  } finally { processor.close(); }
}

// Coordinates just beyond a face are legal between LAMMPS neighbor-list
// rebuilds. All column combinations must represent the same continuous atom.
for (const cell of cells) for (const pbc of ['pp pp pp', 'pp ff pp']) {
  test(`dump images stay consistent through parsing, replication and smoothing: ${cell.name}, ${pbc}`, async () => {
    for (const wrapped of ['x', 'xs', null]) for (const explicit of [null, 'xu', 'xsu']) {
      if (!wrapped && !explicit) continue;
      const options = { cell, pbc, wrapped, explicit };
      const text = dump([1.01, -.2, .3], options);
      const expectedFractional = [.01, pbc === 'pp pp pp' ? .8 : -.2, .3];
      const expectedImages = [1, pbc === 'pp pp pp' ? -1 : 0, 0];
      for (const input of [text, encode(text)]) for (const projection of ['full', 'coordinates']) {
        const frame = parseLammpsFrame(input, 'outside.dump', { projection });
        near(frame.fractional, expectedFractional);
        near(frame.positions, cartesian(expectedFractional, cell));
        near(frame.unwrappedPositions, cartesian([1.01, -.2, .3], cell));
        assert.deepEqual([...frame.imageFlags], expectedImages);
      }
      const frame = parseLammpsFrame(text);
      const reference = parseLammpsFrame(dump([.99, -.2, .3], options));
      near((await computeDisplacements(frame, reference)).vectors, [.2, 0, 0]);
      const copies = await Promise.all([reference, frame].map(value => replicateFrame(value, [2, 1, 1])));
      near((await computeDisplacements(copies[1], copies[0])).vectors, [.2, 0, 0, .2, 0, 0]);
      await unchangedBySmoothing(frame);
    }
  });
}

test('dump wrapping adds existing images only on periodic axes, including exact and negative boundaries', () => {
  const text = dump([1, -1, -2], { pbc: 'pp ff pp', images: [2, 0, -3] });
  for (const input of [text, encode(text)]) {
    const frame = parseLammpsFrame(input);
    assert.deepEqual([...frame.imageFlags], [3, 0, -5]);
    near(frame.fractional, [0, -1, 0]);
    near(frame.unwrappedPositions, cartesian([3, -1, -5], cells[0]));
  }
});

test('explicit dump unwrap overrides stale image flags for replication and smoothing', async () => {
  for (const explicit of ['xu', 'xsu']) {
    const frame = parseLammpsFrame(dump([.1, .2, .3], {
      explicit, explicitRaw: [2.1, -1.8, .3], images: [7, 8, 9],
    }));
    assert.deepEqual([...frame.imageFlags], [2, -2, 0]);
    const copies = await replicateFrame(frame, [2, 1, 1]);
    near(copies.unwrappedPositions, [...cartesian([2.1, -1.8, .3], cells[0]), ...cartesian([3.1, -1.8, .3], cells[0])]);
    await unchangedBySmoothing(frame);
  }
});

test('dump image normalization rejects overflow instead of silently wrapping Int32 flags', () => {
  for (const text of [
    dump([1, 0, 0], { images: [2147483647, 0, 0] }),
    dump([-.1, 0, 0], { images: [-2147483648, 0, 0] }),
    dump([2147483648, 0, 0], { wrapped: null, explicit: 'xsu' }),
  ]) for (const input of [text, encode(text)]) {
    assert.throws(() => parseLammpsFrame(input), /Wrapping coordinates requires an image flag outside the supported 32-bit range/);
  }
});

function cfg(values, extended = false) {
  const header = `Number of particles = ${values.length}\nA = 1 Angstrom\n`
    + Array.from({ length: 9 }, (_, index) => `H0(${Math.floor(index / 3) + 1},${index % 3 + 1}) = ${index % 4 === 0 ? 10 : 0}\n`).join('');
  return header + (extended ? '.NO_VELOCITY.\nentry_count = 3\n55.845\nFe\n' : '')
    + values.map(value => `${extended ? '' : '55.845 Fe '}${value} .2 .3\n`).join('');
}

test('CFG boundary snapping and inferred images agree at positive and negative integer faces', () => {
  const values = [1.999999, 2.000001, -1.000001, -.999999, 2.999999, -2.000001];
  const images = [2, 2, -1, -1, 3, -2];
  for (const extended of [false, true]) {
    const text = cfg(values, extended);
    for (const input of [text, encode(text)]) for (const projection of ['full', 'coordinates']) {
      const frame = parseCfg(input, 'boundary.cfg', { projection });
      assert.deepEqual([...frame.imageFlags], images.flatMap(value => [value, 0, 0]));
      near(frame.fractional, values.flatMap(() => [0, .2, .3]));
      near(frame.unwrappedPositions, images.flatMap(value => [value * 10, 2, 3]));
    }
  }
  // The established tolerance around the base cell does not invent history.
  const frame = parseCfg(cfg([1.000001, -.000001]));
  assert.equal(frame.imageFlags, undefined);
  assert.equal(frame.unwrappedPositions, undefined);
});

test('CFG motion near an integer face remains continuous after replication and smoothing', async () => {
  const reference = parseCfg(cfg([1.9999])), frame = parseCfg(cfg([1.999999]));
  near((await computeDisplacements(frame, reference, { minimumImage: false })).vectors, [.001, 0, 0]);
  const copies = await Promise.all([reference, frame].map(value => replicateFrame(value, [2, 1, 1])));
  near((await computeDisplacements(copies[1], copies[0])).vectors, [.001, 0, 0, .001, 0, 0]);
  await unchangedBySmoothing(frame);
});
