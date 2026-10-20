const immutableBytes = new WeakMap();
const abort = signal => { if (signal?.aborted) throw new DOMException('Replication cancelled.', 'AbortError'); };

/** Only IDs constructed by replication enter this cache. Freezing the array
 * makes its byte estimate safe even when a caller retains a frame for years. */
export function retainReplicatedIds(ids, bytes) {
  if (immutableBytes.get(ids) === bytes) return ids;
  Object.freeze(ids);
  immutableBytes.set(ids, bytes);
  return ids;
}

export function retainedIdBytes(ids) { return immutableBytes.get(ids); }

/** One retained layout, rather than one million-string array per frame.
 * Source IDs are checked exactly, including order/type and in-place edits.
 * A private snapshot keeps the comparison independent of caller mutation. */
export class ReplicationIdCache {
  constructor() { this.current = null; this.nextToken = 1; this.generation = 0; }

  clear() { this.current = null; this.generation++; }

  async prepare(ids, repetitions, { signal, yieldTask, maxEncodedCharacters = Infinity,
    memoryLimitError = () => new Error('Physical replication exceeds the memory limit; reduce the repeat counts.') }) {
    const generation = this.generation, current = this.current;
    const key = repetitions.join(':');
    if (current?.key === key && current.sourceIds.length === ids.length) {
      let same = true;
      for (let atom = 0; atom < ids.length; atom++) {
        if (!Object.is(ids[atom], current.sourceIds[atom])) { same = false; break; }
        if ((atom + 1) % 16_384 === 0) { await yieldTask(); abort(signal); }
      }
      if (same) return current;
    }
    const sourceIds = ArrayBuffer.isView(ids) ? new ids.constructor(ids.length) : new Array(ids.length);
    const keys = new Array(ids.length), seen = new Set();
    let encodedCharacters = 0, sourceBytes = sourceIds.byteLength ?? 0;
    for (let atom = 0; atom < ids.length; atom++) {
      const id = ids[atom];
      if (!(typeof id === 'number' && Number.isSafeInteger(id)
        || typeof id === 'string' && id.length && !/[\x00-\x1f\x7f]/.test(id))) {
        throw new Error('Physical replication requires finite, unique atom IDs.');
      }
      const value = String(id);
      if (seen.has(value)) throw new Error('Physical replication requires unique source atom IDs.');
      seen.add(value); sourceIds[atom] = id;
      if (Array.isArray(sourceIds)) sourceBytes += 16 + (typeof id === 'string' ? id.length * 2 : 8);
      const encoded = encodeURIComponent(value);
      encodedCharacters += encoded.length;
      // Reject while keys are still bounded, before retaining a large source
      // worth of escaped strings that the final expansion cannot admit.
      if (encodedCharacters > maxEncodedCharacters) throw memoryLimitError();
      keys[atom] = encoded;
      if ((atom + 1) % 16_384 === 0) { await yieldTask(); abort(signal); }
    }
    abort(signal);
    return { key, sourceIds, sourceBytes, keys, encodedCharacters, generation, token: this.nextToken++ };
  }

  /** A changed layout may need the full allocation budget. Release only the
   * cache's previous owner before building it; pending requests keep their
   * own immutable IDs, and token/generation ordering remains unchanged. */
  makeRoom(entry, allocationBytes, maxBytes) {
    const previous = this.current;
    if (previous && previous !== entry && allocationBytes + previous.bytes + previous.sourceBytes > maxBytes) this.current = null;
  }

  commit(entry, ids, bytes) {
    entry.ids = retainReplicatedIds(ids, bytes); entry.bytes = bytes;
    entry.keys = null;
    if (entry.generation === this.generation) this.current = entry;
  }
}

/** Request-local references survive overlapping replies and cache replacement.
 * A Worker can omit IDs only when this particular request already owns them. */
export class ReplicationIdsReceiver {
  constructor() { this.current = null; }
  clear() { this.current = null; }
  restore(result, known) {
    if (result.idsToken === undefined) return result.frame; // older Worker protocol
    const frame = result.frame;
    const ids = frame.ids ?? (known?.token === result.idsToken ? known.ids : null);
    if (!Array.isArray(ids)) throw new Error('The replication Worker returned unknown atom IDs.');
    if (!Number.isSafeInteger(result.idsBytes) || result.idsBytes < 0) throw new Error('The replication Worker returned invalid ID accounting.');
    frame.ids = retainReplicatedIds(ids, result.idsBytes);
    this.current = { token: result.idsToken, ids: frame.ids };
    return frame;
  }
}
