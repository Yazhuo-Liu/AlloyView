// Archived review evidence for baseline 77b24ad; see docs/REPOSITORY_REVIEW_2026-10-16.md.
import assert from 'node:assert/strict';
import { withWebGpuBrowser } from '../../../scripts/webgpu-browser.mjs';
const report=await withWebGpuBrowser(async({evaluate,call})=>{
 const origin=await evaluate('location.origin');await call('Page.navigate',{url:origin+'/AlloyView/index.html'});
 await evaluate(`(async()=>{while(document.readyState!=='complete')await new Promise(r=>setTimeout(r,10));const{WebGLRenderer}=await import('/AlloyView/src/render/webgl-renderer.js');const original=WebGLRenderer.prototype.setFrame;WebGLRenderer.prototype.setFrame=function(...args){if(this.canvas.id==='viewport')window.auditMain=this;else if(this.canvas.closest?.('#comparison-view'))window.auditSecond=this;return original.apply(this,args)};const input=document.getElementById('file-input'),transfer=new DataTransfer();transfer.items.add(new File(['2\\nLattice="10 0 0 0 10 0 0 0 10" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1\\nFe 2 3 5 1\\nNi 7 7 5 2\\n'],'slice.xyz'));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));while(window.auditMain?.atomCount!==2||!document.getElementById('loading').hidden)await new Promise(r=>setTimeout(r,10));document.getElementById('replicate-a').value=2;document.getElementById('apply-replicate').click();while(auditMain.repetitions[0]!==2)await new Promise(r=>setTimeout(r,10));const compare=document.getElementById('compare-view');compare.checked=true;compare.dispatchEvent(new Event('change',{bubbles:true}));while(!window.auditSecond?.frame)await new Promise(r=>setTimeout(r,10));document.querySelector('[data-compare-view="top"]').click();document.getElementById('slice-pick-atoms').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`);
 const picks=[];
 for(const pos of [[12,3,5],[7,7,5]]){
  const point=await evaluate(`(()=>{const r=auditSecond;r.updateMatrices();const w=${JSON.stringify(pos)},v=r.viewMatrix,p=r.projectionMatrix;const view=[0,1,2,3].map(i=>v[i]*w[0]+v[4+i]*w[1]+v[8+i]*w[2]+v[12+i]);const clip=[0,1,2,3].map(i=>p[i]*view[0]+p[4+i]*view[1]+p[8+i]*view[2]+p[12+i]*view[3]);const rect=r.canvas.getBoundingClientRect(),x=rect.left+(clip[0]/clip[3]+1)*rect.width/2,y=rect.top+(1-clip[1]/clip[3])*rect.height/2;return {x,y,target:document.elementFromPoint(x,y)?.tagName}})()`);
  assert.equal(point.target,'CANVAS');
  for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:'left',clickCount:1});
  picks.push(await evaluate('({main:auditMain.lastPick,second:auditSecond.lastPick,help:document.getElementById("slice-pick-help").textContent})'));
 }
 return await evaluate(`(()=>{document.getElementById('slice-from-two').click();return {picks:${JSON.stringify(picks)},actual:auditMain.slices,expectedNormal:[-5/Math.sqrt(41),4/Math.sqrt(41),0],expectedPosition:(-5*9.5+4*5)/Math.sqrt(41)}})()`);
},{requireGpu:false});
assert.equal(report.picks[0].second.replica[0],1);assert.equal(report.actual.length,1);assert.ok(report.actual[0].normal[0]>0);console.log(JSON.stringify(report,null,2));
