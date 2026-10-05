import { cartesianToFractional } from '../data/model.js';

const EPSILON = 1e-12;
const SUBDIVISIONS = 4;

const add = (a, b) => a.map((value, axis) => value + b[axis]);
const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
const scale = (a, amount) => a.map(value => value * amount);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);
const unit = (a, fallback = [0, 0, 1]) => length(a) > EPSILON ? scale(a, 1 / length(a)) : [...fallback];
const mix = (a, b, amount) => a.map((value, axis) => value + (b[axis] - value) * amount);

function initialNormal(tangent) {
  const axis = tangent.map(Math.abs).indexOf(Math.min(...tangent.map(Math.abs)));
  const reference = [0, 0, 0];
  reference[axis] = 1;
  return unit(cross(reference, tangent));
}

function perpendicular(normal, tangent) {
  return unit(subtract(normal, scale(tangent, dot(normal, tangent))), initialNormal(tangent));
}

function rotate(vector, axis, angle) {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return add(add(scale(vector, cosine), scale(cross(axis, vector), sine)), scale(axis, dot(axis, vector) * (1 - cosine)));
}

function transport(normal, previous, tangent) {
  const axis = cross(previous, tangent), sine = length(axis), cosine = Math.max(-1, Math.min(1, dot(previous, tangent)));
  // At an exact reversal a half-turn about the old normal preserves that
  // normal. It avoids an arbitrary reference-axis flip and remains finite.
  const moved = sine > EPSILON ? rotate(normal, scale(axis, 1 / sine), Math.atan2(sine, cosine)) : normal;
  return perpendicular(moved, tangent);
}

function closure(points, cell, requested, tolerance) {
  const displacement = subtract(points.at(-1), points[0]);
  if (requested === false) return { closed: false, winding: [0, 0, 0] };
  if (length(displacement) <= tolerance) {
    points[points.length - 1] = [...points[0]];
    return { closed: true, winding: [0, 0, 0] };
  }
  if (!requested) return { closed: false, winding: [0, 0, 0] };
  const fractions = cartesianToFractional([...points[0], ...points.at(-1)], cell, new Float64Array(6));
  const delta = [0, 1, 2].map(axis => fractions[axis + 3] - fractions[axis]);
  const fractionalTolerance = 1e-8;
  const periodic = delta.every((value, axis) => Math.abs(value - (cell.pbc[axis] ? Math.round(value) : 0)) <= fractionalTolerance);
  if (periodic) {
    const image = delta.map((value, axis) => cell.pbc[axis] ? Math.round(value) : 0);
    const winding = [0, 1, 2].map(axis => image[0] * cell.vectors[axis] + image[1] * cell.vectors[3 + axis] + image[2] * cell.vectors[6 + axis]);
    // Native smoothing can leave a tiny numerical endpoint residual. Its
    // closed flag is authoritative: snap only these copied display knots to
    // the nearest exact lattice translation, for finite and winding loops.
    points[points.length - 1] = add(points[0], winding);
    return { closed: true, winding };
  }
  // Be tolerant of callers supplying a finite closed loop without its repeated
  // endpoint. Native DXA already supplies that endpoint, including winding.
  points.push([...points[0]]);
  return { closed: true, winding: [0, 0, 0] };
}

function sampleCurve(points, closed, winding) {
  const last = points.length - 1;
  const tangents = points.map((point, index) => {
    const before = index ? points[index - 1] : closed ? subtract(points[Math.max(0, last - 1)], winding) : null;
    const after = index < last ? points[index + 1] : closed ? add(points[Math.min(1, last)], winding) : null;
    if (!before) return unit(subtract(after, point));
    if (!after) return unit(subtract(point, before));
    // The mean of the two unit chords restrains interpolation to the native
    // neighborhood, even with uneven sampling. Its magnitude falls at a bend.
    return scale(add(unit(subtract(point, before)), unit(subtract(after, point))), 0.5);
  });
  if (closed) tangents[last] = [...tangents[0]];
  const samples = [];
  for (let span = 0; span < last; span += 1) {
    const from = points[span], to = points[span + 1], chord = subtract(to, from), distance = length(chord);
    if (distance <= EPSILON) continue;
    const first = scale(tangents[span], distance), second = scale(tangents[span + 1], distance);
    const straight = length(subtract(tangents[span], unit(chord))) < 1e-8 && length(subtract(tangents[span + 1], unit(chord))) < 1e-8;
    const steps = straight ? 1 : SUBDIVISIONS;
    for (let step = 0; step <= steps; step += 1) {
      if (samples.length && !step) continue;
      const t = step / steps, t2 = t * t, t3 = t2 * t;
      const center = step === 0 ? [...from] : step === steps ? [...to]
        : add(add(from, scale(chord, -2 * t3 + 3 * t2)), add(scale(first, t3 - 2 * t2 + t), scale(second, t3 - t2)));
      const derivative = add(scale(chord, -6 * t2 + 6 * t), add(scale(first, 3 * t2 - 4 * t + 1), scale(second, 3 * t2 - 2 * t)));
      samples.push({ center, tangent: unit(derivative, unit(chord)) });
    }
  }
  if (samples.length < 2) return [];
  if (closed) samples.at(-1).tangent = [...samples[0].tangent];
  samples[0].normal = initialNormal(samples[0].tangent);
  const distances = [0];
  for (let index = 1; index < samples.length; index += 1) {
    samples[index].normal = transport(samples[index - 1].normal, samples[index - 1].tangent, samples[index].tangent);
    distances.push(distances.at(-1) + length(subtract(samples[index].center, samples[index - 1].center)));
  }
  if (closed) {
    const first = samples[0], end = samples.at(-1), total = distances.at(-1);
    const angle = Math.atan2(dot(first.tangent, cross(end.normal, first.normal)), dot(end.normal, first.normal));
    for (let index = 1; index < samples.length; index += 1) {
      samples[index].normal = perpendicular(rotate(samples[index].normal, samples[index].tangent, angle * distances[index] / total), samples[index].tangent);
    }
    end.normal = [...first.normal];
  }
  return samples;
}

function crossingSample(first, last, time) {
  if (!time) return first;
  if (time === 1) return last;
  const tangent = unit(mix(first.tangent, last.tangent, time), first.tangent);
  return { center: mix(first.center, last.center, time), tangent, normal: perpendicular(mix(first.normal, last.normal, time), tangent) };
}

function splitSamples(samples, cell, closed, tolerance) {
  if (!samples.length) return [];
  const fractional = cartesianToFractional(samples.flatMap(sample => sample.center), cell, new Float64Array(samples.length * 3));
  const pieces = [];
  let current = null, previousImage;
  const translated = (sample, image) => ({ ...sample, center: sample.center.map((value, axis) => value
    - image[0] * cell.vectors[axis] - image[1] * cell.vectors[3 + axis] - image[2] * cell.vectors[6 + axis]) });
  for (let point = 1; point < samples.length; point += 1) {
    const from = Array.from(fractional.subarray((point - 1) * 3, point * 3)), to = Array.from(fractional.subarray(point * 3, (point + 1) * 3));
    const times = [0, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      if (!cell.pbc[axis] || Math.abs(to[axis] - from[axis]) < EPSILON) continue;
      const minimum = Math.min(from[axis], to[axis]), maximum = Math.max(from[axis], to[axis]);
      if (maximum - minimum > 100_000) throw new Error('Dislocation line crosses too many periodic images to display.');
      for (let face = Math.floor(minimum) + 1; face < maximum; face += 1) {
        const time = (face - from[axis]) / (to[axis] - from[axis]);
        if (time > EPSILON && time < 1 - EPSILON) times.push(time);
      }
    }
    times.sort((a, b) => a - b);
    const unique = times.filter((time, index) => !index || time - times[index - 1] > EPSILON);
    // Compute a crossing's orthonormal frame once, before either translation.
    const rings = unique.map(time => crossingSample(samples[point - 1], samples[point], time));
    for (let interval = 1; interval < unique.length; interval += 1) {
      const middle = (unique[interval - 1] + unique[interval]) / 2;
      const image = from.map((value, axis) => cell.pbc[axis] ? Math.floor(value + (to[axis] - value) * middle) : 0);
      const first = translated(rings[interval - 1], image), last = translated(rings[interval], image);
      if (length(subtract(last.center, first.center)) <= tolerance) continue;
      if (!current || image.some((value, axis) => value !== previousImage[axis])) {
        current = { samples: [first], closed: false, capStart: !closed && point === 1 && interval === 1, capEnd: false };
        pieces.push(current);
      }
      current.samples.push(last);
      current.capEnd = !closed && point === samples.length - 1 && interval === unique.length - 1;
      previousImage = image;
    }
  }
  if (closed && pieces.length) {
    const first = pieces[0], last = pieces.at(-1);
    if (length(subtract(first.samples[0].center, last.samples.at(-1).center)) <= tolerance) {
      if (first === last) {
        first.seam = { start: first.samples[0], end: first.samples.at(-1) };
        first.samples.pop();
        first.closed = first.samples.length > 2;
      } else {
        last.samples.push(...first.samples.slice(1));
        pieces.shift();
      }
    }
  }
  return pieces;
}

/** Render-only interpolation and frames. Native XYZ coordinates and topology
 * remain untouched. Frames follow the unwrapped curve before periodic cuts.
 */
export function createDislocationCurve(points, cell, requestedClosed = null) {
  const extent = Math.max(1, ...Array.from(cell.vectors, Math.abs));
  const tolerance = extent * 1e-10;
  const knots = [];
  for (let index = 0; index < points.length; index += 3) {
    const point = Array.from(points.slice(index, index + 3));
    if (!knots.length || length(subtract(point, knots.at(-1))) > tolerance) knots.push(point);
  }
  if (knots.length < 2) return [];
  const { closed, winding } = closure(knots, cell, requestedClosed, tolerance);
  return splitSamples(sampleCurve(knots, closed, winding), cell, closed, tolerance);
}

/** Append a connected indexed surface. Radius is a draw-time uniform, so
 * changing line width, slices or display repetitions reuses these buffers.
 */
export function appendDislocationTube(values, indices, curve, color, radialSegments = 12) {
  const vertexStart = values.length / 12, indexStart = indices.length, rings = curve.samples.length;
  const vertex = (sample, radial, normal) => {
    const index = values.length / 12;
    values.push(...sample.center, ...radial, ...normal, ...color);
    return index;
  };
  const radial = (sample, side) => {
    const angle = side * Math.PI * 2 / radialSegments;
    return add(scale(sample.normal, Math.cos(angle)), scale(cross(sample.tangent, sample.normal), Math.sin(angle)));
  };
  for (const sample of curve.samples) {
    for (let side = 0; side < radialSegments; side += 1) {
      const offset = radial(sample, side);
      vertex(sample, offset, offset);
    }
  }
  for (let ring = 0; ring < (curve.closed ? rings : rings - 1); ring += 1) {
    const next = (ring + 1) % rings;
    for (let side = 0; side < radialSegments; side += 1) {
      const a = vertexStart + ring * radialSegments + side, b = vertexStart + ring * radialSegments + (side + 1) % radialSegments;
      const c = vertexStart + next * radialSegments + side, d = vertexStart + next * radialSegments + (side + 1) % radialSegments;
      indices.push(a, b, c, b, d, c);
    }
  }
  for (const [enabled, ring, sign] of [[curve.capStart, 0, -1], [curve.capEnd, rings - 1, 1]]) {
    if (!enabled) continue;
    const sample = curve.samples[ring], normal = scale(sample.tangent, sign), center = vertex(sample, [0, 0, 0], normal);
    const rim = Array.from({ length: radialSegments }, (_, side) => vertex(sample, radial(sample, side), normal));
    for (let side = 0; side < radialSegments; side += 1) {
      const first = rim[side], last = rim[(side + 1) % radialSegments];
      indices.push(center, sign > 0 ? first : last, sign > 0 ? last : first);
    }
  }
  return { closed: curve.closed, capStart: curve.capStart, capEnd: curve.capEnd, radialSegments, ringCount: rings,
    vertexStart, vertexCount: values.length / 12 - vertexStart, indexStart, indexCount: indices.length - indexStart,
    points: Float64Array.from(curve.samples.flatMap(sample => sample.center)),
    tangents: Float64Array.from(curve.samples.flatMap(sample => sample.tangent)),
    normals: Float64Array.from(curve.samples.flatMap(sample => sample.normal)), seam: curve.seam };
}
