import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { withWebGpuBrowser, useSoftwareAdapter } from '../lib/webgpu-browser.mjs';

// Interleaved old serial canvas.toBlob+CRC and the two-frame Worker pipeline.
// Both capture the same real WebGL scene and compare the complete ZIP digest.
// SwiftShader results describe this browser/CPU, never physical GPU speed.
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const baseline = arg('baseline');
assert.ok(baseline, 'Pass --baseline=/path/to/baseline-checkout');
const trials = Number(arg('trials', 3)), frames = Number(arg('frames', 12)), atoms = Number(arg('atoms', 60000));
const width = Number(arg('width', 1050)), height = Number(arg('height', 928));
for (const [name, value, max] of [['trials', trials, 20], ['frames', frames, 500], ['atoms', atoms, 1e6], ['width', width, 4000], ['height', height, 4000]]) {
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= max, `Invalid ${name}`);
}
const root = resolve(import.meta.dirname, '../..'), temporary = await mkdtemp(resolve(root, '.benchmark-png-'));
await copyFile(resolve(baseline, 'src/io/export-archive.js'), resolve(temporary, 'export-archive.js'));
try {
  const result = await withWebGpuBrowser(async ({ evaluate }) => evaluate(`(async()=>{
    const [{PngArchiveQueue},{ImageArchiveBuilder},{WebGLRenderer},{createCell,fractionalToCartesian}]=await Promise.all([
      import('/AlloyView/src/video/png-archive-queue.js'),import('/AlloyView/${basename(temporary)}/export-archive.js'),
      import('/AlloyView/src/render/webgl-renderer.js'),import('/AlloyView/src/data/model.js')]);
    const canvas=document.createElement('canvas');canvas.style.cssText='width:${width}px;height:${height}px';document.body.append(canvas);
    const renderer=new WebGLRenderer(canvas),cells=Math.ceil(Math.cbrt(${atoms})),length=cells*2.6;
    const cell=createCell({origin:[0,0,0],vectors:[length,0,0,0,length,0,0,0,length]});
    const fractional=new Float64Array(${atoms}*3),colors=new Uint8Array(${atoms}*3),radii=new Float32Array(${atoms}).fill(.8);
    for(let i=0;i<${atoms};i++){
      fractional[3*i]=(i%cells+.5)/cells;fractional[3*i+1]=(Math.floor(i/cells)%cells+.5)/cells;fractional[3*i+2]=(Math.floor(i/cells/cells)+.5)/cells;
      colors.set(i%2?[30,140,210]:[220,90,50],i*3);
    }
    const positions=fractionalToCartesian(fractional,cell);
    renderer.setFrame({cell,fractional,positions,ids:Uint32Array.from({length:${atoms}},(_,i)=>i+1)},colors,positions,radii,[1,1,1]);
    renderer.setBackground('#ffffff');renderer.resetCamera();const startYaw=renderer.yaw;
    const capture=async index=>{
      renderer.yaw=startYaw+index*.017;
      const image=await renderer.captureImage({includeBackground:true,resolution:{mode:'custom',width:${width},height:${height},lockAspect:false}});
      const context=image.getContext('2d');context.font='24px sans-serif';context.fillStyle='#222';context.fillText('Frame '+(index+1)+' / Fe-Ni',20,35);
      return image;
    };
    const toBlob=canvas=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('PNG failed')),'image/png'));
    const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
    const digest=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),value=>value.toString(16).padStart(2,'0')).join('');
    async function trial(version){
      let captureMs=0,archiveMs=0,retained=0,peakRetained=0,heartbeats=0,maxHeartbeatGapMs=0,lateHeartbeatMs=0,last=performance.now();
      const beat=setInterval(()=>{const time=performance.now(),gap=time-last;last=time;heartbeats++;maxHeartbeatGapMs=Math.max(maxHeartbeatGapMs,gap);lateHeartbeatMs+=Math.max(0,gap-5);},5);
      const release=image=>{image.width=image.height=1;retained--;};
      const archive=version==='before'?new ImageArchiveBuilder():new PngArchiveQueue({release});
      const started=performance.now();let blob;
      try{
        for(let frame=0;frame<${frames};frame++){
          let stamp=performance.now();const image=await capture(frame);captureMs+=performance.now()-stamp;
          retained++;peakRetained=Math.max(peakRetained,retained);const name='frame-'+String(frame+1).padStart(6,'0')+'.png';
          if(version==='before'){
            const png=await toBlob(image),bytes=new Uint8Array(await png.arrayBuffer());stamp=performance.now();archive.add({name,bytes});archiveMs+=performance.now()-stamp;release(image);
          }else await archive.add(image,name);
          await pause();
        }
        blob=await archive.finish();
        const elapsedMs=performance.now()-started;await pause();
        return {elapsedMs,perFrameMs:elapsedMs/${frames},captureMs,archiveMs:version==='before'?archiveMs:null,peakRetainedImages:peakRetained,
          heartbeats,maxHeartbeatGapMs,lateHeartbeatMs,size:blob.size,sha256:await digest(blob)};
      }finally{clearInterval(beat);if(version==='before')archive.clear();else archive.dispose();}
    }
    // Warm shader compilation and the browser encoder before measured exports;
    // each after trial still includes a new export-scoped Worker startup.
    const warm=await capture(0);await toBlob(warm);warm.width=warm.height=1;
    await trial('before');await trial('after');
    const before=[],after=[];
    for(let i=0;i<${trials};i++)for(const version of i%2?['after','before']:['before','after'])(version==='before'?before:after).push(await trial(version));
    renderer.clearFrame();canvas.remove();return{before,after,userAgent:navigator.userAgent};
  })()`, { timeoutMs: 600_000 }), { requireGpu: false, software: useSoftwareAdapter() });
  for (const sample of [...result.before, ...result.after]) assert.equal(sample.sha256, result.before[0].sha256, 'every rendered ZIP must be byte-identical');
  assert.ok(result.after.every(sample => sample.peakRetainedImages <= 2), 'two-frame bound');
  const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(['before', 'after'].map(version => [version, Object.fromEntries(['elapsedMs', 'perFrameMs', 'captureMs', 'maxHeartbeatGapMs', 'lateHeartbeatMs']
    .map(key => [key, median(result[version].map(sample => sample[key]))]))]));
  console.log(JSON.stringify({ benchmark: 'T9 real WebGL capture + PNG + CRC + ZIP', atoms, frames, width, height, trials,
    command: ['node', 'scripts/benchmarks/benchmark-png-worker.mjs', ...process.argv.slice(2)],
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    workerStaging: 'bitmaprenderer transferFromImageBitmap; CPU 2D fallback',
    softwareAdapter: useSoftwareAdapter(), scope: 'Same unchanged renderer; interleaved export pipelines; Worker startup included; full ZIP SHA-256 equality. Heartbeat includes unavoidable main-thread WebGL capture.',
    summary, ...result }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
