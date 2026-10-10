/** Test doubles for WebGPU: no shader executes, but queue order, buffer
 * contents written by the host, copies and mappings are reproduced. */
/** A queue-ordered fake device: writes, dispatches, clears and copies are
 * logged in submission order, and completion promises can be held. `execute`
 * may stand in for a shader: it receives each dispatch's bound buffers. */
export function fakeDevice({ holdCompletions = false, execute } = {}) {
  const log = [], completions = [];
  let maps = 0;
  const device = {
    limits: { maxBufferSize: 2 ** 28, maxStorageBufferBindingSize: 2 ** 28, maxComputeWorkgroupsPerDimension: 65_535,
      maxComputeInvocationsPerWorkgroup: 256 },
    queue: {
      writeBuffer(buffer, offset, data, dataOffset = 0, size = data.byteLength - dataOffset) {
        const bytes = new Uint8Array(data, dataOffset, size);
        buffer.data.set(bytes, offset);
        log.push({ type: 'write', buffer, offset, words: Array.from(new Uint32Array(bytes.slice().buffer)) });
      },
      submit(commands) {
        for (const { operations } of commands) for (const operation of operations) {
          if (operation.type === 'copy') operation.target.data.set(operation.source.data.subarray(operation.sourceOffset, operation.sourceOffset + operation.size), operation.targetOffset);
          if (operation.type === 'clear') operation.buffer.data.fill(0, operation.offset, operation.offset + (operation.size ?? operation.buffer.size));
          if (operation.type === 'dispatch') execute?.(operation.buffers);
          log.push(operation);
        }
      },
      onSubmittedWorkDone() {
        let resolve;
        const done = new Promise(value => { resolve = value; });
        completions.push(resolve);
        if (!holdCompletions) resolve();
        return done;
      },
    },
    createBuffer({ size, usage }) {
      return { size, usage, data: new Uint8Array(size), destroyed: false, destroy() { this.destroyed = true; },
        async mapAsync() { maps++; }, getMappedRange(offset = 0, length = size - offset) { return this.data.buffer.slice(offset, offset + length); },
        unmap() {} };
    },
    createCommandEncoder() {
      const operations = [];
      let buffers = [];
      return {
        beginComputePass: () => ({ setPipeline() {}, end() {},
          setBindGroup(_index, group) { buffers = (group?.entries ?? []).map(entry => entry.resource.buffer); },
          dispatchWorkgroups(workgroups) { operations.push({ type: 'dispatch', workgroups, buffers }); } }),
        copyBufferToBuffer(source, sourceOffset, target, targetOffset, size) { operations.push({ type: 'copy', source, sourceOffset, target, targetOffset, size }); },
        clearBuffer(buffer, offset = 0, size) { operations.push({ type: 'clear', buffer, offset, size }); },
        finish: () => ({ operations }),
      };
    },
    pushErrorScope() {}, async popErrorScope() { return null; },
    createShaderModule({ code }) { return { code }; }, createBindGroupLayout: options => options, createPipelineLayout: options => options,
    async createComputePipelineAsync() { return { getBindGroupLayout() { return {}; } }; },
    createBindGroup: options => options, destroy() {},
    lost: new Promise(() => {}), addEventListener() {},
  };
  return { device, log, completions, get maps() { return maps; } };
}


/** A `navigator.gpu` whose adapter returns `fakeDevice()`. */
export function fakeGpu({ info = { vendor: 'test', architecture: 'hardware' }, ...options } = {}) {
  const fake = fakeDevice(options);
  return { ...fake, gpu: { async requestAdapter() {
    return { info, limits: fake.device.limits, async requestDevice() { return fake.device; } };
  } } };
}
