import assert from 'node:assert/strict';
import test from 'node:test';
import { clearAnalysisResults } from '../src/analysis/results.js';
import { registerVectorProperties, vectorPropertyNames } from '../src/analysis/vector-properties.js';
import { estimateFrameBytes } from '../src/data/cache-policy.js';

const frameWithAtoms = count => ({ ids: new Uint32Array(count), properties: [] });
const property = (frame, name) => frame.properties.find(candidate => candidate.name === name);

test('displacement components and magnitude are physical values without glyph settings', () => {
  const frame = frameWithAtoms(2);
  const vectors = new Float64Array([3, -4, 12, 0, 0, 0]);
  const original = [...vectors];
  const result = registerVectorProperties(frame, { mode: 'displacement', vectors, unit: 'ignored' });
  assert.deepEqual(result.names, {
    x: 'displacementX', y: 'displacementY', z: 'displacementZ', magnitude: 'displacementMagnitude',
  });
  assert.deepEqual([...property(frame, 'displacementX').data], [3, 0]);
  assert.deepEqual([...property(frame, 'displacementY').data], [-4, 0]);
  assert.deepEqual([...property(frame, 'displacementMagnitude').data], [13, 0]);
  assert.equal(property(frame, 'displacementMagnitude').displayName, 'Displacement magnitude');
  assert.ok(result.properties.every(item => item.analysisKind === 'displacement' && item.unit === 'Å'));
  assert.deepEqual([...vectors], original);
});

test('a missing or invalid component gives a NaN magnitude while finite components remain available', () => {
  const frame = frameWithAtoms(3);
  registerVectorProperties(frame, { mode: 'generic', vectors: [NaN, NaN, NaN, 3, Infinity, 4, 3e38, 3e38, 3e38] });
  const magnitude = property(frame, 'vectorMagnitude').data;
  assert.ok(Number.isNaN(magnitude[0]));
  assert.ok(Number.isNaN(magnitude[1]));
  assert.equal(property(frame, 'vectorX').data[1], 3);
  assert.ok(Number.isNaN(property(frame, 'vectorY').data[1]));
  assert.ok(Number.isFinite(magnitude[2]));
  assert.equal(magnitude[2], Math.hypot(3e38, 3e38, 3e38));
});

test('force, velocity, displacement and custom fields coexist and recomputation replaces only its mode', () => {
  const frame = frameWithAtoms(1);
  for (const [mode, unit] of [['force', 'eV/Å'], ['velocity', 'Å/ps'], ['displacement', ''], ['generic', '']]) {
    registerVectorProperties(frame, { mode, vectors: [1, 2, 3], unit });
  }
  const force = property(frame, 'forceX');
  const velocity = property(frame, 'velocityX');
  registerVectorProperties(frame, { mode: 'displacement', vectors: [8, 0, 0] });
  assert.equal(frame.properties.length, 16);
  assert.equal(property(frame, 'forceX'), force);
  assert.equal(property(frame, 'velocityX'), velocity);
  assert.equal(property(frame, 'forceMagnitude').unit, 'eV/Å');
  assert.equal(property(frame, 'velocityMagnitude').unit, 'Å/ps');
  assert.equal(property(frame, 'displacementMagnitude').data[0], 8);
  assert.deepEqual([...frame.vectorPropertyResults.keys()], ['force', 'velocity', 'displacement', 'generic']);
});

test('repeated vector results preserve imported name collisions and unrelated analyses for reset', () => {
  const frame = frameWithAtoms(1);
  const imported = { name: 'displacementX', unit: 'Å', data: new Float32Array([99]) };
  const unrelated = { name: 'coordination', analysisKind: 'coordination', data: new Uint32Array([12]) };
  frame.properties.push(imported, unrelated);
  registerVectorProperties(frame, { mode: 'displacement', vectors: [1, 2, 3] });
  registerVectorProperties(frame, { mode: 'displacement', vectors: [4, 5, 6] });
  assert.equal(frame.analysisOriginalProperties.get(imported.name), imported);
  assert.equal(property(frame, 'coordination'), unrelated);
  assert.equal(property(frame, 'displacementX').data[0], 4);
  clearAnalysisResults(frame, 'displacement');
  assert.deepEqual(frame.properties, [imported, unrelated]);
  assert.equal(frame.analysisOriginalProperties, undefined);
});

test('invalid vector shapes and unsupported modes fail before modifying frame properties', () => {
  const frame = frameWithAtoms(2);
  assert.throws(() => registerVectorProperties(frame, { mode: 'displacement', vectors: [1, 2, 3] }), /three components per atom/);
  assert.throws(() => registerVectorProperties(frame, { mode: 'unknown', vectors: new Float32Array(6) }), /Unknown vector source/);
  assert.throws(() => vectorPropertyNames('constructor'), /Unknown vector source/);
  assert.throws(() => registerVectorProperties(frame, { mode: 'force', vectors: new Float32Array(6), unit: null }), /units must be a string/);
  assert.deepEqual(frame.properties, []);
  assert.equal(frame.vectorPropertyResults, undefined);
  assert.deepEqual(vectorPropertyNames('generic'), { x: 'vectorX', y: 'vectorY', z: 'vectorZ', magnitude: 'vectorMagnitude' });
});

test('frame memory estimates count derived Float64 fields and imported backups without retaining repeated results', () => {
  const frame = frameWithAtoms(2);
  const imported = ['forceX', 'forceY', 'forceZ'].map(name => ({ name, data: new Float32Array([1, 2]) }));
  frame.properties.push(...imported);
  const originalBytes = estimateFrameBytes(frame);
  const fieldBytes = 4 * frame.ids.length * Float64Array.BYTES_PER_ELEMENT;
  for (let repeat = 0; repeat < 10; repeat++) {
    registerVectorProperties(frame, { mode: 'force', vectors: [repeat, 2, 3, 4, 5, 6] });
    assert.equal(estimateFrameBytes(frame), originalBytes + fieldBytes);
  }
  registerVectorProperties(frame, { mode: 'displacement', vectors: [1, 2, 3, 4, 5, 6] });
  assert.equal(estimateFrameBytes(frame), originalBytes + 2 * fieldBytes);
  clearAnalysisResults(frame, 'vectors');
  assert.equal(estimateFrameBytes(frame), originalBytes + fieldBytes);
  assert.ok(frame.properties.some(item => item.analysisKind === 'displacement'));
  clearAnalysisResults(frame, 'displacement');
  assert.equal(estimateFrameBytes(frame), originalBytes);
  assert.deepEqual(frame.properties, imported);
});
