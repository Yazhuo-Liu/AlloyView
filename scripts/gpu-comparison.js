/** Compare periodic graphs independent of linked-cell insertion/output order. */
export function compareGpuBonds(actual, expected, vectorTolerance = 3e-5) {
  if (actual.count !== expected.count) throw new Error(`Bond counts differ: GPU ${actual.count}, CPU ${expected.count}.`);
  if (actual.coordination.length !== expected.coordination.length) throw new Error('Bond coordination lengths differ.');
  for (let atom = 0; atom < actual.coordination.length; atom++) {
    if (actual.coordination[atom] !== expected.coordination[atom]) throw new Error(`Bond coordination differs at atom ${atom}.`);
  }
  const key = (result, edge) => `${result.indices[edge * 2]}:${result.indices[edge * 2 + 1]}:${result.shifts[edge * 3]}:${result.shifts[edge * 3 + 1]}:${result.shifts[edge * 3 + 2]}`;
  const edges = new Map();
  for (let edge = 0; edge < expected.count; edge++) {
    const id = key(expected, edge);
    if (edges.has(id)) throw new Error(`Duplicate CPU periodic bond ${id}.`);
    edges.set(id, edge);
  }
  let maxAbsoluteError = 0;
  for (let edge = 0; edge < actual.count; edge++) {
    const id = key(actual, edge), counterpart = edges.get(id);
    if (counterpart === undefined) throw new Error(`Unexpected or duplicate GPU periodic bond ${id}.`);
    edges.delete(id);
    for (let axis = 0; axis < 3; axis++) {
      const difference = Math.abs(actual.vectors[edge * 3 + axis] - expected.vectors[counterpart * 3 + axis]);
      if (!Number.isFinite(difference) || difference > vectorTolerance) throw new Error(`Bond vector differs for ${id}, axis ${axis}: ${difference}.`);
      maxAbsoluteError = Math.max(maxAbsoluteError, difference);
    }
  }
  if (edges.size) throw new Error('GPU periodic bonds omit CPU edges.');
  return maxAbsoluteError;
}
