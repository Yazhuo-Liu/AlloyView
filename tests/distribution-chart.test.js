import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDistributionChart, renderPopulationTable } from '../src/render/distribution-chart.js';

class Element {
  constructor(root, tag) {
    this.ownerDocument = root; this.tagName = tag; this.children = [];
    this.attributes = {}; this.listeners = new Map(); this.textContent = '';
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
  focus() { this.ownerDocument.activeElement = this; }
  all(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.all(tag)]); }
  text() { return [this.textContent, ...this.children.map(child => child.text())].join(' '); }
}

function rootAndContainer() {
  const root = { createElement: tag => new Element(root, tag), createElementNS: (_, tag) => new Element(root, tag) };
  return { root, container: root.createElement('div') };
}

test('distribution charts keep all bins in one bar path and build numerical rows only on disclosure', () => {
  const { container } = rootAndContainer();
  renderDistributionChart(container, { counts: [1, 0, 3], edges: [0, 1, 2, 3], centers: [.5, 1.5, 2.5] }, { label: 'Bond lengths', unit: 'Å', xLabel: 'Length' });
  assert.equal(container.all('svg').length, 1);
  assert.equal(container.all('path').filter(path => path.attributes.class === 'chart-bar').length, 1);
  assert.match(container.all('svg')[0].attributes['aria-label'], /4 samples/);
  assert.equal(container.all('table').length, 0);
  const details = container.all('details')[0];
  details.open = true; details.dispatch('toggle');
  assert.equal(container.all('tbody')[0].children.length, 3);
  assert.match(container.all('tbody')[0].children[1].text(), /0/);
  details.open = false; details.dispatch('toggle');
  details.open = true; details.dispatch('toggle');
  assert.equal(container.all('table').length, 1);
  assert.equal(container.text().includes('NaN'), false);
});

test('uniform Voronoi volumes retain their exact coordinate and undefined density', () => {
  const { container } = rootAndContainer();
  renderDistributionChart(container, [{ lower: 8, upper: 8, count: 20, fraction: 1 }], { label: 'Atomic volume', unit: 'Å³' });
  const labels = container.all('text').map(node => node.textContent);
  assert.equal(labels.includes('8'), true);
  assert.equal(container.all('path').some(node => /NaN|Infinity/.test(node.attributes.d ?? '')), false);
  const details = container.all('details')[0]; details.open = true; details.dispatch('toggle');
  assert.equal(container.all('tbody')[0].children[0].children.at(-1).textContent, '—');
});

test('population paging retains every index and keyboard focus with bounded rendered rows', () => {
  const { root, container } = rootAndContainer();
  const entries = Array.from({ length: 103 }, (_, index) => ({ index: `index-${index}`, count: 1 }));
  renderPopulationTable(container, entries);
  const seen = [], page = () => container.all('tbody')[0].children;
  seen.push(...page().map(row => row.children[0].textContent));
  assert.equal(page().length, 50);
  container.all('button')[1].dispatch('click');
  assert.equal(root.activeElement, container.all('button')[1]);
  seen.push(...page().map(row => row.children[0].textContent));
  assert.equal(page().length, 50);
  container.all('button')[1].dispatch('click');
  seen.push(...page().map(row => row.children[0].textContent));
  assert.equal(page().length, 3);
  assert.equal(container.all('button')[1].disabled, true);
  assert.equal(root.activeElement, container.all('button')[0]);
  assert.deepEqual(seen, entries.map(entry => entry.index));
});
