import { CrystalDragGesture, snapCrystalOrigin } from './render/crystal-drag.js';

const AXES = ['a', 'b', 'c'];

/** "Move crystal": drag the structure through its periodic boundaries.
 * The mode toggle (viewport toolbar on desktop, Periodic display origin
 * controls everywhere) makes a left drag or one-finger drag move the crystal;
 * Alt/Option + left drag does so without the mode. Taps still select atoms. */
export function initializeCrystalDragControls({ renderer, getOrigin, getCoordinateMode, commit } = {}) {
  const document = renderer.canvas.ownerDocument;
  const viewport = renderer.canvas.parentElement;
  const sidebarButton = document.getElementById('origin-drag-mode');
  if (!document.getElementById('crystal-drag-styles')) {
    const css = document.createElement('link');
    css.id = 'crystal-drag-styles'; css.rel = 'stylesheet';
    css.href = new URL('./crystal-drag-controls.css', import.meta.url).href;
    document.head.append(css);
  }
  const toolbarButton = document.createElement('button');
  toolbarButton.id = 'toggle-crystal-drag'; toolbarButton.type = 'button'; toolbarButton.disabled = true;
  toolbarButton.title = 'Move crystal: drag it through the periodic boundaries (M). Alt-drag works in any mode.';
  toolbarButton.setAttribute('aria-label', 'Move crystal through periodic boundaries');
  toolbarButton.setAttribute('aria-pressed', 'false');
  toolbarButton.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M4.5 6.5h15v11h-15z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.2 1.8"/><path d="M12 3v18M3 12h18M12 3l-2.4 2.4M12 3l2.4 2.4M12 21l-2.4-2.4M12 21l2.4-2.4M3 12l2.4-2.4M3 12l2.4 2.4M21 12l-2.4-2.4M21 12l-2.4 2.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  document.getElementById('reset-camera')?.after(toolbarButton);
  const status = document.createElement('output');
  status.id = 'crystal-drag-status'; status.className = 'crystal-drag-status'; status.hidden = true;
  // Pointer moves update it continuously; the origin fields announce the result.
  status.setAttribute('aria-live', 'off');
  viewport?.append(status);

  let mode = false, enabled = false, touch = false;
  const gesture = new CrystalDragGesture(renderer, {
    getOrigin, getCoordinateMode,
    onChange: origin => showStatus(origin),
    onCommit: origin => commit(origin),
    onEnd: () => { status.hidden = true; renderer.canvas.classList.remove('crystal-dragging'); },
  });
  const periodic = () => Boolean(renderer.frame?.cell.pbc.some(Boolean));

  function showStatus(origin) {
    const pbc = renderer.frame?.cell.pbc ?? [];
    const values = AXES.flatMap((name, axis) => pbc[axis] ? [`${name} ${origin[axis].toFixed(4)}`] : []).join(' · ');
    status.textContent = `Origin ${values} — release to apply${touch ? '' : ', Esc cancels'}`;
    status.hidden = false;
  }
  function sync() {
    for (const button of [toolbarButton, sidebarButton]) {
      if (!button) continue;
      button.disabled = !enabled;
      button.setAttribute('aria-pressed', String(mode));
    }
    renderer.canvas.classList.toggle('crystal-drag-mode', mode && enabled);
  }
  function setMode(value) {
    mode = Boolean(value);
    if (!mode) gesture.cancel();
    sync();
  }
  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled) gesture.cancel();
    sync();
  }
  // camera-interactions.js decides which pointer gestures reach this object.
  renderer.crystalDragController = {
    accepts(event) {
      if (!enabled || !periodic()) return false;
      if (event.pointerType === 'touch') return mode;
      return event.button === 0 && !event.shiftKey && (mode || Boolean(event.altKey));
    },
    update(pointer) {
      if (!gesture.active) {
        if (!enabled || !gesture.begin(pointer.startX, pointer.startY)) return;
        touch = pointer.pointerType === 'touch';
        renderer.canvas.classList.add('crystal-dragging');
      }
      gesture.moveTo(pointer.x, pointer.y);
    },
    finish(apply) { return apply ? gesture.commit() : gesture.cancel(); },
  };

  /** Keyboard step: move the crystal by `amount` cell fractions along `axis`. */
  function canNudge(axis) { return enabled && Boolean(renderer.frame?.cell.pbc[axis]); }
  function nudge(axis, amount) {
    if (!canNudge(axis) || !Number.isFinite(amount)) return;
    gesture.cancel();
    const origin = [...getOrigin()];
    origin[axis] -= amount;
    commit(snapCrystalOrigin(origin, renderer.frame.cell, getCoordinateMode()));
  }

  const toggle = () => setMode(!mode);
  toolbarButton.addEventListener('click', toggle);
  sidebarButton?.addEventListener('click', toggle);
  sync();
  return {
    setMode, setEnabled, toggle, nudge, canNudge,
    dispose() {
      gesture.cancel();
      toolbarButton.removeEventListener('click', toggle); sidebarButton?.removeEventListener('click', toggle);
      toolbarButton.remove(); status.remove();
      if (renderer.crystalDragController) delete renderer.crystalDragController;
    },
  };
}
