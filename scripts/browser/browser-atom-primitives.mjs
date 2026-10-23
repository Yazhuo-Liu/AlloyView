import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Draw the original expanded triangles as an independent geometry oracle.
const productionSource = await readFile(new URL('../../src/render/atom-primitives.js', import.meta.url), 'utf8');
const start = productionSource.indexOf('export function createIndexedPrimitiveMesh(');
const end = productionSource.indexOf('/** Flat rectangle/triangle meshes', start);
assert.ok(start >= 0 && end > start);
const source = productionSource.slice(0, start)
  + 'export function createIndexedPrimitiveMesh(cone = false, sides = 10) { return { vertices: createPrimitiveMesh(cone, sides) }; }\n\n'
  + productionSource.slice(end);
const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({evaluate,call}) => {
  if (production) {
    const origin = await evaluate('location.origin');
    await call('Page.navigate', {url:`${origin}/AlloyView/dist/index.html`});
    const deadline = Date.now() + 30_000;
    while (!(await evaluate('document.readyState === "complete" && document.querySelector("[data-tool-button=coordination]")'))) {
      if (Date.now() > deadline) throw new Error('Production page startup timed out.');
      await delay(25);
    }
  }
  return evaluate(`(async()=>({production:${production},entry:${production} ? document.querySelector('script[type=module][src]').src : null,
    singleSample:await (${run.toString()})(${JSON.stringify(source)},false,${production}),
    multisample:await (${run.toString()})(${JSON.stringify(source)},true,${production})}))()`);
}, {requireGpu:false});
console.log(JSON.stringify(report,null,2));
assert.ok([report.singleSample,report.multisample].every(result=>result.exportDifferences===0&&result.rows.every(row => row.differingBytes === 0 && row.errorA === 0 && row.errorB === 0)));


async function run(source, antialias, production) {
  // Production resolves the candidate and dependencies from the built page's
  // real content-versioned facade; the oracle still expands independent caps.
  const baseUrl = production
    ? new URL('./render/atom-primitives.js',document.querySelector('script[type=module][src]').src)
    : new URL('./src/render/atom-primitives.js',location.href);
  source = source.replace(/from '([^']+)'/g,(_,name)=>`from '${new URL(name,baseUrl).href}'`);
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
  const [{AtomPrimitiveLayer:Baseline},{AtomPrimitiveLayer:Candidate},{WebGLRenderer},{crystalFrame},{calculateBonds},{createCell,fractionalToCartesian}] = await Promise.all([
    import(url),import(baseUrl),import(new URL('./webgl-renderer.js',baseUrl)),import('/AlloyView/tests/helpers/crystals.js'),
    import(new URL('../analysis/bonds.js',baseUrl)),import(new URL('../data/model.js',baseUrl))]);
  URL.revokeObjectURL(url);
  const frame=crystalFrame('fcc',2,3.52);
  frame.cell=createCell({vectors:[7.04,0,0,1.2,7.04,0,-.8,.7,7.04]}); frame.positions=fractionalToCartesian(frame.fractional,frame.cell);
  const colors=Uint8Array.from({length:frame.types.length*3},(_,i)=>[175,85,215][i%3]);
  const bonds=calculateBonds(frame,{cutoff:3.0});
  const canvases=[0,1].map(()=>{const canvas=document.createElement('canvas');canvas.style.cssText='width:480px;height:320px';document.body.append(canvas);return canvas;});
  canvases.forEach(canvas=>canvas.getContext('webgl2',{alpha:true,antialias,preserveDrawingBuffer:true}));
  const renderers=canvases.map(canvas=>new WebGLRenderer(canvas));
  renderers.forEach(r=>{r.requestRender=()=>{};r.setFrame(frame,colors);r.setBackground('#182b35');});
  const baseline=renderers[0].primitiveLayer=new Baseline(renderers[0].gl);baseline.setFrame(renderers[0],colors);
  const candidate=renderers[1].primitiveLayer=new Candidate(renderers[1].gl);candidate.setFrame(renderers[1],colors);
  const rows=[], textureUploads=[]; const upload=candidate.uploadTexture.bind(candidate);
  candidate.uploadTexture=(index,values,...args)=>{textureUploads.push({index,bytes:values.byteLength});return upload(index,values,...args);};
  if(candidate.positionValues || candidate.colorValues || candidate.fractionalValues || candidate.visibilityValues) throw Error('Inactive layer allocated atom mirrors');
  const compare = (label, requirePrimitivePixels=true) => {
    const images=renderers.map(r=>{r.render(performance.now(),{trackStats:false});const p=new Uint8Array(r.canvas.width*r.canvas.height*4);r.gl.readPixels(0,0,r.canvas.width,r.canvas.height,r.gl.RGBA,r.gl.UNSIGNED_BYTE,p);return p;});
    let differingBytes=0,maximumDifference=0;for(let i=0;i<images[0].length;i++){const delta=Math.abs(images[0][i]-images[1][i]);if(delta)differingBytes++;maximumDifference=Math.max(maximumDifference,delta);}
    const base=renderers[0], layer=base.primitiveLayer; base.primitiveLayer=null; base.render(performance.now(),{trackStats:false}); const without=new Uint8Array(images[0].length); base.gl.readPixels(0,0,base.canvas.width,base.canvas.height,base.gl.RGBA,base.gl.UNSIGNED_BYTE,without); base.primitiveLayer=layer; let primitivePixelBytes=0; for(let i=0;i<without.length;i++) if(images[0][i]!==without[i])primitivePixelBytes++;
    rows.push({label,bytes:images[0].length,differingBytes,maximumDifference,primitivePixelBytes,
      capless:candidate.coveredBondMesh(renderers[1])===candidate.caplessCylinder,
      errorA:renderers[0].gl.getError(),errorB:renderers[1].gl.getError()});
    if(requirePrimitivePixels&&!primitivePixelBytes) throw new Error(label+' exercises no primitive pixels');
    if(differingBytes) throw new Error(label+' differs in '+differingBytes+' bytes; max '+maximumDifference);
  };
  const both=fn=>renderers.forEach(fn);
  both(r=>r.setBonds(bonds,{radius:.15})); compare('guarded capless bonds / skew cell');
  if(rows.at(-1).capless!==candidate.singleSampleDefault) throw Error('Normal-sized spheres must exercise capless only on single-sample contexts');
  if(candidate.singleSampleDefault && !(candidate.caplessCylinder.count<candidate.cylinder.count))throw Error('Capless must reduce actual draw indices');
  // Negative control: reproduce why geometry-only cap removal is not enabled
  // on multisampled contexts. A driver may produce no difference, so record
  // this observation without making its raster behavior a required contract.
  let unsafeMultisampleControl=null;
  if(!candidate.singleSampleDefault&&renderers[1].gl.getParameter(renderers[1].gl.SAMPLES)>0){
    const r=renderers[1],gl=r.gl,read=()=>{const bytes=new Uint8Array(r.canvas.width*r.canvas.height*4);gl.readPixels(0,0,r.canvas.width,r.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return bytes;};
    const capped=read();candidate.singleSampleDefault=true;candidate.bondBuffers.displayShifts=bonds.shifts;
    try{r.render(performance.now(),{trackStats:false});const capless=read();let differingBytes=0,maximumDifference=0,firstDifference=-1;
      for(let i=0;i<capped.length;i++){const difference=Math.abs(capped[i]-capless[i]);if(difference){differingBytes++;if(firstDifference<0)firstDifference=i;}maximumDifference=Math.max(maximumDifference,difference);}
      let firstPixel=null;
      if(firstDifference>=0){
        const offset=firstDifference-firstDifference%4,x=(offset/4)%r.canvas.width,y=Math.floor(offset/4/r.canvas.width);
        firstPixel={x,y,capped:Array.from(capped.subarray(offset,offset+4)),capless:Array.from(capless.subarray(offset,offset+4))};
        // Record whether the observation is even near a sphere's fading edge.
        // This is diagnostic evidence, not an added production coverage rule.
        let nearest=null;
        for(let atom=0;atom<r.atomCount;atom++){
          const position=r.displayPositions.subarray(atom*3,atom*3+3),view=r.viewMatrix,projection=r.projectionMatrix;
          const center=[0,1,2].map(row=>view[row]*position[0]+view[4+row]*position[1]+view[8+row]*position[2]+view[12+row]);
          if(center[2]>=0)continue;
          const projected=[(projection[0]*center[0]/-center[2]+1)*r.canvas.width/2,(projection[5]*center[1]/-center[2]+1)*r.canvas.height/2];
          const radius=r.atomRadii[atom]*r.radiusScale;
          const corner=[(x+.5-projected[0])/(projection[0]*radius/-center[2]*r.canvas.width/2),
            (y+.5-projected[1])/(projection[5]*radius/-center[2]*r.canvas.height/2)];
          const normalizedRadiusSquared=corner[0]**2+corner[1]**2;
          if(!nearest||normalizedRadiusSquared<nearest.normalizedRadiusSquared)nearest={atom,projectedCenter:projected,normalizedRadiusSquared};
        }
        firstPixel.nearestSphere=nearest;
        const savedLayer=r.primitiveLayer;r.primitiveLayer=null;
        try{r.render(performance.now(),{trackStats:false});firstPixel.spheresOnly=Array.from(read().subarray(offset,offset+4));}
        finally{r.primitiveLayer=savedLayer;}
      }
      unsafeMultisampleControl={caplessExercised:candidate.coveredBondMesh(r)===candidate.caplessCylinder,differingBytes,maximumDifference,firstPixel};
    }finally{candidate.singleSampleDefault=false;candidate.bondBuffers.displayShifts=null;candidate.bondCapCoverage=null;}
  }
  both(r=>r.setProjection('orthographic'));compare('orthographic cap coverage');
  both(r=>r.setProjection('perspective'));
  const radii = new Float32Array(frame.types.length).fill(.7); radii[0]=.1;
  both(r=>r.setAtomRadii(radii));compare('one small per-atom radius retains every cap');
  if(rows.at(-1).capless)throw Error('Small endpoint radius must retain caps');
  radii[0]=.7;both(r=>r.setAtomRadii(radii));compare('same-array radii restoration re-enables capless');
  if(rows.at(-1).capless!==candidate.singleSampleDefault)throw Error('Restored same-array radii must refresh cap coverage');
  both(r=>r.setRadiusScale(.05)); compare('caps exposed by tiny spheres retained');
  if(rows.at(-1).capless)throw Error('Tiny spheres must retain caps');
  both(r=>r.setReplications([2,1,2])); compare('periodic replicas and bond image shifts');
  both(r=>{r.setRadiusScale(1);r.resetCamera();});compare('full spheres over periodic bond images');
  const force=Float32Array.from({length:frame.types.length*3},(_,i)=>[.8,.2,-.4][i%3]);
  const velocities=Float32Array.from({length:force.length},(_,i)=>[0,.4,.9][i%3]);
  both(r=>r.setVectorFields([{id:'force',vectors:force,options:{color:'#ff8844',anchor:'center',headRadius:.22}},
    {id:'velocity',vectors:velocities,options:{color:'#aaff55',dimension:'2d',anchor:'head'}}])); compare('3d and flat multiple arrow fields');
  const hidden=new Uint8Array(frame.types.length).fill(255);for(let i=0;i<hidden.length;i+=3)hidden[i]=0;
  textureUploads.length=0;both(r=>r.setVisibility(hidden)); compare('ordinary hidden atoms preserve independent arrows');
  if(textureUploads.length!==1 || textureUploads[0].index!==3 || textureUploads[0].bytes!==candidate.width*candidate.height) throw Error('Visibility update must upload only one padded byte per atom');
  const selections=new Uint8Array(hidden.length).fill(255);for(let i=1;i<selections.length;i+=4)selections[i]=0;
  both(r=>r.setVisibility(hidden,{selectionVisibility:selections}));compare('selection hiding excludes attached bonds and arrows');
  both(r=>r.setSlices([{id:'cut',normal:[1,0,0],position:8,enabled:true,side:'negative'}])); compare('slice planes clip primitive endpoints and faces');
  if(rows.at(-1).capless)throw Error('Active slices must retain every cap');
  both(r=>r.setSlices([]));
  const data=Float64Array.from({length:hidden.length},(_,i)=>i/hidden.length), overrides=new Uint8Array(hidden.length);overrides[5]=255;
  both(r=>r.setScalarColorPreview(data,{minimum:.1,maximum:.7,colorStops:[[0,.267,.004,.329],[1,.992,.906,.145]],colorOverrides:overrides}));compare('scalar preview and per-atom overrides');
  both(r=>r.setCrystalDragShift([.25,-.25,.5]));compare('crystal drag wraps bond anchors and replicas');
  if(rows.at(-1).capless)throw Error('Interactive wrapping must retain every cap');
  const before=candidate.visibilityValues;
  both(r=>{r.setBonds(bonds,{visible:false});r.setVectorFields(r.atomVectorFields.map(field=>({...field,options:{...field.options,visible:false}})));});
  textureUploads.length=0; both(r=>r.setVisibility(new Uint8Array(hidden.length).fill(255)));
  compare('inactive layer leaves dirty textures unuploaded',false);
  if(textureUploads.length)throw Error('Inactive geometry uploaded atom textures');
  both(r=>{r.setBonds(bonds,{visible:true});r.setVectorFields(r.atomVectorFields.map(field=>({...field,options:{...field.options,visible:true}})));});
  compare('reenabling flushes latest visibility on warm mirrors');
  candidate.updateVisibility(renderers[1]);candidate.flushTextures(renderers[1]);
  const warmMirrorReused=before===candidate.visibilityValues;
  if(!warmMirrorReused)throw Error('Visibility changed a same-sized warm staging buffer');
  both(r=>{r.clearScalarColorPreview();r.setCrystalDragShift(null);r.setVisibility();r.setRadiusScale(1);r.setReplications([1,1,1]);r.resetCamera();});
  compare('full spheres re-enable capless after hiding and drag');
  if(rows.at(-1).capless!==candidate.singleSampleDefault)throw Error('A restored safe view must re-enable single-sample capless');
  both(r=>r.setSlice(0,.6));compare('legacy fractional slicing retains caps');
  if(rows.at(-1).capless)throw Error('Legacy slices must retain caps');
  both(r=>r.setSlices([]));
  both(r=>r.setVisibility(new Uint8Array(hidden.length).fill(1)));compare('noncanonical small visibility bytes retain caps without sphere coverage');
  if(rows.at(-1).capless)throw Error('Nondrawn spheres must never justify cap removal');
  both(r=>r.setVisibility());
  both(r=>r.setPeriodicOrigin([.25,-.25,.5]));compare('committed periodic origin updates cap coverage and image shifts');
  both(r=>r.setPeriodicOrigin([0,0,0]));
  const moved=Float64Array.from(frame.positions);moved[0]+=2;
  both(r=>r.setDisplayPositions(moved));compare('display coordinate edits retain mismatched endpoint caps');
  if(rows.at(-1).capless)throw Error('A displaced displayed endpoint must retain caps');
  both(r=>r.setDisplayPositions(frame.positions));
  const exports=[];
  for(const offscreen of [false,true])for(const includeBackground of [false,true]){
    const images=[];
    for(const r of renderers){const image=await r.captureImage({includeBackground,includeAxes:false,
      resolution:offscreen?{mode:'custom',width:720,height:480}:{mode:'current'},forceOffscreen:offscreen,tileSize:256});
      images.push(image.getContext('2d').getImageData(0,0,image.width,image.height).data);}
    let differences=0;for(let i=0;i<images[0].length;i++)if(images[0][i]!==images[1][i])differences++;
    exports.push({offscreen,includeBackground,differingBytes:differences});
    if(differences)throw Error('Capless export differs in '+differences+' bytes');
  }
  const small=crystalFrame('sc',1,1.5), self=calculateBonds(small,{cutoff:1.6});
  both(r=>{r.setFrame(small,new Uint8Array([180,90,220]));r.setBonds(self,{radius:.1});r.setReplications([3,3,3]);});
  compare('periodic self bonds with both sphere images displayed');
  const recovered=renderers[1],gl=recovered.gl,extension=gl.getExtension('WEBGL_lose_context');
  if(!extension)throw Error('WEBGL_lose_context is required for capless resource recovery');
  const read=()=>{recovered.render(performance.now(),{trackStats:false});const bytes=new Uint8Array(recovered.canvas.width*recovered.canvas.height*4);gl.readPixels(0,0,recovered.canvas.width,recovered.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return bytes;};
  const beforeRecovery=read(),oldCapless=candidate.caplessCylinder,expectedSingle=candidate.singleSampleDefault;
  const wait=async predicate=>{const deadline=performance.now()+10000;while(!predicate()){if(performance.now()>deadline)throw Error('Context recovery timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
  extension.loseContext();await wait(()=>recovered.contextLost);extension.restoreContext();await wait(()=>!recovered.contextLost&&!gl.isContextLost());
  const afterRecovery=read();let recoveryDifferences=0;for(let i=0;i<beforeRecovery.length;i++)if(beforeRecovery[i]!==afterRecovery[i])recoveryDifferences++;
  const contextRecovery={differingBytes:recoveryDifferences,rebuiltCaplessMesh:recovered.primitiveLayer.caplessCylinder!==oldCapless,
    sampleModeRetained:recovered.primitiveLayer.singleSampleDefault===expectedSingle,glError:gl.getError()};
  if(recoveryDifferences||!contextRecovery.rebuiltCaplessMesh||!contextRecovery.sampleModeRetained||contextRecovery.glError)throw Error('Capless context recovery failed');
  return {rows,bondCount:bonds.count,exportDifferences:exports.reduce((n,row)=>n+row.differingBytes,0),exports,defaultSamples:renderers[1].gl.getParameter(renderers[1].gl.SAMPLES),
    bondDrawIndices:[candidate.cylinder.count,candidate.caplessCylinder.count],unsafeMultisampleControl,warmMirrorReused,contextRecovery,
    note:'Real WebGL2 pixel parity on SwiftShader. No physical-GPU speed claim. Single-sample guarded capless/indexed primitives checked against expanded capped triangle oracle; MSAA and offscreen exports retain caps.'};
}
