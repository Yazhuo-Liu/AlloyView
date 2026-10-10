import { recommendCoordinationCutoff } from './cutoff.js';
import { dxaCartesianCoordinates, runDxaKernelTask, validateDxaFrame } from './dxa.js';

/** Alpha-shape surface construction after OVITO 3.9.4's Construct surface
 * mesh modifier (alpha-shape method with identified regions). The native
 * code is part of the DXA kernel, which already contains the periodic
 * Delaunay tessellation and the manifold builder. */
export const SURFACE_MESH_DEFAULTS = Object.freeze({ radius: 4, smoothingLevel: 8 });
export const SURFACE_MESH_STAGES = 6;
export const MAX_SURFACE_SMOOTHING = 100;
export const MAX_SURFACE_RADIUS = 1e6;

export function validateSurfaceMeshParameters(parameters = {}) {
  const settings = Object.fromEntries(Object.entries(SURFACE_MESH_DEFAULTS)
    .map(([name, value]) => [name, Object.hasOwn(parameters ?? {}, name) ? parameters[name] : value]));
  if (typeof settings.radius !== 'number' || !(settings.radius > 0) || settings.radius > MAX_SURFACE_RADIUS) {
    throw new Error('The probe sphere radius must be a positive number of ångströms.');
  }
  if (!Number.isInteger(settings.smoothingLevel) || settings.smoothingLevel < 0 || settings.smoothingLevel > MAX_SURFACE_SMOOTHING) {
    throw new Error(`The surface smoothing level must be an integer between 0 and ${MAX_SURFACE_SMOOTHING}.`);
  }
  return settings;
}

/** One byte per atom, nonzero for atoms that take part in the tessellation;
 * null uses every atom. */
export function validateSurfaceMask(mask, count) {
  if (mask === undefined || mask === null) return null;
  if (!(mask instanceof Uint8Array) || mask.length !== count) throw new Error('The surface atom mask does not match the frame.');
  return mask;
}

/** A starting radius from the first-shell cutoff estimate of the frame's
 * elements: 1.15 times that cutoff, about 1.3 nearest-neighbor distances.
 * A perfect FCC or BCC crystal is solid above 0.71 and 0.65 neighbor
 * distances; at 1.3 a single vacancy stays filled and larger voids open. */
export function suggestProbeRadius(frame) {
  const cutoff = recommendCoordinationCutoff(frame);
  const radius = Number((Math.round(cutoff.value * 1.15 / 0.05) * 0.05).toFixed(2));
  return { radius, cutoff: cutoff.value, method: cutoff.method,
    message: `${radius.toFixed(2)} Å = 1.15 × the ${cutoff.value.toFixed(2)} Å first-shell cutoff estimate (about 1.3 nearest-neighbor distances).` };
}

function nativeSurfaceError(module, canceled) {
  const pointer = module._alloy_surface_last_error();
  const message = pointer ? module.UTF8ToString(pointer) : 'Surface construction failed.';
  if (canceled || /was canceled/.test(message)) return new DOMException('The surface calculation was cancelled.', 'AbortError');
  return new Error(message || 'Surface construction failed.');
}

/** Constructs the surface with the native kernel. Browser callers should use
 * DxaClient.surface() to keep the synchronous work off the UI thread. */
export async function calculateSurfaceMesh(frame, parameters = {}, { mask, onProgress = () => {}, onControl = () => {},
  resetCancellation = true, memoryBudgetBytes, workerCount: requestedWorkers, signal, startupTimeoutMs } = {}) {
  if (signal?.aborted) throw new DOMException('The surface calculation was cancelled.', 'AbortError');
  const settings = validateSurfaceMeshParameters(parameters), count = validateDxaFrame(frame);
  const selection = validateSurfaceMask(mask, count);
  const startedAt = performance.now();
  let workerCount = 1;
  const report = update => onProgress({ backend: 'cpu', workerCount, totalStages: SURFACE_MESH_STAGES, totalAtoms: count, ...update });
  return runDxaKernelTask({ atomCount: count, workerCount: requestedWorkers, memoryBudgetBytes, onControl, resetCancellation, signal,
    startupTimeoutMs, onProgress: update => report({ ...update, completedStages: 0, totalStages: SURFACE_MESH_STAGES }) },
  async (module, kernel) => {
    workerCount = kernel.workerCount;
    const hostTimings = { prepareMs: performance.now() - startedAt, inputMs: 0, collectMs: 0 };
    let hostStarted = performance.now();
    const positions = dxaCartesianCoordinates(frame);
    const coordinates = module._malloc(positions.byteLength), cellPointer = module._malloc(12 * 8);
    const maskPointer = selection ? module._malloc(count) : 0;
    const stageTimings = [];
    let stagePhase, stageStarted;
    const previousProgress = module.onSurfaceProgress;
    module.onSurfaceProgress = (phase, completedStages, totalStages) => {
      const now = performance.now();
      if (stagePhase) stageTimings.push({ phase: stagePhase, elapsedMs: now - stageStarted, backend: 'cpu' });
      stagePhase = completedStages < totalStages ? phase : undefined;
      stageStarted = now;
      report({ phase, completedStages, totalStages });
    };
    try {
      if (!coordinates || !cellPointer || (selection && !maskPointer)) {
        throw new Error('The surface calculation could not allocate its input; reduce the analyzed structure.');
      }
      module.HEAPF64.set(positions, coordinates / 8);
      module.HEAPF64.set(frame.cell.vectors, cellPointer / 8);
      module.HEAPF64.set(frame.cell.origin, cellPointer / 8 + 9);
      if (selection) module.HEAPU8.set(selection, maskPointer);
      const pbc = frame.cell.pbc.reduce((bits, enabled, axis) => bits | (enabled ? 1 << axis : 0), 0);
      hostTimings.inputMs = performance.now() - hostStarted;
      kernel.checkCancellation();
      report({ phase: 'analyzing', completedStages: 0 });
      const summaryPointer = module._alloy_surface_construct(coordinates, count, cellPointer, pbc, maskPointer,
        settings.radius, settings.smoothingLevel);
      if (!summaryPointer) throw nativeSurfaceError(module, kernel.canceled());
      kernel.checkCancellation();
      hostStarted = performance.now();
      report({ phase: 'collecting', completedStages: SURFACE_MESH_STAGES });
      // UTF8ToString refreshes the heap views after any pthread memory growth.
      const summary = JSON.parse(module.UTF8ToString(summaryPointer));
      const vertexCount = module._alloy_surface_vertex_count(), faceCount = module._alloy_surface_face_count();
      const regionCount = module._alloy_surface_region_count();
      const slice = (heap, pointer, length) => {
        const start = pointer / heap.BYTES_PER_ELEMENT;
        return heap.slice(start, start + length);
      };
      const raw = { ...summary,
        vertices: slice(module.HEAPF64, module._alloy_surface_vertices_ptr(), vertexCount * 3),
        vertexAtoms: slice(module.HEAPU32, module._alloy_surface_vertex_particles_ptr(), vertexCount),
        triangles: slice(module.HEAPU32, module._alloy_surface_faces_ptr(), faceCount * 3),
        faceRegions: slice(module.HEAP32, module._alloy_surface_face_regions_ptr(), faceCount * 2),
        regionData: slice(module.HEAPF64, module._alloy_surface_regions_ptr(), regionCount * 4) };
      const result = normalizeSurfaceMeshResult(raw, frame.cell, settings, count);
      hostTimings.collectMs = performance.now() - hostStarted;
      return { ...result, elapsedMs: performance.now() - startedAt, stageTimings, hostTimings, ...kernel.metadata(),
        workerCount, backend: 'cpu', engine: workerCount > 1 ? `Wasm CPU · ${workerCount} threads` : 'Wasm CPU' };
    } finally {
      module.onSurfaceProgress = previousProgress;
      module._alloy_surface_dispose();
      if (coordinates) module._free(coordinates);
      if (cellPointer) module._free(cellPointer);
      if (maskPointer) module._free(maskPointer);
    }
  });
}

/** Validate the kernel arrays and derive the fractions OVITO reports. Region
 * arrays are indexed by region: filled regions first, then empty ones. */
export function normalizeSurfaceMeshResult(raw, cell, parameters = {}, atomCount) {
  const settings = validateSurfaceMeshParameters(parameters);
  const { vertices, triangles, vertexAtoms, faceRegions, regionData } = raw ?? {};
  if (!(vertices instanceof Float64Array) || vertices.length % 3 || !(triangles instanceof Uint32Array) || triangles.length % 3
      || !(vertexAtoms instanceof Uint32Array) || vertexAtoms.length !== vertices.length / 3
      || !(faceRegions instanceof Int32Array) || faceRegions.length !== triangles.length / 3 * 2
      || !(regionData instanceof Float64Array) || regionData.length % 4) throw new Error('The surface kernel returned invalid mesh arrays.');
  const vertexCount = vertices.length / 3, faceCount = triangles.length / 3, regionCount = regionData.length / 4;
  if (raw.vertexCount !== vertexCount || raw.faceCount !== faceCount || raw.regionCount !== regionCount) throw new Error('The surface kernel returned an inconsistent mesh summary.');
  for (const vertex of triangles) if (vertex >= vertexCount) throw new Error('The surface kernel returned an invalid face.');
  for (const region of faceRegions) if (region < 0 || region >= regionCount) throw new Error('The surface kernel returned an invalid face region.');
  if (atomCount !== undefined) for (const atom of vertexAtoms) if (atom >= atomCount) throw new Error('The surface kernel returned an invalid vertex atom.');
  const regionVolumes = new Float64Array(regionCount), regionAreas = new Float64Array(regionCount);
  const regionFilled = new Uint8Array(regionCount), regionExterior = new Uint8Array(regionCount);
  for (let region = 0; region < regionCount; region += 1) {
    regionVolumes[region] = regionData[region * 4]; regionAreas[region] = regionData[region * 4 + 1];
    regionFilled[region] = regionData[region * 4 + 2] ? 1 : 0; regionExterior[region] = regionData[region * 4 + 3] ? 1 : 0;
  }
  for (const name of ['surfaceArea', 'filledVolume', 'emptyVolume', 'voidVolume', 'cellVolume']) {
    if (!Number.isFinite(raw[name]) || raw[name] < 0) throw new Error('The surface kernel returned an invalid measurement.');
  }
  // As upstream: fractions refer to the filled plus empty volume, which is the
  // cell volume when every filled tetrahedron lies inside the cell.
  const totalVolume = raw.filledVolume + raw.emptyVolume;
  const { regionData: omitted, ...summary } = raw;
  return { ...summary, vertices, triangles, vertexAtoms, faceRegions, regionVolumes, regionAreas, regionFilled, regionExterior,
    totalVolume, filledFraction: totalVolume ? raw.filledVolume / totalVolume : 0,
    emptyFraction: totalVolume ? raw.emptyVolume / totalVolume : 0, voidFraction: totalVolume ? raw.voidVolume / totalVolume : 0,
    specificSurfaceArea: totalVolume ? raw.surfaceArea / totalVolume : 0,
    parameters: settings,
    cell: { vectors: Float64Array.from(cell.vectors), origin: Float64Array.from(cell.origin), pbc: Array.from(cell.pbc, Boolean) } };
}

export function surfaceMeshTransferables(result) {
  return [...new Set([result.vertices, result.triangles, result.vertexAtoms, result.faceRegions, result.regionVolumes,
    result.regionAreas, result.regionFilled, result.regionExterior, result.cell?.vectors, result.cell?.origin]
    .filter(ArrayBuffer.isView).map(array => array.buffer))];
}

/** Regions as rows, for tables and exports. */
export function surfaceMeshRegions(result) {
  return Array.from(result.regionVolumes, (volume, id) => ({ id, volume, surfaceArea: result.regionAreas[id],
    filled: Boolean(result.regionFilled[id]), exterior: Boolean(result.regionExterior[id]),
    kind: result.regionFilled[id] ? 'filled' : result.regionExterior[id] ? 'exterior' : 'void' }));
}
