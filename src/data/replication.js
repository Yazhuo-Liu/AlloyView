export const MAX_REPLICAS = 4096;

// Cell vectors are rows: a, b, c. Replication is display metadata only; neither
// atom arrays nor the cell used by neighbor analysis are expanded.
export function normalizeRepetitions(values, pbc) {
  if (values.length !== 3) throw new Error('Specify a repeat count for each cell direction.');
  const counts = Array.from(values, (value, axis) => {
    if (!pbc[axis]) return 1;
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_REPLICAS) {
      throw new Error(`Repeat counts must be whole numbers from 1 to ${MAX_REPLICAS}.`);
    }
    return count;
  });
  if (counts.reduce((product, count) => product * count, 1) > MAX_REPLICAS) {
    throw new Error(`Use at most ${MAX_REPLICAS} displayed cells in total.`);
  }
  return counts;
}

export function createReplication(cell, values = [1, 1, 1]) {
  const repetitions = normalizeRepetitions(values, cell.pbc);
  const vectors = Float64Array.from(cell.vectors, (value, index) => value * repetitions[Math.floor(index / 3)]);
  const displayCell = { ...cell, vectors };
  const replicas = [];
  const minimumOffset = [0, 0, 0], maximumOffset = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    for (let component = 0; component < 3; component += 1) {
      const extent = (repetitions[axis] - 1) * cell.vectors[axis * 3 + component];
      minimumOffset[component] += Math.min(0, extent);
      maximumOffset[component] += Math.max(0, extent);
    }
  }
  for (let c = 0; c < repetitions[2]; c += 1) {
    for (let b = 0; b < repetitions[1]; b += 1) {
      for (let a = 0; a < repetitions[0]; a += 1) {
        replicas.push({
          indices: [a, b, c],
          offset: [0, 1, 2].map(component => a * cell.vectors[component]
            + b * cell.vectors[3 + component] + c * cell.vectors[6 + component]),
        });
      }
    }
  }
  return { repetitions, displayCell, replicas, minimumOffset, maximumOffset };
}
