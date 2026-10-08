import { atomIdSet, frameAtomIdLookup, hasAtomId } from './data/atom-ids.js';
/** Named selections store source atom IDs, never row or replicated-image indices.
 * Immutable group arrays also let the display path cache membership styling.
 */
export const MAX_SELECTION_GROUPS = 64;
export const MAX_SELECTION_ATOM_IDS = 1_000_000;
export const SELECTION_GROUP_COLORS = Object.freeze(['#22c1c3', '#f5b544', '#eb6f92', '#9b8afb', '#5eb97d', '#ed906b', '#6aa7e8', '#c6a558']);

const FORBIDDEN_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const STATE_KEYS = new Set(['groups', 'selectedGroupId']);
const GROUP_KEYS = new Set(['id', 'name', 'color', 'visible', 'atomIds']);
const PATCH_KEYS = new Set(['name', 'color', 'visible']);
const stylesCache = new WeakMap();
const frameIdsCache = new WeakMap();
const visibilityCache = new WeakMap();

export function normalizeSelectionGroups(value = {}, { path = 'selectionGroups' } = {}) {
  record(value, path, STATE_KEYS);
  const source = value.groups ?? [];
  if (!Array.isArray(source) || source.length > MAX_SELECTION_GROUPS) fail(`${path}.groups`, `must contain at most ${MAX_SELECTION_GROUPS} groups`);
  let totalIds = 0;
  const groups = source.map((entry, index) => {
    const entryPath = `${path}.groups[${index}]`;
    record(entry, entryPath, GROUP_KEYS);
    const id = groupIdentifier(entry.id, `${entryPath}.id`);
    const name = label(entry.name, `${entryPath}.name`, 160);
    const color = colorValue(entry.color, `${entryPath}.color`);
    const visible = entry.visible === undefined ? true : visibility(entry.visible, `${entryPath}.visible`);
    if (!Array.isArray(entry.atomIds) || entry.atomIds.length > MAX_SELECTION_ATOM_IDS) fail(`${entryPath}.atomIds`, 'must be an array of atom IDs');
    totalIds += entry.atomIds.length;
    if (totalIds > MAX_SELECTION_ATOM_IDS) fail(`${path}.groups`, `exceeds ${MAX_SELECTION_ATOM_IDS} stored atom IDs`);
    const atomIds = entry.atomIds.map((atomId, atomIndex) => atomIdentifier(atomId, `${entryPath}.atomIds[${atomIndex}]`));
    if (new Set(atomIds.map(String)).size !== atomIds.length) fail(`${entryPath}.atomIds`, 'contains duplicate atom IDs');
    return freezeGroup({ id, name, color, visible, atomIds });
  });
  if (new Set(groups.map(({ id }) => id)).size !== groups.length) fail(`${path}.groups`, 'contains duplicate group IDs');
  const selectedGroupId = value.selectedGroupId ?? null;
  if (selectedGroupId !== null) {
    groupIdentifier(selectedGroupId, `${path}.selectedGroupId`);
    if (!groups.some(({ id }) => id === selectedGroupId)) fail(`${path}.selectedGroupId`, 'does not identify an existing group');
  }
  return freezeState(groups, selectedGroupId);
}

export function addSelectionGroup(state, options = {}) {
  record(options, 'selection group', GROUP_KEYS);
  if (state.groups.length >= MAX_SELECTION_GROUPS) fail('groups', `allows at most ${MAX_SELECTION_GROUPS} groups`);
  let ordinal = 0;
  const ids = new Set(state.groups.map(({ id }) => id));
  while (ids.has(`selection-${ordinal}`)) ordinal += 1;
  const id = groupIdentifier(options.id ?? `selection-${ordinal}`, 'group.id');
  if (ids.has(id)) fail('group.id', 'already exists');
  const atomIds = uniqueAtomIds(options.atomIds ?? []);
  enforceBudget(state.groups, atomIds.length);
  const group = freezeGroup({ id,
    name: label(options.name ?? `Selection ${ordinal + 1}`, 'group.name', 160),
    color: colorValue(options.color ?? SELECTION_GROUP_COLORS[ordinal % SELECTION_GROUP_COLORS.length], 'group.color'),
    visible: options.visible === undefined ? true : visibility(options.visible, 'group.visible'), atomIds });
  return freezeState([...state.groups, group], id);
}

export function updateSelectionGroup(state, id, patch) {
  record(patch, 'group', PATCH_KEYS);
  const index = findGroup(state, id);
  const previous = state.groups[index];
  const group = Object.freeze({ ...previous,
    name: patch.name === undefined ? previous.name : label(patch.name, 'group.name', 160),
    color: patch.color === undefined ? previous.color : colorValue(patch.color, 'group.color'),
    visible: patch.visible === undefined ? previous.visible : visibility(patch.visible, 'group.visible') });
  const groups = state.groups.slice();
  groups[index] = group;
  return freezeState(groups, state.selectedGroupId);
}

export function removeSelectionGroup(state, id) {
  const index = findGroup(state, id);
  const groups = state.groups.filter((group) => group.id !== id);
  const selected = state.selectedGroupId === id ? groups[Math.min(index, groups.length - 1)]?.id ?? null : state.selectedGroupId;
  return freezeState(groups, selected);
}

export function selectSelectionGroup(state, id) {
  if (id !== null) findGroup(state, id);
  // Group membership did not change: retain the array and its compiled styles.
  return Object.freeze({ groups: state.groups, selectedGroupId: id });
}

export function setSelectionGroupMembers(state, id, atomIds, { operation = 'replace' } = {}) {
  if (!['replace', 'add', 'remove'].includes(operation)) fail('operation', 'must be replace, add or remove');
  const index = findGroup(state, id);
  const incoming = uniqueAtomIds(atomIds);
  const previous = state.groups[index];
  let members;
  if (operation === 'replace') members = incoming;
  else if (operation === 'add') {
    const seen = new Set(previous.atomIds.map(String));
    members = previous.atomIds.slice();
    for (const atomId of incoming) if (!seen.has(String(atomId))) { seen.add(String(atomId)); members.push(atomId); }
  } else {
    const remove = new Set(incoming.map(String));
    members = previous.atomIds.filter((atomId) => !remove.has(String(atomId)));
  }
  enforceBudget(state.groups, members.length - previous.atomIds.length);
  const groups = state.groups.slice();
  groups[index] = Object.freeze({ ...previous, atomIds: Object.freeze(members) });
  return freezeState(groups, state.selectedGroupId);
}

/** Whitespace/comma-separated editing preserves exact large integer labels. */
export function parseSelectionAtomIds(text) {
  if (typeof text !== 'string') fail('atom IDs', 'must be text');
  const tokens = text.trim().split(/[\s,;]+/).filter(Boolean);
  return uniqueAtomIds(tokens.map((token) => {
    if (/^[+-]?\d+$/.test(token)) {
      const number = Number(token);
      if (Number.isSafeInteger(number)) return number;
    }
    return token;
  }));
}

/** Later groups win colors; membership in any hidden group hides the atom. */
export function selectionGroupStyles(groups = []) {
  if (stylesCache.has(groups)) return stylesCache.get(groups);
  const styles = new Map();
  for (const group of groups) {
    const rgb = Object.freeze([1, 3, 5].map((offset) => parseInt(group.color.slice(offset, offset + 2), 16)));
    const shown = Object.freeze({ color: group.color, rgb, visible: group.visible });
    const hidden = group.visible ? Object.freeze({ color: group.color, rgb, visible: false }) : shown;
    for (const atomId of group.atomIds) {
      const key = String(atomId);
      styles.set(key, styles.get(key)?.visible === false ? hidden : shown);
    }
  }
  if (Object.isFrozen(groups)) stylesCache.set(groups, styles);
  return styles;
}

/** Source-row visibility for automatic color limits; analyses retain every atom.
 * Frame IDs and normalized groups are immutable between source/group edits.
 * Cache masks by both identities so camera and palette edits never rescan IDs.
 */
export function selectionGroupVisibility(frame, groups = []) {
  if (!frame?.ids?.length || !groups.length) return null;
  let entry = visibilityCache.get(groups);
  if (!entry) {
    const hiddenIds = atomIdSet(groups.flatMap(group => group.visible ? [] : group.atomIds));
    entry = { hiddenIds, masks: new WeakMap() };
    if (Object.isFrozen(groups)) visibilityCache.set(groups, entry);
  }
  if (!entry.hiddenIds.size) return null;
  const cached = entry.masks.get(frame.ids);
  if (cached?.length === frame.ids.length) return cached.mask;
  let mask = null;
  for (let index = 0; index < frame.ids.length; index += 1) {
    if (!hasAtomId(entry.hiddenIds, frame.ids[index])) continue;
    if (!mask) { mask = new Uint8Array(frame.ids.length); mask.fill(255); }
    mask[index] = 0;
  }
  entry.masks.set(frame.ids, { length: frame.ids.length, mask });
  return mask;
}

export function summarizeSelectionGroups(frame, state) {
  let entry = frame && frameIdsCache.get(frame);
  if (!entry || entry.ids !== frame.ids) {
    entry = { ids: frame?.ids, hasFrameId: frameAtomIdLookup(frame?.ids ?? []) };
    if (frame) frameIdsCache.set(frame, entry);
  }
  const { hasFrameId } = entry;
  return state.groups.map((group) => ({ id: group.id, totalCount: group.atomIds.length,
    matchedCount: group.atomIds.reduce((count, id) => count + Number(hasFrameId(id)), 0) }));
}

function uniqueAtomIds(value) {
  if (!(Array.isArray(value) || value instanceof Set || (ArrayBuffer.isView(value) && !(value instanceof DataView)))) fail('atomIds', 'must be a collection of atom IDs');
  if ((value.length ?? value.size) > MAX_SELECTION_ATOM_IDS) fail('atomIds', `exceeds ${MAX_SELECTION_ATOM_IDS} atom IDs`);
  const result = [], seen = new Set();
  for (const valueId of value) {
    const atomId = atomIdentifier(valueId, 'atomIds');
    if (!seen.has(String(atomId))) { seen.add(String(atomId)); result.push(atomId); }
  }
  return result;
}

function enforceBudget(groups, delta) {
  if (groups.reduce((count, group) => count + group.atomIds.length, delta) > MAX_SELECTION_ATOM_IDS) fail('groups', `exceeds ${MAX_SELECTION_ATOM_IDS} stored atom IDs`);
}

function findGroup(state, id) {
  const index = state.groups.findIndex((group) => group.id === id);
  if (index < 0) fail('group.id', 'does not identify an existing group');
  return index;
}

function freezeGroup(group) { return Object.freeze({ ...group, atomIds: Object.freeze(group.atomIds) }); }
function freezeState(groups, selectedGroupId) { return Object.freeze({ groups: Object.freeze(groups), selectedGroupId }); }

function record(value, path, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be an object');
  for (const key of Object.keys(value)) if (!keys.has(key) || FORBIDDEN_IDS.has(key)) fail(`${path}.${key}`, 'is not a supported setting');
}
function label(value, path, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) fail(path, `must be non-empty text of at most ${maximum} characters without control characters`);
  return value;
}
function groupIdentifier(value, path) {
  const id = label(value, path, 128);
  if (FORBIDDEN_IDS.has(id)) fail(path, 'is reserved');
  return id;
}
function atomIdentifier(value, path) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative safe integer; use a string for larger IDs');
    return value;
  }
  return groupIdentifier(value, path);
}
function colorValue(value, path) {
  if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) fail(path, 'must be a six-digit hexadecimal color');
  return value.toLowerCase();
}
function visibility(value, path) { if (typeof value !== 'boolean') fail(path, 'must be true or false'); return value; }
function fail(path, message) { throw new Error(`Invalid selection groups: ${path} ${message}.`); }
