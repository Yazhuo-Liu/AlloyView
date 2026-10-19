import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { SelectionExpansionClient } from '../src/analysis/selection-expansion-client.js';
import { expandSelection } from '../src/analysis/expand-selection.js';
import { createCell } from '../src/data/model.js';

test('resident selection expansion follows changed cell geometry and coordinate revisions', async t => {
  const workers = [], messages = [];
  const client = new SelectionExpansionClient({ createWorker: () => {
    const worker = new Worker(new URL('./helpers/node-selection-worker.mjs', import.meta.url));
    workers.push(worker);
    return {
      addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { messages.push(data); worker.postMessage(data, transfer); },
      terminate() { void worker.terminate(); },
    };
  } });
  t.after(() => client.terminate());
  const frame = { fractional: new Float64Array([.02, .5, .5, .97, .5, .5]),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
  const selected = Uint8Array.of(1, 0), options = { cutoff: 1 };
  assert.deepEqual([...(await client.expand(frame, selected, options)).mask], [1, 1]);
  const stretched = { ...frame, cell: createCell({ vectors: [40, 0, 0, 0, 10, 0, 0, 0, 10] }) };
  assert.deepEqual(await client.expand(stretched, selected, options), await expandSelection(stretched, selected, options),
    'a wider cell places the periodic neighbor outside the cutoff');
  frame.cell.pbc[0] = false;
  assert.deepEqual(await client.expand(frame, selected, options), await expandSelection(frame, selected, options),
    'open boundaries exclude the old periodic image');
  await client.expand(frame, selected, { cutoff: 2 });
  assert.equal(messages.at(-1).fractional, undefined, 'unchanged geometry retains its neighbor index');
  frame.fractional[3] = .03; frame.geometryRevision = 1;
  assert.deepEqual([...(await client.expand(frame, selected, options)).mask], [1, 1], 'a coordinate revision refreshes the index');
  assert.equal(workers.length, 1, 'geometry edits retain the warmed Worker');
  assert.deepEqual([...selected], [1, 0], 'the source selection stays intact');
});
