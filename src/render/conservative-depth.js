// A compiler-tested GLSL feature: some WebGL implementations expose neither
// a JavaScript extension object nor the conservative-depth shader extension.
const capabilities = new WeakMap();
export function resetConservativeDepth(gl) { capabilities.delete(gl); }
const FRONT_DEPTH_GLSL = `
vec4 conservativeBillboardDepth(vec4 center, vec4 raster, float radius) {
  // Preserve original center-plane clipping. Only z changes: screen coverage
  // and perspective interpolation retain exactly the previous x/y/w.
  if (raster.w > 0.0 && raster.z >= -raster.w && raster.z <= raster.w) {
    float guardRadius = radius * 1.001 + abs(center.z) * 0.0000005;
    vec4 front = uProjection * (center + vec4(0.0, 0.0, guardRadius, 0.0));
    // The geometric margin alone is insufficient: lower*w followed by the
    // rasterizer's z/w can round upward by one ulp while fragment z/w rounds
    // downward. Reserve explicit NDC arithmetic slack, then clamp at near.
    float lower = front.w > 0.0 ? clamp(front.z / front.w - 0.000003814697265625, -1.0, 1.0) : -1.0;
    raster.z = min(raster.z / raster.w, lower) * raster.w;
  }
  return raster;
}
`;
export function conservativeSphereSources(vertex, fragment, radius = 'radius', { qualifier = true } = {}) {
  const assignment = /gl_Position = uProjection[^;]+;/;
  if (!assignment.test(vertex) || !fragment.includes('gl_FragDepth =')) throw new Error('Invalid sphere impostor shader.');
  const adjustedVertex = vertex.replace('void main() {', `${FRONT_DEPTH_GLSL}\nvoid main() {`)
    .replace(assignment, match => `${match}\n  gl_Position = conservativeBillboardDepth(centerView, gl_Position, ${radius});`);
  let adjustedFragment = fragment.replace(/gl_FragDepth = ([^;]+);/, 'gl_FragDepth = clamp($1, 0.0, 1.0);');
  if (qualifier) adjustedFragment = adjustedFragment.replace('#version 300 es', '#version 300 es\n#extension GL_EXT_conservative_depth : require')
    .replace('void main() {', 'layout(depth_greater) out highp float gl_FragDepth;\nvoid main() {');
  return { vertex: adjustedVertex, fragment: adjustedFragment };
}
function compileCandidate(gl, vertex, fragment) {
  const program = gl.createProgram(), shaders = [];
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type); shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Conservative depth is unsupported.');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Conservative depth linking failed.');
    return program;
  } catch (error) { gl.deleteProgram(program); throw error; }
  finally { for (const shader of shaders) gl.deleteShader(shader); }
}
export function createConservativeDepthProgram(gl, vertex, fragment, fallback, radius = 'radius') {
  const previous = capabilities.get(gl);
  if (previous?.supported !== false && typeof gl.getSupportedExtensions === 'function') {
    try {
      if (typeof gl.getShaderPrecisionFormat === 'function') {
        for (const type of [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER]) {
          const precision = gl.getShaderPrecisionFormat(type, gl.HIGH_FLOAT)?.precision;
          if (!(precision >= 23)) throw new Error('Conservative depth requires Float32 highp shader precision.');
        }
      }
      const sources = conservativeSphereSources(vertex, fragment, radius);
      const program = compileCandidate(gl, sources.vertex, sources.fragment);
      capabilities.set(gl, { supported: true });
      return { program, supported: true, sources };
    } catch (error) { capabilities.set(gl, { supported: false, reason: error.message }); }
  }
  return { program: fallback(gl, vertex, fragment), supported: false, reason: capabilities.get(gl)?.reason ?? 'Conservative depth unavailable.' };
}

const replicaOrders = new WeakMap();
const FLOAT32_ERROR = 32 * 2 ** -23;
// WebGL implementations provide at least 16 depth bits; exports use 24.
// The stricter bound also protects LEQUAL winners at quantized equal depths.
const DEPTH_SEPARATION = 2 / 65535;

function projectionDepth(projection, z) {
  const clipZ = projection[10] * z + projection[14];
  const clipW = projection[11] * z + projection[15];
  if (!(clipW > 0) || !Number.isFinite(clipZ)) return null;
  return { value: Math.min(1, Math.max(0, clipZ / clipW * .5 + .5)),
    error: FLOAT32_ERROR * (Math.abs(projection[10] * z) + Math.abs(projection[14])) / clipW };
}

/** Reorder only separated source-depth intervals, including Float32 encoding
 * and depth-buffer quantization. Overlaps retain the original LEQUAL winners,
 * edge coverage and replica-specific AO values. No atom arrays are sorted. */
export function orderedOpaqueReplicas(renderer) {
  const replicas = renderer.replicas ?? [], bounds = renderer.sourceBoundsCache, view = renderer.viewMatrix;
  const projection = renderer.projectionMatrix;
  let cached = replicaOrders.get(renderer);
  if (!cached || cached.replicas !== replicas || cached.original.length !== replicas.length
      || cached.original.some((row, ordinal) => row.replica !== replicas[ordinal])) {
    const original = replicas.map((replica, ordinal) => ({ replica, ordinal }));
    cached = { replicas, original, sorted: original.slice(), key: [] };
    replicaOrders.set(renderer, cached);
  }
  if (renderer.opaqueReplicaOrdering === false || renderer.crystalDrag || replicas.length < 2 || !bounds || !view || !projection) return cached.original;
  // Keys are bounded by the displayed copies, never by the number of atoms.
  // Scan mutable numeric inputs, but reuse the key and rows on repeated draws.
  let index = 0, changed = false;
  const note = value => { if (!Object.is(cached.key[index], value)) { cached.key[index] = value; changed = true; } index++; };
  note(renderer.maximumAtomRadius ?? .7); note(renderer.radiusScale ?? 1);
  for (let axis = 0; axis < 3; axis++) { note(bounds.minimum[axis]); note(bounds.maximum[axis]); note(view[axis * 4 + 2]); }
  note(view[14]);
  for (const axis of [10, 14, 11, 15]) note(projection[axis]);
  for (const replica of replicas) for (const offset of replica.offset) note(offset);
  if (!changed && cached.result) return cached.result;
  cached.key.length = index;
  const radius = (renderer.maximumAtomRadius ?? .7) * (renderer.radiusScale ?? 1);
  let minimum = view[14] - radius, maximum = view[14] + radius;
  let sourceMagnitude = Math.abs(view[14]);
  for (let axis = 0; axis < 3; axis++) {
    const coefficient = view[axis * 4 + 2], first = coefficient * bounds.minimum[axis], last = coefficient * bounds.maximum[axis];
    minimum += Math.min(first, last); maximum += Math.max(first, last);
    sourceMagnitude += Math.abs(coefficient) * Math.max(Math.abs(bounds.minimum[axis]), Math.abs(bounds.maximum[axis]));
  }
  if (!(Number.isFinite(minimum) && Number.isFinite(maximum))) return cached.result = cached.original;
  for (const row of cached.sorted) {
    let depth = 0, magnitude = sourceMagnitude;
    for (let axis = 0; axis < 3; axis++) {
      const term = row.replica.offset[axis] * view[axis * 4 + 2];
      depth += term; magnitude += Math.abs(term);
    }
    row.depth = depth;
    // Enclose position/offset Float32 conversion, world addition and view math
    // on drivers with either separate multiply/add or fused operations.
    row.error = magnitude * FLOAT32_ERROR + radius * .001;
  }
  cached.sorted.sort((a, b) => b.depth - a.depth || a.ordinal - b.ordinal);
  for (let item = 1; item < cached.sorted.length; item++) {
    const near = cached.sorted[item - 1], far = cached.sorted[item];
    const nearestFar = maximum + far.depth + far.error;
    const farthestNear = minimum + near.depth - near.error;
    if (!(farthestNear > nearestFar)) return cached.result = cached.original;
    const nearDepth = projectionDepth(projection, farthestNear), farDepth = projectionDepth(projection, nearestFar);
    if (!nearDepth || !farDepth || !(farDepth.value - nearDepth.value > DEPTH_SEPARATION + nearDepth.error + farDepth.error)) {
      return cached.result = cached.original;
    }
  }
  return cached.result = cached.sorted;
}
