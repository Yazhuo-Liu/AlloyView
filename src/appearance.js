import { radiiByType } from './render/atomic-radii.js';
import { selectionGroupStyles } from './selection-groups.js';

/** Display overrides are keyed by stable labels/IDs, independent of atom order. */
export function applyAppearance(frame, colors, visibility, appearance = {}, { elementColors = true, selectionGroups = [] } = {}) {
  const elements = new Map((appearance.elements ?? []).map(entry => [entry.label, entry]));
  const atoms = new Map((appearance.atoms ?? []).map(entry => [String(entry.id), entry]));
  const groups = selectionGroupStyles(selectionGroups);
  const outputColors = colors.slice();
  const outputVisibility = visibility?.slice() ?? new Uint8Array(frame.ids.length).fill(255);
  const radii = radiiByType(frame);
  const typeStyles = frame.typeLabels.map(label => elements.get(label));
  for (let index = 0; index < frame.ids.length; index += 1) {
    const element = typeStyles[frame.types[index]];
    const id = String(frame.ids[index]);
    const atom = atoms.get(id);
    const group = groups.get(id);
    const color = atom?.color ?? group?.color ?? (elementColors ? element?.color : null);
    if (color) outputColors.set(color === group?.color ? group.rgb : hexColor(color), index * 3);
    radii[index] = atom?.radius ?? element?.radius ?? radii[index];
    if (element?.visible === false || atom?.visible === false || group?.visible === false) outputVisibility[index] = 0;
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
