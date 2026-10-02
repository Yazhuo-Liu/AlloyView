import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { indexLammpsDumpSeries, readLammpsSeriesFrame } from '../src/io/lammps-series.js';

const root = new URL('../', import.meta.url);

test('numbered LAMMPS dump files combine numeric file order with frames inside each file', async () => {
  const text = await readFile(new URL('examples/bcc-trajectory.dump', root), 'utf8');
  const later = namedBlob(text, 'snapshot_10.lmp');
  const earlier = namedBlob(text, 'snapshot_2.lmp');
  const progress = [];
  const series = await indexLammpsDumpSeries([later, earlier], (event) => progress.push(event));

  assert.equal(series.frameCount, 4);
  assert.deepEqual(series.chunks.map((chunk) => chunk.file.name), ['snapshot_2.lmp', 'snapshot_10.lmp']);
  assert.deepEqual(series.chunks.map((chunk) => chunk.firstFrame), [0, 2]);
  assert.equal(progress.at(-1).loaded, 2);

  const second = await readLammpsSeriesFrame(series, 1);
  const third = await readLammpsSeriesFrame(series, 2);
  assert.equal(second.timestep, 100);
  assert.match(second.title, /^snapshot_2\.lmp/);
  assert.equal(third.timestep, 0);
  assert.match(third.title, /^snapshot_10\.lmp/);
  await assert.rejects(() => readLammpsSeriesFrame(series, 4), /outside the available range/);
});

function namedBlob(text, name) {
  const blob = new Blob([text]);
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}
