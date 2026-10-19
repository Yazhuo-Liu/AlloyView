/** Serialize state-mutating recipe restoration while keeping the analyses
 * within each recipe parallel. A superseded queued recipe never runs; an
 * already running recipe leaves the slot only after all its work settles. */
export function createConfigurationRestoreQueue() {
  let tail = Promise.resolve();
  return Object.freeze({
    run(restore, { isCurrent = () => true } = {}) {
      const result = tail.then(() => isCurrent() ? restore() : false);
      // A failed recipe must not poison the queue for a later valid one.
      tail = result.then(() => {}, () => {});
      return result;
    },
  });
}

/** Joining every analysis prevents an early rejection from releasing the
 * restoration slot while its other tools still publish state. */
export async function settleConfigurationAnalyses(tasks) {
  const results = await Promise.allSettled(tasks);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}
