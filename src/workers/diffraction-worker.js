import { prepareDiffractionSourceSteps, prepareDiffractionSteps, calculateDiffractionRangeSteps,
  finalizeDiffractionSteps, diffractionCsvSteps } from '../analysis/diffraction.js';
import { runParserStepsAsync } from '../io/cooperative-parser.js';

let active = null, frame = null, sourceKey = null, prepared = null, preparedKey = null;
let preparationSequence = 0, preparedParameters = null, sourceCache = new Map(), sharedCache = new WeakMap();
let gpuRuntime = null, gpuModule = null;
const abortError = () => new DOMException('Diffraction calculation cancelled.', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };

self.addEventListener('message', ({ data }) => {
  if (data.type === 'cancel') { if (active?.id === data.id) active.controller.abort(); return; }
  if (data.type === 'cpu-permit') {
    if (active?.id !== data.id) return;
    const waiter = active.cpuWaiters.get(data.token); if (!waiter) return;
    if (data.ok) waiter.resolve();
    else { const error = new Error(data.error || 'CPU stage admission failed.'); error.name = data.name || 'Error'; waiter.reject(error); }
    return;
  }
  if (active) { self.postMessage({ id: data.id, ok: false, error: 'The diffraction Worker is busy.' }); return; }
  void run(data);
});

function bufferSet(object, output = new Set(), seen = new Set()) {
  if (!object || typeof object !== 'object' || seen.has(object)) return output;
  seen.add(object);
  if (ArrayBuffer.isView(object)) { if (object.buffer instanceof ArrayBuffer) output.add(object.buffer); }
  else for (const value of Object.values(object)) bufferSet(value, output, seen);
  return output;
}
function preparedBytes(value) {
  const arrays = new Set(), seen = new Set();
  const visit = object => {
    if (!object || typeof object !== 'object' || seen.has(object)) return; seen.add(object);
    if (ArrayBuffer.isView(object)) arrays.add(object.buffer); else for (const child of Object.values(object)) visit(child);
  };
  visit(value); return [...arrays].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}
function* sharedPreparedSteps(object, seen = new Map()) {
  if (!object || typeof object !== 'object') return object;
  if (sharedCache.has(object)) return sharedCache.get(object);
  if (seen.has(object)) return seen.get(object);
  if (ArrayBuffer.isView(object)) {
    const copy = new object.constructor(new SharedArrayBuffer(object.byteLength));
    for (let start = 0; start < object.length; start += 65536) { yield; copy.set(object.subarray(start, start + 65536), start); }
    sharedCache.set(object, copy); return copy;
  }
  const copy = Array.isArray(object) ? [] : {}; seen.set(object, copy);
  for (const [key, value] of Object.entries(object)) copy[key] = yield* sharedPreparedSteps(value, seen);
  return copy;
}
async function gpuResources(signal) {
  gpuModule ??= await import('../analysis/gpu/diffraction.js');
  const { GpuRuntime } = await import('../analysis/gpu/runtime.js');
  if (gpuRuntime?.lost || gpuRuntime?.closed) { gpuModule.releaseGpuDiffraction(gpuRuntime); gpuRuntime.close?.(); gpuRuntime = null; }
  gpuRuntime ??= new GpuRuntime(); await gpuRuntime.initialize(signal);
  return { runtime: gpuRuntime, module: gpuModule };
}
function receivePrepared(port, key, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { signal.removeEventListener('abort', abort); port.close(); };
    const abort = () => { cleanup(); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    port.addEventListener('message', ({ data }) => {
      cleanup();
      if (signal.aborted) { reject(abortError()); return; }
      if (data.key !== key || !data.prepared || !Number.isSafeInteger(data.prepared.reflectionCount)
          || data.prepared.hkls?.length !== data.prepared.reflectionCount * 3) { reject(new Error('Invalid diffraction stage input.')); return; }
      resolve(data.prepared);
    }, { once: true });
    port.addEventListener('messageerror', () => { cleanup(); reject(new Error('Unreadable diffraction stage input.')); }, { once: true });
    port.start(); if (signal.aborted) abort();
  });
}

async function run(data) {
  const task = active = { id: data.id, controller: new AbortController(), cpuSequence: 0, cpuWaiters: new Map() };
  const options = { signal: task.controller.signal }, progress = update => self.postMessage({ id: data.id, progress: update });
  // GPU host work joins the same CPU budget as atom analyses. Permits cover
  // packing/reduction/precision correction only, never GPU queue/read waits.
  const withCpu = async operation => {
    checkAbort(options.signal);
    const token = ++task.cpuSequence;
    let abort;
    try {
      await new Promise((resolve, reject) => {
        const finish = callback => value => { task.cpuWaiters.delete(token); options.signal.removeEventListener('abort', abort); callback(value); };
        task.cpuWaiters.set(token, { resolve: finish(resolve), reject: finish(reject) });
        abort = () => task.cpuWaiters.get(token)?.reject(abortError());
        options.signal.addEventListener('abort', abort, { once: true });
        self.postMessage({ id: data.id, cpu: { action: 'acquire', token } });
      });
      checkAbort(options.signal); return await operation();
    } finally {
      options.signal.removeEventListener('abort', abort); task.cpuWaiters.delete(token);
      self.postMessage({ id: data.id, cpu: { action: 'release', token } });
    }
  };
  try {
    let result;
    if (data.type === 'clear') {
      frame = null; sourceKey = null; prepared = null; preparedKey = null; preparedParameters = null;
      sourceCache.clear(); sharedCache = new WeakMap();
      if (gpuRuntime) gpuModule?.releaseGpuDiffraction(gpuRuntime);
      result = { cleared: true };
    } else if (data.type === 'release-gpu') {
      if (gpuRuntime) { gpuModule?.releaseGpuDiffraction(gpuRuntime); gpuRuntime.close(); gpuRuntime = null; }
      result = { gpuReady: false };
    } else if (data.type === 'warm') result = { workerCount: 1, gpuReady: false };
    else if (data.type === 'warm-gpu') {
      const { runtime, module } = await gpuResources(options.signal); await module.warmGpuDiffraction(runtime, options);
      result = { workerCount: 1, gpuReady: true };
    } else if (data.type === 'source') {
      if (sourceKey !== data.key) {
        frame = data.frame; sourceKey = data.key; prepared = null; preparedKey = null; preparedParameters = null;
        sourceCache.clear(); sharedCache = new WeakMap();
        if (gpuRuntime) gpuModule?.releaseGpuDiffraction(gpuRuntime);
      }
      result = { sourceReady: true };
    } else if (data.type === 'prepare') {
      if (!frame || sourceKey !== data.key) throw new Error('Diffraction source is no longer resident.');
      const signature = JSON.stringify([data.parameters, Boolean(data.shared)]);
      if (!prepared || signature !== preparedParameters) {
        const thermal = data.parameters?.useThermal !== false;
        let source = sourceCache.get(thermal);
        if (!source) {
          source = await runParserStepsAsync(prepareDiffractionSourceSteps(frame, { useThermal: thermal }), options);
          sourceCache.set(thermal, source);
        }
        let next = await runParserStepsAsync(prepareDiffractionSteps(frame, data.parameters, { source }), options);
        if (data.shared) next = await runParserStepsAsync(sharedPreparedSteps(next), options);
        prepared = next; preparedKey = `${sourceKey}:${++preparationSequence}`; preparedParameters = signature;
      }
      result = { key: preparedKey, atomCount: prepared.atomCount, reflectionCount: prepared.reflectionCount,
        preparedBytes: preparedBytes(prepared) };
    } else if (data.type === 'receive') {
      const next = await receivePrepared(data.port, data.key, options.signal);
      prepared = next; preparedKey = data.key; frame = null; sourceKey = null; sourceCache.clear();
      result = { ready: true };
    } else if (data.type === 'publish') {
      try {
        if (!prepared || preparedKey !== data.key) throw new Error('Diffraction stage input is no longer resident.');
        for (const port of data.ports) {
          checkAbort(options.signal); port.postMessage({ key: preparedKey, prepared }); port.close();
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        result = { sent: data.ports.length };
      } finally { for (const port of data.ports) port.close(); }
    } else if (data.type === 'range') {
      if (!prepared || preparedKey !== data.key) throw new Error('Diffraction stage input is no longer resident.');
      result = await runParserStepsAsync(calculateDiffractionRangeSteps(prepared, { start: data.start, end: data.end }, { onProgress: progress }), options);
    } else if (data.type === 'gpu') {
      if (!prepared || preparedKey !== data.key) throw new Error('Diffraction stage input is no longer resident.');
      const { runtime, module } = await gpuResources(options.signal);
      result = await module.analyzeGpuDiffraction(runtime, prepared, { ...options, onProgress: progress, withCpu });
    } else if (data.type === 'finalize') {
      if (!prepared || preparedKey !== data.key) throw new Error('Diffraction stage input is no longer resident.');
      result = await runParserStepsAsync(finalizeDiffractionSteps(prepared, data.parts), options);
    } else if (data.type === 'csv') result = await runParserStepsAsync(diffractionCsvSteps(data.result, data.options), options);
    else throw new Error('Unknown diffraction Worker request.');
    const owned = bufferSet(prepared), transfer = [...bufferSet(result)].filter(buffer => !owned.has(buffer));
    self.postMessage({ id: data.id, ok: true, result, sourceKey, preparedKey }, transfer);
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: error.message, name: error.name,
      gpuUnavailable: ['gpu', 'warm-gpu'].includes(data.type) && error.name !== 'AbortError', sourceKey, preparedKey });
  } finally { if (active === task) active = null; }
}
