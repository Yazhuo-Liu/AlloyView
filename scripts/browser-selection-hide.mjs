import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Exercise the built application with real Workers, pointer/touch clicks and
// actual WebGL/PNG pixels. SwiftShader is used only for rendering validation.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const fixtures = await mkdtemp(resolve(tmpdir(), 'alloyview-selection-hide-fixtures-'));
const artifacts = resolve(tmpdir(), 'alloyview-selection-hide');
await mkdir(artifacts, { recursive: true });
const positions = [[2, 2, 2], [4, 2, 2], [2, 4, 2], [4, 4, 2]];
function xyz(order, energies, step) {
  return ['4', `Lattice="8 0 0 0 8 0 0 0 8" pbc="F F F" Properties=species:S:1:pos:R:3:id:I:1:energy:R:1:vx:R:1:vy:R:1:vz:R:1 Step=${step}`,
    ...order.map(index => `Ni ${positions[index].join(' ')} ${11 + index} ${energies[index]} 1.2 0.5 0`), ''].join('\n');
}
await writeFile(resolve(fixtures, 'selection-outliers.xyz'),
  xyz([0, 1, 2, 3], [0, 1, 2, 1000], 17) + xyz([3, 2, 0, 1], [10, 11, 12, 2000], 18));

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
    const origin = await evaluate('location.origin');
    let mobile = false;
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeout = 45_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
      throw new Error(`${label}: ${JSON.stringify(await evaluate(`({file:document.getElementById('file-name')?.textContent,analysis:document.getElementById('analysis-state')?.textContent,bonds:document.getElementById('bonds-state')?.textContent,group:document.getElementById('selection-group-status')?.textContent,legend:document.getElementById('color-legend')?.textContent,configuration:document.getElementById('configuration-status')?.textContent,toast:document.getElementById('toast')?.textContent})`))}`);
    }
    await waitFor('document.readyState==="complete" && document.getElementById("toggle-selection-group-visibility")', 'selection hide production UI');
    await evaluate(`(${initializeChecks.toString()})()`);
    await evaluate(`if(document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true')document.getElementById('enable-gpu-computing').click()`);
    async function change(id, value, { checkbox = false, event = 'change' } = {}) {
      await evaluate(`(() => {const input=document.getElementById(${JSON.stringify(id)});if(!input)throw new Error('Missing '+${JSON.stringify(id)});${checkbox ? 'input.checked' : 'input.value'}=${JSON.stringify(value)};input.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
    }
    async function press(selector) {
      const point = await evaluate(`(() => {const button=document.querySelector(${JSON.stringify(selector)});if(!button)throw new Error('Missing '+${JSON.stringify(selector)});button.scrollIntoView({block:'nearest',inline:'nearest'});const box=button.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2,hit=document.elementFromPoint(x,y);return{x,y,enabled:!button.disabled,reachable:button===hit||button.contains(hit),hit:hit?.id};})()`);
      assert.ok(point.enabled && point.reachable, `${selector} must be clickable: ${JSON.stringify(point)}`);
      if (mobile) {
        await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: point.x, y: point.y }] });
        await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      }
      await delay(40);
    }
    async function showTool(name) {
      const category = await evaluate(`document.querySelector('[data-tool-button="${name}"]').closest('[data-tool-category-panel]').dataset.toolCategoryPanel`);
      if (await evaluate(`document.getElementById('tool-category-${category}').getAttribute('aria-selected')!=='true'`)) await press(`#tool-category-${category}`);
      if (await evaluate(`document.querySelector('[data-tool-button="${name}"]').getAttribute('aria-expanded')!=='true'`)) await press(`[data-tool-button="${name}"]`);
    }
    async function inputFile(selector, filename) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector });
      assert.ok(nodeId, `${selector} exists`);
      await call('DOM.setFileInputFiles', { nodeId, files: [resolve(fixtures, filename)] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function members(ids) {
      const details = '#selection-group-settings .selection-group-members';
      if (await evaluate(`!document.querySelector(${JSON.stringify(details)}).open`)) await press(`${details} > summary`);
      await change('selection-group-operation', 'replace');
      await change('selection-group-ids', ids.join(', '), { event: 'input' });
      await press('#apply-selection-group-ids');
    }
    const range = () => evaluate('Array.from(document.querySelectorAll(".legend-controls input[type=number]"),input=>input.valueAsNumber)');
    const mask = () => evaluate('Array.from(selectionHideChecks.renderer.visibility)');
    const recipe = () => evaluate('selectionHideChecks.recipe()');
    const pixels = renderer => evaluate(`selectionHideChecks.pixels(${renderer ? JSON.stringify(renderer) : ''})`);
    async function download(selector) {
      await evaluate('selectionHideChecks.beginDownload()');
      await press(selector); await waitFor('selectionHideChecks.download!==null', `download ${selector}`);
      return evaluate('selectionHideChecks.finishDownload()');
    }
    async function screenshot(name) {
      await evaluate(`document.getElementById('toggle-selection-group-visibility').scrollIntoView({block:'nearest'})`);
      await delay(60);
      const capture = await call('Page.captureScreenshot', { format: 'png' });
      const path = resolve(artifacts, name); await writeFile(path, Buffer.from(capture.data, 'base64')); return path;
    }

    assert.equal(await evaluate('document.getElementById("toggle-selection-group-visibility").disabled'), true, 'hide requires a loaded selection');
    await inputFile('#file-input', 'selection-outliers.xyz');
    await waitFor('selectionHideChecks.renderer?.atomCount===4 && document.getElementById("loading").hidden', 'load outlier trajectory');
    await showTool('coordination'); await change('cutoff', '2.1', { event: 'input' }); await press('#run-analysis');
    await waitFor('document.getElementById("analysis-state").textContent==="Calculated"', 'real CPU coordination');
    assert.deepEqual(await evaluate('selectionHideChecks.property("coordination")'), [2, 2, 2, 2]);
    await showTool('bonds'); await change('bonds-cutoff', '2.1'); await press('#run-bonds');
    await waitFor('document.getElementById("bonds-state").textContent==="Calculated"', 'real CPU bond graph');
    await showTool('vectors');
    for (const [id, value] of [['vector-x', 'vx'], ['vector-y', 'vy'], ['vector-z', 'vz']]) await change(id, value);
    await change('show-vectors', true, { checkbox: true });
    await waitFor('selectionHideChecks.renderer.atomVectorFields?.length===1', 'property arrows');
    await showTool('display'); await change('show-cell', false, { checkbox: true }); await change('radius-percent', '25', { event: 'input' });
    await change('color-mode', 'property:energy');
    await evaluate(`selectionHideChecks.renderer.setView('top');selectionHideChecks.renderer.setProjection('orthographic');selectionHideChecks.renderer.resetCamera()`);
    assert.deepEqual(await range(), [0, 1000]);
    assert.equal(await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")'), 'true');
    await showTool('selectionGroups'); await press('#add-selection-group'); await members([14]);
    await change('selection-group-name', 'Outlier', { event: 'input' });
    await evaluate('selectionHideChecks.saveSource()');
    const beforeHidePixels = await pixels(); assert.ok(beforeHidePixels.opaque > 0);
    await press('#toggle-selection-group-visibility');
    assert.deepEqual(await mask(), [255, 255, 255, 0]);
    assert.deepEqual(await range(), [0, 2], 'Auto excludes hidden outlier');
    assert.equal(await evaluate('document.getElementById("selection-group-visible").checked'), false);
    assert.equal(await evaluate('document.getElementById("toggle-selection-group-visibility").textContent'), 'Show selected atoms');
    assert.match(await evaluate('document.querySelector("[data-selection-group-id]").textContent'), /Hidden/);
    assert.equal(await evaluate('selectionHideChecks.renderer.isAtomVisible(3)'), false);
    assert.equal(await evaluate('selectionHideChecks.pickAtom(3)'), -1, 'hidden atom cannot be picked');
    assert.deepEqual(await evaluate('Array.from({length:4},(_,i)=>selectionHideChecks.renderer.primitiveLayer.positionValues[i*4+3])'), [1, 1, 1, -1], 'selection hiding reaches bond and arrow GPU endpoints');
    assert.equal(await evaluate('selectionHideChecks.sourceUnchanged()'), true, 'hiding preserves source arrays, properties, analysis cache and bond/vector arrays');
    const hiddenOutlierPixels = await pixels(); assert.ok(hiddenOutlierPixels.opaque > 0);
    assert.notEqual(hiddenOutlierPixels.hash, beforeHidePixels.hash);
    const desktopScreenshot = await screenshot('selection-hide-desktop.png');
    console.log('Selection hide: outlier range, synchronized controls, source/cache reuse and hidden GPU endpoints passed.');

    // New calculations retain the complete structure even while a group is
    // hidden. Changing the cutoff forces a real job rather than a cache hit.
    await showTool('coordination'); await change('cutoff', '2.11', { event: 'input' }); await press('#run-analysis');
    await waitFor('document.getElementById("analysis-state").textContent==="Calculated" && selectionHideChecks.renderer.frame.properties.find(property=>property.name==="coordination").analysisCutoff===2.11', 'CPU calculation with hidden atoms');
    assert.deepEqual(await evaluate('selectionHideChecks.property("coordination")'), [2, 2, 2, 2], 'CPU counts the hidden atom as a neighbor');
    let hiddenGpuEngine = null;
    if (adapter.available) {
      await press('#enable-gpu-computing'); await change('cutoff', '2.12', { event: 'input' }); await press('#run-analysis');
      await waitFor('document.getElementById("analysis-state").textContent==="Calculated" && selectionHideChecks.renderer.frame.properties.find(property=>property.name==="coordination").analysisCutoff===2.12', 'GPU calculation with hidden atoms');
      hiddenGpuEngine = await evaluate('selectionHideChecks.renderer.frame.properties.find(property=>property.name==="coordination").analysisEngine');
      assert.match(hiddenGpuEngine, /gpu/i, 'supported coordination actually runs on WebGPU');
      assert.deepEqual(await evaluate('selectionHideChecks.property("coordination")'), [2, 2, 2, 2], 'GPU counts the hidden atom as a neighbor');
      await press('#enable-gpu-computing');
    }
    await showTool('display'); await change('color-mode', 'property:energy'); await showTool('selectionGroups');
    assert.deepEqual(await range(), [0, 2]);

    // Manual ranges remain user-controlled, including across row reordering.
    await evaluate(`(() => {const input=document.querySelector('.legend-controls input[type=number]');input.value='-5';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate(`(() => {const input=document.querySelectorAll('.legend-controls input[type=number]')[1];input.value='50';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    assert.equal(await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")'), 'false');
    await press('#toggle-selection-group-visibility'); assert.deepEqual(await range(), [-5, 50]);
    await press('#toggle-selection-group-visibility'); assert.deepEqual(await range(), [-5, 50]);
    await change('frame-slider', '1', { event: 'input' });
    await waitFor('selectionHideChecks.renderer.frame.frameIndex===1 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent==="Calculated" && document.getElementById("bonds-state").textContent==="Calculated"', 'manual range across frame reorder');
    assert.deepEqual(await evaluate('Array.from(selectionHideChecks.renderer.frame.ids)'), [14, 13, 11, 12]);
    assert.deepEqual(await range(), [-5, 50]);
    assert.equal((await mask())[0], 0, 'hidden selection follows stable IDs');
    await press('#legend-auto'); assert.deepEqual(await range(), [10, 12]);
    await change('frame-slider', '0', { event: 'input' });
    await waitFor('selectionHideChecks.renderer.frame.frameIndex===0 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent==="Calculated" && document.getElementById("bonds-state").textContent==="Calculated"', 'return to first frame');
    assert.deepEqual(await range(), [0, 2]);

    // Any hidden overlapping group wins until every such group is shown/deleted.
    await press('#add-selection-group'); await members([14]);
    assert.equal((await mask())[3], 0, 'a visible overlapping group cannot reveal a hidden member');
    await press('#toggle-selection-group-visibility');
    await press('[data-selection-group-id="selection-0"]'); await press('#toggle-selection-group-visibility');
    assert.equal((await mask())[3], 0, 'other hidden membership still applies');
    assert.deepEqual(await range(), [0, 2]);
    await press('[data-selection-group-id="selection-1"]'); await press('#delete-selection-group');
    assert.deepEqual(await mask(), [255, 255, 255, 255]); assert.deepEqual(await range(), [0, 1000]);
    await press('#toggle-selection-group-visibility');
    await press('#add-selection-group'); await members([11, 12, 13]); await change('selection-group-name', 'Remaining atoms', { event: 'input' });
    await showTool('display'); await change('compare-view', true, { checkbox: true });
    await waitFor('selectionHideChecks.comparison?.frame===selectionHideChecks.renderer.frame', 'second view initialized');
    await showTool('selectionGroups'); await press('#toggle-selection-group-visibility');
    assert.deepEqual(await mask(), [0, 0, 0, 0]);
    assert.equal(await evaluate('document.getElementById("legend-empty-range").textContent'), 'No visible finite values');
    assert.equal(await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")'), 'true');
    assert.equal(await evaluate('document.getElementById("legend-auto").disabled'), true);
    assert.deepEqual(await range(), [], 'empty Auto has no fabricated numeric limits');
    assert.equal(await evaluate('Boolean(document.querySelector(".legend-gradient"))'), false);
    assert.doesNotMatch(await evaluate('document.getElementById("color-legend").textContent'), /NaN|Infinity/);
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:energy');
    assert.equal((await pixels()).opaque, 0, 'all hidden atoms, attached bonds and arrows leave no rendered pixels');
    assert.deepEqual(await evaluate('Array.from(selectionHideChecks.comparison.visibility)'), [0, 0, 0, 0]);
    assert.deepEqual(await evaluate('Array.from({length:4},(_,i)=>selectionHideChecks.comparison.primitiveLayer.positionValues[i*4+3])'), [-1, -1, -1, -1]);
    assert.equal((await pixels('comparison')).opaque, 0, 'second view hides all attached geometry');
    await showTool('display');
    for (const id of ['png-background', 'png-legend', 'png-axes']) await change(id, false, { checkbox: true });
    const png = await download('#export-png');
    assert.equal(png.type, 'image/png'); assert.equal(png.opaque, 0, 'real PNG export excludes hidden geometry');
    await writeFile(resolve(artifacts, png.filename), Buffer.from(png.bytes));
    console.log('Selection hide: manual/frame ranges, stable IDs, overlaps, empty Auto and transparent PNG/second-view geometry passed.');

    // Configuration saves display filters; analysis/CSV still includes all atoms.
    const hiddenRecipe = await recipe();
    assert.ok(hiddenRecipe.settings.selectionGroups.groups.every(group => !group.visible));
    await writeFile(resolve(fixtures, 'selection-hidden.json'), JSON.stringify(hiddenRecipe));
    await showTool('statistics');
    if (await evaluate('!document.querySelector(".statistics-csv-section").open')) await press('.statistics-csv-section > summary');
    const csv = await download('#export-atom-properties');
    assert.equal(csv.type.startsWith('text/csv'), true);
    const csvRows = csv.text.trimEnd().split('\r\n');
    assert.equal(csvRows.length, 5, 'display hiding retains all four atoms in scientific CSV');
    assert.ok(csvRows.slice(1).some(row => row.includes('1000')), 'hidden outlier remains in exported scientific data');
    await showTool('selectionGroups'); await press('#toggle-selection-group-visibility');
    await press('[data-selection-group-id="selection-0"]'); await press('#toggle-selection-group-visibility');
    assert.deepEqual(await mask(), [255, 255, 255, 255]);
    await inputFile('#configuration-file', 'selection-hidden.json');
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && selectionHideChecks.renderer.visibility.every(value=>value===0)', 'hidden groups configuration replay');
    assert.equal(await evaluate('document.getElementById("legend-empty-range").textContent'), 'No visible finite values');
    assert.equal((await pixels()).opaque, 0);

    // Existing atom-category controls continue to leave arrow layers independent.
    await showTool('selectionGroups');
    for (const id of ['selection-0', 'selection-1']) { await press(`[data-selection-group-id="${id}"]`); await press('#toggle-selection-group-visibility'); }
    await showTool('display'); await change('compare-view', false, { checkbox: true }); await change('color-mode', 'type');
    await press('[data-category-property="type"][data-atom-type="Ni"]');
    assert.deepEqual(await mask(), [0, 0, 0, 0]);
    assert.deepEqual(await evaluate('Array.from({length:4},(_,i)=>selectionHideChecks.renderer.primitiveLayer.positionValues[i*4+3])'), [0, 0, 0, 0]);
    assert.ok((await pixels()).opaque > 0, 'ordinary legend hiding keeps arrows independently visible');
    await press('[data-category-property="type"][data-atom-type="Ni"]'); await change('color-mode', 'property:energy');
    await showTool('selectionGroups');
    await press('[data-selection-group-id="selection-1"]'); await press('#clear-selection-group');
    assert.equal(await evaluate('document.getElementById("toggle-selection-group-visibility").disabled'), true, 'empty group has no hide action');
    await members([999]);
    assert.equal(await evaluate('document.getElementById("toggle-selection-group-visibility").disabled'), true, 'only missing IDs have no hide action');
    await press('#delete-selection-group'); await press('#toggle-selection-group-visibility');
    assert.deepEqual(await range(), [0, 2]);

    // The primary action stays reachable on small screens with a fixed viewport.
    mobile = true;
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await press('#toggle-selection-group-visibility'); assert.deepEqual(await range(), [0, 1000]);
    await press('#toggle-selection-group-visibility'); assert.deepEqual(await range(), [0, 2]);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    const phoneScreenshot = await screenshot('selection-hide-phone.png');
    const viewportRect = await evaluate('(() => {const box=document.getElementById("viewport").getBoundingClientRect();return {top:box.top,bottom:box.bottom,height:box.height};})()');
    assert.ok(viewportRect.top >= 0 && viewportRect.bottom <= 844 && viewportRect.height > 100, 'phone toolbar scrolling retains the viewport');
    await press('#delete-selection-group'); assert.deepEqual(await range(), [0, 1000], 'deleting the hidden group restores Auto range');
    await evaluate('document.getElementById("close-file").click()');
    assert.equal(await evaluate('document.getElementById("toggle-selection-group-visibility").disabled'), true);
    console.log('Selection hide: scientific CSV, configuration replay, independent ordinary arrows, missing/empty groups and mobile touch passed.');
    return { adapter, rendering: 'SwiftShader validation only', fixtureAtoms: 4, hiddenGpuEngine,
      checks: ['Auto range excludes hidden members', 'manual range persists across frames', 'stable IDs and overlapping groups',
        'unchanged source/analysis caches', 'CPU/GPU calculations include hidden atoms', 'hidden atoms, bonds and arrows', 'empty Auto state', 'second view and transparent PNG',
        'complete scientific CSV', 'configuration replay', 'independent ordinary category arrows', 'desktop and phone actions'],
      screenshots: [desktopScreenshot, phoneScreenshot], pngDirectory: artifacts };
  });
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(fixtures, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const [{ WebGLRenderer }, { AnalysisPool }, { transformPoint }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)),
    import(new URL('./render/math.js', app)),
  ]);
  const checks = window.selectionHideChecks = { history: [], download: null };
  const setFrame = WebGLRenderer.prototype.setFrame, analyze = AnalysisPool.prototype.analyze;
  WebGLRenderer.prototype.setFrame = function(...args) {
    checks[this.canvas.id === 'viewport' ? 'renderer' : 'comparison'] = this;
    return setFrame.apply(this, args);
  };
  AnalysisPool.prototype.analyze = function(frame, parameters, options) {
    checks.history.push({ frame, parameters }); return analyze.call(this, frame, parameters, options);
  };
  checks.property = name => Array.from(checks.renderer.frame.properties.find(property => property.name === name)?.data ?? []);
  checks.saveSource = () => {
    const r = checks.renderer, f = r.frame;
    checks.source = { frame: f, ids: f.ids, positions: f.positions, fractional: f.fractional,
      properties: f.properties.map(property => ({ name: property.name, data: property.data, values: Array.from(property.data) })),
      idsValues: Array.from(f.ids), positionsValues: Array.from(f.positions), fractionalValues: Array.from(f.fractional),
      cache: f.atomeyeResults?.bonds, bonds: r.atomBonds, vectors: r.atomVectorFields[0]?.vectors,
      jobCount: checks.history.length };
  };
  checks.sourceUnchanged = () => {
    const r = checks.renderer, f = r.frame, s = checks.source;
    const equal = (first, second) => first.length === second.length && first.every((value, index) => Object.is(value, second[index]));
    return f === s.frame && f.ids === s.ids && f.positions === s.positions && f.fractional === s.fractional
      && equal(Array.from(f.ids), s.idsValues) && equal(Array.from(f.positions), s.positionsValues) && equal(Array.from(f.fractional), s.fractionalValues)
      && s.properties.every(item => { const current = f.properties.find(property => property.name === item.name);return current?.data === item.data && equal(Array.from(current.data), item.values); })
      && f.atomeyeResults?.bonds === s.cache && r.atomBonds === s.bonds && r.atomVectorFields[0]?.vectors === s.vectors && checks.history.length === s.jobCount;
  };
  checks.pickAtom = index => {
    const r = checks.renderer; r.updateMatrices();
    const p = transformPoint(r.viewProjectionMatrix, ...r.displayPositions.slice(index * 3, index * 3 + 3)), box = r.canvas.getBoundingClientRect();
    return r.pick(box.left + (p[0] / p[3] * .5 + .5) * box.width, box.top + (.5 - p[1] / p[3] * .5) * box.height);
  };
  checks.pixels = (kind = 'renderer') => {
    const canvas = checks[kind].captureImage({ includeBackground: false });
    const values = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0, hash = 2166136261;
    for (let index = 0; index < values.length; index++) { hash = Math.imul(hash ^ values[index], 16777619);if (index % 4 === 3 && values[index]) opaque++; }
    return { opaque, hash: hash >>> 0, width: canvas.width, height: canvas.height };
  };
  checks.beginDownload = () => {
    const urls = new Map(), create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    checks.download = null;
    URL.createObjectURL = function(blob) { const url = create.call(this, blob); urls.set(url, blob); return url; };
    HTMLAnchorElement.prototype.click = function() { const blob = urls.get(this.href);if (blob) checks.download = { blob, filename: this.download }; };
    checks.restoreDownload = () => { URL.createObjectURL = create;HTMLAnchorElement.prototype.click = click; };
  };
  checks.finishDownload = async () => {
    try {
      const { blob, filename } = checks.download;
      if (blob.type === 'image/png') {
        const image = await createImageBitmap(blob), canvas = document.createElement('canvas');canvas.width = image.width;canvas.height = image.height;
        const context = canvas.getContext('2d');context.drawImage(image, 0, 0);image.close();
        const values = context.getImageData(0, 0, canvas.width, canvas.height).data;let opaque = 0;
        for (let index = 3; index < values.length; index += 4) if (values[index]) opaque++;
        return { filename, type: blob.type, opaque, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
      }
      return { filename, type: blob.type, text: await blob.text() };
    } finally { checks.restoreDownload();checks.download = null; }
  };
  checks.recipe = async () => { checks.beginDownload();document.getElementById('export-configuration').click();const output = await checks.finishDownload();return JSON.parse(output.text); };
}
