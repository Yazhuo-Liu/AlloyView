import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import { calculateDxa, releaseDxaKernels } from '../src/analysis/dxa.js';

test('the actual Fe dump preserves triclinic image data and yields a finite BCC dislocation loop', async () => {
  const frame = parseLammpsFrame(await readFile(new URL('../examples/Fe_disloc_loop.dump', import.meta.url), 'utf8'),
    'Fe_disloc_loop.dump');
  assert.equal(frame.ids.length, 60229);
  assert.equal(frame.timestep, 11524);
  assert.deepEqual(frame.typeLabels, ['Type 1']);
  assert.deepEqual(frame.cell.pbc, [true, true, true]);
  assert.equal(frame.cell.triclinic, true);
  assert.ok(frame.cell.vectors[6] < -.08 && frame.cell.vectors[7] < -.05);
  assert.equal(new Set(frame.ids).size, frame.ids.length);
  assert.ok(frame.imageFlags instanceof Int32Array);
  assert.equal(frame.imageFlags.length, 60229 * 3);
  assert.equal(frame.unwrapSource, 'ix/iy/iz');
  assert.ok(frame.properties.some(property => property.name === 'i_group_inters'));
  const before = frame.fractional.slice();
  try {
    const result = await calculateDxa(frame, { lattice: 'bcc' }, { workerCount: 1 });
    assert.deepEqual(frame.fractional, before);
    assert.equal(result.atomStructureTypes.length, 60229);
    assert.ok(result.structureCounts[3] > 60000);
    assert.equal(result.segments.length, 1);
    const segment = result.segments[0];
    assert.equal(segment.familyId, 'half111');
    assert.equal(segment.structureType, 3);
    assert.equal(segment.closed, true);
    assert.equal(segment.isInfinite, false);
    assert.ok(Math.abs(Math.hypot(...segment.burgersVector) - Math.sqrt(3) / 2) < 1e-10);
    assert.ok(Math.hypot(...segment.spatialBurgersVector) > 2.4 && Math.hypot(...segment.spatialBurgersVector) < 2.5);
    // DXA estimates the core with a smoothed polyline; do not pin its points,
    // crystallographic symmetry gauge, or representative tessellation.
    assert.ok(result.totalLength > 100 && result.totalLength < 108);
    assert.ok(segment.points.length >= 12 && segment.points.every(Number.isFinite));
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(segment.points[axis]
      - segment.points[segment.points.length - 3 + axis]) < 1e-6);
    assert.deepEqual(segment.junctions, [[{ segmentId: segment.id, end: 1 }], [{ segmentId: segment.id, end: 0 }]]);
    assert.equal(result.totalLength, segment.length);
    assert.ok(Math.abs(result.density - result.totalLength / result.volume) < 1e-15);
  } finally { await releaseDxaKernels(); }
});
