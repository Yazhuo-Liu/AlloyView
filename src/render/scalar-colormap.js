// A drag changes only uniforms. Normalize the immutable f64 source once before
// uploading float32 scalars, so large offsets and tiny physical values retain
// useful precision. The exact CPU palette is restored when editing finishes.
export const MAX_COLOR_STOPS = 16;
export const SCALAR_COLOR_UNIFORMS = ['uScalarColorEnabled', 'uScalarRange', 'uScalarHideOutside', 'uColorStopCount', 'uColorStops[0]'];
export const SCALAR_COLOR_GLSL = `
uniform bool uScalarColorEnabled;
uniform vec2 uScalarRange;
uniform bool uScalarHideOutside;
uniform int uColorStopCount;
uniform vec4 uColorStops[${MAX_COLOR_STOPS}];
bool scalarShown(float value) {
  return !uScalarColorEnabled || !uScalarHideOutside
    || (!isnan(value) && !isinf(value) && value >= uScalarRange.x && value <= uScalarRange.y);
}
vec3 scalarColor(float value, bool overridden, vec3 exactColor) {
  if (!uScalarColorEnabled || overridden) return exactColor;
  if (isnan(value) || isinf(value)) return vec3(130.0 / 255.0);
  float amount = clamp((value - uScalarRange.x) / (uScalarRange.y - uScalarRange.x), 0.0, 1.0);
  vec4 left = uColorStops[0], right = left;
  for (int index = 1; index < ${MAX_COLOR_STOPS}; index++) {
    if (index >= uColorStopCount) break;
    right = uColorStops[index];
    if (right.x >= amount) break;
    left = right;
  }
  float fraction = right.x > left.x ? (amount - left.x) / (right.x - left.x) : 0.0;
  // Match palette.js's byte rounding rather than interpolating an unrelated LUT.
  return floor(mix(left.yzw, right.yzw, fraction) + 0.5) / 255.0;
}`;

export function prepareScalarColorData(data, { dataMinimum, dataMaximum, colorOverrides = null } = {}) {
  if (colorOverrides && colorOverrides.length !== data.length) throw new Error('Scalar color overrides must match the atom count.');
  let minimum = dataMinimum, maximum = dataMaximum;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    minimum = Infinity; maximum = -Infinity;
    for (const value of data) if (Number.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) minimum = maximum = 0;
  const difference = maximum - minimum;
  const origin = Number.isFinite(difference) && difference > 0 ? minimum : 0;
  const scale = Number.isFinite(difference) && difference > 0 ? difference : Math.max(Math.abs(minimum), Math.abs(maximum)) || 1;
  const normalize = value => Number.isFinite(value - origin) ? (value - origin) / scale : value / scale - origin / scale;
  const values = new Float32Array(data.length);
  let safe = true;
  for (let atom = 0; atom < values.length; atom++) {
    const value = data[atom], finite = Number.isFinite(value);
    values[atom] = finite ? normalize(value) : NaN;
    if (finite && !Number.isFinite(values[atom])) safe = false;
  }
  return { data, values, origin, scale, normalize, safe, colorOverrides: colorOverrides ?? new Uint8Array(data.length) };
}

export function scalarColorSettings(input, { minimum, maximum, colorStops, hideOutside = true, onCommit = null }) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !(maximum > minimum)) throw new Error('The scalar color maximum must be greater than its minimum.');
  if (!Array.isArray(colorStops) || colorStops.length < 2 || colorStops.length > MAX_COLOR_STOPS) throw new Error('Invalid scalar color stops.');
  const stops = new Float32Array(MAX_COLOR_STOPS * 4);
  colorStops.forEach((stop, index) => stops.set(stop, index * 4));
  const range = new Float32Array([input.normalize(minimum), input.normalize(maximum)]);
  // Extremely narrow limits within a wide source domain can collapse to the
  // same float32 value. Keep exact CPU drawing for these exceptional edits.
  const safe = input.safe && Number.isFinite(range[0]) && Number.isFinite(range[1])
    && range[1] > range[0] && Number.isFinite(maximum - minimum);
  return { input, minimum, maximum, colorStops, hideOutside, onCommit, stops, range, safe };
}

export function applyScalarColorUniforms(gl, uniforms, preview) {
  gl.uniform1i(uniforms.uScalarColorEnabled, preview ? 1 : 0);
  if (!preview) return;
  gl.uniform2fv(uniforms.uScalarRange, preview.range);
  gl.uniform1i(uniforms.uScalarHideOutside, preview.hideOutside ? 1 : 0);
  gl.uniform1i(uniforms.uColorStopCount, preview.colorStops.length);
  gl.uniform4fv(uniforms['uColorStops[0]'], preview.stops);
}

/** CPU picking uses exact f64 limits even during the temporary GPU preview. */
export function scalarPreviewAtomVisible(preview, atom) {
  if (!preview?.hideOutside) return true;
  const value = preview.input.data[atom];
  return Number.isFinite(value) && value >= preview.minimum && value <= preview.maximum;
}
