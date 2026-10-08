import { sliceBetweenAtoms, sliceThroughAtoms, sliceThroughAtom } from './slice-from-atoms.js';
import { dot } from './render/math.js';
import {
  DEFAULT_SLAB_THICKNESS, DEFAULT_SLICE_STEP, flippedSliceSide, millerPlane, nearestLatticePlanePosition,
  stepSlicePosition, validateMillerIndices, validateSliceLength,
} from './render/slicing.js';

export const MAX_SLICES = 16;
// Holding a step button repeats like a key: one step, a pause, then a stream.
const STEP_REPEAT_DELAY = 400;
const STEP_REPEAT_INTERVAL = 80;

/** Sidebar editing for independent Cartesian clipping planes. */
export function initializeSliceControls({
  getDefaultSlice = () => ({ normal: [0, 0, 1], position: 0 }),
  getPickedPoints = () => [],
  getSelectedPoint = () => null,
  getSelectedAtomId = () => null,
  getCell = () => null,
  resolveAtomPoint,
  onChange = () => {},
  onSelectionChange = () => {},
  onPickModeChange = () => {},
  onPickedAtomsChange = () => {},
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
    miller: ['h', 'k', 'l'].map((index) => element(`slice-miller-${index}`)),
    applyMiller: element('slice-apply-miller'), millerResult: element('slice-miller-result'),
    step: element('slice-step'), stepBack: element('slice-step-back'), stepForward: element('slice-step-forward'),
    flip: element('slice-flip'), slab: element('slice-slab'), thickness: element('slice-thickness'),
    showOutlines: element('slice-show-outlines'), exportOutlines: element('slice-export-outlines'),
  };
  let slices = [];
  let selectedId = null;
  let nextId = 0;
  let frameLoaded = false;
  let picking = false;
  let pickedAtoms = [];
  let pickMessage = '';
  // Outline display is one choice for all planes, kept across source reloads.
  let showOutlines = false;
  let exportOutlines = true;
  const selected = () => slices.find((slice) => slice.id === selectedId);
  const clone = (slice) => ({ ...slice, normal: [...slice.normal], miller: slice.miller ? [...slice.miller] : null });
  const getState = () => ({ slices: slices.map(clone), selectedId, showOutlines, exportOutlines });

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
    // Slice picks have their own highlight channel. The measurement fallback
    // can define a plane too, but does not become a retained slice selection.
    onPickedAtomsChange(frameLoaded && pickedAtoms.length ? points.filter((atom) =>
      atom?.position?.length === 3 && Array.from(atom.position).every(Number.isFinite))
      .map((atom) => atom.id) : []);
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
      status.textContent = slice.enabled ? (slice.slab ? 'Slab' : 'On') : 'Off';
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
      ...controls.normal, controls.offset, controls.side, ...controls.presets,
      ...controls.miller, controls.step, controls.stepBack, controls.stepForward, controls.flip,
      controls.slab, controls.thickness]) {
      input.disabled = !frameLoaded || !slice;
    }
    // A slab keeps both sides of its plane, so only its thickness applies.
    if (slice?.slab) controls.side.disabled = controls.flip.disabled = true;
    else controls.thickness.disabled = true;
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
      controls.miller.forEach((input, axis) => { input.value = slice.miller ? String(slice.miller[axis]) : ''; });
      controls.step.value = displayNumber(slice.step);
      setInvalid(controls.step);
      controls.slab.checked = slice.slab;
      controls.thickness.value = displayNumber(slice.thickness);
      setInvalid(controls.thickness);
    }
    controls.showOutlines.checked = showOutlines;
    controls.showOutlines.disabled = !frameLoaded;
    controls.exportOutlines.checked = exportOutlines;
    controls.exportOutlines.disabled = !frameLoaded || !showOutlines;
    renderMiller();
    renderPicking();
    setStatus();
  }

  // Null until all three indices are entered, so typing is not flagged.
  function millerInputs() {
    const values = controls.miller.map((input) => input.value.trim());
    return values.some((value) => value === '') ? null : values.map(Number);
  }

  // Preview the entered indices in the current frame's cell. The stored
  // normal stays numerically fixed when a later frame changes the cell.
  function renderMiller() {
    const slice = selected(), indices = millerInputs(), cell = getCell();
    let plane = null;
    let message = 'Enter integer indices h, k and l to set the normal from the cell\'s reciprocal lattice.';
    if (slice && indices) {
      try {
        if (!cell?.vectors) throw new Error('Load a structure with a cell to use Miller indices.');
        plane = millerPlane(indices, cell.vectors);
        validateSliceLength(plane.spacing, 'interplanar spacing');
        message = `n = (${plane.normal.map(formatValue).join(', ')}) · d = ${formatValue(plane.spacing)} Å`;
        if (slice.miller?.every((value, axis) => value === plane.indices[axis])
          && plane.normal.some((value, axis) => Math.abs(value - slice.normal[axis]) > 1e-9)) {
          message += '. This frame\'s cell differs; apply again to realign.';
        }
      } catch (error) {
        plane = null;
        message = error.message;
      }
    }
    const invalid = Boolean(slice && indices && !plane && cell?.vectors);
    controls.miller.forEach((input) => setInvalid(input, invalid ? message : ''));
    controls.millerResult.textContent = message;
    controls.applyMiller.disabled = !frameLoaded || !slice || !plane;
    return plane;
  }

  /** Align the normal with (h k l), place the plane on the lattice plane
   * nearest its current center, and step or slab by one spacing d. */
  function applyMiller() {
    const slice = selected(), cell = getCell();
    if (!slice || !frameLoaded || !cell?.vectors) return null;
    const plane = renderMiller();
    if (!plane) return null;
    const origin = Array.from(cell.origin ?? [0, 0, 0]);
    const center = origin.map((value, axis) => value
      + (cell.vectors[axis] + cell.vectors[3 + axis] + cell.vectors[6 + axis]) / 2);
    const offset = slice.position - dot(slice.normal, center);
    const anchor = center.map((value, axis) => value + offset * slice.normal[axis]);
    Object.assign(slice, { normal: [...plane.normal], miller: plane.indices, step: plane.spacing,
      thickness: plane.spacing, position: nearestLatticePlanePosition(plane, origin, anchor) });
    render();
    notify();
    return clone(slice);
  }

  function stepSelected(count) {
    const slice = selected();
    if (!slice || !frameLoaded) return false;
    try {
      slice.position = stepSlicePosition(slice.position, slice.step, count);
    } catch (error) {
      setStatus(error.message);
      return false;
    }
    controls.offset.value = displayNumber(slice.position);
    setInvalid(controls.offset);
    setStatus();
    notify();
    return true;
  }

  function flipSelected() {
    const slice = selected();
    if (!slice || !frameLoaded || slice.slab) return null;
    slice.side = flippedSliceSide(slice.side);
    controls.side.value = slice.side;
    notify();
    return clone(slice);
  }

  // Pointer presses step at once and repeat while held. Keyboard activation
  // and scripted clicks report no pointer detail and step once.
  function bindStepButton(button, count) {
    let timer = null;
    const stop = () => { clearTimeout(timer); timer = null; };
    const repeat = (delay) => {
      timer = setTimeout(() => { if (stepSelected(count)) repeat(STEP_REPEAT_INTERVAL); else stop(); }, delay);
    };
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || button.disabled) return;
      stop();
      if (stepSelected(count)) repeat(STEP_REPEAT_DELAY);
    });
    for (const name of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) button.addEventListener(name, stop);
    button.addEventListener('click', (event) => { if (!event.detail) stepSelected(count); });
  }

  function updateLength(input, property, { commit = false } = {}) {
    const slice = selected();
    if (!slice || !frameLoaded) return;
    // The field shows the stored length rounded to 8 digits; keep the exact
    // value, such as a d-spacing, until the user types a different number.
    if (input.value.trim() === displayNumber(slice[property])) {
      setInvalid(input);
      setStatus();
      return;
    }
    const value = input.value.trim() === '' ? NaN : Number(input.value);
    try {
      slice[property] = validateSliceLength(value, property === 'step' ? 'step' : 'slab thickness');
      if (commit) input.value = displayNumber(slice[property]);
      setInvalid(input);
      setStatus();
    } catch (error) {
      if (commit) {
        input.value = displayNumber(slice[property]);
        setInvalid(input);
        setStatus();
      } else {
        setInvalid(input, error.message);
        setStatus(error.message);
      }
      return;
    }
    if (property === 'thickness' && slice.slab) notify();
  }

  function setState(state, { silent = true } = {}) {
    if (!state || !Array.isArray(state.slices)) throw new TypeError('Slice state must contain a slices array.');
    if (state.slices.length > MAX_SLICES) throw new RangeError(`A maximum of ${MAX_SLICES} slices is supported.`);
    const normalized = state.slices.map((slice, index) => normalizeSlice(slice, index));
    if (new Set(normalized.map((slice) => slice.id)).size !== normalized.length) {
      throw new TypeError('Slice IDs must be unique.');
    }
    for (const property of ['showOutlines', 'exportOutlines']) {
      if (state[property] !== undefined && typeof state[property] !== 'boolean') {
        throw new TypeError(`Slice ${property} must be true or false.`);
      }
    }
    const oldSelectedId = selectedId;
    slices = normalized;
    showOutlines = state.showOutlines ?? showOutlines;
    exportOutlines = state.exportOutlines ?? exportOutlines;
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
    // Unedited fields show the stored normal rounded to 8 digits. Keep the
    // exact normal, and its Miller indices, unless a component was changed.
    const normalEdited = controls.normal.some((input, axis) => input.value.trim() !== displayNumber(slice.normal[axis]));
    const normal = controls.normal.map((input) => input.value.trim() === '' ? NaN : Number(input.value));
    const length = Math.hypot(...normal);
    const normalValid = !normalEdited || (Number.isFinite(length) && length > 1e-12);
    const position = controls.offset.value.trim() === '' ? NaN : Number(controls.offset.value);
    const positionValid = Number.isFinite(position);
    controls.normal.forEach((input) => setInvalid(input, normalValid ? '' : 'Enter a finite, non-zero normal.'));
    setInvalid(controls.offset, positionValid ? '' : 'Enter a finite plane position in Å.');
    if (!normalValid || !positionValid) {
      setStatus(normalValid ? 'Enter a finite plane position in Å.' : 'Enter a finite, non-zero plane normal.');
      return;
    }
    if (normalEdited) {
      slice.normal = normal.map((component) => component / length);
      slice.miller = null;
    }
    slice.position = position;
    if (commit) render();
    else {
      renderMiller();
      setStatus();
    }
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
    clearPickedAtoms();
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
    slice.miller = null;
    render();
    notify();
  });
  controls.offset.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    // Arrow keys sweep by the plane's own step instead of the input's grid.
    event.preventDefault();
    stepSelected(event.key === 'ArrowUp' ? 1 : -1);
  });
  bindStepButton(controls.stepBack, -1);
  bindStepButton(controls.stepForward, 1);
  controls.flip.addEventListener('click', flipSelected);
  controls.step.addEventListener('input', () => updateLength(controls.step, 'step'));
  controls.step.addEventListener('change', () => updateLength(controls.step, 'step', { commit: true }));
  controls.thickness.addEventListener('input', () => updateLength(controls.thickness, 'thickness'));
  controls.thickness.addEventListener('change', () => updateLength(controls.thickness, 'thickness', { commit: true }));
  controls.slab.addEventListener('change', () => {
    const slice = selected();
    if (!slice || !frameLoaded) return;
    slice.slab = controls.slab.checked;
    render({ editor: false });
    notify();
  });
  for (const input of controls.miller) {
    input.addEventListener('input', () => renderMiller());
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      applyMiller();
    });
  }
  controls.applyMiller.addEventListener('click', applyMiller);
  controls.showOutlines.addEventListener('change', () => {
    if (!frameLoaded) return;
    showOutlines = controls.showOutlines.checked;
    render({ editor: false });
    notify();
  });
  controls.exportOutlines.addEventListener('change', () => {
    if (frameLoaded) exportOutlines = controls.exportOutlines.checked;
  });
  render();
  return Object.freeze({
    getState, setState, addSlice, createFromPickedAtoms, moveToPickedAtom,
    applyMiller, stepSelected, flipSelected,
    setPicking, isPicking: () => picking, addPickedAtom, clearPickedAtoms,
    getPickedAtomIds: () => pickedAtoms.map((atom) => atom.id),
    // Called whenever the displayed frame or coordinates change; the Miller
    // preview follows the current frame's cell.
    refreshPickedAtoms() { pickMessage = ''; renderMiller(); renderPicking(); },
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
  if (slice.slab !== undefined && typeof slice.slab !== 'boolean') throw new TypeError('Slice slab mode must be true or false.');
  const id = typeof slice.id === 'string' && slice.id ? slice.id : `slice-${index}`;
  const name = typeof slice.name === 'string' && slice.name.trim() ? slice.name.trim().slice(0, 80) : `Slice ${index}`;
  return {
    id, name, normal: slice.normal.map((component) => component / length), position: slice.position,
    side: slice.side ?? 'negative', enabled: slice.enabled !== false, showGizmo: slice.showGizmo !== false,
    slab: slice.slab ?? false,
    thickness: validateSliceLength(slice.thickness ?? DEFAULT_SLAB_THICKNESS, 'slab thickness'),
    step: validateSliceLength(slice.step ?? DEFAULT_SLICE_STEP, 'step'),
    miller: slice.miller === undefined || slice.miller === null ? null : validateMillerIndices(slice.miller),
  };
}

function displayNumber(value) {
  return String(Number(value.toPrecision(8)));
}

function formatValue(value) {
  return String(Number(value.toPrecision(6)));
}
