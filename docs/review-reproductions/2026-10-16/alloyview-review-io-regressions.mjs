// Archived review evidence for baseline 77b24ad; see docs/REPOSITORY_REVIEW_2026-10-16.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCfg } from '../../../src/io/cfg.js';
import { parseLammpsFrame } from '../../../src/io/lammps-dump.js';
import { parseLammpsData } from '../../../src/io/lammps-data.js';
import { parsePoscar } from '../../../src/io/poscar.js';
import { detectStructureFormatHeader } from '../../../src/io/file-sequences.js';
import { replicateFrame } from '../../../src/data/replicate.js';
import { computeDisplacements } from '../../../src/analysis/displacement.js';
const dump=(x,ix)=>`ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n1\nITEM: BOX BOUNDS pp pp pp\n0 10\n0 10\n0 10\nITEM: ATOMS id type x y z ix iy iz\n1 1 ${x} 2 3 ${ix} 0 0\n`;
test('a dump atom slightly outside its box retains continuous physical copies',async()=>{
 const frames=[parseLammpsFrame(dump(9.9,0)),parseLammpsFrame(dump(10.1,0))];
 const replicated=await Promise.all(frames.map(frame=>replicateFrame(frame,[2,1,1])));
 const source=(await computeDisplacements(frames[1],frames[0])).vectors[0];
 const expanded=(await computeDisplacements(replicated[1],replicated[0])).vectors[0];
 assert.ok(Math.abs(source-.2)<1e-5);
 assert.ok(Math.abs(expanded-.2)<1e-5,`expected displacement +0.2; got ${expanded}`);
});
test('CFG boundary stabilization uses the same image as its wrapped coordinate',()=>{
 const header='Number of particles = 1\nA = 1 Angstrom\n'+Array.from({length:9},(_,i)=>`H0(${Math.floor(i/3)+1},${i%3+1}) = ${i%4===0?10:0}`).join('\n')+'\n';
 const frame=parseCfg(header+'55.845 Fe 1.999999 .2 .3\n');
 assert.ok(Math.abs(frame.unwrappedPositions[0]-20)<.0002,`expected x approximately20; got ${frame.unwrappedPositions[0]}`);
});
test('LAMMPS data masses addressed by atom type labels remain available',()=>{
 const data='title\n1 atoms\n1 atom types\n0 10 xlo xhi\n0 10 ylo yhi\n0 10 zlo zhi\n\nAtom Type Labels\n\n1 Fe\n\nMasses\n\nFe 55.845\n\nAtoms # atomic\n\n1 Fe 1 2 3\n';
 const frame=parseLammpsData(data);
 const mass=frame.properties.find(p=>p.name==='mass').data[0];
 assert.ok(Math.abs(mass-55.845)<.0001,`expected mass55.845; got ${mass}`);
});
test('a valid POSCAR with numeric title opens through format autodetection',()=>{
 const poscar='123\n1\n10 0 0\n0 10 0\n0 0 10\nFe\n1\nDirect\n0 0 0\n';
 assert.equal(parsePoscar(poscar).ids.length,1);
 assert.equal(detectStructureFormatHeader(poscar),'poscar');
});
