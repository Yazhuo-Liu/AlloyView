export const MAX_SLICES = 16;

/** Sidebar editing for independent Cartesian clipping planes. */
export function initializeSliceControls({
  getDefaultSlice = () => ({ normal: [0, 0, 1], position: 0 }),
  onChange = () => {},
  onSelectionChange = () => {},
} = {}) {
  const element = (id) => document.getElementById(id);
  const controls = {
    add: element('add-slice'), remove: element('delete-slice'), list: element('slice-list'),
    empty: element('slice-empty'), settings: element('slice-settings'), status: element('slice-status'),
    name: element('slice-name'), enabled: element('slice-enabled'), gizmo: element('slice-show-gizmo'),
    normal: ['x', 'y', 'z'].map((axis) => element(`slice-normal-${axis}`)),
    offset: element('slice-offset'), side: element('slice-side'),
    presets: [...document.querySelectorAll('[data-slice-normal]')],
  };
  let slices = [];
  let selectedId = null;
  let nextId = 0;
  let frameLoaded = false;
  const selected = () => slices.find((slice) => slice.id === selectedId);
  const clone = (slice) => ({ ...slice, normal: [...slice.normal] });
  const getState = () => ({ slices: slices.map(clone), selectedId });

  function notify({ selectionChanged = false } = {}) {
    const state = getState();
    onChange(state.slices, state.selectedId);
    if (selectionChanged) onSelectionChange(state.selectedId);
  }

  function setStatus(message) {
    controls.status.textContent = message || `${slices.length} / ${MAX_SLICES} slices · All enabled planes apply together.`;
  }

  function renderList() {
    controls.list.replaceChildren();
    for (const slice of slices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.sliceId = slice.id;
      button.setAttribute('aria-pressed', String(slice.id === selectedId));
      button.classList.toggle('is-enabled', slice.enabled);
      button.disabled = !frameLoaded;
      const dot = document.createElement('span');
      dot.className = 'slice-list-dot';
      dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'slice-list-name';
      name.textContent = slice.name;
      const status = document.createElement('span');
      status.className = 'slice-list-state';
      status.textContent = slice.enabled ? 'On' : 'Off';
      button.append(dot, name, status);
      button.addEventListener('click', () => {
        if (slice.id === selectedId) return;
        selectedId = slice.id;
        render();
        notify({ selectionChanged: true });
      });
      controls.list.append(button);
    }
    controls.empty.hidden = slices.length !== 0;
  }

  function setInvalid(input, message = '') {
    input.setCustomValidity(message);
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function render({ editor = true } = {}) {
    const slice = selected();
    renderList();
    controls.settings.hidden = !slice;
    controls.add.disabled = !frameLoaded || slices.length >= MAX_SLICES;
    controls.add.title = slices.length >= MAX_SLICES ? `Maximum of ${MAX_SLICES} slices` : 'Add an independent clipping plane';
    for (const input of [controls.remove, controls.name, controls.enabled, controls.gizmo,
      ...controls.normal, controls.offset, controls.side, ...controls.presets]) {
      input.disabled = !frameLoaded || !slice;
    }
    if (editor && slice) {
      controls.name.value = slice.name;
      controls.enabled.checked = slice.enabled;
      controls.gizmo.checked = slice.showGizmo;
      controls.normal.forEach((input, axis) => {
        input.value = displayNumber(slice.normal[axis]);
        setInvalid(input);
      });
      controls.offset.value = displayNumber(slice.position);
      setInvalid(controls.offset);
      controls.side.value = slice.side;
    }
    setStatus();
  }

  function setState(state, { silent = true } = {}) {
    if (!state || !Array.isArray(state.slices)) throw new TypeError('Slice state must contain a slices array.');
    if (state.slices.length > MAX_SLICES) throw new RangeError(`A maximum of ${MAX_SLICES} slices is supported.`);
    const normalized = state.slices.map((slice, index) => normalizeSlice(slice, index));
    if (new Set(normalized.map((slice) => slice.id)).size !== normalized.length) {
      throw new TypeError('Slice IDs must be unique.');
    }
    const oldSelectedId = selectedId;
    slices = normalized;
    selectedId = state.selectedId === null ? null
      : (slices.some((slice) => slice.id === state.selectedId) ? state.selectedId : slices[0]?.id ?? null);
    const assignedIds = slices.map((slice) => Number(slice.id.match(/^slice-(\d+)$/)?.[1] ?? -1))
      .filter((id) => Number.isSafeInteger(id) && id < Number.MAX_SAFE_INTEGER - 1);
    nextId = Math.max(nextId, ...assignedIds.map((id) => id + 1));
    render();
    if (!silent) notify({ selectionChanged: oldSelectedId !== selectedId });
    return getState();
  }

  function addSlice() {
    if (!frameLoaded || slices.length >= MAX_SLICES) return null;
    const defaults = getDefaultSlice() || {};
    while (slices.some((slice) => slice.id === `slice-${nextId}`)) nextId += 1;
    const number = nextId++;
    const id = `slice-${number}`;
    const slice = normalizeSlice({ ...defaults, id, name: `Slice ${number}` }, slices.length);
    slices.push(slice);
    selectedId = id;
    render();
    notify({ selectionChanged: true });
    return clone(slice);
  }

  function updateNumeric({ commit = false } = {}) {
    const slice = selected();
    if (!slice || !frameLoaded) return;
    const normal = controls.normal.map((input) => input.value.trim() === '' ? NaN : Number(input.value));
    const length = Math.hypot(...normal);
    const normalValid = Number.isFinite(length) && length > 1e-12;
    const position = controls.offset.value.trim() === '' ? NaN : Number(controls.offset.value);
    const positionValid = Number.isFinite(position);
    controls.normal.forEach((input) => setInvalid(input, normalValid ? '' : 'Enter a finite, non-zero normal.'));
    setInvalid(controls.offset, positionValid ? '' : 'Enter a finite plane position in Å.');
    if (!normalValid || !positionValid) {
      setStatus(normalValid ? 'Enter a finite plane position in Å.' : 'Enter a finite, non-zero plane normal.');
      return;
    }
    slice.normal = normal.map((component) => component / length);
    slice.position = position;
    if (commit) render();
    else setStatus();
    notify();
  }

  controls.add.addEventListener('click', addSlice);
  controls.remove.addEventListener('click', () => {
    if (!selected() || !frameLoaded) return;
    const index = slices.findIndex((slice) => slice.id === selectedId);
    slices.splice(index, 1);
    selectedId = slices[Math.min(index, slices.length - 1)]?.id ?? null;
    render();
    notify({ selectionChanged: true });
  });
  controls.name.addEventListener('input', () => {
    const slice = selected();
    if (!slice || !frameLoaded) return;
    slice.name = controls.name.value.trim() || `Slice ${slices.indexOf(slice)}`;
    render({ editor: false });
    notify();
  });
  controls.name.addEventListener('change', () => render());
  for (const [input, property] of [[controls.enabled, 'enabled'], [controls.gizmo, 'showGizmo']]) {
    input.addEventListener('change', () => {
      const slice = selected();
      if (!slice || !frameLoaded) return;
      slice[property] = input.checked;
      render({ editor: false });
      notify();
    });
  }
  controls.side.addEventListener('change', () => {
    const slice = selected();
    if (!slice || !frameLoaded) return;
    slice.side = controls.side.value;
    notify();
  });
  for (const input of [...controls.normal, controls.offset]) {
    input.addEventListener('input', () => updateNumeric());
    input.addEventListener('change', () => updateNumeric({ commit: true }));
  }
  for (const button of controls.presets) button.addEventListener('click', () => {
    const slice = selected();
    if (!slice || !frameLoaded) return;
    slice.normal = ['x', 'y', 'z'].map((axis) => Number(axis === button.dataset.sliceNormal));
    render();
    notify();
  });
  render();
  return Object.freeze({
    getState, setState, addSlice,
    reset({ silent = true } = {}) {
      nextId = 0;
      return setState({ slices: [], selectedId: null }, { silent });
    },
    setEnabled(enabled) { frameLoaded = Boolean(enabled); render(); },
  });
}

function normalizeSlice(slice, index) {
  if (!slice || typeof slice !== 'object') throw new TypeError('Each slice must define a plane.');
  if (!Array.isArray(slice.normal) || slice.normal.length !== 3 || !slice.normal.every(Number.isFinite)) {
    throw new TypeError('Slice normals must contain three finite numbers.');
  }
  const length = Math.hypot(...slice.normal);
  if (!Number.isFinite(length) || !(length > 1e-12)) throw new TypeError('A slice normal must be finite and non-zero.');
  if (!Number.isFinite(slice.position)) throw new TypeError('Slice positions must be finite.');
  if (slice.side !== undefined && !['negative', 'positive'].includes(slice.side)) throw new TypeError('Unknown slice side.');
  const id = typeof slice.id === 'string' && slice.id ? slice.id : `slice-${index}`;
  const name = typeof slice.name === 'string' && slice.name.trim() ? slice.name.trim().slice(0, 80) : `Slice ${index}`;
  return {
    id, name, normal: slice.normal.map((component) => component / length), position: slice.position,
    side: slice.side ?? 'negative', enabled: slice.enabled !== false, showGizmo: slice.showGizmo !== false,
  };
}

function displayNumber(value) {
  return String(Number(value.toPrecision(8)));
}
