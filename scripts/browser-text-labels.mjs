import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Production UI and LAMMPS dump parser. An FCC crystal (3 × 3 × 3 cells,
// a = 3.52 Å, 108 atoms) is stretched along x by 1% per frame. Frame f has
// timestep 100 f, |a| = 10.56 (1 + 0.01 f) Å, engineering strain 0.01 f
// relative to frame 1, and c_pe = 10 f + (id mod 2), whose mean is exactly
// 10 f + 0.5. Homogeneous strain keeps every atom FCC for adaptive CNA.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-text-labels-'));
const fixture = 'labels-fixture.dump', fixturePath = resolve(temporary, fixture);
const FRAMES = 4, LATTICE = 3.52, CELLS = 3, LENGTH = LATTICE * CELLS;
function fccFrame(frame) {
  const scale = 1 + 0.01 * frame, lines = [];
  let id = 1;
  for (let i = 0; i < CELLS; i++) for (let j = 0; j < CELLS; j++) for (let k = 0; k < CELLS; k++) {
    for (const [x, y, z] of [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]]) {
      lines.push(`${id} 1 ${(i + x) * LATTICE * scale} ${(j + y) * LATTICE} ${(k + z) * LATTICE} ${10 * frame + id % 2}`);
      id++;
    }
  }
  return ['ITEM: TIMESTEP', String(100 * frame), 'ITEM: NUMBER OF ATOMS', String(lines.length), 'ITEM: BOX BOUNDS pp pp pp',
    `0 ${LENGTH * scale}`, `0 ${LENGTH}`, `0 ${LENGTH}`, 'ITEM: ATOMS id type x y z c_pe', ...lines, ''].join('\n');
}
await writeFile(fixturePath, Array.from({ length: FRAMES }, (_, frame) => fccFrame(frame)).join(''));
const TEMPLATE = 'Step [Timestep] · a [Cell.a:.3f] · e [Strain.a:.3f] · pe [Mean.c_pe:.2f] · FCC [CNA.FCC.fraction:.1%]';
const MAGENTA = '#ff00ff';

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(40); }
      throw new Error(`${label}: ${await evaluate(`JSON.stringify({ toast: document.getElementById('toast')?.textContent,
        series: document.getElementById('time-series-status')?.textContent, labels: document.getElementById('text-label-problems')?.textContent,
        recipe: document.getElementById('configuration-status')?.textContent })`)}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("add-text-label")', 'Application startup');
    await evaluate(`(${installChecks.toString()})()`);
    await waitFor('window.labelChecks?.ready', 'Check modules');
    await evaluate('if(document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true")document.getElementById("enable-gpu-computing").click()');
    const { root: dom } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: dom.nodeId, selector: '#file-input' });
    await call('DOM.setFileInputFiles', { nodeId, files: [fixturePath] });
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    await waitFor(`labelChecks.renderer?.frame?.ids.length === 108 && document.getElementById('loading').hidden
      && document.getElementById('frame-count').textContent === '${FRAMES}' && !document.getElementById('add-text-label').disabled`, 'Fixture load');
    const change = (id, value, event = 'change') => evaluate(`labelChecks.change(${JSON.stringify(id)},${JSON.stringify(value)},${JSON.stringify(event)})`);
    const showTool = name => evaluate(`labelChecks.showTool(${JSON.stringify(name)})`);
    async function download(id) {
      await evaluate(`labelChecks.beginDownload();document.getElementById(${JSON.stringify(id)}).click()`);
      try { await waitFor('Boolean(labelChecks.download?.blob)', `${id} download`); return await evaluate('labelChecks.finishDownload()'); }
      finally { await evaluate('labelChecks.restoreDownload()'); }
    }
    const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} ≈ ${expected}`);

    // Without labels, captures are the unchanged legacy images.
    assert.equal(await evaluate('labelChecks.unlabeledEquivalent()'), true, 'no labels: export pixels unchanged');

    // A label on screen, with an unavailable analysis value marked and reported.
    await showTool('textLabels');
    await evaluate('document.getElementById("add-text-label").click()');
    await change('text-label-text', TEMPLATE, 'input');
    await change('text-label-position', 'top-right');
    await change('text-label-size', 20);
    await change('text-label-box', 'custom');
    await change('text-label-box-color', MAGENTA, 'input');
    await waitFor('document.querySelector("#text-label-overlay .text-label")?.textContent.startsWith("Step 0")', 'Overlay label');
    const before = await evaluate('labelChecks.overlay()');
    assert.equal(before.text, 'Step 0 · a 10.560 · e 0.000 · pe 0.50 · FCC [?CNA.FCC.fraction:.1%]');
    assert.ok(before.right >= before.canvasRight - 14 && before.top <= before.canvasTop + 14, `label at the top-right corner: ${JSON.stringify(before)}`);
    assert.match(await evaluate('document.getElementById("text-label-problems").textContent'), /CNA\.FCC\.fraction.*Calculate CNA/);
    assert.equal(await evaluate('document.querySelector("[data-tool-button=textLabels] .tool-enabled-dot").hidden'), false, 'Labels tool is marked active');

    // Labels update when an analysis finishes.
    await showTool('cna');
    await evaluate('document.getElementById("run-cna").click()');
    await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'CNA');
    await waitFor('document.querySelector("#text-label-overlay .text-label")?.textContent.endsWith("FCC 100.0%")', 'Label after CNA');

    // PNG at the viewport size and at a chosen size: pixels at the chosen corner.
    await download('export-png');
    const pngPixels = await evaluate('labelChecks.magenta(labelChecks.lastImage)');
    assert.ok(await evaluate(`labelChecks.topRight(${JSON.stringify(pngPixels)})`), `PNG label pixels: ${JSON.stringify(pngPixels)}`);
    await change('export-resolution', '1080p');
    const hd = await download('export-png');
    assert.deepEqual(hd.size, [1920, 1080]);
    const hdPixels = await evaluate('labelChecks.magenta(labelChecks.lastImage)');
    const canvasHeight = await evaluate('labelChecks.renderer.canvas.height'), hdScale = 1080 / canvasHeight;
    assert.ok(await evaluate(`labelChecks.topRight(${JSON.stringify(hdPixels)}, ${hdScale})`), `HD label pixels: ${JSON.stringify(hdPixels)}`);
    near(hdPixels.boxHeight / pngPixels.boxHeight, hdScale, 0.05 * hdScale, 'label box scales with the annotation scale');

    // A six-view sheet carries one label for the sheet, not one per view.
    const sheet = await download('export-multiview');
    assert.deepEqual(sheet.size, [1920, 1080]);
    const sheetPixels = await evaluate('labelChecks.magenta(labelChecks.lastImage)');
    assert.ok(sheetPixels.count > 100 && sheetPixels.lower === 0 && sheetPixels.left > 1920 * 2 / 3 && sheetPixels.right >= 1920 - 12,
      `six-view label once at the sheet corner: ${JSON.stringify(sheetPixels)}`);

    // The second view stamps the same label.
    await change('export-resolution', 'current');
    await change('compare-view', true);
    await waitFor('labelChecks.comparison?.frame', 'Second view');
    await download('export-comparison-png');
    const secondPixels = await evaluate('labelChecks.magenta(labelChecks.lastImage)');
    assert.ok(await evaluate(`labelChecks.topRight(${JSON.stringify(secondPixels)})`), `second-view label: ${JSON.stringify(secondPixels)}`);
    await change('compare-view', false);

    // Time series: file values read in the background keep the displayed frame.
    await showTool('timeSeries');
    for (const name of ['Timestep', 'Cell.a', 'Strain.a', 'Mean.c_pe', 'CNA.FCC.fraction']) {
      await change('time-series-attribute', name, 'input');
      await evaluate('document.getElementById("add-time-series-attribute").click()');
    }
    await evaluate('[...document.querySelectorAll("#time-series-attribute-list button")].find(button => button.getAttribute("aria-label").includes("Cell.volume"))?.click()');
    assert.equal(await evaluate('document.querySelectorAll("#time-series-attribute-list li").length'), 5);
    await change('time-series-last', FRAMES);
    await evaluate('labelChecks.frameChanges = 0');
    const started = await evaluate('performance.now()');
    await evaluate('document.getElementById("collect-time-series").click()');
    await waitFor(`document.getElementById("time-series-state").textContent === "Partial" && !document.getElementById("collect-time-series").disabled
      && document.querySelector('#time-series-chart path[data-series="Cell.a"]')?.dataset.pointCount === '${FRAMES}'`, 'Background collection');
    const collectMs = await evaluate('performance.now()') - started;
    assert.equal(await evaluate('labelChecks.frameChanges'), 0, 'background reading never displays another frame');
    assert.equal(await evaluate('labelChecks.renderer.frame.frameIndex'), 0);
    assert.equal(await evaluate('document.querySelector(\'#time-series-chart path[data-series="Cell.a"]\').dataset.pointCount'), String(FRAMES));
    assert.equal(await evaluate('document.querySelector(\'#time-series-chart path[data-series="CNA.FCC.fraction"]\').dataset.pointCount'), '1',
      'analysis values exist only for analyzed frames');
    assert.match(await evaluate('document.getElementById("time-series-status").textContent'), /CNA\.FCC\.fraction \(3 missing, analysis\)/);

    // Visit frames fills the analysis values and returns to frame 1.
    await evaluate('document.getElementById("visit-time-series").click()');
    await waitFor('document.getElementById("time-series-state").textContent === "Complete" && labelChecks.renderer.frame.frameIndex === 0 && document.getElementById("loading").hidden', 'Visit frames');
    const csv = await download('export-time-series');
    const rows = csv.text.trim().split('\r\n').map(line => line.split(','));
    assert.deepEqual(rows[0], ['source_file', 'frame_number', 'timestep', 'Timestep', 'Cell.a [Å]', 'Strain.a', 'Mean.c_pe', 'CNA.FCC.fraction']);
    assert.equal(rows.length, FRAMES + 1);
    for (let frame = 0; frame < FRAMES; frame++) {
      const row = rows[frame + 1].slice(1).map(Number);
      assert.deepEqual(row.slice(0, 3), [frame + 1, 100 * frame, 100 * frame]);
      near(row[3], LENGTH * (1 + 0.01 * frame), 1e-9, `Cell.a frame ${frame + 1}`);
      near(row[4], 0.01 * frame, 1e-12, `Strain.a frame ${frame + 1}`);
      near(row[5], 10 * frame + 0.5, 1e-9, `Mean.c_pe frame ${frame + 1}`);
      assert.equal(row[6], 1, `CNA.FCC.fraction frame ${frame + 1}`);
    }
    await evaluate('document.querySelector("#time-series-chart .chart-inspect-slider").value = "2"; document.querySelector("#time-series-chart .chart-inspect-slider").dispatchEvent(new Event("input"))');
    const readout = await evaluate('document.querySelector("#time-series-chart .time-series-readout").textContent');
    assert.match(readout, /^Frame 3/); assert.match(readout, /0\.02 Strain\.a/); assert.match(readout, /20\.5 Mean\.c_pe/);
    await change('time-series-x-axis', 'timestep');
    assert.match(await evaluate('document.querySelector("#time-series-chart .time-series-readout").textContent'), /^Timestep 200 \(frame 3\)/);

    // Every image of the frame-series ZIP stamps its own frame's values.
    await showTool('display');
    await change('export-series-first', 1); await change('export-series-last', FRAMES); await change('export-series-step', 1);
    await evaluate('labelChecks.recordText = []');
    const archive = await download('export-frame-series');
    assert.equal(archive.images.length, FRAMES);
    assert.ok(await evaluate(`${JSON.stringify(archive.images)}.every(image => labelChecks.topRight(image.magenta))`), JSON.stringify(archive.images));
    const stamped = await evaluate('labelChecks.recordText.filter(text => text.startsWith("Step "))');
    assert.deepEqual(stamped, Array.from({ length: FRAMES }, (_, frame) =>
      `Step ${100 * frame} · a ${(LENGTH * (1 + 0.01 * frame)).toFixed(3)} · e ${(0.01 * frame).toFixed(3)} · pe ${(10 * frame + 0.5).toFixed(2)} · FCC 100.0%`));
    await waitFor('document.getElementById("export-series-status").textContent.includes("Exported") && labelChecks.renderer.frame.frameIndex === 0', 'Frame export restore');

    // Configuration round trip restores the label and the plotted attributes.
    const recipe = JSON.parse((await download('export-configuration')).text);
    assert.equal(recipe.settings.extensions.textLabels.labels[0].text, TEMPLATE);
    assert.equal(recipe.settings.extensions.textLabels.labels[0].boxColor, MAGENTA);
    assert.deepEqual(recipe.settings.extensions.timeSeries.attributes, ['Timestep', 'Cell.a', 'Strain.a', 'Mean.c_pe', 'CNA.FCC.fraction']);
    await showTool('textLabels');
    await change('text-label-text', 'Changed', 'input');
    await evaluate(`labelChecks.importRecipe(${JSON.stringify(JSON.stringify(recipe))})`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'Recipe restore');
    assert.equal(await evaluate('document.getElementById("text-label-text").value'), TEMPLATE);
    await waitFor('document.querySelector("#text-label-overlay .text-label")?.textContent.endsWith("FCC 100.0%")', 'Restored label');
    const unsafe = structuredClone(recipe);
    unsafe.settings.extensions.textLabels.labels[0].text = 'x'.repeat(1001);
    await evaluate(`labelChecks.importRecipe(${JSON.stringify(JSON.stringify(unsafe))})`);
    await waitFor('/textLabels.labels\\[0\\]\\.text/.test(document.getElementById("toast").textContent)', 'Oversized template rejected');

    // Phone layout: panels fit, the overlay stays inside the viewport.
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await delay(200);
    const phone = {};
    for (const name of ['textLabels', 'timeSeries']) {
      await showTool(name);
      await evaluate(`document.querySelector('[data-tool-panel="${name}"]').scrollIntoView({ block: 'start' })`);
      await delay(100);
      phone[name] = await evaluate('({ fits: document.documentElement.scrollWidth <= innerWidth, width: document.documentElement.scrollWidth })');
      assert.equal(phone[name].fits, true, `${name} panel fits a phone: ${JSON.stringify(phone[name])}`);
    }
    const phoneLabel = await evaluate('labelChecks.overlay()');
    assert.ok(phoneLabel.left >= phoneLabel.canvasLeft - 1 && phoneLabel.right <= phoneLabel.canvasRight + 1, `phone overlay inside the viewport: ${JSON.stringify(phoneLabel)}`);
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    // Timing on the 40-frame CFG example with CNA.
    await evaluate(`document.getElementById('open-examples').click()`);
    await waitFor(`[...document.querySelectorAll('#source-options .source-option')].some(button => !button.disabled && button.textContent.includes('fixed_end_climb'))`, 'Example catalog');
    await evaluate(`[...document.querySelectorAll('#source-options .source-option')].find(button => !button.disabled && button.textContent.includes('fixed_end_climb')).click()`);
    await waitFor(`document.getElementById('file-name').textContent.includes('fixed_end_climb') && document.getElementById('frame-count').textContent === '40'
      && document.getElementById('loading').hidden && !document.getElementById('collect-time-series').disabled`, 'Example load');
    await showTool('cna');
    await evaluate('document.getElementById("run-cna").click()');
    await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'Example CNA');
    await showTool('timeSeries');
    while (await evaluate('(() => { const button = document.querySelector("#time-series-attribute-list button"); button?.click(); return Boolean(button); })()')) await delay(0);
    assert.equal(await evaluate('document.querySelectorAll("#time-series-attribute-list li").length'), 0);
    for (const name of ['AtomCount', 'Cell.volume', 'Strain.volumetric', 'CNA.FCC.fraction', 'CNA.Other.count']) {
      await change('time-series-attribute', name, 'input');
      await evaluate('document.getElementById("add-time-series-attribute").click()');
    }
    await change('time-series-last', 40);
    const fileStart = await evaluate('performance.now()');
    await evaluate('document.getElementById("collect-time-series").click()');
    await waitFor('document.getElementById("time-series-state").textContent === "Partial" && !document.getElementById("collect-time-series").disabled', 'Example file values', 300_000);
    const exampleFileMs = await evaluate('performance.now()') - fileStart;
    const visitStart = await evaluate('performance.now()');
    await evaluate('document.getElementById("visit-time-series").click()');
    await waitFor('document.getElementById("time-series-state").textContent === "Complete" && labelChecks.renderer.frame.frameIndex === 0 && document.getElementById("loading").hidden', 'Example visit', 300_000);
    const exampleVisitMs = await evaluate('performance.now()') - visitStart;
    const exampleCsv = await download('export-time-series');
    const exampleRows = exampleCsv.text.trim().split('\r\n').slice(1).map(line => line.split(','));
    assert.equal(exampleRows.length, 40);
    assert.ok(exampleRows.every(row => row.slice(3).every(cell => cell !== '')), 'every example frame has every value');
    const fccColumn = exampleCsv.text.split('\r\n')[0].split(',').indexOf('CNA.FCC.fraction');
    const fractions = exampleRows.map(row => Number(row[fccColumn]));
    assert.ok(fractions.every(value => value > 0.5 && value < 1), 'the climbing dislocation keeps most atoms FCC');
    return { overlay: before, pngPixels, hdPixels, sheetPixels, secondPixels, collectMs, archive: archive.images.length, phone,
      example: { fileValuesMs: exampleFileMs, visitWithCnaMs: exampleVisitMs, fccFraction: [Math.min(...fractions), Math.max(...fractions)] } };
  }, { software: true, requireGpu: false });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function installChecks() {
  const app = document.querySelector('script[type="module"][src]').src;
  const [{ WebGLRenderer }] = await Promise.all([import(new URL('./render/webgl-renderer.js', app))]);
  const checks = window.labelChecks = { frameChanges: 0, recordText: null };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') { checks.renderer = this; checks.frameChanges++; } else checks.comparison = this;
    return setFrame.apply(this, args);
  };
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function(text, ...rest) { checks.recordText?.push(String(text)); return fillText.call(this, text, ...rest); };
  checks.change = (id, value, event = 'change') => {
    const element = document.getElementById(id);
    if (typeof value === 'boolean') element.checked = value; else element.value = String(value);
    element.dispatchEvent(new Event(event, { bubbles: true }));
  };
  checks.showTool = name => {
    const panel = document.querySelector(`[data-tool-panel="${name}"]`);
    if (panel.hidden) document.querySelector(`[data-tool-button="${name}"]`).click();
  };
  checks.overlay = () => {
    const label = document.querySelector('#text-label-overlay .text-label'), rect = label.getBoundingClientRect();
    const canvas = document.getElementById('viewport').getBoundingClientRect();
    return { text: label.textContent, left: rect.left, right: rect.right, top: rect.top, canvasLeft: canvas.left, canvasRight: canvas.right, canvasTop: canvas.top };
  };
  const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  checks.unlabeledEquivalent = () => {
    const renderer = checks.renderer, a = pixels(renderer.captureImage()), b = pixels(renderer.captureImage({ textLabels: null }));
    return a.length === b.length && a.every((value, index) => value === b[index]);
  };
  /** Pure magenta (label box) pixels: their count, bounding box and those in the lower half. */
  checks.magenta = image => {
    const data = image.data, { width, height } = image;
    let count = 0, lower = 0, left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (data[offset] < 250 || data[offset + 1] > 5 || data[offset + 2] < 250) continue;
      count++;
      if (y > height / 2) lower++;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
    return { count, lower, width, height, left, top, right, bottom, boxHeight: bottom - top };
  };
  /** One label box in the top-right corner, a margin of 12 scaled pixels from both edges. */
  checks.topRight = (pixels, scale = 1) => pixels.count > 100 && pixels.lower === 0
    && Math.abs(pixels.right - (pixels.width - 12 * scale)) <= 2 && Math.abs(pixels.top - 12 * scale) <= 2;
  const decode = async blob => {
    const bitmap = await createImageBitmap(blob), canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height);
  };
  const oldUrl = URL.createObjectURL, oldClick = HTMLAnchorElement.prototype.click;
  checks.beginDownload = () => {
    checks.download = null;
    URL.createObjectURL = function(blob) { checks.download = { blob }; return oldUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = function() { if (checks.download) checks.download.filename = this.download; };
  };
  checks.restoreDownload = () => { URL.createObjectURL = oldUrl; HTMLAnchorElement.prototype.click = oldClick; };
  checks.finishDownload = async () => {
    const { blob, filename } = checks.download;
    const result = { filename, type: blob.type, bytes: blob.size };
    if (blob.type.startsWith('image/')) { checks.lastImage = await decode(blob); result.size = [checks.lastImage.width, checks.lastImage.height]; }
    else if (blob.type === 'application/zip') {
      const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer); result.images = [];
      for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
        const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)), start = offset + 30 + nameLength + extra;
        const image = await decode(new Blob([bytes.subarray(start, start + length)], { type: 'image/png' }));
        result.images.push({ name, size: [image.width, image.height], magenta: checks.magenta(image) }); offset = start + length;
      }
    } else result.text = await blob.text();
    return result;
  };
  checks.importRecipe = text => {
    const input = document.getElementById('configuration-file'), files = new DataTransfer();
    files.items.add(new File([text], 'recipe.json', { type: 'application/json' }));
    input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.ready = true;
}
