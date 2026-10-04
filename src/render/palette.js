const DEFAULT_ATOM_COLOR = [218, 201, 164];

const TYPE_COLORS = [
  [218, 201, 164], [111, 177, 150], [205, 112, 96], [157, 139, 185],
  [202, 184, 126], [91, 163, 174], [190, 120, 145], [177, 187, 191],
  [157, 169, 105], [206, 145, 128], [125, 151, 183], [171, 133, 103],
];

const ELEMENT_COLORS = {
  Al: [201, 198, 181], Cr: [142, 151, 163], Cu: [207, 124, 65],
  Fe: [198, 105, 78], Mg: [153, 181, 148], Mn: [158, 126, 174],
  Mo: [130, 160, 168], Nb: [104, 166, 158], Ni: [214, 194, 151],
  Ti: [166, 172, 176], V: [137, 150, 160], W: [117, 128, 143],
  Zn: [155, 163, 181], C: [83, 89, 91], H: [228, 226, 219],
};

const COLOR_MAPS = Object.freeze({
  atomeye: {
    label: 'AtomEye rainbow',
    stops: [
      [0.000, 0, 0, 128], [0.125, 0, 0, 255], [0.375, 0, 255, 255],
      [0.625, 255, 255, 0], [0.875, 255, 0, 0], [1.000, 128, 0, 0],
    ],
  },
  viridis: {
    label: 'Viridis',
    stops: [
      [0.00, 68, 1, 84], [0.25, 59, 82, 139], [0.50, 33, 145, 140],
      [0.75, 94, 201, 98], [1.00, 253, 231, 37],
    ],
  },
  plasma: {
    label: 'Plasma',
    stops: [
      [0.00, 13, 8, 135], [0.25, 126, 3, 168], [0.50, 204, 71, 120],
      [0.75, 248, 149, 64], [1.00, 240, 249, 33],
    ],
  },
  coolwarm: {
    label: 'Cool–warm',
    stops: [
      [0.00, 59, 76, 192], [0.25, 141, 176, 254], [0.50, 221, 221, 221],
      [0.75, 244, 152, 122], [1.00, 180, 4, 38],
    ],
  },
  grayscale: {
    label: 'Grayscale',
    stops: [[0.00, 32, 35, 38], [1.00, 244, 244, 240]],
  },
  // Sampled from the standard Matplotlib maps; both atoms and exported
  // legends interpolate the same anchors rather than using separate gradients.
  magma: {
    label: 'Magma',
    stops: [
      [0.000, 0, 0, 4], [0.125, 29, 17, 71], [0.250, 81, 18, 124],
      [0.375, 131, 38, 129], [0.500, 183, 55, 121], [0.625, 231, 82, 99],
      [0.750, 252, 137, 97], [0.875, 254, 196, 136], [1.000, 252, 253, 191],
    ],
  },
  inferno: {
    label: 'Inferno',
    stops: [
      [0.000, 0, 0, 4], [0.125, 33, 12, 74], [0.250, 87, 16, 110],
      [0.375, 138, 34, 106], [0.500, 188, 55, 84], [0.625, 228, 90, 49],
      [0.750, 249, 142, 9], [0.875, 249, 203, 53], [1.000, 252, 255, 164],
    ],
  },
  cividis: {
    label: 'Cividis',
    stops: [
      [0.000, 0, 34, 78], [0.125, 26, 56, 111], [0.250, 67, 78, 108],
      [0.375, 97, 101, 111], [0.500, 125, 124, 120], [0.625, 155, 148, 118],
      [0.750, 188, 174, 108], [0.875, 222, 201, 88], [1.000, 254, 232, 56],
    ],
  },
  turbo: {
    label: 'Turbo',
    stops: [
      [0.000, 48, 18, 59], [0.125, 70, 107, 227], [0.250, 40, 188, 235],
      [0.375, 50, 242, 152], [0.500, 164, 252, 60], [0.625, 238, 207, 58],
      [0.750, 251, 126, 33], [0.875, 208, 47, 5], [1.000, 122, 4, 3],
    ],
  },
  spectral: {
    label: 'Spectral',
    // ColorBrewer's diverging eleven-color Spectral sequence.
    stops: [
      [0.0, 158, 1, 66], [0.1, 213, 62, 79], [0.2, 244, 109, 67],
      [0.3, 253, 174, 97], [0.4, 254, 224, 139], [0.5, 255, 255, 191],
      [0.6, 230, 245, 152], [0.7, 171, 221, 164], [0.8, 102, 194, 165],
      [0.9, 50, 136, 189], [1.0, 94, 79, 162],
    ],
  },
});

export const SCALAR_COLOR_SCHEMES = Object.freeze(Object.entries(COLOR_MAPS).map(([value, map]) => ({
  value,
  label: map.label,
})));

export function colorsByType(frame, hiddenLabels = new Set()) {
  const colors = new Uint8Array(frame.types.length * 3);
  const counts = new Uint32Array(frame.typeLabels.length);
  const palette = frame.typeLabels.length === 1
    ? [DEFAULT_ATOM_COLOR]
    : frame.typeLabels.map((label, index) => ELEMENT_COLORS[label] ?? TYPE_COLORS[index % TYPE_COLORS.length]);
  for (let atom = 0; atom < frame.types.length; atom += 1) {
    colors.set(palette[frame.types[atom]], atom * 3);
    counts[frame.types[atom]] += 1;
  }
  return {
    colors,
    legend: {
      kind: 'types',
      title: 'Atom type',
      atomTypes: true,
      atomCount: frame.types.length,
      items: frame.typeLabels.map((label, index) => ({ id: index, label, color: palette[index],
        count: counts[index], visible: !hiddenLabels.has(label) })),
    },
  };
}

/** Label-based choices remain meaningful when a frame reorders its type IDs. */
export function visibilityByType(frame, hiddenLabels) {
  if (hiddenLabels.size === 0) return null;
  return Uint8Array.from(frame.types, id => hiddenLabels.has(frame.typeLabels[id]) ? 0 : 255);
}

export function colorsByCategory(property, hiddenTypes = new Set()) {
  const colors = new Uint8Array(property.data.length * 3);
  const counts = new Map();
  const categories = new Map(property.categories.map((item) => [item.id, item]));
  for (let atom = 0; atom < property.data.length; atom += 1) {
    const id = property.data[atom];
    colors.set(categories.get(id)?.color ?? [242, 242, 242], atom * 3);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return { colors, legend: {
    kind: 'types', title: property.displayName ?? property.name, property,
    atomCount: property.data.length,
    items: property.categories.map((item) => ({ ...item, count: counts.get(item.id) ?? 0,
      visible: !hiddenTypes.has(item.id) })),
  } };
}

export function visibilityByCategory(property, hiddenTypes) {
  if (hiddenTypes.size === 0) return null;
  return Uint8Array.from(property.data, (id) => hiddenTypes.has(Number.isFinite(id) ? id : 'NaN') ? 0 : 255);
}

export function colorsByProperty(property, limits = null, scheme = 'atomeye', hiddenCategories = new Set()) {
  const colorMap = COLOR_MAPS[scheme];
  if (!colorMap) throw new Error(`Unknown scalar color scheme “${scheme}”.`);
  let dataMinimum = Number.POSITIVE_INFINITY;
  let dataMaximum = Number.NEGATIVE_INFINITY;
  for (const value of property.data) {
    if (!Number.isFinite(value)) continue;
    dataMinimum = Math.min(dataMinimum, value);
    dataMaximum = Math.max(dataMaximum, value);
  }
  if (!Number.isFinite(dataMinimum) || !Number.isFinite(dataMaximum)) {
    // An entirely undefined strain field is a valid result, including at
    // defects or for an unmatched reference. Display NaN without an error.
    const colors = new Uint8Array(property.data.length * 3).fill(130);
    return { colors, legend: { kind: 'types', title: property.displayName ?? property.name,
      property, atomCount: property.data.length,
      items: [{ id: 'NaN', label: 'NaN', color: [130, 130, 130],
        count: property.data.length, visible: !hiddenCategories.has('NaN') }] } };
  }
  const minimum = limits?.minimum ?? dataMinimum;
  const maximum = limits?.maximum ?? dataMaximum;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || (limits && maximum <= minimum)) {
    throw new Error('The scalar color maximum must be greater than its minimum.');
  }
  const span = maximum - minimum;
  const colors = new Uint8Array(property.data.length * 3);
  for (let atom = 0; atom < property.data.length; atom += 1) {
    const value = property.data[atom];
    const normalized = Number.isFinite(value) && span > 0 ? (value - minimum) / span : 0.5;
    colors.set(Number.isFinite(value) ? sampleColorMap(normalized, colorMap.stops) : [130, 130, 130], atom * 3);
  }
  return {
    colors,
    legend: {
      kind: 'scalar',
      title: property.displayName ?? property.name,
      unit: property.unit,
      minimum,
      maximum,
      dataMinimum,
      dataMaximum,
      property,
      scheme,
      schemeLabel: colorMap.label,
      colorStops: colorMap.stops,
      gradient: colorMapGradient(colorMap.stops),
      customRange: Boolean(limits),
    },
  };
}

/** Intersect element, category and scalar masks before per-atom overrides. */
export function combineVisibilityMasks(...masks) {
  const active = masks.filter(mask => mask !== null && mask !== undefined);
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];
  const combined = new Uint8Array(active[0].length).fill(255);
  for (const mask of active) {
    if (mask.length !== combined.length) throw new Error('Visibility masks must have matching atom counts.');
    for (let atom = 0; atom < combined.length; atom++) if (!mask[atom]) combined[atom] = 0;
  }
  return combined;
}

export function visibilityByProperty(property, limits, hideOutside = true) {
  if (!limits || !hideOutside) return null;
  const { minimum, maximum } = limits;
  const mask = new Uint8Array(property.data.length);
  for (let atom = 0; atom < mask.length; atom += 1) {
    const value = property.data[atom];
    mask[atom] = Number.isFinite(value) && value >= minimum && value <= maximum ? 255 : 0;
  }
  return mask;
}

export function coupleScalarRange(minimum, maximum, changed, step) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null;
  if (minimum >= maximum) {
    // The requested bound can be much larger than the current data. A step
    // derived from the old range must still advance its floating-point value.
    const changedValue = changed === 'minimum' ? minimum : maximum;
    const increment = Math.max(
      Number.isFinite(step) && step > 0 ? step : 0,
      Math.abs(changedValue) * Number.EPSILON * 2,
      Number.MIN_VALUE,
    );
    if (changed === 'minimum') maximum = minimum + increment;
    else minimum = maximum - increment;
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum) return null;
  return { minimum, maximum };
}

export function colorMapGradient(stops) {
  return `linear-gradient(90deg, ${stops.map(([position, red, green, blue]) => (
    `rgb(${red} ${green} ${blue}) ${(position * 100).toFixed(1)}%`
  )).join(', ')})`;
}

function sampleColorMap(value, stops) {
  const clamped = Math.max(0, Math.min(1, value));
  let right = 1;
  while (right < stops.length && stops[right][0] < clamped) right += 1;
  const left = Math.max(0, right - 1);
  right = Math.min(stops.length - 1, right);
  const span = stops[right][0] - stops[left][0];
  const amount = span > 0 ? (clamped - stops[left][0]) / span : 0;
  return [0, 1, 2].map((component) => Math.round(
    stops[left][component + 1] * (1 - amount) + stops[right][component + 1] * amount,
  ));
}
