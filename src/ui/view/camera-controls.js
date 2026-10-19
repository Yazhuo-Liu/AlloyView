const DEGREES = 180 / Math.PI;
const AXES = ['X', 'Y', 'Z'];
const COLORS = ['#ef6666', '#58c878', '#669efa'];
const wrapAngle = angle => Math.atan2(Math.sin(angle), Math.cos(angle)) * DEGREES;
const formatNumber = value => Number(value.toPrecision(8)).toString();

/** Precise controls live beside the viewport export button and never enter image captures. */
export function initializeCameraControls({ renderer, onEdit = () => {}, onDisplayChange } = {}) {
  const document = renderer.canvas.ownerDocument;
  const viewport = renderer.canvas.parentElement;
  const toolbar = document.getElementById('export-png')?.parentElement;
  if (!viewport || !toolbar) return { sync() {}, close() {}, setEnabled() {}, dispose() {} };
  if (!document.getElementById('camera-controls-styles')) {
    const css = document.createElement('link');
    css.id = 'camera-controls-styles'; css.rel = 'stylesheet';
    css.href = new URL('./camera-controls.css', import.meta.url).href;
    document.head.append(css);
  }
  const button = document.createElement('button');
  button.id = 'toggle-camera-controls'; button.type = 'button'; button.title = 'Adjust view';
  button.setAttribute('aria-label', 'Adjust view'); button.setAttribute('aria-controls', 'camera-controls');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  document.getElementById('export-png').after(button);
  const panel = document.createElement('section');
  panel.id = 'camera-controls'; panel.className = 'camera-controls'; panel.hidden = true; panel.inert = true;
  panel.setAttribute('aria-label', 'Adjust view');
  const vectorFields = (name, title, readonly = false) => `<fieldset><legend>${title}</legend><div class="camera-triple">${AXES.map((axis, i) => `<label><span>${axis}</span><input id="camera-${name}-${i}" data-vector="${name}" data-axis="${i}" type="number" step="any" aria-label="${title} ${axis}"${readonly ? ' readonly' : ''}></label>`).join('')}</div></fieldset>`;
  const angleFields = (name, title, min, max) => `<label class="camera-angle"><span>${title}</span><input id="camera-${name}-slider" data-angle="${name}" type="range" min="${min}" max="${max}" step="0.1" aria-label="${title}"><input id="camera-${name}" data-angle="${name}" type="number" step="0.1" aria-label="${title} degrees"><span>°</span></label>`;
  panel.innerHTML = `<header><strong>Adjust view</strong><button id="close-camera-controls" type="button" aria-label="Close adjust view">×</button></header>
    <div class="camera-controls-body">
      <div class="camera-orientation">
        <svg id="camera-trackball" viewBox="0 0 120 120" role="img" tabindex="0" aria-label="Drag to rotate the camera; arrow keys rotate, plus and minus zoom">
          <circle cx="60" cy="60" r="48" class="camera-globe-surface"/>
          <ellipse cx="60" cy="60" rx="48" ry="16" class="camera-globe-ring"/><ellipse cx="60" cy="60" rx="16" ry="48" class="camera-globe-ring"/>
          ${AXES.map((axis, i) => `<g data-camera-axis="${i}"><line x1="60" y1="60"/><circle r="8"/><text text-anchor="middle" dy="3">${axis}</text></g>`).join('')}
          <circle cx="60" cy="60" r="3" class="camera-globe-center"/>
        </svg>
        <div class="camera-angles">${angleFields('yaw', 'Azimuth', -180, 180)}${angleFields('pitch', 'Elevation', -89.5, 89.5)}</div>
      </div>
      <p class="camera-help">Drag the globe to rotate. Values follow viewport orbit, pan and zoom.</p>
      ${vectorFields('position', 'Camera position')}${vectorFields('direction', 'View direction')}
      <fieldset><legend>Up direction</legend><label class="camera-upright"><input id="camera-constrain-up" type="checkbox">Keep Z pointing upward</label>
        ${angleFields('roll', 'Roll', -180, 180)}
        <div class="camera-triple">${AXES.map((axis, i) => `<label><span>${axis}</span><input id="camera-up-${i}" type="number" readonly aria-label="Up direction ${axis} read only"></label>`).join('')}</div>
      </fieldset>
      <fieldset><legend>Projection</legend>
        <label class="camera-setting"><span>Type</span><select id="camera-projection"><option value="perspective">Perspective</option><option value="orthographic">Parallel</option></select></label>
        <label class="camera-setting"><span>View angle (°)</span><input id="camera-fov" type="number" min="1" max="175" step="0.1"></label>
        <input id="camera-fov-slider" type="range" min="1" max="175" step="0.1" aria-label="Perspective view angle">
        <label class="camera-setting"><span>Field width</span><input id="camera-field-width" type="number" min="0.001" step="any"></label>
        <label class="camera-zoom"><span>Zoom</span><input id="camera-zoom" type="range" min="-6" max="6" step="0.01" aria-label="Camera zoom"></label>
      </fieldset>
      <fieldset><legend>Cell outline</legend><label class="camera-setting"><span>Edges</span><select id="camera-cell-outline"><option value="mono">Single color</option><option value="rgb">RGB cell directions</option><option value="rgb-origin">RGB origin edges</option><option value="rgb-black">RGB origin, black edges</option></select></label></fieldset>
      <p id="camera-controls-status" class="camera-status" role="status" aria-live="polite"></p>
    </div>`;
  viewport.append(panel);
  const fields = new Map();
  const dirtyInputs = new Set();
  const field = id => {
    if (!fields.has(id)) fields.set(id, panel.querySelector(`#camera-${id}`));
    return fields.get(id);
  };
  const axisGraphics = [...panel.querySelectorAll('[data-camera-axis]')].map(group => ({ group,
    axis: Number(group.dataset.cameraAxis), line: group.querySelector('line'),
    circle: group.querySelector('circle'), text: group.querySelector('text') }));
  const listeners = [];
  const narrow = document.defaultView?.matchMedia?.('(max-width: 920px)');
  let enabled = true;
  let drag = null;
  function listen(target, event, callback, options) {
    target?.addEventListener(event, callback, options);
    listeners.push(() => target?.removeEventListener(event, callback, options));
  }
  function close({ focus = false } = {}) {
    if (focus && panel.contains(document.activeElement)) button.focus();
    panel.hidden = true; panel.inert = true; button.setAttribute('aria-expanded', 'false');
    finishDrag();
  }
  function open() {
    if (!renderer.frame || !enabled) return;
    if (narrow?.matches) {
      for (const [wrapperId, buttonId, panelId] of [['view-overlay', 'toggle-view-controls', 'view-controls'],
        ['legend-overlay', 'toggle-legend', 'legend'], ['atom-details-overlay', 'toggle-atom-details', 'atom-details']]) {
        document.getElementById(wrapperId)?.classList.remove('is-expanded');
        document.getElementById(buttonId)?.setAttribute('aria-expanded', 'false');
        const other = document.getElementById(panelId);
        if (other) { other.inert = true; if (panelId === 'atom-details') other.hidden = true; }
      }
      document.getElementById('background-picker')?.removeAttribute('open');
    }
    panel.hidden = false; panel.inert = false; button.setAttribute('aria-expanded', 'true'); sync();
  }
  function assign(input, value) {
    // A focused committed value still follows mouse gestures. Only a draft that
    // the user is currently typing is protected from renderer notifications.
    if (input.readOnly || document.activeElement !== input || !dirtyInputs.has(input)) input.value = formatNumber(value);
  }
  function zoomBase(state) {
    return state.projectionMode === 'orthographic' ? Math.max(.001, 2 * (renderer.modelRadius || 1)) : Math.max(.02, (renderer.modelRadius || 1) * 3.5);
  }
  function sync() {
    button.disabled = !renderer.frame || !enabled;
    if (button.disabled) close();
    if (panel.hidden) return;
    const state = renderer.getCameraState();
    for (const name of ['position', 'direction', 'up']) AXES.forEach((_axis, i) => assign(field(`${name}-${i}`), state[name][i]));
    for (const name of ['yaw', 'pitch', 'roll']) {
      const value = wrapAngle(state[name]);
      assign(field(name), value); assign(field(`${name}-slider`), value);
    }
    field('pitch-slider').min = state.constrainUp ? -89.5 : -180;
    field('pitch-slider').max = state.constrainUp ? 89.5 : 180;
    field('constrain-up').checked = state.constrainUp;
    field('roll').disabled = field('roll-slider').disabled = state.constrainUp;
    field('projection').value = state.projectionMode;
    assign(field('fov'), state.fov * DEGREES); assign(field('fov-slider'), state.fov * DEGREES);
    field('fov').disabled = field('fov-slider').disabled = state.projectionMode !== 'perspective';
    assign(field('field-width'), state.fieldWidth);
    field('field-width').disabled = state.projectionMode !== 'orthographic';
    const zoomAmount = state.projectionMode === 'orthographic' ? state.fieldWidth : state.distance;
    const zoomValue = -Math.log2(zoomAmount / zoomBase(state));
    field('zoom').min = Math.min(-6, Math.floor(zoomValue)); field('zoom').max = Math.max(6, Math.ceil(zoomValue));
    assign(field('zoom'), zoomValue);
    field('cell-outline').value = renderer.cellWireframeMode ?? 'mono';
    const { right, up } = renderer.cameraBasis();
    for (const { group, axis, line, circle, text } of axisGraphics) {
      const x = 60 + right[axis] * 39, y = 60 - up[axis] * 39;
      line.setAttribute('x2', x); line.setAttribute('y2', y); line.setAttribute('stroke', COLORS[axis]);
      circle.setAttribute('cx', x); circle.setAttribute('cy', y); circle.setAttribute('fill', COLORS[axis]);
      text.setAttribute('x', x); text.setAttribute('y', y);
      group.style.opacity = state.direction[axis] > 0 ? '.55' : '1';
    }
  }
  function apply(patch, committedInputs = []) {
    try {
      renderer.setCameraState(patch);
      for (const input of committedInputs) dirtyInputs.delete(input);
      onEdit(); field('controls-status').textContent = ''; sync();
    } catch (error) { field('controls-status').textContent = error.message; }
  }
  listen(button, 'click', () => panel.hidden ? open() : close());
  listen(panel.querySelector('#close-camera-controls'), 'click', () => close({ focus: true }));
  listen(document, 'pointerdown', event => {
    // Keep the panel visible while the viewport is dragged so its numbers follow
    // orbit, pan and zoom in real time.
    if (!panel.hidden && !viewport.contains(event.target)) close();
  });
  listen(document, 'keydown', event => { if (event.key === 'Escape') close({ focus: true }); });
  listen(narrow, 'change', () => close({ focus: true }));
  for (const id of ['toggle-view-controls', 'toggle-legend', 'toggle-atom-details']) {
    listen(document.getElementById(id), 'click', () => { if (narrow?.matches) close(); });
  }
  for (const input of panel.querySelectorAll('input[type="number"]')) {
    if (input.readOnly) continue;
    listen(input, 'input', () => dirtyInputs.add(input));
    listen(input, 'blur', () => { dirtyInputs.delete(input); sync(); });
  }
  for (const input of panel.querySelectorAll('[data-vector]')) listen(input, 'change', () => {
    const name = input.dataset.vector;
    const values = AXES.map((_axis, i) => field(`${name}-${i}`));
    if (values.some(value => value.value.trim() === '' || !value.checkValidity())) {
      field('controls-status').textContent = 'Enter three finite coordinates.'; return;
    }
    apply({ [name]: values.map(value => Number(value.value)) }, values);
  });
  for (const input of panel.querySelectorAll('[data-angle]')) listen(input, input.type === 'range' ? 'input' : 'change', () => {
    if (input.value.trim() === '' || !input.checkValidity()) { field('controls-status').textContent = 'Enter a finite angle.'; return; }
    apply({ [input.dataset.angle]: Number(input.value) / DEGREES }, [input]);
  });
  listen(field('constrain-up'), 'change', () => apply({ constrainUp: field('constrain-up').checked }));
  listen(field('projection'), 'change', () => apply({ projectionMode: field('projection').value }));
  for (const id of ['fov', 'fov-slider']) listen(field(id), id.endsWith('slider') ? 'input' : 'change', () => {
    const input = field(id);
    if (!input.value.trim() || !input.checkValidity()) { field('controls-status').textContent = 'Choose a view angle from 1° to 175°.'; return; }
    apply({ fov: Number(input.value) / DEGREES }, [input]);
  });
  listen(field('field-width'), 'change', () => {
    const input = field('field-width');
    if (!input.value.trim() || !input.checkValidity()) { field('controls-status').textContent = 'Field width must be at least 0.001.'; return; }
    apply({ fieldWidth: Number(input.value) }, [input]);
  });
  function zoom(value) {
    const state = renderer.getCameraState(), key = state.projectionMode === 'orthographic' ? 'fieldWidth' : 'distance';
    apply({ [key]: Math.max(key === 'distance' ? .02 : .001, zoomBase(state) * 2 ** -value) });
  }
  listen(field('zoom'), 'input', () => zoom(Number(field('zoom').value)));
  listen(field('cell-outline'), 'change', () => {
    onEdit();
    if (onDisplayChange) onDisplayChange({ cellWireframeMode: field('cell-outline').value });
    else renderer.setCellWireframeMode?.(field('cell-outline').value);
    sync();
  });
  const globe = panel.querySelector('#camera-trackball');
  function finishDrag() {
    const id = drag?.id; drag = null;
    if (id !== undefined && globe.hasPointerCapture?.(id)) globe.releasePointerCapture(id);
  }
  listen(globe, 'pointerdown', event => {
    if (drag || event.button !== 0) return;
    event.preventDefault(); drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    globe.setPointerCapture(event.pointerId); globe.focus({ preventScroll: true });
  });
  listen(globe, 'pointermove', event => {
    if (event.pointerId !== drag?.id) return;
    event.preventDefault();
    renderer.orbitCamera((drag.x - event.clientX) * .014, (event.clientY - drag.y) * .014);
    drag.x = event.clientX; drag.y = event.clientY;
    onEdit(); renderer.requestRender(); sync();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(globe, name, event => { if (event.pointerId === drag?.id) finishDrag(); });
  listen(document.defaultView, 'blur', finishDrag);
  listen(globe, 'keydown', event => {
    const direction = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (direction) {
      event.preventDefault(); const step = (event.shiftKey ? 15 : 2) / DEGREES;
      renderer.orbitCamera(direction[0] * step, direction[1] * step); onEdit(); renderer.requestRender(); sync();
    } else if (['+', '=', '-'].includes(event.key)) {
      event.preventDefault(); const state = renderer.getCameraState();
      const current = state.projectionMode === 'orthographic' ? state.fieldWidth : state.distance;
      zoom(-Math.log2(current / zoomBase(state)) + (event.key === '-' ? -.1 : .1));
    }
  });
  const previousCameraChange = renderer.onCameraChange;
  const onCameraChange = (...args) => { previousCameraChange?.apply(renderer, args); sync(); };
  renderer.onCameraChange = onCameraChange;
  sync();
  return { sync, close, setEnabled(value) { enabled = Boolean(value); sync(); }, dispose() {
    close(); for (const remove of listeners) remove();
    if (renderer.onCameraChange === onCameraChange) renderer.onCameraChange = previousCameraChange;
    panel.remove(); button.remove();
  } };
}
