import { cellFaceHeights } from '../../data/model.js';
import { NEIGHBOR_BINDINGS_WGSL } from './neighbors.js';
import { gpuPreparationKinds } from './preparation.js';
import { conservativeGpuBudget, DEFAULT_GPU_BUDGET_BYTES, frameUploadBytes, gpuWorkspaceBytes,
  trajectoryCapacity, frameEvictionOrder } from './cache-policy.js';
import { yieldToEventLoop as yieldWorker } from '../../task-yield.js';

const MAX_INPUT_BYTES = 256 * 1024 ** 2;
const CONFIG_BYTES = 128;
const STORAGE = 128, COPY_SRC = 4, COPY_DST = 8, UNIFORM = 64, MAP_READ = 1;
export const MAX_GPU_PERIODIC_RADIUS_FACES = 32;

const CLEAR_NEIGHBORS_SHADER = `${NEIGHBOR_BINDINGS_WGSL}
@compute @workgroup_size(128) fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < config.dimX * config.dimY * config.dimZ) { atomicStore(&heads[gid.x], -1); }
}`;
const INDEX_NEIGHBORS_SHADER = `${NEIGHBOR_BINDINGS_WGSL.replace('@group(0) @binding(3) var<storage, read>', '@group(0) @binding(3) var<storage, read_write>')}
@group(0) @binding(5) var<storage, read_write> occupancy: array<atomic<u32>>;
@compute @workgroup_size(128) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let atom = gid.x + config.startAtom; if (atom >= config.endAtom || atom >= config.count) { return; }
  let bin = flattenBin(positionBin(fractionalHigh(atom)));
  next[atom] = atomicExchange(&heads[bin], i32(atom));
  if (atomicAdd(&occupancy[bin + 1u], 1u) >= config.padding.x) { atomicStore(&occupancy[0], 1u); }
}`;

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
    this.pipelineCompilations = new Map();
    this.frames = new Map();
    this.indexes = new Map();
    this.configContexts = new WeakMap();
    this.initialization = null;
    this.lost = null;
    this.inputUploads = 0;
    this.bufferSizes = new WeakMap();
    this.allocatedBytes = 0;
    this.budgetBytes = DEFAULT_GPU_BUDGET_BYTES;
    this.explicitBudget = false;
    this.frameCount = 0;
    this.currentIndex = 0;
    this.frameBytes = 0;
    this.residentBytes = 0;
    this.protectedFrameKey = null;
    this.analysisFramePins = new Map();
    this.adaptiveCna = new Map();
    this.warmupPromise = null;
    this.memoryLimited = false;
    this.voronoiWorkspace = null;
    this.voronoiCpuContext = null;
    this.voronoiPreparations = new Map();
    this.neighborIndexBuildCount = this.voronoiKernelWarmupCount = 0;
  }

  async initialize(signal) {
    checkSignal(signal);
    if (this.lost) throw new GpuUnavailableError(this.lost);
    if (!this.initialization) this.initialization = this.initializeDevice();
    await waitForGpu(this.initialization, signal);
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
    if (!this.explicitBudget) this.budgetBytes = conservativeGpuBudget(adapter.limits, this.adapterInfo);
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

  async warmup({ signal, analysisKinds } = {}) {
    const kinds = gpuPreparationKinds(analysisKinds);
    await this.initialize(signal);
    if (kinds) {
      if (kinds.includes('voronoi')) {
        const voronoi = await waitForGpu(import('./voronoi-shaders.js'), signal);
        // compilePipeline shares native promises with general warmup and
        // foreground dispatches. A cancelled caller need not wait for the
        // driver to finish compilation before releasing the worker queue.
        checkSignal(signal);
        await waitForGpu(Promise.all([CLEAR_NEIGHBORS_SHADER, INDEX_NEIGHBORS_SHADER,
          voronoi.VORONOI_INITIALIZE_SHADER, voronoi.VORONOI_CLIP_SHADER].map(source => this.compilePipeline(source))), signal);
      }
      checkSignal(signal);
      return this.cacheStatus();
    }
    if (!this.warmupPromise) {
      this.warmupPromise = (async () => {
        const [{ COORDINATION_SHADER }, { RDF_SHADER }, shear, bonds, strain, cna, reference, csp, displacement, ptm, bondStatistics, voronoi] = await Promise.all([
          import('./coordination.js'), import('./rdf.js'), import('./local-shear-shaders.js'),
          import('./bonds-shaders.js'), import('./atomic-strain-shaders.js'),
          import('./cna-shaders.js'), import('./reference-strain-shaders.js'),
          import('./centrosymmetry-shaders.js'), import('./displacement-shaders.js'), import('./ptm-neighbors-shaders.js'),
          import('./bond-statistics-shaders.js'), import('./voronoi-shaders.js'),
        ]);
        const sources = [CLEAR_NEIGHBORS_SHADER, INDEX_NEIGHBORS_SHADER, COORDINATION_SHADER, RDF_SHADER,
          shear.makeShearCoordinationShader(), shear.makeShearMetricsShader(8), shear.makeShearMetricsShader(12),
          shear.SHEAR_CORRECTION_SHADER, shear.SHEAR_REDUCTION_SHADER, shear.SHEAR_FINALIZE_SHADER,
          bonds.BONDS_COUNT_SHADER, bonds.BONDS_WRITE_SHADER, strain.ATOMIC_STRAIN_SHADER,
          cna.CNA_FIXED_SHADER, cna.CNA_ADAPTIVE_SHADER,
          reference.REFERENCE_STRAIN_CLEAR_SHADER, reference.REFERENCE_STRAIN_SHADER,
          csp.CSP_SHADER, displacement.DISPLACEMENT_SHADER, ptm.PTM_NEIGHBORS_SHADER, bondStatistics.BOND_STATISTICS_SHADER,
          voronoi.VORONOI_INITIALIZE_SHADER, voronoi.VORONOI_CLIP_SHADER];
        for (const source of sources) await this.compilePipeline(source);
      })();
      this.warmupPromise.catch(() => { this.warmupPromise = null; });
    }
    await waitForGpu(this.warmupPromise, signal);
    checkSignal(signal);
    return this.cacheStatus();
  }

  configureCache({ frameCount = this.frameCount, currentIndex = this.currentIndex, budgetBytes } = {}) {
    if (!Number.isInteger(frameCount) || frameCount < 0) throw new Error('GPU frame count must be a nonnegative integer.');
    if (!Number.isInteger(currentIndex) || currentIndex < 0) throw new Error('GPU current frame must be a nonnegative integer.');
    if (budgetBytes !== undefined) {
      if (!Number.isFinite(budgetBytes) || budgetBytes < 4) throw new Error('GPU cache budget must be a positive byte count.');
      this.budgetBytes = Math.floor(budgetBytes); this.explicitBudget = true;
    }
    this.frameCount = frameCount; this.currentIndex = currentIndex;
    // Jobs are serialized by the GPU worker. A new current index ends the
    // preceding analysis's pin; the current trajectory frame remains pinned.
    this.protectedFrameKey = null;
    this.trimFrames();
    return this.cacheStatus();
  }

  cacheStatus() {
    const workspaceBytes = Math.max(gpuWorkspaceBytes(this.frameBytes), this.voronoiWorkspace?.bytes ?? 0);
    const capacity = trajectoryCapacity({ frameCount: this.frameCount, frameBytes: this.frameBytes,
      budgetBytes: this.budgetBytes, workspaceBytes });
    const cachedFrameIndexes = [...new Set([...this.frames.values()].map(frame => frame.frameIndex).filter(Number.isInteger))].sort((a, b) => a - b);
    const preparedVoronoi = [...this.voronoiPreparations].filter(([frameKey, prepared]) => this.frames.has(frameKey)
      && this.indexes.has(`${frameKey}:${prepared.radius}`) && this.voronoiWorkspace?.capacity >= prepared.capacity
      && prepared.sources.every(source => this.pipelines.has(source)));
    const preparedVoronoiFrameIndexes = [...new Set(preparedVoronoi.map(([frameKey]) => this.frames.get(frameKey).frameIndex)
      .filter(Number.isInteger))].sort((a,b) => a-b);
    return { initialized: Boolean(this.device && !this.lost), pipelineCount: this.pipelines.size, uploadCount: this.inputUploads,
      budgetBytes: this.budgetBytes, allocatedBytes: this.allocatedBytes, residentBytes: this.residentBytes, frameBytes: this.frameBytes,
      bufferLimitBytes: this.device ? Math.min(this.device.limits.maxBufferSize, this.device.limits.maxStorageBufferBindingSize) : 0,
      workspaceBytes, frameBudgetBytes: Math.max(0, this.budgetBytes - workspaceBytes), capacity,
      frameCount: this.frameCount, currentIndex: this.currentIndex,
      cachedFrameIds: [...this.frames.keys()], cachedFrameIndexes,
      fullTrajectory: this.frameCount > 0 && this.frameBytes > 0 && capacity >= this.frameCount,
      fullyCached: this.frameCount > 0 && cachedFrameIndexes.length === this.frameCount
        && cachedFrameIndexes[0] === 0 && cachedFrameIndexes.at(-1) === this.frameCount - 1,
      memoryLimited: this.memoryLimited, neighborIndexCount: this.indexes.size, neighborIndexBuildCount: this.neighborIndexBuildCount,
      voronoiWorkspaceAtoms: this.voronoiWorkspace?.capacity ?? 0, voronoiKernelWarmupCount: this.voronoiKernelWarmupCount,
      preparedVoronoiFrameIds: preparedVoronoi.map(([frameKey]) => frameKey), preparedVoronoiFrameIndexes };
  }

  frameKey(frame) {
    const frameId = frame.gpuFrameId ?? frame;
    return typeof frameId === 'number' ? frameId : frameId.gpuKey ?? (frameId.gpuKey = ++GpuRuntime.frameSerial);
  }

  async uploadFrame(frame, { signal, frameIndex } = {}) {
    await this.initialize(signal);
    checkSignal(signal);
    if (frameIndex !== undefined && (!Number.isInteger(frameIndex) || frameIndex < 0)) throw new Error('GPU frame index must be a nonnegative integer.');
    const frameKey = this.frameKey(frame), existing = this.frames.get(frameKey);
    if (existing?.positionsBuffer && existing?.typesBuffer) {
      if (frameIndex !== undefined) existing.frameIndex = frameIndex;
      return { frameKey, ...this.cacheStatus() };
    }
    if (existing) this.protectedFrameKey = frameKey;
    const atomCount = frame.fractional.length / 3;
    if (!Number.isInteger(atomCount) || atomCount < 1) throw new Error('Analysis requires at least one atom.');
    if (atomCount > 4_000_000) throw new GpuUnavailableError('This frame exceeds the GPU precision or memory budget.');
    const limits = this.device?.limits;
    const bufferLimit = limits ? Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize) : Infinity;
    if (atomCount * 32 > bufferLimit || atomCount * 4 > bufferLimit) {
      throw new GpuUnavailableError('This analysis exceeds the GPU buffer limits; using CPU workers.');
    }
    const bytes = frameUploadBytes(frame) - (existing?.typesBuffer ? atomCount * 4 : 0);
    const prospectiveLargestBytes = Math.max(this.frameBytes, (existing?.bytes ?? 0) + bytes);
    if (bytes + gpuWorkspaceBytes(prospectiveLargestBytes) > this.budgetBytes) {
      throw new GpuUnavailableError('The current frame exceeds the GPU cache budget; using CPU workers.');
    }
    const uploaded = new Float32Array(atomCount * 8);
    for (let atom = 0; atom < atomCount; atom++) {
      for (let axis = 0; axis < 3; axis++) {
        let value = frame.fractional[atom * 3 + axis];
        if (!Number.isFinite(value)) throw new Error(`Atom ${atom + 1} has a non-finite fractional coordinate.`);
        if (frame.cell.pbc[axis]) value -= Math.floor(value);
        else if (value < 0 || value > 1) throw new GpuUnavailableError('GPU neighbor analysis currently requires nonperiodic coordinates inside the cell.');
        const high = Math.fround(value);
        uploaded[atom * 8 + axis] = high; uploaded[atom * 8 + 4 + axis] = value - high;
      }
      if (atom && atom % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
    }
    if (frame.types && (frame.types.length !== atomCount || frame.types.some(type => !Number.isInteger(type) || type < 0 || type > 0xffff_ffff))) {
      throw new GpuUnavailableError('The frame element types cannot be represented exactly on this GPU backend.');
    }
    this.frameBytes = prospectiveLargestBytes;
    const types = frame.types ? Uint32Array.from(frame.types) : new Uint32Array(atomCount);
    for (let attempt = 0; ; attempt++) {
      this.trimFrames({ incomingBytes: bytes });
      if (this.residentBytes + bytes > this.cacheStatus().frameBudgetBytes) {
        throw new GpuUnavailableError('The current frame exceeds the GPU cache budget; using CPU workers.');
      }
      const owned = [];
      try {
        const buffers = await this.withErrors(async () => {
          const positionsBuffer = this.storageBuffer(uploaded); owned.push(positionsBuffer);
          const typesBuffer = existing?.typesBuffer ?? this.storageBuffer(types);
          if (!existing?.typesBuffer) owned.push(typesBuffer);
          await this.device.queue.onSubmittedWorkDone?.();
          checkSignal(signal);
          return { positionsBuffer, typesBuffer, frameIndex, bytes };
        });
        this.frames.set(frameKey, { ...existing, ...buffers, typesSource: frame.types, frameIndex: frameIndex ?? existing?.frameIndex,
          bytes: (existing?.bytes ?? 0) + bytes }); this.residentBytes += bytes; this.inputUploads++;
        return { frameKey, ...this.cacheStatus() };
      } catch (error) {
        this.disposeBuffers(owned);
        if (!isGpuOutOfMemory(error) || attempt >= 1) throw error;
        this.shrinkBudget(bytes);
        checkSignal(signal);
      }
    }
  }

  async prepareFrame(frame, options = {}) {
    const kinds = gpuPreparationKinds(options.analysisKinds);
    if (kinds?.includes('voronoi')) {
      const { prepareGpuVoronoiFrame } = await waitForGpu(import('./voronoi.js'), options.signal);
      return prepareGpuVoronoiFrame(this, frame, { selectedTypes: options.selectedTypes }, options);
    }
    return this.uploadFrame(frame, options);
  }

  /** Resident inputs also serve atomwise kernels which need no neighbor grid. */
  async prepareFrameBuffers(frame, options) {
    await this.uploadFrame(frame, options);
    return this.frames.get(this.frameKey(frame));
  }

  /** Immutable raw PTM fits survive edited reference lattices. Their buffers
   * belong to the source frame, so eviction and source barriers free them.
   * Cached fits need element IDs, but no periodic-neighbor geometry.
   */
  getPtmBuffers(frame, ptmInput) {
    const resident = this.frames.get(this.frameKey(frame)), cached = resident?.ptm;
    if (!cached) return undefined;
    if (ptmInput && (cached.structures !== ptmInput.structures || cached.scales !== ptmInput.scales
      || cached.deformation !== ptmInput.deformation || cached.types !== frame.types
      || cached.revision !== ptmInput.revision || cached.fitId !== ptmInput.gpuFitId)) return undefined;
    return { ...cached, typesBuffer: resident.typesBuffer, reused: true };
  }

  clearPtmBuffers(frame, fitId) {
    const resident = this.frames.get(this.frameKey(frame)), cached = resident?.ptm;
    if (!cached || (fitId !== undefined && cached.fitId !== fitId)) return;
    this.disposeBuffers([cached.metadataBuffer, cached.scalesBuffer, cached.deformationBuffer]);
    resident.bytes -= cached.bytes; this.residentBytes -= cached.bytes;
    delete resident.ptm;
  }

  async preparePtmBuffers(frame, ptmInput, prepare, options = {}) {
    if (typeof prepare !== 'function') { options = prepare ?? {}; prepare = options.prepare; }
    const { signal, frameIndex = frame.gpuFrameIndex } = options;
    await this.initialize(signal); checkSignal(signal);
    const frameKey = this.frameKey(frame);
    this.protectedFrameKey = frameKey;
    const reused = this.getPtmBuffers(frame, ptmInput);
    if (reused) return reused;
    if (typeof prepare !== 'function') throw new Error('A GPU PTM input encoder is required.');
    if (frameIndex !== undefined && (!Number.isInteger(frameIndex) || frameIndex < 0)) throw new Error('GPU frame index must be nonnegative.');
    const count = frame.fractional.length / 3, existing = this.frames.get(frameKey), previous = existing?.ptm;
    if (!Number.isInteger(count) || count < 1 || count > 4_000_000) throw new GpuUnavailableError('The PTM fit exceeds the GPU atom budget.');
    const bufferLimit = Math.min(this.device.limits.maxBufferSize, this.device.limits.maxStorageBufferBindingSize);
    if (count * 72 > bufferLimit) throw new GpuUnavailableError('The PTM fit exceeds the GPU buffer limits.');
    const replaceTypes = !existing?.typesBuffer || existing.typesSource !== frame.types;
    const bytes = count * 88, typesBytes = existing?.typesBuffer ? 0 : count * 4;
    const deltaBytes = bytes - (previous?.bytes ?? 0) + typesBytes;
    const prospectiveLargestBytes = Math.max(this.frameBytes, (existing?.bytes ?? 0) + deltaBytes);
    if ((existing?.bytes ?? 0) + deltaBytes + gpuWorkspaceBytes(prospectiveLargestBytes) > this.budgetBytes) {
      throw new GpuUnavailableError('The PTM fit exceeds the GPU cache budget.');
    }
    const input = await prepare(frame, ptmInput, { signal });
    checkSignal(signal);
    this.frameBytes = prospectiveLargestBytes;
    for (let attempt = 0; ; attempt += 1) {
      this.trimFrames({ incomingBytes: deltaBytes });
      if (this.residentBytes + deltaBytes > this.cacheStatus().frameBudgetBytes) throw new GpuUnavailableError('The PTM fit exceeds the GPU cache budget.');
      const owned = [];
      try {
        const buffers = await this.withErrors(async () => {
          const own = buffer => { owned.push(buffer); return buffer; };
          const typesBuffer = replaceTypes ? own(this.storageBuffer(input.types)) : existing.typesBuffer;
          const metadataBuffer = own(this.storageBuffer(input.metadata));
          const scalesBuffer = own(this.storageBuffer(input.scales));
          const deformationBuffer = own(this.storageBuffer(input.deformation));
          await this.device.queue.onSubmittedWorkDone?.(); checkSignal(signal);
          return { typesBuffer, metadataBuffer, scalesBuffer, deformationBuffer };
        });
        const ptm = { ...buffers, structures: ptmInput.structures, scales: ptmInput.scales, deformation: ptmInput.deformation,
          types: frame.types, revision: ptmInput.revision, fitId: ptmInput.gpuFitId, bytes, atomCount: count };
        this.frames.set(frameKey, { ...existing, typesBuffer: buffers.typesBuffer, typesSource: frame.types, ptm,
          frameIndex: frameIndex ?? existing?.frameIndex, bytes: (existing?.bytes ?? 0) + deltaBytes });
        this.disposeBuffers([previous?.metadataBuffer, previous?.scalesBuffer, previous?.deformationBuffer]);
        if (replaceTypes && existing?.typesBuffer) {
          this.disposeBuffers([existing.typesBuffer]);
          for (const [key, index] of this.indexes) if (index.frameKey === frameKey) {
            this.disposeBuffers([index.configBuffer, index.headsBuffer, index.nextBuffer]); this.indexes.delete(key);
          }
        }
        this.residentBytes += deltaBytes; this.inputUploads += 1;
        return { ...ptm, reused: false };
      } catch (error) {
        this.disposeBuffers(owned);
        if (!isGpuOutOfMemory(error) || attempt >= 1) throw error;
        this.shrinkBudget(deltaBytes); checkSignal(signal);
      }
    }
  }

  /** Cartesian positions retain source origins, open boundaries and unwrapped
   * image motion. Each variant is independent of neighbor fractional buffers.
   */
  async prepareCartesianFrame(frame, positions, { signal, frameIndex, variant = 'cartesian' } = {}) {
    await this.initialize(signal); checkSignal(signal);
    if (!['cartesian', 'unwrapped-cartesian'].includes(variant)) throw new Error('Unknown GPU Cartesian coordinate variant.');
    if (frameIndex !== undefined && (!Number.isInteger(frameIndex) || frameIndex < 0)) throw new Error('GPU frame index must be a nonnegative integer.');
    const frameKey = this.frameKey(frame), existing = this.frames.get(frameKey);
    this.protectedFrameKey = frameKey;
    const cached = existing?.cartesian?.get(variant);
    if (cached?.source === positions) {
      if (frameIndex !== undefined) existing.frameIndex = frameIndex;
      return { positionsBuffer: cached.positionsBuffer, atomCount: cached.atomCount, anchor: cached.anchor };
    }
    const atomCount = frame.fractional.length / 3;
    if (!Number.isInteger(atomCount) || atomCount < 1 || !ArrayBuffer.isView(positions) || positions instanceof DataView || positions.length !== atomCount * 3) {
      throw new Error('GPU displacement requires complete typed Cartesian coordinates.');
    }
    if (atomCount > 4_000_000) throw new GpuUnavailableError('This frame exceeds the GPU precision or memory budget.');
    const bytes = atomCount * 32, deltaBytes = cached ? 0 : bytes;
    const bufferLimit = Math.min(this.device.limits.maxBufferSize, this.device.limits.maxStorageBufferBindingSize);
    if (bytes > bufferLimit) throw new GpuUnavailableError('This analysis exceeds the GPU buffer limits; using CPU workers.');
    const prospectiveLargestBytes = Math.max(this.frameBytes, (existing?.bytes ?? 0) + deltaBytes);
    if ((existing?.bytes ?? 0) + deltaBytes + gpuWorkspaceBytes(prospectiveLargestBytes) > this.budgetBytes) {
      throw new GpuUnavailableError('The current frame exceeds the GPU cache budget; using CPU workers.');
    }
    const packed = new Float32Array(atomCount * 8);
    const anchor = Float64Array.from([0, 1, 2], axis => Number.isFinite(frame.cell?.origin?.[axis]) ? frame.cell.origin[axis] : 0);
    for (let atom = 0; atom < atomCount; atom++) {
      if ([0, 1, 2].every(axis => Number.isFinite(positions[atom * 3 + axis]))) {
        anchor.set(positions.subarray(atom * 3, atom * 3 + 3)); break;
      }
    }
    for (let atom = 0; atom < atomCount; atom++) {
      let encodingError = 0;
      for (let axis = 0; axis < 3; axis++) {
        const source = positions[atom * 3 + axis];
        const value = source - anchor[axis], high = Math.fround(value), low = Math.fround(value - high);
        if (!Number.isFinite(value)) throw new GpuUnavailableError('Nonfinite Cartesian source coordinates require CPU displacement matching.');
        if (!Number.isFinite(high) || !Number.isFinite(low) || (value !== 0 && Math.abs(high) < 1e-30)) {
          throw new GpuUnavailableError('The Cartesian coordinates exceed the GPU numeric range.');
        }
        packed[atom * 8 + axis] = high; packed[atom * 8 + 4 + axis] = low;
        const recoveredAnchor = source - value;
        const subtractionError = (source - (value + recoveredAnchor)) + (recoveredAnchor - anchor[axis]);
        encodingError = Math.max(encodingError, Math.abs(value - (high + low)) + Math.abs(subtractionError));
      }
      packed[atom * 8 + 3] = Math.fround(encodingError * 1.000001);
      if (atom && atom % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
    }
    this.frameBytes = prospectiveLargestBytes;
    for (let attempt = 0; ; attempt++) {
      this.trimFrames({ incomingBytes: deltaBytes });
      if (this.residentBytes + deltaBytes > this.cacheStatus().frameBudgetBytes) {
        throw new GpuUnavailableError('The current frame exceeds the GPU cache budget; using CPU workers.');
      }
      let positionsBuffer;
      try {
        await this.withErrors(async () => {
          positionsBuffer = this.storageBuffer(packed);
          await this.device.queue.onSubmittedWorkDone?.(); checkSignal(signal);
        });
        const cartesian = existing?.cartesian ?? new Map();
        cartesian.set(variant, { positionsBuffer, atomCount, source: positions, anchor });
        this.frames.set(frameKey, { ...existing, cartesian, frameIndex: frameIndex ?? existing?.frameIndex,
          bytes: (existing?.bytes ?? 0) + deltaBytes });
        this.disposeBuffers([cached?.positionsBuffer]);
        this.residentBytes += deltaBytes; this.inputUploads++;
        return { positionsBuffer, atomCount, anchor };
      } catch (error) {
        this.disposeBuffers([positionsBuffer]);
        if (!isGpuOutOfMemory(error) || attempt >= 1) throw error;
        this.shrinkBudget(deltaBytes); checkSignal(signal);
      }
    }
  }

  getAdaptiveCna(frame) { return this.adaptiveCna.get(this.frameKey(frame)); }
  cacheAdaptiveCna(frame, structures) {
    const key = this.frameKey(frame), count = frame.fractional.length / 3;
    if (!this.frames.has(key) || !(structures instanceof Uint8Array) || structures.length !== count) return false;
    this.adaptiveCna.set(key, structures.slice());
    return true;
  }

  shrinkBudget(incomingBytes = 0) {
    const workspaceBytes = gpuWorkspaceBytes(this.frameBytes);
    const protectedKeys = this.protectedKeys();
    const protectedBytes = [...this.frames].filter(([key, frame]) => protectedKeys.has(key) || frame.frameIndex === this.currentIndex)
      .reduce((total, [, frame]) => total + frame.bytes, 0);
    const lowerBound = workspaceBytes + Math.max(this.frameBytes, protectedBytes + incomingBytes);
    this.budgetBytes = Math.min(this.budgetBytes, Math.max(lowerBound,
      Math.min(Math.floor(this.budgetBytes * 0.75), workspaceBytes + this.residentBytes + incomingBytes - this.frameBytes)));
    this.memoryLimited = true;
    this.trimFrames({ incomingBytes });
  }

  recoverMemory(error) {
    if (!isGpuOutOfMemory(error) || this.lost) return false;
    // Computation may need more workspace than the estimate on a particular
    // adapter. Release indexes and speculative trajectory inputs, then let
    // the worker retry the complete analysis once with its active frame.
    this.clearIndexes();
    this.shrinkBudget();
    for (const key of frameEvictionOrder(this.frames, this.currentIndex, this.protectedKeys())) this.evictFrame(key);
    return true;
  }

  finishAnalysis() { this.protectedFrameKey = null; this.trimFrames(); }

  /** Reference analyses bind two frames at once. Nested kernel/worker scopes
   * keep both uploads resident without changing the displayed trajectory index.
   */
  pinFrames(frames) {
    const keys = new Set(frames.filter(Boolean).map((frame) => this.frameKey(frame)));
    for (const key of keys) this.analysisFramePins.set(key, (this.analysisFramePins.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const count = this.analysisFramePins.get(key) ?? 0;
        if (count > 1) this.analysisFramePins.set(key, count - 1);
        else this.analysisFramePins.delete(key);
      }
    };
  }

  createBuffer(bytes, usage = STORAGE | COPY_SRC | COPY_DST) {
    if (!this.device || this.lost) throw new GpuUnavailableError(this.lost || 'WebGPU is not initialized.');
    const size = Math.max(4, Math.ceil(bytes / 4) * 4);
    if (size > this.device.limits.maxBufferSize || ((usage & STORAGE) && size > this.device.limits.maxStorageBufferBindingSize)) {
      throw new GpuUnavailableError('This analysis exceeds the GPU buffer limits; using CPU workers.');
    }
    if (this.allocatedBytes + size > this.budgetBytes) {
      for (const key of frameEvictionOrder(this.frames, this.currentIndex, this.protectedKeys())) {
        this.evictFrame(key);
        if (this.allocatedBytes + size <= this.budgetBytes) break;
      }
      if (this.allocatedBytes + size > this.budgetBytes) throw new GpuUnavailableError('This analysis exceeds the GPU memory budget; using CPU workers.');
    }
    const buffer = this.device.createBuffer({ size, usage });
    this.bufferSizes.set(buffer, size); this.allocatedBytes += size;
    return buffer;
  }

  /** Reserve a complete temporary job before any of its buffers are allocated.
   * The displayed frame and active analyses keep their existing cache pins.
   */
  reserveWorkspace(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.budgetBytes) {
      throw new GpuUnavailableError('The analysis workspace exceeds the GPU memory budget; using CPU workers.');
    }
    if (this.allocatedBytes + bytes > this.budgetBytes) {
      for (const key of frameEvictionOrder(this.frames, this.currentIndex, this.protectedKeys())) {
        this.evictFrame(key);
        if (this.allocatedBytes + bytes <= this.budgetBytes) break;
      }
      if (this.allocatedBytes + bytes > this.budgetBytes) {
        throw new GpuUnavailableError('The analysis workspace exceeds the available GPU memory budget; using CPU workers.');
      }
    }
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
    // Lightweight tests can use a buffer-only fake device. Real WebGPU always
    // supplies scopes, so allocation failures are captured before residency.
    if (!this.device?.pushErrorScope) return callback();
    this.device.pushErrorScope('out-of-memory');
    this.device.pushErrorScope('validation');
    let result, failure;
    try { result = await callback(); } catch (error) { failure = error; }
    const validation = await this.device.popErrorScope(), memory = await this.device.popErrorScope();
    if (failure) {
      if (memory && failure.name !== 'AbortError') failure.gpuOutOfMemory = true;
      throw failure;
    }
    if (validation || memory) {
      // An allocation OOM can also make a later write validate against an
      // invalid buffer. Retain the original allocation cause for recovery.
      const error = new GpuUnavailableError((memory || validation).message || 'The GPU could not allocate or execute this analysis.');
      error.gpuOutOfMemory = Boolean(memory);
      throw error;
    }
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
    const frameKey = this.frameKey(frame);
    this.protectedFrameKey = frameKey;
    const key = `${frameKey}:${cutoff}`;
    const cached = this.indexes.get(key);
    if (cached) {
      // Keep recently used radii; eviction removes the least recently used.
      this.indexes.delete(key); this.indexes.set(key, cached);
      return cached;
    }
    const heights = Array.from(cellFaceHeights(frame.cell));
    const vectors = Array.from(frame.cell.vectors);
    if (vectors.some((value) => !Number.isFinite(value)) || heights.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new GpuUnavailableError('This cell geometry is unsuitable for GPU neighbor analysis.');
    }
    let imageBudget = heights.reduce((product, height, axis) => product * (frame.cell.pbc[axis] ? 2 * Math.ceil(cutoff / height) + 3 : 1), 1);
    if (imageBudget > 4096) throw new GpuUnavailableError('The periodic image search exceeds the GPU budget.');
    // Extremely long image translations amplify the shared f32 cell-matrix
    // error beyond its distance tolerance. Open axes enumerate no images.
    if (heights.some((height, axis) => frame.cell.pbc[axis] && cutoff / height > MAX_GPU_PERIODIC_RADIUS_FACES)) {
      throw new GpuUnavailableError('The periodic image geometry exceeds the GPU distance precision budget.');
    }
    const cellScale = Math.max(...[0, 3, 6].map((offset) => Math.hypot(...vectors.slice(offset, offset + 3))));
    if (cellScale / cutoff > 1e6 || atomCount > 4_000_000) throw new GpuUnavailableError('This frame exceeds the GPU precision or memory budget.');
    if (!Number.isFinite(Math.fround(cutoff * cutoff)) || Math.fround(cutoff * cutoff) <= 0
        || [...vectors, ...heights].some((value) => !Number.isFinite(Math.fround(value)))
        || heights.some((value) => Math.fround(value) <= 0)) {
      throw new GpuUnavailableError('The cell or cutoff exceeds the GPU numeric range.');
    }
    const coefficientSum = heights.reduce((sum, height, axis) => sum + (frame.cell.pbc[axis] ? Math.ceil(cutoff / height) + 1 : 1), 0);
    const imagePrecisionFactor = Math.max(1, coefficientSum / 4);
    const distanceTolerance = Math.max(1e-8, (cutoff * cellScale * 32 * 2 ** -23 + cutoff * cutoff * 64 * 2 ** -23) * imagePrecisionFactor);
    const paddedSquared = Math.fround(Math.fround(cutoff * cutoff) + Math.fround(distanceTolerance));
    if (!Number.isFinite(Math.fround(distanceTolerance)) || Math.fround(distanceTolerance) <= 0
        || !Number.isFinite(paddedSquared) || paddedSquared <= 0) {
      throw new GpuUnavailableError('The padded GPU neighbor radius exceeds the GPU numeric range.');
    }
    const queryRadius = Math.sqrt(paddedSquared);
    imageBudget = heights.reduce((product, height, axis) => product * (frame.cell.pbc[axis] ? 2 * Math.ceil(queryRadius / height) + 3 : 1), 1);
    if (imageBudget > 4096) throw new GpuUnavailableError('The padded periodic image search exceeds the GPU budget.');
    if (heights.some((height, axis) => frame.cell.pbc[axis] && queryRadius / height > MAX_GPU_PERIODIC_RADIUS_FACES)) {
      throw new GpuUnavailableError('The padded periodic image geometry exceeds the GPU distance precision budget.');
    }
    const dimensions = heights.map((height) => Math.max(1, Math.min(256, Math.floor(height / queryRadius))));
    const maximumBins = Math.min(2_000_000, atomCount * 4);
    while (dimensions.reduce((product, value) => product * value, 1) > maximumBins) {
      const axis = dimensions.indexOf(Math.max(...dimensions)); dimensions[axis] = Math.max(1, Math.floor(dimensions[axis] / 2));
    }
    const totalBins = dimensions.reduce((product, value) => product * value, 1);
    await this.uploadFrame(frame, { signal });
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
    const stencilBins = dimensions.reduce((product, dimension) => product * Math.min(3, dimension), 1);
    const maximumOccupancy = Math.max(32, Math.floor(50_000 / stencilBins / imageBudget));
    ints[28] = maximumOccupancy;
    const owned = [];
    const own = (buffer) => { owned.push(buffer); return buffer; };
    try {
      const frameBuffers = this.frames.get(frameKey);
      const context = { atomCount, dimensions, faceHeights: heights, cutoff, distanceTolerance: floats[25],
        frameKey, configBuffer: own(this.createBuffer(CONFIG_BYTES, UNIFORM | COPY_DST)), ...frameBuffers,
        headsBuffer: own(this.createBuffer(totalBins * 4)), nextBuffer: own(this.createBuffer(atomCount * 4)) };
      this.write(context.configBuffer, new Uint8Array(config));
      this.configContexts.set(context.configBuffer, context);
      // Clearing bins and indexing atoms are GPU operations; no JS linked-cell
      // construction or quadratic all-pairs upload is required.
      await this.run(CLEAR_NEIGHBORS_SHADER, this.neighborBindings(context), totalBins, { signal, batchSize: 0, updateRange: false });
      const occupancyBuffer = own(this.createBuffer((totalBins + 1) * 4));
      await this.run(INDEX_NEIGHBORS_SHADER, this.neighborBindings(context, [occupancyBuffer]), atomCount, { signal });
      const occupied = await this.read(occupancyBuffer, Uint32Array, 1, { signal });
      this.disposeBuffers([occupancyBuffer]); owned.splice(owned.indexOf(occupancyBuffer), 1);
      if (occupied[0]) throw new GpuUnavailableError('The neighbor cells are too densely occupied for a bounded GPU dispatch.');
      while (this.indexes.size >= 2) { const [oldKey, old] = this.indexes.entries().next().value; this.disposeBuffers([old.configBuffer, old.headsBuffer, old.nextBuffer]); this.indexes.delete(oldKey); }
      this.indexes.set(key, context);
      this.neighborIndexBuildCount++;
      return context;
    } catch (error) { this.disposeBuffers(owned); throw error; }
  }

  compilePipeline(source) {
    const device = this.device;
    if (this.pipelines.has(source)) return Promise.resolve(this.pipelines.get(source));
    const existing = this.pipelineCompilations.get(source);
    if (existing) return existing;
    const compilation = (async () => {
      let pendingPipeline, scopedValidation, failure;
      device.pushErrorScope('validation');
      try {
        const module = device.createShaderModule({ code: source });
        const layout = device.createBindGroupLayout({ entries: bindingDeclarations(source).map(({ binding, access }) => ({
          binding, visibility: 4, buffer: { type: access.includes('uniform') ? 'uniform' : access.includes('read_write') ? 'storage' : 'read-only-storage' },
        })) });
        pendingPipeline = device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: { module, entryPoint: 'main' } });
      } catch (error) { failure = error; }
      // Remove the scope from the device stack before yielding. Background
      // compilation must not consume a foreground dispatch's error scope.
      finally { scopedValidation = device.popErrorScope(); }
      // Handle both promises immediately, including device-loss rejection of
      // popErrorScope while a slow native compilation is still pending.
      const [compiled, scoped] = await Promise.allSettled([pendingPipeline, scopedValidation]);
      if (compiled.status === 'rejected') failure ??= compiled.reason;
      if (scoped.status === 'rejected') failure ??= scoped.reason;
      const validation = scoped.status === 'fulfilled' ? scoped.value : null;
      if (validation) throw new GpuUnavailableError(validation.message);
      if (failure) throw failure;
      const pipeline = compiled.value;
      if (this.device !== device || this.lost) throw new GpuUnavailableError(this.lost || 'The WebGPU device was released during compilation.');
      if (this.pipelines.size > 32) this.pipelines.delete(this.pipelines.keys().next().value);
      this.pipelines.set(source, pipeline);
      return pipeline;
    })();
    this.pipelineCompilations.set(source, compilation);
    const retire = () => { if (this.pipelineCompilations.get(source) === compilation) this.pipelineCompilations.delete(source); };
    compilation.then(retire, retire);
    return compilation;
  }

  async run(source, bindings, invocations, { signal, startAtom = 0, endAtom = invocations, batchSize = 16_384, updateRange = true, workgroupSize = 128, onProgress } = {}) {
    await this.initialize(signal);
    const device = this.device;
    const pipeline = await waitForGpu(this.compilePipeline(source), signal);
    checkSignal(signal);
    if (!Number.isInteger(workgroupSize) || workgroupSize < 1 || workgroupSize > (device.limits.maxComputeInvocationsPerWorkgroup ?? 256)) {
      throw new GpuUnavailableError('The GPU kernel workgroup size exceeds device limits.');
    }
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
      const step = context ? Math.max(workgroupSize, Math.ceil(size / workgroupSize) * workgroupSize) : endAtom - startAtom;
      for (let offset = startAtom; offset < endAtom; offset += step) {
        checkSignal(signal);
        const end = Math.min(endAtom, offset + step);
        if (context) this.write(bindings[0], new Uint32Array([offset, end]), 104);
        const workgroups = Math.ceil((end - offset) / workgroupSize);
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

  protectedKeys() {
    const keys = new Set(this.analysisFramePins.keys());
    if (this.protectedFrameKey !== null) keys.add(this.protectedFrameKey);
    return keys;
  }

  evictFrame(frameKey) {
    this.voronoiPreparations.delete(frameKey);
    if (this.voronoiCpuContext?.frameKey === frameKey) this.voronoiCpuContext = null;
    const frame = this.frames.get(frameKey);
    if (!frame) return;
    for (const [indexKey, index] of this.indexes) if (index.frameKey === frameKey) {
      this.disposeBuffers([index.configBuffer, index.headsBuffer, index.nextBuffer]); this.indexes.delete(indexKey);
    }
    this.disposeBuffers([frame.positionsBuffer, frame.typesBuffer]);
    this.disposeBuffers([frame.ptm?.metadataBuffer, frame.ptm?.scalesBuffer, frame.ptm?.deformationBuffer]);
    this.disposeBuffers([...(frame.cartesian?.values() ?? [])].map(entry => entry.positionsBuffer));
    this.adaptiveCna.delete(frameKey);
    this.residentBytes -= frame.bytes; this.frames.delete(frameKey);
  }

  trimFrames({ incomingBytes = 0 } = {}) {
    const { capacity, frameBudgetBytes } = this.cacheStatus();
    for (const key of frameEvictionOrder(this.frames, this.currentIndex, this.protectedKeys())) {
      if (this.frames.size + (incomingBytes > 0 ? 1 : 0) <= capacity && this.residentBytes + incomingBytes <= frameBudgetBytes) break;
      this.evictFrame(key);
    }
  }

  disposeBuffers(buffers) {
    for (const buffer of buffers) if (buffer) {
      const size = this.bufferSizes.get(buffer);
      if (size !== undefined) { this.allocatedBytes -= size; this.bufferSizes.delete(buffer); }
      buffer.destroy();
    }
  }
  releaseFrames() {
    this.voronoiPreparations.clear();
    this.disposeBuffers(this.voronoiWorkspace?.buffers ?? []); this.voronoiWorkspace = null; this.voronoiCpuContext = null;
    this.clearIndexes();
    for (const frame of this.frames.values()) this.disposeBuffers([frame.positionsBuffer, frame.typesBuffer,
      frame.ptm?.metadataBuffer, frame.ptm?.scalesBuffer, frame.ptm?.deformationBuffer,
      ...[...(frame.cartesian?.values() ?? [])].map(entry => entry.positionsBuffer)]);
    this.adaptiveCna.clear();
    this.indexes.clear(); this.frames.clear(); this.residentBytes = 0; this.frameBytes = 0;
    this.frameCount = 0; this.currentIndex = 0; this.protectedFrameKey = null;
    this.analysisFramePins.clear();
  }
  clearFrames() { this.releaseFrames(); return this.cacheStatus(); }
  clearIndexes() {
    for (const context of this.indexes.values()) this.disposeBuffers([context.configBuffer, context.headsBuffer, context.nextBuffer]);
    this.indexes.clear();
  }
  close() {
    this.releaseFrames(); this.pipelines.clear(); this.pipelineCompilations.clear();
    this.device?.destroy(); this.device = null; this.warmupPromise = null;
  }
}
GpuRuntime.frameSerial = 0;

// Our generated shaders declare simple buffer bindings in group zero. An
// explicit layout also accepts resources referenced only by unused helpers.
function bindingDeclarations(source) {
  return [...source.matchAll(/@group\(0\)\s+@binding\((\d+)\)\s+var<([^>]+)>/g)]
    .map((match) => ({ binding: Number(match[1]), access: match[2] }));
}

// Lets cancellation messages reach the GPU Worker between batches.
export { yieldWorker };

/** Native compilation/device acquisition can complete in the background, but
 * cancellation must release the serialized worker task promptly. The shared
 * promise always retains rejection handlers and may safely populate caches. */
function waitForGpu(promise, signal) {
  checkSignal(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException('Analysis cancelled.', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once:true});
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function isGpuOutOfMemory(error) {
  return error?.gpuOutOfMemory || error?.name === 'GPUOutOfMemoryError';
}
