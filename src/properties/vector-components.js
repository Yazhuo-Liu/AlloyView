/** Recognize imported vector families (force, velocity) among a frame's
 * numeric properties. Expressions, color quantities and the renderer's vector
 * settings all resolve the same component triplets from here. */
const normalizedNames = new WeakMap();
function normalizedPropertyName(property) {
  const cached = normalizedNames.get(property);
  if (cached?.name === property.name) return cached.normalized;
  const normalized = property.name.toLowerCase().replace(/[._\[\]\s]/g, '');
  normalizedNames.set(property, { name: property.name, normalized });
  return normalized;
}

/** Match a complete imported vector family; never mix force and velocity axes. */
export function findVectorComponents(properties, mode) {
  const families = mode === 'force' ? ['force', 'forces', 'f'] : mode === 'velocity' ? ['velocity', 'velocities', 'vel', 'v'] : [];
  const numeric = properties.filter(property => !property.categories && property.analysisKind !== 'vectors');
  for (const family of families) {
    for (const axes of [['x', 'y', 'z'], ['0', '1', '2'], ['1', '2', '3']]) {
      const matches = axes.map(axis => numeric.find(property => {
        const normalized = normalizedPropertyName(property);
        return normalized === family + axis;
      }));
      if (matches.every(Boolean)) return matches;
    }
  }
  return null;
}

/** Restore imported fields in their original order before resolving aliases. */
export function importedVectorComponents(frame, mode) {
  const properties = (frame?.properties ?? []).map(property => frame.analysisOriginalProperties?.get(property.name) ?? property);
  const names = new Set(properties.map(property => property.name));
  for (const property of frame?.analysisOriginalProperties?.values() ?? []) {
    if (!names.has(property.name)) properties.push(property);
  }
  return findVectorComponents(properties.filter(property => !property.analysisKind), mode);
}

