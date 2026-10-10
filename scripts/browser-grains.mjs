import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';
import { axisAngleQuaternion, polycrystalDumpText, polycrystalFrame } from '../tests/helpers/polycrystal.js';

// Production UI, real file parser, PTM Wasm Workers and the grain Worker.
// Every published array is compared element-wise with the direct kernels in
// the same page, on a host without and with cross-origin isolation.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-grains-'));
const fixture = 'grain-fixture.dump', fixturePath = resolve(temporary, fixture);
const nickelPath = resolve(root, 'examples/NiGB_minimized.cfg');
// Frame 1: four FCC grains. Frame 2: two grains of the same box.
const box = [56, 56, 36];
const four = polycrystalFrame({ lattice: 'fcc', a: 3.52, box, noise: .04, seed: 5,
  seeds: [[14, 14, 18], [42, 14, 18], [14, 42, 18], [42, 42, 18]],
  orientations: [axisAngleQuaternion([0, 0, 1], 0), axisAngleQuaternion([0, 0, 1], 25), axisAngleQuaternion([1, 0, 0], 31), axisAngleQuaternion([1, 1, 0], 38)] });
const two = polycrystalFrame({ lattice: 'fcc', a: 3.52, box, noise: .04, seed: 6,
  seeds: [[14, 28, 18], [42, 28, 18]], orientations: [axisAngleQuaternion([0, 0, 1], 0), axisAngleQuaternion([0, 1, 1], 33)] });
await writeFile(fixturePath, polycrystalDumpText(four, { timestep: 0 }) + polycrystalDumpText(two, { timestep: 100 }));

async function exercise({ isolated }) {
  return withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 240_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(40);
      }
      throw new Error(`${label}: ${await evaluate(`JSON.stringify({ state: document.getElementById('grains-state')?.textContent,
        status: document.getElementById('grains-status')?.textContent, toast: document.getElementById('toast')?.textContent,
        recipe: document.getElementById('configuration-status')?.textContent })`)}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("run-grains")', 'Grain production page startup');
    await evaluate(`(${initializeChecks.toString()})()`);
    await waitFor('window.grainChecks?.ready', 'Grain check modules');
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
    async function openFile(path, name) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(name)} && grainChecks.renderer?.frame
        && document.getElementById('loading').hidden && !document.getElementById('run-grains').disabled`, `${name} import`);
    }
    async function calculated(label, { frameIndex = null, parity = true } = {}) {
      await waitFor(`document.getElementById('grains-state').textContent === 'Calculated' && grainChecks.property('grainId')
        ${frameIndex === null ? '' : `&& grainChecks.renderer.frame.frameIndex === ${frameIndex}`}`, label);
      const view = await evaluate(`grainChecks.view(${parity})`);
      if (parity) assert.equal(view.mismatch, null, `${label}: Worker arrays must equal the direct kernels (${view.mismatch})`);
      return view;
    }
    const change = (id, value, checkbox = false, event = 'change') => evaluate(
      `grainChecks.change(${JSON.stringify(id)}, ${JSON.stringify(value)}, ${checkbox}, ${JSON.stringify(event)})`);

    if (isolated) assert.equal(await evaluate('crossOriginIsolated && typeof SharedArrayBuffer === "function"'), true);
    else assert.equal(await evaluate('crossOriginIsolated'), false);

    await openFile(fixturePath, fixture);
    await evaluate('grainChecks.showTool("grains")');
    // Match OVITO's default templates (FCC, HCP, BCC) for this check.
    await evaluate(`for (const input of document.querySelectorAll('[data-ptm-template]')) {
      const wanted = ['1', '2', '4'].includes(input.dataset.ptmTemplate);
      if (input.checked !== wanted) { input.checked = wanted; input.dispatchEvent(new Event('change', { bubbles: true })); } }`);
    assert.equal(await evaluate('document.getElementById("grains-threshold").disabled'), true, 'the automatic threshold is an output');
    await evaluate('document.getElementById("run-grains").click()');
    const first = await calculated('Four-grain frame', { frameIndex: 0 });
    assert.equal(first.grainCount, 4);
    assert.equal(first.atoms, four.ids.length);
    assert.equal(first.unassigned, 0, 'orphan adoption assigns every atom');
    assert.equal(first.ptmIdentical, true, 'PTM outputs do not depend on the neighbor-list option');
    assert.ok(first.sizes.every((size, index) => index === 0 || size <= first.sizes[index - 1]), 'grain 1 is the largest');
    // Each found grain is one constructed grain, apart from boundary atoms.
    const truth = await evaluate(`grainChecks.purity(${JSON.stringify(Array.from(four.grainOf))})`);
    assert.ok(truth.purity > .97 && truth.distinct === 4, JSON.stringify(truth));
    assert.equal(first.mode, 'property:grainId');
    assert.deepEqual(first.legend.map(text => text.split(/\d/)[0].trim()), ['Grain', 'Grain', 'Grain', 'Grain']);
    assert.equal(first.rows, 4);
    assert.match(first.summary, /^4 grains · mean [\d,.]+ atoms · largest [\d,]+ · every atom in a grain/);
    assert.match(first.backend, /CPU · 1 Worker/);
    assert.equal(first.chart.thresholds, 1, 'the applied threshold is marked');
    assert.ok(first.chart.points >= 1 && first.chart.legend.length === 2);
    assert.match(first.chart.readout, /Log merge distance [\d.]+ · merge size [\d,]+ atoms · merged/);
    assert.ok(Number(first.thresholdField) >= first.threshold && Number(first.thresholdField) - first.threshold < 1.01e-4, 'the automatic value is shown, rounded up');
    assert.equal(first.attributes.count, 4);
    assert.ok(Math.abs(first.attributes.mean - four.ids.length / 4) < 1e-9);

    await evaluate('document.getElementById("grains-results").scrollIntoView({ block: "start" })');
    await delay(100);
    const { data: desktop } = await call('Page.captureScreenshot', { format: 'png' });
    const desktopScreenshot = resolve(tmpdir(), `alloyview-grains-desktop${isolated ? '-isolated' : ''}.png`);
    await writeFile(desktopScreenshot, Buffer.from(desktop, 'base64'));

    // CSV tables.
    const table = await evaluate('grainChecks.download("export-grain-table")');
    const rows = table.text.trim().split(/\r\n/).map(line => line.split(','));
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0].slice(3, 9), ['grain_id', 'atom_count', 'atom_fraction', 'structure_type', 'structure_type_id', 'orientation_w']);
    assert.deepEqual(rows.slice(1).map(row => [row[3], Number(row[4]), row[6]]), first.sizes.map((size, index) => [String(index + 1), size, 'FCC']));
    assert.ok(rows.slice(1).every(row => Number(row.at(-2)) > 0 && row.at(-1) === 'atoms × mean atomic volume'));
    assert.match(table.filename, /grain-fixture-frame-1-grains\.csv/);
    const merges = await evaluate('grainChecks.download("export-grain-merges")');
    const mergeRows = merges.text.trim().split(/\r\n/).map(line => line.split(','));
    assert.deepEqual(mergeRows[0].slice(3), ['log_merge_distance', 'merge_size [atoms]', 'merged', 'threshold']);
    assert.equal(mergeRows.length - 1, first.plotPoints);

    // Orientation colors use the grain means.
    await evaluate('document.getElementById("grains-color-ipf").click()');
    const ipf = await evaluate('grainChecks.orientation()');
    assert.equal(ipf.mode, 'builtin:grains:ipf');
    assert.match(ipf.legend, /Sample direction/);
    assert.equal(ipf.keys, 1); assert.equal(ipf.distinctColors, 4, 'one color per grain');
    await evaluate('document.getElementById("grains-color-rodrigues").click()');
    const rodrigues = await evaluate('grainChecks.orientation()');
    assert.equal(rodrigues.mode, 'builtin:grains:quaternion'); assert.equal(rodrigues.distinctColors, 4);
    await evaluate('document.getElementById("grains-color-id").click()');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:grainId');

    // Minimum size and orphan adoption reuse the merge sequence and the PTM fit.
    const ptmRuns = await evaluate('grainChecks.ptmRuns');
    await change('grains-orphans', false, true);
    const strict = await calculated('Without orphan adoption');
    assert.equal(strict.grainCount, 4); assert.ok(strict.unassigned > 0);
    assert.match(strict.status, /reused the PTM fit · reused the merge sequence/);
    assert.ok(strict.legend.some(text => text.startsWith('No grain')));
    await change('grains-min-size', '100000');
    const none = await calculated('Minimum size above every grain');
    assert.equal(none.grainCount, 0); assert.equal(none.unassigned, none.atoms);
    assert.match(none.tableCaption, /No grain reaches the minimum size/);
    await change('grains-min-size', '100'); await change('grains-orphans', true, true);
    await calculated('Defaults again');
    assert.equal(await evaluate('grainChecks.ptmRuns'), ptmRuns, 'no further PTM fit');

    // Manual threshold: starts from the automatic value. A large value applies every
    // merge, which still leaves the four grains: no bond below 4° connects them.
    await change('grains-algorithm', 'manual');
    const manual = await calculated('Manual threshold');
    assert.equal(await evaluate('document.getElementById("grains-threshold").disabled'), false);
    assert.equal(manual.grainCount, 4);
    await change('grains-threshold', '40');
    const merged = await calculated('Manual threshold above every merge');
    assert.equal(merged.grainCount, 4); assert.equal(merged.threshold, 40); assert.equal(merged.appliedMerges, merged.mergeCount);
    await change('grains-threshold', '9');
    const split = await calculated('Manual threshold inside the grains');
    assert.ok(split.appliedMerges < merged.appliedMerges && split.sizes[0] < merged.sizes[0], 'a low threshold leaves the grains in pieces');
    await change('grains-algorithm', 'mst');
    const mst = await calculated('Minimum spanning tree');
    assert.equal(mst.grainCount, 4); assert.equal(mst.threshold, 2);
    assert.equal(await evaluate('document.getElementById("grains-threshold-unit").textContent'), '°');
    assert.match(mst.chart.readout, /Disorientation [\d.]+° · merge size/);
    await change('grains-algorithm', 'automatic');
    await calculated('Automatic again');

    // With the PTM tool on, one fit per frame serves both tools.
    await evaluate('grainChecks.showTool("ptm"); document.getElementById("run-ptm").click()');
    await waitFor('document.getElementById("ptm-state").textContent === "Calculated"', 'PTM tool');
    await evaluate('grainChecks.showTool("grains")');
    await calculated('Grains beside the PTM tool');
    const before = await evaluate('grainChecks.ptmRuns');
    await change('frame-slider', '1', false, 'input');
    await waitFor('grainChecks.renderer.frame.frameIndex === 1 && document.getElementById("ptm-state").textContent === "Calculated"', 'PTM on frame 2');
    const second = await calculated('Two-grain frame', { frameIndex: 1 });
    assert.equal(second.grainCount, 2); assert.equal(second.atoms, two.ids.length);
    assert.equal(await evaluate('grainChecks.ptmRuns') - before, 1, 'the PTM tool and Grains share one fit');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:ptmStructureType');
    await evaluate('document.getElementById("cancel-ptm").click()');
    await evaluate('grainChecks.selectColor("builtin:grains:ipf")');

    // A recipe replays the settings and the orientation color choice.
    await change('grains-min-size', '50');
    await calculated('Minimum size 50', { frameIndex: 1 });
    const recipe = await evaluate('grainChecks.exportRecipe()');
    assert.deepEqual(recipe.settings.extensions.grains, { enabled: true, algorithm: 'automatic', mergeThreshold: recipe.settings.extensions.grains.mergeThreshold,
      mstThreshold: 2, minGrainSize: 50, adoptOrphans: true, handleCoherentInterfaces: true });
    assert.equal(recipe.settings.display.colorMode, 'builtin:grains:ipf');
    recipe.settings.extensions.grains.minGrainSize = 75; recipe.settings.extensions.grains.handleCoherentInterfaces = false;
    await evaluate(`grainChecks.importRecipe(${JSON.stringify(JSON.stringify(recipe))})`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'Grain recipe restoration');
    const restored = await calculated('Restored recipe', { frameIndex: 1 });
    assert.equal(restored.grainCount, 2);
    assert.deepEqual(await evaluate(`[document.getElementById('grains-min-size').value, document.getElementById('grains-interfaces').checked,
      document.getElementById('color-mode').value]`), ['75', false, 'builtin:grains:ipf']);
    const invalid = structuredClone(recipe); invalid.settings.extensions.grains.minGrainSize = 0;
    await evaluate(`grainChecks.importRecipe(${JSON.stringify(JSON.stringify(invalid))})`);
    await waitFor('/minGrainSize/.test(document.getElementById("configuration-status").textContent + document.getElementById("toast").textContent)', 'Invalid grain recipe is rejected');
    assert.equal(await evaluate('document.getElementById("grains-min-size").value'), '75', 'a rejected recipe changes nothing');

    // Phone layout keeps the controls inside the viewport.
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('grainChecks.showTool("grains"); document.getElementById("run-grains").scrollIntoView({ block: "center" })');
    await delay(150);
    const mobile = await evaluate(`(() => ['grains-algorithm', 'grains-threshold', 'grains-min-size', 'run-grains', 'export-grain-table', 'grains-chart'].map(id => {
      const box = document.getElementById(id).getBoundingClientRect();
      return { id, width: box.width, fits: box.left >= 0 && box.right <= innerWidth };
    }))()`);
    assert.ok(mobile.every(item => item.fits && item.width > 0), JSON.stringify(mobile));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const { data: phone } = await call('Page.captureScreenshot', { format: 'png' });
    const screenshot = resolve(tmpdir(), `alloyview-grains-mobile${isolated ? '-isolated' : ''}.png`);
    await writeFile(screenshot, Buffer.from(phone, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    await evaluate('document.getElementById("cancel-grains").click()');
    await waitFor(`document.getElementById('grains-state').textContent === 'Not calculated' && !grainChecks.property('grainId')`, 'Cancel clears grains');
    assert.equal(await evaluate('grainChecks.renderer.frame.ptm === undefined'), true, 'the PTM fit is released with the last tool that used it');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'type');

    // The 129,904-atom nickel bicrystal is one lattice period thick along c.
    await openFile(nickelPath, 'NiGB_minimized.cfg');
    await evaluate('grainChecks.showTool("grains")');
    await evaluate('document.getElementById("run-grains").click()');
    await waitFor('document.getElementById("grains-state").textContent === "Failed"', 'Thin cell is refused');
    assert.match(await evaluate('document.getElementById("grains-status").textContent'), /too short along cell vector C.*Replicate/);
    await evaluate('grainChecks.showTool("replicate")');
    await change('replicate-c', '2');
    await evaluate('document.getElementById("apply-replicate").click()');
    await change('replicate-atoms', true, true);
    await waitFor('grainChecks.renderer.frame.ids.length === 259808 && document.getElementById("loading").hidden', 'Physical 1 × 1 × 2 replication');
    await evaluate('grainChecks.showTool("grains")');
    // The failed tool stays enabled, so the replicated frame is segmented at once.
    const nickel = await calculated('Replicated nickel bicrystal', { parity: false });
    assert.equal(nickel.grainCount, 2); assert.equal(nickel.atoms, 259808); assert.equal(nickel.unassigned, 0);
    assert.deepEqual(nickel.sizes, [130560, 129248]);
    const cold = await evaluate('grainChecks.timing()');
    // Cancelling a running job stops it and leaves a warm Worker behind.
    await change('grains-interfaces', false, true);
    await waitFor('document.getElementById("grains-state").textContent === "Calculating…"', 'Recalculation starts');
    await evaluate('document.getElementById("cancel-grains").click()');
    await waitFor('document.getElementById("grains-state").textContent === "Not calculated"', 'Cancel during calculation');
    await change('grains-interfaces', true, true);
    await evaluate('document.getElementById("run-grains").click()');
    const again = await calculated('Nickel bicrystal after cancelling', { parity: false });
    assert.deepEqual(again.sizes, nickel.sizes, 'results are deterministic');
    const warm = await evaluate('grainChecks.timing()');
    return { adapter, isolated, first: { grainCount: first.grainCount, sizes: first.sizes, threshold: first.threshold, purity: truth.purity },
      second: { grainCount: second.grainCount, sizes: second.sizes }, csvRows: rows.length - 1, mergeRows: mergeRows.length - 1,
      nickel: { atoms: nickel.atoms, sizes: nickel.sizes, threshold: nickel.threshold, cold, warm }, mobile, screenshots: [desktopScreenshot, screenshot] };
  }, { software: useSoftwareAdapter(true), isolated, requireGpu: false });
}

try {
  const reports = [];
  for (const isolated of [false, true]) reports.push(await exercise({ isolated }));
  assert.deepEqual(reports[0].first, reports[1].first, 'isolated and non-isolated hosts agree');
  assert.deepEqual(reports[0].nickel.sizes, reports[1].nickel.sizes);
  console.log(JSON.stringify(reports, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { AnalysisPool }, { calculatePtm, PTM_FIELDS }, { calculateGrains }, { createAttributeRegistry }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)),
    import(new URL('./analysis/ptm.js', app)), import(new URL('./analysis/grains.js', app)), import(new URL('./global-attributes.js', app)),
  ]);
  const checks = window.grainChecks = { ptmRuns: 0 };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this;
    return setFrame.apply(this, args);
  };
  const setColors = WebGLRenderer.prototype.setColors;
  WebGLRenderer.prototype.setColors = function(colors, ...args) {
    if (this.canvas.id === 'viewport') checks.colors = colors;
    return setColors.call(this, colors, ...args);
  };
  const analyze = AnalysisPool.prototype.analyze;
  AnalysisPool.prototype.analyze = async function(frame, parameters, ...args) {
    if (parameters.kind === 'ptm') checks.ptmRuns += 1;
    return analyze.call(this, frame, parameters, ...args);
  };
  checks.change = (id, value, checkbox = false, event = 'change') => {
    const input = document.getElementById(id);
    if (checkbox) input.checked = value; else input.value = String(value);
    input.dispatchEvent(new Event(event, { bubbles: true }));
  };
  checks.showTool = name => {
    if (document.querySelector(`[data-tool-panel="${name}"]`).hidden) document.querySelector(`[data-tool-button="${name}"]`).click();
  };
  checks.selectColor = value => {
    const select = document.getElementById('color-mode'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.property = name => checks.renderer?.frame.properties.find(property => property.name === name);
  const text = id => document.getElementById(id).textContent;
  checks.view = async parity => {
    const frame = checks.renderer.frame, result = frame.atomeyeResults.grains.result, ptm = frame.ptm;
    let mismatch = null, ptmIdentical = null;
    if (checks.property('grainId').data !== result.grainId) mismatch = 'published property';
    if (parity) {
      const flags = [...document.querySelectorAll('[data-ptm-template]:checked')].reduce((mask, input) => mask | Number(input.dataset.ptmTemplate), 0);
      const rmsdCutoff = document.getElementById('ptm-rmsd').valueAsNumber;
      // The same kernels on this thread: PTM without and with neighbor lists, then both grain stages.
      const plain = await calculatePtm(frame, { flags, rmsdCutoff });
      const lists = await calculatePtm(frame, { flags, rmsdCutoff, neighborLists: true });
      ptmIdentical = true;
      for (const name of Object.keys(PTM_FIELDS)) for (let index = 0; index < plain[name].length; index += 1) {
        if (!Object.is(plain[name][index], lists[name][index]) || !Object.is(plain[name][index], ptm[name][index])) ptmIdentical = false;
      }
      for (const name of ['neighborCounts', 'neighborIndices', 'neighborSpan']) for (let index = 0; index < lists[name].length && !mismatch; index += 1) {
        if (!Object.is(lists[name][index], ptm[name][index])) mismatch = `PTM ${name}[${index}]`;
      }
      const direct = calculateGrains({ ...lists, fractional: frame.fractional, cell: frame.cell }, { algorithm: result.algorithm,
        mergeThreshold: result.algorithm === 'automatic' ? 0 : result.mergeThreshold, minGrainSize: result.minGrainSize, adoptOrphans: result.adoptOrphans,
        handleCoherentInterfaces: result.handleCoherentInterfaces });
      for (const name of ['grainId', 'sizes', 'structureTypes', 'rootStructureTypes', 'orientations']) {
        if (result[name].length !== direct[name].length) { mismatch ??= `${name} length`; break; }
        for (let index = 0; index < direct[name].length && !mismatch; index += 1) if (!Object.is(result[name][index], direct[name][index])) mismatch = `${name}[${index}]`;
      }
      for (const name of ['distance', 'size']) for (let index = 0; index < direct.plot[name].length && !mismatch; index += 1) {
        if (!Object.is(result.plot[name][index], direct.plot[name][index])) mismatch = `plot.${name}[${index}]`;
      }
      for (const name of ['grainCount', 'mergeThreshold', 'suggestedThreshold', 'unassignedAtoms', 'adoptedAtoms', 'meanSize']) {
        if (!Object.is(result[name], direct[name])) mismatch ??= name;
      }
    }
    const registry = createAttributeRegistry({ frame, frameIndex: frame.frameIndex ?? 0 });
    const chart = document.getElementById('grains-chart');
    return { mismatch, ptmIdentical, atoms: frame.ids.length, grainCount: result.grainCount, sizes: Array.from(result.sizes.subarray(0, 20)),
      unassigned: result.unassignedAtoms, threshold: result.mergeThreshold, plotPoints: result.plot.distance.length,
      appliedMerges: result.appliedMerges, mergeCount: result.mergeCount,
      thresholdField: document.getElementById('grains-threshold').value, mode: document.getElementById('color-mode').value,
      legend: Array.from(document.querySelectorAll('#color-legend .legend-item'), item => item.textContent.trim()),
      rows: document.querySelectorAll('#grains-table-body tr').length, summary: text('grains-summary'), backend: text('grains-backend'),
      status: text('grains-status'), tableCaption: text('grains-table-caption'),
      chart: { points: chart.querySelectorAll('path.chart-points').length, thresholds: chart.querySelectorAll('path.chart-threshold').length,
        legend: Array.from(chart.querySelectorAll('.chart-legend > span'), item => item.textContent), readout: chart.querySelector('output')?.textContent ?? '' },
      attributes: { count: registry.get('Grains.grain_count')?.value, mean: registry.get('Grains.mean_size')?.value } };
  };
  /** Share of atoms whose grain is the majority grain of their constructed grain. */
  checks.purity = truth => {
    const ids = checks.renderer.frame.atomeyeResults.grains.result.grainId, tallies = new Map();
    for (let atom = 0; atom < ids.length; atom += 1) {
      if (!tallies.has(truth[atom])) tallies.set(truth[atom], new Map());
      const tally = tallies.get(truth[atom]); tally.set(ids[atom], (tally.get(ids[atom]) ?? 0) + 1);
    }
    let agreeing = 0; const majorities = new Set();
    for (const tally of tallies.values()) { const [id, count] = [...tally].sort((a, b) => b[1] - a[1])[0]; agreeing += count; majorities.add(id); }
    return { purity: agreeing / ids.length, distinct: majorities.size };
  };
  checks.orientation = () => {
    const ids = checks.renderer.frame.atomeyeResults.grains.result.grainId, colors = checks.colors, seen = new Map();
    let consistent = true;
    for (let atom = 0; atom < ids.length; atom += 1) {
      const color = `${colors[atom * 3]},${colors[atom * 3 + 1]},${colors[atom * 3 + 2]}`;
      if (!seen.has(ids[atom])) seen.set(ids[atom], color); else if (seen.get(ids[atom]) !== color) consistent = false;
    }
    return { mode: document.getElementById('color-mode').value, legend: document.getElementById('legend').textContent,
      keys: document.querySelectorAll('#color-legend canvas.legend-ipf-key').length, distinctColors: consistent ? new Set(seen.values()).size : -1 };
  };
  checks.timing = () => {
    const result = checks.renderer.frame.atomeyeResults.grains.result;
    return { totalMs: result.totalMs, ptmMs: result.ptmMs, grainMs: result.elapsedMs, mergeSequenceMs: result.modelMs, ptmReused: result.ptmReused, modelReused: result.modelReused };
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
  checks.exportRecipe = async () => {
    const { text } = await checks.download('export-configuration');
    return JSON.parse(text);
  };
  checks.importRecipe = text => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], 'grains-recipe.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.ready = true;
}
