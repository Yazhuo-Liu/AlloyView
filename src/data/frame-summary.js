/** Small summaries travel with the arrays they describe. Structured cloning
 * preserves these aliases, so no extra coordinate/type buffers are copied.
 * Producers that edit an array in place must increment the corresponding
 * geometryRevision/typesRevision or explicitly invalidate its summary.
 * geometryRevision also invalidates types, matching GPU frame invalidation. */
export function createFrameSummaryAccumulator(typeCount) {
  return { typeCounts: new Uint32Array(typeCount),
    typeOrder: [],
    minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity] };
}

/** Read the stored values, including their Float32 rounding, not parser
 * temporaries. Math.min/max preserve signed zero and non-finite semantics. */
export function includeFrameSummaryAtom(summary, type, positions, offset) {
  if (summary.typeCounts[type]++ === 0) summary.typeOrder.push(type);
  for (let axis = 0; axis < 3; axis++) {
    const value = positions[offset + axis];
    summary.minimum[axis] = Math.min(summary.minimum[axis], value);
    summary.maximum[axis] = Math.max(summary.maximum[axis], value);
  }
}

export function collectFrameSummary(types, positions, typeCount) {
  const summary = createFrameSummaryAccumulator(typeCount);
  for (let atom = 0; atom < types.length; atom++) includeFrameSummaryAtom(summary, types[atom], positions, atom * 3);
  return summary;
}

/** CFG and periodic XYZ/PDB/POSCAR/data already visit every final coordinate
 * in this conversion. Generate the summary in that pass, with the same sums
 * and storage rounding as fractionalToCartesian's default Float32 output. */
export function fractionalToCartesianSummary(fractional, cell, types, typeCount) {
  const positions = new Float32Array(fractional.length), summary = createFrameSummaryAccumulator(typeCount);
  const { origin, vectors } = cell;
  for (let atom = 0; atom < types.length; atom++) {
    const offset = atom * 3, a = fractional[offset], b = fractional[offset + 1], c = fractional[offset + 2];
    positions[offset] = origin[0] + a * vectors[0] + b * vectors[3] + c * vectors[6];
    positions[offset + 1] = origin[1] + a * vectors[1] + b * vectors[4] + c * vectors[7];
    positions[offset + 2] = origin[2] + a * vectors[2] + b * vectors[5] + c * vectors[8];
    includeFrameSummaryAtom(summary, types[atom], positions, offset);
  }
  return { positions, summary };
}

export function attachFrameSummary(frame, collected = collectFrameSummary(frame.types, frame.positions, frame.typeLabels.length)) {
  frame.summary = { types: frame.types, positions: frame.positions,
    atomCount: frame.types.length, typeCount: frame.typeLabels.length,
    geometryRevision: frame.geometryRevision ?? 0, typesRevision: frame.typesRevision ?? 0,
    typeCounts: collected.typeCounts, typeOrder: collected.typeOrder,
    positionBounds: { minimum: collected.minimum, maximum: collected.maximum } };
  return frame;
}

export function frameTypeCounts(frame, { scan = true } = {}) {
  const summary = frame.summary, typeCount = frame.typeLabels?.length ?? 0;
  if (summary && summary.types === frame.types && summary.atomCount === frame.types?.length
    && summary.typeCount === typeCount && summary.typesRevision === (frame.typesRevision ?? 0)
    && summary.geometryRevision === (frame.geometryRevision ?? 0)) return summary.typeCounts;
  if (!scan) return null;
  // Unsummarized callers retain their original mutation semantics. In
  // particular, do not memoize arbitrary arrays merely by object identity.
  const counts = new Uint32Array(typeCount);
  for (const type of frame.types ?? []) counts[type]++;
  return counts;
}

export function frameCoordinateBounds(frame, positions = frame.positions) {
  const summary = frame.summary;
  return summary && summary.positions === positions && summary.atomCount * 3 === positions?.length
    && summary.geometryRevision === (frame.geometryRevision ?? 0) ? summary.positionBounds ?? null : null;
}

/** Match Set insertion order even when dense type IDs use a different order
 * (for example, numeric LAMMPS types are sorted during parsing). */
export function frameTypeOrder(frame) {
  return frameTypeCounts(frame, { scan: false }) && frame.summary.typeOrder
    ? frame.summary.typeOrder : [...new Set(frame.types)];
}

export function invalidateFrameCoordinateBounds(frame, positions) {
  if (frame?.summary && frame.summary.positions === positions) delete frame.summary.positionBounds;
}
