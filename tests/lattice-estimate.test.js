import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePtm } from '../src/analysis/ptm.js';
import { calculateAtomicStrain } from '../src/analysis/atomic-strain.js';
import { estimateLatticeReferences } from '../src/analysis/lattice-estimate.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

function deform(frame, matrix) {
  const vectors = [];
  for (let axis = 0; axis < 3; axis += 1) for (let row = 0; row < 3; row += 1) {
    vectors.push(matrix.slice(row * 3, row * 3 + 3)
      .reduce((sum, value, k) => sum + value * frame.cell.vectors[axis * 3 + k], 0));
  }
  return { ...frame, cell: createCell({ vectors, pbc: frame.cell.pbc, triclinic: true }) };
}

// Independent crystal domains leave free surfaces and genuinely unmatched atoms;
// every fit is produced by the real neighbor search and WebAssembly PTM kernel.
function domains(specifications) {
  const fractional = [], types = [];
  for (const [kind, repeat, a, type, offset] of specifications) {
    const crystal = crystalFrame(kind, repeat, a);
    for (let atom = 0; atom < crystal.types.length; atom += 1) {
      const p = atom * 3;
      fractional.push((crystal.positions[p] + offset) / 80,
        (crystal.positions[p + 1] + 10) / 80, (crystal.positions[p + 2] + 10) / 80);
      types.push(type);
    }
  }
  return { fractional: Float64Array.from(fractional), types: Uint16Array.from(types),
    cell: createCell({ vectors: [80, 0, 0, 0, 80, 0, 0, 0, 80], pbc: [false, false, false] }) };
}

for (const [kind, structure, a] of [['fcc', 1, 3.61], ['bcc', 3, 2.87], ['sc', 5, 3.35], ['diamond', 6, 5.43]]) {
  test(`real PTM geometry estimates conventional ${kind} a without assigning an element`, async () => {
    const frame = crystalFrame(kind, 3, a);
    const [estimate] = await estimateLatticeReferences(frame, await calculatePtm(frame, { flags: 255 }));
    assert.equal(estimate.status, 'estimated');
    assert.equal(estimate.structure, structure);
    assert.equal(estimate.element, '');
    assert.equal(estimate.sampleCount, frame.types.length);
    assert.equal(estimate.phaseCounts[structure], frame.types.length);
    close(estimate.a, a);
  });
}

for (const [kind, structure] of [['hcp', 2], ['hex-diamond', 7]]) {
  test(`real PTM estimates independent ${kind} a and nonideal c/a after rotation`, async () => {
    const a = 3.21, c = a * 1.624, angle = .71;
    const frame = deform(crystalFrame(kind, 3, a), [Math.cos(angle), -Math.sin(angle), 0,
      Math.sin(angle), Math.cos(angle), 0, 0, 0, 1.624 / Math.sqrt(8 / 3)]);
    const ptm = await calculatePtm(frame, { flags: 255 });
    const [estimate] = await estimateLatticeReferences(frame, ptm);
    assert.equal(estimate.status, 'estimated');
    assert.equal(estimate.structure, structure);
    close(estimate.a, a);
    close(estimate.c, c);
    const strain = await calculateAtomicStrain(frame, { references: [estimate], ptmInput: ptm });
    assert.ok(strain.atomicHydrostaticStrain.every(value => Math.abs(value) < 1e-6));
    assert.ok(strain.atomicShearStrain.every(value => Math.abs(value) < 1e-6));
  });
}

test('numeric species with different local crystals receive separate lengths despite free surfaces', async () => {
  const frame = domains([['fcc', 4, 3.6, 0, 5], ['bcc', 5, 2.86, 1, 40]]);
  const estimates = await estimateLatticeReferences(frame, await calculatePtm(frame, { flags: 255 }));
  assert.equal(estimates.length, 2);
  assert.deepEqual(estimates.map(estimate => estimate.structure), [1, 3]);
  close(estimates[0].a, 3.6);
  close(estimates[1].a, 2.86);
  assert.ok(estimates.every(estimate => estimate.sampleCount < estimate.totalCount));
  assert.ok(estimates.every(estimate => estimate.element === ''));
});

test('mixed crystal phases remain ambiguous rather than averaging unlike lattice parameters', async () => {
  const frame = domains([['fcc', 4, 3.6, 0, 5], ['bcc', 5, 2.86, 0, 40]]);
  const [estimate] = await estimateLatticeReferences(frame, await calculatePtm(frame, { flags: 255 }));
  assert.equal(estimate.status, 'ambiguous');
  assert.equal(estimate.reason, 'mixed-phases');
  assert.ok(estimate.phaseCounts[1] > 0 && estimate.phaseCounts[3] > 0);
  assert.equal(estimate.structure, null);
  assert.equal(estimate.a, null);
});

test('a strongly dominant crystalline phase supplies its own median despite a minority phase', async () => {
  const frame = domains([['fcc', 6, 3.6, 0, 5], ['bcc', 3, 2.86, 0, 40]]);
  const [estimate] = await estimateLatticeReferences(frame, await calculatePtm(frame, { flags: 255 }));
  assert.equal(estimate.status, 'estimated');
  assert.equal(estimate.structure, 1);
  assert.ok(estimate.phaseCounts[3] > 0);
  assert.ok(estimate.dominantFraction >= .8);
  close(estimate.a, 3.6);
});

test('vacancy disorder excludes unmatched atoms while the bulk median retains the lattice constant', async () => {
  let frame = crystalFrame('fcc', 5, 4);
  const fractional = [];
  for (let atom = 0; atom < frame.types.length; atom += 1) {
    if (atom % 23) fractional.push(...frame.fractional.subarray(atom * 3, atom * 3 + 3));
  }
  frame = { ...frame, fractional: Float64Array.from(fractional), types: new Uint16Array(fractional.length / 3) };
  const [estimate] = await estimateLatticeReferences(frame, await calculatePtm(frame, { flags: 255 }));
  assert.equal(estimate.status, 'estimated');
  assert.ok(estimate.sampleCount > 100 && estimate.sampleCount < estimate.totalCount);
  assert.ok(estimate.phaseCounts[0] > 0);
  close(estimate.a, 4);
});

test('current-frame expansion is retained rather than confused with a stress-free material prediction', async () => {
  const a = 3.61, dilation = 1.04;
  const frame = deform(crystalFrame('fcc', 3, a), [dilation, .05, 0, 0, dilation, 0, 0, 0, dilation]);
  const [estimate] = await estimateLatticeReferences(frame, await calculatePtm(frame, { flags: 255 }));
  close(estimate.a, a * dilation);
});

test('CNA labels and partial PTM fits cannot supply a length; isolated atoms cannot supply a reference', async () => {
  const frame = crystalFrame('fcc', 3);
  const ptm = await calculatePtm(frame, { flags: 255 });
  await assert.rejects(estimateLatticeReferences(frame, { structures: ptm.structures }), /complete PTM geometric fit/);
  await assert.rejects(estimateLatticeReferences(frame, { ...ptm, startAtom: 1 }), /complete PTM geometric fit/);
  const isolated = { fractional: new Float64Array([.5, .5, .5]), types: new Uint16Array(1),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  const [estimate] = await estimateLatticeReferences(isolated, await calculatePtm(isolated));
  assert.equal(estimate.status, 'insufficient');
  assert.equal(estimate.a, null);
});

test('icosahedral coordination and overly loose PTM fits do not supply bulk reference lengths', async () => {
  const phi = (1 + Math.sqrt(5)) / 2, xyz = [0, 0, 0];
  for (const a of [-1, 1]) for (const b of [-phi, phi]) xyz.push(0, a, b, a, b, 0, b, 0, a);
  const ico = { fractional: Float64Array.from(xyz, x => .5 + x / 10), types: new Uint16Array(xyz.length / 3),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  const ptm = await calculatePtm(ico, { flags: 8 });
  const [estimate] = await estimateLatticeReferences(ico, ptm, { minSamples: 1 });
  assert.equal(estimate.status, 'insufficient');
  assert.equal(estimate.a, null);
  assert.equal(estimate.phaseCounts[4], 1);
  const noisy = crystalFrame('fcc', 3);
  for (let i = 0; i < noisy.fractional.length; i += 1) noisy.fractional[i] += Math.sin(i * 12.9898) * .01;
  const loose = await calculatePtm(noisy, { rmsdCutoff: 0, flags: 255 });
  assert.ok(loose.structures.some(id => id > 0));
  const [strict] = await estimateLatticeReferences(noisy, loose, { rmsdCutoff: .00001 });
  assert.equal(strict.status, 'insufficient');
  assert.equal(strict.sampleCount, 0);
});

test('estimation respects cancellation before touching a fitted frame', async () => {
  const frame = crystalFrame('bcc', 3), ptm = await calculatePtm(frame, { flags: 255 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(estimateLatticeReferences(frame, ptm, { signal: controller.signal }), { name: 'AbortError' });
});
