import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { readFrameHeaderDescriptor, MAX_FRAME_HEADER_BYTES } from '../src/io/frame-header.js';
import { parseFrameDescriptor } from '../src/workers/frame-parser.js';
import { indexPdb } from '../src/io/pdb.js';
import { FrameParserPool } from '../src/data/frame-parser-pool.js';
import { collectFileSeries, isHeaderSeries, TimeSeriesStore } from '../src/data/time-series.js';
import { createAttributeRegistry } from '../src/properties/global-attributes.js';
import { createGlobalAttributeSource } from '../src/properties/global-attribute-source.js';
import { createCell } from '../src/data/model.js';

const dump = (count = 2, step = -10) => `ITEM: TIMESTEP\n${step}\nITEM: UNITS\nmetal\nITEM: TIME\n1.5\nITEM: NUMBER OF ATOMS\n${count}\nITEM: BOX BOUNDS xy xz yz pp ff pp\n-1 12 2\n-2 11 1\n3 13 3\nITEM: ATOMS id type xs ys zs energy\n`;
const xyz = (count = 2) => `${count}\nLattice="10 0 0 2 11 0 1 3 12" pbc="T F T" Step=-1.25D2 Properties=species:S:1:pos:R:3:id:I:1:q:R:1\nFe 1 2 3 1 5\nNi 2 3 4 2 7\n`;
const file = (text, name = 'run.dump') => new File([text], name);
const metadata = index => ({ atomCount: 2, cell: createCell({ vectors: [10 + index,0,0,0,10,0,0,0,10] }), timestep: index * 10, frameIndex: index });
const registry = (frame, index) => createAttributeRegistry({ frame, frameIndex: index, frameCount: 4, fileOnly: true });
const tick = () => new Promise(resolve => setImmediate(resolve));

function assertHeaderMatches(header, frame) {
  assert.equal(header.atomCount, frame.ids.length);
  assert.deepEqual(header.cell, frame.cell);
  assert.equal(header.timestep, frame.timestep);
  assert.equal(header.frameIndex, frame.frameIndex);
  for (const key of ['ids', 'types', 'positions', 'fractional', 'unwrappedPositions', 'imageFlags', 'properties']) assert.ok(!(key in header), key);
}

test('dump and Extended XYZ headers retain the exact full-parser cell, count and timestep', async () => {
  for (const descriptor of [
    { format: 'lammps-dump', file: file(dump() + '1 1 .1 .2 .3 5\n2 2 .3 .4 .5 7\n'), index: 3 },
    { format: 'xyz', file: file(xyz(), 'run.xyz'), index: 2 },
  ]) assertHeaderMatches(await readFrameHeaderDescriptor(descriptor), await parseFrameDescriptor(descriptor));
  const header = await readFrameHeaderDescriptor({ format:'lammps-dump', file:file(dump()+'invalid rows deliberately not parsed\n') });
  assert.equal(header.lammpsUnits, 'metal'); assert.equal(header.simulationTime, 1.5);
});

test('the bundled CFG transform and real Fe dump give exact metadata without atom-sized output', async () => {
  for (const [path, format] of [['examples/fixed_end_climb/replica.9.cfg','cfg'], ['examples/Fe_disloc_loop.dump','lammps-dump']]) {
    const descriptor = { file:file(await readFile(new URL(`../${path}`, import.meta.url)), path), format, index: 9 };
    assertHeaderMatches(await readFrameHeaderDescriptor(descriptor), await parseFrameDescriptor(descriptor));
  }
});

test('header reads stay bounded for a large frame, split UTF-8 comments, BOM and CRLF', async () => {
  const reads = [];
  const original = file(dump(1_000_000) + 'invalid atom row\n'.repeat(1_000_000));
  const traced = { size:original.size, name:original.name, slice(start,end) { reads.push([start,end]); return original.slice(start,end); } };
  const header = await readFrameHeaderDescriptor({format:'lammps-dump',file:traced});
  assert.equal(header.atomCount, 1_000_000);
  assert.ok(reads.reduce((sum,[a,b]) => sum + b-a, 0) < 8192);
  const padded = '\uFEFF2\r\n' + 'x'.repeat(4085) + '界😀 ' + xyz().split('\n')[1] + '\r\ninvalid rows\r\n';
  assert.equal((await readFrameHeaderDescriptor({format:'xyz',file:file(padded)})).timestep, -125);
});

test('gzip CFG prefixes stream header metadata; unrecognized or inferred cells request the full path', async () => {
  const text = await readFile(new URL('../examples/fixed_end_climb/replica.9.cfg', import.meta.url));
  const compressed = file(gzipSync(text), 'replica.9.cfg.gz');
  assert.deepEqual(await readFrameHeaderDescriptor({format:'cfg',file:compressed}), await readFrameHeaderDescriptor({format:'cfg',file:file(text)}));
  for (const descriptor of [
    {format:'xyz',file:file('2\nfree molecule\nFe 1 2 3\nNi 3 4 5\n')},
    {format:'poscar',file:file('not read')},
    {format:'pdb',file:file('not read'), atomCount:2, metadataHeader:'MODEL        1'},
    {format:'xyz',file:file('2\n'+'padding='+'x'.repeat(MAX_FRAME_HEADER_BYTES)+'\ninvalid rows\n')},
  ]) assert.equal((await readFrameHeaderDescriptor(descriptor)).headerUnavailable, true);
});

test('invalid header rules match the full parser and cancellation cannot return a stale header', async () => {
  for (const [format,text] of [
    ['xyz',xyz().replace('Step=-1.25D2','Step=Infinity')],
    ['xyz',xyz().replace('10 0 0 2 11 0 1 3 12','0 0 0 0 0 0 0 0 0')],
    ['lammps-dump',dump().replace('xy xz yz','xy')],
    ['lammps-dump',dump().replace('NUMBER OF ATOMS\n2','NUMBER OF ATOMS\n0')],
    ['cfg','Number of particles = 2\nA = 1\n1 2 3\n'],
  ]) {
    let original;
    try { await parseFrameDescriptor({format,file:file(text)}); } catch(error) { original = error; }
    await assert.rejects(readFrameHeaderDescriptor({format,file:file(text)}), error => error.message === original?.message);
  }
  let release;
  const gate = new Promise(resolve => { release=resolve; });
  const target = file(dump());
  const controller = new AbortController();
  const traced = {size:target.size,name:target.name,slice(a,b) { const value=target.slice(a,b); return {arrayBuffer:async()=> {await gate;return value.arrayBuffer();}}; }};
  const read = readFrameHeaderDescriptor({format:'lammps-dump',file:traced},{signal:controller.signal});
  controller.abort(); release();
  await assert.rejects(read, {name:'AbortError'});
});

const crystal = a => 'CRYST1'+[a,10,10].map(value=>value.toFixed(3).padStart(9)).join('')+[90,90,90].map(value=>value.toFixed(2).padStart(7)).join('');
const atom = (id, alt=' ') => `ATOM  ${String(id).padStart(5)}  Fe ${alt}FE A   1       1.000   2.000   3.000  1.00  0.00          Fe`;

test('PDB progressive index retains primary counts and every per-model cell override', async () => {
  const blob=file([crystal(10),'MODEL        3',atom(1),atom(2,'B'),atom(3,'A'),crystal(12),'ENDMDL',crystal(15),'MODEL        5',atom(4),'ENDMDL'].join('\n'), 'run.pdb');
  const published=[];
  const indexed = await indexPdb(blob,undefined,{chunkSize:37,onFrame:descriptor=>published.push(descriptor)});
  assert.deepEqual(published.map(descriptor=>descriptor.atomCount), [2,1]);
  for (const [index,descriptor] of indexed.frames.entries()) {
    const full={...descriptor,format:'pdb',file:blob,index};
    assertHeaderMatches(await readFrameHeaderDescriptor(full), await parseFrameDescriptor(full));
  }
  const implicit=file([crystal(17),atom(1),atom(2,'B')].join('\n'),'single.pdb');
  const descriptor={...(await indexPdb(implicit)).frames[0],format:'pdb',file:implicit};
  assertHeaderMatches(await readFrameHeaderDescriptor(descriptor),await parseFrameDescriptor(descriptor));
  const malformed={...descriptor,metadataHeader:crystal(0)+'\n'+crystal(17)};
  await assert.rejects(readFrameHeaderDescriptor(malformed),/CRYST1/);
});

class NodeParser {
  constructor() { this.worker=new Worker(new URL('./helpers/node-frame-parser-worker.mjs',import.meta.url),{type:'module'}); }
  addEventListener(name,listener) { this.worker.on(name,value=>listener(name==='message'?{data:value}:value)); }
  postMessage(...args) { this.worker.postMessage(...args); }
  terminate() { return this.worker.terminate(); }
}

test('real retained parser Workers produce tiny header messages and keep subsequent full parsing usable', async t => {
  let created=0;
  const pool=new FrameParserPool({backgroundCount:1,workerFactory:()=>{created++;return new NodeParser();}});
  t.after(()=>pool.close());
  const descriptor={format:'xyz',file:file(xyz()),index:2};
  const header=await pool.parse({...descriptor,projection:'header'},{background:true});
  const frame=await pool.parse(descriptor,{background:true});
  assertHeaderMatches(header,frame); assert.equal(created,1);
  assert.equal(frame.properties[0].data.length,2);
  const controller=new AbortController();
  const retained=pool.slots[0].worker,post=retained.postMessage.bind(retained);
  retained.postMessage=(message,...args)=>{post(message,...args);if(message.descriptor)controller.abort();};
  const cancelled=pool.parse({...descriptor,projection:'header'},{background:true,signal:controller.signal});
  await assert.rejects(cancelled,{name:'AbortError'});
  retained.postMessage=post;
  assertHeaderMatches(await pool.parse({...descriptor,projection:'header'},{background:true}),frame);
  assert.equal(created,1);
});

test('header-only series use a bounded concurrent window with ordered commits; mixed columns retain full reads', async () => {
  assert.equal(isHeaderSeries(['Cell.a','Strain.volumetric','AtomCount']),true);
  assert.equal(isHeaderSeries(['Cell.a','Mean.energy']),false);
  const store=new TimeSeriesStore(), pending=new Map(), reads=[],progress=[];
  const collection=collectFileSeries({store,frames:[0,1,2,3],names:['Cell.volume','AtomCount'],headerConcurrency:2,
    readHeader:index=>{reads.push(index);return new Promise(resolve=>pending.set(index,resolve));},
    readFrame:()=>{throw new Error('Unexpected atom read');},attributesFor:registry,
    onProgress:({frameIndex})=>{if(frameIndex!==undefined)progress.push(frameIndex);}});
  await tick(); assert.deepEqual(reads,[0,1]);
  pending.get(1)(metadata(1)); await tick(); assert.equal(store.has('Cell.volume',1),false);
  pending.get(0)(metadata(0)); await tick(); assert.deepEqual(progress,[0,1]); assert.deepEqual(reads,[0,1,2,3]);
  pending.get(3)(metadata(3)); pending.get(2)(metadata(2));
  assert.deepEqual(await collection,{read:4,recorded:8}); assert.deepEqual(progress,[0,1,2,3]);
  const fullReads=[];
  await collectFileSeries({store:new TimeSeriesStore(),frames:[0,1],names:['Cell.volume','Mean.q'],
    readHeader:()=>{throw new Error('Mixed collection may not use metadata');},readFrame:async index=>{
      fullReads.push(index);return {...metadata(index),properties:[{name:'q',data:Float32Array.of(1,3)}]};},attributesFor:registry});
  assert.deepEqual(fullReads,[0,1]);
});

test('header fallback and cancellation preserve collected points and abort only outstanding subscriptions', async () => {
  const fullReads=[],store=new TimeSeriesStore();
  await collectFileSeries({store,frames:[0,1],names:['Cell.volume'],readHeader:async index=>index?{headerUnavailable:true}:metadata(index),
    readFrame:async index=>{fullReads.push(index);return metadata(index);},attributesFor:registry});
  assert.deepEqual(fullReads,[1]);assert.equal(store.value('Cell.volume',1),1100);
  const controller=new AbortController(),signals=[];
  const cancelled=collectFileSeries({store:new TimeSeriesStore(),frames:[0,1,2,3],names:['AtomCount'],signal:controller.signal,
    readHeader:async(index,{signal})=>{signals.push(signal);if(!index)return metadata(index);return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError'))));},
    readFrame:()=>{throw new Error('No fallback after cancellation');},attributesFor:registry,
    onProgress:({done})=>{if(done===1)controller.abort();}});
  await assert.rejects(cancelled,{name:'AbortError'});
  assert.equal(signals.length,3); assert.ok(signals.every(signal=>signal.aborted));
});

test('cell-strain reference uses metadata first and inferred cells fall back, without displaying reference atoms', async () => {
  const calls=[];
  const source=createGlobalAttributeSource({getFrame:()=>metadata(0),getFrameCount:()=>4,getFrameIndex:()=>0,
    getFrameHeaderAt:async index=>{calls.push(['header',index]);return index===2?{headerUnavailable:true}:metadata(index);},
    getFrameAt:async index=>{calls.push(['full',index]);return metadata(index);},schedule:()=>{}});
  source.setStrainReferenceFrame(1);
  assert.deepEqual((await source.ensureReference()).vectors,metadata(1).cell.vectors);
  assert.deepEqual(calls,[['header',1]]);
  await source.ensureReference();assert.equal(calls.length,1);
  source.setStrainReferenceFrame(2);await source.ensureReference();
  assert.deepEqual(calls,[['header',1],['header',2],['full',2]]);
});

test('many short CFG comments remain bounded and yield cancellation between header chunks', { timeout: 5000 }, async () => {
  const body=await readFile(new URL('../examples/fixed_end_climb/replica.9.cfg', import.meta.url),'utf8');
  const long=file('# comment\n'.repeat(80_000)+body,'comments.cfg');
  const header=await readFrameHeaderDescriptor({format:'cfg',file:long});
  assert.equal(header.atomCount,257);
  const controller=new AbortController(),reads=[];
  const traced={size:long.size,name:long.name,slice(a,b){reads.push([a,b]);const sliced=long.slice(a,b);return {arrayBuffer:async()=>{
    const bytes=await sliced.arrayBuffer();if(reads.length===3)controller.abort();return bytes;
  }};}};
  await assert.rejects(readFrameHeaderDescriptor({format:'cfg',file:traced},{signal:controller.signal}),{name:'AbortError'});
  assert.equal(reads.length,3,'Cancellation stops prefix expansion promptly');
});

test('metadata failures stop the bounded pipeline and leave already committed values intact', async () => {
  const store=new TimeSeriesStore(),signals=[],read=[];
  const failure=collectFileSeries({store,frames:[0,1,2,3,4,5],names:['AtomCount'],headerConcurrency:2,
    readHeader:async(index,{signal})=>{read.push(index);signals.push(signal);if(index===0)return metadata(index);if(index===1)throw new Error('Malformed cell header');
      return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError'))));},
    readFrame:()=>{throw new Error('A malformed header must not quietly fall back');},attributesFor:registry});
  await assert.rejects(failure,/Malformed cell header/);
  assert.equal(store.value('AtomCount',0),2);assert.deepEqual(read,[0,1,2]);assert.ok(signals.every(signal=>signal.aborted));
});
