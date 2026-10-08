import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crystalFrame, dumpText } from '../tests/helpers/crystals.js';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-orientation-'));
const fixture = resolve(temporary, 'orientation-discrete.dump');
const first = crystalFrame('fcc', 3), second = crystalFrame('fcc', 3), third = crystalFrame('fcc', 3);
first.properties = [{ name: 'phase', data: Float64Array.from(first.ids, (_, atom) => [9, -3, 4][atom % 3]) }];
second.properties = [{ name: 'phase', data: Float64Array.from(second.ids, (_, atom) => [-3, 9, 7][atom % 3]) }];
third.properties = [{ name: 'phase', data: Float64Array.from(third.ids, (_, atom) => atom % 33) }];
await writeFile(fixture, dumpText([first, second, third], { element: 'Al' }));

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeout = 90_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({toast:document.getElementById("toast")?.textContent,ptm:document.getElementById("ptm-status")?.textContent,recipe:document.getElementById("configuration-status")?.textContent})')}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("color-mode")', 'Page startup');
    await evaluate(`(${initializeChecks.toString()})()`);
    if (await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed") === "true"')) await evaluate('document.getElementById("enable-gpu-computing").click()');
    const { root: document } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
    await call('DOM.setFileInputFiles', { nodeId, files: [fixture] });
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    await waitFor('colorChecks.renderer?.frame && document.getElementById("loading").hidden', 'Fixture load');
    const change = (id, value) => evaluate(`colorChecks.change(${JSON.stringify(id)},${JSON.stringify(value)})`);
    await change('legend-color-mode', 'property:phase');
    assert.equal(await evaluate('document.getElementById("legend-scale-mode").value'), 'continuous', 'Imported integers remain continuous by default.');
    await change('legend-scale-mode', 'discrete');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#color-legend [data-category-id]"),input=>input.dataset.categoryId)'), ['-3', '4', '9']);
    const originalColor = await evaluate('Array.from(colorChecks.renderer.atomColors.slice(0,3))');
    await evaluate('colorChecks.renderer.onPick(1)');
    assert.match(await evaluate('document.getElementById("hide-selected-class").textContent'), /Hide -3 atoms/);
    await evaluate('document.getElementById("hide-selected-class").click()');
    assert.deepEqual(await evaluate('Array.from(colorChecks.renderer.visibility.slice(0,3))'), [255, 0, 255]);
    const discreteRecipe = await evaluate('colorChecks.exportRecipe()');
    assert.deepEqual(discreteRecipe.settings.colors.modes, [{ property: 'phase', mode: 'discrete' }]);
    assert.deepEqual(discreteRecipe.settings.colors.hiddenCategories.find(item => item.property === 'phase').ids, [-3]);
    await evaluate('document.getElementById("frame-next").click()');
    await waitFor('colorChecks.renderer.frame.frameIndex === 1 && document.getElementById("legend-scale-mode")?.value === "discrete"', 'Discrete frame 2');
    assert.deepEqual(await evaluate('Array.from(colorChecks.renderer.visibility.slice(0,3))'), [0, 255, 255]);
    assert.deepEqual(await evaluate('Array.from(colorChecks.renderer.atomColors.slice(3,6))'), originalColor, 'Value 9 retains its color after categories change order.');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#color-legend [data-category-id]"),input=>input.dataset.categoryId)'), ['-3', '7', '9']);
    const discreteExport = await evaluate('colorChecks.captureLegend()');
    assert.ok(discreteExport.changedPixels > 100, 'Discrete legend is included in PNG rendering.');
    await evaluate('document.getElementById("frame-next").click()');
    await waitFor('colorChecks.renderer.frame.frameIndex === 2 && document.getElementById("legend-scale-mode")?.value === "continuous"', '33-value fallback');
    assert.equal(await evaluate('document.getElementById("legend-scale-mode").options[1].disabled'), true);
    await evaluate('document.getElementById("frame-previous").click()');
    await waitFor('colorChecks.renderer.frame.frameIndex === 1 && document.getElementById("legend-scale-mode")?.value === "discrete"', 'Eligible frame resumes discrete colors');
    await evaluate('document.querySelector("#color-legend [data-legend-action=select-all]").click()');
    // The actual production legend must remain accessible with 32 classes on
    // a short desktop. Temporarily change the imported scalar, then restore it.
    await evaluate('colorChecks.originalPhase = colorChecks.renderer.frame.properties.find(property=>property.name==="phase").data; colorChecks.renderer.frame.properties.find(property=>property.name==="phase").data = Float64Array.from(colorChecks.renderer.frame.ids,(_,atom)=>atom%32)');
    await change('legend-color-mode', 'property:phase');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 600, deviceScaleFactor: 1, mobile: false });
    const tallLegend = await evaluate(`(()=>{const legend=document.getElementById('legend'), viewport=document.querySelector('.viewport-panel');
      const rows=document.querySelectorAll('#color-legend [data-category-id]');return {count:rows.length,top:legend.getBoundingClientRect().top,
        viewportTop:viewport.getBoundingClientRect().top,scrollable:legend.scrollHeight>legend.clientHeight};})()`);
    assert.equal(tallLegend.count, 32);
    assert.ok(tallLegend.top >= tallLegend.viewportTop, 'A large integer legend retains its controls inside the viewport.');
    assert.equal(tallLegend.scrollable, true, 'Every integer class remains reachable by scrolling.');
    await evaluate('document.getElementById("legend").scrollTop = document.getElementById("legend").scrollHeight; colorChecks.renderer.frame.properties.find(property=>property.name==="phase").data = colorChecks.originalPhase');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await change('legend-color-mode', 'property:phase');
    await change('legend-scale-mode', 'continuous');
    await evaluate(`colorChecks.importRecipe(${JSON.stringify(JSON.stringify(discreteRecipe))})`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("legend-scale-mode")?.value === "discrete" && colorChecks.renderer.frame.frameIndex === 0', 'Discrete recipe restore');
    assert.equal(await evaluate('colorChecks.renderer.visibility[1]'), 0);
    await evaluate('document.querySelector("#color-legend [data-legend-action=select-all]").click()');
    await evaluate('document.querySelector("[data-tool-button=ptm]").click(); document.getElementById("run-ptm").click()');
    await waitFor('document.getElementById("ptm-state").textContent === "Calculated" && colorChecks.renderer.frame.ptm?.orientations', 'CPU PTM');
    await change('legend-color-mode', 'builtin:ptm:ipf');
    assert.equal(await evaluate('document.querySelectorAll(".legend-ipf-key").length'), 1);
    assert.deepEqual(await evaluate('Array.from(colorChecks.renderer.atomColors.slice(0,3))'), [255, 0, 0]);
    await change('legend-ipf-direction', 'custom');
    for (const axis of ['x', 'y', 'z']) await change(`legend-ipf-${axis}`, '1');
    assert.deepEqual(await evaluate('Array.from(colorChecks.renderer.atomColors.slice(0,3))'), [0, 0, 255]);
    assert.equal(await evaluate('colorChecks.parity()'), true, 'Live colors equal the scientific IPF resolver for every atom.');
    const orientationRecipe = await evaluate('colorChecks.exportRecipe()');
    assert.equal(orientationRecipe.settings.display.colorMode, 'builtin:ptm:ipf');
    assert.deepEqual(orientationRecipe.settings.colors.orientation, { direction: 'custom', custom: [1, 1, 1] });
    const ipfExport = await evaluate('colorChecks.captureLegend()');
    assert.ok(ipfExport.changedPixels > 500, 'IPF key is included in PNG rendering.');
    assert.ok(ipfExport.redPixels > 10 && ipfExport.greenPixels > 10 && ipfExport.bluePixels > 10, 'PNG key contains all three primary color corners.');
    await evaluate('document.getElementById("compare-view").checked = true; document.getElementById("compare-view").dispatchEvent(new Event("change",{bubbles:true}))');
    await waitFor('colorChecks.secondary?.frame', 'Second view');
    assert.equal(await evaluate('colorChecks.secondary.atomColors.every((value,index)=>value===colorChecks.renderer.atomColors[index])'), true);
    await change('legend-color-mode', 'builtin:ptm:quaternion');
    assert.equal(await evaluate('document.querySelectorAll(".legend-ipf-key").length'), 0);
    assert.deepEqual(await evaluate('Array.from(colorChecks.renderer.atomColors.slice(0,3))'), [128, 128, 128]);
    await evaluate(`colorChecks.importRecipe(${JSON.stringify(JSON.stringify(orientationRecipe))})`);
    await waitFor('document.getElementById("legend-ipf-direction")?.value === "custom" && document.getElementById("legend-ipf-x")?.value === "1"', 'Orientation recipe restore');
    assert.deepEqual(await evaluate('Array.from(colorChecks.renderer.atomColors.slice(0,3))'), [0, 0, 255]);
    await evaluate('document.getElementById("cancel-ptm").click(); document.querySelector("[data-tool-button=strain]").click(); document.getElementById("run-strain").click()');
    await waitFor('document.getElementById("strain-state").textContent === "Calculated" && colorChecks.renderer.frame.ptm?.orientations && !colorChecks.renderer.frame.properties.some(property=>property.name==="ptmStructureType")', 'Strain-only cached PTM fit');
    await change('legend-color-mode', 'builtin:ptm:ipf');
    assert.equal(await evaluate('colorChecks.parity()'), true, 'Strain-only orientation colors reuse the completed fit.');
    const strainRecipe = await evaluate('colorChecks.exportRecipe()');
    assert.equal(strainRecipe.settings.analyses.ptm.enabled, false);
    assert.equal(strainRecipe.settings.analyses.strain.enabled, true);
    await change('legend-color-mode', 'type');
    await evaluate(`colorChecks.importRecipe(${JSON.stringify(JSON.stringify(strainRecipe))})`);
    await waitFor('document.getElementById("legend-ipf-direction") && document.getElementById("strain-state").textContent === "Calculated" && !colorChecks.renderer.frame.properties.some(property=>property.name==="ptmStructureType")', 'Strain-only orientation recipe restore');
    await evaluate('document.getElementById(document.documentElement.dataset.theme === "dark" ? "theme-light" : "theme-dark").click()');
    await change('legend-ipf-direction', 'z');
    assert.ok((await evaluate('colorChecks.captureLegend()')).changedPixels > 500, 'IPF export works in the alternate theme.');
    const desktop = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(tmpdir(), 'alloyview-orientation-desktop.png'), Buffer.from(desktop.data, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('document.getElementById("toggle-legend").click()');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'Mobile key does not widen the page.');
    await evaluate('(()=>{const legend=document.getElementById("legend"),key=document.querySelector(".legend-ipf-key");legend.scrollTop+=key.getBoundingClientRect().top-legend.getBoundingClientRect().top-8;})()');
    const mobile = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(tmpdir(), 'alloyview-orientation-mobile.png'), Buffer.from(mobile.data, 'base64'));
    return { atoms: first.ids.length, discreteExport, ipfExport, scientificParity: true, recipeRestore: true, secondView: true,
      screenshots: ['/tmp/alloyview-orientation-desktop.png', '/tmp/alloyview-orientation-mobile.png'] };
  }, { software: useSoftwareAdapter(true), requireGpu: false });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { OrientationColorResolver }, { colorsByDiscreteProperty }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./render/orientation-colors.js', app)),
    import(new URL('./render/discrete-colors.js', app)),
  ]);
  const checks = window.colorChecks = {};
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this; else checks.secondary = this;
    return setFrame.apply(this, args);
  };
  checks.change = (id, value) => { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); };
  checks.orientationSettings = () => ({ direction: document.getElementById('legend-ipf-direction')?.value ?? 'z',
    custom: ['x', 'y', 'z'].map(axis => Number(document.getElementById(`legend-ipf-${axis}`)?.value ?? (axis === 'z' ? 1 : 0))) });
  checks.parity = () => {
    const palette = new OrientationColorResolver().resolve(checks.renderer.frame, document.getElementById('color-mode').value, checks.orientationSettings());
    return palette.colors.every((value, index) => value === checks.renderer.atomColors[index]);
  };
  checks.captureLegend = () => {
    const mode = document.getElementById('color-mode').value;
    const palette = mode.startsWith('builtin:ptm:') ? new OrientationColorResolver().resolve(checks.renderer.frame, mode, checks.orientationSettings())
      : colorsByDiscreteProperty(checks.renderer.frame.properties.find(property => property.name === 'phase'));
    const without = checks.renderer.captureImage({ includeBackground: true });
    const withLegend = checks.renderer.captureImage({ includeBackground: true, legend: palette.legend });
    const a = without.getContext('2d').getImageData(0, 0, without.width, without.height).data;
    const b = withLegend.getContext('2d').getImageData(0, 0, withLegend.width, withLegend.height).data;
    let changedPixels = 0, redPixels = 0, greenPixels = 0, bluePixels = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2]) {
        changedPixels++;
        if (b[i] > 220 && b[i+1] < 120 && b[i+2] < 120) redPixels++;
        if (b[i+1] > 220 && b[i] < 120 && b[i+2] < 120) greenPixels++;
        if (b[i+2] > 220 && b[i] < 120 && b[i+1] < 120) bluePixels++;
      }
    }
    return { width: withLegend.width, height: withLegend.height, changedPixels, redPixels, greenPixels, bluePixels };
  };
  checks.exportRecipe = async () => {
    const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    let blob;
    URL.createObjectURL = value => { blob = value; return create.call(URL, value); };
    HTMLAnchorElement.prototype.click = function() {};
    try { document.getElementById('export-configuration').click(); return JSON.parse(await blob.text()); }
    finally { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; }
  };
  checks.importRecipe = text => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], 'color-recipe.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
}
