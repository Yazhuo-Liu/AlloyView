import test from 'node:test';
import assert from 'node:assert/strict';
import { imageToEps } from '../src/export-eps.js';

test('EPS image has correct bounding box, RGB scan order and opaque alpha composition', async () => {
  const text = await (await imageToEps({ width: 2, height: 1, data: Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0]) })).text();
  assert.ok(text.startsWith('%!PS-Adobe-3.0 EPSF-3.0\n'));
  assert.ok(text.includes('%%BoundingBox: 0 0 2 1'));
  assert.ok(text.includes('[2 0 0 -1 0 1]'));
  assert.ok(text.includes('colorimage\nff0000ffffff\nshowpage\n%%EOF'));
});

test('EPS respects cancellation and rejects incomplete or oversized images', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(imageToEps({ width: 1, height: 1, data: new Uint8Array(4) }, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(imageToEps({ width: 2, height: 1, data: new Uint8Array(4) }), /Invalid/);
});
