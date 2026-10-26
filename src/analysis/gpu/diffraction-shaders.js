/** Each workgroup reduces 512 atoms for one reflection. Coarse fractional
 * coordinates are multiples of 2^-12; their integer hkl dot products are exact
 * for |h|,|k|,|l| <= 1024. The residual is added only after quadrant reduction.
 * Trigonometric polynomials avoid implementation-dependent native sin/cos error. */
export const DIFFRACTION_STRUCTURE_FACTORS_SHADER = `
@group(0) @binding(0) var<storage, read> settings: array<u32>;
@group(0) @binding(1) var<storage, read> atoms: array<vec4f>;
@group(0) @binding(2) var<storage, read> residuals: array<vec4f>;
@group(0) @binding(3) var<storage, read> thermal: array<vec4f>;
@group(0) @binding(4) var<storage, read> reflections: array<vec4f>;
@group(0) @binding(5) var<storage, read> factors: array<f32>;
@group(0) @binding(6) var<storage, read_write> partials: array<vec4f>;
var<workgroup> sums: array<vec4f, 128>;

fn phasePair(h: vec3f, high: vec3f, low: vec3f) -> vec2f {
  let coarse = dot(h, high);
  let fine = dot(h, low);
  let quarter = round(coarse * 4.0);
  var turn = (coarse - quarter * 0.25) + fine;
  var quadrant = i32(quarter);
  let adjustment = round(turn * 4.0);
  turn -= adjustment * 0.25;
  quadrant += i32(adjustment);
  let x = turn * 6.2831853071795864769;
  let x2 = x*x;
  let sn = x + x*x2*(-0.1666666666666666667 + x2*(0.0083333333333333333 +
    x2*(-0.0001984126984126984 + x2*(0.0000027557319223986 + x2*(-0.0000000250521083854)))));
  let cs = 1.0 + x2*(-0.5 + x2*(0.0416666666666666667 + x2*(-0.0013888888888888889 +
    x2*(0.0000248015873015873 + x2*(-0.0000002755731922399 + x2*0.0000000020876756988)))));
  let q = ((quadrant % 4) + 4) % 4;
  if (q == 0) { return vec2f(cs,sn); }
  if (q == 1) { return vec2f(-sn,cs); }
  if (q == 2) { return vec2f(-cs,-sn); }
  return vec2f(sn,-cs);
}

@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let reflection = group.x / settings[3];
  let chunk = group.x % settings[3];
  var sum = vec4f(0.0);
  if (reflection < settings[2]) {
    let h = reflections[reflection*3u].xyz;
    let q0 = reflections[reflection*3u+1u];
    let q1 = reflections[reflection*3u+2u];
    for (var offset=0u; offset<512u; offset+=128u) {
      let atom=chunk*512u+lane+offset;
      if (atom < settings[0]) {
        let high=atoms[atom]; let low=residuals[atom];
        var weight=high.w*factors[reflection*settings[1]+u32(low.w)];
        if (settings[4] != 0u) {
          let u0=thermal[atom*2u]; let u1=thermal[atom*2u+1u];
          let q=dot(q0,u0)+dot(q1.xy,u1.xy);
          weight *= exp(-19.739208802178716 * max(0.0,q));
        }
        let phase=phasePair(h,high.xyz,low.xyz);
        sum += vec4f(weight*phase,abs(weight),0.0);
      }
    }
  }
  sums[lane]=sum;
  workgroupBarrier();
  for(var stride=64u;stride>0u;stride>>=1u) {
    if(lane<stride) { sums[lane]+=sums[lane+stride]; }
    workgroupBarrier();
  }
  if(lane==0u && reflection<settings[2]) { partials[group.x]=sums[0]; }
}
`;
