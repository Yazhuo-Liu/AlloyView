// Read UTF-8 text in bounded chunks while preserving byte offsets. Trajectory
// indexes retain offsets, rather than the complete decoded trajectory.
export async function* scanTextLines(blob, onProgress = () => {}, { chunkSize = 4 * 1024 * 1024 } = {}) {
  const decoder = new TextDecoder();
  let pending = new Uint8Array(0);
  let lineStart = 0;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const end = Math.min(blob.size, offset + chunkSize);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    let cursor = 0;
    for (let newline = chunk.indexOf(10, cursor); newline >= 0; newline = chunk.indexOf(10, cursor)) {
      let bytes = chunk.subarray(cursor, newline);
      if (pending.length) {
        const joined = new Uint8Array(pending.length + bytes.length);
        joined.set(pending);
        joined.set(bytes, pending.length);
        bytes = joined;
        pending = new Uint8Array(0);
      }
      const absoluteEnd = offset + newline + 1;
      yield { text: decoder.decode(bytes).replace(/\r$/, '').replace(/^\uFEFF/, ''), start: lineStart, end: absoluteEnd };
      lineStart = absoluteEnd;
      cursor = newline + 1;
    }
    if (cursor < chunk.length) {
      const tail = chunk.subarray(cursor);
      const joined = new Uint8Array(pending.length + tail.length);
      joined.set(pending);
      joined.set(tail, pending.length);
      pending = joined;
    }
    onProgress({ loaded: end, total: blob.size });
  }
  if (pending.length) {
    yield { text: decoder.decode(pending).replace(/\r$/, '').replace(/^\uFEFF/, ''), start: lineStart, end: blob.size };
  }
}
