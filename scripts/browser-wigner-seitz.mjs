import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Production UI, real XYZ parser and CPU Workers. Every published result is
// compared element-wise with the direct kernel in the same page.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-wigner-seitz-'));
const fixture = 'ws-fixture.xyz', fixturePath = resolve(temporary, fixture);
const loopPath = resolve(root, 'examples/Fe_disloc_loop.dump');

// B2 FeNi, 4 × 4 × 4 cubes of 2.87 Å: Fe on corners, Ni at cube centers.
// Frame 1 is perfect. Frame 2 removes the Fe at cube (1, 2, 1), swaps the
// elements of cube (3, 0, 2), and adds an Fe and a Ni next to two sites, so it
// has 129 atoms. Frame 3 is frame 1 stretched by 15% along x.
const a = 2.87, n = 4, length = a * n;
const sites = [];
for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) for (let k = 0; k < n; k += 1) {
  sites.push({ element: 'Fe', position: [i * a, j * a, k * a] }, { element: 'Ni', position: [(i + .5) * a, (j + .5) * a, (k + .5) * a] });
}
const row = (i, j, k, basis) => ((i * n + j) * n + k) * 2 + basis;
const removed = row(1, 2, 1, 0), swapped = [row(3, 0, 2, 0), row(3, 0, 2, 1)];
const dumbbells = [{ site: row(0, 1, 3, 1), element: 'Fe', offset: [.6, .5, 0] }, { site: row(2, 3, 0, 0), element: 'Ni', offset: [0, -.55, .45] }];
let seed = 5;
const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648 - .5) * .1; };
function xyz(atoms, step, scale = 1) {
  return [String(atoms.length), `Lattice="${length * scale} 0 0 0 ${length} 0 0 0 ${length}" Properties=species:S:1:pos:R:3 pbc="T T T" Step=${step}`,
    ...atoms.map(({ element, position }) => `${element} ${position.map((value, axis) => (axis === 0 ? value * scale : value).toFixed(6)).join(' ')}`), ''].join('\n');
}
const defective = sites.flatMap((site, index) => index === removed ? [] : [{ element: swapped.includes(index) ? (site.element === 'Fe' ? 'Ni' : 'Fe') : site.element,
  position: site.position.map(value => value + noise()) }]);
for (const { site, element, offset } of dumbbells) defective.push({ element, position: sites[site].position.map((value, axis) => value + offset[axis]) });
await writeFile(fixturePath, xyz(sites, 0) + xyz(defective, 1) + xyz(sites, 2, 1.15));

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
      throw new Error(`${label}: ${await evaluate(`JSON.stringify({ state: document.getElementById('wigner-seitz-state')?.textContent,
        status: document.getElementById('wigner-seitz-status')?.textContent, toast: document.getElementById('toast')?.textContent,
        recipe: document.getElementById('configuration-status')?.textContent })`)}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("run-wigner-seitz")', 'Wigner–Seitz production page startup');
    await evaluate(`(${initializeChecks.toString()})()`);
    await waitFor('window.wsChecks?.ready', 'Wigner–Seitz check modules');
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
    if (isolated) assert.equal(await evaluate('crossOriginIsolated && typeof SharedArrayBuffer === "function"'), true);
    else assert.equal(await evaluate('crossOriginIsolated'), false);
    async function openFile(path, name, frames = 1) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(name)} && wsChecks.renderer?.frame
        && document.getElementById('loading').hidden && !document.getElementById('run-wigner-seitz').disabled
        && document.getElementById('frame-label').textContent.endsWith('/ ${frames}')`, `${name} import`);
    }
    async function calculated(label, frameIndex) {
      await waitFor(`document.getElementById('wigner-seitz-state').textContent === 'Calculated' && wsChecks.property('wsDefectClass')
        && wsChecks.renderer.frame.frameIndex === ${frameIndex} && wsChecks.lastFrame === wsChecks.renderer.frame`, label);
      const parity = await evaluate('wsChecks.parity()');
      assert.equal(parity.identical, true, `${label}: pool arrays must equal the direct kernel (${parity.mismatch})`);
      return parity;
    }
    const change = (id, value, checkbox = false, event = 'change') => evaluate(
      `wsChecks.change(${JSON.stringify(id)}, ${JSON.stringify(value)}, ${checkbox}, ${JSON.stringify(event)})`);

    await openFile(fixturePath, fixture, 3);
    await evaluate('wsChecks.showTool("wignerSeitz")');
    await evaluate('document.getElementById("run-wigner-seitz").click()');
    const perfect = await calculated('Perfect reference frame', 0);
    assert.deepEqual(perfect.counts, [0, 0, 0, 128, 128]);
    assert.equal(perfect.markers, 0);
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:wsDefectClass');

    // Frame changes recalculate against the same reference frame.
    await change('frame-slider', '1', false, 'input');
    const defects = await calculated('Defective frame', 1);
    assert.deepEqual(defects.counts, [1, 2, 2, 129, 128]);
    assert.equal(defects.markers, 1);
    const vacancy = sites[removed].position;
    assert.ok(defects.markerPosition.every((value, axis) => Math.abs(value - vacancy[axis]) < 1e-5), `vacancy marker ${defects.markerPosition}`);
    const view = await evaluate(`({ legend: Array.from(document.querySelectorAll('#color-legend .legend-item'), item => item.textContent.trim()),
      summary: document.getElementById('wigner-seitz-summary').textContent,
      rows: Array.from(document.querySelectorAll('#wigner-seitz-table-body tr'), row => Array.from(row.children, cell => cell.textContent)),
      backend: document.getElementById('wigner-seitz-backend').textContent,
      markerStatus: document.getElementById('wigner-seitz-marker-status').textContent })`);
    assert.match(view.summary, /^1 vacancy · 2 interstitials · 2 antisites · 129 atoms on 128 sites of frame 1/);
    assert.deepEqual(view.rows, [['Fe', '64', '64', '1', '1', '2'], ['Ni', '64', '65', '0', '1', '2'], ['All', '128', '129', '1', '2', '4']]);
    // Legend entries read "<label><count> · <percent>": 123 regular, 4 on shared sites, 2 antisites.
    assert.deepEqual(view.legend.map(text => text.match(/^[A-Za-z]+\d+/)?.[0]), ['Regular123', 'Interstitial4', 'Antisite2']);
    assert.match(view.backend, /^CPU · \d+ Worker/);
    assert.match(view.markerStatus, /^1 vacant site drawn/);

    const csv = await evaluate('wsChecks.download("export-wigner-seitz-sites")');
    const rows = csv.text.trim().split(/\r\n/).map(line => line.split(','));
    assert.deepEqual(rows[0].slice(3, 10), ['site_index', 'site_id', 'site_type', 'site_class', 'occupancy', 'occupancy_Fe', 'occupancy_Ni']);
    const expectedSites = [removed, ...swapped, ...dumbbells.map(entry => entry.site)].sort((left, right) => left - right);
    assert.deepEqual(rows.slice(1).map(entry => Number(entry[3])), expectedSites);
    const classOf = Object.fromEntries(rows.slice(1).map(entry => [entry[3], entry[6]]));
    assert.equal(classOf[removed], 'vacancy');
    for (const site of swapped) assert.equal(classOf[site], 'antisite');
    for (const { site } of dumbbells) assert.equal(classOf[site], 'interstitial');
    const vacancyRow = rows.find(entry => Number(entry[3]) === removed);
    assert.ok(vacancyRow.slice(10, 13).every((value, axis) => Math.abs(Number(value) - vacancy[axis]) < 1e-5));
    assert.match(csv.filename, /ws-fixture-frame-2-wigner-seitz\.csv/);

    for (const [mode, count] of [['defects', 5], ['all', 128], ['vacancies', 1]]) {
      await change('wigner-seitz-markers', mode);
      assert.equal(await evaluate('wsChecks.renderer.siteMarkers?.positions.length / 3'), count, `${mode} markers`);
    }
    assert.equal(await evaluate('wsChecks.analyses'), 2, 'display choices never recalculate');

    // The PNG export draws markers; hiding them or slicing them away removes them.
    await change('wigner-seitz-marker-radius', '2');
    const exported = await evaluate('wsChecks.markerPixels()');
    assert.ok(exported.shown > 50, `markers in the PNG export (${JSON.stringify(exported)})`);
    assert.equal(exported.hidden, 0);
    assert.equal(exported.sliced, 0);
    assert.ok(exported.keptSlice > 50);

    // The second view receives the same markers.
    await change('compare-view', true, true);
    await waitFor('wsChecks.comparison?.siteMarkers === wsChecks.renderer.siteMarkers && wsChecks.comparison.siteMarkerOptions.radius === 2', 'Second view markers');

    await evaluate('document.getElementById("wigner-seitz-results").scrollIntoView({ block: "center" })');
    const { data: desktop } = await call('Page.captureScreenshot', { format: 'png' });
    const desktopScreenshot = resolve(tmpdir(), `alloyview-wigner-seitz-desktop${isolated ? '-isolated' : ''}.png`);
    await writeFile(desktopScreenshot, Buffer.from(desktop, 'base64'));
    await change('compare-view', false, true);

    // Frame 3: a 15% stretch is a strain, not defects, once mapped.
    await change('frame-slider', '2', false, 'input');
    const stretched = await calculated('Stretched frame without mapping', 2);
    assert.ok(stretched.counts[0] > 0 && stretched.counts[0] === stretched.counts[1], `spurious defects ${stretched.counts}`);
    await change('wigner-seitz-affine', true, true);
    await waitFor('wsChecks.lastParameters?.affineMapping === true', 'Affine recalculation');
    const mapped = await calculated('Stretched frame with affine mapping', 2);
    assert.deepEqual(mapped.counts, [0, 0, 0, 128, 128]);
    assert.ok(mapped.maximumDistance < 1e-5, 'mapped atoms sit on their sites up to Float32 parsing');

    // A recipe replays the analysis and display choices after import.
    await change('frame-slider', '1', false, 'input');
    await calculated('Defective frame with mapping', 1);
    const recipe = await evaluate('wsChecks.exportRecipe()');
    assert.deepEqual(recipe.settings.extensions.wignerSeitz, { enabled: true, referenceFrame: 0, affineMapping: true, markers: 'vacancies', showMarkers: true, markerRadius: 2 });
    recipe.settings.extensions.wignerSeitz.markers = 'defects';
    recipe.settings.extensions.wignerSeitz.affineMapping = false;
    await evaluate('wsChecks.analyses = 0');
    await evaluate(`wsChecks.importRecipe(${JSON.stringify(JSON.stringify(recipe))})`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'Wigner–Seitz recipe restoration');
    const restored = await calculated('Restored recipe', 1);
    assert.deepEqual(restored.counts, [1, 2, 2, 129, 128]);
    assert.equal(restored.markers, 5);
    assert.equal(await evaluate('document.getElementById("wigner-seitz-markers").value'), 'defects');
    assert.equal(await evaluate('document.getElementById("wigner-seitz-affine").checked'), false);

    // Phone layout keeps controls inside the viewport; the table scrolls itself.
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('wsChecks.showTool("wignerSeitz"); document.getElementById("run-wigner-seitz").scrollIntoView({ block: "center" })');
    await delay(150);
    const mobile = await evaluate(`(() => ['wigner-seitz-reference-frame', 'wigner-seitz-affine', 'wigner-seitz-markers', 'wigner-seitz-marker-radius',
      'run-wigner-seitz', 'export-wigner-seitz-sites', 'wigner-seitz-color-class'].map(id => {
      const box = document.getElementById(id).getBoundingClientRect();
      return { id, width: box.width, fits: box.left >= 0 && box.right <= innerWidth };
    }))()`);
    assert.ok(mobile.every(item => item.fits && item.width > 0), JSON.stringify(mobile));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const { data: phone } = await call('Page.captureScreenshot', { format: 'png' });
    const screenshot = resolve(tmpdir(), `alloyview-wigner-seitz-mobile${isolated ? '-isolated' : ''}.png`);
    await writeFile(screenshot, Buffer.from(phone, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    await evaluate('document.getElementById("cancel-wigner-seitz").click()');
    await waitFor(`document.getElementById('wigner-seitz-state').textContent === 'Not calculated' && !wsChecks.property('wsDefectClass')
      && !wsChecks.renderer.siteMarkers`, 'Cancel clears outputs and markers');

    // Timing on 120,458 atoms: the Fe loop replicated 2 × 1 × 1 as the
    // reference and a randomly displaced copy as the current frame.
    await openFile(loopPath, 'Fe_disloc_loop.dump');
    const timing = await evaluate('wsChecks.timeLoop()');
    assert.equal(timing.identical, true, `120k pool result must equal the direct kernel (${timing.mismatch})`);
    return { adapter, isolated, sharedMemory: timing.sharedMemory, perfect: perfect.counts, defects: defects.counts, stretched: stretched.counts,
      mapped: mapped.counts, restored: restored.counts, csvRows: rows.length - 1, exported, mobile, timing, screenshots: [desktopScreenshot, screenshot] };
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
  const [{ WebGLRenderer }, { AnalysisPool }, { calculateWignerSeitz }, { replicateFrame }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)),
    import(new URL('./analysis/wigner-seitz.js', app)), import(new URL('./data/replicate.js', app)),
  ]);
  const checks = window.wsChecks = { analyses: 0 };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this; else checks.comparison = this;
    return setFrame.apply(this, args);
  };
  const analyze = AnalysisPool.prototype.analyze;
  AnalysisPool.prototype.analyze = async function(frame, parameters, ...args) {
    checks.pool = this;
    if (parameters.kind === 'wignerSeitz' && !checks.timing) checks.analyses += 1;
    const result = await analyze.call(this, frame, parameters, ...args);
    if (parameters.kind === 'wignerSeitz' && !checks.timing) { checks.lastResult = result; checks.lastParameters = parameters; checks.lastFrame = frame; }
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
  checks.property = name => checks.renderer?.frame.properties.find(property => property.name === name);
  const compare = (result, direct) => {
    for (const name of ['siteIndex', 'siteDistance', 'siteOccupancy', 'siteClass', 'siteAtomOffsets', 'siteAtoms', 'defectSites', 'atomOccupancy', 'atomClass', 'atomSiteType']) {
      if (result[name].constructor !== direct[name].constructor || result[name].length !== direct[name].length) return `${name} shape`;
      for (let index = 0; index < direct[name].length; index += 1) if (!Object.is(result[name][index], direct[name][index])) return `${name}[${index}]`;
    }
    for (const name of ['vacancyCount', 'interstitialCount', 'antisiteCount', 'atomCount', 'siteCount']) if (result[name] !== direct[name]) return name;
    return null;
  };
  checks.parity = () => {
    const frame = checks.renderer.frame, result = checks.lastResult, parameters = checks.lastParameters;
    if (checks.lastFrame !== frame) return { identical: false, mismatch: 'frame' };
    const direct = calculateWignerSeitz(frame, { fractional: parameters.referenceFractional, cell: parameters.referenceCell,
      types: parameters.referenceTypes, typeLabels: parameters.referenceTypeLabels }, { affineMapping: parameters.affineMapping });
    let mismatch = compare(result, direct);
    if (checks.property('wsOccupancy').data !== result.atomOccupancy || checks.property('wsDefectClass').data !== result.atomClass) mismatch ??= 'published property';
    const markers = checks.renderer.siteMarkers;
    return { identical: mismatch === null, mismatch, counts: [result.vacancyCount, result.interstitialCount, result.antisiteCount, result.atomCount, result.siteCount],
      markers: markers ? markers.positions.length / 3 : 0, markerPosition: markers ? Array.from(markers.positions.subarray(0, 3)) : null,
      maximumDistance: Math.max(...result.siteDistance), analysisMs: result.elapsedMs };
  };
  // Marker pixels in exported images: all atoms and the cell hidden on black.
  checks.markerPixels = async () => {
    const renderer = checks.renderer, visibility = renderer.visibility;
    const count = canvas => {
      const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let colored = 0;
      for (let pixel = 0; pixel < image.length; pixel += 4) if (image[pixel] > 60 && image[pixel] > image[pixel + 1] + 30) colored++;
      return colored;
    };
    const png = async () => {
      const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
      let resolveBlob; const received = new Promise(resolve => { resolveBlob = resolve; });
      URL.createObjectURL = function(blob) { if (blob.type === 'image/png') resolveBlob(blob); return createUrl.call(this, blob); };
      HTMLAnchorElement.prototype.click = () => {};
      try {
        renderer.setVisibility(new Uint8Array(renderer.atomCount));
        document.getElementById('export-png').click();
        const bitmap = await createImageBitmap(await received), canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
        return count(canvas);
      } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
    };
    const background = renderer.background, cell = renderer.cellVisible;
    renderer.setBackground('#000000'); renderer.setCellVisible(false); renderer.setView('front');
    const shown = await png();
    checks.change('wigner-seitz-show-markers', false, true);
    const hidden = await png();
    checks.change('wigner-seitz-show-markers', true, true);
    const x = renderer.siteMarkers.positions[0];
    renderer.setVisibility(new Uint8Array(renderer.atomCount));
    renderer.setSlices([{ normal: [1, 0, 0], position: x - 1 }]);
    const sliced = count(renderer.captureImage({ includeBackground: true }));
    renderer.setSlices([{ normal: [1, 0, 0], position: x + 1 }]);
    const keptSlice = count(renderer.captureImage({ includeBackground: true }));
    renderer.setSlices([]);
    renderer.setBackground(`#${Array.from(background, value => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`);
    renderer.setCellVisible(cell); renderer.setVisibility(visibility);
    return { shown, hidden, sliced, keptSlice };
  };
  checks.timeLoop = async () => {
    const reference = await replicateFrame(checks.renderer.frame, [2, 1, 1]);
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const h = reference.cell.vectors, lengths = [0, 1, 2].map(axis => Math.hypot(h[axis * 3], h[axis * 3 + 1], h[axis * 3 + 2]));
    const fractional = Float32Array.from(reference.fractional, (value, index) => value + (random() - .5) * .6 / lengths[index % 3]);
    const current = { ...reference, fractional };
    const parameters = { kind: 'wignerSeitz', referenceFractional: reference.fractional, referenceCell: reference.cell,
      referenceTypes: reference.types, referenceTypeLabels: reference.typeLabels, affineMapping: false };
    checks.timing = true;
    const runs = [];
    let result;
    try {
      for (let run = 0; run < 4; run += 1) {
        const startedAt = performance.now();
        result = await checks.pool.analyze(current, parameters);
        runs.push({ totalMs: Math.round(performance.now() - startedAt), assignMs: Math.round(result.assignElapsedMs), workers: result.workerCount });
      }
    } finally { checks.timing = false; }
    const startedAt = performance.now();
    const direct = calculateWignerSeitz(current, reference);
    const directMs = Math.round(performance.now() - startedAt);
    const mismatch = compare(result, direct);
    return { atoms: reference.ids.length, runs, directMs, identical: mismatch === null, mismatch, sharedMemory: result.sharedMemory,
      counts: [result.vacancyCount, result.interstitialCount, result.antisiteCount] };
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
    const transfer = new DataTransfer(); transfer.items.add(new File([text], 'ws-recipe.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.ready = true;
}
