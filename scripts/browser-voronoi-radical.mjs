import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Radical (radius-weighted) Voronoi in the built application: the panel's
// radius table and property source, validation, CPU Workers and WebGPU parity,
// empty cells, the all-cell display and configuration replay.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const fixtures = await mkdtemp(resolve(tmpdir(), 'alloyview-radical-fixtures-'));
// A rock-salt arrangement: simple-cubic sites at spacing 2 Å, checkerboard Ni/Cu.
const spacing = 2, points = [], species = [];
for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
  points.push([a * spacing, b * spacing, c * spacing]); species.push((a + b + c) % 2 ? 'Cu' : 'Ni');
}
const propertyRadius = label => label === 'Ni' ? 1.125 : .75;
await writeFile(resolve(fixtures, 'radical-rock-salt.xyz'), [String(points.length),
  'Lattice="4 0 0 0 4 0 0 0 4" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1:radius:R:1 Step=5',
  ...points.map((point, index) => `${species[index]} ${point.join(' ')} ${index + 1} ${propertyRadius(species[index])}`), ''].join('\n'));
// The smaller ion keeps the cube between its six radical {100} planes.
function rockSalt(small, large) {
  const half = (spacing ** 2 + small ** 2 - large ** 2) / (2 * spacing), volume = (2 * half) ** 3;
  return [volume, 2 * spacing ** 3 - volume];
}

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeout = 120_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
      throw new Error(`${label}: ${JSON.stringify(await evaluate(`({state:document.getElementById('voronoi-state')?.textContent,status:document.getElementById('voronoi-status')?.textContent,summary:document.getElementById('voronoi-summary')?.textContent,configuration:document.getElementById('configuration-status')?.textContent,toast:document.getElementById('toast')?.textContent})`))}`);
    }
    await waitFor('document.readyState==="complete" && document.getElementById("voronoi-radical")', 'radical Voronoi controls');
    await evaluate(`(${initializeChecks.toString()})()`);
    async function setValue(selector, value, { checkbox = false } = {}) {
      await evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw new Error('Missing '+${JSON.stringify(selector)});${checkbox ? 'input.checked' : 'input.value'}=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    }
    async function press(selector) {
      const point = await evaluate(`(() => {const button=document.querySelector(${JSON.stringify(selector)});if(!button)throw new Error('Missing '+${JSON.stringify(selector)});button.scrollIntoView({block:'nearest',inline:'nearest'});const box=button.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2,hit=document.elementFromPoint(x,y);return{x,y,enabled:!button.disabled,reachable:button===hit||button.contains(hit)};})()`);
      assert.ok(point.enabled && point.reachable, `${selector}: ${JSON.stringify(point)}`);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await delay(40);
    }
    async function showTool(name) {
      const category = await evaluate(`document.querySelector('[data-tool-button="${name}"]').closest('[data-tool-category-panel]').dataset.toolCategoryPanel`);
      if (await evaluate(`document.getElementById('tool-category-${category}').getAttribute('aria-selected')!=='true'`)) await press(`#tool-category-${category}`);
      if (await evaluate(`document.querySelector('[data-tool-button="${name}"]').getAttribute('aria-expanded')!=='true'`)) await press(`[data-tool-button="${name}"]`);
    }
    async function expand(selector) { if (await evaluate(`!document.querySelector(${JSON.stringify(selector)}).open`)) await press(`${selector} > summary`); }
    async function inputFile(selector, filename) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector });
      await call('DOM.setFileInputFiles', { nodeId, files: [resolve(fixtures, filename)] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function load() {
      await inputFile('#file-input', 'radical-rock-salt.xyz');
      await waitFor('document.getElementById("file-name").textContent==="radical-rock-salt.xyz" && document.getElementById("loading").hidden && radicalChecks.renderer?.atomCount===8', 'load fixture');
      await delay(100);
    }
    async function useGpu(gpu) {
      if (await evaluate(`document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')===${JSON.stringify(String(!gpu))}`)) await press('#enable-gpu-computing');
    }
    // Waits for a completed full analysis newer than `after` and returns it.
    async function completed(after, label) {
      await waitFor(`document.getElementById("voronoi-state").textContent==="Calculated" && radicalChecks.jobs().length>${after} && radicalChecks.jobs().at(-1).done`, label);
      return evaluate('radicalChecks.result()');
    }
    const close = (actual, expected, tolerance, label) => actual.forEach((value, index) => assert.ok(
      Math.abs(value - expected[index]) <= tolerance * Math.max(1, Math.abs(expected[index])), `${label} ${index}: ${value} vs ${expected[index]}`));
    const typed = (result, radii) => result.atomicVolume.map((_value, atom) => radii[species[atom]]);
    const expected = (small, large) => { const [ni, cu] = small.label === 'Ni' ? rockSalt(small.radius, large.radius) : rockSalt(small.radius, large.radius).reverse();
      return species.map(label => label === 'Ni' ? ni : cu); };

    await load(); await useGpu(false); await showTool('voronoi');
    let jobs = await evaluate('radicalChecks.jobs().length');
    await press('#run-voronoi');
    const standard = await completed(jobs, 'standard CPU Voronoi');
    close(standard.atomicVolume, Array(8).fill(8), 1e-12, 'standard volume');
    assert.equal(standard.tessellation, undefined);
    await expand('#voronoi-radical-controls');
    assert.equal(await evaluate('document.getElementById("voronoi-radical-summary").textContent'), 'Standard Voronoi');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-voronoi-radius-type]")].map(input=>[input.dataset.voronoiRadiusType,input.value,input.disabled])'),
      [['Ni', '1.24', true], ['Cu', '1.28', true]], 'element radii start from the display atomic radii');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true);

    jobs = await evaluate('radicalChecks.jobs().length');
    await setValue('#voronoi-radical', true, { checkbox: true });
    const atomic = await completed(jobs, 'radical CPU Voronoi with atomic radii');
    assert.equal(atomic.tessellation, 'radical'); assert.equal(atomic.summary.emptyCellCount, 0);
    close(atomic.atomicVolume, expected({ label: 'Ni', radius: 1.24 }, { label: 'Cu', radius: 1.28 }), 1e-9, 'atomic-radius volume');
    assert.deepEqual(await evaluate('Array.from(radicalChecks.jobs().at(-1).parameters.radii)'), typed(atomic, { Ni: 1.24, Cu: 1.28 }));

    jobs = await evaluate('radicalChecks.jobs().length');
    await setValue('[data-voronoi-radius-type="Cu"]', '0.6');
    const edited = await completed(jobs, 'edited Cu radius');
    jobs = await evaluate('radicalChecks.jobs().length');
    await setValue('[data-voronoi-radius-type="Ni"]', '1');
    const cpu = await completed(jobs, 'edited Ni radius');
    assert.ok(edited.atomicVolume[1] !== cpu.atomicVolume[1]);
    close(cpu.atomicVolume, expected({ label: 'Cu', radius: .6 }, { label: 'Ni', radius: 1 }), 1e-9, 'edited radius volume');
    assert.match(await evaluate('document.getElementById("voronoi-summary").textContent'), /radical \(radius-weighted\) · 0 empty cells/);
    assert.equal(await evaluate('Boolean(document.querySelector("[data-voronoi-stat=radical]"))'), true);
    jobs = await evaluate('radicalChecks.jobs().length');
    await setValue('[data-voronoi-radius-type="Cu"]', '-0.5');
    await waitFor('document.getElementById("toast").textContent.includes("finite and at least 0")', 'invalid radius notification');
    assert.equal(await evaluate('radicalChecks.jobs().length'), jobs, 'invalid radii never start an analysis');
    assert.equal(await evaluate('document.querySelector("[data-voronoi-radius-type=Cu]").value'), '0.6');

    await useGpu(true); jobs = await evaluate('radicalChecks.jobs().length');
    await press('#run-voronoi');
    const gpu = await completed(jobs, 'radical WebGPU Voronoi');
    assert.equal(gpu.backend, 'gpu', gpu.fallbackReason); assert.equal(gpu.tessellation, 'radical');
    close(gpu.atomicVolume, cpu.atomicVolume, 2e-5, 'GPU volume'); assert.deepEqual(gpu.voronoiIndices, cpu.voronoiIndices);
    // Engines may list a cell's faces in different orders.
    const faces = (result, atom) => Array.from({ length: result.faceOffsets[atom + 1] - result.faceOffsets[atom] }, (_, index) => {
      const face = result.faceOffsets[atom] + index; return [result.faceNeighbors[face], result.faceOrders[face], result.faceAreas[face]];
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    for (let atom = 0; atom < 8; atom++) {
      const first = faces(gpu, atom), second = faces(cpu, atom);
      assert.deepEqual(first.map(face => face.slice(0, 2)), second.map(face => face.slice(0, 2)), `GPU face topology ${atom}`);
      close(first.map(face => face[2]), second.map(face => face[2]), 8e-5, `GPU face area ${atom}`);
    }

    // Large Ni ions take the complete power cells of zero-radius Cu sites.
    jobs = await evaluate('radicalChecks.jobs().length');
    await setValue('[data-voronoi-radius-type="Cu"]', '0');
    await completed(jobs, 'zero Cu radius');
    jobs = await evaluate('radicalChecks.jobs().length');
    await setValue('[data-voronoi-radius-type="Ni"]', '2.4');
    const empty = await completed(jobs, 'empty Cu cells on GPU');
    assert.equal(empty.backend, 'gpu', empty.fallbackReason); assert.equal(empty.summary.emptyCellCount, 4);
    assert.equal(empty.gpuCorrectionReasons.emptyCell, 4, 'empty cells use exact CPU recovery');
    close(empty.atomicVolume, species.map(label => label === 'Ni' ? 16 : 0), 2e-5, 'empty-cell volume');
    assert.ok(species.every((label, atom) => label === 'Ni' || (empty.voronoiCoordination[atom] === 0 && empty.faceOffsets[atom] === empty.faceOffsets[atom + 1])));
    assert.ok(Math.abs(empty.summary.volumeError) < 5e-5);
    assert.match(await evaluate('document.querySelector("[data-voronoi-stat=radical]").textContent'), /Empty radical cells\s*4/);
    await expand('#voronoi-cell-display');
    await setValue('#show-all-voronoi-cells', true, { checkbox: true });
    await waitFor('radicalChecks.allGeometry()?.complete && radicalChecks.allGeometry().cellCount===4', 'all nonempty radical cells');
    assert.deepEqual((await evaluate('radicalChecks.allGeometry()')).atomIndices, species.flatMap((label, atom) => label === 'Ni' ? [atom] : []));
    assert.deepEqual(await evaluate('radicalChecks.jobs("voronoiGeometryBatch").at(-1).parameters.radii'), species.map(label => label === 'Ni' ? 2.4 : 0));
    await setValue('#show-all-voronoi-cells', false, { checkbox: true });

    // Per-atom property radii: Ni 1.125 Å and Cu 0.75 Å in the source file.
    jobs = await evaluate('radicalChecks.jobs().length');
    await setValue('#voronoi-radius-source', 'property');
    const property = await completed(jobs, 'property radii');
    assert.equal(await evaluate('document.getElementById("voronoi-radius-property").value'), 'radius');
    assert.equal(await evaluate('document.getElementById("voronoi-type-radii").hidden && !document.getElementById("voronoi-radius-property-field").hidden'), true);
    close(property.atomicVolume, expected({ label: 'Cu', radius: .75 }, { label: 'Ni', radius: 1.125 }), 2e-5, 'property volume');
    const recipe = JSON.parse(await evaluate(`(async () => {
      const urls = new Map(), create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click; let saved;
      URL.createObjectURL = function(blob) { const url = create.call(this, blob); urls.set(url, blob); return url; };
      HTMLAnchorElement.prototype.click = function() { saved = urls.get(this.href); };
      try { document.getElementById('export-configuration').click(); await new Promise(resolve => setTimeout(resolve, 200)); return await saved.text(); }
      finally { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; }
    })()`));
    const savedVoronoi = recipe.settings.extensions.voronoi;
    assert.deepEqual({ radical: savedVoronoi.radical, radiusSource: savedVoronoi.radiusSource, radiusProperty: savedVoronoi.radiusProperty, typeRadii: savedVoronoi.typeRadii },
      { radical: true, radiusSource: 'property', radiusProperty: 'radius', typeRadii: [{ label: 'Cu', radius: 0 }, { label: 'Ni', radius: 2.4 }] });
    await writeFile(resolve(fixtures, 'radical-recipe.json'), JSON.stringify(recipe));
    await press('#close-file'); await inputFile('#configuration-file', 'radical-recipe.json');
    await waitFor('document.getElementById("configuration-status").textContent.includes("Waiting for source files")', 'recipe waits for its source');
    jobs = await evaluate('radicalChecks.jobs().length');
    await load();
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'radical recipe restored');
    const restored = await completed(jobs, 'restored radical analysis');
    close(restored.atomicVolume, property.atomicVolume, 2e-5, 'restored property volume');
    assert.equal(await evaluate('document.getElementById("voronoi-radical").checked && document.getElementById("voronoi-radius-source").value==="property"'), true);
    await showTool('voronoi'); await expand('#voronoi-radical-controls');
    await setValue('#voronoi-radius-source', 'types');
    jobs = await evaluate('radicalChecks.jobs().length');
    await setValue('#voronoi-radical', false, { checkbox: true });
    const standardAgain = await completed(jobs, 'standard Voronoi after radical');
    assert.equal(standardAgain.tessellation, undefined); close(standardAgain.atomicVolume, Array(8).fill(8), 2e-5, 'standard volume again');
    assert.equal('radii' in await evaluate('radicalChecks.jobs().at(-1).parameters'), false, 'standard requests carry no radii');

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 640, deviceScaleFactor: 1, mobile: true });
    await setValue('#voronoi-radical', true, { checkbox: true });
    await waitFor('document.getElementById("voronoi-state").textContent==="Calculated"', 'phone radical analysis');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true, 'radical controls fit a phone');
    return { adapter, cpuMs: cpu.elapsedMs, gpuMs: gpu.elapsedMs, gpuEngine: gpu.engine, emptyEngine: empty.engine,
      maximumVolumeDifference: Math.max(...gpu.atomicVolume.map((value, index) => Math.abs(value - cpu.atomicVolume[index]))) };
  }, { software: useSoftwareAdapter(true) });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(fixtures, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const [{ WebGLRenderer }, { AnalysisPool }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app))]);
  const checks = window.radicalChecks = { history: [] };
  const setFrame = WebGLRenderer.prototype.setFrame, analyze = AnalysisPool.prototype.analyze, analyzeCPU = AnalysisPool.prototype.analyzeCPU;
  WebGLRenderer.prototype.setFrame = function(...args) { if (this.canvas.id === 'viewport') checks.renderer = this; return setFrame.apply(this, args); };
  const record = (call, original) => async function(frame, parameters, options) {
    const entry = { kind: parameters.kind, parameters, done: false };
    if (call === 'analyze' || parameters.kind.startsWith('voronoiGeometry')) checks.history.push(entry);
    try { return await original.call(this, frame, parameters, options); } finally { entry.done = true; }
  };
  AnalysisPool.prototype.analyze = record('analyze', analyze);
  AnalysisPool.prototype.analyzeCPU = record('analyzeCPU', analyzeCPU);
  const plain = value => JSON.parse(JSON.stringify(value, (_key, item) => ArrayBuffer.isView(item) ? Array.from(item) : item));
  checks.jobs = (kind = 'voronoi') => plain(checks.history.filter(entry => entry.kind === kind));
  checks.result = () => plain(checks.renderer.frame.atomeyeResults.voronoi.result);
  checks.allGeometry = () => {
    const geometry = checks.renderer?.voronoiAllCellGeometry;
    if (!geometry) return null;
    return { cellCount: geometry.cellCount, complete: Boolean(geometry.complete),
      atomIndices: [...new Set(geometry.chunks.flatMap(chunk => Array.from(chunk.cellRanges).filter((_, index) => index % 5 === 0)))].sort((a, b) => a - b) };
  };
}
