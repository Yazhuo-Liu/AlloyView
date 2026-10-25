import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DxaClient } from '../src/analysis/dxa-client.js';
import { crystalFrame } from './helpers/crystals.js';

test('real serial DXA checkpoint cancellation reuses its warmed Worker for subsequent DXA and surface jobs', { timeout: 30_000 }, async t => {
  const workers = [], messages = [], controller = new AbortController();
  let cancelled = false;
  const client = new DxaClient({ workerFactory: () => {
    const worker = new Worker(new URL('./helpers/node-dxa-worker.mjs', import.meta.url));
    workers.push(worker);
    return {
      postMessage(message, transfer) { messages.push({ id: message.id, type: message.type, requestId: message.requestId }); worker.postMessage(message, transfer); },
      addEventListener(type, callback) {
        worker.on(type, data => {
          callback(type === 'message' ? { data } : data);
          if (type === 'message' && data.checkpoint?.phase === 'before-tracing' && !cancelled) {
            cancelled = true;
            controller.abort();
          }
        });
      },
      terminate() { return worker.terminate(); },
    };
  }, environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: false },
  yieldToMain: () => new Promise(resolve => setImmediate(resolve)) });
  t.after(() => client.close());
  const frame = crystalFrame('fcc', 6, 4);
  const first = client.analyze(frame, {}, { signal: controller.signal });
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(cancelled, true);
  const result = await client.analyze(frame);
  assert.equal(workers.length, 1, 'cancel at the stage boundary keeps the native module and heap');
  assert.equal(result.atomStructureTypes.length, frame.ids.length);
  assert.ok(result.atomStructureTypes.every(value => value === 1));
  assert.equal(result.segments.length, 0);
  assert.ok(messages.some(message => message.type === 'resume-checkpoint'));
  const repeated = await client.analyze(frame);
  assert.equal(repeated.kernelGeneration, result.kernelGeneration);
  assert.deepEqual(repeated.atomStructureTypes, result.atomStructureTypes);
  assert.equal(workers.length, 1);
  const surface = await client.surface(frame, { radius: 3.5, smoothingLevel: 0 });
  assert.ok(surface.vertices instanceof Float64Array);
  assert.equal(workers.length, 1, 'surface uses the same guarded native entry protocol');
  assert.equal(client.cpuBudget.active, 0);
});
