import assert from 'node:assert/strict';
import test from 'node:test';
import { OrientationColorResolver, ipfColor, ipfWeights, orientationFamily, orientationSampleDirection,
  rodriguesColor, sampleToCrystalDirection } from '../src/render/orientation-colors.js';

function seededRandom() {
  let seed = 0x317fea49;
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

function orientations(count) {
  const random = seededRandom(), structures = new Uint8Array(count), quaternions = new Float64Array(count * 4);
  const boundaries = [[1, 0, 0, 0], [0, 0, 0, 0], [NaN, 0, 0, 0], [Infinity, 0, 0, 0],
    [1e-13, 0, 0, 0], [1e-12, 0, 0, 0], [Math.cos(Math.PI / 8), 0, 0, Math.sin(Math.PI / 8)],
    [Math.cos(Math.PI / 12), 0, 0, Math.sin(Math.PI / 12)], [Math.SQRT1_2, -Math.SQRT1_2, 0, 0],
    [1, 1e-9, -1e-9, 0], [1, -0, 0, -0], [.5, .5, .5, .5]];
  for (let atom = 0; atom < count; atom++) {
    structures[atom] = atom % 10;
    const scale = 2 ** Math.floor(random() * 1000 - 500);
    const q = atom < boundaries.length * 10 ? boundaries[Math.floor(atom / 10)]
      : Array.from({ length: 4 }, () => (random() * 2 - 1) * scale);
    for (let axis = 0; axis < 4; axis++) quaternions[atom * 4 + axis] = atom % 2 ? -q[axis] : q[axis];
  }
  return { structures, quaternions };
}

function expected(structures, quaternions, ipf, sample) {
  const colors = new Uint8Array(structures.length * 3);
  let undefinedCount = 0;
  for (let atom = 0; atom < structures.length; atom++) {
    const q = quaternions.subarray(atom * 4, atom * 4 + 4), structure = structures[atom];
    const weights = ipf ? ipfWeights(sampleToCrystalDirection(q, sample), structure) : null;
    const defined = ipf ? weights && Math.max(...weights) > 0
      : orientationFamily(structure) && Number.isFinite(Math.hypot(...q)) && Math.hypot(...q) >= 1e-12;
    colors.set(ipf ? ipfColor(q, structure, sample) : rodriguesColor(q, structure), atom * 3);
    if (!defined) undefinedCount++;
  }
  return { colors, undefinedCount };
}

test('scalar PTM colors match the public scientific helpers byte for byte for packed and planar inputs', () => {
  const { structures, quaternions } = orientations(16000), ids = new Uint32Array(structures.length);
  const resolver = new OrientationColorResolver();
  for (const settings of [{ direction: 'x' }, { direction: 'y' }, { direction: 'z' },
    { direction: 'custom', custom: [1, 1, 1] }, { direction: 'custom', custom: [.2, -.6, .9] }]) {
    const sample = orientationSampleDirection(settings);
    for (const ipf of [true, false]) {
      const oracle = expected(structures, quaternions, ipf, sample);
      for (const planar of [false, true]) {
        const properties = [{ name: 'ptmStructureType', data: structures }];
        const frame = { ids, properties };
        if (!planar) frame.ptm = { structures, orientations: quaternions };
        else for (let axis = 0; axis < 4; axis++) properties.push({ name: `ptmOrientation${'WXYZ'[axis]}`,
          data: Float64Array.from(ids, (_, atom) => quaternions[atom * 4 + axis]) });
        const palette = resolver.resolve(frame, `builtin:ptm:${ipf ? 'ipf' : 'quaternion'}`, settings);
        assert.deepEqual(palette.colors, oracle.colors);
        assert.equal(palette.legend.undefinedCount, oracle.undefinedCount);
        assert.deepEqual(palette.legend.keys.map(key => key.family), ipf ? ['cubic', 'hexagonal'] : []);
        assert.equal(resolver.resolve(frame, `builtin:ptm:${ipf ? 'ipf' : 'quaternion'}`, settings), palette);
      }
    }
  }
});

test('scalar grain table colors retain per-grain helper bytes and undefined atom counts', () => {
  const { structures, quaternions } = orientations(4000), grainId = Uint32Array.from({ length: 15000 }, (_, atom) => atom % 4002);
  const frame = { ids: new Uint32Array(grainId.length), properties: [{ name: 'grainId', data: grainId, analysisKind: 'grains' }],
    atomeyeResults: { grains: { result: { grainId, grainCount: structures.length, structureTypes: structures, orientations: quaternions } } } };
  const settings = { direction: 'custom', custom: [-.3, .11, 1] }, sample = orientationSampleDirection(settings);
  for (const ipf of [true, false]) {
    const oracle = expected(structures, quaternions, ipf, sample), colors = new Uint8Array(frame.ids.length * 3);
    let undefinedCount = 0;
    for (let atom = 0; atom < grainId.length; atom++) {
      const grain = grainId[atom] - 1;
      if (grain < 0 || grain >= structures.length) { colors.set([130, 130, 130], atom * 3); undefinedCount++; continue; }
      colors.set(oracle.colors.subarray(grain * 3, grain * 3 + 3), atom * 3);
      const q = quaternions.subarray(grain * 4, grain * 4 + 4), weights = ipf ? ipfWeights(sampleToCrystalDirection(q, sample), structures[grain]) : null;
      if (!(ipf ? weights && Math.max(...weights) > 0 : orientationFamily(structures[grain]) && Number.isFinite(Math.hypot(...q)) && Math.hypot(...q) >= 1e-12)) undefinedCount++;
    }
    const palette = new OrientationColorResolver().resolve(frame, `builtin:grains:${ipf ? 'ipf' : 'quaternion'}`, settings);
    assert.deepEqual(palette.colors, colors);
    assert.equal(palette.legend.undefinedCount, undefinedCount);
  }
});
