import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Production UI with a LAMMPS dump that has no image flags. A 4 × 4 × 4 FCC
// Ni crystal (256 atoms, L = 14.08 Å) drifts by 0.55 Å per frame along x, so
// about half of its atoms cross the +x boundary within 14 frames, and each
// atom has independent Gaussian noise (σ = 0.18 Å) in every frame. Raw
// adaptive CNA finds under half of the atoms FCC; a ±3-frame average finds
// all of them.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-trajectory-tools-'));
const fixture = 'drifting-fcc.dump', fixturePath = resolve(temporary, fixture);
const a = 3.52, cells = 4, L = a * cells, frameCount = 14, drift = 0.55, sigma = 0.18;
let seed = 12345;
const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return (seed + 0.5) / 2_147_483_648; };
const gaussian = () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
const sites = [];
for (let i = 0; i < cells; i++) for (let j = 0; j < cells; j++) for (let k = 0; k < cells; k++) {
  for (const [x, y, z] of [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]]) sites.push([(i + x) * a, (j + y) * a, (k + z) * a]);
}
const continuous = [], text = [];
for (let frame = 0; frame < frameCount; frame++) {
  const positions = sites.map(site => site.map((value, axis) => value + (axis === 0 ? drift * frame : 0) + sigma * gaussian()));
  continuous.push(positions);
  text.push(['ITEM: TIMESTEP', frame * 100, 'ITEM: NUMBER OF ATOMS', sites.length, 'ITEM: BOX BOUNDS pp pp pp',
    `0 ${L}`, `0 ${L}`, `0 ${L}`, 'ITEM: ATOMS id type x y z',
    ...positions.map((point, atom) => `${atom + 1} 1 ${point.map(value => (value - Math.floor(value / L) * L).toFixed(6)).join(' ')}`), ''].join('\n'));
}
await writeFile(fixturePath, text.join(''));
// Atom IDs whose continuous x leaves the cell by the last frame.
const crossing = continuous[frameCount - 1].map((point, atom) => [atom, point[0]]).filter(([, x]) => x >= L + 0.5).map(([atom]) => atom);
assert.ok(crossing.length > 50);
const tracked = crossing[0];
// Unwrapping starts from the wrapped position in frame 1.
const offset = sites[tracked].map((_, axis) => -L * Math.floor(continuous[0][tracked][axis] / L));
const expectedUnwrapped = frame => continuous[frame][tracked].map((value, axis) => value + offset[axis]);
const smoothedX = (frame, window) => {
  const first = Math.max(0, frame - window), last = Math.min(frameCount - 1, frame + window);
  let sum = 0;
  for (let index = first; index <= last; index++) sum += continuous[index][tracked][0];
  const mean = sum / (last - first + 1);
  return mean - Math.floor(mean / L) * L;
};

async function exercise({ isolated }) {
  return withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(40);
      }
      throw new Error(`${label}: ${await evaluate(`JSON.stringify({ toast: document.getElementById('toast')?.textContent,
        unwrap: document.getElementById('trajectory-unwrap-status')?.textContent, smooth: document.getElementById('trajectory-smooth-status')?.textContent,
        lines: document.getElementById('trajectory-lines-status')?.textContent, cna: document.getElementById('cna-state')?.textContent,
        recipe: document.getElementById('configuration-status')?.textContent, frame: window.trajectoryChecks?.renderer?.frame?.frameIndex })`)}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("generate-trajectory-lines")', 'Production page startup');
    await evaluate(`(${initializeChecks.toString()})()`);
    await waitFor('window.trajectoryChecks?.ready', 'Check modules');
    await evaluate(`trajectoryChecks.hold(${frameCount - 1})`);
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
    if (isolated) assert.equal(await evaluate('crossOriginIsolated && typeof SharedArrayBuffer === "function"'), true);
    else assert.equal(await evaluate('crossOriginIsolated'), false);
    const { root: document } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
    await call('DOM.setFileInputFiles', { nodeId, files: [fixturePath] });
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(fixture)} && trajectoryChecks.renderer?.frame
      && document.getElementById('frame-count').textContent === '${frameCount}' && document.getElementById('loading').hidden`, 'Trajectory import');
    const change = (id, value, checkbox = false) => evaluate(`trajectoryChecks.change(${JSON.stringify(id)}, ${JSON.stringify(value)}, ${checkbox})`);
    const atom = index => evaluate(`trajectoryChecks.atom(${index})`);
    const loading = () => evaluate(`({ hidden: document.getElementById('loading').hidden, text: document.getElementById('loading-text').textContent })`);

    // A frame request that is superseded by a cached frame hides the loading
    // indicator it showed. The last frame is held back, so it is still loading.
    await change('frame-slider', '1');
    await waitFor('trajectoryChecks.renderer.frame.frameIndex === 1 && document.getElementById("loading").hidden', 'Frame 2');
    await evaluate('document.getElementById("frame-last").click()');
    await waitFor(`!document.getElementById('loading').hidden && document.getElementById('loading-text').textContent === 'Preparing frame ${frameCount}…'`,
      'Loading indicator of the held frame');
    await evaluate('document.getElementById("frame-first").click()');
    await waitFor('trajectoryChecks.renderer.frame.frameIndex === 0', 'Cached first frame');
    assert.equal((await loading()).hidden, true, 'a superseded frame request must not leave the loading indicator on');
    await evaluate('trajectoryChecks.release()');
    await delay(300);
    assert.equal((await loading()).hidden, true);

    // Unwrapping off: requests carry no trajectory options.
    assert.equal(await evaluate('trajectoryChecks.requests.every(request => !request.trajectory)'), true);
    const option = await evaluate(`(() => { const item = document.querySelector('#coordinate-mode option[value=unwrapped]'); return { disabled: item.disabled, text: item.textContent }; })()`);
    assert.deepEqual(option, { disabled: false, text: 'Unwrapped coordinates (inferred from adjacent frames)' });

    // Jump to the last frame first, then unwrap, then visit earlier frames.
    await evaluate('document.getElementById("frame-last").click()');
    await waitFor(`trajectoryChecks.renderer.frame.frameIndex === ${frameCount - 1} && document.getElementById('loading').hidden`, 'Last frame');
    await change('coordinate-mode', 'unwrapped');
    await waitFor(`trajectoryChecks.renderer.coordinateMode === 'unwrapped' && trajectoryChecks.renderer.frame.inferredUnwrap`, 'Inferred unwrapping of the last frame');
    const unwrappedChecks = [];
    for (const frame of [frameCount - 1, 4, 9, 0, 10]) {
      if (frame !== frameCount - 1) {
        await change('frame-slider', String(frame));
        await waitFor(`trajectoryChecks.renderer.frame.frameIndex === ${frame} && trajectoryChecks.renderer.coordinateMode === 'unwrapped'`, `Unwrapped frame ${frame + 1}`);
      }
      const shown = await atom(tracked);
      const expected = expectedUnwrapped(frame);
      const error = Math.max(...shown.display.map((value, axis) => Math.abs(value - expected[axis])));
      assert.ok(error < 2e-3, `frame ${frame + 1}: ${shown.display} vs ${expected}`);
      assert.equal(shown.file, false);
      unwrappedChecks.push({ frame: frame + 1, error, image: shown.image });
    }
    for (const check of unwrappedChecks) {
      assert.deepEqual(check.image, continuous[check.frame - 1][tracked].map((value, axis) => Math.floor(value / L) - Math.floor(continuous[0][tracked][axis] / L)));
    }
    assert.equal(unwrappedChecks.find(check => check.frame === frameCount).image[0], 1);
    const details = await evaluate('document.getElementById("trajectory-unwrap-status").textContent');
    assert.match(details, /inferred from frames 1–11/);
    // Inferred coordinates never reach analysis inputs.
    assert.equal(await evaluate('trajectoryChecks.renderer.frame.unwrappedPositions == null && trajectoryChecks.renderer.frame.imageFlags == null'), true);
    await change('coordinate-mode', 'wrapped');
    await waitFor(`trajectoryChecks.renderer.coordinateMode === 'wrapped'`, 'Wrapped display');

    // Raw CNA at frame 8, then a ±3-frame average with CNA enabled.
    await change('frame-slider', '7');
    await waitFor('trajectoryChecks.renderer.frame.frameIndex === 7 && document.getElementById("loading").hidden', 'Frame 8');
    await evaluate('trajectoryChecks.showTool("cna"); document.getElementById("run-cna").click()');
    await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'Raw CNA');
    const raw = await evaluate('trajectoryChecks.fccCount()');
    const rawX = (await atom(tracked)).wrapped[0];
    await evaluate('trajectoryChecks.showTool("trajectory")');
    await change('trajectory-smooth-window', '3');
    await change('trajectory-smooth-enabled', true, true);
    await waitFor(`trajectoryChecks.renderer.frame.smoothing?.frameCount === 7 && document.getElementById('cna-state').textContent === 'Calculated'
      && document.getElementById('loading').hidden`, 'Smoothed CNA');
    const smoothed = await evaluate('trajectoryChecks.fccCount()');
    const smoothedAtom = await atom(tracked);
    assert.ok(raw < 160 && smoothed === 256, `raw ${raw}, smoothed ${smoothed}`);
    assert.ok(Math.abs(smoothedAtom.wrapped[0] - smoothedX(7, 3)) < 2e-3, `${smoothedAtom.wrapped[0]} vs ${smoothedX(7, 3)}`);
    assert.ok(Math.abs(smoothedAtom.wrapped[0] - rawX) > 1e-3);
    assert.equal(await evaluate('trajectoryChecks.requests.at(-1).trajectory?.smoothing'), 3);
    assert.match(await evaluate('document.getElementById("trajectory-smooth-status").textContent'), /average of 7 frames \(5–11\)/);
    // Stepping keeps smoothing; the window is truncated at the first frame.
    await change('frame-slider', '1');
    await waitFor('trajectoryChecks.renderer.frame.frameIndex === 1 && trajectoryChecks.renderer.frame.smoothing?.frameCount === 5', 'Truncated window');
    assert.ok(Math.abs((await atom(tracked)).wrapped[0] - smoothedX(1, 3)) < 2e-3);
    await change('frame-slider', '7');
    await waitFor(`trajectoryChecks.renderer.frame.frameIndex === 7 && trajectoryChecks.renderer.frame.smoothing?.frameCount === 7
      && document.getElementById('cna-state').textContent === 'Calculated'`, 'Back to frame 8');
    assert.equal(await evaluate('trajectoryChecks.fccCount()'), smoothed);

    // Lines for crossing atoms over every frame: continuous, outside the cell.
    const lineIds = crossing.slice(0, 3).map(index => index + 1);
    await change('trajectory-lines-ids', lineIds.join(' '));
    await change('trajectory-lines-first', '1');
    await change('trajectory-lines-last', String(frameCount));
    await change('trajectory-lines-stride', '1');
    await change('trajectory-lines-width', '3');
    await evaluate('document.getElementById("generate-trajectory-lines").click()');
    await waitFor('trajectoryChecks.renderer.trajectoryLines?.lineCount === 3', 'Trajectory lines');
    const lines = await evaluate(`trajectoryChecks.lineSummary(${tracked + 1})`);
    assert.equal(lines.vertexCount, 3 * frameCount);
    assert.ok(lines.maximumStep < 2, `largest step ${lines.maximumStep}`);
    assert.ok(lines.trackedMaximumX > L, 'the path continues beyond the periodic boundary');
    lines.trackedX.forEach((x, frame) => assert.ok(Math.abs((x - lines.trackedX[0]) - (continuous[frame][tracked][0] - continuous[0][tracked][0])) < 2e-3));
    // Lines follow file coordinates even while smoothing is on.
    assert.match(await evaluate('document.getElementById("trajectory-lines-status").textContent'), /^3 paths · 42 points · frames 1–14, every 1 frame\./);
    // Lines persist across frame changes.
    await change('frame-slider', '8');
    await waitFor('trajectoryChecks.renderer.frame.frameIndex === 8 && trajectoryChecks.renderer.frame.smoothing', 'Frame 9 with lines');
    assert.equal(await evaluate('trajectoryChecks.renderer.trajectoryLines?.lineCount'), 3);
    await change('frame-slider', '7');
    await waitFor(`trajectoryChecks.renderer.frame.frameIndex === 7 && document.getElementById('cna-state').textContent === 'Calculated'`, 'Frame 8 again');

    // Second view and image exports include the lines; exports scale width.
    await evaluate('trajectoryChecks.showTool("display"); trajectoryChecks.change("compare-view", true, true)');
    await waitFor('trajectoryChecks.comparison?.trajectoryLines === trajectoryChecks.renderer.trajectoryLines', 'Second-view lines');
    const exported = await evaluate('trajectoryChecks.exportDifference()');
    assert.ok(exported.current > 50 && exported.double > 2.5 * exported.current, JSON.stringify(exported));
    assert.equal(exported.glError, 0);
    await evaluate('trajectoryChecks.change("compare-view", false, true)');

    // Configuration round trip: export, then restore lines without smoothing.
    const recipe = await evaluate('trajectoryChecks.exportRecipe()');
    assert.deepEqual(recipe.settings.extensions.trajectory, { smoothing: { enabled: true, window: 3 },
      lines: { enabled: true, source: 'ids', selectionGroupId: null, atomIds: lineIds, firstFrame: 0, lastFrame: null, stride: 1,
        visible: true, color: '#ff9f1c', width: 3, colorByTime: false, colorScheme: 'viridis' } });
    recipe.settings.extensions.trajectory.smoothing.enabled = false;
    recipe.settings.extensions.trajectory.lines = { ...recipe.settings.extensions.trajectory.lines, stride: 2, colorByTime: true, colorScheme: 'magma' };
    await evaluate('trajectoryChecks.change("trajectory-lines-visible", false, true)');
    await evaluate(`trajectoryChecks.importRecipe(${JSON.stringify(JSON.stringify(recipe))})`);
    await waitFor(`document.getElementById("configuration-status").textContent.includes("restored")
      && trajectoryChecks.renderer.trajectoryLines?.vertexCount === ${3 * Math.ceil(frameCount / 2)} && !trajectoryChecks.renderer.frame.smoothing
      && document.getElementById('cna-state').textContent === 'Calculated'`, 'Recipe restoration');
    assert.deepEqual(await evaluate('trajectoryChecks.renderer.trajectoryLineOptions'),
      { visible: true, color: '#ff9f1c', width: 3, colorByTime: true, colorScheme: 'magma' });
    assert.equal(await evaluate('trajectoryChecks.fccCount()'), raw, 'restoring unsmoothed coordinates restores the raw CNA');
    assert.equal(await evaluate('document.getElementById("trajectory-smooth-enabled").checked'), false);

    // A recipe rejected after its smoothing setting was applied leaves the
    // setting on the displayed frame's coordinates, in both directions.
    const rejected = structuredClone(recipe);
    Object.assign(rejected.settings, { replicate: [2, 1, 1], replicateAtoms: true });
    rejected.settings.display.coordinateMode = 'unwrapped';
    const importRejected = async enabled => {
      rejected.settings.extensions.trajectory.smoothing = { enabled, window: 2 };
      await evaluate(`document.getElementById('toast').textContent = ''; trajectoryChecks.importRecipe(${JSON.stringify(JSON.stringify(rejected))})`);
      await waitFor(`document.getElementById('toast').textContent.includes('saved unwrapped view')`, 'Rejected recipe');
      return evaluate(`({ checked: document.getElementById('trajectory-smooth-enabled').checked, window: document.getElementById('trajectory-smooth-window').value,
        status: document.getElementById('trajectory-smooth-status').textContent, shown: trajectoryChecks.renderer.frame.smoothing?.window ?? 0 })`);
    };
    const rejectedOff = await importRejected(true);
    assert.deepEqual([rejectedOff.checked, rejectedOff.window, rejectedOff.shown], [false, '3', 0], JSON.stringify(rejectedOff));
    assert.match(rejectedOff.status, /^Off\./);
    // A recipe that turns smoothing on announces its own wait for the saved
    // frame and ends it. Frame 3 is held back for the reference read below.
    await evaluate('trajectoryChecks.hold(2)');
    recipe.settings.extensions.trajectory.smoothing.enabled = true;
    await evaluate(`document.getElementById('configuration-status').textContent = ''; trajectoryChecks.importRecipe(${JSON.stringify(JSON.stringify(recipe))})`);
    await waitFor(`document.getElementById("configuration-status").textContent.includes("restored") && trajectoryChecks.renderer.frame.smoothing?.frameCount === 7
      && document.getElementById('cna-state').textContent === 'Calculated'`, 'Recipe that turns smoothing on');
    assert.equal((await loading()).hidden, true, 'restoring a smoothed frame must not leave the loading indicator on');
    // A tool that reads its own reference frame reports in its panel; the
    // averaging progress of that read does not show the indicator.
    await evaluate('trajectoryChecks.showTool("displacement")');
    await change('displacement-reference-frame', '3');
    await evaluate('document.getElementById("run-displacement").click()');
    await delay(200);
    assert.equal(await evaluate(`trajectoryChecks.requests.some(request => request.index === 2 && request.trajectory?.smoothing === 3)`), true,
      'the reference frame must share a read using the active smoothing settings');
    assert.equal(await evaluate(`document.getElementById('displacement-state').textContent`), 'Calculating…',
      'the reference consumer stays active while the shared read is held');
    await evaluate('trajectoryChecks.release()');
    await waitFor(`document.getElementById('displacement-state').textContent === 'Calculated'`, 'Displacement from a smoothed reference');
    assert.equal((await loading()).hidden, true, 'a reference frame read must not leave the loading indicator on');
    await evaluate('trajectoryChecks.showTool("trajectory")');
    const rejectedOn = await importRejected(false);
    assert.deepEqual([rejectedOn.checked, rejectedOn.window, rejectedOn.shown], [true, '3', 3], JSON.stringify(rejectedOn));
    assert.match(rejectedOn.status, /average of 7 frames \(5–11\)/);
    assert.deepEqual((await evaluate('trajectoryChecks.exportRecipe()')).settings.extensions.trajectory.smoothing, { enabled: true, window: 3 });
    // The next frame is requested with the setting that is shown.
    await change('frame-slider', '8');
    await waitFor('trajectoryChecks.renderer.frame.frameIndex === 8 && trajectoryChecks.renderer.frame.smoothing?.window === 3', 'Smoothed frame after a rejected recipe');
    await change('trajectory-smooth-enabled', false, true);
    await waitFor(`!trajectoryChecks.renderer.frame.smoothing && document.getElementById('cna-state').textContent === 'Calculated'
      && document.getElementById('loading').hidden`, 'Smoothing off after the rejected recipes');

    // Phone layout keeps the panel inside the viewport.
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('trajectoryChecks.showTool("trajectory"); document.getElementById("generate-trajectory-lines").scrollIntoView({ block: "center" })');
    await delay(150);
    const mobile = await evaluate(`(() => ['trajectory-smooth-enabled', 'trajectory-smooth-window', 'trajectory-lines-source', 'trajectory-lines-ids',
      'trajectory-lines-first', 'trajectory-lines-last', 'trajectory-lines-stride', 'trajectory-lines-width', 'generate-trajectory-lines', 'cancel-trajectory-lines'].map(id => {
      const box = document.getElementById(id).getBoundingClientRect();
      return { id, width: box.width, fits: box.left >= 0 && box.right <= innerWidth };
    }))()`);
    assert.ok(mobile.every(item => item.fits && item.width > 0), JSON.stringify(mobile));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const screenshot = resolve(tmpdir(), `alloyview-trajectory-tools-mobile${isolated ? '-isolated' : ''}.png`);
    await writeFile(screenshot, Buffer.from(data, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    // Closing the tool removes the lines.
    await evaluate('document.getElementById("close-tool").click()');
    await waitFor('!trajectoryChecks.renderer.trajectoryLines', 'Closing the trajectory tool');
    const requests = await evaluate('({ total: trajectoryChecks.requests.length, promoted: trajectoryChecks.promotions.length })');
    return { adapter, isolated, trackedAtom: tracked + 1, crossingAtoms: crossing.length, unwrappedChecks, cna: { raw, smoothed }, requests,
      lines: { maximumStep: lines.maximumStep, maximumX: lines.trackedMaximumX }, exported, screenshot };
  }, { software: useSoftwareAdapter(true), isolated, requireGpu: false });
}

async function initializeChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { StructureWorkerClient }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./worker-client.js', app))]);
  const checks = window.trajectoryChecks = { requests: [], promotions: [] };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this; else checks.comparison = this;
    return setFrame.apply(this, args);
  };
  const frame = StructureWorkerClient.prototype.frame;
  // hold(index) keeps every read of one frame waiting until release().
  let held = null, gate = null, open = null;
  const heldReads = new Set();
  checks.hold = index => { held = index; gate = new Promise(resolve => { open = resolve; }); };
  checks.release = () => { held = null; open?.(); };
  StructureWorkerClient.prototype.frame = function(index, options = {}) {
    const row = { index, trajectory: options.trajectory ?? null, foreground: options.reportProgress !== false && !options.background };
    checks.requests.push(row);
    if (index !== held) return frame.call(this, index, options);
    const read = { row, options: { ...options } };
    heldReads.add(read);
    return gate.then(() => frame.call(this, index, read.options)).finally(() => heldReads.delete(read));
  };
  const promoteFrame = StructureWorkerClient.prototype.promoteFrame;
  StructureWorkerClient.prototype.promoteFrame = function(index, trajectory = null) {
    // The gate delays client dispatch, whereas a real parse is already known
    // to the client. Record a foreground join without demanding a duplicate
    // frame() call, and carry its priority across the artificial gate.
    checks.promotions.push({ index, trajectory });
    for (const read of heldReads) if (read.row.index === index && JSON.stringify(read.row.trajectory) === JSON.stringify(trajectory)) {
      read.options.background = false; read.options.reportProgress = true;
      read.row.foreground = true; read.row.promoted = true;
    }
    return promoteFrame.call(this, index, trajectory);
  };
  checks.change = (id, value, checkbox = false) => {
    const input = document.getElementById(id);
    if (checkbox) input.checked = value; else input.value = String(value);
    input.dispatchEvent(new Event(id === 'frame-slider' ? 'input' : 'change', { bubbles: true }));
    if (id === 'frame-slider') input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.showTool = name => {
    if (document.querySelector(`[data-tool-panel="${name}"]`).hidden) document.querySelector(`[data-tool-button="${name}"]`).click();
  };
  checks.atom = index => {
    const r = checks.renderer, frame = r.frame, base = index * 3;
    return { display: Array.from(r.rawDisplayPositions.subarray(base, base + 3)), wrapped: Array.from(frame.positions.subarray(base, base + 3)),
      image: frame.inferredUnwrap ? Array.from(frame.inferredUnwrap.imageFlags.subarray(base, base + 3)) : null, file: Boolean(frame.unwrappedPositions) };
  };
  checks.fccCount = () => {
    const property = checks.renderer.frame.properties.find(item => item.name === 'structureType');
    return property ? property.data.reduce((count, value) => count + (value === 1), 0) : -1;
  };
  checks.lineSummary = trackedId => {
    const lines = checks.renderer.trajectoryLines, vertices = lines.vertices;
    let maximumStep = 0;
    for (let line = 0; line < lines.lineCount; line++) {
      for (let vertex = lines.lineOffsets[line]; vertex + 1 < lines.lineOffsets[line + 1]; vertex++) {
        maximumStep = Math.max(maximumStep, Math.hypot(...[0, 1, 2].map(axis => vertices[(vertex + 1) * 4 + axis] - vertices[vertex * 4 + axis])));
      }
    }
    const line = lines.lineAtomIds.indexOf(trackedId), trackedX = [];
    for (let vertex = lines.lineOffsets[line]; vertex < lines.lineOffsets[line + 1]; vertex++) trackedX.push(vertices[vertex * 4]);
    return { vertexCount: lines.vertexCount, maximumStep, trackedX, trackedMaximumX: Math.max(...trackedX) };
  };
  const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const changed = (left, right) => {
    let count = 0;
    for (let pixel = 0; pixel < left.length / 4; pixel++) if ([0, 1, 2].some(channel => Math.abs(left[pixel * 4 + channel] - right[pixel * 4 + channel]) > 24)) count++;
    return count;
  };
  checks.exportDifference = () => {
    const r = checks.renderer, toggle = document.getElementById('trajectory-lines-visible');
    const capture = mode => pixels(r.captureImage({ resolution: { mode } }));
    const set = visible => { toggle.checked = visible; toggle.dispatchEvent(new Event('change', { bubbles: true })); };
    const withLines = { current: capture('current'), double: capture('2x') };
    set(false);
    const without = { current: capture('current'), double: capture('2x') };
    set(true);
    return { current: changed(withLines.current, without.current), double: changed(withLines.double, without.double), glError: r.gl.getError() };
  };
  checks.download = async id => {
    const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    let saved;
    URL.createObjectURL = function(blob) { saved = blob; return createUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = function() {};
    try {
      document.getElementById(id).click();
      const deadline = Date.now() + 30_000;
      while (!saved && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (!saved) throw new Error(`${id} did not produce a download.`);
      return saved.text();
    } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
  checks.exportRecipe = async () => JSON.parse(await checks.download('export-configuration'));
  checks.importRecipe = text => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], 'trajectory-recipe.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.ready = true;
}

try {
  const reports = [];
  for (const isolated of [false, true]) reports.push(await exercise({ isolated }));
  console.log(JSON.stringify(reports, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
