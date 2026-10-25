import assert from 'node:assert/strict';
import test from 'node:test';
import { createVisibleAnalysisRequests } from '../src/application/visible-analysis-requests.js';
import { crystalFrame } from './helpers/crystals.js';

const analyses = () => ({
  coordination: { enabled: true, cutoff: 3.4 },
  cna: { enabled: true, parameters: { mode: 'adaptive' } },
  centrosymmetry: { enabled: true, parameters: { mode: 'auto' } },
  ptm: { enabled: true, parameters: { flags: 31, rmsdCutoff: .1 } },
  strain: { enabled: true, parameters: { flags: 1, rmsdCutoff: .1 } },
});
const references = () => [{ structure: 1, a: 4.05, element: 'Al' }];
const parameters = (request, results = []) => typeof request.parameters === 'function' ? request.parameters(results) : request.parameters;

test('visible planning does not calculate unrelated enabled tools or raw coordinates', () => {
  const frame = crystalFrame('fcc', 1);
  for (const quantity of ['type', 'builtin:position:x', 'property:externalEnergy', 'builtin:grains:ipf']) {
    assert.deepEqual(createVisibleAnalysisRequests({ frame, quantity, analyses: analyses(), references: references() }), []);
  }
  const coordination = createVisibleAnalysisRequests({ frame, quantity: 'property:coordination', analyses: analyses() });
  assert.deepEqual(coordination.map(request => parameters(request)), [{ kind: 'coordination', cutoff: 3.4 }]);
});

test('hidden crystal classification is a dependency even under element coloring', () => {
  const frame = crystalFrame('fcc', 1);
  const options = { frame, quantity: 'type', visibilitySource: 'structureType', analyses: analyses() };
  assert.deepEqual(createVisibleAnalysisRequests(options), []);
  assert.deepEqual(createVisibleAnalysisRequests({ ...options, hidden: new Set([1]) }).map(request => parameters(request)), [{ kind: 'cna', mode: 'adaptive' }]);
});

test('Auto CSP borrows exactly the enabled adaptive CNA array without publishing it', () => {
  const frame = crystalFrame('fcc', 1), state = analyses();
  const requests = createVisibleAnalysisRequests({ frame, quantity: 'property:centralSymmetry', analyses: state });
  assert.equal(requests.length, 2); assert.deepEqual(parameters(requests[0]), { kind: 'cna', mode: 'adaptive' });
  const structures = new Uint8Array(frame.ids.length).fill(1);
  assert.deepEqual(parameters(requests[1], [{ structures }]), { kind: 'centrosymmetry', mode: 'auto', structureInput: structures });
  assert.equal(parameters(requests[1], [{ structures }]).structureInput, structures);
  assert.equal(frame.properties.length, 0);
});

test('fixed CNA and manual CSP do not invent an adaptive dependency', () => {
  const frame = crystalFrame('fcc', 1), state = analyses();
  state.cna.parameters = { mode: 'fixed', cutoff: 3.4 };
  let requests = createVisibleAnalysisRequests({ frame, quantity: 'property:centralSymmetry', analyses: state });
  assert.equal(requests.length, 1); assert.deepEqual(parameters(requests[0]), { kind: 'centrosymmetry', mode: 'auto' });
  state.centrosymmetry.parameters = { mode: 'fixed', neighbors: 12, normalization: true };
  requests = createVisibleAnalysisRequests({ frame, quantity: 'property:centralSymmetry', analyses: state });
  assert.deepEqual(parameters(requests[0]), { kind: 'centrosymmetry', mode: 'fixed', neighbors: 12, normalization: true });
  assert.deepEqual(createVisibleAnalysisRequests({ frame, quantity: 'property:centralSymmetryStructureType', analyses: state }), []);
});

test('Auto CSP reuses a real saved adaptive classification when its producer is not enabled', () => {
  const frame = crystalFrame('fcc', 1), state = analyses(), structures = new Uint8Array(frame.ids.length).fill(1);
  state.cna.enabled = false;
  frame.properties.push({ name: 'structureType', analysisKind: 'cna', analysisKey: JSON.stringify({ mode: 'adaptive' }), data: structures });
  const requests = createVisibleAnalysisRequests({ frame, quantity: 'property:centralSymmetryNeighbors', analyses: state });
  assert.equal(requests.length, 1); assert.equal(parameters(requests[0]).structureInput, structures);
});

test('strain borrows the enabled compatible PTM arrays and exact superset flags', () => {
  const frame = crystalFrame('fcc', 1), state = analyses(), refs = references();
  const requests = createVisibleAnalysisRequests({ frame, quantity: 'property:strainE11', analyses: state, references: refs, neighborLists: true });
  assert.equal(requests.length, 2);
  assert.deepEqual(parameters(requests[0]), { kind: 'ptm', flags: 31, rmsdCutoff: .1, neighborLists: true });
  const fit = { structures: new Uint8Array(frame.ids.length), scales: new Float64Array(frame.ids.length) };
  const tensor = parameters(requests[1], [fit]);
  assert.equal(tensor.kind, 'strain'); assert.equal(tensor.flags, 31); assert.equal(tensor.ptmInput, fit); assert.equal(tensor.neighborLists, true);
  assert.deepEqual(tensor.references, refs); assert.notEqual(tensor.references, refs); assert.notEqual(tensor.references[0], refs[0]);
});

test('strain expands reference phase flags and refuses an incompatible PTM fit', () => {
  const frame = crystalFrame('fcc', 1), state = analyses();
  state.ptm.parameters.flags = 1;
  const requests = createVisibleAnalysisRequests({ frame, quantity: 'property:atomicShearStrain', analyses: state,
    references: [{ structure: 3, a: 2.87 }] });
  const tensor = parameters(requests[1], [{ structures: new Uint8Array(frame.ids.length) }]);
  assert.equal(tensor.flags, 5); assert.equal(tensor.ptmInput, undefined);
  assert.equal(state.strain.parameters.flags, 1, 'foreground parameter state is not edited by planning');
});

test('strain uses a compatible current fit while its panel is off and skips missing references', () => {
  const frame = crystalFrame('fcc', 1), state = analyses(); state.ptm.enabled = false;
  frame.ptm = { key: JSON.stringify({ flags: 31, rmsdCutoff: .1 }), structures: new Uint8Array(frame.ids.length) };
  let requests = createVisibleAnalysisRequests({ frame, quantity: 'property:atomicShearStrain', analyses: state, references: references() });
  assert.equal(requests.length, 1); assert.equal(parameters(requests[0]).ptmInput, frame.ptm); assert.equal(parameters(requests[0]).flags, 31);
  requests = createVisibleAnalysisRequests({ frame, quantity: 'property:atomicShearStrain', analyses: state, references: [{ structure: 1, a: null }] });
  assert.deepEqual(requests, []);
});

test('PTM scalar and orientation views request only their actual enabled fit producer', () => {
  const frame = crystalFrame('fcc', 1), state = analyses();
  for (const quantity of ['property:ptmOrientationW', 'property:ptmOrderingType', 'builtin:ptm:ipf', 'builtin:ptm:quaternion']) {
    const requests = createVisibleAnalysisRequests({ frame, quantity, analyses: state });
    assert.equal(requests.length, 1); assert.equal(parameters(requests[0]).kind, 'ptm');
  }
  state.ptm.enabled = false;
  const requests = createVisibleAnalysisRequests({ frame, quantity: 'builtin:ptm:ipf', analyses: state, references: references() });
  assert.equal(requests.length, 1); assert.equal(parameters(requests[0]).kind, 'strain');
});

test('multiple visible dependencies preserve stage indexes and freeze settings across later edits', () => {
  const frame = crystalFrame('fcc', 1), state = analyses(), refs = references();
  const requests = createVisibleAnalysisRequests({ frame, quantity: 'property:centralSymmetry', visibilitySource: 'idealStrainStructureType', hidden: true,
    requiredProperties: ['coordination'], analyses: state, references: refs, neighborLists: true });
  const outputs = [], kinds = [];
  state.cna.parameters.mode = 'fixed'; state.ptm.parameters.flags = 1; refs[0].a = 9;
  for (const request of requests) {
    const input = parameters(request, outputs); kinds.push(input.kind);
    if (input.kind === 'cna') outputs.push({ structures: new Uint8Array(frame.ids.length).fill(1) });
    else if (input.kind === 'ptm') outputs.push({ structures: new Uint8Array(frame.ids.length).fill(2), deformation: new Float64Array(frame.ids.length * 9) });
    else { if (input.kind === 'centrosymmetry') assert.equal(input.structureInput, outputs[1].structures);
      if (input.kind === 'strain') { assert.equal(input.ptmInput, outputs[2]); assert.equal(input.flags, 31); assert.equal(input.references[0].a, 4.05); }
      outputs.push({}); }
  }
  assert.deepEqual(kinds, ['coordination', 'cna', 'ptm', 'centrosymmetry', 'strain']);
});

test('an already calculated target provides a resident result only for the same parameters and backend policy', () => {
  const frame = crystalFrame('fcc', 1), state = analyses(), structures = new Uint8Array(frame.ids.length).fill(1);
  const property = { name: 'structureType', analysisKind: 'cna', analysisKey: JSON.stringify({ mode: 'adaptive' }),
    analysisGpuRequested: false, analysisBackend: 'cpu', analysisEngine: 'js-worker', data: structures };
  frame.properties.push(property);
  const make = options => createVisibleAnalysisRequests({ frame, quantity: 'property:structureType', analyses: state, gpuRequested: false, ...options })[0];
  let request = make(); assert.equal(request.cachedResult([], frame, parameters(request)).structures, structures);
  request = make({ gpuRequested: true }); assert.equal(request.cachedResult([], frame, parameters(request)), undefined);
  request = make({ canReuseResult: () => false }); assert.equal(request.cachedResult([], frame, parameters(request)), undefined);
  property.analysisKey = JSON.stringify({ mode: 'fixed', cutoff: 3.4 });
  request = make(); assert.equal(request.cachedResult([], frame, parameters(request)), undefined);
});

test('resident PTM property preserves a broader strain fit exactly as the foreground cached path does', () => {
  const frame = crystalFrame('fcc', 1), state = analyses(); state.ptm.parameters.flags = 1;
  frame.ptm = { key: JSON.stringify({ flags: 31, rmsdCutoff: .1 }), structures: new Uint8Array(frame.ids.length) };
  frame.properties.push({ name: 'ptmStructureType', analysisKind: 'ptm', analysisKey: JSON.stringify({ flags: 1, rmsdCutoff: .1 }),
    analysisGpuRequested: false, data: frame.ptm.structures });
  const requests = createVisibleAnalysisRequests({ frame, quantity: 'property:atomicShearStrain', analyses: state, references: references(), gpuRequested: false });
  const first = requests[0].cachedResult([], frame, parameters(requests[0]));
  const tensor = parameters(requests[1], [first]);
  assert.equal(tensor.flags, 31); assert.equal(tensor.ptmInput.structures, frame.ptm.structures);
});
