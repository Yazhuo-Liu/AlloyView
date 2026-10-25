import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { parseFrameDescriptor } from '../src/workers/frame-parser.js';
import { detectStructureFormatHeader, inferStructureFormatFromPath, isSupportedStructurePath, catalogLocalSources } from '../src/io/file-sequences.js';
import { readStructureHeader } from '../src/io/gzip.js';
import { createExampleCatalog } from '../scripts/lib/example-catalog.mjs';

const source = new URL('../examples/crystals/SrTiO3.cif', import.meta.url);

test('crystal examples are discovered as individual CIF/POSCAR sources with useful catalog descriptions', async () => {
  const catalog = await createExampleCatalog(new URL('..', import.meta.url).pathname);
  for (const [path, format] of [['crystals/SrTiO3.cif', 'cif'], ['crystals/POSCAR-SrTiO3', 'poscar']]) {
    const entry = catalog.examples.find(item => item.path === path);
    assert.equal(entry?.format, format);
    assert.equal(entry.kind, 'file');
    assert.match(entry.detail, /SrTiO3/);
    assert.equal(isSupportedStructurePath(path), true);
    assert.equal(inferStructureFormatFromPath(path), format);
  }
  const entries = ['first.cif', 'second.cif'].map(name => ({ name, size: 10 }));
  assert.equal(catalogLocalSources(entries).sequenceCount, 0);
});

test('CIF content and gzip files enter the existing frame parser with complete symmetry and source properties', async () => {
  const text = await readFile(source, 'utf8');
  const frames = [];
  for (const file of [new File([text], 'unusual.txt'), new File([gzipSync(text)], 'crystal.CIF.gz')]) {
    const format = detectStructureFormatHeader(await readStructureHeader(file));
    assert.equal(format, 'cif');
    const frame = await parseFrameDescriptor({ format, file, index: 0 });
    assert.equal(frame.ids.length, 5);
    assert.equal(frame.frameIndex, 0);
    assert.deepEqual(frame.typeLabels, ['Sr', 'Ti', 'O']);
    assert.ok(frame.positions instanceof Float64Array);
    assert.equal(frame.crystal.symmetryOperations.length, 48);
    assert.equal(frame.crystal.asymmetricSiteCount, 3);
    assert.deepEqual([...frame.summary.typeCounts], [1, 1, 3]);
    assert.deepEqual([...frame.properties.find(property => property.name === 'occupancy').data], [1, 1, 1, 1, 1]);
    frames.push(frame);
  }
  assert.deepEqual(frames[0].fractional, frames[1].fractional);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(parseFrameDescriptor({ format: 'cif', file: new File([text], 'cancel.cif') }, { signal: controller.signal }), { name: 'AbortError' });
});
