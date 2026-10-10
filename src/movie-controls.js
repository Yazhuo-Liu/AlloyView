import { addKeyframe as insertKeyframe, applyCamera, cameraPathDuration, captureCamera, createCameraPath, FRAME_RATE_RANGE, MAX_CAMERA_KEYFRAMES,
  moveKeyframe, normalizeCameraPathState, planMovie, removeKeyframe, retimeKeyframe, sampleCameraPath, trajectoryFrameAt } from './camera-path.js';
import { downloadBlob } from './export-archive.js';
import { DEFAULT_MOVIE_OUTPUT, estimateMovieBytes, exportMovie, movieBitrate, movieRenderSize, MOVIE_LIMITS, MOVIE_QUALITIES, normalizeMovieOutput,
  normalizeMovieState, PNG_SEQUENCE_FORMAT } from './movie-export.js';
import { MOVIE_FORMATS, probeMovieFormats } from './video/codecs.js';
import { createAutomationLock, waitUntilSettled } from './script-controls.js';

const canvasBlob = canvas => new Promise((resolve, reject) => canvas.toBlob(
  blob => blob ? resolve(blob) : reject(new Error('Could not encode the image.')), 'image/png'));

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

export function formatSeconds(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return whole >= 60 ? `${Math.floor(whole / 60)} min ${whole % 60} s` : `${whole} s`;
}

/** The Movie panel: camera keyframes, a viewport preview and video export. */
export function initializeMovieControls({ renderer, tools = null, lock = createAutomationLock(), getFrameIndex = () => 0, getFrameCount = () => 1,
  getSourceVersion = () => '', ensureIndexed = async () => {}, showFrame = async () => true, stopPlayback = () => {}, getExportOptions = () => ({}),
  getResolution = () => ({ mode: 'current' }), analysesSettled = () => true,
  prepareExport = async () => {}, getFileStem = () => 'alloyview', onEdit = () => {}, notify = () => {}, documentRoot = globalThis.document,
  VideoEncoderClass = globalThis.VideoEncoder, VideoFrameClass = globalThis.VideoFrame } = {}) {
  const $ = id => documentRoot?.getElementById(id) ?? null;
  const view = documentRoot?.defaultView ?? globalThis;
  const controls = { keyframes: $('movie-keyframes'), add: $('add-movie-keyframe'), clear: $('clear-movie-keyframes'), easing: $('movie-easing'),
    preview: $('preview-movie'), frameMode: $('movie-frame-mode'), frameRange: $('movie-frame-range'), first: $('movie-frame-first'), last: $('movie-frame-last'),
    step: $('movie-frame-step'), rateField: $('movie-frame-rate-field'), rate: $('movie-frame-rate'), format: $('movie-format'), fps: $('movie-fps'),
    quality: $('movie-quality'), bitrateField: $('movie-bitrate-field'), bitrate: $('movie-bitrate'), resolution: $('movie-resolution'),
    keyframeSeconds: $('movie-keyframe-seconds'), summary: $('movie-summary'), exportButton: $('export-movie'), status: $('movie-status'), state: $('movie-state') };
  if (documentRoot && !$('script-movie-styles')) {
    const stylesheet = documentRoot.createElement('link');
    stylesheet.id = 'script-movie-styles'; stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./script-movie.css', import.meta.url).href;
    documentRoot.head?.append(stylesheet);
  }
  const node = (tag, text, className) => { const element = documentRoot.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  const dialog = documentRoot ? node('dialog') : null;
  if (dialog) {
    dialog.id = 'movie-export-dialog'; dialog.className = 'movie-export-dialog'; dialog.setAttribute('aria-labelledby', 'movie-export-title');
    const title = node('h2', 'Exporting movie'); title.id = 'movie-export-title';
    const progress = node('progress'); progress.id = 'movie-progress'; progress.className = 'analysis-progress'; progress.max = 1; progress.value = 0;
    progress.setAttribute('aria-label', 'Movie export progress');
    const text = node('p'); text.id = 'movie-progress-text';
    const cancel = node('button', 'Cancel', 'button button-secondary'); cancel.id = 'cancel-movie'; cancel.type = 'button';
    dialog.append(title, progress, text, node('p', 'The view and frame return to where they were when the export ends.', 'help'), cancel);
    documentRoot.body?.append(dialog);
    // A long render is not thrown away by Escape; Cancel is explicit.
    dialog.addEventListener('cancel', event => event.preventDefault());
  }
  let path = createCameraPath(), output = { ...DEFAULT_MOVIE_OUTPUT }, enabled = false, message = '';
  let formats = [], probeRequest = 0, probeTimer = null, probeStale = true, exporting = null, preview = null, renderedKeyframes = '', toolMarked = false;
  // Encoders are asked only while the panel is open or an export starts, so
  // a session that never makes a movie never touches the video encoder.
  const panel = controls.exportButton?.closest?.('[data-tool-panel]') ?? null;
  const panelOpen = () => !panel || !panel.hidden;
  const busy = () => exporting !== null || preview !== null;
  const frameCount = () => Math.max(1, getFrameCount());
  // The image size is the Display panel's export setting; the menu here edits the same control.
  const resolutionSource = $('export-resolution');

  function setState(text, ready = false) {
    if (!controls.state) return;
    controls.state.textContent = text; controls.state.classList.toggle('ready', ready);
  }

  /** The chosen format entry: an explicit choice if still offered, else the first offered. */
  function chosenFormat() { return formats.find(entry => entry.format.id === output.format) ?? formats[0] ?? null; }

  /** Throws while the Display image size is invalid, for example mid-edit. */
  function sizeFor(format) { return movieRenderSize(getResolution(), renderer.canvas.width, renderer.canvas.height, format); }

  function describePlan() {
    const entry = chosenFormat();
    if (!entry) return { error: 'Checking which video formats this browser can encode…' };
    try {
      const archive = entry.format.id === PNG_SEQUENCE_FORMAT.id;
      const plan = planMovie(path, { fps: output.fps, frameCount: frameCount(), maxFrames: archive ? MOVIE_LIMITS.maxArchiveFrames : MOVIE_LIMITS.maxFrames });
      const size = sizeFor(entry.format);
      const bitrate = archive ? 0 : entry.config.bitrate, bytes = archive ? 0 : estimateMovieBytes(bitrate, plan.movieSeconds);
      return { entry, plan, size, bitrate, bytes, archive };
    } catch (error) { return { entry, error: error.message }; }
  }

  function renderSummary() {
    if (!controls.summary) return;
    const description = describePlan(), unavailable = formats.length > 0 && formats.every(entry => entry.format.id === PNG_SEQUENCE_FORMAT.id);
    const note = unavailable ? ` This browser cannot encode video here (${typeof VideoEncoderClass === 'function' ? 'no supported encoder for this size' : 'WebCodecs is unavailable; it needs a recent browser and a secure page'}), so PNG frames in a ZIP archive are offered instead.` : '';
    // An empty path is the starting point, not a mistake; anything else that blocks an export is marked.
    const started = path.keyframes.length >= 2 || path.frames.mode === 'rate';
    if (description.error) { controls.summary.textContent = `${description.error}${note}`; controls.summary.classList.toggle('error', Boolean(description.entry) && started); }
    else {
      const { plan, size, bitrate, bytes, archive, entry } = description;
      const parts = [`${plan.frameTotal.toLocaleString('en-US')} frames`, `${Number(plan.movieSeconds.toFixed(2))} s at ${output.fps} fps`,
        `${size.width.toLocaleString('en-US')} × ${size.height.toLocaleString('en-US')} pixels${size.adjusted ? ' (made even for video)' : ''}`,
        archive ? 'PNG images' : `${(bitrate / 1e6).toFixed(bitrate < 1e7 ? 1 : 0)} Mbit/s, about ${formatBytes(bytes)}`];
      const large = bytes > MOVIE_LIMITS.warnBytes ? ' This is a very large file: the browser holds the encoded movie until it is saved, so lower the quality or size if it fails.' : '';
      controls.summary.textContent = `${parts.join(' · ')}. ${entry.format.note}${large}${note}`;
      controls.summary.classList.toggle('error', false);
    }
    if (controls.exportButton) {
      controls.exportButton.disabled = !enabled || busy() || Boolean(description.error);
      controls.exportButton.textContent = description.archive ? 'Export frames (ZIP)' : 'Export movie';
    }
    if (controls.preview) controls.preview.disabled = !enabled || exporting !== null || (preview === null && Boolean(previewError()));
  }

  function previewError() {
    try { planMovie(path, { fps: 30, frameCount: frameCount() }); return null; } catch (error) { return error.message; }
  }

  function renderFormats() {
    if (!controls.format) return;
    const signature = JSON.stringify(formats.map(entry => entry.format.id));
    if (controls.format.dataset.signature !== signature) {
      controls.format.replaceChildren(...formats.map(entry => { const option = node('option', entry.format.label); option.value = entry.format.id; return option; }));
      controls.format.dataset.signature = signature;
    }
    const chosen = chosenFormat();
    if (chosen) controls.format.value = chosen.format.id;
  }

  /** Ask the encoder which formats work at the current size, rate and quality. */
  async function probe() {
    const request = ++probeRequest;
    probeStale = false;
    const candidates = [];
    for (const format of MOVIE_FORMATS) {
      try {
        const size = sizeFor(format), bitrate = movieBitrate(output, size.width, size.height, format.codec);
        candidates.push({ format, size, bitrate });
      } catch { /* a size beyond the image limits is reported by the summary */ }
    }
    const results = [];
    for (const { format, size, bitrate } of candidates) {
      const [entry] = await probeMovieFormats({ width: size.width, height: size.height, fps: output.fps, bitrate, formats: [format], VideoEncoderClass });
      if (request !== probeRequest) return;
      if (entry.supported && typeof VideoFrameClass === 'function') results.push(entry);
    }
    formats = [...results, { format: PNG_SEQUENCE_FORMAT, supported: true, config: null, reason: '' }];
    if (controls.format) controls.format.dataset.pending = 'false';
    renderFormats(); renderSummary();
  }

  function scheduleProbe() {
    clearTimeout(probeTimer);
    if (controls.format) controls.format.dataset.pending = 'true';
    if (!panelOpen()) { probeStale = true; return; }
    probeTimer = setTimeout(() => { void probe(); }, 120);
  }

  function renderKeyframes() {
    if (!controls.keyframes) return;
    const active = enabled && !busy(), signature = JSON.stringify([active, path.frames.mode, path.keyframes.map(keyframe => [keyframe.time, keyframe.frame])]);
    if (signature === renderedKeyframes) return;
    renderedKeyframes = signature;
    if (!path.keyframes.length) {
      controls.keyframes.replaceChildren(node('p', 'No keyframes yet. Turn the view to the first pose and select Add keyframe; repeat for each pose.', 'help'));
      return;
    }
    controls.keyframes.replaceChildren(...path.keyframes.map((keyframe, index) => {
      const row = node('div', undefined, 'movie-keyframe'); row.setAttribute('role', 'listitem'); row.dataset.keyframe = String(index);
      const time = node('input'); time.type = 'number'; time.min = '0'; time.max = '3600'; time.step = '0.1'; time.value = String(keyframe.time);
      time.disabled = !active; time.setAttribute('aria-label', `Keyframe ${index + 1} time in seconds`);
      time.addEventListener('change', () => edit(() => { path.keyframes = retimeKeyframe(path.keyframes, index, time.valueAsNumber); }));
      const label = node('span', `${index + 1}`, 'movie-keyframe-index');
      // The saved trajectory frame matters only when the movie uses it.
      const unit = node('span', path.frames.mode !== 'keyframes' || keyframe.frame === null ? 's' : `s · frame ${keyframe.frame + 1}`, 'movie-keyframe-unit');
      const button = (text, name, action, disabled = false) => {
        const item = node('button', text); item.type = 'button'; item.disabled = !active || disabled; item.title = name;
        item.setAttribute('aria-label', `${name} (keyframe ${index + 1})`); item.dataset.action = text; item.addEventListener('click', action); return item;
      };
      row.append(label, time, unit,
        button('Go', 'Show this view', () => showKeyframe(index)),
        button('Set', 'Replace with the current view', () => edit(() => {
          path.keyframes = path.keyframes.map((item, position) => position === index ? { ...item, camera: captureCamera(renderer), frame: getFrameIndex() } : item);
        })),
        button('↑', 'Swap view with the earlier keyframe', () => edit(() => { path.keyframes = moveKeyframe(path.keyframes, index, -1); }), index === 0),
        button('↓', 'Swap view with the later keyframe', () => edit(() => { path.keyframes = moveKeyframe(path.keyframes, index, 1); }), index === path.keyframes.length - 1),
        button('×', 'Delete', () => edit(() => { path.keyframes = removeKeyframe(path.keyframes, index); })));
      return row;
    }));
  }

  function render() {
    const active = enabled && !busy(), mode = path.frames.mode;
    renderKeyframes();
    if (controls.add) controls.add.disabled = !active || path.keyframes.length >= MAX_CAMERA_KEYFRAMES;
    if (controls.clear) controls.clear.disabled = !active || !path.keyframes.length;
    for (const element of [controls.easing, controls.frameMode, controls.first, controls.last, controls.step, controls.rate, controls.format, controls.fps,
      controls.quality, controls.bitrate, controls.keyframeSeconds]) if (element) element.disabled = !active;
    if (controls.resolution) {
      controls.resolution.disabled = !active;
      const current = resolutionSource?.value ?? 'current';
      if (controls.resolution.value !== current) controls.resolution.value = current;
    }
    if (controls.easing) controls.easing.value = path.easing;
    if (controls.frameMode) {
      controls.frameMode.value = mode;
      // A single frame has nothing to play.
      for (const option of controls.frameMode.options) option.disabled = option.value !== 'current' && frameCount() < 2 && option.value !== mode;
    }
    if (controls.frameRange) controls.frameRange.hidden = mode !== 'rate' && mode !== 'fit';
    if (controls.rateField) controls.rateField.hidden = mode !== 'rate';
    const focused = documentRoot.activeElement;
    const setNumber = (element, value) => { if (element && element !== focused) element.value = String(value); };
    setNumber(controls.first, path.frames.first + 1); setNumber(controls.last, (path.frames.last ?? frameCount() - 1) + 1);
    setNumber(controls.step, path.frames.step); setNumber(controls.rate, path.frames.rate);
    for (const element of [controls.first, controls.last]) if (element) element.max = String(frameCount());
    setNumber(controls.fps, output.fps); setNumber(controls.bitrate, output.bitrateMbps); setNumber(controls.keyframeSeconds, output.keyframeSeconds);
    if (controls.quality) controls.quality.value = output.quality;
    if (controls.bitrateField) controls.bitrateField.hidden = output.quality !== 'custom';
    if (controls.preview) controls.preview.textContent = preview ? 'Stop preview' : 'Preview';
    renderFormats(); renderSummary();
    if (controls.status) controls.status.textContent = message || (!enabled ? 'Open a structure to record a movie.'
      : path.keyframes.length ? `${path.keyframes.length} keyframe${path.keyframes.length === 1 ? '' : 's'} over ${Number(cameraPathDuration(path).toFixed(3))} s. Preview plays the path in the viewport.`
        : 'Add keyframes for a camera move, or choose trajectory frames to play.');
    const marked = path.keyframes.length > 0;
    if (marked !== toolMarked) { toolMarked = marked; tools?.setToolEnabled('movie', marked); }
  }

  /** Apply one user edit; invalid input is reported and leaves the path unchanged. */
  function edit(change, { reprobe = false } = {}) {
    if (busy()) return;
    try { onEdit(); change(); message = ''; setState('Idle'); }
    catch (error) { notify(error.message); renderedKeyframes = ''; }
    render();
    if (reprobe) scheduleProbe();
  }

  function showKeyframe(index) {
    const keyframe = path.keyframes[index];
    if (!keyframe || busy()) return;
    onEdit();
    applyCamera(renderer, keyframe.camera);
    if (path.frames.mode === 'keyframes' && keyframe.frame !== null && keyframe.frame < frameCount() && keyframe.frame !== getFrameIndex()) void showFrame(keyframe.frame);
  }

  function addKeyframe({ time = null } = {}) {
    if (!renderer.frame) throw new Error('No structure is displayed.');
    path.keyframes = insertKeyframe(path.keyframes, captureCamera(renderer), { time, frame: getFrameIndex() });
    message = ''; render();
  }

  function clearKeyframes() { path.keyframes = []; message = ''; render(); }

  function readFrames() {
    const count = frameCount();
    const whole = (element, fallback, minimum, maximum) => {
      const value = element?.valueAsNumber;
      if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Enter a whole number from ${minimum} to ${maximum}.`);
      return value ?? fallback;
    };
    const first = whole(controls.first, 1, 1, count) - 1, lastValue = whole(controls.last, count, 1, count) - 1;
    if (lastValue < first) throw new Error('The last frame must not be before the first.');
    const rate = controls.rate?.valueAsNumber;
    if (!(rate >= FRAME_RATE_RANGE[0] && rate <= FRAME_RATE_RANGE[1])) throw new Error(`Enter a trajectory rate from ${FRAME_RATE_RANGE[0]} to ${FRAME_RATE_RANGE[1]} frames per second.`);
    // "Last frame" at the end of the trajectory follows a trajectory that grows.
    path.frames = { ...path.frames, first, last: lastValue === count - 1 ? null : lastValue, step: whole(controls.step, 1, 1, 1_000_000), rate };
  }

  function readOutput() {
    const next = normalizeMovieOutput({ ...output, fps: controls.fps?.valueAsNumber, quality: controls.quality?.value ?? output.quality,
      bitrateMbps: controls.bitrate?.valueAsNumber, keyframeSeconds: controls.keyframeSeconds?.valueAsNumber });
    output = next;
  }

  function stopPreview({ restore = true } = {}) {
    const task = preview;
    if (!task) return;
    preview = null;
    view.cancelAnimationFrame?.(task.request);
    task.release();
    for (const [name, listener] of task.listeners) renderer.canvas.removeEventListener(name, listener);
    if (restore && getSourceVersion() === task.source) {
      applyCamera(renderer, task.camera);
      if (getFrameIndex() !== task.frame) void showFrame(task.frame);
    }
    message = restore ? '' : 'Preview stopped at this pose.'; setState('Idle'); render();
  }

  /** Play the path in real time in the viewport. Frames appear as they load. */
  function startPreview() {
    if (busy() || !enabled) return;
    let plan;
    try { plan = planMovie(path, { fps: 30, frameCount: frameCount() }); } catch (error) { notify(error.message); return; }
    const release = lock.acquire('movie');
    if (!release) { notify('Stop the running script first.'); return; }
    stopPlayback();
    const stopHere = () => stopPreview({ restore: false });
    const task = { release, source: getSourceVersion(), camera: captureCamera(renderer), frame: getFrameIndex(), started: null, loading: false,
      listeners: [['pointerdown', stopHere], ['wheel', stopHere]], request: 0 };
    for (const [name, listener] of task.listeners) renderer.canvas.addEventListener(name, listener, { passive: true });
    preview = task;
    const tick = now => {
      if (preview !== task) return;
      if (getSourceVersion() !== task.source) { stopPreview({ restore: false }); return; }
      task.started ??= now;
      const time = Math.min(plan.duration, (now - task.started) / 1000);
      const camera = sampleCameraPath(path, time);
      if (camera) applyCamera(renderer, camera);
      const frame = trajectoryFrameAt(path, time, { frameCount: frameCount(), duration: plan.duration });
      if (frame !== null && frame !== getFrameIndex() && !task.loading) {
        task.loading = true;
        Promise.resolve(showFrame(frame)).catch(() => false).then(() => { task.loading = false; });
      }
      if (controls.status) controls.status.textContent = `Preview ${time.toFixed(1)} / ${Number(plan.duration.toFixed(2))} s`;
      if (time >= plan.duration) { stopPreview(); return; }
      task.request = view.requestAnimationFrame(tick);
    };
    setState('Preview'); render();
    task.request = view.requestAnimationFrame(tick);
  }

  async function runExport() {
    if (busy() || !enabled) return;
    const release = lock.acquire('movie');
    if (!release) { notify('Stop the running script first.'); return; }
    const controller = new AbortController();
    exporting = { controller };
    // Ask the encoder again, so its configuration matches the settings and viewport of this moment.
    clearTimeout(probeTimer);
    await probe();
    const description = describePlan();
    if (description.error || controller.signal.aborted) { exporting = null; release(); render(); if (description.error) notify(description.error); return; }
    const { entry, size } = description;
    const snapshot = normalizeCameraPathState(JSON.parse(JSON.stringify(path))), settings = { ...output }, stem = getFileStem();
    const progressBar = $('movie-progress'), progressText = $('movie-progress-text'), cancel = $('cancel-movie');
    const onCancel = () => { controller.abort(); if (progressText) progressText.textContent = 'Cancelling…'; };
    message = ''; setState('Exporting…');
    if (progressBar) progressBar.value = 0;
    if (progressText) progressText.textContent = 'Preparing…';
    cancel?.addEventListener('click', onCancel);
    render();
    // A modal dialog keeps stray clicks and shortcuts from changing the scene mid-export.
    try { dialog?.showModal(); } catch { /* an open dialog elsewhere: continue without the modal */ }
    let lastText = 0;
    try {
      const result = await exportMovie({ path: snapshot, output: settings, format: entry.format, config: entry.config, fileStem: stem, signal: controller.signal,
        VideoEncoderClass, VideoFrameClass,
        host: {
          stopPlayback, getSourceVersion, getFrameCount: frameCount, getFrameIndex, showFrame,
          getCamera: () => captureCamera(renderer), setCamera: camera => applyCamera(renderer, camera),
          // Analyses still running for the displayed frame finish before the first image.
          prepare: async ({ signal }) => { await ensureIndexed({ signal }); await prepareExport({ signal }); await waitUntilSettled(analysesSettled, { signal }); },
          // Movies have no transparency: the background is always drawn, as for JPG.
          capture: () => renderer.captureImage({ ...getExportOptions(), includeBackground: true, resolution: size.resolution }),
          encodeImage: async canvas => new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer()),
          release: canvas => { canvas.width = canvas.height = 1; },
        },
        onProgress: ({ frame, frameTotal, bytes, elapsedMs, etaMs }) => {
          if (progressBar) progressBar.value = frame / frameTotal;
          const now = performance.now();
          if (progressText && (now - lastText > 200 || frame === frameTotal) && !controller.signal.aborted) {
            lastText = now;
            progressText.textContent = `Frame ${frame.toLocaleString('en-US')} of ${frameTotal.toLocaleString('en-US')} · ${formatBytes(bytes)} · ${formatSeconds(elapsedMs / 1000)} elapsed${frame < frameTotal ? ` · about ${formatSeconds(etaMs / 1000)} left` : ''}`;
          }
        } });
      const name = `${stem}${entry.format.id === PNG_SEQUENCE_FORMAT.id ? '-movie-frames' : '-movie'}.${entry.format.extension}`;
      downloadBlob(new Blob(result.parts, { type: result.mimeType }), name);
      message = `Saved ${name}: ${result.frames.toLocaleString('en-US')} frames, ${Number(result.durationSeconds.toFixed(2))} s, ${formatBytes(result.size)}, rendered in ${formatSeconds(result.elapsedMs / 1000)}.`;
      setState('Saved', true);
    } catch (error) {
      if (error?.name === 'AbortError') { message = 'Movie export cancelled. The view and frame were restored.'; setState('Cancelled'); }
      else { message = `Movie export failed: ${error?.message ?? error}`; setState('Failed'); notify(message); }
    } finally {
      cancel?.removeEventListener('click', onCancel);
      if (dialog?.open) dialog.close();
      exporting = null; release();
      render(); scheduleProbe();
    }
  }

  if (controls.quality && !controls.quality.options.length) {
    controls.quality.replaceChildren(...MOVIE_QUALITIES.map(quality => { const option = node('option', quality.label); option.value = quality.id; return option; }));
  }
  controls.add?.addEventListener('click', () => edit(() => addKeyframe()));
  controls.clear?.addEventListener('click', () => edit(() => clearKeyframes()));
  controls.easing?.addEventListener('change', () => edit(() => { path.easing = controls.easing.value === 'ease' ? 'ease' : 'linear'; }));
  controls.preview?.addEventListener('click', () => { if (preview) stopPreview(); else startPreview(); });
  controls.frameMode?.addEventListener('change', () => edit(() => {
    const mode = controls.frameMode.value;
    path.frames = normalizeCameraPathState({ frames: { ...path.frames, mode } }).frames;
    renderedKeyframes = '';
  }));
  for (const element of [controls.first, controls.last, controls.step, controls.rate]) element?.addEventListener('change', () => edit(readFrames));
  for (const element of [controls.fps, controls.quality, controls.bitrate, controls.keyframeSeconds]) {
    element?.addEventListener('change', () => edit(() => { try { readOutput(); } catch { throw new Error('Enter a frame rate from 1 to 120, a bitrate from 0.1 to 400 Mbit/s and a seek interval from 0.1 to 10 s.'); } }, { reprobe: true }));
  }
  controls.format?.addEventListener('change', () => edit(() => { output.format = normalizeMovieOutput({ format: controls.format.value }).format; }));
  controls.resolution?.addEventListener('change', () => {
    if (!resolutionSource || busy()) return;
    resolutionSource.value = controls.resolution.value;
    resolutionSource.dispatchEvent(new view.Event('change', { bubbles: true }));
  });
  const onResolution = () => { render(); scheduleProbe(); };
  for (const id of ['export-resolution', 'export-width', 'export-height', 'export-aspect-lock']) $(id)?.addEventListener('change', onResolution);
  const observer = typeof view.ResizeObserver === 'function' && renderer?.canvas ? new view.ResizeObserver(() => { if (!busy()) onResolution(); }) : null;
  observer?.observe(renderer.canvas);
  const panelObserver = panel && typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => { if (panelOpen() && probeStale) scheduleProbe(); }) : null;
  panelObserver?.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  controls.exportButton?.addEventListener('click', () => void runExport());
  render(); scheduleProbe();

  return Object.freeze({
    addKeyframe, clearKeyframes, startPreview, stopPreview, exportMovie: runExport, probe,
    hasKeyframes: () => path.keyframes.length > 0,
    isBusy: busy,
    getState: () => ({ path: normalizeCameraPathState(JSON.parse(JSON.stringify(path))), output: { ...output } }),
    getFormats: () => formats.map(entry => ({ id: entry.format.id, config: entry.config ? { ...entry.config } : null })),
    /** Called when the frame count changes. */
    refresh() { if (!busy()) render(); },
    /** A new or closed source: keyframes belong to the previous structure. */
    reset() {
      stopPreview({ restore: false }); exporting?.controller.abort();
      path = createCameraPath(); message = ''; renderedKeyframes = '';
      setState('Idle'); render();
    },
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) { stopPreview({ restore: false }); exporting?.controller.abort(); }
      renderedKeyframes = ''; render(); scheduleProbe();
    },
    /** Saved only when used, so other configurations are unchanged. */
    serialize() {
      const changed = path.keyframes.length || path.easing !== 'linear' || path.frames.mode !== 'current' || JSON.stringify(output) !== JSON.stringify(DEFAULT_MOVIE_OUTPUT);
      return changed ? { path: normalizeCameraPathState(JSON.parse(JSON.stringify(path))), output: { ...output } } : undefined;
    },
    /** Replace the camera path and output settings with validated saved ones. */
    restore(saved) {
      stopPreview({ restore: false });
      const state = normalizeMovieState(saved ?? {});
      path = state.path; output = state.output; message = ''; renderedKeyframes = '';
      setState('Idle'); render(); scheduleProbe();
    },
    dispose() { stopPreview({ restore: false }); exporting?.controller.abort(); observer?.disconnect(); panelObserver?.disconnect(); clearTimeout(probeTimer); dialog?.remove(); },
  });
}
