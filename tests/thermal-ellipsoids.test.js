import test from 'node:test';
import assert from 'node:assert/strict';
import { thermalEllipsoidAxes, thermalProbabilityScale, cifThermalToCartesian, cartesianThermalToCif,
  rotateThermalTensor, THERMAL_PROPERTY_NAMES } from '../src/crystal/thermal-ellipsoids.js';
import { parseCif } from '../src/io/cif.js';
import { frameTransferables, createCell } from '../src/data/model.js';
import { replicateFrame } from '../src/data/replicate.js';
import { structureExportText } from '../src/io/structure-export.js';
import { thermalRayDepth, normalizeThermalOptions } from '../src/render/thermal-ellipsoid-layer.js';
import { orthographic, perspective } from '../src/render/math.js';
const close = (a,b,eps=1e-10) => assert.ok(Math.abs(a-b) < eps, `${a} != ${b}`);
const closeArray = (a,b,eps=1e-10) => { assert.equal(a.length,b.length); a.forEach((x,i)=>close(x,b[i],eps)); };
const source = (rows='C1 .04 .09 .16 .015 -.02 .01', operations="'x,y,z'\n'-y,x,z'") => `data_adp
_cell_length_a 5
_cell_length_b 5
_cell_length_c 7
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_space_group_symop_operation_xyz
${operations}
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
C1 C .1 .2 .3
loop_
_atom_site_aniso_label
_atom_site_aniso_U_11
_atom_site_aniso_U_22
_atom_site_aniso_U_33
_atom_site_aniso_U_12
_atom_site_aniso_U_13
_atom_site_aniso_U_23
${rows}
`;
function covariance(axes) {
  const at=(i,j)=>[0,1,2].reduce((sum,k)=>sum+axes[k*3+i]*axes[k*3+j],0);
  return [at(0,0),at(1,1),at(2,2),at(0,1),at(0,2),at(1,2)];
}
test('thermal probability is chi-square(3), and Jacobi axes reconstruct full covariance including rotations',()=>{
  close(thermalProbabilityScale(.5),1.5381722544550522,1e-12);
  close(thermalProbabilityScale(.95),2.7954834829151074,1e-11);
  const isotropic=thermalEllipsoidAxes([.04,.04,.04,0,0,0]);
  closeArray([...isotropic.axes],[.2,0,0,0,.2,0,0,0,.2],1e-8);
  const tensor=[.04,.09,.16,.015,-.02,.01],result=thermalEllipsoidAxes(tensor);
  closeArray(covariance(result.axes),tensor,1e-8);
  assert.throws(()=>thermalEllipsoidAxes([1,1,-.01,0,0,0]),/positive semidefinite/);
  assert.throws(()=>thermalEllipsoidAxes([1,1,NaN,0,0,0]),/six finite/);
  assert.equal(thermalEllipsoidAxes([1,0,1,0,0,0]).valid,false);
  assert.throws(()=>normalizeThermalOptions({probability:1}),/probability/);
});
test('triclinic crystallographic Uij uses reciprocal-axis norms and roundtrips Cartesian covariance',()=>{
  const cell=createCell({vectors:[3,0,0,1,4,0,2,1,5]});
  const cartesian=[.04,.04,.04,0,0,0],cif=cartesianThermalToCif(cartesian,cell);
  closeArray(cifThermalToCartesian(cif,cell),cartesian);
  closeArray([...cif.slice(0,3)],[.04,.04,.04]);
  assert.ok(Math.abs(cif[3])>.001,'isotropic Cartesian motion is not diagonal Uij in a skew crystal');
  const rotation=[-1,0,0,0,-1,0,0,0,-1];
  closeArray(rotateThermalTensor(cartesian,rotation,cell),cartesian);
});
test('CIF transforms anisotropic ellipsoids for every symmetry image and exports Uij without losing precision',()=>{
  const frame=parseCif(source(),'ADP.cif');
  assert.equal(frame.ids.length,2);assert.equal(frame.thermalEllipsoids.count,2);
  const values=THERMAL_PROPERTY_NAMES.map(name=>frame.properties.find(p=>p.name===name).data);
  closeArray(values.map(x=>x[0]),[.04,.09,.16,.015,-.02,.01]);
  closeArray(values.map(x=>x[1]),[.09,.04,.16,-.015,-.01,-.02]);
  assert.ok(frameTransferables(frame).includes(frame.thermalEllipsoids.transforms.buffer));
  const text=structureExportText(frame),roundtrip=parseCif(text,'roundtrip.cif');
  assert.match(text,/_atom_site_aniso_U_23/);
  for(let i=0;i<6;i++)closeArray(roundtrip.properties.find(p=>p.name===THERMAL_PROPERTY_NAMES[i]).data,values[i]);
  const b=source('C1 '+[.04,.09,.16,.015,-.02,.01].map(x=>x*8*Math.PI**2).join(' ')).replaceAll('_aniso_U_','_aniso_B_');
  closeArray(parseCif(b).thermalEllipsoids.transforms,frame.thermalEllipsoids.transforms,1e-8);
});
test('invalid or incomplete anisotropic tensors fail explicitly, and missing rows remain undefined',()=>{
  assert.throws(()=>parseCif(source('C1 -.04 .09 .16 0 0 0')),/positive semidefinite/);
  assert.throws(()=>parseCif(source('C1 ? .09 .16 0 0 0')),/all six/);
  assert.throws(()=>parseCif(source('Missing .04 .09 .16 0 0 0')),/no corresponding/);
  assert.equal(parseCif(source('C1 ? ? ? ? ? ?')).thermalEllipsoids.count,0);
  const special=source('C1 .04 .09 .16 0 0 0').replace('C1 C .1 .2 .3','C1 C 0 0 .3');
  assert.throws(()=>parseCif(special),/special-position site symmetry/);
});
test('physical replication repeats tensors without rescaling physical ellipsoid axes',async()=>{
  const frame=parseCif(source()),replica=await replicateFrame(frame,[2,1,2]);
  assert.equal(replica.thermalEllipsoids.count,8);
  assert.equal(replica.thermalEllipsoids.transforms.length,8*9);
  for(let copy=0;copy<4;copy++)closeArray(replica.thermalEllipsoids.transforms.subarray(copy*18,copy*18+18),frame.thermalEllipsoids.transforms);
  closeArray(parseCif(structureExportText(replica)).thermalEllipsoids.transforms,replica.thermalEllipsoids.transforms,1e-7);
});
test('ellipsoid ray picking follows principal axes instead of the hidden atom radius',()=>{
  const axes=Float32Array.from([2,0,0,0,.5,0,0,0,1]);
  const view=Float32Array.from([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  const p=orthographic(-4,4,-4,4,.1,100);
  close(thermalRayDepth(axes,0,1,view,[0,0,-5],p,0,0),-4);
  assert.notEqual(thermalRayDepth(axes,0,1,view,[0,0,-5],p,.4,0),null);
  assert.equal(thermalRayDepth(axes,0,1,view,[0,0,-5],p,0,.2),null);
  close(thermalRayDepth(axes,0,1,view,[0,0,-5],perspective(Math.PI/4,1,.1,100),0,0),-4);
});
