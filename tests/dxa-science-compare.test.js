import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDxaScience, dxaScienceHash, validateDxaScience } from '../scripts/lib/dxa-science-compare.mjs';

const identity=[1,0,0,0,1,0,0,0,1];
const cluster=id=>({id,structure:1,atomCount:id?2:0,orientation:identity,symmetryTransformation:0,centerOfMass:[0,0,0],parentTransition:null});
const segment=(id,points,extra={})=>({id,clusterId:1,structureType:1,points,
  length:points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(...p.map((x,a)=>x-points[i][a])),0),
  closed:false,isInfinite:false,burgersVector:[1,0,0],spatialBurgersVector:[1,0,0],junctions:[[],[]],...extra});
function fixture(){
  return {schemaVersion:1,phase:'finished',matrixLayout:'row-major',
    cell:{vectors:[10,0,0,0,10,0,0,0,10],origin:[0,0,0],pbc:[true,false,true]},
    result:{backend:'cpu-wasm',algorithm:'fixture',lattice:1,volume:1000,
      atomStructureTypes:[1,2],segments:[segment(5,[[0,0,0],[1,0,0],[2,0,0]])],totalLength:2},
    atomClusters:[1,1],clusters:[cluster(0),cluster(1)],transitions:[]};
}
function rewriteLength(data){data.result.totalLength=data.result.segments.reduce((s,line)=>{
  line.length=line.points.slice(1).reduce((n,p,i)=>n+Math.hypot(...p.map((x,a)=>x-line.points[i][a])),0);return s+line.length;
},0);}
const pass=result=>['exact','equivalent'].includes(result.status);

test('DXA science exact comparison ignores only named execution counters',()=>{
  const a=fixture(),b=structuredClone(a);b.result.parallelEdgePasses={pathSearchEdges:99};
  assert.equal(dxaScienceHash(a),dxaScienceHash(b));
  assert.equal(compareDxaScience(a,b,{mode:'exact',requireClusters:true}).status,'exact');
  b.result.extraScience=2;
  assert.equal(compareDxaScience(a,b).status,'inconclusive');
});

test('DXA science proves ID renumbering, periodic shifts and oriented reversal',()=>{
  const a=fixture(),b=structuredClone(a),line=b.result.segments[0];
  line.id=99;line.clusterId=4;line.points.reverse();line.points=line.points.map(p=>[p[0]+10,p[1],p[2]]);
  line.burgersVector=[-1,0,0];line.spatialBurgersVector=[-1,0,0];
  b.atomClusters=[4,4];b.clusters[1].id=4;
  assert.equal(compareDxaScience(a,b,{requireClusters:true}).status,'equivalent');
  assert.equal(compareDxaScience(a,b,{mode:'exact'}).status,'different');
  line.points=line.points.map(p=>[p[0],p[1]+10,p[2]]);
  assert.equal(compareDxaScience(a,b).status,'inconclusive','Nonperiodic translations are not representation changes.');
});

test('DXA science checks every atom, every line and every Burgers vector',()=>{
  const a=fixture();
  for(const mutate of [b=>b.result.atomStructureTypes.reverse(),b=>{b.result.segments=[];b.result.totalLength=0;},
    b=>b.result.segments[0].spatialBurgersVector[0]=2]){
    const b=structuredClone(a);mutate(b);assert.equal(compareDxaScience(a,b).status,'different');
  }
});

test('DXA science rejects intermediate excursions and changed winding despite matching endpoints or labels',()=>{
  const a=fixture(),b=structuredClone(a);
  b.result.segments[0].points[1][1]=1;rewriteLength(b);
  assert.equal(compareDxaScience(a,b).status,'inconclusive');
  const c=structuredClone(a);c.result.segments[0].points.at(-1)[0]+=10;rewriteLength(c);
  assert.equal(pass(compareDxaScience(a,c)),false);
});

test('DXA science compares all piecewise-linear knots instead of requiring identical sampling',()=>{
  const a=fixture(),b=structuredClone(a);b.result.segments[0].points=[[0,0,0],[.5,0,0],[2,0,0]];
  assert.equal(compareDxaScience(a,b).status,'equivalent');
  b.result.segments[0].points[1][1]=1e-5;rewriteLength(b);
  assert.equal(compareDxaScience(a,b).status,'inconclusive');
  assert.equal(compareDxaScience(a,b,{geometryTolerance:2e-5}).status,'equivalent');
});

test('DXA science preserves the full junction graph after segment renumbering',()=>{
  const a=fixture();
  a.result.segments=[segment(0,[[0,0,0],[1,0,0]]),segment(1,[[1,0,0],[2,0,0]]),segment(2,[[2,0,0],[3,0,0]])];
  a.result.segments[0].junctions[1]=[{segmentId:1,end:0}];a.result.segments[1].junctions[0]=[{segmentId:0,end:1}];
  rewriteLength(a);
  const b=structuredClone(a);b.result.segments[0].junctions[1]=[{segmentId:2,end:0}];
  b.result.segments[1].junctions[0]=[];b.result.segments[2].junctions[0]=[{segmentId:0,end:1}];
  assert.equal(validateDxaScience(b).valid,true,'The mutation remains a reciprocal graph.');
  assert.equal(compareDxaScience(a,b).status,'different','A different reciprocal graph is not equivalent.');
  const c=structuredClone(a);for(const line of c.result.segments){line.id+=10;for(const arms of line.junctions)for(const arm of arms)arm.segmentId+=10;}
  assert.equal(compareDxaScience(a,c).status,'equivalent');
});

test('DXA science detects incomplete junction rings and missing reciprocal arms',()=>{
  const a=fixture();a.result.segments=[segment(0,[[0,0,0],[1,0,0]]),segment(1,[[1,0,0],[2,0,0]])];rewriteLength(a);
  a.result.segments[0].junctions[1]=[{segmentId:1,end:0}];
  assert.equal(validateDxaScience(a).valid,false);
  assert.equal(compareDxaScience(a,a).status,'different','Equal malformed outputs do not pass the exact fast path.');
});

test('DXA science matches cyclic start changes only on isolated closed loops',()=>{
  const a=fixture(),line=segment(5,[[0,0,0],[1,0,0],[1,1,0],[0,0,0]],{closed:true,junctions:[[{segmentId:5,end:1}],[{segmentId:5,end:0}]]});
  a.result.segments=[line];rewriteLength(a);
  const b=structuredClone(a);b.result.segments[0].points=[[1,0,0],[1,1,0],[0,0,0],[1,0,0]];
  assert.equal(compareDxaScience(a,b,{geometryTolerance:1e-14}).status,'equivalent');
});

test('DXA science requires complete cluster member sets and transforms',()=>{
  const a=fixture(),b=structuredClone(a);b.atomClusters=[1,0];
  assert.equal(compareDxaScience(a,b,{requireClusters:true}).status,'different');
  const c=structuredClone(a);c.clusters[1].orientation[0]=2;
  assert.equal(compareDxaScience(a,c).status,'different');
  const d=structuredClone(a);delete d.atomClusters;delete d.clusters;delete d.transitions;
  assert.equal(compareDxaScience(d,d,{requireClusters:true}).status,'inconclusive');
});

test('DXA science compares the complete transition graph including parent paths',()=>{
  const a=fixture(),transition={source:0,target:1,distance:1,area:1,matrix:identity,self:false,reverseMatrix:identity,reverseDistance:1,reverseArea:1};
  const reverse={...transition,source:1,target:0};
  a.transitions=[transition,reverse];a.clusters[1].parentTransition=structuredClone(reverse);
  assert.equal(validateDxaScience(a).valid,true);
  const b=structuredClone(a);b.transitions[0].matrix[0]=2;
  assert.equal(compareDxaScience(a,b).status,'different');
  const c=structuredClone(a);c.clusters[1].parentTransition.distance=2;
  assert.equal(compareDxaScience(a,c).status,'different');
});

test('DXA science never promotes missing or differently triangulated meshes to full equivalence',()=>{
  const a=fixture();assert.equal(compareDxaScience(a,a,{requireDefectMesh:true}).status,'inconclusive');
  a.defectMesh={vertices:[0,0,0,1,0,0,0,1,0],triangles:[0,1,2]};
  a.result.defectMesh={vertexCount:3,triangleCount:1,surfaceArea:.5,goodCellCount:1,defectCellCount:1,smoothingLevel:0};
  const b=structuredClone(a);b.defectMesh.triangles=[0,2,1];
  assert.equal(compareDxaScience(a,b,{requireDefectMesh:true}).status,'inconclusive');
  b.defectMesh.triangles[0]=9;assert.equal(compareDxaScience(a,b).status,'different');
});

test('DXA science requires every native crystal field and reciprocal transition metadata',()=>{
  for(const key of ['structure','symmetryTransformation','parentTransition']){
    const b=fixture();delete b.clusters[1][key];
    assert.equal(compareDxaScience(b,b,{requireClusters:true}).status,'different');
  }
  const b=fixture();b.transitions=[{source:0,target:1,matrix:identity,reverseMatrix:identity}];
  assert.equal(compareDxaScience(b,b,{requireClusters:true}).status,'different');
  b.transitions=[{source:0,target:1,distance:1,area:0,self:false,matrix:identity,reverseMatrix:identity,reverseDistance:1,reverseArea:0}];
  assert.equal(compareDxaScience(b,b,{requireClusters:true}).status,'different');
});

test('DXA continuous tolerances never permit changed discrete crystal science',()=>{
  const a=fixture(),b=structuredClone(a);b.clusters[1].symmetryTransformation=1;
  assert.equal(compareDxaScience(a,b,{clusterTolerance:1}).status,'different');
  const c=structuredClone(a);c.clusters[1].structure=2;c.result.segments[0].structureType=2;
  assert.equal(compareDxaScience(a,c,{clusterTolerance:1}).status,'different');
});

test('DXA candidate reversal does not mutate reused line choices or accept incompatible duplicates',()=>{
  const a=fixture();a.result.segments=[segment(0,[[0,0,0],[1,0,0]]),segment(1,[[0,0,0],[1,0,0]])];rewriteLength(a);
  const b=structuredClone(a);for(const line of b.result.segments){line.burgersVector=[-1,0,0];line.spatialBurgersVector=[-1,0,0];}
  b.result.segments[0].points.reverse();
  assert.equal(compareDxaScience(a,b).status,'different');
  b.result.segments[1].points.reverse();
  assert.equal(compareDxaScience(a,b).status,'equivalent');
});

test('DXA science does not discard unknown segment or junction science',()=>{
  const a=fixture(),b=structuredClone(a);b.result.segments[0].extraScience='changed';
  assert.equal(compareDxaScience(a,b).status,'inconclusive');
  const loop=segment(5,[[0,0,0],[1,0,0],[0,0,0]],{closed:true,junctions:[[{segmentId:5,end:1}],[{segmentId:5,end:0}]]});
  a.result.segments=[loop];rewriteLength(a);
  const c=structuredClone(a);c.result.segments[0].junctions[0][0].extraScience='changed';
  assert.equal(compareDxaScience(a,c).status,'inconclusive');
  assert.throws(()=>compareDxaScience(a,c,{cell:a.cell}),/overrides/);
});

test('DXA science rejects invalid tolerance policies and invalid numeric outputs',()=>{
  const a=fixture();assert.throws(()=>compareDxaScience(a,a,{geometryTolerance:-1}),TypeError);
  const b=structuredClone(a);b.result.segments[0].points[0][0]=NaN;
  assert.equal(compareDxaScience(a,b).status,'different');
});

test('DXA science rejects partial coordinates, missing totals and truncated mesh readback before exact hashing',()=>{
  for(const mutate of [b=>delete b.result.totalLength,b=>b.result.totalLength=NaN,
    b=>b.result.segments[0].points=[0,0,0,1,0,0,NaN],
    b=>{b.result.defectMesh={vertexCount:3,triangleCount:1};b.defectMesh={vertices:[],triangles:[]};}]){
    const b=fixture();mutate(b);
    assert.equal(validateDxaScience(b).valid,false);
    assert.equal(compareDxaScience(b,b,{requireClusters:true}).status,'different');
  }
});

test('DXA science rejects derived polyline and total length overflow',()=>{
  const a=fixture();a.result.segments[0].points=[[1e308,0,0],[-1e308,0,0]];
  a.result.segments[0].length=a.result.totalLength=1e308;
  assert.equal(validateDxaScience(a).valid,false);
  const b=fixture();b.result.segments=[segment(0,[[0,0,0],[1e308,0,0]]),segment(1,[[0,0,0],[1e308,0,0]])];
  b.result.totalLength=1e308;
  assert.equal(validateDxaScience(b).valid,false);
});
