import assert from 'node:assert/strict';
import test from 'node:test';
import { dot, lookAt, multiply4, normalize, orthographic, perspective } from '../src/render/math.js';
import { arcballVector, closestRayAxisParameter, inverseMatrix4, projectWorldPoint,
  rotateBetweenSpherePoints, screenRay, unprojectScreenPoint } from '../src/render/slice-gizmo.js';

function close(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance,
    `${actual} differs from ${expected}`));
}

for (const mode of ['perspective', 'orthographic']) {
  test(`slice handle projection round trips in ${mode} cameras`, () => {
    const view = lookAt([8, -11, 7], [1, 2, 3], [0, 0, 1]);
    const projection = mode === 'perspective' ? perspective(Math.PI / 4, 1.4, 0.1, 80)
      : orthographic(-9, 9, -6, 6, 0.1, 80);
    const matrix = multiply4(projection, view), inverse = inverseMatrix4(matrix);
    const point = [2.3, -1.2, 4.5], screen = projectWorldPoint(matrix, point, 840, 600);
    assert.ok(screen);
    close(unprojectScreenPoint(inverse, screen.x, screen.y, screen.depth, 840, 600), point);
    const ray = screenRay(inverse, screen.x, screen.y, 840, 600);
    const normal = normalize([1, 0.5, 0.2]), offset = 2.8;
    const center = point.map((value, axis) => value - normal[axis] * offset);
    assert.ok(Math.abs(closestRayAxisParameter(ray, center, normal) - offset) < 1e-6);
  });
}

test('the view-aligned normal uses the separate depth movement handle', () => {
  const ray = { origin: [1, 2, 9], direction: [0, 0, -1] };
  assert.equal(closestRayAxisParameter(ray, [1, 2, 0], [0, 0, 1]), null);
  assert.equal(inverseMatrix4(new Float32Array(16)), null);
});

test('sphere rotation preserves unit length and can turn the normal behind the sphere', () => {
  const first = arcballVector(0, 0, 80), front = arcballVector(40, -30, 80);
  const back = arcballVector(160, 0, 80);
  const rotatedFront = rotateBetweenSpherePoints([0, 0, 1], first, front);
  const rotatedBack = rotateBetweenSpherePoints([0, 0, 1], first, back);
  close(rotatedFront, front);
  close(rotatedBack, back);
  assert.ok(rotatedBack[2] < 0);
  assert.ok(Math.abs(Math.hypot(...rotatedBack) - 1) < 1e-12);
  close(rotateBetweenSpherePoints([0, 0, 1], [0, 0, 1], [0, 0, -1]), [0, 0, -1]);
  close(rotateBetweenSpherePoints([0, 0, 1], first, first), [0, 0, 1]);
});

test('rotation updates the plane position around its original center', () => {
  const center = [8, 4, -3], before = [0, 0, 1];
  const normal = rotateBetweenSpherePoints(before, arcballVector(0, 0, 90), arcballVector(-45, 30, 90));
  const position = dot(normal, center);
  assert.notEqual(position, dot(before, center));
  assert.ok(Math.abs(dot(normal, center) - position) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-12);
});
