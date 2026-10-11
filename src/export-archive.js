const encoder = new TextEncoder();
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

const MAX_ARCHIVE_BYTES = 256 * 1024 ** 2;
const checkSignal = signal => { if (signal?.aborted) throw new DOMException('Image archive export cancelled.', 'AbortError'); };

/** Prepare each ZIP record alongside its rendered frame. Blob snapshots keep
 * the image immutable and let callers release their raw PNG arrays promptly.
 * Finishing only joins prepared records and the small central directory; it
 * never revisits image bytes or performs all frames' CRC work in one task. */
export class ImageArchiveBuilder {
  constructor({ maxBytes = MAX_ARCHIVE_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 22 || maxBytes > MAX_ARCHIVE_BYTES) throw new Error('Invalid image archive byte budget.');
    this.maxBytes = maxBytes;
    this.parts = []; this.directory = [];
    this.offset = 0; this.directorySize = 0;
  }

  get count() { return this.parts.length; }
  get size() { return this.offset + this.directorySize + 22; }

  add({ name, bytes }, { signal } = {}) {
    checkSignal(signal);
    if (this.count >= 500) throw new Error('Export at most 500 images in one archive.');
    if (!(bytes instanceof Uint8Array)) throw new Error('Archive entries require image bytes.');
    const filename = encoder.encode(String(name).replace(/[\\/\x00-\x1f]/g, '_'));
    if (!filename.length || filename.length > 65535) throw new Error('Invalid archive filename.');
    // Reject before CRC, record allocation or copying the image into a Blob.
    if (this.size + bytes.length + 76 + filename.length * 2 > this.maxBytes) throw new Error('The image archive exceeds 256 MiB; export fewer or smaller images.');
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
    index.setUint16(28, filename.length, true); index.setUint32(42, this.offset, true);
    central.set(filename, 46);
    checkSignal(signal);
    this.parts.push(new Blob([local, bytes])); this.directory.push(central);
    this.offset += local.length + bytes.length; this.directorySize += central.length;
    return this.count;
  }

  finish({ signal } = {}) {
    checkSignal(signal);
    const end = new Uint8Array(22), footer = new DataView(end.buffer);
    footer.setUint32(0, 0x06054b50, true);
    footer.setUint16(8, this.count, true); footer.setUint16(10, this.count, true);
    footer.setUint32(12, this.directorySize, true); footer.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.directory, end], { type: 'application/zip' });
  }

  clear() { this.parts.length = this.directory.length = 0; this.offset = this.directorySize = 0; }
}

/** ZIP STORE keeps PNGs intact and requires no compression dependency. */
export function createImageArchive(entries) {
  if (entries.length > 500) throw new Error('Export at most 500 images in one archive.');
  const archive = new ImageArchiveBuilder();
  for (const entry of entries) archive.add(entry);
  return archive.finish();
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor);
  anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
