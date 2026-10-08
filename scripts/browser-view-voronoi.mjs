import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';
import { DEFAULT_EXPORT_RESOLUTION } from '../src/render/export-resolution.js';

// Small real CPU tessellations isolate display/camera regressions; the real
// HEA example checks selected-only cells. SwiftShader validates graphics
// without making a hardware performance claim.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const fixtures = await mkdtemp(resolve(tmpdir(), 'alloyview-floating-voronoi-'));
const artifacts = resolve(tmpdir(), 'alloyview-floating-voronoi');
await mkdir(artifacts, { recursive: true });
const atoms = [];
for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
  for (const basis of [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]]) atoms.push(basis.map((value, axis) => 4 * (value + [a, b, c][axis])));
}
function xyz(points, length = 8) {
  return [String(points.length), `Lattice="${length} 0 0 0 ${length} 0 0 0 ${length}" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1`,
    ...points.map((point, index) => `Ni ${point.join(' ')} ${101 + index}`), ''].join('\n');
}
await Promise.all([
  writeFile(resolve(fixtures, 'floating-voronoi.xyz'), xyz(atoms)),
  writeFile(resolve(fixtures, 'slice-highlights.xyz'), xyz([[2, 2, 2], [6, 2, 2], [2, 6, 2], [4, 2, 2], [7, 7, 7], [7, 3, 5]], 10)),
]);

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
    let mobile = false;
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeout = 60_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(35); }
      throw new Error(`${label}: ${JSON.stringify(await evaluate('({file:document.getElementById("file-name")?.textContent,voronoi:document.getElementById("voronoi-state")?.textContent,cells:document.getElementById("voronoi-all-cells-status")?.textContent,configuration:document.getElementById("configuration-status")?.textContent,toast:document.getElementById("toast")?.textContent,exportCapture:floatingChecks?.lastExportCapture?.kind,pointerEvents:floatingChecks?.pointerEvents?.slice(-8)})'))}`);
    }
    await waitFor('document.readyState==="complete" && document.getElementById("voronoi-radius-percent")', 'updated production display controls');
    await evaluate(`(${initializeChecks.toString()})()`);
    async function point(selector, { left = false } = {}) {
      const p = await evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest',inline:'nearest'});const box=node.getBoundingClientRect(),x=box.left+${left ? '12' : 'box.width/2'},y=box.top+box.height/2,hit=document.elementFromPoint(x,y);return{x,y,enabled:!node.disabled,reachable:node===hit||node.contains(hit),hit:hit?.id};})()`);
      assert.ok(p.enabled && p.reachable, `${selector}: ${JSON.stringify(p)}`); return p;
    }
    async function tap(p) {
      if (mobile) {
        await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: p.x, y: p.y }] });
        await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
      }
      await delay(50);
    }
    async function press(selector) { await tap(await point(selector)); }
    async function drag(start, end, button = 'left') {
      const buttons = button === 'right' ? 2 : 1;
      if (mobile) await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: start.x, y: start.y }] });
      else await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button, buttons, clickCount: 1 });
      for (let step = 1; step <= 6; step++) {
        const p = { x: start.x + (end.x - start.x) * step / 6, y: start.y + (end.y - start.y) * step / 6 };
        if (mobile) await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, ...p }] });
        else await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button, buttons });
        await delay(18);
      }
      if (mobile) await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      else await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button, buttons: 0, clickCount: 1 });
      await delay(80);
    }
    async function change(id, value, { checkbox = false, event = 'change' } = {}) {
      await evaluate(`(() => {const field=document.getElementById(${JSON.stringify(id)});if(!field)throw new Error('Missing '+${JSON.stringify(id)});${checkbox ? 'field.checked' : 'field.value'}=${JSON.stringify(value)};field.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
      await delay(45);
    }
    async function showTool(name) {
      const category = await evaluate(`document.querySelector('[data-tool-button="${name}"]').closest('[data-tool-category-panel]').dataset.toolCategoryPanel`);
      if (await evaluate(`document.getElementById('tool-category-${category}').getAttribute('aria-selected')!=='true'`)) await press(`#tool-category-${category}`);
      if (await evaluate(`document.querySelector('[data-tool-button="${name}"]').getAttribute('aria-expanded')!=='true'`)) await press(`[data-tool-button="${name}"]`);
    }
    async function expand(selector) { if (await evaluate(`!document.querySelector(${JSON.stringify(selector)}).open`)) await press(`${selector}>summary`); }
    async function file(selector, filename) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector });
      await call('DOM.setFileInputFiles', { nodeId, files: [resolve(fixtures, filename)] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function load(filename, count, { sourcePath = filename } = {}) {
      await file('#file-input', sourcePath);
      await waitFor(`document.getElementById('file-name').textContent===${JSON.stringify(filename)} && document.getElementById('loading').hidden && floatingChecks.renderer?.atomCount===${count}`, `load ${filename}`);
    }
    async function pick(index = null, { comparison = false, replica = null, slice = false } = {}) {
      const p = await evaluate(`floatingChecks.pickPoint(${index},${JSON.stringify(comparison ? 'comparison' : 'renderer')},${JSON.stringify(replica)})`);
      assert.ok(p, `atom ${index ?? 'any'} in ${comparison ? 'comparison' : 'main'} ${JSON.stringify(replica)} is reachable`);
      await tap({ x: p.x, y: p.y });
      await waitFor(slice ? `document.getElementById('slice-pick-help').textContent.includes(${JSON.stringify(String(p.id))})`
        : `floatingChecks.renderer.selected===${p.index}`, 'actual atom pointer pick');
      return p;
    }
    async function screenshot(name) {
      const capture = await call('Page.captureScreenshot', { format: 'png' });
      const path = resolve(artifacts, name); await writeFile(path, Buffer.from(capture.data, 'base64')); return path;
    }
    async function download(selector) {
      await evaluate('floatingChecks.beginDownload()'); await press(selector);
      await waitFor('floatingChecks.download!==null', selector);
      return evaluate('floatingChecks.finishDownload()');
    }
    const pixels = (kind = 'renderer') => evaluate(`floatingChecks.pixels(${JSON.stringify(kind)})`);
    const camera = (kind = 'renderer') => evaluate(`floatingChecks[${JSON.stringify(kind)}].getCameraState()`);
    const boxes = () => evaluate('floatingChecks.boxes()');
    const allReady = () => waitFor('floatingChecks.renderer.voronoiAllCellGeometry?.complete && floatingChecks.renderer.voronoiAllCellGeometry.cellCount===32', 'complete all-cell display');
    await evaluate('if(document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true")document.getElementById("enable-gpu-computing").click()');
    await load('floating-voronoi.xyz', 32); await showTool('voronoi');
    assert.equal(await evaluate('document.getElementById("voronoi-cell-color").value.toLowerCase()'), '#3b82f6');
    near(Number(await evaluate('document.getElementById("voronoi-cell-opacity").value')), .5);
    await press('#run-voronoi'); await waitFor('document.getElementById("voronoi-state").textContent==="Calculated"', 'real CPU tessellation');
    assert.equal(await evaluate('floatingChecks.renderer.frame.atomeyeResults.voronoi.result.backend'), 'cpu');
    await expand('#voronoi-cell-display');
    await change('voronoi-radius-scale', '60', { event: 'input' });
    near(await evaluate('floatingChecks.renderer.radiusScale'), .6);
    assert.equal(await evaluate('document.getElementById("radius-percent").value'), '60');
    assert.equal(await evaluate('document.getElementById("voronoi-radius-percent").value'), '60');
    await showTool('display'); await change('radius-percent', '125', { event: 'input' });
    assert.equal(await evaluate('document.getElementById("voronoi-radius-scale").value'), '125');
    assert.equal(await evaluate('document.getElementById("voronoi-radius-percent").value'), '125');
    await showTool('voronoi'); await change('voronoi-radius-percent', '25', { event: 'input' });
    near(await evaluate('floatingChecks.renderer.radiusScale'), .25);
    assert.equal(await evaluate('document.getElementById("radius-scale").value'), '25');
    await change('show-voronoi-cell', false, { checkbox: true });
    await change('show-all-voronoi-cells', true, { checkbox: true }); await allReady();
    await evaluate('floatingChecks.renderer.setView("front");floatingChecks.renderer.setProjection("orthographic");floatingChecks.renderer.resetCamera()');
    await showTool('display'); await change('show-cell', false, { checkbox: true });
    for (const id of ['png-background', 'png-legend', 'png-axes']) await change(id, false, { checkbox: true });
    await evaluate('floatingChecks.saveScience()');
    const beforeSelection = await pixels();
    assert.ok(beforeSelection.blue > 100, 'default shaded Voronoi faces are visibly blue');
    const selected = await pick();
    const afterSelection = await pixels();
    assert.equal(await evaluate('floatingChecks.renderer.voronoiAllCellLayer.highlightedCellCount'), 1);
    assert.equal(await evaluate('floatingChecks.renderer.voronoiAllCellLayer.renderedHighlightReplicaCount'), 1);
    assert.ok(afterSelection.orange > beforeSelection.orange, 'selected all-cell polygon gains contrasting highlighted pixels');
    assert.ok(afterSelection.paleEdges > 0, 'all-cell outlines have visible light pixels');
    assert.equal(await evaluate('document.getElementById("show-voronoi-cell").checked'), false, 'all-cell selection highlighting works with single-cell inspection off');
    assert.equal(await evaluate('floatingChecks.scienceUnchanged()'), true, 'radius and selection preserve completed analysis');
    console.log('Floating Voronoi: default blue faces, shared atom radii and all-cell selection highlighting passed.');

    await showTool('display'); await change('compare-view', true, { checkbox: true });
    await waitFor('floatingChecks.comparison?.frame && !document.getElementById("comparison-view").hidden', 'floating second view');
    // Details starts folded; open it to check the default layout against its full panel.
    await evaluate('if(document.getElementById("toggle-atom-details").getAttribute("aria-expanded")!=="true")document.getElementById("toggle-atom-details").click()');
    let b = await boxes(); assertContained(b.panel, b.viewport);
    assert.equal(intersects(b.panel, b.details), false, 'default second view avoids the open Details panel');
    const defaultScreenshot = await screenshot('voronoi-floating-default.png');
    const firstCamera = await camera('comparison'), untouchedMain = await camera();
    let handle = await point('#comparison-drag-handle', { left: true });
    await drag({ x: handle.x, y: handle.y }, { x: handle.x + 100, y: handle.y + 70 });
    let moved = await boxes(); assert.ok(moved.panel.x > b.panel.x + 60 && moved.panel.y > b.panel.y + 40);
    assertCamera(await camera('comparison'), firstCamera);
    b = moved; handle = await point('#comparison-resize-handle');
    await drag({ x: handle.x, y: handle.y }, { x: handle.x + 80, y: handle.y + 65 });
    moved = await boxes(); assert.ok(moved.panel.width > b.panel.width + 40 && moved.panel.height > b.panel.height + 35);
    assertContained(moved.panel, moved.viewport);
    await waitFor('floatingChecks.comparison.canvas.width===Math.round(floatingChecks.comparison.canvas.clientWidth)', 'resized comparison render buffer');
    let p = await point('#comparison-view canvas');
    await drag({ x: p.x, y: p.y }, { x: p.x + 25, y: p.y + 12 });
    const afterOrbit = await camera('comparison'); assert.notDeepEqual(afterOrbit.direction, firstCamera.direction);
    await drag({ x: p.x, y: p.y }, { x: p.x + 18, y: p.y + 8 }, 'right');
    assert.notDeepEqual((await camera('comparison')).center, afterOrbit.center);
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: -140 }); await delay(100);
    assertCamera(await camera(), untouchedMain);
    await press('[data-compare-projection="perspective"]');
    await evaluate('floatingChecks.comparison.setCameraState({constrainUp:false,roll:.61,fov:.78})');
    let secondCamera = await camera('comparison');
    const ownPng = await download('#export-comparison-png');
    assert.equal(ownPng.type, 'image/png');
    await writeFile(resolve(artifacts, 'comparison.png'), Buffer.from(ownPng.bytes));
    const comparisonPixels = await evaluate('floatingChecks.encodedPixels("comparison")');
    assert.equal(ownPng.width, comparisonPixels.width); assert.equal(ownPng.height, comparisonPixels.height);
    assert.equal(ownPng.capture.kind, 'comparison');
    assert.deepEqual(ownPng.capture.options, { includeBackground: false, includeAxes: false, legend: null,
      resolution: DEFAULT_EXPORT_RESOLUTION });
    assertCamera(ownPng.capture.camera, secondCamera);
    assertCamera(await camera('comparison'), secondCamera);
    console.log(`Second-view PNG source comparison: ${JSON.stringify(ownPng.capture.encodingDiff)}`);
    assert.ok(ownPng.capture.encodingDiff.channels / (ownPng.width * ownPng.height * 4) < .005
      && ownPng.capture.encodingDiff.maxWeightedDelta <= 3, 'PNG pixels match its comparison capture within canvas readback rounding');
    // Chromium's GPU-to-CPU 2D readback can round a few channel values, also
    // reproducible on a static standalone 2D canvas. Compare the actual
    // exported canvas above and retain a separate unchanged-scene check.
    assert.ok(comparisonPixels.roundTrip.exportDiff / (ownPng.width * ownPng.height * 4) < .005, 'a fresh render retains the exported scene');
    console.log(`Second-view PNG: export source matched; cross-render differing channels ${comparisonPixels.roundTrip.exportDiff}, PNG roundtrip ${ownPng.capture.roundTripChannels}.`);
    await writeFile(resolve(artifacts, 'comparison.png'), Buffer.from(ownPng.bytes));
    await press('#apply-comparison-camera'); assertCamera(await camera(), secondCamera);
    await press('[data-compare-projection="orthographic"]');
    p = await point('#comparison-view canvas');
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: 95 }); await delay(100);
    secondCamera = await camera('comparison'); await press('#apply-comparison-camera'); assertCamera(await camera(), secondCamera);
    const beforePanelMove = await download('#export-comparison-png');
    handle = await point('#comparison-drag-handle', { left: true });
    await drag({ x: handle.x, y: handle.y }, { x: handle.x - 30, y: handle.y - 30 });
    const afterPanelMove = await download('#export-comparison-png');
    assertCamera(afterPanelMove.capture.camera, beforePanelMove.capture.camera);
    assert.equal(afterPanelMove.width, beforePanelMove.width); assert.equal(afterPanelMove.height, beforePanelMove.height);
    assert.ok(afterPanelMove.differenceFromPrevious / (afterPanelMove.width * afterPanelMove.height * 4) < .005, 'floating panel placement does not appear in its PNG');
    assert.equal(await evaluate('floatingChecks.scienceUnchanged()'), true);
    console.log('Floating Voronoi: drag/resize, independent orbit/pan/zoom, PNG and complete camera transfer passed.');

    await showTool('replicate'); await change('replicate-a', '2'); await press('#apply-replicate');
    await waitFor('floatingChecks.renderer.repetitions[0]===2', 'display copies');
    await evaluate('for(const r of [floatingChecks.renderer,floatingChecks.comparison]){r.setView("front");r.setProjection("orthographic");r.resetCamera()}');
    const replicaSelection = await pick(null, { comparison: true, replica: [1, 0, 0] });
    await pixels(); await pixels('comparison');
    assert.equal(await evaluate('floatingChecks.renderer.voronoiAllCellLayer.renderedHighlightReplicaCount'), 2);
    assert.equal(await evaluate('floatingChecks.comparison.voronoiAllCellLayer.renderedHighlightReplicaCount'), 2);
    const highlightedScreenshot = await screenshot('voronoi-selected-replicas.png');
    const highlightedPng = await download('#export-comparison-png');
    await press('#clear-selection');
    assert.notEqual((await download('#export-comparison-png')).hash, highlightedPng.hash, 'comparison PNG includes highlighted Voronoi polygons');
    await pick(replicaSelection.index, { comparison: true, replica: [1, 0, 0] });
    await showTool('selectionGroups'); await press('#add-selection-group'); await expand('#selection-group-settings .selection-group-members');
    await change('selection-group-operation', 'replace'); await change('selection-group-ids', String(replicaSelection.id), { event: 'input' });
    await press('#apply-selection-group-ids'); await press('#toggle-selection-group-visibility'); await pixels(); await pixels('comparison');
    assert.equal(await evaluate('floatingChecks.renderer.voronoiAllCellLayer.highlightedCellCount'), 0);
    assert.equal(await evaluate('floatingChecks.comparison.voronoiAllCellLayer.highlightedCellCount'), 0);
    await press('#toggle-selection-group-visibility');
    await showTool('slice'); await press('#add-slice'); await change('slice-offset', '-1000'); await change('slice-show-gizmo', false, { checkbox: true });
    await pixels(); await pixels('comparison');
    assert.equal(await evaluate('floatingChecks.renderer.voronoiAllCellLayer.highlightedCellCount'), 0);
    assert.equal(await evaluate('floatingChecks.comparison.voronoiAllCellLayer.highlightedCellCount'), 0);
    await press('#delete-slice'); await showTool('replicate'); await press('#reset-replicate');
    await evaluate('for(const r of [floatingChecks.renderer,floatingChecks.comparison])r.resetCamera()');
    assert.equal(await evaluate('floatingChecks.scienceUnchanged()'), true);
    const savedComparisonCamera = await camera('comparison');
    const recipe = JSON.parse((await download('#export-configuration')).text);
    assert.ok(recipe.settings.extensions.comparison.layout);
    assert.equal(recipe.settings.extensions.voronoiDisplay.color.toLowerCase(), '#3b82f6');
    near(recipe.settings.extensions.voronoiDisplay.opacity, .5);
    await writeFile(resolve(fixtures, 'floating-view-recipe.json'), JSON.stringify(recipe));
    await press('#close-file'); await file('#configuration-file', 'floating-view-recipe.json');
    await waitFor('document.getElementById("configuration-status").textContent.includes("Waiting for source files")', 'recipe requires matching local source');
    await load('floating-voronoi.xyz', 32);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && floatingChecks.comparison?.frame && floatingChecks.renderer.voronoiAllCellGeometry?.complete', 'camera/layout/polygon recipe restore');
    assertCamera(await camera('comparison'), savedComparisonCamera);
    const replayed = JSON.parse((await download('#export-configuration')).text);
    for (const key of ['left', 'top', 'width', 'height']) near(replayed.settings.extensions.comparison.layout[key], recipe.settings.extensions.comparison.layout[key], 2e-3);
    assert.equal(await evaluate('document.getElementById("voronoi-radius-percent").value'), '25');
    console.log('Floating Voronoi: replicated highlights, masks/slices and recipe restoration passed.');

    // A disabled floating window retains its edited layout and camera in the
    // recipe, including an export before the window is opened again.
    const hiddenCamera = await camera('comparison');
    await press('#comparison-view .comparison-close');
    const hiddenRecipe = JSON.parse((await download('#export-configuration')).text);
    assert.equal(hiddenRecipe.settings.extensions.comparison.enabled, false);
    assert.ok(hiddenRecipe.settings.extensions.comparison.layout);
    assert.ok(hiddenRecipe.settings.extensions.comparison.camera);
    await writeFile(resolve(fixtures, 'hidden-view-recipe.json'), JSON.stringify(hiddenRecipe));
    await press('#close-file'); await file('#configuration-file', 'hidden-view-recipe.json');
    await waitFor('document.getElementById("configuration-status").textContent.includes("Waiting for source files")', 'disabled-window recipe requires source');
    await load('floating-voronoi.xyz', 32);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && !document.getElementById("compare-view").checked', 'disabled-window recipe restore');
    const pendingRecipe = JSON.parse((await download('#export-configuration')).text);
    assert.deepEqual(pendingRecipe.settings.extensions.comparison.layout, hiddenRecipe.settings.extensions.comparison.layout);
    assert.deepEqual(pendingRecipe.settings.extensions.comparison.camera, hiddenRecipe.settings.extensions.comparison.camera);
    await showTool('display'); await change('compare-view', true, { checkbox: true });
    await waitFor('floatingChecks.comparison?.frame===floatingChecks.renderer.frame && !document.getElementById("comparison-view").hidden', 'reopen restored disabled window');
    await waitFor('floatingChecks.comparison.canvas.clientWidth>0 && floatingChecks.comparison.canvas.width===Math.round(floatingChecks.comparison.canvas.clientWidth) && floatingChecks.comparison.canvas.height===Math.round(floatingChecks.comparison.canvas.clientHeight)', 'restored floating window first render');
    assertCamera(await camera('comparison'), hiddenCamera);
    const reopenedRecipe = JSON.parse((await download('#export-configuration')).text);
    for (const key of ['left', 'top', 'width', 'height']) near(reopenedRecipe.settings.extensions.comparison.layout[key], hiddenRecipe.settings.extensions.comparison.layout[key], 2e-3);
    console.log('Floating Voronoi: closed-window recipe preserves pending camera/layout and restores on reopening.');

    mobile = true;
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 640, deviceScaleFactor: 1, mobile });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true }); await delay(120);
    b = await boxes(); assertContained(b.panel, b.viewport);
    // A restored user layout is allowed to overlap other floating controls.
    // Home resets the panel to its actual phone default before this assertion.
    await evaluate('document.getElementById("comparison-drag-handle").focus()');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    await delay(80); b = await boxes(); assertContained(b.panel, b.viewport);
    console.log(`Phone default boxes: ${JSON.stringify({ panel: b.panel, viewport: b.viewport, detailsToggle: b.detailToggle })}`);
    await screenshot('floating-view-phone-default.png');
    assert.equal(intersects(b.panel, b.detailToggle), false, 'phone default view leaves the folded Atom details toggle usable');
    handle = await point('#comparison-drag-handle', { left: true });
    await drag({ x: handle.x, y: handle.y }, { x: b.viewport.x + 20, y: b.viewport.y + 20 });
    b = await boxes(); assertContained(b.panel, b.viewport);
    handle = await point('#comparison-resize-handle');
    await drag({ x: handle.x, y: handle.y }, { x: b.viewport.right - 12, y: b.viewport.bottom - 12 });
    b = await boxes(); assertContained(b.panel, b.viewport);
    await evaluate('document.getElementById("comparison-resize-handle").focus()');
    for (const key of ['ArrowRight', 'ArrowDown']) {
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, modifiers: 8 });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, modifiers: 8 });
    }
    b = await boxes(); assertContained(b.panel, b.viewport);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true);
    const phonePng = await download('#export-comparison-png'); assert.ok(phonePng.width > 0 && phonePng.height > 0);
    await press('#apply-comparison-camera'); assertCamera(await camera(), await camera('comparison'));
    const phoneScreenshot = await screenshot('floating-view-390x640.png');
    console.log('Floating Voronoi: phone touch movement/resize, bounds, own PNG and camera application passed.');
    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile });
    await delay(80); await evaluate('document.getElementById("comparison-drag-handle").focus()');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    await delay(80); b = await boxes(); assertContained(b.panel, b.viewport);
    assert.equal(intersects(b.panel, b.detailToggle), false, '320px phone default also leaves Atom details usable');
    assert.ok((await download('#export-comparison-png')).width > 0, 'narrow titlebar PNG action is reachable');
    await press('#apply-comparison-camera'); assertCamera(await camera(), await camera('comparison'));
    const narrowScreenshot = await screenshot('floating-view-320x640.png');

    // Slice construction uses a dedicated highlight channel; its retained
    // three anchors must survive auto-finish and measurement edits.
    mobile = false;
    await call('Emulation.setTouchEmulationEnabled', { enabled: false });
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile });
    if (await evaluate('document.getElementById("compare-view").checked')) await press('#comparison-view .comparison-close');
    await load('slice-highlights.xyz', 6);
    await change('show-all-voronoi-cells', false, { checkbox: true });
    await evaluate('if(document.getElementById("toggle-atom-details").getAttribute("aria-expanded")!=="true")document.getElementById("toggle-atom-details").click()');
    await change('measure-mode', true, { checkbox: true });
    await evaluate('if(document.getElementById("toggle-atom-details").getAttribute("aria-expanded")==="true")document.getElementById("toggle-atom-details").click()');
    await evaluate('floatingChecks.renderer.resetCamera();floatingChecks.renderer.setView("top");floatingChecks.renderer.setCameraState({fieldWidth:15})');
    await pick(5); await showTool('slice'); await expand('.slice-atom-controls'); await press('#slice-pick-atoms');
    await pick(0, { slice: true }); await pick(1, { slice: true });
    assert.deepEqual(await evaluate('Array.from(floatingChecks.renderer.sliceSelectedAtoms).filter(index=>index>=0)'), [0, 1]);
    assert.equal(await evaluate('[0,1,5].every(index=>Array.from(floatingChecks.renderer.getSelectionHighlightAtoms()).includes(index))'), true);
    assert.equal(await evaluate('[0,1].every(index=>floatingChecks.atomHighlightPixels(index)>0)'), true, 'both picked anchors have rendered amber rings');
    await pick(2, { slice: true });
    assert.equal(await evaluate('document.getElementById("slice-pick-atoms").getAttribute("aria-pressed")'), 'false');
    assert.deepEqual(await evaluate('Array.from(floatingChecks.renderer.sliceSelectedAtoms).filter(index=>index>=0)'), [0, 1, 2]);
    const measurementAtoms = await evaluate('Array.from(floatingChecks.renderer.selectedAtoms).filter(index=>index>=0)');
    await press('#slice-from-three'); await change('slice-enabled', false, { checkbox: true }); await press('#slice-clear-picks');
    assert.deepEqual(await evaluate('Array.from(floatingChecks.renderer.selectedAtoms).filter(index=>index>=0)'), measurementAtoms);
    assert.deepEqual(await evaluate('Array.from(floatingChecks.renderer.sliceSelectedAtoms).filter(index=>index>=0)'), []);
    await press('#slice-pick-atoms');
    for (const index of [0, 1, 2]) await pick(index, { slice: true });
    await evaluate('if(document.getElementById("toggle-atom-details").getAttribute("aria-expanded")!=="true")document.getElementById("toggle-atom-details").click()');
    await press('#clear-measurements');
    assert.deepEqual(await evaluate('Array.from(floatingChecks.renderer.selectedAtoms).filter(index=>index>=0)'), []);
    assert.deepEqual(await evaluate('Array.from(floatingChecks.renderer.sliceSelectedAtoms).filter(index=>index>=0)'), [0, 1, 2]);
    assert.equal(await evaluate('[0,1,2].every(index=>Array.from(floatingChecks.renderer.getSelectionHighlightAtoms()).includes(index))'), true);
    assert.equal(await evaluate('[0,1,2].every(index=>floatingChecks.atomHighlightPixels(index)>0)'), true, 'three retained anchors render amber rings after measurements are cleared');
    const sliceScreenshot = await screenshot('slice-three-anchor-highlights.png');
    await press('#slice-clear-picks');
    assert.deepEqual(await evaluate('Array.from(floatingChecks.renderer.sliceSelectedAtoms).filter(index=>index>=0)'), []);
    console.log('Floating Voronoi: two/three Slice anchors remain highlighted after auto-finish and measurement clearing.');

    // Exercise the real multicomponent dislocation example, with only the
    // picked cell shown. A small display box reveals the core neighborhood;
    // its complete 28,800-atom Voronoi analysis remains unchanged.
    await press('#close-file');
    await load('hea-fcc-screw.dump', 28_800, { sourcePath: resolve(root, 'examples/hea-fcc-screw.dump') });
    await showTool('voronoi'); await press('#run-voronoi');
    await waitFor('document.getElementById("voronoi-state").textContent==="Calculated"', 'HEA full CPU Voronoi');
    await expand('#voronoi-cell-display'); await change('voronoi-radius-percent', '20', { event: 'input' });
    await change('show-all-voronoi-cells', false, { checkbox: true });
    await change('show-voronoi-cell', true, { checkbox: true });
    await showTool('display'); await change('show-cell', false, { checkbox: true });
    for (const id of ['png-background', 'png-legend', 'png-axes']) await change(id, false, { checkbox: true });
    await change('background', '#ffffff', { event: 'input' });
    await evaluate('if(document.getElementById("toggle-atom-details").getAttribute("aria-expanded")==="true")document.getElementById("toggle-atom-details").click();floatingChecks.saveScience();floatingChecks.heaIndex=floatingChecks.coreAtom();floatingChecks.focusLocal(floatingChecks.heaIndex)');
    const heaPick = await pick(await evaluate('floatingChecks.heaIndex'));
    await waitFor(`floatingChecks.renderer.voronoiCellGeometry?.atomIndex===${heaPick.index}`, 'HEA picked cell geometry');
    const singleWhite = await pixels();
    assert.equal(await evaluate('floatingChecks.renderer.voronoiCellLayer.highlightedCellCount'), 1);
    assert.ok(singleWhite.orange > 20 && singleWhite.paleEdges > 20, 'single picked HEA cell has amber faces and light outlines');
    await change('show-voronoi-cell', false, { checkbox: true }); const noSingle = await pixels();
    assert.ok(singleWhite.orange > noSingle.orange + 20 && singleWhite.paleEdges > noSingle.paleEdges + 20, 'amber facets and pale edges belong to the inspected cell');
    await change('show-voronoi-cell', true, { checkbox: true });
    await waitFor(`floatingChecks.renderer.voronoiCellGeometry?.atomIndex===${heaPick.index}`, 'reenable cached HEA cell');
    const heaWhiteScreenshot = await screenshot('hea-selected-cell-white.png');
    const heaPng = await download('#export-png');
    assert.ok(heaPng.orange > 20 && heaPng.paleEdges > 20, 'PNG includes the selected-only HEA amber cell and light outlines');
    await writeFile(resolve(artifacts, 'hea-selected-cell.png'), Buffer.from(heaPng.bytes));
    await change('background', '#151b2e', { event: 'input' });
    const singleDark = await pixels(); assert.ok(singleDark.orange > 20 && singleDark.paleEdges > 20);
    const heaDarkScreenshot = await screenshot('hea-selected-cell-dark.png');
    const next = await evaluate('floatingChecks.localNeighbor(floatingChecks.heaIndex)');
    await pick(next); await waitFor(`floatingChecks.renderer.voronoiCellGeometry?.atomIndex===${next}`, 'selection changes HEA cell mesh');
    await pixels(); assert.equal(await evaluate('floatingChecks.renderer.voronoiCellLayer.highlightedCellCount'), 1);
    await showTool('selectionGroups'); await press('#add-selection-group'); await expand('#selection-group-settings .selection-group-members');
    await change('selection-group-operation', 'replace'); await change('selection-group-ids', String(await evaluate(`floatingChecks.renderer.frame.ids[${next}]`)), { event: 'input' });
    await press('#apply-selection-group-ids'); await press('#toggle-selection-group-visibility'); await pixels();
    assert.equal(await evaluate('floatingChecks.renderer.voronoiCellLayer.highlightedCellCount'), 0, 'hidden atom suppresses its selected-only cell');
    await press('#toggle-selection-group-visibility');
    await evaluate('floatingChecks.renderer.setSlices([])');
    await showTool('replicate'); await change('replicate-c', '2'); await press('#apply-replicate');
    await waitFor('floatingChecks.renderer.repetitions[2]===2', 'HEA display replicas'); await pixels();
    assert.equal(await evaluate('floatingChecks.renderer.voronoiCellLayer.renderedReplicaCount'), 2);
    await showTool('display'); await change('compare-view', true, { checkbox: true });
    await waitFor('floatingChecks.comparison?.frame===floatingChecks.renderer.frame', 'HEA selected-only second view');
    await evaluate('floatingChecks.comparison.resize();floatingChecks.comparison.setCameraState(floatingChecks.renderer.getCameraState())');
    await pixels('comparison');
    assert.equal(await evaluate('floatingChecks.comparison.voronoiCellLayer.highlightedCellCount'), 1);
    assert.equal(await evaluate('floatingChecks.comparison.voronoiCellLayer.renderedReplicaCount'), 2);
    assert.ok((await download('#export-comparison-png')).paleEdges > 0);
    await press('#comparison-view .comparison-close'); await showTool('replicate'); await press('#reset-replicate');
    await evaluate(`floatingChecks.focusLocal(${next})`);
    await change('background', '#ffffff', { event: 'input' });
    mobile = true;
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 640, deviceScaleFactor: 2, mobile });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true }); await delay(100);
    await evaluate('floatingChecks.renderer.resize();floatingChecks.renderer.setCameraState({fieldWidth:12})');
    const singlePhone = await pixels();
    assert.equal(singlePhone.width, 780); assert.ok(singlePhone.orange > 20 && singlePhone.paleEdges > 20);
    const heaPhoneScreenshot = await screenshot('hea-selected-cell-phone-dpr2.png');
    assert.equal(await evaluate('floatingChecks.scienceUnchanged()'), true, 'HEA inspection, colors, masks, replicas and DPI preserve full scientific results');
    console.log(`HEA selected-only cells: white/dark/DPR2 light-edge pixels ${singleWhite.paleEdges}/${singleDark.paleEdges}/${singlePhone.paleEdges}; amber facets, selection changes, masks, replicas, comparison and PNG passed.`);
    return { adapter, graphics: 'SwiftShader validation only', compute: 'CPU Workers', atoms: 32,
      defaults: { color: '#3b82f6', opacity: .5 }, selectedAtomId: selected.id,
      checks: ['shared Voronoi/Display radii', 'lit faces and selected polygon highlights', 'floating default placement', 'desktop drag/resize',
        'independent orbit/pan/zoom and PNG', 'perspective/parallel camera transfer with roll', 'replicated highlights and masks',
        'camera/layout/radius recipe and disabled-window replay', 'phone drag/resize bounds and PNG', 'retained Slice anchors and separate measurement channel',
        'HEA selected-only amber facets/light edges on white/dark/DPR2, masks/replicas/comparison/PNG'],
      hea: { atoms: 28_800, selectedAtomId: heaPick.id, edgePixels: { white: singleWhite.paleEdges, dark: singleDark.paleEdges, phoneDpr2: singlePhone.paleEdges } },
      screenshots: [defaultScreenshot, highlightedScreenshot, phoneScreenshot, narrowScreenshot, sliceScreenshot, heaWhiteScreenshot, heaDarkScreenshot, heaPhoneScreenshot], artifacts };
  }, { software: true });
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(fixtures, { recursive: true, force: true }); }

function near(actual, expected, tolerance = 2e-7) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≈ ${expected}`);
}
function assertCamera(actual, expected, { center = true } = {}) {
  for (const key of ['direction', 'up', ...(center ? ['position', 'center'] : [])]) actual[key].forEach((value, axis) => near(value, expected[key][axis]));
  for (const key of ['distance', 'fov', 'roll', 'fieldWidth']) near(actual[key], expected[key]);
  assert.equal(actual.projectionMode, expected.projectionMode); assert.equal(actual.constrainUp, expected.constrainUp);
}
function intersects(a, b) { return a && b && a.width > 0 && b.width > 0 && Math.min(a.right, b.right) > Math.max(a.x, b.x) && Math.min(a.bottom, b.bottom) > Math.max(a.y, b.y); }
function assertContained(panel, viewport) {
  assert.ok(panel.x >= viewport.x - 1 && panel.y >= viewport.y - 1 && panel.right <= viewport.right + 1 && panel.bottom <= viewport.bottom + 1,
    `floating panel stays inside viewport: ${JSON.stringify({ panel, viewport })}`);
}

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const [{ WebGLRenderer }, { AnalysisPool }, { transformPoint }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)), import(new URL('./render/math.js', app)),
  ]);
  const checks = window.floatingChecks = { history: [], download: null };
  checks.pointerEvents = [];
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) document.addEventListener(type, event => {
    if (event.target.closest?.('#comparison-view')) {
      checks.pointerEvents.push({ type, id: event.target.id, pointer: event.pointerType });
      if (checks.pointerEvents.length > 32) checks.pointerEvents.shift();
    }
  }, true);
  const setFrame = WebGLRenderer.prototype.setFrame, analyze = AnalysisPool.prototype.analyze, captureImage = WebGLRenderer.prototype.captureImage;
  WebGLRenderer.prototype.setFrame = function(...args) { checks[this.canvas.id === 'viewport' ? 'renderer' : 'comparison'] = this; return setFrame.apply(this, args); };
  WebGLRenderer.prototype.captureImage = function(options) {
    const image = captureImage.call(this, options);
    if (checks.recordCapture) checks.lastExportCapture = { ...summary(image), imageCanvas: image, kind: this === checks.comparison ? 'comparison' : 'renderer', camera: this.getCameraState(), options,
      values: image.getContext('2d').getImageData(0, 0, image.width, image.height).data };
    return image;
  };
  AnalysisPool.prototype.analyze = async function(frame, parameters, options) {
    checks.history.push({ frame, kind: parameters.kind }); return analyze.call(this, frame, parameters, options);
  };
  const box = node => { if (!node) return null; const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom }; };
  checks.boxes = () => ({ panel: box(document.getElementById('comparison-view')), viewport: box(checks.renderer.canvas),
    details: box(document.getElementById('atom-details-overlay')), detailToggle: box(document.getElementById('toggle-atom-details')) });
  checks.pickPoint = (wanted = null, kind = 'renderer', requestedReplica = null) => {
    const r = checks[kind]; r.updateMatrices(); const rect = r.canvas.getBoundingClientRect();
    for (const replica of r.replicas) {
      if (requestedReplica && !replica.indices.every((value, axis) => value === requestedReplica[axis])) continue;
      for (let index = r.atomCount - 1; index >= 0; index--) {
        if (wanted !== null && index !== wanted || !r.isAtomVisible(index, replica.indices)) continue;
        const p = transformPoint(r.viewProjectionMatrix, ...Array.from(r.displayPositions.slice(index * 3, index * 3 + 3), (value, axis) => value + replica.offset[axis]));
        const x = rect.left + (.5 + p[0] / p[3] * .5) * rect.width, y = rect.top + (.5 - p[1] / p[3] * .5) * rect.height;
        if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom || document.elementFromPoint(x, y) !== r.canvas || r.pick(x, y) !== index) continue;
        if (requestedReplica && !r.lastPick.replica.every((value, axis) => value === requestedReplica[axis])) continue;
        return { x, y, index, id: r.frame.ids[index] };
      }
    }
    return null;
  };
  checks.coreAtom = () => {
    const frame = checks.renderer.frame, distance = frame.properties.find(property => property.name === 'core_distance')?.data;
    const candidates = [];
    for (let index = 0; index < frame.ids.length; index++) {
      const fractional = frame.fractional.subarray(index * 3, index * 3 + 3);
      if (fractional.some(value => value < .3 || value > .7)) continue;
      const score = distance ? distance[index] : fractional.reduce((sum, value) => sum + (value - .5) ** 2, 0);
      if (Number.isFinite(score)) candidates.push({ index, score });
    }
    candidates.sort((a, b) => a.score - b.score);
    // A dense core can occlude its mathematically closest atom. Keep real
    // pointer input by choosing the nearest interior core atom that is visible.
    for (const candidate of candidates.slice(0, 128)) {
      checks.focusLocal(candidate.index);
      if (checks.pickPoint(candidate.index)) return candidate.index;
    }
    throw new Error('HEA source has no reachable interior core atom.');
  };
  checks.localNeighbor = index => {
    const r = checks.renderer, center = r.displayPositions.subarray(index * 3, index * 3 + 3);
    const candidates = [];
    for (let atom = 0; atom < r.atomCount; atom++) {
      if (atom === index || !r.isAtomVisible(atom, [0, 0, 0])) continue;
      const distance = center.reduce((sum, value, axis) => sum + (value - r.displayPositions[atom * 3 + axis]) ** 2, 0);
      if (distance > .01) candidates.push({ atom, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const chosen = candidates.find(candidate => checks.pickPoint(candidate.atom));
    if (!chosen) throw new Error('HEA local neighborhood has no reachable atom.');
    return chosen.atom;
  };
  checks.focusLocal = index => {
    const r = checks.renderer, center = Array.from(r.displayPositions.subarray(index * 3, index * 3 + 3));
    r.setCameraState({ yaw: .371, pitch: .287, constrainUp: true });
    r.resetCamera(); const camera = r.getCameraState();
    const position = camera.position.map((value, axis) => value + center[axis] - camera.center[axis]);
    r.setCameraState({ position, projectionMode: 'orthographic', fieldWidth: 12 });
    const planes = [];
    for (let axis = 0; axis < 3; axis++) for (const direction of [-1, 1]) {
      const normal = [0, 0, 0]; normal[axis] = direction;
      planes.push({ id: `local-${axis}-${direction}`, normal, position: direction * center[axis] + 4, enabled: true });
    }
    r.setSlices(planes);
  };
  function summary(canvas) {
    const values = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261, blue = 0, orange = 0, paleEdges = 0;
    for (let i = 0; i < values.length; i++) hash = Math.imul(hash ^ values[i], 16777619);
    for (let i = 0; i < values.length; i += 4) if (values[i + 3] > 50) {
      if (values[i + 2] > values[i] * 1.2 && values[i + 2] > values[i + 1] * 1.05) blue++;
      if (values[i] > 150 && values[i + 1] > 70 && values[i + 2] < values[i + 1] * .8) orange++;
      if (values[i] > 210 && values[i + 1] > 210 && values[i + 2] > 140) paleEdges++;
    }
    return { width: canvas.width, height: canvas.height, hash: hash >>> 0, blue, orange, paleEdges };
  }
  checks.pixels = (kind = 'renderer') => summary(checks[kind].captureImage({ includeBackground: false }));
  checks.atomHighlightPixels = index => {
    const r = checks.renderer, canvas = r.captureImage({ includeBackground: false });
    const center = transformPoint(r.viewMatrix, ...r.displayPositions.subarray(index * 3, index * 3 + 3));
    const clip = transformPoint(r.projectionMatrix, center[0], center[1], center[2]);
    const edge = transformPoint(r.projectionMatrix, center[0] + r.atomRadii[index] * r.radiusScale, center[1], center[2]);
    const x = (.5 + clip[0] / clip[3] * .5) * canvas.width, y = (.5 - clip[1] / clip[3] * .5) * canvas.height;
    const radius = Math.ceil(Math.abs(edge[0] / edge[3] - clip[0] / clip[3]) * canvas.width * .5) + 2;
    const left = Math.max(0, Math.floor(x - radius)), top = Math.max(0, Math.floor(y - radius));
    const width = Math.min(canvas.width - left, radius * 2 + 1), height = Math.min(canvas.height - top, radius * 2 + 1);
    if (width <= 0 || height <= 0) return 0;
    const values = canvas.getContext('2d').getImageData(left, top, width, height).data;
    let amber = 0; for (let i = 0; i < values.length; i += 4) if (values[i] > 200 && values[i + 1] > 100 && values[i + 1] < 210 && values[i + 2] < 100 && values[i + 3] > 100) amber++;
    return amber;
  };
  checks.encodedPixels = async (kind = 'renderer') => {
    const raw = checks[kind].captureImage({ includeBackground: false });
    const original = raw.getContext('2d').getImageData(0, 0, raw.width, raw.height).data;
    const blob = await new Promise(resolve => raw.toBlob(resolve, 'image/png'));
    const image = await createImageBitmap(blob), decoded = document.createElement('canvas');
    decoded.width = image.width; decoded.height = image.height; decoded.getContext('2d').drawImage(image, 0, 0); image.close();
    const values = decoded.getContext('2d').getImageData(0, 0, decoded.width, decoded.height).data;
    let differentChannels = 0, maxDelta = 0;
    for (let index = 0; index < values.length; index++) if (values[index] !== original[index]) {
      differentChannels++; maxDelta = Math.max(maxDelta, Math.abs(values[index] - original[index]));
    }
    let exportDiff = 0, alphaDiff = 0, exportMaxDelta = 0;
    const previous = checks.lastExportCapture?.values;
    if (previous?.length === original.length) for (let index = 0; index < original.length; index++) if (previous[index] !== original[index]) {
      exportDiff++; if (index % 4 === 3) alphaDiff++; exportMaxDelta = Math.max(exportMaxDelta, Math.abs(previous[index] - original[index]));
    }
    return { ...summary(decoded), roundTrip: { rawHash: summary(raw).hash, differentChannels, maxDelta, exportDiff, alphaDiff, exportMaxDelta } };
  };
  checks.saveScience = () => {
    const frame = checks.renderer.frame;
    checks.science = { frame, fractional: Array.from(frame.fractional), positions: Array.from(frame.positions),
      result: frame.atomeyeResults.voronoi.result, count: checks.history.filter(entry => entry.kind === 'voronoi').length };
  };
  checks.scienceUnchanged = () => {
    const f = checks.renderer.frame, s = checks.science;
    return f === s.frame && f.atomeyeResults.voronoi.result === s.result
      && f.fractional.every((value, index) => Object.is(value, s.fractional[index]))
      && f.positions.every((value, index) => Object.is(value, s.positions[index]))
      && checks.history.filter(entry => entry.kind === 'voronoi').length === s.count;
  };
  checks.beginDownload = () => {
    const urls = new Map(), create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    checks.download = null;
    checks.recordCapture = true; checks.lastExportCapture = null;
    URL.createObjectURL = function(blob) { const url = create.call(this, blob); urls.set(url, blob); return url; };
    HTMLAnchorElement.prototype.click = function() { const blob = urls.get(this.href); if (blob) checks.download = { blob, filename: this.download }; };
    checks.restoreDownload = () => { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; };
  };
  checks.finishDownload = async () => {
    try {
      const { blob, filename } = checks.download;
      checks.recordCapture = false;
      if (blob.type === 'image/png') {
        const image = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0); image.close();
        const values = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const { values: original, imageCanvas, ...capture } = checks.lastExportCapture ?? {};
        if (imageCanvas) {
          const encoded = await new Promise(resolve => imageCanvas.toBlob(resolve, 'image/png'));
          const sourceImage = await createImageBitmap(encoded), sourceCanvas = document.createElement('canvas');
          sourceCanvas.width = sourceImage.width; sourceCanvas.height = sourceImage.height;
          sourceCanvas.getContext('2d').drawImage(sourceImage, 0, 0); sourceImage.close();
          capture.encodedHash = summary(sourceCanvas).hash;
          capture.roundTripChannels = values.reduce((sum, value, index) => sum + (value !== original[index] ? 1 : 0), 0);
          const expected = sourceCanvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let channels = 0, maxDelta = 0, maxWeightedDelta = 0;
          for (let index = 0; index < values.length; index++) if (values[index] !== expected[index]) {
            const delta = Math.abs(values[index] - expected[index]), alphaIndex = index - index % 4 + 3;
            channels++; maxDelta = Math.max(maxDelta, delta);
            maxWeightedDelta = Math.max(maxWeightedDelta, delta * (index % 4 === 3 ? 1 : Math.max(values[alphaIndex], expected[alphaIndex]) / 255));
          }
          capture.encodingDiff = { channels, maxDelta, maxWeightedDelta };
        }
        let differenceFromPrevious = values.length;
        if (checks.previousPng?.length === values.length) differenceFromPrevious = values.reduce((sum, value, index) => sum + (value !== checks.previousPng[index] ? 1 : 0), 0);
        checks.previousPng = values;
        return { filename, type: blob.type, ...summary(canvas), capture, differenceFromPrevious, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
      }
      return { filename, type: blob.type, text: await blob.text() };
    } finally { checks.recordCapture = false; checks.restoreDownload(); checks.download = null; }
  };
}
