import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuRuntime } from '../src/analysis/gpu/runtime.js';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { prepareGpuVoronoi, voronoiGpuInitialRadius, voronoiGpuWorkspaceBytes } from '../src/analysis/gpu/voronoi.js';
import { VORONOI_INITIALIZE_SHADER, VORONOI_CLIP_SHADER } from '../src/analysis/gpu/voronoi-shaders.js';
import { COORDINATION_SHADER } from '../src/analysis/gpu/coordination.js';
import { crystalFrame } from './helpers/crystals.js';
import { frameUploadBytes } from '../src/analysis/gpu/cache-policy.js';

// Host scheduling/resource tests. Real dispatch parity is checked by
// scripts/browser-voronoi-gpu.mjs, including load-style frame preparation.
function fixture({ beforeCompile, afterRun } = {}) {
  const runtime = new GpuRuntime(), allocations = [], compiled = [], runs = [], scopes = [];
  const device = { limits:{maxBufferSize:256*1024**2,maxStorageBufferBindingSize:256*1024**2},
    queue:{writeBuffer(){},async onSubmittedWorkDone(){}},
    createBuffer({size}) { const buffer={size,destroyed:false,destroy(){this.destroyed=true;}}; allocations.push(buffer);return buffer; },
    pushErrorScope(kind){scopes.push(kind);},async popErrorScope(){scopes.pop();return null;},
    createShaderModule({code}){return {code};},createBindGroupLayout(options){return options;},createPipelineLayout(options){return options;},
    async createComputePipelineAsync(options){compiled.push(options.compute.module.code);await beforeCompile?.(options.compute.module.code);return {};},destroy(){} };
  runtime.device=device; runtime.adapterInfo={isFallbackAdapter:true};
  runtime.initialize=async signal=>{if(signal?.aborted)throw new DOMException('Cancelled','AbortError');return device;};
  runtime.run=async (source,bindings,count,options={})=>{runs.push({source,bindings,count,options});await afterRun?.(source,options);};
  runtime.read=async (_buffer,Type,length)=>new Type(length);
  return {runtime,allocations,compiled,runs,scopes};
}
const nextTick = () => new Promise(resolve=>setTimeout(resolve,0));
async function until(test) { for(let attempt=0;attempt<200;attempt++){if(test())return;await nextTick();}assert.fail('timed out'); }

test('targeted GPU warmup shares just four Voronoi/index pipelines without allocating frame or unrelated workspaces', async () => {
  const {runtime,compiled,allocations}=fixture();
  try {
    const status=await runtime.warmup({analysisKinds:['voronoi']});
    assert.equal(status.pipelineCount,4);assert.equal(compiled.length,4);assert.equal(allocations.length,0);
    assert.ok(runtime.pipelines.has(VORONOI_CLIP_SHADER));
    await runtime.warmup({analysisKinds:['voronoi','voronoi']}); assert.equal(compiled.length,4);
    await runtime.warmup();
    // The full warmup also prepares the radical (radius-weighted) clipping kernel.
    assert.equal(compiled.length,24);assert.equal(compiled.filter(source=>source===VORONOI_CLIP_SHADER).length,1);
    await assert.rejects(runtime.warmup({analysisKinds:['ptm']}),/analysisKinds/);
  } finally {runtime.close();}
});

test('load-time preparation primes source indexing and one discarded cell, and repeats without uploads, allocations or dispatches', async () => {
  const {runtime,compiled,allocations,runs}=fixture(), frame=crystalFrame('fcc',2), source=frame.fractional.slice();
  frame.gpuFrameId=101;runtime.configureCache({frameCount:1,currentIndex:0});
  try {
    const progress=[], status=await runtime.prepareFrame(frame,{frameIndex:0,analysisKinds:['voronoi'],onProgress:value=>progress.push(value)});
    assert.equal(status.uploadCount,1);assert.equal(status.neighborIndexBuildCount,1);assert.equal(status.voronoiKernelWarmupCount,1);
    assert.deepEqual(status.preparedVoronoiFrameIds,[101]);assert.deepEqual(status.preparedVoronoiFrameIndexes,[0]);
    assert.equal(status.voronoiWorkspaceAtoms,32);assert.ok(voronoiGpuWorkspaceBytes(status.voronoiWorkspaceAtoms)<32*1024**2);
    assert.equal(runtime.indexes.get(`101:${voronoiGpuInitialRadius(prepareGpuVoronoi(frame))}`).frameKey,101);
    const cellRuns=runs.filter(run=>[VORONOI_INITIALIZE_SHADER,VORONOI_CLIP_SHADER].includes(run.source));
    assert.equal(cellRuns.length,2);assert.ok(cellRuns.every(run=>run.count===1&&run.options.endAtom===1));
    assert.equal(status.atomicVolume,undefined);assert.equal(status.faceOffsets,undefined,'preparation returns no scientific result');
    assert.deepEqual(progress.map(value=>value.phase),['preparing-neighbors','warming-kernels','prepared']);
    const workspace=runtime.voronoiWorkspace,index=[...runtime.indexes.values()][0], uploadCount=runtime.inputUploads,
      allocationCount=allocations.length,runCount=runs.length;
    await runtime.prepareFrame(frame,{frameIndex:0,analysisKinds:['voronoi']});
    assert.equal(allocations.length,allocationCount);assert.equal(runs.length,runCount);assert.equal(runtime.inputUploads,uploadCount);
    assert.equal(runtime.voronoiWorkspace,workspace);assert.equal([...runtime.indexes.values()][0],index);assert.equal(compiled.length,4);
    assert.deepEqual(frame.fractional,source);
    runtime.clearIndexes();assert.deepEqual(runtime.cacheStatus().preparedVoronoiFrameIds,[],'evicted index invalidates readiness');
    await runtime.prepareFrame(frame,{frameIndex:0,analysisKinds:['voronoi']});
    assert.equal(runtime.cacheStatus().neighborIndexBuildCount,2);assert.equal(runtime.voronoiWorkspace,workspace);assert.equal(compiled.length,4);
    runtime.disposeBuffers(workspace.buffers);runtime.voronoiWorkspace=null;
    assert.deepEqual(runtime.cacheStatus().preparedVoronoiFrameIndexes,[],'released scratch invalidates readiness');
    await runtime.prepareFrame(frame,{frameIndex:0,analysisKinds:['voronoi']});assert.notEqual(runtime.voronoiWorkspace,workspace);
    runtime.clearFrames();assert.equal(runtime.allocatedBytes,0);assert.deepEqual(runtime.cacheStatus().preparedVoronoiFrameIds,[]);
    assert.equal(runtime.pipelines.size,4,'source clear retains warmed pipelines');
  } finally {runtime.close();}
  assert.ok(allocations.every(buffer=>buffer.destroyed));
});

test('cancelling shared targeted compilation releases the wait promptly while foreground compilation remains independent', async () => {
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const {runtime,compiled,scopes}=fixture({beforeCompile:source=>source===VORONOI_CLIP_SHADER?blocked:undefined});
  const controller=new AbortController();
  try {
    const warming=runtime.warmup({analysisKinds:['voronoi'],signal:controller.signal});
    const cancelled=assert.rejects(warming,{name:'AbortError'});
    await until(()=>compiled.includes(VORONOI_CLIP_SHADER));controller.abort();await cancelled;
    assert.equal(scopes.length,0,'background native compilation retains no error scopes');
    await runtime.compilePipeline(COORDINATION_SHADER);assert.ok(runtime.pipelines.has(COORDINATION_SHADER));
    assert.equal(compiled.filter(source=>source===VORONOI_CLIP_SHADER).length,1);
    release();await runtime.warmup({analysisKinds:['voronoi']});assert.equal(compiled.length,5);
  } finally {release();runtime.close();}
});

test('trajectory capacity reserves the actual resident hardware Voronoi batch instead of only the generic workspace estimate', async () => {
  const {runtime}=fixture(),frame=crystalFrame('fcc',8),budgetBytes=128*1024**2;
  runtime.adapterInfo={isFallbackAdapter:false};frame.gpuFrameId=103;
  runtime.configureCache({frameCount:2000,currentIndex:0,budgetBytes});
  try {
    const status=await runtime.prepareFrame(frame,{frameIndex:0,analysisKinds:['voronoi']});
    assert.equal(runtime.voronoiWorkspace.capacity,2048);
    assert.equal(runtime.voronoiWorkspace.bytes,voronoiGpuWorkspaceBytes(2048));
    assert.ok(runtime.voronoiWorkspace.bytes>32*1024**2);
    assert.equal(status.workspaceBytes,runtime.voronoiWorkspace.bytes);
    assert.equal(status.frameBudgetBytes,budgetBytes-runtime.voronoiWorkspace.bytes);
    assert.equal(status.capacity,Math.floor(status.frameBudgetBytes/frameUploadBytes(frame)));
    assert.ok(status.allocatedBytes<=budgetBytes);
  } finally {runtime.close();}
});

test('full warmup cancellation frees its task while shared pipelines finish without blocking a targeted request', async () => {
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const {runtime,compiled}=fixture({beforeCompile:source=>source===COORDINATION_SHADER?blocked:undefined});
  const controller=new AbortController();
  try {
    const warming=runtime.warmup({signal:controller.signal}),cancelled=assert.rejects(warming,{name:'AbortError'});
    await until(()=>compiled.includes(COORDINATION_SHADER));controller.abort();await cancelled;
    await runtime.warmup({analysisKinds:['voronoi']});assert.ok(runtime.pipelines.has(VORONOI_CLIP_SHADER));
    release();await runtime.warmup();
    // The full warmup also prepares the radical (radius-weighted) clipping kernel.
    assert.equal(compiled.length,24);assert.equal(compiled.filter(source=>source===VORONOI_CLIP_SHADER).length,1);
  } finally {release();runtime.close();}
});

test('cancelled one-cell driver warmup preserves bounded resources and publishes readiness only after a complete retry', async () => {
  const controller=new AbortController();let abortOnce=true;
  const {runtime,runs,allocations}=fixture({afterRun:source=>{if(abortOnce&&source===VORONOI_INITIALIZE_SHADER){abortOnce=false;controller.abort();}}});
  const frame=crystalFrame('bcc',2);frame.gpuFrameId=102;
  try {
    await assert.rejects(runtime.prepareFrame(frame,{analysisKinds:['voronoi'],signal:controller.signal}),{name:'AbortError'});
    assert.deepEqual(runtime.cacheStatus().preparedVoronoiFrameIds,[]);assert.equal(runtime.inputUploads,1);
    assert.equal(runs.filter(run=>run.source===VORONOI_CLIP_SHADER).length,0);
    const capacity=runtime.voronoiWorkspace.capacity,allocated=allocations.length;
    const status=await runtime.prepareFrame(frame,{analysisKinds:['voronoi']});
    assert.deepEqual(status.preparedVoronoiFrameIds,[102]);assert.equal(status.voronoiWorkspaceAtoms,capacity);
    assert.equal(allocations.length,allocated);assert.equal(runtime.inputUploads,1);
  } finally {runtime.close();}
});

class FakeWorker {
  constructor(){this.messages=[];this.listeners=new Map();}
  addEventListener(type,callback){this.listeners.set(type,callback);}
  postMessage(message){this.messages.push(message);}
  answer(message,extra={}){this.listeners.get('message')({data:{id:message.id,ok:true,...extra}});}
  terminate(){this.terminated=true;}
}

test('client keeps full warmup behind foreground analyses and separates targeted readiness from general readiness', async () => {
  const worker=new FakeWorker(),client=new GpuAnalysisClient({environment:{navigator:{gpu:{}}},workerFactory:()=>worker}),frame=crystalFrame('fcc',2);
  try {
    const targeted=client.warmup({analysisKinds:['voronoi']});await until(()=>worker.messages.length===1);
    assert.deepEqual(worker.messages[0].options.analysisKinds,['voronoi']);worker.answer(worker.messages[0]);await targeted;
    await client.warmup({analysisKinds:['voronoi']});assert.equal(worker.messages.length,1);
    const general=client.warmup(),cancelled=assert.rejects(general,{name:'AbortError'});await until(()=>worker.messages.length===2);
    const warmRequest=worker.messages[1], foreground=client.analyze(frame,{kind:'cna'});
    await cancelled;assert.equal(worker.messages.at(-1).type,'cancel');
    worker.answer(warmRequest,{ok:false,name:'AbortError',error:'preempted'});await until(()=>worker.messages.some(message=>message.type==='analyze'));
    worker.answer(worker.messages.at(-1),{result:{backend:'gpu'}});await foreground;
    const preparation=client.prepareFrame(frame,{frameIndex:0,analysisKinds:['voronoi']});await until(()=>worker.messages.at(-1).type==='prepare-frame');
    assert.deepEqual(worker.messages.at(-1).options.analysisKinds,['voronoi']);
    worker.answer(worker.messages.at(-1),{cacheStatus:{preparedVoronoiFrameIds:[1],preparedVoronoiFrameIndexes:[0]}});await preparation;
    const status=client.cacheStatus;status.preparedVoronoiFrameIndexes.push(999);
    assert.deepEqual(client.cacheStatus.preparedVoronoiFrameIndexes,[0]);
  } finally {client.close();}
});
