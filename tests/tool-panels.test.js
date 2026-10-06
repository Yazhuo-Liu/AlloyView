import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeToolPanels } from '../src/tool-panels.js';
import { createToolRegistry } from '../src/tool-registry.js';

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.attributes = {};
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = '';
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector() { return null; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  append(child) { this.children.push(child); child.parentElement = this; }
  focus() { document.activeElement = this; }
  dispatch(name, data = {}) {
    let prevented = false;
    this.listeners.get(name)?.({ target: this, preventDefault() { prevented = true; }, ...data });
    return prevented;
  }
}

function harness(t) {
  const previousDocument = globalThis.document;
  const toolNames = ['display', 'slice', 'coordination', 'displacement', 'replicate', 'externalProperties'];
  const buttons = Object.fromEntries(toolNames.map(name => [name, new Element({ toolButton: name })]));
  const panels = Object.fromEntries(toolNames.map(name => [name, new Element({ toolPanel: name })]));
  const tabs = Object.fromEntries(['visualization', 'modification'].map(name => [name, new Element({ toolCategory: name })]));
  const groups = Object.fromEntries(['visualization', 'modification'].map(name => [name, new Element({ toolCategoryPanel: name })]));
  const host = new Element(), close = new Element();
  for (const panel of Object.values(panels)) host.append(panel);
  globalThis.document = {
    activeElement: null,
    getElementById: id => id === 'close-tool' ? close : null,
    querySelectorAll(selector) {
      return Object.values({ '[data-tool-button]': buttons, '[data-tool-panel]': panels,
        '[data-tool-category]': tabs, '[data-tool-category-panel]': groups }[selector] ?? {});
    },
  };
  t.after(() => { globalThis.document = previousDocument; });
  const changes = [], categoryChanges = [], analysesClosed = [], toolsClosed = [];
  const tools = initializeToolPanels({
    onSelectionChange: (...args) => changes.push(args),
    onCategoryChange: (...args) => categoryChanges.push(args),
    onDeactivateAnalysis: name => analysesClosed.push(name),
    onDeactivateTool: name => toolsClosed.push(name),
  });
  return { tools, buttons, panels, tabs, groups, close, host, changes, categoryChanges, analysesClosed, toolsClosed };
}

test('category navigation remembers settings and preserves running analyses', t => {
  const h = harness(t);
  assert.equal(h.tools.getActiveCategory(), 'visualization');
  assert.equal(h.tools.getActiveTool(), 'display');
  assert.equal(h.panels.display.hidden, false);
  assert.equal(h.groups.modification.hidden, true);
  h.tools.setToolEnabled('displacement', true);
  h.buttons.displacement.dispatch('click');
  assert.equal(h.changes.at(-1)[1].userInitiated, true);
  h.tabs.modification.dispatch('click');
  assert.equal(h.tools.getActiveTool(), 'replicate');
  assert.equal(h.buttons.display.hidden, true);
  assert.equal(h.buttons.replicate.hidden, false);
  h.buttons.externalProperties.dispatch('click');
  h.tabs.visualization.dispatch('click');
  assert.equal(h.tools.getActiveTool(), 'displacement');
  assert.equal(h.changes.at(-1)[1].userInitiated, false);
  assert.equal(h.tools.isToolEnabled('displacement'), true);
  assert.deepEqual(h.analysesClosed, []);
  assert.deepEqual(h.toolsClosed, []);
  h.tabs.modification.dispatch('click');
  assert.equal(h.tools.getActiveTool(), 'externalProperties');
});

test('programmatic selection and revealed results show their own category', t => {
  const h = harness(t);
  h.tools.selectTool('externalProperties');
  assert.equal(h.tools.getActiveCategory(), 'modification');
  assert.equal(h.groups.modification.hidden, false);
  assert.equal(h.panels.externalProperties.hidden, false);
  h.tools.setToolEnabled('coordination', true, { reveal: true });
  assert.equal(h.tools.getActiveCategory(), 'visualization');
  assert.equal(h.tools.getActiveTool(), 'coordination');
  assert.equal(h.close.textContent, 'Close / cancel');
  assert.equal(h.buttons.coordination.attributes['aria-pressed'], 'true');
  assert.equal(h.tools.setActiveCategory('missing'), false);
  assert.equal(h.tools.selectTool('missing'), false);
});

test('explicitly closing an analysis clears it and keeps its category empty on return', t => {
  const h = harness(t);
  h.tools.setToolEnabled('coordination', true, { reveal: true });
  h.close.dispatch('click');
  assert.equal(h.tools.getActiveTool(), null);
  assert.equal(h.tools.isToolEnabled('coordination'), false);
  assert.deepEqual(h.analysesClosed, ['coordination']);
  h.tools.setActiveCategory('modification');
  h.tools.setActiveCategory('visualization');
  assert.equal(h.tools.getActiveTool(), null);
  assert.equal(h.close.hidden, true);
  assert.ok(Object.values(h.panels).every(panel => panel.hidden));
});

test('tab keyboard navigation updates roving focus, selection and panels', t => {
  const h = harness(t);
  assert.equal(h.tabs.visualization.tabIndex, 0);
  assert.equal(h.tabs.modification.tabIndex, -1);
  assert.equal(h.tabs.visualization.dispatch('keydown', { key: 'ArrowRight' }), true);
  assert.equal(document.activeElement, h.tabs.modification);
  assert.equal(h.tabs.modification.attributes['aria-selected'], 'true');
  assert.equal(h.tabs.modification.tabIndex, 0);
  assert.equal(h.tabs.visualization.tabIndex, -1);
  h.tabs.modification.dispatch('keydown', { key: 'Home' });
  assert.equal(document.activeElement, h.tabs.visualization);
  h.tabs.visualization.dispatch('keydown', { key: 'End' });
  assert.equal(document.activeElement, h.tabs.modification);
  h.tabs.modification.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(document.activeElement, h.tabs.visualization);
  h.tabs.visualization.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(document.activeElement, h.tabs.modification);
  assert.equal(h.tabs.modification.dispatch('keydown', { key: 'Escape' }), false);
});

test('future modification editors can mount through the registry and share navigation', t => {
  const h = harness(t), button = new Element(), panel = new Element();
  const entry = h.tools.registerTool({ id: 'moveAtoms', label: 'Move selected atoms', category: 'modification', changesStructure: true }, { button, panel });
  assert.equal(entry.changesStructure, true);
  assert.equal(h.groups.modification.children.includes(button), true);
  assert.equal(h.host.children.includes(panel), true);
  assert.equal(button.attributes['aria-controls'], 'tool-moveAtoms');
  h.tools.selectTool('moveAtoms');
  assert.equal(h.tools.getActiveCategory(), 'modification');
  assert.equal(panel.hidden, false);
  button.dispatch('click');
  assert.deepEqual(h.toolsClosed, ['moveAtoms']);
  assert.equal(panel.hidden, true);
  assert.throws(() => h.tools.registerTool({ id: 'moveAtoms' }, { button, panel }), /already mounted/);
});

test('registry provides built-in classification and rejects ambiguous registrations', () => {
  const registry = createToolRegistry();
  assert.equal(registry.categoryFor('display'), 'visualization');
  assert.equal(registry.categoryFor('replicate'), 'modification');
  assert.equal(registry.isAnalysis('coordination'), true);
  assert.equal(registry.isAnalysis('vectors'), false);
  assert.deepEqual(registry.list('modification').map(tool => tool.id), ['replicate', 'externalProperties']);
  assert.throws(() => registry.register({ id: 'display' }), /already registered/);
  assert.throws(() => registry.register({ id: 'invalid tool' }), /stable/);
  assert.throws(() => registry.register({ id: 'newTool', category: 'unknown' }), /category/);
  const tool = registry.register({ id: 'deleteAtoms', category: 'modification', changesStructure: true });
  assert.equal(registry.get('deleteAtoms'), tool);
  assert.equal(Object.isFrozen(tool), true);
});
