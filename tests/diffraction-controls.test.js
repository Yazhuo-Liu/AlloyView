import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDiffractionControls, DIFFRACTION_UI_DEFAULTS, diffractionChartPaths, nearestDiffractionPeak } from '../src/ui/view/diffraction-controls.js';
import { createConfiguration, parseConfiguration } from '../src/application/configuration.js';
import { normalizeDiffractionParameters } from '../src/analysis/diffraction.js';
import { electronWavelengthFromEnergy } from '../src/crystal/diffraction-scattering.js';
import { crystalFrame } from './helpers/crystals.js';

class Element {
  constructor(tag='div'){this.tagName=tag;this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.children=[];this.listeners=new Map();this.attributes={};this.classList={toggle(){}};}
  get valueAsNumber(){return this.value.trim()===''?NaN:Number(this.value);}
  addEventListener(type,fn){this.listeners.set(type,fn);}
  dispatch(type,event={}){return this.listeners.get(type)?.({target:this,...event});}
  setAttribute(key,value){this.attributes[key]=String(value);}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  getBoundingClientRect(){return {left:0,top:0,width:640,height:280};}
}
function setup(t){
  const previous=globalThis.document,nodes=new Map();globalThis.document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)};
  t.after(()=>{globalThis.document=previous;});
  let frame=crystalFrame('fcc',1),source=1;const jobs=[],exports=[],downloads=[],notices=[];
  const client={analyze(input,params,options){return new Promise((resolve,reject)=>jobs.push({input,params,options,resolve,reject}));},
    export(result,kind,settings,options){return new Promise((resolve,reject)=>exports.push({result,kind,settings,options,resolve,reject}));},warm:async()=>{}};
  const controls=initializeDiffractionControls({client,getFrame:()=>frame,getSourceVersion:()=>source,getGpuEnabled:()=>true,getFileStem:()=> 'sample',onDownload:(...args)=>downloads.push(args),notify:message=>notices.push(message)});
  controls.setEnabled(true);
  return{controls,nodes,jobs,exports,downloads,notices,getFrame:()=>frame,setFrame(next){frame=next;source++;}};
}
function output(count=3){
  const parameters={...DIFFRACTION_UI_DEFAULTS};delete parameters.wavelengthPreset;
  return {parameters,peaks:Array.from({length:count},(_,i)=>({twoTheta:10+i*.5,dSpacing:2+i*.01,intensity:100-i/2,relativeIntensity:100-i/2,multiplicity:2,hkls:[[1,i,0]]})),
    profile:{twoTheta:Float64Array.of(5,10,15,90),intensity:Float64Array.of(0,10,2,0),relativeIntensity:Float64Array.of(0,100,20,0)},
    atomCount:4,reflectionCount:count,peakCount:count,backend:'gpu',workerCount:1,elapsedMs:10,warnings:[]};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('diffraction starts optional and publishes the actual backend, chart and exact probe data',async t=>{
  const h=setup(t);await h.controls.onFrame();assert.equal(h.jobs.length,0);assert.equal(h.controls.isEnabled(),false);
  const pending=h.controls.run();assert.equal(h.jobs[0].options.useGpu,true);assert.equal(h.jobs[0].params.wavelength,1.5406);
  h.jobs[0].options.onProgress({backend:'gpu',phase:'structure-factors',totalReflections:4,completedReflections:2});
  assert.equal(h.nodes.get('diffraction-progress').value,.5);
  const result=output();h.jobs[0].resolve(result);assert.equal(await pending,true);
  assert.equal(h.getFrame().atomeyeResults.diffraction,result);assert.equal(h.controls.getResult(),result);
  assert.equal(h.nodes.get('diffraction-backend').textContent,'WebGPU structure factors');assert.equal(h.nodes.get('diffraction-results').hidden,false);
  assert.equal(h.nodes.get('diffraction-chart').children[0].tagName,'svg');assert.match(h.nodes.get('diffraction-probe').textContent,/2θ 10°.*multiplicity 2.*\(1 0 0\)/);
  h.nodes.get('diffraction-peak-slider').value='2';h.nodes.get('diffraction-peak-slider').dispatch('input');assert.match(h.nodes.get('diffraction-probe').textContent,/Peak 3\/3/);
});

test('wavelength and physical-setting edits invalidate stale patterns and exports without silently rerunning',async t=>{
  const h=setup(t),pending=h.controls.run();h.jobs[0].resolve(output());await pending;
  const exporting=h.controls.exportCsv('peaks');assert.equal(h.exports[0].kind,'peaks');assert.equal(h.exports[0].settings.stem,'sample');
  h.nodes.get('diffraction-preset').value='co-ka1';h.nodes.get('diffraction-preset').dispatch('change');
  assert.equal(h.controls.serialize().wavelength,1.78897);assert.equal(h.controls.getResult(),null);assert.equal(h.exports[0].options.signal.aborted,true);
  h.exports[0].resolve({blob:new Blob(['old']),filename:'old.csv'});assert.equal(await exporting,false);assert.equal(h.downloads.length,0);
  assert.equal(h.jobs.length,1);assert.equal(h.nodes.get('diffraction-results').hidden,true);
  h.nodes.get('diffraction-wavelength').value='1.3';h.nodes.get('diffraction-wavelength').dispatch('change');assert.equal(h.controls.serialize().wavelengthPreset,'custom');
  const next=h.controls.run();h.jobs[1].resolve({...output(),backend:'cpu',workerCount:3,fallbackReason:'Precision requires CPU'});await next;
  assert.match(h.nodes.get('diffraction-backend').textContent,/CPU · 3 Workers/);assert.match(h.nodes.get('diffraction-status').textContent,/CPU fallback/);
  const current=h.controls.exportCsv('profile');h.exports[1].resolve({blob:new Blob(['new']),filename:'new.csv'});assert.equal(await current,true);assert.equal(h.downloads[0][1],'new.csv');
});

test('frame changes, cancellation and geometry revisions reject late output and preserve unrelated analyses',async t=>{
  const h=setup(t);h.getFrame().atomeyeResults={unrelated:{value:3}};
  const old=h.controls.run(),oldJob=h.jobs[0];h.setFrame(crystalFrame('bcc',1));const refreshed=h.controls.onFrame();
  assert.equal(oldJob.options.signal.aborted,true);oldJob.resolve(output());assert.equal(await old,false);
  h.jobs[1].resolve(output());await refreshed;const frame=h.getFrame();frame.atomeyeResults.unrelated={value:4};
  const next=h.controls.run();h.controls.cancel();h.jobs[2].resolve(output());await next;
  assert.deepEqual(frame.atomeyeResults,{unrelated:{value:4}});assert.equal(h.controls.isEnabled(),false);assert.equal(h.controls.getResult(),null);
  const revision=h.controls.run();frame.geometryRevision=1;h.jobs[3].resolve(output());assert.equal(await revision,false);assert.equal(h.controls.getResult(),null);
});

test('same-frame scientific metadata changes reject pending patterns and CSV without scanning atom arrays',async t=>{
  const h=setup(t);
  const edits=[
    ['coordinates',frame=>{frame.fractional=frame.fractional.slice();}],
    ['types',frame=>{frame.types=frame.types.slice();}],
    ['frame revision',frame=>{frame.revision=1;}],
    ['property revision',frame=>{frame.propertyRevision=1;}],
    ['type revision',frame=>{frame.typesRevision=1;}],
    ['cell vectors',frame=>{frame.cell.vectors[0]+=.1;}],
    ['periodicity',frame=>{frame.cell.pbc[0]=false;}],
    ['type labels',frame=>{frame.typeLabels[0]='Cu';}],
    ['occupancy values',frame=>{frame.properties[0].data=Float64Array.from([.5,1,1,1]);}],
    ['occupancy revision',frame=>{frame.properties[0].revision=1;}],
    ['ADP values',frame=>{frame.properties[1].data=new Float64Array(4).fill(.03);}],
    ['ADP revision',frame=>{frame.properties[1].revision=1;}],
    ['ADP removal',frame=>{frame.properties.pop();}],
  ];
  const frame=()=>({...crystalFrame('fcc',1),properties:[
    {name:'occupancy',data:new Float64Array(4).fill(1)},
    {name:'displacementUxx',data:new Float64Array(4).fill(.01)}]});
  for(const [name,edit] of edits){
    h.setFrame(frame());const pending=h.controls.run(),job=h.jobs.at(-1);edit(h.getFrame());job.resolve(output());
    assert.equal(await pending,false,`${name}: stale calculation`);assert.equal(h.controls.getResult(),null,name);
    assert.equal(h.nodes.get('diffraction-state').textContent,'Not calculated');
    h.setFrame(frame());const ready=h.controls.run();h.jobs.at(-1).resolve(output());await ready;
    const exporting=h.controls.exportCsv('peaks'),exportJob=h.exports.at(-1);edit(h.getFrame());
    exportJob.resolve({blob:new Blob(['old']),filename:'old.csv'});
    assert.equal(await exporting,false,`${name}: stale export`);assert.equal(h.controls.getResult(),null,name);
    assert.equal(h.nodes.get('export-diffraction-peaks').disabled,true,name);
  }
  assert.equal(h.downloads.length,0);
  h.setFrame(frame());const ready=h.controls.run(),result=output();h.jobs.at(-1).resolve(result);await ready;
  h.getFrame().properties.push({name:'coordination',data:new Uint32Array(4)});
  assert.equal(h.controls.getResult(),result,'unrelated analysis properties do not expire diffraction');
});

test('GPU precision corrections identify their CPU work in progress and the actual backend tooltip',async t=>{
  const h=setup(t),pending=h.controls.run();
  h.jobs[0].options.onProgress({backend:'gpu',phase:'cpu-precision-correction',totalReflections:20,completedReflections:16});
  assert.match(h.nodes.get('diffraction-status').textContent,/^CPU · checking reflection precision/);
  assert.equal(h.nodes.get('diffraction-progress').value,.8);
  h.jobs[0].resolve({...output(),correctedReflections:16});await pending;
  assert.equal(h.nodes.get('diffraction-backend').textContent,'WebGPU structure factors');
  assert.equal(h.nodes.get('diffraction-backend').title,'16 reflections checked on CPU');
});

test('radiation changes cancel old work, apply valid mode defaults and show each physical model',async t=>{
  const h=setup(t),xray=h.controls.run();
  h.nodes.get('diffraction-radiation').value='electron';h.nodes.get('diffraction-radiation').dispatch('change');
  assert.equal(h.jobs[0].options.signal.aborted,true);
  h.jobs[0].resolve(output());assert.equal(await xray,false);assert.equal(h.controls.getResult(),null);
  const electron=h.controls.serialize();
  assert.equal(electron.radiation,'electron');assert.equal(electron.wavelengthPreset,'electron-200kev');
  assert.equal(electron.wavelength,electronWavelengthFromEnergy(200));assert.equal(electron.maxAngle,4);
  assert.equal(electron.minAngle,.1);assert.equal(electron.step,.002);assert.equal(electron.fwhm,.03);
  assert.match(h.nodes.get('diffraction-model-help').textContent,/not an oriented single-crystal SAED.*dynamical/);
  assert.equal(h.nodes.get('diffraction-lp-label').textContent,'Powder Lorentz correction');
  assert.equal(h.nodes.get('diffraction-preset-label').textContent,'Accelerating voltage / wavelength');
  assert.deepEqual(h.nodes.get('diffraction-preset').children.map(option=>option.value),['electron-80kev','electron-100kev','electron-200kev','electron-300kev','custom']);
  for(const energy of [80,100,200,300]){
    h.nodes.get('diffraction-preset').value=`electron-${energy}kev`;h.nodes.get('diffraction-preset').dispatch('change');
    const {enabled,wavelengthPreset,...parameters}=h.controls.serialize();
    assert.equal(parameters.wavelength,electronWavelengthFromEnergy(energy));
    assert.doesNotThrow(()=>normalizeDiffractionParameters(parameters));
  }
  const pending=h.controls.run(),job=h.jobs.at(-1);
  assert.equal(job.params.radiation,'electron');
  job.resolve({...output(),radiation:'electron',parameters:job.params});await pending;
  assert.match(h.nodes.get('diffraction-summary').textContent,/^Electron ·/);
  assert.match(h.nodes.get('diffraction-chart').children[0].attributes['aria-label'],/^Electron powder/);
  const exporting=h.controls.exportCsv('profile'),exportJob=h.exports.at(-1);
  h.nodes.get('diffraction-radiation').value='neutron';h.nodes.get('diffraction-radiation').dispatch('change');
  exportJob.resolve({blob:new Blob(['old']),filename:'old.csv'});assert.equal(await exporting,false);assert.equal(h.downloads.length,0);
  assert.equal(h.nodes.get('diffraction-results').hidden,true);
  const neutron=h.controls.serialize();assert.equal(neutron.wavelength,1.8);assert.equal(neutron.maxAngle,150);assert.equal(neutron.wavelengthPreset,'neutron-1.8');
  assert.match(h.nodes.get('diffraction-model-help').textContent,/natural isotope composition.*deuterium/);
  assert.match(h.nodes.get('diffraction-model-help').textContent,/Magnetic scattering, arbitrary isotope enrichment/);
  h.nodes.get('diffraction-preset').value='neutron-2.36';h.nodes.get('diffraction-preset').dispatch('change');
  assert.equal(h.controls.serialize().wavelength,2.36);
  h.nodes.get('diffraction-lp').checked=false;h.nodes.get('diffraction-lp').dispatch('change');
  const neutronRun=h.controls.run(),neutronJob=h.jobs.at(-1);assert.equal(neutronJob.params.lorentzPolarization,false);
  neutronJob.resolve({...output(),radiation:'neutron',parameters:neutronJob.params});await neutronRun;
  assert.match(h.nodes.get('diffraction-summary').textContent,/^Neutron ·/);
});

test('custom radiation wavelengths and legacy X-ray settings restore without changing their scientific parameters',async t=>{
  const h=setup(t);
  await h.controls.restore({radiation:'electron',enabled:false});
  h.nodes.get('diffraction-wavelength').value='.03';h.nodes.get('diffraction-wavelength').dispatch('change');
  assert.equal(h.controls.serialize().radiation,'electron');assert.equal(h.controls.serialize().wavelengthPreset,'custom');
  assert.equal(h.controls.serialize().wavelength,.03);
  const saved=h.controls.serialize();await h.controls.restore(saved);assert.deepEqual(h.controls.serialize(),saved);
  const legacy={...DIFFRACTION_UI_DEFAULTS,enabled:false,wavelengthPreset:'co-ka1',wavelength:1.78897,minAngle:15,maxAngle:75};delete legacy.radiation;
  await h.controls.restore(legacy);assert.deepEqual(h.controls.serialize(),{...legacy,radiation:'xray'});
  assert.equal(h.nodes.get('diffraction-radiation').value,'xray');assert.equal(h.nodes.get('diffraction-lp-label').textContent,'Lorentz–polarization correction');
  assert.deepEqual(h.nodes.get('diffraction-preset').children.map(option=>option.value),['cu-ka1','co-ka1','mo-ka1','custom']);
});

test('peak tables page with bounded DOM while CSV retains the complete current result',async t=>{
  const h=setup(t),pending=h.controls.run();const result=output(120);h.jobs[0].resolve(result);await pending;
  assert.equal(h.nodes.get('diffraction-table-body').children.length,40);assert.match(h.nodes.get('diffraction-table-caption').textContent,/1–40 of 120/);
  h.nodes.get('diffraction-next').dispatch('click');assert.match(h.nodes.get('diffraction-table-caption').textContent,/41–80 of 120/);
  h.nodes.get('diffraction-next').dispatch('click');assert.match(h.nodes.get('diffraction-table-caption').textContent,/81–120 of 120/);assert.equal(h.nodes.get('diffraction-next').disabled,true);
  const pendingExport=h.controls.exportCsv('peaks');assert.equal(h.exports[0].result,result);assert.equal(h.exports[0].result.peaks.length,120);
  h.exports[0].resolve({blob:new Blob(['all']),filename:'all.csv'});await pendingExport;
});

test('restored diffraction settings recalculate and invalid input clears the obsolete displayed result',async t=>{
  const h=setup(t);const restore=h.controls.restore({enabled:true,...DIFFRACTION_UI_DEFAULTS,wavelengthPreset:'custom',wavelength:1.1,minAngle:10,maxAngle:60});
  assert.equal(h.jobs[0].params.wavelength,1.1);assert.equal(h.jobs[0].params.minAngle,10);h.jobs[0].resolve(output());await restore;
  h.nodes.get('diffraction-min-angle').value='100';h.nodes.get('diffraction-min-angle').dispatch('change');assert.equal(h.controls.getResult(),null);assert.equal(h.nodes.get('diffraction-state').textContent,'Invalid input');assert.equal(h.jobs.length,1);
  h.controls.reset();assert.equal(h.controls.isUntouched(),true);assert.equal(h.controls.serialize().wavelength,1.5406);
  await h.controls.restore({enabled:true},{isCurrent:()=>false});assert.equal(h.jobs.length,1);
});

test('chart decimation retains narrow maxima, nearest-peak lookup is bounded and source arrays stay intact',()=>{
  const result=output(),angles=Float64Array.from({length:10000},(_,i)=>5+85*i/9999),values=new Float64Array(10000);values[4973]=100;
  result.profile={twoTheta:angles,relativeIntensity:values};const paths=diffractionChartPaths(result,100);
  assert.ok((paths.curve.match(/[ML]/g)??[]).length<=100);assert.match(paths.curve,/,18\.000/);assert.equal(values[4973],100);
  assert.equal(nearestDiffractionPeak(result.peaks,-10),0);assert.equal(nearestDiffractionPeak(result.peaks,200),2);assert.equal(nearestDiffractionPeak(result.peaks,10.7),1);assert.equal(nearestDiffractionPeak([],20),-1);
});

test('diffraction configurations retain only validated physical settings and migrate older recipes as disabled',()=>{
  assert.equal(Object.hasOwn(createConfiguration().settings.extensions,'diffraction'),false);
  const diffraction={enabled:true,...DIFFRACTION_UI_DEFAULTS,wavelengthPreset:'custom',wavelength:1.2,useThermal:false};
  const recipe=createConfiguration({settings:{extensions:{diffraction}}});assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.extensions.diffraction,diffraction);
  for(const invalid of [{wavelength:0},{wavelength:NaN},{wavelength:1,wavelengthPreset:'co-ka1'},{minAngle:100,maxAngle:90},{fwhm:0},{step:0},{useThermal:1},{lorentzPolarization:'yes'},{enabled:1},{peaks:[]},{wavelengthPreset:'Cu'}]) {
    assert.throws(()=>createConfiguration({settings:{extensions:{diffraction:invalid}}}),/settings\.extensions\.diffraction/);
  }
});

test('electron and neutron recipes validate their radiation-specific presets and preserve old X-ray recipes',()=>{
  for(const radiation of ['electron','neutron']){
    const settings={enabled:true,...normalizeDiffractionParameters({radiation})};
    const recipe=createConfiguration({settings:{extensions:{diffraction:settings}}});
    const saved=recipe.settings.extensions.diffraction;
    assert.equal(saved.radiation,radiation);assert.equal(saved.wavelengthPreset,radiation==='electron'?'electron-200kev':'neutron-1.8');
    assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.extensions.diffraction,saved);
  }
  const legacy={...DIFFRACTION_UI_DEFAULTS,enabled:true};delete legacy.radiation;
  assert.deepEqual(createConfiguration({settings:{extensions:{diffraction:legacy}}}).settings.extensions.diffraction,{...legacy,radiation:'xray'});
  for(const invalid of [
    {radiation:'proton'},
    {radiation:'electron',wavelengthPreset:'cu-ka1'},
    {radiation:'neutron',wavelengthPreset:'electron-200kev'},
    {radiation:'electron',wavelengthPreset:'electron-300kev',wavelength:electronWavelengthFromEnergy(200)},
    {radiation:'neutron',wavelengthPreset:'neutron-2.36',wavelength:1.8},
    {radiation:'electron',maxAngle:90},
  ])assert.throws(()=>createConfiguration({settings:{extensions:{diffraction:invalid}}}),/settings\.extensions\.diffraction/);
});
