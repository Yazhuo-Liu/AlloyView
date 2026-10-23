import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

const root = resolve(import.meta.dirname, '../..'), source = process.argv.includes('--source');
if (!source) assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-progressive-series-'));
const file = resolve(directory, 'progressive.xyz');
// A large comment, rather than a large atom array, crosses the real indexer's
// 4 MiB read boundary after seven frames. Gate only that subsequent read.
const header = 'Lattice="10 0 0 2 10 0 1 1 10" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T"';
await writeFile(file, Array.from({ length: 30 }, (_, frame) => `2\n${header} Step=${frame * 10}${frame === 7 ? ' padding=' + 'x'.repeat(6 * 1024 ** 2) : ''}\nFe ${frame / 10} 0 0 7\nNi 5 5 5 12\n`).join(''));

async function progressiveBootstrap(moduleUrl) {
  const post = self.postMessage.bind(self), read = Blob.prototype.arrayBuffer;
  let reads = 0, releaseIndex, completed = false, ready = false;
  const indexGate = new Promise(resolve => { releaseIndex = resolve; });
  const held = [], pending = [];
  Blob.prototype.arrayBuffer = async function() {
    if (this.size > 1024 ** 2 && ++reads === 2) { post({ event:'audit-index-gated' }); await indexGate; }
    return read.call(this);
  };
  self.postMessage = (message, ...args) => {
    if (message.event === 'source-info' && message.result.indexComplete && !completed) {
      held.push([message, args]); post({ event:'audit-completion-held', result:message.result });
    } else post(message, ...args);
  };
  self.addEventListener('message', event => {
    if (event.data.type === 'audit-release-index') { event.stopImmediatePropagation(); releaseIndex(); return; }
    if (event.data.type === 'audit-release-completion') {
      event.stopImmediatePropagation(); completed = true;
      for (const [message, args] of held.splice(0)) post(message, ...args);
      return;
    }
    if (!ready) { event.stopImmediatePropagation(); pending.push(event.data); }
  });
  await import(moduleUrl);
  ready = true;
  for (const data of pending.splice(0)) self.dispatchEvent(new MessageEvent('message', {data}));
}

try {
  const result = await withWebGpuBrowser(async ({ call, evaluate }) => {
    await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable:true, get:()=>5 });
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(url, options) {
          if (!String(url).includes('/workers/structure-worker.js')) { super(url, options); return; }
          const absolute = new URL(url, location.href).href;
          const bootstrap = '(' + ${JSON.stringify(progressiveBootstrap.toString())} + ')(' + JSON.stringify(absolute) + ')';
          super(URL.createObjectURL(new Blob([bootstrap], {type:'text/javascript'})), options);
        }
      };
    ` });
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url:`${origin}/AlloyView/${source ? '' : 'dist/'}index.html` });
    async function waitFor(expression, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(25); }
      throw new Error(`${label}: ${await evaluate(`JSON.stringify({toast:document.getElementById('toast')?.textContent,count:document.getElementById('frame-count')?.textContent,cache:document.getElementById('cache-label')?.textContent,series:document.getElementById('time-series-status')?.textContent,audit:window.progressiveChecks && {gated:progressiveChecks.gated,held:progressiveChecks.held,notices:progressiveChecks.notices.slice(-4)}})`)}`);
    }
    await waitFor('document.readyState === "complete" && document.querySelector("[data-tool-button=timeSeries]")', 'Application startup');
    await evaluate(`(async () => {
      if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click();
      const app = document.querySelector('script[type=module][src]').src;
      const { StructureWorkerClient } = await import(new URL('./data/structure-worker-client.js', app));
      const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
      const checks = window.progressiveChecks = { notices:[], requests:[], downloads:[], gated:false, held:false, phase:'series', beforeComplete:true };
      const prepare = StructureWorkerClient.prototype.prepareSource;
      StructureWorkerClient.prototype.prepareSource = function(...args) { checks.client = this; return prepare.apply(this, args); };
      const handle = StructureWorkerClient.prototype.handleMessage;
      StructureWorkerClient.prototype.handleMessage = function(message, worker) {
        if (message.event === 'audit-index-gated') { checks.gated = true; checks.gatedWorker = worker; return; }
        if (message.event === 'audit-completion-held') { checks.held = true; checks.gatedWorker = worker; return; }
        if (message.event === 'source-info') checks.notices.push({ count:message.result.frameCount, complete:message.result.indexComplete, phase:checks.phase });
        return handle.call(this, message, worker);
      };
      const read = StructureWorkerClient.prototype.frame;
      StructureWorkerClient.prototype.frame = function(index, options) {
        const request = {index, background:Boolean(options?.background), phase:checks.phase, beforeComplete:checks.beforeComplete};
        checks.requests.push(request);
        return read.call(this, index, options).then(value => {
          if (request.phase === 'prefetch' && request.index === 1 && request.beforeComplete) throw new Error('Audit transient speculative failure');
          return value;
        });
      };
      const set = WebGLRenderer.prototype.setFrame;
      WebGLRenderer.prototype.setFrame = function(...args) { if (this.canvas.id === 'viewport') checks.renderer = this; return set.apply(this, args); };
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob.type === 'application/json') checks.downloads.push(blob); return create(blob); };
      HTMLAnchorElement.prototype.click = function() {};
    })()`);
    const { root:dom } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId:dom.nodeId, selector:'#file-input' });
    async function open() {
      await call('DOM.setFileInputFiles', { nodeId, files:[file] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor('progressiveChecks.gated && progressiveChecks.renderer?.frame.frameIndex === 0 && document.getElementById("frame-count").textContent === "7+" && document.getElementById("loading").hidden', 'First frame available while real indexing is gated');
    }
    await open();
    await evaluate(`document.querySelector('[data-tool-button="timeSeries"]').click();
      const edit = (id,value) => { const input=document.getElementById(id); input.value=value; input.dispatchEvent(new Event('change',{bubbles:true})); };
      edit('time-series-first','2'); edit('time-series-last','5'); edit('time-series-stride','2');
      edit('time-series-x-axis','timestep');
      document.getElementById('time-series-separate').checked=true; document.getElementById('time-series-separate').dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('export-configuration').click();`);
    const exported = await evaluate('(async()=>JSON.parse(await progressiveChecks.downloads.at(-1).text()))()');
    const settings = exported.settings.extensions.timeSeries;
    assert.deepEqual(settings, { attributes:['Cell.volume'], firstFrame:1, lastFrame:4, stride:2, xAxis:'timestep', separatePanels:true, autoCollect:false });
    await evaluate(`(() => {
      const edit = (id,value) => { const input=document.getElementById(id); input.value=value; input.dispatchEvent(new Event('change',{bubbles:true})); };
      edit('time-series-first','1'); edit('time-series-last','7'); edit('time-series-stride','1'); edit('time-series-x-axis','frame');
      document.getElementById('time-series-separate').checked=false; document.getElementById('time-series-separate').dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('collect-time-series').click();
    })()`);
    await waitFor('!document.getElementById("cancel-time-series").disabled && /Preparing the trajectory index/.test(document.getElementById("time-series-status").textContent)', 'Collection waits for the real index');
    // Cancel just the reader's wait, then retry while the source keeps indexing.
    await evaluate('document.getElementById("cancel-time-series").click()');
    await waitFor('document.getElementById("time-series-state").textContent === "Cancelled"', 'Index wait cancelled');
    await evaluate('document.getElementById("collect-time-series").click(); progressiveChecks.gatedWorker.postMessage({type:"audit-release-index"})');
    await waitFor('progressiveChecks.held && document.getElementById("frame-count").textContent === "30+"', 'Full count published before terminal notification');
    await waitFor('document.getElementById("time-series-state").textContent === "Complete" && document.querySelector("#time-series-chart path[data-series=\\"Cell.volume\\"]")?.dataset.pointCount === "30"', 'All thirty file values collected after index completion');
    const collection = await evaluate(`({first:document.getElementById('time-series-first').value,last:document.getElementById('time-series-last').value,
      maximum:document.getElementById('time-series-last').max,state:document.getElementById('time-series-state').textContent,
      count:document.querySelector('#time-series-chart path[data-series="Cell.volume"]').dataset.pointCount,view:progressiveChecks.renderer.frame.frameIndex,
      budget:progressiveChecks.client.cpuBudget.limit,status:document.getElementById('time-series-status').textContent})`);
    assert.equal(collection.last, '30'); assert.equal(collection.maximum, '30'); assert.equal(collection.view, 0); assert.equal(collection.budget, 3);
    await evaluate('progressiveChecks.beforeComplete=false; progressiveChecks.gatedWorker.postMessage({type:"audit-release-completion"})');
    await waitFor('document.getElementById("frame-count").textContent === "30"', 'Unchanged-count completion delivered');
    // Import the actual saved nondefault, uncollected recipe; no atom arrays
    // or series results are serialized to achieve this round trip.
    await evaluate(`(async () => {
      const transfer=new DataTransfer(); transfer.items.add(new File([await progressiveChecks.downloads[0].text()],'series.json',{type:'application/json'}));
      document.getElementById('configuration-file').files=transfer.files;
      document.getElementById('configuration-file').dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor('document.getElementById("time-series-first").value === "2" && document.getElementById("time-series-last").value === "5" && document.getElementById("time-series-stride").value === "2" && document.getElementById("configuration-status").textContent.includes("restored")', 'Saved range, axis and panel settings restored');
    const restored = await evaluate(`({axis:document.getElementById('time-series-x-axis').value,separate:document.getElementById('time-series-separate').checked,
      running:!document.getElementById('cancel-time-series').disabled,maximum:document.getElementById('time-series-last').max})`);
    assert.deepEqual(restored, {axis:'timestep',separate:true,running:false,maximum:'30'});

    // Reload with one transient prefetch failure. The last partial notice and
    // terminal notice both have count 30. A completion-only restart must fill
    // the one missing frame using the still retained parser source.
    await evaluate('progressiveChecks.phase="prefetch"; progressiveChecks.gated=false; progressiveChecks.held=false; progressiveChecks.beforeComplete=true');
    await open();
    await waitFor('/cached 6 \\/ 7/.test(document.getElementById("cache-label").textContent)', 'Initial partial-index prefetch completes with one missing frame');
    await evaluate('progressiveChecks.gatedWorker.postMessage({type:"audit-release-index"})');
    await waitFor('progressiveChecks.held && document.getElementById("frame-count").textContent === "30+" && /cached 29 \\/ 30/.test(document.getElementById("cache-label").textContent)', 'Idle prefetch fills frames added during indexing');
    const before = await evaluate('progressiveChecks.requests.filter(r=>r.phase==="prefetch"&&r.index===1).length');
    await evaluate('progressiveChecks.beforeComplete=false; progressiveChecks.gatedWorker.postMessage({type:"audit-release-completion"})');
    await waitFor('document.getElementById("frame-count").textContent === "30" && /cached 30 \\/ 30/.test(document.getElementById("cache-label").textContent)', 'Same-count completion restarts idle prefetch');
    const prefetch = await evaluate(`({cache:document.getElementById('cache-label').textContent,
      attempts:progressiveChecks.requests.filter(r=>r.phase==='prefetch'&&r.index===1).length,
      transitions:progressiveChecks.notices.filter(r=>r.phase==='prefetch').slice(-2),view:progressiveChecks.renderer.frame.frameIndex})`);
    assert.ok(prefetch.attempts > before);
    assert.deepEqual(prefetch.transitions, [{count:30,complete:false,phase:'prefetch'},{count:30,complete:true,phase:'prefetch'}]);
    assert.equal(prefetch.view, 0);
    await evaluate('document.getElementById("close-file").click()');
    await waitFor('!progressiveChecks.client.worker && progressiveChecks.client.cpuBudget.active === 0', 'Source close releases active reader leases');
    return {collection,exportedSettings:settings,restored,prefetch};
  }, { requireGpu:false });
  console.log(JSON.stringify({result:'passed',tree:source?'source':'production',...result}, null, 2));
} finally { await rm(directory, {recursive:true,force:true}); }
