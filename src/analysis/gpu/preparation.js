/** Preparation is deliberately opt-in per analysis. Other kernels retain
 * their existing lazy allocations and never reserve atom-sized workspaces. */
export function gpuPreparationKinds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some(kind => kind !== 'voronoi')) {
    throw new Error('GPU frame preparation currently supports analysisKinds: ["voronoi"].');
  }
  return [...new Set(value)];
}
