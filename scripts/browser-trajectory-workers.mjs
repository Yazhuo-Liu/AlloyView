import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-trajectory-workers-'));
const file = resolve(directory, 'trajectory.xyz');
const header = 'Lattice="10 0 0 2 10 0 1 1 10" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T"';
await writeFile(file, Array.from({ length: 12 }, (_, frame) => `2\n${header}\nFe ${frame / 10} 0 0 7\nNi 5 5 5 12\n`).join(''));

try {
  const result = await withWebGpuBrowser(async ({ call, evaluate }) => {
    await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, get: () => 5 });
    ` });
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(25);
      }
      throw new Error(`${label}: ${await evaluate('document.getElementById("toast")?.textContent')}`);
    }
    await waitFor('document.readyState === "complete" && document.querySelector("[data-tool-button=replicate]")', 'Application startup');
    await evaluate(`(async () => {
      const app = document.querySelector('script[type=module][src]').src;
      const { StructureWorkerClient } = await import(new URL('./worker-client.js', app));
      const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
      const checks = window.trajectoryChecks = { loads: [], frameRequests: [], replicas: [], displays: [] };
      // Keep one processed-frame read in flight long enough for a file-value
      // collection and navigation to share the app's processing operation.
      let releaseFrame;
      const heldFrame = new Promise(resolve => { releaseFrame = resolve; });
      let held = true;
      checks.releaseFrame = () => { held = false; releaseFrame(); };
      const load = StructureWorkerClient.prototype.load;
      StructureWorkerClient.prototype.load = function(...args) {
        checks.client = this;
        return load.apply(this, args).then(result => { checks.loads.push({ frames: result.frameCount, complete: result.indexComplete }); return result; });
      };
      const frame = StructureWorkerClient.prototype.frame;
      StructureWorkerClient.prototype.frame = function(index, options) {
        checks.frameRequests.push({ index, background: Boolean(options?.background), time: performance.now() });
        const result = frame.call(this, index, options);
        return index === 1 && held ? result.then(async value => {
          await heldFrame;
          if (options?.signal?.aborted) throw new DOMException('Frame request cancelled.', 'AbortError');
          return value;
        }) : result;
      };
      const replicate = StructureWorkerClient.prototype.replicate;
      StructureWorkerClient.prototype.replicate = function(...args) {
        const row = { started: performance.now() }; checks.replicas.push(row);
        return replicate.apply(this, args).then(result => { row.atoms = result.ids.length; row.completed = performance.now(); return result; });
      };
      const setFrame = WebGLRenderer.prototype.setFrame;
      WebGLRenderer.prototype.setFrame = function(...args) {
        if (this.canvas.id === 'viewport') {
          checks.renderer = this;
          checks.displays.push({ index: args[0].frameIndex, atoms: args[0].ids.length, time: performance.now() });
        }
        return setFrame.apply(this, args);
      };
    })()`);
    const { root: dom } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: dom.nodeId, selector: '#file-input' });
    await call('DOM.setFileInputFiles', { nodeId, files: [file] });
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    await waitFor('trajectoryChecks.renderer?.frame.ids.length === 2 && document.getElementById("frame-count").textContent === "12"', 'Indexed trajectory import');
    await waitFor('trajectoryChecks.frameRequests.some(request => request.index === 1)', 'In-flight speculative frame');
    await evaluate(`document.querySelector('[data-tool-button="timeSeries"]').click();
      document.getElementById('time-series-last').value = '12';
      document.getElementById('time-series-last').dispatchEvent(new Event('change', {bubbles:true}));
      document.getElementById('collect-time-series').click();`);
    await waitFor('document.getElementById("collect-time-series").disabled && !document.getElementById("cancel-time-series").disabled', 'File-value collection joined to prefetch');
    await evaluate('document.getElementById("frame-last").click()');
    await waitFor('trajectoryChecks.renderer.frame.frameIndex === 11', 'Foreground seek to last frame');
    assert.equal(await evaluate('document.getElementById("collect-time-series").disabled'), true, 'navigation must preserve the active collection');
    assert.equal(await evaluate('trajectoryChecks.frameRequests.filter(request => request.index === 1).length'), 1, 'the collection shares the prefetch processing request');
    await evaluate('trajectoryChecks.releaseFrame()');
    await waitFor(`document.getElementById('time-series-state').textContent === 'Complete'
      && document.querySelector('#time-series-chart path[data-series="Cell.volume"]')?.dataset.pointCount === '12'`, 'Complete file-value collection after navigation');
    assert.equal(await evaluate('trajectoryChecks.renderer.frame.frameIndex'), 11, 'background collection keeps the navigated view');
    const identities = await evaluate('Array.from(trajectoryChecks.renderer.frame.ids)');
    assert.deepEqual(identities, [7, 12]);
    await evaluate('document.getElementById("frame-first").click()');
    await waitFor('trajectoryChecks.renderer.frame.frameIndex === 0', 'Backward seek');
    await evaluate('document.getElementById("frame-play").click()');
    await waitFor('trajectoryChecks.renderer.frame.frameIndex >= 2', 'Double-buffered playback');
    await evaluate('document.getElementById("frame-play").click()');
    const paused = await evaluate('trajectoryChecks.renderer.frame.frameIndex');
    await delay(1_100);
    assert.equal(await evaluate('trajectoryChecks.renderer.frame.frameIndex'), paused);
    assert.equal(await evaluate('document.getElementById("frame-play").getAttribute("aria-pressed")'), 'false');
    await evaluate(`document.querySelector('[data-tool-button="replicate"]').click();
      document.getElementById('replicate-a').value = '2';
      document.getElementById('replicate-atoms').checked = true;
      document.getElementById('apply-replicate').click();`);
    await waitFor('trajectoryChecks.renderer.frame.ids.length === 4', 'Worker physical replication');
    const replicated = await evaluate(`({ids:trajectoryChecks.renderer.frame.ids,
      cell:Array.from(trajectoryChecks.renderer.frame.cell.vectors),
      worker:Boolean(trajectoryChecks.client.replicationWorker),
      budget:trajectoryChecks.client.cpuBudget.limit})`);
    assert.equal(replicated.worker, true);
    assert.equal(replicated.budget, 3);
    assert.deepEqual(replicated.cell, [20, 0, 0, 2, 10, 0, 1, 1, 10]);
    assert.equal(replicated.ids.length, 4);
    await evaluate('document.getElementById("frame-next").click()');
    await waitFor(`trajectoryChecks.renderer.frame.frameIndex === ${paused + 1} && trajectoryChecks.renderer.frame.ids.length === 4`, 'Replicated next frame');
    await evaluate('document.getElementById("reset-replicate").click()');
    await waitFor('trajectoryChecks.renderer.frame.ids.length === 2', 'Source restoration');
    const direct = await evaluate(`(async () => {
      const app = document.querySelector('script[type=module][src]').src;
      const { StructureWorkerClient } = await import(new URL('./worker-client.js', app));
      const { CpuBudget } = await import(new URL('./analysis/cpu-budget.js', app));
      const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 5 } } });
      const client = new StructureWorkerClient(() => {}, { cpuBudget: budget });
      let maximumActive = 0;
      const acquire = budget.acquire.bind(budget);
      budget.acquire = (...args) => acquire(...args).then(lease => { maximumActive = Math.max(maximumActive, budget.active); return lease; });
      const rows = Array.from({length:10000}, (_,index) => 'Fe '+(index%50)/10+' '+(Math.floor(index/50)%50)/10+' '+Math.floor(index/2500)/10+' '+(index+1)).join('\\n');
      const header = 'Lattice="10 0 0 2 10 0 1 1 10" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T"';
      const frame = '10000\\n'+header+'\\n'+rows+'\\n';
      await client.load(new File([frame.repeat(8)], 'parallel.xyz'));
      await client.waitForIndex();
      const first = client.frame(2, { background:true, reportProgress:false });
      const second = client.frame(3, { background:true, reportProgress:false });
      const selected = client.frame(7);
      const results = await Promise.all([first,second,selected]);
      const controller = new AbortController();
      const cancelled = client.frame(6,{background:true,reportProgress:false,signal:controller.signal}).then(()=>false,error=>error.name==='AbortError');
      controller.abort();
      const abortObserved = await cancelled;
      const foreground = await client.frame(4);
      // Hold CPU admission so promotion is observable through the real
      // structure Worker -> parser pool -> page-thread budget protocol.
      const occupied = await budget.acquire(budget.limit);
      const messages = [];
      const post = client.worker.postMessage.bind(client.worker);
      client.worker.postMessage = message => { messages.push(message); return post(message); };
      const navigation = new AbortController();
      const prefetched = client.frame(5, { background:true, reportProgress:false, speculative:true })
        .then(() => false, error => error.name === 'AbortError');
      const series = client.frame(5, { background:true, reportProgress:false });
      const selectedFrame = client.frame(5, { signal:navigation.signal })
        .then(() => false, error => error.name === 'AbortError');
      const deadline = performance.now() + 10000;
      while (!budget.queue.some(request => request.priority === 20) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      const promoted = budget.queue.some(request => request.priority === 20);
      client.cancelPrefetch(); navigation.abort();
      const independentCancellation = await prefetched && await selectedFrame;
      const sharedParses = messages.filter(message => message.type === 'frame' && message.payload.index === 5).length;
      const prematureCancels = messages.filter(message => message.type === 'cancel-frame').length;
      occupied.release();
      const collected = await series;
      client.close();
      return { maximumActive, limit:budget.limit, indices:results.map(result=>result.index),
        atoms:foreground.frame.ids.length, abortObserved, activeAfterClose:budget.active,
        shared:{promoted,independentCancellation,sharedParses,prematureCancels,collected:collected.index} };
    })()`);
    assert.ok(direct.maximumActive >= 2 && direct.maximumActive <= direct.limit, JSON.stringify(direct));
    assert.deepEqual(direct.indices, [2, 3, 7]);
    assert.equal(direct.atoms, 10000);
    assert.equal(direct.abortObserved, true);
    assert.equal(direct.activeAfterClose, 0);
    assert.deepEqual(direct.shared, { promoted:true, independentCancellation:true, sharedParses:1, prematureCancels:0, collected:5 });
    const beforeClose = await evaluate('({loads:trajectoryChecks.loads, requests:trajectoryChecks.frameRequests.length, replicas:trajectoryChecks.replicas.length})');
    await evaluate('document.getElementById("close-file").click()');
    await waitFor('!trajectoryChecks.client.worker && !trajectoryChecks.client.replicationWorker', 'Closing the source releases parser/replication Workers');
    return { ...beforeClose, direct, playbackPausedAt: paused };
  }, { requireGpu: false });
  console.log(JSON.stringify({ result: 'passed', ...result }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
