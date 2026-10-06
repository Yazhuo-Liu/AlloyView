import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeVoronoiCellControls } from '../src/voronoi-cell-controls.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';

function harness() {
  const elements = Object.fromEntries(['show-voronoi-cell', 'voronoi-cell-color', 'voronoi-cell-opacity', 'voronoi-cell-status']
    .map(id => [id, { listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } }]));
  let frame = { ids: [10, 20], fractional: new Float64Array([0, 0, 0, .5, .5, .5]) }, id = 10, version = 'a';
  const result = { atomicVolume: new Float64Array([8, 9]), voronoiCoordination: new Uint32Array([6, 12]) };
  const jobs = [], rendered = [];
  const renderer = { selected: 0, setVoronoiCellGeometry(geometry, options) { rendered.push({ geometry, options }); } };
  const controls = initializeVoronoiCellControls({ renderer,
    pool: { analyzeCPU(frame, parameters, options) { return new Promise(resolve => jobs.push({ frame, parameters, options, resolve })); } },
    root: { getElementById: id => elements[id] }, getFrame: () => frame, getSelectedId: () => id,
    getSourceVersion: () => version, getResult: () => result });
  const geometry = atomIndex => ({ atomIndex, faceOffsets: new Uint32Array(7) });
  return { controls, elements, jobs, rendered, geometry, getFrame: () => frame,
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
    { enabled: true, color: '#abcdef', opacity: .4 });
  for (const patch of [{ opacity: -1 }, { opacity: 'NaN' }, { color: 'red' }, { vertices: [1, 2, 3] }, { enabled: 'yes' }]) {
    const invalid = structuredClone(recipe); Object.assign(invalid.settings.extensions.voronoiDisplay, patch);
    assert.throws(() => parseConfiguration(JSON.stringify(invalid)), /voronoiDisplay/);
  }
});
