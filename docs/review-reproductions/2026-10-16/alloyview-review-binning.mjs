// Archived review evidence for baseline 77b24ad; see docs/REPOSITORY_REVIEW_2026-10-16.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeBinningTools, binningQuantityOptions, BINNING_DEFAULTS } from '../../../src/binning-tools.js';
import { calculateSpatialBins } from '../../../src/analysis/spatial-binning.js';
import { buildStatisticsTable, serializeCsv } from '../../../src/statistics-export.js';
import { createConfiguration, parseConfiguration } from '../../../src/configuration.js';
import { createCell, fractionalToCartesian } from '../../../src/data/model.js';
import { describeBin, niceRange, binningMapColors } from '../../../src/render/binning-chart.js';
import { compileScript, runScript } from '../../../src/command-script.js';
import { createScriptHost, waitUntilSettled } from '../../../src/script-controls.js';

class Element {
  constructor(value = '') {
    this.value = String(value); this.textContent = ''; this.hidden = false; this.checked = false; this.title = '';
    this.disabled = false; this.listeners = new Map(); this.attributes = new Map(); this.style = {}; this.className = '';
    this.classList = { toggle() {} }; this.children = [];
  }
  get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

/** Two atoms per layer in eight layers along c, with an energy column. */
function layeredFrame({ shift = 0, energy = layer => -layer, frameIndex = 0 } = {}) {
  const cell = createCell({ vectors: [4, 0, 0, 0, 4, 0, 0, 0, 16] });
  const count = 16, fractional = new Float64Array(count * 3), data = new Float64Array(count);
  for (let atom = 0; atom < count; atom++) {
    const layer = atom >> 1;
    fractional.set([(atom & 1) * 0.5, 0.25, (layer + 0.5 + shift) / 8], atom * 3);
    data[atom] = energy(layer);
  }
  return { fractional, cell, positions: fractionalToCartesian(fractional, cell, new Float64Array(count * 3)), frameIndex, timestep: frameIndex * 10,
    ids: Uint32Array.from({ length: count }, (_, atom) => 101 + atom), types: new Uint16Array(count), typeLabels: ['Fe'],
    properties: [{ name: 'pe', unit: 'eV', data }, { name: 'structureType', data: new Uint8Array(count), categories: [{ id: 0, label: 'Other' }] }] };
}

function harness(t, { frames = [layeredFrame()], groups = [] } = {}) {
  const previousDocument = globalThis.document;
  const fields = {};
  for (const id of ['binning-state', 'binning-status', 'binning-backend', 'binning-progress', 'binning-results', 'binning-summary',
    'binning-geometry', 'binning-chart', 'binning-chart-title', 'run-binning', 'cancel-binning', 'export-binning', 'binning-second-axis',
    'binning-reduction-field', 'binning-scheme-field', 'binning-average-field', 'binning-selection', 'binning-color-scheme']) fields[id] = new Element();
  Object.assign(fields, { 'binning-mode': new Element('1d'), 'binning-axis-1': new Element('c'), 'binning-axis-2': new Element('a'),
    'binning-bins-1': new Element('8'), 'binning-bins-2': new Element('2'), 'binning-quantity': new Element('density'),
    'binning-reduction': new Element('mean'), 'binning-average-frames': new Element() });
  globalThis.document = { getElementById: id => fields[id] ?? null,
    createElement() { const element = new Element(); element.ownerDocument = this; return element; } };
  for (const element of Object.values(fields)) element.ownerDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  let index = 0, version = 'a';
  let dependency = null;
  const charts = [], notifications = [], toolFlags = new Map(), loaded = [];
  const tools = initializeBinningTools({ tools: { setToolEnabled: (name, enabled) => toolFlags.set(name, enabled) },
    getFrame: () => frames[index], getFrameAt: async frameIndex => { loaded.push(frameIndex); return frames[frameIndex]; },
    getFrameCount: () => frames.length, getSourceVersion: () => version, getFrameIndex: () => index,
    getSelectionGroups: () => groups, notify: message => notifications.push(message),
    getPropertyDependency: () => dependency,
    renderChart: (container, result, options) => charts.push({ container, result, options }) });
  tools.setEnabled(true);
  const change = (id, value) => {
    if (id === 'binning-average-frames') fields[id].checked = value; else fields[id].value = String(value);
    fields[id].dispatch('change');
  };
  return { tools, fields, charts, notifications, toolFlags, loaded, change, frames,
    setFrame(next) { index = next; }, setVersion(next) { version = next; }, setGroups(next) { groups = next; },
    setDependency(next) { dependency = next; } };
}

const settle = () => new Promise(resolve => setImmediate(resolve));


test('review: selection edit while averaging', async t => {
 const h=harness(t, {frames:[layeredFrame(),layeredFrame({frameIndex:1})], groups:[{id:'top',name:'Top',atomIds:[101]}]});
 h.change('binning-selection','top');
 h.change('binning-average-frames',true);
 h.change('binning-quantity','count');
 const pending=h.tools.run();
 h.setGroups([{id:'top',name:'Top',atomIds:[113,114,115,116]}]);
 await h.tools.refresh();
 await pending;
 console.log(JSON.stringify({counts:[...h.tools.getResult().counts],totals:h.tools.getResult().totals,settings:h.tools.serialize()}));
 assert.equal(h.tools.getResult().totals.binned,2,'publishes old 1-atom selection in 2 frames instead of current 4-atom selection');
});
