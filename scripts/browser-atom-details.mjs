import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crystalFrame } from '../tests/helpers/crystals.js';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Real local files, CPU Workers, pointer picking, touch scrolling, and the PNG
// exporter exercise the production overlay independently of sidebar tools.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-atom-details-fixtures-'));
const artifacts = resolve(tmpdir(), 'alloyview-atom-details');
await mkdir(artifacts, { recursive: true });
const fcc = crystalFrame('fcc', 3, 3.6);
function crystalXyz(step) {
  return [String(fcc.ids.length),
    `Lattice="${Array.from(fcc.cell.vectors).join(' ')}" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1:force:R:3:energy:R:1:all_nan:R:1:${Array.from({ length: 18 }, (_, i) => `site_energy_${i}:R:1`).join(':')} Step=${step}`,
    ...Array.from(fcc.ids, (id, atom) => `Ni ${Array.from(fcc.positions.slice(atom * 3, atom * 3 + 3), v => v + step * .1).join(' ')} ${id} 1 .5 -.25 ${atom / 100 + step} NaN ${Array.from({ length: 18 }, (_, i) => atom + i / 10 + step).join(' ')}`), '',
  ].join('\n');
}
const periodicAtoms = [[9.5, 4, 2], [.5, 2, 5], [4, 5, 4], [6, 8, 7]];
const periodicXyz = [String(periodicAtoms.length),
  'Lattice="10 0 0 0 10 0 0 0 10" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1:energy:R:1',
  ...periodicAtoms.map((xyz, atom) => `Ni ${xyz.join(' ')} ${(atom + 1) * 101} ${atom / 10}`), '',
].join('\n');
await Promise.all([
  writeFile(resolve(temporary, 'atom-details-trajectory.xyz'), crystalXyz(0) + crystalXyz(1)),
  writeFile(resolve(temporary, 'atom-details-periodic.xyz'), periodicXyz),
]);

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
    const origin = await evaluate('location.origin');
    let mobile = false;
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(35);
      }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({file:document.getElementById("file-name")?.textContent,frame:window.atomDetailsChecks?.renderer?.frame?.frameIndex,coordination:document.getElementById("analysis-state")?.textContent,cna:document.getElementById("cna-state")?.textContent,displacement:document.getElementById("displacement-state")?.textContent,toast:document.getElementById("toast")?.textContent,configuration:document.getElementById("configuration-status")?.textContent})')}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("atom-details")', 'production Atom details page');
    await evaluate(`(${initializeChecks.toString()})()`);
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
    assert.equal(await evaluate('document.querySelector("[data-tool-button=selection]")'), null);
    assert.equal(await evaluate('document.getElementById("tool-selection")'), null);
    assert.equal(await evaluate('document.getElementById("atom-details-overlay").hidden'), true, 'no floating details before a source is loaded');
    async function change(id, value, checkbox = false, event = 'change') {
      await evaluate(`(() => { const field = document.getElementById(${JSON.stringify(id)}); ${checkbox ? 'field.checked' : 'field.value'} = ${JSON.stringify(value)}; field.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
    }
    async function showTool(name) {
      await evaluate(`if (!document.querySelector('[data-tool-button="${name}"]').classList.contains('active')) document.querySelector('[data-tool-button="${name}"]').click()`);
    }
    async function press(selector) {
      const point = await evaluate(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); button.scrollIntoView({block:'nearest',inline:'nearest'}); const box = button.getBoundingClientRect(),hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2); return {x:box.left+box.width/2,y:box.top+box.height/2,enabled:!button.disabled,hit:hit === button,hitId:hit?.id,hitTag:hit?.tagName,hitPanel:hit?.closest('section')?.id}; })()`);
      assert.ok(point.enabled && point.hit, `${selector} must be reachable: ${JSON.stringify(point)}`);
      if (mobile) {
        await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: point.x, y: point.y }] });
        await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      }
      await delay(45);
    }
    async function openFile(name, atoms) {
      const analyses = await evaluate('atomDetailsChecks.analyses');
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [resolve(temporary, name)] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(name)} && document.getElementById('loading').hidden && atomDetailsChecks.renderer?.atomCount === ${atoms}`, `load ${name}`);
      await delay(350);
      assert.equal(await evaluate('atomDetailsChecks.analyses'), analyses, 'opening a source does not calculate properties');
      assert.equal(await evaluate('document.getElementById("atom-details-overlay").hidden'), false);
    }
    async function setExpanded(expanded) {
      if (await evaluate('document.getElementById("toggle-atom-details").getAttribute("aria-expanded")') !== String(expanded)) await press('#toggle-atom-details');
      await waitFor(`document.getElementById('toggle-atom-details').getAttribute('aria-expanded') === '${expanded}'`, 'Atom details expansion');
      assert.equal(await evaluate('document.getElementById("atom-details").inert'), !expanded);
    }
    async function pick(index = null) {
      const before = await evaluate('({tool:atomDetailsChecks.activeTool(),expanded:document.getElementById("toggle-atom-details").getAttribute("aria-expanded")})');
      const point = await evaluate(`atomDetailsChecks.pickPoint(${index === null ? 'null' : index})`);
      assert.ok(point, `find a visible clickable atom${index === null ? '' : ` ${index}`}`);
      if (mobile) {
        await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: point.x, y: point.y }] });
        await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      }
      await waitFor(`atomDetailsChecks.renderer.selected === ${point.index}`, 'real atom pointer pick');
      assert.deepEqual(await evaluate('({tool:atomDetailsChecks.activeTool(),expanded:document.getElementById("toggle-atom-details").getAttribute("aria-expanded")})'), before, 'picking preserves the sidebar tool and overlay expansion choice');
      return point;
    }
    async function coverage(label) {
      const actual = await evaluate('atomDetailsChecks.propertyCoverage()');
      assert.deepEqual(actual.missing, [], `${label}: all imported and computed properties appear in Atom details`);
      assert.deepEqual(actual.wrong, [], `${label}: selected atom values and category labels are current`);
      assert.ok(actual.id && actual.type && actual.cartesian && actual.fractional);
      return actual;
    }
    async function screenshot(name) {
      await waitFor('document.getElementById("toast").hidden', 'transient load message dismissed', 10_000);
      const { data } = await call('Page.captureScreenshot', { format: 'png' });
      const path = resolve(artifacts, name); await writeFile(path, Buffer.from(data, 'base64')); return path;
    }
    async function exportRecipe() { return evaluate('atomDetailsChecks.exportRecipe()'); }

    await openFile('atom-details-trajectory.xyz', 108);
    assert.equal(await evaluate('document.getElementById("toggle-atom-details").getAttribute("aria-expanded")'), 'false', 'desktop starts with Details folded');
    assert.equal(await evaluate('document.getElementById("toggle-atom-details").textContent'), 'Details');
    await setExpanded(true);
    assert.equal(await evaluate('document.getElementById("selected-atom-appearance").open'), false);
    await showTool('vectors');
    const selected = await pick();
    const imported = await coverage('imported FCC properties');
    assert.equal(imported.properties, 23);
    await showTool('coordination');
    await press('#run-analysis');
    await waitFor('document.getElementById("analysis-state").textContent === "Calculated" && atomDetailsChecks.renderer.frame.properties.some(p=>p.name==="coordination")', 'CPU coordination');
    assert.equal(await evaluate('atomDetailsChecks.renderer.frame.properties.find(p=>p.name==="coordination").data[atomDetailsChecks.renderer.selected]'), 12);
    await showTool('cna'); await press('#run-cna');
    await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'CPU CNA');
    await showTool('displacement');
    await waitFor('document.getElementById("displacement-state").textContent === "Calculated"', 'CPU displacement');
    const calculated = await coverage('calculated FCC properties');
    assert.ok(calculated.properties >= 29);
    assert.match(await evaluate('document.getElementById("selection-data").textContent'), /FCC/);
    await showTool('vectors');
    await evaluate('document.getElementById("atom-details").scrollTop = 0');
    const desktopScreenshot = await screenshot('desktop-properties.png');
    console.log('Atom details: imported and computed desktop properties passed.');
    await setExpanded(false);
    await change('frame-slider', '1', false, 'input');
    await waitFor('atomDetailsChecks.renderer.frame.frameIndex === 1 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent === "Calculated" && document.getElementById("cna-state").textContent === "Calculated" && document.getElementById("displacement-state").textContent === "Calculated"', 'trajectory properties and selection');
    assert.equal(await evaluate('atomDetailsChecks.renderer.frame.ids[atomDetailsChecks.renderer.selected]'), selected.id);
    assert.equal(await evaluate('document.getElementById("toggle-atom-details").getAttribute("aria-expanded")'), 'false', 'frame and analysis updates preserve desktop collapse');
    const trajectory = await coverage('trajectory property refresh');
    assert.equal(Number(await evaluate('atomDetailsChecks.rows().energy')), selected.index / 100 + 1);
    await setExpanded(true);
    await change('measure-mode', true, true);
    await pick();
    const legacy = await exportRecipe(); legacy.settings.activeTool = 'selection';
    const savedId = legacy.settings.selectedAtomId;
    await evaluate(`(() => { const files=new DataTransfer(); files.items.add(new File([${JSON.stringify(JSON.stringify(legacy))}],'legacy-selection.json',{type:'application/json'})); const input=document.getElementById('configuration-file'); input.files=files.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'legacy Selection recipe restore');
    assert.equal(await evaluate('atomDetailsChecks.activeTool()'), 'display');
    assert.equal(await evaluate('atomDetailsChecks.renderer.frame.ids[atomDetailsChecks.renderer.selected]'), savedId);
    const restored = await exportRecipe();
    assert.equal(restored.settings.activeTool, 'display');
    assert.deepEqual(restored.settings.extensions.measurements, legacy.settings.extensions.measurements);
    await coverage('legacy recipe selected properties');
    await press('#clear-selection');
    assert.equal(await evaluate('atomDetailsChecks.renderer.selected'), -1);
    assert.equal(await evaluate('document.getElementById("selection-data").hidden'), true);
    assert.equal((await exportRecipe()).settings.selectedAtomId, null);
    assert.deepEqual((await exportRecipe()).settings.extensions.measurements.atomIds, legacy.settings.extensions.measurements.atomIds, 'clearing main selection does not discard the measurement set');
    await press('#clear-measurements');
    assert.deepEqual((await exportRecipe()).settings.extensions.measurements.atomIds, []);

    await press('#close-file');
    assert.equal(await evaluate('document.getElementById("atom-details-overlay").hidden'), true);
    await openFile('atom-details-periodic.xyz', 4);
    assert.equal(await evaluate('document.getElementById("toggle-atom-details").getAttribute("aria-expanded")'), 'false', 'closing a source folds Details again');
    await setExpanded(true);
    await showTool('vectors');
    await evaluate(`(() => { const r=atomDetailsChecks.renderer; r.setView('front'); r.centerOnPoint([5,5,5]); r.orthographicScale=7; r.render(performance.now(),{trackStats:false}); })()`);
    await change('measure-mode', true, true);
    await setExpanded(false); await pick(0); await pick(1); await setExpanded(true);
    const nearest = await evaluate('atomDetailsChecks.measurement()');
    assert.deepEqual(nearest.vector, [1, -2, 3]);
    assert.ok(Math.abs(nearest.distance - Math.sqrt(14)) < 1e-6);
    await change('measure-pbc', false, true);
    const direct = await evaluate('atomDetailsChecks.measurement()');
    assert.deepEqual(direct.vector, [-9, -2, 3]);
    assert.ok(Math.abs(direct.distance - Math.sqrt(94)) < 1e-6);
    await change('measure-pbc', true, true); await press('#clear-measurements');
    assert.equal(await evaluate('atomDetailsChecks.renderer.selected'), 1, 'clearing measurements preserves the inspected atom');
    await setExpanded(false); await pick(1); await pick(0); await setExpanded(true);
    const reverse = await evaluate('atomDetailsChecks.measurement()');
    assert.deepEqual(reverse.vector, [-1, 2, -3]);
    assert.equal(reverse.distance, nearest.distance);
    const measurementScreenshot = await screenshot('desktop-measurement.png');
    const pngOpen = await evaluate('atomDetailsChecks.exportPng(true)');
    await writeFile(resolve(artifacts, 'viewport-details-open.png'), Buffer.from(pngOpen.data, 'base64'));
    await setExpanded(false);
    const pngClosed = await evaluate('atomDetailsChecks.exportPng(false)');
    assert.equal(pngClosed.changedPixels, 0, 'the real PNG exporter is pixel-identical with Atom details expanded or collapsed');
    assert.equal(pngClosed.width, pngOpen.width); assert.equal(pngClosed.height, pngOpen.height);
    await writeFile(resolve(artifacts, 'viewport-details-closed.png'), Buffer.from(pngClosed.data, 'base64'));
    console.log('Atom details: trajectory, legacy recipe, signed periodic vectors, and identical PNG pixels passed.');

    await press('#close-file'); mobile = true;
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true });
    await openFile('atom-details-trajectory.xyz', 108);
    assert.equal(await evaluate('document.getElementById("toggle-atom-details").getAttribute("aria-expanded")'), 'false');
    assert.equal(await evaluate('document.getElementById("atom-details").inert'), true);
    assert.equal(await evaluate('(() => {document.getElementById("atom-search-id").focus();return document.activeElement === document.getElementById("atom-search-id")})()'), false, 'collapsed phone details cannot receive keyboard focus');
    await showTool('vectors'); await pick();
    await press('#toggle-atom-details');
    assert.equal(await evaluate('document.getElementById("atom-details").inert'), false);
    await coverage('phone selected properties');
    const mobileScreenshot = await screenshot('mobile-properties.png');
    const beforeScroll = await evaluate('atomDetailsChecks.cameraAndViewport()');
    const scrollPoint = await evaluate(`(() => { const panel=document.getElementById('atom-details'), box=panel.getBoundingClientRect(); panel.scrollTop=0; return {x:box.left+8,y:box.bottom-16,height:box.height,scrollable:panel.scrollHeight>panel.clientHeight}; })()`);
    assert.equal(scrollPoint.scrollable, true);
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: scrollPoint.x, y: scrollPoint.y }] });
    for (let step = 1; step <= 8; step++) {
      await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: scrollPoint.x, y: scrollPoint.y - step * 18 }] });
      await delay(20);
    }
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitFor('document.getElementById("atom-details").scrollTop > 0', 'phone Atom details touch scrolling');
    // A tap during native inertial scrolling first stops the fling. Wait for
    // the panel to settle before testing an unrelated overlay button.
    await evaluate(`(async () => { const panel=document.getElementById('atom-details'); let previous=panel.scrollTop,stable=0; for(let attempt=0;attempt<50&&stable<3;attempt++){await new Promise(resolve=>setTimeout(resolve,40)); const current=panel.scrollTop; stable=current===previous?stable+1:0; previous=current;} })()`);
    assert.deepEqual(await evaluate('atomDetailsChecks.cameraAndViewport()'), beforeScroll, 'scrolling Atom details leaves camera, fixed canvas, and page scroll unchanged');
    const mobileScrolledScreenshot = await screenshot('mobile-properties-scrolled.png');
    await press('#toggle-view-controls');
    assert.deepEqual(await evaluate('atomDetailsChecks.overlayState()'), { details: false, view: true, legend: false, detailsInert: true, viewInert: false, legendInert: true });
    await press('#toggle-atom-details');
    assert.deepEqual(await evaluate('atomDetailsChecks.overlayState()'), { details: true, view: false, legend: false, detailsInert: false, viewInert: true, legendInert: true });
    await press('#toggle-legend');
    assert.deepEqual(await evaluate('atomDetailsChecks.overlayState()'), { details: false, view: false, legend: true, detailsInert: true, viewInert: true, legendInert: false });
    assert.deepEqual(await evaluate('atomDetailsChecks.overlayCollisions()'), [], 'the open phone legend stays below the Details toggle and toolbar');
    await press('#toggle-atom-details');
    assert.deepEqual(await evaluate('atomDetailsChecks.overlayCollisions()'), [], 'open phone Details leaves the legend toggle uncovered');
    await evaluate('document.getElementById("atom-search-id").focus()');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate('document.getElementById("atom-details").inert'), true);
    assert.equal(await evaluate('document.activeElement.id'), 'toggle-atom-details');
    assert.equal(await evaluate('atomDetailsChecks.activeTool()'), 'vectors');
    const compactPhone = [];
    for (const [width, height] of [[390, 640], [320, 568], [640, 400]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await setExpanded(true);
      const pane = await evaluate(`(() => { const panel=document.getElementById('atom-details'),style=getComputedStyle(panel),box=panel.getBoundingClientRect();panel.scrollTop=0;return{width:innerWidth,height:innerHeight,panelHeight:box.height,contentHeight:panel.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom),scrollable:panel.scrollHeight>panel.clientHeight,x:box.left+8,y:box.bottom-16}; })()`);
      assert.ok(pane.contentHeight > 0, `compact phone must expose usable Atom details content: ${JSON.stringify(pane)}`);
      assert.deepEqual(await evaluate('atomDetailsChecks.overlayCollisions()'), [], `open Details at ${width}×${height} leaves the toolbar and overlay toggles uncovered`);
      assert.equal(pane.scrollable, true);
      const compactCamera = await evaluate('atomDetailsChecks.cameraAndViewport()');
      await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: pane.x, y: pane.y }] });
      const distance = Math.max(20, Math.min(72, pane.panelHeight - 32));
      for (let step = 1; step <= 4; step++) {
        await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: pane.x, y: pane.y - distance * step / 4 }] });
        await delay(25);
      }
      await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitFor('document.getElementById("atom-details").scrollTop > 0', `Atom details scrolling at ${width}×${height}`);
      await evaluate(`(async () => { const panel=document.getElementById('atom-details');let previous=panel.scrollTop,stable=0;for(let attempt=0;attempt<50&&stable<3;attempt++){await new Promise(resolve=>setTimeout(resolve,40));const current=panel.scrollTop;stable=current===previous?stable+1:0;previous=current;} })()`);
      assert.deepEqual(await evaluate('atomDetailsChecks.cameraAndViewport()'), compactCamera, 'compact phone scrolling preserves camera and fixed viewport');
      const image = await screenshot(`compact-${width}x${height}.png`);
      await press('#toggle-view-controls');
      assert.deepEqual(await evaluate('atomDetailsChecks.overlayState()'), { details: false, view: true, legend: false, detailsInert: true, viewInert: false, legendInert: true });
      await press('#toggle-atom-details');
      assert.deepEqual(await evaluate('atomDetailsChecks.overlayCollisions()'), [], `Details opened from View at ${width}×${height} leaves the toolbar and overlay toggles uncovered`);
      await press('#toggle-legend');
      assert.deepEqual(await evaluate('atomDetailsChecks.overlayState()'), { details: false, view: false, legend: true, detailsInert: true, viewInert: true, legendInert: false });
      assert.deepEqual(await evaluate('atomDetailsChecks.overlayCollisions()'), [], `the open legend at ${width}×${height} stays below the Details toggle and toolbar`);
      await press('#toggle-atom-details');
      assert.deepEqual(await evaluate('atomDetailsChecks.overlayState()'), { details: true, view: false, legend: false, detailsInert: false, viewInert: true, legendInert: true });
      assert.deepEqual(await evaluate('atomDetailsChecks.cameraAndViewport()'), compactCamera, 'compact overlay switching preserves camera and viewport');
      compactPhone.push({ width, height, panelHeight: pane.panelHeight, contentHeight: pane.contentHeight, scrollingPreservesCamera: true, mutualExclusion: true, screenshot: image });
    }
    await press('#close-file');
    assert.equal(await evaluate('document.getElementById("atom-details-overlay").hidden'), true);

    return { adapter, imported, calculated, trajectory, selected, legacyRecipeSelectedId: savedId,
      measurements: { nearest, direct, reverse }, png: { width: pngOpen.width, height: pngOpen.height, changedPixels: pngClosed.changedPixels },
      phone: { width: 390, scrollingPreservesCamera: true, mutualExclusion: true, collapsedInert: true, panelHeight: scrollPoint.height },
      compactPhone,
      screenshots: { desktopScreenshot, measurementScreenshot, mobileScreenshot, mobileScrolledScreenshot } };
  }, { software: useSoftwareAdapter(true) });
  const path = resolve(artifacts, 'report.json');
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Atom details browser regression passed. Report: ${path}`);
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const appUrl = document.querySelector('script[type="module"]').src;
  const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', appUrl));
  const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
  const { transformPoint } = await import(new URL('./render/math.js', appUrl));
  const checks = window.atomDetailsChecks = { analyses: 0 };
  const setFrame = WebGLRenderer.prototype.setFrame, analyze = AnalysisPool.prototype.analyze;
  WebGLRenderer.prototype.setFrame = function(...args) { if (this.canvas.id === 'viewport') checks.renderer = this; return setFrame.apply(this, args); };
  AnalysisPool.prototype.analyze = function(...args) { checks.analyses++; return analyze.apply(this, args); };
  checks.activeTool = () => document.querySelector('[data-tool-button][aria-expanded="true"]')?.dataset.toolButton ?? null;
  checks.rows = () => Object.fromEntries([...document.querySelectorAll('#selection-data dt')].map(term => [term.textContent, term.nextElementSibling.textContent]));
  checks.propertyCoverage = () => {
    const r = checks.renderer, rows = checks.rows(), index = r.selected;
    const missing = [], wrong = [];
    for (const property of r.frame.properties) {
      const text = rows[property.name], value = property.data[index];
      if (text === undefined) { missing.push(property.name); continue; }
      if (property.categories) {
        const label = property.categories.find(category => category.id === value)?.label ?? 'Other';
        if (text !== `${label} (${value})`) wrong.push({ property: property.name, text, value, label });
      } else if (!Number.isFinite(value)) {
        if (!text.startsWith(String(value))) wrong.push({ property: property.name, text, value: String(value) });
      } else if (Math.abs(parseFloat(text) - value) > 1e-6 * Math.max(1, Math.abs(value)) || (property.unit && !text.endsWith(` ${property.unit}`))) wrong.push({ property: property.name, text, value });
    }
    return { properties: r.frame.properties.length, missing, wrong, id: rows.ID === String(r.frame.ids[index]), type: Boolean(rows.Type), cartesian: Boolean(rows.Cartesian), fractional: Boolean(rows.Fractional) };
  };
  checks.pickPoint = (wanted) => {
    const r = checks.renderer; r.render(performance.now(), { trackStats: false });
    const rect = r.canvas.getBoundingClientRect();
    for (let index = 0; index < r.atomCount; index++) {
      if (wanted !== null && wanted !== index) continue;
      const p = transformPoint(r.viewProjectionMatrix, ...r.displayPositions.slice(index * 3, index * 3 + 3));
      const x = rect.left + (p[0] / p[3] * .5 + .5) * rect.width, y = rect.top + (.5 - p[1] / p[3] * .5) * rect.height;
      if (document.elementFromPoint(x, y) === r.canvas && r.pick(x, y) === index) return { x, y, index, id: r.frame.ids[index] };
    }
    return null;
  };
  checks.measurement = () => {
    const text = document.getElementById('measurement-data').textContent;
    const vector = ['x', 'y', 'z'].map(axis => Number(text.match(new RegExp(`Δ${axis} = ([^ ]+) Å`))?.[1]));
    return { text, vector, distance: Number(text.match(/Distance: ([^ ]+) Å/)?.[1]) };
  };
  checks.exportRecipe = async () => {
    const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click; let blob;
    URL.createObjectURL = function(value) { blob = value; return createUrl.call(this, value); };
    HTMLAnchorElement.prototype.click = () => {};
    try { document.getElementById('export-configuration').click(); return JSON.parse(await blob.text()); }
    finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
  checks.exportPng = async (saveReference) => {
    const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    let resolveBlob; const received = new Promise(resolve => { resolveBlob = resolve; });
    URL.createObjectURL = function(blob) { if (blob.type === 'image/png') resolveBlob(blob); return createUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = () => {};
    try {
      document.getElementById('export-png').click(); const blob = await received;
      const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let changedPixels = 0;
      if (saveReference) checks.pngReference = pixels;
      else { if (pixels.length !== checks.pngReference.length) throw new Error('PNG dimensions changed with overlay expansion.'); for (let offset = 0; offset < pixels.length; offset += 4) if ([0, 1, 2, 3].some(channel => pixels[offset + channel] !== checks.pngReference[offset + channel])) changedPixels++; }
      const data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
      return { width: canvas.width, height: canvas.height, changedPixels, data };
    } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
  checks.cameraAndViewport = () => {
    const r = checks.renderer, rect = r.canvas.getBoundingClientRect();
    return { yaw: r.yaw, pitch: r.pitch, pan: [...r.pan], target: [...r.target], distance: r.distance, scale: r.orthographicScale, projection: r.projectionMode,
      canvas: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, pageScroll: scrollY };
  };
  // Open panels and the overlay toggles must not cover one another or the view toolbar.
  checks.overlayCollisions = () => {
    const box = element => { const rect = element?.getBoundingClientRect(); return rect?.width && rect.height ? rect : null; };
    const items = [['toolbar', document.querySelector('.view-toolbar')], ['details-toggle', document.getElementById('toggle-atom-details')],
      ['view-toggle', document.getElementById('toggle-view-controls')], ['legend-toggle', document.getElementById('toggle-legend')],
      ['details-panel', document.getElementById('atom-details')], ['legend-panel', document.getElementById('legend')]]
      .map(([name, element]) => [name, box(element)]).filter(([, rect]) => rect);
    const collisions = [];
    for (let first = 0; first < items.length; first++) for (let second = first + 1; second < items.length; second++) {
      const [a, b] = [items[first][1], items[second][1]];
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) collisions.push(`${items[first][0]}×${items[second][0]}`);
    }
    return collisions;
  };
  checks.overlayState = () => {
    const expanded = id => document.getElementById(id).getAttribute('aria-expanded') === 'true';
    return { details: expanded('toggle-atom-details'), view: expanded('toggle-view-controls'), legend: expanded('toggle-legend'),
      detailsInert: document.getElementById('atom-details').inert, viewInert: document.getElementById('view-controls').inert, legendInert: document.getElementById('legend').inert };
  };
}
