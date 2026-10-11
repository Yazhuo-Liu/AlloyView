import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeAtomEyeTools } from '../src/atomeye-tools.js';
import { attributeSegment, createAttributeRegistry } from '../src/global-attributes.js';
import { TimeSeriesStore, recordRegistry } from '../src/time-series.js';
import { createCell } from '../src/data/model.js';

async function withAnalysisControls(gpuRequested, run) {
  const oldDocument = globalThis.document, elements = new Map(), errors = [], requests = [];
  const makeElement = () => ({
    value: '1', checked: false, children: [], listeners: {}, dataset: {},
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
    classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
    append(...children) { this.children.push(...children); }, prepend(...children) { this.children.unshift(...children); },
    replaceChildren(...children) { this.children = children; }, addEventListener(name, listener) { this.listeners[name] = listener; },
  });
  globalThis.document = { querySelectorAll: () => [], createElement: makeElement,
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); } };
  const makeFrame = frameIndex => ({ frameIndex, idSource: 'explicit', ids: Uint32Array.of(1, 2),
    types: Uint16Array.of(0, 0), typeLabels: ['Fe'], properties: [],
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }),
    fractional: Float64Array.of(.1, .1, .1, .2, .2, .2), positions: Float64Array.of(1, 1, 1, 2, 2, 2) });
  const frames = [makeFrame(0), makeFrame(1)];
  let frame = frames[0];
  const renderer = { frame, atomCount: 2, setSelectedAtoms() {}, setVectorFields() {}, setBonds() {} };
  const pool = { gpuEnabled: gpuRequested, async analyze(target, parameters) {
    requests.push(parameters);
    const value = parameters.cutoff > 3 ? 18 : 12;
    const common = { elapsedMs: 1, gpuRequested, engine: gpuRequested ? 'webgpu' : 'cpu-workers' };
    if (parameters.kind === 'bonds') return { ...common, coordination: new Uint32Array(2).fill(value), count: value,
      histogram: [{ coordination: value, count: 2 }], meanCoordination: value };
    if (parameters.kind === 'localShear') return { ...common, localShear: Float32Array.of(1, 2) };
    if (parameters.kind === 'referenceStrain') return { ...common,
      referenceShearStrain: Float32Array.of(1, 2), referenceD2min: Float32Array.of(3, 4) };
    return { ...common, vectors: Float32Array.of(1, 2, 3, 4, 5, 6) };
  } };
  try {
    const controls = initializeAtomEyeTools({ renderer, pool, tools: { setToolEnabled() {}, isToolEnabled: () => false },
      getFrame: () => frame, getFrames: () => frames, getFrameAt: async index => frames[index], getFrameIndex: () => frame.frameIndex,
      getFrameCount: () => 2, getSelectedIndex: () => -1, getSourceVersion: () => 1,
      refresh() {}, chooseProperty() {}, getColorMode: () => 'type', notify: error => errors.push(error),
      requestDisplayRefresh() {} });
    elements.get('bonds-cutoff').value = '3';
    elements.get('local-shear-cutoff').value = '3';
    elements.get('reference-cutoff').value = '3';
    await run({ controls, frames, elements, requests, getFrame: () => frame, setFrame(value) {
      frame = value; renderer.frame = value;
    } });
    assert.deepEqual(errors, []);
  } finally {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  }
}

for (const gpuRequested of [false, true]) {
  test(`published bond, shear, reference and displacement outputs use their cached parameter identity (GPU ${gpuRequested})`, async () => {
    await withAnalysisControls(gpuRequested, async ({ controls, getFrame }) => {
      for (const kind of ['bonds', 'localShear', 'referenceStrain']) await controls.run(kind);
      await controls.runDisplacement();
      const frame = getFrame();
      for (const kind of ['bonds', 'localShear', 'referenceStrain', 'displacement']) {
        const properties = frame.properties.filter(property => property.analysisKind === kind);
        assert.ok(properties.length, kind);
        const cacheKey = frame.atomeyeResults[kind].key;
        assert.equal(JSON.parse(cacheKey).gpuRequested, gpuRequested);
        for (const property of properties) {
          if (property.name === 'displacementTile') assert.equal(property.analysisKey, JSON.stringify([cacheKey, frame.atomeyeResults.displacement.tiles.key]));
          else assert.equal(property.analysisKey, cacheKey, property.name);
          const name = property.categories ? `${property.name}.${attributeSegment(property.categories[0].label)}.count` : `Mean.${property.name}`;
          assert.ok(createAttributeRegistry({ frame }).get(name), name);
        }
      }
    });
  });
}

test('bond controller cutoff edits remove older trajectory points while automatic frame changes retain them', async () => {
  await withAnalysisControls(false, async ({ controls, frames, getFrame, setFrame, elements, requests }) => {
    const store = new TimeSeriesStore(), names = ['Mean.bondCoordination'];
    const record = () => recordRegistry(store, createAttributeRegistry({ frame: getFrame() }), getFrame().frameIndex, names);
    await controls.run('bonds'); record();
    setFrame(frames[1]); await controls.run('bonds', { automatic: true }); record();
    assert.equal(store.describe(names[0]).points.size, 2);
    assert.equal(store.value(names[0], 0), 12); assert.equal(store.value(names[0], 1), 12);
    elements.get('bonds-cutoff').value = '4.2';
    await controls.run('bonds'); record();
    assert.equal(requests.length, 3);
    assert.equal(store.has(names[0], 0), false);
    assert.equal(store.value(names[0], 1), 18);
    assert.equal(store.describe(names[0]).points.size, 1);
  });
});
