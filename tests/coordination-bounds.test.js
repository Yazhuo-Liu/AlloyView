import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateCoordination, minimumImageDistanceSquared } from '../src/analysis/coordination.js';
import { createCell } from '../src/data/model.js';

function frame(count, vectors, pbc = [true, true, true]) {
  const fractional = new Float64Array(count * 3);
  for (let atom = 0; atom < count; atom++) {
    fractional[atom * 3] = (atom * 19 % 503) / 503;
    fractional[atom * 3 + 1] = (atom * 23 % 509) / 509;
    fractional[atom * 3 + 2] = (atom * 31 % 521) / 521;
  }
  return { fractional, cell: createCell({ vectors, pbc }) };
}

test('large coordination cutoffs complete in a real Worker and retain unique-ID counting', { timeout: 15_000 }, async () => {
  const source = frame(500, [18, 0, 0, 2.4, 18, 0, -.8, 1.1, 18]);
  const original = source.fractional.slice();
  let created = 0;
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 } }, workerFactory() {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)); created++;
    return {
      addEventListener(name, callback) { worker.on(name, data => callback(name === 'message' ? { data } : data)); },
      postMessage(data, transfers) { worker.postMessage(data, transfers); }, terminate() { worker.terminate(); },
    };
  } });
  try {
    for (const cutoff of [300, 1e15]) {
      let timer;
      const result = await Promise.race([pool.analyzeCPU(source, { kind: 'coordination', cutoff }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Coordination closest-image search stalled.')), 5000); })
      ]).finally(() => clearTimeout(timer));
      assert.ok(result.coordination.every(value => value === 499));
      assert.equal(result.candidatePairs, 500 * 499 / 2);
      assert.equal(result.acceptedPairs, 500 * 499 / 2);
    }
    assert.equal(created, 1, 'a cutoff edit reuses its Worker');
    assert.deepEqual(source.fractional, original);
    const following = await pool.analyzeCPU(frame(2, [18, 0, 0, 0, 18, 0, 0, 0, 18]), { kind: 'coordination', cutoff: 3 });
    assert.equal(following.coordination.length, 2);
    assert.equal(created, 1);
    const thin = frame(2, [2.4309237939305604, 1.572750010062009, 2.7974060042761266,
      2.4309237963507075, 1.5727500138506099, 2.797406005240905,
      -.7926766320567864, .38624590370698036, .4716755864582013]);
    thin.fractional.set([0, 0, 0, 0, 0, .3]);
    await assert.rejects(pool.analyzeCPU(thin, { kind: 'coordination', cutoff: .5 }), /work limit/);
    await pool.analyzeCPU(source, { kind: 'coordination', cutoff: 300 });
    assert.equal(created, 1, 'an extreme cell rejection retains the usable Worker');
  } finally { pool.close(); }
});

test('tightened closest-image work bounds agree with exhaustive triclinic and mixed-PBC images', () => {
  for (const pbc of [[true, true, true], [true, false, true], [false, false, false]]) {
    const source = frame(23, [4, .2, -.1, 3.7, 2, .1, -.8, .7, 3], pbc);
    for (let atom = 1; atom < 23; atom++) {
      const d = Array.from({ length: 3 }, (_, axis) => source.fractional[atom * 3 + axis] - source.fractional[axis]);
      let expected = Infinity;
      for (let a = pbc[0] ? -6 : 0; a <= (pbc[0] ? 6 : 0); a++) {
        for (let b = pbc[1] ? -6 : 0; b <= (pbc[1] ? 6 : 0); b++) {
          for (let c = pbc[2] ? -6 : 0; c <= (pbc[2] ? 6 : 0); c++) {
            const h = source.cell.vectors, f0 = d[0] - a, f1 = d[1] - b, f2 = d[2] - c;
            const x = f0 * h[0] + f1 * h[3] + f2 * h[6];
            const y = f0 * h[1] + f1 * h[4] + f2 * h[7];
            const z = f0 * h[2] + f1 * h[5] + f2 * h[8];
            expected = Math.min(expected, x * x + y * y + z * z);
          }
        }
      }
      assert.equal(minimumImageDistanceSquared(source.fractional, 0, atom, source.cell, [1e15, 1e15, 1e15]), expected);
    }
  }
});

test('coordination rejects overflowing cutoffs and unsafe image coefficients before enumeration', () => {
  const source = frame(2, [10, 0, 0, 9, 1, 0, .7, -.8, 10]);
  assert.throws(() => calculateCoordination(source, 1e200), /squared distance/);
  source.fractional[3] = 3e38;
  assert.throws(() => minimumImageDistanceSquared(source.fractional, 0, 1, source.cell, [1e40, 1e40, 1e40]), /safe integer precision/);
  assert.throws(() => minimumImageDistanceSquared(new Float64Array([0, 0, 0, .1, .1, .1]), 0, 1,
    createCell({ vectors: [10, 0, 0, 9, 1e-8, 0, 0, 0, 10] }), [1e20, 1e20, 1e20]), /work limit/);
});

test('ill-conditioned face heights cannot create an empty axis that bypasses the image work limit', () => {
  const cell = createCell({ vectors: [2.4309237939305604, 1.572750010062009, 2.7974060042761266,
    2.4309237963507075, 1.5727500138506099, 2.797406005240905,
    -.7926766320567864, .38624590370698036, .4716755864582013] });
  const fractional = new Float64Array([0, 0, 0, 0, 0, .3]);
  assert.equal(minimumImageDistanceSquared(fractional, 0, 1, cell, [4, 4, 4]), .0899999999999999);
  assert.throws(() => calculateCoordination({ cell, fractional }, .5), /work limit/);
});
