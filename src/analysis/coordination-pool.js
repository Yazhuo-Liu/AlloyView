const TARGET_ATOMS_PER_WORKER = 50_000;
const MAX_WORKERS = 6;

export class CoordinationPool {
  constructor() {
    this.nextId = 1;
    this.activeWorkers = new Set();
  }

  async analyze(frame, cutoff, { onProgress = () => {} } = {}) {
    const startedAt = performance.now();
    const atomCount = frame.fractional.length / 3;
    const sharedFractional = sharedCoordinates(frame.fractional);
    const workerCount = chooseWorkerCount(atomCount, sharedFractional ? 0 : frame.fractional.byteLength);
    let completed = 0;
    onProgress({ completed, total: workerCount, workerCount });
    const tasks = Array.from({ length: workerCount }, (_, workerIndex) => {
      const startAtom = Math.floor(atomCount * workerIndex / workerCount);
      const endAtom = Math.floor(atomCount * (workerIndex + 1) / workerCount);
      return this.runWorker({
        fractional: sharedFractional ?? frame.fractional,
        cell: frame.cell,
        cutoff,
        startAtom,
        endAtom,
      }).then((result) => {
        completed += 1;
        onProgress({ completed, total: workerCount, workerCount });
        return result;
      });
    });
    const partials = await Promise.all(tasks);
    const coordination = new Uint32Array(atomCount);
    let candidatePairs = 0;
    let acceptedPairs = 0;
    for (const partial of partials) {
      for (let atom = 0; atom < atomCount; atom += 1) coordination[atom] += partial.coordination[atom];
      candidatePairs += partial.candidatePairs;
      acceptedPairs += partial.acceptedPairs;
    }
    return {
      coordination,
      elapsedMs: performance.now() - startedAt,
      candidatePairs,
      acceptedPairs,
      bins: partials[0]?.bins ?? null,
      warning: partials.find((partial) => partial.warning)?.warning ?? null,
      engine: `js-worker${workerCount === 1 ? '' : `-pool×${workerCount}`}`,
      workerCount,
      sharedMemory: Boolean(sharedFractional),
    };
  }

  runWorker(payload) {
    const worker = new Worker(new URL('../workers/coordination-worker.js', import.meta.url), { type: 'module' });
    this.activeWorkers.add(worker);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = () => {
        worker.terminate();
        this.activeWorkers.delete(worker);
      };
      worker.addEventListener('message', (event) => {
        if (event.data.id !== id) return;
        finish();
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.error));
      });
      worker.addEventListener('error', (event) => {
        finish();
        reject(new Error(event.message || 'A coordination Worker failed.'));
      }, { once: true });
      worker.postMessage({ id, ...payload });
    });
  }

  close() {
    for (const worker of this.activeWorkers) worker.terminate();
    this.activeWorkers.clear();
  }
}

export function chooseWorkerCount(atomCount, coordinateBytes, environment = globalThis) {
  const hardware = Math.max(1, Number(environment.navigator?.hardwareConcurrency) || 2);
  let count = Math.max(1, Math.ceil(atomCount / TARGET_ATOMS_PER_WORKER));
  count = Math.min(count, Math.max(1, hardware - 1), MAX_WORKERS);
  const heapLimit = Number(environment.performance?.memory?.jsHeapSizeLimit);
  const copyBudget = Number.isFinite(heapLimit) ? heapLimit * 0.15 : 256 * 1024 ** 2;
  while (count > 1 && coordinateBytes * count > copyBudget) count -= 1;
  return count;
}

function sharedCoordinates(source) {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') return null;
  const shared = new SharedArrayBuffer(source.byteLength);
  const coordinates = new Float32Array(shared);
  coordinates.set(source);
  return coordinates;
}
