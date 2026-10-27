/** Unit quaternion (w, x, y, z) conversions shared by grain segmentation, its
 * controls and the statistics export. */
/** Rotation angle in degrees and unit axis of a unit quaternion (w, x, y, z)
 * taken with w ≥ 0; the axis of the identity is reported as [0, 0, 1]. */
export function quaternionAxisAngle(quaternion, offset = 0) {
  let w = quaternion[offset], x = quaternion[offset + 1], y = quaternion[offset + 2], z = quaternion[offset + 3];
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  const sine = Math.hypot(x, y, z);
  if (!(sine > 1e-12)) return { angle: 0, axis: [0, 0, 1] };
  return { angle: 2 * Math.atan2(sine, w) * 180 / Math.PI, axis: [x / sine, y / sine, z / sine] };
}

/** Bunge Euler angles (φ1, Φ, φ2) in degrees, Z–X–Z, of the passive rotation
 * g = R(q)ᵀ that takes sample coordinates to crystal coordinates. PTM's
 * quaternion actively rotates the ideal lattice into the sample frame, so
 * R(q) = Z(φ1) X(Φ) Z(φ2). φ1 and φ2 lie in [0, 360), Φ in [0, 180]. */
export function quaternionBungeEuler(quaternion, offset = 0) {
  const w = quaternion[offset], x = quaternion[offset + 1], y = quaternion[offset + 2], z = quaternion[offset + 3];
  const degrees = 180 / Math.PI, wrap = angle => { const turn = angle * degrees % 360; return turn < 0 ? turn + 360 : turn; };
  // Elements of R(q): r[row][column].
  const r02 = 2 * (x * z + w * y), r12 = 2 * (y * z - w * x), r22 = 1 - 2 * (x * x + y * y);
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x);
  const sinePhi = Math.hypot(r02, r12);
  if (sinePhi < 1e-9) {
    // Φ = 0 or 180°: only φ1 ± φ2 is defined; report it as φ1.
    const r00 = 1 - 2 * (y * y + z * z), r10 = 2 * (x * y + w * z);
    return [wrap(Math.atan2(r10, r00)), r22 > 0 ? 0 : 180, 0];
  }
  return [wrap(Math.atan2(r02, -r12)), Math.atan2(sinePhi, r22) * degrees, wrap(Math.atan2(r20, r21))];
}
