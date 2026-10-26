import { useSoftwareAdapter, withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

const software=useSoftwareAdapter(true);
const report=await withWebGpuBrowser(async({evaluate,adapter})=>({adapter,softwareValidation:software,
  rows:await evaluate(`(${checks.toString()})()`,{timeoutMs:240_000})}),{software});
console.log(JSON.stringify(report,null,2));

async function checks(){
  const [{GpuRuntime},{analyzeGpuDiffraction,releaseGpuDiffraction,warmGpuDiffraction},
    {prepareDiffraction,prepareDiffractionSteps,evaluatePreparedScatteringFactor,calculateDiffractionRange,finalizeDiffractionSteps},{crystalFrame},{createCell},{runParserSteps}]=await Promise.all([
      import('./src/analysis/gpu/runtime.js'),import('./src/analysis/gpu/diffraction.js'),
      import('./src/analysis/diffraction.js'),import('./tests/helpers/crystals.js'),import('./src/data/model.js'),import('./src/io/cooperative-parser.js')]);
  const finalizeDiffraction=(prepared,parts)=>runParserSteps(finalizeDiffractionSteps(prepared,parts));
  const runtime=new GpuRuntime(),rows=[];
  const check=(condition,message)=>{if(!condition)throw new Error(message);};
  const crystal=(kind,element,lattice,repeat=1)=>({...crystalFrame(kind,repeat,lattice),typeLabels:[element]});
  const parameters={maxAngle:100,step:0.1,useThermal:false};
  async function run(label,frame,settings=parameters,{source,range}={}){
    const prepared=source??prepareDiffraction(frame,settings),cpu=calculateDiffractionRange(prepared,range);
    const progress=[],gpu=await analyzeGpuDiffraction(runtime,prepared,{...range,onProgress:value=>progress.push(value)});
    check(gpu.backend==='gpu',label+': requires real GPU execution');
    check(gpu.radiation===prepared.radiation,label+': backend model metadata must identify the evaluated radiation');
    let maximumAmplitudeError=0,maximumIntensityError=0,extinctions=0,weak=0;
    for(let i=0;i<cpu.real.length;i++){
      const bound=Math.max(cpu.amplitudeBound[i],1e-20);
      const amplitudeError=Math.hypot(gpu.real[i]-cpu.real[i],gpu.imag[i]-cpu.imag[i])/bound;
      const intensityError=Math.abs(gpu.intensity[i]-cpu.intensity[i])/Math.max(cpu.intensity[i],bound*bound*1e-24);
      maximumAmplitudeError=Math.max(maximumAmplitudeError,amplitudeError);maximumIntensityError=Math.max(maximumIntensityError,intensityError);
      check(amplitudeError<2e-5,label+': complex amplitude mismatch '+amplitudeError+' at '+i);
      check(intensityError<8e-5,label+': intensity mismatch '+intensityError+' at '+i);
      if(cpu.intensity[i]<bound*bound*1e-12){
        check(gpu.intensity[i]===cpu.intensity[i],label+': weak/extinct reflection needs exact f64 correction');
        if(cpu.intensity[i]>bound*bound*1e-25)weak++;else extinctions++;
      }
    }
    if(!range){
      const actual=finalizeDiffraction(prepared,[gpu]),expected=finalizeDiffraction(prepared,[cpu]);
      check(actual.peaks.length===expected.peaks.length,label+': false or lost powder peak');
      for(let i=0;i<expected.peaks.length;i++){
        check(actual.peaks[i].twoTheta===expected.peaks[i].twoTheta,label+': peak position changed');
        check(Math.abs(actual.peaks[i].relativeIntensity-expected.peaks[i].relativeIntensity)<0.008,label+': normalized peak mismatch');
      }
    }
    check(progress.at(-1)?.phase==='complete',label+': missing progress completion');
    rows.push({label,radiation:prepared.radiation,atoms:prepared.atomCount,reflections:gpu.real.length,correctedReflections:gpu.correctedReflections,
      maximumAmplitudeError,maximumIntensityError,extinctions,weak,inputReused:gpu.inputReused});
    return {prepared,gpu};
  }
  try{
    await warmGpuDiffraction(runtime);
    const fcc=await run('FCC Cu systematic absences',crystal('fcc','Cu',3.615));
    check(fcc.gpu.correctedReflections>0&&fcc.gpu.correctedReflections<fcc.prepared.reflectionCount,'FCC must use GPU for strong reflections and exact CPU for extinctions');
    check((await run('Retained atom uploads and scratch',null,parameters,{source:fcc.prepared})).gpu.inputReused,'unchanged prepared atoms should remain resident');
    const sharedNeutron=runParserSteps(prepareDiffractionSteps(null,{...parameters,radiation:'neutron'},{source:fcc.prepared}));
    check(sharedNeutron.fractional===fcc.prepared.fractional,'model retarget must share geometric source arrays');
    check((await run('Radiation switch retains geometry but replaces scattering factors',null,parameters,{source:sharedNeutron})).gpu.inputReused,'model switch must reuse geometric uploads');
    check((await run('Switching back to X-ray restores its factors',null,parameters,{source:fcc.prepared})).gpu.inputReused,'returning to X-ray must retain atom uploads');
    await run('BCC Fe systematic absences',crystal('bcc','Fe',2.866));
    await run('Diamond Si additional systematic absences',crystal('diamond','Si',5.431));
    await run('HCP Ti non-dyadic phases',crystal('hcp','Ti',2.95));
    const weak=crystal('bcc','Fe',2.866);weak.properties=[{name:'occupancy',data:Float64Array.from([1,1-1e-8])}];
    await run('Genuine weak peaks from almost equal occupancies',weak);
    const partial=crystal('fcc','Cu',3.615);partial.properties=[{name:'occupancy',data:Float64Array.from([1,.8,.6,.9])},
      {name:'Uiso',data:Float64Array.from([.005,.01,.02,.015])}];
    await run('Partial occupancy with isotropic thermal displacement',partial,{...parameters,useThermal:true});
    const skew=crystal('fcc','Cu',3.615);skew.typeLabels=['Cu','Ni'];skew.types=Uint16Array.from([0,1,0,1]);
    skew.cell=createCell({vectors:[4.1,.2,-.1,1.2,3.5,.3,-.4,.6,4.8],triclinic:true});
    skew.fractional=Float64Array.from([.123456789,.234567891,.345678912,.333333333,.444444444,.555555555,.73123456,.81234567,.91234568,.25,.75,.125]);
    const covariance=[.01,.02,.03,.002,-.001,.003];
    skew.properties=['xx','yy','zz','xy','xz','yz'].map((axis,c)=>({name:`displacementU${axis}`,data:Float64Array.from({length:4},(_,i)=>covariance[c]*(1+i*.1))}));
    await run('Triclinic mixed species with anisotropic thermal displacement',skew,{...parameters,useThermal:true});
    await run('Electron Si small-angle diffraction at 200 keV',crystal('diamond','Si',5.431),
      {radiation:'electron',maxAngle:1.8,step:.002,useThermal:false});
    await run('Electron mixed triclinic anisotropic thermal factors',skew,
      {radiation:'electron',maxAngle:1.8,step:.002,useThermal:true});
    await run('Neutron HCP Ti negative coherent length',crystal('hcp','Ti',2.95),
      {...parameters,radiation:'neutron'});
    const neutronWeak=crystal('bcc','Fe',4);neutronWeak.typeLabels=['Fe','Ti'];neutronWeak.types=Uint16Array.from([0,1]);
    const neutronProbe=prepareDiffraction(neutronWeak,{...parameters,radiation:'neutron'});
    const ratio=-evaluatePreparedScatteringFactor(neutronProbe,1,0)/evaluatePreparedScatteringFactor(neutronProbe,0,0);
    neutronWeak.properties=[{name:'occupancy',data:Float64Array.from([ratio*(1-1e-8),1])}];
    await run('Neutron signed-species cancellation retains genuine weak peaks',neutronWeak,
      {...parameters,radiation:'neutron'});
    await run('Neutron mixed triclinic anisotropic thermal factors',skew,
      {...parameters,radiation:'neutron',useThermal:true});
    const chunks=await run('Multiple 512-atom workgroups',crystal('bcc','Fe',2.866,7),{...parameters,maxAngle:55});
    check(chunks.gpu.correctedReflections<chunks.prepared.reflectionCount,'multi-chunk reduction must retain genuine nonzero GPU results');
    const ranged=prepareDiffraction(crystal('hcp','Ti',2.95),parameters);
    await run('Nonzero reflection range',null,parameters,{source:ranged,range:{start:3,end:Math.min(37,ranged.reflectionCount)}});
    const high={...ranged,hkls:ranged.hkls.slice()};high.hkls[0]=1025;
    let rejected=false;try{await analyzeGpuDiffraction(runtime,high);}catch(error){check(error.name==='GpuUnavailableError','high hkl must explicitly request CPU');rejected=true;}
    check(rejected,'unsupported high Miller coefficients must request CPU fallback');
    const controller=new AbortController();let cancelled=false;
    try{await analyzeGpuDiffraction(runtime,ranged,{signal:controller.signal,onProgress:p=>{if(p.phase==='gpu-structure-factors')controller.abort();}});}
    catch(error){check(error.name==='AbortError','GPU cancellation must not become CPU fallback');cancelled=true;}
    check(cancelled,'GPU diffraction should be cancellable');
    await run('Cancellation preserves the retained device',null,parameters,{source:ranged});
    releaseGpuDiffraction(runtime);
    check(!(await run('Source clear reloads atom uploads',null,parameters,{source:ranged})).gpu.inputReused,'source clear must release uploads');
  }finally{releaseGpuDiffraction(runtime);runtime.close();}
  return rows;
}
