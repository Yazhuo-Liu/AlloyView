import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Draw the original expanded triangles as an independent geometry oracle.
const production = await readFile(new URL('../src/render/atom-primitives.js', import.meta.url), 'utf8');
const start = production.indexOf('export function createIndexedPrimitiveMesh(');
const end = production.indexOf('/** Flat rectangle/triangle meshes', start);
assert.ok(start >= 0 && end > start);
const source = production.slice(0, start)
  + 'export function createIndexedPrimitiveMesh(cone = false, sides = 10) { return { vertices: createPrimitiveMesh(cone, sides) }; }\n\n'
  + production.slice(end);
const report = await withWebGpuBrowser(async ({evaluate}) => evaluate(`(${run.toString()})(${JSON.stringify(source)})`), {requireGpu:false});
console.log(JSON.stringify(report,null,2));
assert.ok(report.rows.every(row => row.differingBytes === 0 && row.errorA === 0 && row.errorB === 0));


async function run(source) {
  const baseUrl = new URL('./src/render/atom-primitives.js',location.href);
  source = source.replace(/from '([^']+)'/g,(_,name)=>`from '${new URL(name,baseUrl).href}'`);
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
  const [{AtomPrimitiveLayer:Baseline},{AtomPrimitiveLayer:Candidate},{WebGLRenderer},{crystalFrame},{calculateBonds},{createCell,fractionalToCartesian}] = await Promise.all([
    import(url),import('./src/render/atom-primitives.js'),import('./src/render/webgl-renderer.js'),import('./tests/helpers/crystals.js'),import('./src/analysis/bonds.js'),import('./src/data/model.js')]);
  URL.revokeObjectURL(url);
  const frame=crystalFrame('fcc',2,3.52);
  frame.cell=createCell({vectors:[7.04,0,0,1.2,7.04,0,-.8,.7,7.04]}); frame.positions=fractionalToCartesian(frame.fractional,frame.cell);
  const colors=Uint8Array.from({length:frame.types.length*3},(_,i)=>[175,85,215][i%3]);
  const bonds=calculateBonds(frame,{cutoff:3.0});
  const canvases=[0,1].map(()=>{const canvas=document.createElement('canvas');canvas.style.cssText='width:480px;height:320px';document.body.append(canvas);return canvas;});
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
    rows.push({label,bytes:images[0].length,differingBytes,maximumDifference,primitivePixelBytes,errorA:renderers[0].gl.getError(),errorB:renderers[1].gl.getError()});
    if(requirePrimitivePixels&&!primitivePixelBytes) throw new Error(label+' exercises no primitive pixels');
    if(differingBytes) throw new Error(label+' differs in '+differingBytes+' bytes; max '+maximumDifference);
  };
  const both=fn=>renderers.forEach(fn);
  both(r=>r.setBonds(bonds,{radius:.15})); compare('indexed capped bonds / skew cell');
  both(r=>r.setRadiusScale(.05)); compare('caps exposed by tiny spheres retained');
  both(r=>r.setReplications([2,1,2])); compare('periodic replicas and bond image shifts');
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
  both(r=>r.setSlices([]));
  const data=Float64Array.from({length:hidden.length},(_,i)=>i/hidden.length), overrides=new Uint8Array(hidden.length);overrides[5]=255;
  both(r=>r.setScalarColorPreview(data,{minimum:.1,maximum:.7,colorStops:[[0,.267,.004,.329],[1,.992,.906,.145]],colorOverrides:overrides}));compare('scalar preview and per-atom overrides');
  both(r=>r.setCrystalDragShift([.25,-.25,.5]));compare('crystal drag wraps bond anchors and replicas');
  const before=candidate.visibilityValues;
  both(r=>{r.setBonds(bonds,{visible:false});r.setVectorFields(r.atomVectorFields.map(field=>({...field,options:{...field.options,visible:false}})));});
  textureUploads.length=0; both(r=>r.setVisibility(new Uint8Array(hidden.length).fill(255)));
  compare('inactive layer leaves dirty textures unuploaded',false);
  if(textureUploads.length)throw Error('Inactive geometry uploaded atom textures');
  both(r=>{r.setBonds(bonds,{visible:true});r.setVectorFields(r.atomVectorFields.map(field=>({...field,options:{...field.options,visible:true}})));});
  compare('reenabling flushes latest visibility on warm mirrors');
  candidate.updateVisibility(renderers[1]);candidate.flushTextures(renderers[1]);
  const warmMirrorReused=before===candidate.visibilityValues;
  return {rows,bondCount:bonds.count,arrowFieldCount:candidate.vectorFields.length,warmMirrorReused,note:'Real WebGL2 pixel parity on SwiftShader. No physical-GPU speed claim. Production indexed primitives checked against expanded capped triangle oracle, with signed visibility and lazy upload assertions.'};
}
