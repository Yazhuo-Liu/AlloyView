import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisProgressText, analysisBackendLabel, analysisBackendDetails } from '../src/analysis/status.js';

test('analysis status reports actual GPU phases and CPU fallback without calling GPU lanes Workers', () => {
  assert.equal(analysisProgressText({ backend: 'gpu', phase: 'initializing' }), 'Initializing WebGPU…');
  assert.equal(analysisProgressText({ backend: 'gpu', phase: 'preparing' }, { frameIndex: 2 }), 'Uploading frame 3 to the GPU…');
  assert.equal(analysisProgressText({ backend: 'gpu', phase: 'analyzing', completedAtoms: 50, totalAtoms: 100 }),
    'Analyzing frame 1 with WebGPU… 50 / 100 atoms');
  const fallback = { engine: 'js-worker-pool×6', fallbackReason: 'WebGPU is unavailable.' };
  assert.equal(analysisBackendLabel(fallback), 'js-worker-pool×6 · CPU fallback');
  assert.equal(analysisBackendDetails(fallback), 'CPU fallback: WebGPU is unavailable.');
  assert.match(analysisProgressText({ backend: 'cpu', phase: 'analyzing', workerCount: 6, total: 6 }), /6 Workers/);
});

test('ideal strain status distinguishes GPU neighbor preparation, CPU template fitting, and GPU reference tensors', () => {
  assert.equal(analysisProgressText({ backend: 'gpu', phase: 'indexing', stage: 'ptm-neighbors' }),
    'Preparing PTM neighbors with WebGPU for frame 1…');
  assert.equal(analysisProgressText({ backend: 'cpu', phase: 'indexing', stage: 'ptm-fit' }),
    'Preparing crystal template fitting for frame 1…');
  assert.equal(analysisProgressText({ backend: 'cpu', phase: 'analyzing', stage: 'ptm-fit', workerCount: 2,
    completedAtoms: 100, totalAtoms: 300 }), 'Fitting crystal templates for frame 1 with 2 CPU Workers… 100 / 300 atoms');
  assert.equal(analysisProgressText({ backend: 'gpu', phase: 'analyzing', stage: 'strain-tensor',
    completedAtoms: 300, totalAtoms: 300 }), 'Calculating lattice-reference strain with WebGPU for frame 1… 300 / 300 atoms');
});
