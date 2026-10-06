import { sliceBetweenAtoms, sliceThroughAtoms, sliceThroughAtom } from './slice-from-atoms.js';

export const MAX_SLICES = 16;

/** Sidebar editing for independent Cartesian clipping planes. */
export function initializeSliceControls({
  getDefaultSlice = () => ({ normal: [0, 0, 1], position: 0 }),
  getPickedPoints = () => [],
  getSelectedPoint = () => null,
  getSelectedAtomId = () => null,
  resolveAtomPoint,
  onChange = () => {},
  onSelectionChange = () => {},
  onPickModeChange = () => {},
} = {}) {
  const element = (id) => document.getElementById(id);
  const controls = {
    add: element('add-slice'), remove: element('delete-slice'), list: element('slice-list'),
    empty: element('slice-empty'), settings: element('slice-settings'), status: element('slice-status'),
    name: element('slice-name'), enabled: element('slice-enabled'), gizmo: element('slice-show-gizmo'),
    normal: ['x', 'y', 'z'].map((axis) => element(`slice-normal-${axis}`)),
    offset: element('slice-offset'), side: element('slice-side'),
    pick: element('slice-pick-atoms'), clearPicks: element('slice-clear-picks'),
    fromTwo: element('slice-from-two'), fromThree: element('slice-from-three'),
    toAtom: element('slice-to-atom'), pickHelp: element('slice-pick-help'),
    presets: [...document.querySelectorAll('[data-slice-normal]')],
  };
  let slices = [];
  let selectedId = null;
  let nextId = 0;
  let frameLoaded = false;
  let picking = false;
  let pickedAtoms = [];
  let pickMessage = '';
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

  function pickedPoints() {
    if (!pickedAtoms.length) return getPickedPoints() || [];
    return pickedAtoms.map((atom) => ({ ...atom,
      position: typeof resolveAtomPoint === 'function' ? resolveAtomPoint(atom.id, atom) : atom.position,
    }));
  }

  function selectedAtomPoint() {
    const last = pickedPoints().at(-1);
    if (pickedAtoms.length) {
      const selectedAtomId = getSelectedAtomId();
      // A later ordinary selection supersedes the slice's pick list. Retain
      // the clicked cell copy when both selections refer to the same atom.
      if (selectedAtomId !== null && selectedAtomId !== undefined && selectedAtomId !== last?.id) return getSelectedPoint();
      return last?.position;
    }
    return getSelectedPoint() || last?.position;
  }

  function renderPicking() {
    const points = pickedPoints();
    const ready = (count) => points.length >= count
      && points.slice(0, count).every((atom) => atom?.position?.length === 3
        && Array.from(atom.position).every(Number.isFinite));
    if (controls.pick) {
      controls.pick.disabled = !frameLoaded;
      controls.pick.setAttribute('aria-pressed', String(picking));
      controls.pick.classList.toggle('is-active', picking);
      controls.pick.textContent = picking ? 'Finish picking' : 'Pick atoms';
    }
    if (controls.clearPicks) controls.clearPicks.disabled = !pickedAtoms.length;
    const canCreate = frameLoaded && slices.length < MAX_SLICES;
    if (controls.fromTwo) controls.fromTwo.disabled = !canCreate || !ready(2);
    if (controls.fromThree) controls.fromThree.disabled = !canCreate || !ready(3);
    const selectedPoint = selectedAtomPoint();
    if (controls.toAtom) controls.toAtom.disabled = !frameLoaded || !selected()
      || !selectedPoint || selectedPoint.length !== 3 || !Array.from(selectedPoint).every(Number.isFinite);
    if (controls.pickHelp) {
      const ids = points.map((atom, index) => `${index + 1}: ${String(atom.id)}`).join(' · ');
      const missing = points.some((atom) => !atom?.position);
      controls.pickHelp.textContent = pickMessage || (missing
        ? 'A picked atom is absent from this frame. Clear the picks and choose atoms in this frame.'
        : `${ids ? `Picked atoms ${ids}. ` : ''}${picking
          ? 'Click up to three atoms in order. Drag the view to rotate it.'
          : 'Pick two atoms for a bisector or three atoms for a plane through them.'}`);
    }
  }

  function setPicking(active) {
    const next = Boolean(active) && frameLoaded;
    if (picking !== next) {
      picking = next;
      onPickModeChange(picking);
    }
    pickMessage = '';
    renderPicking();
    return picking;
  }

  function clearPickedAtoms() {
    pickedAtoms = [];
    pickMessage = '';
    renderPicking();
  }

  function addPickedAtom(atom) {
    if (!frameLoaded || !picking) return false;
    if (!atom || atom.id === null || atom.id === undefined
      || !atom.position || atom.position.length !== 3 || !Array.from(atom.position).every(Number.isFinite)) {
      pickMessage = 'This atom has no finite display coordinates.';
      renderPicking();
      return false;
    }
    if (pickedAtoms.some((picked) => picked.id === atom.id)) {
      pickMessage = 'That atom is already picked. Choose a different atom.';
      renderPicking();
      return false;
    }
    if (pickedAtoms.length >= 3) {
      pickMessage = 'Three atoms are already picked. Clear the picks to choose a new plane.';
      renderPicking();
      return false;
    }
    if (atom.replicaIndices !== undefined && (!atom.replicaIndices || atom.replicaIndices.length !== 3
      || !Array.from(atom.replicaIndices).every(Number.isSafeInteger))) {
      pickMessage = 'This displayed atom has an invalid cell replica.';
      renderPicking();
      return false;
    }
    pickedAtoms.push({ id: atom.id, position: Array.from(atom.position),
      ...(atom.replicaIndices ? { replicaIndices: Array.from(atom.replicaIndices) } : {}),
    });
    pickMessage = '';
    if (pickedAtoms.length === 3) setPicking(false);
    else renderPicking();
    return true;
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
    renderPicking();
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

  function addSlice(plane) {
    if (!frameLoaded || slices.length >= MAX_SLICES) return null;
    const defaults = plane || getDefaultSlice() || {};
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

  function createFromPickedAtoms(count) {
    if (!frameLoaded) return null;
    if (slices.length >= MAX_SLICES) {
      setStatus(`Maximum of ${MAX_SLICES} slices. Delete a slice before creating another.`);
      return null;
    }
    try {
      const points = pickedPoints();
      if (![2, 3].includes(count) || points.length < count) {
        throw new Error(`Pick ${count} atoms first.`);
      }
      const atoms = points.slice(0, count);
      if (new Set(atoms.map((atom) => atom.id)).size !== count) {
        throw new Error('Pick different atoms. Each atom can be used only once.');
      }
      const positions = atoms.map((atom) => atom.position);
      const plane = count === 2 ? sliceBetweenAtoms(...positions) : sliceThroughAtoms(...positions);
      const slice = addSlice(plane);
      setPicking(false);
      return slice;
    } catch (error) {
      pickMessage = error.message;
      renderPicking();
      setStatus(error.message);
      return null;
    }
  }

  function moveToPickedAtom() {
    const slice = selected();
    if (!frameLoaded || !slice) return null;
    try {
      const point = selectedAtomPoint();
      if (!point) throw new Error('Select or pick an atom first.');
      const updated = sliceThroughAtom(slice, point);
      Object.assign(slice, updated);
      setPicking(false);
      render();
      notify();
      return clone(slice);
    } catch (error) {
      pickMessage = error.message;
      renderPicking();
      setStatus(error.message);
      return null;
    }
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

  controls.add.addEventListener('click', () => addSlice());
  controls.pick?.addEventListener('click', () => setPicking(!picking));
  controls.clearPicks?.addEventListener('click', clearPickedAtoms);
  controls.fromTwo?.addEventListener('click', () => createFromPickedAtoms(2));
  controls.fromThree?.addEventListener('click', () => createFromPickedAtoms(3));
  controls.toAtom?.addEventListener('click', moveToPickedAtom);
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
    getState, setState, addSlice, createFromPickedAtoms, moveToPickedAtom,
    setPicking, isPicking: () => picking, addPickedAtom, clearPickedAtoms,
    getPickedAtomIds: () => pickedAtoms.map((atom) => atom.id),
    refreshPickedAtoms() { pickMessage = ''; renderPicking(); },
    reset({ silent = true } = {}) {
      setPicking(false);
      clearPickedAtoms();
      nextId = 0;
      return setState({ slices: [], selectedId: null }, { silent });
    },
    setEnabled(enabled) {
      frameLoaded = Boolean(enabled);
      if (!frameLoaded) setPicking(false);
      render();
    },
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
