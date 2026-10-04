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

/** Compare every component and NaN location; summaries retain each field's
 * error so a tensor invariant cannot hide a wrong deformation component. */
export function compareGpuArrays(actual, expected, tolerance = 0, label = 'Result') {
  if (!actual || !expected || actual.length !== expected.length) throw new Error(`${label} lengths differ.`);
  let maxAbsoluteError = 0, nanAtoms = 0;
  for (let index = 0; index < actual.length; index++) {
    if (Number.isNaN(actual[index]) && Number.isNaN(expected[index])) { nanAtoms++; continue; }
    if (actual[index] === expected[index]) continue;
    const error = Math.abs(actual[index] - expected[index]);
    if (!Number.isFinite(error) || error > tolerance) {
      throw new Error(`${label} differs at ${index}: GPU ${actual[index]}, CPU ${expected[index]}, tolerance ${tolerance}.`);
    }
    maxAbsoluteError = Math.max(maxAbsoluteError, error);
  }
  return { maxAbsoluteError, nanAtoms };
}

export function compareGpuFields(actual, expected, fields, tolerance = 0) {
  const errors = Object.fromEntries(fields.map(name => [name, compareGpuArrays(actual[name], expected[name], tolerance, name)]));
  if (actual.incomplete !== expected.incomplete) throw new Error(`Incomplete atoms differ: GPU ${actual.incomplete}, CPU ${expected.incomplete}.`);
  if (actual.warning !== expected.warning) throw new Error('GPU/CPU silent undefined-fit behavior differs.');
  return { maxAbsoluteError: Math.max(...Object.values(errors).map(value => value.maxAbsoluteError)), fields: errors };
}

/** GPU transfer paths must copy inputs rather than detach or rewrite source
 * arrays; compare raw bytes to preserve NaNs, -0, and original precision. */
export function snapshotGpuInputs(frame, parameters = {}) {
  const arrays = [];
  const remember = (name, values) => {
    if (ArrayBuffer.isView(values)) arrays.push({ name, values, bytes: Uint8Array.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)) });
  };
  for (const name of ['fractional', 'positions', 'unwrapped', 'ids', 'types']) remember(name, frame[name]);
  for (const name of ['referenceFractional', 'referenceMapping', 'structureInput']) remember(name, parameters[name]);
  for (const name of ['fractional', 'positions', 'ids', 'types']) remember(`referenceFrame.${name}`, parameters.referenceFrame?.[name]);
  for (const [name, values] of Object.entries(parameters.ptmInput ?? {})) remember(`ptmInput.${name}`, values);
  remember('cell vectors', frame.cell?.vectors);
  remember('reference cell vectors', parameters.referenceCell?.vectors);
  return () => {
    for (const { name, values, bytes } of arrays) {
      if (values.byteLength !== bytes.length) throw new Error(`${name} source array was detached.`);
      const current = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
      for (let k = 0; k < bytes.length; k++) if (current[k] !== bytes[k]) throw new Error(`${name} source array changed at byte ${k}.`);
    }
  };
}
