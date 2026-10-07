import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// The built application, actual CPU Workers, real WebGPU kernels and pointer
// input are exercised together. SwiftShader timings are validation only.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const fixtures = await mkdtemp(resolve(tmpdir(), 'alloyview-voronoi-fixtures-'));
const artifacts = resolve(tmpdir(), 'alloyview-voronoi-tools');
await mkdir(artifacts, { recursive: true });
const basis = [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]];
const positions = [];
for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
  for (const point of basis) positions.push(point.map((value, axis) => (value + [a, b, c][axis]) * 4));
}
const idealPositions = positions.map(point => [...point]);
// Small, nonsymmetric distortion provides a meaningful volume distribution
// and avoids using a rounded constant-volume display to verify GPU parity.
positions[0] = [.12, .07, .09]; positions[7][1] += .06;
const binaryPositions = [], binarySpecies = [];
for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
  binaryPositions.push([a * 2, b * 2, c * 2]); binarySpecies.push((a + b + c) % 2 ? 'Cu' : 'Ni');
}
function xyz(points, step, { lattice = [8, 0, 0, 0, 8, 0, 0, 0, 8], pbc = 'T T T', species = null } = {}) {
  return [String(points.length), `Lattice="${lattice.join(' ')}" pbc="${pbc}" Properties=species:S:1:pos:R:3:id:I:1 Step=${step}`,
    ...points.map((point, index) => `${species?.[index] ?? 'Ni'} ${point.join(' ')} ${101 + index}`), ''].join('\n');
}
await Promise.all([
  writeFile(resolve(fixtures, 'voronoi-two-frames.xyz'), xyz(positions, 17)
    + xyz(positions.map((point, index) => point.map((value, axis) => value + (index === 0 && axis === 0 ? .14 : 0))), 18)),
  writeFile(resolve(fixtures, 'open-voronoi.xyz'), xyz([[.25, .5, .5], [.75, .5, .5]], 19,
    { lattice: [1, 0, 0, 0, 1, 0, 0, 0, 1], pbc: 'F F F' })),
  writeFile(resolve(fixtures, 'ideal-fcc.xyz'), xyz(idealPositions, 20)),
  writeFile(resolve(fixtures, 'origin-sc.xyz'), xyz([[0, 0, 0]], 21,
    { lattice: [2, 0, 0, 0, 2, 0, 0, 0, 2] })),
  writeFile(resolve(fixtures, 'wall-voronoi.xyz'), xyz([[0, 1, 1]], 22,
    { lattice: [2, 0, 0, 0, 2, 0, 0, 0, 2], pbc: 'F F F' })),
  writeFile(resolve(fixtures, 'binary-voronoi.xyz'), xyz(binaryPositions, 23,
    { lattice: [4, 0, 0, 0, 4, 0, 0, 0, 4], species: binarySpecies })
    + xyz(binaryPositions, 24, { lattice: [4, 0, 0, 0, 4, 0, 0, 0, 4],
      species: binarySpecies.map(label => label === 'Ni' ? 'Cu' : 'Ni') })),
]);

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
    const origin = await evaluate('location.origin');
    let mobile = false;
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeout = 90_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
      throw new Error(`${label}: ${JSON.stringify(await evaluate(`({file:document.getElementById('file-name')?.textContent,state:document.getElementById('voronoi-state')?.textContent,status:document.getElementById('voronoi-status')?.textContent,cell:document.getElementById('voronoi-cell-status')?.textContent,configuration:document.getElementById('configuration-status')?.textContent,toast:document.getElementById('toast')?.textContent})`))}`);
    }
    await waitFor('document.readyState==="complete" && document.getElementById("show-voronoi-cell")', 'new Voronoi production UI');
    await evaluate(`(${initializeChecks.toString()})()`);
    async function change(id, value, { checkbox = false, event = 'change' } = {}) {
      await evaluate(`(() => {const input=document.getElementById(${JSON.stringify(id)});if(!input)throw new Error('Missing '+${JSON.stringify(id)});${checkbox ? 'input.checked' : 'input.value'}=${JSON.stringify(value)};input.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
    }
    async function press(selector) {
      const point = await evaluate(`(() => {const button=document.querySelector(${JSON.stringify(selector)});if(!button)throw new Error('Missing '+${JSON.stringify(selector)});button.scrollIntoView({block:'nearest',inline:'nearest'});const box=button.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2,hit=document.elementFromPoint(x,y);return{x,y,enabled:!button.disabled,reachable:button===hit||button.contains(hit),hit:hit?.id};})()`);
      assert.ok(point.enabled && point.reachable, `${selector}: ${JSON.stringify(point)}`);
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
    async function expand(selector) { if (await evaluate(`!document.querySelector(${JSON.stringify(selector)}).open`)) await press(`${selector} > summary`); }
    async function inputFile(selector, filename) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector });
      assert.ok(nodeId, `${selector} exists`);
      await call('DOM.setFileInputFiles', { nodeId, files: [resolve(fixtures, filename)] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function load(filename, count) {
      await inputFile('#file-input', filename);
      await waitFor(`document.getElementById('file-name').textContent===${JSON.stringify(filename)} && document.getElementById('loading').hidden && voronoiChecks.renderer?.atomCount===${count}`, `load ${filename}`);
      await delay(100);
    }
    async function run({ gpu = false, hold = null } = {}) {
      if (await evaluate(`document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')===${JSON.stringify(String(!gpu))}`)) await press('#enable-gpu-computing');
      await showTool('voronoi');
      if (hold) await evaluate(`voronoiChecks.holdKind=${JSON.stringify(hold)}`);
      await press('#run-voronoi');
      await waitFor(hold === 'voronoi' ? 'voronoiChecks.held?.kind==="voronoi"'
        : 'document.getElementById("voronoi-state").textContent==="Calculated"', `${gpu ? 'GPU' : 'CPU'} Voronoi`);
      if (!hold) {
        assert.equal(await evaluate('voronoiChecks.result().backend'), gpu ? 'gpu' : 'cpu', 'requested backend executes the real Voronoi kernel');
        assert.match(await evaluate('document.getElementById("voronoi-backend").textContent'), gpu ? /GPU/i : /CPU|worker|wasm/i);
      }
    }
    async function pointerPick(replica = null) {
      const point = await evaluate(`voronoiChecks.pickablePoint(${JSON.stringify(replica)})`);
      assert.ok(point && point.index >= 0, 'a visible atom is pickable');
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await waitFor(`voronoiChecks.renderer.selected===${point.index}`, 'ordinary atom selection');
      return point;
    }
    async function screenshot(name) {
      await delay(60); const capture = await call('Page.captureScreenshot', { format: 'png' });
      const path = resolve(artifacts, name); await writeFile(path, Buffer.from(capture.data, 'base64')); return path;
    }
    async function download(selector) {
      await evaluate('voronoiChecks.beginDownload()'); await press(selector);
      await waitFor('voronoiChecks.download!==null', `download ${selector}`);
      return evaluate('voronoiChecks.finishDownload()');
    }
    const pixels = kind => evaluate(`voronoiChecks.pixels(${JSON.stringify(kind ?? 'renderer')})`);
    const result = () => evaluate('voronoiChecks.result()');

    assert.equal(await evaluate('document.getElementById("show-voronoi-cell").disabled'), true, 'cell display requires calculated topology');
    assert.equal(await evaluate('document.getElementById("show-all-voronoi-cells").checked'), false, 'all-cell drawing is optional and initially off');
    assert.equal(await evaluate('document.getElementById("voronoi-type-selection").open'), false, 'element selection starts folded');
    await load('voronoi-two-frames.xyz', 32); await run();
    const cpuResult = await result();
    close([cpuResult.summary.totalVolume], [512], 1e-9);
    assert.ok(Math.max(...cpuResult.atomicVolume) > Math.min(...cpuResult.atomicVolume));
    assert.equal(await evaluate('document.querySelectorAll("#voronoi-stat-cards [data-voronoi-stat]").length'), 6);
    assert.equal(await evaluate('document.getElementById("voronoi-distributions").open'), false, 'long charts start folded');
    assert.equal(await evaluate('document.getElementById("voronoi-topology-details").open'), false, 'complete index table starts folded');
    assert.equal(await evaluate('document.getElementById("voronoi-topology-populations").closest("details").id'), 'voronoi-distributions', 'common indices belong to the folded distributions');
    assert.equal(await evaluate('document.getElementById("voronoi-topology-populations").checkVisibility()'), false, 'common indices are folded initially');
    for (const [id, property] of [['volume', 'atomicVolume'], ['coordination', 'voronoiCoordination'], ['surface', 'voronoiSurfaceArea'], ['face-order', 'voronoiMaxFaceOrder'], ['boundary', 'voronoiBoundaryFaces']]) {
      await press(`#voronoi-color-${id}`);
      assert.equal(await evaluate('document.getElementById("color-mode").value'), `property:${property}`);
    }
    await press('#voronoi-color-volume'); await expand('#voronoi-distributions');
    assert.ok(await evaluate('document.querySelectorAll("#voronoi-topology-populations [data-voronoi-index]").length>0 || document.getElementById("voronoi-topology-populations").textContent.includes("<")'), 'opening distributions exposes common topological populations');
    const volumeChart = '#voronoi-volume-chart';
    assert.equal(await evaluate(`document.querySelectorAll('${volumeChart} svg path.chart-bar').length`), 1, 'one bar path avoids excessive DOM');
    await press(`${volumeChart} .chart-modes button:last-child`);
    assert.match(await evaluate(`document.querySelector('${volumeChart} svg').textContent`), /Probability/i);
    const volumeBins = cpuResult.volumeHistogram.length;
    await evaluate(`(() => {const slider=document.querySelector('${volumeChart} .chart-inspect-slider');slider.value=String(Math.floor(${volumeBins}/2));slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    assert.ok(await evaluate(`document.querySelector('${volumeChart} .chart-readout').textContent.length>0`), 'selected histogram bin exposes numerical values');
    console.log('Voronoi UI: CPU domain volume, summary cards, quantity shortcuts and readable distributions passed.');

    await run({ gpu: true });
    const gpuResult = await result();
    close(gpuResult.atomicVolume, cpuResult.atomicVolume, 2e-4);
    close(gpuResult.voronoiSurfaceArea, cpuResult.voronoiSurfaceArea, 2e-4);
    assert.deepEqual(gpuResult.voronoiCoordination, cpuResult.voronoiCoordination);
    assert.deepEqual(gpuResult.voronoiIndices, cpuResult.voronoiIndices);
    close([gpuResult.summary.totalVolume], [512], 2e-5);
    const gpuCsv = await download('#export-voronoi-csv');
    assert.match(gpuCsv.type, /^text\/csv/); assert.ok(gpuCsv.text.includes('volume [Å³]'));
    await writeFile(resolve(artifacts, gpuCsv.filename), gpuCsv.text);
    await showTool('display'); await change('show-cell', false, { checkbox: true });
    await change('radius-percent', '35', { event: 'input' });
    await change('png-background', false, { checkbox: true }); await change('png-legend', false, { checkbox: true }); await change('png-axes', false, { checkbox: true });
    await evaluate('voronoiChecks.renderer.setView("front");voronoiChecks.renderer.setProjection("orthographic");voronoiChecks.renderer.resetCamera()');
    const selected = await pointerPick();
    await showTool('voronoi'); await expand('#voronoi-cell-display');
    const bare = await pixels();
    await change('show-voronoi-cell', true, { checkbox: true });
    await waitFor('voronoiChecks.geometry()!==null', 'selected convex cell mesh');
    assert.equal(await evaluate('document.getElementById("voronoi-cell-color").disabled || document.getElementById("voronoi-cell-opacity").disabled'), false);
    await change('voronoi-cell-color', '#00ccff'); await change('voronoi-cell-opacity', '.45');
    const geometry = await evaluate('voronoiChecks.geometry()');
    assert.equal(geometry.atomIndex, selected.index);
    assert.ok(geometry.vertices.length >= 12 && geometry.faceOffsets.length >= 5);
    assert.ok(await evaluate('voronoiChecks.renderer.voronoiCellLayer.vertexCount>0 && voronoiChecks.renderer.voronoiCellLayer.indexCount>0 && voronoiChecks.renderer.voronoiCellLayer.edgeCount>0'), 'cell faces and edges reach the WebGL layer');
    const illustrated = await pixels();
    assert.notEqual(illustrated.hash, bare.hash, 'the selected cell changes actual viewport pixels');
    await evaluate(`(() => {const sidebar=document.getElementById('sidebar'),target=document.getElementById('voronoi-stat-cards');sidebar.scrollTop+=target.getBoundingClientRect().top-sidebar.getBoundingClientRect().top-18;})()`);
    const desktopScreenshot = await screenshot('voronoi-desktop.png');
    const pngWithCell = await download('#export-png');
    assert.match(pngWithCell.type, /^image\/png/);
    await writeFile(resolve(artifacts, 'selected-cell.png'), Buffer.from(pngWithCell.bytes));
    await change('show-voronoi-cell', false, { checkbox: true });
    const pngWithoutCell = await download('#export-png');
    assert.notEqual(pngWithCell.hash, pngWithoutCell.hash, 'PNG includes the displayed polyhedron');
    await change('show-voronoi-cell', true, { checkbox: true });
    await waitFor('voronoiChecks.geometry()!==null', 'restore selected cell');
    console.log('Voronoi UI: real GPU parity and selected-cell viewport/PNG pixels passed.');

    // Display transformations must not initiate full tessellations or mutate
    // scientific values. They move the selected cell in the same display space.
    await evaluate('voronoiChecks.saveSource()');
    await showTool('display'); await expand('.periodic-origin-controls'); await change('display-origin-a', '.2');
    assert.equal(await evaluate('voronoiChecks.sourceUnchanged()'), true, 'periodic origin preserves all scientific inputs/results');
    assert.deepEqual((await evaluate('voronoiChecks.geometry()')).vertices, geometry.vertices, 'display origin translates the mesh without changing its local geometry');
    await showTool('replicate'); await change('replicate-a', '2'); await press('#apply-replicate');
    await waitFor('voronoiChecks.renderer.repetitions[0]===2', 'display replication');
    assert.equal(await evaluate('voronoiChecks.sourceUnchanged()'), true, 'display replication keeps computation unchanged');
    await pixels();
    assert.equal(await evaluate('voronoiChecks.renderer.voronoiCellLayer.renderedReplicaCount'), 2, 'both displayed replicas receive selected-cell polyhedra');
    const replica = await pointerPick([1, 0, 0]);
    await waitFor(`voronoiChecks.geometry()?.atomIndex===${replica.index}`, 'selected replica cell');
    await showTool('display'); await change('compare-view', true, { checkbox: true });
    await waitFor('voronoiChecks.comparison?.frame && voronoiChecks.geometry("comparison")!==null', 'second-view selected cell');
    const secondOn = await pixels('comparison');
    await showTool('voronoi'); await change('show-voronoi-cell', false, { checkbox: true });
    assert.notEqual((await pixels('comparison')).hash, secondOn.hash, 'comparison view shares cell visibility');
    await change('show-voronoi-cell', true, { checkbox: true });
    await waitFor('voronoiChecks.geometry()!==null', 'selected cell for hide test');
    await showTool('selectionGroups'); await press('#add-selection-group');
    await expand('#selection-group-settings .selection-group-members');
    await change('selection-group-operation', 'replace'); await change('selection-group-ids', String(replica.id), { event: 'input' }); await press('#apply-selection-group-ids');
    await press('#toggle-selection-group-visibility');
    const hiddenCellOn = await pixels();
    await showTool('voronoi'); await change('show-voronoi-cell', false, { checkbox: true });
    assert.deepEqual(await pixels(), hiddenCellOn, 'a hidden source atom has no displayed cell or dangling cell edges');
    await change('show-voronoi-cell', true, { checkbox: true });
    await showTool('selectionGroups'); await press('#toggle-selection-group-visibility');
    await showTool('slice'); await press('#add-slice'); await change('slice-offset', '-1000'); await change('slice-show-gizmo', false, { checkbox: true });
    const slicedCellOn = await pixels();
    await showTool('voronoi'); await change('show-voronoi-cell', false, { checkbox: true });
    assert.deepEqual(await pixels(), slicedCellOn, 'a sliced-out selected atom does not leave a cell overlay');
    await showTool('slice'); await press('#delete-slice');
    await showTool('display'); await change('compare-view', false, { checkbox: true });
    await showTool('replicate'); await press('#reset-replicate');
    await showTool('display'); await press('#origin-reset');
    console.log('Voronoi UI: periodic origin, replicas, second view, selection hiding and slicing passed.');

    await showTool('voronoi'); await change('show-voronoi-cell', true, { checkbox: true });
    await waitFor('voronoiChecks.geometry()!==null', 'selected cell before cancellation');
    const savedPreview = JSON.parse((await download('#export-configuration')).text);
    assert.equal(savedPreview.settings.extensions.voronoiDisplay.enabled, true);
    assert.equal(savedPreview.settings.extensions.voronoiDisplay.color.toLowerCase(), '#00ccff');
    close([savedPreview.settings.extensions.voronoiDisplay.opacity], [.45], 1e-12);
    await press('#cancel-voronoi');
    assert.equal(await evaluate('voronoiChecks.geometry()'), null);
    assert.equal(await evaluate('document.getElementById("show-voronoi-cell").disabled'), true);
    assert.equal(await evaluate('document.getElementById("export-voronoi-csv").disabled'), true);
    await run({ hold: 'voronoi' }); await press('#cancel-voronoi');
    assert.equal(await evaluate('voronoiChecks.held.signal.aborted'), true);
    await evaluate('voronoiChecks.release()'); await delay(120);
    assert.equal(await evaluate('voronoiChecks.geometry()'), null, 'late analysis cannot recreate a canceled overlay');
    assert.equal(await evaluate('document.getElementById("voronoi-results").hidden'), true);
    // Recipes restore topology first, then reconstruct the inspected cell
    // from the matching source rather than serializing a stale display mesh.
    await writeFile(resolve(fixtures, 'voronoi-preview-recipe.json'), JSON.stringify(savedPreview));
    await press('#close-file'); await inputFile('#configuration-file', 'voronoi-preview-recipe.json');
    await waitFor('document.getElementById("configuration-status").textContent.includes("Waiting for source files")', 'preview recipe waits for matching local source');
    const beforeReplay = await evaluate('voronoiChecks.history.length');
    await load('voronoi-two-frames.xyz', 32);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("voronoi-state").textContent==="Calculated" && voronoiChecks.geometry()!==null', 'preview recipe restores topology and selected-cell geometry');
    assert.equal(await evaluate('document.getElementById("show-voronoi-cell").checked'), true);
    assert.equal(await evaluate('document.getElementById("voronoi-cell-color").value.toLowerCase()'), '#00ccff');
    close([await evaluate('Number(document.getElementById("voronoi-cell-opacity").value)')], [.45], 1e-12);
    assert.equal(await evaluate('voronoiChecks.renderer.frame.ids[voronoiChecks.geometry().atomIndex]'), savedPreview.settings.selectedAtomId);
    assert.ok(await evaluate(`voronoiChecks.history.slice(${beforeReplay}).some(entry=>entry.kind==='voronoi') && voronoiChecks.history.slice(${beforeReplay}).some(entry=>entry.kind==='voronoiGeometry')`), 'recipe replay executes fresh tessellation and inspected-cell extraction');
    close((await result()).atomicVolume, gpuResult.atomicVolume, 2e-4);
    const replayedPreview = JSON.parse((await download('#export-configuration')).text);
    assert.deepEqual(replayedPreview.settings.extensions.voronoiDisplay, savedPreview.settings.extensions.voronoiDisplay);
    console.log('Voronoi UI: saved preview recipe reconstructs topology, appearance and selected-cell geometry.');
    await run();
    await pointerPick();
    await expand('#voronoi-cell-display'); await change('show-voronoi-cell', true, { checkbox: true });
    await waitFor('voronoiChecks.geometry()!==null', 'selected cell before frame change');
    await change('frame-slider', '1', { event: 'input' });
    await waitFor('document.getElementById("voronoi-state").textContent==="Calculated" && voronoiChecks.renderer.frame.timestep===18', 'next-frame tessellation');
    await waitFor('voronoiChecks.geometry()!==null', 'next-frame selected cell');
    const nextFrameResult = await result();
    assert.ok(nextFrameResult.atomicVolume.some((value, index) => Math.abs(value - cpuResult.atomicVolume[index]) > .001));
    await load('open-voronoi.xyz', 2); await run();
    assert.equal(await evaluate('voronoiChecks.geometry()'), null, 'loading a new source clears the previous selection geometry');
    const open = await result(); close(open.atomicVolume, [.5, .5], 1e-8);
    assert.deepEqual(open.voronoiBoundaryFaces, [5, 5]);
    assert.ok(await evaluate('document.querySelector("[data-voronoi-stat=boundary]").textContent.includes("2")'));
    console.log('Voronoi UI: cancel, late results, frame/source transitions and finite-domain cells passed.');

    // A binary SC crystal becomes FCC after either checkerboard element is
    // removed from both the centers and the neighbor search. A display-only
    // filter would leave volume 8 and CN 6 rather than volume 16 and CN 12.
    await load('binary-voronoi.xyz', 8); await run();
    const binaryFull = await result(); close(binaryFull.atomicVolume, Array(8).fill(8), 1e-9);
    assert.deepEqual(binaryFull.voronoiCoordination, Array(8).fill(6));
    await change('show-voronoi-cell', false, { checkbox: true });
    await expand('#voronoi-cell-display');
    assert.equal(await evaluate('document.getElementById("show-all-voronoi-cells").checked'), false);
    const withoutAll = await pixels();
    await evaluate('voronoiChecks.holdKind="voronoiGeometryBatch"');
    await change('show-all-voronoi-cells', true, { checkbox: true });
    await waitFor('voronoiChecks.held?.kind==="voronoiGeometryBatch"', 'hold an active all-cell display request');
    await change('show-all-voronoi-cells', false, { checkbox: true });
    assert.equal(await evaluate('voronoiChecks.held.signal.aborted'), true, 'turning all-cell display off aborts its pending extraction');
    await evaluate('voronoiChecks.release()'); await delay(120);
    assert.equal(await evaluate('voronoiChecks.allGeometry()'), null, 'late all-cell extraction cannot restore canceled display geometry');
    await change('show-all-voronoi-cells', true, { checkbox: true });
    await waitFor('voronoiChecks.allGeometry()?.cellCount===8 && voronoiChecks.allGeometry()?.complete', 'all binary-crystal cell meshes');
    assert.deepEqual((await evaluate('voronoiChecks.allGeometry()')).atomIndices, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(await evaluate('voronoiChecks.renderer.voronoiAllCellLayer.cellCount'), 8);
    assert.notEqual((await pixels()).hash, withoutAll.hash, 'all-cell drawing changes real viewport pixels');
    const allPng = await download('#export-png');
    await change('show-all-voronoi-cells', false, { checkbox: true });
    assert.notEqual((await download('#export-png')).hash, allPng.hash, 'PNG includes all requested cell faces and edges');
    await change('show-all-voronoi-cells', true, { checkbox: true });
    await waitFor('voronoiChecks.allGeometry()?.cellCount===8', 're-enable all binary cells');
    await pointerPick();
    await evaluate('voronoiChecks.saveAllGeometry()');
    await expand('#voronoi-type-selection'); await press('[data-voronoi-type="Cu"]');
    await waitFor('document.getElementById("voronoi-state").textContent==="Calculated" && voronoiChecks.renderer.frame.atomeyeResults?.voronoi?.result.selectedTypes?.join(",")==="Ni"', 'Ni-only CPU tessellation');
    const niIndices = [0, 3, 5, 6], niCpu = await result();
    assert.equal(niCpu.backend, 'cpu'); assert.deepEqual(niCpu.analyzedAtomIndices, niIndices);
    close(niIndices.map(index => niCpu.atomicVolume[index]), Array(4).fill(16), 1e-9);
    assert.ok(niIndices.every(index => niCpu.voronoiCoordination[index] === 12 && niCpu.voronoiIndices[index] === '<0,12,0,0>'));
    assert.equal(niCpu.summary.atomCount, 4); close([niCpu.summary.totalVolume], [64], 1e-9);
    assert.equal(await evaluate('(() => {const r=voronoiChecks.renderer.frame.atomeyeResults.voronoi.result;return [1,2,4,7].every(atom=>["atomicVolume","voronoiSurfaceArea","voronoiCoordination","voronoiBoundaryFaces","voronoiMaxFaceOrder"].every(name=>Number.isNaN(r[name][atom])) && r.faceOffsets[atom]===r.faceOffsets[atom+1]);})()'), true, 'excluded atoms have NaN fields and no central faces');
    assert.ok(niCpu.faceNeighbors.every(index => niIndices.includes(index)), 'excluded Cu sites are absent from the neighbor tessellation');
    await waitFor('voronoiChecks.allGeometry()?.cellCount===4', 'Ni-only cell mesh replaces all-site mesh');
    assert.equal(await evaluate('voronoiChecks.allGeometryChanged()'), true, 'changing scientific selection invalidates the complete mesh cache');
    assert.deepEqual((await evaluate('voronoiChecks.allGeometry()')).atomIndices, niIndices);
    const niCsv = await download('#export-voronoi-csv');
    const niRows = niCsv.text.trim().split(/\r?\n/).slice(1);
    assert.equal(niRows.length, 4); assert.ok(niRows.every(row => row.includes(',Ni,')), 'atom CSV exports only tessellated element sites');
    await run({ gpu: true });
    const niGpu = await result(); assert.deepEqual(niGpu.analyzedAtomIndices, niIndices);
    close(niIndices.map(index => niGpu.atomicVolume[index]), niIndices.map(index => niCpu.atomicVolume[index]), 2e-5);
    assert.deepEqual(niGpu.voronoiCoordination, niCpu.voronoiCoordination);
    assert.deepEqual(niGpu.voronoiIndices, niCpu.voronoiIndices);
    await waitFor('voronoiChecks.allGeometry()?.cellCount===4', 'Ni-only GPU results and native display mesh');

    await evaluate('voronoiChecks.saveSource();voronoiChecks.saveAllGeometry()');
    await showTool('replicate'); await change('replicate-a', '2'); await press('#apply-replicate');
    await waitFor('voronoiChecks.renderer.repetitions[0]===2', 'replicate all Ni cells in display'); await pixels();
    assert.equal(await evaluate('voronoiChecks.renderer.voronoiAllCellLayer.renderedReplicaCount'), 2);
    assert.equal(await evaluate('voronoiChecks.sourceUnchanged()'), true, 'all-cell display copies leave subset scientific results unchanged');
    assert.equal(await evaluate('voronoiChecks.allGeometryChanged()'), false, 'display copies reuse the same complete scientific mesh');
    await pointerPick([1, 0, 0]);
    await showTool('display'); await change('compare-view', true, { checkbox: true });
    await waitFor('voronoiChecks.allGeometry("comparison")?.cellCount===4', 'comparison view displays all selected-element cells');
    const allSecond = await pixels('comparison');
    await showTool('voronoi'); await change('show-all-voronoi-cells', false, { checkbox: true });
    assert.notEqual((await pixels('comparison')).hash, allSecond.hash, 'all-cell switch changes the second-view pixels');
    await change('show-all-voronoi-cells', true, { checkbox: true });
    await showTool('display'); await change('compare-view', false, { checkbox: true });
    await showTool('replicate'); await press('#reset-replicate');

    await showTool('selectionGroups'); await press('#add-selection-group');
    await expand('#selection-group-settings .selection-group-members'); await change('selection-group-operation', 'replace');
    await change('selection-group-ids', niIndices.map(index => 101 + index).join(' '), { event: 'input' }); await press('#apply-selection-group-ids');
    await press('#toggle-selection-group-visibility');
    const hiddenAllOn = await pixels();
    await showTool('voronoi'); await change('show-all-voronoi-cells', false, { checkbox: true });
    assert.deepEqual(await pixels(), hiddenAllOn, 'hidden owners suppress all their cell faces and edges');
    await change('show-all-voronoi-cells', true, { checkbox: true });
    await showTool('selectionGroups'); await press('#toggle-selection-group-visibility');
    await showTool('slice'); await press('#add-slice'); await change('slice-offset', '-1000'); await change('slice-show-gizmo', false, { checkbox: true });
    const slicedAllOn = await pixels();
    await showTool('voronoi'); await change('show-all-voronoi-cells', false, { checkbox: true });
    assert.deepEqual(await pixels(), slicedAllOn, 'sliced-out cells leave no displayed faces or edges');
    await change('show-all-voronoi-cells', true, { checkbox: true });
    await showTool('slice'); await press('#delete-slice');

    await showTool('voronoi'); await evaluate('voronoiChecks.saveAllGeometry()');
    await change('frame-slider', '1', { event: 'input' });
    await waitFor('voronoiChecks.renderer.frame.timestep===24 && document.getElementById("voronoi-state").textContent==="Calculated"', 'selected element survives reordered frame labels');
    const niReordered = await result(), reorderedIndices = [1, 2, 4, 7];
    assert.deepEqual(niReordered.selectedTypes, ['Ni']); assert.deepEqual(niReordered.analyzedAtomIndices, reorderedIndices);
    close(reorderedIndices.map(index => niReordered.atomicVolume[index]), Array(4).fill(16), 2e-5);
    await waitFor('voronoiChecks.allGeometry()?.atomIndices.join(",")==="1,2,4,7"', 'frame change rebuilds all cells with original source indices');
    assert.equal(await evaluate('voronoiChecks.allGeometryChanged()'), true);
    assert.equal(await evaluate('document.querySelector("[data-voronoi-type=Ni]").checked && !document.querySelector("[data-voronoi-type=Cu]").checked'), true);
    const subsetRecipe = JSON.parse((await download('#export-configuration')).text);
    assert.deepEqual(subsetRecipe.settings.extensions.voronoi.selectedTypes, ['Ni']);
    assert.equal(subsetRecipe.settings.extensions.voronoiDisplay.allEnabled, true);
    await writeFile(resolve(fixtures, 'voronoi-subset-recipe.json'), JSON.stringify(subsetRecipe));
    await press('#close-file'); await inputFile('#configuration-file', 'voronoi-subset-recipe.json');
    await waitFor('document.getElementById("configuration-status").textContent.includes("Waiting for source files")', 'subset recipe waits for original source');
    await load('binary-voronoi.xyz', 8);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && voronoiChecks.allGeometry()?.atomIndices.join(",")==="1,2,4,7"', 'recipe restores selected types, saved frame and all-cell mesh');
    assert.equal(await evaluate('document.getElementById("show-all-voronoi-cells").checked'), true);
    await showTool('voronoi'); await expand('#voronoi-type-selection'); await press('#voronoi-clear-types');
    await waitFor('voronoiChecks.allGeometry()===null && document.getElementById("voronoi-results").hidden', 'empty element selection clears previous results and cells');
    assert.equal(await evaluate('document.getElementById("export-voronoi-csv").disabled'), true);
    await press('#voronoi-select-all-types');
    await waitFor('document.getElementById("voronoi-state").textContent==="Calculated" && voronoiChecks.allGeometry()?.cellCount===8', 'select all recovers full SC tessellation');
    close((await result()).atomicVolume, Array(8).fill(8), 2e-5);
    await change('show-all-voronoi-cells', false, { checkbox: true });
    console.log('Voronoi UI: true CPU/GPU element subsets, all-cell rendering, cache/frame lifecycle, CSV and recipe replay passed.');

    await load('ideal-fcc.xyz', 32); await run({ gpu: true });
    const ideal = await result(); close(ideal.atomicVolume, Array(32).fill(16), 2e-5);
    const idealColorCount = await evaluate('(() => {const r=voronoiChecks.renderer;return new Set(Array.from({length:r.atomCount},(_unused,index)=>Array.from(r.atomColors.subarray(index*3,index*3+3)).join(","))).size;})()');
    assert.equal(idealColorCount, 1, 'ideal FCC volumes have one Auto color despite GPU arithmetic roundoff');

    // The Wigner–Seitz cell of a periodic site at the origin extends outside
    // the displayed simulation box. Camera near/far bounds must include it.
    await load('origin-sc.xyz', 1); await run({ gpu: true });
    await showTool('display'); await change('radius-percent', '35', { event: 'input' });
    await evaluate('voronoiChecks.renderer.setView("front");voronoiChecks.renderer.setProjection("orthographic");voronoiChecks.renderer.resetCamera()');
    await pointerPick(); await showTool('voronoi'); await expand('#voronoi-cell-display');
    await change('show-voronoi-cell', true, { checkbox: true });
    await waitFor('voronoiChecks.geometry()!==null', 'periodic origin cell');
    assert.equal(await evaluate('voronoiChecks.renderer.sceneBounds.minimum.every(value=>value<=-1+1e-7)'), true, 'camera bounds include cell faces beyond the simulation-box origin');
    await pixels(); assert.equal(await evaluate('voronoiChecks.renderer.voronoiCellLayer.renderedReplicaCount'), 1);
    await load('wall-voronoi.xyz', 1); await run();
    const wallResult = await result(); close(wallResult.atomicVolume, [8], 1e-9);
    assert.deepEqual(wallResult.voronoiBoundaryFaces, [6]);
    await change('show-voronoi-cell', false, { checkbox: true });
    await evaluate('voronoiChecks.renderer.setView("front");voronoiChecks.renderer.setProjection("orthographic");voronoiChecks.renderer.resetCamera()');
    await pointerPick(); await showTool('voronoi'); await expand('#voronoi-cell-display');
    const bareWall = await pixels();
    await change('show-voronoi-cell', true, { checkbox: true });
    await waitFor('voronoiChecks.geometry()!==null', 'cell preview for an atom exactly on a nonperiodic wall');
    const wallGeometry = await evaluate('voronoiChecks.geometry()');
    const wallMesh = await evaluate('voronoiChecks.mesh()');
    const interior = [0, 0, 0];
    wallGeometry.vertices.forEach((value, index) => { interior[index % 3] += value / (wallGeometry.vertices.length / 3); });
    for (let triangle = 0; triangle < wallMesh.indices.length; triangle += 3) {
      const corners = wallMesh.indices.slice(triangle, triangle + 3).map(index => wallMesh.values.slice(index * 6, index * 6 + 3));
      const ab = corners[1].map((value, axis) => value - corners[0][axis]);
      const ac = corners[2].map((value, axis) => value - corners[0][axis]);
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const outward = corners[0].map((value, axis) => value - interior[axis]);
      assert.ok(cross.reduce((sum, value, axis) => sum + value * outward[axis], 0) > 0, 'built preview triangles wind away from their centroid at a nonperiodic wall');
      for (const index of wallMesh.indices.slice(triangle, triangle + 3)) {
        const normal = wallMesh.values.slice(index * 6 + 3, index * 6 + 6);
        assert.ok(normal.reduce((sum, value, axis) => sum + value * outward[axis], 0) > 0, 'built wall-cell normals point outward');
      }
    }
    assert.notEqual((await pixels()).hash, bareWall.hash, 'the wall atom cell reaches viewport pixels');
    console.log('Voronoi UI: nonperiodic wall-cell preview has outward normals and winding.');
    await load('ideal-fcc.xyz', 32); await run({ gpu: true });

    mobile = true;
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 640, deviceScaleFactor: 1, mobile });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true });
    await showTool('voronoi'); await press('#voronoi-color-coordination');
    await expand('#voronoi-cell-display');
    const phoneBare = await pixels();
    await press('#show-all-voronoi-cells');
    await waitFor('voronoiChecks.allGeometry()?.cellCount===32 && voronoiChecks.allGeometry()?.complete', 'phone enables all analyzed cell meshes');
    assert.notEqual((await pixels()).hash, phoneBare.hash, 'touch-enabled all-cell switch updates phone viewport');
    await press('#show-all-voronoi-cells');
    await expand('#voronoi-type-selection');
    assert.equal(await evaluate('document.querySelector("[data-voronoi-type=Ni]").checked'), true, 'phone type choices agree with the restored all-site analysis');
    await expand('#voronoi-distributions');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true, 'result cards and interactive charts fit the phone');
    await press('#voronoi-coordination-chart .chart-modes button:last-child');
    const phoneScreenshot = await screenshot('voronoi-390x640.png');
    const viewport = await evaluate('(() => {const box=document.getElementById("viewport").getBoundingClientRect();return{top:box.top,bottom:box.bottom,height:box.height};})()');
    assert.ok(viewport.top >= 0 && viewport.bottom <= 640 && viewport.height > 100, 'tool scrolling retains the phone viewport');
    await press('#cancel-voronoi'); await evaluate('document.getElementById("close-file").click()');
    assert.equal(await evaluate('voronoiChecks.geometry()'), null);
    return { adapter, computation: ['parallel CPU/Wasm', 'WebGPU'], rendering: 'SwiftShader validation only',
      atoms: positions.length, cpuMs: cpuResult.elapsedMs, gpuMs: gpuResult.elapsedMs,
      cpuWorkers: cpuResult.workerCount, gpuEngine: gpuResult.engine,
      idealColorCount, previewRecipeRestored: true, wallCellOutward: true,
      trueElementSubsets: true, allCellDrawing: true, subsetRecipeRestored: true,
      maximumVolumeDifference: Math.max(...gpuResult.atomicVolume.map((value, index) => Math.abs(value - cpuResult.atomicVolume[index]))),
      screenshots: [desktopScreenshot, phoneScreenshot], artifacts };
  }, { software: true });
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(fixtures, { recursive: true, force: true }); }

function close(actual, expected, tolerance) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Number.isFinite(value)
    && Math.abs(value - expected[index]) <= tolerance * Math.max(1, Math.abs(expected[index])),
  `${value} differs from ${expected[index]}`));
}

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const [{ WebGLRenderer }, { AnalysisPool }, { transformPoint }, { createVoronoiCellMesh }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)),
    import(new URL('./render/math.js', app)),
    import(new URL('./render/voronoi-cell-layer.js', app)),
  ]);
  const checks = window.voronoiChecks = { history: [], download: null, holdKind: null, held: null };
  const setFrame = WebGLRenderer.prototype.setFrame, analyze = AnalysisPool.prototype.analyze,
    analyzeCPU = AnalysisPool.prototype.analyzeCPU;
  WebGLRenderer.prototype.setFrame = function(...args) {
    checks[this.canvas.id === 'viewport' ? 'renderer' : 'comparison'] = this;
    return setFrame.apply(this, args);
  };
  AnalysisPool.prototype.analyze = async function(frame, parameters, options) {
    const entry = { frame, kind: parameters.kind, parameters, signal: options?.signal };
    checks.history.push(entry);
    const hold = checks.holdKind === parameters.kind; if (hold) checks.holdKind = null;
    const result = await analyze.call(this, frame, parameters, options); entry.result = result;
    if (hold) { checks.held = entry; await new Promise(resolve => { checks.release = () => { checks.held = null; resolve(); }; }); }
    return result;
  };
  // A single inspected cell intentionally uses the resident CPU engine even
  // after full analysis on GPU. This is separate from whole-frame dispatch.
  AnalysisPool.prototype.analyzeCPU = async function(frame, parameters, options) {
    if (!['voronoiGeometry', 'voronoiGeometryBatch'].includes(parameters.kind)) return analyzeCPU.call(this, frame, parameters, options);
    const entry = { frame, kind: parameters.kind, parameters, signal: options?.signal };
    checks.history.push(entry);
    const hold = checks.holdKind === parameters.kind; if (hold) checks.holdKind = null;
    const result = await analyzeCPU.call(this, frame, parameters, options); entry.result = result;
    if (hold) { checks.held = entry; await new Promise(resolve => { checks.release = () => { checks.held = null; resolve(); }; }); }
    return result;
  };
  const plain = value => JSON.parse(JSON.stringify(value, (_key, item) => ArrayBuffer.isView(item) ? Array.from(item) : item));
  checks.result = () => plain(checks.renderer.frame.atomeyeResults.voronoi.result);
  // Renderer-selected geometry is a scientific local-offset polyhedron. It
  // must be available to both the main viewport and comparison view.
  checks.geometry = (kind = 'renderer') => plain(checks[kind]?.voronoiCellGeometry ?? null);
  checks.mesh = () => plain(createVoronoiCellMesh(checks.renderer.voronoiCellGeometry));
  checks.allGeometry = (kind = 'renderer') => {
    const geometry = checks[kind]?.voronoiAllCellGeometry;
    if (!geometry) return null;
    return { cellCount: geometry.cellCount, complete: Boolean(geometry.complete), chunks: geometry.chunks.length,
      atomIndices: [...new Set(geometry.chunks.flatMap(chunk => Array.from(chunk.cellRanges).filter((_, index) => index % 5 === 0)))].sort((a, b) => a - b) };
  };
  checks.saveAllGeometry = () => { checks.previousAllGeometry = checks.renderer.voronoiAllCellGeometry; };
  checks.allGeometryChanged = () => checks.previousAllGeometry !== checks.renderer.voronoiAllCellGeometry;
  checks.pickablePoint = (requestedReplica = null) => {
    const r = checks.renderer; r.updateMatrices(); const box = r.canvas.getBoundingClientRect();
    const replicas = r.replicas.filter(replica => !requestedReplica || replica.indices.every((value, axis) => value === requestedReplica[axis]));
    for (const replica of replicas) for (let index = r.atomCount - 1; index >= 0; index--) {
      if (!r.isAtomVisible(index, replica.indices)) continue;
      const p = transformPoint(r.viewProjectionMatrix, ...Array.from(r.displayPositions.slice(index * 3, index * 3 + 3), (value, axis) => value + replica.offset[axis]));
      const x = box.left + (p[0] / p[3] * .5 + .5) * box.width, y = box.top + (.5 - p[1] / p[3] * .5) * box.height;
      const hit = document.elementFromPoint(x, y);
      if (x <= box.left || x >= box.right || y <= box.top || y >= box.bottom || hit !== r.canvas || r.pick(x, y) !== index) continue;
      if (requestedReplica && !r.lastPick.replica.every((value, axis) => value === requestedReplica[axis])) continue;
      return { x, y, index, id: r.frame.ids[index], replica: replica.indices };
    }
    return null;
  };
  checks.saveSource = () => {
    const f = checks.renderer.frame;
    checks.source = { frame: f, fractional: f.fractional, positions: f.positions, result: f.atomeyeResults.voronoi.result,
      fractionalValues: Array.from(f.fractional), positionsValues: Array.from(f.positions),
      volumeValues: Array.from(f.atomeyeResults.voronoi.result.atomicVolume),
      fullJobs: checks.history.filter(entry => entry.kind === 'voronoi').length };
  };
  checks.sourceUnchanged = () => {
    const f = checks.renderer.frame, s = checks.source;
    const equal = (first, second) => first.length === second.length && first.every((value, index) => Object.is(value, second[index]));
    return f === s.frame && f.fractional === s.fractional && f.positions === s.positions
      && f.atomeyeResults.voronoi.result === s.result
      && equal(Array.from(f.fractional), s.fractionalValues) && equal(Array.from(f.positions), s.positionsValues)
      && equal(Array.from(f.atomeyeResults.voronoi.result.atomicVolume), s.volumeValues)
      && checks.history.filter(entry => entry.kind === 'voronoi').length === s.fullJobs;
  };
  const pixelValues = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const pixelSummary = values => {
    let opaque = 0, hash = 2166136261;
    for (let index = 0; index < values.length; index++) { hash = Math.imul(hash ^ values[index], 16777619); if (index % 4 === 3 && values[index]) opaque++; }
    return { opaque, hash: hash >>> 0 };
  };
  checks.pixels = (kind = 'renderer') => {
    const canvas = checks[kind].captureImage({ includeBackground: false });
    return { ...pixelSummary(pixelValues(canvas)), width: canvas.width, height: canvas.height };
  };
  checks.beginDownload = () => {
    const urls = new Map(), create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    checks.download = null;
    URL.createObjectURL = function(blob) { const url = create.call(this, blob); urls.set(url, blob); return url; };
    HTMLAnchorElement.prototype.click = function() { const blob = urls.get(this.href); if (blob) checks.download = { blob, filename: this.download }; };
    checks.restoreDownload = () => { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; };
  };
  checks.finishDownload = async () => {
    try {
      const { blob, filename } = checks.download;
      if (blob.type === 'image/png') {
        const image = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0); image.close();
        return { filename, type: blob.type, ...pixelSummary(pixelValues(canvas)), bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
      }
      return { filename, type: blob.type, text: await blob.text() };
    } finally { checks.restoreDownload(); checks.download = null; }
  };
}
