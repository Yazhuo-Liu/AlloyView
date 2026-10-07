import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeVoronoiCellControls } from '../src/voronoi-cell-controls.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';

function harness() {
  const elements = Object.fromEntries(['show-voronoi-cell', 'show-all-voronoi-cells', 'voronoi-cell-color', 'voronoi-cell-opacity', 'voronoi-cell-style', 'voronoi-cell-scale', 'voronoi-cell-status', 'voronoi-all-cells-status']
    .map(id => [id, { listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } }]));
  let frame = { ids: [10, 20], fractional: new Float64Array([0, 0, 0, .5, .5, .5]) }, id = 10, version = 'a';
  let result = { atomicVolume: new Float64Array([8, 9]), voronoiCoordination: new Uint32Array([6, 12]) };
  const jobs = [], rendered = [], allRendered = [];
  const renderer = { selected: 0, setVoronoiCellGeometry(geometry, options) { rendered.push({ geometry, options }); },
    setVoronoiAllCellGeometry(geometry, options) { allRendered.push({ geometry, options }); } };
  const controls = initializeVoronoiCellControls({ renderer,
    pool: { analyzeCPU(frame, parameters, options) { return new Promise(resolve => jobs.push({ frame, parameters, options, resolve })); } },
    root: { getElementById: id => elements[id] }, getFrame: () => frame, getSelectedId: () => id,
    getSourceVersion: () => version, getResult: () => result });
  const geometry = atomIndex => ({ atomIndex,
    vertices: Float64Array.from([-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1]),
    faceOffsets: Uint32Array.from([0,4,8,12,16,20,24]),
    faceVertices: Uint32Array.from([0,3,2,1, 4,5,6,7, 0,1,5,4, 3,7,6,2, 0,4,7,3, 1,2,6,5]) });
  return { controls, elements, jobs, rendered, allRendered, geometry, getFrame: () => frame,
    setResult(next) { result = next; },
    select(next) { id = next; renderer.selected = frame.ids.indexOf(next); },
    replace() { frame = { ...frame, fractional: frame.fractional.slice() }; version = 'b'; } };
}

test('cell inspection reuses bounded cached meshes and appearance changes never alter scientific arrays', async () => {
  const h = harness(), input = h.getFrame().fractional.slice();
  const ready = h.controls.restore({ enabled: true, color: '#123456', opacity: .35 });
  assert.deepEqual(h.jobs[0].parameters, { kind: 'voronoiGeometry', atomIndex: 0 });
  const geometry = h.geometry(0); h.jobs[0].resolve(geometry); await ready;
  await h.controls.refresh();
  assert.equal(h.jobs.length, 1);
  h.elements['voronoi-cell-color'].value = '#abcdef';
  h.elements['voronoi-cell-color'].listeners.change();
  assert.equal(h.jobs.length, 1);
  assert.equal(h.rendered.at(-1).geometry, geometry);
  assert.equal(h.rendered.at(-1).options.color, '#abcdef');
  assert.deepEqual(h.getFrame().fractional, input);
  assert.match(h.elements['voronoi-cell-status'].textContent, /volume 8.*coordination 6/);
});

test('late selected-cell responses cannot display a previous selection, source or disabled preview', async () => {
  const h = harness();
  const first = h.controls.restore({ enabled: true });
  h.select(20); const second = h.controls.refresh();
  assert.equal(h.jobs[0].options.signal.aborted, true);
  h.jobs[0].resolve(h.geometry(0)); await first;
  assert.equal(h.rendered.at(-1).geometry, null);
  h.jobs[1].resolve(h.geometry(1)); await second;
  assert.equal(h.rendered.at(-1).geometry.atomIndex, 1);
  h.replace(); const source = h.controls.refresh();
  const disabled = h.controls.restore({ enabled: false }); await disabled;
  h.jobs[2].resolve(h.geometry(1)); await source;
  assert.equal(h.jobs[2].options.signal.aborted, true);
  assert.equal(h.rendered.at(-1).geometry, null);
});

test('cell display recipe stays optional, validates appearance and contains no geometry payload', () => {
  assert.equal(Object.hasOwn(createConfiguration().settings.extensions, 'voronoiDisplay'), false);
  const recipe = createConfiguration({ settings: { extensions: { voronoiDisplay: { enabled: true, color: '#abcdef', opacity: .4 } } } });
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.extensions.voronoiDisplay,
    { enabled: true, allEnabled: false, color: '#abcdef', opacity: .4, style: 'xray', scale: 1 });
  for (const patch of [{ opacity: -1 }, { opacity: 'NaN' }, { color: 'red' }, { vertices: [1, 2, 3] }, { enabled: 'yes' }, { allEnabled: 'yes' }, { style: 'wireframe' }, { scale: .1 }]) {
    const invalid = structuredClone(recipe); Object.assign(invalid.settings.extensions.voronoiDisplay, patch);
    assert.throws(() => parseConfiguration(JSON.stringify(invalid)), /voronoiDisplay/);
  }
});

test('full-cell display defaults off, streams all contributing atoms and reuses packed geometry on appearance/toggle changes', async () => {
  const h = harness();
  await h.controls.refresh();
  assert.equal(h.jobs.length, 0, 'no geometry computation until display is requested');
  assert.equal(h.controls.serialize().allEnabled, false);
  const ready = h.controls.restore({ allEnabled: true, color: '#abcdef', opacity: .45 });
  const job = h.jobs[0];
  assert.equal(job.parameters.kind, 'voronoiGeometryBatch');
  assert.equal(job.options.retainCells, false, 'native polygons are not duplicated in the completed response');
  await job.options.onGeometryChunk([h.geometry(0)], { completedAtoms: 1, totalAtoms: 2 });
  assert.equal(h.allRendered.at(-1).geometry.cellCount, 1);
  await job.options.onGeometryChunk([h.geometry(1)], { completedAtoms: 2, totalAtoms: 2 });
  job.resolve({ cells: [], workerCount: 2 }); await ready;
  const geometry = h.allRendered.at(-1).geometry;
  assert.equal(geometry.cellCount, 2);
  assert.deepEqual(geometry.chunks.map(chunk => [...new Set(chunk.atomIndices)]), [[0], [1]]);
  assert.match(h.elements['voronoi-all-cells-status'].textContent, /2 cells.*2 Workers/);
  await h.controls.restore({ allEnabled: false });
  assert.equal(h.allRendered.at(-1).options.allEnabled, false);
  await h.controls.restore({ allEnabled: true, color: '#123456' });
  assert.equal(h.jobs.length, 1, 'completed CPU and GPU mesh buffers can be reused');
  assert.equal(h.allRendered.at(-1).geometry, geometry);
  assert.equal(h.allRendered.at(-1).options.color, '#123456');
  h.controls.setEnabled(false);
  assert.equal(h.allRendered.at(-1).geometry, null, 'disabling controls also disables a cached full mesh');
  h.controls.setEnabled(true);
  assert.equal(h.allRendered.at(-1).geometry, geometry);
  assert.equal(h.jobs.length, 1);
});

test('subset results govern geometry sites and invalidate both inspection and full-cell meshes', async () => {
  const h = harness();
  const first = h.controls.restore({ enabled: true, allEnabled: true });
  h.jobs[0].resolve(h.geometry(0));
  await h.jobs[1].options.onGeometryChunk([h.geometry(0), h.geometry(1)]);
  h.jobs[1].resolve({ cells: [] }); await first;
  h.setResult({ selectedTypes: ['Ni'], analyzedAtomIndices: Uint32Array.from([1]),
    atomicVolume: Float64Array.from([NaN, 16]), voronoiCoordination: Float64Array.from([NaN, 12]) });
  const changed = h.controls.refresh();
  assert.equal(h.rendered.at(-1).geometry, null, 'excluded selected atom has no inspected cell');
  assert.match(h.elements['voronoi-cell-status'].textContent, /excluded/);
  assert.equal(h.allRendered.at(-1).geometry, null, 'old tessellation disappears while subset geometry is built');
  const batch = h.jobs[2];
  assert.deepEqual(batch.parameters.selectedTypes, ['Ni']);
  assert.deepEqual(Array.from(batch.parameters.atomIndices), [1]);
  await batch.options.onGeometryChunk([h.geometry(1)]);
  batch.resolve({ cells: [] }); await changed;
  assert.equal(h.allRendered.at(-1).geometry.cellCount, 1);
  h.select(20); const inspected = h.controls.refresh();
  assert.deepEqual(h.jobs[3].parameters, { kind: 'voronoiGeometry', atomIndex: 1, selectedTypes: ['Ni'] });
  h.jobs[3].resolve(h.geometry(1)); await inspected;
  assert.equal(h.rendered.at(-1).geometry.atomIndex, 1);
});

test('canceling partial all-cell construction rejects late chunks and source changes cannot republish them', async () => {
  const h = harness();
  const first = h.controls.restore({ allEnabled: true });
  const old = h.jobs[0];
  const uploading = old.options.onGeometryChunk([h.geometry(0)]);
  assert.equal(h.allRendered.at(-1).geometry.cellCount, 1);
  await h.controls.restore({ allEnabled: false });
  await uploading;
  assert.equal(old.options.signal.aborted, true);
  await old.options.onGeometryChunk([h.geometry(1)]);
  old.resolve({ cells: [h.geometry(1)] }); await first;
  assert.equal(h.allRendered.at(-1).geometry, null);
  const fresh = h.controls.restore({ allEnabled: true });
  assert.equal(h.jobs.length, 2, 'incomplete batches are not cached as complete');
  h.replace(); const replaced = h.controls.refresh();
  assert.equal(h.jobs[1].options.signal.aborted, true);
  await h.jobs[1].options.onGeometryChunk([h.geometry(1)]);
  h.jobs[1].resolve({ cells: [] }); await fresh;
  assert.equal(h.allRendered.at(-1).geometry, null);
  await h.jobs[2].options.onGeometryChunk([h.geometry(0), h.geometry(1)]);
  h.jobs[2].resolve({ cells: [] }); await replaced;
  assert.equal(h.allRendered.at(-1).geometry.cellCount, 2);
});

test('all-cell view and cell scale controls reach the renderer without rebuilding cells', async () => {
  const h = harness();
  void h.controls.restore({ allEnabled: true });
  assert.equal(h.elements['voronoi-cell-style'].value, 'xray', 'see-through is the default all-cell view');
  assert.equal(h.elements['voronoi-cell-scale'].value, '1');
  const jobs = h.jobs.length;
  Object.assign(h.elements['show-all-voronoi-cells'], { checked: true });
  Object.assign(h.elements['voronoi-cell-color'], { value: '#3b82f6' });
  Object.assign(h.elements['voronoi-cell-opacity'], { value: '0.5' });
  Object.assign(h.elements['voronoi-cell-style'], { value: 'surface' });
  Object.assign(h.elements['voronoi-cell-scale'], { value: '0.1' });
  h.elements['voronoi-cell-style'].listeners.change();
  assert.equal(h.allRendered.at(-1).options.style, 'surface');
  assert.equal(h.allRendered.at(-1).options.scale, 0.4, 'scale is clamped to the supported range');
  assert.deepEqual(h.controls.serialize(), { enabled: false, allEnabled: true, color: '#3b82f6', opacity: 0.5, style: 'surface', scale: 0.4 });
  assert.equal(h.jobs.length, jobs, 'appearance edits reuse the pending or cached geometry request');
  h.controls.reset();
});
