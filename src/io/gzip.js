// gzip-compressed structure files. Files are recognized by the gzip magic
// bytes (1f 8b), not by their names, and are decompressed with the platform
// DecompressionStream. Format detection and parsing then see the
// decompressed content, exactly as for an uncompressed file.
//
// Memory: a trajectory whose frames are read in any order (LAMMPS dump, XYZ,
// PDB) is decompressed once into a Blob (decompressToFile). The Worker copies
// the output into the Blob in bounded parts, so its own heap holds at most one
// part at a time; the browser keeps the Blob data, which Chromium moves to
// disk when large and other browsers may keep in memory. Single-frame files
// (CFG, LAMMPS data, POSCAR), including the files of a CFG sequence, are
// decompressed whenever they are read (readFileBytes), so only the file being
// parsed is held, as for uncompressed files.
//
// DecompressionStream accepts one gzip member. Files made by concatenating
// members (appending to a .gz file, bgzip) are rejected with an error.

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const PART_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;

// Each Blob read is a round trip to the browser's file storage, so a file is
// read once per use and its gzip flag is remembered from any read of its start.
const gzipFlags = new WeakMap();

function rememberGzip(file, head) {
  const gzip = head[0] === GZIP_MAGIC_0 && head[1] === GZIP_MAGIC_1;
  gzipFlags.set(file, gzip);
  return gzip;
}

/** Whether the file starts with the gzip magic bytes. */
export async function isGzipFile(file) {
  const known = gzipFlags.get(file);
  if (known !== undefined) return known;
  if (!(file.size >= 2)) return false;
  return rememberGzip(file, new Uint8Array(await file.slice(0, 2).arrayBuffer()));
}

/** Reject a gzip file early when the browser lacks DecompressionStream. */
export async function assertGzipSupported(file) {
  if (typeof DecompressionStream !== 'function' && await isGzipFile(file)) throw unsupportedError(file);
}

function unsupportedError(file) {
  return new Error(`“${file.name}” is gzip-compressed, but this browser cannot decompress gzip data. Decompress the file before opening it.`);
}

function decompressedStream(file, compressed = file.slice(0, file.size)) {
  if (typeof DecompressionStream !== 'function') throw unsupportedError(file);
  // A File cloned from another realm may lack stream(); its slice() is a Blob.
  return compressed.stream().pipeThrough(new DecompressionStream('gzip'));
}

function decompressionError(file, error) {
  const detail = error?.message ? `: ${error.message}` : '.';
  return new Error(`“${file.name}” could not be decompressed as a single gzip stream${detail}`);
}

/**
 * The first `limit` bytes of a file as text, decompressed if the file is
 * gzip-compressed; this is what format detection inspects. Like
 * `file.slice(0, limit).text()`, a character cut at the end decodes to U+FFFD.
 * A damaged or truncated gzip file yields the text decompressed before the
 * damage; opening it reports the error.
 */
export async function readStructureHeader(file, limit = HEADER_BYTES) {
  const head = new Uint8Array(await file.slice(0, limit).arrayBuffer());
  if (!rememberGzip(file, head) || typeof DecompressionStream !== 'function') {
    // TextDecoder decodes as Blob.text() does.
    return new TextDecoder().decode(head);
  }
  const reader = decompressedStream(file).getReader();
  const header = new Uint8Array(limit);
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const count = Math.min(value.length, limit - length);
      header.set(value.subarray(0, count), length);
      length += count;
    }
  } catch {
    // Keep what was decompressed before the damage.
  } finally {
    reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(header.subarray(0, length));
}

/** The complete contents of a file, decompressed if it is gzip-compressed. */
export async function readFileBytes(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!rememberGzip(file, bytes)) return bytes;
  const stream = decompressedStream(file, new Blob([bytes]));
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (error) {
    throw decompressionError(file, error);
  }
}

/** The complete text of a file, decompressed if it is gzip-compressed; the
 * same text as `file.text()` for an uncompressed file. */
export async function readFileText(file) {
  return new TextDecoder().decode(await readFileBytes(file));
}

/**
 * A File with the decompressed contents and the name of `file`, or `file`
 * itself if it is not gzip-compressed. Blob.slice() on the result gives random
 * access to the decompressed data.
 */
export async function decompressToFile(file, { partBytes = PART_BYTES } = {}) {
  if (!(await isGzipFile(file))) return file;
  const reader = decompressedStream(file).getReader();
  const parts = [];
  // Blob() copies its parts, so one staging buffer is reused.
  const staging = new Uint8Array(partBytes);
  let filled = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.length;) {
        const count = Math.min(value.length - offset, staging.length - filled);
        staging.set(value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === staging.length) {
          parts.push(new Blob([staging]));
          filled = 0;
        }
      }
    }
  } catch (error) {
    throw decompressionError(file, error);
  }
  if (filled > 0) parts.push(new Blob([staging.subarray(0, filled)]));
  return new File(parts, file.name, { lastModified: file.lastModified });
}
