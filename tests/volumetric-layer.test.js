import test from 'node:test';
import assert from 'node:assert/strict';
import { volumetricSurfaceGeometry, volumetricImages, normalizeVolumetricSurfaceOptions } from '../src/render/volumetric-layer.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';
import { createCell } from '../src/data/model.js';

const mesh=()=>({vertices:Float64Array.of(0,0,0,1,0,0,0,1,0),triangles:Uint32Array.of(0,1,2),
  grid:{periodic:[true,true,true]}});
function fixture(){
  const calls=[],gl={};
  for(const name of ['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','ARRAY_BUFFER','FLOAT','STATIC_DRAW','CULL_FACE','BLEND','SRC_ALPHA','ONE_MINUS_SRC_ALPHA','ONE','TRIANGLES'])gl[name]=name;
  for(const name of ['createProgram','createShader','createVertexArray','createBuffer'])gl[name]=()=>({});
  gl.getShaderParameter=gl.getProgramParameter=()=>true;gl.isContextLost=()=>false;gl.getUniformLocation=(_,name)=>name;
  for(const name of ['shaderSource','compileShader','attachShader','deleteShader','linkProgram','deleteProgram','bindVertexArray','bindBuffer','bufferData',
    'enableVertexAttribArray','vertexAttribPointer','deleteVertexArray','deleteBuffer','useProgram','uniformMatrix4fv','uniformMatrix3fv','uniform3f','uniform1f',
    'uniform1i','uniform4fv','disable','enable','blendFuncSeparate','depthMask','drawArrays'])gl[name]=(...args)=>calls.push({name,args});
  const r=Object.assign(Object.create(WebGLRenderer.prototype),{gl,frame:{cell:createCell({vectors:[4,0,0,1,4,0,0,0,4]})},
    coordinateMode:'wrapped',periodicOrigin:[0,0,0],replicas:[{offset:[0,0,0]},{offset:[4,0,0]}],
    viewMatrix:new Float32Array(16),projectionMatrix:new Float32Array(16),sliceMode:'planes',sliceCount:1,slicePlaneValues:Float32Array.of(1,0,0,2),
    requestRender(){},updateSceneBounds(){}});
  return{r,calls};
}

test('isosurface triangles retain Cartesian coordinates, outward normals and one reusable drawing layout',()=>{
  const result=mesh(),geometry=volumetricSurfaceGeometry(result);
  assert.deepEqual([...geometry.positions],[...result.vertices]);assert.deepEqual([...geometry.normals],[0,0,1,0,0,1,0,0,1]);
  assert.deepEqual([...geometry.bounds],[0,0,0,1,1,0]);assert.equal(volumetricSurfaceGeometry(result),geometry);
  assert.equal(volumetricSurfaceGeometry({renderGeometry:geometry}),geometry,'Worker packing needs no per-triangle page work');
  assert.throws(()=>volumetricSurfaceGeometry({...result,triangles:Uint32Array.of(0,1,9)}),/index/);
  assert.throws(()=>volumetricSurfaceGeometry({renderGeometry:{positions:new Float32Array(9),normals:new Float32Array(3),bounds:new Float64Array(6)}}),/geometry/);
});

test('appearance and periodic display shifts reuse buffers while replicas and slice planes reach the shader',()=>{
  const {r,calls}=fixture(),result=mesh();r.setVolumetricSurface(result);const layer=r.volumetricLayer;
  const uploads=calls.filter(call=>call.name==='bufferData').length;layer.render(r);assert.equal(layer.renderedImageCount,2);
  r.periodicOrigin=[.25,.5,0];r.setVolumetricSurface(result,{color:'#ff4400',opacity:.4});layer.render(r);
  assert.equal(layer.renderedImageCount,8);assert.equal(calls.filter(call=>call.name==='bufferData').length,uploads);
  assert.ok(calls.some(call=>call.name==='uniform1i'&&call.args[0]==='uSliceCount'&&call.args[1]===1));
  assert.ok(calls.some(call=>call.name==='uniform3f'&&call.args[0]==='uOffset'&&call.args[1]===-1.5&&call.args[2]===-2));
  assert.equal(calls.filter(call=>call.name==='depthMask').at(-1).args[0],true);
  r.setVolumetricSurface(result,{visible:false});layer.render(r);assert.equal(layer.renderedImageCount,0);
  r.setVolumetricSurface(null);assert.equal(r.volumetricLayer,layer);assert.equal(layer.geometry,null);
});

test('wrapped image shifts are bounded for large origins and open Cube axes do not repeat or invent caps',()=>{
  const {r}=fixture(),result=mesh();r.periodicOrigin=[1000000.25,-999999.5,0];
  assert.deepEqual(volumetricImages(r,result).offsets,[[-1.5,-2,0],[-.5,2,0],[2.5,-2,0],[3.5,2,0]]);
  r.crystalDrag={shift:[.25,0,0]};assert.deepEqual(volumetricImages(r,result).shift,[.5,.5,0]);
  r.coordinateMode='unwrapped';assert.equal(volumetricImages(r,result).offsets.length,1);
  assert.equal(volumetricImages(r,result).wrap,false);
  const open={...mesh(),grid:{periodic:[false,false,false]}};
  assert.deepEqual(volumetricImages(r,open).offsets,[[0,0,0]]);
  r.setVolumetricSurface(open);const low=[0,0,0],high=[0,0,0];r.volumetricLayer.extendBounds(r,low,high);
  assert.deepEqual(high,[5,1,0]);assert.equal(r.volumetricLayer.geometry.positions.length,9,'the open triangle receives no artificial endcaps');
});

test('invalid isosurface edits are transactional and context loss retains source geometry for restoration',()=>{
  const {r,calls}=fixture(),result=mesh();r.setVolumetricSurface(result);const options=r.volumetricSurfaceOptions;
  for(const invalid of [{color:'invalid'},{opacity:NaN},{opacity:-1},{visible:1}]){
    assert.throws(()=>r.setVolumetricSurface(result,invalid));assert.equal(r.volumetricSurfaceOptions,options);
  }
  assert.deepEqual(normalizeVolumetricSurfaceOptions(),{visible:true,color:'#5b8def',opacity:.7});
  r.contextLost=true;r.volumetricLayer=null;calls.length=0;r.setVolumetricSurface(result,{opacity:.3});
  assert.equal(r.volumetricSurface,result);assert.equal(calls.length,0);
  r.contextLost=false;r.setVolumetricSurface(r.volumetricSurface,r.volumetricSurfaceOptions);
  assert.equal(r.volumetricLayer.geometry,volumetricSurfaceGeometry(result));assert.equal(r.volumetricLayer.options.opacity,.3);
});

test('scene banks retain independent volume descriptors for pending frames and release their own buffers',()=>{
  const {r}=fixture(),first=mesh();r.setVolumetricSurface(first);const bank=r.captureSceneBank(),layer=r.volumetricLayer;
  assert.equal(bank.volumetricSurface,first);assert.equal(bank.volumetricLayer,layer);
  r.volumetricSurface=null;r.volumetricLayer=null;r.applySceneBank(bank);
  assert.equal(r.volumetricSurface,first);assert.equal(r.volumetricLayer,layer);
});
