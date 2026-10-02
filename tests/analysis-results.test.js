import assert from 'node:assert/strict';
import test from 'node:test';
import { clearAnalysisResults, replaceAnalysisProperty } from '../src/analysis/results.js';
import { estimateFrameBytes } from '../src/data/cache-policy.js';

test('reset restores imported properties overwritten by repeat analysis', () => {
  const imported = { name: 'coordination', data: new Uint32Array([4, 5]) };
  const energy = { name: 'energy', data: new Float32Array([-1, -2]) };
  const frame = { properties: [imported, energy] };
  for (const count of [12, 8]) replaceAnalysisProperty(frame, {
    name: 'coordination', data: new Uint32Array([count, count]), analysisKind: 'coordination',
  });
  assert.equal(estimateFrameBytes(frame), imported.data.byteLength + energy.data.byteLength + 8);
  assert.deepEqual([...clearAnalysisResults(frame, 'coordination')], ['coordination']);
  assert.deepEqual(frame.properties, [imported, energy]);
  assert.equal('analysisOriginalProperties' in frame, false);
});

test('reset removes only its own outputs while independent analysis results remain', () => {
  const frame = { properties: [] };
  for (const [name, analysisKind] of [['ptmStructureType', 'ptm'], ['atomicShearStrain', 'strain'], ['strainE11', 'strain']]) {
    replaceAnalysisProperty(frame, { name, analysisKind, data: new Float32Array([0]) });
  }
  clearAnalysisResults(frame, 'strain');
  assert.deepEqual(frame.properties.map(property => property.name), ['ptmStructureType']);
  assert.equal(clearAnalysisResults(frame, 'strain').size, 0);
});
