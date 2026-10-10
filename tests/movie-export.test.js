import assert from 'node:assert/strict';
import test from 'node:test';
import { createCameraPath } from '../src/camera-path.js';
import { DEFAULT_MOVIE_OUTPUT, estimateMovieBytes, exportMovie, movieBitrate, movieRenderSize, MOVIE_LIMITS, MOVIE_QUALITIES, normalizeMovieOutput,
  normalizeMovieState, PNG_SEQUENCE_FORMAT, renderMovie } from '../src/movie-export.js';
import { movieFormat } from '../src/video/codecs.js';
import { formatBytes, formatSeconds } from '../src/movie-controls.js';
import { planMovie } from '../src/camera-path.js';
import { readMp4, readWebm } from './helpers/video-containers.js';

const camera = (yaw = 0) => ({ yaw, pitch: 0.3, roll: 0, fov: 0.7, constrainUp: true, target: [0, 0, 0], pan: [0, 0, 0], distance: 20, orthographicScale: 8, projectionMode: 'perspective' });
const cameraPath = (extra = {}) => ({ ...createCameraPath(), keyframes: [{ time: 0, camera: camera(0), frame: null }, { time: 1, camera: camera(1), frame: null }], ...extra });
const AVCC = Uint8Array.of(1, 0x64, 0, 0x1e, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 1, 0x68);

/** A VideoEncoder double that finishes frames asynchronously, in order. */
function fakeCodec({ delay = 1, failAt = null, description = AVCC } = {}) {
  const state = { encoders: [], openFrames: 0, frames: [], maxQueue: 0 };
  class Frame {
    constructor(canvas, init) { this.canvas = canvas; Object.assign(this, init); state.openFrames++; state.frames.push(this); }
    close() { state.openFrames--; this.closed = true; }
  }
  class Encoder {
    constructor(callbacks) { this.callbacks = callbacks; this.encodeQueueSize = 0; this.state = 'unconfigured'; this.listeners = new Set(); this.encoded = []; this.pending = Promise.resolve(); state.encoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    addEventListener(name, listener) { if (name === 'dequeue') this.listeners.add(listener); }
    removeEventListener(name, listener) { this.listeners.delete(listener); }
    encode(frame, options) {
      assert.equal(this.state, 'configured'); assert.equal(frame.closed, undefined, 'frames are encoded before they are closed');
      const index = this.encoded.length; this.encoded.push({ timestamp: frame.timestamp, duration: frame.duration, keyFrame: options.keyFrame, canvas: frame.canvas });
      this.encodeQueueSize++; state.maxQueue = Math.max(state.maxQueue, this.encodeQueueSize);
      this.pending = this.pending.then(() => new Promise(resolve => setTimeout(resolve, delay))).then(() => {
        if (this.state === 'closed') return;
        this.encodeQueueSize--;
        for (const listener of [...this.listeners]) listener();
        if (index === failAt) { this.state = 'closed'; this.callbacks.error(new Error('device lost')); return; }
        const data = new Uint8Array(40 + index).fill(index + 1);
        this.callbacks.output({ byteLength: data.length, timestamp: frame.timestamp, type: options.keyFrame ? 'key' : 'delta', copyTo: target => target.set(data) },
          index === 0 ? { decoderConfig: { codec: this.config.codec, description } } : {});
      });
    }
    async flush() { await this.pending; }
    close() { this.state = 'closed'; }
  }
  return { state, VideoEncoderClass: Encoder, VideoFrameClass: Frame };
}

/** An application double: a trajectory, a camera and a canvas per capture. */
function fakeHost({ frameCount = 10, size = [320, 240], showFrame = null } = {}) {
  const log = [], app = { frame: 3, camera: camera(9), source: 'a', released: 0, playing: true, prepared: 0 };
  const host = {
    stopPlayback: () => { app.playing = false; }, getSourceVersion: () => app.source, getFrameCount: () => frameCount, getFrameIndex: () => app.frame,
    getCamera: () => structuredClone(app.camera), setCamera: value => { app.camera = structuredClone(value); log.push(['camera', value.yaw]); },
    prepare: async () => { app.prepared++; },
    showFrame: showFrame ?? (async index => { log.push(['frame', index]); app.frame = index; return true; }),
    capture: () => { log.push(['capture', app.frame, app.camera.yaw]); return { width: size[0], height: size[1], id: log.length }; },
    encodeImage: async canvas => Uint8Array.of(0x89, 0x50, 0x4e, 0x47, canvas.id & 255),
    release: () => { app.released++; },
  };
  return { host, log, app };
}
const h264 = movieFormat('mp4-h264'), config = { codec: 'avc1.64001e', width: 320, height: 240, bitrate: 1e6, framerate: 10 };
const bytesOf = async file => new Uint8Array(await new Blob(file.parts).arrayBuffer());

test('a camera path renders every frame in order into a playable MP4 with forced keyframes', async () => {
  const codec = fakeCodec(), { host, log, app } = fakeHost(), progress = [];
  const plan = planMovie(cameraPath(), { fps: 10, frameCount: 10 });
  const file = await renderMovie({ plan, format: h264, config, keyframeSeconds: 0.5, host, onProgress: value => progress.push(value), ...codec });
  const [encoder] = codec.state.encoders;
  assert.equal(encoder.state, 'closed'); assert.deepEqual(encoder.config, config);
  assert.deepEqual(encoder.encoded.map(frame => frame.timestamp), Array.from({ length: 11 }, (_, index) => index * 100_000));
  assert.ok(encoder.encoded.every(frame => frame.duration === 100_000));
  assert.deepEqual(encoder.encoded.map((frame, index) => frame.keyFrame ? index : null).filter(index => index !== null), [0, 5, 10]);
  assert.equal(codec.state.openFrames, 0, 'every VideoFrame is closed'); assert.equal(app.released, 11);
  // The camera is set before each capture; the trajectory frame is left alone.
  assert.deepEqual(log.filter(entry => entry[0] === 'capture').map(entry => entry[2]), Array.from({ length: 11 }, (_, index) => index / 10));
  assert.equal(log.some(entry => entry[0] === 'frame'), false);
  assert.deepEqual(progress.map(value => value.frame), Array.from({ length: 11 }, (_, index) => index + 1));
  assert.ok(progress.every(value => value.frameTotal === 11 && value.etaMs >= 0 && value.elapsedMs >= 0) && progress.at(-1).etaMs === 0);
  const bytes = await bytesOf(file), movie = readMp4(bytes);
  assert.deepEqual([file.frames, file.mimeType, movie.frames.length, movie.width, movie.height, movie.timescale], [11, 'video/mp4', 11, 320, 240, 10 * 512]);
  assert.deepEqual(movie.frames.filter(frame => frame.key).map(frame => frame.time / 512), [0, 5, 10]);
  assert.deepEqual([...movie.configuration.bytes], [...AVCC]);
  for (const [index, frame] of movie.frames.entries()) assert.ok(bytes.subarray(frame.offset, frame.offset + frame.size).every(value => value === index + 1));
});

test('the encoder queue applies backpressure and trajectory frames load only when they change', async () => {
  const codec = fakeCodec({ delay: 4 }), { host, log } = fakeHost({ frameCount: 6 });
  const path = { ...createCameraPath(), frames: { mode: 'rate', first: 1, last: 4, step: 1, rate: 5 } };
  const plan = planMovie(path, { fps: 20, frameCount: 6 });
  const file = await renderMovie({ plan, format: movieFormat('webm-vp9'), config: { ...config, codec: 'vp09.00.10.08', framerate: 20 }, host, ...codec });
  assert.equal(plan.frameTotal, 16);
  assert.ok(codec.state.maxQueue <= MOVIE_LIMITS.maxEncodeQueue + 1, `at most ${MOVIE_LIMITS.maxEncodeQueue + 1} frames queued, saw ${codec.state.maxQueue}`);
  assert.deepEqual(log.filter(entry => entry[0] === 'frame').map(entry => entry[1]), [1, 2, 3, 4], 'each trajectory frame loads once, not once per video frame');
  assert.deepEqual(log.filter(entry => entry[0] === 'capture').map(entry => entry[1]), [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
  assert.equal(log.some(entry => entry[0] === 'camera'), false, 'no keyframes: the camera is not touched');
  const movie = readWebm(await bytesOf(file));
  assert.deepEqual([movie.codecId, movie.frames.length, movie.duration, movie.width], ['V_VP9', 16, 800, 320]);
});

test('cancel, encoder errors and missing frames stop the export and restore frame and camera', async () => {
  const cases = [
    { name: 'cancel', abortAt: 4, expect: { name: 'AbortError' } },
    { name: 'encoder error', codec: { failAt: 2 }, expect: /The video encoder failed: device lost/ },
    { name: 'frame not loaded', showFrame: app => async index => { if (index === 2) return false; app.frame = index; return true; }, expect: /Could not load frame 3/ },
    { name: 'size change', resizeAt: 3, expect: /image size changed during the export/ },
    { name: 'missing configuration', codec: { description: null }, expect: /did not provide its configuration record/ },
  ];
  for (const item of cases) {
    const codec = fakeCodec(item.codec), fake = fakeHost({ frameCount: 8 }), controller = new AbortController();
    if (item.showFrame) fake.host.showFrame = item.showFrame(fake.app);
    const capture = fake.host.capture; let captures = 0;
    fake.host.capture = () => { captures++; const canvas = capture(); if (item.resizeAt === captures) canvas.width = 322; return canvas; };
    const path = cameraPath({ frames: { mode: 'fit', first: 0, last: 7, step: 1, rate: 10 } });
    const onProgress = ({ frame }) => { if (frame === item.abortAt) controller.abort(); };
    await assert.rejects(exportMovie({ path, output: { ...DEFAULT_MOVIE_OUTPUT, fps: 8 }, format: h264, config, host: fake.host, signal: controller.signal, onProgress, ...codec }), item.expect, item.name);
    assert.deepEqual([fake.app.frame, fake.app.camera, fake.app.playing], [3, camera(9), false], `${item.name}: original frame and camera are back`);
    assert.equal(codec.state.encoders[0].state, 'closed', `${item.name}: encoder closed`);
    assert.equal(codec.state.openFrames, 0, `${item.name}: no frame leaked`);
  }
});

test('a finished export restores the view, and a source change during it leaves the new source alone', async () => {
  const codec = fakeCodec(), fake = fakeHost({ frameCount: 8 });
  const path = cameraPath({ frames: { mode: 'fit', first: 0, last: 7, step: 1, rate: 10 } });
  const result = await exportMovie({ path, output: { ...DEFAULT_MOVIE_OUTPUT, fps: 8 }, format: h264, config, host: fake.host, ...codec });
  assert.deepEqual([result.frames, result.plan.frameTotal, fake.app.frame, fake.app.camera, fake.app.prepared], [9, 9, 3, camera(9), 1]);
  assert.deepEqual(fake.log.filter(entry => entry[0] === 'frame').map(entry => entry[1]), [0, 1, 2, 3, 4, 5, 6, 7, 3], 'the last call restores the original frame');
  // Closing or replacing the source cancels without touching the new one.
  const second = fakeCodec(), other = fakeHost({ frameCount: 8 });
  const show = other.host.showFrame;
  other.host.showFrame = async index => { if (index === 2) { other.app.source = 'b'; other.app.frame = 0; other.app.camera = camera(5); } return show(index); };
  await assert.rejects(exportMovie({ path, output: { ...DEFAULT_MOVIE_OUTPUT, fps: 8 }, format: h264, config, host: other.host, ...second }), { name: 'AbortError' });
  assert.equal(other.log.filter(entry => entry[0] === 'capture').length, 2, 'no image is captured from the new source');
  assert.deepEqual([other.app.source, other.app.frame, other.app.camera], ['b', 2, camera(5)], 'nothing was restored into the new source');
  // Plans that cannot be rendered fail before any frame is touched.
  const idle = fakeHost();
  await assert.rejects(exportMovie({ path: createCameraPath(), output: DEFAULT_MOVIE_OUTPUT, format: h264, config, host: idle.host, ...fakeCodec() }), /Nothing moves yet/);
  assert.deepEqual(idle.log, []);
  await assert.rejects(renderMovie({ plan: planMovie(cameraPath(), { fps: 10 }), format: h264, config, host: idle.host, VideoEncoderClass: undefined, VideoFrameClass: undefined }), /no WebCodecs video encoder/);
  await assert.rejects(renderMovie({ plan: { frameTotal: MOVIE_LIMITS.maxFrames + 1, fps: 30 }, format: h264, config, host: idle.host, ...fakeCodec() }), /at most 20,000 frames/);
});

test('PNG frames go into a ZIP archive without an encoder, within its limits', async () => {
  const fake = fakeHost();
  const file = await renderMovie({ plan: planMovie(cameraPath(), { fps: 4 }), format: PNG_SEQUENCE_FORMAT, host: fake.host, fileStem: 'loop', VideoEncoderClass: undefined, VideoFrameClass: undefined });
  const bytes = await bytesOf(file), text = new TextDecoder('latin1').decode(bytes);
  assert.deepEqual([file.frames, file.mimeType, file.size], [5, 'application/zip', bytes.length]);
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  for (let index = 1; index <= 5; index++) assert.ok(text.includes(`loop-000${index}.png`), `entry ${index}`);
  assert.equal(new DataView(bytes.buffer).getUint16(bytes.length - 22 + 10, true), 5, 'five central directory entries');
  assert.equal(fake.app.released, 5);
  const long = { ...createCameraPath(), keyframes: [{ time: 0, camera: camera(0), frame: null }, { time: 20, camera: camera(1), frame: null }] };
  await assert.rejects(exportMovie({ path: long, output: { ...DEFAULT_MOVIE_OUTPUT, fps: 30 }, format: PNG_SEQUENCE_FORMAT, host: fake.host }), /601 frames; the limit is 500/);
  const heavy = fakeHost(); heavy.host.encodeImage = async () => new Uint8Array(100 * 1024 ** 2);
  await assert.rejects(renderMovie({ plan: planMovie(cameraPath(), { fps: 4 }), format: PNG_SEQUENCE_FORMAT, host: heavy.host }), /exceeds 256 MiB/);
});

test('bitrates follow quality presets, and odd sizes become even for video but not for PNG frames', () => {
  const output = { ...DEFAULT_MOVIE_OUTPUT, fps: 30 };
  assert.equal(movieBitrate({ ...output, quality: 'medium' }, 1920, 1080, 'avc'), Math.round(1920 * 1080 * 30 * 0.1));
  assert.equal(movieBitrate({ ...output, quality: 'high' }, 1920, 1080, 'avc'), Math.round(1920 * 1080 * 30 * 0.2));
  assert.equal(movieBitrate({ ...output, quality: 'high' }, 1920, 1080, 'vp9'), Math.round(1920 * 1080 * 30 * 0.2 * 0.7));
  assert.equal(movieBitrate({ ...output, quality: 'custom', bitrateMbps: 3.5 }, 1920, 1080, 'av1'), 3_500_000);
  assert.equal(movieBitrate({ ...output, quality: 'low' }, 16, 16, 'avc'), 100_000, 'never below the minimum');
  assert.equal(movieBitrate({ ...output, quality: 'best', fps: 120 }, 7680, 4320, 'avc'), 400_000_000, 'never above the maximum');
  assert.deepEqual(MOVIE_QUALITIES.map(item => item.id), ['low', 'medium', 'high', 'best', 'custom']);
  assert.equal(estimateMovieBytes(8e6, 10), 10_000_000);
  assert.deepEqual([formatBytes(300), formatBytes(326_000), formatBytes(1_996_456), formatBytes(52_428_800), formatBytes(3 * 1024 ** 3)], ['1 kB', '318 kB', '1.9 MB', '50 MB', '3.00 GB']);
  assert.deepEqual([formatSeconds(0.4), formatSeconds(9.6), formatSeconds(75), formatSeconds(-3)], ['0 s', '10 s', '1 min 15 s', '0 s']);
  const vp9 = movieFormat('webm-vp9');
  assert.deepEqual(movieRenderSize({ mode: 'current' }, 1001, 701, PNG_SEQUENCE_FORMAT), { width: 1001, height: 701, resolution: { mode: 'current' }, adjusted: false });
  assert.deepEqual(movieRenderSize({ mode: 'current' }, 1001, 700, vp9), { width: 1000, height: 700, resolution: { mode: 'custom', width: 1000, height: 700, lockAspect: false }, adjusted: true });
  assert.deepEqual(movieRenderSize({ mode: 'current' }, 1001, 701, h264), { width: 1000, height: 700, resolution: { mode: 'custom', width: 1000, height: 700, lockAspect: false }, adjusted: true });
  assert.deepEqual(movieRenderSize({ mode: 'current' }, 1000, 700, h264), { width: 1000, height: 700, resolution: { mode: 'current' }, adjusted: false });
  assert.deepEqual(movieRenderSize({ mode: '1080p' }, 1001, 701, h264), { width: 1920, height: 1080, resolution: { mode: '1080p' }, adjusted: false });
  assert.deepEqual(movieRenderSize({ mode: 'custom', width: 641, height: 480 }, 1001, 701, h264).resolution, { mode: 'custom', width: 640, height: 480, lockAspect: false });
  assert.deepEqual(movieRenderSize({ mode: '2x' }, 501, 300, h264), { width: 1002, height: 600, resolution: { mode: '2x' }, adjusted: false });
  assert.deepEqual(movieRenderSize(null, 800, 600, h264), { width: 800, height: 600, resolution: { mode: 'current' }, adjusted: false });
  assert.throws(() => movieRenderSize({ mode: 'custom', width: 1, height: 300 }, 800, 600, h264), /at least 2 × 2/);
  assert.throws(() => movieRenderSize({ mode: '4x' }, 4000, 3000, vp9), /32 megapixels/);
});

test('saved movie settings validate strictly and round-trip', () => {
  assert.deepEqual(normalizeMovieOutput(undefined), DEFAULT_MOVIE_OUTPUT);
  assert.deepEqual(normalizeMovieState(undefined), { path: createCameraPath(), output: DEFAULT_MOVIE_OUTPUT });
  const saved = { path: { keyframes: [{ time: 0, camera: camera(0), frame: null }, { time: 4, camera: camera(2), frame: 7 }], easing: 'ease',
    frames: { mode: 'keyframes', first: 0, last: null, step: 1, rate: 10 } }, output: { format: 'webm-vp9', fps: 60, quality: 'custom', bitrateMbps: 20, keyframeSeconds: 1 } };
  const normalized = normalizeMovieState(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(normalized, saved);
  assert.deepEqual(normalizeMovieState(JSON.parse(JSON.stringify(normalized))), normalized);
  assert.equal(normalizeMovieOutput({ format: 'png-zip' }).format, 'png-zip');
  for (const output of [[], { format: 'gif' }, { format: 'constructor' }, { fps: 0 }, { fps: 121 }, { fps: 29.97 }, { fps: '30' }, { quality: 'ultra' }, { bitrateMbps: 0 },
    { bitrateMbps: 401 }, { keyframeSeconds: 0 }, { keyframeSeconds: 11 }, { codec: 'x' }, JSON.parse('{"__proto__":{"fps":1}}')]) {
    assert.throws(() => normalizeMovieOutput(output), /Invalid AlloyView configuration: settings\.extensions\.movie\.output/, JSON.stringify(output));
  }
  for (const state of [[], { path: [] }, { output: 5 }, { script: 'x' }, { path: { keyframes: [{ time: 0 }] } }]) {
    assert.throws(() => normalizeMovieState(state), /Invalid AlloyView configuration: settings\.extensions\.movie/, JSON.stringify(state));
  }
});
