/** A request remains cancelled after parsing, including while imported
 * properties are attached. Cache retention does not revive its work. Snapshot
 * checks also invalidate preparations when the source/replication changes. */
export function framePreparationSignal(signal, isCurrent = () => true) {
  return {
    get aborted() { return Boolean(signal?.aborted) || !isCurrent(); },
    addEventListener: (...args) => signal?.addEventListener?.(...args),
    removeEventListener: (...args) => signal?.removeEventListener?.(...args),
  };
}
