import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExternalProperties, mapExternalProperties, normalizeExternalPropertyState, validateExternalPropertyAllocation } from '../src/io/external-properties.js';

const options = { frameIds: [11, 22, 33], idSource: 'explicit', frameIndex: 2 };

test('CSV IDs anchor attributes to atoms without modifying coordinates', () => {
  const bundle = parseExternalProperties('id,x,stress [GPa],force_x\n33,9,3,6\n11,7,1,4\n22,8,2,5\n', options);
  const frame = { ids: [22, 33, 11], idSource: 'explicit', positions: new Float32Array([2, 2, 2]), frameIndex: 8 };
  const positions = frame.positions.slice();
  const fields = mapExternalProperties(bundle, frame);
  assert.deepEqual(fields.map(field => field.name), ['x', 'stress', 'force_x']);
  assert.deepEqual([...fields[0].data], [8, 9, 7]);
  assert.deepEqual([...fields[1].data], [2, 3, 1]);
  assert.equal(fields[1].unit, 'GPa');
  assert.deepEqual(frame.positions, positions);
  assert.equal(bundle.manifest.scope, 'all-frames');
});

test('numeric AUX row order is anchored to baseline stable IDs', () => {
  const bundle = parseExternalProperties('1 4\n2 5\n3 6\n', options);
  assert.equal(bundle.manifest.mapping, 'row-order');
  const reordered = mapExternalProperties(bundle, { ids: [33, 11, 22], idSource: 'explicit', frameIndex: 9 });
  assert.deepEqual([...reordered[0].data], [3, 1, 2]);
  assert.deepEqual(reordered.map(column => column.name), ['aux_1', 'aux_2']);
  reordered[0].data[0] = 100;
  assert.deepEqual([...mapExternalProperties(bundle, { ids: [33, 11, 22], idSource: 'explicit' })[0].data], [3, 1, 2]);
});

test('CSV blanks and NaN are missing attributes while Infinity is rejected', () => {
  const bundle = parseExternalProperties('id,energy\n11,NaN\n22,\n33,1D-3\n', options);
  assert.ok(Number.isNaN(bundle.columns[0].data[0]));
  assert.ok(Number.isNaN(bundle.columns[0].data[1]));
  assert.equal(bundle.columns[0].data[2], 0.001);
  for (const value of ['Inf', '-Infinity', '1e309', 'not-a-number']) {
    assert.throws(() => parseExternalProperties(`id,energy\n11,${value}\n22,2\n33,3`, options), /infinite|numeric/);
  }
  assert.throws(() => parseExternalProperties('id,energy\nNaN,1\n22,2\n33,3', options), /safe integer/);
  assert.throws(() => parseExternalProperties('id,energy\n,1\n22,2\n33,3', options), /non-empty atom ID/);
  const zero = parseExternalProperties('id,energy\n0,1\n22,2\n33,3', { ...options, frameIds: [0, 22, 33] });
  assert.deepEqual([...mapExternalProperties(zero, { ids: [22, 0, 33], idSource: 'explicit' })[0].data], [2, 1, 3]);
});

test('exact counts and unique known IDs are required before mapping', () => {
  for (const [text, pattern] of [
    ['id,value\n11,1\n22,2', /2 attribute rows/],
    ['id,value\n11,1\n22,2\n33,3\n44,4', /4 attribute rows/],
    ['id,value\n11,1\n22,2\n22,3', /repeats atom ID/],
    ['id,value\n11,1\n22,2\n44,3', /Unknown atom ID/],
    ['id,value\n11,1\n22,2\n33', /expected 2/],
    ['id,id,value\n11,11,1\n22,22,2\n33,33,3', /duplicate column/],
    ['value,value\n1,1\n2,2\n3,3', /duplicate column/],
  ]) assert.throws(() => parseExternalProperties(text, options), pattern);
  const bundle = parseExternalProperties('1\n2\n3', options);
  assert.throws(() => mapExternalProperties(bundle, { ids: [11, 22, 44], idSource: 'explicit' }), /no attributes/);
  assert.throws(() => mapExternalProperties(bundle, { ids: [11, 22], idSource: 'explicit' }), /this frame has 2/);
  assert.throws(() => mapExternalProperties(bundle, { ids: [11, 22, 22], idSource: 'explicit' }), /duplicate atom IDs/);
});

test('properties cannot shadow input or reserved analysis fields', () => {
  for (const name of ['coordination', 'structureType', 'referenceF32', 'displacementX', 'positions', '__proto__']) {
    assert.throws(() => parseExternalProperties(`id,${name}\n11,1\n22,2\n33,3`, options), /built-in|printable/);
  }
  assert.throws(() => parseExternalProperties('1\n2\n3', { ...options, names: ['mass'], existingNames: ['mass'] }), /already exists/);
  const renamed = parseExternalProperties('id,coordination\n11,1\n22,2\n33,3', { ...options, names: ['imported_coordination'] });
  assert.equal(renamed.manifest.columns[0].sourceName, 'coordination');
  assert.equal(renamed.manifest.columns[0].name, 'imported_coordination');
});

test('imported force, velocity and custom vector families are allowed when absent from the frame', () => {
  const names = ['forceX', 'forceY', 'forceZ', 'forceMagnitude', 'velocityX', 'velocityY', 'velocityZ', 'velocityMagnitude', 'vectorX', 'vectorY', 'vectorZ', 'vectorMagnitude'];
  const text = `id,${names.join(',')}\n11,${names.map((_, index) => index + 1).join(',')}\n22,${names.map((_, index) => index + 2).join(',')}\n33,${names.map((_, index) => index + 3).join(',')}`;
  const bundle = parseExternalProperties(text, options);
  assert.deepEqual(bundle.manifest.columns.map(column => column.name), names);
  assert.deepEqual([...mapExternalProperties(bundle, { ids: [33, 11, 22], idSource: 'explicit' })[0].data], [3, 1, 2]);
  assert.deepEqual(normalizeExternalPropertyState({ files: [bundle.manifest] }).files[0].columns.map(column => column.name), names);
  for (const existing of ['forceX', 'VELOCITYY', 'vectorMagnitude']) {
    assert.throws(() => parseExternalProperties(text, { ...options, existingNames: [existing] }), /already exists/);
  }
  assert.throws(() => parseExternalProperties('id,displacementMagnitude\n11,1\n22,2\n33,3', options), /built-in or analysis property/);
});

test('synthetic atom IDs explicitly restrict imports to a single frame', () => {
  const bundle = parseExternalProperties('1\n2\n3', { ...options, idSource: 'row-order' });
  assert.equal(bundle.manifest.scope, 'single-frame');
  assert.deepEqual(mapExternalProperties(bundle, { ids: [11, 22, 33], idSource: 'row-order', frameIndex: 3 }), []);
  assert.deepEqual([...mapExternalProperties(bundle, { ids: [11, 22, 33], idSource: 'row-order', frameIndex: 2 })[0].data], [1, 2, 3]);
  const stable = parseExternalProperties('1\n2\n3', options);
  assert.throws(() => mapExternalProperties(stable, { ids: [11, 22, 33], idSource: 'row-order' }), /requires stable atom IDs/);
});

test('quoted CSV and commented whitespace headers preserve source names and units', () => {
  const csv = parseExternalProperties('"id","stress, tensile [GPa]"\n11,1\n22,2\n33,3', options);
  assert.equal(csv.manifest.columns[0].name, 'stress, tensile');
  assert.equal(csv.manifest.columns[0].unit, 'GPa');
  const aux = parseExternalProperties('# columns: fx fy\n1 2\n3 4\n5 6', options);
  assert.deepEqual(aux.manifest.columns.map(column => column.name), ['fx', 'fy']);
  assert.throws(() => parseExternalProperties('"id","energy\n11,1\n22,2\n33,3', options), /unclosed CSV quote/);
});

test('portable manifests contain only validated file metadata and column mappings', () => {
  const bundle = parseExternalProperties('1\n2\n3', options);
  const state = normalizeExternalPropertyState({ files: [bundle.manifest] });
  assert.ok(JSON.stringify(state).length < 600);
  assert.ok(!JSON.stringify(state).includes('data'));
  assert.throws(() => normalizeExternalPropertyState({ files: [{ ...bundle.manifest, data: [1, 2, 3] }] }), /Unexpected/);
  assert.throws(() => normalizeExternalPropertyState({ files: [{ ...bundle.manifest, columns: [{ ...bundle.manifest.columns[0], data: [1, 2, 3] }] }] }), /Unexpected/);
  assert.throws(() => normalizeExternalPropertyState({ files: [{ ...bundle.manifest, file: { ...bundle.manifest.file, name: '../bad.aux' } }] }), /filename/);
  assert.throws(() => normalizeExternalPropertyState({ files: [bundle.manifest, bundle.manifest] }), /unique/);
});

test('large auxiliary and physical-replica allocations are rejected before buffers are created', () => {
  assert.doesNotThrow(() => validateExternalPropertyAllocation(1_000_000, 8));
  assert.throws(() => validateExternalPropertyAllocation(4_000_000, 4096), /memory limit/);
  assert.throws(() => validateExternalPropertyAllocation(Infinity, 3), /memory limit/);
});
