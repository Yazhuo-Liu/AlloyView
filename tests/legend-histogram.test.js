import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegendScale, scalarLegendHistogram } from '../src/render/legend-histogram.js';

class Element {
  constructor(root, tag) {
    this.ownerDocument = root; this.tagName = tag; this.children = []; this.attributes = {};
    this.listeners = new Map(); this.textContent = ''; this.style = {}; this.hidden = false;
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name, event = {}) { this.listeners.get(name)?.({ target: this, ...event }); }
  all(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.all(tag)]); }
  find(className) { return this.children.flatMap(child => [...(child.className === className ? [child] : []), ...child.find(className)]); }
  getBoundingClientRect() { return { left: 100, width: 200 }; }
}
const root = { createElement: tag => new Element(root, tag), createElementNS: (_, tag) => new Element(root, tag) };

test('legend histograms count finite values per color band and reuse cached data', () => {
  const data = Float64Array.of(0, 0.1, 0.5, 0.99, 1, -2, 3, NaN, Infinity);
  const histogram = scalarLegendHistogram(data, 0, 1, 4);
  assert.deepEqual([...histogram.counts], [2, 0, 1, 2], 'the maximum belongs to the last band');
  assert.equal(histogram.below, 1); assert.equal(histogram.above, 1); assert.equal(histogram.peak, 2);
  assert.equal(scalarLegendHistogram(data, 0, 1, 4), histogram, 'unchanged data and range reuse the counts');
  assert.notEqual(scalarLegendHistogram(data, 0, 2, 4), histogram, 'a new range recounts');
  assert.deepEqual([...scalarLegendHistogram(Float64Array.of(5.5, 5.5), 5.5, 5.5, 3).counts], [2, 0, 0], 'a constant range counts every value once');
  const integers = scalarLegendHistogram(Uint8Array.of(10, 11, 12, 12, 12, 9, 13), 10, 12);
  assert.equal(integers.integer, true);
  assert.deepEqual([...integers.counts], [1, 1, 3], 'integer data gets one band per value');
  assert.equal(integers.below + integers.above, 2);
  assert.equal(scalarLegendHistogram(new Float64Array(200).map((_, index) => index), 0, 199).integer, false,
    'wide integer ranges fall back to equal-width bands');
});

test('the legend probe reports the value and band population under the pointer', () => {
  const data = new Float64Array(100).map((_, index) => index / 10);
  const scale = createLegendScale(root, { minimum: 0, maximum: 10, gradient: 'linear-gradient(red, blue)', property: { data } },
    { format: value => value.toFixed(2) });
  assert.equal(scale.all('svg').length, 1, 'a faint histogram sits behind the gradient');
  assert.equal(scale.find('legend-gradient')[0].style.background, 'linear-gradient(red, blue)');
  const [marker] = scale.find('legend-probe'), [label] = scale.find('legend-probe-label');
  assert.equal(label.hidden, true);
  scale.dispatch('pointermove', { clientX: 150 });
  assert.equal(label.hidden, false); assert.equal(marker.style.left, '25%');
  assert.match(label.textContent, /^2\.50 · \d+ atoms in band$/);
  scale.dispatch('pointermove', { clientX: 400 });
  assert.equal(marker.style.left, '100%'); assert.equal(label.style.left, '86%', 'the label stays inside the legend');
  scale.dispatch('pointerleave');
  assert.equal(marker.hidden, true); assert.equal(label.hidden, true);
  const bare = createLegendScale(root, { minimum: 1, maximum: 3, gradient: 'red' }, { format: String });
  assert.equal(bare.all('svg').length, 0);
  bare.dispatch('pointerdown', { clientX: 200 });
  assert.equal(bare.find('legend-probe-label')[0].textContent, '2');
});

test('integer legends snap the probe to the nearest integer and report its population', () => {
  const scale = createLegendScale(root, { minimum: 10, maximum: 12, gradient: 'red', property: { data: Uint8Array.of(11, 12, 12, 12) } }, { format: String });
  const [marker] = scale.find('legend-probe'), [label] = scale.find('legend-probe-label');
  scale.dispatch('pointermove', { clientX: 225 });
  assert.equal(label.textContent, '11 · 1 atom'); assert.equal(marker.style.left, '50%');
  scale.dispatch('pointermove', { clientX: 290 });
  assert.equal(label.textContent, '12 · 3 atoms'); assert.equal(marker.style.left, '100%');
  scale.dispatch('pointermove', { clientX: 100 });
  assert.equal(label.textContent, '10 · 0 atoms');
});
