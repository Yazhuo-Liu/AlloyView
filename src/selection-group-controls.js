import {
  normalizeSelectionGroups, addSelectionGroup, updateSelectionGroup,
  removeSelectionGroup, selectSelectionGroup, setSelectionGroupMembers,
  summarizeSelectionGroups, parseSelectionAtomIds,
  MAX_SELECTION_GROUPS,
} from './selection-groups.js';

/** Edit persistent atom-ID groups; picking mode only applies while the tool is open. */
export function initializeSelectionGroupControls({
  getFrame = () => null, getState, setState,
  onEdit = () => {}, onChange = () => {}, onError = () => {},
} = {}) {
  const element = id => document.getElementById(id);
  const controls = {
    add: element('add-selection-group'), list: element('selection-group-list'),
    empty: element('selection-group-empty'), settings: element('selection-group-settings'),
    mode: element('selection-group-mode'), operation: element('selection-group-operation'),
    name: element('selection-group-name'), color: element('selection-group-color'),
    visible: element('selection-group-visible'), count: element('selection-group-count'),
    toggleVisibility: element('toggle-selection-group-visibility'),
    ids: element('selection-group-ids'), applyIds: element('apply-selection-group-ids'),
    preview: element('selection-group-member-preview'), clear: element('clear-selection-group'),
    remove: element('delete-selection-group'), hint: element('selection-group-hint'),
    status: element('selection-group-status'),
  };
  let localState = normalizeSelectionGroups({});
  let enabled = false, active = false, mode = 'click', operation = 'add';
  let editorGroupId = null;
  let summaryFrame = null, summaryIds = null, summaryMembers = [], summaries = new Map();
  const readState = () => getState ? getState() : localState;
  const selected = state => state.groups.find(group => group.id === state.selectedGroupId);
  const snapshot = () => normalizeSelectionGroups(readState());
  const interaction = () => ({ enabled: enabled && active && Boolean(getFrame()), mode, operation });

  function writeState(next) {
    localState = next;
    setState?.(next);
  }

  function notify(reason) {
    onChange(readState(), { reason });
  }

  function report(error) {
    controls.status.textContent = error.message || String(error);
    onError(error);
  }

  function change(transform, reason, { editor = true } = {}) {
    try {
      const next = transform(readState());
      onEdit();
      writeState(next);
      render({ editor });
      notify(reason);
      return next;
    } catch (error) { report(error); return null; }
  }

  function render({ editor = true, force = false } = {}) {
    const state = readState(), group = selected(state), frame = getFrame();
    if (summaryFrame !== frame || summaryIds !== frame?.ids || summaryMembers.length !== state.groups.length
      || state.groups.some((item, index) => summaryMembers[index]?.id !== item.id || summaryMembers[index]?.atomIds !== item.atomIds)) {
      summaryFrame = frame;
      summaryIds = frame?.ids;
      summaryMembers = state.groups.map(item => ({ id: item.id, atomIds: item.atomIds }));
      summaries = new Map((frame && state.groups.length ? summarizeSelectionGroups(frame, state) : []).map(summary => [summary.id, summary]));
    }
    controls.list.replaceChildren();
    for (const item of state.groups) {
      const summary = summaries.get(item.id);
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.selectionGroupId = item.id;
      button.disabled = !enabled;
      button.setAttribute('aria-pressed', String(item.id === state.selectedGroupId));
      const swatch = document.createElement('span');
      swatch.className = 'selection-group-swatch';
      swatch.style.setProperty('--group-color', item.color);
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.className = 'selection-group-label';
      const name = document.createElement('strong'); name.textContent = item.name;
      const count = document.createElement('small');
      count.textContent = frame
        ? `${integer(summary?.matchedCount ?? 0)} in frame / ${integer(item.atomIds.length)} IDs`
        : `${integer(item.atomIds.length)} atom IDs`;
      label.append(name, count);
      const visibility = document.createElement('span'); visibility.className = 'selection-group-visibility';
      visibility.textContent = item.visible ? 'Visible' : 'Hidden';
      button.append(swatch, label, visibility);
      button.addEventListener('click', () => {
        if (readState().selectedGroupId === item.id) return;
        change(state => selectSelectionGroup(state, item.id), 'selection');
      });
      controls.list.append(button);
    }
    controls.empty.hidden = state.groups.length !== 0;
    controls.settings.hidden = !group;
    controls.add.disabled = !enabled || state.groups.length >= MAX_SELECTION_GROUPS;
    controls.add.title = state.groups.length >= MAX_SELECTION_GROUPS ? `Maximum of ${MAX_SELECTION_GROUPS} groups` : 'Create an empty atom selection group';
    controls.mode.disabled = controls.operation.disabled = !enabled;
    controls.mode.value = mode; controls.operation.value = operation;
    for (const input of [controls.name, controls.color, controls.visible,
      controls.ids, controls.applyIds, controls.remove]) input.disabled = !enabled || !group;
    controls.clear.disabled = !enabled || !group?.atomIds.length;
    controls.toggleVisibility.disabled = !enabled || !frame || !group || !(summaries.get(group.id)?.matchedCount);
    controls.toggleVisibility.textContent = group?.visible === false ? 'Show selected atoms' : 'Hide selected atoms';
    controls.applyIds.textContent = operation === 'remove' ? 'Remove IDs' : operation === 'replace' ? 'Replace IDs' : 'Add IDs';
    const groupChanged = editorGroupId !== (group?.id ?? null);
    if (groupChanged) { controls.ids.value = ''; controls.name.setCustomValidity(''); controls.name.removeAttribute('aria-invalid'); }
    if (group && (editor || groupChanged)) {
      if (force || groupChanged || document.activeElement !== controls.name) controls.name.value = group.name;
      controls.color.value = group.color; controls.visible.checked = group.visible;
    }
    editorGroupId = group?.id ?? null;
    if (group) {
      const summary = summaries.get(group.id);
      const matched = summary?.matchedCount ?? 0, absent = group.atomIds.length - matched;
      controls.count.textContent = frame
        ? `${integer(matched)} atoms in this frame · ${integer(absent)} IDs absent from this frame${group.visible ? '' : ' · Group atoms hidden'}`
        : `${integer(group.atomIds.length)} atom IDs · Open a structure to view them`;
      const preview = group.atomIds.slice(0, 24).join(', ');
      controls.preview.textContent = preview
        ? `IDs: ${preview}${group.atomIds.length > 24 ? ` · ${integer(group.atomIds.length - 24)} more` : ''}`
        : 'This group has no atom IDs yet.';
    }
    const action = operation === 'remove' ? 'remove atoms from' : operation === 'replace' ? 'replace the atoms in' : 'add atoms to';
    controls.hint.textContent = mode === 'box'
      ? `Drag a box in the viewport to ${action} the current group. Right-drag, wheel or two fingers navigate; Escape cancels the box.`
      : `Click atoms in the viewport to ${action} the current group. Drag to rotate the view. The first selection creates a group.`;
    controls.status.textContent = !enabled ? 'Open a structure to create selections.'
      : !active ? 'Open Selections to edit groups in the viewport. Group colors and visibility stay applied.'
        : group ? `Editing ${group.name}. Changes are saved immediately.`
          : 'Add a group or select atoms to create your first group.';
  }

  function addGroup() {
    if (!enabled) return null;
    return change(state => addSelectionGroup(state), 'add');
  }

  function updateGroup(patch, { editor = true } = {}) {
    if (!enabled) return null;
    const group = selected(readState());
    if (!group || Object.entries(patch).every(([key, value]) => group[key] === value)) return null;
    return change(state => updateSelectionGroup(state, group.id, patch), 'appearance', { editor });
  }

  function selectAtoms(atomIds, { operation: requestedOperation = operation } = {}) {
    if (!enabled || !getFrame()) return null;
    const ids = Array.from(atomIds ?? []), group = selected(readState());
    if (!ids.length && (requestedOperation !== 'replace' || !group)) return null;
    if (!group && requestedOperation === 'remove') {
      controls.status.textContent = 'Choose or add a group before removing atoms.';
      return null;
    }
    return change(state => {
      let next = state;
      if (!selected(next)) next = addSelectionGroup(next);
      return setSelectionGroupMembers(next, next.selectedGroupId, ids, { operation: requestedOperation });
    }, 'members');
  }

  controls.add.addEventListener('click', addGroup);
  controls.remove.addEventListener('click', () => {
    const group = selected(readState());
    if (enabled && group) change(state => removeSelectionGroup(state, group.id), 'delete');
  });
  controls.clear.addEventListener('click', () => selectAtoms([], { operation: 'replace' }));
  controls.name.addEventListener('input', () => {
    const value = controls.name.value.trim();
    controls.name.setCustomValidity(value ? '' : 'Enter a group name.');
    if (value) { controls.name.removeAttribute('aria-invalid'); updateGroup({ name: value }, { editor: false }); }
    else { controls.name.setAttribute('aria-invalid', 'true'); controls.status.textContent = 'Enter a group name.'; }
  });
  controls.name.addEventListener('change', () => render());
  for (const event of ['input', 'change']) controls.color.addEventListener(event, () => updateGroup({ color: controls.color.value }));
  controls.visible.addEventListener('change', () => updateGroup({ visible: controls.visible.checked }));
  controls.toggleVisibility.addEventListener('click', () => {
    const group = selected(readState());
    if (enabled && getFrame() && group && summaries.get(group.id)?.matchedCount) updateGroup({ visible: !group.visible });
  });
  for (const [input, kind] of [[controls.mode, 'mode'], [controls.operation, 'operation']]) {
    input.addEventListener('change', () => {
      if (!enabled) return;
      onEdit();
      if (kind === 'mode') mode = input.value;
      else operation = input.value;
      render(); notify('interaction');
    });
  }
  controls.applyIds.addEventListener('click', () => {
    try {
      const ids = parseSelectionAtomIds(controls.ids.value);
      if (!ids.length && operation !== 'replace') {
        controls.status.textContent = 'Enter one or more atom IDs.';
        return;
      }
      if (selectAtoms(ids)) controls.ids.value = '';
    } catch (error) { report(error); }
  });
  render();

  return Object.freeze({
    getState: snapshot,
    setState(state, { silent = true } = {}) {
      writeState(normalizeSelectionGroups(state)); render({ force: true });
      if (!silent) notify('restore');
      return snapshot();
    },
    refresh: render,
    setEnabled(value) {
      if (enabled === Boolean(value)) { render(); return; }
      enabled = Boolean(value); render(); notify('interaction');
    },
    setActive(value) {
      if (active === Boolean(value)) return;
      active = Boolean(value); render(); notify('interaction');
    },
    getInteractionState: interaction,
    selectAtoms,
    addGroup,
    /** Edits from other tools, such as expression selections. Errors are thrown
     * to the caller, which reports them in its own panel. */
    apply(transform, reason = 'members') {
      if (!enabled || !getFrame()) throw new Error('Open a structure to edit selections.');
      const next = transform(readState());
      onEdit(); writeState(next); render(); notify(reason);
      return next;
    },
  });
}

function integer(value) { return value.toLocaleString('en-US'); }
