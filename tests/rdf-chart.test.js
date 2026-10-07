import test from 'node:test';
import assert from 'node:assert/strict';
import { niceCeiling, renderRdfChart } from '../src/render/rdf-chart.js';
import { finalizeRdf } from '../src/analysis/rdf.js';

class Element {
  constructor(root, tag) {
    this.ownerDocument = root; this.tagName = tag; this.children = []; this.attributes = {};
    this.listeners = new Map(); this.textContent = ''; this.value = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name, event = {}) { this.listeners.get(name)?.({ target: this, ...event }); }
  all(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.all(tag)]); }
  getBoundingClientRect() { return { left: 0, width: 360 }; }
}

function container() {
  const root = { createElement: tag => new Element(root, tag), createElementNS: (_, tag) => new Element(root, tag) };
  return root.createElement('div');
}

function rdf() {
  // Four 1 Å bins to 4 Å; the third bin is the highest peak.
  return finalizeRdf(Float64Array.of(0, 30, 400, 120), { bins: 4, cutoff: 4, volume: 1000, pairPopulation: 10_000 });
}

test('g(r) axes use a rounded top, the ideal-gas reference and exact bin readouts', () => {
  assert.deepEqual([0.3, 1, 1.1, 2.2, 3.1, 5.3, 7, 12].map(niceCeiling).map(value => +value.toPrecision(12)), [0.3, 1, 1.2, 2.5, 4, 6, 8, 12]);
  const chart = container(), result = rdf();
  renderRdfChart(chart, result);
  const texts = chart.all('text').map(text => text.textContent);
  assert.ok(texts.includes('g(r)') && texts.includes('r (Å)'));
  assert.ok(texts.includes('4'), 'the x axis ends at the cutoff rather than the last bin center');
  assert.equal(chart.all('path').filter(path => path.attributes.class === 'chart-line').length, 1, 'all bins share one path');
  assert.equal(chart.all('path').filter(path => path.attributes.class === 'chart-reference').length, 1);
  const output = chart.all('output')[0], slider = chart.all('input')[0];
  assert.equal(slider.value, '2', 'inspection starts at the highest peak');
  assert.match(output.textContent, /^r = 2\.5 Å \(2–3 Å\) · g\(r\) = [\d.]+ · 400 pairs$/);
  assert.equal(slider.attributes['aria-valuetext'], output.textContent);
});

test('pointer, keyboard and slider inspection move one crosshair; touch moves do not scrub', () => {
  const chart = container();
  renderRdfChart(chart, rdf());
  const svg = chart.all('svg')[0], slider = chart.all('input')[0], output = chart.all('output')[0];
  const crosshair = chart.all('path').find(path => path.attributes.class === 'chart-crosshair');
  svg.dispatch('pointermove', { clientX: 60, pointerType: 'mouse' });
  assert.equal(slider.value, '0'); assert.match(output.textContent, /0–1 Å.* 0 pairs/);
  assert.match(crosshair.attributes.d, /^M78\.00,20V154$/);
  svg.dispatch('pointermove', { clientX: 330, pointerType: 'touch' });
  assert.equal(slider.value, '0', 'touch scrolling leaves the inspected bin');
  svg.dispatch('pointerdown', { clientX: 330, pointerType: 'touch' }); assert.equal(slider.value, '3');
  svg.dispatch('pointermove', { clientX: 10, pointerType: 'mouse' }); assert.equal(slider.value, '3', 'the axis margin is ignored');
  let prevented = false;
  svg.dispatch('keydown', { key: 'ArrowLeft', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(slider.value, '2');
  svg.dispatch('keydown', { key: 'Home', preventDefault() {} }); assert.equal(slider.value, '0');
  slider.value = '1'; slider.dispatch('input'); assert.match(output.textContent, /1–2 Å.* 30 pairs/);
  assert.equal(chart.all('circle').length, 1);
  assert.equal(JSON.stringify(chart.all('path').map(path => path.attributes.d)).includes('NaN'), false);
});

test('recalculation keeps the inspected radius, and results without counts or normalization still render', () => {
  const chart = container();
  renderRdfChart(chart, rdf());
  chart.all('input')[0].value = '1'; chart.all('input')[0].dispatch('input');
  const finer = finalizeRdf(new Float64Array(8).fill(5), { bins: 8, cutoff: 4, volume: 1000, pairPopulation: 10_000 });
  renderRdfChart(chart, finer);
  assert.equal(chart.all('input')[0].value, '3', 'r = 1.5 Å lies in the fourth 0.5 Å bin');
  const bare = container();
  renderRdfChart(bare, { radii: Float64Array.of(0.25, 0.75), values: Float64Array.of(0, 2) });
  assert.match(bare.all('output')[0].textContent, /^r = 0\.75 Å \(0\.5–1 Å\) · g\(r\) = 2$/);
  const empty = container();
  renderRdfChart(empty, { radii: new Float64Array(0), values: new Float64Array(0) });
  assert.equal(empty.all('svg').length, 0);
});
