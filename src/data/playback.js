export const DEFAULT_PLAYBACK_INTERVAL_MS = 1000;
export const DEFAULT_PLAYBACK_SETTINGS = Object.freeze({ fps: 1, mode: 'complete' });
export const MIN_PLAYBACK_FPS = 0.1;
export const MAX_PLAYBACK_FPS = 60;

export function normalizePlaybackSettings(value = {}) {
  const fps = value.fps ?? DEFAULT_PLAYBACK_SETTINGS.fps;
  const mode = value.mode ?? DEFAULT_PLAYBACK_SETTINGS.mode;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < MIN_PLAYBACK_FPS || fps > MAX_PLAYBACK_FPS) {
    throw new Error(`Playback rate must be between ${MIN_PLAYBACK_FPS} and ${MAX_PLAYBACK_FPS} frames per second.`);
  }
  if (!['complete', 'preview'].includes(mode)) throw new Error('Playback mode must be complete or preview.');
  return { fps, mode };
}

export function nextPlaybackFrame(currentIndex, frameCount) {
  if (!Number.isInteger(frameCount) || frameCount < 2) return 0;
  return (currentIndex + 1) % frameCount;
}

/** Complete playback waits for the requested formal scene, subtracting its
 * preparation time from the next interval. Preview playback follows a clock
 * and replaces obsolete requests instead of building an analysis queue.
 * navigate must keep any borrowed preview data out of scientific exports. */
export function createPlaybackController({ getState, navigate, onPrepareNext = () => {},
  onStateChange = () => {}, onError = () => {}, settings: initialSettings,
  now = () => performance.now(), setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout } = {}) {
  let settings = normalizePlaybackSettings(initialSettings), playing = false;
  let timer = null, request = 0, pending = null, sourceKey, originTime = 0, originIndex = 0;

  const period = () => 1000 / settings.fps;
  const state = () => getState();
  function clearScheduled() { if (timer !== null) clearTimer(timer); timer = null; }
  function cancelPending() {
    request++;
    pending?.controller.abort();
    pending = null;
  }
  function stop() {
    clearScheduled(); cancelPending();
    if (!playing) return;
    playing = false; onStateChange(false);
  }
  function valid() {
    const current = state();
    if (!playing) return false;
    if (current.sourceKey !== sourceKey || current.count < 2) { stop(); return false; }
    return true;
  }
  function prepare(index) {
    try { Promise.resolve(onPrepareNext(index)).catch(() => {}); } catch { /* Speculation cannot stop playback. */ }
  }
  function schedule(delay) {
    clearScheduled();
    if (!playing) return;
    timer = setTimer(() => {
      timer = null;
      if (!valid()) return;
      if (settings.mode === 'preview') previewStep();
      else void completeStep();
    }, Math.max(0, delay));
  }
  function error(error, invocation) {
    if (!playing || invocation !== request) return;
    stop();
    if (error?.name !== 'AbortError') onError(error);
  }
  async function completeStep() {
    const current = state(), started = now();
    if (current.indexComplete === false && current.index >= current.count - 1) {
      schedule(period()); return;
    }
    const index = nextPlaybackFrame(current.index, current.count);
    const controller = new AbortController(), invocation = ++request;
    pending = { index, controller };
    try {
      const displayed = await navigate(index, { mode: 'complete', signal: controller.signal });
      if (!playing || invocation !== request || !valid()) return;
      pending = null;
      if (displayed === false) { stop(); return; }
      const latest = state();
      prepare(nextPlaybackFrame(latest.index, latest.count));
      schedule(period() - Math.max(0, now() - started));
    } catch (failure) { error(failure, invocation); }
  }
  function previewStep() {
    const current = state(), elapsed = Math.max(0, now() - originTime);
    const steps = Math.max(1, Math.floor((elapsed + 1e-7) / period()));
    const absoluteIndex = originIndex + steps;
    const index = current.indexComplete === false
      ? Math.min(current.count - 1, absoluteIndex) : absoluteIndex % current.count;
    // Schedule by the original clock even if a previous frame is still being
    // decoded. A delayed event-loop callback jumps directly to its newest tick.
    schedule(originTime + (steps + 1) * period() - now());
    if (index === current.index) {
      if (pending && pending.index !== index) cancelPending();
      return;
    }
    if (pending?.index === index) return;
    cancelPending();
    const controller = new AbortController(), invocation = ++request;
    pending = { index, controller };
    prepare(nextPlaybackFrame(index, current.count));
    try {
      Promise.resolve(navigate(index, { mode: 'preview', signal: controller.signal })).then(displayed => {
        if (!playing || invocation !== request || !valid()) return;
        pending = null;
        if (displayed === false) stop();
      }, failure => error(failure, invocation));
    } catch (failure) { error(failure, invocation); }
  }
  function rebase() {
    clearScheduled(); cancelPending();
    const current = state();
    sourceKey = current.sourceKey;
    originIndex = current.index; originTime = now();
    prepare(nextPlaybackFrame(current.index, current.count));
    schedule(period());
  }
  return {
    start() {
      if (playing) return true;
      if (state().count < 2) return false;
      playing = true; rebase(); onStateChange(true); return true;
    },
    stop,
    setSettings(value) {
      const next = normalizePlaybackSettings(value);
      if (next.fps === settings.fps && next.mode === settings.mode) return;
      settings = next;
      if (playing) rebase();
    },
    get settings() { return { ...settings }; },
    get playing() { return playing; },
    dispose: stop,
  };
}
