import { atomIdSet, hasAtomId } from './data/atom-ids.js';
import {
  applyComputedProperties, compileComputedProperties, isComputedProperty,
  validateComputedPropertyName, validateComputedPropertyUnit,
} from './computed-properties.js';
import { bindExpression, createExpressionScope, evaluateSelection, parseExpression } from './expressions.js';
import { addSelectionGroup, selectSelectionGroup, setSelectionGroupMembers } from './selection-groups.js';
import { SelectionExpansionClient } from './selection-expansion-client.js';

const OPERATIONS = Object.freeze({ replace: 'Replaced the members of', add: 'Added atoms to', remove: 'Removed atoms from', intersect: 'Intersected' });
const MAX_VARIABLE_CHIPS = 120;

/** Computed properties and expression selections. Definitions are portable
 * recipes; values are recalculated on the displayed frame by sync(). Selection
 * results become ordinary ID-based selection groups. Every method also works
 * without the panel, which keeps the logic testable outside a browser. */
export function initializeExpressionControls({
  getFrame = () => null, getSelectionGroups = () => ({ groups: [], selectedGroupId: null }),
  editSelectionGroups = null, onPropertiesChange = () => {}, onChooseColor = null,
  onEdit = () => {}, notify = () => {}, expansionClient = new SelectionExpansionClient(),
  documentRoot = globalThis.document,
} = {}) {
  const element = id => documentRoot?.getElementById?.(id) ?? null;
  const controls = {
    name: element('expression-property-name'), unit: element('expression-property-unit'),
    text: element('expression-property-text'), save: element('save-expression-property'),
    cancelEdit: element('cancel-expression-edit'), propertyError: element('expression-property-error'),
    list: element('expression-property-list'), propertyStatus: element('expression-property-status'),
    selectionText: element('expression-selection-text'), group: element('expression-selection-group'),
    operation: element('expression-selection-operation'), select: element('apply-expression-selection'),
    selectionError: element('expression-selection-error'), invert: element('invert-expression-selection'),
    mode: element('expand-selection-mode'), cutoff: element('expand-selection-cutoff'), count: element('expand-selection-count'),
    cutoffField: element('expand-selection-cutoff-field'), countField: element('expand-selection-count-field'),
    iterations: element('expand-selection-iterations'), expand: element('expand-expression-selection'),
    cancelExpand: element('cancel-expand-selection'), selectionStatus: element('expression-selection-status'),
    variables: element('expression-variable-list'),
  };
  let definitions = [], statuses = new Map(), enabled = false, editing = null, expansion = null;
  let renderedList = '', renderedVariables = null, selectionMessage = '', propertyMessage = '';
  let lastField = controls.text;
  const cache = new WeakMap();
  const snapshot = () => ({ properties: definitions.map(({ name, unit, expression }) => ({ name, unit, expression })) });
  const groups = () => getSelectionGroups()?.groups ?? [];
  const busy = () => expansion !== null;

  function render() {
    const frame = getFrame(), active = enabled && Boolean(frame);
    for (const input of [controls.name, controls.unit, controls.text, controls.save, controls.selectionText, controls.select,
      controls.mode, controls.cutoff, controls.count, controls.iterations]) if (input) input.disabled = !active;
    const replacing = editing ?? definitions.find(definition => definition.name.toLowerCase() === controls.name?.value.trim().toLowerCase())?.name;
    if (controls.save) controls.save.textContent = replacing ? 'Update property' : 'Compute property';
    if (controls.cancelEdit) controls.cancelEdit.hidden = editing === null;
    renderGroups(active);
    const mode = controls.mode?.value ?? 'cutoff';
    if (controls.cutoffField) controls.cutoffField.hidden = mode !== 'cutoff';
    if (controls.countField) controls.countField.hidden = mode !== 'nearest';
    if (controls.expand) controls.expand.disabled = !active || busy() || !targetGroup();
    if (controls.invert) controls.invert.disabled = !active || busy() || !targetGroup();
    if (controls.cancelExpand) controls.cancelExpand.disabled = !busy();
    if (controls.propertyStatus) controls.propertyStatus.textContent = !active ? 'Open a structure to compute properties.'
      : propertyMessage || (definitions.length ? 'Computed properties are recalculated for each frame and listed under Color by.'
        : 'Name a property and enter an expression, for example sqrt(Position.X^2 + Position.Y^2).');
    if (controls.selectionStatus) controls.selectionStatus.textContent = !active ? 'Open a structure to select atoms by expression.'
      : selectionMessage || 'Matching atom IDs are written to a selection group, which follows the IDs across frames.';
    renderList(active);
    renderVariables(frame, active);
  }

  function renderGroups(active) {
    if (!controls.group) return;
    const list = groups(), previous = controls.group.value;
    const options = [['new', 'New group'], ...list.map(group => [group.id, group.name])];
    const signature = JSON.stringify(options);
    if (controls.group.dataset.signature !== signature) {
      controls.group.replaceChildren(...options.map(([value, label]) => { const option = documentRoot.createElement('option'); option.value = value; option.textContent = label; return option; }));
      controls.group.dataset.signature = signature;
      const selected = getSelectionGroups()?.selectedGroupId;
      controls.group.value = options.some(([value]) => value === previous) && previous !== '' ? previous
        : options.some(([value]) => value === selected) ? selected : 'new';
    }
    controls.group.disabled = !active;
    if (controls.operation) controls.operation.disabled = !active || controls.group.value === 'new';
  }

  function renderList(active) {
    if (!controls.list) return;
    const signature = JSON.stringify([active, editing, definitions.map(definition => [definition.key, statuses.get(definition.name)])]);
    if (signature === renderedList) return;
    renderedList = signature;
    controls.list.replaceChildren(...definitions.map(definition => {
      const status = statuses.get(definition.name);
      const row = documentRoot.createElement('div'); row.className = 'expression-property-row';
      row.dataset.expressionProperty = definition.name;
      const summary = documentRoot.createElement('div'); summary.className = 'expression-property-summary';
      const name = documentRoot.createElement('strong'); name.textContent = `${definition.name}${definition.unit ? ` [${definition.unit}]` : ''}`;
      const code = documentRoot.createElement('code'); code.textContent = definition.expression;
      const state = documentRoot.createElement('small');
      state.className = `expression-property-state${status?.state === 'ready' ? ' ready' : ''}`;
      state.textContent = !status ? 'Not evaluated yet' : status.state === 'ready' ? 'Calculated for this frame'
        : status.state === 'waiting' ? `Waiting: ${status.message}` : status.message;
      summary.append(name, code, state);
      const actions = documentRoot.createElement('div'); actions.className = 'expression-property-actions';
      const button = (label, action, disabled = false) => {
        const item = documentRoot.createElement('button'); item.type = 'button'; item.textContent = label;
        item.disabled = !active || disabled; item.addEventListener('click', action); return item;
      };
      actions.append(
        ...(onChooseColor ? [button('Color', () => onChooseColor(definition.name), status?.state !== 'ready')] : []),
        button('Edit', () => beginEdit(definition.name)),
        button('Remove', () => handle(() => removeProperty(definition.name), 'property')),
      );
      row.append(summary, actions);
      return row;
    }));
  }

  function renderVariables(frame, active) {
    if (!controls.variables) return;
    let names = [];
    try { names = active ? createExpressionScope(frame).names().slice(0, MAX_VARIABLE_CHIPS) : []; } catch { names = []; }
    const signature = names.join('\0');
    if (signature === renderedVariables) return;
    renderedVariables = signature;
    controls.variables.replaceChildren(...names.map(name => {
      const chip = documentRoot.createElement('button'); chip.type = 'button'; chip.className = 'expression-variable';
      chip.textContent = name; chip.title = `Insert ${name}`;
      chip.addEventListener('click', () => insertName(name));
      return chip;
    }));
  }

  function insertName(name) {
    const field = lastField ?? controls.text;
    if (!field || field.disabled) return;
    const text = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*(?:\[\d+\])*$/.test(name) ? name : `\`${name}\``;
    const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
    field.setRangeText?.(text, start, end, 'end');
    field.focus?.();
  }

  function showError(kind, error) {
    const output = kind === 'property' ? controls.propertyError : controls.selectionError;
    const field = kind === 'property' ? (error?.field === 'name' ? controls.name : error?.field === 'unit' ? controls.unit : controls.text) : controls.selectionText;
    if (output) { output.textContent = error ? error.message : ''; output.hidden = !error; }
    for (const input of kind === 'property' ? [controls.name, controls.unit, controls.text] : [controls.selectionText]) input?.removeAttribute('aria-invalid');
    if (!error || !field) return;
    field.setAttribute('aria-invalid', 'true');
    if (Number.isInteger(error.position) && field.setSelectionRange) {
      field.focus?.({ preventScroll: true });
      field.setSelectionRange(error.position, Math.min(field.value.length, error.position + Math.max(1, error.length ?? 1)));
    }
  }

  function handle(operation, kind) {
    return Promise.resolve().then(operation).then(result => { showError(kind, null); return result; }, error => {
      if (error?.name === 'AbortError') return null;
      showError(kind, error); render();
      return null;
    });
  }

  function requireFrame() {
    const frame = getFrame();
    if (!enabled || !frame) throw new Error('Open a structure first.');
    return frame;
  }

  /** Add a property, or replace the one with the same name or being edited. */
  function saveProperty({ name = controls.name?.value ?? '', unit = controls.unit?.value ?? '', expression = controls.text?.value ?? '' } = {}) {
    const frame = requireFrame();
    const previousName = editing ?? definitions.find(definition => definition.name.toLowerCase() === String(name).trim().toLowerCase())?.name ?? null;
    const index = previousName === null ? definitions.length : definitions.findIndex(definition => definition.name === previousName);
    const sourceNames = frame.properties.filter(property => !isComputedProperty(property)).map(property => property.name);
    let validName, validUnit;
    try { validName = validateComputedPropertyName(name, [...sourceNames, ...definitions.filter((_, position) => position !== index).map(definition => definition.name)]); }
    catch (error) { error.field = 'name'; throw error; }
    try { validUnit = validateComputedPropertyUnit(unit); } catch (error) { error.field = 'unit'; throw error; }
    if (!String(expression).trim()) throw Object.assign(new Error('Enter an expression.'), { field: 'text' });
    const parsed = parseExpression(expression);
    // References are case-insensitive, so only a real rename can break a dependent.
    if (previousName !== null && previousName.toLowerCase() !== validName.toLowerCase()) {
      const dependent = definitions.slice(index + 1).find(definition => definition.parsed.references.some(reference => reference.name.toLowerCase() === previousName.toLowerCase()));
      if (dependent) throw new Error(`“${dependent.name}” uses “${previousName}”. Edit it before renaming “${previousName}”.`);
    }
    const entries = snapshot().properties;
    entries.splice(index, previousName === null ? 0 : 1, { name: validName, unit: validUnit, expression });
    const next = compileComputedProperties({ properties: entries });
    // Variables must exist now; earlier computed properties are available.
    const preceding = new Set(next.slice(0, index).map(definition => definition.name));
    const properties = frame.properties.filter(property => !isComputedProperty(property) || preceding.has(property.name));
    bindExpression(parsed, createExpressionScope(frame, { properties }), { strictTypeLabels: true });
    definitions = next; editing = null; propertyMessage = '';
    onEdit();
    onPropertiesChange({ reason: previousName === null ? 'add' : 'replace', name: validName,
      removed: previousName !== null && previousName !== validName ? [previousName] : [] });
    const status = statuses.get(validName);
    propertyMessage = status?.state === 'ready' ? `${previousName === null ? 'Computed' : 'Updated'} “${validName}”. Choose it under Color by.`
      : `Saved “${validName}”. ${status?.message ?? ''}`.trim();
    if (controls.name) controls.name.value = '';
    if (controls.unit) controls.unit.value = '';
    if (controls.text) controls.text.value = '';
    render();
    return snapshot();
  }

  function removeProperty(name) {
    const index = definitions.findIndex(definition => definition.name === name);
    if (index < 0) return snapshot();
    const dependent = definitions.slice(index + 1).find(definition => definition.parsed.references.some(reference => reference.name.toLowerCase() === name.toLowerCase()));
    if (dependent) throw new Error(`“${dependent.name}” uses “${name}”. Remove or edit it first.`);
    definitions = definitions.filter((_, position) => position !== index);
    if (editing === name) editing = null;
    statuses.delete(name);
    onEdit();
    onPropertiesChange({ reason: 'remove', name, removed: [name] });
    propertyMessage = `Removed “${name}”.`;
    render();
    return snapshot();
  }

  function beginEdit(name) {
    const definition = definitions.find(item => item.name === name);
    if (!definition) return;
    editing = name;
    if (controls.name) controls.name.value = definition.name;
    if (controls.unit) controls.unit.value = definition.unit;
    if (controls.text) { controls.text.value = definition.expression; controls.text.focus?.(); }
    propertyMessage = `Editing “${name}”. Update it or cancel.`;
    render();
  }

  function targetGroup(target = controls.group?.value) {
    return groups().find(group => group.id === target) ?? null;
  }

  function editGroups(transform) {
    if (!editSelectionGroups) throw new Error('Selections are unavailable.');
    return editSelectionGroups(transform);
  }

  function frameMembership(frame, group) {
    const members = atomIdSet(group.atomIds), mask = new Uint8Array(frame.ids.length);
    let count = 0;
    for (let index = 0; index < mask.length; index++) if (hasAtomId(members, frame.ids[index])) { mask[index] = 1; count++; }
    return { mask, count };
  }

  function idsFor(frame, mask, exclude = null) {
    const ids = [];
    for (let index = 0; index < mask.length; index++) if (mask[index] && !exclude?.[index]) ids.push(frame.ids[index]);
    return ids;
  }

  function groupSummary(next, id, frame) {
    const group = next.groups.find(item => item.id === id);
    return group ? `“${group.name}” has ${integer(frameMembership(frame, group).count)} atoms in this frame` : '';
  }

  /** Evaluate a condition and combine the matching atom IDs with a group. */
  function selectByExpression({ expression = controls.selectionText?.value ?? '', target = controls.group?.value ?? 'new',
    operation = controls.operation?.value ?? 'replace' } = {}) {
    const frame = requireFrame();
    if (!OPERATIONS[operation]) throw new Error('Choose replace, add, subtract or intersect.');
    const bound = bindExpression(parseExpression(expression), createExpressionScope(frame), { strictTypeLabels: true });
    const mask = evaluateSelection(bound), ids = idsFor(frame, mask);
    let groupId = target;
    const next = editGroups(state => {
      if (target === 'new') {
        const created = addSelectionGroup(state, { name: groupName(expression), atomIds: ids });
        groupId = created.selectedGroupId;
        return created;
      }
      return setSelectionGroupMembers(selectSelectionGroup(state, target), target, ids, { operation });
    });
    if (controls.group) { render(); controls.group.value = groupId; render(); }
    selectionMessage = `${integer(ids.length)} of ${integer(mask.length)} atoms match. ${target === 'new' ? 'Created a group;' : `${OPERATIONS[operation]} the group;`} ${groupSummary(next, groupId, frame)}.`;
    render();
    return { matched: ids.length, groupId, state: next };
  }

  /** Members become the frame's other atoms. IDs absent from this frame are dropped. */
  function invertSelection({ target = controls.group?.value } = {}) {
    const frame = requireFrame(), group = targetGroup(target);
    if (!group) throw new Error('Choose an existing group to invert.');
    const { mask } = frameMembership(frame, group);
    const ids = [];
    for (let index = 0; index < mask.length; index++) if (!mask[index]) ids.push(frame.ids[index]);
    const next = editGroups(state => setSelectionGroupMembers(selectSelectionGroup(state, group.id), group.id, ids, { operation: 'replace' }));
    selectionMessage = `Inverted “${group.name}”: ${groupSummary(next, group.id, frame)}.`;
    render();
    return { count: ids.length, state: next };
  }

  /** Add periodic neighbors of the group's atoms in this frame. */
  async function expandGroup({ target = controls.group?.value, mode = controls.mode?.value ?? 'cutoff',
    cutoff = controls.cutoff?.valueAsNumber, count = controls.count?.valueAsNumber, iterations = controls.iterations?.valueAsNumber ?? 1 } = {}) {
    const frame = requireFrame(), group = targetGroup(target);
    if (!group) throw new Error('Choose an existing group to expand.');
    if (busy()) throw new Error('Wait for the current expansion to finish or cancel it.');
    const { mask, count: selected } = frameMembership(frame, group);
    if (!selected) throw new Error(`“${group.name}” has no atoms in this frame.`);
    const controller = new AbortController();
    expansion = controller;
    selectionMessage = `Expanding “${group.name}”…`;
    render();
    try {
      const result = await expansionClient.expand(frame, mask, { mode, cutoff, count, iterations }, {
        signal: controller.signal,
        onProgress: ({ iteration, iterations: total, processed, frontier }) => {
          if (expansion !== controller) return;
          selectionMessage = `Expanding “${group.name}”: iteration ${iteration} of ${total}, ${integer(processed)} / ${integer(frontier)} atoms.`;
          render();
        },
      });
      if (getFrame() !== frame) throw new Error('The frame changed during expansion. Expand the group again.');
      const ids = idsFor(frame, result.mask, mask);
      const next = editGroups(state => setSelectionGroupMembers(state, group.id, ids, { operation: 'add' }));
      selectionMessage = `Added ${integer(ids.length)} neighboring atoms to “${group.name}”; ${groupSummary(next, group.id, frame)}.`;
      return { added: ids.length, state: next };
    } finally {
      if (expansion === controller) expansion = null;
      render();
    }
  }

  function cancelExpansion() {
    if (!expansion) return;
    expansion.abort();
    expansion = null;
    selectionMessage = 'Expansion cancelled. The group is unchanged.';
    render();
  }

  controls.save?.addEventListener('click', () => handle(() => saveProperty(), 'property'));
  controls.cancelEdit?.addEventListener('click', () => {
    editing = null; propertyMessage = '';
    for (const input of [controls.name, controls.unit, controls.text]) if (input) input.value = '';
    showError('property', null); render();
  });
  controls.name?.addEventListener('input', render);
  controls.select?.addEventListener('click', () => handle(() => selectByExpression(), 'selection'));
  controls.invert?.addEventListener('click', () => handle(() => invertSelection(), 'selection'));
  controls.expand?.addEventListener('click', () => handle(() => expandGroup(), 'selection'));
  controls.cancelExpand?.addEventListener('click', cancelExpansion);
  for (const input of [controls.group, controls.mode]) input?.addEventListener('change', render);
  for (const field of [controls.text, controls.selectionText]) field?.addEventListener('focus', () => { lastField = field; });
  for (const [field, action, kind] of [[controls.text, () => saveProperty(), 'property'], [controls.selectionText, () => selectByExpression(), 'selection']]) {
    // Ctrl/Cmd+Enter applies; plain Enter keeps multi-line editing.
    field?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void handle(action, kind); }
    });
  }
  render();

  return Object.freeze({
    saveProperty, removeProperty, beginEdit, selectByExpression, invertSelection, expandGroup, cancelExpansion,
    /** Apply the definitions to a frame; returns whether its properties changed. */
    sync(frame) {
      if (!frame) return false;
      let result;
      // Frame display must continue even if, for example, an allocation fails.
      try { result = applyComputedProperties(frame, definitions, cache); }
      catch (error) {
        statuses = new Map(definitions.map(definition => [definition.name, { name: definition.name, state: 'error', message: error.message ?? String(error) }]));
        notify(`Computed properties could not be evaluated: ${error.message ?? error}`);
        if (frame === getFrame()) render();
        return false;
      }
      statuses = new Map(result.statuses.map(status => [status.name, status]));
      if (frame === getFrame()) render();
      return result.changed;
    },
    /** Saved properties without values in this frame, for Color by placeholders. */
    pendingColorProperties: () => definitions.filter(definition => statuses.get(definition.name)?.state !== 'ready')
      .map(definition => ({ name: definition.name, label: `${definition.name}${definition.unit ? ` [${definition.unit}]` : ''}` })),
    getState: snapshot,
    setState(value) {
      definitions = compileComputedProperties(value ?? {});
      editing = null; statuses = new Map(); propertyMessage = ''; render();
      return snapshot();
    },
    reset() {
      cancelExpansion();
      definitions = []; statuses = new Map(); editing = null; propertyMessage = ''; selectionMessage = '';
      showError('property', null); showError('selection', null); render();
    },
    refresh: render,
    setEnabled(value) { enabled = Boolean(value); if (!enabled) cancelExpansion(); render(); },
  });
}

function groupName(expression) {
  const text = expression.replace(/\s+/g, ' ').trim();
  return `Expression: ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`;
}

function integer(value) { return value.toLocaleString('en-US'); }
