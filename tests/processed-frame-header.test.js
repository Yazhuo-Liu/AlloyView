import test from 'node:test';
import assert from 'node:assert/strict';
import { processedFrameHeader } from '../src/data/processed-frame-header.js';
import { replicateFrame, MAX_PHYSICAL_REPLICATION_ATOMS } from '../src/data/replicate.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { createAttributeRegistry } from '../src/global-attributes.js';

test('header-derived physical attributes match materialized skew and mixed-PBC frames', async () => {
  for (const pbc of [[true, true, true], [true, false, true]]) {
    const frame = crystalFrame('bcc', 2, 2.86);
    frame.cell = createCell({ origin: [7, -5, 2], vectors: [5.72, 1, -.2, -2, 5.72, .7, 1.3, -1, 5.72], pbc });
    frame.positions = fractionalToCartesian(frame.fractional, frame.cell);
    frame.timestep = 175;
    const header = { atomCount: frame.ids.length, cell: frame.cell, timestep: frame.timestep, frameIndex: 4, headerOnly: true };
    const repetitions = [2, pbc[1] ? 3 : 1, 2];
    const actual = processedFrameHeader(header, { physical: true, repetitions });
    const expanded = await replicateFrame(frame, repetitions);
    assert.deepEqual(actual.cell, expanded.cell);
    assert.equal(actual.atomCount, expanded.ids.length);
    const headerAttributes = createAttributeRegistry({ frame: actual, frameIndex: 4, frameCount: 6, referenceCell: frame.cell });
    const expandedAttributes = createAttributeRegistry({ frame: expanded, frameIndex: 4, frameCount: 6, referenceCell: frame.cell });
    for (const name of ['Frame', 'FrameCount', 'Timestep', 'AtomCount', 'NumberDensity', 'Cell.a', 'Cell.b', 'Cell.c',
      'Cell.alpha', 'Cell.beta', 'Cell.gamma', 'Cell.volume', 'Strain.a', 'Strain.b', 'Strain.c', 'Strain.volumetric']) {
      assert.ok(headerAttributes.has(name) && expandedAttributes.has(name), name);
      assert.ok(Object.is(headerAttributes.get(name).value, expandedAttributes.get(name).value), name);
    }
    assert.equal(header.cell, frame.cell);
    assert.equal(header.atomCount, frame.ids.length);
    assert.equal(actual.timestep, frame.timestep);
    assert.equal(actual.ids, undefined, 'the metadata path does not allocate replicated atom arrays');
  }
});

test('header transforms retain ordinary metadata and require valid physical repeats', () => {
  const frame = crystalFrame('fcc', 1, 3.52);
  const header = { atomCount: 4, cell: frame.cell, timestep: null, headerOnly: true };
  assert.equal(processedFrameHeader(header), header);
  const unavailable = { headerUnavailable: true };
  assert.equal(processedFrameHeader(unavailable, { physical: true }), unavailable);
  assert.equal(processedFrameHeader(null), null);
  assert.throws(() => processedFrameHeader({ ...header, atomCount: 0 }, { physical: true }), /positive atom count/);
  assert.throws(() => processedFrameHeader(header, { physical: true, repetitions: [1.5, 1, 1] }), /repeat|integer/i);
  assert.throws(() => processedFrameHeader({ ...header, atomCount: MAX_PHYSICAL_REPLICATION_ATOMS },
    { physical: true, repetitions: [2, 1, 1] }), /limit/);
  const open = { ...header, cell: createCell({ vectors: frame.cell.vectors, pbc: [true, false, true] }) };
  assert.throws(() => processedFrameHeader(open, { physical: true, repetitions: [1, 2, 1] }), /periodic/);
});
