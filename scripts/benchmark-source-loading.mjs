import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Interleaved before/after, real browser module Workers and gzip streams.
// Rendering and GPU preparation are excluded; both use the unchanged shared
// CPU budget. A temporary copy makes the baseline modules same-origin.
const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice(11);
assert.ok(baseline, 'Pass --baseline=/path/to/read-only/baseline-checkout');
const trials = Number(process.argv.find(value => value.startsWith('--trials='))?.slice(9) ?? 5);
const atoms = Number(process.argv.find(value => value.startsWith('--atoms='))?.slice(8) ?? 20_000);
const frames = Number(process.argv.find(value => value.startsWith('--frames='))?.slice(9) ?? 30);
assert.ok(Number.isSafeInteger(trials) && trials > 0 && trials <= 20);
assert.ok(Number.isSafeInteger(atoms) && atoms > 0 && atoms <= 100_000);
assert.ok(Number.isSafeInteger(frames) && frames > 1 && frames <= 100);
const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(root, '.benchmark-loading-'));
await cp(resolve(baseline, 'src'), resolve(temporary, 'src'), { recursive: true });

async function structureBootstrap(moduleUrl) {
  const NativeWorker = self.Worker;
  self.Worker = class extends NativeWorker {
    constructor(...args) { super(...args); self.postMessage({ event: 'benchmark-parser-created' }); }
  };
  let ready = false;
  const pending = [];
  self.addEventListener('message', event => {
    if (!ready) { event.stopImmediatePropagation(); pending.push(event.data); }
  });
  await import(moduleUrl);
  ready = true;
  self.postMessage({ event: 'benchmark-module-ready' });
  for (const data of pending) self.dispatchEvent(new MessageEvent('message', { data }));
}

try {
  const result = await withWebGpuBrowser(async ({ evaluate }) => evaluate(`(async () => {
    const bases = { before: '/AlloyView/${basename(temporary)}/src', after: '/AlloyView/src' };
    const implementations = {};
    for (const [name, base] of Object.entries(bases)) {
      implementations[name] = {
        ...(await import(base + '/data/structure-worker-client.js')),
        ...(await import(base + '/analysis/cpu-budget.js')),
        ...(await import(base + '/workers/indexed-trajectory.js')),
        ...(await import(base + '/workers/frame-parser.js')),
      };
    }
    const NativeWorker = window.Worker;
    let created = 0;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        const absolute = new URL(url, location.href).href;
        const bootstrap = '(' + ${JSON.stringify(structureBootstrap.toString())} + ')(' + JSON.stringify(absolute) + ')';
        const objectUrl = URL.createObjectURL(new Blob([bootstrap], { type:'text/javascript' }));
        super(objectUrl, options); URL.revokeObjectURL(objectUrl);
        created++;
        this.moduleReady = new Promise(resolve => { this.resolveModule = resolve; });
        this.warmReady = new Promise(resolve => { this.resolveWarm = resolve; });
        this.addEventListener('message', ({data}) => {
          if (data.event === 'benchmark-parser-created') created++;
          if (data.event === 'benchmark-module-ready') this.resolveModule();
          if (data.ok && data.id === undefined) this.resolveWarm();
        });
      }
    };
    const exact = frame => ({ ids:Array.from(frame.ids),types:Array.from(frame.types),positions:Array.from(frame.positions),
      fractional:Array.from(frame.fractional),cell:frame.cell,typeLabels:frame.typeLabels,properties:frame.properties });
    const small = new File(['2\\nLattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3\\nFe 1 2 3\\nNi 4 5 6\\n'], 'startup.xyz');
    async function sourceTrial(name) {
      const api = implementations[name];
      const budget = new api.CpuBudget({ environment:{navigator:{hardwareConcurrency:4}} });
      const client = new api.StructureWorkerClient(() => {}, { cpuBudget:budget });
      const ready = worker => name === 'after' ? worker.warmReady : worker.moduleReady;
      await ready(client.worker);
      const records = [];
      try {
        for (let source = 0; source < 2; source++) {
          if (client.standbyClient) await ready(client.standbyClient.worker);
          const before = created, started = performance.now();
          const prepared = await client.prepareSource([small]);
          const milliseconds = performance.now() - started;
          records.push({ milliseconds, workersCreatedDuringSelection:created-before, frame:exact(prepared.result.frame) });
          prepared.commit();
        }
      } finally { client.close(); }
      return records;
    }
    let seed = 17;
    const random = () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return (seed/4294967296*10).toFixed(6); };
    const parts = [];
    for (let frame=0;frame<${frames};frame++) {
      parts.push('${atoms}\\nLattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:id:I:1 Step='+frame+'\\n');
      for(let atom=0;atom<${atoms};atom++) parts.push((atom%2?'Fe':'Ni')+' '+random()+' '+random()+' '+random()+' '+(atom+1)+'\\n');
    }
    const plain = new Blob(parts); parts.length=0;
    const gzip = new File([await new Response(plain.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()], 'trajectory.xyz.gz');
    async function digest(frame) {
      const buffers = [frame.ids,frame.types,frame.positions,frame.fractional,...frame.properties.map(property=>property.data)];
      const metadata = JSON.stringify({cell:frame.cell,typeLabels:frame.typeLabels,timestep:frame.timestep,
        properties:frame.properties.map(({data,...metadata})=>metadata)});
      const bytes = await new Blob([metadata,...buffers]).arrayBuffer();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');
    }
    async function gzipTrial(name) {
      const api=implementations[name], started=performance.now();
      const read=Blob.prototype.arrayBuffer;
      let rangeReadBytes=0,opened,firstMs,indexMs,early;
      Blob.prototype.arrayBuffer=function(){ rangeReadBytes+=this.size; return read.call(this); };
      try {
        opened=await api.openIndexedTrajectory([gzip],'xyz',{parse:api.parseFrameDescriptor});
        firstMs=performance.now()-started; early=!opened.result.indexComplete;
        await opened.source.indexPromise;
        indexMs=performance.now()-started;
      } finally { Blob.prototype.arrayBuffer=read; }
      const allBytes = await new Blob(opened.source.descriptors.map(({file,start,end})=>file.slice(start,end))).arrayBuffer();
      const byteDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',allBytes))).map(value=>value.toString(16).padStart(2,'0')).join('');
      const firstDigest=await digest(opened.result.frame);
      const last=await api.parseFrameDescriptor(opened.source.descriptors.at(-1));
      return {firstMs,indexMs,early,rangeReadBytes,frameCount:opened.source.frameCount,byteDigest,firstDigest,lastDigest:await digest(last)};
    }
    for(const name of ['before','after']) { await sourceTrial(name); await gzipTrial(name); }
    const samples={before:{source:[],gzip:[]},after:{source:[],gzip:[]}};
    for(let trial=0;trial<${trials};trial++) for(const name of trial%2?['after','before']:['before','after']) {
      samples[name].source.push(await sourceTrial(name)); samples[name].gzip.push(await gzipTrial(name));
    }
    return {samples,compressedBytes:gzip.size,decodedBytes:plain.size};
  })()`), { requireGpu:false });
  const before = result.samples.before, after = result.samples.after;
  for (let trial = 0; trial < trials; trial++) {
    for (let source = 0; source < 2; source++) {
      assert.deepEqual(after.source[trial][source].frame, before.source[trial][source].frame);
      assert.equal(after.source[trial][source].workersCreatedDuringSelection, 0, 'selection must use the prewarmed backend');
    }
    assert.equal(after.gzip[trial].early, true, 'first gzip frame must arrive before final indexing completes');
    for (const name of ['frameCount', 'byteDigest', 'firstDigest', 'lastDigest']) assert.equal(after.gzip[trial][name], before.gzip[trial][name]);
  }
  for (const sample of Object.values(result.samples)) for (const trial of sample.source) for (const source of trial) delete source.frame;
  const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const medians = Object.fromEntries(Object.entries(result.samples).map(([name, sample]) => [name, {
    startupSelectionMs:median(sample.source.map(value=>value[0].milliseconds)),
    replacementSelectionMs:median(sample.source.map(value=>value[1].milliseconds)),
    gzipFirstFrameMs:median(sample.gzip.map(value=>value.firstMs)), gzipFullIndexMs:median(sample.gzip.map(value=>value.indexMs)),
  }]));
  console.log(JSON.stringify({ scope:'Real browser Worker selection and gzip decompression/indexing; no rendering or GPU timing',
    atoms,frames,trials,baseline:resolve(baseline),exactOutputs:true,medians,...result },null,2));
} finally { await rm(temporary, { recursive:true, force:true }); }
