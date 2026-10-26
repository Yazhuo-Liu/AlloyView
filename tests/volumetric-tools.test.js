import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeVolumetricTools, volumetricSlicePixels, volumetricSliceProbe, VOLUMETRIC_TOOL_DEFAULTS } from '../src/ui/view/volumetric-tools.js';
import { createConfiguration, parseConfiguration, matchesSource } from '../src/application/configuration.js';

class Element {
  constructor(){this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.children=[];this.listeners=new Map();this.classList={toggle(){}};}
  get valueAsNumber(){return this.value.trim()===''?NaN:Number(this.value);}
  addEventListener(name,listener){this.listeners.set(name,listener);}
  dispatch(name,event={}){this.listeners.get(name)?.({target:this,...event});}
  replaceChildren(...children){this.children=children;}
}
const source=()=>({id:'charge',name:'Charge density',unit:'e/Å³',dimensions:[3,2,2],origin:Float64Array.of(1,2,3),
  steps:Float64Array.of(1,0,0,.25,1,0,0,0,1),periodic:[true,true,true],values:Float64Array.from({length:12},(_,i)=>i),statistics:{min:0,max:11,integral:66}});
const frame=()=>({volumetric:{datasets:[source()]}});
const mesh=()=>({vertices:Float64Array.of(0,0,0,1,0,0,0,1,0),triangles:Uint32Array.of(0,1,2),triangleCount:1,backend:'gpu',statistics:{surfaceArea:.5}});
const slice=()=>({values:Float64Array.of(-1,0,1,2,3,4),width:3,height:2,axis:2,index:.5,axes:[0,1],origin:Float64Array.of(1,2,3.5),steps:Float64Array.of(1,0,0,.25,1,0),unit:'e/Å³',statistics:{min:-1,max:4},backend:'cpu',workerCount:1});
function harness(t){
  const previous=globalThis.document,fields=new Map();
  globalThis.document={getElementById(id){if(!fields.has(id))fields.set(id,new Element());return fields.get(id);},createElement(){return new Element();}};
  t.after(()=>{globalThis.document=previous;});
  let current=frame(),version=1;const jobs=[],draws=[],downloads=[],exports=[],notifications=[];
  const controller=initializeVolumetricTools({getFrame:()=>current,getSourceVersion:()=>version,getGpuEnabled:()=>true,
    renderer:{setVolumetricSurface(...args){draws.push(args);}},tools:{setToolEnabled(){}},
    client:{analyze(data,params,options){return new Promise((resolve,reject)=>jobs.push({data,params,options,resolve,reject}));},
      exportSliceCsv(result,settings,options){return new Promise(resolve=>exports.push({result,settings,options,resolve}));}},
    onDownload:(...args)=>downloads.push(args),notify:message=>notifications.push(message)});
  controller.setEnabled(true);
  return{controller,jobs,draws,downloads,exports,notifications,field:id=>fields.get(id),getFrame:()=>current,
    setFrame(value){current=value;version++;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('volume opens without analysis, exposes source units, and styles a GPU mesh without recalculation',async t=>{
  const h=harness(t);await h.controller.onFrame();
  assert.equal(h.jobs.length,0);assert.equal(h.controller.isEnabled(),false);
  assert.match(h.field('volume-info').textContent,/3 × 2 × 2.*e\/Å³/);
  h.field('volume-level').value='-0.5';const pending=h.controller.run();
  assert.deepEqual(h.jobs[0].params,{kind:'isosurface',level:-.5});assert.equal(h.jobs[0].options.useGpu,true);
  const result=mesh();h.jobs[0].resolve(result);assert.equal(await pending,true);
  assert.equal(h.getFrame().atomeyeResults.volumetric.mesh,result);assert.equal(h.field('volume-backend').textContent,'WebGPU');
  h.field('volume-color').value='#ff3300';h.field('volume-opacity').value='.4';h.field('volume-opacity').dispatch('input');
  assert.equal(h.jobs.length,1);assert.equal(h.draws.at(-1)[0],result);assert.deepEqual(h.draws.at(-1)[1],{visible:true,color:'#ff3300',opacity:.4});
});

test('volume cancellation and frame transitions reject obsolete outputs without clearing unrelated results',async t=>{
  const h=harness(t);await h.controller.onFrame();h.getFrame().atomeyeResults={other:{value:1}};
  const old=h.controller.run(),job=h.jobs[0];h.controller.cancel();
  assert.equal(job.options.signal.aborted,true);job.resolve(mesh());assert.equal(await old,false);
  assert.deepEqual(h.getFrame().atomeyeResults,{other:{value:1}});assert.equal(h.draws.at(-1)[0],null);
  const pending=h.controller.run(),oldFrame=h.getFrame();h.jobs[1].resolve(mesh());await pending;
  h.setFrame(frame());const changed=h.controller.onFrame();
  assert.equal(oldFrame.atomeyeResults.volumetric,undefined);assert.equal(h.jobs.length,3);
  h.jobs[2].resolve({...mesh(),backend:'cpu',workerCount:2,fallbackReason:'No WebGPU adapter'});await changed;
  assert.match(h.field('volume-backend').textContent,/CPU/);assert.match(h.field('volume-status').textContent,/CPU fallback/);
});

test('slice controls keep native exact values, manual color limits and export freshness',async t=>{
  const h=harness(t);await h.controller.onFrame();h.field('volume-slice-enabled').checked=true;h.field('volume-slice-enabled').dispatch('change');
  assert.deepEqual(h.jobs[0].params,{kind:'slice',axis:2,index:0});h.jobs[0].resolve(slice());await tick();
  assert.equal(h.field('volume-slice-results').hidden,false);assert.match(h.field('volume-slice-probe').textContent,/value -1/);
  h.field('volume-range-min').value='-2';h.field('volume-range-max').value='8';h.field('volume-range-max').dispatch('change');
  assert.equal(h.controller.serialize().rangeAuto,false);assert.equal(h.jobs.length,1);
  h.field('export-volume-slice').dispatch('click');assert.equal(h.exports.length,1);
  h.setFrame(frame());const changed=h.controller.onFrame();assert.equal(h.exports[0].options.signal.aborted,true);
  h.exports[0].resolve({blob:new Blob(['old']),filename:'old.csv'});await tick();assert.equal(h.downloads.length,0);
  h.jobs[1].resolve({...slice(),statistics:{min:-50,max:100}});await changed;
  assert.match(h.field('volume-slice-limits').textContent,/-2 → 8/);
  h.field('export-volume-slice').dispatch('click');h.exports[1].resolve({blob:new Blob(['new']),filename:'new.csv'});await tick();assert.equal(h.downloads[0][1],'new.csv');
});

test('grid probing preserves skew Cartesian coordinates and bounded heatmaps reverse vertical rows',()=>{
  const result=slice();assert.deepEqual(volumetricSliceProbe(result,2,1),{x:2,y:1,value:4,position:[3.25,3,3.5]});
  assert.equal(volumetricSliceProbe(result,-1,0),null);
  const pixels=volumetricSlicePixels(result,{colorScheme:'viridis',minimum:-1,maximum:4,maxSide:2});
  assert.equal(pixels.width,2);assert.equal(pixels.height,2);assert.equal(pixels.data.length,16);
  assert.ok(pixels.data[1]>pixels.data[9],'upper row contains larger native values, not flipped axes');
  assert.deepEqual([...result.values],[-1,0,1,2,3,4]);
});

test('volume settings restore independently of computation and missing saved fields never select a different dataset',async t=>{
  const h=harness(t);await h.controller.restore({enabled:true,...VOLUMETRIC_TOOL_DEFAULTS,datasetId:'absent',level:1});
  assert.equal(h.jobs.length,0);assert.equal(h.field('volume-state').textContent,'Not available');
  const restore=h.controller.restore({enabled:false,...VOLUMETRIC_TOOL_DEFAULTS,datasetId:'charge',sliceEnabled:true,sliceIndex:.5});
  assert.equal(h.jobs[0].params.index,.5);h.jobs[0].resolve(slice());await restore;
  assert.equal(h.controller.getResult().mesh,null);assert.equal(h.controller.getResult().slice.values.length,6);
  h.controller.reset();assert.equal(h.controller.isUntouched(),true);
});

test('portable volume recipes retain field selection and manual limits without grid payloads',()=>{
  assert.equal(Object.hasOwn(createConfiguration().settings.extensions,'volumetric'),false);
  const volumetric={enabled:true,...VOLUMETRIC_TOOL_DEFAULTS,datasetId:'charge',level:.15,sliceEnabled:true,sliceIndex:3.25,rangeAuto:false,rangeMin:-1,rangeMax:2};
  for(const format of ['cube','vasp-volume']) {
    const recipe=createConfiguration({settings:{activeTool:'volumetric',extensions:{volumetric}},source:{format,files:[{name:'density',size:500}],frameCount:1}});
    assert.deepEqual(parseConfiguration(JSON.stringify(recipe)),recipe);assert.deepEqual(recipe.settings.extensions.volumetric,volumetric);
    assert.equal(matchesSource(recipe,[{name:'density',size:500}],format),true);
  }
  for(const invalid of [{level:Infinity},{sliceAxis:1.5},{sliceIndex:-1},{rangeAuto:false},{rangeAuto:false,rangeMin:1,rangeMax:0},
    {opacity:2},{visible:1},{datasetId:1},{color:'blue'},{colorScheme:'invalid'},{values:[1,2,3]},{vertices:[]}]) {
    assert.throws(()=>createConfiguration({settings:{extensions:{volumetric:invalid}}}),/settings\.extensions\.volumetric/);
  }
});
