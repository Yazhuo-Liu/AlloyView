import { CSP_F64_WGSL } from '../src/analysis/gpu/csp-f64.js';

/** Check the CSP integer binary64 implementation against JavaScript doubles
 * on the actual adapter, including rounding, cancellation and subnormals.
 */
export async function checkGpuF64(device) {
  const bytes = new DataView(new ArrayBuffer(8));
  const toBits = value => {
    bytes.setFloat64(0, value, true);
    return [bytes.getUint32(0, true), bytes.getUint32(4, true)];
  };
  const fromBits = (low, high) => {
    bytes.setUint32(0, low, true); bytes.setUint32(4, high, true);
    return bytes.getFloat64(0, true);
  };
  const floatBits = value => {
    bytes.setFloat32(0, value, true);
    return bytes.getUint32(0, true);
  };
  const edges = [0, -0, 1, -1, 1 + Number.EPSILON, 1 - Number.EPSILON / 2,
    2 ** 53, -(2 ** 53), 2 ** 53 - 1, 2 ** -53, 2 ** -54,
    Number.MIN_VALUE, -Number.MIN_VALUE, Number.MIN_VALUE * 3,
    2 ** -1022, -(2 ** -1022), 2 ** -1022 - Number.MIN_VALUE,
    2 ** -126, 2 ** -149, 2 ** -150, 3 * 2 ** -150,
    2 ** 127, 3e38, Number.MAX_VALUE, -Number.MAX_VALUE];
  const pairs = [];
  for (const a of edges) for (const b of edges) pairs.push([a, b]);
  let seed = 0x5c64a711;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed >>> 0;
  };
  const next = () => fromBits(random(), (random() & 0x800fffff) | ((random() % 2047) << 20));
  for (let index = 0; index < 8192; index++) {
    const a = next();
    const b = index % 3 ? next() : a * (1 + ((index % 5) - 2) * Number.EPSILON);
    if (Number.isFinite(b)) pairs.push([a, b]);
  }
  const input = new Uint32Array(pairs.length * 4);
  pairs.forEach(([a, b], index) => input.set([...toBits(a), ...toBits(b)], index * 4));
  const source = `${CSP_F64_WGSL}
    @group(0) @binding(0) var<storage, read> inputs: array<vec4u>;
    @group(0) @binding(1) var<storage, read_write> outputs: array<vec4u>;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
      if (id.x >= arrayLength(&inputs)) { return; }
      let a = inputs[id.x].xy; let b = inputs[id.x].zw;
      outputs[id.x * 3u] = vec4u(f64Add(a, b), f64Subtract(a, b));
      outputs[id.x * 3u + 1u] = vec4u(f64Multiply(a, b), bitcast<u32>(f64ToFloat(a)), select(0u, 1u, f64Less(a, b)));
      outputs[id.x * 3u + 2u] = vec4u(select(0u, 1u, f64Equal(a, b)), f64FromInt(bitcast<i32>(a.x)), 0u);
    }`;
  const module = device.createShaderModule({ code: source });
  const messages = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error');
  if (messages.length) throw new Error(`CSP binary64 validation shader: ${messages.map(message => message.message).join('; ')}`);
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const storage = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const outputSize = pairs.length * 12 * Uint32Array.BYTES_PER_ELEMENT;
  const output = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const staging = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    device.queue.writeBuffer(storage, 0, input);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: storage } }, { binding: 1, resource: { buffer: output } }] }));
    pass.dispatchWorkgroups(Math.ceil(pairs.length / 64)); pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, outputSize);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(staging.getMappedRange());
    const compare = (operation, index, offset, value) => {
      const expected = toBits(value);
      if (Number.isNaN(value)) {
        if (!Number.isNaN(fromBits(actual[offset], actual[offset + 1]))) throw new Error(`${operation} ${index}: expected NaN`);
      } else if (actual[offset] !== expected[0] || actual[offset + 1] !== expected[1]) {
        throw new Error(`${operation} ${index} (${pairs[index].join(', ')}): GPU ${fromBits(actual[offset], actual[offset + 1])}, CPU ${value}; words ${actual[offset].toString(16)} ${actual[offset + 1].toString(16)} / ${expected.map(word => word.toString(16)).join(' ')}`);
      }
    };
    for (let index = 0; index < pairs.length; index++) {
      const [a, b] = pairs[index], offset = index * 12;
      compare('add', index, offset, a + b);
      compare('subtract', index, offset + 2, a - b);
      compare('multiply', index, offset + 4, a * b);
      if (actual[offset + 6] !== floatBits(a)) throw new Error(`Float32 conversion ${index}: ${a}`);
      if (actual[offset + 7] !== Number(a < b)) throw new Error(`less ${index}: ${a}, ${b}`);
      if (actual[offset + 8] !== Number(a === b)) throw new Error(`equal ${index}: ${a}, ${b}`);
      compare('integer conversion', index, offset + 9, input[index * 4] | 0);
    }
    return { pairs: pairs.length, exactComparisons: pairs.length * 7 };
  } finally {
    if (staging.mapState === 'mapped') staging.unmap();
    storage.destroy(); output.destroy(); staging.destroy();
  }
}
