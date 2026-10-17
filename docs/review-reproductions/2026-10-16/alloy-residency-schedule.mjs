// Archived review evidence for baseline 77b24ad; see docs/REPOSITORY_REVIEW_2026-10-16.md.
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../../../src/analysis/analysis-pool.js';
import { calculateCna } from '../../../src/analysis/cna.js';
import { calculateCentrosymmetry } from '../../../src/analysis/centrosymmetry.js';
import { crystalFrame } from '../../../tests/helpers/crystals.js';
let slotCounter=0;
const pool = new AnalysisPool({environment:{crossOriginIsolated:true,navigator:{hardwareConcurrency:4}},workerFactory(){
 const index=slotCounter++,worker=new Worker(new URL('../../../tests/helpers/node-analysis-worker.mjs', import.meta.url));
 return {addEventListener(name,callback){worker.on(name,value=>{
  const deliver=()=>callback(name==='message'?{data:value}:value);
  if(index===1 && name==='message' && value.ok)setTimeout(deliver,100);else deliver();
 });},postMessage(data,transfers){worker.postMessage(data,transfers);},terminate(){void worker.terminate();}};
}});
const frames=[crystalFrame('fcc',11),crystalFrame('bcc',14)];
try {
 const first=await Promise.all(frames.map(frame=>pool.analyzeCPU(frame,{kind:'cna'})));
 first.forEach((result,i)=>assert.deepEqual(result.structures,calculateCna(frames[i]).structures));
 console.log({first:first.map(row=>({frameKey:row.frameKey,indexBuilds:row.indexBuilds,frameUploads:row.frameUploads})),slots:[...pool.slots].map(slot=>[...slot.cpuFrameKeys])});
 const repeated=await Promise.all(frames.map(frame=>pool.analyzeCPU(frame,{kind:'centrosymmetry',neighbors:12})));
 repeated.forEach((result,i)=>assert.deepEqual(result.centrosymmetry,calculateCentrosymmetry(frames[i]).centrosymmetry));
 console.log({repeated:repeated.map(row=>({frameKey:row.frameKey,indexBuilds:row.indexBuilds,frameUploads:row.frameUploads})),slots:[...pool.slots].map(slot=>[...slot.cpuFrameKeys]),scientificArraysMatch:true});
}finally{pool.close();}
