// Read UTF-8 text in bounded chunks while preserving byte offsets. Trajectory
// indexes retain offsets, rather than the complete decoded trajectory.

const lineDecoder = new TextDecoder();

/** A line's text: its bytes decoded alone, without a trailing carriage
 * return or a leading byte order mark. */
export function lineText(bytes) {
  return lineDecoder.decode(bytes).replace(/\r$/, '').replace(/^\uFEFF/, '');
}

/** Whether the text of the line in `bytes[from, to)` is empty after
 * `trim()`. UTF-8 decodes every ASCII byte to that same character, so one
 * ASCII byte that `trim()` keeps proves the line is not blank; only other
 * lines need decoding. */
export function isBlankLine(bytes, from = 0, to = bytes.length) {
  let ascii = true;
  for (let index = from; index < to; index++) {
    const byte = bytes[index];
    if (byte >= 0x80) ascii = false;
    else if (byte !== 32 && (byte < 9 || byte > 13)) return false;
  }
  return ascii || !lineText(bytes.subarray(from, to)).trim();
}

/** Visit every line as `visit(bytes, from, to, start, end)`: the line,
 * without its newline, is `bytes[from, to)`; `start` and `end` are the file
 * offsets of the line and of the next one. Lines are split at LF only.
 * Indexers decode just the few lines they read as text. */
export async function scanLineBytes(blob, visit, onProgress = () => {}, { chunkSize = 4 * 1024 * 1024 } = {}) {
  let tail = new Uint8Array(0);
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const end = Math.min(blob.size, offset + chunkSize);
    let chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    if (tail.length) {
      const joined = new Uint8Array(tail.length + chunk.length);
      joined.set(tail);
      joined.set(chunk, tail.length);
      chunk = joined;
    }
    const base = offset - tail.length;
    let cursor = 0;
    for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, cursor)) {
      visit(chunk, cursor, newline, base + cursor, base + newline + 1);
      cursor = newline + 1;
    }
    tail = chunk.slice(cursor);
    onProgress({ loaded: end, total: blob.size });
  }
  if (tail.length) visit(tail, 0, tail.length, blob.size - tail.length, blob.size);
}
