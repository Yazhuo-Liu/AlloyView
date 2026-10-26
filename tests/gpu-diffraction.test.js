import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDiffraction, evaluateDiffractionReflection, calculateDiffractionRange } from '../src/analysis/diffraction.js';
import { analyzeGpuDiffraction, prepareGpuDiffraction, releaseGpuDiffraction, warmGpuDiffraction, packDiffractionBatch } from '../src/analysis/gpu/diffraction.js';
import { DIFFRACTION_STRUCTURE_FACTORS_SHADER } from '../src/analysis/gpu/diffraction-shaders.js';
import { crystalFrame } from './helpers/crystals.js';

function prepared(kind='bcc',repeat=1) {
  const frame=crystalFrame(kind,repeat,4);frame.typeLabels=['Fe'];
  return prepareDiffraction(frame,{maxAngle:75,useThermal:false});
}

// These mocks exercise host packing, corrections and ownership. Actual WGSL
// scientific parity is checked by scripts/browser/browser-diffraction-gpu.mjs.
function fixture(source,{onRead,onRun}={}) {
  const allocations=[],compiled=[],dispatches=[];
  const runtime={device:{limits:{maxComputeWorkgroupsPerDimension:65535}},async initialize(){},
    async compilePipeline(shader){compiled.push(shader);},reserveWorkspace(){},
    createBuffer(bytes){const buffer={data:new Uint8Array(bytes),destroyed:false};allocations.push(buffer);return buffer;},
    storageBuffer(array){const buffer=this.createBuffer(array.byteLength);this.write(buffer,array);return buffer;},
    write(buffer,array){buffer.data.set(new Uint8Array(array.buffer,array.byteOffset,array.byteLength));},
    disposeBuffers(buffers){for(const buffer of buffers)if(buffer)buffer.destroyed=true;},
    async run(shader,bindings,invocations,options){
      assert.equal(shader,DIFFRACTION_STRUCTURE_FACTORS_SHADER);dispatches.push({invocations,options});
      const config=new Uint32Array(bindings[0].data.buffer),reflections=new Float32Array(bindings[4].data.buffer);
      const output=new Float32Array(bindings[6].data.buffer);output.fill(0);
      for(let local=0;local<config[2];local++){
        const h=reflections.subarray(local*12,local*12+3);
        const index=source.s2.findIndex((_,i)=>h.every((v,a)=>v===source.hkls[i*3+a]));
        assert.ok(index>=0);const exact=evaluateDiffractionReflection(source,index);
        output.set([exact.real,exact.imag,exact.amplitudeBound,0],local*config[3]*4);
      }
      onRun?.(output,config);
    },
    async read(buffer,Type,length,{signal}={}){onRead?.();if(signal?.aborted)throw new DOMException('Cancelled','AbortError');return new Type(buffer.data.buffer.slice(0,length*Type.BYTES_PER_ELEMENT));}
  };
  return {runtime,allocations,compiled,dispatches};
}

test('diffraction GPU warmup compiles without source uploads and cancellation releases its waiter',async()=>{
  const f=fixture(prepared());await warmGpuDiffraction(f.runtime);
  assert.deepEqual(f.compiled,[DIFFRACTION_STRUCTURE_FACTORS_SHADER]);assert.equal(f.allocations.length,0);
  const controller=new AbortController();f.runtime.compilePipeline=()=>new Promise(()=>{});
  const pending=warmGpuDiffraction(f.runtime,{signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
});

test('diffraction retains precise wrapped residuals and reuses atom buffers across reflection edits',async()=>{
  const source=prepared(),f=fixture(source);source.fractional[0]=0.1234567890123;
  const first=await prepareGpuDiffraction(f.runtime,source);
  const high=new Float32Array(first.cache.inputs[0].data.buffer),low=new Float32Array(first.cache.inputs[1].data.buffer);
  assert.ok(Math.abs(high[0]+low[0]-source.fractional[0])<1e-11);
  assert.equal(high[0]*4096,Math.floor(high[0]*4096));
  assert.equal((await prepareGpuDiffraction(f.runtime,{...source,hkls:source.hkls.slice()})).inputReused,true);
  const next=await prepareGpuDiffraction(f.runtime,{...source,fractional:source.fractional.slice()});
  assert.equal(next.inputReused,false);assert.ok(first.cache.inputs.every(buffer=>buffer.destroyed));
  releaseGpuDiffraction(f.runtime);assert.ok(f.allocations.every(buffer=>buffer.destroyed));
});

test('uncertain and genuinely weak diffraction reflections are recomputed in f64, never clipped to zero',async()=>{
  const frame=crystalFrame('bcc',1,4);frame.typeLabels=['Fe'];
  frame.properties=[{name:'occupancy',data:Float64Array.from([1,1-1e-8])}];
  const source=prepareDiffraction(frame,{maxAngle:75,useThermal:false}),f=fixture(source),before=source.fractional.slice();
  const result=await analyzeGpuDiffraction(f.runtime,source),expected=calculateDiffractionRange(source);
  const weak=source.s2.findIndex((_,i)=>Math.abs(source.hkls[i*3]+source.hkls[i*3+1]+source.hkls[i*3+2])%2===1);
  assert.ok(weak>=0&&result.correctedReflections>0&&result.correctedReflections<source.reflectionCount);
  assert.ok(result.intensity[weak]>0);assert.equal(result.intensity[weak],expected.intensity[weak]);
  assert.deepEqual(source.fractional,before);
  const allocations=f.allocations.length;assert.equal((await analyzeGpuDiffraction(f.runtime,source)).inputReused,true);
  assert.equal(f.allocations.length,allocations);releaseGpuDiffraction(f.runtime);assert.ok(f.allocations.every(buffer=>buffer.destroyed));
});

test('diffraction GPU batches preserve reflection ranges and bound atom-chunk workspace',async()=>{
  const source=prepared('bcc',7),f=fixture(source),start=2,end=Math.min(100,source.reflectionCount);
  const result=await analyzeGpuDiffraction(f.runtime,source,{start,end});
  assert.equal(result.start,start);assert.equal(result.end,end);assert.equal(result.real.length,end-start);
  assert.ok(f.dispatches.every(({invocations})=>invocations/128<=65535));
  assert.ok(f.allocations.every(buffer=>buffer.data.length<1024*1024));releaseGpuDiffraction(f.runtime);
});

test('GPU diffraction numerical limits reject unsafe encodings and preserve a valid resident source',async()=>{
  const source=prepared(),f=fixture(source),first=await prepareGpuDiffraction(f.runtime,source);
  const large={...source,hkls:source.hkls.slice()};large.hkls[0]=1025;
  assert.throws(()=>packDiffractionBatch(large,first.cache,0,1),{name:'GpuUnavailableError'});
  const tiny={...source,occupancy:Float64Array.from([1,1e-40])};
  await assert.rejects(prepareGpuDiffraction(f.runtime,tiny),{name:'GpuUnavailableError'});
  assert.ok(first.cache.inputs.every(buffer=>!buffer.destroyed));
  const invalid={...source,fractional:source.fractional.slice()};invalid.fractional[0]=NaN;
  await assert.rejects(prepareGpuDiffraction(f.runtime,invalid),/wrapped fractional/);
  await assert.rejects(analyzeGpuDiffraction(f.runtime,source,{start:-1}),/range/);
  releaseGpuDiffraction(f.runtime);
});

test('diffraction cancellation retains warm resources, while failed allocation frees only its partial buffers',async()=>{
  const source=prepared(),controller=new AbortController(),f=fixture(source,{onRead:()=>controller.abort()});
  await assert.rejects(analyzeGpuDiffraction(f.runtime,source,{signal:controller.signal}),{name:'AbortError'});
  const previous=await prepareGpuDiffraction(f.runtime,source);
  f.runtime.withErrors=async operation=>{await operation();throw new Error('allocation failed');};
  await assert.rejects(prepareGpuDiffraction(f.runtime,{...source,fractional:source.fractional.slice()}),/allocation failed/);
  assert.ok(previous.cache.inputs.every(buffer=>!buffer.destroyed));
  assert.ok(f.allocations.slice(-3).every(buffer=>buffer.destroyed));releaseGpuDiffraction(f.runtime);
  assert.ok(f.allocations.every(buffer=>buffer.destroyed));
});

test('invalid device structure factors request explicit fallback instead of plausible diffraction peaks',async()=>{
  const source=prepared(),f=fixture(source,{onRun:output=>{output[0]=NaN;}});
  await assert.rejects(analyzeGpuDiffraction(f.runtime,source),{name:'GpuUnavailableError'});releaseGpuDiffraction(f.runtime);
});

test('GPU diffraction admits CPU packing and exact corrections without retaining a CPU permit across device waits',async()=>{
  const source=prepared(),f=fixture(source);let permits=0,acquisitions=0;
  const withCpu=async operation=>{assert.equal(permits,0);permits++;acquisitions++;try{return await operation();}finally{permits--;}};
  for(const name of ['initialize','run','read']){
    const original=f.runtime[name];f.runtime[name]=async function(...args){assert.equal(permits,0,`${name} must not hold a CPU permit`);return original.apply(this,args);};
  }
  const result=await analyzeGpuDiffraction(f.runtime,source,{withCpu});
  assert.ok(result.correctedReflections>0);assert.ok(acquisitions>=3);assert.equal(permits,0);
  releaseGpuDiffraction(f.runtime);
});

test('dense expensive diffraction corrections return to parallel CPU instead of serially recomputing a large GPU job',async()=>{
  const original=prepared(),n=100_001,r=81,source={...original,atomCount:n,reflectionCount:r,
    fractional:new Float64Array(n*3),types:new Uint32Array(n),occupancy:new Float64Array(n).fill(1),
    hkls:new Int32Array(r*3),reciprocal:new Float64Array(r*3),s2:new Float64Array(r)};
  for(let i=0;i<r;i++){source.hkls[i*3]=1;source.reciprocal[i*3]=.25;source.s2[i]=1/64;}
  const f=fixture(source);f.runtime.run=async(_shader,bindings)=>new Float32Array(bindings[6].data.buffer).fill(0);
  await assert.rejects(analyzeGpuDiffraction(f.runtime,source),error=>error.name==='GpuUnavailableError'&&/parallel CPU Workers/.test(error.message));
  releaseGpuDiffraction(f.runtime);assert.ok(f.allocations.every(buffer=>buffer.destroyed));
});
