import { radiiByType } from './render/atomic-radii.js';
import { selectionGroupStyles } from './selection-groups.js';
import { atomIndexEntry, atomIndicesById } from './data/atom-ids.js';

// Atom indices by display ID, built once per immutable ID array. A replicated
// or merged frame may repeat an ID, so a key can name several atoms.
const indicesByIdCache = new WeakMap();
function indicesById(ids) {
  let map = indicesByIdCache.get(ids);
  if (!map) { map = atomIndicesById(ids); indicesByIdCache.set(ids, map); }
  return map;
}

/** First atom whose ID has the same text as `id`, exactly like
 * `ids.findIndex(value => String(value) === String(id))`. A typed ID array
 * holds numbers, whose text matches only the number that text parses to, so
 * a native `indexOf` replaces converting every ID to a string. */
export function findAtomIndex(ids, id) {
  if (ArrayBuffer.isView(ids)) {
    const key = String(id), value = Number(key);
    if (!Number.isNaN(value)) return String(value) === key ? ids.indexOf(value) : -1;
  }
  return ids.findIndex(value => String(value) === String(id));
}

function forEachAtom(map, key, visit) {
  const found = atomIndexEntry(map, key);
  if (typeof found === 'number') visit(found);
  else if (found) for (const index of found) visit(index);
}

/** Resolve the independently versioned radius layer without building colors or
 * visibility. The caller owns the defaults and keeps the returned array until
 * a frame/type/ID/radius style changes. */
export function resolveAppearanceRadii(frame, appearance = {}, baseRadii = radiiByType(frame)) {
  const elements = new Map((appearance.elements ?? []).filter(entry => entry.radius != null).map(entry => [entry.label, entry.radius]));
  const atoms = (appearance.atoms ?? []).filter(entry => entry.radius != null);
  if (!elements.size && !atoms.length) return baseRadii;
  const radii = baseRadii.slice(), byType = frame.typeLabels.map(label => elements.get(label));
  if (byType.some(radius => radius != null)) for (let index = 0; index < frame.types.length; index++) {
    const radius = byType[frame.types[index]];
    if (radius != null) radii[index] = radius;
  }
  if (atoms.length) {
    const byId = indicesById(frame.ids);
    for (const { id, radius } of atoms) forEachAtom(byId, String(id), index => { radii[index] = radius; });
  }
  return radii;
}

/** Display overrides are keyed by stable labels/IDs, independent of atom order.
 * Precedence is atom > selection group > element for color, atom > element
 * for radius, and any of them can hide an atom. Element styles are resolved
 * per type; atom and group overrides touch only the atoms they name, so the
 * common case without overrides never converts every atom ID to a string. */
export function applyAppearance(frame, colors, visibility, appearance = {}, { elementColors = true, selectionGroups = [], trackColorOverrides = false, baseRadii = null, identity = false, resolveRadii = true } = {}) {
  const elements = new Map((appearance.elements ?? []).map(entry => [entry.label, entry]));
  const atoms = new Map((appearance.atoms ?? []).map(entry => [String(entry.id), entry]));
  const groups = selectionGroupStyles(selectionGroups);
  // The display controller owns immutable defaults. With no styles there is
  // nothing to resolve: retain its palette/mask/radius references verbatim.
  if (identity && !elements.size && !atoms.size && !groups.size) {
    return { colors, visibility, radii: baseRadii ?? radiiByType(frame), ...(trackColorOverrides ? { colorOverrides: null } : {}) };
  }
  const outputColors = colors.slice();
  const colorOverrides = trackColorOverrides ? new Uint8Array(frame.ids.length) : null;
  const outputVisibility = visibility?.slice() ?? new Uint8Array(frame.ids.length).fill(255);
  const hasRadiusOverrides = resolveRadii && [...elements.values(), ...atoms.values()].some(style => style.radius != null);
  const radii = baseRadii ? (hasRadiusOverrides ? baseRadii.slice() : baseRadii) : radiiByType(frame);
  const typeStyles = frame.typeLabels.map(label => elements.get(label));
  const typeColors = typeStyles.map(style => elementColors && style?.color ? hexColor(style.color) : null);
  if (typeStyles.some((style, type) => typeColors[type] || style?.radius != null || style?.visible === false)) {
    for (let index = 0; index < frame.types.length; index += 1) {
      const type = frame.types[index], style = typeStyles[type];
      if (!style) continue;
      const rgb = typeColors[type];
      if (rgb) { outputColors[index * 3] = rgb[0]; outputColors[index * 3 + 1] = rgb[1]; outputColors[index * 3 + 2] = rgb[2]; if (colorOverrides) colorOverrides[index] = 255; }
      if (resolveRadii && style.radius != null) radii[index] = style.radius;
      if (style.visible === false) outputVisibility[index] = 0;
    }
  }
  if (groups.size || atoms.size) {
    const byId = indicesById(frame.ids);
    for (const [key, group] of groups) forEachAtom(byId, key, index => {
      outputColors[index * 3] = group.rgb[0]; outputColors[index * 3 + 1] = group.rgb[1]; outputColors[index * 3 + 2] = group.rgb[2];
      if (colorOverrides) colorOverrides[index] = 255;
      if (group.visible === false) outputVisibility[index] = 0;
    });
    for (const [key, atom] of atoms) {
      const rgb = atom.color ? hexColor(atom.color) : null;
      forEachAtom(byId, key, index => {
        if (rgb) { outputColors[index * 3] = rgb[0]; outputColors[index * 3 + 1] = rgb[1]; outputColors[index * 3 + 2] = rgb[2]; if (colorOverrides) colorOverrides[index] = 255; }
        if (resolveRadii && atom.radius != null) radii[index] = atom.radius;
        if (atom.visible === false) outputVisibility[index] = 0;
      });
    }
  }
  return { colors: outputColors, visibility: outputVisibility, radii, ...(colorOverrides ? { colorOverrides } : {}) };
}

export function hexColor(value) {
  if (!/^#[a-f\d]{6}$/i.test(value)) throw new Error('Colors must use six-digit hexadecimal values.');
  return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
}

export function rgbHex(values) {
  return `#${Array.from(values, value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
}
