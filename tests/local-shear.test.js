import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLocalShear } from '../src/analysis/local-shear.js';
import { crystalFrame } from './helpers/crystals.js';

test('geometric shear of undistorted cubic crystals is zero with modal coordination', () => {
  for (const [kind, cutoff, coordination] of [['sc', 4.01, 6], ['fcc', 3, 12], ['bcc', 3.5, 8]]) {
    const result = calculateLocalShear(crystalFrame(kind, 2), { cutoff });
    assert.equal(result.coordinationMode, coordination, kind);
    assert.ok(result.localShear.every((value) => Math.abs(value) < 1e-7), kind);
    assert.ok(result.coordination.every((value) => value === coordination), kind);
    assert.equal(result.averageCoordination, coordination);
  }
});

test('geometric shear matches AtomEye normalized Mises metric for a homogeneous stretch', () => {
  const frame = crystalFrame('sc', 3, 1);
  frame.cell.vectors[0] *= 1.2;
  const result = calculateLocalShear(frame, { cutoff: 1.3 });
  // Six axial neighbors: M=diag(1.44,1,1)/mean(1.44,1,1).
  const normalizer = (1.44 + 1 + 1) / 3;
  const expected = .44 / normalizer / Math.sqrt(3) / 2;
  assert.ok(result.localShear.every((value) => Math.abs(value - expected) < 1e-7));
  assert.ok(Math.abs(result.averageShear - expected) < 1e-12);
  const subtracted = calculateLocalShear(frame, { cutoff: 1.3, subtractMean: true });
  assert.ok(subtracted.localShear.every((value) => Math.abs(value) < 1e-7));
});

test('geometric shear range uses the complete-frame normalization and mean', () => {
  const frame = crystalFrame('fcc', 3), count = frame.types.length;
  frame.fractional[0] += .02;
  const full = calculateLocalShear(frame, { cutoff: 3.3, subtractMean: true });
  const first = calculateLocalShear(frame, { cutoff: 3.3, subtractMean: true, endAtom: count / 2 });
  const second = calculateLocalShear(frame, { cutoff: 3.3, subtractMean: true, startAtom: count / 2 });
  assert.deepEqual([...first.localShear, ...second.localShear], [...full.localShear]);
  assert.deepEqual([...first.coordination, ...second.coordination], [...full.coordination]);
});

test('empty neighbor geometry remains NaN and does not emit a warning', () => {
  const result = calculateLocalShear(crystalFrame('sc', 1), { cutoff: .01 });
  assert.equal(result.coordinationMode, 0);
  assert.ok(result.localShear.every(Number.isNaN));
  assert.equal(result.warning, null);
});
