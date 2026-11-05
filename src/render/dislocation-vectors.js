import { cartesianToFractional, fractionalToCartesian } from '../data/model.js';
import { createPrimitiveMesh } from './atom-primitives.js';
import { createDislocationCurve } from './dislocation-curves.js';
import { translatePeriodicPoints } from './periodic-origin.js';
import { DISLOCATION_VECTOR_DEFAULTS, DISLOCATION_VECTOR_MINIMUM, DISLOCATION_VECTOR_MAXIMUM } from './dislocation-vector-style.js';

const EPSILON = 1e-12;
const add = (a, b) => a.map((value, axis) => value + b[axis]);
const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
const scale = (a, amount) => a.map(value => value * amount);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix = (a, b, t) => a.map((value, axis) => value + (b[axis] - value) * t);
const unit = a => { const length = Math.hypot(...a); return length > EPSILON ? scale(a, 1 / length) : [0, 0, 1]; };
const CYLINDER = createPrimitiveMesh(false, 10), CONE = createPrimitiveMesh(true, 10);

function wrappedPoint(point, cell, wrap) {
  if (!wrap) return [...point];
  const fractional = cartesianToFractional(point, cell, new Float64Array(3));
  for (let axis = 0; axis < 3; axis++) if (cell.pbc[axis]) fractional[axis] -= Math.floor(fractional[axis]);
  return Array.from(fractionalToCartesian(fractional, cell, new Float64Array(3)));
}

/** Split an already smoothed continuous polyline without losing its original
 * arc-length fraction. A PBC crossing has two displayed endpoints at the same
 * fraction, not a connector through the cell. */
function displayPaths(points, fractions, cell, wrap) {
  if (!wrap) return [{ points: Float64Array.from(points.flat()), fractions: Float64Array.from(fractions) }];
  const fractional = cartesianToFractional(points.flat(), cell, new Float64Array(points.length * 3));
  const paths = [];
  let current, previousImage;
  for (let index = 1; index < points.length; index++) {
    const from = Array.from(fractional.subarray((index - 1) * 3, index * 3));
    const to = Array.from(fractional.subarray(index * 3, (index + 1) * 3));
    const times = [0, 1];
    for (let axis = 0; axis < 3; axis++) {
      if (!cell.pbc[axis] || Math.abs(to[axis] - from[axis]) < EPSILON) continue;
      const minimum = Math.min(from[axis], to[axis]), maximum = Math.max(from[axis], to[axis]);
      if (maximum - minimum > 100_000) throw new Error('Dislocation line crosses too many periodic images to display.');
      for (let face = Math.floor(minimum) + 1; face < maximum; face++) {
        const t = (face - from[axis]) / (to[axis] - from[axis]);
        if (t > EPSILON && t < 1 - EPSILON) times.push(t);
      }
    }
    times.sort((a, b) => a - b);
    const unique = times.filter((value, offset) => !offset || value - times[offset - 1] > EPSILON);
    for (let interval = 1; interval < unique.length; interval++) {
      const first = unique[interval - 1], last = unique[interval], middle = (first + last) / 2;
      const image = from.map((value, axis) => cell.pbc[axis] ? Math.floor(value + (to[axis] - value) * middle) : 0);
      const offset = [0, 1, 2].map(axis => image[0] * cell.vectors[axis] + image[1] * cell.vectors[3 + axis] + image[2] * cell.vectors[6 + axis]);
      const project = t => subtract(mix(points[index - 1], points[index], t), offset);
      const fraction = t => fractions[index - 1] + (fractions[index] - fractions[index - 1]) * t;
      if (!current || image.some((value, axis) => value !== previousImage[axis])) {
        current = { points: [...project(first)], fractions: [fraction(first)] };
        paths.push(current);
      }
      current.points.push(...project(last)); current.fractions.push(fraction(last));
      previousImage = image;
    }
  }
  return paths.map(path => ({ points: Float64Array.from(path.points), fractions: Float64Array.from(path.fractions) }));
}

/** Cache this render-only representation for a network/display transform.
 * Annotation moves only resample it; they do not rebuild the scientific tubes. */
export function createDislocationVectorPaths(network, cell, options = {}, display = {}) {
  if (!Array.isArray(network?.segments)) throw new Error('Dislocation vectors require a segment list.');
  const selected = options.visibleFamilies == null ? null : new Set(options.visibleFamilies);
  const wrap = display.coordinateMode !== 'unwrapped', sources = [];
  for (const segment of network.segments) {
    const familyId = segment.familyId ?? segment.family ?? 'other';
    if ((selected && !selected.has(familyId)) || options.familyVisibility?.[familyId] === false) continue;
    const raw = Array.isArray(segment.points?.[0]) ? segment.points.flat() : segment.points;
    if (!raw || raw.length < 6 || raw.length % 3 || !Array.from(raw).every(Number.isFinite)) {
      throw new Error('Dislocation vectors require finite curve coordinates.');
    }
    const spatial = segment.spatialBurgersVector ?? [0, 0, 0];
    if (spatial.length !== 3 || !Array.from(spatial).every(Number.isFinite)) throw new Error('Dislocation Burgers vectors must be finite Cartesian vectors.');
    const translated = translatePeriodicPoints(raw, cell, display.periodicOrigin);
    const pieces = createDislocationCurve(translated, cell, segment.closed ?? null, { wrap: false });
    if (!pieces.length) continue;
    // No wrapping means a continuous source segment. Finite closed loops omit
    // the duplicated end ring; add it here for complete arc-length sampling.
    const piece = pieces[0], samples = [...piece.samples];
    if (piece.closed) samples.push(samples[0]);
    const points = samples.map(sample => [...sample.center]), tangents = samples.map(sample => [...sample.tangent]);
    const lengths = [0];
    for (let index = 1; index < points.length; index++) lengths.push(lengths.at(-1) + Math.hypot(...subtract(points[index], points[index - 1])));
    const length = lengths.at(-1);
    if (!(length > EPSILON)) continue;
    const fractions = lengths.map(value => value / length);
    sources.push({ segmentId: segment.id, familyId, points, tangents, fractions, length,
      closed: Boolean(segment.closed) || piece.closed, finiteLoop: Boolean(piece.closed), spatialBurgersVector: Array.from(spatial), wrap,
      paths: displayPaths(points, fractions, cell, wrap) });
  }
  return sources;
}

/** Interpolated point/tangent on exactly the smoothed path used by the tubes. */
export function sampleDislocationVectorPath(source, position) {
  if (!Number.isFinite(position) || position < 0 || position > 1) throw new Error('A dislocation arrow position must lie between zero and one.');
  let index = 1;
  while (index < source.fractions.length - 1 && source.fractions[index] < position) index++;
  const span = source.fractions[index] - source.fractions[index - 1];
  const amount = span > EPSILON ? (position - source.fractions[index - 1]) / span : 0;
  return { point: mix(source.points[index - 1], source.points[index], amount),
    tangent: unit(mix(source.tangents[index - 1], source.tangents[index], amount)) };
}

function appendShape(values, indices, shape, start, end, radius, color, bounds, anchor) {
  const delta = subtract(end, start), length = Math.hypot(...delta);
  if (!(length > EPSILON)) return;
  const direction = scale(delta, 1 / length), reference = Math.abs(direction[0]) < .8 ? [1, 0, 0] : [0, 1, 0];
  const across = unit(cross(direction, reference)), up = cross(direction, across);
  for (let index = 0; index < shape.length; index += 6) {
    const point = [0, 1, 2].map(axis => start[axis] + shape[index] * radius * across[axis]
      + shape[index + 1] * radius * up[axis] + shape[index + 2] * length * direction[axis]);
    const normal = unit([0, 1, 2].map(axis => shape[index + 3] / radius * across[axis]
      + shape[index + 4] / radius * up[axis] + shape[index + 5] / length * direction[axis]));
    indices.push(values.length / 12);
    // Crystal-drag clipping follows one anchor for the complete glyph, so an
    // arrow crossing a periodic face is never torn into separate images.
    values.push(...anchor, ...subtract(point, anchor), ...normal, ...color);
    for (let axis = 0; axis < 3; axis++) {
      bounds.minimum[axis] = Math.min(bounds.minimum[axis], point[axis]);
      bounds.maximum[axis] = Math.max(bounds.maximum[axis], point[axis]);
    }
  }
}

function appendArrow(values, indices, start, end, radius, color, bounds, anchor = start) {
  const delta = subtract(end, start), length = Math.hypot(...delta);
  if (!(length > EPSILON)) return;
  const headLength = Math.min(length * .42, radius * 2.5);
  const neck = add(end, scale(delta, -headLength / length));
  // Radius is the actual shaft radius, independent of the dislocation tube.
  // These proportions preserve the original glyph appearance at defaults.
  appendShape(values, indices, CYLINDER, start, neck, radius, color, bounds, anchor);
  appendShape(values, indices, CONE, neck, end, radius * (25 / 14), color, bounds, anchor);
}

/** One object/Burgers arrow per source segment, regardless of periodic cuts.
 * All fields are display data; flipping never mutates the scientific result. */
export function createDislocationVectorGeometry(sources, cell, options = {}) {
  const values = [], indices = [], objects = [];
  const bounds = { minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity] };
  const annotations = new Map((options.vectorAnnotations ?? []).map(value => [value.segmentId, value]));
  const style = {};
  for (const [name, fallback] of Object.entries(DISLOCATION_VECTOR_DEFAULTS)) {
    const value = Object.hasOwn(options, name) ? options[name] : fallback;
    if (!Number.isFinite(value) || value < DISLOCATION_VECTOR_MINIMUM || value > DISLOCATION_VECTOR_MAXIMUM) {
      throw new Error(`${name} must be between ${DISLOCATION_VECTOR_MINIMUM} and ${DISLOCATION_VECTOR_MAXIMUM}.`);
    }
    style[name] = value;
  }
  for (const source of sources) {
    const annotation = annotations.get(source.segmentId), position = annotation?.position ?? .5, sign = annotation?.flipped ? -1 : 1;
    const sample = sampleDislocationVectorPath(source, position), root = wrappedPoint(sample.point, cell, source.wrap);
    const tangent = scale(sample.tangent, sign), burgers = scale(source.spatialBurgersVector, sign);
    const burgersEnd = add(root, scale(burgers, style.burgersVectorScale));
    // Offset the direction arrow along the line so parallel screw arrows have
    // distinct heads. Keep its anchor on the source curve, including loops.
    const away = dot(sample.tangent, source.spatialBurgersVector) >= 0 ? -1 : 1;
    let linePosition = position + away * Math.min(.2, 4.5 / source.length);
    linePosition = source.closed ? (linePosition % 1 + 1) % 1 : Math.max(.05, Math.min(.95, linePosition));
    const lineSample = sampleDislocationVectorPath(source, linePosition), lineCenter = wrappedPoint(lineSample.point, cell, source.wrap);
    const lineTangent = scale(lineSample.tangent, sign), lineLength = Math.min(source.length * .3, 3.75) * style.lineDirectionScale;
    const lineStart = add(lineCenter, scale(lineTangent, -lineLength / 2));
    const lineEnd = add(lineCenter, scale(lineTangent, lineLength / 2));
    const selected = options.selectedVectorId === source.segmentId;
    const lineColor = selected ? [1, .85, .3] : [1, .68, .08];
    const burgersColor = selected ? [.55, 1, 1] : [.05, .9, 1];
    if (options.showLineDirections) appendArrow(values, indices, lineStart, lineEnd, style.lineDirectionRadius, lineColor, bounds, lineCenter);
    if (options.showBurgersVectors) appendArrow(values, indices, root, burgersEnd, style.burgersVectorRadius, burgersColor, bounds);
    objects.push({ segmentId: source.segmentId, familyId: source.familyId, position, flipped: sign < 0, root, tangent,
      burgers, burgersEnd, lineStart, lineEnd, paths: source.paths, selected });
  }
  return { objects, values: Float32Array.from(values), indices: Uint32Array.from(indices), indexCount: indices.length,
    vertexCount: values.length / 12, ...bounds };
}
