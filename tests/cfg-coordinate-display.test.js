import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCfg } from '../src/io/cfg.js';
import { fractionalToCartesian } from '../src/data/model.js';
import { ensureFileUnwrappedPositions, fileDisplayPositions, hasFileUnwrap } from '../src/data/coordinate-display.js';

function cfg(rows, { images = true } = {}) {
  return `Number of particles = ${rows.length}\nA = 1 Angstrom\nH0(1,1) = 10\nH0(1,2) = 0\nH0(1,3) = 0\nH0(2,1) = 2\nH0(2,2) = 11\nH0(2,3) = 0\nH0(3,1) = -1\nH0(3,2) = 3\nH0(3,3) = 12\n.NO_VELOCITY.\nentry_count = ${images ? 7 : 4}\n${images ? 'auxiliary[0] = ix\nauxiliary[1] = iy\nauxiliary[2] = iz\nauxiliary[3] = id' : 'auxiliary[0] = id'}\n55.845\nFe\n${rows.join('\n')}\n`;
}

const variants = text => [text, new TextEncoder().encode(text)];

test('deferred CFG unwrapping retains counters and validates rows without building continuous coordinates', () => {
  for (const input of variants(cfg(['.02 .2 .3 3 -1 2 7', '.3 .4 .5 0 0 0 9']))) {
    const ordinary = parseCfg(input);
    const frame = parseCfg(input, 'fixture.cfg', { deferUnwrap: true });
    assert.equal(frame.unwrappedPositions, undefined);
    assert.equal(frame.unwrapSource, 'ix/iy/iz');
    assert.deepEqual(frame.imageFlags, ordinary.imageFlags);
    assert.deepEqual(frame.positions, ordinary.positions);
    assert.deepEqual(frame.fractional, ordinary.fractional);
    assert.equal(fileDisplayPositions(frame), frame.positions);
    assert.equal(frame.filePositions, undefined, 'ordinary in-cell input needs no extra display array');
    assert.equal(hasFileUnwrap(frame), true);
    const continuous = ensureFileUnwrappedPositions(frame);
    assert.deepEqual(continuous, ordinary.unwrappedPositions);
    assert.equal(ensureFileUnwrappedPositions(frame), continuous, 'repeated display toggles reuse the same materialized coordinates');
    assert.deepEqual(frame.positions, ordinary.positions, 'display preparation cannot replace analyzed geometry');
  }
  const invalid = cfg(['.02 .2 .3 1.5 0 0 7']);
  for (const input of variants(invalid)) assert.throws(() => parseCfg(input, 'bad.cfg', { deferUnwrap: true }), /supported 32-bit integer/);
});

test('zero image counters still supply an authoritative single-frame Unwrap source', () => {
  const frame = parseCfg(cfg(['.2 .3 .4 0 0 0 1']), 'fixture.cfg', { deferUnwrap: true });
  assert.equal(frame.unwrappedPositions, undefined);
  assert.equal(hasFileUnwrap(frame), true);
  assert.deepEqual(ensureFileUnwrappedPositions(frame), frame.positions);
});

test('file display preserves out-of-cell CFG positions and never adds image counters', () => {
  for (const input of variants(cfg(['1.2 -.3 2.1 1'], { images: false }))) {
    const frame = parseCfg(input, 'outside.cfg', { deferUnwrap: true });
    const expected = fractionalToCartesian(Float64Array.of(1.2, -.3, 2.1), frame.cell);
    assert.deepEqual(fileDisplayPositions(frame), expected);
    assert.notDeepEqual(frame.positions, expected);
    assert.equal(frame.unwrappedPositions, undefined);
    assert.equal(frame.unwrapSource, 'out-of-cell CFG coordinates');
    assert.equal(hasFileUnwrap(frame), true);
    assert.equal(ensureFileUnwrappedPositions(frame), frame.filePositions, 'continuous source positions are used directly');
  }
  const frame = parseCfg(cfg(['1.2 -.3 2.1 3 -2 4 1']), 'outside-with-images.cfg', { deferUnwrap: true });
  assert.deepEqual(fileDisplayPositions(frame), fractionalToCartesian(Float64Array.of(1.2, -.3, 2.1), frame.cell));
  assert.notDeepEqual(ensureFileUnwrappedPositions(frame), fileDisplayPositions(frame), 'explicit image counters affect only requested Unwrap');
});

test('file display retains boundary coordinates without inventing trajectory history', () => {
  for (const input of variants(cfg(['1 .9999999 -.0000001 1'], { images: false }))) {
    const frame = parseCfg(input, 'boundary.cfg', { deferUnwrap: true });
    assert.deepEqual(fileDisplayPositions(frame), fractionalToCartesian(Float64Array.of(1, .9999999, -.0000001), frame.cell));
    assert.equal(frame.imageFlags, undefined);
    assert.equal(hasFileUnwrap(frame), false, 'round-off normalization is not evidence of a crossing');
    assert.equal(ensureFileUnwrappedPositions(frame), null);
  }
});

test('a CFG without file image information never starts inference through the display helpers', () => {
  const frame = parseCfg(cfg(['.2 .3 .4 1'], { images: false }), 'wrapped.cfg', { deferUnwrap: true });
  assert.equal(fileDisplayPositions(frame), frame.positions);
  assert.equal(hasFileUnwrap(frame), false);
  assert.equal(ensureFileUnwrappedPositions(frame), null);
  assert.equal(ensureFileUnwrappedPositions(null), null);
  assert.equal(fileDisplayPositions(null), null);
});
