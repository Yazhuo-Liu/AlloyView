// Archived review evidence for baseline 77b24ad; see docs/REPOSITORY_REVIEW_2026-10-16.md.
import assert from 'node:assert/strict';
import { withWebGpuBrowser } from '../../../scripts/webgpu-browser.mjs';
const report=await withWebGpuBrowser(async({evaluate,call})=>{
 const origin=await evaluate('location.origin');await call('Page.navigate',{url:origin+'/AlloyView/index.html'});
 await evaluate(`(async()=>{while(document.readyState!=='complete')await new Promise(r=>setTimeout(r,10));const{WebGLRenderer}=await import('/AlloyView/src/render/webgl-renderer.js');const original=WebGLRenderer.prototype.setFrame;WebGLRenderer.prototype.setFrame=function(...args){if(this.canvas.id==='viewport')window.auditRenderer=this;return original.apply(this,args)};const input=document.getElementById('file-input'),transfer=new DataTransfer();transfer.items.add(new File(['2\\nLattice="10 0 0 0 10 0 0 0 10" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1\\nFe 5 5 5 1\\nNi 5 5 6 2\\n'],'pick.xyz'));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));while(window.auditRenderer?.atomCount!==2||!document.getElementById('loading').hidden)await new Promise(r=>setTimeout(r,10));for(const[label,color,radius]of[['Fe','#ff0000',3],['Ni','#0000ff',.5]]){document.querySelector('[aria-label="'+label+' atom color"]').value=color;const field=document.querySelector('[aria-label="'+label+' radius in angstroms"]');field.value=radius;field.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('[data-view="top"]').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`);
 const screen=await evaluate(`(()=>{const r=auditRenderer,c=r.canvas,rect=c.getBoundingClientRect(),gl=r.gl,pixel=new Uint8Array(4);r.render(0,{trackStats:false});gl.readPixels(c.width/2,c.height/2,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return{x:rect.left+rect.width/2,y:rect.top+rect.height/2,pixel:[...pixel],radii:[...r.atomRadii],radiusScale:r.radiusScale}})()`);
 for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,x:screen.x,y:screen.y,button:'left',clickCount:1});
 const picking=await evaluate(`({selectedAtomId:auditRenderer.frame.ids[auditRenderer.selected],details:document.getElementById('atom-details').textContent})`);
 const before=await evaluate(`(()=>{document.querySelector('[data-view="bottom"]').click();return auditRenderer.cameraBasis()})()`);
 await call('Input.dispatchMouseEvent',{type:'mousePressed',x:screen.x,y:screen.y,button:'left',clickCount:1});
 await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:screen.x+4,y:screen.y,button:'left',buttons:1});
 await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:screen.x+4,y:screen.y,button:'left',clickCount:1});
 const after=await evaluate('auditRenderer.cameraBasis()');const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
 return{screen,picking,bottomDrag:{pixelsMoved:4,rightDot:dot(before.right,after.right),upDot:dot(before.up,after.up)}};
},{requireGpu:false});
assert.equal(report.picking.selectedAtomId,2);assert.ok(report.screen.pixel[0]>report.screen.pixel[2]*4);assert.ok(report.bottomDrag.upDot<-.99);
console.log(JSON.stringify(report,null,2));
