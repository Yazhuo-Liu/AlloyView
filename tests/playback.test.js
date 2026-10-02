import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_PLAYBACK_INTERVAL_MS, nextPlaybackFrame } from '../src/data/playback.js';

test('trajectory playback defaults to one second per frame and loops', () => {
  assert.equal(DEFAULT_PLAYBACK_INTERVAL_MS, 1000);
  assert.equal(nextPlaybackFrame(0, 40), 1);
  assert.equal(nextPlaybackFrame(39, 40), 0);
});
