import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { dxaCartesianCoordinates } from '../../src/analysis/dxa.js';
import { replicateFrame } from '../../src/data/replicate.js';
import { parseCfg } from '../../src/io/cfg.js';
import { parseLammpsFrame } from '../../src/io/lammps-dump.js';
import { dxaGlobalFixtures } from '../../tests/helpers/dxa-global-fixtures.js';
import { compareDxaScience, dxaScienceHash, validateDxaScience } from '../lib/dxa-science-compare.mjs';

const root=resolve(import.meta.dirname,'../..');
const options={'--baseline-ref':'d1bfe2f','--baseline-dir':'','--current-dir':'','--baseline-science-dir':'',
  '--dataset':'all','--kernel':'threaded','--threads':'1,2,4,1','--repetitions':'3','--audit-repetitions':'2',
  '--audits':'yes','--diagnostics':'yes','--audit-mesh':'yes','--snapshot':'no','--budget-mib':'512',
  '--circuit':'14','--stretch':'9','--geometry-tolerance':'0','--burgers-tolerance':'0','--cluster-tolerance':'0',
  '--require-equivalence':'yes','--allow-oversubscription':'no','--output':'','--artifacts-dir':''};
for(let index=2;index<process.argv.length;index+=2){
  assert.ok(Object.hasOwn(options,process.argv[index])&&process.argv[index+1],
    'Use --baseline-ref HEX --dataset all|fixtures|NAME[,NAME] --kernel serial|threaded|both --threads 1,2,4,1 --repetitions 1..10 --output FILE. See script options for audit and artifact controls.');
  options[process.argv[index]]=process.argv[index+1];
}
assert.match(options['--baseline-ref'],/^[a-f\d]{7,40}$/i);
assert.ok(options['--output'],'--output is required so complete scientific records are retained.');
assert.ok(['serial','threaded','both'].includes(options['--kernel']));
for(const key of ['--audits','--diagnostics','--audit-mesh','--snapshot','--require-equivalence','--allow-oversubscription'])assert.ok(['yes','no'].includes(options[key]),key);
const count=(key,min,max)=>{const value=Number(options[key]);assert.ok(Number.isSafeInteger(value)&&value>=min&&value<=max,key);return value;};
const repetitions=count('--repetitions',1,10),auditRepetitions=count('--audit-repetitions',1,10),circuit=count('--circuit',3,100),stretch=count('--stretch',0,100);
const budgetBytes=count('--budget-mib',1,2048)*1024**2;
const sequence=options['--threads'].split(',').map(Number);
assert.ok(sequence.length&&sequence.every(x=>Number.isSafeInteger(x)&&x>=1&&x<=64));
const cpuQuota=(await readFile('/sys/fs/cgroup/cpu.max','utf8').catch(()=>'unknown')).trim();
const [quota,period]=cpuQuota.split(' ').map(Number),quotaCpus=Number.isFinite(quota)&&period>0?quota/period:null;
const effectiveCpus=Math.min(availableParallelism(),quotaCpus??Infinity);
const maximumRequestedThreads=options['--kernel']==='serial'?1:Math.max(...sequence);
if(options['--allow-oversubscription']==='no')assert.ok(maximumRequestedThreads<=effectiveCpus,`Requested threads exceed actual CPU allowance ${effectiveCpus}; explicit --allow-oversubscription yes only records contention, not core scaling.`);
const tolerances=Object.fromEntries(['geometry','burgers','cluster'].map(name=>{
  const value=Number(options[`--${name}-tolerance`]);assert.ok(Number.isFinite(value)&&value>=0);return [`${name}Tolerance`,value];
}));
const baseline=execFileSync('git',['rev-parse','--verify',`${options['--baseline-ref']}^{commit}`],{cwd:root,encoding:'utf8'}).trim();
const temporary=await mkdtemp(join(tmpdir(),'alloyview-dxa-global-'));
const baselineDirectory=options['--baseline-dir']?resolve(root,options['--baseline-dir']):temporary;
const currentDirectory=options['--current-dir']?resolve(root,options['--current-dir']):join(root,'src/analysis');
const baselineScienceDirectory=options['--baseline-science-dir']?resolve(root,options['--baseline-science-dir']):baselineDirectory;
const output=resolve(root,options['--output']),artifactDirectory=options['--artifacts-dir']?resolve(root,options['--artifacts-dir']):`${output.replace(/\.json$/,'')}.science`;
await mkdir(dirname(output),{recursive:true});await mkdir(artifactDirectory,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const median=values=>{const sorted=values.toSorted((a,b)=>a-b),i=Math.floor(sorted.length/2);return sorted.length%2?sorted[i]:(sorted[i-1]+sorted[i])/2;};
const report={schemaVersion:1,complete:false,generatedAt:new Date().toISOString(),baseline,command:process.argv.slice(1),runtime:process.version,
  cpuModel:(await readFile('/proc/cpuinfo','utf8').catch(()=>'')).match(/^model name\s*:\s*(.+)$/m)?.[1]??'unknown',
  availableParallelism:availableParallelism(),cpuQuota,effectiveCpus,oversubscribed:maximumRequestedThreads>effectiveCpus,
  repetitions,auditRepetitions,threadSequence:sequence,parameters:{circuit,stretch,perfectOnly:false,smoothing:1,coarsening:2.5},comparisonPolicy:tolerances,
  buildToolchain:{emscripten:'3.1.69',provenance:'Pinned repository toolchain; actual baseline/current files are independently identified by JS/Wasm SHA-256.'},
  baselineDirectory:options['--baseline-dir']||'original git artifacts',currentDirectory,baselineScienceDirectory:options['--baseline-science-dir']||'formal baseline artifacts',
  protocol:[
    'The requested thread count stays active for the complete native pipeline: BDEL at one thread, real PDEL above one. No progress callback changes thread count.',
    'Each fixture/thread-sequence step warms both retained modules once, then alternates baseline/current measured order. Returning to one thread reuses the same heap and pool.',
    'Formal elapsedMs covers the complete native analyze call including native graph release; upload/startup/JSON decoding/comparison/archive costs are excluded and reported separately where measured.',
    'The diagnostic callback is absent in timed runs. Staged full-science audits use separate module instances after formal timing; an optional baseline readback-only build is never used for performance conclusions.',
    'Every run retains complete scientific JSON in a compressed artifact, deduplicated only by the full original JSON hash. Exact science hashes omit only parallelEdgePasses execution counters. Repeated baseline and repeated current comparisons expose existing nondeterminism.',
    'A semantic match checks every label, complete polylines, Burgers vectors and reciprocal junction graph. Full audits additionally require per-atom cluster memberships, orientations and the complete transition graph.',
    'Declared tolerances are fixed before execution. Unsupported physical PDEL geometry or mesh differences are inconclusive, not a passing comparison or an automatically accepted tolerance.',
    'Heap values are retained Wasm capacities. This process holds two versions simultaneously, so process RSS is deliberately not presented as a single-version memory peak.'
  ],kernels:[]};
const persist=()=>writeFile(output,`${JSON.stringify(report,null,2)}\n`);
const archivedJson=new Map();
const archive=async(envelope,label)=>{
  const json=Buffer.from(JSON.stringify(envelope)),jsonSha256=hash(json);
  if(archivedJson.has(jsonSha256))return {...archivedJson.get(jsonSha256),runLabel:label};
  const compressed=gzipSync(json,{level:6}),path=join(artifactDirectory,`${jsonSha256}.json.gz`);
  await writeFile(path,compressed);
  const artifact={path:relative(dirname(output),path),jsonSha256,gzipSha256:hash(compressed),jsonBytes:json.length,gzipBytes:compressed.length,scienceSha256:dxaScienceHash(envelope)};
  archivedJson.set(jsonSha256,artifact);return {...artifact,runLabel:label};
};
const frames=[];
const requested=options['--dataset'].split(','),real=[['hea','hea-fcc-screw.dump',parseLammpsFrame,1],['fe','Fe_disloc_loop.dump',parseLammpsFrame,3],['nigb','NiGB_minimized.cfg',parseCfg,1]];
for(const [name,filename,parse,lattice] of real)if(requested.includes('all')||requested.includes(name)){
  const file=await readFile(join(root,'examples',filename));let frame=parse(file.toString(),filename);
  if(name==='nigb')frame=await replicateFrame(frame,[1,1,2]);
  frames.push({name,frame,lattice,source:{filename,sha256:hash(file),replication:name==='nigb'?[1,1,2]:[1,1,1]}});
}
const generated=dxaGlobalFixtures();
for(const fixture of generated)if(requested.includes('fixtures')||requested.includes(fixture.name))frames.push({...fixture,source:{generated:true,contract:fixture.contract}});
assert.ok(frames.length&&requested.every(name=>['all','fixtures'].includes(name)||real.some(row=>row[0]===name)||generated.some(row=>row.name===name)),'Unknown or empty dataset selection.');

async function artifacts(directory,basename){
  return Object.fromEntries(await Promise.all(['mjs','wasm'].map(async extension=>{
    const filename=`${basename}.${extension}`;return [filename,hash(await readFile(join(directory,filename)))];
  })));
}
async function createState(version,directory,basename,maxThreads){
  const start=performance.now(),factory=(await import(pathToFileURL(join(directory,`${basename}.mjs`)))).default;
  const state={version,kernel:null,stages:[],phase:null,last:0};
  state.kernel=await factory({wasmBinary:await readFile(join(directory,`${basename}.wasm`)),dxaPoolSize:maxThreads-1,
    onDxaProgress(phase){const now=performance.now();if(state.phase)state.stages.push({phase:state.phase,ms:now-state.last});state.phase=phase;state.last=now;}});
  state.initializationMs=performance.now()-start;return state;
}
function prepare(state,xyz,cell){
  const kernel=state.kernel,positions=kernel._malloc(xyz.byteLength),cellPointer=kernel._malloc(96);
  if(!positions||!cellPointer){if(positions)kernel._free(positions);if(cellPointer)kernel._free(cellPointer);throw new Error('Native input allocation failed.');}
  kernel.HEAPF64.set(xyz,positions/8);kernel.HEAPF64.set(cell.vectors,cellPointer/8);kernel.HEAPF64.set(cell.origin,cellPointer/8+9);
  return {state,positions,cellPointer,release(){kernel._free(positions);kernel._free(cellPointer);}};
}
function extract(input,descriptor,threads,kind){
  const {state,positions,cellPointer}=input,kernel=state.kernel,{frame,lattice}=descriptor;
  state.phase=null;state.stages=[];let diagnostic=null,callbacks=0;
  kernel.onDxaProfile=kind==='audit'&&options['--diagnostics']==='yes'?value=>{diagnostic=value;callbacks++;}:null;
  kernel._alloy_dxa_reset_cancel();kernel._alloy_dxa_set_threads(threads);
  assert.equal(kernel._alloy_dxa_thread_count(),threads,'Requested full-pipeline thread count must be active.');
  const pbc=frame.cell.pbc.reduce((bits,enabled,axis)=>bits|(enabled?1<<axis:0),0);
  const args=[positions,frame.fractional.length/3,cellPointer,pbc,lattice??1,circuit,stretch,0,1,2.5];
  const heapCapacityBytesBefore=kernel.HEAPU8.byteLength;
  const error=()=>kernel.UTF8ToString(kernel._alloy_dxa_last_error());
  try{
    kernel._alloy_dxa_defect_mesh(kind==='audit'&&options['--audit-mesh']==='yes'?1:0,0);
    const started=performance.now();let pointer;
    if(kind==='audit'){
      assert.equal(kernel._alloy_dxa_begin(...args),1,error());pointer=kernel._alloy_dxa_finish();
    }else pointer=kernel._alloy_dxa_analyze(...args);
    const elapsedMs=performance.now()-started;
    if(state.phase)state.stages.push({phase:state.phase,ms:performance.now()-state.last});
    assert.ok(pointer,error());
    const decodeStart=performance.now(),raw=JSON.parse(kernel.UTF8ToString(pointer));
    assert.equal(raw.atomStructureTypes?.length,args[1],'Complete native labels must cover every input atom.');
    const cell={vectors:Array.from(frame.cell.vectors),origin:Array.from(frame.cell.origin),pbc:Array.from(frame.cell.pbc)};
    const envelope={result:raw,cell};let readback={available:false},geometrySnapshot=null;
    if(kind==='audit'){
      if(typeof kernel._alloy_dxa_science_snapshot==='function'){
        const science=kernel._alloy_dxa_science_snapshot(budgetBytes);assert.ok(science,error());
        Object.assign(envelope,JSON.parse(kernel.UTF8ToString(science)));readback={available:true,schemaVersion:envelope.schemaVersion};
        assert.equal(envelope.atomClusters?.length,args[1],'Complete native crystal membership must cover every input atom.');
        kernel._alloy_dxa_release_science_snapshot?.();
      }
      if(options['--audit-mesh']==='yes'){
        assert.ok(!raw.defectMesh?.error,raw.defectMesh?.error);
        const v=kernel._alloy_dxa_defect_vertex_count(),t=kernel._alloy_dxa_defect_triangle_count();
        envelope.defectMesh={vertices:Array.from(kernel.HEAPF64.subarray(kernel._alloy_dxa_defect_vertices_ptr()/8,kernel._alloy_dxa_defect_vertices_ptr()/8+v*3)),
          triangles:Array.from(kernel.HEAPU32.subarray(kernel._alloy_dxa_defect_triangles_ptr()/4,kernel._alloy_dxa_defect_triangles_ptr()/4+t*3))};
      }
      if(options['--snapshot']==='yes'){
        assert.equal(kernel._alloy_dxa_worker_snapshot(budgetBytes),1,error());
        const counts=[kernel._alloy_dxa_worker_vertex_count(),kernel._alloy_dxa_worker_tet_count(),kernel._alloy_dxa_worker_edge_count(),kernel._alloy_dxa_worker_transition_count()];
        const fields=[['vertices',kernel._alloy_dxa_worker_vertex_ptr(),counts[0]*24],['tetrahedra',kernel._alloy_dxa_worker_tet_ptr(),counts[1]*64],
          ['edges',kernel._alloy_dxa_worker_edge_ptr(),counts[2]*32],['transitions',kernel._alloy_dxa_worker_transition_ptr(),counts[3]*160]];
        geometrySnapshot={counts,alpha:kernel._alloy_dxa_worker_alpha(),buffers:Object.fromEntries(fields.map(([name,pointer,size])=>[name,{bytes:size,sha256:hash(kernel.HEAPU8.subarray(pointer,pointer+size))}]))};
        kernel._alloy_dxa_release_worker_snapshot();
      }
    }else assert.equal(callbacks,0,'Formal timing must not enable profile callbacks.');
    assert.ok(callbacks<=1,'At most one diagnostic snapshot per complete extraction.');
    if(diagnostic)assert.equal(diagnostic.overflow,false,'Diagnostic storage must retain every recorded field.');
    const validity=validateDxaScience(envelope);assert.ok(validity.valid,validity.errors.join('\n'));
    return {envelope,record:{version:state.version,kind,threads,backend:threads>1?'PDEL':'BDEL',elapsedMs,decodeAndReadbackMs:performance.now()-decodeStart,
      heapCapacityBytesBefore,heapCapacityBytesAfter:kernel.HEAPU8.byteLength,stages:state.stages,readback,geometrySnapshot,diagnostic,validity}};
  }finally{kernel.onDxaProfile=null;kernel._alloy_dxa_dispose();kernel._alloy_dxa_defect_mesh(0,0);}
}
const comparison=(reference,candidate,threads,full)=>compareDxaScience(reference,candidate,{...tolerances,mode:threads===1?'exact':'semantic',
  requireClusters:full,requireDefectMesh:full&&options['--audit-mesh']==='yes'});
const nativeNetwork=envelope=>{
  const result={...envelope.result};delete result.defectMesh;
  return {result,cell:envelope.cell};
};
const comparisons=[];
try{
  for(const mode of ['serial','threaded'].filter(mode=>options['--kernel']==='both'||mode===options['--kernel'])){
    const basename=`dxa-kernel${mode==='threaded'?'-threaded':''}`,threadsSequence=mode==='serial'?[1]:sequence,maxThreads=Math.max(...threadsSequence);
    if(!options['--baseline-dir'])for(const extension of ['mjs','wasm'])await writeFile(join(baselineDirectory,`${basename}.${extension}`),
      execFileSync('git',['show',`${baseline}:src/analysis/${basename}.${extension}`],{cwd:root,maxBuffer:32*1024**2}));
    const row={mode,threadSequence:threadsSequence,artifacts:{baseline:await artifacts(baselineDirectory,basename),current:await artifacts(currentDirectory,basename)},datasets:[]};report.kernels.push(row);
    let states=[];const formalReferences=new Map();
    try{
      for(const [version,directory] of [['baseline',baselineDirectory],['current',currentDirectory]])states.push(await createState(version,directory,basename,maxThreads));
      row.initializationMs=Object.fromEntries(states.map(state=>[state.version,state.initializationMs]));
      for(const descriptor of frames){
        const xyz=dxaCartesianCoordinates(descriptor.frame),coordinates=Buffer.from(xyz.buffer,xyz.byteOffset,xyz.byteLength);
        const scientificInput={atoms:xyz.length/3,lattice:descriptor.lattice??1,parameters:report.parameters,
          cell:{vectors:Array.from(descriptor.frame.cell.vectors),origin:Array.from(descriptor.frame.cell.origin),pbc:Array.from(descriptor.frame.cell.pbc)}};
        const metadata=Buffer.from(JSON.stringify(scientificInput));
        const scientificInputSha256=createHash('sha256').update(String(metadata.length)).update(':').update(metadata).update(coordinates).digest('hex');
        const entry={fixture:descriptor.name,atoms:xyz.length/3,source:descriptor.source,coordinateSha256:hash(coordinates),scientificInputSha256,scientificInput,steps:[]};row.datasets.push(entry);
        const prepared=states.map(state=>prepare(state,xyz,descriptor.frame.cell));
        try{
          for(let sequenceIndex=0;sequenceIndex<threadsSequence.length;sequenceIndex++){
            const threads=threadsSequence[sequenceIndex],step={sequenceIndex,threads,backend:threads>1?'PDEL':'BDEL',warmups:[],runs:[],audits:[]};entry.steps.push(step);
            const first=new Map();let baselineReference;
            const perform=async(input,kind,repetition)=>{
              const {envelope,record}=extract(input,descriptor,threads,kind);
              if(!first.has(input.state.version))first.set(input.state.version,envelope);
              if(kind==='warmup')formalReferences.set(`${descriptor.name}/${sequenceIndex}/${input.state.version}`,envelope);
              baselineReference??=envelope;
              const withinVersion=comparison(first.get(input.state.version),envelope,threads,false),againstBaseline=comparison(baselineReference,envelope,threads,false);
              comparisons.push(withinVersion,againstBaseline);
              const scienceArtifact=await archive(envelope,`${mode}-${descriptor.name}-s${sequenceIndex}-${input.state.version}-${kind}-${repetition}`);
              const result={...record,repetition,scienceArtifact,withinVersion,againstBaseline};
              step[kind==='warmup'?'warmups':'runs'].push(result);
              if(kind==='measured')console.error(`${descriptor.name}/${mode}/${threads} ${input.state.version}: ${record.elapsedMs.toFixed(2)} ms; ${againstBaseline.status}`);
            };
            for(const input of prepared)await perform(input,'warmup',0);
            for(let repetition=0;repetition<repetitions;repetition++)for(const input of repetition%2?prepared.toReversed():prepared)await perform(input,'measured',repetition);
            step.summary=Object.fromEntries(states.map(({version})=>{
              const runs=step.runs.filter(run=>run.version===version),phases=[...new Set(runs.flatMap(run=>run.stages.map(stage=>stage.phase)))];
              return [version,{medianMs:median(runs.map(run=>run.elapsedMs)),minimumMs:Math.min(...runs.map(run=>run.elapsedMs)),maximumMs:Math.max(...runs.map(run=>run.elapsedMs)),
                heapCapacityBytes:Math.max(...runs.map(run=>run.heapCapacityBytesAfter)),stageMediansMs:Object.fromEntries(phases.map(phase=>[phase,median(runs.map(run=>run.stages.filter(stage=>stage.phase===phase).reduce((s,stage)=>s+stage.ms,0)))]))}];
            }));await persist();
          }
        }finally{for(const input of prepared)input.release();}
      }
    }finally{for(const state of states)state.kernel.PThread?.terminateAllThreads();}
    // Full audits are deliberately after all formal runs of this kernel and
    // use separate instances, so optional readback does not warm one version's
    // measured heap or make the patched baseline a timing reference.
    if(options['--audits']==='yes'){
      row.auditArtifacts={baseline:await artifacts(baselineScienceDirectory,basename),current:await artifacts(currentDirectory,basename)};
      states=[];
      try{
        for(const [version,directory] of [['baseline',baselineScienceDirectory],['current',currentDirectory]])states.push(await createState(version,directory,basename,maxThreads));
        for(let fixtureIndex=0;fixtureIndex<frames.length;fixtureIndex++){
          const descriptor=frames[fixtureIndex],entry=row.datasets[fixtureIndex],xyz=dxaCartesianCoordinates(descriptor.frame),prepared=states.map(state=>prepare(state,xyz,descriptor.frame.cell));
          try{
            for(const step of entry.steps){
              let baselineReference;const first=new Map();
              for(let repetition=0;repetition<auditRepetitions;repetition++)for(const input of repetition%2?prepared.toReversed():prepared){
                const {envelope,record}=extract(input,descriptor,step.threads,'audit');
                if(!first.has(input.state.version))first.set(input.state.version,envelope);baselineReference??=envelope;
                const withinVersion=comparison(first.get(input.state.version),envelope,step.threads,true),againstBaseline=comparison(baselineReference,envelope,step.threads,true);
                const againstTimedNativeNetwork=comparison(nativeNetwork(formalReferences.get(`${descriptor.name}/${step.sequenceIndex}/${input.state.version}`)),
                  nativeNetwork(envelope),step.threads,false);
                comparisons.push(withinVersion,againstBaseline,againstTimedNativeNetwork);
                const scienceArtifact=await archive(envelope,`${mode}-${descriptor.name}-s${step.sequenceIndex}-${input.state.version}-audit-${repetition}`);
                step.audits.push({...record,repetition,scienceArtifact,withinVersion,againstBaseline,againstTimedNativeNetwork});
                console.error(`${descriptor.name}/${mode}/${step.threads} ${input.state.version} full audit: ${againstBaseline.status}`);
              }
              await persist();
            }
          }finally{for(const input of prepared)input.release();}
        }
      }finally{for(const state of states)state.kernel.PThread?.terminateAllThreads();}
    }
  }
  report.complete=true;report.comparisonCounts=Object.fromEntries(['exact','equivalent','different','inconclusive'].map(status=>[status,comparisons.filter(row=>row.status===status).length]));
  report.fullScienceAuditAttempted=options['--audits']==='yes';
  const audits=report.kernels.flatMap(kernel=>kernel.datasets.flatMap(dataset=>dataset.steps.flatMap(step=>step.audits)));
  report.fullScienceCoverageAvailable=audits.length>0&&audits.every(audit=>audit.validity.coverage.crystalMembershipAndTransforms
    &&(options['--audit-mesh']==='no'||audit.validity.coverage.defectMesh));
  report.allComparisonsPassed=comparisons.every(row=>['exact','equivalent'].includes(row.status));
  report.fullScienceAuditPassed=report.fullScienceCoverageAvailable&&audits.every(audit=>[audit.withinVersion,audit.againstBaseline,audit.againstTimedNativeNetwork]
    .every(comparison=>['exact','equivalent'].includes(comparison.status)));
  await persist();console.log(JSON.stringify({output,complete:report.complete,comparisonCounts:report.comparisonCounts,allComparisonsPassed:report.allComparisonsPassed}));
  if(options['--require-equivalence']==='yes'&&!report.allComparisonsPassed)process.exitCode=2;
}catch(error){report.error={name:error.name,message:error.message};await persist();throw error;}
finally{await rm(temporary,{recursive:true,force:true});}
