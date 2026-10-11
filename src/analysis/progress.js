const callbackErrors = new WeakSet();
export const isAnalysisProgressError = error => error !== null
  && (typeof error === 'object' || typeof error === 'function') && callbackErrors.has(error);

/** Coalesce browser progress before callers format text or update controls.
 * Scientific work and Worker admission never wait for the next paint. */
export function createAnalysisProgressReporter(callback, { environment = globalThis, signal } = {}) {
  const requestFrame = environment.requestAnimationFrame?.bind(environment);
  const cancelFrame = environment.cancelAnimationFrame?.bind(environment);
  const setTimer = environment.setTimeout?.bind(environment) ?? setTimeout;
  const clearTimer = environment.clearTimeout?.bind(environment) ?? clearTimeout;
  let pending, frameHandle = null, timerHandle = null, previousPhase = null;
  let closed = false, callbackError = null, reportedAtoms = false;
  const clearScheduled = () => {
    if (frameHandle !== null) cancelFrame?.(frameHandle);
    if (timerHandle !== null) clearTimer(timerHandle);
    frameHandle = timerHandle = null;
  };
  const deliver = progress => {
    if (closed || signal?.aborted) return;
    if (callbackError) throw callbackError;
    try { callback(progress); } catch (error) {
      callbackError = error !== null && (typeof error === 'object' || typeof error === 'function')
        ? error : new Error(String(error), { cause: error });
      callbackErrors.add(callbackError);
      throw callbackError;
    }
  };
  const flush = () => {
    clearScheduled();
    if (callbackError) throw callbackError;
    const latest = pending; pending = undefined;
    if (latest !== undefined) deliver(latest);
  };
  const scheduledFlush = () => {
    // A callback failure is rethrown by the next report or final flush, so it
    // rejects the analysis instead of becoming an unhandled animation task.
    try { flush(); } catch (error) { callbackError = error; }
  };
  const close = () => {
    closed = true; pending = undefined; clearScheduled();
    signal?.removeEventListener('abort', close);
  };
  signal?.addEventListener('abort', close, { once: true });
  const report = progress => {
    if (closed || signal?.aborted) return;
    if (callbackError) throw callbackError;
    const phase = [progress.backend, progress.phase, progress.stage, progress.cpuStage,
      progress.fallbackReason, progress.threadingFallback].join('|');
    const terminal = progress.phase === 'complete' || progress.phase === 'completed'
      || progress.phase === 'failed' || progress.phase === 'cancelled';
    const firstAtoms = !reportedAtoms && progress.completedAtoms > 0;
    if (progress.completedAtoms > 0) reportedAtoms = true;
    if (!requestFrame || previousPhase !== phase || terminal || firstAtoms) {
      clearScheduled(); pending = undefined; previousPhase = phase;
      deliver(progress); return;
    }
    pending = progress;
    if (frameHandle === null) {
      frameHandle = requestFrame(scheduledFlush);
      // Background tabs can suspend animation frames. Keep their progress and
      // callback-driven cancellation live without waiting for visibility.
      timerHandle = setTimer(scheduledFlush, 80);
    }
  };
  return { report, flush, close };
}

/** Keep the atom-progress clock across ranges of the same Worker analysis.
 * Completion of a range is reported by its result message; only the last
 * source range needs an immediate final atom update. */
export function createAtomProgressThrottle({ now = () => performance.now(), intervalMs = 80, maxEntries = 64 } = {}) {
  const clocks = new Map();
  return (key, { final = false } = {}) => {
    const time = now(), previous = clocks.get(key);
    if (previous !== undefined && !final && time - previous < intervalMs) return false;
    clocks.delete(key); clocks.set(key, time);
    if (clocks.size > maxEntries) clocks.delete(clocks.keys().next().value);
    return true;
  };
}
