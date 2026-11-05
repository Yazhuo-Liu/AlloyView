// An annotation belongs to a particular extracted curve, not just its numeric
// ID (a later extraction may reuse or renumber IDs). Hash copied scalar values
// without retaining geometry in exported configuration recipes.
const signatures = new WeakMap();
export function dislocationSegmentSignature(segment) {
  if (signatures.has(segment)) return signatures.get(segment);
  const bytes = new DataView(new ArrayBuffer(8));
  let first = 2166136261, second = 0x9e3779b9;
  const add = value => {
    bytes.setFloat64(0, value, true);
    for (let index = 0; index < 8; index++) {
      const byte = bytes.getUint8(index);
      first = Math.imul(first ^ byte, 16777619);
      second = Math.imul(second ^ byte, 0x85ebca6b);
    }
  };
  for (const values of [segment.points, segment.burgersVector, segment.spatialBurgersVector]) {
    add(values?.length ?? 0);
    for (const value of values ?? []) {
      if (Array.isArray(value)) for (const component of value) add(component);
      else add(value);
    }
  }
  add(Number(Boolean(segment.closed))); add(Number(Boolean(segment.isInfinite)));
  const signature = [first, second].map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
  signatures.set(segment, signature);
  return signature;
}
