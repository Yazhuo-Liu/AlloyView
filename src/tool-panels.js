import { createToolRegistry, TOOL_CATEGORIES } from './tool-registry.js';

/**
 * Show one configuration panel while keeping independently enabled analyses.
 * User-selection metadata lets Displacement start when opened. Other panels
 * wait for their calculation controls. Closing an analysis explicitly
 * deactivates it; switching settings leaves its computation and results intact.
 */
export function initializeToolPanels({ registry = createToolRegistry(), onDeactivateAnalysis = () => {}, onDeactivateTool = () => {}, onSelectionChange = () => {}, onCategoryChange = () => {} } = {}) {
  const buttons = new Map([...document.querySelectorAll('[data-tool-button]')]
    .map((button) => [button.dataset.toolButton, button]));
  const panels = new Map([...document.querySelectorAll('[data-tool-panel]')]
    .map((panel) => [panel.dataset.toolPanel, panel]));
  const panelHost = panels.values().next().value?.parentElement;
  const closeButton = document.getElementById('close-tool');
  const categoryTabs = new Map([...document.querySelectorAll('[data-tool-category]')]
    .map(tab => [tab.dataset.toolCategory, tab]));
  const categoryPanels = new Map([...document.querySelectorAll('[data-tool-category-panel]')]
    .map(panel => [panel.dataset.toolCategoryPanel, panel]));
  const enabledTools = new Set();
  const rememberedTools = new Map(TOOL_CATEGORIES.map(category => [category,
    [...panels.keys()].find(name => registry.categoryFor(name) === category) ?? null]));
  let activeCategory = 'visualization';
  let activeTool = panels.has('display') ? 'display' : null;
  rememberedTools.set(activeCategory, activeTool);

  function render() {
    for (const [name, panel] of panels) panel.hidden = name !== activeTool;
    for (const [category, tab] of categoryTabs) {
      const active = category === activeCategory;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      tab.classList.toggle('active', active);
    }
    for (const [category, panel] of categoryPanels) panel.hidden = category !== activeCategory;
    for (const [name, button] of buttons) {
      button.hidden = registry.categoryFor(name) !== activeCategory;
      const active = name === activeTool;
      const enabled = enabledTools.has(name);
      button.classList.toggle('active', active);
      button.classList.toggle('enabled', enabled);
      button.setAttribute('aria-expanded', String(active));
      button.setAttribute('aria-pressed', String(active || enabled));
      const indicator = button.querySelector('.tool-enabled-dot');
      if (indicator) indicator.hidden = !enabled;
      const label = button.querySelector('.tool-button-label')?.textContent.trim() || registry.get(name)?.label || name;
      button.title = active
        ? (registry.isAnalysis(name) ? `Close ${label} and clear its results` : `Close ${label}`)
        : (enabled ? `Open ${label} settings · currently enabled` : `Open ${label} settings`);
    }
    if (closeButton) {
      closeButton.hidden = activeTool === null;
      closeButton.textContent = activeTool && registry.isAnalysis(activeTool) ? 'Close / cancel' : 'Close';
      closeButton.setAttribute('aria-label', activeTool ? `Close ${activeTool} tool` : 'Close tool');
    }
  }

  function selectTool(name, { focus = false, userInitiated = false } = {}) {
    if (!panels.has(name)) return false;
    const previousCategory = activeCategory;
    activeCategory = registry.categoryFor(name);
    activeTool = name;
    rememberedTools.set(activeCategory, name);
    render();
    if (previousCategory !== activeCategory) onCategoryChange(activeCategory, { userInitiated });
    onSelectionChange(activeTool, { userInitiated });
    if (focus) buttons.get(name)?.focus();
    return true;
  }

  function setActiveCategory(category, { focus = false, userInitiated = false } = {}) {
    if (!TOOL_CATEGORIES.includes(category)) return false;
    if (category !== activeCategory) {
      activeCategory = category;
      activeTool = rememberedTools.get(category) ?? null;
      render();
      onCategoryChange(category, { userInitiated });
      // Returning to settings must not restart or enable an analysis.
      onSelectionChange(activeTool, { userInitiated: false });
    }
    if (focus) categoryTabs.get(category)?.focus();
    return true;
  }

  function closeTool(name = activeTool, { deactivate = true } = {}) {
    if (!panels.has(name)) return false;
    if (name === activeTool) activeTool = null;
    const category = registry.categoryFor(name);
    if (rememberedTools.get(category) === name) rememberedTools.set(category, null);
    if (deactivate) enabledTools.delete(name);
    render();
    onSelectionChange(activeTool);
    if (deactivate) {
      if (registry.isAnalysis(name)) onDeactivateAnalysis(name);
      else onDeactivateTool(name);
    }
    return true;
  }

  function setToolEnabled(name, enabled, { reveal = false } = {}) {
    if (!panels.has(name)) return false;
    if (enabled) enabledTools.add(name);
    else enabledTools.delete(name);
    // A Cancel button clears results while leaving settings available to retry.
    // Callers explicitly close the tool when they also want to hide settings.
    if (reveal) selectTool(name);
    else render();
    return true;
  }

  function bindToolButton(name, button) {
    button.addEventListener('click', () => {
      if (activeTool === name) closeTool(name);
      else selectTool(name, { userInitiated: true });
    });
  }
  for (const [name, button] of buttons) bindToolButton(name, button);
  for (const [category, tab] of categoryTabs) {
    tab.addEventListener('click', () => setActiveCategory(category, { userInitiated: true }));
    tab.addEventListener('keydown', event => {
      const categories = TOOL_CATEGORIES.filter(name => categoryTabs.has(name));
      const index = categories.indexOf(category);
      let next;
      if (event.key === 'ArrowRight') next = categories[(index + 1) % categories.length];
      else if (event.key === 'ArrowLeft') next = categories[(index + categories.length - 1) % categories.length];
      else if (event.key === 'Home') next = categories[0];
      else if (event.key === 'End') next = categories.at(-1);
      else return;
      event.preventDefault();
      setActiveCategory(next, { focus: true, userInitiated: true });
    });
  }

  function registerTool(definition, { button, panel } = {}) {
    if (!button || !panel) throw new TypeError('A registered tool requires a button and a settings panel.');
    if (buttons.has(definition?.id) || panels.has(definition?.id)) throw new TypeError(`Tool already mounted: ${definition?.id}`);
    const entry = registry.register(definition);
    button.dataset.toolButton = entry.id;
    panel.dataset.toolPanel = entry.id;
    if (!panel.id) panel.id = `tool-${entry.id}`;
    button.setAttribute('aria-controls', panel.id);
    buttons.set(entry.id, button);
    panels.set(entry.id, panel);
    categoryPanels.get(entry.category)?.append(button);
    if (!panel.parentElement) panelHost?.append(panel);
    if (!rememberedTools.get(entry.category)) rememberedTools.set(entry.category, entry.id);
    bindToolButton(entry.id, button);
    render();
    return entry;
  }
  closeButton?.addEventListener('click', () => closeTool());
  render();

  return Object.freeze({
    selectTool,
    closeTool,
    setToolEnabled,
    registerTool,
    setActiveCategory,
    getActiveCategory: () => activeCategory,
    getActiveTool: () => activeTool,
    isToolEnabled: (name) => enabledTools.has(name),
  });
}
