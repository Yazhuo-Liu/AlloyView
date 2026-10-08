import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Production UI, real file parsers and CPU Workers. Every published cluster
// array is compared element-wise with the direct kernel in the same page.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-clusters-'));
const fixture = 'cluster-fixture.xyz', fixturePath = resolve(temporary, fixture);
const loopPath = resolve(root, 'examples/Fe_disloc_loop.dump');
function xyz(points, step) {
  return [String(points.length), `Lattice="20 0 0 0 20 0 0 0 20" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T" Step=${step}`,
    ...points.map((point, index) => `Ni ${point.join(' ')} ${201 + index}`), ''].join('\n');
}
// A chain across the periodic x face, a pair and a single atom. In the second
// frame the single atom joins the pair, giving two clusters of three atoms.
const frameA = [[19.5, 5, 5], [0.5, 5, 5], [1.5, 5, 5], [10, 10, 10], [11, 10, 10], [10, 15, 15]];
const frameB = frameA.map((point, index) => index === 5 ? [12, 10, 10] : point);
await writeFile(fixturePath, xyz(frameA, 0) + xyz(frameB, 1));

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
      throw new Error(`${label}: ${await evaluate(`JSON.stringify({ state: document.getElementById('clusters-state')?.textContent,
        status: document.getElementById('clusters-status')?.textContent, toast: document.getElementById('toast')?.textContent,
        recipe: document.getElementById('configuration-status')?.textContent })`)}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("run-clusters")', 'Cluster production page startup');
    await evaluate(`(${initializeChecks.toString()})()`);
    await waitFor('window.clusterChecks?.ready', 'Cluster check modules');
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
    async function openFile(path, name) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(name)} && clusterChecks.renderer?.frame
        && document.getElementById('loading').hidden && !document.getElementById('run-clusters').disabled`, `${name} import`);
    }
    async function calculated(label, frameIndex = null) {
      await waitFor(`document.getElementById('clusters-state').textContent === 'Calculated' && clusterChecks.property('clusterId')
        ${frameIndex === null ? '' : `&& clusterChecks.renderer.frame.frameIndex === ${frameIndex}`}`, label);
      const parity = await evaluate('clusterChecks.parity()');
      assert.equal(parity.identical, true, `${label}: pool arrays must equal the direct kernel (${parity.mismatch})`);
      return parity;
    }
    const change = (id, value, checkbox = false, event = 'change') => evaluate(
      `clusterChecks.change(${JSON.stringify(id)}, ${JSON.stringify(value)}, ${checkbox}, ${JSON.stringify(event)})`);
    const near = (actual, expected, label) => assert.ok(Math.abs(Number(actual) - expected) < 1e-5, `${label}: ${actual} ≈ ${expected}`);

    if (isolated) {
      assert.equal(await evaluate('crossOriginIsolated && typeof SharedArrayBuffer === "function"'), true);
    } else assert.equal(await evaluate('crossOriginIsolated'), false);

    await openFile(fixturePath, fixture);
    await evaluate('clusterChecks.showTool("clusters")');
    await change('clusters-cutoff', '1.05');
    await evaluate('document.getElementById("run-clusters").click()');
    const first = await calculated('Fixture frame 1', 0);
    assert.deepEqual(first.ids, [1, 1, 1, 2, 2, 3]);
    assert.deepEqual(first.sizes, [3, 2, 1]);
    near(first.centers[0], 20.5, 'The chain is unwrapped from its first atom across the periodic face');
    const view = await evaluate(`({ mode: document.getElementById('color-mode').value,
      legend: Array.from(document.querySelectorAll('#color-legend .legend-item'), item => item.textContent.trim()),
      rows: document.querySelectorAll('#clusters-table-body tr').length,
      summary: document.getElementById('clusters-summary').textContent,
      backend: document.getElementById('clusters-backend').textContent })`);
    assert.equal(view.mode, 'property:clusterId');
    assert.deepEqual(view.legend.map(text => text.split(/\d/)[0].trim()), ['Cluster', 'Cluster', 'Cluster']);
    assert.equal(view.rows, 3);
    assert.match(view.summary, /3 clusters · largest 3 atoms/);
    assert.match(view.backend, /^CPU · \d+ Worker/);

    await evaluate('document.getElementById("clusters-results").scrollIntoView({ block: "center" })');
    const { data: desktop } = await call('Page.captureScreenshot', { format: 'png' });
    const desktopScreenshot = resolve(tmpdir(), `alloyview-clusters-desktop${isolated ? '-isolated' : ''}.png`);
    await writeFile(desktopScreenshot, Buffer.from(desktop, 'base64'));

    const csv = await evaluate('clusterChecks.download("export-cluster-table")');
    const rows = csv.text.trim().split(/\r\n/).map(line => line.split(','));
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0].slice(3, 7), ['cluster_id', 'atom_count', 'total_weight [atoms]', 'center_x [Å]']);
    assert.deepEqual(rows.slice(1).map(row => [row[3], row[4], row.at(-2), row.at(-1)]),
      [['1', '3', 'false', '201'], ['2', '2', 'false', '204'], ['3', '1', 'false', '206']]);
    for (const [row, center] of [[1, 20.5], [2, 10.5], [3, 10]]) near(rows[row][6], center, `CSV center of cluster ${row}`);
    assert.match(csv.filename, /cluster-fixture-frame-1-clusters\.csv/);

    await evaluate('document.getElementById("clusters-color-size").click()');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:clusterSize');
    await evaluate('clusterChecks.selectColor("property:clusterId")');

    // Bond mode follows the Bonds cutoff, which then survives frame changes.
    await change('bonds-cutoff', '0.9');
    await change('clusters-neighbor-mode', 'bonds');
    assert.equal(await evaluate('document.getElementById("clusters-cutoff-field").hidden'), true);
    const bonded = await calculated('Bond cutoffs', 0);
    assert.deepEqual(bonded.ids, [1, 2, 3, 4, 5, 6]);
    assert.equal(await evaluate('clusterChecks.lastParameters.neighborMode'), 'bonds');
    // Frame changes recalculate and keep the chosen color quantity.
    await change('frame-slider', '1', false, 'input');
    const bondedFrame = await calculated('Bond cutoffs on frame 2', 1);
    assert.deepEqual(bondedFrame.ids, [1, 2, 3, 4, 5, 6]);
    assert.equal(await evaluate('document.getElementById("bonds-cutoff").value'), '0.9');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:clusterId');
    await change('clusters-neighbor-mode', 'cutoff');
    const second = await calculated('Fixture frame 2', 1);
    assert.deepEqual(second.ids, [1, 1, 1, 2, 2, 2]);

    // A recipe restricted to a saved selection group replays exactly.
    const recipe = await evaluate('clusterChecks.exportRecipe()');
    assert.deepEqual(recipe.settings.extensions.clusters, { enabled: true, neighborMode: 'cutoff', cutoff: 1.05, selectionGroupId: null, sortBySize: true });
    recipe.settings.selectionGroups = { groups: [{ id: 'subset', name: 'Subset', color: '#22c1c3', visible: true, atomIds: [201, 203, 204, 205, 206] }], selectedGroupId: null };
    recipe.settings.extensions.clusters.selectionGroupId = 'subset';
    await evaluate(`clusterChecks.importRecipe(${JSON.stringify(JSON.stringify(recipe))})`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'Cluster recipe restoration');
    const restricted = await calculated('Selection-restricted recipe', 1);
    assert.deepEqual(restricted.ids, [2, 0, 3, 1, 1, 1]);
    assert.equal(await evaluate('document.getElementById("clusters-selection").value'), 'subset');
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('#color-legend .legend-item'), item => item.textContent).some(text => text.startsWith('Not analyzed'))`));

    // Phone layout keeps controls inside the viewport; the table scrolls itself.
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('clusterChecks.showTool("clusters"); document.getElementById("run-clusters").scrollIntoView({ block: "center" })');
    await delay(150);
    const mobile = await evaluate(`(() => ['clusters-neighbor-mode', 'clusters-cutoff', 'clusters-selection', 'run-clusters', 'export-cluster-table'].map(id => {
      const box = document.getElementById(id).getBoundingClientRect();
      return { id, width: box.width, fits: box.left >= 0 && box.right <= innerWidth };
    }))()`);
    assert.ok(mobile.every(item => item.fits && item.width > 0), JSON.stringify(mobile));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const { data: phone } = await call('Page.captureScreenshot', { format: 'png' });
    const screenshot = resolve(tmpdir(), `alloyview-clusters-mobile${isolated ? '-isolated' : ''}.png`);
    await writeFile(screenshot, Buffer.from(phone, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    await evaluate('document.getElementById("cancel-clusters").click()');
    await waitFor(`document.getElementById('clusters-state').textContent === 'Not calculated' && !clusterChecks.property('clusterId')`, 'Cancel clears clusters');

    // The 60,229-atom dislocation loop: one crystal spanning every periodic face.
    await openFile(loopPath, 'Fe_disloc_loop.dump');
    await evaluate('clusterChecks.showTool("clusters")');
    const suggestedCutoff = await evaluate('document.getElementById("clusters-cutoff").valueAsNumber');
    assert.ok(suggestedCutoff > 2.5, 'A fresh source starts from the element estimate or fallback.');
    await change('clusters-cutoff', '2.85');
    await evaluate('document.getElementById("run-clusters").click()');
    const loop = await calculated('Fe dislocation loop');
    assert.deepEqual(loop.sizes, [60229]);
    assert.deepEqual(loop.percolating, [1]);
    assert.deepEqual(loop.centers, ['NaN', 'NaN', 'NaN']);
    const timings = [];
    for (let run = 0; run < 3; run += 1) {
      await change('clusters-sort', run % 2 === 0 ? false : true, true);
      await calculated(`Fe loop warm run ${run + 1}`);
      timings.push(await evaluate(`({ total: clusterChecks.lastResult.elapsedMs, edges: clusterChecks.lastResult.edgeElapsedMs,
        labels: clusterChecks.lastResult.labelElapsedMs })`));
    }
    const periodicRow = await evaluate('document.querySelector("#clusters-table-body tr td:last-child").textContent');
    assert.equal(periodicRow, 'Periodic');
    return { adapter, isolated, sharedMemory: await evaluate('clusterChecks.lastResult?.sharedMemory'), first, bonded, second, restricted,
      loop: { atoms: 60229, suggestedCutoff, workers: await evaluate('clusterChecks.lastResult?.workerCount'), firstMs: loop.analysisMs, warmMs: timings },
      csvRows: rows.length - 1, mobile, screenshots: [desktopScreenshot, screenshot] };
  }, { software: useSoftwareAdapter(true), isolated, requireGpu: false });
}

try {
  const reports = [];
  for (const isolated of [false, true]) reports.push(await exercise({ isolated }));
  assert.equal(reports[0].sharedMemory, false);
  assert.equal(reports[1].sharedMemory, true);
  console.log(JSON.stringify(reports, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { AnalysisPool }, { calculateClusters }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)),
    import(new URL('./analysis/clusters.js', app)),
  ]);
  const checks = window.clusterChecks = { jobs: [] };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this;
    return setFrame.apply(this, args);
  };
  const analyze = AnalysisPool.prototype.analyze;
  AnalysisPool.prototype.analyze = async function(frame, parameters, ...args) {
    const result = await analyze.call(this, frame, parameters, ...args);
    if (parameters.kind === 'clusters') { checks.lastResult = result; checks.lastParameters = parameters; checks.lastFrame = frame; }
    return result;
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
  checks.parity = () => {
    const frame = checks.renderer.frame, result = checks.lastResult, parameters = checks.lastParameters;
    if (checks.lastFrame !== frame) return { identical: false, mismatch: 'frame' };
    const { kind: _kind, ...options } = parameters;
    const direct = calculateClusters(frame, options);
    let mismatch = null;
    for (const name of ['clusterId', 'clusterSize', 'sizes', 'totalWeights', 'centers', 'radiiOfGyration', 'gyrationTensors', 'percolating', 'firstAtoms']) {
      if (result[name].length !== direct[name].length) { mismatch = `${name} length`; break; }
      for (let index = 0; index < direct[name].length && !mismatch; index += 1) if (!Object.is(result[name][index], direct[name][index])) mismatch = `${name}[${index}]`;
    }
    if (checks.property('clusterId').data !== result.clusterId || checks.property('clusterSize').data !== result.clusterSize) mismatch ??= 'published property';
    return { identical: mismatch === null, mismatch, ids: frame.ids.length < 100 ? Array.from(result.clusterId) : null,
      // DevTools JSON turns NaN into null; keep undefined centers explicit.
      sizes: Array.from(result.sizes.subarray(0, 20)), centers: Array.from(result.centers.subarray(0, 3), value => Number.isNaN(value) ? 'NaN' : value),
      percolating: Array.from(result.percolating.subarray(0, 20)), analysisMs: result.elapsedMs };
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
    const transfer = new DataTransfer(); transfer.items.add(new File([text], 'clusters-recipe.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.ready = true;
}
