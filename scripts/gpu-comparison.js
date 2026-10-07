/** GPU bond vectors are float32 differences of float32 positions and cell
 * images, so their rounding error grows with the coordinate magnitude rather
 * than the bond length. Allow four float32 ulps of the largest coordinate. */
export function bondVectorTolerance(frame) {
  const { vectors, origin } = frame.cell, extent = [0, 0, 0];
  for (let index = 0; index < frame.fractional.length; index++) extent[index % 3] = Math.max(extent[index % 3], Math.abs(frame.fractional[index]));
  let scale = 0;
  for (let axis = 0; axis < 3; axis++) {
    scale = Math.max(scale, Math.abs(origin?.[axis] ?? 0) + extent[0] * Math.abs(vectors[axis])
      + extent[1] * Math.abs(vectors[3 + axis]) + extent[2] * Math.abs(vectors[6 + axis]));
  }
  return Math.max(3e-5, scale > 0 ? 4 * 2 ** (Math.floor(Math.log2(scale)) - 23) : 0);
}

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

/** Auto CSP recognition/votes are categorical outputs, so scalar tolerance
 * never excuses different shell selection or a different unresolved atom. */
export function compareGpuCentrosymmetry(actual, expected, tolerance = 2e-6) {
  const scalar = compareGpuArrays(actual.centrosymmetry, expected.centrosymmetry, tolerance, 'centrosymmetry');
  if (actual.incomplete !== expected.incomplete) throw new Error('Central-symmetry incomplete counts differ.');
  if (expected.cspStructureTypes) {
    compareGpuArrays(actual.cspStructureTypes, expected.cspStructureTypes, 0, 'CSP structure types');
    compareGpuArrays(actual.cspNeighborCounts, expected.cspNeighborCounts, 0, 'CSP neighbor counts');
    for (const [name, count] of Object.entries(expected.cspSummary)) {
      if (actual.cspSummary?.[name] !== count) throw new Error(`CSP ${name} summary differs: GPU ${actual.cspSummary?.[name]}, CPU ${count}.`);
    }
  }
  return scalar;
}

/** Readback vectors feed the existing WebGL/vector-property pipeline. Compare
 * magnitude after the same Float32 vector rounding used by the CPU UI. */
export function compareGpuDisplacements(actual, expected, tolerance = 2e-6) {
  if (!(actual.vectors instanceof Float32Array)) throw new Error('Displacement readback must use Float32 vectors for WebGL.');
  const vectors = compareGpuArrays(actual.vectors, expected.vectors, tolerance, 'displacement vectors');
  const count = expected.vectors.length / 3;
  const expectedMagnitudes = expected.magnitudes ?? Float64Array.from({ length: count }, (_, atom) => Math.hypot(
    expected.vectors[atom * 3], expected.vectors[atom * 3 + 1], expected.vectors[atom * 3 + 2]));
  // Magnitudes may exceed Float32's range even when every vector component is finite.
  if (!(actual.magnitudes instanceof Float64Array)) throw new Error('Displacement magnitudes must retain Float64 range.');
  if (actual.magnitudes.length !== count) throw new Error('Displacement magnitude lengths differ.');
  let magnitudeMaxError = 0, maxRelativeError = 0, nanAtoms = 0;
  for (let atom = 0; atom < count; atom++) {
    const observed = actual.magnitudes[atom], baseline = expectedMagnitudes[atom];
    if (Number.isNaN(observed) && Number.isNaN(baseline)) { nanAtoms++; continue; }
    const error = Math.abs(observed - baseline), permitted = Math.max(tolerance, Math.abs(baseline) * 5e-14);
    if (!Number.isFinite(error) || error > permitted) throw new Error(`Displacement magnitude differs at ${atom}: GPU ${observed}, CPU ${baseline}.`);
    magnitudeMaxError = Math.max(magnitudeMaxError, error);
    if (baseline !== 0) maxRelativeError = Math.max(maxRelativeError, error / Math.abs(baseline));
  }
  const magnitudes = { maxAbsoluteError: magnitudeMaxError, maxRelativeError, nanAtoms };
  compareGpuArrays(actual.referenceMapping, expected.referenceMapping, 0, 'displacement ID mapping');
  for (const name of ['matched', 'unmatched', 'minimumImage', 'mappingMode']) {
    if (actual[name] !== expected[name]) throw new Error(`Displacement ${name} differs: GPU ${actual[name]}, CPU ${expected[name]}.`);
  }
  return { maxAbsoluteError: Math.max(vectors.maxAbsoluteError, magnitudes.maxAbsoluteError), vectors, magnitudes };
}

/** PTM consumes exact ordered Cartesian rows; compare every valid neighbor
 * and all original source indices rather than accepting equivalent distances. */
export function compareGpuPreparedNeighbors(actual, expected) {
  if (!(actual.counts instanceof Uint8Array) || !(actual.indices instanceof Uint32Array)
      || !(actual.vectors instanceof Float64Array) || actual.maxNeighbors !== 18) {
    throw new Error('GPU PTM preparation must return Uint8 counts, Uint32 indices and Float64 Cartesian vectors.');
  }
  compareGpuArrays(actual.counts, expected.counts, 0, 'PTM neighbor counts');
  if (actual.startAtom !== expected.startAtom || actual.endAtom !== expected.endAtom
      || actual.indices.length !== actual.counts.length * 18 || actual.vectors.length !== actual.counts.length * 54) {
    throw new Error('GPU PTM neighbor table range or lengths differ.');
  }
  let comparedNeighbors = 0;
  for (let atom = 0; atom < actual.counts.length; atom++) for (let neighbor = 0; neighbor < actual.counts[atom]; neighbor++) {
    const index = atom * 18 + neighbor;
    if (actual.indices[index] !== expected.indices[index]) throw new Error(`PTM neighbor ordering differs at atom ${atom}, neighbor ${neighbor}.`);
    for (let axis = 0; axis < 3; axis++) if (actual.vectors[index * 3 + axis] !== expected.vectors[index * 3 + axis]) {
      throw new Error(`PTM Float64 neighbor vector differs at atom ${atom}, neighbor ${neighbor}, axis ${axis}.`);
    }
    comparedNeighbors++;
  }
  return { maxAbsoluteError: 0, comparedNeighbors };
}

export function compareGpuPtm(actual, expected, tolerance = 2e-12) {
  const fields = Object.fromEntries(['structures', 'rmsd', 'scales', 'deformation', 'distances'].map(name => [name,
    compareGpuArrays(actual[name], expected[name], name === 'structures' ? 0 : tolerance, `PTM ${name}`)]));
  return { maxAbsoluteError: Math.max(...Object.values(fields).map(error => error.maxAbsoluteError)), fields };
}

/** GPU transfer paths must copy inputs rather than detach or rewrite source
 * arrays; compare raw bytes to preserve NaNs, -0, and original precision. */
export function snapshotGpuInputs(frame, parameters = {}) {
  const arrays = [];
  const remember = (name, values) => {
    if (ArrayBuffer.isView(values)) arrays.push({ name, values, bytes: Uint8Array.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)) });
  };
  for (const name of ['fractional', 'positions', 'unwrappedPositions', 'unwrapped', 'ids', 'types']) remember(name, frame[name]);
  for (const name of ['referenceFractional', 'referenceMapping', 'structureInput', 'currentPositions', 'referencePositions']) remember(name, parameters[name]);
  for (const name of ['fractional', 'positions', 'unwrappedPositions', 'ids', 'types']) remember(`referenceFrame.${name}`, parameters.referenceFrame?.[name]);
  for (const [name, values] of Object.entries(parameters.ptmInput ?? {})) remember(`ptmInput.${name}`, values);
  for (const [name, values] of Object.entries(parameters.preparedNeighbors ?? {})) remember(`preparedNeighbors.${name}`, values);
  remember('cell vectors', frame.cell?.vectors);
  remember('cell origin', frame.cell?.origin);
  remember('reference cell origin', parameters.referenceCell?.origin ?? parameters.referenceFrame?.cell?.origin);
  remember('reference cell vectors', parameters.referenceCell?.vectors);
  return () => {
    for (const { name, values, bytes } of arrays) {
      if (values.byteLength !== bytes.length) throw new Error(`${name} source array was detached.`);
      const current = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
      for (let k = 0; k < bytes.length; k++) if (current[k] !== bytes[k]) throw new Error(`${name} source array changed at byte ${k}.`);
    }
  };
}
