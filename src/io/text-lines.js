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

/** Read Blob ranges or progressive bytes with the same bounded chunk and
 * absolute-offset semantics. Streams announce EOF explicitly. */
export async function* scanByteChunks(blob, { chunkSize = 4 * 1024 * 1024, signal, chunks } = {}) {
  const check = () => {
    if (signal?.aborted) throw new DOMException('Trajectory indexing cancelled.', 'AbortError');
  };
  let offset = 0;
  if (chunks) {
    for await (const bytes of chunks) {
      for (let start = 0; start < bytes.length; start += chunkSize) {
        check();
        const chunk = bytes.subarray(start, Math.min(bytes.length, start + chunkSize));
        const end = offset + chunk.length;
        yield { chunk, offset, end, final: false };
        offset = end;
      }
    }
    check();
    // An explicit EOF lets marker scanners process their tail without waiting
    // for a lookahead read before publishing each preceding complete frame.
    yield { chunk: new Uint8Array(0), offset, end: offset, final: true };
  } else {
    while (offset < blob.size) {
      check();
      const end = Math.min(blob.size, offset + chunkSize);
      const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      check();
      yield { chunk, offset, end, final: end === blob.size };
      offset = end;
    }
  }
}

/** Visit every line as `visit(bytes, from, to, start, end)`: the line,
 * without its newline, is `bytes[from, to)`; `start` and `end` are the file
 * offsets of the line and of the next one. Lines are split at LF only.
 * Indexers decode just the few lines they read as text. */
export async function scanLineBytes(blob, visit, onProgress = () => {}, options = {}) {
  let fragments = [], tailLength = 0;
  const joinTail = (last = new Uint8Array(0)) => {
    const line = new Uint8Array(tailLength + last.length);
    let offset = 0;
    for (const fragment of fragments) { line.set(fragment, offset); offset += fragment.length; }
    line.set(last, offset);
    fragments = []; tailLength = 0;
    return line;
  };
  for await (const { chunk, offset, end } of scanByteChunks(blob, options)) {
    let cursor = 0;
    for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, cursor)) {
      if (tailLength) {
        const start = offset - tailLength;
        const line = joinTail(chunk.subarray(0, newline));
        visit(line, 0, line.length, start, offset + newline + 1);
      } else visit(chunk, cursor, newline, offset + cursor, offset + newline + 1);
      cursor = newline + 1;
    }
    if (cursor < chunk.length) {
      // A long comment/header split over many small gzip chunks is copied
      // once when complete, instead of recopied after every streamed chunk.
      const fragment = chunk.slice(cursor);
      fragments.push(fragment); tailLength += fragment.length;
    }
    onProgress({ loaded: end, total: blob.size });
  }
  if (tailLength) {
    const start = blob.size - tailLength, tail = joinTail();
    visit(tail, 0, tail.length, start, blob.size);
  }
}
