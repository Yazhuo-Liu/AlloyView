import assert from 'node:assert/strict';
import test from 'node:test';
import { closestDislocationAnchor } from '../src/render/dislocation-vector-gizmo.js';
import { projectWorldPoint } from '../src/render/slice-gizmo.js';
import { orthographic, perspective } from '../src/render/math.js';

const paths = (points, fractions = [0, 1]) => [{ points: Float64Array.from(points), fractions: Float64Array.from(fractions) }];
const viewport = { width: 800, height: 600 };
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance,
  `${actual} differs from ${expected}`);

for (const mode of ['orthographic', 'perspective']) {
  test(`Burgers root follows the physical curve in ${mode} projection`, () => {
    const matrix = mode === 'perspective' ? perspective(Math.PI / 2, 4 / 3, .1, 30)
      : orthographic(-5, 5, -5, 5, .1, 30);
    const path = paths([-1, -.5, -2, 2, 1, -8]);
    const expected = .37, point = [-1 + 3 * expected, -.5 + 1.5 * expected, -2 - 6 * expected];
    const screen = projectWorldPoint(matrix, point, viewport.width, viewport.height);
    const result = closestDislocationAnchor(path, screen, { matrix, ...viewport });
    close(result.position, expected);
    result.point.forEach((value, axis) => close(value, point[axis]));
    close(result.distanceSquared, 0);
  });
}

test('dragging respects slice clipping and retains the original source fraction', () => {
  const matrix = orthographic(-5, 5, -5, 5, .1, 30), path = paths([-4, 0, -3, 4, 0, -3]);
  const pointer = projectWorldPoint(matrix, [-3, 0, -3], viewport.width, viewport.height);
  const result = closestDislocationAnchor(path, pointer, { matrix, ...viewport,
    planes: [{ normal: [-1, 0, 0], offset: 0 }] });
  close(result.point[0], -1e-5);
  close(result.position, .5, 2e-6);
  assert.equal(closestDislocationAnchor(path, pointer, { matrix, ...viewport,
    planes: [{ normal: [1, 0, 0], offset: -8 }] }), null);
});

test('periodic pieces preserve source arc position without adding a bridge at the seam', () => {
  const matrix = orthographic(-1, 11, -5, 5, .1, 30);
  const path = [
    ...paths([8, 0, -3, 10, 0, -3], [0, .5]),
    ...paths([0, 0, -3, 2, 0, -3], [.5, 1]),
  ];
  const target = projectWorldPoint(matrix, [1, 0, -3], viewport.width, viewport.height);
  close(closestDislocationAnchor(path, target, { matrix, ...viewport }).position, .75);
  const gap = projectWorldPoint(matrix, [5, 0, -3], viewport.width, viewport.height);
  const nearest = closestDislocationAnchor(path, gap, { matrix, ...viewport, preferredPosition: .8 });
  assert.ok(nearest.distanceSquared > 0, 'there is no segment from the high cell face to the low face');
  close(nearest.point[0], 2);
});

test('selected display replicas drag on their translated curves', () => {
  const matrix = orthographic(0, 20, -5, 5, .1, 30);
  const path = paths([0, 0, -3, 4, 0, -3]);
  const target = projectWorldPoint(matrix, [13, 0, -3], viewport.width, viewport.height);
  const result = closestDislocationAnchor(path, target, { matrix, ...viewport, offset: [10, 0, 0] });
  close(result.position, .75); close(result.point[0], 13);
});

test('camera-plane crossings clip safely and paths behind the camera cannot be dragged', () => {
  const matrix = perspective(Math.PI / 2, 4 / 3, .1, 30), pointer = { x: 400, y: 300 };
  assert.equal(closestDislocationAnchor(paths([-1, 0, 2, 1, 0, 3]), pointer, { matrix, ...viewport }), null);
  const visible = closestDislocationAnchor(paths([0, 0, 1, 0, 0, -3]), pointer,
    { matrix, ...viewport, preferredPosition: .7 });
  assert.ok(visible); close(visible.position, .7);
  assert.ok(visible.point[2] < 0);
});

test('end-on curves and projected crossings prefer the current source position', () => {
  const matrix = orthographic(-5, 5, -5, 5, .1, 30), pointer = { x: 400, y: 300 };
  close(closestDislocationAnchor(paths([0, 0, -2, 0, 0, -8]), pointer,
    { matrix, ...viewport, preferredPosition: .73 }).position, .73);
  const crossing = paths([-2, -2, -3, 2, 2, -3, -2, 2, -3, 2, -2, -3], [0, .3, .6, 1]);
  const result = closestDislocationAnchor(crossing, pointer, { matrix, ...viewport, preferredPosition: .8 });
  close(result.position, .8);
});
