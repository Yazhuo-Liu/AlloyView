import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVaspVolume } from '../src/io/volumetric.js';
import { replicateFrame, physicalReplicationPlan } from '../src/data/replicate.js';
import { replicateVolumetricData } from '../src/data/replicate-volume.js';

function frame() {
  return parseVaspVolume('Synthetic grid\n1\n2 0 0\n.5 3 0\n-.2 .4 4\nH\n1\nDirect\n0 0 0\n\n2 2 2\n24 48 72 96 120 144 168 192\n', 'CHGCAR');
}

test('physical replicas tile periodic scalar fields with their atoms, preserving density and scaling integrated charge', async () => {
  const source = frame(), original = structuredClone(source.volumetric);
  const expanded = await replicateFrame(source, [2, 3, 1]);
  const a = source.volumetric.datasets[0], b = expanded.volumetric.datasets[0];
  assert.deepEqual(b.dimensions, [4, 6, 2]); assert.equal(expanded.ids.length, 6);
  for (let z = 0; z < 2; z++) for (let y = 0; y < 6; y++) for (let x = 0; x < 4; x++) {
    assert.equal(b.values[x + 4 * (y + 6 * z)], a.values[x % 2 + 2 * (y % 2 + 2 * z)]);
  }
  assert.equal(b.statistics.integral, 6 * a.statistics.integral);
  assert.equal(b.statistics.mean, a.statistics.mean); assert.equal(b.statistics.sampleCount, 48);
  assert.deepEqual(b.steps, a.steps); assert.notEqual(b.values.buffer, a.values.buffer);
  assert.deepEqual(source.volumetric, original);
});

test('volume replication rejects incompatible periodicity, geometry and allocations before atom expansion', () => {
  const source = frame(), atomsOnly = { ...source }; delete atomsOnly.volumetric;
  const ordinary = physicalReplicationPlan(atomsOnly, [2, 1, 1]);
  assert.ok(physicalReplicationPlan(source, [2, 1, 1]).estimatedBytes > ordinary.estimatedBytes);
  assert.throws(() => physicalReplicationPlan(source, [2, 1, 1], { maxBytes: ordinary.estimatedBytes }), /memory limit/);
  source.volumetric.datasets[0].periodic[0] = false;
  assert.throws(() => physicalReplicationPlan(source, [2, 1, 1]), /open volumetric/);
  source.volumetric.datasets[0].periodic[0] = true;
  source.volumetric.datasets[0].steps[0] *= 2;
  assert.throws(() => physicalReplicationPlan(source, [2, 1, 1]), /span the simulation cell/);
});

test('cancelled volume tiling publishes no partial grid and leaves source samples intact', async () => {
  const source = frame(), saved = source.volumetric.datasets[0].values.slice(), controller = new AbortController();
  await assert.rejects(replicateVolumetricData(source, [2, 1, 1], {
    signal: controller.signal, yieldTask: async () => controller.abort(),
  }), { name: 'AbortError' });
  assert.deepEqual(source.volumetric.datasets[0].values, saved);
});
