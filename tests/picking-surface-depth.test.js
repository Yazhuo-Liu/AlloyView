import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell } from '../src/data/model.js';
import { orthographic, perspective } from '../src/render/math.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

function fixture(projection, positions, radii, radiusScale = 1) {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [true, true, true] });
  return Object.assign(Object.create(WebGLRenderer.prototype), {
    canvas: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 400 }) },
    frame: { cell }, displayPositions: Float64Array.from(positions.flat()), atomRadii: Float64Array.from(radii),
    atomCount: radii.length, radiusScale, sliceMode: 'planes', slices: [],
    viewMatrix: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    projectionMatrix: projection === 'perspective' ? perspective(Math.PI / 2, 1, .01, 100)
      : orthographic(-10, 10, -10, 10, .01, 100),
    replicas: [{ indices: [0, 0, 0], offset: [0, 0, 0] }], updateMatrices() {},
  });
}

for (const projection of ['perspective', 'orthographic']) {
  test(`${projection}: the visible hemisphere wins over a nearer center, in either traversal order`, () => {
    for (const radiusScale of [.1, .5, 1, 2]) {
      for (const reverse of [false, true]) {
        const positions = [[0, 0, -5], [0, 0, -6]], radii = [.5, 3];
        if (reverse) { positions.reverse(); radii.reverse(); }
        const r = fixture(projection, positions, radii, radiusScale);
        const expectedRadius = radiusScale === .1 ? .5 : 3;
        assert.equal(r.pick(210, 220), radii.indexOf(expectedRadius));
        assert.deepEqual(r.lastPick.position, positions[radii.indexOf(expectedRadius)]);
      }
    }
  });

  test(`${projection}: off-center hits use the local sphere surface rather than its frontmost point`, () => {
    // At 90% of the large disc radius its surface is z=-4.692, behind
    // the small sphere at z=-4.0, although the large sphere's tip is z=-3.
    const smallX = projection === 'perspective' ? 2.7 * 4.3 / 6 : 2.7;
    const r = fixture(projection, [[smallX, 0, -4.3], [0, 0, -6]], [.3, 3]);
    const dx = projection === 'perspective' ? 90 : 54;
    assert.equal(r.pick(210 + dx, 220), 0);
    assert.equal(r.pick(210, 220), 1);
  });

  test(`${projection}: hidden and clipped front spheres do not obscure a pick`, () => {
    const r = fixture(projection, [[0, 0, -5], [0, 0, -6]], [.5, 3]);
    r.visibility = Uint8Array.of(255, 0);
    assert.equal(r.pick(210, 220), 0);
    r.visibility = null;
    r.slices = [{ enabled: true, normal: [0, 0, 1], position: -5.5, side: 'positive' }];
    assert.equal(r.pick(210, 220), 0);
  });

  test(`${projection}: winning replica coordinates and the tiny-atom hit tolerance are retained`, () => {
    const r = fixture(projection, [[0, 0, -6]], [1]);
    r.replicas.push({ indices: [0, 0, 1], offset: [0, 0, 1] });
    assert.equal(r.pick(210, 220), 0);
    assert.deepEqual(r.lastPick, { index: 0, replica: [0, 0, 1], position: [0, 0, -5] });
    r.replicas.length = 1; r.atomRadii[0] = .01;
    assert.equal(r.pick(212.9, 220), 0);
    assert.equal(r.pick(213.1, 220), -1);
  });
}

for (const projection of ['perspective', 'orthographic']) {
  test(`${projection}: center planes outside the clipping volume cannot win a pick`, () => {
    const r = fixture(projection, [[0, 0, -.001], [0, 0, -5], [0, 0, -101]], [1, 1, 110]);
    assert.equal(r.pick(210, 220), 1, 'near- and far-clipped billboards leave the visible middle sphere');
    r.visibility = Uint8Array.of(255, 0, 255);
    assert.equal(r.pick(210, 220), -1, 'fully clipped atoms are not selectable');
  });
}

test('perspective: a hemisphere behind the eye has far-plane depth and cannot obscure the visible sphere', () => {
  for (const reverse of [false, true]) {
    const positions = [[0, 0, -.1], [0, 0, -5]], radii = [1, 1];
    if (reverse) positions.reverse();
    const r = fixture('perspective', positions, radii);
    assert.equal(r.pick(210, 220), reverse ? 0 : 1);
    r.visibility = Uint8Array.from(positions, ([, , z]) => z === -.1 ? 255 : 0);
    assert.equal(r.pick(210, 220), reverse ? 1 : 0, 'a lone far-depth fragment still passes LEQUAL against the clear depth');
  }
});
