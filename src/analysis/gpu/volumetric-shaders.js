/** The same six tetrahedra as the CPU kernel, split around cube diagonal
 * 000→111. Signed scalar pairs decide topology; geometry is emitted in local
 * voxel coordinates so large Cartesian origins never enter f32 arithmetic. */
const COMMON = `
@group(0) @binding(0) var<storage, read> settings: array<u32>;
@group(0) @binding(1) var<storage, read> samples: array<vec4f>;
const TETS = array<vec4u, 6>(vec4u(0,1,3,7), vec4u(0,3,2,7), vec4u(0,2,6,7),
  vec4u(0,6,4,7), vec4u(0,4,5,7), vec4u(0,5,1,7));
struct Cell { distances: array<f32,8>, high: array<bool,8>, error: u32 }
struct Tet { points: array<vec3f,6>, count: u32, error: u32 }
fn point(corner: u32) -> vec3f { return vec3f(f32(corner & 1u), f32((corner >> 1u) & 1u), f32(corner >> 2u)); }
fn cellCoordinates(id: u32) -> vec3u {
  return vec3u(id % settings[3], (id / settings[3]) % settings[4], id / (settings[3] * settings[4]));
}
fn loadCell(id: u32) -> Cell {
  var cell: Cell;
  let base = cellCoordinates(id);
  let level = vec3f(bitcast<f32>(settings[10]), bitcast<f32>(settings[11]), bitcast<f32>(settings[12]));
  for (var corner=0u; corner<8u; corner++) {
    let p = base + vec3u(corner & 1u, (corner >> 1u) & 1u, corner >> 2u);
    let ix = p.x % settings[0]; let iy = p.y % settings[1]; let iz = p.z % settings[2];
    let sample = samples[ix + settings[0] * (iy + settings[1] * iz)];
    let delta = (sample.x-level.x) + (sample.y-level.y);
    cell.distances[corner] = delta;
    cell.high[corner] = sample.x > level.x || (sample.x == level.x && sample.y >= level.y);
    let uncertainty = sample.z + level.z;
    if (uncertainty > 0.0 && abs(delta) <= uncertainty * 4.0) { cell.error = 1u; }
    if (delta == 0.0 && (sample.x != level.x || sample.y != level.y)) { cell.error=1u; }
  }
  return cell;
}
fn crossing(first:u32, second:u32, cell:Cell) -> vec3f {
  // Every tetrahedron must interpolate a shared edge in the same direction.
  // Reversing it computes t versus 1-t with different f32 rounding and can
  // leave one-ulp cracks between otherwise identical faces.
  let start=min(first,second); let end=max(first,second);
  let a=cell.distances[start]; let b=cell.distances[end];
  let t=clamp(a/(a-b), 0.0, 1.0);
  return mix(point(start),point(end),t);
}
fn appendTriangle(input:Tet, first:vec3f, second:vec3f, third:vec3f, direction:vec3f) -> Tet {
  var result=input;
  let normal=cross(second-first,third-first);
  if (all(normal == vec3f(0.0))) { return result; }
  // Nearly collinear intersections cannot safely retain CPU topology in f32.
  let longest=max(dot(second-first,second-first), max(dot(third-first,third-first),dot(third-second,third-second)));
  if (dot(normal,normal) < longest*longest*1e-14) { result.error=1u; }
  let reverse=(dot(normal,direction)<0.0) != (settings[9]!=0u);
  result.points[result.count*3u]=first;
  result.points[result.count*3u+1u]=select(second,third,reverse);
  result.points[result.count*3u+2u]=select(third,second,reverse);
  result.count++;
  return result;
}
fn extractTet(tet:vec4u,cell:Cell) -> Tet {
  var high:array<u32,4>; var low:array<u32,4>; var nh=0u; var nl=0u;
  var direction=vec3f(0.0);
  for (var i=0u;i<4u;i++) {
    let vertex=tet[i];
    if (cell.high[vertex]) { high[nh]=vertex;nh++; } else { low[nl]=vertex;nl++; }
  }
  var result:Tet;
  if (nh==0u || nh==4u) { return result; }
  // A genuine intersection rounded onto an endpoint can erase a thin face.
  // Exact level equality is allowed; nonzero lost distances need CPU recovery.
  for(var i=0u;i<nh;i++) { for(var j=0u;j<nl;j++) {
    let a=cell.distances[high[i]]; let b=cell.distances[low[j]];
    let t=a/(a-b);
    if ((t<1e-7 && a!=0.0) || (t>1.0-1e-7 && b!=0.0)) { result.error=1u; }
  } }
  for(var i=0u;i<nl;i++) { direction+=point(low[i])/f32(nl); }
  for(var i=0u;i<nh;i++) { direction-=point(high[i])/f32(nh); }
  if(nh==1u) {
    return appendTriangle(result,crossing(high[0],low[0],cell),crossing(high[0],low[1],cell),crossing(high[0],low[2],cell),direction);
  }
  if(nh==3u) {
    return appendTriangle(result,crossing(low[0],high[0],cell),crossing(low[0],high[1],cell),crossing(low[0],high[2],cell),direction);
  }
  let a=crossing(high[0],low[0],cell); let b=crossing(high[0],low[1],cell);
  let c=crossing(high[1],low[0],cell); let d=crossing(high[1],low[1],cell);
  result=appendTriangle(result,a,b,c,direction);
  return appendTriangle(result,b,d,c,direction);
}
`;

export const VOLUMETRIC_COUNT_SHADER = `${COMMON}
@group(0) @binding(2) var<storage, read_write> counts: array<vec2u>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u) {
  if(gid.x>=settings[7]) { return; }
  let cell=loadCell(settings[6]+gid.x);
  var count=0u; var error=cell.error;
  for(var i=0u;i<6u;i++) { let tet=extractTet(TETS[i],cell);count+=tet.count;error|=tet.error; }
  counts[gid.x]=vec2u(count,error);
}`;

export const VOLUMETRIC_EMIT_SHADER = `${COMMON}
@group(0) @binding(2) var<storage, read> offsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> vertices: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u) {
  if(gid.x>=settings[7]) { return; }
  let id=settings[6]+gid.x;let cell=loadCell(id);
  var offset=offsets[gid.x]*3u;
  for(var i=0u;i<6u;i++) {
    let tet=extractTet(TETS[i],cell);
    // Grid limits keep IDs below 2^24; ordinary conversion is exact and avoids
    // bitcast integer IDs becoming subnormals flushed to zero by some GPUs.
    for(var j=0u;j<tet.count*3u;j++) { vertices[offset]=vec4f(tet.points[j],f32(id));offset++; }
  }
}`;
