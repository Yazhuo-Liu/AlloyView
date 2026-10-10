import { buildGrainDendrogram, segmentGrains } from '../analysis/grains.js';

// The merge sequence of the most recent structure stays here, so changing the
// threshold, the minimum grain size or orphan adoption only repeats the cheap
// second stage. Cancellation terminates this Worker; it never polls.
let resident = null;

self.addEventListener('message', ({ data }) => {
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
      const model = buildGrainDendrogram(input, { ...modelOptions, onProgress: (stage, fraction) => {
        const now = performance.now();
        if (fraction > 0 && now - lastProgressAt < 100) return;
        lastProgressAt = now;
        self.postMessage({ id, progress: { stage, fraction } });
      } });
      resident = { key: modelKey, model };
    }
    const modelMs = performance.now() - startedAt;
    self.postMessage({ id, progress: { stage: 'grains', fraction: 0 } });
    const result = segmentGrains(resident.model, parameters);
    // The plot belongs to the resident model; send a copy.
    result.plot = { distance: result.plot.distance.slice(), size: result.plot.size.slice(), unit: result.plot.unit };
    Object.assign(result, { modelReused, modelMs, elapsedMs: performance.now() - startedAt });
    self.postMessage({ id, ok: true, result }, [result.grainId, result.sizes, result.structureTypes, result.rootStructureTypes,
      result.orientations, result.plot.distance, result.plot.size].map(values => values.buffer));
  } catch (error) {
    resident = null;
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
