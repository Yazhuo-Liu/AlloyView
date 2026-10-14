import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';
import { crystalFrame, dumpText } from '../tests/helpers/crystals.js';

// Follow the actual content-versioned entry in the built page; no source-tree
// URL, hard-coded asset version or bundle-specific Worker factory is supplied.
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const entryPath = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
assert.match(entryPath ?? '', /^\.\/assets\/[a-f0-9]+\/src\/app\.js$/);
const smallText = dumpText([crystalFrame('fcc', 4, 4.05)]);
const threadedText = dumpText([crystalFrame('fcc', 8, 4.05)]);

async function exercise({ call, evaluate }, { isolated }) {
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {configurable:true,get:()=>5});
    const trace = window.bundleTrace = {workers:[],errors:[],consoleErrors:[]};
    window.addEventListener('error', event => trace.errors.push(event.message));
    const error = console.error.bind(console);
    console.error = (...args) => { trace.consoleErrors.push(args.map(String).join(' ')); error(...args); };
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url, options) {
        super(url, options); trace.workers.push(new URL(url, location.href).href);
        this.addEventListener('error', event => trace.errors.push(event.message || 'Worker error'));
      }
    };
  ` });
  const origin = await evaluate('location.origin');
  await call('Page.navigate', {url:`${origin}/AlloyView/dist/index.html`});
  async function waitFor(expression, label, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(25); }
    throw new Error(`${label}: ${await evaluate('JSON.stringify({trace:bundleTrace,toast:document.getElementById("toast")?.textContent})')}`);
  }
  await waitFor('document.readyState === "complete" && document.querySelector("[data-tool-button=coordination]")', 'Bundled page startup');
  const startup = await evaluate(`(() => {
    const entry = document.querySelector('script[type=module][src]').src;
    const modules = performance.getEntriesByType('resource').filter(r=>r.initiatorType==='script' && /\\.(?:js|mjs)$/.test(new URL(r.name).pathname)).map(r=>r.name);
    return {entry,modules,regularModules:modules.filter(url=>new URL(url).pathname.endsWith('.js')),
      glueModules:modules.filter(url=>new URL(url).pathname.endsWith('.mjs')),isolated:crossOriginIsolated};
  })()`);
  assert.equal(startup.isolated, isolated);
  assert.deepEqual(startup.regularModules, [startup.entry], 'normal page module requests must contain only the bundled app entry');
  assert.ok(startup.entry.includes('/AlloyView/dist/assets/'), 'the built entry must work under a Pages project subpath');
  const manifest = await evaluate(`(async () => {
    const response=await fetch(new URL('../runtime-manifest.json',document.querySelector('script[type=module][src]').src));
    if(!response.ok) throw new Error('Runtime manifest HTTP '+response.status);
    return response.json();
  })()`);
  assert.equal(manifest.version, 1); assert.ok(manifest.moduleFacades > 100);
  const result = await evaluate(`(${runJobs.toString()})(${JSON.stringify({text:isolated ? threadedText : smallText,isolated,entries:manifest.entries.map(item=>item.entry)})})`);
  assert.deepEqual(result.errors, []); assert.deepEqual(result.consoleErrors, []);
  assert.deepEqual(result.notFound, []); assert.equal(result.buffersRetained, true);
  assert.equal(result.identities, true); assert.equal(result.coordination, isolated ? 2048 : 256);
  assert.equal(result.dxa.threads, isolated ? 2 : 1);
  assert.equal(result.dxa.shared, isolated); assert.equal(result.dxa.labels, isolated ? 2048 : 256);
  if (isolated) assert.ok(result.dxa.poolSize >= 1, 'the native shared heap must load at least one actual pthread');
  else {
    assert.equal(result.ptm, 256); assert.equal(result.voronoi, 256); assert.equal(result.grains, 1);
    assert.equal(result.replicated, 512); assert.equal(result.externalProperties, 256); assert.equal(result.csvRows, 256);
    assert.equal(result.selected, 13); assert.equal(result.binned, 256); assert.equal(result.surfaceTriangles, 12);
    assert.equal(result.gpu.backend, 'gpu'); assert.equal(result.gpu.coordination, 256);
    assert.deepEqual(result.executedEntries.toSorted(), manifest.entries.map(item=>item.entry).toSorted());
  }
  return {startupModules:startup.modules.length,ordinaryStartupModules:startup.regularModules.length,
    startupGlueModules:startup.glueModules.map(url=>new URL(url).pathname.split('/').at(-1)),
    manifestEntries:manifest.entries.length,moduleFacades:manifest.moduleFacades,...result};
}

async function runJobs({text,isolated,entries}) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const trace = window.bundleTrace, appUrl = document.querySelector('script[type=module][src]').src;
  const assetRoot = new URL('../', appUrl);
  const namespace = await import(appUrl);
  const modules = await Promise.all(['worker-client.js','analysis/analysis-pool.js','render/webgl-renderer.js','analysis/dxa-client.js']
    .map(path => import(new URL(path, appUrl))));
  const [{StructureWorkerClient},{AnalysisPool},{WebGLRenderer},{DxaClient}] = modules;
  const exported = Object.values(namespace);
  const identities = [StructureWorkerClient,AnalysisPool,WebGLRenderer,DxaClient].every(type => exported.some(module => module?.[type.name] === type));
  check(identities, 'Module facades must expose the app bundle class identities');
  const workerEntries = entries.filter(path=>path!=='src/app.js');
  const nativeFiles = ['ptm-kernel.mjs','ptm-kernel.wasm','voronoi-kernel.mjs','voronoi-kernel.wasm',
    ...(isolated?['dxa-kernel-threaded.mjs','dxa-kernel-threaded.wasm']:['dxa-kernel.mjs','dxa-kernel.wasm'])];
  const statuses = await Promise.all([...workerEntries,...nativeFiles.map(name=>'src/analysis/'+name)].map(async path => {
    const response=await fetch(new URL(path,assetRoot),{method:'HEAD'}); return {path,status:response.status};
  }));
  check(statuses.every(item=>item.status===200),'Every bundled entry/native asset must be published under the same hash');
  // Patch the same facade prototypes used by established integration probes.
  // Opening a structure and running its existing UI analysis captures actual
  // app-owned instances, rather than only constructing stand-alone copies.
  const prepare = StructureWorkerClient.prototype.prepareSource;
  StructureWorkerClient.prototype.prepareSource = function(...args) { trace.appClient=this; return prepare.apply(this,args); };
  const analyze = AnalysisPool.prototype.analyze;
  AnalysisPool.prototype.analyze = function(...args) { trace.appPool=this; return analyze.apply(this,args); };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) { if(this.canvas.id==='viewport') trace.renderer=this; return setFrame.apply(this,args); };
  if(document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true') document.getElementById('enable-gpu-computing').click();
  const sourceFile = new File([text], 'bundle-fcc.dump'), transfer = new DataTransfer(); transfer.items.add(sourceFile);
  document.getElementById('file-input').files=transfer.files;
  document.getElementById('file-input').dispatchEvent(new Event('change',{bubbles:true}));
  async function wait(condition, label) {
    const deadline=performance.now()+60_000;
    while(performance.now()<deadline) { if(condition()) return; await new Promise(resolve=>setTimeout(resolve,10)); }
    throw new Error(label+': '+document.getElementById('toast').textContent);
  }
  await wait(()=>trace.renderer?.frame.ids.length===(isolated?2048:256)&&document.getElementById('loading').hidden,'Bundled structure/parser job');
  document.querySelector('[data-tool-button="coordination"]').click(); document.getElementById('cutoff').value='3'; document.getElementById('run-analysis').click();
  await wait(()=>document.getElementById('analysis-state').textContent==='Calculated','Bundled ordinary analysis Worker');
  check(trace.appClient instanceof StructureWorkerClient && trace.appPool instanceof AnalysisPool && trace.renderer instanceof WebGLRenderer,
    'Facade prototype patches must capture the actual app instances');
  const frame=trace.renderer.frame, budget=trace.appClient.cpuBudget;
  const originals={fractional:frame.fractional.slice(),positions:frame.positions.slice(),ids:frame.ids.slice()};
  const counts=frame.properties.find(property=>property.name==='coordination').data;
  check(counts.every(value=>value===12),'FCC coordination must remain exact');
  const result={identities,coordination:counts.length,executedEntries:['src/app.js','src/workers/structure-worker.js','src/workers/frame-parser-worker.js','src/workers/analysis-worker.js']};
  const dxa=new DxaClient({cpuBudget:budget,workerCount:isolated?2:1});
  await dxa.warmup({atomCount:frame.ids.length,workerCount:isolated?2:1});
  const network=await dxa.analyze(frame,{lattice:'fcc'},{workerCount:isolated?2:1});
  check(network.segments.length===0&&network.atomStructureTypes.every(type=>type===1),'Perfect FCC DXA must return correct labels and no lines');
  result.dxa={threads:network.nativeWorkerCount,shared:network.sharedMemory,poolSize:network.poolSize,labels:network.atomStructureTypes.length,engine:network.engine};
  result.executedEntries.push('src/workers/dxa-worker.js'); dxa.close();
  if(!isolated) {
    const replicated=await trace.appClient.replicate(frame,[2,1,1]); result.replicated=replicated.ids.length;
    result.executedEntries.push('src/workers/replication-worker.js');
    // Exercise the parser entry directly as well as the nested parser selected
    // by the StructureWorker pool; this gives observable entry-path coverage.
    const parser=new Worker(new URL('./workers/frame-parser-worker.js',appUrl),{type:'module'});
    const parsed=await new Promise((resolve,reject)=>{
      parser.addEventListener('error',event=>reject(new Error(event.message)));
      parser.addEventListener('message',({data})=>data.ok?resolve(data.frame):reject(new Error(data.error)));
      parser.postMessage({id:1,type:'parse',descriptor:{file:sourceFile,format:'lammps-dump',index:0}});
    }); parser.terminate(); check(parsed.ids.length===256,'Standalone bundled parser entry must parse every atom');
    const ptm=await trace.appPool.analyze(frame,{kind:'ptm',flags:7,rmsdCutoff:.1,neighborLists:true});
    check(ptm.structures.every(type=>type===1),'Bundled PTM Wasm fit'); result.ptm=ptm.structures.length;
    const voronoi=await trace.appPool.analyze(frame,{kind:'voronoi',bins:8});
    check(voronoi.atomicVolume.every(value=>Math.abs(value-4.05**3/4)<1e-6),'Bundled Voro++ Wasm volume '+JSON.stringify({first:voronoi.atomicVolume[0],min:Math.min(...voronoi.atomicVolume),max:Math.max(...voronoi.atomicVolume),expected:4.05**3/4,cell:Array.from(frame.cell.vectors),backend:voronoi.backend})); result.voronoi=voronoi.atomicVolume.length;
    const extra=await Promise.all(['external-property-worker-client.js','statistics-export-client.js','selection-expansion-client.js',
      'binning-client.js','grains-client.js','render/surface-geometry-client.js','analysis/gpu/client.js'].map(path=>import(new URL(path,appUrl))));
    const [{ExternalPropertyWorkerClient},{StatisticsExportClient},{SelectionExpansionClient},{SpatialBinningClient},
      {GrainSegmentationClient},{SurfaceGeometryClient},{GpuAnalysisClient}]=extra;
    const attrs=new ExternalPropertyWorkerClient();
    const attributesFile=new File(['id,energy\n'+Array.from(frame.ids,(id,index)=>id+','+(index+.5)).join('\n')+'\n'],'energy.csv');
    const imported=await attrs.request('import',{file:attributesFile,frame,importId:'external-bundle-energy',options:{mapping:'id',existingNames:[]}});
    const attached=await attrs.request('attach',{frame,manifests:[imported.manifest],existingNames:[]});
    check(attached.properties[0].data[0]===.5,'Bundled external attribute mapping'); result.externalProperties=attached.properties[0].data.length; attrs.reset();
    result.executedEntries.push('src/workers/external-property-worker.js');
    const stats=new StatisticsExportClient(), csv=await stats.export({fileName:sourceFile.name,frameIndex:0,frame},frame,'atoms');
    result.csvRows=(await csv.blob.text()).trim().split('\r\n').length-1; stats.dispose(); result.executedEntries.push('src/workers/statistics-export-worker.js');
    const selections=new SelectionExpansionClient({cpuBudget:budget}), mask=new Uint8Array(frame.ids.length); mask[0]=1;
    const selected=await selections.expand(frame,mask,{mode:'cutoff',cutoff:3,count:12,iterations:1});
    result.selected=selected.mask.reduce((sum,value)=>sum+value,0); selections.terminate(); result.executedEntries.push('src/workers/selection-worker.js');
    const binning=new SpatialBinningClient({cpuBudget:budget,workerMinAtoms:1}), bins=await binning.accumulate(frame,{axes:[0],bins:[4]});
    result.binned=bins.counts.reduce((sum,value)=>sum+value,0); binning.dispose(); result.executedEntries.push('src/workers/binning-worker.js');
    const grains=new GrainSegmentationClient({cpuBudget:budget}), clustered=await grains.segment({ptm,fractional:frame.fractional,cell:frame.cell},
      {algorithm:'mst',mergeThreshold:1,minGrainSize:1,adoptOrphans:true});
    result.grains=clustered.grainCount; grains.dispose(); result.executedEntries.push('src/workers/grains-worker.js');
    const grainStage=new Worker(new URL('./workers/grains-stage-worker.js',appUrl),{type:'module'});
    try {
      await new Promise((resolve,reject)=>{
        grainStage.addEventListener('error',event=>reject(new Error(event.message)),{once:true});
        grainStage.addEventListener('message',({data})=>data.id===1&&data.ok?resolve():reject(new Error(data.error??'Invalid grain warmup ACK')),{once:true});
        grainStage.postMessage({id:1,warm:true});
      });
    } finally { grainStage.terminate(); }
    result.executedEntries.push('src/workers/grains-stage-worker.js');
    const mesh={vertices:Float64Array.from([8,3,4,2,3,4,8,7,4,2,7,4,8,3,6,2,3,6,8,7,6,2,7,6]),
      triangles:Uint32Array.from([[0,4,6,2],[1,3,7,5],[0,1,5,4],[2,6,7,3],[0,2,3,1],[4,5,7,6]].flatMap(([a,b,c,d])=>[a,b,c,a,c,d]))};
    const geometry=new SurfaceGeometryClient({cpuBudget:budget}), prepared=await geometry.prepare(mesh,frame.cell);
    result.surfaceTriangles=prepared.display.surfaceIndexCount/3;
    check(mesh.vertices.length===24&&mesh.triangles.length===36,'Surface Worker must retain source arrays'); geometry.close(); result.executedEntries.push('src/workers/surface-geometry-worker.js');
    const gpu=new GpuAnalysisClient(), accelerated=await gpu.analyze(frame,{kind:'coordination',cutoff:3},{frameIndex:0});
    check(accelerated.coordination.every(value=>value===12),'Bundled GPU coordination');
    result.gpu={backend:accelerated.backend,coordination:accelerated.coordination.length}; gpu.close(); result.executedEntries.push('src/analysis/gpu/worker.js');
  }
  result.buffersRetained=Object.entries(originals).every(([name,values])=>frame[name].length===values.length&&values.every((value,index)=>Object.is(frame[name][index],value)));
  result.workerUrls=Array.from(new Set(trace.workers)).map(url=>new URL(url).pathname.replace(assetRoot.pathname,''));
  result.notFound=statuses.filter(item=>item.status>=400);
  result.errors=[...trace.errors]; result.consoleErrors=[...trace.consoleErrors];
  document.getElementById('close-file').click();
  await wait(()=>!trace.appClient.worker&&budget.active===0,'Bundled source cleanup');
  result.cpuPermitsAfterClose=budget.active;
  return result;
}

const serial=await withWebGpuBrowser(context=>exercise(context,{isolated:false}),{requireGpu:true});
const threaded=await withWebGpuBrowser(context=>exercise(context,{isolated:true}),{requireGpu:false,isolated:true});
console.log(JSON.stringify({result:'passed',entry:entryPath,serial,threaded},null,2));
