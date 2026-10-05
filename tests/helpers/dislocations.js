import { createCell } from '../../src/data/model.js';

/** FCC screw dislocation with a/2<110> parallel to periodic Z, free X/Y.
 * The rotated orthogonal FCC cell has two sites and volume a^3/2.
 * This elastic displacement fixture is an extraction check, not a relaxed core.
 * OVITO 3.10.6.post2 extracts one perfect dislocation of length Lz at defaults.
 */
export function fccScrewFrame({ screw = true, nx = 30, ny = 24, nz = 6, a = 3.52 } = {}) {
  const step = [a / Math.sqrt(2), a, a / Math.sqrt(2)];
  const size = [nx * step[0], ny * step[1], nz * step[2]];
  const cell = createCell({ vectors: [size[0], 0, 0, 0, size[1], 0, 0, 0, size[2]],
    pbc: [false, false, true] });
  const count = nx * ny * nz * 2;
  const positions = new Float64Array(count * 3);
  const fractional = new Float64Array(count * 3);
  let cursor = 0;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    for (const basis of [0, .5]) {
      const x = (i + basis) * step[0], y = (j + basis) * step[1];
      const shift = screw ? step[2] / (2 * Math.PI)
        * Math.atan2(y - size[1] / 2 - .17 * a, x - size[0] / 2 - .13 * a) : 0;
      const z = (k + basis) * step[2] + shift;
      positions.set([x, y, z], cursor);
      fractional.set([x / size[0], y / size[1], z / size[2]], cursor);
      cursor += 3;
    }
  }
  return { cell, fractional, positions, ids: Uint32Array.from({ length: count }, (_, i) => i + 1),
    types: new Uint16Array(count), typeLabels: ['Ni'], properties: [],
    expected: { burgersMagnitude: step[2], totalLength: size[2], segments: screw ? 1 : 0 } };
}
