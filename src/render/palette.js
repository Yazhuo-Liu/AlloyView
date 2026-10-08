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
    const type = frame.types[atom], rgb = palette[type];
    colors[atom * 3] = rgb[0]; colors[atom * 3 + 1] = rgb[1]; colors[atom * 3 + 2] = rgb[2];
    counts[type] += 1;
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
  const hidden = frame.typeLabels.map(label => hiddenLabels.has(label)), mask = new Uint8Array(frame.types.length);
  for (let atom = 0; atom < mask.length; atom++) mask[atom] = hidden[frame.types[atom]] ? 0 : 255;
  return mask;
}

// Category IDs are usually small non-negative integers. Those use lookup
// tables; any other value (NaN, negative, fractional or large) takes the Map
// path, so results match a Map lookup per atom exactly.
const CATEGORY_TABLE_SIZE = 256;
// `(id | 0) === id` is Number.isInteger for this range, including -0.
const isTableCategory = id => id >= 0 && id < CATEGORY_TABLE_SIZE && (id | 0) === id;

// Open-ended integer categories, such as cluster IDs, list only some IDs in
// `categories`. With `unlistedCategories: { label, legendLabel, colors }`,
// other positive integer IDs cycle through `colors` and share one legend
// entry whose visibility key is UNLISTED_CATEGORY_ID. Properties without it
// keep the fallback color and per-ID legend exactly as before.
export const UNLISTED_CATEGORY_ID = 'other';
const isUnlistedCandidate = id => typeof id === 'number' && Number.isInteger(id) && id > 0;

function categoryColorLookup(property, categories, fallback) {
  const cycle = property.unlistedCategories?.colors;
  if (!cycle?.length) return id => categories.get(id)?.color ?? fallback;
  return id => categories.get(id)?.color ?? (isUnlistedCandidate(id) ? cycle[(id - 1) % cycle.length] : fallback);
}

function unlistedLegendItems(property, categories, tableCounts, counts, hiddenTypes) {
  if (!property.unlistedCategories) return [];
  let atoms = 0, ids = 0;
  for (let id = 1; id < CATEGORY_TABLE_SIZE; id += 1) if (tableCounts[id] && !categories.has(id)) { atoms += tableCounts[id]; ids += 1; }
  for (const [id, count] of counts) if (isUnlistedCandidate(id) && !categories.has(id)) { atoms += count; ids += 1; }
  if (!ids) return [];
  const { legendLabel = 'Other', label = 'Category' } = property.unlistedCategories;
  return [{ id: UNLISTED_CATEGORY_ID, label: `${legendLabel} (${ids.toLocaleString('en-US')})`, color: [200, 200, 200],
    description: `${ids.toLocaleString('en-US')} more ${label.toLowerCase()} IDs, each in its own cyclic color; show or hide them together`,
    count: atoms, visible: !hiddenTypes.has(UNLISTED_CATEGORY_ID) }];
}

export function colorsByCategory(property, hiddenTypes = new Set()) {
  const colors = new Uint8Array(property.data.length * 3);
  const counts = new Map(), tableCounts = new Uint32Array(CATEGORY_TABLE_SIZE);
  const categories = new Map(property.categories.map((item) => [item.id, item]));
  const fallback = [242, 242, 242], table = new Uint8Array(CATEGORY_TABLE_SIZE * 3);
  const colorOf = categoryColorLookup(property, categories, fallback);
  for (let id = 0; id < CATEGORY_TABLE_SIZE; id += 1) table.set(colorOf(id), id * 3);
  for (let atom = 0; atom < property.data.length; atom += 1) {
    const id = property.data[atom], offset = atom * 3;
    if (id >= 0 && id < CATEGORY_TABLE_SIZE && (id | 0) === id) {
      const entry = id * 3;
      colors[offset] = table[entry]; colors[offset + 1] = table[entry + 1]; colors[offset + 2] = table[entry + 2];
      tableCounts[id] += 1;
    } else {
      colors.set(colorOf(id), offset);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const countOf = id => isTableCategory(id) ? tableCounts[id] : counts.get(id) ?? 0;
  return { colors, legend: {
    kind: 'types', title: property.displayName ?? property.name, property,
    atomCount: property.data.length,
    items: [...property.categories.map((item) => ({ ...item, count: countOf(item.id),
      visible: !hiddenTypes.has(item.id) })), ...unlistedLegendItems(property, categories, tableCounts, counts, hiddenTypes)],
  } };
}

/** Eighteen well-separated colors (minimum CIE76 ΔE ≈ 26), none of them gray.
 * Cluster IDs and discrete integer values cycle through them. */
export const DISTINCT_CATEGORY_COLORS = Object.freeze([
  [230, 25, 75], [60, 180, 75], [255, 225, 25], [0, 130, 200], [245, 130, 48], [145, 30, 180],
  [70, 240, 240], [240, 50, 230], [210, 245, 60], [250, 190, 212], [0, 128, 128], [220, 190, 255],
  [170, 110, 40], [128, 0, 0], [170, 255, 195], [128, 128, 0], [255, 215, 180], [100, 100, 255],
].map(color => Object.freeze(color)));

export function visibilityByCategory(property, hiddenTypes) {
  if (hiddenTypes.size === 0) return null;
  const hidden = new Uint8Array(CATEGORY_TABLE_SIZE), mask = new Uint8Array(property.data.length);
  const listed = property.unlistedCategories && hiddenTypes.has(UNLISTED_CATEGORY_ID)
    ? new Set(property.categories.map(item => item.id)) : null;
  const hiddenUnlisted = id => listed !== null && isUnlistedCandidate(id) && !listed.has(id);
  for (let id = 0; id < CATEGORY_TABLE_SIZE; id += 1) hidden[id] = hiddenTypes.has(id) || hiddenUnlisted(id) ? 1 : 0;
  for (let atom = 0; atom < mask.length; atom += 1) {
    const id = property.data[atom];
    const isHidden = id >= 0 && id < CATEGORY_TABLE_SIZE && (id | 0) === id
      ? hidden[id] === 1 : hiddenTypes.has(Number.isFinite(id) ? id : 'NaN') || hiddenUnlisted(id);
    mask[atom] = isHidden ? 0 : 255;
  }
  return mask;
}

/** Optional rangeVisibility excludes atoms from range estimates, without changing their colors or source data. */
export function colorsByProperty(property, limits = null, scheme = 'atomeye', hiddenCategories = new Set(), rangeVisibility = null) {
  const colorMap = COLOR_MAPS[scheme];
  if (!colorMap) throw new Error(`Unknown scalar color scheme “${scheme}”.`);
  if (rangeVisibility !== null && rangeVisibility !== undefined && rangeVisibility.length !== property.data.length) {
    throw new Error('Scalar range visibility must match the property atom count.');
  }
  let dataMinimum = Number.POSITIVE_INFINITY;
  let dataMaximum = Number.NEGATIVE_INFINITY;
  let hasFiniteSource = false;
  let undefinedCount = 0;
  for (let atom = 0; atom < property.data.length; atom += 1) {
    const value = property.data[atom];
    const eligible = !rangeVisibility || Boolean(rangeVisibility[atom]);
    if (!Number.isFinite(value)) {
      if (eligible) undefinedCount += 1;
      continue;
    }
    hasFiniteSource = true;
    if (!eligible) continue;
    dataMinimum = Math.min(dataMinimum, value);
    dataMaximum = Math.max(dataMaximum, value);
  }
  const hasFiniteRange = Number.isFinite(dataMinimum) && Number.isFinite(dataMaximum);
  if (!hasFiniteSource && undefinedCount > 0) {
    // An entirely undefined strain field is a valid result, including at
    // defects or for an unmatched reference. Display NaN without an error.
    const colors = new Uint8Array(property.data.length * 3).fill(130);
    return { colors, legend: { kind: 'types', title: property.displayName ?? property.name,
      property, atomCount: property.data.length,
      items: [{ id: 'NaN', label: 'NaN', color: [130, 130, 130],
        count: undefinedCount, visible: !hiddenCategories.has('NaN') }] } };
  }
  if (!hasFiniteRange) dataMinimum = dataMaximum = null;
  const emptyRange = !hasFiniteRange && !limits;
  const minimum = limits?.minimum ?? dataMinimum;
  const maximum = limits?.maximum ?? dataMaximum;
  if (!emptyRange && (!Number.isFinite(minimum) || !Number.isFinite(maximum) || (limits && maximum <= minimum))) {
    throw new Error('The scalar color maximum must be greater than its minimum.');
  }
  const span = emptyRange ? 0 : maximum - minimum;
  // Avoid amplifying backend precision into apparent defects in an otherwise
  // uniform field. A Float64 container may hold GPU float32 measurements.
  // Keep source values and range bounds exact; an explicit range still maps
  // every requested difference, even at this scale.
  const suppliedTolerance = property.autoRangeRelativeTolerance;
  const relativeTolerance = Number.isFinite(suppliedTolerance) && suppliedTolerance >= 0
    ? Math.max(32 * Number.EPSILON, suppliedTolerance) : 32 * Number.EPSILON;
  const uniform = !limits && !emptyRange && span <= relativeTolerance * Math.max(Math.abs(minimum), Math.abs(maximum));
  const colors = new Uint8Array(property.data.length * 3), stops = flatColorStops(colorMap.stops);
  for (let atom = 0; atom < property.data.length; atom += 1) {
    const value = property.data[atom];
    if (!Number.isFinite(value)) { colors[atom * 3] = colors[atom * 3 + 1] = colors[atom * 3 + 2] = 130; continue; }
    writeColorMap(span > 0 && !uniform ? (value - minimum) / span : 0.5, stops, colors, atom * 3);
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
      ...(emptyRange ? { emptyRange: true } : {}),
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

// Color-map stops flattened into typed arrays once per map: the per-atom loop
// then avoids nested-array access while keeping the same arithmetic.
const flatStopsCache = new WeakMap();
function flatColorStops(stops) {
  let flat = flatStopsCache.get(stops);
  if (!flat) {
    flat = { count: stops.length, positions: Float64Array.from(stops, stop => stop[0]),
      rgb: Float64Array.from(stops.flatMap(stop => [stop[1], stop[2], stop[3]])) };
    flatStopsCache.set(stops, flat);
  }
  return flat;
}

// Interpolated color-map RGB written at `offset`; runs once per atom, so it
// stores into the output instead of returning a new array.
function writeColorMap(value, { count, positions, rgb }, output, offset) {
  const clamped = Math.max(0, Math.min(1, value));
  let right = 1;
  while (right < count && positions[right] < clamped) right += 1;
  const left = Math.max(0, right - 1);
  right = Math.min(count - 1, right);
  const span = positions[right] - positions[left];
  const amount = span > 0 ? (clamped - positions[left]) / span : 0;
  const from = left * 3, to = right * 3;
  output[offset] = Math.round(rgb[from] * (1 - amount) + rgb[to] * amount);
  output[offset + 1] = Math.round(rgb[from + 1] * (1 - amount) + rgb[to + 1] * amount);
  output[offset + 2] = Math.round(rgb[from + 2] * (1 - amount) + rgb[to + 2] * amount);
}
