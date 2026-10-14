import { buildGrainDendrogram, buildGrainDendrogramParallel, segmentGrains } from '../analysis/grains.js';

// The merge sequence of the most recent structure stays here, so changing the
// threshold, the minimum grain size or orphan adoption only repeats the cheap
// second stage. Cancellation terminates this Worker; it never polls.
let resident = null;

let queue = Promise.resolve(), sequence = 0;
const stageReplies = new Map();
self.addEventListener('message', ({ data }) => {
  if (data.type === 'stage-result') {
    const reply = stageReplies.get(data.requestId); stageReplies.delete(data.requestId);
    if (reply) data.error ? reply.reject(new Error(data.error)) : reply.resolve(data.result);
    return;
  }
  queue = queue.then(() => run(data));
});
async function run(data) {
  const { id, type, modelKey, input, model: modelOptions, parameters } = data;
  try {
    if (type === 'warm') { self.postMessage({ id, ok: true, result: { warmed: true } }); return; }
    if (type === 'release') { resident = null; return; }
    if (type !== 'grains') throw new Error(`Unknown grain request: ${type}`);
    const startedAt = performance.now();
    let modelReused = true, lastProgressAt = -Infinity;
    if (resident?.key !== modelKey) {
      if (!input) throw new Error('The grain merge sequence is unavailable in its Worker.');
      resident = null; modelReused = false;
      const options = { ...modelOptions, onProgress: (stage, fraction) => {
        const now = performance.now();
        if (fraction > 0 && now - lastProgressAt < 100) return;
        lastProgressAt = now;
        self.postMessage({ id, progress: { stage, fraction } });
      } };
      const stage = (stage, values, length) => new Promise((resolve, reject) => {
        const requestId = ++sequence; stageReplies.set(requestId, { resolve, reject });
        const payload = stage === 'disorientation' ? values : undefined;
        const transfers = payload ? [...new Set(Object.values(payload).filter(ArrayBuffer.isView).map(values => values.buffer))] : [];
        self.postMessage({ id, stageRequest: { stage, input: payload, length, requestId } }, transfers);
      });
      const model = data.parallel ? await buildGrainDendrogramParallel(input, options, stage, () => stage('serial')) : buildGrainDendrogram(input, options);
      resident = { key: modelKey, model };
    }
    const modelMs = performance.now() - startedAt;
    self.postMessage({ id, progress: { stage: 'grains', fraction: 0 } });
    const result = segmentGrains(resident.model, parameters);
    // The plot belongs to the resident model; send a copy.
    result.plot = { distance: result.plot.distance.slice(), size: result.plot.size.slice(), unit: result.plot.unit };
    Object.assign(result, { modelReused, modelMs, workerCount: modelReused ? 1 : data.workerCount ?? 1, elapsedMs: performance.now() - startedAt });
    self.postMessage({ id, ok: true, result }, [result.grainId, result.sizes, result.structureTypes, result.rootStructureTypes,
      result.orientations, result.plot.distance, result.plot.size].map(values => values.buffer));
  } catch (error) {
    resident = null;
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
