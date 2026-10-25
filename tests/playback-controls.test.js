import assert from 'node:assert/strict';
import test from 'node:test';
import { initializePlaybackControls } from '../src/ui/view/playback-controls.js';

function element(value = '') {
  const listeners = new Map();
  return { value, disabled: false, addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: type => listeners.delete(type), dispatch(type, event = {}) { listeners.get(type)?.(event); },
    blur() { this.blurred = true; } };
}

test('playback controls expose bounded fps and explicit complete/preview settings without starting playback', () => {
  const fpsInput = element(), modeInput = element(), summary = element(), playButton = element(), changes = [];
  const state = { enabled: false, playing: false };
  const controls = initializePlaybackControls({ fpsInput, modeInput, summary, playButton,
    getState: () => state, onChange: value => changes.push(value) });
  assert.equal(fpsInput.disabled, true); assert.equal(modeInput.disabled, true);
  assert.equal(fpsInput.min, '0.1'); assert.equal(fpsInput.max, '60');
  assert.equal(summary.textContent, '1 fps · Complete');
  state.enabled = true; controls.refresh(); fpsInput.value = '24'; modeInput.value = 'preview'; modeInput.dispatch('change');
  assert.deepEqual(changes, [{ fps: 24, mode: 'preview' }]);
  assert.deepEqual(controls.getSettings(), { fps: 24, mode: 'preview' });
  controls.setSettings({ fps: 5, mode: 'complete' });
  assert.equal(changes.length, 1, 'restoring settings does not dispatch a user edit');
  assert.equal(playButton.title, 'Play at 5 frames per second (complete results)');
  state.playing = true; controls.refresh(); assert.equal(playButton.title, 'Pause trajectory');
  controls.dispose();
});

test('invalid rate restores the previous setting and Enter commits a valid draft', () => {
  const fpsInput = element(), modeInput = element(), changes = [], errors = [];
  const controls = initializePlaybackControls({ fpsInput, modeInput,
    getState: () => ({ enabled: true }), onChange: value => changes.push(value), notify: message => errors.push(message) });
  fpsInput.value = ''; fpsInput.dispatch('change');
  assert.equal(fpsInput.value, '1'); assert.equal(errors.length, 1); assert.deepEqual(changes, []);
  fpsInput.value = '12.5'; let prevented = false;
  fpsInput.dispatch('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(fpsInput.blurred, true);
  assert.deepEqual(changes, [{ fps: 12.5, mode: 'complete' }]);
  controls.dispose(); fpsInput.value = '20'; fpsInput.dispatch('change'); assert.equal(changes.length, 1);
});

test('frame refresh preserves an actively typed FPS draft and restoration deliberately replaces it', () => {
  const fpsInput = element(), modeInput = element(), documentRoot = { activeElement: fpsInput };
  const controls = initializePlaybackControls({ fpsInput, modeInput, documentRoot, getState: () => ({ enabled: true }) });
  fpsInput.value = '12.'; fpsInput.dispatch('input'); controls.refresh();
  assert.equal(fpsInput.value, '12.');
  controls.setSettings({ fps: 24, mode: 'preview' }); assert.equal(fpsInput.value, '24');
  fpsInput.value = '3'; fpsInput.dispatch('input'); fpsInput.dispatch('blur');
  assert.equal(fpsInput.value, '24'); controls.dispose();
});
