// Archived review evidence for baseline 77b24ad; see docs/REPOSITORY_REVIEW_2026-10-16.md.
import {parseCfg} from '../../../src/io/cfg.js';
import {replicateFrame} from '../../../src/data/replicate.js';
import {computeDisplacements} from '../../../src/analysis/displacement.js';
const header='Number of particles = 1\nA = 1 Angstrom\n'+Array.from({length:9},(_,i)=>`H0(${Math.floor(i/3)+1},${i%3+1}) = ${i%4===0?10:0}`).join('\n')+'\n';
const values=[1.9999,1.999999],frames=values.map(x=>parseCfg(header+`55.845 Fe ${x} .2 .3\n`));
const expanded=await Promise.all(frames.map(f=>replicateFrame(f,[2,1,1])));
console.log('expected physical displacement:',(values[1]-values[0])*10);
console.log('expected after deliberate tolerance stabilization: approximately 0.001');
console.log('unwrapped source displacement:',Array.from((await computeDisplacements(frames[1],frames[0],{minimumImage:false})).vectors));
console.log('replicated default displacement:',Array.from((await computeDisplacements(expanded[1],expanded[0])).vectors));
for(let i=0;i<2;i++) console.log('source',values[i],{fractional:Array.from(frames[i].fractional),imageFlags:Array.from(frames[i].imageFlags),unwrapped:Array.from(frames[i].unwrappedPositions)});
