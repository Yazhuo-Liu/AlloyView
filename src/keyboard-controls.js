import { KeyboardCommandRegistry, keyboardGearScale, normalizeShortcutKey, shouldIgnoreShortcut } from './keyboard-commands.js';

/** Register real camera/trajectory/slice actions and a viewport shortcut dialog. */
export function initializeKeyboardControls({ renderer, getSliceControls = () => null, onEdit = () => {} } = {}) {
  const document = renderer.canvas.ownerDocument;
  const viewport = renderer.canvas.parentElement;
  const toolbar = document.getElementById('export-png')?.parentElement;
  if (!viewport || !toolbar) return { dispose() {} };
  const listeners = [];
  const listen = (target, name, callback) => { target.addEventListener(name, callback); listeners.push(() => target.removeEventListener(name, callback)); };
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./keyboard-controls.css', import.meta.url).href;
  document.head.append(stylesheet);
  const button = document.createElement('button');
  button.id = 'show-keyboard-shortcuts'; button.type = 'button'; button.textContent = '?';
  button.title = 'Keyboard shortcuts (?)'; button.setAttribute('aria-label', 'Keyboard shortcuts');
  button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'keyboard-shortcuts');
  toolbar.append(button);
  const indicator = document.createElement('output');
  indicator.id = 'keyboard-gear-indicator'; indicator.className = 'keyboard-gear-indicator'; indicator.hidden = true;
  indicator.setAttribute('role', 'status'); indicator.setAttribute('aria-live', 'polite'); viewport.append(indicator);
  const dialog = document.createElement('dialog'); dialog.id = 'keyboard-shortcuts'; dialog.className = 'keyboard-shortcuts';
  dialog.setAttribute('aria-labelledby', 'keyboard-shortcuts-title');
  dialog.innerHTML = '<header><h2 id="keyboard-shortcuts-title">Keyboard shortcuts</h2><button id="close-keyboard-shortcuts" type="button" aria-label="Close keyboard shortcuts">×</button></header><div class="keyboard-shortcuts-body"><p>Press <kbd>0</kbd>–<kbd>9</kbd> to change camera step size. Gear <strong id="keyboard-current-gear"></strong>. Shortcuts pause while typing or a dialog is open.</p><p>To change a shortcut, select <strong>Change</strong> and press a key, optionally with Shift. Conflicts are refused; digits are reserved. Escape cancels capture.</p><div id="keyboard-command-groups"></div></div><footer><button id="reset-keyboard-shortcuts" type="button">Reset defaults</button><a href="./docs/features/keyboard.html" target="_blank" rel="noopener">Documentation</a><p id="keyboard-shortcuts-status" role="status" aria-live="polite"></p></footer>';
  document.body.append(dialog);
  const status = dialog.querySelector('#keyboard-shortcuts-status');
  const groups = dialog.querySelector('#keyboard-command-groups');
  let capture = null, indicatorTimer, previousFocus;
  const cameraEnabled = () => Boolean(renderer.frame && !document.getElementById('reset-camera')?.disabled);
  const cameraCommand = (id, label, bindings, action) => ({ id, label, bindings, group: 'Camera', enabled: cameraEnabled,
    handler: ({ scale }) => { renderer.cancelSelectionGesture(); action(scale); onEdit(); renderer.requestRender(); } });
  const angle = 5 * Math.PI / 180;
  const orbit = (x, y) => scale => renderer.orbitCamera(x * angle * scale, y * angle * scale);
  const roll = direction => scale => {
    // Releasing upright must first preserve screen-up, especially at the bottom
    // preset where the unconstrained Euler base differs by half a turn.
    if (renderer.constrainUp !== false) renderer.setCameraState({ constrainUp: false });
    renderer.setCameraState({ roll: (renderer.roll ?? 0) + direction * angle * scale });
  };
  const pan = (horizontal, vertical) => scale => {
    const { right, up } = renderer.cameraBasis();
    const step = (renderer.modelRadius || 1) * .02 * scale;
    renderer.pan = renderer.pan.map((value, axis) => value + step * (horizontal * right[axis] + vertical * up[axis]));
  };
  const zoom = direction => scale => {
    const state = renderer.getCameraState(), multiplier = Math.exp(direction * .05 * scale);
    renderer.setCameraState(state.projectionMode === 'orthographic'
      ? { fieldWidth: Math.max(.001, state.fieldWidth * multiplier) }
      : { distance: Math.max(.02, state.distance * multiplier) });
  };
  const clickCommand = (id, label, group, bindings, target) => ({ id, label, group, bindings,
    enabled: () => { const element = document.getElementById(target); return Boolean(element && !element.disabled); },
    handler: () => document.getElementById(target).click() });
  const sliceEnabled = flip => {
    if (!cameraEnabled()) return false;
    const state = getSliceControls()?.getState(), selected = state?.slices.find(slice => slice.id === state.selectedId);
    return Boolean(selected && (!flip || !selected.slab));
  };
  const commands = [
    cameraCommand('camera.yaw-left', 'Orbit left', ['ArrowLeft'], orbit(1, 0)),
    cameraCommand('camera.yaw-right', 'Orbit right', ['ArrowRight'], orbit(-1, 0)),
    cameraCommand('camera.pitch-up', 'Orbit up', ['ArrowUp'], orbit(0, -1)),
    cameraCommand('camera.pitch-down', 'Orbit down', ['ArrowDown'], orbit(0, 1)),
    cameraCommand('camera.roll-left', 'Roll left · release upright constraint', ['q'], roll(-1)),
    cameraCommand('camera.roll-right', 'Roll right · release upright constraint', ['e'], roll(1)),
    cameraCommand('camera.pan-left', 'Pan left', ['Shift+ArrowLeft'], pan(-1, 0)),
    cameraCommand('camera.pan-right', 'Pan right', ['Shift+ArrowRight'], pan(1, 0)),
    cameraCommand('camera.pan-up', 'Pan up', ['Shift+ArrowUp'], pan(0, 1)),
    cameraCommand('camera.pan-down', 'Pan down', ['Shift+ArrowDown'], pan(0, -1)),
    cameraCommand('camera.zoom-in', 'Zoom in', ['=', '+'], zoom(-1)),
    cameraCommand('camera.zoom-out', 'Zoom out', ['-', '_'], zoom(1)),
    cameraCommand('camera.reset', 'Reset camera', ['r'], () => renderer.resetCamera()),
    ...[['front', 'f'], ['back', 'b'], ['left', 'l'], ['right', 'Shift+l'], ['top', 't'], ['bottom', 'Shift+t']]
      .map(([view, binding]) => cameraCommand(`camera.view-${view}`, `${view[0].toUpperCase()}${view.slice(1)} view`, [binding], () => renderer.setView(view))),
    clickCommand('frames.previous', 'Previous frame', 'Trajectory', ['['], 'frame-previous'),
    clickCommand('frames.next', 'Next frame', 'Trajectory', [']'], 'frame-next'),
    clickCommand('frames.first', 'First frame', 'Trajectory', ['{'], 'frame-first'),
    clickCommand('frames.last', 'Last frame', 'Trajectory', ['}'], 'frame-last'),
    clickCommand('frames.play', 'Play / pause trajectory', 'Trajectory', ['Space'], 'frame-play'),
    { id: 'slice.previous', label: 'Move selected plane back by its step', group: 'Slices', bindings: [','], enabled: () => sliceEnabled(false),
      handler: () => { onEdit(); getSliceControls().stepSelected(-1); } },
    { id: 'slice.next', label: 'Move selected plane forward by its step', group: 'Slices', bindings: ['.'], enabled: () => sliceEnabled(false),
      handler: () => { onEdit(); getSliceControls().stepSelected(1); } },
    { id: 'slice.flip', label: 'Flip selected plane retained side', group: 'Slices', bindings: ['Shift+f'], enabled: () => sliceEnabled(true),
      handler: () => { onEdit(); getSliceControls().flipSelected(); } },
    clickCommand('image.png', 'Download PNG', 'Interface', ['p'], 'export-png'),
    { id: 'interface.theme', label: 'Switch light / dark theme', group: 'Interface', bindings: ['d'],
      handler: () => document.getElementById(document.documentElement.dataset.theme === 'dark' ? 'theme-light' : 'theme-dark').click() },
    { id: 'interface.shortcuts', label: 'Show keyboard shortcuts', group: 'Interface', bindings: ['?'], handler: open },
  ];
  let storage;
  try { storage = document.defaultView.localStorage; } catch { storage = null; }
  const registry = new KeyboardCommandRegistry(commands, { storage });
  function updateGear() {
    dialog.querySelector('#keyboard-current-gear').textContent = `${registry.gear} (${keyboardGearScale(registry.gear)}×)`;
  }
  function renderCommands() {
    groups.replaceChildren(); updateGear();
    for (const group of new Set(registry.commands.map(command => command.group))) {
      const section = document.createElement('section'), heading = document.createElement('h3'); heading.textContent = group; section.append(heading);
      for (const command of registry.commands.filter(entry => entry.group === group)) {
        const row = document.createElement('div'); row.className = 'keyboard-command'; row.dataset.command = command.id;
        const label = document.createElement('span'); label.textContent = command.label;
        const keys = document.createElement('span'); keys.className = 'keyboard-command-keys';
        for (const binding of command.bindings) { const key = document.createElement('kbd'); key.textContent = binding; keys.append(key); }
        const change = document.createElement('button'); change.type = 'button'; change.textContent = capture === command.id ? 'Press a key…' : 'Change';
        change.setAttribute('aria-label', `Change shortcut for ${command.label}`);
        change.addEventListener('click', () => { capture = command.id; status.textContent = `Press a key for ${command.label}. Escape cancels.`; renderCommands(); groups.querySelector(`[data-command="${command.id}"] button`).focus(); });
        row.append(label, keys, change); section.append(row);
      }
      groups.append(section);
    }
  }
  function open() {
    if (dialog.open) return;
    previousFocus = document.activeElement; capture = null; status.textContent = ''; renderCommands(); dialog.showModal();
    dialog.querySelector('#close-keyboard-shortcuts').focus();
  }
  function close() { capture = null; dialog.close(); previousFocus?.focus?.(); }
  listen(button, 'click', open);
  listen(dialog.querySelector('#close-keyboard-shortcuts'), 'click', close);
  listen(dialog, 'cancel', event => { event.preventDefault(); close(); });
  listen(dialog.querySelector('#reset-keyboard-shortcuts'), 'click', () => {
    capture = null; const saved = registry.reset(); renderCommands(); status.textContent = saved ? 'Default shortcuts restored.' : 'Defaults restored for this session; browser storage is unavailable.';
    dialog.querySelector('#reset-keyboard-shortcuts').focus();
  });
  listen(dialog, 'keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key === 'Tab') {
      // Keep wraparound in the dialog rather than tabbing into browser chrome.
      const focusable = [...dialog.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
        .filter(element => element.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (capture) { capture = null; renderCommands(); status.textContent = 'Shortcut capture cancelled.'; dialog.querySelector('#close-keyboard-shortcuts').focus(); }
      else close();
      return;
    }
    if (!capture) return;
    event.preventDefault(); event.stopPropagation();
    const binding = normalizeShortcutKey(event), id = capture;
    if (!binding) { status.textContent = 'Use a key, optionally with Shift. Escape, Tab, Enter, digits and browser modifier keys are reserved.'; return; }
    try {
      const saved = registry.rebind(id, binding); capture = null; renderCommands();
      status.textContent = saved ? 'Shortcut saved.' : 'Shortcut changed for this session; browser storage is unavailable.';
      groups.querySelector(`[data-command="${id}"] button`).focus();
    } catch (error) { status.textContent = error.message; }
  });
  listen(document, 'keydown', event => {
    if (shouldIgnoreShortcut(event, { modalOpen: Boolean(document.querySelector('dialog[open], [aria-modal="true"]:not([hidden])')), viewport })) return;
    if (/^[0-9]$/.test(event.key) && !event.shiftKey) {
      if (!cameraEnabled()) return;
      event.preventDefault(); if (event.repeat) return;
      const saved = registry.setGear(Number(event.key)); updateGear();
      indicator.textContent = `Camera gear ${registry.gear} · ${keyboardGearScale(registry.gear)}×${saved ? '' : ' · session only'}`;
      indicator.hidden = false; clearTimeout(indicatorTimer); indicatorTimer = setTimeout(() => { indicator.hidden = true; }, 1600);
      return;
    }
    const key = normalizeShortcutKey(event);
    const command = registry.commands.find(entry => entry.bindings.includes(key));
    // A held key repeats camera/slice movements, but never exports files, resets,
    // toggles playback/theme, or repeatedly changes a trajectory frame.
    if (event.repeat && command && (!command.id.startsWith('camera.') || command.id === 'camera.reset' || command.id.startsWith('camera.view-'))
      && !['slice.previous', 'slice.next'].includes(command.id)) return;
    if (key && registry.execute(key, event)) event.preventDefault();
  });
  return { registry, open, close, dispose() {
    clearTimeout(indicatorTimer); listeners.forEach(remove => remove());
    if (dialog.open) dialog.close(); dialog.remove(); button.remove(); indicator.remove(); stylesheet.remove();
  } };
}
