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
  // The same integer has the same hue when categories disappear or reorder.
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  const hue = ((hash ^ (hash >>> 16)) >>> 0) / 4294967296 * 6;
  const chroma = .72, x = chroma * (1 - Math.abs(hue % 2 - 1)), m = .12;
  const rgb = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x]
    : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return rgb.map(component => Math.round(255 * (component + m)));
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
