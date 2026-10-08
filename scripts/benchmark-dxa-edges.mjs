import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import { parseCfg } from '../src/io/cfg.js';
import { replicateFrame } from '../src/data/replicate.js';
// Compare only the P18 stages on deterministic serial Delaunay geometry.
// Other native stages remain serial in both versions; the same two warmed
// modules and pthread heaps persist for the complete run.
const root = resolve(import.meta.dirname, '..');
const option = (flag, fallback) => { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1]; };
const baselineRef = option('--baseline-ref', 'cda3c41');
const threads = Number(option('--threads', '3'));
const repetitions = Number(option('--repetitions', '3'));
const dataset = option('--dataset', 'all');
assert.match(baselineRef, /^[a-f\d]{7,40}$/i);
assert.ok(Number.isInteger(threads) && threads >= 1 && threads <= 64);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
assert.ok(['all', 'hea', 'fe', 'nigb'].includes(dataset));
const base = await mkdtemp(join(tmpdir(), 'alloyview-dxa-edge-compare-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const artifactHashes = { baseline: {}, current: {} };
const commit = execFileSync('git', ['rev-parse', '--verify', `${baselineRef}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
for (const filename of ['dxa-kernel-threaded.mjs', 'dxa-kernel-threaded.wasm']) {
  const bytes = execFileSync('git', ['show', `${commit}:src/analysis/${filename}`], { cwd: root, maxBuffer: 32 * 1024 ** 2 });
  await writeFile(join(base, filename), bytes);
  artifactHashes.baseline[filename] = hash(bytes);
  artifactHashes.current[filename] = hash(await readFile(join(root, 'src/analysis', filename)));
}
const make=async(version,dir)=>{
 const factory=(await import(pathToFileURL(join(dir, 'dxa-kernel-threaded.mjs')))).default;
 const state={version,kernel:null,parallel:version==='current',stages:[],phase:null,last:0};
 state.kernel=await factory({wasmBinary:await readFile(join(dir,'dxa-kernel-threaded.wasm')),dxaPoolSize:threads-1,
 onDxaProgress(phase){
  const now=performance.now(); if(state.phase)state.stages.push({phase:state.phase,elapsedMs:now-state.last});
  state.phase=phase;state.last=now;
  state.kernel._alloy_dxa_set_threads(state.parallel&&['Build tessellation edges','Map edges to the ideal lattice'].includes(phase)?threads:1);
 }}); return state;
};
const backends=[await make('baseline',base),await make('current',join(root, 'src/analysis'))];
const fixtures=[['HEA','hea-fcc-screw.dump',parseLammpsFrame,1],['Fe','Fe_disloc_loop.dump',parseLammpsFrame,3],['NiGB','NiGB_minimized.cfg',parseCfg,1]].filter(([name]) => dataset === 'all' || dataset === name.toLowerCase());
const report={baseline:commit,runtime:`Node ${process.version}`,availableParallelism:availableParallelism(),edgeThreads:threads,warmupsPerMode:1,repetitions,artifactHashes,protocol:'Serial Delaunay and all other stages held fixed. Alternate baseline/current edge passes on the same deterministic serial topology; time edges and mapping before tracing. Every complete raw scientific network and atom label must match exactly. Retain modules, native pools and heaps.',datasets:[]};
const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
try {
 for(const [name,file,parse,lattice] of fixtures) {
  let frame=parse(await readFile(root+'/examples/'+file,'utf8'),file);if(name==='NiGB')frame=await replicateFrame(frame,[1,1,2]);
  const xyz=dxaCartesianCoordinates(frame), prepared=backends.map(state=>{
   const kernel=state.kernel,positions=kernel._malloc(xyz.byteLength),cell=kernel._malloc(96);
   kernel.HEAPF64.set(xyz,positions/8);kernel.HEAPF64.set(frame.cell.vectors,cell/8);kernel.HEAPF64.set(frame.cell.origin,cell/8+9);
   return {state,positions,cell};
  });
  const row={fixture:name,atoms:xyz.length/3,replication:name==='NiGB'?[1,1,2]:[1,1,1],runs:[]};report.datasets.push(row);let reference,referenceHash;
  function run(prep,warmup=false){
   const {state,positions,cell}=prep,kernel=state.kernel;
   state.phase=null;state.stages=[];kernel._alloy_dxa_reset_cancel();kernel._alloy_dxa_set_threads(1);
   const started=performance.now();
   assert.equal(kernel._alloy_dxa_begin(positions,xyz.length/3,cell,frame.cell.pbc.reduce((bits,p,i)=>bits|(p?1<<i:0),0),lattice,14,9,0,1,2.5),1,kernel.UTF8ToString(kernel._alloy_dxa_last_error()));
   const ended=performance.now();state.stages.push({phase:state.phase,elapsedMs:ended-state.last});state.phase=null;
   const topology={vertices:kernel._alloy_dxa_worker_vertex_count(),tetrahedra:kernel._alloy_dxa_worker_tet_count(),edges:kernel._alloy_dxa_worker_edge_count()};
   if(!reference)reference=topology;assert.deepEqual(topology,reference);
   const result={version:state.version,beginMs:ended-started,topology,stages:state.stages.map(stage=>({...stage}))};
   const pointer=kernel._alloy_dxa_finish();
   assert.ok(pointer,kernel.UTF8ToString(kernel._alloy_dxa_last_error()));
   const raw=JSON.parse(kernel.UTF8ToString(pointer));
   result.parallelEdgePasses=raw.parallelEdgePasses;
   delete raw.parallelEdgePasses;
   result.scienceSha256=hash(JSON.stringify(raw));
   referenceHash??=result.scienceSha256;
   assert.equal(result.scienceSha256,referenceHash,'Complete network, cluster frame, labels and junctions are exact on the serial topology.');
   kernel._alloy_dxa_dispose(); if(!warmup){row.runs.push(result);console.error(`${name} ${state.version}: edge ${result.stages.find(s=>s.phase==='Build tessellation edges').elapsedMs.toFixed(1)} ms; map ${result.stages.find(s=>s.phase==='Map edges to the ideal lattice').elapsedMs.toFixed(1)} ms`);}
  }
  try {
   for(const prep of prepared)run(prep,true);
   for(let rep=0;rep<repetitions;rep++)for(const prep of rep%2?[...prepared].reverse():prepared)run(prep);
   row.summary=Object.fromEntries(['baseline','current'].map(version=>[version,Object.fromEntries(['Build tessellation edges','Map edges to the ideal lattice'].map(phase=>[phase,median(row.runs.filter(r=>r.version===version).map(r=>r.stages.find(s=>s.phase===phase).elapsedMs))]))]));

  }finally {for(const {state,positions,cell}of prepared){state.kernel._free(positions);state.kernel._free(cell);}}
 }
  console.log(JSON.stringify(report,null,2));
}finally {for(const state of backends)state.kernel.PThread.terminateAllThreads();await rm(base,{recursive:true,force:true});}
