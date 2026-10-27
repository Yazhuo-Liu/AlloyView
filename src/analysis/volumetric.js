import { validateVolumetricDataset, volumetricCellDimensions, volumetricGridPosition } from '../data/volumetric-grid.js';
import { runCooperativeSteps, runCooperativeStepsAsync } from '../shared/cooperative-steps.js';

export const MAX_VOLUMETRIC_TRIANGLES = 1_000_000;
export const VOLUMETRIC_TETRAHEDRA = Object.freeze([[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7],
  [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]].map(Object.freeze));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function validateVolumetricParameters(dataset, parameters = {}) {
  validateVolumetricDataset(dataset);
  const { kind = 'isosurface' } = parameters;
  if (!['isosurface', 'slice'].includes(kind)) throw new Error('Choose an isosurface or a volumetric slice.');
  if (kind === 'isosurface') {
    if (!Number.isFinite(parameters.level)) throw new Error('The isosurface level must be finite.');
    const maxTriangles = parameters.maxTriangles ?? MAX_VOLUMETRIC_TRIANGLES;
    if (!Number.isInteger(maxTriangles) || maxTriangles < 1 || maxTriangles > MAX_VOLUMETRIC_TRIANGLES) throw new Error('The isosurface triangle budget is invalid.');
    const cells = volumetricCellDimensions(dataset).reduce((a, b) => a * b, 1);
    const startCell = parameters.startCell ?? 0, endCell = parameters.endCell ?? cells;
    if (![startCell, endCell].every(Number.isInteger) || startCell < 0 || endCell < startCell || endCell > cells) throw new Error('The isosurface cell range is invalid.');
    return { ...parameters, kind, startCell, endCell, totalCells: cells, maxTriangles };
  }
  const axis = parameters.axis ?? 2, index = parameters.index ?? 0;
  if (!Number.isInteger(axis) || axis < 0 || axis > 2 || !Number.isFinite(index) || index < 0
      || index > (dataset.periodic[axis] ? dataset.dimensions[axis] : dataset.dimensions[axis] - 1)) {
    throw new Error('The slice needs an axis from 0 to 2 and an index within the sampled grid.');
  }
  return { ...parameters, kind, axis, index };
}

export function calculateIsosurface(dataset, parameters) { return runCooperativeSteps(isosurfaceSteps(dataset, parameters)); }
export function calculateIsosurfaceAsync(dataset, parameters, options) { return runCooperativeStepsAsync(isosurfaceSteps(dataset, parameters), options); }

/** Piecewise-linear marching tetrahedra. Every cube uses the same body
 * diagonal and face diagonals, including the final periodic voxel. Cases use
 * >= for the high-valued solid and normals point toward lower field values.
 * No copied Marching Cubes lookup tables or ambiguous face cases are used. */
export function* isosurfaceSteps(dataset, parameters = {}, { trusted = false } = {}) {
  const startedAt = performance.now(), options = validateVolumetricParameters(dataset, parameters);
  if (!trusted) yield* validateVolumeValuesSteps(dataset);
  const { level, startCell, endCell, maxTriangles } = options;
  const [nx, ny, nz] = dataset.dimensions, [cx, cy] = volumetricCellDimensions(dataset);
  const h = dataset.steps, o = dataset.origin, source = dataset.values;
  let vertices = new Float64Array(Math.min(maxTriangles, 512) * 9), triangleCount = 0, surfaceArea = 0;
  const values = new Float64Array(8), points = Array.from({ length: 8 }, () => [0, 0, 0]);
  const world = p => [o[0] + p[0] * h[0] + p[1] * h[3] + p[2] * h[6],
    o[1] + p[0] * h[1] + p[1] * h[4] + p[2] * h[7], o[2] + p[0] * h[2] + p[1] * h[5] + p[2] * h[8]];
  const vector = p => [p[0] * h[0] + p[1] * h[3] + p[2] * h[6],
    p[0] * h[1] + p[1] * h[4] + p[2] * h[7], p[0] * h[2] + p[1] * h[5] + p[2] * h[8]];
  function intersection(first, second) {
    // Shared edges must use identical arithmetic from both adjacent tetrahedra.
    // Reversing an edge computes t versus 1-t and can introduce tiny cracks.
    // Corner ordering is consistent across the monotone cube-face diagonals.
    if (first > second) [first, second] = [second, first];
    const a = values[first], b = values[second], denominator = b - a;
    const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(level));
    const fraction = Number.isFinite(denominator) ? (level - a) / denominator : (level / scale - a / scale) / (b / scale - a / scale);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error('The isosurface interpolation exceeds numerical precision.');
    return points[first].map((value, axis) => value + fraction * (points[second][axis] - value));
  }
  function append(first, second, third, towardLow) {
    // Use local displacements for orientation/area, not subtraction of large
    // absolute origins, so a translated grid retains its physical surface.
    const normal = cross(vector(subtract(second, first)), vector(subtract(third, first)));
    const twiceArea = Math.hypot(...normal);
    if (!Number.isFinite(twiceArea)) throw new Error('The isosurface area exceeds the numeric range.');
    if (twiceArea === 0) return;
    if (dot(normal, vector(towardLow)) < 0) [second, third] = [third, second];
    if (triangleCount === maxTriangles) throw new Error('The isosurface exceeds its triangle budget; choose a different level or a smaller grid.');
    if ((triangleCount + 1) * 9 > vertices.length) {
      const grown = new Float64Array(Math.min(maxTriangles, Math.ceil(vertices.length / 9 * 1.5)) * 9);
      grown.set(vertices); vertices = grown;
    }
    const coordinates = [...world(first), ...world(second), ...world(third)];
    if (coordinates.some(value => !Number.isFinite(value))) throw new Error('The isosurface coordinates exceed the numeric range.');
    vertices.set(coordinates, triangleCount * 9); triangleCount++; surfaceArea += twiceArea / 2;
    if (!Number.isFinite(surfaceArea)) throw new Error('The isosurface area exceeds the numeric range.');
  }
  for (let cell = startCell; cell < endCell; cell++) {
    if (((cell - startCell) & 255) === 0) {
      parameters.onProgress?.({ phase: 'analyzing', completedCells: cell - startCell, totalCells: endCell - startCell }); yield;
    }
    const x = cell % cx, y = Math.floor(cell / cx) % cy, z = Math.floor(cell / (cx * cy));
    for (let corner = 0; corner < 8; corner++) {
      const i = x + (corner & 1), j = y + (corner >> 1 & 1), k = z + (corner >> 2 & 1);
      points[corner][0] = i; points[corner][1] = j; points[corner][2] = k;
      values[corner] = source[(i % nx) + nx * ((j % ny) + ny * (k % nz))];
    }
    // Most voxels in a physical field do not intersect the requested level.
    // Reject those once instead of allocating six tetrahedron case lists.
    const firstHigh = values[0] >= level;
    let crosses = false;
    for (let corner = 1; corner < 8; corner++) if ((values[corner] >= level) !== firstHigh) { crosses = true; break; }
    if (!crosses) continue;
    for (const tetra of VOLUMETRIC_TETRAHEDRA) {
      const high = [], low = [];
      for (const index of tetra) (values[index] >= level ? high : low).push(index);
      if (!high.length || !low.length) continue;
      const direction = [0, 1, 2].map(axis => low.reduce((sum, index) => sum + points[index][axis] / low.length, 0)
        - high.reduce((sum, index) => sum + points[index][axis] / high.length, 0));
      if (high.length === 1) append(...low.map(index => intersection(high[0], index)), direction);
      else if (low.length === 1) append(...high.map(index => intersection(low[0], index)), direction);
      else {
        const a = intersection(high[0], low[0]), b = intersection(high[0], low[1]);
        const c = intersection(high[1], low[0]), d = intersection(high[1], low[1]);
        append(a, b, c, direction); append(b, d, c, direction);
      }
    }
  }
  vertices = vertices.slice(0, triangleCount * 9);
  const triangles = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < triangles.length; i++) { if ((i & 8191) === 0) yield; triangles[i] = i; }
  parameters.onProgress?.({ phase: 'complete', completedCells: endCell - startCell, totalCells: endCell - startCell });
  return { kind: 'isosurface', vertices, triangles, triangleCount, level, startCell, endCell,
    totalCells: options.totalCells, statistics: { surfaceArea }, backend: 'cpu', elapsedMs: performance.now() - startedAt };
}

export function* validateVolumeValuesSteps(dataset) {
  validateVolumetricDataset(dataset);
  for (let index = 0; index < dataset.values.length; index++) {
    if ((index & 8191) === 0) yield;
    if (!Number.isFinite(dataset.values[index])) throw new Error('Volumetric values must be finite.');
  }
}

export function calculateVolumeSlice(dataset, parameters) { return runCooperativeSteps(volumeSliceSteps(dataset, parameters)); }
export function calculateVolumeSliceAsync(dataset, parameters, options) { return runCooperativeStepsAsync(volumeSliceSteps(dataset, parameters), options); }

/** A plane through the grid, with linear interpolation only along its normal
 * coordinate. Its u/v axes follow the remaining two step vectors, retaining
 * tilted cell geometry rather than pretending these directions are Cartesian. */
export function* volumeSliceSteps(dataset, parameters = {}, { trusted = false } = {}) {
  const options = validateVolumetricParameters(dataset, { ...parameters, kind: 'slice' });
  if (!trusted) yield* validateVolumeValuesSteps(dataset);
  const { axis, index } = options, axes = [0, 1, 2].filter(value => value !== axis);
  const width = dataset.dimensions[axes[0]], height = dataset.dimensions[axes[1]], values = new Float64Array(width * height);
  const lower = Math.floor(index), fraction = index - lower;
  const coordinate = [0, 0, 0], position = [0, 0, 0]; position[axis] = index;
  const origin = volumetricGridPosition(dataset, ...position), steps = Float64Array.from(axes.flatMap(value => Array.from(dataset.steps.slice(value * 3, value * 3 + 3))));
  let min = Infinity, max = -Infinity, sum = 0, mean = 0, m2 = 0;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const i = column + width * row;
    if ((i & 4095) === 0) yield;
    coordinate[axes[0]] = column; coordinate[axes[1]] = row;
    const read = plane => {
      coordinate[axis] = plane % dataset.dimensions[axis];
      return dataset.values[coordinate[0] + dataset.dimensions[0] * (coordinate[1] + dataset.dimensions[1] * coordinate[2])];
    };
    const a = read(lower), value = fraction === 0 ? a : a * (1 - fraction) + read(lower + 1) * fraction;
    if (!Number.isFinite(value)) throw new Error('The volumetric slice exceeds the numeric range.');
    values[i] = value; min = Math.min(min, value); max = Math.max(max, value); sum += value;
    const delta = value - mean; mean += delta / (i + 1); m2 += delta * (value - mean);
  }
  const count = values.length;
  if (![sum, mean, m2].every(Number.isFinite)) throw new Error('The volumetric slice statistics exceed the numeric range.');
  return { kind: 'slice', values, width, height, axis, index, axes, origin, steps, unit: dataset.unit ?? '', name: dataset.name ?? '',
    periodic: axes.map(value => dataset.periodic[value]), backend: 'cpu',
    statistics: { count, min, max, sum, mean, standardDeviation: Math.sqrt(Math.max(0, m2 / count)) } };
}

export function* volumeSliceCsvSteps(result, { stem = 'volume' } = {}) {
  if (result?.kind !== 'slice' || !(result.values instanceof Float64Array) || !Number.isSafeInteger(result.width)
      || !Number.isSafeInteger(result.height) || result.width < 1 || result.height < 1 || result.values.length !== result.width * result.height
      || result.origin?.length !== 3 || result.steps?.length !== 6 || [...result.origin, ...result.steps].some(value => !Number.isFinite(value))) throw new Error('A completed volumetric slice is required for CSV export.');
  const parts = ['u_index,v_index,x_A,y_A,z_A,value,unit\r\n'];
  let bytes = parts[0].length;
  const encoder = new TextEncoder();
  const escapedUnit = `"${String(result.unit ?? '').replaceAll('"', '""')}"`;
  for (let start = 0; start < result.values.length; start += 2048) {
    yield;
    let text = '';
    for (let index = start; index < Math.min(start + 2048, result.values.length); index++) {
      const column = index % result.width, row = Math.floor(index / result.width);
      const point = [0, 1, 2].map(axis => result.origin[axis] + column * result.steps[axis] + row * result.steps[3 + axis]);
      if (point.some(value => !Number.isFinite(value)) || !Number.isFinite(result.values[index])) throw new Error('The volumetric slice CSV contains nonfinite coordinates or values.');
      text += [column, row, ...point, result.values[index], escapedUnit].join(',') + '\r\n';
    }
    bytes += encoder.encode(text).length;
    if (bytes > 256 * 1024 ** 2) throw new Error('The volumetric CSV exceeds the 256 MiB export budget.');
    parts.push(text);
  }
  const safe = String(stem).split(/[\\/]/).at(-1).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'volume';
  return { blob: new Blob(parts, { type: 'text/csv;charset=utf-8' }), filename: `${safe}-slice.csv` };
}

/** Per-triangle display packing stays in Workers. Source geometry remains
 * double precision, while WebGL receives only finite representable values. */
export function* prepareVolumetricRenderGeometrySteps(result, dataset) {
  const positions = new Float32Array(result.vertices.length), normals = new Float32Array(result.vertices.length);
  const bounds = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let triangle = 0; triangle < result.triangleCount; triangle++) {
    if ((triangle & 1023) === 0) yield;
    const offset = triangle * 9, a = result.vertices.subarray(offset, offset + 3), b = result.vertices.subarray(offset + 3, offset + 6), c = result.vertices.subarray(offset + 6, offset + 9);
    const normal = cross(subtract(b, a), subtract(c, a)), length = Math.hypot(...normal);
    if (!Number.isFinite(length)) throw new Error('The volumetric mesh normal exceeds the numeric range.');
    for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) {
      const source = result.vertices[offset + corner * 3 + axis], packed = Math.fround(source);
      if (!Number.isFinite(packed)) throw new Error('The volumetric mesh exceeds the Float32 rendering range.');
      positions[offset + corner * 3 + axis] = packed;
      normals[offset + corner * 3 + axis] = length ? normal[axis] / length : 0;
      bounds[axis] = Math.min(bounds[axis], source); bounds[axis + 3] = Math.max(bounds[axis + 3], source);
    }
  }
  if (!result.triangleCount) bounds.fill(0);
  result.renderGeometry = { positions, normals, bounds };
  result.grid = { origin: Array.from(dataset.origin), steps: Array.from(dataset.steps), dimensions: [...dataset.dimensions], periodic: [...dataset.periodic] };
  return result;
}
