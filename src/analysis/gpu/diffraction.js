import { GpuUnavailableError, checkSignal, yieldWorker } from './runtime.js';
import { DIFFRACTION_STRUCTURE_FACTORS_SHADER } from './diffraction-shaders.js';
import { evaluateDiffractionReflectionSteps } from '../diffraction.js';
import { runParserStepsAsync } from '../../io/cooperative-parser.js';

const caches = new WeakMap();
const ATOMS_PER_CHUNK = 512, REFLECTIONS_PER_BATCH = 64;
const MAX_DISPATCH_WORK = 2_000_000, MAX_UPLOAD_BYTES = 128 * 1024 ** 2;
const FLOAT_MIN_NORMAL = 2 ** -126, MAX_HKL = 1024;
const COMPLEX_RELATIVE_TOLERANCE = 2e-5;
const MAX_DENSE_CORRECTION_WORK = 8_000_000;
const scoped = (runtime, operation) => runtime.withErrors ? runtime.withErrors(operation) : Promise.resolve().then(operation);
const unavailable = message => new GpuUnavailableError(`GPU diffraction: ${message}`);
const copyNumber = value => {
  const result = Math.fround(value);
  if (!Number.isFinite(result) || result !== 0 && Math.abs(result) < FLOAT_MIN_NORMAL || value !== 0 && result === 0) {
    throw unavailable('an input value exceeds normal float32 precision; using CPU Workers.');
  }
  return result;
};

function shape(prepared) {
  const n=prepared?.atomCount,r=prepared?.reflectionCount,t=prepared?.typeLabels?.length;
  if (!Number.isSafeInteger(n)||n<1||!Number.isSafeInteger(r)||r<0||!Number.isSafeInteger(t)||t<1
      ||prepared.fractional?.length!==n*3||prepared.types?.length!==n||prepared.occupancy?.length!==n
      ||prepared.coefficients?.length!==t*9||prepared.hkls?.length!==r*3||prepared.reciprocal?.length!==r*3
      ||prepared.s2?.length!==r||prepared.thermal&&prepared.thermal.length!==n*6) throw new Error('Invalid prepared diffraction arrays.');
  return {n,r,t};
}

export async function warmGpuDiffraction(runtime, { signal } = {}) {
  checkSignal(signal); await runtime.initialize(signal); checkSignal(signal);
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort=()=>reject(new DOMException('Diffraction cancelled.','AbortError'));
    signal?.addEventListener('abort',abort,{once:true});
  });
  try { await Promise.race([runtime.compilePipeline(DIFFRACTION_STRUCTURE_FACTORS_SHADER),cancelled]); }
  finally { signal?.removeEventListener('abort',abort); }
  checkSignal(signal);
}

export function releaseGpuDiffraction(runtime) {
  const cached=caches.get(runtime);
  if(cached) runtime.disposeBuffers([...cached.inputs,...Object.values(cached.scratch).map(value=>value.buffer)]);
  caches.delete(runtime);
}

function sameSource(cached,prepared,runtime) {
  return cached?.device===runtime.device && cached.fractional===prepared.fractional && cached.types===prepared.types
    &&cached.occupancy===prepared.occupancy&&cached.thermal===prepared.thermal&&cached.coefficients===prepared.coefficients;
}

/** Retain only minimal immutable atom inputs. A wavelength/range/profile edit
 * does not need another atom upload when preparation retains these arrays. */
export async function prepareGpuDiffraction(runtime, prepared, { signal, withCpu=operation=>operation() } = {}) {
  const {n,t}=shape(prepared); checkSignal(signal);
  const bytes=n*(prepared.thermal?64:32);
  if(bytes>MAX_UPLOAD_BYTES) throw unavailable('the atom upload exceeds its memory budget.');
  await runtime.initialize(signal);
  if(sameSource(caches.get(runtime),prepared,runtime)) return {cache:caches.get(runtime),inputReused:true};
  const high=new Float32Array(n*4),low=new Float32Array(n*4),thermal=new Float32Array(prepared.thermal?n*8:8);
  const populations=new Float64Array(t),occupancyErrors=new Float64Array(t),maxThermal=new Float64Array(6),thermalErrors=new Float64Array(6);
  await withCpu(async()=>{for(let atom=0;atom<n;atom++) {
    if((atom&8191)===0) {checkSignal(signal);await yieldWorker();}
    const type=prepared.types[atom],occupancy=prepared.occupancy[atom];
    if(!Number.isSafeInteger(type)||type<0||type>=t||!Number.isFinite(occupancy)||occupancy<0) throw new Error('Invalid diffraction species or occupancy.');
    for(let axis=0;axis<3;axis++) {
      const value=prepared.fractional[atom*3+axis];
      if(!Number.isFinite(value)||value<0||value>=1) throw new Error('GPU diffraction requires wrapped fractional coordinates.');
      const coarse=Math.floor(value*4096)/4096;
      high[atom*4+axis]=coarse;low[atom*4+axis]=copyNumber(value-coarse);
    }
    high[atom*4+3]=copyNumber(occupancy);low[atom*4+3]=type;
    populations[type]+=occupancy;occupancyErrors[type]+=Math.abs(occupancy-high[atom*4+3]);
    if(prepared.thermal) for(let component=0;component<6;component++) {
      const value=prepared.thermal[atom*6+component],encoded=copyNumber(value);
      thermal[atom*8+component]=encoded;
      maxThermal[component]=Math.max(maxThermal[component],Math.abs(value));
      thermalErrors[component]=Math.max(thermalErrors[component],Math.abs(value-encoded));
    }
  }});
  checkSignal(signal);
  const inputs=[];
  try {
    runtime.reserveWorkspace?.(bytes+32);
    await scoped(runtime,()=>{for(const array of [high,low,thermal])inputs.push(runtime.storageBuffer(array));});
    checkSignal(signal);
  }catch(error){runtime.disposeBuffers(inputs);throw error;}
  releaseGpuDiffraction(runtime);
  const cache={device:runtime.device,fractional:prepared.fractional,types:prepared.types,occupancy:prepared.occupancy,
    thermal:prepared.thermal,coefficients:prepared.coefficients,inputs,scratch:{},populations,occupancyErrors,maxThermal,thermalErrors};
  caches.set(runtime,cache);return {cache,inputReused:false};
}

async function scratch(runtime,cache,name,bytes) {
  const old=cache.scratch[name];if(old?.bytes>=bytes)return old.buffer;
  const size=Math.max(4,2**Math.ceil(Math.log2(bytes||4)));
  runtime.disposeBuffers([old?.buffer]);delete cache.scratch[name];
  let buffer;
  try{await scoped(runtime,()=>{buffer=runtime.createBuffer(size);});}
  catch(error){runtime.disposeBuffers([buffer]);throw error;}
  cache.scratch[name]={buffer,bytes:size};return buffer;
}

/** Species-only scattering factors are prepared in f64. The expensive
 * atom×reflection phase/thermal products and reductions run on WebGPU. */
export function packDiffractionBatch(prepared,cache,start,end) {
  const {t}=shape(prepared),count=end-start;
  const reflections=new Float32Array(count*12),factors=new Float32Array(count*t);
  const bounds=new Float64Array(count),errors=new Float64Array(count);
  for(let local=0;local<count;local++) {
    const index=start+local,h=prepared.hkls.subarray(index*3,index*3+3);
    if([...h].some(value=>!Number.isSafeInteger(value)||Math.abs(value)>MAX_HKL)) throw unavailable(`Miller indices above ${MAX_HKL} need the double-precision CPU path.`);
    reflections.set(h,local*12);
    const [gx,gy,gz]=prepared.reciprocal.subarray(index*3,index*3+3),s2=prepared.s2[index];
    if(![gx,gy,gz,s2].every(Number.isFinite)||s2<0)throw new Error('Invalid prepared diffraction reciprocal geometry.');
    const q=[gx*gx,gy*gy,gz*gz,2*gx*gy,2*gx*gz,2*gy*gz];
    let qBound=0,qError=0;
    for(let c=0;c<6;c++) {
      const encoded=copyNumber(q[c]);reflections[local*12+4+c]=encoded;
      qBound+=Math.abs(q[c])*cache.maxThermal[c];
      qError+=Math.abs(q[c]-encoded)*cache.maxThermal[c]+Math.abs(encoded)*cache.thermalErrors[c];
    }
    let amplitudeBound=0,amplitudeError=0;
    for(let type=0;type<t;type++) {
      const offset=type*9;let factor=prepared.coefficients[offset+8];
      for(let k=0;k<4;k++)factor+=prepared.coefficients[offset+k]*Math.exp(-prepared.coefficients[offset+4+k]*s2);
      const encoded=copyNumber(factor);factors[local*t+type]=encoded;
      amplitudeBound+=Math.abs(factor)*cache.populations[type];
      amplitudeError+=Math.abs(factor-encoded)*cache.populations[type]+Math.abs(encoded)*cache.occupancyErrors[type];
    }
    // The high dot is exact by construction. Low dot, reduced phase and
    // polynomial errors are bounded before grouping any powder peaks. The
    // bound also covers tree reduction of 512 terms and host partial sums.
    const phaseError=2**-26+(Math.abs(h[0])+Math.abs(h[1])+Math.abs(h[2]))*2**-35;
    const thermalError=prepared.thermal ? 2*Math.PI**2*(qError+qBound*8*2**-24)+2e-6 : 0;
    bounds[local]=amplitudeBound;
    errors[local]=amplitudeError+amplitudeBound*(3e-6+2*Math.PI*phaseError+thermalError);
    if(!Number.isFinite(bounds[local])||!Number.isFinite(errors[local]))throw unavailable('amplitude bounds exceed GPU numeric range.');
  }
  return {reflections,factors,bounds,errors};
}

export async function analyzeGpuDiffraction(runtime,prepared,{signal,onProgress=()=>{},start=0,end=prepared.reflectionCount,withCpu=operation=>operation()}={}) {
  const {n,r,t}=shape(prepared);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>r)throw new Error('Invalid diffraction reflection range.');
  checkSignal(signal);
  const startedAt=performance.now(),length=end-start;
  const real=new Float64Array(length),imag=new Float64Array(length),intensity=new Float64Array(length),amplitudeBound=new Float64Array(length);
  const report=(phase,completed=0)=>onProgress({phase,backend:'gpu',completedReflections:completed,totalReflections:length,completed,total:length});
  report('preparing');
  const {cache,inputReused}=await prepareGpuDiffraction(runtime,prepared,{signal,withCpu});
  const chunks=Math.ceil(n/ATOMS_PER_CHUNK),maxGroups=runtime.device?.limits?.maxComputeWorkgroupsPerDimension??65535;
  if(chunks>maxGroups)throw unavailable('the atom count exceeds one bounded reduction dispatch.');
  const batchSize=Math.max(1,Math.min(REFLECTIONS_PER_BATCH,Math.floor(MAX_DISPATCH_WORK/n),Math.floor(maxGroups/chunks)));
  const settings=new Uint32Array([n,t,0,chunks,prepared.thermal?1:0,0,0,0]);
  const config=await scratch(runtime,cache,'settings',settings.byteLength);
  let correctedReflections=0;
  for(let first=start;first<end;first+=batchSize) {
    checkSignal(signal);
    const last=Math.min(end,first+batchSize),count=last-first,packed=await withCpu(()=>packDiffractionBatch(prepared,cache,first,last));
    const reflectionBuffer=await scratch(runtime,cache,'reflections',packed.reflections.byteLength);
    const factorBuffer=await scratch(runtime,cache,'factors',packed.factors.byteLength);
    const partialBuffer=await scratch(runtime,cache,'partials',count*chunks*16);
    settings[2]=count;runtime.write(config,settings);runtime.write(reflectionBuffer,packed.reflections);runtime.write(factorBuffer,packed.factors);
    report('gpu-structure-factors',first-start);
    await runtime.run(DIFFRACTION_STRUCTURE_FACTORS_SHADER,[config,...cache.inputs,reflectionBuffer,factorBuffer,partialBuffer],count*chunks*128,
      {signal,batchSize:0,workgroupSize:128,wait:false});
    const partials=await runtime.read(partialBuffer,Float32Array,count*chunks*4,{signal});
    await withCpu(async()=>{for(let local=0;local<count;local++) {
      checkSignal(signal);
      const output=first-start+local;let re=0,im=0,bound=0;
      for(let chunk=0;chunk<chunks;chunk++) {
        const offset=(local*chunks+chunk)*4;re+=partials[offset];im+=partials[offset+1];bound+=partials[offset+2];
      }
      if(![re,im,bound].every(Number.isFinite)||bound<0)throw unavailable('the device returned an invalid complex amplitude.');
      const magnitude=Math.hypot(re,im),uncertainty=packed.errors[local];
      if(magnitude===0||uncertainty>magnitude*COMPLEX_RELATIVE_TOLERANCE) {
        // Large repeated crystals can have mostly extinct supercell hkl rows.
        // Recovering those serially would defeat the shared CPU pool. Small
        // unit cells keep sparse recovery, while costly dense recovery returns
        // to the complete parallel CPU implementation, preserving every peak.
        if(n*(correctedReflections+1)>MAX_DENSE_CORRECTION_WORK
            &&(correctedReflections+1)/(output+1)>.25) {
          throw unavailable('many reflections need double-precision recovery; using parallel CPU Workers.');
        }
        const exact=await runParserStepsAsync(evaluateDiffractionReflectionSteps(prepared,first+local),{signal});
        real[output]=exact.real;imag[output]=exact.imag;intensity[output]=exact.intensity;amplitudeBound[output]=exact.amplitudeBound;
        correctedReflections++;
        if((correctedReflections&15)===0){report('cpu-precision-correction',output);await yieldWorker();}
      }else {
        real[output]=re;imag[output]=im;intensity[output]=re*re+im*im;amplitudeBound[output]=Math.max(bound,packed.bounds[local]);
      }
      if(!Number.isFinite(intensity[output]))throw unavailable('the structure-factor intensity exceeds the numeric range.');
    }});
    report('gpu-structure-factors',last-start);await yieldWorker();
  }
  checkSignal(signal);report('complete',length);
  return {start,end,real,imag,intensity,amplitudeBound,backend:'gpu',correctedReflections,inputReused,
    elapsedMs:performance.now()-startedAt,precision:'f32 with bounded f64 reflection corrections'};
}
