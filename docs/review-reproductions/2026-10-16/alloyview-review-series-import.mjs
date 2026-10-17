// Archived review evidence for baseline 77b24ad; see docs/REPOSITORY_REVIEW_2026-10-16.md.
import { initializeTimeSeries } from '../../../src/time-series-controls.js';
import { createAttributeRegistry } from '../../../src/global-attributes.js';
import { createCell } from '../../../src/data/model.js';
const frames=[0,1,2].map(frameIndex=>({frameIndex,timestep:frameIndex,ids:Uint32Array.of(1),types:Uint8Array.of(0),typeLabels:['Fe'],cell:createCell({vectors:[1,0,0,0,1,0,0,0,1]}),properties:[]}));
let listener; const reads=[];
const attributes={current:()=>createAttributeRegistry({frame:frames[0],frameCount:3}),forFrame:(f,i)=>createAttributeRegistry({frame:f,frameIndex:i,fileOnly:true}),subscribe:cb=>{listener=cb},getStrainReferenceFrame:()=>0};
const series=initializeTimeSeries({attributes,getFrame:()=>frames[0],getFrameCount:()=>3,getFrameAt:async i=>{reads.push(i);return frames[i]},documentRoot:null});
await series.restore({attributes:['Mean.energy']});
await series.collect();
console.log('Before import',{reads:[...reads],values:series.getData().series[0].values});
for(const f of frames)f.properties=[{name:'energy',externalImportId:'external-1',data:Float64Array.of(f.frameIndex+10)}];
listener(attributes.current()); reads.length=0;
await series.collect();
console.log('After import+Read file values',{reads,values:series.getData().series[0].values,available:frames.map(f=>attributes.forFrame(f,f.frameIndex).get('Mean.energy').value)});
