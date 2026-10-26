import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';
const production = process.argv.includes('--production');
const root = resolve(import.meta.dirname, '../..');
const result = await withWebGpuBrowser(async ({evaluate,call}) => {
  const origin = await evaluate('location.origin');
  const url = `${origin}/AlloyView/${production ? 'dist/' : ''}index.html`;
  const waitFor = async (expression,label) => { const deadline=Date.now()+60000;while(!await evaluate(expression)) {
    if(Date.now()>deadline)throw Error(label+': '+await evaluate(`document.getElementById('toast')?.textContent`));await delay(25);
  }};
  await call('Page.navigate',{url});await waitFor('document.readyState==="complete"','startup');
  const direct = await evaluate(`(async()=>{
  const moduleUrl = path => new URL(path, document.querySelector('script[type=module][src]').src).href;
  const {WebGLRenderer}=await import(moduleUrl('./render/webgl-renderer.js'));
  const {parseCif}=await import(moduleUrl('./io/cif.js'));
  const frame=parseCif(await (await fetch('/AlloyView/examples/crystals/SrTiO3_thermal.cif')).text());
  const canvas=document.createElement('canvas');canvas.style.cssText='width:480px;height:400px';document.body.append(canvas);
  const r=new WebGLRenderer(canvas),gl=r.gl;
  r.setFrame(frame,new Uint8Array(frame.ids.length*3).fill(180),frame.positions,new Float32Array(frame.ids.length).fill(.7));
  r.setBackground('#ffffff');r.setView('top');r.resetCamera();r.setView('top');
  const pixels=()=>{r.render(0,{trackStats:false});const bytes=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return bytes;};
  const original=pixels();r.setThermalEllipsoids(frame.thermalEllipsoids,{enabled:true,probability:.95,opacity:.8});
  const shown=pixels(),buffer=r.thermalEllipsoidLayer.axesBuffer,firstData=r.thermalEllipsoidLayer.data;
  let changed=0;for(let i=0;i<shown.length;i++)changed+=shown[i]!==original[i];
  r.setThermalEllipsoids(frame.thermalEllipsoids,{enabled:true,probability:.5,opacity:1});pixels();
  const retained=buffer===r.thermalEllipsoidLayer.axesBuffer&&firstData===r.thermalEllipsoidLayer.data;
  r.setSelectedAtoms([0,1]);r.setPeriodicOrigin([.1,.1,0]);r.setReplications([2,1,1]);
  r.setScalarColorPreview(Float64Array.from([0,1,2,3,4]),{minimum:0,maximum:4,colorStops:[[0,0,0,255],[1,255,0,0]],hideOutside:false});pixels();
  const glBefore=gl.getError();r.clearScalarColorPreview();r.setVisibility(Uint8Array.from([255,0,255,255,255]));
  const before=pixels();
  const extension=gl.getExtension('WEBGL_lose_context');
  const wait=async test=>{const deadline=performance.now()+15000;while(!test()){if(performance.now()>deadline)throw Error('Context timeout');await new Promise(resolve=>setTimeout(resolve,20));}};
  extension.loseContext();await wait(()=>r.contextLost);extension.restoreContext();await wait(()=>!r.contextLost&&!gl.isContextLost());
  const after=pixels();let difference=0;for(let i=0;i<after.length;i++)difference+=after[i]!==before[i];
  const glAfter=gl.getError();const png=await r.captureImage();
  r.clearFrame();const clear=r.thermalEllipsoids===null&&r.thermalEllipsoidLayer.data===null;
  return{count:frame.thermalEllipsoids.count,changed,retained,glBefore,glAfter,difference,clear,png:!!png};
})()`);
  // Reload the real app and observe only its renderer instances. No direct
  // controller calls: file loading, display edits and recipe restore use UI.
  await call('Page.navigate',{url});await waitFor('document.readyState==="complete"','app startup');
  await evaluate(`(async()=>{
    const app=document.querySelector('script[type=module][src]').src;
    const {WebGLRenderer}=await import(new URL('./render/webgl-renderer.js',app));
    window.thermalChecks={};const old=WebGLRenderer.prototype.setFrame;
    WebGLRenderer.prototype.setFrame=function(...args){thermalChecks[this.canvas.id==='viewport'?'main':'second']=this;return old.apply(this,args);};
  })()`);
  const {root:document}=await call('DOM.getDocument');
  const {nodeId}=await call('DOM.querySelector',{nodeId:document.nodeId,selector:'#file-input'});
  await call('DOM.setFileInputFiles',{nodeId,files:[resolve(root,'examples/crystals/SrTiO3_thermal.cif')]});
  await evaluate(`document.getElementById('file-input').dispatchEvent(new Event('change',{bubbles:true}))`);
  await waitFor(`thermalChecks.main?.frame?.thermalEllipsoids?.count===5 && document.getElementById('loading').hidden`,'ADP file load');
  assert.equal(await evaluate(`document.getElementById('thermal-controls').open`),false);
  assert.equal(await evaluate(`document.getElementById('thermal-enabled').checked`),false);
  await evaluate(`(()=>{
    document.querySelector('[data-tool-button=crystal]').click();document.getElementById('thermal-controls').open=true;
    const checkbox=document.getElementById('thermal-enabled');if(checkbox.disabled)throw Error('Thermal control disabled');checkbox.click();
  })()`);
  await waitFor('thermalChecks.main.thermalEllipsoidOptions.enabled && !!thermalChecks.main.thermalEllipsoidLayer','thermal UI enable');
  await evaluate(`(()=>{const input=document.getElementById('thermal-probability');input.value='95';input.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-tool-button=display]').click();const compare=document.getElementById('compare-view');compare.checked=true;compare.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor('thermalChecks.second?.thermalEllipsoidOptions?.probability===.95 && thermalChecks.second.thermalEllipsoids===thermalChecks.main.thermalEllipsoids','second view thermal sync');
  await evaluate(`(()=>{
    const urls=new Map(),create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;
    URL.createObjectURL=function(blob){const url=create.call(this,blob);urls.set(url,blob);return url;};
    HTMLAnchorElement.prototype.click=function(){const blob=urls.get(this.href);if(blob)thermalChecks.download=blob;};
    thermalChecks.restoreDownload=()=>{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;};
    document.getElementById('export-configuration').click();
  })()`);
  await waitFor('!!thermalChecks.download','configuration download');
  const recipe=await evaluate(`(async()=>{const text=await thermalChecks.download.text();thermalChecks.recipe=text;thermalChecks.restoreDownload();return JSON.parse(text);})()`);
  assert.equal(recipe.settings.extensions.crystal.thermalEllipsoids.probability,.95);
  await evaluate(`(()=>{
    document.getElementById('thermal-enabled').click();
    const input=document.getElementById('configuration-file'),transfer=new DataTransfer();
    transfer.items.add(new File([thermalChecks.recipe],'thermal.json',{type:'application/json'}));input.files=transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor(`document.getElementById('configuration-status').textContent.startsWith('Configuration restored.')`,'configuration restore');
  assert.equal(await evaluate('thermalChecks.main.thermalEllipsoidOptions.enabled'),true);
  assert.equal(await evaluate('thermalChecks.main.thermalEllipsoidOptions.probability'),.95);
  const errors=await evaluate('[thermalChecks.main.gl.getError(),thermalChecks.second.gl.getError()]');assert.deepEqual(errors,[0,0]);
  return {direct,ui:{production,fileInput:true,foldedByDefault:true,secondView:true,configuration:true,glErrors:errors}};
},{requireGpu:false});
assert.equal(result.direct.count,5);assert.ok(result.direct.changed>100);assert.equal(result.direct.retained,true);
assert.equal(result.direct.glBefore,0);assert.equal(result.direct.glAfter,0);assert.equal(result.direct.difference,0);assert.equal(result.direct.clear,true);assert.equal(result.direct.png,true);
console.log(JSON.stringify(result,null,2));
