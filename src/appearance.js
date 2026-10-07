import { radiiByType } from './render/atomic-radii.js';
import { selectionGroupStyles } from './selection-groups.js';

// Atom indices by display ID, built once per immutable ID array. A replicated
// or merged frame may repeat an ID, so a key can name several atoms.
const indicesByIdCache = new WeakMap();
function indicesById(ids) {
  let map = indicesByIdCache.get(ids);
  if (map) return map;
  map = new Map();
  for (let index = 0; index < ids.length; index += 1) {
    const key = String(ids[index]), existing = map.get(key);
    if (existing === undefined) map.set(key, index);
    else if (typeof existing === 'number') map.set(key, [existing, index]);
    else existing.push(index);
  }
  indicesByIdCache.set(ids, map);
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
  const found = map.get(key);
  if (typeof found === 'number') visit(found);
  else if (found) for (const index of found) visit(index);
}

/** Display overrides are keyed by stable labels/IDs, independent of atom order.
 * Precedence is atom > selection group > element for color, atom > element
 * for radius, and any of them can hide an atom. Element styles are resolved
 * per type; atom and group overrides touch only the atoms they name, so the
 * common case without overrides never converts every atom ID to a string. */
export function applyAppearance(frame, colors, visibility, appearance = {}, { elementColors = true, selectionGroups = [] } = {}) {
  const elements = new Map((appearance.elements ?? []).map(entry => [entry.label, entry]));
  const atoms = new Map((appearance.atoms ?? []).map(entry => [String(entry.id), entry]));
  const groups = selectionGroupStyles(selectionGroups);
  const outputColors = colors.slice();
  const outputVisibility = visibility?.slice() ?? new Uint8Array(frame.ids.length).fill(255);
  const radii = radiiByType(frame);
  const typeStyles = frame.typeLabels.map(label => elements.get(label));
  const typeColors = typeStyles.map(style => elementColors && style?.color ? hexColor(style.color) : null);
  if (typeStyles.some((style, type) => typeColors[type] || style?.radius != null || style?.visible === false)) {
    for (let index = 0; index < frame.types.length; index += 1) {
      const type = frame.types[index], style = typeStyles[type];
      if (!style) continue;
      const rgb = typeColors[type];
      if (rgb) { outputColors[index * 3] = rgb[0]; outputColors[index * 3 + 1] = rgb[1]; outputColors[index * 3 + 2] = rgb[2]; }
      if (style.radius != null) radii[index] = style.radius;
      if (style.visible === false) outputVisibility[index] = 0;
    }
  }
  if (groups.size || atoms.size) {
    const byId = indicesById(frame.ids);
    for (const [key, group] of groups) forEachAtom(byId, key, index => {
      outputColors[index * 3] = group.rgb[0]; outputColors[index * 3 + 1] = group.rgb[1]; outputColors[index * 3 + 2] = group.rgb[2];
      if (group.visible === false) outputVisibility[index] = 0;
    });
    for (const [key, atom] of atoms) {
      const rgb = atom.color ? hexColor(atom.color) : null;
      forEachAtom(byId, key, index => {
        if (rgb) { outputColors[index * 3] = rgb[0]; outputColors[index * 3 + 1] = rgb[1]; outputColors[index * 3 + 2] = rgb[2]; }
        if (atom.radius != null) radii[index] = atom.radius;
        if (atom.visible === false) outputVisibility[index] = 0;
      });
    }
  }
  return { colors: outputColors, visibility: outputVisibility, radii };
}

export function hexColor(value) {
  if (!/^#[a-f\d]{6}$/i.test(value)) throw new Error('Colors must use six-digit hexadecimal values.');
  return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
}

export function rgbHex(values) {
  return `#${Array.from(values, value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
}
