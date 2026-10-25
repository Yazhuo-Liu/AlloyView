import { MAX_PLAYBACK_FPS, MIN_PLAYBACK_FPS, normalizePlaybackSettings } from '../../data/playback.js';

/** Settings are independent of the active source and never start playback as
 * a side effect of restoring a recipe. The application owns navigation. */
export function initializePlaybackControls({ fpsInput, modeInput, summary, playButton,
  getState = () => ({ enabled: false, playing: false }), onChange = () => {},
  notify = () => {}, settings: initialSettings, documentRoot = globalThis.document } = {}) {
  let settings = normalizePlaybackSettings(initialSettings), editingRate = false;
  const listeners = [];
  const listen = (element, name, handler) => {
    element?.addEventListener(name, handler);
    listeners.push(() => element?.removeEventListener(name, handler));
  };
  function refresh({ force = false } = {}) {
    const { enabled, playing } = getState();
    if (fpsInput) {
      fpsInput.min = String(MIN_PLAYBACK_FPS); fpsInput.max = String(MAX_PLAYBACK_FPS); fpsInput.step = '0.1';
      fpsInput.disabled = !enabled;
      if (force || !editingRate || documentRoot?.activeElement !== fpsInput) fpsInput.value = String(settings.fps);
    }
    if (modeInput) { modeInput.disabled = !enabled; modeInput.value = settings.mode; }
    if (summary) summary.textContent = `${settings.fps} fps · ${settings.mode === 'complete' ? 'Complete' : 'Preview'}`;
    if (playButton) {
      playButton.title = playing ? 'Pause trajectory' : `Play at ${settings.fps} frames per second (${settings.mode === 'complete' ? 'complete results' : 'quick preview'})`;
    }
  }
  function setSettings(value, { emit = false } = {}) {
    const next = normalizePlaybackSettings(value);
    const changed = next.fps !== settings.fps || next.mode !== settings.mode;
    settings = next; editingRate = false; refresh({ force: true });
    if (changed && emit) onChange({ ...settings });
  }
  function change() {
    try { setSettings({ fps: Number(fpsInput.value), mode: modeInput.value }, { emit: true }); }
    catch (error) { editingRate = false; notify(error.message); refresh({ force: true }); }
  }
  listen(fpsInput, 'input', () => { editingRate = true; });
  listen(fpsInput, 'blur', () => { editingRate = false; refresh({ force: true }); });
  listen(fpsInput, 'change', change);
  listen(modeInput, 'change', change);
  listen(fpsInput, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); change(); fpsInput.blur?.(); } });
  refresh();
  return { getSettings: () => ({ ...settings }), setSettings, refresh,
    dispose() { for (const remove of listeners) remove(); } };
}
