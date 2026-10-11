import assert from 'node:assert/strict';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Source modules keep this recovery check independent of build artifacts.
const report = await withWebGpuBrowser(async ({ evaluate }) => evaluate(`(async () => {
  const { WebGLRenderer } = await import('/AlloyView/src/render/webgl-renderer.js');
  const { createCell, fractionalToCartesian } = await import('/AlloyView/src/data/model.js');
  const { createVoronoiCellBatch } = await import('/AlloyView/src/render/voronoi-cell-layer.js');
  const wait = async predicate => { const deadline=performance.now()+10000; while(!predicate()){if(performance.now()>deadline)throw Error('Context event timed out');await new Promise(resolve=>setTimeout(resolve,10));} };
  const canvas=document.createElement('canvas');canvas.style.cssText='width:480px;height:320px';document.body.append(canvas);
  const r=new WebGLRenderer(canvas), gl=r.gl, extension=gl.getExtension('WEBGL_lose_context');
  if(!extension)throw Error('WEBGL_lose_context is needed to validate recovery');
  const cell=createCell({vectors:[8,0,0,1,8,0,0,1,8]});
  const fractional=Float64Array.from([.3,.35,.4,.55,.35,.4]);
  const properties=[{name:'energy',data:Float64Array.from([1,2]),analysisKey:'retained-reference'}];
  const frame={ids:Uint32Array.from([1,2]),types:new Uint32Array(2),typeLabels:['Fe'],cell,fractional,positions:fractionalToCartesian(fractional,cell),properties};
  const colors=Uint8Array.from([160,185,225,180,120,160]),radii=Float32Array.from([.65,.75]);
  r.setFrame(frame,colors,frame.positions,radii,[2,1,1]);r.resetCamera();r.setBackground('#ffffff');r.setRadiusScale(.8);
  r.setPeriodicOrigin([.1,.05,0]);r.setSlices([{id:'clip',enabled:true,normal:[0,0,1],position:7,side:'negative'}]);r.setSliceOutlines(true);
  r.setSelected(1);r.setSelectedAtoms([0,1]);r.setSliceSelectedAtoms([0,1]);
  const bonds={indices:Uint32Array.from([0,1]),vectors:Float32Array.from([2,0,0]),shifts:new Int32Array(3),count:1};
  r.setBonds(bonds,{radius:.09});
  const vectors=Float32Array.from([.4,.7,.2,-.3,.5,.1]);r.setVectorFields([{id:'force',vectors,options:{color:'#ff8800',scale:1.2}}]);
  const network={parameters:{lattice:'fcc'},segments:[{familyId:'other',points:[1,1,1,2,1.5,2,3,1,2.5]}]};
  r.setDislocationNetwork(network,{radius:.1});
  const markers={positions:Float32Array.from([1.5,3,4]),colors:Uint8Array.from([60,180,160])};r.setSiteMarkers(markers,{radius:.2});
  const vertices=[];for(let c=0;c<8;c++)vertices.push(c&1?4.7:3.3,c&2?5.1:3.7,c&4?5.5:4.1);
  const faces=[[0,4,6,2],[1,3,7,5],[0,1,5,4],[2,6,7,3],[0,2,3,1],[4,5,7,6]];
  const surface={vertices:Float64Array.from(vertices),triangles:Uint32Array.from(faces.flatMap(([a,b,c,d])=>[a,b,c,a,c,d]))};
  r.setSurfaceMesh('surface',surface,{color:'#6070a0',opacity:.6});
  const lines={vertexCount:2,vertices:Float32Array.from([1,2,3,0,2,3,4,1])};r.setTrajectoryLines(lines,{visible:true});
  const local=Float64Array.from(Array.from({length:8},(_,c)=>[c&1?.9:-.9,c&2?.9:-.9,c&4?.9:-.9]).flat());
  const geometry={atomIndex:0,vertices:local,faceOffsets:Uint32Array.from([0,4,8,12,16,20,24]),faceVertices:Uint32Array.from(faces.flat()),faceNeighbors:new Int32Array(6).fill(-1)};
  const all={chunks:[createVoronoiCellBatch([geometry])],cellCount:1,complete:true};
  r.setVoronoiCellGeometry(geometry,{enabled:true,allEnabled:true,opacity:.42});r.setVoronoiAllCellGeometry(all,{enabled:true,allEnabled:true,opacity:.42});
  const factors=Float32Array.from([1,.8,.75,.6]);r.setAmbientOcclusion(factors,{intensity:.4});
  r.setScalarColorPreview(properties[0].data,{minimum:1,maximum:2,colorStops:[[0,0,0,255],[1,255,0,0]]});
  const pixels=()=>{r.render(performance.now(),{trackStats:false});const bytes=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return bytes;};
  const camera=()=>JSON.stringify([r.target,r.pan,r.yaw,r.pitch,r.roll,r.constrainUp,r.distance,r.orthographicScale,r.projectionMode,r.fov]);
  const before=pixels(),beforeCamera=camera(),oldProgram=r.sphereProgram,oldPositionBuffer=r.positionBuffer;
  const layerNames=['primitiveLayer','dislocationLayer','siteMarkerLayer','surfaceMeshLayer','trajectoryLineLayer','voronoiCellLayer','voronoiAllCellLayer'];
  const oldLayers=layerNames.map(name=>r[name]);
  let prevented=false;canvas.addEventListener('webglcontextlost',event=>{prevented=event.defaultPrevented;});
  extension.loseContext();await wait(()=>r.contextLost);
  const denied=[];for(const options of [{},{includeBackground:false},{resolution:{mode:'custom',width:320,height:240}}]){try{r.captureImage(options);denied.push(false);}catch(error){denied.push(/graphics context is unavailable/.test(error.message));}}
  const notice=r.contextNotice.textContent,frameRetained=r.frame===frame;
  extension.restoreContext();await wait(()=>!r.contextLost&&!gl.isContextLost());
  const after=pixels();let differingBytes=0;for(let i=0;i<before.length;i++)if(before[i]!==after[i])differingBytes++;
  const first={prevented,denied,notice,frameRetained,pixelBytesEqual:differingBytes===0,differingBytes,cameraEqual:camera()===beforeCamera,
    scientificArraysRetained:r.frame.properties===properties&&r.frame.properties[0].data===properties[0].data,
    newProgram:r.sphereProgram!==oldProgram,newPositionBuffer:r.positionBuffer!==oldPositionBuffer,
    allLayersRebuilt:layerNames.every((name,index)=>r[name]&&r[name]!==oldLayers[index]),
    sourceDescriptorsRetained:r.atomBonds.indices===bonds.indices&&r.atomVectorFields[0].vectors===vectors&&r.dislocationNetwork===network&&r.siteMarkers===markers&&r.surfaceMeshes()[0].mesh===surface&&r.trajectoryLines===lines&&r.voronoiCellGeometry===geometry&&r.voronoiAllCellGeometry===all,
    factorsRetained:r.ambientOcclusionFactors===factors,previewRetained:r.scalarColorPreview?.input.data===properties[0].data,noticeHidden:r.contextNotice.hidden,glError:gl.getError()};
  // A new frame and an analysis result can arrive while the context is lost.
  extension.loseContext();await wait(()=>r.contextLost);
  let uploadsWhileLost=0;const upload=gl.bufferData.bind(gl);gl.bufferData=(...args)=>{if(gl.isContextLost())uploadsWhileLost++;return upload(...args);};
  const nextFractional=Float64Array.from(fractional,value=>value+.02),next={...frame,ids:Uint32Array.from([3,4]),fractional:nextFractional,positions:fractionalToCartesian(nextFractional,cell),properties:[{name:'energy',data:Float64Array.from([3,4])}]};
  const nextColors=Uint8Array.from([20,180,90,80,90,200]);r.setFrame(next,nextColors,next.positions,radii,[1,1,1]);r.setVisibility(Uint8Array.from([255,0]));r.setBonds(bonds,{radius:.13});r.setVectorFields([{id:'force',vectors,options:{scale:2}}]);r.setSelected(0);
  extension.restoreContext();await wait(()=>!r.contextLost&&!gl.isContextLost());pixels();
  const second={uploadsWhileLost,latestFrame:r.frame===next,latestProperties:r.frame.properties[0].data[0]===3,latestColors:r.atomColors===nextColors,latestMask:r.visibility[1]===0,
    latestBondRadius:r.bondOptions.radius,latestVectorScale:r.atomVectorFields[0].options.scale,latestPick:r.selected,
    obsoleteSurfaceRemoved:r.surfaceMeshes().length===0,glError:gl.getError()};
  r.clearFrame();return{first,second,dimensions:[canvas.width,canvas.height]};
})()`), { requireGpu: false });
assert.equal(report.first.prevented, true);
assert.ok(report.first.denied.every(Boolean));
for (const key of ['frameRetained','pixelBytesEqual','cameraEqual','scientificArraysRetained','newProgram','newPositionBuffer','allLayersRebuilt',
  'sourceDescriptorsRetained','factorsRetained','previewRetained','noticeHidden']) assert.equal(report.first[key], true, key);
assert.equal(report.first.glError, 0);
assert.equal(report.second.uploadsWhileLost, 0);
for (const key of ['latestFrame','latestProperties','latestColors','latestMask','obsoleteSurfaceRemoved']) assert.equal(report.second[key], true, key);
assert.equal(report.second.latestBondRadius, .13); assert.equal(report.second.latestVectorScale, 2); assert.equal(report.second.latestPick, 0);
assert.equal(report.second.glError, 0);
console.log(JSON.stringify(report, null, 2));
