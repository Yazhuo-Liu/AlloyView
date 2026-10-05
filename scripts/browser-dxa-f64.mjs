import assert from 'node:assert/strict';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// DXA's cutoffs are order-sensitive binary64 arithmetic. Compare real shader
// result bits against JavaScript's correctly rounded square root and division,
// across the complete exponent range rather than just ordinary atom distances.
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  const result = await evaluate(`(async () => {
    const { CSP_F64_WGSL } = await import('./src/analysis/gpu/csp-f64.js');
    const { DXA_F64_WGSL } = await import('./src/analysis/gpu/dxa-f64.js');
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const binary = new DataView(new ArrayBuffer(8));
    const words = value => { binary.setFloat64(0, value, true); return [binary.getUint32(0, true), binary.getUint32(4, true)]; };
    const number = (lo, hi) => { binary.setUint32(0, lo, true); binary.setUint32(4, hi, true); return binary.getFloat64(0, true); };
    let state = 0xd1a64a37;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    const adjacent = (value, direction) => {
      let [lo, hi] = words(value);
      if (direction > 0) { lo = (lo + 1) >>> 0; if (!lo) hi = (hi + 1) >>> 0; }
      else { if (!lo) hi = (hi - 1) >>> 0; lo = (lo - 1) >>> 0; }
      return number(lo, hi);
    };
    const rows = [];
    const add = (a, b, category) => rows.push({ a, b, category });
    const edges = [0, -0, Number.MIN_VALUE, -Number.MIN_VALUE,
      number(0xffffffff, 0x000fffff), number(0, 0x00100000), number(1, 0x00100000),
      1, -1, 2, 3, 12, 0.5, Number.MAX_VALUE, -Number.MAX_VALUE, Infinity, -Infinity, NaN,
      number(0x12345678, 0x7ff12345), number(0x23456789, 0xfff23456)];
    for (const a of edges) for (const b of edges) add(a, b, 'special');
    for (let i = 0; i < 6144; i++) {
      const hiA = random() & 0x7fffffff, hiB = random();
      add(number(random(), hiA), number(random(), hiB), 'random-binary64');
    }
    for (let i = 0; i < 2048; i++) {
      const exponent = (random() % 1001) - 500;
      const root = (1 + random() / 0x100000000) * 2 ** exponent;
      const square = root * root;
      add(square, 3, 'square');
      add(adjacent(square, 1), adjacent(root, 1), 'square-next');
      add(adjacent(square, -1), adjacent(root, -1), 'square-previous');
    }
    // Dense subnormal inputs, exponent extremes and midpoint-sensitive quotients.
    for (let i = 1; i <= 512; i++) {
      add(number(i, 0), number((i * 7919) >>> 0, 0), 'subnormal');
      add(number(random(), 0x00100000), number(random(), 0x7fd00000), 'underflow');
      add(number(random(), 0x7fe00000), number(random(), 0x00100000), 'overflow');
      add(number(random(), 0x3ff00000), number(random(), 0x3ff00000), 'rounding');
    }
    const input = new Uint32Array(rows.length * 4);
    for (let i = 0; i < rows.length; i++) { input.set(words(rows[i].a), 4 * i); input.set(words(rows[i].b), 4 * i + 2); }
    const source = CSP_F64_WGSL + DXA_F64_WGSL + '\\n' +
      '@group(0) @binding(0) var<storage, read> inputs: array<vec4u>;\\n' +
      '@group(0) @binding(1) var<storage, read_write> results: array<vec4u>;\\n' +
      '@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {\\n' +
      ' if (id.x >= arrayLength(&inputs)) { return; }\\n' +
      ' let row = inputs[id.x]; results[id.x] = vec4u(f64Sqrt(row.xy), f64Divide(row.xy, row.zw));\\n}';
    const module = device.createShaderModule({ code: source });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error(JSON.stringify(errors.map(message => ({ line: message.lineNum, message: message.message }))));
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const sourceBuffer = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const resultBuffer = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuffer = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    device.queue.writeBuffer(sourceBuffer, 0, input);
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: sourceBuffer } }, { binding: 1, resource: { buffer: resultBuffer } },
    ] });
    const started = performance.now(), encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(rows.length / 64)); pass.end();
    encoder.copyBufferToBuffer(resultBuffer, 0, readBuffer, 0, input.byteLength);
    device.queue.submit([encoder.finish()]); await readBuffer.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(readBuffer.getMappedRange().slice(0)), elapsedMs = performance.now() - started;
    const failures = [], categories = {};
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; categories[row.category] = (categories[row.category] ?? 0) + 1;
      for (const operation of ['sqrt', 'divide']) {
        const expected = operation === 'sqrt' ? Math.sqrt(row.a) : row.a / row.b;
        const offset = i * 4 + (operation === 'sqrt' ? 0 : 2), observed = number(actual[offset], actual[offset + 1]);
        const expectedWords = words(expected);
        if (Number.isNaN(expected) ? !Number.isNaN(observed)
          : actual[offset] !== expectedWords[0] || actual[offset + 1] !== expectedWords[1]) {
          if (failures.length < 16) failures.push({ operation, category: row.category, a: String(row.a), b: String(row.b),
            expected: String(expected), observed: String(observed), expectedWords, actualWords: [...actual.subarray(offset, offset + 2)] });
        }
      }
    }
    readBuffer.unmap(); sourceBuffer.destroy(); resultBuffer.destroy(); readBuffer.destroy(); device.destroy();
    return { rows: rows.length, comparisons: rows.length * 2, categories, elapsedMs, failures };
  })()`);
  assert.deepEqual(result.failures, [], 'DXA binary64 shader arithmetic must match native result bits.');
  return { adapter, ...result, scope: 'Real WebGPU exact binary64 square root and division; software timings are not hardware speed.' };
}, { software: useSoftwareAdapter(true) });
console.log(JSON.stringify(report, null, 2));
