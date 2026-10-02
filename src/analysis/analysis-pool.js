const MAX_WORKERS = 6;
const PTM_OUTPUT_FIELDS = { structures: [Uint8Array, 1], rmsd: [Float32Array, 1], scales: [Float64Array, 1],
  deformation: [Float64Array, 9], distances: [Float32Array, 1] };
const STRAIN_OUTPUT_FIELDS = Object.fromEntries(['atomicShearStrain', 'atomicHydrostaticStrain', 'atomicVolumeChange',
  'strainE11', 'strainE22', 'strainE33', 'strainE12', 'strainE13', 'strainE23'].map((name) => [name, [Float32Array, 1]]));

export function chooseWorkerCount(atomCount, coordinateBytes, environment = globalThis, targetAtoms = 50_000) {
  const hardware = Math.max(1, Number(environment.navigator?.hardwareConcurrency) || 2);
  let count = Math.min(Math.max(1, Math.ceil(atomCount / targetAtoms)), Math.max(1, hardware - 1), MAX_WORKERS);
  const heapLimit = Number(environment.performance?.memory?.jsHeapSizeLimit);
  const copyBudget = Number.isFinite(heapLimit) ? heapLimit * 0.15 : 256 * 1024 ** 2;
  while (count > 1 && coordinateBytes * count > copyBudget) count -= 1;
  return count;
}

/** One concurrency budget across all analyses, with cancellation and bounded
 * coordinate copies. Every task owns a disjoint central-atom range.
 */
export class AnalysisPool {
  constructor({ environment = globalThis, workerFactory = () => new Worker(
    new URL('../workers/analysis-worker.js', import.meta.url), { type: 'module' },
  ) } = {}) {
    this.environment = environment;
    this.workerFactory = workerFactory;
    this.limit = Math.min(MAX_WORKERS, Math.max(1, (Number(environment.navigator?.hardwareConcurrency) || 2) - 1));
    this.active = new Set();
    this.queue = [];
    this.nextId = 1;
    this.closed = false;
  }

  async analyze(frame, parameters, { onProgress = () => {}, signal } = {}) {
    if (this.closed) throw new Error('The analysis pool is closed.');
    if (signal?.aborted) throw abortError();
    const startedAt = performance.now();
    const atomCount = frame.fractional.length / 3;
    if (!Number.isInteger(atomCount) || atomCount < 1) throw new Error('Analysis requires at least one atom.');
    let coordinates = frame.fractional;
    const sharedMemory = Boolean(this.environment.crossOriginIsolated && typeof SharedArrayBuffer === 'function');
    if (sharedMemory) {
      coordinates = new frame.fractional.constructor(new SharedArrayBuffer(frame.fractional.byteLength));
      coordinates.set(frame.fractional);
    }
    const share = (source) => {
      if (!sharedMemory) return source;
      const copy = new source.constructor(new SharedArrayBuffer(source.byteLength));
      copy.set(source);
      return copy;
    };
    let extraBytes = 0;
    const inputs = { ...parameters };
    if (parameters.kind === 'strain') {
      inputs.types = share(frame.types);
      extraBytes += frame.types.byteLength;
      if (parameters.ptmInput) {
        inputs.ptmInput = Object.fromEntries(Object.keys(PTM_OUTPUT_FIELDS).map((name) => {
          extraBytes += parameters.ptmInput[name].byteLength;
          return [name, share(parameters.ptmInput[name])];
        }));
      }
    }
    const outputFields = parameters.kind === 'ptm' ? PTM_OUTPUT_FIELDS
      : parameters.kind === 'strain' ? { ...STRAIN_OUTPUT_FIELDS, ...(parameters.ptmInput ? {} : PTM_OUTPUT_FIELDS) }
        : { values: [parameters.kind === 'cna' ? Uint8Array : Float32Array, 1] };
    const outputBytesPerAtom = Object.values(outputFields).reduce((sum, [Type, stride]) => sum + Type.BYTES_PER_ELEMENT * stride, 0);
    const workerCount = Math.min(this.limit, chooseWorkerCount(atomCount,
      (sharedMemory ? 0 : coordinates.byteLength + extraBytes) + atomCount * (48 + outputBytesPerAtom), this.environment,
      parameters.kind === 'coordination' || (parameters.kind === 'strain' && parameters.ptmInput) ? 50_000 : 4_096));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let completed = 0;
    try {
      onProgress({ completed, total: workerCount, workerCount });
      const partials = await Promise.all(Array.from({ length: workerCount }, (_, index) => {
        const startAtom = Math.floor(atomCount * index / workerCount);
        const endAtom = Math.floor(atomCount * (index + 1) / workerCount);
        return this.runTask({ fractional: coordinates, cell: frame.cell, ...inputs, startAtom, endAtom }, controller.signal)
          .then((partial) => {
            completed += 1;
            onProgress({ completed, total: workerCount, workerCount });
            return partial;
          });
      }));
      const metadata = { elapsedMs: performance.now() - startedAt, workerCount, sharedMemory,
        engine: `${parameters.kind === 'ptm' || (parameters.kind === 'strain' && !parameters.ptmInput) ? 'ptm-wasm' : 'js'}-worker${workerCount === 1 ? '' : `-pool×${workerCount}`}` };
      if (parameters.kind === 'coordination') {
        const coordination = new Uint32Array(atomCount);
        let candidatePairs = 0, acceptedPairs = 0;
        for (const partial of partials) {
          for (let atom = 0; atom < atomCount; atom += 1) coordination[atom] += partial.coordination[atom];
          candidatePairs += partial.candidatePairs;
          acceptedPairs += partial.acceptedPairs;
        }
        return { ...metadata, coordination, candidatePairs, acceptedPairs, bins: partials[0]?.bins,
          warning: partials.find((partial) => partial.warning)?.warning ?? null };
      }
      if (parameters.kind === 'ptm' || parameters.kind === 'strain') {
        const fields = parameters.kind === 'ptm' ? PTM_OUTPUT_FIELDS
          : { ...STRAIN_OUTPUT_FIELDS, ...(parameters.ptmInput ? {} : PTM_OUTPUT_FIELDS) };
        const values = Object.fromEntries(Object.entries(fields).map(([name, [Type, stride]]) => [name, new Type(atomCount * stride)]));
        let incomplete = 0;
        for (const partial of partials) {
          for (const [name, [, stride]] of Object.entries(fields)) values[name].set(partial[name], partial.startAtom * stride);
          incomplete += partial.incomplete ?? 0;
        }
        return { ...metadata, ...values, incomplete,
          warning: incomplete ? `${incomplete} atoms do not match their reference lattice; their elastic strain is undefined (NaN).` : null };
      }
      const field = parameters.kind === 'cna' ? 'structures' : 'centrosymmetry';
      const values = parameters.kind === 'cna' ? new Uint8Array(atomCount) : new Float32Array(atomCount);
      let incomplete = 0;
      for (const partial of partials) {
        values.set(partial[field], partial.startAtom);
        incomplete += partial.incomplete ?? 0;
      }
      return { ...metadata, [field]: values, incomplete,
        warning: incomplete ? `${incomplete} atoms have insufficient neighbors or zero-length environments; central symmetry is undefined (NaN) for them.` : null };
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  runTask(payload, signal) {
    return new Promise((resolve, reject) => {
      const task = { id: this.nextId++, payload, signal, resolve, reject, worker: null, done: false };
      task.abort = () => this.finish(task, abortError());
      signal.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task);
      if (signal.aborted) task.abort();
      else this.pump();
    });
  }

  pump() {
    while (!this.closed && this.active.size < this.limit && this.queue.length) {
      const task = this.queue.shift();
      if (task.done) continue;
      this.active.add(task);
      try {
        task.worker = this.workerFactory();
        task.worker.addEventListener('message', ({ data }) => {
          if (data.id !== task.id) return;
          this.finish(task, data.ok ? null : new Error(data.error), data.result);
        });
        task.worker.addEventListener('error', (event) => this.finish(task, new Error(event.message || 'An analysis Worker failed.')), { once: true });
        task.worker.addEventListener('messageerror', () => this.finish(task, new Error('An analysis Worker returned unreadable data.')), { once: true });
        task.worker.postMessage({ id: task.id, ...task.payload });
      } catch (error) { this.finish(task, error); }
    }
  }

  finish(task, error, result) {
    if (task.done) return;
    task.done = true;
    task.signal.removeEventListener('abort', task.abort);
    task.worker?.terminate();
    this.active.delete(task);
    const queued = this.queue.indexOf(task);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (error) task.reject(error);
    else task.resolve(result);
    this.pump();
  }

  close() {
    this.closed = true;
    for (const task of [...this.active, ...this.queue]) this.finish(task, abortError());
  }
}

function abortError() {
  return new DOMException('Analysis cancelled.', 'AbortError');
}
