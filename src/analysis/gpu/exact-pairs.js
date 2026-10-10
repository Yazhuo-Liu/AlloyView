import { NEIGHBOR_RESIDUAL_WGSL } from './neighbors.js';
import { DOUBLE_SINGLE_WGSL } from './atomic-strain-shaders.js';
import { DOUBLE_DOUBLE_WGSL } from './voronoi-shaders.js';

const STORAGE = 128, COPY_SRC = 4, COPY_DST = 8, MAP_READ = 1;
export const EXACT_PAIR_TEST_ROWS = 32;
// Per axis: the high and low words of dsAdd, dsMultiply, ddAdd and ddMul.
// Each row then stores one vec3f deltaResidual.
const AXIS_WORDS = 8, ROW_WORDS = 3 * AXIS_WORDS + 3;

/** The shipped pair helpers applied to fixed operands. Low words are read
 * from the buffer, so the compiler sees the general pair arithmetic of the
 * analysis kernels, while their runtime zeros keep every result an exact
 * two-sum or two-product. */
export const EXACT_PAIR_TEST_SHADER = `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;
${NEIGHBOR_RESIDUAL_WGSL}${DOUBLE_SINGLE_WGSL}${DOUBLE_DOUBLE_WGSL}
@compute @workgroup_size(${EXACT_PAIR_TEST_ROWS})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let row = gid.x;
  if (row >= ${EXACT_PAIR_TEST_ROWS}u) { return; }
  let partner = (row + 1u) % ${EXACT_PAIR_TEST_ROWS}u;
  for (var axis = 0u; axis < 3u; axis += 1u) {
    let a = vec2f(positions[row * 2u][axis], positions[row * 2u + 1u][axis]);
    let b = vec2f(positions[partner * 2u][axis], positions[partner * 2u + 1u][axis]);
    let pairs = array<vec2f, 4>(dsAdd(a, b), dsMultiply(a, b), ddAdd(a, b), ddMul(a, b));
    for (var pair = 0u; pair < 4u; pair += 1u) {
      let offset = row * ${ROW_WORDS}u + axis * ${AXIS_WORDS}u + pair * 2u;
      results[offset] = pairs[pair].x; results[offset + 1u] = pairs[pair].y;
    }
  }
  let residual = deltaResidual(row, partner, fractionalHigh(row) - fractionalHigh(partner));
  for (var axis = 0u; axis < 3u; axis += 1u) { results[row * ${ROW_WORDS}u + ${3 * AXIS_WORDS}u + axis] = residual[axis]; }
}`;

/** Fixed Float32 operands with full 24-bit significands in six binades and
 * both signs, packed like a frame upload: high xyz, then a zero low word. */
export function exactPairTestVectors() {
  const positions = new Float32Array(EXACT_PAIR_TEST_ROWS * 8);
  let seed = 20261010;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let row = 0; row < EXACT_PAIR_TEST_ROWS; row += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const magnitude = (1 + random()) * 2 ** (Math.floor(random() * 6) - 3);
      positions[row * 8 + axis] = random() < .5 ? -magnitude : magnitude;
    }
  }
  return positions;
}

/** Correctly rounded results and their exact errors. Sums, differences and
 * products of these operands are exact in binary64, so each error is too. */
export function exactPairExpected(positions = exactPairTestVectors()) {
  const expected = new Float32Array(EXACT_PAIR_TEST_ROWS * ROW_WORDS);
  for (let row = 0; row < EXACT_PAIR_TEST_ROWS; row += 1) {
    const partner = (row + 1) % EXACT_PAIR_TEST_ROWS;
    for (let axis = 0; axis < 3; axis += 1) {
      const a = positions[row * 8 + axis], b = positions[partner * 8 + axis];
      const sum = Math.fround(a + b), product = Math.fround(a * b), difference = Math.fround(a - b);
      const words = [sum, a + b - sum, product, a * b - product];
      expected.set([...words, ...words], row * ROW_WORDS + axis * AXIS_WORDS);
      expected[row * ROW_WORDS + 3 * AXIS_WORDS + axis] = a - b - difference;
    }
  }
  return expected;
}

/** True when this device's shader compiler kept every error term bit for bit
 * (the sign of a zero is not compared). A shader that fails to compile or run
 * counts as a failed test. */
export async function verifyExactPairs(device) {
  const positions = exactPairTestVectors(), expected = exactPairExpected(positions), bytes = expected.byteLength;
  const buffers = [];
  const allocate = (size, usage) => { const buffer = device.createBuffer({ size, usage }); buffers.push(buffer); return buffer; };
  let actual = null;
  device.pushErrorScope('validation');
  try {
    const input = allocate(positions.byteLength, STORAGE | COPY_DST), output = allocate(bytes, STORAGE | COPY_SRC),
      staging = allocate(bytes, MAP_READ | COPY_DST);
    device.queue.writeBuffer(input, 0, positions.buffer, 0, positions.byteLength);
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto',
      compute: { module: device.createShaderModule({ code: EXACT_PAIR_TEST_SHADER }), entryPoint: 'main' } });
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
      entries: [input, output].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(MAP_READ, 0, bytes);
    actual = new Float32Array(staging.getMappedRange(0, bytes).slice(0));
    staging.unmap();
  } catch { actual = null; }
  const error = await device.popErrorScope().catch(() => true);
  for (const buffer of buffers) buffer.destroy();
  return !error && actual !== null && actual.every((value, index) => value === expected[index]);
}
