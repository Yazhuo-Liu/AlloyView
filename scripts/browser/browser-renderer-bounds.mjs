import assert from 'node:assert/strict';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Source-only comparison of optimized bounds against the original merge.
// Pixel equality is a correctness check; SwiftShader is not a speed benchmark.
const report = await withWebGpuBrowser(async ({ evaluate }) => evaluate(`(async () => {
  const {WebGLRenderer}=await import('/AlloyView/src/render/webgl-renderer.js');
  const {AmbientOcclusionController}=await import('/AlloyView/src/render/ambient-occlusion.js');
  const {createCell,cellVertices,fractionalToCartesian}=await import('/AlloyView/src/data/model.js');
  function original(r){
    const minimum=[Infinity,Infinity,Infinity],maximum=[-Infinity,-Infinity,-Infinity],sourceMinimum=[...minimum],sourceMaximum=[...maximum];
    for(const array of[cellVertices(r.displayCell??r.frame.cell),r.displayPositions])for(let i=0;i<array.length;i+=3)for(let c=0;c<3;c++){
      const atoms=array===r.displayPositions;
      if(atoms){sourceMinimum[c]=Math.min(sourceMinimum[c],array[i+c]);sourceMaximum[c]=Math.max(sourceMaximum[c],array[i+c]);}
      minimum[c]=Math.min(minimum[c],array[i+c]+(atoms?r.minimumOffset?.[c]??0:0));
      maximum[c]=Math.max(maximum[c],array[i+c]+(atoms?r.maximumOffset?.[c]??0:0));
    }
    const layer=r.primitiveLayer;
    for(const {vectors,options} of layer?.vectorFields??[]){
      if(!options.visible)continue;
      const shift={tail:0,head:-1,center:-.5}[options.anchor??'tail'],padding=Math.max(options.radius,options.headRadius??.15);
      for(let i=0;i<vectors.length;i+=3){
        if(r.selectionVisibility?.[i/3]===0||!Number.isFinite(vectors[i])||!Number.isFinite(vectors[i+1])||!Number.isFinite(vectors[i+2]))continue;
        for(let c=0;c<3;c++){const delta=vectors[i+c]*options.scale,tail=r.displayPositions[i+c]+delta*shift,tip=tail+delta;
          minimum[c]=Math.min(minimum[c],Math.min(tail,tip)+(r.minimumOffset?.[c]??0)-padding);
          maximum[c]=Math.max(maximum[c],Math.max(tail,tip)+(r.maximumOffset?.[c]??0)+padding);
        }
      }
    }
    for(const name of['dislocationLayer','siteMarkerLayer','surfaceMeshLayer','trajectoryLineLayer','voronoiCellLayer','voronoiAllCellLayer'])r[name]?.extendBounds(r,minimum,maximum);
    r.selectionSourceBounds={minimum:sourceMinimum,maximum:sourceMaximum};return r.sceneBounds={minimum,maximum};
  }
  const canvas=document.createElement('canvas');canvas.style.cssText='width:420px;height:320px';document.body.append(canvas);
  const r=new WebGLRenderer(canvas),gl=r.gl;
  const cell=createCell({origin:[10,-3,2],vectors:[-16,1,0,2,16,1,-3,2,16]});
  const f=[];for(let x=0;x<5;x++)for(let y=0;y<5;y++)for(let z=0;z<5;z++)f.push(.2+x*.12,.2+y*.12,.2+z*.12);
  const fractional=Float64Array.from(f),positions=fractionalToCartesian(fractional,cell),frame={cell,fractional,positions,ids:Uint32Array.from({length:125},(_,i)=>i+1)};
  r.setFrame(frame,new Uint8Array(375).fill(160),positions,new Float32Array(125).fill(1.3),[2,1,1]);r.setBackground('#ffffff');r.setSelectedAtoms([1,30]);
  const vectors=Float32Array.from({length:375},(_,i)=>Math.sin(i)*3),second=Float32Array.from(vectors,value=>-value);
  const fields=[{id:'first',vectors,options:{scale:2,anchor:'center',color:'#ff7000'}},{id:'second',vectors:second,options:{scale:1.5,anchor:'head',color:'#00a0e0'}}];
  r.setVectorFields(fields);
  const controller=new AmbientOcclusionController(r,{schedule(){return()=>{};}});
  controller.setSettings({enabled:true,directions:16,resolution:256});
  const bytes=()=>{r.render(performance.now(),{trackStats:false});const data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;};
  const scenarios=[];
  const exact=(a,b)=>a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]));
  for(const mode of['wrapped','slice','origin','unwrapped','selection-hidden']){
    if(mode==='slice')r.setSlices([{id:'cut',enabled:true,normal:[1,0,1],position:5,side:'negative'}]);
    if(mode==='origin')r.setPeriodicOrigin([.2,.1,0]);
    if(mode==='unwrapped'){
      const continuous=fractionalToCartesian(Float64Array.from(fractional,(value,i)=>value+(i%3===0?1:0)),cell);
      r.setDisplayPositions(continuous,{coordinateMode:'unwrapped'});r.setReplications([1,2,2]);
    }
    if(mode==='selection-hidden'){
      r.setVisibility(Uint8Array.from({length:125},(_,i)=>i%2?0:255),{selectionVisibility:Uint8Array.from({length:125},(_,i)=>i%3?255:0)});
      r.setVectorFields(fields.map(field=>({...field,options:{...field.options,scale:3}})));
    }
    const expected=original(r);r.resetCamera();controller.result=null;controller.ensureCurrent();const before=bytes(),factors=controller.result.factors.slice();
    const actual=r.updateSceneBounds({reuseSourceBounds:true});r.resetCamera();controller.result=null;controller.ensureCurrent();const after=bytes();
    let different=0;for(let i=0;i<before.length;i++)if(before[i]!==after[i])different++;
    scenarios.push({mode,boundsExact:exact(actual.minimum,expected.minimum)&&exact(actual.maximum,expected.maximum),
      pixelBytesEqual:different===0,differingBytes:different,ambientOcclusionExact:exact(controller.result.factors,factors),glError:gl.getError()});
  }
  controller.dispose();r.clearFrame();return{scenarios,dimensions:[canvas.width,canvas.height]};
})()`), { requireGpu: false });
assert.equal(report.scenarios.length, 5);
for (const scenario of report.scenarios) {
  assert.equal(scenario.boundsExact, true, scenario.mode);
  assert.equal(scenario.pixelBytesEqual, true, scenario.mode);
  assert.equal(scenario.ambientOcclusionExact, true, scenario.mode);
  assert.equal(scenario.glError, 0, scenario.mode);
}
console.log(JSON.stringify(report, null, 2));
