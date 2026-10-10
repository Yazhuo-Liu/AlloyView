/** Kinds a caller may prepare ahead of an analysis. `voronoi` covers the
 * standard clip pipeline, the frame's neighbour index and the cell workspace;
 * `voronoiRadical` adds the radical clip pipeline. */
export const GPU_PREPARATION_KINDS = Object.freeze(['voronoi', 'voronoiRadical']);

/** Preparation is deliberately opt-in per analysis. Other kernels retain
 * their existing lazy allocations and never reserve atom-sized workspaces.
 * An empty list prepares the device alone. */
export function gpuPreparationKinds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some(kind => !GPU_PREPARATION_KINDS.includes(kind))) {
    throw new Error('GPU frame preparation currently supports analysisKinds: ["voronoi", "voronoiRadical"].');
  }
  return [...new Set(value)];
}
