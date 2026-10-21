import { createHash } from 'node:crypto';

// A conservative scientific comparator for development audits. No distance or
// arc-length allowance is inferred from observed candidate differences.
export function canonicalDxaScience(envelope) {
  const convert = value => {
    if (ArrayBuffer.isView(value)) return Array.from(value, convert);
    if (Array.isArray(value)) return value.map(convert);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, convert(value[key])]));
    return value;
  };
  const copy = convert(envelope?.result ? envelope : { result: envelope });
  delete copy.result.parallelEdgePasses; // Execution statistics, not science.
  return copy;
}
export function dxaScienceHash(envelope) {
  return createHash('sha256').update(JSON.stringify(canonicalDxaScience(envelope))).digest('hex');
}
const finite = values => Array.isArray(values) && values.every(Number.isFinite);
const vec = (value, size = 3) => finite(value) && value.length === size;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const close = (a, b, tolerance) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tolerance);
const nodeKey = (id, end) => `${id}:${end}`;
const flattenPoints = points => Array.isArray(points?.[0]) ? points : Array.from({ length: (points?.length ?? 0) / 3 }, (_, i) => Array.from(points.slice(3 * i, 3 * i + 3)));
const validPoints = points => Array.isArray(points) && (Array.isArray(points[0])
  ? points.length >= 2 && points.every(point => vec(point))
  : points.length >= 6 && points.length % 3 === 0 && points.every(Number.isFinite));
const length = points => points.slice(1).reduce((sum, point, i) => sum + Math.hypot(...point.map((x, axis) => x - points[i][axis])), 0);

export function validateDxaScience(input) {
  const envelope = canonicalDxaScience(input), raw = envelope.result;
  const errors = [], segments = raw?.segments, labels = raw?.atomStructureTypes;
  const checkFinite=(value,path)=>{
    if(typeof value==='number'&&!Number.isFinite(value))errors.push(`Nonfinite scientific value: ${path}.`);
    else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value))checkFinite(child,`${path}.${key}`);
  };
  checkFinite(envelope,'science');
  if (!Array.isArray(segments)) errors.push('Missing complete segment array.');
  if (!Array.isArray(labels) || labels.some(x => !Number.isInteger(x) || x < 0 || x > 5)) errors.push('Invalid or missing complete atom labels.');
  if (!Number.isFinite(raw?.totalLength) || raw.totalLength < 0) errors.push('Invalid or missing complete total length.');
  if (!Number.isFinite(raw?.volume) || raw.volume <= 0) errors.push('Invalid analyzed volume.');
  if (!Number.isInteger(raw?.lattice) || raw.lattice < 1 || raw.lattice > 5) errors.push('Invalid input lattice.');
  const ids = new Map();
  for (const segment of segments ?? []) {
    if (!Number.isSafeInteger(segment.id) || segment.id < 0 || ids.has(segment.id)) errors.push(`Invalid/duplicate segment ID ${segment.id}.`);
    ids.set(segment.id, segment);
    const points = validPoints(segment.points) ? flattenPoints(segment.points) : [];
    if (!points.length) errors.push(`Invalid complete coordinates on segment ${segment.id}.`);
    if (!vec(segment.burgersVector) || !vec(segment.spatialBurgersVector)) errors.push(`Invalid Burgers vector on segment ${segment.id}.`);
    if (!Number.isSafeInteger(segment.clusterId) || !Number.isInteger(segment.structureType)) errors.push(`Invalid crystal reference on segment ${segment.id}.`);
    if (typeof segment.closed !== 'boolean' || typeof segment.isInfinite !== 'boolean') errors.push(`Missing closure flags on segment ${segment.id}.`);
    if (!Number.isFinite(segment.length) || segment.length < 0) errors.push(`Invalid length on segment ${segment.id}.`);
    else if (points.length) {
      const measured = length(points), rounding = 256 * Number.EPSILON * Math.max(1, measured, segment.length) * points.length;
      if (!Number.isFinite(measured) || Math.abs(measured - segment.length) > rounding) errors.push(`Stored length disagrees with complete polyline on segment ${segment.id}.`);
    }
    if (!Array.isArray(segment.junctions) || segment.junctions.length !== 2 || segment.junctions.some(arms => !Array.isArray(arms))) errors.push(`Missing junction endpoints on segment ${segment.id}.`);
  }
  for (const segment of segments ?? []) for (let end = 0; end < 2; end++) {
    const arms = segment.junctions?.[end];
    if (!Array.isArray(arms)) continue;
    const observed = new Set();
    for (const arm of arms) {
      const key = nodeKey(arm.segmentId, arm.end), other = ids.get(arm.segmentId);
      if (!other || (arm.end !== 0 && arm.end !== 1) || key === nodeKey(segment.id, end) || observed.has(key)) {
        errors.push(`Invalid junction arm ${segment.id}:${end} -> ${key}.`); continue;
      }
      observed.add(key);
      const peers = other.junctions?.[arm.end];
      if (!Array.isArray(peers) || !peers.some(peer => peer.segmentId === segment.id && peer.end === end)) errors.push(`Nonreciprocal junction ${segment.id}:${end} -> ${key}.`);
      // Every node in the native junction ring lists every other node. Verify
      // the complete ring neighborhood, not only reciprocal pairwise edges.
      const a = [nodeKey(segment.id, end), ...arms.map(peer => nodeKey(peer.segmentId, peer.end))].sort();
      const b = [key, ...(peers ?? []).map(peer => nodeKey(peer.segmentId, peer.end))].sort();
      if (!equal(a, b)) errors.push(`Incomplete junction ring at ${segment.id}:${end}.`);
    }
  }
  if (Number.isFinite(raw?.totalLength) && Array.isArray(segments)) {
    const sum = segments.reduce((n, segment) => n + segment.length, 0);
    if (!Number.isFinite(sum) || Math.abs(sum - raw.totalLength) > 256 * Number.EPSILON * Math.max(1, sum) * Math.max(1, segments.length)) errors.push('Total length disagrees with all segment lengths.');
  }
  const clustersPresent = Array.isArray(envelope.atomClusters) && Array.isArray(envelope.clusters) && Array.isArray(envelope.transitions);
  if (clustersPresent) {
    if(envelope.schemaVersion!==1||!['mapped','finished'].includes(envelope.phase)||envelope.matrixLayout!=='row-major')errors.push('Unsupported or incomplete native crystal snapshot schema.');
    const clusterIds = new Set(envelope.clusters.map(cluster => cluster.id));
    if (clusterIds.size !== envelope.clusters.length || envelope.atomClusters.length !== labels?.length
        || envelope.atomClusters.some(id => !Number.isSafeInteger(id) || !clusterIds.has(id))) errors.push('Invalid per-atom crystal membership.');
    const members=new Map();for(const id of envelope.atomClusters)members.set(id,(members.get(id)??0)+1);
    const transitionValid=transition=>transition&&typeof transition==='object'
      &&clusterIds.has(transition.source)&&clusterIds.has(transition.target)
      &&['source','target','distance','area','reverseDistance','reverseArea'].every(key=>Number.isSafeInteger(transition[key])&&transition[key]>=0)
      &&typeof transition.self==='boolean'&&vec(transition.matrix,9)&&vec(transition.reverseMatrix,9)
      &&(!transition.self||(transition.source===transition.target&&transition.distance===0&&transition.reverseDistance===0
        &&equal(transition.matrix,[1,0,0,0,1,0,0,0,1])&&equal(transition.matrix,transition.reverseMatrix)));
    const transitionKey=transition=>JSON.stringify(['source','target','distance','area','self','matrix','reverseMatrix','reverseDistance','reverseArea'].map(key=>transition[key]));
    const transitionCounts=new Map();
    for(const transition of envelope.transitions){
      if(!transitionValid(transition)){errors.push('Invalid complete crystal transition.');continue;}
      const key=transitionKey(transition);transitionCounts.set(key,(transitionCounts.get(key)??0)+1);
    }
    for(const transition of envelope.transitions)if(transitionValid(transition)){
      const reverse={...transition,source:transition.target,target:transition.source,distance:transition.reverseDistance,
        area:transition.reverseArea,matrix:transition.reverseMatrix,reverseMatrix:transition.matrix,
        reverseDistance:transition.distance,reverseArea:transition.area};
      if(transitionCounts.get(transitionKey(transition))!==transitionCounts.get(transitionKey(reverse)))errors.push('Nonreciprocal complete crystal transition graph.');
    }
    for (const cluster of envelope.clusters) {
      if (!Number.isSafeInteger(cluster.id)||cluster.id<0||!Number.isInteger(cluster.structure)||cluster.structure<0||cluster.structure>5
        ||!Number.isSafeInteger(cluster.symmetryTransformation)||cluster.symmetryTransformation<0||!vec(cluster.orientation, 9)
        || !vec(cluster.centerOfMass) || !Number.isSafeInteger(cluster.atomCount) || cluster.atomCount < 0
        ||(cluster.id!==0&&cluster.atomCount!==(members.get(cluster.id)??0))) errors.push(`Invalid cluster ${cluster.id}.`);
      if(cluster.parentTransition!==null&&(!transitionValid(cluster.parentTransition)||cluster.parentTransition.source!==cluster.id
        ||!transitionCounts.has(transitionKey(cluster.parentTransition))))errors.push(`Invalid or incomplete parent transition for cluster ${cluster.id}.`);
    }
    for (const segment of segments ?? []) {
      const cluster=envelope.clusters.find(cluster=>cluster.id===segment.clusterId);
      if(!cluster||cluster.structure!==segment.structureType)errors.push(`Unknown or inconsistent segment cluster ${segment.clusterId}.`);
    }
  }
  const mesh = envelope.defectMesh;
  if (mesh) {
    if (!finite(mesh.vertices) || mesh.vertices.length % 3 || !Array.isArray(mesh.triangles) || mesh.triangles.length % 3
        || mesh.triangles.some(index => !Number.isSafeInteger(index) || index < 0 || index >= mesh.vertices.length / 3)) errors.push('Invalid complete defect mesh buffers.');
    if (!raw.defectMesh || raw.defectMesh.vertexCount !== mesh.vertices?.length / 3
        || raw.defectMesh.triangleCount !== mesh.triangles?.length / 3 || raw.defectMesh.error) errors.push('Defect mesh buffers disagree with native metadata or report extraction failure.');
    if(!raw.defectMesh||!Number.isFinite(raw.defectMesh.surfaceArea)||raw.defectMesh.surfaceArea<0
      ||!['smoothingLevel','goodCellCount','defectCellCount','vertexCount','triangleCount'].every(key=>Number.isSafeInteger(raw.defectMesh[key])&&raw.defectMesh[key]>=0))errors.push('Incomplete native defect mesh metadata.');
  }
  return { valid: errors.length === 0, errors, coverage: { atomLabels: Array.isArray(labels), completeNetwork: Array.isArray(segments),
    crystalMembershipAndTransforms: clustersPresent, defectMesh: Boolean(mesh) } };
}

function inverseCell(vectors) {
  if (!vec(vectors, 9)) return null;
  const [a,b,c,d,e,f,g,h,i] = vectors;
  const det = a*(e*i-f*h)-d*(b*i-c*h)+g*(b*f-c*e);
  if (!Number.isFinite(det) || det === 0) return null;
  return [(e*i-f*h)/det,(g*f-d*i)/det,(d*h-g*e)/det,
    (h*c-b*i)/det,(a*i-g*c)/det,(g*b-a*h)/det,
    (b*f-e*c)/det,(d*c-a*f)/det,(a*e-d*b)/det];
}
function equivalentShift(reference, candidate, cell, tolerance) {
  const delta = reference.map((x, axis) => x - candidate[axis]);
  if (!cell) return delta.every(x => Math.abs(x) <= tolerance) ? [0,0,0] : null;
  const inverse = inverseCell(cell.vectors);
  if (!inverse || !Array.isArray(cell.pbc) || cell.pbc.length !== 3) return null;
  const fractional = [0,1,2].map(row => inverse.slice(row*3,row*3+3).reduce((sum,x,axis) => sum+x*delta[axis],0));
  const image = fractional.map((x,axis) => cell.pbc[axis] ? Math.round(x) : 0);
  const shift = [0,1,2].map(axis => image.reduce((sum,x,column) => sum+x*cell.vectors[3*column+axis],0));
  return close(delta, shift, tolerance) ? shift : null;
}
function arc(points) {
  const cumulative = [0];
  for (let i=1;i<points.length;i++) cumulative.push(cumulative.at(-1)+Math.hypot(...points[i].map((x,axis)=>x-points[i-1][axis])));
  const total = cumulative.at(-1);
  return { points, total, knots: cumulative.map(x => total ? x/total : 0) };
}
function interpolate(polyline, t, cursor) {
  while (cursor.index+1 < polyline.knots.length-1 && polyline.knots[cursor.index+1] <= t) cursor.index++;
  const i=cursor.index, next=Math.min(i+1,polyline.points.length-1), width=polyline.knots[next]-polyline.knots[i];
  const u=width ? (t-polyline.knots[i])/width : 0;
  return polyline.points[i].map((x,axis) => x+u*(polyline.points[next][axis]-x));
}
function lineGeometry(reference, candidate, cell, tolerance) {
  const shift=equivalentShift(reference[0],candidate[0],cell,tolerance);
  if (!shift) return null;
  const a=arc(reference), b=arc(candidate.map(point=>point.map((x,axis)=>x+shift[axis])));
  // Both complete piecewise-linear functions are checked at every knot. A
  // chord, extra excursion, or omitted part cannot hide behind endpoint tests.
  if (Math.abs(a.total-b.total)>tolerance) return null;
  const knots=[...new Set([...a.knots,...b.knots])].sort((x,y)=>x-y), ac={index:0},bc={index:0};
  let maximumDistance=0;
  for (const t of knots) {
    const pa=interpolate(a,t,ac),pb=interpolate(b,t,bc);
    const distance=Math.hypot(...pa.map((x,axis)=>x-pb[axis]));
    maximumDistance=Math.max(maximumDistance,distance);
    if(distance>tolerance)return null;
  }
  return { maximumDistance, shift };
}
function clusterComparison(a,b,tolerance) {
  const present=Array.isArray(a.atomClusters)&&Array.isArray(b.atomClusters)&&Array.isArray(a.clusters)&&Array.isArray(b.clusters)
    &&Array.isArray(a.transitions)&&Array.isArray(b.transitions);
  if(!present)return {available:false,map:null};
  if(a.atomClusters.length!==b.atomClusters.length)return {available:true,error:'Atom cluster membership length changed.'};
  const map=new Map(),reverse=new Map();
  for(let i=0;i<a.atomClusters.length;i++){
    const old=a.atomClusters[i],next=b.atomClusters[i];
    if((map.has(old)&&map.get(old)!==next)||(reverse.has(next)&&reverse.get(next)!==old))return {available:true,error:'Crystal member sets changed.'};
    map.set(old,next);reverse.set(next,old);
  }
  for(const cluster of a.clusters)if(!map.has(cluster.id)){
    // Empty clusters have no member-set key. Never guess a correspondence.
    const other=b.clusters.find(row=>row.id===cluster.id);
    if(!other||reverse.has(other.id))return {available:true,error:'Empty crystal correspondence is unsupported.',inconclusive:true};
    map.set(cluster.id,other.id);reverse.set(other.id,cluster.id);
  }
  if(a.clusters.length!==b.clusters.length)return {available:true,error:'Complete crystal count changed.'};
  const continuousFields=new Set(['orientation','centerOfMass','matrix','reverseMatrix']);
  const numericEqual=(left,right,continuous=false)=>{
    if(typeof left==='number'&&typeof right==='number')return continuous?Math.abs(left-right)<=tolerance:left===right;
    if(Array.isArray(left)&&Array.isArray(right))return left.length===right.length&&left.every((x,i)=>numericEqual(x,right[i],continuous));
    if(left&&right&&typeof left==='object'&&typeof right==='object')return equal(Object.keys(left).sort(),Object.keys(right).sort())&&Object.keys(left).every(key=>numericEqual(left[key],right[key],continuousFields.has(key)));
    return left===right;
  };
  const transition=t=>t===null?null:{...t,source:map.get(t.source),target:map.get(t.target)};
  for(const cluster of a.clusters){
    const other=b.clusters.find(row=>row.id===map.get(cluster.id));
    if(!other||!numericEqual({...cluster,id:other.id,parentTransition:transition(cluster.parentTransition)},other))return {available:true,error:'Crystal orientation, symmetry or metadata changed.'};
  }
  const left=a.transitions.map(transition), used=new Set();
  for(const old of left){
    const index=b.transitions.findIndex((next,index)=>!used.has(index)&&numericEqual(old,next));
    if(index<0)return {available:true,error:'Complete crystal transition graph changed.'};used.add(index);
  }
  if(used.size!==b.transitions.length)return {available:true,error:'Complete crystal transition count changed.'};
  return {available:true,map};
}

export function compareDxaScience(reference,candidate,options={}) {
  const {mode='semantic',geometryTolerance=0,burgersTolerance=0,clusterTolerance=0,requireClusters=false,requireDefectMesh=false,maxMatchStates=10000}=options;
  if(!['exact','semantic'].includes(mode)||![geometryTolerance,burgersTolerance,clusterTolerance].every(x=>Number.isFinite(x)&&x>=0)
      ||!Number.isSafeInteger(maxMatchStates)||maxMatchStates<1)throw new TypeError('Invalid DXA comparison policy.');
  if(Object.hasOwn(options,'cell'))throw new TypeError('Provide the analyzed cell in each scientific envelope; policy overrides are not permitted.');
  const a=canonicalDxaScience(reference),b=canonicalDxaScience(candidate),av=validateDxaScience(a),bv=validateDxaScience(b);
  const coverage={atomLabels:av.coverage.atomLabels&&bv.coverage.atomLabels,completeNetwork:av.coverage.completeNetwork&&bv.coverage.completeNetwork,
    crystalMembershipAndTransforms:av.coverage.crystalMembershipAndTransforms&&bv.coverage.crystalMembershipAndTransforms,
    defectMesh:av.coverage.defectMesh&&bv.coverage.defectMesh};
  const result=(status,reasons=[],extra={})=>({status,reasons,coverage,policy:{mode,geometryTolerance,burgersTolerance,clusterTolerance},...extra});
  if(!av.valid||!bv.valid)return result('different',[...av.errors.map(x=>`Reference: ${x}`),...bv.errors.map(x=>`Candidate: ${x}`)]);
  const missing=[];
  if(requireClusters&&!coverage.crystalMembershipAndTransforms)missing.push('Complete native crystal membership/transforms are unavailable.');
  if(requireDefectMesh&&!coverage.defectMesh)missing.push('Complete defect mesh buffers are unavailable.');
  const ah=dxaScienceHash(a),bh=dxaScienceHash(b);
  if(ah===bh)return result(missing.length?'inconclusive':'exact',missing,{referenceSha256:ah,candidateSha256:bh});
  if(mode==='exact'&&missing.length&&equal(a.result,b.result))return result('inconclusive',missing,{referenceSha256:ah,candidateSha256:bh});
  if(mode==='exact')return result('different',['Complete scientific output differs.'],{referenceSha256:ah,candidateSha256:bh});
  if(!equal(a.result.atomStructureTypes,b.result.atomStructureTypes))return result('different',['Per-atom structure labels changed.']);
  if(a.result.segments.length!==b.result.segments.length)return result('different',['Segment count changed; unmatched lines are not permitted.']);
  for(const key of ['lattice','volume'])if(a.result[key]!==b.result[key])return result('different',[`${key} changed.`]);
  if(!equal(a.cell??null,b.cell??null))return result('different',['Analyzed cell or periodicity changed.']);
  const clusters=clusterComparison(a,b,clusterTolerance);
  if(clusters.error)return result(clusters.inconclusive?'inconclusive':'different',[clusters.error]);
  const cell=a.cell, candidates=[], geometryUnknown=[];
  for(const old of a.result.segments){
    const choices=[];let scalarCompatible=false;
    for(const next of b.result.segments)for(const reversed of [false,true]){
      if(old.structureType!==next.structureType||old.closed!==next.closed||old.isInfinite!==next.isInfinite
          ||(clusters.map?.get(old.clusterId)??old.clusterId)!==next.clusterId)continue;
      const sign=reversed?-1:1;
      if(!close(old.burgersVector,next.burgersVector.map(x=>x*sign),burgersTolerance)
          ||!close(old.spatialBurgersVector,next.spatialBurgersVector.map(x=>x*sign),burgersTolerance))continue;
      scalarCompatible=true;
      const first=flattenPoints(old.points),second=reversed?flattenPoints(next.points).toReversed():flattenPoints(next.points);
      let geometry=lineGeometry(first,second,cell,geometryTolerance);
      // A self-contained closed loop may start at another existing vertex;
      // junction-bearing lines cannot move their physical endpoints this way.
      const isolatedLoop=old.closed&&next.closed&&old.junctions.every((arms,end)=>arms.length===1&&arms[0].segmentId===old.id&&arms[0].end===1-end)
        &&next.junctions.every((arms,end)=>arms.length===1&&arms[0].segmentId===next.id&&arms[0].end===1-end);
      if(!geometry&&isolatedLoop&&close(second[0],second.at(-1),geometryTolerance)){
        const ring=second.slice(0,-1);
        for(let start=1;start<ring.length&&!geometry;start++){
          const rotated=[...ring.slice(start),...ring.slice(0,start),ring[start]];
          geometry=lineGeometry(first,rotated,cell,geometryTolerance);
        }
      }
      if(geometry)choices.push({id:next.id,reversed,...geometry});
    }
    if(!choices.length){
      if(!scalarCompatible)return result('different',[`No complete Burgers/closure/crystal match for segment ${old.id}.`]);
      geometryUnknown.push(old.id);
    }
    candidates.push({old,choices});
  }
  if(geometryUnknown.length)return result('inconclusive',[`Full polyline geometry differs beyond the declared tolerance for segments ${geometryUnknown.join(',')}; known PDEL variation is not automatically accepted.`]);
  candidates.sort((x,y)=>x.choices.length-y.choices.length);
  const mapping=new Map(),used=new Set(),byId=new Map(b.result.segments.map(segment=>[segment.id,segment]));
  let states=0,solution=null,exhausted=false;
  const graphMatches=()=>a.result.segments.every(segment=>{
    const choice=mapping.get(segment.id),next=byId.get(choice.id);
    return [0,1].every(end=>{
      const oldArms=segment.junctions[end].map(arm=>{
        const target=mapping.get(arm.segmentId);return nodeKey(target.id,target.reversed?1-arm.end:arm.end);
      }).sort();
      const newArms=next.junctions[choice.reversed?1-end:end].map(arm=>nodeKey(arm.segmentId,arm.end)).sort();
      return equal(oldArms,newArms);
    });
  });
  const search=index=>{
    if(++states>maxMatchStates){exhausted=true;return false;}
    if(index===candidates.length){if(!graphMatches())return false;solution=new Map(mapping);return true;}
    const {old,choices}=candidates[index];
    for(const choice of choices)if(!used.has(choice.id)){
      mapping.set(old.id,choice);used.add(choice.id);
      if(search(index+1))return true;
      mapping.delete(old.id);used.delete(choice.id);
      if(exhausted)return false;
    }
    return false;
  };
  search(0);
  if(!solution)return result(exhausted?'inconclusive':'different',[exhausted?'Bounded complete-network matching budget exhausted.':'Complete junction connectivity changed.']);
  const segmentKeys=new Set(['id','clusterId','structureType','length','closed','isInfinite','burgersVector','spatialBurgersVector','points','junctions']);
  for(const old of a.result.segments){
    const match=solution.get(old.id),next=byId.get(match.id);
    for(const key of new Set([...Object.keys(old),...Object.keys(next)]))
      if(!segmentKeys.has(key)&&!equal(old[key],next[key]))missing.push(`Unsupported segment field differs: ${old.id}.${key}.`);
    for(let end=0;end<2;end++)for(const arm of old.junctions[end]){
      const target=solution.get(arm.segmentId),other=next.junctions[match.reversed?1-end:end]
        .find(value=>value.segmentId===target.id&&value.end===(target.reversed?1-arm.end:arm.end));
      for(const key of new Set([...Object.keys(arm),...Object.keys(other)]))
        if(!['segmentId','end'].includes(key)&&!equal(arm[key],other[key]))missing.push(`Unsupported junction-arm field differs: ${old.id}:${end}.${key}.`);
    }
  }
  if(coverage.defectMesh&&!equal(a.defectMesh,b.defectMesh))missing.push('Defect mesh buffers differ; semantic remeshing equivalence is not established.');
  // Catch any new scientific field that this comparator does not yet know.
  const known=new Set(['segments','atomStructureTypes','totalLength','defectMesh','backend','algorithm','lattice','volume']);
  for(const key of new Set([...Object.keys(a.result),...Object.keys(b.result)]))
    if(!known.has(key)&&!equal(a.result[key],b.result[key]))missing.push(`Unsupported scientific field differs: ${key}.`);
  for(const key of ['backend','algorithm','defectMesh'])if(!equal(a.result[key],b.result[key]))missing.push(`Scientific metadata differs: ${key}.`);
  const envelopeKeys=new Set(['result','cell','atomClusters','clusters','transitions','defectMesh']);
  for(const key of new Set([...Object.keys(a),...Object.keys(b)]))
    if(!envelopeKeys.has(key)&&!equal(a[key],b[key]))missing.push(`Scientific envelope metadata differs: ${key}.`);
  return result(missing.length?'inconclusive':'equivalent',missing,{matchedSegments:solution.size,matchStates:states,
    maximumGeometryDistance:Math.max(0,...Array.from(solution.values(),x=>x.maximumDistance))});
}
