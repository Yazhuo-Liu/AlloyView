import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
  let base = '/AlloyView/src';
  if (production) {
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    for (let i = 0; i < 500 && !await evaluate('document.readyState==="complete"&&!!document.getElementById("viewport")'); i++) await delay(20);
    base = await evaluate('new URL(".",document.querySelector("script[type=module][src]").src).pathname.replace(/\\/$/,"")');
  }
  return evaluate(`(async()=>{
    const [{PngFrameEncoder},{PngArchiveQueue},{createImageArchive,crc32},{WebGLRenderer},{createCell,fractionalToCartesian}]=await Promise.all([
      import('${base}/video/png-frame-encoder.js'),import('${base}/video/png-archive-queue.js'),import('${base}/io/export-archive.js'),
      import('${base}/render/webgl-renderer.js'),import('${base}/data/model.js')]);
    const check=(value,label)=>{if(!value)throw new Error(label);};
    const exact=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
    const NativeWorker=window.Worker,workers=[];
    window.Worker=class extends NativeWorker {constructor(url,...args){super(url,...args);if(String(url).includes('png-encoder-worker'))workers.push({url:String(url),worker:this,terminated:false});}
      terminate(){const entry=workers.find(entry=>entry.worker===this);if(entry)entry.terminated=true;super.terminate();}};
    const toBlob=canvas=>new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const reports=[],entries=[],expected=[],encoder=new PngFrameEncoder();
    async function compare(canvas,name){
      const baseline=await toBlob(canvas),a=new Uint8Array(await baseline.arrayBuffer()),encoded=await encoder.encode(canvas),b=new Uint8Array(await encoded.blob.arrayBuffer());
      check(exact(a,b),name+': exact PNG bytes');check(crc32(a)===encoded.crc,name+': CRC');
      reports.push({name,size:a.length,width:canvas.width,height:canvas.height,exact:true});
      entries.push({name:name+'.png',...encoded});expected.push({name:name+'.png',bytes:a});
      canvas.width=canvas.height=1;
    }
    for(const alpha of[false,true]){
      const canvas=document.createElement('canvas');canvas.width=321;canvas.height=241;const context=canvas.getContext('2d'),image=context.createImageData(canvas.width,canvas.height);
      for(let i=0;i<image.data.length;i++)image.data[i]=i%4===3&&!alpha?255:(Math.imul(i,17)+(i>>>8))&255;
      context.putImageData(image,0,0);context.font='19px sans-serif';context.fillStyle='rgba(255,0,100,.37)';context.fillText('Fe / Ni · 透明',13,29);
      await compare(canvas,alpha?'rgba-text-edges':'opaque-text-edges');
    }
    const canvas=document.createElement('canvas');canvas.style.cssText='width:321px;height:241px';document.body.append(canvas);
    const renderer=new WebGLRenderer(canvas),cell=createCell({origin:[0,0,0],vectors:[8,0,0,0,8,0,0,0,8]});
    const fractional=Float64Array.of(.2,.2,.2,.6,.3,.4,.4,.7,.6),positions=fractionalToCartesian(fractional,cell);
    renderer.setFrame({cell,fractional,positions,ids:Uint32Array.of(1,2,3)},Uint8Array.of(220,20,30,20,120,220,90,200,60),positions,Float32Array.of(.7,.9,.8),[1,1,1]);
    renderer.setBackground('#ffffff');renderer.resetCamera();
    for(const includeBackground of[true,false])for(const mode of['current','custom']){
      const image=await renderer.captureImage({includeBackground,resolution:mode==='current'?{mode}:{mode,width:377,height:255,lockAspect:false}});
      await compare(image,'webgl-'+mode+'-'+(includeBackground?'opaque':'transparent'));
    }
    const oldZip=new Uint8Array(await createImageArchive(expected).arrayBuffer()),newZip=new Uint8Array(await createImageArchive(entries).arrayBuffer());
    check(exact(oldZip,newZip),'Complete ZIP equality');encoder.dispose();renderer.clearFrame();canvas.remove();
    // A real Worker crash after two captures must retry those exact canvases.
    const crashed=new PngFrameEncoder();let fallbackCalls=0;
    const source=document.createElement('canvas');source.width=23;source.height=17;source.getContext('2d').fillRect(2,3,12,7);
    const baseline=await toBlob(source),original=source.toBlob.bind(source);source.toBlob=(...args)=>{fallbackCalls++;return original(...args);};
    const a=crashed.encode(source),b=crashed.encode(source);
    crashed.worker.dispatchEvent(new ErrorEvent('error',{message:'synthetic encoder crash',cancelable:true}));
    for(const result of await Promise.all([a,b]))check(exact(new Uint8Array(await baseline.arrayBuffer()),new Uint8Array(await result.blob.arrayBuffer())),'Crash fallback snapshot equality');
    check(fallbackCalls===2,'Each failed frame retries once');crashed.dispose();
    const controller=new AbortController(),cancelled=new PngFrameEncoder({signal:controller.signal}),pending=cancelled.encode(source);
    controller.abort();let aborted=false;try{await pending;}catch(error){aborted=error.name==='AbortError';}check(aborted,'Cancellation rejects immediately');
    check(workers.every(entry=>entry.terminated),'All export Workers terminated');
    window.Worker=NativeWorker;
    return {production:${production},cases:reports,zipBytes:oldZip.length,zipExact:true,fallbackCalls,aborted,workers:workers.map(({url,terminated})=>({url,terminated}))};
  })()`);
}, { requireGpu: false });
assert.equal(report.cases.length, 6);assert.equal(report.zipExact, true);assert.equal(report.fallbackCalls, 2);assert.equal(report.aborted, true);
if (production) for (const { url } of report.workers) assert.match(url, /\/assets\/[a-f0-9]+\/src\/workers\/png-encoder-worker\.js$/);
console.log(JSON.stringify({ result: 'passed', ...report }, null, 2));
