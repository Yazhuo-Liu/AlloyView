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
});

export const SCALAR_COLOR_SCHEMES = Object.freeze(Object.entries(COLOR_MAPS).map(([value, map]) => ({
  value,
  label: map.label,
})));

export function colorsByType(frame) {
  const colors = new Uint8Array(frame.types.length * 3);
  const palette = frame.typeLabels.length === 1
    ? [DEFAULT_ATOM_COLOR]
    : frame.typeLabels.map((label, index) => ELEMENT_COLORS[label] ?? TYPE_COLORS[index % TYPE_COLORS.length]);
  for (let atom = 0; atom < frame.types.length; atom += 1) {
    colors.set(palette[frame.types[atom]], atom * 3);
  }
  return {
    colors,
    legend: {
      kind: 'types',
      title: 'Atom type',
      items: frame.typeLabels.map((label, index) => ({ label, color: palette[index] })),
    },
  };
}

export function colorsByProperty(property, limits = null, scheme = 'atomeye') {
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
    throw new Error(`Property ${property.name} has no finite values to color.`);
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
    colors.set(sampleColorMap(normalized, colorMap.stops), atom * 3);
  }
  return {
    colors,
    legend: {
      kind: 'scalar',
      title: property.name,
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
  const increment = Number.isFinite(step) && step > 0 ? step : Number.EPSILON;
  if (minimum >= maximum) {
    if (changed === 'minimum') maximum = minimum + increment;
    else minimum = maximum - increment;
  }
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
