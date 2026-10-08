export const ORIENTATION_COLOR_MODES = Object.freeze(['builtin:ptm:ipf', 'builtin:ptm:quaternion']);
export const DEFAULT_ORIENTATION_SETTINGS = Object.freeze({ direction: 'z', custom: Object.freeze([0, 0, 1]) });
export const UNDEFINED_ORIENTATION_COLOR = Object.freeze([130, 130, 130]);
export const IPF_KEYS = Object.freeze({
  cubic: { title: 'Cubic · FCC / BCC', labels: ['[001]', '[101]', '[111]'] },
  hexagonal: { title: 'Hexagonal · HCP', labels: ['[0001]', '[10−10]', '[2−1−10]'] },
});

export function normalizeOrientationSettings(value = {}) {
  const direction = value.direction ?? 'z';
  if (!['x', 'y', 'z', 'custom'].includes(direction)) throw new Error('Choose an IPF sample direction: X, Y, Z or Custom.');
  // Check the length before copying: shared configuration JSON could supply
  // an array-like object such as { length: 4294967295 }.
  const source = value.custom ?? [0, 0, 1];
  const custom = source?.length === 3 ? Array.from(source) : [];
  if (custom.length !== 3 || !custom.every(component => typeof component === 'number' && Number.isFinite(component) && Math.abs(component) <= 1e15)
      || Math.hypot(...custom) < 1e-12) throw new Error('The IPF sample direction must have three finite components and a nonzero length.');
  return { direction, custom };
}

export function orientationSampleDirection(settings = DEFAULT_ORIENTATION_SETTINGS) {
  const normalized = normalizeOrientationSettings(settings);
  if (normalized.direction !== 'custom') return ['x', 'y', 'z'].map(axis => axis === normalized.direction ? 1 : 0);
  const length = Math.hypot(...normalized.custom);
  return normalized.custom.map(component => component / length);
}

/** PTM q=(w,x,y,z) actively rotates its ideal template into the sample frame.
 * See third_party/ptm/ptm_structure_matcher.cpp calc_rmsd: rot * ideal_points.
 * An inverse pole figure therefore uses R(q)^T times the sample direction. */
export function sampleToCrystalDirection(quaternion, sample) {
  if (quaternion?.length !== 4 || sample?.length !== 3 || !Array.from(sample).every(Number.isFinite)) return null;
  const length = Math.hypot(...quaternion);
  if (!Number.isFinite(length) || length < 1e-12) return null;
  const [w, x, y, z] = Array.from(quaternion, value => value / length);
  const [a, b, c] = sample;
  return [
    (1 - 2 * (y * y + z * z)) * a + 2 * (x * y + w * z) * b + 2 * (x * z - w * y) * c,
    2 * (x * y - w * z) * a + (1 - 2 * (x * x + z * z)) * b + 2 * (y * z + w * x) * c,
    2 * (x * z + w * y) * a + 2 * (y * z - w * x) * b + (1 - 2 * (x * x + y * y)) * c,
  ];
}

export function ipfWeights(direction, structure) {
  if (!direction?.every(Number.isFinite)) return null;
  const norm = Math.hypot(...direction);
  if (norm < 1e-12) return null;
  if (structure === 1 || structure === 3) {
    const [y, x, z] = direction.map(value => Math.abs(value) / norm).sort((a, b) => a - b);
    return [Math.max(0, z - x), Math.max(0, Math.SQRT2 * (x - y)), Math.sqrt(3) * y];
  }
  if (structure === 2) {
    const [x, y, z] = direction;
    const period = Math.PI / 3;
    const angle = ((Math.atan2(y, x) % period) + period) % period;
    const basal = Math.min(angle, period - angle) / (Math.PI / 6);
    const rho = Math.hypot(x, y) / norm;
    // PTM's basal x axis is a1 = [2−1−10]. The other corner, [10−10],
    // is at 30 degrees for a1=(1,0), a2=(-1/2,sqrt(3)/2), a3=-a1-a2.
    return [Math.abs(z) / norm, rho * basal, rho * (1 - basal)];
  }
  return null;
}

export function ipfColorFromWeights(weights) {
  if (!weights) return [...UNDEFINED_ORIENTATION_COLOR];
  const maximum = Math.max(...weights);
  if (!(maximum > 0)) return [...UNDEFINED_ORIENTATION_COLOR];
  return weights.map(value => Math.round(255 * Math.sqrt(Math.max(0, value) / maximum)));
}

export function ipfColor(quaternion, structure, sample = [0, 0, 1]) {
  return ipfColorFromWeights(ipfWeights(sampleToCrystalDirection(quaternion, sample), structure));
}

export function ptmOrientationSource(frame) {
  if (!frame?.ids) return null;
  const property = frame?.properties?.find(item => item.name === 'ptmStructureType');
  if (!property) {
    // Ideal-lattice strain retains its completed PTM fit without publishing
    // separate PTM scalar columns. Reuse that fit only while its strain
    // structure output is present; estimation-only caches do not count.
    const strain = frame?.properties?.find(item => item.name === 'idealStrainStructureType');
    return strain?.data === frame?.ptm?.structures && frame?.ptm?.structures?.length === frame.ids.length
      && frame.ptm.orientations?.length === frame.ids.length * 4
      ? { structures: frame.ptm.structures, orientations: frame.ptm.orientations } : null;
  }
  if (property.data?.length !== frame.ids.length) return null;
  if (frame.ptm?.orientations?.length === frame.ids.length * 4 && frame.ptm.structures === property.data) {
    return { structures: property.data, orientations: frame.ptm.orientations };
  }
  const components = ['W', 'X', 'Y', 'Z'].map(axis => frame.properties.find(item => item.name === `ptmOrientation${axis}`)?.data);
  if (!components.every(data => data?.length === frame.ids.length)) return null;
  return { structures: property.data, components };
}

/** Retain only the current color array. A render/export does not recompute it. */
export class OrientationColorResolver {
  clear() { this.current = null; }

  resolve(frame, mode, settings = DEFAULT_ORIENTATION_SETTINGS) {
    const source = ptmOrientationSource(frame);
    if (!source || !ORIENTATION_COLOR_MODES.includes(mode)) { this.clear(); return null; }
    const normalized = normalizeOrientationSettings(settings), sample = orientationSampleDirection(normalized);
    const key = mode === ORIENTATION_COLOR_MODES[0] ? `${normalized.direction}:${sample.join(',')}` : mode;
    const sources = [source.structures, source.orientations ?? null, ...(source.components ?? [])];
    if (this.current?.frame === frame && this.current.key === key && sources.every((value, index) => value === this.current.sources[index])) return this.current.palette;
    const colors = new Uint8Array(frame.ids.length * 3), quaternion = [0, 0, 0, 0];
    let undefinedCount = 0, cubic = 0, hexagonal = 0;
    for (let atom = 0; atom < frame.ids.length; atom++) {
      for (let axis = 0; axis < 4; axis++) quaternion[axis] = source.orientations?.[atom * 4 + axis] ?? source.components?.[axis][atom];
      const structure = source.structures[atom], crystal = sampleToCrystalDirection(quaternion, sample);
      let rgb;
      if (mode === ORIENTATION_COLOR_MODES[1] && crystal && (structure === 1 || structure === 2 || structure === 3)) {
        const norm = Math.hypot(...quaternion);
        // Quaternion sign is redundant. Canonicalize q and -q before mapping.
        const sign = quaternion.find(value => Math.abs(value) > 1e-12) < 0 ? -1 : 1;
        rgb = quaternion.slice(1).map(value => {
          const component = Math.abs(value / norm) < 1e-12 ? 0 : value * sign / norm;
          return Math.round(255 * Math.max(0, Math.min(1, .5 + .5 * component)));
        });
      } else if (crystal && (structure === 1 || structure === 3 || structure === 2)) {
        rgb = ipfColorFromWeights(ipfWeights(crystal, structure));
      } else { rgb = UNDEFINED_ORIENTATION_COLOR; undefinedCount++; }
      colors.set(rgb, atom * 3);
      if (structure === 1 || structure === 3) cubic++;
      if (structure === 2) hexagonal++;
    }
    const palette = { colors, legend: { kind: 'orientation', title: mode === ORIENTATION_COLOR_MODES[0]
      ? `PTM inverse pole figure · ${normalized.direction === 'custom' ? sample.map(value => Number(value.toPrecision(3))).join(', ') : normalized.direction.toUpperCase()}`
      : 'PTM quaternion RGB', mode: mode === ORIENTATION_COLOR_MODES[0] ? 'ipf' : 'quaternion',
      sample, undefinedCount, atomCount: frame.ids.length,
      keys: mode === ORIENTATION_COLOR_MODES[0] ? [ ...(cubic ? [{ ...IPF_KEYS.cubic, family: 'cubic' }] : []),
        ...(hexagonal ? [{ ...IPF_KEYS.hexagonal, family: 'hexagonal' }] : []) ] : [] } };
    this.current = { frame, key, sources, palette };
    return palette;
  }
}

/** Standard stereographic IPF sectors, including their curved boundary. Every
 * pixel maps back to a crystal direction and uses exactly the atom RGB rule. */
export function drawIpfKey(context, key, x, y, width, height, { color = '#355563', fontSize = 10 } = {}) {
  const cubic = key.family === 'cubic', uMax = cubic ? Math.SQRT2 - 1 : 1;
  const vMax = cubic ? 1 / (Math.sqrt(3) + 1) : .5;
  const factor = Math.min((width - 36) / uMax, (height - 36) / vMax);
  const span = uMax * factor, triangleHeight = vMax * factor;
  const left = x + (width - span) / 2, bottom = y + height - 18, top = bottom - triangleHeight;
  const transform = context.getTransform?.();
  const pixelScale = transform ? Math.max(1, Math.hypot(transform.a, transform.b)) : 1;
  const pixels = context.createImageData(Math.max(1, Math.round(span * pixelScale)), Math.max(1, Math.round(triangleHeight * pixelScale)));
  for (let row = 0; row < pixels.height; row++) for (let column = 0; column < pixels.width; column++) {
    const u = (column + .5) / pixels.width * uMax, v = (1 - (row + .5) / pixels.height) * vMax;
    const radius = u * u + v * v, denominator = 1 + radius;
    const crystal = [2 * u / denominator, 2 * v / denominator, (1 - radius) / denominator];
    const inSector = cubic ? crystal[1] <= crystal[0] && crystal[0] <= crystal[2]
      : radius <= 1 && v <= u / Math.sqrt(3);
    if (!inSector) continue;
    const rgb = ipfColorFromWeights(ipfWeights(crystal, cubic ? 1 : 2)), offset = (row * pixels.width + column) * 4;
    pixels.data.set([...rgb, 255], offset);
  }
  // A temporary canvas lets the identical helper work at export scale and in
  // the live key. putImageData would bypass the destination context transform.
  const canvas = context.canvas.ownerDocument?.createElement('canvas') ?? new OffscreenCanvas(pixels.width, pixels.height);
  canvas.width = pixels.width; canvas.height = pixels.height;
  canvas.getContext('2d').putImageData(pixels, 0, 0);
  context.drawImage(canvas, left, top, span, triangleHeight);
  const point = (u, v) => [left + u * factor, bottom - v * factor];
  const red = point(0, 0), green = cubic ? point(Math.SQRT2 - 1, 0) : point(Math.sqrt(3) / 2, .5);
  const blue = cubic ? point(vMax, vMax) : point(1, 0);
  context.beginPath(); context.moveTo(...red); context.lineTo(...(cubic ? green : blue));
  // Cubic boundary x=z, y from 0 to z; HCP boundary is the basal great circle.
  for (let step = 1; step <= 48; step++) {
    const parameter = step / 48;
    if (cubic) {
      const z = 1 / Math.sqrt(2 + parameter * parameter);
      context.lineTo(...point(z / (1 + z), parameter * z / (1 + z)));
    } else {
      const angle = parameter * Math.PI / 6; context.lineTo(...point(Math.cos(angle), Math.sin(angle)));
    }
  }
  context.lineTo(...red); context.closePath();
  context.strokeStyle = color; context.lineWidth = 1; context.stroke();
  context.fillStyle = color; context.font = `${fontSize}px system-ui, sans-serif`; context.textBaseline = 'alphabetic';
  context.textAlign = 'left'; context.fillText(key.labels[0], red[0] - 12, bottom + 14);
  context.textAlign = 'right';
  context.fillText(key.labels[1], green[0] + 12, cubic ? bottom + 14 : green[1] - 5);
  context.fillText(key.labels[2], blue[0] + 12, cubic ? blue[1] - 5 : bottom + 14);
  context.textAlign = 'left';
}
