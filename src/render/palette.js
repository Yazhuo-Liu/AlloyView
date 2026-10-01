const TYPE_COLORS = [
  [214, 157, 92], [111, 177, 150], [205, 112, 96], [157, 139, 185],
  [202, 184, 126], [91, 163, 174], [190, 120, 145], [177, 187, 191],
  [157, 169, 105], [206, 145, 128], [125, 151, 183], [171, 133, 103],
];

const ELEMENT_COLORS = {
  Al: [190, 194, 194], Cr: [142, 151, 163], Cu: [207, 124, 65],
  Fe: [198, 105, 78], Mg: [153, 181, 148], Mn: [158, 126, 174],
  Mo: [130, 160, 168], Nb: [104, 166, 158], Ni: [205, 170, 112],
  Ti: [166, 172, 176], V: [137, 150, 160], W: [117, 128, 143],
  Zn: [155, 163, 181], C: [83, 89, 91], H: [228, 226, 219],
};

const VIRIDIS = [
  [0.00, 68, 1, 84], [0.13, 71, 44, 122], [0.25, 59, 82, 139],
  [0.38, 44, 113, 142], [0.50, 33, 145, 140], [0.63, 39, 173, 129],
  [0.75, 94, 201, 98], [0.88, 173, 220, 48], [1.00, 253, 231, 37],
];

export function colorsByType(frame) {
  const colors = new Uint8Array(frame.types.length * 3);
  const palette = frame.typeLabels.map((label, index) => ELEMENT_COLORS[label] ?? TYPE_COLORS[index % TYPE_COLORS.length]);
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

export function colorsByProperty(property, limits = null) {
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
    colors.set(sampleViridis(normalized), atom * 3);
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
      customRange: Boolean(limits),
    },
  };
}

function sampleViridis(value) {
  const clamped = Math.max(0, Math.min(1, value));
  let right = 1;
  while (right < VIRIDIS.length && VIRIDIS[right][0] < clamped) right += 1;
  const left = Math.max(0, right - 1);
  right = Math.min(VIRIDIS.length - 1, right);
  const span = VIRIDIS[right][0] - VIRIDIS[left][0];
  const amount = span > 0 ? (clamped - VIRIDIS[left][0]) / span : 0;
  return [0, 1, 2].map((component) => Math.round(
    VIRIDIS[left][component + 1] * (1 - amount) + VIRIDIS[right][component + 1] * amount,
  ));
}
