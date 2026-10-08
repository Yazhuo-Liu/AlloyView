import { DISTINCT_CATEGORY_COLORS } from './palette.js';

// Imported numeric fields stay continuous unless the user explicitly chooses
// discrete colors. Values, rather than their current legend row, identify a class.
export const MAX_DISCRETE_VALUES = 32;
const valueCache = new WeakMap();

export function discreteValues(property) {
  const data = property?.data;
  if (!data || property.categories) return null;
  if (valueCache.has(data)) return valueCache.get(data);
  const counts = new Map();
  let undefinedCount = 0;
  for (const value of data) {
    if (!Number.isFinite(value)) { undefinedCount++; continue; }
    if (!Number.isSafeInteger(value)) { valueCache.set(data, null); return null; }
    counts.set(value === 0 ? 0 : value, (counts.get(value) ?? 0) + 1);
    if (counts.size > MAX_DISCRETE_VALUES) { valueCache.set(data, null); return null; }
  }
  const values = counts.size ? [...counts].sort((a, b) => a[0] - b[0]).map(([id, count]) => ({ id, count })) : null;
  if (values && undefinedCount) values.push({ id: 'NaN', count: undefinedCount });
  valueCache.set(data, values);
  return values;
}

export function discreteColor(value) {
  if (value === 'NaN') return [130, 130, 130];
  // The color depends only on the integer, so it survives categories that
  // disappear or reorder. Any 18 consecutive integers get distinct colors.
  const count = DISTINCT_CATEGORY_COLORS.length;
  return [...DISTINCT_CATEGORY_COLORS[((value % count) + count) % count]];
}

export function colorsByDiscreteProperty(property, hiddenValues = new Set()) {
  const values = discreteValues(property);
  if (!values) return null;
  const categories = values.map(({ id }) => ({ id, label: String(id), color: discreteColor(id) }));
  const discreteProperty = { ...property, categories, discrete: true };
  const lookup = new Map(categories.map(category => [category.id, category.color]));
  const colors = new Uint8Array(property.data.length * 3);
  for (let atom = 0; atom < property.data.length; atom++) {
    const value = property.data[atom], id = Number.isFinite(value) ? value : 'NaN';
    colors.set(lookup.get(id), atom * 3);
  }
  return { colors, legend: { kind: 'types', title: property.displayName ?? property.name,
    property: discreteProperty, atomCount: property.data.length, discrete: true,
    unit: property.unit ?? '', items: categories.map((category, index) => ({ ...category, count: values[index].count,
      visible: !hiddenValues.has(category.id) })) } };
}
