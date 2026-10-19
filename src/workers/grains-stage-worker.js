import { createNeighborBonds, grainDisorientationRange } from '../analysis/grains.js';
let current = null;
import { yieldToEventLoop as pause } from '../shared/task-yield.js';
self.addEventListener('message', ({ data }) => {
  if (data.warm) { self.postMessage({ id: data.id, ok: true, result: { warmed: true } }); return; }
  if (data.cancel) { if (current?.id === data.id) current.cancelled = true; return; }
  void run(data);
});
async function run({ id, stage, input, first, end }) {
  const task = current = { id, cancelled: false };
  try {
    if (!['bonds', 'disorientation'].includes(stage) || !Number.isInteger(first) || !Number.isInteger(end) || first < 0 || end < first) throw new Error('Invalid grain stage range.');
    const parts = [], values = stage === 'disorientation' ? new Float64Array(end - first) : null;
    for (let start = first; start < end; start += 1024) {
      if (task.cancelled) throw new Error('Grain stage cancelled.');
      const stop = Math.min(end, start + 1024);
      if (values) values.set(grainDisorientationRange(input, start, stop), start - first);
      else parts.push(createNeighborBonds(input, start, stop));
      if (stop < end) await pause();
    }
    if (task.cancelled) throw new Error('Grain stage cancelled.');
    let result = values;
    if (!result) {
      const count = parts.reduce((sum, part) => sum + part.count, 0);
      result = { a: new Uint32Array(count), b: new Uint32Array(count), lengths: new Float64Array(count), count };
      let offset = 0;
      for (const part of parts) { for (const key of ['a', 'b', 'lengths']) result[key].set(part[key], offset); offset += part.count; }
    }
    const arrays = ArrayBuffer.isView(result) ? [result] : [result.a, result.b, result.lengths];
    self.postMessage({ id, ok: true, result }, arrays.map(values => values.buffer));
  } catch (error) { self.postMessage({ id, ok: false, error: error.message }); }
  finally { if (current === task) current = null; }
}
