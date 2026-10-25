import assert from 'node:assert/strict';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Run the real source modules, Workers and WebGPU queue without UI timing
// gates. Prediction may compute values but must never publish frame properties.
// SwiftShader validates behavior only; these are not hardware speed timings.
const report = await withWebGpuBrowser(async ({ evaluate }) => evaluate(`(async () => {
  const [{AnalysisPool},{AnalysisPrefetchScheduler},{createVisibleAnalysisRequests},{createCell}] = await Promise.all([
    import('/AlloyView/src/analysis/analysis-pool.js'),
    import('/AlloyView/src/application/analysis-prefetch.js'),
    import('/AlloyView/src/application/visible-analysis-requests.js'),
    import('/AlloyView/src/data/model.js'),
  ]);
  const check=(value,message)=>{if(!value)throw new Error(message);};
  const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
  const until=async(predicate,label)=>{const end=performance.now()+60000;while(!predicate()){if(performance.now()>end)throw new Error(label);await pause();}};
  function crystal(index,n=4){
    const positions=[],fractions=[],ids=[],types=[];let id=1;
    for(let x=0;x<n;x++)for(let y=0;y<n;y++)for(let z=0;z<n;z++)for(const b of [[0,0,0],[.5,.5,0],[.5,0,.5],[0,.5,.5]]){
      const p=[(x+b[0])*4,(y+b[1])*4,(z+b[2])*4+.01*index];positions.push(...p);fractions.push(...p.map(v=>v/(4*n)));ids.push(id++);types.push(0);
    }
    return {frameIndex:index,ids:Uint32Array.from(ids),types:Uint16Array.from(types),typeLabels:['Cu'],
      positions:Float64Array.from(positions),fractional:Float64Array.from(fractions),properties:[],
      cell:createCell({vectors:[4*n,0,0,0,4*n,0,0,0,4*n]})};
  }
  const pool=new AnalysisPool(), events=[], calls=[];
  let scheduler, promotionRequested=false, promotedPromise=null;
  const analyze=pool.analyze;
  pool.analyze=function(frame,parameters,options={}){
    calls.push({index:frame.frameIndex,kind:parameters.kind,background:Boolean(options.background)});
    const promise=analyze.call(this,frame,parameters,options);
    if(options.background&&promotionRequested){promotionRequested=false;queueMicrotask(()=>{promotedPromise=scheduler.analyze(frame,parameters,{frameIndex:frame.frameIndex});});}
    return promise;
  };
  scheduler=new AnalysisPrefetchScheduler({pool,settleMs:0,retryMs:5,onStatus:status=>events.push(status)});
  const phases=[];
  try {
    await pool.warmupCpu({atomCount:256,modules:['ptm']});
    for(const gpu of [false,true]){
      pool.setGpuEnabled(gpu);
      if(gpu)await pool.warmupGpu({analysisKinds:[]});
      scheduler.setSourceKey('browser-prediction:'+gpu);
      const target=crystal(gpu?11:1),parameters={kind:'coordination',cutoff:3};
      const beforeCalls=calls.length;
      scheduler.schedule({frameIndex:target.frameIndex,getFrame:async()=>target,requests:[parameters]});
      await until(()=>events.some(status=>status?.phase==='ready'&&status.frameIndex===target.frameIndex),'prediction ready');
      const predicted=scheduler.lookup(target,parameters);
      check(predicted&&predicted.coordination.every(value=>value===12),'exact FCC coordination');
      const result=await scheduler.analyze(target,parameters,{frameIndex:target.frameIndex});
      check(result===predicted,'foreground reuses the exact predicted result');
      check(calls.length===beforeCalls+1,'cached foreground request does not dispatch another analysis');
      check(target.properties.length===0,'prediction and consumption leave publication to normal controllers');

      const joiningTarget=crystal(gpu?12:2),joinedBefore=calls.length;
      promotionRequested=true;promotedPromise=null;
      scheduler.schedule({frameIndex:joiningTarget.frameIndex,getFrame:async()=>joiningTarget,requests:[{kind:'cna',mode:'adaptive'}]});
      await until(()=>promotedPromise!==null,'foreground joined prediction');
      const joined=await promotedPromise;
      check(joined.structures.every(value=>value===1),'promoted CNA result is exact FCC');
      check(calls.length===joinedBefore+1,'promotion does not restart backend work');
      await until(()=>pool.backgroundAnalyses.size===0,'promoted request cleanup');

      const chainedTarget=crystal(gpu?16:6),chainBefore=calls.length;
      const chainOptions={quantity:'property:centralSymmetry',visibilitySource:'idealStrainStructureType',hidden:true,neighborLists:true,
        references:[{structure:1,a:4,element:'Cu'}],analyses:{cna:{enabled:true,parameters:{mode:'adaptive'}},
          centrosymmetry:{enabled:true,parameters:{mode:'auto'}},ptm:{enabled:true,parameters:{flags:31,rmsdCutoff:.1}},
          strain:{enabled:true,parameters:{flags:1,rmsdCutoff:.1}}}};
      scheduler.schedule({frameIndex:chainedTarget.frameIndex,getFrame:async()=>chainedTarget,
        requests:frame=>createVisibleAnalysisRequests({...chainOptions,frame})});
      await until(()=>events.some(status=>status?.phase==='ready'&&status.frameIndex===chainedTarget.frameIndex),'chained prediction ready');
      const outputs=[];
      for(const request of createVisibleAnalysisRequests({...chainOptions,frame:chainedTarget})){
        const parameters=typeof request.parameters==='function'?request.parameters(outputs,chainedTarget):request.parameters;
        outputs.push(await scheduler.analyze(chainedTarget,parameters,{frameIndex:chainedTarget.frameIndex}));
      }
      check(calls.length===chainBefore+4,'CNA/PTM/CSP/strain foreground chains reuse all four predictions');
      check(outputs[2].centrosymmetry.every(value=>Number.isFinite(value)&&Math.abs(value)<1e-6),'predicted Auto CSP exact crystal');
      check(outputs[3].atomicShearStrain.every(value=>Number.isFinite(value)&&Math.abs(value)<1e-6),'predicted strain exact crystal');
      check(chainedTarget.properties.length===0,'chained prediction does not publish scientific properties');

      const workersBefore=new Set([...pool.slots].map(slot=>slot.worker)),gpuWorker=pool.gpuBackend.worker;
      const old=crystal(gpu?14:4,10),latest=crystal(gpu?15:5);
      let foreground=null;
      const obsolete=pool.analyze(old,{kind:'cna',mode:'adaptive'},{background:true,frameIndex:old.frameIndex,
        onProgress:()=>{if(!foreground)foreground=Promise.resolve().then(()=>pool.analyze(latest,{kind:'coordination',cutoff:3},{frameIndex:latest.frameIndex}));}});
      const cancelled=obsolete.then(()=>false,error=>error.name==='AbortError');
      await until(()=>foreground!==null,'foreground preemption');
      const current=await foreground;
      check(await cancelled,'foreground cancels obsolete background work');
      check(current.coordination.every(value=>value===12),'latest foreground result remains correct');
      await until(()=>pool.active.size===0&&pool.cpuBudget.active===0,'CPU leases acknowledged');
      const workersRetained=[...pool.slots].filter(slot=>workersBefore.has(slot.worker)).length;
      check(workersRetained>0,'warmed CPU Worker survives speculative cancellation');
      if(gpu)check(pool.gpuBackend.worker===gpuWorker,'GPU Worker/device survives speculative cancellation');
      phases.push({gpuRequested:gpu,predictedBackend:result.backend,atoms:target.ids.length,
        cachedDispatches:1,promotedDispatches:1,chainedDispatches:4,chainedForegroundDispatches:0,obsoleteCancelled:true,warmCpuWorkersRetained:workersRetained,
        gpuWorkerRetained:gpu?pool.gpuBackend.worker===gpuWorker:null,propertiesPublished:target.properties.length});
      scheduler.cancel();
    }
    return {result:'passed',isolated:crossOriginIsolated,phases,stats:scheduler.stats,cacheBytes:scheduler.cacheBytes};
  } finally {scheduler.clearSource();pool.close();}
})()`), { isolated: process.argv.includes('--isolated') });
assert.equal(report.result, 'passed');
console.log(JSON.stringify(report, null, 2));
