/** Movie export: render a planned sequence of frames through the image
 * export, encode it with WebCodecs and write an MP4 or WebM file, or collect
 * PNG frames in a ZIP archive. The application is reached through a host
 * object, so the pipeline also runs with test doubles. */
import { createImageArchive } from './export-archive.js';
import { planMovie } from './camera-path.js';
import { DEFAULT_MOVIE_OUTPUT, MOVIE_LIMITS, PNG_SEQUENCE_FORMAT } from './movie-settings.js';
import { Mp4Muxer } from './video/mp4-muxer.js';
import { WebmMuxer } from './video/webm-muxer.js';

export * from './movie-settings.js';

function abortError() { return new DOMException('The movie export was cancelled.', 'AbortError'); }
const throwIfAborted = signal => { if (signal?.aborted) throw abortError(); };
/** Give the page a turn. A message task, unlike a timer, is not slowed to
 * one per second while the tab is in the background. */
const pause = () => new Promise(resolve => {
  if (typeof MessageChannel !== 'function') { setTimeout(resolve, 0); return; }
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => { port1.close(); resolve(); };
  port2.postMessage(null);
});

/** Resolve when the encoder has taken work off its queue, or shortly after. */
function encoderProgress(encoder) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); encoder.removeEventListener?.('dequeue', done); resolve(); };
    const timer = setTimeout(done, 50);
    encoder.addEventListener?.('dequeue', done, { once: true });
  });
}

/**
 * Render and encode every frame of a plan.
 *
 * host: getFrameIndex(), showFrame(index) → shown?, setCamera(camera),
 * capture() → canvas, encodeImage(canvas) → PNG bytes (ZIP only),
 * release(canvas). Encoded chunks go straight to the muxer; at most
 * `maxEncodeQueue` frames wait in the encoder, so memory stays bounded by a
 * few images plus the encoded movie.
 */
export async function renderMovie({ plan, format, config = null, keyframeSeconds = DEFAULT_MOVIE_OUTPUT.keyframeSeconds, host,
  signal = null, onProgress = () => {}, limits = MOVIE_LIMITS, fileStem = 'alloyview', now = () => performance.now(),
  VideoEncoderClass = globalThis.VideoEncoder, VideoFrameClass = globalThis.VideoFrame } = {}) {
  const { frameTotal, fps } = plan, started = now();
  if (frameTotal > limits.maxFrames) throw new Error(`A movie has at most ${limits.maxFrames.toLocaleString('en-US')} frames.`);
  const archive = format.id === PNG_SEQUENCE_FORMAT.id;
  if (archive && frameTotal > limits.maxArchiveFrames) throw new Error(`A ZIP of frames holds at most ${limits.maxArchiveFrames} images; this movie has ${frameTotal.toLocaleString('en-US')}.`);
  if (!archive && (typeof VideoEncoderClass !== 'function' || typeof VideoFrameClass !== 'function')) throw new Error('This browser has no WebCodecs video encoder.');
  let failure = null, encoder = null, muxer = null, archiveBytes = 0;
  const entries = [];
  const digits = Math.max(4, String(frameTotal).length);
  if (!archive) {
    const Muxer = format.container === 'mp4' ? Mp4Muxer : WebmMuxer;
    muxer = new Muxer({ width: config.width, height: config.height, frameRate: fps, codec: format.codec, codecString: config.codec });
    encoder = new VideoEncoderClass({
      output: (chunk, metadata) => {
        if (failure) return;
        try {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          muxer.addSample({ data, frame: Math.round(chunk.timestamp * fps / 1e6), key: chunk.type === 'key' }, metadata?.decoderConfig ?? null);
          if (muxer.dataSize > limits.maxBytes) throw new Error('The movie exceeds 2 GiB. Lower the quality, size or duration.');
        } catch (error) { failure = error; }
      },
      error: error => { failure ??= new Error(`The video encoder failed: ${error?.message ?? error}`); },
    });
    encoder.configure(config);
  }
  const keyInterval = Math.max(1, Math.round(keyframeSeconds * fps));
  const frameDuration = Math.round(1e6 / fps);
  try {
    for (let index = 0; index < frameTotal; index++) {
      throwIfAborted(signal);
      if (failure) throw failure;
      const trajectoryFrame = plan.frameAt(index);
      if (trajectoryFrame !== null && trajectoryFrame !== host.getFrameIndex()) {
        // Resolves once the frame's analyses have finished, as in the frame-image export.
        if (!await host.showFrame(trajectoryFrame)) { throwIfAborted(signal); throw new Error(`Could not load frame ${trajectoryFrame + 1}.`); }
        throwIfAborted(signal);
      }
      const camera = plan.cameraAt(index);
      if (camera) host.setCamera(camera);
      const canvas = host.capture();
      try {
        if (archive) {
          const bytes = await host.encodeImage(canvas);
          archiveBytes += bytes.length;
          if (archiveBytes > 256 * 1024 ** 2) throw new Error('The frame archive exceeds 256 MiB. Choose a smaller image size or fewer frames.');
          entries.push({ name: `${fileStem}-${String(index + 1).padStart(digits, '0')}.png`, bytes });
        } else {
          if (canvas.width !== config.width || canvas.height !== config.height) {
            throw new Error('The image size changed during the export. Keep the window size, or choose a fixed image resolution.');
          }
          const frame = new VideoFrameClass(canvas, { timestamp: Math.round(index * 1e6 / fps), duration: frameDuration });
          try { encoder.encode(frame, { keyFrame: index % keyInterval === 0 }); } finally { frame.close(); }
        }
      } finally { host.release?.(canvas); }
      // Backpressure: do not render faster than the encoder accepts frames.
      while (encoder && encoder.encodeQueueSize > limits.maxEncodeQueue && !failure) { await encoderProgress(encoder); throwIfAborted(signal); }
      const elapsedMs = now() - started, done = index + 1;
      onProgress({ frame: done, frameTotal, bytes: archive ? archiveBytes : muxer.dataSize, elapsedMs, etaMs: elapsedMs / done * (frameTotal - done) });
      await pause();
    }
    throwIfAborted(signal);
    if (archive) {
      const blob = createImageArchive(entries);
      return { parts: [blob], size: blob.size, mimeType: format.mimeType, frames: entries.length, durationSeconds: entries.length / fps, elapsedMs: now() - started };
    }
    await encoder.flush();
    if (failure) throw failure;
    throwIfAborted(signal);
    const file = muxer.finalize();
    return { ...file, elapsedMs: now() - started };
  } finally {
    if (encoder && encoder.state !== 'closed') { try { encoder.close(); } catch { /* already closed by an encoder error */ } }
  }
}

/**
 * Export a movie and put the application back as it was. The displayed
 * frame and the camera are restored after success, cancellation and errors,
 * unless the source changed in the meantime.
 *
 * host adds to renderMovie's: stopPlayback(), getSourceVersion(),
 * getFrameCount(), getCamera(), prepare({ signal }).
 */
export async function exportMovie({ path, output, format, config = null, host, signal = null, onProgress = () => {}, limits = MOVIE_LIMITS, ...rest } = {}) {
  host.stopPlayback?.();
  const source = host.getSourceVersion(), originalFrame = host.getFrameIndex(), originalCamera = host.getCamera();
  let started = false;
  try {
    await host.prepare?.({ signal });
    throwIfAborted(signal);
    if (host.getSourceVersion() !== source) throw abortError();
    const plan = planMovie(path, { fps: output.fps, frameCount: host.getFrameCount(),
      maxFrames: format.id === PNG_SEQUENCE_FORMAT.id ? limits.maxArchiveFrames : limits.maxFrames });
    // A source closed or replaced during the export ends it like a cancellation;
    // nothing more is rendered from, or changed in, the new source.
    const current = () => { if (host.getSourceVersion() !== source) throw abortError(); };
    const guarded = { ...host,
      showFrame: async index => { current(); const shown = await host.showFrame(index); current(); return shown; },
      setCamera: camera => { current(); host.setCamera(camera); },
      capture: () => { current(); return host.capture(); } };
    started = true;
    const result = await renderMovie({ plan, format, config, keyframeSeconds: output.keyframeSeconds, host: guarded, signal, onProgress, limits, ...rest });
    return { ...result, plan };
  } finally {
    if (started && host.getSourceVersion() === source) {
      try { if (host.getFrameIndex() !== originalFrame) await host.showFrame(originalFrame); } catch { /* the original frame stays unavailable */ }
      if (host.getSourceVersion() === source) host.setCamera(originalCamera);
    }
  }
}

