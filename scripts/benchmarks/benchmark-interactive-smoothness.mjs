import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Run revisions serially in a quiet browser window. --root may point to an
// archived/built baseline; its own harness serves its own production assets.
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const root = resolve(argument('--root', resolve(import.meta.dirname, '../..')));
const label = argument('--label', 'candidate');
const output = resolve(argument('--output', `/tmp/alloyview-smoothness-performance-${label}.json`));
const compareIndex = process.argv.indexOf('--compare');
if (compareIndex >= 0) {
  const [before, after] = await Promise.all(process.argv.slice(compareIndex + 1, compareIndex + 3).map(async path => JSON.parse(await readFile(resolve(path), 'utf8'))));
  assert.ok(before && after, '--compare requires baseline and candidate JSON files');
  const changes = {};
  for (const key of ['scalarNeighbor', 'scalarRandom', 'controlledCna']) {
    changes[key] = { before: before.summary[key], after: after.summary[key] };
  }
  const combined = { date: '2026-10-25', method: 'Serial production Chromium runs using the same benchmark script. Software SwiftShader; draw submission timings, not physical GPU/display latency. Controlled CNA delays verify presentation behavior, not scientific compute speed.',
    changes, unrelatedCsp: { before: before.summary.unrelatedCsp, after: after.summary.unrelatedCsp },
    cancellation: { before: before.cancellation, after: after.cancellation }, baseline: before, candidate: after };
  await writeFile(output, JSON.stringify(combined, null, 2) + '\n');
  console.log(JSON.stringify({ output, changes, unrelatedCsp: combined.unrelatedCsp, cancellation: combined.cancellation }, null, 2));
  process.exit(0);
}
const atoms = Number(argument('--atoms', '50000'));
const samples = Number(argument('--samples', '24'));
const frameCount = 10;
const controlledSamples = 6;
const diagnostic = process.argv.includes('--diagnostic');
assert.ok(Number.isInteger(atoms) && atoms >= 1000 && atoms <= 250000);
assert.ok(Number.isInteger(samples) && samples >= 8 && samples <= 100);
await readFile(resolve(root, 'dist/index.html'));
const { withWebGpuBrowser } = await import(pathToFileURL(resolve(root, 'scripts/lib/webgpu-browser.mjs')));

const result = await withWebGpuBrowser(async ({ evaluate, call }) => {
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installWorkerCounter.toString()})()` });
  const origin = await evaluate('location.origin');
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
  async function wait(expression, name, timeout = 120000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(15);
    }
    throw new Error(`${name}: ${await evaluate(`JSON.stringify({
      frame:window.smoothBenchmark?.renderer?.frame?.frameIndex,
      presented:window.smoothBenchmark?.renderer?.presentedFrame?.frameIndex,
      pending:window.smoothBenchmark?.pending.map(x=>({kind:x.kind,index:x.index,aborted:x.signal?.aborted})),
      sample:window.smoothBenchmark?.active,
      cna:document.getElementById('cna-state')?.textContent,
      csp:document.getElementById('csp-state')?.textContent,
      toast:document.getElementById('toast')?.textContent})`)}`);
  }
  const memory = async () => {
    const heap = await call('Runtime.getHeapUsage');
    return { ...heap, ...(await evaluate('performance.memory ? {usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize,jsHeapSizeLimit:performance.memory.jsHeapSizeLimit} : {}')) };
  };
  await wait('document.readyState==="complete" && document.getElementById("frame-jump-go")', 'Startup');
  assert.equal(await evaluate('Array.isArray(window.benchmarkWorkers) && navigator.hardwareConcurrency===8'), true, 'startup Worker/cpu instrumentation installed');
  await evaluate(`(${installBenchmark.toString()})()`);
  const runtime = await evaluate('document.querySelector("script[type=module][src]").src');
  await evaluate('if(document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true")document.getElementById("enable-gpu-computing").click()');

  // Imported scalar colors separate display/seek work from analysis time.
  await evaluate(`smoothBenchmark.open(${atoms},${frameCount},'scalar')`);
  await wait(`smoothBenchmark.renderer?.frame?.ids.length===${atoms} && document.getElementById('frame-count').textContent==='${frameCount}' && document.getElementById('loading').hidden`, 'Scalar trajectory');
  await evaluate('smoothBenchmark.change("color-mode","property:energy")');
  await wait('!smoothBenchmark.pool?.cpuBudget.active && !smoothBenchmark.pool?.cpuBudget.queue.length', 'Initial CPU preparation');
  await delay(150);
  const scalarMemoryBefore = await memory();
  // Visit each frame first. Both revisions then measure the same cached seeks;
  // prefetch/result policies remain enabled throughout the benchmark.
  for (let index = 1; index < frameCount; index++) {
    await evaluate(`smoothBenchmark.startSeek(${index},'warm')`);
    await wait('!smoothBenchmark.active', `Warm scalar ${index}`);
  }
  const scalar = [];
  if (diagnostic) { await call('Profiler.enable'); await call('Profiler.setSamplingInterval', { interval: 1000 }); await call('Profiler.start'); }
  for (let sample = 0; sample < samples; sample++) {
    const current = await evaluate('smoothBenchmark.renderer.frame.frameIndex');
    const neighbor = sample < samples / 2;
    let target = neighbor ? (current + 1) % frameCount : (sample * 7 + 3) % frameCount;
    if (target === current) target = (target + 3) % frameCount;
    await evaluate(`smoothBenchmark.startSeek(${target},${JSON.stringify(neighbor ? 'cached-neighbor' : 'cached-random')})`);
    await wait('!smoothBenchmark.active', `Scalar sample ${sample}`);
    scalar.push(await evaluate('smoothBenchmark.samples.at(-1)'));
  }
  const scalarMemoryAfter = await memory();
  const scalarWorkers = await evaluate('smoothBenchmark.workerSnapshot()');
  if (diagnostic) {
    const { profile } = await call('Profiler.stop');
    const browser = await call('Browser.getVersion');
    const shape = await evaluate('(()=>{const r=smoothBenchmark.renderer;return{canvas:[r.canvas.width,r.canvas.height],cssCanvas:[r.canvas.clientWidth,r.canvas.clientHeight],atomCount:r.atomCount,displayAtomCount:r.displayAtomCount,camera:{yaw:r.yaw,pitch:r.pitch,distance:r.distance,projection:r.projectionMode,radiusScale:r.radiusScale},appearance:document.getElementById("viewport").parentElement.dataset.appearanceState??null}})()');
    return {runtime,browser,shape,scalar:{samples:scalar,memoryBefore:scalarMemoryBefore,memoryAfter:scalarMemoryAfter,workers:scalarWorkers},profile,longTasks:await evaluate('smoothBenchmark.longTasks'),glError:await evaluate('smoothBenchmark.renderer.gl.getError()')};
  }

  // Gate only completion order. Actual CNA/CSP kernels run after release;
  // the deliberate 100ms hold is not a scientific-compute speed comparison.
  await evaluate('document.getElementById("close-file").click();smoothBenchmark.holdAnalyses=true;smoothBenchmark.released.clear();smoothBenchmark.open(10976,8,"controlled-cna")');
  await wait('smoothBenchmark.renderer?.frame?.ids.length===10976 && document.getElementById("frame-count").textContent==="8" && document.getElementById("loading").hidden', 'Controlled trajectory');
  await evaluate('smoothBenchmark.change("csp-neighbors","12");document.getElementById("run-csp").click()');
  await wait('document.getElementById("csp-state").textContent==="Calculated"', 'Initial CSP');
  await evaluate('document.getElementById("run-cna").click()');
  await wait('document.getElementById("cna-state").textContent==="Calculated"', 'Initial CNA');
  await evaluate(`smoothBenchmark.change('color-mode','property:structureType');const box=document.querySelector('#color-legend [data-category-id="1"]');if(!box)throw new Error('FCC checkbox missing');box.checked=false;box.dispatchEvent(new Event('change',{bubbles:true}));smoothBenchmark.remember();`);
  await delay(80);
  const controlled = [], unrelated = [];
  const cnaMemoryBefore = await memory();
  for (let index = 1; index <= controlledSamples; index++) {
    await evaluate(`smoothBenchmark.startSeek(${index},'controlled-cna')`);
    await wait(`smoothBenchmark.pending.some(x=>x.index===${index}&&x.kind==='cna'&&!x.signal?.aborted&&!x.settled)`, `Held CNA ${index}`);
    await delay(100);
    await evaluate(`smoothBenchmark.release(${index},'cna')`);
    await wait('!smoothBenchmark.active', `Final CNA appearance ${index}`);
    controlled.push(await evaluate('smoothBenchmark.samples.at(-1)'));
    await evaluate(`smoothBenchmark.startUnrelated(${index});smoothBenchmark.release(${index},'centrosymmetry')`);
    await wait('document.getElementById("csp-state").textContent==="Calculated"', `CSP ${index}`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    unrelated.push(await evaluate('smoothBenchmark.finishUnrelated()'));
  }
  const cnaMemoryAfter = await memory();
  const cnaWorkers = await evaluate('smoothBenchmark.workerSnapshot()');
  await evaluate('document.getElementById("close-file").click();smoothBenchmark.holdAnalyses=false;smoothBenchmark.releaseAll()');
  await wait('document.getElementById("file-input") && document.getElementById("frame-jump-input").disabled', 'Close fixture');
  await wait('!smoothBenchmark.pool?.cpuBudget.active && !smoothBenchmark.pool?.cpuBudget.queue.length', 'CPU idle before parser probe');
  await delay(100);
  const cancellation = await evaluate('smoothBenchmark.parserCancellationProbe()');
  await delay(100);
  const longTasks = await evaluate('smoothBenchmark.longTasks');
  const browser = await call('Browser.getVersion');
  return { runtime, browser, graphics: await evaluate('(()=>{const gl=smoothBenchmark.renderer.gl,extension=gl.getExtension("WEBGL_debug_renderer_info");return{vendor:extension?gl.getParameter(extension.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)}})()'), navigator: await evaluate('({hardwareConcurrency:navigator.hardwareConcurrency,userAgent:navigator.userAgent,deviceMemory:navigator.deviceMemory})'),
    scalar: { requestedAtoms: atoms, frameCount, samples: scalar, memoryBefore: scalarMemoryBefore, memoryAfter: scalarMemoryAfter, workers: scalarWorkers },
    controlledCna: { atoms: 10976, samples: controlled, unrelatedCompletions: unrelated, holdMs: 100, memoryBefore: cnaMemoryBefore, memoryAfter: cnaMemoryAfter, workers: cnaWorkers },
    cancellation, longTasks, glError: await evaluate('smoothBenchmark.renderer.gl.getError()') };
}, { requireGpu: false, software: true, isolated: process.argv.includes('--isolated') });
assert.equal(result.glError, 0);
if (diagnostic) {
  for (const row of result.scalar.samples) {
    const frame=row.setFrameEvents[0],draw=row.renderEvents.find(event=>event.presented===row.target);
    row.phases={inputToSetFrameStartMs:frame?frame.started-row.inputAt:null,setFrameDurationMs:frame?frame.finished-frame.started:null,
      setFrameEndToTargetRenderStartMs:frame&&draw?draw.started-frame.finished:null,targetRenderCpuMs:draw?draw.finished-draw.started:null,
      renderCallsUntilFinalAppearance:row.renderEvents.length};
  }
  const nodes = new Map(result.profile.nodes.map(node=>[node.id,node]));
  const parents = new Map();
  for (const node of result.profile.nodes) for (const child of node.children??[]) parents.set(child,node.id);
  const snapshotFunctions=new Set(['captureSteps','indexIds','copyLegend','remapLegend']);
  const snapshotNode=node=>node.callFrame.url.includes('/render/appearance-snapshot.js')||snapshotFunctions.has(node.callFrame.functionName);
  const snapshotNodesPresent=result.profile.nodes.some(snapshotNode);
  const attribution = { appearanceSnapshotUs:snapshotNodesPresent?0:null,idleUs:0,gcUs:0,otherSamplesUs:0,
    appearanceAttributionNote:'Sampled inclusive attribution, matching the original module URL or its unique function names in the production app.js bundle; null means the profiler did not identify a snapshot node, not proof of zero work.' };
  for (let index=0;index<(result.profile.samples?.length??0);index++) {
    let node=nodes.get(result.profile.samples[index]),snapshot=false;
    const duration=result.profile.timeDeltas?.[index]??0,name=node?.callFrame.functionName??'';
    if(name==='(idle)')attribution.idleUs+=duration;
    else if(name==='(garbage collector)')attribution.gcUs+=duration;
    else {
      while(node){if(snapshotNode(node))snapshot=true;node=nodes.get(parents.get(node.id));}
      if(snapshot)attribution.appearanceSnapshotUs+=duration;else attribution.otherSamplesUs+=duration;
    }
  }
  const report={date:'2026-10-25',label,source:argument('--commit',label),method:'Supplemental8-seek50k-atomscalar diagnostic; sameproductionUI andSwiftShader. CallsandCPUprofileinstrumented; original24/6 resultartifact preserved. CPUprofileattribution is sampled, not an exact capture() stopwatch.',...result,profileAttribution:attribution};
  await writeFile(output.replace(/\.json$/, '')+'.cpuprofile',JSON.stringify(result.profile)+'\n');
  delete report.profile;
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,label,runtime:report.runtime,shape:report.shape,profileAttribution:attribution,samples:report.scalar.samples},null,2));
  process.exit(0);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted.length ? Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(3)) : null;
}
function summary(rows) {
  const times = field => Object.fromEntries([['p50',.5],['p95',.95],['p99',.99]].map(([name,fraction])=>[name,percentile(rows.map(row=>row[field]).filter(Number.isFinite),fraction)]));
  const tasks = result.longTasks.filter(task => rows.some(row => task.startTime < row.finishedAt && task.startTime + task.duration > row.inputAt));
  return { count: rows.length, firstTargetDrawSubmittedMs: times('firstTargetDrawSubmittedMs'), finalSelectedAppearanceDrawSubmittedMs: times('finalSelectedAppearanceDrawSubmittedMs'),
    fallbackFlashFrames: rows.reduce((total,row)=>total+row.fallbackFlashFrames,0), previewFrames: rows.reduce((total,row)=>total+row.previewFrames,0),
    atomColorUploads: rows.reduce((total,row)=>total+row.uploads.colors.count,0), atomColorUploadBytes: rows.reduce((total,row)=>total+row.uploads.colors.bytes,0),
    atomVisibilityUploads: rows.reduce((total,row)=>total+row.uploads.visibility.count,0), atomVisibilityUploadBytes: rows.reduce((total,row)=>total+row.uploads.visibility.bytes,0),
    longTasksOver50ms: tasks.length, longestTaskMs: tasks.length ? Math.max(...tasks.map(task=>task.duration)) : 0 };
}
const report = { date:'2026-10-25', label, source:argument('--commit', label==='baseline'?'2b80367':'working tree'),
  method: { production:true, softwareGpu:true, physicalGpuBenchmark:false, cpuAnalyses:true, analysisGpuEnabled:false, reportedHardwareConcurrency:8,
    drawTiming:'Input event to end of the actual target viewport render() call. Measures submitted draws; no gl.finish/fence and no promise of physical display latency.',
    uploadScope:'Actual main atom RGB/visibility WebGL bufferData and bufferSubData calls, including frame uploads. Optional primitive/overlay buffers are excluded.',
    memoryScope:'Chromium Runtime.getHeapUsage and performance.memory; excludes GPU memory, native/Wasm allocator reservations and Blob backing storage unless Chromium reports them separately.',
    cancellationScope:'Separate direct production FrameParserPool probe in the same browser, not a UI seek. Worker ACK includes any remaining Blob read, numeric chunk and message transport; immediate client rejection is measured separately.',
    controlledCna:'100ms held completions, then real CPU CNA/CSP. These values verify continuity and upload behavior; do not interpret the artificial delay as calculation speed.',
    statistics:'Nearest-rank percentiles; 24 scalar seeks and 6 controlled CNA seeks by default. Small samples and shared-host/SwiftShader noise limit timing conclusions.' },
  ...result,
  summary: { scalarNeighbor:summary(result.scalar.samples.filter(row=>row.kind==='cached-neighbor')), scalarRandom:summary(result.scalar.samples.filter(row=>row.kind==='cached-random')),
    controlledCna:summary(result.controlledCna.samples), unrelatedCsp: { completions:result.controlledCna.unrelatedCompletions.length,
      colorUploads:result.controlledCna.unrelatedCompletions.reduce((sum,row)=>sum+row.uploads.colors.count,0),
      colorBytes:result.controlledCna.unrelatedCompletions.reduce((sum,row)=>sum+row.uploads.colors.bytes,0),
      visibilityUploads:result.controlledCna.unrelatedCompletions.reduce((sum,row)=>sum+row.uploads.visibility.count,0),
      visibilityBytes:result.controlledCna.unrelatedCompletions.reduce((sum,row)=>sum+row.uploads.visibility.bytes,0) } } };
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,label,runtime:report.runtime,summary:report.summary,cancellation:report.cancellation},null,2));

function installWorkerCounter() {
  Object.defineProperty(Navigator.prototype,'hardwareConcurrency',{configurable:true,get:()=>8});
  const NativeWorker=Worker;
  window.benchmarkWorkers=[];
  window.benchmarkWorkerRows=new WeakMap();
  window.Worker=class extends NativeWorker {
    constructor(...args) {
      super(...args);
      const row={id:benchmarkWorkers.length,url:String(args[0]),created:performance.now(),terminated:false};
      benchmarkWorkers.push(row);benchmarkWorkerRows.set(this,row);
      const terminate=this.terminate.bind(this);
      this.terminate=()=>{row.terminated=true;row.terminatedAt=performance.now();return terminate();};
    }
  };
}

async function installBenchmark() {
  const app=document.querySelector('script[type=module][src]').src;
  const [{WebGLRenderer},{AnalysisPool},{StructureWorkerClient},{FrameParserPool},{CpuBudget}]=await Promise.all([
    import(new URL('./render/webgl-renderer.js',app)),import(new URL('./analysis/analysis-pool.js',app)),
    import(new URL('./data/structure-worker-client.js',app)),import(new URL('./data/frame-parser-pool.js',app)),import(new URL('./analysis/cpu-budget.js',app))]);
  const checks=window.smoothBenchmark={samples:[],pending:[],released:new Set(),longTasks:[],active:null,unrelated:null,holdAnalyses:false,sequence:0};
  const uploadCounts=()=>({colors:{count:0,bytes:0},visibility:{count:0,bytes:0}});
  const digest=array=>{let sum=0,weighted=0;for(let i=0;i<(array?.length??0);i++){sum+=array[i];weighted+=(i+1)*array[i];}return [sum,weighted];};
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>value===b[index]);
  if(PerformanceObserver.supportedEntryTypes.includes('longtask')){
    checks.observer=new PerformanceObserver(list=>checks.longTasks.push(...list.getEntries().map(entry=>({startTime:entry.startTime,duration:entry.duration}))));
    checks.observer.observe({type:'longtask',buffered:true});
  }
  const bind=new WeakMap();
  for(const prototype of [WebGLRenderingContext?.prototype,WebGL2RenderingContext?.prototype].filter(Boolean)){
    const bindBuffer=prototype.bindBuffer;
    prototype.bindBuffer=function(target,buffer){let values=bind.get(this);if(!values)bind.set(this,values=new Map());values.set(target,buffer);return bindBuffer.call(this,target,buffer);};
    for(const method of ['bufferData','bufferSubData']){
      const original=prototype[method];
      prototype[method]=function(...args){
        const renderer=checks.renderer,buffer=bind.get(this)?.get(args[0]);
        const field=this===renderer?.gl?(buffer===renderer.colorBuffer?'colors':buffer===renderer.visibilityBuffer?'visibility':null):null;
        const recording=checks.active??checks.unrelated;
        if(field&&recording){const data=args[method==='bufferData'?1:2],offset=args[method==='bufferData'?3:3]??0,length=args[4];
          const bytes=typeof data==='number'?data:length!==undefined?length*(data.BYTES_PER_ELEMENT??1):Math.max(0,(data?.byteLength??0)-offset*(data?.BYTES_PER_ELEMENT??1));
          recording.uploads[field].count++;recording.uploads[field].bytes+=bytes;}
        return original.apply(this,args);
      };
    }
  }
  const frame=WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame=function(...args){
    if(this.canvas.id==='viewport')checks.renderer=this;
    const sample=checks.active,started=performance.now(),result=frame.apply(this,args);
    if(this===checks.renderer&&sample&&args[0].frameIndex===sample.target)sample.setFrameEvents.push({started,finished:performance.now()});
    return result;
  };
  const render=WebGLRenderer.prototype.render;
  WebGLRenderer.prototype.render=function(...args){
    const started=performance.now(),result=render.apply(this,args),sample=checks.active;
    if(this!==checks.renderer||!sample)return result;
    const presented=this.presentedFrame??this.frame,view=this.presentedRenderer??this;
    sample.renderEvents.push({started,finished:performance.now(),presented:presented?.frameIndex});
    if(presented?.frameIndex!==sample.target)return result;
    const now=performance.now(),appearance=this.canvas.parentElement.dataset.appearanceState??null;
    if(sample.firstTargetDrawSubmittedMs===null)sample.firstTargetDrawSubmittedMs=now-sample.inputAt;
    const field=checks.quantity==='cna'?'structureType':'energy';
    const formal=presented.properties.some(property=>property.name===field)&&!['preview','waiting','held','pending'].includes(appearance)&&!this.sceneUpdate;
    if(!formal){
      sample.previewFrames++;
      if(checks.remembered&&(!equal(digest(view.atomColors),checks.remembered.colors)||view.visibility.filter(Boolean).length!==checks.remembered.visible))sample.fallbackFlashFrames++;
    }
    if(formal){sample.finalSelectedAppearanceDrawSubmittedMs=now-sample.inputAt;sample.finishedAt=now;checks.samples.push(sample);checks.active=null;}
    return result;
  };
  const prepare=StructureWorkerClient.prototype.prepareSource;
  StructureWorkerClient.prototype.prepareSource=function(...args){checks.client=this;return prepare.apply(this,args);};
  const warm=AnalysisPool.prototype.warmupCpu;
  AnalysisPool.prototype.warmupCpu=function(...args){checks.pool=this;return warm.apply(this,args);};
  const analyze=AnalysisPool.prototype.analyze;
  AnalysisPool.prototype.analyze=async function(frame,parameters,options={}){
    checks.pool=this;
    const key=frame.frameIndex+':'+parameters.kind;
    if(checks.holdAnalyses&&frame.frameIndex>0&&['cna','centrosymmetry'].includes(parameters.kind)&&!checks.released.has(key))await new Promise((resolve,reject)=>{
      const entry={kind:parameters.kind,index:frame.frameIndex,signal:options.signal,settled:false};checks.pending.push(entry);
      const stop=()=>{entry.settled=true;reject(new DOMException('Stopped','AbortError'));};
      options.signal?.addEventListener('abort',stop,{once:true});
      entry.resolve=()=>{entry.settled=true;options.signal?.removeEventListener('abort',stop);resolve();};
      if(options.signal?.aborted)stop();
    });
    return analyze.call(this,frame,parameters,options);
  };
  checks.release=(index,kind)=>{checks.released.add(index+':'+kind);for(const entry of checks.pending.filter(entry=>entry.index===index&&entry.kind===kind&&!entry.settled&&!entry.signal?.aborted))entry.resolve();};
  checks.releaseAll=()=>{for(const entry of checks.pending.filter(entry=>!entry.settled&&!entry.signal?.aborted))entry.resolve();};
  checks.change=(id,value)=>{const input=document.getElementById(id);input.value=String(value);input.dispatchEvent(new Event('change',{bubbles:true}));};
  checks.open=(count,frames,name)=>{
    checks.quantity=name==='controlled-cna'?'cna':'scalar';checks.remembered=null;
    const n=Math.ceil(Math.cbrt(count/4)),length=n*3.6,rows=[];let id=1;
    for(let x=0;x<n&&rows.length<count;x++)for(let y=0;y<n&&rows.length<count;y++)for(let z=0;z<n&&rows.length<count;z++)for(const b of [[0,0,0],[.5,.5,0],[.5,0,.5],[0,.5,.5]]){
      if(rows.length<count)rows.push({id:id++,position:[(x+b[0])*3.6,(y+b[1])*3.6,(z+b[2])*3.6]});
    }
    const text=Array.from({length:frames},(_,step)=>[
      count,`Lattice="${length} 0 0 0 ${length} 0 0 0 ${length}" pbc="T T T" Step=${step} Properties=species:S:1:pos:R:3:id:I:1:energy:R:1`,
      ...rows.map(atom=>'Cu '+atom.position.map(value=>(value+step*.05).toFixed(5)).join(' ')+' '+atom.id+' '+(Math.sin(atom.id*.1)+step*.01).toFixed(5)),''
    ].join('\n')).join('');
    const transfer=new DataTransfer();transfer.items.add(new File([text],name+'.xyz'));
    const input=document.getElementById('file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    checks.loadedStructureWorker=null;
  };
  checks.startSeek=(target,kind)=>{
    if(!checks.loadedStructureWorker)checks.loadedStructureWorker=checks.client.worker;
    checks.active={id:++checks.sequence,target,kind,inputAt:performance.now(),firstTargetDrawSubmittedMs:null,finalSelectedAppearanceDrawSubmittedMs:null,
      previewFrames:0,fallbackFlashFrames:0,uploads:uploadCounts(),setFrameEvents:[],renderEvents:[]};
    document.getElementById('frame-jump-input').value=String(target+1);document.getElementById('frame-jump-go').click();
  };
  checks.remember=()=>{checks.remembered={colors:digest(checks.renderer.atomColors),visible:checks.renderer.visibility.filter(Boolean).length};};
  checks.startUnrelated=index=>{checks.unrelated={index,inputAt:performance.now(),uploads:uploadCounts()};};
  checks.finishUnrelated=()=>{const value=checks.unrelated;checks.unrelated=null;return value;};
  checks.workerSnapshot=()=>({structureWorkerRetained:checks.client.worker===checks.loadedStructureWorker,
    workers:benchmarkWorkers.map(row=>({...row})),cpuPermits:checks.pool?.cpuBudget.active,cpuLimit:checks.pool?.limit,cpuWarmup:checks.pool?.cpuWarmupStatus});
  checks.parserCancellationProbe=async()=>{
    const budget=new CpuBudget({environment:{navigator:{hardwareConcurrency:3}}}),workers=[],replies=[],messages=[];
    const pool=new FrameParserPool({acquire:({signal,priority})=>budget.acquire(1,{signal,priority}),workerFactory:()=>{
      const worker=new Worker(new URL('./workers/frame-parser-worker.js',app),{type:'module'});workers.push(worker);
      const post=worker.postMessage.bind(worker);worker.postMessage=(message,...rest)=>{messages.push({id:message.id,type:message.type??'parse',time:performance.now()});return post(message,...rest);};
      worker.addEventListener('message',({data})=>replies.push({id:data.id,ok:data.ok,name:data.name,time:performance.now()}));return worker;
    }});
    try{
      await pool.warm();
      const count=500000,text=count+'\nProperties=species:S:1:pos:R:3:id:I:1\n'+Array.from({length:count},(_,i)=>'Fe 1 2 3 '+(i+1)+'\n').join('');
      const controller=new AbortController(),request=pool.parse({format:'xyz',file:new File([text],'cancel.xyz'),index:50},{signal:controller.signal});
      const rejected=request.catch(error=>({name:error.name,time:performance.now()}));
      await new Promise(resolve=>setTimeout(resolve,5));const abortedAt=performance.now();controller.abort();const rejection=await rejected;
      const permitsImmediatelyAfterCancel=budget.active;
      const next=await pool.parse({format:'xyz',file:new File(['2\nProperties=species:S:1:pos:R:3:id:I:1\nFe 1 2 3 1\nFe 2 3 4 2\n'],'next.xyz'),index:150});
      const nextFinishedAt=performance.now(),cancel=messages.find(message=>message.type==='cancel-parser');
      const ack=replies.find(reply=>reply.id===cancel?.id&&reply.time>=cancel.time);
      return{atoms:count,callerRejectionMs:rejection.time-abortedAt,workerAckMs:ack?ack.time-abortedAt:null,
        nextForegroundReadyMs:nextFinishedAt-abortedAt,ackOk:ack?.ok,ackName:ack?.name??null,workersCreated:workers.length,warmWorkerReused:workers.length===1,
        permitsImmediatelyAfterCancel,permitsAfterCompletion:budget.active,nextFrameIndex:next.frameIndex};
    }finally{pool.close();}
  };
}
