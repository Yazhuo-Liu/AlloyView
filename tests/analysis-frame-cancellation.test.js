import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeAtomEyeTools } from '../src/atomeye-tools.js';
import { StructureWorkerClient } from '../src/worker-client.js';
import { createCell } from '../src/data/model.js';

class FakeWorker {
  constructor() { this.messages = []; }
  addEventListener() {}
  postMessage(message) { this.messages.push(message); }
  terminate() {}
}

for (const kind of ['referenceStrain', 'displacement']) {
  test(`cancelling ${kind} during reference loading cancels its last frame consumer before analysis dispatch`, async () => {
    const oldDocument = globalThis.document, oldWorker = globalThis.Worker, elements = new Map();
    const element = () => ({ value: '1', checked: false, children: [], listeners: {}, dataset: {},
      get valueAsNumber() { return Number(this.value); }, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
      append(...items) { this.children.push(...items); }, prepend(...items) { this.children.unshift(...items); },
      replaceChildren(...items) { this.children = items; }, addEventListener(name, listener) { this.listeners[name] = listener; } });
    globalThis.document = { querySelectorAll: () => [], createElement: element,
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } };
    globalThis.Worker = FakeWorker;
    const client = new StructureWorkerClient();
    const frame = { frameIndex: 0, idSource: 'explicit', ids: Uint32Array.of(1), types: Uint16Array.of(0),
      typeLabels: ['Fe'], properties: [], fractional: Float64Array.of(.1, .1, .1), positions: Float64Array.of(1, 1, 1),
      cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
    let readOptions, analyses = 0;
    try {
      const controls = initializeAtomEyeTools({ renderer: { frame, atomCount: 1, setSelectedAtoms() {}, setVectorFields() {} },
        pool: { async analyze() { analyses++; throw new Error('A cancelled reference must not be dispatched'); } },
        tools: { setToolEnabled() {}, isToolEnabled: () => false }, getFrame: () => frame, getFrames: () => [frame],
        getFrameAt: (index, options) => { readOptions = options; return client.frame(index, { ...options, reportProgress: false }).then(result => result.frame); },
        getFrameIndex: () => 0, getFrameCount: () => 2, getSelectedIndex: () => -1, getSourceVersion: () => 1,
        getColorMode: () => 'type', refresh() {}, chooseProperty() {}, requestDisplayRefresh() {} });
      elements.get(kind === 'referenceStrain' ? 'reference-frame' : 'displacement-reference-frame').value = '2';
      const running = kind === 'referenceStrain' ? controls.run(kind) : controls.runDisplacement();
      assert.equal(readOptions.background, true);
      assert.equal(readOptions.signal.aborted, false);
      assert.equal(client.pending.size, 1);
      if (kind === 'referenceStrain') controls.cancel(kind); else controls.cancelDisplacement();
      await running;
      assert.equal(readOptions.signal.aborted, true);
      assert.equal(client.pending.size, 0);
      assert.equal(client.worker.messages.filter(message => message.type === 'cancel-frame').length, 1);
      assert.equal(analyses, 0);
      client.handleMessage({ id: 1, ok: true, result: { frame } });
      assert.equal(frame.atomeyeResults, undefined);
    } finally {
      client.close();
      if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
      if (oldWorker === undefined) delete globalThis.Worker; else globalThis.Worker = oldWorker;
    }
  });
}
