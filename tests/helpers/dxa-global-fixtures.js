import { createCell, fractionalToCartesian } from '../../src/data/model.js';
import { crystalFrame } from './crystals.js';
import { fccScrewFrame } from './dislocations.js';
import { fccBlock, periodicDistance, subsetFrame, withCell } from './surfaces.js';

/** Two opposite a/2<110> Volterra screws, separated along free X and parallel
 * to periodic Z. Like the existing single-screw fixture this is an elastic
 * displacement field, not an energy-minimized core. */
export function fccScrewPairFrame({ nx = 32, ny = 24, nz = 6, a = 3.52 } = {}) {
  const frame = fccScrewFrame({ screw: false, nx, ny, nz, a });
  const [lx, , , , ly, , , , lz] = frame.cell.vectors;
  const burgers = a / Math.SQRT2;
  const centers = [[lx * .3 + .13 * a, ly * .5 + .17 * a, 1],
    [lx * .7 + .13 * a, ly * .5 + .17 * a, -1]];
  for (let atom = 0; atom < frame.ids.length; atom++) {
    const offset = atom * 3, x = frame.positions[offset], y = frame.positions[offset + 1];
    let shift = 0;
    for (const [cx, cy, sign] of centers)
      shift += sign * burgers / (2 * Math.PI) * Math.atan2(y - cy, x - cx);
    frame.positions[offset + 2] += shift;
    frame.fractional[offset + 2] = frame.positions[offset + 2] / lz;
  }
  frame.expected = { segments: 2, burgersMagnitude: burgers, windingLength: lz,
    totalLength: 2 * lz, centers: centers.map(center => center.slice(0, 2)) };
  return frame;
}

/** Crossing orthogonal perfect-screw displacement fields in the same rotated
 * FCC lattice. The reference, rather than this constructor, determines the
 * resolved core network. It must not be advertised as a relaxed junction. */
export function fccCrossingScrewsFrame({ nx = 20, ny = 20, nz = 20, a = 3.52, crossings = 1 } = {}) {
  const frame = fccScrewFrame({ screw: false, nx, ny, nz, a });
  const [lx, , , , ly, , , , lz] = frame.cell.vectors, burgers = a / Math.SQRT2;
  frame.cell = createCell({ vectors: frame.cell.vectors, pbc: [false, false, false] });
  for (let atom = 0; atom < frame.ids.length; atom++) {
    const offset = atom * 3, [x, y, z] = frame.positions.subarray(offset, offset + 3);
    const dx = burgers / (2 * Math.PI) * Math.atan2(z - lz * .5 - .11 * a, y - ly * .5 - .17 * a);
    const dz = crossings === 1
      ? burgers / (2 * Math.PI) * Math.atan2(y - ly * .5 - .17 * a, x - lx * .5 - .13 * a)
      : burgers / (2 * Math.PI) * (
        Math.atan2(y - ly * .5 - .17 * a, x - lx * .3 - .13 * a)
        - Math.atan2(y - ly * .5 - .17 * a, x - lx * .7 - .13 * a));
    frame.positions[offset] = x + dx;
    frame.positions[offset + 2] = z + dz;
    frame.fractional[offset] = (x + dx) / lx;
    frame.fractional[offset + 2] = (z + dz) / lz;
  }
  delete frame.expected;
  return frame;
}

/** Two separated four-arm crossings. Frozen old-kernel and independent OVITO
 * references describe the resolved network; this remains an unrelaxed elastic
 * geometry stress fixture, not an assertion of equilibrium junction physics. */
export function fccJunctionNetworkFrame() {
  return fccCrossingScrewsFrame({ nx: 32, ny: 20, nz: 20, crossings: 2 });
}

/** Opposite Shockley edge partials bounding one intrinsic (111) stacking-fault
 * ribbon. Axes are X=[1 -1 0] (line), Y=[1 1 -2] (slip), Z=[1 1 1].
 * The isotropic Volterra fields use nu=1/3 and b=a/sqrt(6); their cut changes
 * ABC stacking by +a/6[1 1 -2] between the two cores. This is an unrelaxed
 * elasticity fixture, independently resolved by pinned OVITO, not a claim
 * about equilibrium dissociation width or core energy. */
export function fccPartialDipoleFrame() {
  const nx = 6, ny = 24, nz = 24, a = 3.52, nu = 1 / 3;
  const dx = a / Math.SQRT2, dy = a * Math.sqrt(1.5), dz = a / Math.sqrt(3), burgers = a / Math.sqrt(6);
  const lx = nx * dx, ly = ny * dy, lz = nz * dz;
  const centers = [[ly * .3 + .13 * dy, -1], [ly * .7 + .13 * dy, 1]], cz = (Math.floor(nz / 2) - .5) * dz;
  const positions = new Float64Array(nx * ny * nz * 6), fractional = new Float64Array(positions.length);
  let cursor = 0;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) for (const basis of [0, .5]) {
    const x = (i + basis) * dx, y = (j + basis + (k % 3) / 3) * dy, z = k * dz;
    let uy = 0, uz = 0;
    for (const [cy, charge] of centers) {
      const yy = y - cy, zz = z - cz, radius2 = yy * yy + zz * zz, factor = charge * burgers / (2 * Math.PI);
      uy += factor * (Math.atan2(zz, yy) + yy * zz / (2 * (1 - nu) * radius2));
      uz -= factor * ((1 - 2 * nu) / (4 * (1 - nu)) * Math.log(radius2) + (yy * yy - zz * zz) / (4 * (1 - nu) * radius2));
    }
    positions.set([x, y + uy, z + uz], cursor);
    fractional.set([x / lx, (y + uy) / ly, (z + uz) / lz], cursor); cursor += 3;
  }
  return { positions, fractional, cell: createCell({ vectors: [lx, 0, 0, 0, ly, 0, 0, 0, lz], pbc: [true, false, false] }),
    ids: Uint32Array.from({ length: positions.length / 3 }, (_, atom) => atom + 1),
    types: new Uint16Array(positions.length / 3), properties: [] };
}

export function fccTwinsFrame() {
  const side = 16, layers = [0, 1, 2, 0, 1, 2, 0, 2, 1, 0, 2, 1], a = 3.52, spacing = a / Math.SQRT2;
  const fractional = new Float64Array(side * side * layers.length * 3);
  let cursor = 0;
  for (let layer = 0; layer < layers.length; layer++)
    for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) {
      const shift = layers[layer] / 3;
      fractional[cursor++] = (x + shift) / side;
      fractional[cursor++] = (y + shift) / side;
      fractional[cursor++] = layer / layers.length;
    }
  const cell = createCell({ vectors: [side * spacing, 0, 0,
    side * spacing / 2, side * spacing * Math.sqrt(3) / 2, 0,
    0, 0, layers.length * a / Math.sqrt(3)], pbc: [true, true, true] });
  return { fractional, cell, positions: fractionalToCartesian(fractional, cell, new Float64Array(fractional.length)),
    ids: Uint32Array.from({ length: fractional.length / 3 }, (_, atom) => atom + 1),
    types: new Uint16Array(fractional.length / 3), properties: [] };
}

/** A cavity crossing all three periodic boundaries, also used by K4's frozen
 * surface regression. This exercises shared tessellation and region finding. */
export function fccCornerVoidFrame() {
  const side = 8 * 3.52;
  const frame = subsetFrame(fccBlock(8, 3.52), point => periodicDistance(point, [0, 0, 0], side) > 5.5);
  return withCell(frame, [side, 0, 0, side * .05, side, 0, side * .03, side * .02, side], { origin: [-3, 5, 7] });
}

/** A deterministic short sequence, not a dynamics integrator. Each frame is a
 * new scientific input: periodic translation, a sub-angstrom displacement,
 * changed cell, then a vacancy (topology event), followed by the original. */
export function dxaGlobalTrajectoryFixtures() {
  const original = crystalFrame('fcc', 4, 3.52);
  const translated = { ...original, fractional: original.fractional.slice() };
  for (let coordinate = 0; coordinate < translated.fractional.length; coordinate++)
    translated.fractional[coordinate] += [.97, -.43, 1.12][coordinate % 3];
  translated.positions = fractionalToCartesian(translated.fractional, translated.cell, new Float64Array(translated.fractional.length));
  const perturbed = { ...translated, fractional: translated.fractional.slice() };
  for (let atom = 0; atom < perturbed.ids.length; atom++)
    perturbed.fractional[atom * 3] += .0002 * Math.sin(atom * .37);
  perturbed.positions = fractionalToCartesian(perturbed.fractional, perturbed.cell, new Float64Array(perturbed.fractional.length));
  const side = original.cell.vectors[0];
  const changedCell = withCell(perturbed, [side * 1.002, 0, 0, side * .003, side, 0, 0, side * .002, side * .999],
    { origin: [-2, 3, 1] });
  const vacancy = subsetFrame(changedCell, (_, atom) => atom !== 127);
  return [['initial', original], ['translated', translated], ['perturbed', perturbed], ['cell', changedCell],
    ['vacancy', vacancy], ['return', original]].map(([name, frame]) => geometryFixture(`trajectory-${name}`, frame));
}

function rectangularFcc([nx, ny, nz], a = 3.52) {
  const fractional = new Float64Array(nx * ny * nz * 12);
  let cursor = 0;
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++)
    for (const [dx, dy, dz] of [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]]) {
      fractional[cursor++] = (x + dx) / nx;
      fractional[cursor++] = (y + dy) / ny;
      fractional[cursor++] = (z + dz) / nz;
    }
  const cell = createCell({ vectors: [nx * a, 0, 0, 0, ny * a, 0, 0, 0, nz * a] });
  return { fractional, cell, positions: fractionalToCartesian(fractional, cell, new Float64Array(fractional.length)),
    ids: Uint32Array.from({ length: fractional.length / 3 }, (_, atom) => atom + 1),
    types: new Uint16Array(fractional.length / 3), properties: [] };
}

export function dxaGlobalBoundaryFixtures() {
  const duplicate = crystalFrame('fcc', 4, 3.52);
  duplicate.fractional.set(duplicate.fractional.subarray(0, 3), 3);
  duplicate.positions = fractionalToCartesian(duplicate.fractional, duplicate.cell, new Float64Array(duplicate.fractional.length));
  const slab = crystalFrame('fcc', 4, 3.52);
  slab.cell = createCell({ vectors: [14.08, 0, 0, 0, 14.08, 0, 0, 0, 40], pbc: [true, true, false] });
  for (let atom = 0; atom < slab.ids.length; atom++) slab.fractional[atom * 3 + 2] = (slab.positions[atom * 3 + 2] + 12) / 40;
  slab.positions = fractionalToCartesian(slab.fractional, slab.cell, new Float64Array(slab.fractional.length));
  return [geometryFixture('thin-valid', rectangularFcc([8, 8, 3])),
    geometryFixture('thin-small', rectangularFcc([4, 4, 1])),
    geometryFixture('duplicate-position', duplicate), geometryFixture('vacuum-slab', slab)];
}

function geometryFixture(name, frame) {
  return { name, frame, lattice: 1, contract: { kind: 'baseline-geometry',
    source: 'Deterministic FCC geometry; compare complete baseline science and exact tetrahedron invariants.' } };
}

/** Small geometry cases exercise real BDEL/PDEL, including every PBC mask.
 * No case assumes that atom labels at a free surface are all FCC. */
export function dxaGlobalGeometryFixtures() {
  const fixtures = [];
  for (let mask = 0; mask < 8; mask++) {
    const frame = crystalFrame('fcc', 4, 3.52);
    frame.cell = createCell({ vectors: frame.cell.vectors,
      pbc: [0, 1, 2].map(axis => Boolean(mask & (1 << axis))) });
    fixtures.push(geometryFixture(`fcc-pbc-${mask}`, frame));
  }
  const base = crystalFrame('fcc', 4, 3.52), side = base.cell.vectors[0];
  fixtures.push(geometryFixture('triclinic-mixed', withCell(base,
    [side, 0, 0, side * .07, side, 0, side * .03, side * .04, side],
    { origin: [-3, 5, 7], pbc: [true, false, true] })));
  const near = crystalFrame('fcc', 4, 3.52);
  for (let coordinate = 0; coordinate < near.fractional.length; coordinate++)
    near.fractional[coordinate] += ((coordinate * 17) % 7 - 3) * 1e-12;
  near.positions = fractionalToCartesian(near.fractional, near.cell, new Float64Array(near.fractional.length));
  fixtures.push(geometryFixture('near-cospherical', near));
  return fixtures;
}

export function dxaGlobalFixtures() {
  return [...dxaGlobalGeometryFixtures(), ...dxaGlobalBoundaryFixtures().filter(fixture => fixture.name !== 'thin-small'),
    { name: 'screw-pair', frame: fccScrewPairFrame(), lattice: 1,
      contract: { kind: 'opposite-screws', source: 'Two analytical Volterra screw displacement fields; unrelaxed cores.' } },
    { name: 'junction-network', frame: fccJunctionNetworkFrame(), lattice: 1,
      contract: { kind: 'external-reference', source: 'Two orthogonal Volterra crossings; unrelaxed stress fixture, not an equilibrium junction. Compare the pinned full reference.' } },
    { name: 'shockley-partials', frame: fccPartialDipoleFrame(), lattice: 1,
      contract: { kind: 'external-reference', source: 'Opposite analytical a/6<112> Shockley edge partials bounding a (111) intrinsic stacking-fault ribbon; unrelaxed elastic cores, independently resolved by pinned OVITO.' } }];
}
