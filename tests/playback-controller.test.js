import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackController, normalizePlaybackSettings } from '../src/data/playback.js';

async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function fakeClock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) { const handle = ++id; timers.set(handle, { callback, at: time + Math.max(0, delay) }); return handle; },
    clearTimer(handle) { timers.delete(handle); },
    async advance(duration) {
      const end = time + duration;
      for (;;) {
        const [handle, entry] = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0] ?? [];
        if (!entry || entry.at > end) break;
        timers.delete(handle); time = entry.at; entry.callback(); await settle();
      }
      time = end; await settle();
    },
    get size() { return timers.size; },
  };
}

test('complete playback subtracts preparation from the next frame interval', async () => {
  const clock = fakeClock(), current = { index: 0, count: 5, sourceKey: 1 }, events = [];
  const player = createPlaybackController({ ...clock, getState: () => current,
    navigate(index, { mode, signal }) {
      events.push({ index, at: clock.now(), mode, signal });
      return new Promise(resolve => clock.setTimer(() => { current.index = index; resolve(true); }, 600));
    } });
  player.start();
  await clock.advance(1000);
  assert.deepEqual(events.map(({ index, at, mode }) => ({ index, at, mode })), [{ index: 1, at: 1000, mode: 'complete' }]);
  await clock.advance(600);
  assert.equal(current.index, 1);
  await clock.advance(399);
  assert.equal(events.length, 1);
  await clock.advance(1);
  assert.deepEqual(events.map(event => event.at), [1000, 2000]);
  player.stop();
  assert.equal(events[1].signal.aborted, true);
});

test('complete playback under load proceeds immediately after a finished frame without piling up requests', async () => {
  const clock = fakeClock(), current = { index: 0, count: 5, sourceKey: 'folder' }, events = [];
  const player = createPlaybackController({ ...clock, getState: () => current,
    navigate(index) {
      events.push({ index, at: clock.now() });
      return new Promise(resolve => clock.setTimer(() => { current.index = index; resolve(true); }, 1500));
    } });
  player.start(); await clock.advance(2500);
  assert.deepEqual(events, [{ index: 1, at: 1000 }, { index: 2, at: 2500 }]);
  player.stop();
});

test('preview playback replaces overdue requests and late abandoned completion cannot stop playback', async () => {
  const clock = fakeClock(), current = { index: 0, count: 10, sourceKey: 1 }, requests = [];
  const player = createPlaybackController({ ...clock, settings: { fps: 2, mode: 'preview' }, getState: () => current,
    navigate(index, options) { return new Promise(resolve => requests.push({ index, ...options, resolve })); } });
  player.start(); await clock.advance(1500);
  assert.deepEqual(requests.map(entry => entry.index), [1, 2, 3]);
  assert.deepEqual(requests.map(entry => entry.signal.aborted), [true, true, false]);
  requests[0].resolve(false); await settle();
  assert.equal(player.playing, true);
  current.index = 3; requests[2].resolve(true); await settle();
  await clock.advance(500);
  assert.equal(requests.at(-1).index, 4);
  player.stop();
  assert.equal(requests.at(-1).signal.aborted, true);
  assert.equal(clock.size, 0);
});

test('preview uses elapsed time to skip ticks delayed by a busy event loop', async () => {
  let time = 0, callback;
  const current = { index: 0, count: 10, sourceKey: 1 }, indices = [];
  const player = createPlaybackController({ getState: () => current, settings: { fps: 2, mode: 'preview' }, now: () => time,
    setTimer(fn) { callback = fn; return 1; }, clearTimer() {},
    navigate(index) { indices.push(index); current.index = index; return Promise.resolve(true); } });
  player.start(); time = 1750; callback(); await settle();
  assert.deepEqual(indices, [3]);
  player.stop();
});

test('a source change aborts the old request and stops its timers', async () => {
  const clock = fakeClock(), current = { index: 0, count: 5, sourceKey: 1 }, signals = [], states = [];
  const player = createPlaybackController({ ...clock, settings: { mode: 'preview' }, getState: () => current,
    navigate(index, { signal }) { signals.push(signal); return new Promise(() => {}); }, onStateChange: value => states.push(value) });
  player.start(); await clock.advance(1000);
  current.sourceKey = 2; await clock.advance(1000);
  assert.equal(player.playing, false); assert.equal(signals[0].aborted, true); assert.equal(clock.size, 0);
  assert.deepEqual(states, [true, false]);
});

test('progressive source waits at the indexed end rather than looping early', async () => {
  const clock = fakeClock(), current = { index: 1, count: 2, indexComplete: false, sourceKey: 1 }, indices = [];
  const player = createPlaybackController({ ...clock, getState: () => current,
    navigate(index) { indices.push(index); current.index = index; return Promise.resolve(true); } });
  player.start(); await clock.advance(2000); assert.deepEqual(indices, []);
  current.count = 3; await clock.advance(1000); assert.deepEqual(indices, [2]);
  current.indexComplete = true; await clock.advance(1000); assert.deepEqual(indices, [2, 0]);
  player.stop();
});

test('editing playback settings rebases its clock and validates fps and modes', async () => {
  const clock = fakeClock(), current = { index: 0, count: 5, sourceKey: 1 }, events = [];
  const player = createPlaybackController({ ...clock, getState: () => current,
    navigate(index) { events.push({ index, at: clock.now() }); current.index = index; return Promise.resolve(true); } });
  player.start(); await clock.advance(250); player.setSettings({ fps: 4, mode: 'preview' });
  await clock.advance(250); assert.deepEqual(events, [{ index: 1, at: 500 }]);
  assert.deepEqual(player.settings, { fps: 4, mode: 'preview' });
  assert.throws(() => player.setSettings({ fps: 0 }), /Playback rate/);
  assert.deepEqual(player.settings, { fps: 4, mode: 'preview' });
  player.stop();
  for (const value of [{ fps: 61 }, { fps: NaN }, { fps: '2' }, { mode: 'unknown' }]) assert.throws(() => normalizePlaybackSettings(value));
});

test('formal navigation failure stops once and reports its real error', async () => {
  const clock = fakeClock(), errors = [];
  const player = createPlaybackController({ ...clock, getState: () => ({ index: 0, count: 3, sourceKey: 1 }),
    navigate() { throw new Error('Frame unavailable'); }, onError: error => errors.push(error.message) });
  player.start(); await clock.advance(2000);
  assert.equal(player.playing, false); assert.deepEqual(errors, ['Frame unavailable']); assert.equal(clock.size, 0);
});
