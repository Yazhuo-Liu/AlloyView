import { cpuWorkerLimit } from './cpu-budget.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** Browsers expose different memory hints. None describes free RAM. Reserve
 * a modest share, with a core-based fallback where Chromium's heap hint is
 * unavailable. Known small heaps/devices still cap that fallback. */
export function cpuMemoryBudget(environment = globalThis) {
  const heap = Number(environment.performance?.memory?.jsHeapSizeLimit);
  const device = Number(environment.navigator?.deviceMemory) * GiB;
  const cores = Number(environment.navigator?.hardwareConcurrency);
  const coreShare = (Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : 2) * 64 * MiB;
  let bytes = Math.min(2 * GiB, Math.max(256 * MiB, coreShare,
    Number.isFinite(heap) && heap > 0 ? heap * .15 : 0,
    Number.isFinite(device) && device > 0 ? device * .125 : 0));
  if (Number.isFinite(heap) && heap > 0) bytes = Math.min(bytes, heap * .5);
  if (Number.isFinite(device) && device > 0) bytes = Math.min(bytes, device * .25);
  return Math.floor(bytes);
}

/** Fixed source/output bytes cannot be saved by removing Workers. Refuse an
 * allocation that cannot fit one Worker instead of reporting an unsafe count
 * of one. This is an admission estimate, not an assertion about free RAM. */
export function chooseMemoryWorkerCount(atomCount, perWorkerBytes, environment = globalThis,
  targetAtoms = 50_000, { sharedBytes = 0 } = {}) {
  if (!Number.isFinite(perWorkerBytes) || perWorkerBytes < 0 || !Number.isFinite(sharedBytes) || sharedBytes < 0) {
    throw new Error('CPU memory estimates must be finite and non-negative.');
  }
  const budget = cpuMemoryBudget(environment), available = budget - sharedBytes;
  if (available < perWorkerBytes || available < 0) {
    throw new Error('This analysis cannot fit its source, outputs and one Worker in the CPU memory budget. Reduce the atom count or analysis size.');
  }
  const maximum = Math.min(cpuWorkerLimit(environment), Math.max(1, Math.ceil(atomCount / targetAtoms)));
  return Math.min(maximum, perWorkerBytes ? Math.floor(available / perWorkerBytes) : maximum);
}
