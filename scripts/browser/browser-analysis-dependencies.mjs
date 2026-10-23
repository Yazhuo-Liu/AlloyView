import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

const source = process.argv.includes('--source'), root = resolve(import.meta.dirname, '../..');
if (!source) assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first, or pass --source.');
// Delaying selected requests controls completion order; after release, the
// application uses its real CPU pool, Wasm kernels, masks and CSV lifecycle.
const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
  const origin = await evaluate('location.origin');
  await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/AlloyView/${source ? '' : 'dist/'}index.html` });
  async function wait(expression, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(35); }
    throw new Error(`${label}: ${await evaluate(`JSON.stringify({binning:document.getElementById('binning-state')?.textContent,binningStatus:document.getElementById('binning-status')?.textContent,surface:document.getElementById('surface-mesh-state')?.textContent,surfaceStatus:document.getElementById('surface-mesh-status')?.textContent,cna:document.getElementById('cna-state')?.textContent,csp:document.getElementById('csp-state')?.textContent,recipe:document.getElementById('configuration-status')?.textContent,toast:document.getElementById('toast')?.textContent})`)}`);
  }
  await wait('document.readyState === "complete" && document.getElementById("run-binning")', 'Page startup');
  // Production modules live under a versioned asset prefix. Instrument the
  // graph actually loaded by this page; an unversioned import is another class.
  const modulePath = await evaluate("new URL('.', document.querySelector('script[type=module][src]').src).pathname.replace(/\\/$/, '')");
  await evaluate(`(async()=>{
    const {WebGLRenderer}=await import('${modulePath}/render/webgl-renderer.js');
    const {AnalysisPool}=await import('${modulePath}/analysis/analysis-pool.js');
    const {DxaClient}=await import('${modulePath}/analysis/dxa-client.js');
    window.dependencyChecks={gates:new Map(),pending:[],started:[],surfaceRequests:[]}; const checks=dependencyChecks;
    const render=WebGLRenderer.prototype.render;WebGLRenderer.prototype.render=function(...args){if(this.canvas.id==='viewport')checks.renderer=this;return render.apply(this,args)};
    const analyze=AnalysisPool.prototype.analyze;AnalysisPool.prototype.analyze=async function(frame,parameters,options={}){
      checks.pool=this;checks.started.push(parameters.kind);
      if(checks.gates.has(parameters.kind))await new Promise((resolve,reject)=>{const entry={kind:parameters.kind,resolve,reject,signal:options.signal};checks.pending.push(entry);const stop=()=>reject(new DOMException('Stopped','AbortError'));options.signal?.addEventListener('abort',stop,{once:true});entry.resolve=()=>{options.signal?.removeEventListener('abort',stop);resolve()};entry.reject=error=>{options.signal?.removeEventListener('abort',stop);reject(error)};if(options.signal?.aborted)stop()});
      const result=await analyze.call(this,frame,parameters,options);
      if(parameters.kind==='cna'&&checks.splitCna)result.structures=Uint8Array.from(frame.ids,(_,atom)=>frame.positions[atom*3]<8?1:3);
      return result;
    };
    const surface=DxaClient.prototype.surface;DxaClient.prototype.surface=function(frame,parameters,options){checks.surfaceRequests.push({frame,mask:options.mask&&Uint8Array.from(options.mask)});return surface.call(this,frame,parameters,options)};
    const createUrl=URL.createObjectURL;URL.createObjectURL=function(blob){if(blob.type==='application/json')checks.configBlob=blob;return createUrl.call(this,blob)};
    checks.change=(id,value,event='change')=>{const element=document.getElementById(id);if(typeof value==='boolean')element.checked=value;else element.value=value;element.dispatchEvent(new Event(event,{bubbles:true}))};
    checks.export=async()=>{checks.configBlob=null;document.getElementById('export-configuration').click();await new Promise(resolve=>setTimeout(resolve,5));return JSON.parse(await checks.configBlob.text())};
    checks.import=config=>{const input=document.getElementById('configuration-file'),files=new DataTransfer();files.items.add(new File([JSON.stringify(config)],'dependency-check.json',{type:'application/json'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}))};
    checks.release=(kind,error=null)=>{checks.gates.delete(kind);const entries=checks.pending.filter(entry=>entry.kind===kind&&!entry.signal?.aborted);checks.pending=checks.pending.filter(entry=>entry.kind!==kind);for(const entry of entries)error?entry.reject(new Error(error)):entry.resolve()};
    checks.frameText=step=>{const rows=[];let id=1;for(let x=0;x<4;x++)for(let y=0;y<4;y++)for(let z=0;z<4;z++)for(const b of [[0,0,0],[.5,.5,0],[.5,0,.5],[0,.5,.5]])rows.push('Cu '+[(x+b[0])*4,(y+b[1])*4,(z+b[2])*4+.5].join(' ')+' '+id++);return [rows.length,'Lattice="16 0 0 0 16 0 0 0 16" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T" Step='+step,...rows,''].join('\\n')};
    checks.open=()=>{const input=document.getElementById('file-input'),files=new DataTransfer();files.items.add(new File([checks.frameText(0)+checks.frameText(1)+checks.frameText(2)],'dependency-fixture.xyz'));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}))};
    document.getElementById('background').dispatchEvent(new Event('input',{bubbles:true}));checks.ready=true;
  })()`);
  await wait('dependencyChecks.ready', 'Check modules');
  await evaluate("if(document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true')document.getElementById('enable-gpu-computing').click();dependencyChecks.open()");
  await wait('dependencyChecks.renderer?.frame && document.getElementById("loading").hidden && document.getElementById("frame-count").textContent === "3"', 'Fixture load');
  await evaluate('(async()=>{dependencyChecks.base=await dependencyChecks.export(); dependencyChecks.missing=structuredClone(dependencyChecks.base);dependencyChecks.missing.settings.extensions.binning={enabled:true,mode:"1d",axes:["a","b"],bins:[8,8],quantity:"property",property:"property:does_not_exist",reduction:"mean",selectionGroupId:null,averageFrames:false,colorScheme:"viridis"};dependencyChecks.import(dependencyChecks.missing)})()');
  await wait('document.getElementById("binning-state").textContent === "Unavailable"', 'Missing quantity terminal state');
  await evaluate("dependencyChecks.change('script-text','wait-analyses','input');document.getElementById('run-script').click()");
  await wait('document.getElementById("script-state").textContent === "Failed"', 'Script rejects missing producer');
  const missing = await evaluate("({binning:document.getElementById('binning-state').textContent,error:document.getElementById('script-error').textContent,runEnabled:!document.getElementById('run-script').disabled})");
  assert.match(missing.error, /Binning: does_not_exist.*No active calculation/); assert.equal(missing.runEnabled, true);
  await evaluate('dependencyChecks.import(dependencyChecks.base)');
  await wait('document.getElementById("binning-state").textContent === "Not calculated"', 'Reset recipe');
  // Enable an actual CSP producer while its request is held, then restore a
  // profile which uses its output; the profile must resume on publication.
  await evaluate("dependencyChecks.gates.set('centrosymmetry',true);dependencyChecks.change('csp-neighbors','12');document.getElementById('run-csp').click()");
  await wait('dependencyChecks.pending.some(entry=>entry.kind==="centrosymmetry"&&!entry.signal.aborted)', 'Held CSP producer');
  await evaluate('(async()=>{dependencyChecks.active=await dependencyChecks.export();dependencyChecks.active.settings.extensions.binning={...dependencyChecks.missing.settings.extensions.binning,property:"property:centralSymmetry"};dependencyChecks.import(dependencyChecks.active)})()');
  await wait('document.getElementById("binning-state").textContent === "Waiting"', 'Profile waits for active producer');
  assert.equal(await evaluate('document.getElementById("binning-results").hidden'), true);
  await evaluate("dependencyChecks.release('centrosymmetry')");
  await wait('document.getElementById("binning-state").textContent === "Calculated"', 'Profile resumes after CSP');
  const resumed = await evaluate("({state:document.getElementById('binning-state').textContent,sourceValues:dependencyChecks.renderer.frame.properties.find(property=>property.name==='centralSymmetry').data.length})");
  assert.equal(resumed.sourceValues, 256);
  // A failed producer has no publication. Its terminal notification must still
  // release the dependent profile and the automation wait.
  await evaluate("dependencyChecks.import(dependencyChecks.base)");
  await wait('document.getElementById("csp-state").textContent === "Not calculated"', 'Clear CSP result');
  await evaluate("dependencyChecks.gates.set('centrosymmetry',true);dependencyChecks.import(dependencyChecks.active)");
  await wait('document.getElementById("binning-state").textContent === "Waiting"', 'Profile waits on failing producer');
  await evaluate("dependencyChecks.release('centrosymmetry','Controlled producer failure')");
  await wait('document.getElementById("csp-state").textContent === "Failed" && document.getElementById("binning-state").textContent === "Unavailable"', 'Failure wakes profile');
  const failure = await evaluate("({producer:document.getElementById('csp-state').textContent,binning:document.getElementById('binning-state').textContent,status:document.getElementById('binning-status').textContent})");
  assert.match(failure.status, /failed/);
  await evaluate('dependencyChecks.import(dependencyChecks.base)');
  await wait('document.getElementById("csp-state").textContent === "Not calculated"', 'Clear failure');
  // Validation can fail before a Worker result or a toast exists. An automatic
  // bond-statistics rerun must still release a profile waiting for Q4.
  await evaluate('(async()=>{dependencyChecks.bondActive=structuredClone(dependencyChecks.base);dependencyChecks.bondActive.settings.extensions.bondStatistics={enabled:true,lengthBins:100,angleBins:180};dependencyChecks.bondActive.settings.extensions.binning={...dependencyChecks.missing.settings.extensions.binning,property:"property:bondQ4"};dependencyChecks.gates.set("bondStatistics",true);dependencyChecks.import(dependencyChecks.bondActive)})()');
  await wait('document.getElementById("binning-state").textContent === "Waiting" && dependencyChecks.pending.some(entry=>entry.kind==="bondStatistics"&&!entry.signal.aborted)', 'Profile waits for bond Q4');
  await evaluate("dependencyChecks.change('bond-statistics-length-bins','0')");
  await wait('document.getElementById("bond-statistics-state").textContent === "Failed" && document.getElementById("binning-state").textContent === "Unavailable"', 'Invalid bond rerun wakes profile');
  const bondFailure = await evaluate("({producer:document.getElementById('bond-statistics-state').textContent,binning:document.getElementById('binning-state').textContent,error:document.getElementById('binning-status').textContent,properties:dependencyChecks.renderer.frame.properties.filter(property=>property.analysisKind==='bondStatistics').length})");
  assert.equal(bondFailure.properties, 0); assert.match(bondFailure.error, /No active calculation/);
  await evaluate("dependencyChecks.release('bondStatistics');dependencyChecks.import(dependencyChecks.base)");
  await wait('document.getElementById("bond-statistics-state").textContent === "Not calculated" && document.getElementById("binning-state").textContent === "Not calculated"', 'Clear invalid bond rerun');
  // Use controlled mixed labels to make the requested display mask exact. The
  // CNA geometry itself and subsequent native surface remain real analyses.
  await evaluate("dependencyChecks.splitCna=true;document.getElementById('run-cna').click()");
  await wait('document.getElementById("cna-state").textContent === "Calculated"', 'Initial classification');
  await evaluate("let checkbox=document.querySelector('#color-legend [data-category-id=\"1\"]');checkbox.checked=false;checkbox.dispatchEvent(new Event('change',{bubbles:true}));dependencyChecks.change('surface-mesh-selection','visible');dependencyChecks.change('surface-mesh-radius','3.5');dependencyChecks.change('surface-mesh-smoothing','0');document.getElementById('run-surface-mesh').click()");
  await wait('document.getElementById("surface-mesh-state").textContent === "Calculated"', 'Initial visible surface');
  const initial = await evaluate('dependencyChecks.surfaceRequests.at(-1).mask.filter(Boolean).length'); assert.equal(initial, 128);
  await evaluate("dependencyChecks.gates.set('cna',true);dependencyChecks.surfaceRequests=[];dependencyChecks.started=[];document.getElementById('frame-next').click()");
  await wait('document.getElementById("surface-mesh-state").textContent === "Waiting" && dependencyChecks.pending.some(entry=>entry.kind==="cna"&&!entry.signal.aborted)', 'Surface awaits new classification');
  assert.equal(await evaluate('dependencyChecks.surfaceRequests.length'), 0, 'visible surface cannot tessellate the interim all-atom mask');
  await evaluate("document.getElementById('run-local-shear').click()");
  await wait('dependencyChecks.started.includes("localShear")', 'Independent local-shear dispatch');
  const concurrent = await evaluate("({surface:document.getElementById('surface-mesh-state').textContent,started:[...dependencyChecks.started],surfaceRequests:dependencyChecks.surfaceRequests.length})");
  assert.equal(concurrent.surface, 'Waiting'); assert.equal(concurrent.surfaceRequests, 0);
  await evaluate("dependencyChecks.release('cna')");
  await wait('document.getElementById("surface-mesh-state").textContent === "Calculated" && dependencyChecks.surfaceRequests.length === 1', 'Filtered surface resumes');
  const surface = await evaluate('({selected:dependencyChecks.surfaceRequests[0].mask.filter(Boolean).length,full:dependencyChecks.surfaceRequests[0].frame.ids.length,frame:document.getElementById("frame-label").textContent})');
  assert.equal(surface.selected, 128); assert.equal(surface.full, 256);
  await evaluate("dependencyChecks.gates.set('cna',true);dependencyChecks.surfaceRequests=[];document.getElementById('frame-next').click()");
  await wait('document.getElementById("surface-mesh-state").textContent === "Waiting"', 'Surface waits on failing classification');
  await evaluate("dependencyChecks.release('cna','Controlled classification failure')");
  await wait('document.getElementById("cna-state").textContent === "Failed" && document.getElementById("surface-mesh-state").textContent === "Failed"', 'Failure wakes visible surface');
  const surfaceFailure = await evaluate("({state:document.getElementById('surface-mesh-state').textContent,status:document.getElementById('surface-mesh-status').textContent,requests:dependencyChecks.surfaceRequests.length})");
  assert.equal(surfaceFailure.requests, 0); assert.match(surfaceFailure.status, /failed/);
  return { result: 'passed', tree: source ? 'source' : 'production', missing, resumed, failure, bondFailure, concurrent, surface, surfaceFailure };
}, { requireGpu: false });
console.log(JSON.stringify(report, null, 2));
