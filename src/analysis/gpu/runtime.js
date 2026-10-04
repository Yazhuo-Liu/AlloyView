import { cellFaceHeights } from '../../data/model.js';
import { NEIGHBOR_BINDINGS_WGSL } from './neighbors.js';

const MAX_INPUT_BYTES = 256 * 1024 ** 2;
const CONFIG_BYTES = 128;
const STORAGE = 128, COPY_SRC = 4, COPY_DST = 8, UNIFORM = 64, MAP_READ = 1;

export class GpuUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'GpuUnavailableError'; }
}

export function checkSignal(signal) {
  if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
}

/** One device and queue shared by all GPU analyses in the dedicated worker. */
export class GpuRuntime {
  constructor({ environment = globalThis } = {}) {
    this.environment = environment;
    this.device = null;
    this.adapterInfo = null;
    this.pipelines = new Map();
    this.frames = new Map();
    this.indexes = new Map();
    this.configContexts = new WeakMap();
    this.initialization = null;
    this.lost = null;
    this.inputUploads = 0;
    this.bufferSizes = new WeakMap();
    this.allocatedBytes = 0;
  }

  async initialize(signal) {
    checkSignal(signal);
    if (this.lost) throw new GpuUnavailableError(this.lost);
    if (!this.initialization) this.initialization = this.initializeDevice();
    await this.initialization;
    checkSignal(signal);
    return this.device;
  }

  async initializeDevice() {
    const gpu = this.environment.navigator?.gpu;
    if (!gpu) throw new GpuUnavailableError('WebGPU is unavailable in this browser or context.');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new GpuUnavailableError('No WebGPU adapter is available.');
    this.adapterInfo = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: Boolean(adapter.info.isFallbackAdapter) } : {};
    this.device = await adapter.requestDevice({ requiredLimits: {
      maxStorageBuffersPerShaderStage: Math.min(10, adapter.limits.maxStorageBuffersPerShaderStage),
      maxStorageBufferBindingSize: Math.min(MAX_INPUT_BYTES, adapter.limits.maxStorageBufferBindingSize),
      maxBufferSize: Math.min(MAX_INPUT_BYTES, adapter.limits.maxBufferSize),
    } });
    this.device.lost.then((info) => { this.lost = `WebGPU device was lost${info.message ? `: ${info.message}` : '.'}`; });
    // Uncaptured errors must not become silent incorrect output. Every run
    // also uses error scopes, which provide the actual operation's rejection.
    this.device.addEventListener('uncapturederror', (event) => { this.lost = event.error?.message || 'A WebGPU device error occurred.'; });
  }

  createBuffer(bytes, usage = STORAGE | COPY_SRC | COPY_DST) {
    if (!this.device || this.lost) throw new GpuUnavailableError(this.lost || 'WebGPU is not initialized.');
    const size = Math.max(4, Math.ceil(bytes / 4) * 4);
    if (size > this.device.limits.maxBufferSize || ((usage & STORAGE) && size > this.device.limits.maxStorageBufferBindingSize)) {
      throw new GpuUnavailableError('This analysis exceeds the GPU buffer limits; using CPU workers.');
    }
    if (this.allocatedBytes + size > MAX_INPUT_BYTES) throw new GpuUnavailableError('This analysis exceeds the GPU memory budget; using CPU workers.');
    const buffer = this.device.createBuffer({ size, usage });
    this.bufferSizes.set(buffer, size); this.allocatedBytes += size;
    return buffer;
  }

  storageBuffer(values) {
    const buffer = this.createBuffer(values.byteLength);
    try { this.write(buffer, values); } catch (error) { this.disposeBuffers([buffer]); throw error; }
    return buffer;
  }

  write(buffer, values, byteOffset = 0) {
    this.device.queue.writeBuffer(buffer, byteOffset, values.buffer, values.byteOffset, values.byteLength);
  }

  zeroBuffer(buffer) {
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(buffer);
    this.device.queue.submit([encoder.finish()]);
  }

  async withErrors(callback) {
    this.device.pushErrorScope('out-of-memory');
    this.device.pushErrorScope('validation');
    let result, failure;
    try { result = await callback(); } catch (error) { failure = error; }
    const validation = await this.device.popErrorScope(), memory = await this.device.popErrorScope();
    if (failure) throw failure;
    if (validation || memory) throw new GpuUnavailableError((validation || memory).message || 'The GPU could not allocate or execute this analysis.');
    return result;
  }

  neighborBindings(context, extraBuffers = []) {
    return [context.configBuffer, context.positionsBuffer, context.headsBuffer, context.nextBuffer, context.typesBuffer, ...extraBuffers];
  }

  async prepareNeighbors(frame, cutoff, { signal } = {}) {
    await this.initialize(signal);
    checkSignal(signal);
    if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('The cutoff radius must be a finite value greater than zero.');
    const atomCount = frame.fractional.length / 3;
    if (!Number.isInteger(atomCount) || atomCount < 1) throw new Error('Analysis requires at least one atom.');
    const frameId = frame.gpuFrameId ?? frame;
    const frameKey = typeof frameId === 'number' ? frameId : frameId.gpuKey ?? (frameId.gpuKey = ++GpuRuntime.frameSerial);
    const key = `${frameKey}:${cutoff}`;
    if (this.indexes.has(key)) return this.indexes.get(key);
    const heights = Array.from(cellFaceHeights(frame.cell));
    const vectors = Array.from(frame.cell.vectors);
    if (vectors.some((value) => !Number.isFinite(value)) || heights.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new GpuUnavailableError('This cell geometry is unsuitable for GPU neighbor analysis.');
    }
    const imageBudget = heights.reduce((product, height, axis) => product * (frame.cell.pbc[axis] ? 2 * Math.ceil(cutoff / height) + 3 : 1), 1);
    if (imageBudget > 4096) throw new GpuUnavailableError('The periodic image search exceeds the GPU budget.');
    const cellScale = Math.max(...[0, 3, 6].map((offset) => Math.hypot(...vectors.slice(offset, offset + 3))));
    if (cellScale / cutoff > 1e6 || atomCount > 4_000_000) throw new GpuUnavailableError('This frame exceeds the GPU precision or memory budget.');
    if (!Number.isFinite(Math.fround(cutoff * cutoff)) || Math.fround(cutoff * cutoff) <= 0
        || [...vectors, ...heights].some((value) => !Number.isFinite(Math.fround(value)))
        || heights.some((value) => Math.fround(value) <= 0)) {
      throw new GpuUnavailableError('The cell or cutoff exceeds the GPU numeric range.');
    }
    const distanceTolerance = Math.max(1e-8, cutoff * cellScale * 32 * 2 ** -23 + cutoff * cutoff * 64 * 2 ** -23);
    const queryRadius = Math.sqrt(cutoff * cutoff + distanceTolerance);
    const dimensions = heights.map((height) => Math.max(1, Math.min(256, Math.floor(height / queryRadius))));
    const maximumBins = Math.min(2_000_000, atomCount * 4);
    while (dimensions.reduce((product, value) => product * value, 1) > maximumBins) {
      const axis = dimensions.indexOf(Math.max(...dimensions)); dimensions[axis] = Math.max(1, Math.floor(dimensions[axis] / 2));
    }
    const totalBins = dimensions.reduce((product, value) => product * value, 1);
    let uploaded;
    if (!this.frames.has(frameKey)) {
      uploaded = new Float32Array(atomCount * 8);
      for (let atom = 0; atom < atomCount; atom++) {
        for (let axis = 0; axis < 3; axis++) {
          let value = frame.fractional[atom * 3 + axis];
          if (!Number.isFinite(value)) throw new Error(`Atom ${atom + 1} has a non-finite fractional coordinate.`);
          if (frame.cell.pbc[axis]) value -= Math.floor(value);
          else if (value < 0 || value > 1) throw new GpuUnavailableError('GPU neighbor analysis currently requires nonperiodic coordinates inside the cell.');
          const high = Math.fround(value);
          uploaded[atom * 8 + axis] = high;
          uploaded[atom * 8 + 4 + axis] = value - high;
        }
        if (atom && atom % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
      }
    }
    const config = new ArrayBuffer(CONFIG_BYTES), ints = new Uint32Array(config), floats = new Float32Array(config);
    ints.set([atomCount, ...dimensions]);
    for (let axis = 0; axis < 3; axis++) {
      floats.set(vectors.slice(axis * 3, axis * 3 + 3), 4 + axis * 4);
      ints[16 + axis] = frame.cell.pbc[axis] ? 1 : 0;
      floats[20 + axis] = heights[axis];
    }
    floats[24] = cutoff * cutoff;
    floats[25] = distanceTolerance;
    ints[26] = 0; ints[27] = atomCount;
    const owned = [];
    const own = (buffer) => { owned.push(buffer); return buffer; };
    try {
      let frameBuffers = this.frames.get(frameKey);
      if (!frameBuffers) {
        const frameOwned = [];
        try {
          const positionsBuffer = this.storageBuffer(uploaded); frameOwned.push(positionsBuffer);
          const typesBuffer = this.storageBuffer(frame.types ? Uint32Array.from(frame.types) : new Uint32Array(atomCount)); frameOwned.push(typesBuffer);
          frameBuffers = { positionsBuffer, typesBuffer };
          this.frames.set(frameKey, frameBuffers);
          this.inputUploads++;
          this.trimFrames();
        } catch (error) { this.disposeBuffers(frameOwned); throw error; }
      }
      const context = { atomCount, dimensions, faceHeights: heights, cutoff, distanceTolerance: floats[25],
        frameKey, configBuffer: own(this.createBuffer(CONFIG_BYTES, UNIFORM | COPY_DST)), ...frameBuffers,
        headsBuffer: own(this.createBuffer(totalBins * 4)), nextBuffer: own(this.createBuffer(atomCount * 4)) };
      this.write(context.configBuffer, new Uint8Array(config));
      this.configContexts.set(context.configBuffer, context);
      // Clearing bins and indexing atoms are GPU operations; no JS linked-cell
      // construction or quadratic all-pairs upload is required.
      await this.run(`${NEIGHBOR_BINDINGS_WGSL}
@compute @workgroup_size(128) fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < config.dimX * config.dimY * config.dimZ) { atomicStore(&heads[gid.x], -1); }
}`, this.neighborBindings(context), totalBins, { signal, batchSize: 0, updateRange: false });
      const occupancyBuffer = own(this.createBuffer((totalBins + 1) * 4));
      const maximumOccupancy = Math.max(32, Math.floor(50_000 / 27 / imageBudget));
      await this.run(`${NEIGHBOR_BINDINGS_WGSL.replace('@group(0) @binding(3) var<storage, read>', '@group(0) @binding(3) var<storage, read_write>')}
@group(0) @binding(5) var<storage, read_write> occupancy: array<atomic<u32>>;
@compute @workgroup_size(128) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let atom = gid.x + config.startAtom; if (atom >= config.endAtom || atom >= config.count) { return; }
  let bin = flattenBin(positionBin(fractionalHigh(atom)));
  next[atom] = atomicExchange(&heads[bin], i32(atom));
  if (atomicAdd(&occupancy[bin + 1u], 1u) >= ${maximumOccupancy}u) { atomicStore(&occupancy[0], 1u); }
}`, this.neighborBindings(context, [occupancyBuffer]), atomCount, { signal });
      const occupied = await this.read(occupancyBuffer, Uint32Array, 1, { signal });
      this.disposeBuffers([occupancyBuffer]); owned.splice(owned.indexOf(occupancyBuffer), 1);
      if (occupied[0]) throw new GpuUnavailableError('The neighbor cells are too densely occupied for a bounded GPU dispatch.');
      while (this.indexes.size >= 2) { const [oldKey, old] = this.indexes.entries().next().value; this.disposeBuffers([old.configBuffer, old.headsBuffer, old.nextBuffer]); this.indexes.delete(oldKey); }
      this.indexes.set(key, context);
      return context;
    } catch (error) { this.disposeBuffers(owned); throw error; }
  }

  async run(source, bindings, invocations, { signal, startAtom = 0, endAtom = invocations, batchSize = 16_384, updateRange = true, onProgress } = {}) {
    await this.initialize(signal);
    const device = this.device;
    let pipeline = this.pipelines.get(source);
    if (!pipeline) {
      device.pushErrorScope('validation');
      try {
        const module = device.createShaderModule({ code: source });
        const layout = device.createBindGroupLayout({ entries: bindingDeclarations(source).map(({ binding, access }) => ({
          binding, visibility: 4, buffer: { type: access.includes('uniform') ? 'uniform' : access.includes('read_write') ? 'storage' : 'read-only-storage' },
        })) });
        pipeline = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: { module, entryPoint: 'main' } });
      } finally {
        const error = await device.popErrorScope(); if (error) throw new GpuUnavailableError(error.message);
      }
      if (this.pipelines.size > 32) this.pipelines.delete(this.pipelines.keys().next().value);
      this.pipelines.set(source, pipeline);
    }
    checkSignal(signal);
    const layout = pipeline.getBindGroupLayout(0);
    const entries = bindings.map((buffer, binding) => ({ binding, resource: { buffer } }));
    device.pushErrorScope('validation');
    try {
      const declaredBindings = new Set(bindingDeclarations(source).map(({ binding }) => binding));
      const bindGroup = device.createBindGroup({ layout, entries: entries.filter(({ binding }) => declaredBindings.has(binding)) });
      const context = updateRange ? this.configContexts.get(bindings[0]) : null;
      const size = batchSize || endAtom - startAtom;
      if (!context && batchSize && endAtom - startAtom > size) {
        // Standalone kernels own their indexing and run as a single dispatch.
        batchSize = 0;
      }
      const step = context ? Math.max(128, Math.ceil(size / 128) * 128) : endAtom - startAtom;
      for (let offset = startAtom; offset < endAtom; offset += step) {
        checkSignal(signal);
        const end = Math.min(endAtom, offset + step);
        if (context) this.write(bindings[0], new Uint32Array([offset, end]), 104);
        const workgroups = Math.ceil((end - offset) / 128);
        if (workgroups > device.limits.maxComputeWorkgroupsPerDimension) throw new GpuUnavailableError('The GPU dispatch exceeds device limits.');
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(workgroups); pass.end();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        checkSignal(signal);
        onProgress?.({ completedAtoms: end, totalAtoms: endAtom });
        if (end < endAtom) await yieldWorker();
      }
    } finally {
      const error = await device.popErrorScope(); if (error) throw new GpuUnavailableError(error.message);
    }
  }

  async read(buffer, Type, length, { signal } = {}) {
    checkSignal(signal);
    const bytes = length * Type.BYTES_PER_ELEMENT;
    const staging = this.createBuffer(bytes, MAP_READ | COPY_DST);
    try {
      const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(1, 0, bytes); checkSignal(signal);
      const values = new Type(staging.getMappedRange(0, bytes).slice(0)); staging.unmap();
      return values;
    } finally { this.disposeBuffers([staging]); }
  }

  trimFrames() {
    while (this.frames.size > 2) {
      const [oldKey, old] = this.frames.entries().next().value;
      for (const [indexKey, index] of this.indexes) if (index.frameKey === oldKey) {
        this.disposeBuffers([index.configBuffer, index.headsBuffer, index.nextBuffer]); this.indexes.delete(indexKey);
      }
      this.disposeBuffers([old.positionsBuffer, old.typesBuffer]); this.frames.delete(oldKey);
    }
  }

  disposeBuffers(buffers) {
    for (const buffer of buffers) if (buffer) {
      const size = this.bufferSizes.get(buffer);
      if (size !== undefined) { this.allocatedBytes -= size; this.bufferSizes.delete(buffer); }
      buffer.destroy();
    }
  }
  close() {
    for (const context of this.indexes.values()) this.disposeBuffers([context.configBuffer, context.headsBuffer, context.nextBuffer]);
    for (const frame of this.frames.values()) this.disposeBuffers([frame.positionsBuffer, frame.typesBuffer]);
    this.indexes.clear(); this.frames.clear(); this.device?.destroy();
  }
}
GpuRuntime.frameSerial = 0;

// Our generated shaders declare simple buffer bindings in group zero. An
// explicit layout also accepts resources referenced only by unused helpers.
function bindingDeclarations(source) {
  return [...source.matchAll(/@group\(0\)\s+@binding\((\d+)\)\s+var<([^>]+)>/g)]
    .map((match) => ({ binding: Number(match[1]), access: match[2] }));
}

export function yieldWorker() { return new Promise((resolve) => setTimeout(resolve, 0)); }
