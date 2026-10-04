/** IEEE binary64 arithmetic for the order-sensitive greedy CSP definition.
 * WGSL has no portable f64 type. Integer limbs retain CPU round-to-nearest-even
 * distance and pair-cost comparisons, including subnormals and signed zero.
 * Values use vec2u(low word, high word); ordinary CSP output is still Float32.
 */
export const CSP_F64_WGSL = /* wgsl */`
fn f64WordsAdd(a: vec2u, b: vec2u) -> vec2u {
  let lo = a.x + b.x;
  return vec2u(lo, a.y + b.y + select(0u, 1u, lo < a.x));
}
fn f64WordsSubtract(a: vec2u, b: vec2u) -> vec2u {
  return vec2u(a.x - b.x, a.y - b.y - select(0u, 1u, a.x < b.x));
}
fn f64WordsLeft(a: vec2u, shift: u32) -> vec2u {
  if (shift == 0u) { return a; }
  if (shift < 32u) { return vec2u(a.x << shift, (a.y << shift) | (a.x >> (32u - shift))); }
  if (shift < 64u) { return vec2u(0u, a.x << (shift - 32u)); }
  return vec2u(0u);
}
fn f64WordsRight(a: vec2u, shift: u32) -> vec2u {
  if (shift == 0u) { return a; }
  if (shift < 32u) { return vec2u((a.x >> shift) | (a.y << (32u - shift)), a.y >> shift); }
  if (shift < 64u) { return vec2u(a.y >> (shift - 32u), 0u); }
  return vec2u(0u);
}
fn f64WordsRightJam(a: vec2u, shift: u32) -> vec2u {
  if (shift == 0u) { return a; }
  let shifted = f64WordsRight(a, shift);
  let discarded = f64WordsLeft(shifted, shift);
  return vec2u(shifted.x | select(0u, 1u, any(discarded != a)), shifted.y);
}
fn f64WordsLess(a: vec2u, b: vec2u) -> bool {
  return a.y < b.y || (a.y == b.y && a.x < b.x);
}
fn f64Significand(value: vec2u) -> vec2u {
  let exponent = (value.y >> 20u) & 2047u;
  return vec2u(value.x, (value.y & 1048575u) | select(0u, 1048576u, exponent != 0u));
}
fn f64IsZero(value: vec2u) -> bool {
  return value.x == 0u && (value.y & 2147483647u) == 0u;
}
fn f64IsNan(value: vec2u) -> bool {
  return (value.y & 2147483647u) > 2146435072u
    || ((value.y & 2147483647u) == 2146435072u && value.x != 0u);
}
fn f64Equal(a: vec2u, b: vec2u) -> bool {
  return !f64IsNan(a) && !f64IsNan(b)
    && (all(a == b) || (f64IsZero(a) && f64IsZero(b)));
}
fn f64Less(a: vec2u, b: vec2u) -> bool {
  if (f64IsNan(a) || f64IsNan(b) || (f64IsZero(a) && f64IsZero(b))) { return false; }
  let negativeA = (a.y & 2147483648u) != 0u;
  let negativeB = (b.y & 2147483648u) != 0u;
  if (negativeA != negativeB) { return negativeA; }
  if (negativeA) { return f64WordsLess(b, a); }
  return f64WordsLess(a, b);
}
// Round an extended significand with three guard/round/sticky bits.
fn f64Pack(extended: vec2u, initialExponent: i32, sign: u32) -> vec2u {
  var significand = extended;
  var exponent = initialExponent;
  if (all(significand == vec2u(0u))) { return vec2u(0u, sign); }
  if ((significand.y & 16777216u) != 0u) {
    significand = f64WordsRightJam(significand, 1u);
    exponent += 1;
  }
  loop {
    if (significand.y >= 8388608u || exponent <= 1) { break; }
    significand = f64WordsLeft(significand, 1u);
    exponent -= 1;
  }
  if (exponent < 1) {
    significand = f64WordsRightJam(significand, u32(1 - exponent));
    exponent = 1;
  }
  let remainder = significand.x & 7u;
  significand = f64WordsRight(significand, 3u);
  if (remainder > 4u || (remainder == 4u && (significand.x & 1u) != 0u)) {
    significand = f64WordsAdd(significand, vec2u(1u, 0u));
  }
  if ((significand.y & 2097152u) != 0u) {
    significand = f64WordsRight(significand, 1u);
    exponent += 1;
  }
  if (exponent >= 2047) { return vec2u(0u, sign | 2146435072u); }
  let encodedExponent = select(0u, u32(exponent), significand.y >= 1048576u);
  return vec2u(significand.x, sign | (encodedExponent << 20u) | (significand.y & 1048575u));
}
fn f64Add(a: vec2u, b: vec2u) -> vec2u {
  let exponentA = (a.y >> 20u) & 2047u;
  let exponentB = (b.y >> 20u) & 2047u;
  if (exponentA == 2047u || exponentB == 2047u) {
    if (f64IsNan(a) || f64IsNan(b)
      || (exponentA == 2047u && exponentB == 2047u && (a.y ^ b.y) >= 2147483648u)) {
      return vec2u(0u, 2146959360u);
    }
    return select(b, a, exponentA == 2047u);
  }
  var larger = a;
  var smaller = b;
  if (f64WordsLess(vec2u(a.x, a.y & 2147483647u), vec2u(b.x, b.y & 2147483647u))) {
    larger = b; smaller = a;
  }
  let sign = larger.y & 2147483648u;
  let exponent = i32(max(1u, (larger.y >> 20u) & 2047u));
  let smallerExponent = i32(max(1u, (smaller.y >> 20u) & 2047u));
  let left = f64WordsLeft(f64Significand(larger), 3u);
  let right = f64WordsRightJam(f64WordsLeft(f64Significand(smaller), 3u), u32(exponent - smallerExponent));
  if (((larger.y ^ smaller.y) & 2147483648u) == 0u) {
    return f64Pack(f64WordsAdd(left, right), exponent, sign);
  }
  let difference = f64WordsSubtract(left, right);
  if (all(difference == vec2u(0u))) { return vec2u(0u); }
  return f64Pack(difference, exponent, sign);
}
fn f64Subtract(a: vec2u, b: vec2u) -> vec2u {
  return f64Add(a, vec2u(b.x, b.y ^ 2147483648u));
}
// Exact 32 x 32 -> 64 bits using 16-bit products (no u64 extension).
fn f64MultiplyWords(a: u32, b: u32) -> vec2u {
  let a0 = a & 65535u; let a1 = a >> 16u;
  let b0 = b & 65535u; let b1 = b >> 16u;
  let first = a0 * b0;
  let second = a1 * b0 + (first >> 16u);
  let third = a0 * b1 + (second & 65535u);
  return vec2u((third << 16u) | (first & 65535u), a1 * b1 + (second >> 16u) + (third >> 16u));
}
fn f64WideAdd(a: vec4u, b: vec4u) -> vec4u {
  var result = vec4u(0u);
  var carry = 0u;
  for (var word = 0u; word < 4u; word += 1u) {
    let sum = a[word] + b[word];
    result[word] = sum + carry;
    carry = select(0u, 1u, sum < a[word] || result[word] < sum);
  }
  return result;
}
fn f64WideProduct(a: vec2u, b: vec2u) -> vec4u {
  let low = f64MultiplyWords(a.x, b.x);
  let first = f64MultiplyWords(a.x, b.y);
  let second = f64MultiplyWords(a.y, b.x);
  let high = f64MultiplyWords(a.y, b.y);
  return f64WideAdd(f64WideAdd(f64WideAdd(vec4u(low, 0u, 0u), vec4u(0u, first, 0u)),
    vec4u(0u, second, 0u)), vec4u(0u, 0u, high));
}
fn f64WideRightJam(value: vec4u, shift: u32) -> vec2u {
  var result = vec2u(0u);
  var sticky = false;
  for (var word = 0u; word < 4u; word += 1u) {
    let offset = i32(word * 32u) - i32(shift);
    if (offset >= 0) {
      if (offset < 64) { result |= f64WordsLeft(vec2u(value[word], 0u), u32(offset)); }
    } else if (offset > -32) {
      result |= f64WordsRight(vec2u(value[word], 0u), u32(-offset));
      sticky = sticky || (value[word] << u32(32 + offset)) != 0u;
    } else { sticky = sticky || value[word] != 0u; }
  }
  result.x |= select(0u, 1u, sticky);
  return result;
}
fn f64Multiply(a: vec2u, b: vec2u) -> vec2u {
  let sign = (a.y ^ b.y) & 2147483648u;
  let exponentA = (a.y >> 20u) & 2047u;
  let exponentB = (b.y >> 20u) & 2047u;
  if (exponentA == 2047u || exponentB == 2047u) {
    if (f64IsNan(a) || f64IsNan(b) || f64IsZero(a) || f64IsZero(b)) { return vec2u(0u, 2146959360u); }
    return vec2u(0u, sign | 2146435072u);
  }
  if (f64IsZero(a) || f64IsZero(b)) { return vec2u(0u, sign); }
  let product = f64WideProduct(f64Significand(a), f64Significand(b));
  var top = 0u;
  for (var word = 0u; word < 4u; word += 1u) {
    if (product[word] != 0u) { top = word * 32u + 31u - countLeadingZeros(product[word]); }
  }
  var extended: vec2u;
  if (top >= 55u) { extended = f64WideRightJam(product, top - 55u); }
  else { extended = f64WordsLeft(product.xy, 55u - top); }
  let exponent = i32(max(exponentA, 1u)) + i32(max(exponentB, 1u)) - 1023 + i32(top) - 104;
  return f64Pack(extended, exponent, sign);
}
fn f64FromInt(value: i32) -> vec2u {
  if (value == 0) { return vec2u(0u); }
  let sign = select(0u, 2147483648u, value < 0);
  let magnitude = select(u32(value), 0u - u32(value), value < 0);
  let top = 31u - countLeadingZeros(magnitude);
  let significand = f64WordsLeft(vec2u(magnitude, 0u), 52u - top);
  return vec2u(significand.x, sign | ((top + 1023u) << 20u) | (significand.y & 1048575u));
}
fn f64ToFloat(value: vec2u) -> f32 {
  let sign = value.y & 2147483648u;
  let rawExponent = (value.y >> 20u) & 2047u;
  if (rawExponent == 2047u) {
    return bitcast<f32>(sign | select(2139095040u, 2143289344u, f64IsNan(value)));
  }
  if (f64IsZero(value)) { return bitcast<f32>(sign); }
  let significand = f64Significand(value);
  var top = 31u - countLeadingZeros(significand.x);
  if (significand.y != 0u) { top = 63u - countLeadingZeros(significand.y); }
  var extended: vec2u;
  if (top >= 26u) { extended = f64WordsRightJam(significand, top - 26u); }
  else { extended = f64WordsLeft(significand, 26u - top); }
  var exponent = i32(max(rawExponent, 1u)) - 896 + i32(top) - 52;
  if (exponent < 1) { extended = f64WordsRightJam(extended, u32(1 - exponent)); exponent = 1; }
  let remainder = extended.x & 7u;
  var rounded = extended.x >> 3u;
  if (remainder > 4u || (remainder == 4u && (rounded & 1u) != 0u)) { rounded += 1u; }
  if (rounded >= 16777216u) { rounded >>= 1u; exponent += 1; }
  if (exponent >= 255) { return bitcast<f32>(sign | 2139095040u); }
  let encodedExponent = select(0u, u32(exponent), rounded >= 8388608u);
  return bitcast<f32>(sign | (encodedExponent << 23u) | (rounded & 8388607u));
}
// The reported CSP ratio is Float32. Scale its operands before converting so
// large/small finite binary64 environments do not overflow the intermediates.
fn f64Ratio(numerator: vec2u, denominator: vec2u) -> f32 {
  if (f64IsZero(numerator)) { return 0.0; }
  if (f64IsZero(denominator)) { return bitcast<f32>(denominator.x | 2143289344u); }
  let ns = f64Significand(numerator); let ds = f64Significand(denominator);
  var ntop = 31u - countLeadingZeros(ns.x); var dtop = 31u - countLeadingZeros(ds.x);
  if (ns.y != 0u) { ntop = 63u - countLeadingZeros(ns.y); }
  if (ds.y != 0u) { dtop = 63u - countLeadingZeros(ds.y); }
  let normalN = f64WordsLeft(ns, 52u - ntop);
  let normalD = f64WordsLeft(ds, 52u - dtop);
  let ne = i32(max(1u, (numerator.y >> 20u) & 2047u)) + i32(ntop);
  let de = i32(max(1u, (denominator.y >> 20u) & 2047u)) + i32(dtop);
  let n = f64ToFloat(vec2u(normalN.x, (normalN.y & 1048575u) | 1072693248u));
  let d = f64ToFloat(vec2u(normalD.x, (normalD.y & 1048575u) | 1072693248u));
  return (n / d) * exp2(f32(ne - de));
}
`;
