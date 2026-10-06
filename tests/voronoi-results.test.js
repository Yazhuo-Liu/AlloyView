import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeVoronoiResults, renderVoronoiHistogram, voronoiOverview } from '../src/render/voronoi-results.js';

class Element {
  constructor(root, tag) {
    this.ownerDocument = root; this.tagName = tag; this.children = []; this.attributes = {};
    this.listeners = new Map(); this.textContent = ''; this.style = {}; this.value = ''; this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name, event = {}) { this.listeners.get(name)?.({ target: this, ...event }); }
  all(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.all(tag)]); }
  text() { return [this.textContent, ...this.children.map(child => child.text())].join(' '); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 0, width: 360 }; }
}

function documentRoot() {
  const root = { createElement: tag => new Element(root, tag), createElementNS: (_, tag) => new Element(root, tag) };
  return root;
}

function result() {
  return {
    atomicVolume: Float64Array.of(1, 2, 3), voronoiCoordination: Uint32Array.of(4, 6, 8),
    voronoiSurfaceArea: Float64Array.of(6, 8, 10), voronoiMaxFaceOrder: Uint32Array.of(4, 5, 6), voronoiBoundaryFaces: Uint8Array.of(1, 0, 0),
    summary: { atomCount: 3, meanVolume: 2, meanSurfaceArea: 8, meanCoordination: 6,
      boundaryAtomCount: 1, totalVolume: 6, cellVolume: 6, volumeError: 0 },
    indexCounts: [{ index: '<0,6,0,0>', count: 2 }, { index: '<0,6,0,8>', count: 1 }],
    volumeHistogram: [{ lower: 1, upper: 2, count: 1, fraction: 1 / 3 }, { lower: 2, upper: 3, count: 2, fraction: 2 / 3 }],
    coordinationHistogram: [{ value: 4, count: 1 }, { value: 6, count: 1 }, { value: 8, count: 1 }],
    faceAreaHistogram: [{ lower: .5, upper: 1, count: 12 }],
  };
}

test('Voronoi overview retains actual ranges, complete population and unavailable domain checks', () => {
  const input = result(), overview = voronoiOverview(input);
  assert.equal(overview.meanVolume, 2); assert.equal(overview.minVolume, 1); assert.equal(overview.maxVolume, 3);
  assert.equal(overview.minCoordination, 4); assert.equal(overview.maxCoordination, 8);
  assert.equal(overview.dominantIndex, '<0,6,0,0>'); assert.equal(overview.dominantFraction, 2 / 3);
  assert.equal(overview.boundaryFraction, 1 / 3); assert.equal(overview.volumeError, 0);
  input.summary.volumeError = null;
  assert.equal(voronoiOverview(input).volumeError, null);
  assert.deepEqual(Array.from(input.atomicVolume), [1, 2, 3]);
});

test('interactive Voronoi bins expose exact counts and update through touch, slider and keyboard', () => {
  const root = documentRoot(), container = root.createElement('div');
  renderVoronoiHistogram(container, [{ lower: 0, upper: 1, count: 163840 }, { lower: 1, upper: 2, count: 491520 }], { label: 'Volumes', unit: 'Å³' });
  const svg = container.all('svg')[0], slider = container.all('input')[0], output = container.all('output')[0];
  assert.match(output.textContent, /163,840 samples · 25%/);
  slider.value = '1'; slider.dispatch('input'); assert.match(output.textContent, /491,520 samples · 75%/);
  let prevented = false;
  svg.dispatch('keydown', { key: 'Home', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(slider.value, '0');
  svg.dispatch('pointerdown', { clientX: 300, pointerType: 'touch' }); assert.equal(slider.value, '1');
  svg.dispatch('pointermove', { clientX: 80, pointerType: 'touch' }); assert.equal(slider.value, '1', 'touch scrolling does not scrub the plot');
  svg.dispatch('pointermove', { clientX: 80, pointerType: 'mouse' }); assert.equal(slider.value, '0');
  container.all('button')[1].dispatch('click');
  assert.equal(container.all('button')[1].attributes['aria-pressed'], 'true');
  assert.equal(container.all('text').some(element => element.textContent === 'Probability'), true);
  assert.equal(container.all('text').some(element => element.textContent === '75%'), true);
  assert.match(output.textContent, /163,840 samples · 25%/);
  assert.equal(container.all('path').filter(element => element.attributes.class === 'chart-bar').length, 1);
});

test('constant and sparse coordination histograms preserve the sample coordinate and nearest discrete bin', () => {
  const root = documentRoot(), constant = root.createElement('div');
  renderVoronoiHistogram(constant, [{ lower: 8, upper: 8, count: 20 }], { label: 'Volumes', unit: 'Å³' });
  assert.match(constant.all('output')[0].textContent, /^8 Å³ · 20 samples · 100%/);
  assert.equal(constant.all('path').some(element => /NaN|Infinity/.test(element.attributes.d ?? '')), false);
  const discrete = root.createElement('div');
  renderVoronoiHistogram(discrete, [{ value: 4, count: 2 }, { value: 8, count: 3 }], { xLabel: 'Neighbors', discrete: true });
  assert.equal(discrete.all('text').some(element => element.textContent === '3.5' || element.textContent === '8.5'), false);
  assert.equal(discrete.all('text').some(element => element.textContent === '4'), true);
  discrete.all('svg')[0].dispatch('pointerdown', { clientX: 176 });
  assert.match(discrete.all('output')[0].textContent, /^Neighbors 4 · 2 samples/);
  discrete.all('svg')[0].dispatch('pointerdown', { clientX: 205 });
  assert.match(discrete.all('output')[0].textContent, /^Neighbors 8 · 3 samples/);
});

test('narrow volume bins retain distinct readable limits without changing their numerical data', () => {
  const root = documentRoot(), container = root.createElement('div');
  const rows = [{ lower: 16.000001, upper: 16.000002, count: 1 }, { lower: 16.000002, upper: 16.000003, count: 2 }];
  renderVoronoiHistogram(container, rows, { unit: 'Å³' });
  assert.match(container.all('output')[0].textContent, /16\.000001–16\.000002 Å³/);
  assert.equal(container.all('text').some(element => element.textContent === '16.000001'), true);
  assert.deepEqual(rows.map(row => row.lower), [16.000001, 16.000002]);
});

test('Voronoi charts keep numerical tables lazy and bounded while retaining every bin', () => {
  const root = documentRoot(), container = root.createElement('div');
  const rows = Array.from({ length: 4096 }, (_, index) => ({ lower: index, upper: index + 1, count: 1 }));
  renderVoronoiHistogram(container, rows, { label: 'Volumes' });
  assert.equal(container.all('table').length, 0);
  assert.equal(container.all('path').length, 2);
  const details = container.all('details')[0]; details.open = true; details.dispatch('toggle');
  assert.equal(container.all('tbody')[0].children.length, 50);
  const next = container.all('button').at(-1); next.dispatch('click');
  assert.equal(container.all('tbody')[0].children[0].children[0].textContent, '50');
  assert.equal(container.all('tbody')[0].children.length, 50);
  assert.equal(root.activeElement, container.all('button').at(-1));
  details.open = false; details.dispatch('toggle'); details.open = true; details.dispatch('toggle');
  assert.equal(container.all('table').length, 1);
});

test('Voronoi cards, color shortcuts, leading index bars and lazy full population share one result lifecycle', () => {
  const root = documentRoot(), ids = {};
  for (const id of ['voronoi-stat-cards', 'voronoi-topology-populations', 'voronoi-index-frequency', 'voronoi-volume-chart',
    'voronoi-coordination-chart', 'voronoi-face-chart', 'voronoi-color-volume', 'voronoi-color-coordination',
    'voronoi-color-surface', 'voronoi-color-face-order', 'voronoi-color-boundary', 'voronoi-topology-details']) ids[id] = root.createElement(id.includes('color-') ? 'button' : 'div');
  const chosen = [], view = initializeVoronoiResults({ getElement: id => ids[id], chooseProperty: (...args) => chosen.push(args) });
  const input = result();
  input.indexCounts = Array.from({ length: 103 }, (_, index) => ({ index: `index-${index}`, count: index + 1 }));
  view.setEnabled(true); view.render(input);
  assert.equal(ids['voronoi-stat-cards'].children.length, 6);
  assert.match(ids['voronoi-stat-cards'].text(), /Range 4–8/);
  assert.match(ids['voronoi-stat-cards'].text(), /Within 0.01%/);
  assert.equal(ids['voronoi-topology-populations'].children.length, 7);
  assert.match(ids['voronoi-topology-populations'].children[0].text(), /index-102/);
  assert.equal(ids['voronoi-index-frequency'].all('table').length, 0);
  ids['voronoi-color-coordination'].dispatch('click');
  assert.deepEqual(chosen, [['voronoiCoordination', { manual: true }]]);
  ids['voronoi-topology-details'].open = true; ids['voronoi-topology-details'].dispatch('toggle');
  assert.equal(ids['voronoi-index-frequency'].all('tbody')[0].children.length, 50);
  view.setEnabled(false); assert.equal(ids['voronoi-color-volume'].disabled, true);
  ids['voronoi-color-volume'].dispatch('click'); assert.equal(chosen.length, 1);
  view.clear(); assert.equal(ids['voronoi-stat-cards'].children.length, 0);
  assert.equal(ids['voronoi-index-frequency'].children.length, 0);
  assert.equal(ids['voronoi-color-coordination'].disabled, true);
});
