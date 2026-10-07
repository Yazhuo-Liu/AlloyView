import { checkSignal, GpuUnavailableError, yieldWorker } from './runtime.js';
import { DXA_ALPHA_SHADER, DXA_REGION_SHADER, DXA_SETTINGS_BYTES, DXA_WORKGROUP_SIZE } from './dxa-shaders.js';

export const GPU_DXA_BATCH_TETRAHEDRA = 4096;
export const DXA_GPU_STAGES = ['tetrahedron-alpha', 'elastic-compatibility'];
const MISSING = 0xffff_ffff;

/** Native geometry and correspondence tables retain their IEEE-754 f64 bits.
 * Alpha classifications stay on the device between the two compute passes.
 */
export async function analyzeGpuDxaClassification(runtime, snapshot, { signal, onProgress = () => {} } = {}) {
  const startedAt = performance.now();
  checkSignal(signal);
  const counts = validateGpuDxaSnapshot(snapshot, { validateValues: false });
  const { tetrahedronCount } = counts;
  const report = (phase, completedTetrahedra = 0) => onProgress({ phase, backend: 'gpu', workerCount: 1,
    completedTetrahedra, totalTetrahedra: tetrahedronCount, completedAtoms: completedTetrahedra,
    totalAtoms: tetrahedronCount });
  if (!tetrahedronCount) return { regions: new Int32Array(), tetrahedronCount, gpuStages: [],
    arithmetic: 'ieee754-f64', elapsedMs: performance.now() - startedAt, uploadedBytes: 0, readbackBytes: 0 };
  await runtime.initialize(signal);
  const workspaceBytes = preflightGpuDxaMemory(runtime, snapshot, counts, { reserve: false });
  for (const _ of validateSnapshotValues(snapshot, counts)) { await yieldWorker(); checkSignal(signal); }
  checkSignal(signal);
  runtime.reserveWorkspace?.(workspaceBytes);
  const buffers = [], own = buffer => { buffers.push(buffer); return buffer; };
  try {
    report('dxa-uploading');
    const settings = prepareGpuDxaSettings(snapshot, counts);
    const settingsBuffer = own(runtime.storageBuffer(settings));
    const verticesBuffer = own(runtime.storageBuffer(snapshot.vertices));
    const tetrahedraBuffer = own(runtime.storageBuffer(snapshot.tetrahedra));
    const edgesBuffer = own(runtime.storageBuffer(snapshot.edges));
    const transitionsBuffer = own(runtime.storageBuffer(snapshot.transitions));
    const alphaBuffer = own(runtime.createBuffer(tetrahedronCount * 4));
    const regionsBuffer = own(runtime.createBuffer(tetrahedronCount * 4));
    const alphaBindings = [settingsBuffer, verticesBuffer, tetrahedraBuffer, alphaBuffer];
    const regionBindings = [settingsBuffer, tetrahedraBuffer, edgesBuffer, transitionsBuffer, alphaBuffer, regionsBuffer];
    for (const [source, bindings, phase] of [[DXA_ALPHA_SHADER, alphaBindings, 'dxa-alpha'],
      [DXA_REGION_SHADER, regionBindings, 'dxa-elastic-compatibility']]) {
      report(phase);
      await runtime.runSequence(source, bindings, tetrahedronCount, { batch: GPU_DXA_BATCH_TETRAHEDRA, signal,
        workgroupSize: DXA_WORKGROUP_SIZE, setRange: (start, end) => runtime.write(settingsBuffer, new Uint32Array([start, end]), 12),
        onProgress: end => report(phase, end) });
    }
    report('dxa-readback');
    const regions = await runtime.read(regionsBuffer, Int32Array, tetrahedronCount, { signal });
    // A corrupt dispatch must never be accepted as a scientific classification.
    for (let index = 0; index < regions.length; index++) {
      if (regions[index] !== -1 && regions[index] !== 0) throw new GpuUnavailableError('The GPU returned an invalid DXA tetrahedron region.');
      if (index && index % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
    }
    checkSignal(signal);
    report('complete', tetrahedronCount);
    return { regions, tetrahedronCount, gpuStages: [...DXA_GPU_STAGES], arithmetic: 'ieee754-f64',
      elapsedMs: performance.now() - startedAt, uploadedBytes: DXA_SETTINGS_BYTES + snapshot.vertices.byteLength
        + snapshot.tetrahedra.byteLength + snapshot.edges.byteLength + snapshot.transitions.byteLength,
      readbackBytes: regions.byteLength };
  } finally { runtime.disposeBuffers(buffers); }
}

/** Schema-only validation lets the main-thread client transfer owned tables
 * without scanning the whole mesh. The GPU worker always validates values.
 */
export function validateGpuDxaSnapshot(snapshot, { validateValues = true } = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('GPU DXA requires a native geometry snapshot.');
  const { vertices, tetrahedra, edges, transitions, alpha } = snapshot;
  if (!(vertices instanceof Float64Array || vertices instanceof Uint32Array)
    || !(tetrahedra instanceof Uint32Array) || !(edges instanceof Uint32Array) || !(transitions instanceof Float64Array)) {
    throw new Error('GPU DXA requires typed f64 vertices, u32 tetrahedra and edges, and f64 transitions.');
  }
  for (const array of [vertices, tetrahedra, edges, transitions]) {
    if (!(array.buffer instanceof ArrayBuffer)) throw new Error('GPU DXA snapshot tables must own transferable ArrayBuffers.');
  }
  const vertexStride = vertices instanceof Float64Array ? 3 : 6;
  if (vertices.length % vertexStride || tetrahedra.length % 16 || edges.length % 8 || transitions.length % 20) {
    throw new Error('GPU DXA snapshot table strides are invalid.');
  }
  if (!Number.isFinite(alpha) || alpha < 0) throw new Error('GPU DXA alpha must be a finite nonnegative value.');
  const counts = { vertexCount: vertices.length / vertexStride, tetrahedronCount: tetrahedra.length / 16,
    edgeCount: edges.length / 8, transitionCount: transitions.length / 20 };
  for (const [name, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || count >= MISSING || (name === 'edgeCount' && count >= 0x8000_0000)) {
      throw new GpuUnavailableError('The DXA snapshot exceeds GPU index limits.');
    }
    if (snapshot[name] !== undefined && snapshot[name] !== count) throw new Error(`GPU DXA ${name} does not match its table.`);
  }
  if (validateValues) for (const _ of validateSnapshotValues(snapshot, counts)) { /* Synchronous callers validate every value. */ }
  return counts;
}

export function prepareGpuDxaSettings(snapshot, counts = validateGpuDxaSnapshot(snapshot, { validateValues: false })) {
  const settings = new Uint32Array(DXA_SETTINGS_BYTES / 4);
  new DataView(settings.buffer).setFloat64(0, snapshot.alpha, true);
  settings.set([counts.tetrahedronCount, 0, counts.tetrahedronCount, counts.vertexCount,
    counts.edgeCount, counts.transitionCount], 2);
  return settings;
}

export function preflightGpuDxaMemory(runtime, snapshot, counts = validateGpuDxaSnapshot(snapshot, { validateValues: false }), { reserve = true } = {}) {
  const sizes = [DXA_SETTINGS_BYTES, snapshot.vertices.byteLength, snapshot.tetrahedra.byteLength,
    snapshot.edges.byteLength, snapshot.transitions.byteLength, counts.tetrahedronCount * 4,
    counts.tetrahedronCount * 4, counts.tetrahedronCount * 4].map(bytes => Math.max(4, bytes));
  const limit = Math.min(runtime.device?.limits.maxBufferSize ?? Infinity,
    runtime.device?.limits.maxStorageBufferBindingSize ?? Infinity);
  if (sizes.some(bytes => bytes > limit)) throw new GpuUnavailableError('The DXA tables exceed GPU buffer limits; using CPU workers.');
  const workspaceBytes = sizes.reduce((total, bytes) => total + bytes, 0);
  if (!Number.isSafeInteger(workspaceBytes) || workspaceBytes > (runtime.budgetBytes ?? Infinity)) {
    throw new GpuUnavailableError('The DXA tables exceed the GPU memory budget; using CPU workers.');
  }
  if (reserve) runtime.reserveWorkspace?.(workspaceBytes);
  return workspaceBytes;
}

function* validateSnapshotValues(snapshot, counts) {
  const vertexWords = snapshot.vertices instanceof Uint32Array
    ? new DataView(snapshot.vertices.buffer, snapshot.vertices.byteOffset, snapshot.vertices.byteLength) : null;
  for (let index = 0; index < counts.vertexCount * 3; index++) {
    const value = vertexWords ? vertexWords.getFloat64(index * 8, true) : snapshot.vertices[index];
    if (!Number.isFinite(value)) throw new Error('GPU DXA vertices must contain finite Cartesian coordinates.');
    if (index && index % 65_536 === 0) yield;
  }
  for (let cell = 0; cell < counts.tetrahedronCount; cell++) {
    const offset = cell * 16, finite = snapshot.tetrahedra[offset + 14];
    if (finite !== 0 && finite !== 1) throw new Error('GPU DXA tetrahedron finite flags must be zero or one.');
    for (let corner = 0; corner < 4; corner++) {
      const vertex = snapshot.tetrahedra[offset + corner], adjacent = snapshot.tetrahedra[offset + 4 + corner];
      if (vertex >= counts.vertexCount && (finite || vertex !== MISSING)) throw new Error('GPU DXA tetrahedron vertex index is outside its table.');
      if (adjacent !== MISSING && adjacent >= counts.tetrahedronCount) throw new Error('GPU DXA tetrahedron adjacency index is outside its table.');
    }
    for (let edge = 0; edge < 6; edge++) {
      const reference = snapshot.tetrahedra[offset + 8 + edge];
      if (reference !== MISSING && (reference & 0x7fff_ffff) >= counts.edgeCount) throw new Error('GPU DXA tetrahedron edge index is outside its table.');
    }
    if (cell && cell % 16_384 === 0) yield;
  }
  const edgeView = new DataView(snapshot.edges.buffer, snapshot.edges.byteOffset, snapshot.edges.byteLength);
  for (let edge = 0; edge < counts.edgeCount; edge++) {
    const offset = edge * 8, transition = snapshot.edges[offset + 6];
    if (transition !== MISSING && transition >= counts.transitionCount) throw new Error('GPU DXA edge transition index is outside its table.');
    for (let axis = 0; axis < 3; axis++) {
      if (!Number.isFinite(edgeView.getFloat64((offset + axis * 2) * 4, true))) throw new Error('GPU DXA edge vectors must be finite.');
    }
    if (edge && edge % 16_384 === 0) yield;
  }
  for (let transition = 0; transition < counts.transitionCount; transition++) {
    const offset = transition * 20;
    for (let element = 0; element < 19; element++) {
      if (!Number.isFinite(snapshot.transitions[offset + element])) throw new Error('GPU DXA cluster transitions must be finite.');
    }
    if (snapshot.transitions[offset + 18] !== 0 && snapshot.transitions[offset + 18] !== 1) {
      throw new Error('GPU DXA cluster transition self flags must be zero or one.');
    }
    if (transition && transition % 4096 === 0) yield;
  }
}
