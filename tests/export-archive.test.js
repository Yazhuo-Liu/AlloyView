import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, createImageArchive } from '../src/export-archive.js';

test('ZIP stores intact image bytes with matching CRC and directory offsets', async () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(bytes), 0xcbf43926);
  const archive = new Uint8Array(await createImageArchive([{ name: 'frame-1.png', bytes }]).arrayBuffer());
  const view = new DataView(archive.buffer);
  const nameLength = view.getUint16(26, true);
  const directoryOffset = 30 + nameLength + bytes.length;
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(14, true), 0xcbf43926);
  assert.deepEqual(archive.slice(30 + nameLength, directoryOffset), bytes);
  assert.equal(view.getUint32(directoryOffset, true), 0x02014b50);
  assert.equal(view.getUint32(directoryOffset + 42, true), 0);
  assert.equal(view.getUint32(archive.length - 22, true), 0x06054b50);
  assert.equal(view.getUint32(archive.length - 6, true), directoryOffset);
});
