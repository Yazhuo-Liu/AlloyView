const ANALYSIS_TOOLS = new Set(['coordination', 'cna', 'centrosymmetry', 'ptm', 'strain', 'bonds', 'statistics', 'referenceStrain', 'localShear', 'displacement']);

/**
 * Show one configuration panel while keeping independently enabled analyses.
 * User-selection metadata lets Displacement start when opened. Other panels
 * wait for their calculation controls. Closing an analysis explicitly
 * deactivates it; switching settings leaves its computation and results intact.
 */
export function initializeToolPanels({ onDeactivateAnalysis = () => {}, onDeactivateTool = () => {}, onSelectionChange = () => {} } = {}) {
  const buttons = new Map([...document.querySelectorAll('[data-tool-button]')]
    .map((button) => [button.dataset.toolButton, button]));
  const panels = new Map([...document.querySelectorAll('[data-tool-panel]')]
    .map((panel) => [panel.dataset.toolPanel, panel]));
  const closeButton = document.getElementById('close-tool');
  const enabledTools = new Set();
  let activeTool = panels.has('display') ? 'display' : null;

  function render() {
    for (const [name, panel] of panels) panel.hidden = name !== activeTool;
    for (const [name, button] of buttons) {
      const active = name === activeTool;
      const enabled = enabledTools.has(name);
      button.classList.toggle('active', active);
      button.classList.toggle('enabled', enabled);
      button.setAttribute('aria-expanded', String(active));
      button.setAttribute('aria-pressed', String(active || enabled));
      const indicator = button.querySelector('.tool-enabled-dot');
      if (indicator) indicator.hidden = !enabled;
      const label = button.querySelector('.tool-button-label')?.textContent.trim() || name;
      button.title = active
        ? (ANALYSIS_TOOLS.has(name) ? `Close ${label} and clear its results` : `Close ${label}`)
        : (enabled ? `Open ${label} settings · currently enabled` : `Open ${label} settings`);
    }
    if (closeButton) {
      closeButton.hidden = activeTool === null;
      closeButton.textContent = activeTool && ANALYSIS_TOOLS.has(activeTool) ? 'Close / cancel' : 'Close';
      closeButton.setAttribute('aria-label', activeTool ? `Close ${activeTool} tool` : 'Close tool');
    }
  }

  function selectTool(name, { focus = false, userInitiated = false } = {}) {
    if (!panels.has(name)) return false;
    activeTool = name;
    render();
    onSelectionChange(activeTool, { userInitiated });
    if (focus) buttons.get(name)?.focus();
    return true;
  }

  function closeTool(name = activeTool, { deactivate = true } = {}) {
    if (!panels.has(name)) return false;
    if (name === activeTool) activeTool = null;
    if (deactivate) enabledTools.delete(name);
    render();
    onSelectionChange(activeTool);
    if (deactivate) {
      if (ANALYSIS_TOOLS.has(name)) onDeactivateAnalysis(name);
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
    if (reveal) activeTool = name;
    render();
    if (reveal) onSelectionChange(activeTool);
    return true;
  }

  for (const [name, button] of buttons) {
    button.addEventListener('click', () => {
      if (activeTool === name) closeTool(name);
      else selectTool(name, { userInitiated: true });
    });
  }
  closeButton?.addEventListener('click', () => closeTool());
  render();

  return Object.freeze({
    selectTool,
    closeTool,
    setToolEnabled,
    getActiveTool: () => activeTool,
    isToolEnabled: (name) => enabledTools.has(name),
  });
}
