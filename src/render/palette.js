const TYPE_COLORS = [
  [79, 226, 208], [255, 180, 88], [121, 166, 255], [244, 112, 139],
  [178, 132, 255], [119, 214, 120], [255, 224, 107], [105, 205, 244],
  [241, 143, 220], [197, 211, 220], [235, 125, 86], [129, 236, 178],
];

const ELEMENT_COLORS = {
  Al: [138, 183, 255], Cr: [138, 153, 199], Cu: [224, 129, 62],
  Fe: [224, 118, 81], Mg: [142, 224, 152], Mn: [168, 120, 211],
  Mo: [118, 190, 200], Nb: [99, 194, 180], Ni: [108, 202, 116],
  Ti: [172, 181, 190], V: [153, 168, 201], W: [93, 122, 181],
  Zn: [143, 161, 214], C: [98, 112, 120], H: [225, 233, 235],
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

export function colorsByProperty(property) {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of property.data) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new Error(`Property ${property.name} has no finite values to color.`);
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
