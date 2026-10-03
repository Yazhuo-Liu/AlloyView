const encoder = new TextEncoder();
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

/** ZIP STORE keeps PNGs intact and requires no compression dependency. */
export function createImageArchive(entries) {
  if (entries.length > 500) throw new Error('Export at most 500 images in one archive.');
  const parts = [], directory = [];
  let offset = 0, directorySize = 0;
  for (const { name, bytes } of entries) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Archive entries require image bytes.');
    const filename = encoder.encode(String(name).replace(/[\\/\x00-\x1f]/g, '_'));
    if (!filename.length || filename.length > 65535) throw new Error('Invalid archive filename.');
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + filename.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); // UTF-8
    view.setUint32(14, crc, true);
    view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true);
    view.setUint16(26, filename.length, true); local.set(filename, 30);
    const central = new Uint8Array(46 + filename.length);
    const index = new DataView(central.buffer);
    index.setUint32(0, 0x02014b50, true); index.setUint16(4, 20, true); index.setUint16(6, 20, true);
    index.setUint16(8, 0x0800, true); index.setUint32(16, crc, true);
    index.setUint32(20, bytes.length, true); index.setUint32(24, bytes.length, true);
    index.setUint16(28, filename.length, true); index.setUint32(42, offset, true);
    central.set(filename, 46);
    parts.push(local, bytes); directory.push(central);
    offset += local.length + bytes.length; directorySize += central.length;
  }
  if (offset + directorySize > 256 * 1024 ** 2) throw new Error('The image archive exceeds 256 MiB; export fewer or smaller images.');
  const end = new Uint8Array(22), footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, entries.length, true); footer.setUint16(10, entries.length, true);
  footer.setUint32(12, directorySize, true); footer.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor);
  anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
