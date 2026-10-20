import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

const source = process.argv.includes('--source'), root = resolve(import.meta.dirname, '..');
if (!source) assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-archive-logo-'));
const trajectory = resolve(directory, 'images.xyz');
await writeFile(trajectory, [0, 1].map(step => `2\nLattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T"\nFe ${1 + step} 1 1 1\nFe 3 3 3 2\n`).join(''));
try {
  const result = await withWebGpuBrowser(async ({ call, evaluate }) => {
    await call('Page.enable');
    const origin = await evaluate('location.origin'), page = `${origin}/AlloyView/${source ? '' : 'dist/'}index.html`;
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      localStorage.setItem('alloyview-theme','light');
      Object.defineProperty(Navigator.prototype,'hardwareConcurrency',{configurable:true,get:()=>4});
      window.logoErrors=[];window.addEventListener('error',event=>window.logoErrors.push(event.message));
      window.addEventListener('unhandledrejection',event=>window.logoErrors.push(String(event.reason)));
    ` });
    await call('Page.navigate', { url: page });
    async function waitFor(expression, label) {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(25); }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({toast:document.getElementById("toast")?.textContent,ready:document.readyState,fallback:document.querySelector(".empty-logo-fallback")?.outerHTML,errors:window.logoErrors})')}`);
    }
    await waitFor('document.getElementById("bcc-logo")?.hidden===false && document.getElementById("brand-logo")?.naturalWidth>0', 'Home logos');
    const cold = await evaluate(`(() => {
      const logo=document.getElementById('brand-logo'), fallback=document.querySelector('.empty-logo-fallback');
      return {brand:logo.currentSrc, width:logo.naturalWidth, fallbackSource:fallback.getAttribute('src'), fallbackHidden:fallback.hidden,
        resources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/assets/logo/')).map(entry=>({name:entry.name.split('/').at(-1),bytes:entry.decodedBodySize}))};
    })()`);
    assert.ok(cold.brand.endsWith('AlloyView_logo_dark.svg')); assert.equal(cold.width, 1700);
    assert.equal(cold.fallbackSource, null); assert.equal(cold.fallbackHidden, true);
    assert.equal(cold.resources.filter(entry=>entry.name.endsWith('.svg')).length, 1, 'Only the chosen initial theme is fetched');
    assert.ok(cold.resources.every(entry=>entry.bytes<70_000), 'Cold logo responses are small');
    await evaluate('document.getElementById("theme-dark").click()');
    await waitFor('document.getElementById("brand-logo").currentSrc.endsWith("AlloyView_logo_light.svg") && document.getElementById("brand-logo").naturalWidth>0', 'Dark wordmark');
    await evaluate(`(async () => {
      const app=document.querySelector('script[type=module][src]').src;
      const [{WebGLRenderer},{ImageArchiveBuilder},{PngFrameEncoder}]=await Promise.all([import(new URL('./render/webgl-renderer.js',app)),import(new URL('./io/export-archive.js',app)),import(new URL('./video/png-frame-encoder.js',app))]);
      const checks=window.archiveChecks={records:[],finishes:[],downloads:[],hold:false,workers:[],snapshots:[]};
      const NativeWorker=window.Worker;
      window.Worker=class extends NativeWorker { constructor(url,...args){super(url,...args);if(String(url).includes('png-encoder-worker'))checks.workers.push({url:String(url),worker:this});} };
      const setFrame=WebGLRenderer.prototype.setFrame;
      WebGLRenderer.prototype.setFrame=function(...args){if(this.canvas.id==='viewport')checks.renderer=this;return setFrame.apply(this,args);};
      const add=ImageArchiveBuilder.prototype.add, finish=ImageArchiveBuilder.prototype.finish;
      ImageArchiveBuilder.prototype.add=function(entry,...args){const result=add.call(this,entry,...args);if(!checks.reference)checks.records.push({name:entry.name,count:this.count,size:this.size});return result;};
      ImageArchiveBuilder.prototype.finish=function(...args){if(!checks.reference)checks.finishes.push({count:this.count,size:this.size});return finish.apply(this,args);};
      const encode=PngFrameEncoder.prototype.encode, encoded=PngFrameEncoder.prototype.finish;
      PngFrameEncoder.prototype.encode=function(canvas){
        const frame=checks.renderer.frame.frameIndex;
        checks.snapshots.push(new Promise(resolve=>canvas.toBlob(blob=>resolve({frame,blob}),'image/png')));
        return encode.call(this,canvas);
      };
      PngFrameEncoder.prototype.finish=function(job,result,error){
        if(!checks.hold||error)return encoded.call(this,job,result,error);
        checks.hold=false;checks.held=true;checks.release=()=>encoded.call(this,job,result,error);
      };
      const create=URL.createObjectURL;
      URL.createObjectURL=function(blob){if(blob.type==='application/zip')checks.downloads.push(blob);return create.call(this,blob);};
      HTMLAnchorElement.prototype.click=function(){};
      checks.change=(id,value)=>{const element=document.getElementById(id);element.value=String(value);element.dispatchEvent(new Event('change',{bubbles:true}));};
    })()`);
    await call('DOM.enable');
    const { root: dom } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: dom.nodeId, selector: '#file-input' });
    await call('DOM.setFileInputFiles', { nodeId, files: [trajectory] });
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    await waitFor('archiveChecks.renderer?.frame.ids.length===2 && document.getElementById("frame-count").textContent==="2" && document.getElementById("loading").hidden', 'Trajectory load');
    await evaluate(`archiveChecks.change('export-resolution','custom');archiveChecks.change('export-width',320);
      archiveChecks.change('export-series-first',1);archiveChecks.change('export-series-last',2);archiveChecks.change('export-series-step',1);
      document.getElementById('export-frame-series').click();`);
    await waitFor('archiveChecks.downloads.length===1 && document.getElementById("export-series-status").textContent.includes("Exported 2 frames")', 'Incremental archive');
    const archive = await evaluate(`(async () => {
      const app=document.querySelector('script[type=module][src]').src,{crc32,createImageArchive}=await import(new URL('./io/export-archive.js',app));
      const blob=archiveChecks.downloads[0],bytes=new Uint8Array(await blob.arrayBuffer()), view=new DataView(bytes.buffer),images=[];
      let offset=0;
      while(view.getUint32(offset,true)===0x04034b50){const length=view.getUint32(offset+18,true),start=offset+30+view.getUint16(offset+26,true),data=bytes.slice(start,start+length);
        const image=await createImageBitmap(new Blob([data],{type:'image/png'}));images.push({width:image.width,height:image.height,crc:crc32(data)===view.getUint32(offset+14,true)});image.close();offset=start+length;}
      archiveChecks.reference=true;
      const snapshots=await Promise.all(archiveChecks.snapshots),expected=await createImageArchive(await Promise.all(snapshots.map(async({frame,blob})=>({name:'images-frame-'+String(frame+1).padStart(6,'0')+'.png',bytes:new Uint8Array(await blob.arrayBuffer())})))).arrayBuffer();
      archiveChecks.reference=false;
      return {records:archiveChecks.records,finishes:archiveChecks.finishes,images,size:blob.size,restoredFrame:archiveChecks.renderer.frame.frameIndex,
        byteIdentical:bytes.length===expected.byteLength&&bytes.every((value,index)=>value===new Uint8Array(expected)[index]),workers:archiveChecks.workers.map(entry=>entry.url)};
    })()`);
    assert.deepEqual(archive.records.map(record=>record.name), ['images-frame-000001.png','images-frame-000002.png']);
    assert.deepEqual(archive.finishes.map(entry=>entry.count), [2]);
    assert.equal(archive.restoredFrame, 0); assert.ok(archive.images.every(image=>image.width===320 && image.crc));
    assert.equal(archive.byteIdentical,true,'Worker PNG and CRC preserve the complete main-thread ZIP bytes');
    assert.equal(archive.workers.length,1);
    if(!source)assert.match(archive.workers[0],/\/assets\/[a-f0-9]+\/src\/workers\/png-encoder-worker\.js$/,'production uses the bundled content-hashed Worker');
    await evaluate(`archiveChecks.hold=true;document.getElementById('export-frame-series').click()`);
    await waitFor('archiveChecks.held', 'Image encoding held');
    await evaluate(`document.getElementById('cancel-frame-series').click()`);
    await waitFor('document.getElementById("export-series-status").textContent==="Export cancelled."', 'Cancellation');
    await evaluate('archiveChecks.release()');
    assert.equal(await evaluate('archiveChecks.downloads.length'), 1, 'Cancelled export publishes no ZIP');
    assert.equal(await evaluate('archiveChecks.finishes.length'), 1, 'Cancelled export never assembles a directory');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      const getContext=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(...args){return this.id==='bcc-logo'?null:getContext.apply(this,args);};
    ` });
    await call('Page.navigate', { url: page });
    await waitFor('document.querySelector(".empty-logo-fallback")?.hidden===false && document.querySelector(".empty-logo-fallback")?.naturalWidth>0', 'Unsupported WebGL fallback');
    const fallback = await evaluate(`({canvasHidden:document.getElementById('bcc-logo').hidden,width:document.querySelector('.empty-logo-fallback').naturalWidth,
      resources:performance.getEntriesByType('resource').filter(entry=>entry.name.endsWith('AlloyView_logo_only.png')).map(entry=>({bytes:entry.decodedBodySize}))})`);
    assert.equal(fallback.canvasHidden,true); assert.equal(fallback.width,264);
    assert.equal(fallback.resources.length,1); assert.ok(fallback.resources[0].bytes<50_000);
    return {cold,archive,fallback};
  }, {requireGpu:false});
  console.log(JSON.stringify({result:'passed',tree:source?'source':'production',...result},null,2));
} finally {await rm(directory,{recursive:true,force:true});}
