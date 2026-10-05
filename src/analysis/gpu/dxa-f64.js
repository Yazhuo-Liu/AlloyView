/** Exact binary64 square root and division used by DXA's local lattice fit.
 * Append these functions to CSP_F64_WGSL. WGSL integer limbs make every
 * threshold operation round just like the CPU, even without shader f64.
 */
export const DXA_F64_WGSL = /* wgsl */`
fn dxaF64Top(significand: vec2u) -> u32 {
  if (significand.y != 0u) { return 63u - countLeadingZeros(significand.y); }
  return 31u - countLeadingZeros(significand.x);
}
// Two bits of a significand shifted into a conceptual 106-bit radicand.
fn dxaF64RadicandPair(significand: vec2u, offset: i32) -> u32 {
  if (offset >= 0) { return f64WordsRight(significand, u32(offset)).x & 3u; }
  if (offset == -1) { return (significand.x & 1u) << 1u; }
  return 0u;
}
fn f64Sqrt(value: vec2u) -> vec2u {
  let rawExponent = (value.y >> 20u) & 2047u;
  if (f64IsNan(value)) { return vec2u(value.x, value.y | 524288u); }
  if (f64IsZero(value)) { return value; }
  if ((value.y & 2147483648u) != 0u) { return vec2u(0u, 2146959360u); }
  if (rawExponent == 2047u) { return value; }
  let significand = f64Significand(value);
  let top = dxaF64Top(significand);
  let valueExponent = i32(max(rawExponent, 1u)) - 1075 + i32(top);
  // Arithmetic shift is floor division, also for a negative odd exponent.
  var rootExponent = valueExponent >> 1;
  let shift = 104 - i32(top) + (valueExponent - 2 * rootExponent);
  var root = vec2u(0u);
  var remainder = vec2u(0u);
  // Restoring radix-4 extraction gives the exact 53-bit integer square root.
  for (var pair = 52; pair >= 0; pair -= 1) {
    remainder = f64WordsLeft(remainder, 2u);
    remainder.x |= dxaF64RadicandPair(significand, 2 * pair - shift);
    let trial = f64WordsLeft(root, 2u) | vec2u(1u, 0u);
    root = f64WordsLeft(root, 1u);
    if (!f64WordsLess(remainder, trial)) {
      remainder = f64WordsSubtract(remainder, trial);
      root.x |= 1u;
    }
  }
  // R - root^2 > root is exactly sqrt(R) > root + 1/2. An integer R
  // cannot hit the half-way point because its square ends in a quarter.
  if (f64WordsLess(root, remainder)) { root = f64WordsAdd(root, vec2u(1u, 0u)); }
  if (root.y >= 2097152u) { root = f64WordsRight(root, 1u); rootExponent += 1; }
  // Every positive binary64 square root, including sqrt(minSubnormal), is normal.
  return vec2u(root.x, (u32(rootExponent + 1023) << 20u) | (root.y & 1048575u));
}
fn f64Divide(a: vec2u, b: vec2u) -> vec2u {
  let sign = (a.y ^ b.y) & 2147483648u;
  let exponentA = (a.y >> 20u) & 2047u;
  let exponentB = (b.y >> 20u) & 2047u;
  let zeroA = f64IsZero(a); let zeroB = f64IsZero(b);
  if (f64IsNan(a) || f64IsNan(b)
      || (exponentA == 2047u && exponentB == 2047u) || (zeroA && zeroB)) {
    return vec2u(0u, 2146959360u);
  }
  if (exponentA == 2047u || zeroB) { return vec2u(0u, sign | 2146435072u); }
  if (exponentB == 2047u || zeroA) { return vec2u(0u, sign); }
  let significandA = f64Significand(a); let significandB = f64Significand(b);
  let topA = dxaF64Top(significandA); let topB = dxaF64Top(significandB);
  var numerator = f64WordsLeft(significandA, 52u - topA);
  let denominator = f64WordsLeft(significandB, 52u - topB);
  var exponent = i32(max(exponentA, 1u)) - i32(max(exponentB, 1u))
    + i32(topA) - i32(topB) + 1023;
  if (f64WordsLess(numerator, denominator)) {
    numerator = f64WordsLeft(numerator, 1u); exponent -= 1;
  }
  var remainder = f64WordsSubtract(numerator, denominator);
  var quotient = vec2u(1u, 0u);
  // 53 significand bits plus the three guard/round/sticky bits used by pack.
  for (var digit = 0u; digit < 55u; digit += 1u) {
    quotient = f64WordsLeft(quotient, 1u);
    remainder = f64WordsLeft(remainder, 1u);
    if (!f64WordsLess(remainder, denominator)) {
      remainder = f64WordsSubtract(remainder, denominator); quotient.x |= 1u;
    }
  }
  quotient.x |= select(0u, 1u, any(remainder != vec2u(0u)));
  return f64Pack(quotient, exponent, sign);
}
`;
