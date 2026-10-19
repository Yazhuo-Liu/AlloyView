import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { lookAt, orthographic, perspective } from '../src/render/math.js';
import { createReplication } from '../src/render/replication.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';
import { baselinePick } from './helpers/pick-reference.js';

function randomGenerator() {
  let seed = 0x314f582d;
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

function fixture(random, scenario, count = 320) {
  const cell = createCell({ origin: [3, -2, 5], vectors: [-12, 1, 0, 4, 13, 2, -2, 3, 10], pbc: [true, scenario % 3 !== 0, true] });
  const fractional = Float64Array.from({ length: count * 3 }, () => random() * 2 - .5);
  const positions = fractionalToCartesian(fractional, cell);
  const rectangle = { left: 19, top: 31, width: 617, height: 401 };
  const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
    canvas: { getBoundingClientRect: () => rectangle }, frame: { cell, fractional }, displayFractional: fractional,
    displayPositions: positions, atomCount: count, radiusScale: [.05, 1, 5, -2][scenario % 4],
    atomRadii: Float64Array.from({ length: count }, () => random() * 1.9),
    visibility: Uint8Array.from({ length: count }, () => random() > .15 ? 255 : 0),
    viewMatrix: lookAt([random() * 60 - 20, random() * 70 - 30, random() * 50 - 10], [2, 2, 3], [0, 0, 1]),
    projectionMatrix: scenario % 2 ? perspective(.4 + random() * 1.2, rectangle.width / rectangle.height, .01, 10000)
      : orthographic(-17, 23, -16, 13, .01, 10000),
    sliceAxis: scenario % 3, sliceMaximum: random(), sliceMode: scenario % 3 ? 'planes' : 'legacy',
    slices: [{ enabled: true, normal: [.8, -.6, 0], position: random() * 8, side: scenario % 2 ? 'positive' : 'negative' },
      { enabled: true, slab: true, normal: [0, .6, .8], position: random() * 10, thickness: 15 },
      { enabled: false, normal: [1, 0, 0], position: -100, side: 'negative' }], updateMatrices() {},
    scalarColorPreview: scenario % 5 ? null : { hideOutside: true, minimum: -.6, maximum: .7,
      input: { data: Float64Array.from({ length: count }, (_, atom) => atom % 23 ? random() * 2 - 1 : NaN) } },
  });
  Object.assign(renderer, createReplication(cell, [2, 2, 2]));
  if (scenario % 7 === 0) { renderer.projectionMatrix[3] = .08; renderer.projectionMatrix[7] = -.03; }
  if (scenario % 11 === 0) { renderer.projectionMatrix[4] = .2; renderer.projectionMatrix[8] = .1; }
  return renderer;
}

function assertSame(renderer, x, y) {
  const expected = baselinePick.call(renderer, x, y), previous = renderer.lastPick;
  assert.equal(renderer.pick(x, y), expected);
  assert.deepEqual(renderer.lastPick, previous);
}

function pointerFor(renderer, atom, replica = renderer.replicas[0], radiusFraction = 0) {
  const p = renderer.projectionMatrix, v = renderer.viewMatrix, positions = renderer.displayPositions, i = atom * 3;
  const wx = positions[i] + replica.offset[0], wy = positions[i + 1] + replica.offset[1], wz = positions[i + 2] + replica.offset[2];
  const vx = v[0] * wx + v[4] * wy + v[8] * wz + v[12], vy = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
  const vz = v[2] * wx + v[6] * wy + v[10] * wz + v[14], cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
  const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12], cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
  const edge = vx + (renderer.atomRadii?.[atom] ?? .7) * renderer.radiusScale;
  const ex = p[0] * edge + p[4] * vy + p[8] * vz + p[12], ew = p[3] * edge + p[7] * vy + p[11] * vz + p[15];
  const rect = renderer.canvas.getBoundingClientRect(), radius = Math.max(3, Math.abs(ex / ew - cx / cw) * rect.width * .5);
  return [rect.left + (cx / cw * .5 + .5) * rect.width + radius * radiusFraction, rect.top + (.5 - cy / cw * .5) * rect.height];
}

test('screen and depth shortcuts match the surface-depth reference for random cameras, replicas, scalar limits and slices', () => {
  const random = randomGenerator();
  for (let scenario = 0; scenario < 100; scenario++) {
    const renderer = fixture(random, scenario), rect = renderer.canvas.getBoundingClientRect();
    for (let probe = 0; probe < 24; probe++) assertSame(renderer, rect.left + random() * rect.width, rect.top + random() * rect.height);
    for (let atom = 0; atom < 12; atom++) {
      const replica = renderer.replicas[atom % renderer.replicas.length];
      for (const boundary of [0, 1 - 1e-14, 1, 1 + 1e-14]) assertSame(renderer, ...pointerFor(renderer, atom, replica, boundary));
    }
  }
});

test('surface depth ties, minimum pixel radius, exceptional radii and unavailable graphics retain their rules', () => {
  const renderer = fixture(randomGenerator(), 1, 5);
  Object.assign(renderer, { viewMatrix: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    projectionMatrix: orthographic(-10, 10, -10, 10, .01, 20), displayPositions: Float64Array.from([0, 0, -5, 0, 0, -5, 0, 0, -6, 0, 0, 1, 0, 0, -4]),
    visibility: new Uint8Array(5).fill(255), atomRadii: new Float64Array(5), radiusScale: 1, sliceMode: 'planes', slices: [],
    scalarColorPreview: null, replicas: [{ indices: [0, 0, 0], offset: [0, 0, 0] }] });
  const center = pointerFor(renderer, 0);
  assertSame(renderer, ...center); assert.equal(renderer.lastPick.index, 4);
  renderer.visibility[4] = 0;
  assertSame(renderer, ...center); assert.equal(renderer.lastPick.index, 0, 'the first equal-depth atom wins');
  for (const distance of [3 - 1e-12, 3, 3 + 1e-12]) assertSame(renderer, center[0] + distance, center[1]);
  for (const radius of [NaN, Infinity, -Infinity, -1, 0, 1e-300, 1e300]) {
    renderer.atomRadii.fill(radius);
    for (const pointer of [center, [center[0] + 200, center[1] + 200]]) assertSame(renderer, ...pointer);
  }
  renderer.contextLost = true; renderer.lastPick = {};
  assertSame(renderer, ...center); assert.equal(renderer.lastPick, null);
  renderer.contextLost = false; renderer.frame = null;
  assertSame(renderer, ...center); assert.equal(renderer.lastPick, null);
});

test('conservative radius bounds tolerate cancellation and extreme finite projection scales', () => {
  const renderer = fixture(randomGenerator(), 0, 3);
  Object.assign(renderer, { viewMatrix: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    visibility: new Uint8Array(3).fill(255), radiusScale: 1, sliceMode: 'planes', slices: [], scalarColorPreview: null,
    replicas: [{ indices: [0, 0, 0], offset: [0, 0, 0] }] });
  for (const scale of [1, 1e-100, 1e100, 1e-300, 1e300]) {
    renderer.projectionMatrix = Float64Array.from([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1, 0, -scale * 1e8, 0, 0, 1]);
    renderer.displayPositions = Float64Array.from([1e8, 0, -1, 1e8 + 1e-7, 0, -2, 1e8 + 1, 0, -3]);
    renderer.atomRadii = Float64Array.from([1e-8, 1e-5, 1]);
    for (let atom = 0; atom < 3; atom++) for (const boundary of [0, 1 - 1e-14, 1, 1 + 1e-14]) assertSame(renderer, ...pointerFor(renderer, atom, renderer.replicas[0], boundary));
  }
});

test('edge-product and squared-distance overflow retain the original exact picking path', () => {
  const renderer = fixture(randomGenerator(), 0, 1);
  Object.assign(renderer, { viewMatrix: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    visibility: Uint8Array.of(255), radiusScale: 1, sliceMode: 'planes', slices: [], scalarColorPreview: null,
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 1200 }) },
    replicas: [{ indices: [0, 0, 0], offset: [0, 0, 0] }] });
  for (const [projection, z, radius, x] of [[1e200, -1.5e308, 2e108, 0], [1, -1, 1e154, 3e154], [1e200, -1, 1e109, -1e109]]) {
    renderer.projectionMatrix = Float64Array.from([projection, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]);
    renderer.displayPositions = Float64Array.of(x, 0, z); renderer.atomRadii = Float64Array.of(radius);
    assert.equal(baselinePick.call(renderer, 300, 1200), 0, 'overflowed radius accepts the old Infinity comparison');
    assertSame(renderer, 300, 1200);
  }
});

test('logarithmic finite projection and geometry scales match the reference including overflow intermediates', () => {
  const renderer = fixture(randomGenerator(), 0, 1), random = randomGenerator();
  Object.assign(renderer, { viewMatrix: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    visibility: Uint8Array.of(255), radiusScale: 1, sliceMode: 'planes', slices: [], scalarColorPreview: null,
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 1200 }) },
    replicas: [{ indices: [0, 0, 0], offset: [0, 0, 0] }] });
  const scale = () => 10 ** (Math.floor(random() * 610) - 305);
  for (let iteration = 0; iteration < 12000; iteration++) {
    renderer.projectionMatrix = Float64Array.from([scale(), 0, 0, 0, 0, scale(), 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]);
    renderer.displayPositions = Float64Array.of((random() < .5 ? -1 : 1) * scale(), (random() < .5 ? -1 : 1) * scale(), -scale());
    renderer.atomRadii = Float64Array.of(scale());
    assertSame(renderer, random() * 600, random() * 1200);
  }
});

test('plane equations run only for pointer hits instead of every displayed atom', () => {
  const renderer = fixture(randomGenerator(), 1, 3000);
  let reads = 0;
  renderer.slices = [{ enabled: true, get normal() { reads++; return [1, 0, 0]; }, position: 0, side: 'positive' }];
  const pointer = pointerFor(renderer, 200);
  baselinePick.call(renderer, ...pointer); const expected = renderer.lastPick, baselineReads = reads;
  reads = 0; renderer.pick(...pointer);
  assert.deepEqual(renderer.lastPick, expected);
  assert.ok(reads < baselineReads / 10, `slice reads ${reads} versus ${baselineReads}`);
});
