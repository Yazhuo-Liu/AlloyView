import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Production UI and file parser. A face-centered cubic crystal (a = 4 Å,
// 4 × 4 × 4 cells) has one (002) plane of 32 atoms in each 2 Å slab along c:
// 32 atoms in 512 Å³ is 0.0625 Å⁻³, the FCC density 4/a³. The per-atom column
// q is the plane index in frame 1 and ten times it in frame 2.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-binning-'));
const fixture = 'binning-fixture.xyz', fixturePath = resolve(temporary, fixture);
const loopPath = resolve(root, 'examples/Fe_disloc_loop.dump');
function fccFrame(step, scale) {
  const lines = [];
  let id = 1;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) {
    for (const [x, y, z] of [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]]) {
      const position = [(i + x) * 4, (j + y) * 4, (k + z) * 4 + 0.5];
      lines.push(`Ni ${position.join(' ')} ${id++} ${Math.floor(position[2] / 2) * scale}`);
    }
  }
  return [String(lines.length), `Lattice="16 0 0 0 16 0 0 0 16" Properties=species:S:1:pos:R:3:id:I:1:q:R:1 pbc="T T T" Step=${step}`, ...lines, ''].join('\n');
}
await writeFile(fixturePath, fccFrame(0, 1) + fccFrame(100, 10));

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
      throw new Error(`${label}: ${await evaluate(`JSON.stringify({ state: document.getElementById('binning-state')?.textContent,
        status: document.getElementById('binning-status')?.textContent, summary: document.getElementById('binning-summary')?.textContent,
        toast: document.getElementById('toast')?.textContent, recipe: document.getElementById('configuration-status')?.textContent })`)}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("run-binning")', 'Binning production page startup');
    await evaluate(`(${initializeChecks.toString()})()`);
    await waitFor('window.binningChecks?.ready', 'Binning check modules');
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
    if (isolated) assert.equal(await evaluate('crossOriginIsolated && typeof SharedArrayBuffer === "function"'), true);
    else assert.equal(await evaluate('crossOriginIsolated'), false);
    async function openFile(path, name) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(name)} && binningChecks.renderer?.frame
        && document.getElementById('loading').hidden && !document.getElementById('run-binning').disabled`, `${name} import`);
    }
    const change = (id, value, checkbox = false, event = 'change') => evaluate(
      `binningChecks.change(${JSON.stringify(id)}, ${JSON.stringify(value)}, ${checkbox}, ${JSON.stringify(event)})`);
    async function calculated(label, summary = '') {
      await waitFor(`document.getElementById('binning-state').textContent === 'Calculated'
        && document.getElementById('binning-summary').textContent.includes(${JSON.stringify(summary)})`, label);
      return evaluate('binningChecks.readout()');
    }
    const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${label}: ${actual} ≈ ${expected}`);
    const csvRows = async () => {
      const csv = await evaluate('binningChecks.download("export-binning")');
      return { filename: csv.filename, rows: csv.text.trim().split(/\r\n/).map(line => line.split(',')) };
    };

    await openFile(fixturePath, fixture);
    await evaluate('binningChecks.showTool("binning")');
    assert.equal(await evaluate('document.getElementById("binning-average-field").hidden'), false, 'trajectories offer an average');
    await change('binning-axis-1', 'c');
    await change('binning-bins-1', '8');
    await evaluate('document.getElementById("run-binning").click()');
    const density = await calculated('FCC density profile', 'frame 1');
    assert.equal(density.bins.length, 8);
    for (const bin of density.bins) assert.match(bin, /Number density 0\.0625 Å⁻³ · 32 atoms$/);
    assert.match(density.bins[0], /^c bin 1 of 8: 0–2 Å/);
    assert.equal(await evaluate('document.querySelectorAll("#binning-chart svg .binning-profile-line").length'), 1);
    assert.match(await evaluate('document.getElementById("binning-geometry").textContent'), /slab parallel to a and b, 2 Å wide along c/);
    const densityCsv = await csvRows();
    assert.deepEqual(densityCsv.rows[0], ['source_file', 'frame_number', 'timestep', 'c_bin', 'c_lower_fraction', 'c_upper_fraction',
      'c_lower [Å]', 'c_upper [Å]', 'c_center [Å]', 'number_density [Å⁻³]', 'atom_count', 'skipped_non_finite']);
    assert.equal(densityCsv.rows.length, 9);
    assert.deepEqual(densityCsv.rows[1], [fixture, '1', '0', '1', '0', '0.125', '0', '2', '1', '0.0625', '32', '0']);
    assert.deepEqual(densityCsv.rows[8].slice(3), ['8', '0.875', '1', '14', '16', '15', '0.0625', '32', '0']);
    assert.equal(densityCsv.filename, 'binning-fixture-frame-1-binning.csv');

    // Mean of an imported column, then the same settings on frame 2.
    await change('binning-quantity', 'property:q');
    assert.equal(await evaluate('document.getElementById("binning-reduction-field").hidden'), false);
    const meanFirst = await calculated('Mean q in frame 1', 'frame 1');
    meanFirst.bins.forEach((text, bin) => assert.match(text, new RegExp(`Mean q ${bin} · 32 atoms$`)));
    await change('frame-slider', '1', false, 'input');
    const meanSecond = await calculated('Mean q in frame 2', 'frame 2');
    meanSecond.bins.forEach((text, bin) => assert.match(text, new RegExp(`Mean q ${bin * 10} · 32 atoms$`)));
    const secondCsv = await csvRows();
    assert.equal(secondCsv.rows[0][9], 'mean(q)');
    assert.deepEqual(secondCsv.rows.slice(1).map(row => [row[1], row[2], row[9]]), Array.from({ length: 8 }, (_, bin) => ['2', '100', String(bin * 10)]));
    await change('binning-reduction', 'stddev');
    const deviation = await calculated('Standard deviation in frame 2', 'frame 2');
    deviation.bins.forEach(text => assert.match(text, /Standard deviation q 0 · 32 atoms$/));
    await change('binning-reduction', 'mean');
    await calculated('Mean again', 'frame 2');

    // A map along c and a; slabs of one plane split into 4 columns of 8 atoms.
    await change('binning-mode', '2d');
    await change('binning-axis-2', 'a');
    await change('binning-bins-2', '4');
    const map = await calculated('Map of q', 'frame 2');
    assert.equal(await evaluate('Boolean(document.querySelector("#binning-chart svg image.binning-map-image")?.getAttribute("href")?.startsWith("data:image/png"))'), true);
    assert.equal(await evaluate('document.querySelectorAll("#binning-chart svg .binning-colorbar").length'), 1);
    assert.match(map.mapBin, /^c bin 3 of 8: 4–6 Å · a bin 2 of 4: 4–8 Å · Mean q 20 · 8 atoms$/);
    const mapCsv = await csvRows();
    assert.equal(mapCsv.rows.length, 33);
    assert.deepEqual(mapCsv.rows[0].slice(3, 10), ['c_bin', 'c_lower_fraction', 'c_upper_fraction', 'c_lower [Å]', 'c_upper [Å]', 'c_center [Å]', 'a_bin']);
    assert.deepEqual(mapCsv.rows[6].slice(3, 4).concat(mapCsv.rows[6].slice(9, 10), mapCsv.rows[6].slice(-3)), ['2', '2', '10', '8', '0']);
    const desktopScreenshot = await screenshot(call, evaluate, `alloyview-binning-map${isolated ? '-isolated' : ''}.png`);

    // Average over both frames: q is 5.5 × the plane index.
    await change('binning-mode', '1d');
    await change('binning-average-frames', true, true);
    const average = await calculated('Trajectory average', 'averaged over 2 frames');
    average.bins.forEach((text, bin) => assert.match(text, new RegExp(`Mean q ${bin * 5.5} · 32 atoms$`)));
    const averageCsv = await csvRows();
    assert.equal(averageCsv.rows[0].at(-1), 'frames_averaged');
    assert.deepEqual(averageCsv.rows[1].slice(0, 3), [fixture, '1-2', '']);
    assert.equal(averageCsv.filename, 'binning-fixture-all-frames-binning.csv');
    await change('frame-slider', '0', false, 'input');
    await waitFor('binningChecks.renderer.frame.frameIndex === 0 && document.getElementById("loading").hidden', 'Frame 1 with an average');
    assert.match(await evaluate('document.getElementById("binning-summary").textContent'), /averaged over 2 frames/);
    await change('binning-average-frames', false, true);
    await calculated('Single frame again', 'frame 1');

    // Recipes store and replay the settings.
    const recipe = await evaluate('binningChecks.exportRecipe()');
    assert.deepEqual(recipe.settings.extensions.binning, { enabled: true, mode: '1d', axes: ['c', 'a'], bins: [8, 4], quantity: 'property',
      property: 'property:q', reduction: 'mean', selectionGroupId: null, averageFrames: false, colorScheme: 'viridis' });
    recipe.settings.extensions.binning = { ...recipe.settings.extensions.binning, quantity: 'count', property: null, selectionGroupId: 'top' };
    recipe.settings.selectionGroups = { groups: [{ id: 'top', name: 'Top', color: '#22c1c3', visible: true,
      atomIds: Array.from({ length: 256 }, (_, index) => index + 1).filter(id => (id - 1) % 4 >= 2) }], selectedGroupId: null };
    await evaluate(`binningChecks.importRecipe(${JSON.stringify(JSON.stringify(recipe))})`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'Binning recipe restoration');
    const restored = await calculated('Restored selection-restricted count', 'outside Top');
    assert.equal(await evaluate('document.getElementById("binning-selection").value'), 'top');
    assert.equal(await evaluate('document.getElementById("binning-quantity").value'), 'count');
    // IDs follow i, j, k, then the basis: its last two sites form the planes at z = 2.5 Å (mod 4).
    restored.bins.forEach((text, bin) => assert.match(text, new RegExp(`Atom count ${bin % 2 ? 32 : 0} · ${bin % 2 ? 32 : 0} atoms$`)));

    // Phone layout keeps controls and the chart inside the viewport.
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('binningChecks.showTool("binning"); document.getElementById("run-binning").scrollIntoView({ block: "center" })');
    await delay(150);
    const mobile = await evaluate(`(() => ['binning-mode', 'binning-axis-1', 'binning-bins-1', 'binning-quantity', 'binning-selection', 'run-binning', 'export-binning', 'binning-chart'].map(id => {
      const box = document.getElementById(id).getBoundingClientRect();
      return { id, width: box.width, fits: box.left >= 0 && box.right <= innerWidth };
    }))()`);
    assert.ok(mobile.every(item => item.fits && item.width > 0), JSON.stringify(mobile));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const phoneScreenshot = await screenshot(call, evaluate, `alloyview-binning-mobile${isolated ? '-isolated' : ''}.png`);
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    await evaluate('document.getElementById("cancel-binning").click()');
    await waitFor(`document.getElementById('binning-state').textContent === 'Not calculated' && document.getElementById('binning-results').hidden
      && document.getElementById('export-binning').disabled`, 'Cancel clears the profile');

    // The 60,229-atom triclinic dislocation loop: the UI profile equals the
    // direct kernel, and the browser Worker equals it bit for bit.
    await openFile(loopPath, 'Fe_disloc_loop.dump');
    await evaluate('binningChecks.showTool("binning")');
    await change('binning-quantity', 'property:c_atom_pe');
    await change('binning-reduction', 'stddev');
    await change('binning-axis-1', 'b');
    await change('binning-bins-1', '64');
    await evaluate('document.getElementById("run-binning").click()');
    await calculated('Fe loop potential energy profile', 'frame 1');
    const loopCsv = await csvRows();
    const parity = await evaluate(`binningChecks.parity(${JSON.stringify(loopCsv.rows.slice(1).map(row => row[9]))})`);
    assert.equal(parity.ui, true, 'UI profile values equal the direct kernel');
    assert.equal(parity.worker, true, `Worker arrays equal the direct kernel (${parity.mismatch})`);
    const timings = [];
    for (let run = 0; run < 3; run++) {
      await change('binning-bins-1', String(63 + run * 2));
      await calculated(`Fe loop warm run ${run + 1}`, 'frame 1');
      timings.push(await evaluate('document.getElementById("binning-status").textContent'));
    }
    return { adapter, isolated, density: density.bins[0], average: average.bins[7], map: map.mapBin, mobile,
      loop: { atoms: 60229, parity, uiStatus: timings }, screenshots: [desktopScreenshot, phoneScreenshot] };
  }, { software: useSoftwareAdapter(true), isolated, requireGpu: false });
}

async function screenshot(call, evaluate, name) {
  await evaluate('document.getElementById("binning-results").scrollIntoView({ block: "center" })');
  await delay(100);
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  const path = resolve(tmpdir(), name);
  await writeFile(path, Buffer.from(data, 'base64'));
  return path;
}

try {
  const reports = [];
  for (const isolated of [false, true]) reports.push(await exercise({ isolated }));
  console.log(JSON.stringify(reports, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { accumulateSpatialBins, finalizeSpatialBins }, { SpatialBinningClient }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/spatial-binning.js', app)),
    import(new URL('./binning-client.js', app)),
  ]);
  const checks = window.binningChecks = {};
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this;
    return setFrame.apply(this, args);
  };
  checks.change = (id, value, checkbox = false, event = 'change') => {
    const input = document.getElementById(id);
    if (checkbox) input.checked = value; else input.value = String(value);
    input.dispatchEvent(new Event(event, { bubbles: true }));
  };
  checks.showTool = name => {
    if (document.querySelector(`[data-tool-panel="${name}"]`).hidden) document.querySelector(`[data-tool-button="${name}"]`).click();
  };
  // Inspect every bin through the chart's own slider and readout.
  checks.readout = () => {
    const chart = document.getElementById('binning-chart'), sliders = [...chart.querySelectorAll('input[type=range]')];
    const readout = chart.querySelector('output');
    const bins = [];
    if (sliders.length === 1) {
      for (let bin = 0; bin <= Number(sliders[0].max); bin++) {
        sliders[0].value = String(bin); sliders[0].dispatchEvent(new Event('input'));
        bins.push(readout.textContent);
      }
      return { bins };
    }
    sliders[0].value = '2'; sliders[0].dispatchEvent(new Event('input'));
    sliders[1].value = '1'; sliders[1].dispatchEvent(new Event('input'));
    return { bins, mapBin: readout.textContent };
  };
  checks.parity = csvValues => {
    const frame = checks.renderer.frame, property = frame.properties.find(item => item.name === 'c_atom_pe');
    const request = { axes: [1], bins: [64], values: property.data, stddev: true };
    const direct = accumulateSpatialBins(frame, request);
    const values = finalizeSpatialBins(direct, { quantity: 'property', reduction: 'stddev' }).values;
    const ui = csvValues.length === values.length && csvValues.every((text, index) => text === String(values[index]));
    const client = new SpatialBinningClient({ workerMinAtoms: 1 });
    return client.accumulate(frame, request).then(remote => {
      let mismatch = null;
      for (const name of ['counts', 'valid', 'skipped', 'sum', 'min', 'max', 'm2', 'densitySum']) {
        for (let index = 0; index < direct[name].length && !mismatch; index++) if (!Object.is(remote[name][index], direct[name][index])) mismatch = `${name}[${index}]`;
      }
      const started = performance.now();
      return client.accumulate(frame, request).then(() => {
        const workerMs = performance.now() - started, directStarted = performance.now();
        accumulateSpatialBins(frame, request);
        client.dispose();
        return { ui, worker: mismatch === null, mismatch, workerMs, directMs: performance.now() - directStarted };
      });
    });
  };
  checks.download = async id => {
    const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    let saved, filename;
    URL.createObjectURL = function(blob) { saved = blob; return createUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = function() { filename = this.download; };
    try {
      document.getElementById(id).click();
      const deadline = Date.now() + 30_000;
      while (!saved && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (!saved) throw new Error(`${id} did not produce a download.`);
      return { text: await saved.text(), filename };
    } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
  checks.exportRecipe = async () => JSON.parse((await checks.download('export-configuration')).text);
  checks.importRecipe = text => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], 'binning-recipe.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.ready = true;
}
