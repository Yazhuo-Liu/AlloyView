// Archived review evidence for baseline 77b24ad; see docs/REPOSITORY_REVIEW_2026-10-16.md.
import { withWebGpuBrowser } from '../../../scripts/webgpu-browser.mjs';
const report = await withWebGpuBrowser(async ({evaluate,adapter}) => {
 await evaluate(`globalThis.checks=(${checks.toString()})();undefined`);
 const rows=[];
 for(let n=0;n<40;n++){
  const step=await evaluate('globalThis.checks.next()');
  if(step.done)return {adapter,rows,...step.value};
  rows.push(step.value);console.log(JSON.stringify(step.value));
 }
 throw Error('too many stages');
});
console.log(JSON.stringify(report,null,2));
async function* checks(){
 const [clientModule,crystals,coord,rdf,bonds,statistics,cna,csp,shear,strain,reference,displacement,model]=await Promise.all([
  import('./src/analysis/gpu/client.js'),import('./tests/helpers/crystals.js'),import('./src/analysis/coordination.js'),
  import('./src/analysis/rdf.js'),import('./src/analysis/bonds.js'),import('./src/analysis/bond-statistics.js'),import('./src/analysis/cna.js'),
  import('./src/analysis/centrosymmetry.js'),import('./src/analysis/local-shear.js'),import('./src/analysis/atomic-strain.js'),
  import('./src/analysis/reference-strain.js'),import('./src/analysis/displacement.js'),import('./src/data/model.js')]);
 const client=new clientModule.GpuAnalysisClient(),anomalies=[];
 const compare=(a,b,tol=0)=>{
  if(a.length!==b.length)return 'length '+a.length+'/'+b.length;
  let error=0;for(let i=0;i<a.length;i++){
   if(!Number.isFinite(a[i])||!Number.isFinite(b[i])){if(!Object.is(a[i],b[i]))return 'nonfinite '+i+' '+a[i]+'/'+b[i];continue;}
   const e=Math.abs(a[i]-b[i]);error=Math.max(error,e);if(e>tol*Math.max(1,Math.abs(b[i])))return 'value '+i+' '+a[i]+'/'+b[i];
  }return null;
 };
 try{
  await client.warmup();yield {stage:'warmup',exactPairs:client.cacheStatus.exactPairs};
  for(let variant=0;variant<3;variant++){
   const frame=crystals.crystalFrame(variant===1?'hcp':'fcc',2);
   if(variant===2)frame.cell=model.createCell({vectors:[8,0,0,1.3,7.4,0,.4,.2,8.3],pbc:[false,false,false],triclinic:true});
   for(let i=0;i<frame.fractional.length;i++)frame.fractional[i]=variant===2?.03+.94*frame.fractional[i]+.012*Math.sin(i*8.12):frame.fractional[i]+.007*Math.sin(i*8.12);
   frame.positions=model.fractionalToCartesian(frame.fractional,frame.cell);
   frame.typeLabels=['A','B'];for(let i=0;i<frame.types.length;i++)frame.types[i]=i%2;
   const tasks=[
    [{kind:'coordination',cutoff:3.1},()=>coord.calculateCoordination(frame,3.1),['coordination'],0],
    [{kind:'cna',mode:'adaptive'},()=>cna.calculateCna(frame),['structures'],0],
    [{kind:'centrosymmetry',neighbors:8},()=>csp.calculateCentrosymmetry(frame,{neighbors:8}),['centrosymmetry'],1e-6],
    [{kind:'localShear',cutoff:3.1,subtractMean:true},()=>shear.calculateLocalShear(frame,{cutoff:3.1,subtractMean:true}),['coordination','localShear'],2e-5],
    [{kind:'bondStatistics',cutoff:3.1,lengthBins:24,angleBins:36,pairCutoffs:[{first:0,second:1,cutoff:2.9}]},p=>statistics.calculateBondStatistics(frame,p),['coordination','q4','q6','lengthCounts','angleCounts'],2e-5]
   ];
   if(variant!==2)tasks.push([{kind:'rdf',cutoff:2,bins:20,firstType:0,secondType:1},p=>rdf.calculateRdf(frame,p),['counts'],0]);
   for(const [p,cpu,fields,tol]of tasks){
    let status;try{const expected=await cpu(p),actual=await client.analyze(frame,p);const failures=fields.map(key=>[key,compare(actual[key],expected[key],tol)]).filter(([,e])=>e);status={variant,kind:p.kind,failures};if(failures.length)anomalies.push(status);}
    catch(error){status={variant,kind:p.kind,fallback:error.message};}yield status;
   }
   const other=structuredClone(frame);for(let i=0;i<other.fractional.length;i++)other.fractional[i]+=.002*Math.cos(i*1.89);other.positions=model.fractionalToCartesian(other.fractional,other.cell);
   const mapping=Int32Array.from({length:frame.types.length},(_,i)=>i);
   const p={kind:'referenceStrain',cutoff:3.1,referenceFrame:frame,referenceFractional:frame.fractional,referenceCell:frame.cell,referenceMapping:mapping};
   try{const expected=reference.calculateReferenceStrain(other,p),actual=await client.analyze(other,p);const failures=reference.REFERENCE_STRAIN_FIELDS.map(key=>[key,compare(actual[key],expected[key],1e-5)]).filter(([,e])=>e);const status={variant,kind:p.kind,failures};if(failures.length)anomalies.push(status);yield status;}catch(error){yield{variant,kind:p.kind,fallback:error.message};}
   const dp={kind:'displacement',...await displacement.prepareDisplacements(other,frame)};
   try{const expected=displacement.calculatePreparedDisplacements(other,dp),actual=await client.analyze(other,dp);const failures=['vectors','magnitudes'].map(key=>[key,compare(actual[key],expected[key],1e-6)]).filter(([,e])=>e);const status={variant,kind:dp.kind,failures};if(failures.length)anomalies.push(status);yield status;}catch(error){yield{variant,kind:dp.kind,fallback:error.message};}
  }
  return{anomalies};
 }finally{client.close();}
}
