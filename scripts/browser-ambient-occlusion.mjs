import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Ambient occlusion in the production page: buried atoms darker than surface
// atoms, AO-off and zero intensity pixel-identical to the plain renderer,
// recomputation after visibility, slice, frame, origin and replication edits,
// exports (current view, chosen size, second view, frame ZIP), recipes, and
// timings on the 60k-atom Fe loop, also replicated to about one million atoms.
// Pass --hardware to use the physical GPU instead of SwiftShader. The
// million-atom stage runs on hardware, or on SwiftShader with --million;
// --skip-large stops after the fixture checks.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const software = useSoftwareAdapter(true);
const skipLarge = process.argv.includes('--skip-large');
const million = !software || process.argv.includes('--million');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-ambient-occlusion-'));
const fixture = resolve(directory, 'ao-block.xyz');

// A 5 × 5 × 5 simple-cubic block whose spacing (2.2 Å) is smaller than an
// atom's diameter, so no line of sight reaches its center. The 3 × 3 × 3 core
// is Fe and the shell Cu. Frame 2 lifts the top layer away, exposing layer 3.
const SIDE = 5, SPACING = 2.2, ORIGIN = 2.6;
const index = (i, j, k) => (i * SIDE + j) * SIDE + k;
function frame(step, lifted) {
  const rows = [];
  for (let i = 0; i < SIDE; i++) for (let j = 0; j < SIDE; j++) for (let k = 0; k < SIDE; k++) {
    const core = [i, j, k].every(value => value >= 1 && value <= 3);
    const z = ORIGIN + k * SPACING + (lifted && k === SIDE - 1 ? 12 : 0);
    rows.push(`${core ? 'Fe' : 'Cu'} ${ORIGIN + i * SPACING} ${ORIGIN + j * SPACING} ${z} ${index(i, j, k) + 1}`);
  }
  return [String(rows.length), `Lattice="14 0 0 0 14 0 0 0 14" Properties=species:S:1:pos:R:3:id:I:1 pbc="F F F" Step=${step}`, ...rows, ''].join('\n');
}
await writeFile(fixture, frame(0, false) + frame(100, true));
const started = Date.now();
const progress = message => console.error(`[ambient-occlusion ${((Date.now() - started) / 1000).toFixed(1)} s] ${message}`);
const atoms = { center: index(2, 2, 2), corner: index(0, 0, 0), face: index(2, 2, 0), coreCorner: index(1, 1, 1), layer3: index(2, 2, 3) };

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({status:document.getElementById("ambient-occlusion-status")?.textContent,toast:document.getElementById("toast")?.textContent})')}`);
    }
    await waitFor('document.readyState==="complete" && document.getElementById("ambient-occlusion")', 'Application startup');
    await evaluate(`(${installChecks.toString()})()`);
    await evaluate('if(document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true")document.getElementById("enable-gpu-computing").click()');
    async function load(path, atomCount) {
      const { root: dom } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: dom.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor(`aoChecks.renderer?.frame?.ids.length===${atomCount} && document.getElementById("loading").hidden && !document.getElementById("ambient-occlusion").disabled`, `load ${path}`, 300_000);
    }
    const change = (id, value) => evaluate(`aoChecks.change(${JSON.stringify(id)},${JSON.stringify(value)})`);
    const ready = (label, timeoutMs) => waitFor('aoChecks.ready()', label, timeoutMs);
    const factors = names => evaluate(`aoChecks.factors(${JSON.stringify(names ?? atoms)})`);

    await load(fixture, SIDE ** 3);
    await evaluate('aoChecks.renderer.setView("front");aoChecks.renderer.setProjection("orthographic");aoChecks.renderer.yaw+=0.5;aoChecks.renderer.pitch+=0.4;aoChecks.renderer.render()');
    const plain = await evaluate('aoChecks.snapshot("plain")');
    assert.equal(await evaluate('document.getElementById("ambient-occlusion-status").textContent'), 'Off. Atom colors are unchanged.');

    // Enable through the Display panel; the first result is computed at once.
    await evaluate('document.querySelector("[data-tool-button=display]").getAttribute("aria-expanded")!=="true"&&document.querySelector("[data-tool-button=display]").click();document.getElementById("ambient-occlusion-controls").open=true');
    await change('ambient-occlusion', true);
    await ready('first ambient occlusion result');
    const first = await factors();
    assert.ok(first.center < 0.02, `a buried atom receives (almost) no light: ${JSON.stringify(first)}`);
    assert.ok(first.center < first.face && first.face < first.corner, `buried < face < corner: ${JSON.stringify(first)}`);
    assert.ok(first.corner > 0.6 && first.maximum === 1 && first.minimum >= 0, JSON.stringify(first));
    assert.equal(first.length, SIDE ** 3);
    const shaded = await evaluate('aoChecks.compare("plain")');
    assert.ok(shaded.changedFraction > 0.02, `ambient occlusion changes the image: ${JSON.stringify(shaded)}`);
    assert.ok(shaded.darkerFraction > 0.99, `it only darkens: ${JSON.stringify(shaded)}`);

    // Zero intensity and Off are exact identities of the plain renderer.
    await change('ambient-occlusion-intensity', 0);
    const zero = await evaluate('aoChecks.compare("plain")');
    assert.equal(zero.different, 0, `intensity 0 is pixel-identical to the renderer without occlusion: ${JSON.stringify(zero)}`);
    await change('ambient-occlusion-intensity', 0.7);
    assert.equal(await evaluate('aoChecks.recomputations'), 1, 'intensity edits never recompute');
    await change('ambient-occlusion', false);
    const off = await evaluate('aoChecks.compare("plain")');
    assert.equal(off.different, 0, `Off restores identical pixels: ${JSON.stringify(off)}`);
    assert.equal(await evaluate('aoChecks.renderer.ambientOcclusionFactors'), null);
    await change('ambient-occlusion', true);
    await ready('re-enabled result');
    assert.deepEqual(await factors(), first, 'deterministic: the same inputs give identical factors');
    const deterministic = await evaluate('aoChecks.sameAsFirst()');
    assert.equal(deterministic, true, 'every factor is bitwise identical after recomputing');

    // Visibility: hiding the Cu shell exposes the Fe core.
    const before = await evaluate('aoChecks.recomputations');
    await evaluate('document.querySelector(\'#color-legend input[data-atom-type="Cu"]\').click()');
    // An export issued before the background update finishes is still current.
    const immediate = await evaluate('aoChecks.snapshot("hidden-immediate")');
    await ready('visibility update');
    const hidden = await factors();
    assert.ok(hidden.coreCorner > first.coreCorner + 0.3, `hidden shell exposes the core: ${JSON.stringify({ first, hidden })}`);
    assert.ok(hidden.center < hidden.coreCorner / 2, `the core center stays more occluded than its corners: ${JSON.stringify(hidden)}`);
    assert.ok(await evaluate('aoChecks.recomputations') > before);
    const settled = await evaluate('aoChecks.compare("hidden-immediate")');
    assert.equal(settled.different, 0, `an immediate export equals the settled view: ${JSON.stringify({ immediate, settled })}`);
    await evaluate('document.querySelector(\'#color-legend input[data-atom-type="Cu"]\').click()');
    await ready('visibility restored');
    assert.equal(await evaluate('aoChecks.sameAsFirst()'), true, 'showing the shell restores the original factors');

    // Slices: a cut through the center exposes it.
    await evaluate(`aoChecks.renderer.setSlices([{ id: 'ao', normal: [0, 0, 1], position: ${ORIGIN + 2 * SPACING + 0.1} }])`);
    await ready('slice update');
    const sliced = await factors();
    assert.ok(sliced.center > 0.3, `a cut exposes the buried atom: ${JSON.stringify(sliced)}`);
    await evaluate('aoChecks.renderer.setSlices([])');
    await ready('slice removed');
    assert.equal(await evaluate('aoChecks.sameAsFirst()'), true);

    // Chosen-size export uses the view's pipeline with occlusion: it matches the screen.
    const screen = await evaluate('aoChecks.screenMatch()');
    assert.ok(screen.changedFraction < 0.002, `offscreen export matches the occluded view: ${JSON.stringify(screen)}`);
    const exportShaded = await evaluate('aoChecks.compare("plain", { resolution: { mode: "custom", width: aoChecks.renderer.canvas.width, height: aoChecks.renderer.canvas.height } })');
    assert.ok(exportShaded.changedFraction > 0.02, `chosen-size exports include occlusion: ${JSON.stringify(exportShaded)}`);
    const transparent = await evaluate('aoChecks.transparentWhite()');
    assert.ok(transparent.maxDifference <= 2, `transparent exports keep occlusion: ${JSON.stringify(transparent)}`);

    // Bonds take their atoms' factors; off they are identical.
    const bonds = await evaluate('aoChecks.bonds()');
    assert.ok(bonds.changedWithOcclusion > 100 && bonds.identicalWhenOff, JSON.stringify(bonds));

    // Second view shares the result and exports it.
    await change('compare-view', true);
    await waitFor('aoChecks.comparison?.frame && aoChecks.comparison.ambientOcclusionFactors===aoChecks.renderer.ambientOcclusionFactors', 'second view');
    const second = await evaluate('aoChecks.secondView()');
    assert.ok(second.changedFraction > 0.02, `second-view export is occluded: ${JSON.stringify(second)}`);
    await change('compare-view', false);

    // Each frame of a ZIP is recomputed for its own atoms.
    await evaluate('aoChecks.recorded = []');
    await change('export-series-first', 1); await change('export-series-last', 2); await change('export-series-step', 1);
    await evaluate('aoChecks.beginDownload();document.getElementById("export-frame-series").click()');
    await waitFor('document.getElementById("export-series-status").textContent.includes("Exported 2 frames")', 'frame ZIP');
    await evaluate('aoChecks.restoreDownload()');
    await ready('restored frame');
    // Frame 1 was current at the start; frame 2 and the restored frame 1 are new results.
    const series = await evaluate(`aoChecks.recordedValues(${atoms.layer3})`);
    assert.ok(series.length >= 2, JSON.stringify(series));
    assert.ok(Math.max(...series) - Math.min(...series) > 0.15, `frame 2 exposes layer 3 during the ZIP export: ${JSON.stringify(series)}`);
    assert.equal(await evaluate('aoChecks.sameAsFirst()'), true, 'returning to frame 1 restores its factors');

    // Recipes: saved, validated and restored; old recipes stay off.
    await change('ambient-occlusion-intensity', 0.45);
    await change('ambient-occlusion-directions', 100);
    await change('ambient-occlusion-resolution', 512);
    await ready('settings update');
    const recipe = JSON.parse(await evaluate('aoChecks.download("export-configuration")'));
    assert.deepEqual(recipe.settings.display.ambientOcclusion, { enabled: true, intensity: 0.45, directions: 100, resolution: 512 });
    await change('ambient-occlusion', false);
    await evaluate(`aoChecks.importRecipe(${JSON.stringify(JSON.stringify(recipe))})`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'recipe restore');
    assert.deepEqual(await evaluate('aoChecks.controls()'), { enabled: true, intensity: '0.45', directions: '100', resolution: '512' });
    await ready('restored recipe');
    const legacy = structuredClone(recipe); delete legacy.settings.display.ambientOcclusion;
    await evaluate(`aoChecks.importRecipe(${JSON.stringify(JSON.stringify(legacy))})`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && !document.getElementById("ambient-occlusion").checked', 'legacy recipe');
    assert.equal(await evaluate('aoChecks.renderer.ambientOcclusionFactors'), null, 'recipes without the entry restore Off');
    const invalid = structuredClone(recipe); invalid.settings.display.ambientOcclusion.directions = 7;
    await evaluate(`aoChecks.importRecipe(${JSON.stringify(JSON.stringify(invalid))})`);
    await waitFor('/ambientOcclusion\\.directions is unsupported/.test(document.getElementById("toast").textContent)', 'invalid recipe rejected');

    // The controls fit a phone screen.
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('document.getElementById("ambient-occlusion-controls").open=true;document.getElementById("ambient-occlusion-cancel").scrollIntoView({block:"center"})');
    await delay(150);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth && document.getElementById("ambient-occlusion-controls").getBoundingClientRect().right<=innerWidth'), true, 'phone layout');
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    const result = { plain, shaded, zero, off, first, hidden, sliced, screen, exportShaded, transparent, bonds, second, series };
    progress('fixture checks passed');
    if (skipLarge) return result;

    // Timings on the 60k-atom Fe loop: background (yielding) and synchronous.
    await load(resolve(root, 'examples/Fe_disloc_loop.dump'), 60229);
    result.large = { atoms: 60229 };
    await change('ambient-occlusion-directions', 40); await change('ambient-occlusion-resolution', 1024);
    await change('ambient-occlusion', true);
    result.large.background = await evaluate('aoChecks.timeBackground()', { timeoutMs: 600_000 });
    result.large.synchronous = await evaluate('aoChecks.timeSynchronous()', { timeoutMs: 600_000 });
    progress(`60k atoms: ${JSON.stringify(result.large)}`);
    // The periodic display origin moves atoms and triggers a new result.
    await evaluate('aoChecks.recorded = []');
    await change('display-origin-a', 0.5);
    await ready('origin update', 600_000);
    assert.ok(await evaluate('aoChecks.recorded.length') >= 1, 'a periodic-origin change recomputes');
    await change('display-origin-a', 0);
    await ready('origin reset', 600_000);
    // Display replication: every copy has its own factors and they occlude each other.
    await change('replicate-a', 2); await evaluate('document.getElementById("apply-replicate").click()');
    await waitFor('aoChecks.renderer.replicas.length===2', 'replication');
    await ready('replicated result', 600_000);
    const copies = await evaluate('aoChecks.copies()');
    assert.equal(copies.length, 2 * 60229);
    assert.ok(copies.differing > 1000, `replicas receive different factors where they meet: ${JSON.stringify(copies)}`);
    progress(`origin and replication checks passed: ${JSON.stringify(copies)}`);
    // Cancel stops a running computation and leaves the previous result.
    await change('ambient-occlusion-resolution', 2048);
    await waitFor('aoChecks.status().state==="computing"', 'computation started', 600_000);
    await evaluate('document.getElementById("ambient-occlusion-cancel").click()');
    assert.equal(await evaluate('aoChecks.status().state'), 'cancelled');
    const steps = await evaluate('aoChecks.steps'); await delay(1500);
    assert.equal(await evaluate('aoChecks.steps'), steps, 'no work after Cancel');
    assert.ok(await evaluate('aoChecks.renderer.ambientOcclusionFactors?.length===2*60229'), 'the previous result stays displayed');
    await change('ambient-occlusion-resolution', 1024);
    await ready('resumed after a setting change', 600_000);
    if (!million) return result;
    // About one million displayed atoms.
    await change('replicate-a', 2); await change('replicate-b', 2); await change('replicate-c', 4);
    await evaluate('document.getElementById("apply-replicate").click()');
    await waitFor('aoChecks.renderer.replicas.length===16', 'million-atom replication');
    await ready('million-atom result', 1_800_000);
    result.million = { instances: 16 * 60229, background: await evaluate('aoChecks.lastTiming()') };
    progress(`million atoms, background: ${JSON.stringify(result.million.background)}`);
    result.million.synchronous = await evaluate('aoChecks.timeSynchronous()', { timeoutMs: 1_800_000 });
    progress(`million atoms, synchronous: ${JSON.stringify(result.million.synchronous)}`);
    await change('ambient-occlusion-resolution', 2048);
    await ready('million atoms at 2048', 1_800_000);
    result.million.background2048 = await evaluate('aoChecks.lastTiming()');
    return result;
  }, { software, requireGpu: false });
  console.log(JSON.stringify({ adapter: software ? 'SwiftShader' : 'hardware', ...report }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }

async function installChecks() {
  const app = document.querySelector('script[type="module"][src]').src;
  const [{ WebGLRenderer }, occlusion] = await Promise.all([import(new URL('./render/webgl-renderer.js', app)),
    import(new URL('./render/ambient-occlusion.js', app))]);
  const checks = window.aoChecks = { recomputations: 0, recorded: [], steps: 0, timings: [] };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) { checks[this.canvas.id === 'viewport' ? 'renderer' : 'comparison'] = this; return setFrame.apply(this, args); };
  const setAmbientOcclusion = WebGLRenderer.prototype.setAmbientOcclusion;
  WebGLRenderer.prototype.setAmbientOcclusion = function(factors, ...rest) {
    if (this.canvas.id === 'viewport' && factors && factors !== this.ambientOcclusionFactors) checks.recorded.push(factors);
    return setAmbientOcclusion.call(this, factors, ...rest);
  };
  const { AmbientOcclusionController, AmbientOcclusionPass } = occlusion, finish = AmbientOcclusionController.prototype.finish;
  const render = AmbientOcclusionPass.prototype.render, update = AmbientOcclusionController.prototype.update;
  AmbientOcclusionController.prototype.finish = function(job) {
    checks.recomputations++; checks.controller = this;
    const result = finish.call(this, job); checks.timings.push({ ...this.result, factors: undefined, inputs: undefined }); return result;
  };
  AmbientOcclusionPass.prototype.render = function(...args) { checks.steps++; return render.apply(this, args); };
  AmbientOcclusionController.prototype.update = function(...args) { if (this.renderer.canvas?.id === 'viewport') checks.controller = this; return update.apply(this, args); };
  const advance = AmbientOcclusionController.prototype.advance;
  AmbientOcclusionController.prototype.advance = function() {
    const started = performance.now(); const result = advance.call(this);
    checks.longestSlice = Math.max(checks.longestSlice ?? 0, performance.now() - started); return result;
  };
  checks.status = () => checks.controller?.status ?? { state: 'unknown' };
  // Current only when the displayed factors belong to the present inputs;
  // the previous result stays visible while an update is queued.
  checks.ready = () => {
    const controller = checks.controller, result = controller?.result;
    return document.getElementById('ambient-occlusion-status').textContent.startsWith('Current:') && Boolean(result)
      && !controller.job && !controller.pending && controller.matches(result.inputs)
      && checks.renderer.ambientOcclusionFactors === result.factors && checks.renderer.ambientOcclusionActive();
  };
  checks.change = (id, value) => {
    const element = document.getElementById(id); if (typeof value === 'boolean') element.checked = value; else element.value = String(value);
    element.dispatchEvent(new Event(element.type === 'range' ? 'input' : 'change', { bubbles: true }));
    if (element.type === 'range') element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.controls = () => ({ enabled: document.getElementById('ambient-occlusion').checked, intensity: document.getElementById('ambient-occlusion-intensity').value,
    directions: document.getElementById('ambient-occlusion-directions').value, resolution: document.getElementById('ambient-occlusion-resolution').value });
  checks.factors = names => {
    const values = checks.renderer.ambientOcclusionFactors, result = Object.fromEntries(Object.entries(names).map(([name, atom]) => [name, values[atom]]));
    let minimum = Infinity, maximum = -Infinity; for (const value of values) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    if (!checks.first) checks.first = values.slice();
    return { ...result, minimum, maximum, length: values.length };
  };
  checks.sameAsFirst = () => {
    const values = checks.renderer.ambientOcclusionFactors;
    return values.length === checks.first.length && values.every((value, index) => Object.is(value, checks.first[index]));
  };
  const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const images = new Map();
  checks.snapshot = (name, options = {}) => {
    const data = pixels(checks.renderer.captureImage(options)); images.set(name, data);
    let sum = 0; for (let index = 0; index < data.length; index += 97) sum = (sum * 31 + data[index]) >>> 0;
    return { width: checks.renderer.canvas.width, height: checks.renderer.canvas.height, checksum: sum };
  };
  const difference = (a, b) => {
    let different = 0, changed = 0, darker = 0;
    for (let pixel = 0; pixel < a.length / 4; pixel++) {
      let delta = 0, sign = 0;
      for (let channel = 0; channel < 4; channel++) {
        const value = b[pixel * 4 + channel] - a[pixel * 4 + channel];
        delta = Math.max(delta, Math.abs(value)); if (channel < 3) sign += value;
      }
      if (delta) different++;
      if (delta > 5) { changed++; if (sign <= 0) darker++; }
    }
    return { different, changedFraction: changed / (a.length / 4), darkerFraction: changed ? darker / changed : 1 };
  };
  checks.compare = (name, options = {}) => difference(images.get(name), pixels(checks.renderer.captureImage(options)));
  checks.screenMatch = () => {
    const r = checks.renderer, resolution = { mode: 'custom', width: r.canvas.width, height: r.canvas.height };
    const screen = pixels(r.captureImage()), offscreen = pixels(r.captureImage({ resolution }));
    return { ...difference(screen, offscreen), samples: r.lastExportStats.samples };
  };
  checks.transparentWhite = () => {
    const r = checks.renderer, background = r.background.slice(); r.setBackground('#ffffff');
    const resolution = { mode: 'custom', width: 640, height: 480 };
    const opaque = r.captureImage({ resolution }), transparent = r.captureImage({ resolution, includeBackground: false });
    const composited = document.createElement('canvas'); composited.width = opaque.width; composited.height = opaque.height;
    const context = composited.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, opaque.width, opaque.height); context.drawImage(transparent, 0, 0);
    const aa = pixels(opaque), bb = pixels(composited); let maxDifference = 0;
    for (let index = 0; index < aa.length; index++) if (index % 4 !== 3) maxDifference = Math.max(maxDifference, Math.abs(aa[index] - bb[index]));
    r.setBackground(`#${background.map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`);
    return { maxDifference };
  };
  checks.bonds = () => {
    const r = checks.renderer, count = r.atomCount, indices = [], vectors = [];
    for (let atom = 0; atom < count; atom++) if (atom % 5 < 4) { indices.push(atom, atom + 1); vectors.push(0, 0, 2.2); }
    r.setBonds({ indices: new Uint32Array(indices), vectors: new Float32Array(vectors) }, { radius: 0.5, visible: true });
    r.setRadiusScale(0.35);
    // A radius change is an input: wait synchronously through an export.
    const factors = r.ambientOcclusionFactors;
    const withOcclusion = pixels(r.captureImage());
    const intensity = r.ambientOcclusionIntensity; r.setAmbientOcclusion(r.ambientOcclusionFactors, { intensity: 0 });
    const hook = r.onBeforeCapture; r.onBeforeCapture = null;
    const zero = pixels(r.captureImage());
    r.setAmbientOcclusion(null); const off = pixels(r.captureImage());
    r.onBeforeCapture = hook;
    let changedWithOcclusion = 0, identicalWhenOff = true;
    for (let index = 0; index < off.length; index += 4) {
      if (Math.abs(withOcclusion[index] - off[index]) > 5) changedWithOcclusion++;
      if (zero[index] !== off[index] || zero[index + 1] !== off[index + 1] || zero[index + 2] !== off[index + 2]) identicalWhenOff = false;
    }
    r.setBonds(null); r.setRadiusScale(1);
    r.setAmbientOcclusion(factors, { intensity });
    return { changedWithOcclusion, identicalWhenOff };
  };
  checks.secondView = () => {
    const c = checks.comparison, factors = c.ambientOcclusionFactors, intensity = c.ambientOcclusionIntensity;
    const shaded = pixels(c.captureImage());
    const hook = c.onBeforeCapture; c.onBeforeCapture = null;
    c.setAmbientOcclusion(null); const off = pixels(c.captureImage()); c.onBeforeCapture = hook;
    c.setAmbientOcclusion(factors, { intensity });
    return difference(off, shaded);
  };
  checks.recordedValues = atom => checks.recorded.map(values => values[atom]);
  const oldUrl = URL.createObjectURL, oldClick = HTMLAnchorElement.prototype.click;
  checks.beginDownload = () => {
    checks.downloaded = null;
    URL.createObjectURL = function(blob) { checks.downloaded = blob; return oldUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = function() {};
  };
  checks.restoreDownload = () => { URL.createObjectURL = oldUrl; HTMLAnchorElement.prototype.click = oldClick; };
  checks.download = async id => {
    checks.beginDownload();
    try { document.getElementById(id).click(); for (let attempt = 0; attempt < 200 && !checks.downloaded; attempt++) await new Promise(done => setTimeout(done, 10)); return await checks.downloaded.text(); }
    finally { checks.restoreDownload(); }
  };
  checks.importRecipe = text => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], 'ao-settings.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.lastTiming = () => {
    const timing = checks.timings.at(-1);
    return { elapsedMs: Math.round(timing.elapsedMs), workMs: Math.round(timing.workMs), directions: timing.directions, resolution: timing.resolution,
      instances: timing.instances, longestSliceMs: Math.round(checks.longestSlice ?? 0) };
  };
  checks.timeBackground = async () => {
    checks.longestSlice = 0;
    const started = performance.now();
    for (;;) { if (checks.ready() && checks.timings.length && checks.controller?.result) break; await new Promise(done => setTimeout(done, 20)); }
    return { ...checks.lastTiming(), wallMs: Math.round(performance.now() - started) };
  };
  checks.timeSynchronous = () => {
    const r = checks.renderer, controller = checks.controller;
    controller.result = null; controller.stop();
    const started = performance.now(); controller.ensureCurrent();
    return { ...checks.lastTiming(), synchronousMs: Math.round(performance.now() - started) };
  };
  checks.copies = () => {
    const r = checks.renderer, values = r.ambientOcclusionFactors, count = r.atomCount;
    let differing = 0; for (let atom = 0; atom < count; atom++) if (Math.abs(values[atom] - values[count + atom]) > 0.1) differing++;
    return { length: values.length, differing };
  };
}
