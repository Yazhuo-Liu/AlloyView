import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Production UI on a small LAMMPS trajectory: an FCC crystal (3 × 3 × 3 cells,
// 108 atoms) stretched along x by 4% per frame for 6 frames, with a per-atom
// column c_pe. Scripts drive the camera and frames; movies of a camera path
// across the trajectory are exported in every format the browser's
// VideoEncoder supports, re-read by an independent container parser and
// decoded again with VideoDecoder and a <video> element.
//
//   --keep <directory>   also write the exported movies there
//   --timing             add a 1920 × 1080, 120-frame export of examples/fixed_end_climb
//   --hardware           use the real GPU for WebGL instead of SwiftShader
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const keepIndex = process.argv.indexOf('--keep'), keep = keepIndex >= 0 ? resolve(process.argv[keepIndex + 1]) : null;
const timing = process.argv.includes('--timing');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-movies-'));
const fixture = 'movie-fixture.dump', fixturePath = resolve(temporary, fixture);
const FRAMES = 6, LATTICE = 3.52, CELLS = 3, LENGTH = LATTICE * CELLS;
function fccFrame(frame) {
  const scale = 1 + 0.04 * frame, lines = [];
  let id = 1;
  for (let i = 0; i < CELLS; i++) for (let j = 0; j < CELLS; j++) for (let k = 0; k < CELLS; k++) {
    for (const [x, y, z] of [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]]) {
      lines.push(`${id} ${1 + id % 2} ${(i + x) * LATTICE * scale} ${(j + y) * LATTICE} ${(k + z) * LATTICE} ${10 * frame + id % 2}`);
      id++;
    }
  }
  return ['ITEM: TIMESTEP', String(100 * frame), 'ITEM: NUMBER OF ATOMS', String(lines.length), 'ITEM: BOX BOUNDS pp pp pp',
    `0 ${LENGTH * scale}`, `0 ${LENGTH}`, `0 ${LENGTH}`, 'ITEM: ATOMS id type x y z c_pe', ...lines, ''].join('\n');
}
await writeFile(fixturePath, Array.from({ length: FRAMES }, (_, frame) => fccFrame(frame)).join(''));
const scriptFile = resolve(temporary, 'imported tour.txt');
await writeFile(scriptFile, '﻿# imported\r\ncamera view bottom\r\nframe last\r\n');
const DEGREE = Math.PI / 180;
const MAGENTA = '#ff00ff';
const SCRIPT = ['# drive the camera, the frame and the colors', 'camera view top', 'frame 3', 'camera orbit 30 -20', 'camera zoom 2', 'color-by c_pe',
  'projection perspective', 'camera.yaw-left', 'keyframe clear', 'keyframe 0', 'repeat 2', '  camera orbit 45 0', 'end', 'keyframe', 'export png shot'].join('\n');
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} ≈ ${expected}`);
const run = promisify(execFile);
const ffprobe = await run('ffprobe', ['-version']).then(() => true, () => false);

async function ffprobeFile(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height,nb_read_frames,avg_frame_rate:format=duration', '-of', 'json', path]);
  const { streams: [stream], format } = JSON.parse(stdout);
  return { codec: stream.codec_name, width: stream.width, height: stream.height, frames: Number(stream.nb_read_frames), rate: stream.avg_frame_rate, duration: Number(format.duration) };
}

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    async function waitFor(expression, label, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(40); }
      throw new Error(`${label}: ${await evaluate(`JSON.stringify({ toast: document.getElementById('toast')?.textContent,
        script: document.getElementById('script-status')?.textContent, scriptError: document.getElementById('script-error')?.textContent,
        movie: document.getElementById('movie-status')?.textContent, summary: document.getElementById('movie-summary')?.textContent,
        progress: document.getElementById('movie-progress-text')?.textContent, recipe: document.getElementById('configuration-status')?.textContent })`)}`);
    }
    async function open(path = 'dist/index.html') {
      await call('Page.navigate', { url: `${origin}/AlloyView/${path}` });
      await waitFor('document.readyState === "complete" && document.getElementById("export-movie") && document.getElementById("run-script")', 'Application startup');
      await evaluate(`(${installChecks.toString()})(${JSON.stringify(`${origin}/AlloyView/tests/helpers/video-containers.js`)})`);
      await waitFor('window.movieChecks?.ready', 'Check modules');
      await evaluate('if(document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true")document.getElementById("enable-gpu-computing").click()');
    }
    async function setFiles(selector, files) {
      const { root: dom } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: dom.nodeId, selector });
      await call('DOM.setFileInputFiles', { nodeId, files });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event("change",{bubbles:true}))`);
    }
    async function loadFixture() {
      await setFiles('#file-input', [fixturePath]);
      await waitFor(`movieChecks.renderer?.frame?.ids.length === 108 && document.getElementById('loading').hidden
        && document.getElementById('frame-count').textContent === '${FRAMES}' && !document.getElementById('run-script').closest('section').querySelector('#script-text').disabled`, 'Fixture load');
    }
    const change = (id, value, event = 'change') => evaluate(`movieChecks.change(${JSON.stringify(id)},${JSON.stringify(value)},${JSON.stringify(event)})`);
    const showTool = name => evaluate(`movieChecks.showTool(${JSON.stringify(name)})`);
    const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const text = id => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
    const camera = () => evaluate('movieChecks.camera()');
    const frameIndex = () => evaluate('movieChecks.renderer.frame.frameIndex');
    async function download(action, label, timeoutMs = 300_000) {
      await evaluate('movieChecks.beginDownload()');
      try { await action(); await waitFor('Boolean(movieChecks.download?.blob)', `${label} download`, timeoutMs); return await evaluate('movieChecks.finishDownload()'); }
      finally { await evaluate('movieChecks.restoreDownload()'); }
    }
    async function runScript(source, expectedState = 'Finished') {
      await change('script-text', source, 'input');
      await click('run-script');
      await waitFor(`document.getElementById('script-state').textContent === ${JSON.stringify(expectedState)}`, `Script ${expectedState}`);
    }

    await open();
    await loadFixture();

    // ── Scripts: errors are located and nothing runs ──────────────────────
    await showTool('scripts');
    const before = await camera();
    await change('script-text', 'camera view top\nframe 99x\ncamera orbit 10', 'input');
    await click('check-script');
    const problem = await evaluate(`({ error: document.getElementById('script-error').textContent, hidden: document.getElementById('script-error').hidden,
      invalid: document.getElementById('script-text').getAttribute('aria-invalid'), selection: [document.getElementById('script-text').selectionStart, document.getElementById('script-text').selectionEnd],
      state: document.getElementById('script-state').textContent, status: document.getElementById('script-status').textContent })`);
    assert.match(problem.error, /^Line 2, column 7: The frame must be one of: first, last, next, prev\. \(1 more problem\)$/);
    assert.deepEqual([problem.hidden, problem.invalid, problem.selection, problem.state], [false, 'true', [22, 25], 'Problems']);
    await click('run-script');
    await delay(150);
    assert.deepEqual(await camera(), before, 'a script with problems does not run');
    assert.match(await text('script-status'), /Fix 2 problems/);
    // Text that looks like code is an unknown command or a plain argument.
    await evaluate('window.__scriptProbe = 0');
    await change('script-text', 'constructor\n__proto__ 1\nalert(1)\nwindow.__scriptProbe=1', 'input');
    await click('check-script');
    assert.match(await text('script-error'), /Line 1: Unknown command “constructor”\. \(3 more problems\)/);
    await runScript('color-by "${window.__scriptProbe=1}"', 'Failed');
    assert.match(await text('script-error'), /Line 1: No color quantity “\$\{window\.__scriptProbe=1\}”\. Available: type, /);
    assert.equal(await evaluate('window.__scriptProbe'), 0, 'script text is never evaluated');

    // ── Scripts: camera, frame, color, keyframes and an image ─────────────
    const shot = await download(() => runScript(SCRIPT), 'Script image');
    assert.equal(shot.filename, 'shot.png'); assert.equal(shot.type, 'image/png');
    const after = await camera();
    assert.equal(await frameIndex(), 2); assert.equal(await text('frame-label'), `3 / ${FRAMES}`);
    near(after.yaw, (30 + 5 + 90) * DEGREE, 1e-9, 'azimuth: orbit 30, one keyboard step of 5 at gear 5, two orbits of 45');
    near(after.pitch, 70 * DEGREE, 1e-9, 'elevation: top view lowered by 20');
    assert.deepEqual([after.projectionMode, after.constrainUp], ['perspective', true]);
    const topScale = await evaluate('movieChecks.resetScale()');
    near(after.orthographicScale, topScale / 2, 1e-9 * topScale, 'zoom 2 halves the parallel field');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:c_pe');
    assert.match(await text('script-status'), /^Finished: 15 commands in [\d.]+ s, 1 image downloaded\.$/);
    const keyframes = await evaluate('movieChecks.keyframes()');
    assert.deepEqual(keyframes.map(keyframe => keyframe.time), [0, 2]);
    near(keyframes[0].camera.yaw, 35 * DEGREE, 1e-9, 'first keyframe'); near(keyframes[1].camera.yaw, 125 * DEGREE, 1e-9, 'second keyframe');
    assert.deepEqual(keyframes.map(keyframe => keyframe.frame), [2, 2]);
    assert.equal(await evaluate('document.querySelector("[data-tool-button=movie] .tool-enabled-dot").hidden'), false, 'Movie tool is marked while keyframes exist');
    // Keyboard command names, awaited frame steps and run-time errors with their line.
    await runScript('frames.first\nframes.next\nframes.next\nwait-analyses\ncamera.reset');
    assert.equal(await frameIndex(), 2);
    await runScript('frame last\nframe next', 'Failed');
    assert.match(await text('script-error'), /^Line 2: This is already the last frame \(6\)\.$/);
    assert.deepEqual(await evaluate('[document.getElementById("script-text").selectionStart, document.getElementById("script-text").selectionEnd]'), [11, 21]);
    assert.equal(await frameIndex(), FRAMES - 1);
    await runScript('frames.next', 'Failed');
    assert.match(await text('script-error'), /“frames\.next” is not available now/);
    // wait-analyses holds the next command until a running analysis has finished.
    await change('script-text', 'wait-analyses\nexport png analysed', 'input');
    const analysed = await download(() => evaluate(`document.getElementById('run-cna').click(); movieChecks.stateAtStart = document.getElementById('cna-state').textContent;
      document.getElementById('run-script').click()`), 'Image after the analysis');
    assert.deepEqual([analysed.filename, await evaluate('movieChecks.stateAtStart'), analysed.states.cna], ['analysed.png', 'Calculating…', 'Calculated']);
    await waitFor('document.getElementById("script-state").textContent === "Finished"', 'Script after analyses');
    await showTool('scripts');
    // Stop interrupts a wait at once.
    await change('script-text', 'camera view left\nwait 30\ncamera view right', 'input');
    await click('run-script');
    await waitFor('document.getElementById("script-state").textContent === "Running…" && !document.getElementById("stop-script").disabled', 'Script running');
    assert.equal(await evaluate('document.getElementById("script-text").disabled && document.getElementById("run-script").disabled'), true, 'the editor is locked while running');
    const stopStart = Date.now();
    await click('stop-script');
    await waitFor('document.getElementById("script-state").textContent === "Stopped"', 'Script stopped');
    assert.ok(Date.now() - stopStart < 3000, 'Stop does not wait for the script');
    assert.match(await text('script-status'), /Stopped at line 2/);
    near((await camera()).yaw, -90 * DEGREE, 1e-9, 'the command after the wait never ran');
    // Examples insert text; an imported file becomes a new script and does not run.
    await change('script-text', '', 'input');
    await change('script-example', 'turntable');
    assert.match(await evaluate('document.getElementById("script-text").value'), /^# Four keyframes[\s\S]*repeat 4\n {2}camera orbit 90 0/);
    const beforeImport = await camera();
    await setFiles('#script-file', [scriptFile]);
    await waitFor('document.getElementById("script-state").textContent === "Imported"', 'Script import');
    assert.deepEqual(await evaluate('[document.getElementById("script-name").value, document.getElementById("script-text").value, document.getElementById("script-list").options.length]'),
      ['imported tour', '# imported\ncamera view bottom\nframe last\n', 2]);
    assert.deepEqual(await camera(), beforeImport, 'importing a script does not run it');
    const exported = await download(() => click('export-script'), 'Script text');
    assert.deepEqual([exported.filename, exported.text], ['movie-fixture-imported tour.txt', '# imported\ncamera view bottom\nframe last\n']);
    await click('insert-script-view');
    const inserted = (await evaluate('document.getElementById("script-text").value')).split('\n').find(line => line.startsWith('camera set'));
    assert.match(inserted, /^camera set azimuth -90 elevation 0 distance [\d.]+ fov 40 field-height [\d.]+ center [-\d.]+ [-\d.]+ [-\d.]+ projection orthographic upright on$/);
    // The inserted line restores the view exactly after the camera moved away.
    const pose = await camera();
    await runScript(`camera view top\ncamera zoom 3\ncamera pan 2 1\n${inserted}`);
    const restoredPose = await camera();
    for (const key of ['yaw', 'pitch', 'distance', 'orthographicScale', 'fov']) near(restoredPose[key], pose[key], 1e-9 * Math.max(1, Math.abs(pose[key])), `camera set restores ${key}`);
    pose.target.forEach((value, axis) => near(restoredPose.target[axis] + restoredPose.pan[axis], value + pose.pan[axis], 1e-9, `camera set restores the center ${axis}`));

    // ── Configuration: scripts and the camera path are saved, never run ───
    await runScript(SCRIPT);
    const recipe = await download(() => click('export-configuration'), 'Configuration');
    const saved = JSON.parse(recipe.text);
    assert.deepEqual(saved.settings.extensions.scripts.scripts.map(script => script.name), ['Script 1', 'imported tour']);
    assert.equal(saved.settings.extensions.scripts.scripts.find(script => script.name === 'imported tour').text, SCRIPT);
    assert.deepEqual(saved.settings.extensions.movie.path.keyframes.map(keyframe => keyframe.time), [0, 2]);
    await runScript('keyframe clear\ncamera view bottom\nframe 1');
    const beforeRestore = await camera();
    const tampered = structuredClone(saved);
    tampered.settings.camera = null; tampered.source.frameIndex = 0;
    tampered.settings.extensions.scripts = { scripts: [{ id: 'evil', name: 'Auto', text: 'camera view top\nexport png stolen' }], selectedId: 'evil' };
    await evaluate('movieChecks.beginDownload()');
    await evaluate(`movieChecks.importRecipe(${JSON.stringify(JSON.stringify(tampered))})`);
    await waitFor('document.getElementById("configuration-status").textContent.startsWith("Configuration restored")', 'Configuration restore');
    await delay(300);
    assert.equal(await evaluate('movieChecks.download'), null, 'a restored script downloads nothing');
    await evaluate('movieChecks.restoreDownload()');
    near((await camera()).pitch, beforeRestore.pitch, 1e-12, 'a restored script is not run');
    assert.deepEqual(await evaluate('[document.getElementById("script-name").value, document.getElementById("script-text").value, document.getElementById("script-state").textContent]'),
      ['Auto', 'camera view top\nexport png stolen', 'Idle']);
    assert.match(await text('script-status'), /Scripts restored\. Review the commands, then select Run\./);
    assert.deepEqual((await evaluate('movieChecks.keyframes()')).map(keyframe => keyframe.time), [0, 2], 'the camera path is restored');
    for (const [label, mutate, pattern] of [
      ['unknown script key', value => { value.settings.extensions.scripts.scripts[0].autorun = true; }, /scripts\[0\]\.autorun is not a supported setting/],
      ['oversized script', value => { value.settings.extensions.scripts.scripts[0].text = 'x'.repeat(20001); }, /scripts\[0\]\.text must be text of at most 20000/],
      ['keyframe order', value => { value.settings.extensions.movie.path.keyframes[1].time = 0; }, /keyframes\[1\]\.time must be later/],
      ['frame rate', value => { value.settings.extensions.movie.output.fps = 1000; }, /output\.fps must be a finite integer from 1 to 120/],
    ]) {
      const invalid = structuredClone(saved); mutate(invalid);
      await evaluate(`document.getElementById('toast').hidden = true; movieChecks.importRecipe(${JSON.stringify(JSON.stringify(invalid))})`);
      await waitFor('!document.getElementById("toast").hidden', `${label} rejected`);
      assert.match(await text('toast'), pattern, label);
    }

    // ── Movie: formats offered are those the encoder supports ─────────────
    await showTool('textLabels');
    await click('add-text-label');
    await change('text-label-text', 'FCC [CNA.FCC.fraction:.1%] · [Frame]', 'input');
    await change('text-label-size', 22);
    await change('text-label-box', 'custom');
    await change('text-label-box-color', MAGENTA, 'input');
    await showTool('display');
    await change('export-resolution', 'custom');
    await change('export-aspect-lock', false);
    await change('export-width', 321); await change('export-height', 241);
    await change('png-background', true); await change('png-legend', true); await change('png-axes', true);
    await showTool('movie');
    await change('movie-frame-mode', 'fit');
    await change('movie-fps', 10);
    await change('movie-quality', 'custom');
    assert.equal(await evaluate('document.getElementById("movie-bitrate-field").hidden'), false, 'a custom quality shows the bitrate');
    await change('movie-bitrate', 4);
    await waitFor('movieChecks.formatsReady()', 'Format probe');
    const offered = await evaluate('[...document.getElementById("movie-format").options].map(option => option.value)');
    const expected = await evaluate('movieChecks.expectedFormats(10, 4)');
    assert.deepEqual(offered, [...expected, 'png-zip'], 'formats follow VideoEncoder.isConfigSupported');
    assert.ok(expected.length >= 1, `this browser encodes at least one format: ${JSON.stringify(expected)}`);
    assert.equal(await evaluate('document.getElementById("movie-resolution").value'), 'custom', 'the image size menu mirrors the Display setting');
    const start = { camera: await camera(), frame: await frameIndex() };
    const movies = {};
    for (const format of expected) {
      await change('movie-format', format);
      await waitFor('movieChecks.formatsReady()', 'Format probe');
      // The 321 × 241 image setting is rendered one pixel smaller: video stores 4:2:0 color.
      const size = [320, 240];
      const summary = await text('movie-summary');
      assert.match(summary, /^21 frames · 2\.1 s at 10 fps · 320 × 240 pixels \(made even for video\) · 4\.0 Mbit\/s, about 1\.0 MB\./, `${format} summary: ${summary}`);
      await evaluate('movieChecks.recordText = []');
      const movie = await download(() => click('export-movie'), `${format} movie`);
      // Every frame waited for its own CNA: the label is resolved, with the frame the plan asks for.
      const labels = await evaluate('movieChecks.takeLabels()');
      assert.equal(labels.length, 21, `${format}: one label per frame: ${JSON.stringify(labels)}`);
      assert.ok(labels.every(label => /^FCC \d+\.\d% · [1-6]$/.test(label)), `${format}: labels resolved: ${JSON.stringify(labels)}`);
      assert.deepEqual(labels.map(label => Number(label.at(-1))), Array.from({ length: 21 }, (_, index) => Math.min(5, Math.floor(index / 20 * 6 + 1e-9)) + 1), `${format}: frames spread over the path`);
      assert.equal(movie.filename, `movie-fixture-movie.${format.startsWith('mp4') ? 'mp4' : 'webm'}`);
      assert.equal(movie.type, format.startsWith('mp4') ? 'video/mp4' : 'video/webm');
      await waitFor('document.getElementById("movie-state").textContent === "Saved" && !document.getElementById("movie-export-dialog").open', `${format} finished`);
      assert.match(await text('movie-status'), /^Saved movie-fixture-movie\.(mp4|webm): 21 frames, 2\.1 s, [\d.]+ (kB|MB), rendered in \d+ s\.$/);
      // The view and frame are back where they were.
      assert.deepEqual({ camera: await camera(), frame: await frameIndex() }, start, `${format}: state restored`);
      // Container structure, read by the independent parser.
      const container = movie.container;
      assert.deepEqual([container.frames, container.width, container.height], [21, size[0], size[1]], `${format} container`);
      assert.ok(container.keyframes[0] === 0 && container.keyframes.includes(20), `${format} seek points every 2 s: ${container.keyframes}`);
      near(container.duration, 2.1, 1e-6, `${format} duration`);
      assert.deepEqual(container.times, Array.from({ length: 21 }, (_, index) => format.startsWith('mp4') ? index / 10 : Math.round(index * 100) / 1000), `${format} frame times`);
      // Decoded again by the browser: every frame, at the right size.
      assert.deepEqual([movie.decoded.frames, movie.decoded.width, movie.decoded.height], [21, size[0], size[1]], `${format} decodes`);
      assert.deepEqual([movie.video.width, movie.video.height], size, `${format} plays in a video element`);
      near(movie.video.duration, 2.1, 0.06, `${format} video duration`);
      // The camera and the trajectory move: early, middle and late frames differ.
      assert.ok(movie.decoded.difference.firstMiddle > 4 && movie.decoded.difference.middleLast > 4 && movie.decoded.difference.firstLast > 4,
        `${format} frames differ along the path: ${JSON.stringify(movie.decoded.difference)}`);
      // The first frame is the PNG export of the first pose and frame, up to compression.
      const againstPng = await evaluate('movieChecks.againstPng()', { timeoutMs: 60_000 });
      assert.ok(againstPng < 4, `${format} first frame matches the PNG export: ${againstPng}`);
      assert.deepEqual({ camera: await camera(), frame: await frameIndex() }, start, `${format}: comparison left the view alone`);
      // The text label is stamped in every sampled frame.
      assert.ok(movie.decoded.magenta.every(count => count > 150), `${format} frames carry the label: ${movie.decoded.magenta}`);
      if (movie.av1) assert.deepEqual([movie.av1.width, movie.av1.height, movie.av1.bitDepth, movie.av1.subsamplingX, movie.av1.subsamplingY], [...size, 8, 1, 1], 'AV1 header read for av1C');
      movies[format] = { bytes: movie.bytes, configuration: container.configuration, decoded: movie.decoded.frames, difference: movie.decoded.difference, againstPng };
      if (keep || ffprobe) {
        const directory = keep ?? temporary, path = resolve(directory, `fixture-${movie.filename.replace('movie-fixture-movie', format)}`);
        await mkdir(directory, { recursive: true });
        await writeFile(path, Buffer.from(await evaluate('movieChecks.base64()'), 'base64'));
        if (ffprobe) {
          const probed = await ffprobeFile(path);
          assert.deepEqual([probed.width, probed.height, probed.frames, probed.rate], [size[0], size[1], 21, '10/1'], `${format} ffprobe: ${JSON.stringify(probed)}`);
          near(probed.duration, 2.1, 0.02, `${format} ffprobe duration`);
          movies[format].ffprobe = probed.codec;
        }
      }
    }

    // An image size beyond the export limit is reported in the panel, not thrown.
    await change('export-width', 8000); await change('export-height', 8000);
    await waitFor('/limited to 32 megapixels/.test(document.getElementById("movie-summary").textContent) && document.getElementById("export-movie").disabled', 'Oversized image reported');
    await change('export-width', 321); await change('export-height', 241);
    await waitFor('movieChecks.formatsReady() && !document.getElementById("export-movie").disabled', 'Image size valid again');

    // ── PNG frames in a ZIP use the same sequence ─────────────────────────
    await change('movie-format', 'png-zip');
    assert.equal(await text('export-movie'), 'Export frames (ZIP)');
    const archive = await download(() => click('export-movie'), 'Frame archive');
    assert.deepEqual([archive.filename, archive.type, archive.images.length], ['movie-fixture-movie-frames.zip', 'application/zip', 21]);
    assert.deepEqual(archive.images.map(image => image.name), Array.from({ length: 21 }, (_, index) => `movie-fixture-${String(index + 1).padStart(4, '0')}.png`));
    assert.ok(archive.images.every(image => image.size[0] === 321 && image.size[1] === 241 && image.magenta > 150));
    await waitFor('document.getElementById("movie-state").textContent === "Saved"', 'Archive finished');
    assert.deepEqual({ camera: await camera(), frame: await frameIndex() }, start, 'archive: state restored');

    // ── Cancel restores the frame and camera and saves nothing ────────────
    await change('movie-format', expected[0]);
    await change('movie-fps', 60);
    await waitFor('movieChecks.formatsReady()', 'Format probe');
    assert.match(await text('movie-summary'), /^121 frames · /);
    await evaluate('movieChecks.beginDownload()');
    await click('export-movie');
    await waitFor('document.getElementById("movie-export-dialog").open && document.getElementById("movie-progress").value > 0.05', 'Export under way');
    const midway = await evaluate('({ camera: movieChecks.camera(), text: document.getElementById("movie-progress-text").textContent, modal: document.getElementById("movie-export-dialog").matches(":modal") })');
    assert.match(midway.text, /^Frame \d+ of 121 · [\d.]+ (kB|MB) · \d+ s elapsed · about \d+ s left$/);
    assert.equal(midway.modal, true, 'the progress dialog blocks other input');
    assert.notDeepEqual(midway.camera, start.camera, 'the camera is animated during the export');
    await click('cancel-movie');
    await waitFor('document.getElementById("movie-state").textContent === "Cancelled" && !document.getElementById("movie-export-dialog").open', 'Export cancelled');
    assert.equal(await evaluate('movieChecks.download'), null, 'a cancelled export saves nothing');
    await evaluate('movieChecks.restoreDownload()');
    assert.deepEqual({ camera: await camera(), frame: await frameIndex() }, start, 'cancel: state restored');
    assert.match(await text('movie-status'), /Movie export cancelled\. The view and frame were restored\./);
    assert.equal(await evaluate('document.getElementById("export-movie").disabled'), false, 'another export can start');

    // ── Keyframe editing and the viewport preview ─────────────────────────
    await change('movie-fps', 10);
    await evaluate('document.querySelector("#movie-keyframes [data-keyframe=\\"1\\"] input").value = "1"; document.querySelector("#movie-keyframes [data-keyframe=\\"1\\"] input").dispatchEvent(new Event("change", { bubbles: true }))');
    assert.deepEqual((await evaluate('movieChecks.keyframes()')).map(keyframe => keyframe.time), [0, 1]);
    await evaluate('document.querySelector("#movie-keyframes [data-keyframe=\\"1\\"] [data-action=\\"↑\\"]").click()');
    const swapped = await evaluate('movieChecks.keyframes()');
    near(swapped[0].camera.yaw, 125 * DEGREE, 1e-9, 'views swap'); near(swapped[1].camera.yaw, 35 * DEGREE, 1e-9, 'times stay');
    await evaluate('document.querySelector("#movie-keyframes [data-keyframe=\\"0\\"] [data-action=\\"Go\\"]").click()');
    near((await camera()).yaw, 125 * DEGREE, 1e-9, 'Go shows the keyframe');
    await evaluate('document.querySelector("#movie-keyframes [data-keyframe=\\"1\\"] input").value = "0"; document.querySelector("#movie-keyframes [data-keyframe=\\"1\\"] input").dispatchEvent(new Event("change", { bubbles: true }))');
    await waitFor('!document.getElementById("toast").hidden && /already has this time/.test(document.getElementById("toast").textContent)', 'Duplicate time refused');
    assert.deepEqual((await evaluate('movieChecks.keyframes()')).map(keyframe => keyframe.time), [0, 1]);
    await runScript('camera view front\nframe 2');
    await showTool('movie');
    const previewStart = { camera: await camera(), frame: await frameIndex() };
    await click('preview-movie');
    await waitFor('document.getElementById("preview-movie").textContent === "Stop preview"', 'Preview started');
    await delay(450);
    const during = await camera();
    assert.ok(during.yaw > 36 * DEGREE && during.yaw < 124 * DEGREE, `the preview moves the camera between the keyframes: ${during.yaw / DEGREE}`);
    await waitFor('document.getElementById("preview-movie").textContent === "Preview" && document.getElementById("movie-state").textContent === "Idle"', 'Preview finished', 15_000);
    await waitFor(`movieChecks.renderer.frame.frameIndex === ${previewStart.frame}`, 'Preview frame restored');
    assert.deepEqual(await camera(), previewStart.camera, 'the preview returns to the view it started from');
    await click('preview-movie');
    await waitFor('document.getElementById("preview-movie").textContent === "Stop preview"', 'Preview started again');
    await delay(200);
    await click('preview-movie');
    await waitFor('document.getElementById("preview-movie").textContent === "Preview"', 'Preview stopped');
    assert.deepEqual(await camera(), previewStart.camera, 'Stop preview returns to the starting view');
    // A script cannot start while a preview owns the viewport, and the reverse.
    await click('preview-movie');
    await waitFor('document.getElementById("preview-movie").textContent === "Stop preview"', 'Preview for the lock check');
    await evaluate('document.getElementById("toast").hidden = true');
    await showTool('scripts');
    await change('script-text', 'camera view top', 'input');
    await click('run-script');
    await waitFor('!document.getElementById("toast").hidden', 'Script refused during a preview');
    assert.match(await text('toast'), /Wait for the movie export or preview to finish first/);
    await showTool('movie');
    await click('preview-movie');
    await waitFor('document.getElementById("preview-movie").textContent === "Preview"', 'Preview stopped for the lock check');

    // ── A trajectory without a camera path ────────────────────────────────
    await click('clear-movie-keyframes');
    assert.match(await text('movie-summary'), /Nothing moves yet\. Add at least two camera keyframes, or play trajectory frames at a rate\./);
    assert.equal(await evaluate('document.getElementById("export-movie").disabled && document.getElementById("preview-movie").disabled'), true);
    await change('movie-frame-mode', 'rate');
    await change('movie-frame-rate', 5);
    await change('movie-frame-first', 2); await change('movie-frame-last', 5);
    await waitFor('movieChecks.formatsReady() && !document.getElementById("export-movie").disabled', 'Trajectory movie ready');
    assert.match(await text('movie-summary'), /^8 frames · 0\.8 s at 10 fps · /);
    const trajectoryStart = { camera: await camera(), frame: await frameIndex() };
    const trajectory = await download(() => click('export-movie'), 'Trajectory movie');
    assert.deepEqual([trajectory.container.frames, trajectory.decoded.frames], [8, 8]);
    assert.ok(trajectory.decoded.difference.firstLast > 2, `trajectory frames differ: ${JSON.stringify(trajectory.decoded.difference)}`);
    await waitFor('document.getElementById("movie-state").textContent === "Saved"', 'Trajectory movie finished');
    assert.deepEqual({ camera: await camera(), frame: await frameIndex() }, trajectoryStart, 'trajectory movie: state restored');

    // ── Frames saved with the keyframes ───────────────────────────────────
    await runScript('keyframe clear\nframe 2\nkeyframe 0\ncamera orbit 30 0\nframe 5\nkeyframe 1\nframe 1');
    await showTool('movie');
    await change('movie-frame-mode', 'keyframes');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#movie-keyframes .movie-keyframe-unit")].map(unit => unit.textContent)'), ['s · frame 2', 's · frame 5']);
    await evaluate(`document.querySelector("#movie-keyframes [data-keyframe='1'] [data-action='Go']").click()`);
    await waitFor('movieChecks.renderer.frame.frameIndex === 4 && document.getElementById("loading").hidden', 'Go shows the frame saved with the keyframe');
    await change('movie-format', 'png-zip');
    assert.match(await text('movie-summary'), /^11 frames · 1\.1 s at 10 fps · /);
    await evaluate('movieChecks.recordText = []');
    const linked = await download(() => click('export-movie'), 'Keyframe-linked frames');
    assert.equal(linked.images.length, 11);
    assert.deepEqual((await evaluate('movieChecks.takeLabels()')).map(label => Number(label.at(-1))), Array.from({ length: 11 }, (_, index) => Math.round(1 + 3 * index / 10) + 1),
      'frames are interpolated between the keyframes');
    await waitFor('document.getElementById("movie-state").textContent === "Saved" && movieChecks.renderer.frame.frameIndex === 4', 'Linked export restored');
    await change('movie-format', expected[0]);

    // ── Phone layout ──────────────────────────────────────────────────────
    await runScript('keyframe 0\ncamera orbit 60 10\nkeyframe\ncamera orbit 60 10\nkeyframe');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await delay(250);
    const phone = {};
    for (const name of ['scripts', 'movie']) {
      await showTool(name);
      await evaluate(`document.querySelector('[data-tool-panel="${name}"]').scrollIntoView({ block: 'start' })`);
      await delay(120);
      phone[name] = await evaluate(`movieChecks.phone(${JSON.stringify(name)})`);
      assert.equal(phone[name].fits, true, `${name} panel fits a phone: ${JSON.stringify(phone[name])}`);
      assert.deepEqual(phone[name].outside, [], `${name} controls stay inside the panel`);
      assert.ok(phone[name].smallest >= 34, `${name} buttons are large enough to tap: ${phone[name].smallest}`);
    }
    await change('movie-frame-mode', 'current');
    await change('movie-fps', 30);
    await waitFor('movieChecks.formatsReady() && !document.getElementById("export-movie").disabled', 'Phone movie ready');
    await evaluate('movieChecks.beginDownload()');
    await click('export-movie');
    await waitFor('document.getElementById("movie-export-dialog").open', 'Phone export dialog');
    const dialogBox = await evaluate('(() => { const box = document.getElementById("movie-export-dialog").getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight }; })()');
    assert.ok(dialogBox.left >= 0 && dialogBox.right <= dialogBox.width && dialogBox.top >= 0 && dialogBox.bottom <= dialogBox.height, `export dialog fits a phone: ${JSON.stringify(dialogBox)}`);
    await click('cancel-movie');
    await waitFor('!document.getElementById("movie-export-dialog").open && document.getElementById("movie-state").textContent === "Cancelled"', 'Phone export cancelled');
    await evaluate('movieChecks.restoreDownload()');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    // ── Optional timing: 1920 × 1080, 120 frames of a 40-frame CFG example ─
    let timed = null;
    if (timing) {
      await evaluate(`document.getElementById('open-examples').click()`);
      await waitFor(`[...document.querySelectorAll('#source-options .source-option')].some(button => !button.disabled && button.textContent.includes('fixed_end_climb'))`, 'Example catalog');
      await evaluate(`[...document.querySelectorAll('#source-options .source-option')].find(button => !button.disabled && button.textContent.includes('fixed_end_climb')).click()`);
      await waitFor(`document.getElementById('file-name').textContent.includes('fixed_end_climb') && document.getElementById('frame-count').textContent === '40'
        && document.getElementById('loading').hidden && !document.getElementById('script-text').disabled`, 'Example load');
      assert.deepEqual(await evaluate('movieChecks.keyframes()'), [], 'a new source starts without keyframes');
      await showTool('scripts');
      await runScript('keyframe 0\ncamera orbit 120 15\nkeyframe 2\ncamera orbit 120 -15\nkeyframe 3.9667');
      await showTool('display');
      await change('export-resolution', '1080p');
      await showTool('movie');
      await change('movie-frame-mode', 'fit');
      await change('movie-fps', 30);
      timed = { atoms: await evaluate('movieChecks.renderer.frame.ids.length'), formats: {} };
      for (const format of expected) {
        await change('movie-format', format);
        await waitFor('movieChecks.formatsReady() && !document.getElementById("export-movie").disabled', 'Timing movie ready');
        const summary = await text('movie-summary');
        assert.match(summary, /^120 frames · 4 s at 30 fps · 1,920 × 1,080 pixels/);
        const started = Date.now();
        const movie = await download(() => click('export-movie'), `${format} 1080p movie`, 1_800_000);
        await waitFor('document.getElementById("movie-state").textContent === "Saved"', `${format} 1080p finished`);
        assert.deepEqual([movie.container.frames, movie.container.width, movie.container.height, movie.decoded.frames], [120, 1920, 1080, 120]);
        timed.formats[format] = { seconds: (Date.now() - started) / 1000, megabytes: movie.bytes / 1e6, status: await text('movie-status') };
        if (keep) await writeFile(resolve(keep, `climb-1080p-${format}.${format.startsWith('mp4') ? 'mp4' : 'webm'}`), Buffer.from(await evaluate('movieChecks.base64()'), 'base64'));
      }
      // A camera orbit of one large frame: the Fe dislocation loop (60,229 atoms).
      await evaluate(`document.getElementById('open-examples').click()`);
      await waitFor(`[...document.querySelectorAll('#source-options .source-option')].some(button => !button.disabled && button.textContent.includes('Fe_disloc_loop'))`, 'Example catalog');
      await evaluate(`[...document.querySelectorAll('#source-options .source-option')].find(button => !button.disabled && button.textContent.includes('Fe_disloc_loop')).click()`);
      await waitFor(`document.getElementById('file-name').textContent.includes('Fe_disloc_loop') && movieChecks.renderer.frame.ids.length > 50000
        && document.getElementById('loading').hidden && !document.getElementById('script-text').disabled`, 'Fe loop load', 300_000);
      await runScript('keyframe clear\nkeyframe 0\ncamera orbit 120 15\nkeyframe 2\ncamera orbit 120 -15\nkeyframe 3.9667');
      await showTool('movie');
      timed.loop = { atoms: await evaluate('movieChecks.renderer.frame.ids.length'), formats: {} };
      for (const format of expected.slice(0, 2)) {
        await change('movie-format', format);
        await waitFor('movieChecks.formatsReady() && !document.getElementById("export-movie").disabled', 'Loop movie ready');
        assert.match(await text('movie-summary'), /^120 frames · 4 s at 30 fps · 1,920 × 1,080 pixels/);
        const started = Date.now();
        const movie = await download(() => click('export-movie'), `${format} loop movie`, 1_800_000);
        await waitFor('document.getElementById("movie-state").textContent === "Saved"', `${format} loop finished`);
        assert.deepEqual([movie.container.frames, movie.container.width, movie.container.height, movie.decoded.frames], [120, 1920, 1080, 120]);
        timed.loop.formats[format] = { seconds: (Date.now() - started) / 1000, megabytes: movie.bytes / 1e6, status: await text('movie-status') };
        if (keep) await writeFile(resolve(keep, `loop-1080p-${format}.${format.startsWith('mp4') ? 'mp4' : 'webm'}`), Buffer.from(await evaluate('movieChecks.base64()'), 'base64'));
      }
    }

    // ── Without WebCodecs the panel explains and offers PNG frames ────────
    await call('Page.enable'); // scripts for new documents need the Page domain
    await call('Page.addScriptToEvaluateOnNewDocument', { source: 'delete window.VideoEncoder; delete window.VideoFrame;' });
    await open();
    await loadFixture();
    await showTool('movie');
    await waitFor('movieChecks.formatsReady()', 'Fallback formats');
    assert.deepEqual(await evaluate('[...document.getElementById("movie-format").options].map(option => option.value)'), ['png-zip']);
    await runScript('keyframe 0\ncamera orbit 90 0\nkeyframe 1');
    await showTool('movie');
    await change('movie-fps', 4);
    assert.match(await text('movie-summary'), /^5 frames · 1\.25 s at 4 fps · .* PNG images\. .*This browser cannot encode video here \(WebCodecs is unavailable; it needs a recent browser and a secure page\), so PNG frames in a ZIP archive are offered instead\.$/);
    const fallback = await download(() => click('export-movie'), 'Fallback archive');
    assert.deepEqual([fallback.type, fallback.images.length], ['application/zip', 5]);

    return { adapter: 'WebGL ' + (await evaluate('movieChecks.renderer.gl.getParameter(movieChecks.renderer.gl.VERSION)')), formats: expected, movies,
      archive: archive.images.length, phone, ffprobe, timed };
  }, { software: useSoftwareAdapter(true), requireGpu: false });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function installChecks(parserUrl) {
  const app = document.querySelector('script[type="module"][src]').src;
  const [{ WebGLRenderer }, { probeMovieFormats, MOVIE_FORMATS, parseAv1SequenceHeader }, { movieBitrate, movieRenderSize, DEFAULT_MOVIE_OUTPUT }, containers] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./video/codecs.js', app)), import(new URL('./movie-export.js', app)), import(parserUrl)]);
  const checks = window.movieChecks = { download: null, recordText: null };
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function(value, ...rest) { checks.recordText?.push(String(value)); return fillText.call(this, value, ...rest); };
  checks.takeLabels = () => { const labels = (checks.recordText ?? []).filter(value => value.startsWith('FCC')); checks.recordText = null; return labels; };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) { if (this.canvas.id === 'viewport') checks.renderer = this; return setFrame.apply(this, args); };
  checks.change = (id, value, event = 'change') => {
    const element = document.getElementById(id);
    if (typeof value === 'boolean') element.checked = value; else element.value = String(value);
    element.dispatchEvent(new Event(event, { bubbles: true }));
  };
  checks.showTool = name => {
    const panel = document.querySelector(`[data-tool-panel="${name}"]`);
    if (panel.hidden) document.querySelector(`[data-tool-button="${name}"]`).click();
  };
  checks.camera = () => {
    const r = checks.renderer;
    return { yaw: r.yaw, pitch: r.pitch, roll: r.roll, constrainUp: r.constrainUp, distance: r.distance, orthographicScale: r.orthographicScale, fov: r.fov,
      projectionMode: r.projectionMode, target: [...r.target], pan: [...r.pan] };
  };
  /** The parallel scale a camera reset gives, without moving the camera. */
  checks.resetScale = () => checks.renderer.modelRadius * 1.25;
  /** Keyframes as the Movie panel would save them. */
  checks.keyframes = () => {
    const rows = [...document.querySelectorAll('#movie-keyframes [data-keyframe]')];
    if (!rows.length) return [];
    // Read the saved recipe rather than private state.
    return checks.recipe().settings.extensions.movie?.path.keyframes ?? [];
  };
  const oldUrl = URL.createObjectURL, oldClick = HTMLAnchorElement.prototype.click;
  checks.recipe = () => {
    let text = null;
    const create = URL.createObjectURL, clickAnchor = HTMLAnchorElement.prototype.click, previous = checks.download;
    URL.createObjectURL = function(blob) { text = blob; return create.call(this, blob); };
    HTMLAnchorElement.prototype.click = function() {};
    try { document.getElementById('export-configuration').click(); } finally { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = clickAnchor; checks.download = previous; }
    return JSON.parse(checks.syncText(text));
  };
  checks.syncText = blob => { const request = new XMLHttpRequest(); request.open('GET', oldUrl.call(URL, blob), false); request.send(); return request.responseText; };
  /** The encoder has answered for the settings now in the panel. */
  checks.formatsReady = () => document.getElementById('movie-format').dataset.pending === 'false'
    && [...document.getElementById('movie-format').options].some(option => option.value === 'png-zip');
  /** Ask the encoder directly, as the panel must have. */
  checks.expectedFormats = async (fps, bitrateMbps) => {
    if (typeof VideoEncoder !== 'function') return [];
    const resolution = { mode: document.getElementById('export-resolution').value, width: document.getElementById('export-width').valueAsNumber,
      height: document.getElementById('export-height').valueAsNumber, lockAspect: document.getElementById('export-aspect-lock').checked };
    const supported = [];
    for (const format of MOVIE_FORMATS) {
      const size = movieRenderSize(resolution, checks.renderer.canvas.width, checks.renderer.canvas.height, format);
      const output = { ...DEFAULT_MOVIE_OUTPUT, fps, quality: 'custom', bitrateMbps };
      const [entry] = await probeMovieFormats({ width: size.width, height: size.height, fps, bitrate: movieBitrate(output, size.width, size.height, format.codec), formats: [format] });
      const direct = entry.config ? (await VideoEncoder.isConfigSupported(entry.config)).supported : false;
      if (entry.supported !== direct) throw new Error(`Probe disagrees with the encoder for ${format.id}`);
      if (entry.supported) supported.push(format.id);
    }
    return supported;
  };
  const decodeImage = async blob => {
    const bitmap = await createImageBitmap(blob), canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height);
  };
  const magenta = image => {
    let count = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) if (image.data[offset] > 190 && image.data[offset + 1] < 90 && image.data[offset + 2] > 190) count++;
    return count;
  };
  const difference = (a, b) => {
    let total = 0;
    for (let offset = 0; offset < a.data.length; offset += 4) total += Math.abs(a.data[offset] - b.data[offset]) + Math.abs(a.data[offset + 1] - b.data[offset + 1]) + Math.abs(a.data[offset + 2] - b.data[offset + 2]);
    return total / (a.data.length / 4 * 3);
  };
  /** Demux with the independent parser, decode every frame with VideoDecoder. */
  async function decodeMovie(bytes, type) {
    const mp4 = type === 'video/mp4', movie = mp4 ? containers.readMp4(bytes) : containers.readWebm(bytes);
    const frames = mp4 ? movie.frames.map(frame => ({ ...frame, seconds: frame.time / movie.timescale })) : movie.frames.map(frame => ({ ...frame, seconds: frame.time / 1000 }));
    const entry = mp4 ? movie.entry : movie.codecId, configuration = mp4 ? movie.configuration : movie.codecPrivate ? { type: 'CodecPrivate', bytes: movie.codecPrivate } : null;
    const hex = byte => byte.toString(16).padStart(2, '0');
    let codec, description;
    if (entry === 'avc1') { const c = configuration.bytes; codec = `avc1.${hex(c[1])}${hex(c[2])}${hex(c[3])}`; description = c; }
    else if (entry === 'vp09' || entry === 'V_VP9') codec = 'vp09.00.10.08';
    else if (entry === 'V_VP8') codec = 'vp8';
    else codec = 'av01.0.04M.08';
    const images = [], wanted = new Set([0, Math.floor(frames.length / 2), frames.length - 1]);
    let decodedCount = 0, width = 0, height = 0, failure = null;
    const decoder = new VideoDecoder({ error: error => { failure = error; }, output: frame => {
      width = frame.displayWidth; height = frame.displayHeight;
      if (wanted.has(decodedCount)) {
        const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight), context = canvas.getContext('2d');
        context.drawImage(frame, 0, 0); images.push(context.getImageData(0, 0, canvas.width, canvas.height));
      }
      decodedCount++; frame.close();
    } });
    decoder.configure({ codec, codedWidth: movie.width, codedHeight: movie.height, ...(description ? { description } : {}) });
    for (const frame of frames) {
      decoder.decode(new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: Math.round(frame.seconds * 1e6), data: bytes.subarray(frame.offset, frame.offset + frame.size) }));
    }
    await decoder.flush(); decoder.close();
    if (failure) throw failure;
    const av1Frame = entry === 'av01' || entry === 'V_AV1' ? parseAv1SequenceHeader(bytes.subarray(frames[0].offset, frames[0].offset + frames[0].size)) : null;
    return { movie, images,
      container: { frames: frames.length, width: movie.width, height: movie.height, duration: mp4 ? movie.mediaDuration / movie.timescale : movie.duration / 1000,
        keyframes: frames.map((frame, index) => frame.key ? index : -1).filter(index => index >= 0), times: frames.map(frame => frame.seconds),
        configuration: configuration ? `${configuration.type} ${configuration.bytes.length} bytes` : 'none', order: mp4 ? movie.order : undefined },
      decoded: { frames: decodedCount, width, height, magenta: images.map(magenta),
        difference: { firstMiddle: difference(images[0], images[1]), middleLast: difference(images[1], images[2]), firstLast: difference(images[0], images[2]) } },
      av1: av1Frame && { width: av1Frame.width, height: av1Frame.height, bitDepth: av1Frame.bitDepth, subsamplingX: av1Frame.subsamplingX, subsamplingY: av1Frame.subsamplingY } };
  }
  checks.beginDownload = () => {
    checks.download = null;
    URL.createObjectURL = function(blob) { checks.download = { blob, states: { cna: document.getElementById('cna-state').textContent } }; return oldUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = function() { if (checks.download) checks.download.filename = this.download; };
  };
  checks.restoreDownload = () => { URL.createObjectURL = oldUrl; HTMLAnchorElement.prototype.click = oldClick; };
  checks.finishDownload = async () => {
    const { blob, filename, states } = checks.download;
    const result = { filename, type: blob.type, bytes: blob.size, states };
    if (blob.type.startsWith('image/')) { const image = await decodeImage(blob); result.size = [image.width, image.height]; }
    else if (blob.type === 'application/zip') {
      const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer); result.images = [];
      for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
        const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)), start = offset + 30 + nameLength + extra;
        const image = await decodeImage(new Blob([bytes.subarray(start, start + length)], { type: 'image/png' }));
        result.images.push({ name, size: [image.width, image.height], magenta: magenta(image) }); offset = start + length;
      }
    } else if (blob.type.startsWith('video/')) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      checks.lastMovie = bytes;
      const decoded = await decodeMovie(bytes, blob.type);
      Object.assign(result, { container: decoded.container, decoded: decoded.decoded, av1: decoded.av1 });
      checks.lastImages = decoded.images;
      const video = document.createElement('video'); video.muted = true; video.preload = 'auto'; video.src = oldUrl.call(URL, blob);
      result.video = await new Promise(resolve => {
        video.onloadeddata = () => resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
        video.onerror = () => resolve({ error: video.error?.message ?? 'video error' });
      });
    } else result.text = await blob.text();
    return result;
  };
  /** Mean difference between the movie's first frame and the PNG button's
   * image of the first keyframe and first frame, at the movie's size. */
  checks.againstPng = async () => {
    const [first] = checks.lastImages, renderer = checks.renderer, saved = checks.camera(), original = renderer.frame.frameIndex;
    const size = [document.getElementById('export-width').value, document.getElementById('export-height').value];
    checks.change('export-width', first.width); checks.change('export-height', first.height);
    const mode = document.getElementById('movie-frame-mode').value;
    const firstFrame = mode === 'fit' || mode === 'rate' ? document.getElementById('movie-frame-first').valueAsNumber - 1 : original;
    if (firstFrame !== original) await checks.waitFrame(firstFrame);
    document.querySelector('#movie-keyframes [data-keyframe="0"] [data-action="Go"]').click();
    const blob = await new Promise(resolve => {
      URL.createObjectURL = function(item) { resolve(item); return oldUrl.call(this, item); };
      HTMLAnchorElement.prototype.click = function() {};
      document.getElementById('export-png').click();
    });
    URL.createObjectURL = oldUrl; HTMLAnchorElement.prototype.click = oldClick;
    const image = await decodeImage(blob);
    checks.change('export-width', size[0]); checks.change('export-height', size[1]);
    if (firstFrame !== original) await checks.waitFrame(original);
    Object.assign(renderer, { ...saved, target: [...saved.target], pan: [...saved.pan] }); renderer.requestRender();
    if (image.width !== first.width || image.height !== first.height) throw new Error(`PNG is ${image.width} × ${image.height}, movie frame ${first.width} × ${first.height}`);
    return difference(first, image);
  };
  checks.waitFrame = async index => {
    const slider = document.getElementById('frame-slider');
    slider.value = String(index); slider.dispatchEvent(new Event('input', { bubbles: true }));
    for (let attempt = 0; attempt < 400 && checks.renderer.frame.frameIndex !== index; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    await new Promise(resolve => setTimeout(resolve, 50));
  };
  checks.base64 = () => {
    let binary = '';
    for (let offset = 0; offset < checks.lastMovie.length; offset += 0x8000) binary += String.fromCharCode(...checks.lastMovie.subarray(offset, offset + 0x8000));
    return btoa(binary);
  };
  checks.importRecipe = recipeText => {
    const input = document.getElementById('configuration-file'), files = new DataTransfer();
    files.items.add(new File([recipeText], 'recipe.json', { type: 'application/json' }));
    input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  /** Panel width, controls that leave it and the smallest visible button. */
  checks.phone = name => {
    const panel = document.querySelector(`[data-tool-panel="${name}"]`), box = panel.getBoundingClientRect();
    const visible = [...panel.querySelectorAll('button, input, select, textarea')].filter(element => element.getClientRects().length && element.type !== 'file');
    const outside = visible.filter(element => { const rect = element.getBoundingClientRect(); return rect.left < box.left - 1 || rect.right > box.right + 1; }).map(element => element.id || element.textContent);
    const buttons = visible.filter(element => element.tagName === 'BUTTON' && !element.classList.contains('feature-help-link'));
    return { fits: document.documentElement.scrollWidth <= innerWidth, width: document.documentElement.scrollWidth, outside,
      smallest: Math.min(...buttons.map(button => button.getBoundingClientRect().height)), buttons: buttons.length };
  };
  checks.ready = true;
}
