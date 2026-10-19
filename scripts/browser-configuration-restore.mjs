import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cfgText, crystalFrame } from '../tests/helpers/crystals.js';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

const root = resolve(import.meta.dirname, '..'), source = process.argv.includes('--source');
if (!source) assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const fcc = cfgText(crystalFrame('fcc', 3, 4.05)), bcc = cfgText(crystalFrame('bcc', 3, 3.3));
const xyz = count => Array.from({ length: count }, (_, frame) =>
  `2\nLattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T" Step=${frame}\nFe 1 1 1 7\nNi ${5 + frame / 10} 5 5 12\n`).join('');

async function indexBootstrap(moduleUrl) {
  const post = self.postMessage.bind(self), read = Blob.prototype.arrayBuffer;
  let reads = 0, release, ready = false;
  const gate = new Promise(resolve => { release = resolve; }), pending = [];
  Blob.prototype.arrayBuffer = async function() {
    if (this.size > 1024 ** 2 && ++reads === 2) { post({ event:'audit-recipe-index-held' }); await gate; }
    return read.call(this);
  };
  self.addEventListener('message', event => {
    if (event.data.type === 'audit-release-recipe-index') { event.stopImmediatePropagation(); release(); return; }
    if (!ready) { event.stopImmediatePropagation(); pending.push(event.data); }
  });
  await import(moduleUrl); ready = true;
  for (const data of pending.splice(0)) self.dispatchEvent(new MessageEvent('message', {data}));
}

const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable:true, get:()=>5 });
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url, options) {
        if (!String(url).includes('/workers/structure-worker.js')) { super(url, options); return; }
        const bootstrap = '(' + ${JSON.stringify(indexBootstrap.toString())} + ')(' + JSON.stringify(new URL(url, location.href).href) + ')';
        super(URL.createObjectURL(new Blob([bootstrap], {type:'text/javascript'})), options);
        this.addEventListener('message', event => { if (event.data.event==='audit-recipe-index-held') { window.recipeIndexHeld=true;window.recipeIndexWorker=this; } });
      }
    };
  ` });
  const origin = await evaluate('location.origin');
  await call('Page.navigate', { url: `${origin}/AlloyView/${source ? '' : 'dist/'}index.html` });
  async function waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(25); }
    throw new Error(`${label}: ${await evaluate(`JSON.stringify({toast:document.getElementById('toast')?.textContent,
      configuration:document.getElementById('configuration-status')?.textContent,loading:document.getElementById('loading')?.textContent,
      color:document.getElementById('color-mode')?.value,calls:window.recipeChecks?.calls})`)}`);
  }
  await waitFor('document.readyState === "complete" && document.querySelector("[data-tool-button=cna]")', 'Startup');
  await evaluate(`(async () => {
    if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click();
    const app = document.querySelector('script[type=module][src]').src;
    const { createConfiguration } = await import(new URL('./application/configuration.js', app));
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', app));
    const { StructureWorkerClient } = await import(new URL('./data/structure-worker-client.js', app));
    const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
    const p = window.recipeChecks = {calls:[],downloads:[],hold:false,held:false,release:null,indexWaits:0,indexAborts:0};
    const waitIndex = StructureWorkerClient.prototype.waitForIndex;
    StructureWorkerClient.prototype.waitForIndex = function(options) {
      p.indexWaits++;return waitIndex.call(this,options).catch(error=>{if(error.name==='AbortError')p.indexAborts++;throw error;});
    };
    const analyze = AnalysisPool.prototype.analyze;
    AnalysisPool.prototype.analyze = async function(frame, parameters, options) {
      p.calls.push({kind:parameters.kind, cutoff:parameters.cutoff, phase:p.phase});
      if (parameters.kind === 'cna' && p.hold && !p.held) { p.held=true; await new Promise(resolve=>p.release=resolve); }
      return analyze.call(this, frame, parameters, options);
    };
    const setFrame = WebGLRenderer.prototype.setFrame;
    WebGLRenderer.prototype.setFrame = function(...args) { if (this.canvas.id==='viewport') p.renderer=this; return setFrame.apply(this,args); };
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { if (blob.type==='application/json') p.downloads.push(blob); return create(blob); };
    HTMLAnchorElement.prototype.click = function() {};
    p.dispatchFile = (id,file) => { const dt=new DataTransfer();dt.items.add(file);const input=document.getElementById(id);
      input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true})); };
    p.open = (text,name) => { p.file=new File([text],name);p.dispatchFile('file-input',p.file); };
    p.import = settings => { const recipe=createConfiguration({settings:{compute:{gpuEnabled:false},...settings}});
      p.dispatchFile('configuration-file',new File([JSON.stringify(recipe)],'recipe.json')); };
    p.futureFrame = () => { const recipe=createConfiguration({source:{kind:'file',label:p.file.name,format:'xyz',frameIndex:29,frameCount:30,
      files:[{name:p.file.name,size:p.file.size}]},settings:{compute:{gpuEnabled:false}}});
      p.dispatchFile('configuration-file',new File([JSON.stringify(recipe)],'future-frame.json')); };
    p.badFrame = () => { const recipe=createConfiguration({source:{kind:'file',label:p.file.name,format:'cfg',frameIndex:3,frameCount:4,
      files:[{name:p.file.name,size:p.file.size}]},settings:{compute:{gpuEnabled:false}}});
      p.dispatchFile('configuration-file',new File([JSON.stringify(recipe)],'bad-frame.json')); };
    p.edit = (id,value) => { const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('change',{bubbles:true})); };
  })()`);
  async function open(text, name, atomCount, frameCount) {
    await evaluate(`recipeChecks.open(${JSON.stringify(text)},${JSON.stringify(name)})`);
    await waitFor(`document.getElementById('loading').hidden && document.getElementById('atom-count').textContent === '${atomCount}'
      && document.getElementById('file-name').textContent === ${JSON.stringify(name)}
      && document.getElementById('frame-count').textContent === '${frameCount}'`, `Open ${name}`);
  }
  await open(fcc, 'restore-fcc.cfg', 108, 1);
  await evaluate(`recipeChecks.phase='serial';recipeChecks.hold=true;
    recipeChecks.import({display:{colorMode:'property:structureType',radiusPercent:88},analyses:{cna:{enabled:true,mode:'fixed',cutoff:3}}});`);
  await waitFor('recipeChecks.held', 'First recipe analysis held');
  await evaluate(`recipeChecks.import({display:{colorMode:'type',radiusPercent:74},analyses:{cna:{enabled:true,mode:'fixed',cutoff:3.1}}})`);
  await delay(50);
  await evaluate(`recipeChecks.import({display:{colorMode:'property:structureType',radiusPercent:63},analyses:{cna:{enabled:true,mode:'fixed',cutoff:2.8}}})`);
  await delay(250);
  assert.equal(await evaluate('recipeChecks.calls.filter(call=>call.phase==="serial").length'), 1, 'later recipes must not mutate tools while the first is running');
  await evaluate('recipeChecks.hold=false;recipeChecks.release()');
  await waitFor(`document.getElementById('configuration-status').textContent.startsWith('Configuration restored.')
    && document.getElementById('cna-cutoff').value === '2.8' && document.getElementById('cna-state').textContent === 'Calculated'`, 'Latest recipe completion');
  const serial = await evaluate(`({calls:recipeChecks.calls.filter(call=>call.phase==='serial'),color:document.getElementById('color-mode').value,
    radius:document.getElementById('radius-percent').value,labels:[...recipeChecks.renderer.frame.properties.find(p=>p.name==='structureType').data]})`);
  assert.deepEqual(serial.calls.map(call=>call.cutoff), [3, 2.8], 'the intermediate queued recipe is skipped');
  assert.equal(serial.color, 'property:structureType'); assert.equal(serial.radius, '63');
  assert.ok(serial.labels.every(type=>type===0), 'the latest scientific cutoff, not the earlier one, determines every output');

  await evaluate('recipeChecks.badFrame()');
  await waitFor(`document.getElementById('configuration-status').textContent.startsWith('Could not restore configuration:')`, 'A rejected target writes a final failure status');
  await evaluate(`recipeChecks.import({display:{colorMode:'builtin:position:x',radiusPercent:52}})`);
  await waitFor(`document.getElementById('configuration-status').textContent.startsWith('Configuration restored.')
    && document.getElementById('radius-percent').value === '52'`, 'A valid recipe recovers after a rejected target');

  // Source invalidation discards both a running recipe's final publication and
  // every queued recipe before it can start work on the replacement source.
  await evaluate(`recipeChecks.phase='invalidate';recipeChecks.hold=true;recipeChecks.held=false;
    recipeChecks.import({analyses:{cna:{enabled:true,mode:'fixed',cutoff:3}}});`);
  await waitFor('recipeChecks.held', 'Old-source recipe held');
  await evaluate(`recipeChecks.import({display:{radiusPercent:33},analyses:{cna:{enabled:true,mode:'fixed',cutoff:2.8}}})`);
  await delay(50);
  await open(bcc, 'restore-bcc.cfg', 54, 1);
  await evaluate('recipeChecks.hold=false;recipeChecks.release()'); await delay(250);
  const replaced = await evaluate(`({calls:recipeChecks.calls.filter(call=>call.phase==='invalidate'),color:document.getElementById('color-mode').value,
    radius:document.getElementById('radius-percent').value,status:document.getElementById('configuration-status').textContent})`);
  assert.equal(replaced.calls.length, 1); assert.equal(replaced.color, 'type'); assert.equal(replaced.radius, '100');
  assert.match(replaced.status, /interrupted by a new source selection/);

  // Imports, including a direct File-input event, cannot race an active script.
  await evaluate(`document.querySelector('[data-tool-button=scripts]').click();
    if (!document.getElementById('script-name').value) document.getElementById('add-script').click();
    recipeChecks.edit('script-text',${JSON.stringify('wait 0.8\ncamera zoom 1.1')});document.getElementById('script-text').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('run-script').click();`);
  await waitFor(`document.getElementById('script-state').textContent === 'Running…'`, 'Script running');
  await evaluate(`recipeChecks.import({display:{radiusPercent:41}})`);
  await waitFor(`document.getElementById('toast').textContent.includes('running script')`, 'Import refused while automation owns state');
  assert.equal(await evaluate(`document.getElementById('radius-percent').value`), '100');
  await waitFor(`document.getElementById('script-state').textContent === 'Finished'`, 'Refused import leaves the script running normally');
  await evaluate(`recipeChecks.import({display:{radiusPercent:41}})`);
  await waitFor(`document.getElementById('configuration-status').textContent.startsWith('Configuration restored.')
    && document.getElementById('radius-percent').value==='41'`, 'Import works after automation releases its lock');

  await open(xyz(8), 'long.xyz', 2, 8);
  await evaluate(`document.querySelector('[data-tool-button=timeSeries]').click();
    recipeChecks.edit('time-series-first','5');recipeChecks.edit('time-series-last','8');recipeChecks.edit('time-series-stride','2');
    recipeChecks.edit('time-series-strain-reference','5');document.getElementById('export-configuration').click();`);
  const long = await evaluate('(async()=>JSON.parse(await recipeChecks.downloads.at(-1).text()))()');
  assert.equal(long.settings.extensions.timeSeries.firstFrame, 4);
  assert.equal(long.settings.extensions.globalAttributes.strainReferenceFrame, 4);
  await open(xyz(3), 'short.xyz', 2, 3);
  await evaluate(`document.getElementById('export-configuration').click()`);
  const short = await evaluate('(async()=>JSON.parse(await recipeChecks.downloads.at(-1).text()))()');
  assert.equal(short.source.frameCount, 3);
  assert.equal(short.settings.extensions.timeSeries.firstFrame, 0);
  assert.equal(short.settings.extensions.timeSeries.lastFrame, null);
  assert.equal(short.settings.extensions.timeSeries.stride, 2, 'chart preferences survive a source replacement');
  assert.equal(short.settings.extensions.globalAttributes?.strainReferenceFrame ?? 0, 0);
  const controls = await evaluate(`({first:document.getElementById('time-series-first').value,
    last:document.getElementById('time-series-last').value,reference:document.getElementById('time-series-strain-reference').value})`);
  assert.deepEqual(controls, {first:'1',last:'3',reference:'1'});
  // A superseded recipe waiting for a future frame releases its subscriber,
  // while the source index itself remains alive and resumes when released.
  await evaluate(`(() => {
    const header='Lattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T"';
    const trajectory=Array.from({length:30},(_,frame)=>'2\\n'+header+' Step='+frame+(frame===7?' padding='+'x'.repeat(6*1024**2):'')+'\\nFe 1 1 1 7\\nNi 5 5 5 12\\n').join('');
    recipeChecks.open(trajectory,'progressive-restore.xyz');
  })()`);
  await waitFor(`window.recipeIndexHeld && document.getElementById('frame-count').textContent === '7+' && document.getElementById('loading').hidden`, 'Progressive source remains usable before full indexing');
  const waits = await evaluate('recipeChecks.indexWaits');
  await evaluate('recipeChecks.futureFrame()');
  await waitFor(`recipeChecks.indexWaits > ${waits}`, 'Recipe waiting for the real source index');
  await evaluate(`recipeChecks.import({display:{radiusPercent:47}})`);
  await waitFor(`document.getElementById('configuration-status').textContent.startsWith('Configuration restored.')
    && document.getElementById('radius-percent').value === '47'`, 'New recipe supersedes an index wait without waiting for index completion');
  assert.equal(await evaluate('document.getElementById("frame-count").textContent'), '7+');
  assert.ok(await evaluate('recipeChecks.indexAborts') > 0);
  await evaluate(`recipeIndexWorker.postMessage({type:'audit-release-recipe-index'})`);
  await waitFor(`document.getElementById('frame-count').textContent === '30'`, 'Cancelling a recipe does not cancel background source indexing');
  await evaluate(`document.getElementById('close-file').click()`);
  const closed = await evaluate(`({first:document.getElementById('time-series-first').value,
    last:document.getElementById('time-series-last').value,reference:document.getElementById('time-series-strain-reference').value})`);
  assert.deepEqual(closed, {first:'1',last:'1',reference:'1'});
  return { hosting: source ? 'source' : 'production Pages subpath', serialCalls:serial.calls.map(call=>call.cutoff),
    latestColor:serial.color, latestRadius:serial.radius, invalidatedCalls:replaced.calls.length,
    failureRecovery:true, automationImportGuard:true, progressiveWaitCancellation:true, shorterSource:controls, closedSourceBounds:closed };
}, { requireGpu:false });
console.log(JSON.stringify(report, null, 2));
