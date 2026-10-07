import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAppearance, findAtomIndex, hexColor } from '../src/appearance.js';
import { radiiByType } from '../src/render/atomic-radii.js';
import { normalizeSelectionGroups, selectionGroupStyles } from '../src/selection-groups.js';

// The original per-atom implementation, kept as the specification.
function reference(frame, colors, visibility, appearance = {}, { elementColors = true, selectionGroups = [] } = {}) {
  const elements = new Map((appearance.elements ?? []).map(entry => [entry.label, entry]));
  const atoms = new Map((appearance.atoms ?? []).map(entry => [String(entry.id), entry]));
  const groups = selectionGroupStyles(selectionGroups);
  const outputColors = colors.slice();
  const outputVisibility = visibility?.slice() ?? new Uint8Array(frame.ids.length).fill(255);
  const radii = radiiByType(frame);
  const typeStyles = frame.typeLabels.map(label => elements.get(label));
  for (let index = 0; index < frame.ids.length; index += 1) {
    const element = typeStyles[frame.types[index]], id = String(frame.ids[index]);
    const atom = atoms.get(id), group = groups.get(id);
    const color = atom?.color ?? group?.color ?? (elementColors ? element?.color : null);
    if (color) outputColors.set(color === group?.color ? group.rgb : hexColor(color), index * 3);
    radii[index] = atom?.radius ?? element?.radius ?? radii[index];
    if (element?.visible === false || atom?.visible === false || group?.visible === false) outputVisibility[index] = 0;
  }
  return { colors: outputColors, visibility: outputVisibility, radii };
}

test('per-type and per-ID appearance passes match the per-atom precedence rules exactly', () => {
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = values => values[Math.floor(random() * values.length)];
  const color = () => `#${Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')}`;
  for (let trial = 0; trial < 200; trial++) {
    const count = 1 + Math.floor(random() * 60), labels = ['Fe', 'Ni', 'Cr'];
    // Repeated IDs occur in replicated or merged frames.
    const ids = Array.from({ length: count }, (_, index) => random() < .1 ? Math.floor(random() * count) : index + 1);
    const frame = { ids: trial % 2 ? ids : Int32Array.from(ids), typeLabels: labels,
      types: Uint8Array.from({ length: count }, () => Math.floor(random() * 3)) };
    const colors = Uint8Array.from({ length: count * 3 }, () => Math.floor(random() * 256));
    const visibility = random() < .5 ? null : Uint8Array.from({ length: count }, () => random() < .2 ? 0 : 255);
    const appearance = {
      elements: labels.filter(() => random() < .5).map(label => ({ label, ...(random() < .6 ? { color: color() } : {}),
        ...(random() < .5 ? { radius: pick([0, 0.8, 1.9, null]) } : {}), ...(random() < .3 ? { visible: false } : {}) })),
      atoms: Array.from({ length: Math.floor(random() * 8) }, () => ({ id: pick(ids), ...(random() < .6 ? { color: color() } : {}),
        ...(random() < .5 ? { radius: pick([0.5, null, 2]) } : {}), ...(random() < .3 ? { visible: pick([false, true]) } : {}) })),
    };
    const selectionGroups = random() < .5 ? [] : normalizeSelectionGroups({ groups: Array.from({ length: 1 + Math.floor(random() * 3) }, (_, index) => ({
      id: `group-${index}`, name: `Group ${index}`, color: color(), visible: random() < .7,
      atomIds: [...new Set(Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(ids)))] })) }).groups;
    const options = { elementColors: random() < .5, selectionGroups };
    const expected = reference(frame, colors, visibility, appearance, options), actual = applyAppearance(frame, colors, visibility, appearance, options);
    for (const field of ['colors', 'visibility', 'radii']) assert.deepEqual(actual[field], expected[field], `trial ${trial}: ${field}`);
  }
});

test('atom ID lookup matches comparing every ID as text', () => {
  const lookup = (ids, id) => ids.findIndex(value => String(value) === String(id));
  const arrays = [Float64Array.from([3, -0, 7, 1e21, .1, 5, 7, NaN, Infinity, -5, 2 ** 53]), new Uint32Array([4, 9, 4]),
    ['a', '7', 7, 'b'], Int32Array.from([1, 2, 3])];
  const keys = [7, '7', '07', ' 7', '', '0', -0, 0, '-0', '1e21', 1e21, '1e+21', .1, '0.1', NaN, 'NaN', Infinity,
    'Infinity', -5, '-5', null, undefined, 'a', 2 ** 53, String(2 ** 53), 9, '9', 4, true, '3.0', [7], '0x7'];
  for (const ids of arrays) for (const id of keys) assert.equal(findAtomIndex(ids, id), lookup(ids, id), `${String(id)} in ${ids.constructor.name}`);
});
