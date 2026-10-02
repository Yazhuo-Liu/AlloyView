/** Derived properties belong to one analysis. Keep imported properties so a
 * reset also restores data whose name was replaced by a calculated result.
 */
export function replaceAnalysisProperty(frame, property) {
  const index = frame.properties.findIndex(candidate => candidate.name === property.name);
  if (index < 0) frame.properties.push(property);
  else {
    const original = frame.properties[index];
    if (!original.analysisKind) {
      frame.analysisOriginalProperties ??= new Map();
      frame.analysisOriginalProperties.set(original.name, original);
    }
    frame.properties[index] = property;
  }
}

export function clearAnalysisResults(frame, kind) {
  const removed = new Set();
  frame.properties = frame.properties.flatMap(property => {
    if (property.analysisKind !== kind) return [property];
    removed.add(property.name);
    const original = frame.analysisOriginalProperties?.get(property.name);
    frame.analysisOriginalProperties?.delete(property.name);
    return original ? [original] : [];
  });
  if (frame.analysisOriginalProperties?.size === 0) delete frame.analysisOriginalProperties;
  return removed;
}
