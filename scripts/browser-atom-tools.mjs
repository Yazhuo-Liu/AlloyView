import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { crystalFrame } from '../tests/helpers/crystals.js';

/** Integration coverage uses real local files, shared Workers and WebGL layers. */
export async function runAtomToolsSmoke({ call, evaluate, waitFor, showTool, exportConfiguration, reloadPage, compareSettings, profile, screenshots = false }) {
  await reloadPage();
  await waitFor('document.readyState === "complete" && !document.getElementById("export-configuration").hidden', 'fresh atom tools page');
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', appUrl));
    const setFrame = WebGLRenderer.prototype.setFrame;
    window.atomToolsRenderers = [];
    WebGLRenderer.prototype.setFrame = function(...args) {
      if (this.canvas.id === 'viewport') window.atomToolsRenderer = this;
      if (!window.atomToolsRenderers.includes(this)) window.atomToolsRenderers.push(this);
      return setFrame.apply(this, args);
    };
    const WorkerClass = window.Worker;
    window.atomToolsWorkers = [];
    window.Worker = class extends WorkerClass {
      constructor(...args) {
        super(...args);
        if (String(args[0]).includes('analysis-worker')) window.atomToolsWorkers.push(this);
      }
    };
  })()`);
  async function change(id, value, event = 'change') {
    await evaluate(`(() => { const field = document.getElementById(${JSON.stringify(id)}); ${typeof value === 'boolean' ? `field.checked = ${value}` : `field.value = ${JSON.stringify(String(value))}`}; field.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
  }
  async function click(id) { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); }
  async function loadFile(path, name) {
    const { root } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
    await call('DOM.setFileInputFiles', { nodeId, files: [path] });
    await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(name)} && document.getElementById('loading').hidden`, `local ${name}`);
  }
  async function collectDownload(button) {
    await evaluate(`(() => {
      window.atomToolsDownload = null;
      window.atomToolsOriginalUrl = URL.createObjectURL;
      window.atomToolsOriginalClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = function(blob) { window.atomToolsDownload = blob; return window.atomToolsOriginalUrl.call(this, blob); };
      HTMLAnchorElement.prototype.click = function() { window.atomToolsDownloadName = this.download; };
      document.getElementById(${JSON.stringify(button)}).click();
    })()`);
    try {
      await waitFor('Boolean(window.atomToolsDownload)', `${button} Blob`);
      return await evaluate(`(async () => {
        const blob = window.atomToolsDownload;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return { size: blob.size, type: blob.type, name: window.atomToolsDownloadName, head: Array.from(bytes.slice(0, 8)), text: blob.type.includes('text') || blob.type.includes('csv') ? await blob.text() : null };
      })()`);
    } finally {
      await evaluate('URL.createObjectURL = window.atomToolsOriginalUrl; HTMLAnchorElement.prototype.click = window.atomToolsOriginalClick');
    }
  }
  const source = crystalFrame('fcc', 3, 4);
  const trajectory = [];
  for (let frame = 0; frame < 2; frame += 1) {
    const scale = frame ? 1.02 : 1;
    trajectory.push(String(source.ids.length), `Lattice="${Array.from(source.cell.vectors, value => value * scale).join(' ')}" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1:force:R:3:energy:R:1 Step=${frame}`);
    for (let atom = 0; atom < source.ids.length; atom += 1) {
      const xyz = Array.from(source.positions.subarray(atom * 3, atom * 3 + 3), value => value * scale);
      trajectory.push(`Cu ${xyz.join(' ')} ${source.ids[atom]} 1 0.5 -0.25 ${atom / 100}`);
    }
  }
  const xyzPath = resolve(profile, 'worker-tools.extxyz');
  await writeFile(xyzPath, trajectory.join('\n') + '\n');
  await loadFile(xyzPath, 'worker-tools.extxyz');
  assert.equal(await evaluate('window.atomToolsRenderer.atomCount'), 108);
  assert.equal(await evaluate('document.getElementById("frame-count").textContent'), '2');
  assert.deepEqual(await evaluate('window.atomToolsRenderer.frame.properties.map(property => property.name)'), ['force_0', 'force_1', 'force_2', 'energy']);
  assert.deepEqual(await evaluate('window.atomToolsRenderer.frame.cell.pbc'), [true, true, true]);
  for (const tool of ['bonds', 'vectors', 'statistics', 'referenceStrain', 'localShear']) {
    await showTool(tool);
    assert.equal(await evaluate('[...document.querySelectorAll("[data-tool-panel]")].filter(panel => !panel.hidden).length'), 1);
  }

  await showTool('selection');
  await change('atom-search-id', 2);
  await click('find-atom');
  assert.match(await evaluate('document.getElementById("selection-data").textContent'), /2/);
  await click('center-atom');
  assert.deepEqual(await evaluate('window.atomToolsRenderer.target'), [0, 2, 2]);
  await change('measure-mode', true);
  await evaluate('window.atomToolsRenderer.onPick(0); window.atomToolsRenderer.onPick(1); window.atomToolsRenderer.onPick(2); window.atomToolsRenderer.onPick(3)');
  assert.match(await evaluate('document.getElementById("measurement-data").textContent'), /distance/i);
  assert.match(await evaluate('document.getElementById("measurement-data").textContent'), /angle/i);
  assert.match(await evaluate('document.getElementById("measurement-data").textContent'), /dihedral/i);
  const measurementSettings = (await exportConfiguration()).settings.extensions.measurements;
  assert.equal(measurementSettings.enabled, true);
  assert.deepEqual(measurementSettings.atomIds, [1, 2, 3, 4]);
  await change('selected-atom-color', '#ff0088');
  await change('selected-atom-radius', .4);
  await click('apply-atom-style');
  assert.ok(Math.abs(await evaluate('window.atomToolsRenderer.atomRadii[3]') - .4) < 1e-6);
  await change('selected-atom-visible', false);
  await click('apply-atom-style');
  assert.equal(await evaluate('window.atomToolsRenderer.visibility[3]'), 0);
  await click('reset-atom-style');
  assert.ok(await evaluate('window.atomToolsRenderer.visibility[3] > 0'));
  await showTool('display');
  await evaluate(`(() => {
    const row = document.querySelector('#element-style-controls .element-style-row');
    const color = row.querySelector('input[type="color"]'), radius = row.querySelector('input[type="number"]');
    color.value = '#66ccaa'; color.dispatchEvent(new Event('change'));
    radius.value = '.9'; radius.dispatchEvent(new Event('change'));
  })()`);
  assert.ok(await evaluate('window.atomToolsRenderer.atomRadii.every(value => Math.abs(value - .9) < 1e-6)'));
  await evaluate(`(() => { const visible = document.querySelector('#element-style-controls input[type="checkbox"]'); visible.checked = false; visible.dispatchEvent(new Event('change')); })()`);
  assert.ok(await evaluate('window.atomToolsRenderer.visibility.every(value => value === 0)'));
  await evaluate(`(() => { const visible = document.querySelector('#element-style-controls input[type="checkbox"]'); visible.checked = true; visible.dispatchEvent(new Event('change')); })()`);

  await showTool('bonds');
  await change('bonds-cutoff', 3.1);
  await click('run-bonds');
  await waitFor('document.getElementById("bonds-state").textContent === "Calculated"', 'Worker bond calculation');
  assert.ok(await evaluate('window.atomToolsRenderer.primitiveLayer.bonds.count > 0'));
  assert.ok(await evaluate('window.atomToolsRenderer.frame.properties.find(property => property.name === "bondCoordination").data.every(value => value === 12)'));
  let workerCount = await evaluate('window.atomToolsWorkers.length');
  assert.ok(workerCount > 0 && workerCount <= 6);
  await evaluate(`(() => { const pair = document.querySelector('#bond-pair-cutoffs input'); pair.value = '0'; pair.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("bonds-state").textContent === "Calculated" && window.atomToolsRenderer.primitiveLayer.bonds.count === 0', 'element-pair bond cutoff exclusion');
  await evaluate(`(() => { const pair = document.querySelector('#bond-pair-cutoffs input'); pair.value = '3.1'; pair.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("bonds-state").textContent === "Calculated" && window.atomToolsRenderer.primitiveLayer.bonds.count > 0', 'element-pair bond cutoff restoration');
  await change('bonds-radius', .18);

  await showTool('vectors');
  for (const [id, value] of [['vector-x', 'force_0'], ['vector-y', 'force_1'], ['vector-z', 'force_2']]) await change(id, value);
  await change('vector-scale', .7);
  await change('show-vectors', true);
  assert.equal(await evaluate('window.atomToolsRenderer.primitiveLayer.vectors.length'), 108 * 3);
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.primitiveLayer.vectors.slice(0, 3))'), [1, .5, -.25]);

  await showTool('coordination');
  await change('cutoff', 3.1);
  await click('run-analysis');
  await waitFor('document.getElementById("analysis-state").textContent === "Calculated"', 'coordination histogram input');
  await showTool('statistics');
  assert.ok(await evaluate('document.getElementById("coordination-histogram").querySelector("svg") !== null'));
  await change('rdf-cutoff', 4);
  await change('rdf-bins', 40);
  await click('run-rdf');
  await waitFor('document.getElementById("rdf-state").textContent === "Calculated"', 'Worker RDF calculation');
  assert.ok(await evaluate('document.getElementById("rdf-chart").querySelector("svg") !== null'));
  const rdfCsv = await collectDownload('export-rdf');
  assert.ok(rdfCsv.text?.split('\n').length >= 40);

  await showTool('localShear');
  await change('local-shear-cutoff', 3.1);
  await evaluate('document.getElementById("run-local-shear").click(); document.getElementById("cancel-local-shear").click()');
  assert.equal(await evaluate('document.getElementById("local-shear-state").textContent'), 'Not calculated');
  assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.name === "localShear")'), false);
  await click('run-local-shear');
  await waitFor('document.getElementById("local-shear-state").textContent === "Calculated"', 'Worker local shear calculation');
  assert.ok(await evaluate('window.atomToolsRenderer.frame.properties.find(property => property.name === "localShear").data.every(value => Number.isFinite(value) && Math.abs(value) < 1e-5)'));

  await click('frame-next');
  await waitFor('document.getElementById("frame-label").textContent === "2 / 2" && document.getElementById("loading").hidden', 'expanded reference-strain frame');
  await showTool('referenceStrain');
  await change('reference-frame', 1);
  await change('reference-cutoff', 3.1);
  await click('run-reference-strain');
  await waitFor('document.getElementById("reference-strain-state").textContent === "Calculated"', 'Worker reference frame strain');
  assert.ok(await evaluate('window.atomToolsRenderer.frame.properties.find(property => property.name === "referenceHydrostaticStrain").data.every(value => Number.isFinite(value) && Math.abs(value - .0202) < 1e-4)'));
  assert.ok(await evaluate('window.atomToolsRenderer.frame.properties.find(property => property.name === "referenceShearStrain").data.every(value => Number.isFinite(value) && Math.abs(value) < 1e-4)'));
  await waitFor('["bonds-state", "rdf-state", "local-shear-state"].every(id => document.getElementById(id).textContent === "Calculated")', 'concurrent frame analysis completion');
  workerCount = await evaluate('window.atomToolsWorkers.length');
  assert.ok(workerCount > 0 && workerCount <= 6, 'concurrent analyses must share the bounded Worker pool');
  await click('cancel-local-shear');
  await click('run-local-shear');
  await waitFor('document.getElementById("local-shear-state").textContent === "Calculated"', 'local shear after shared pool warmup');
  assert.equal(await evaluate('window.atomToolsWorkers.length'), workerCount, 'repeating an analysis should reuse warm Workers');

  await showTool('display');
  await change('compare-preset', 'top');
  await change('compare-view', true);
  await waitFor('Boolean(document.querySelector(".comparison-view canvas"))', 'simultaneous second view');
  const gpu = await evaluate(`(() => {
    const renderers = window.atomToolsRenderers.filter(renderer => renderer.frame);
    for (const renderer of renderers) renderer.render(performance.now(), { trackStats: false });
    return renderers.map(renderer => ({ atoms: renderer.atomCount, error: renderer.gl.getError() }));
  })()`);
  assert.ok(gpu.length >= 2);
  assert.ok(gpu.every(view => view.atoms === 108 && view.error === 0));
  assert.ok(await evaluate(`window.atomToolsRenderers.filter(view => view.frame && view.canvas.id !== 'viewport').every(view => view.primitiveLayer?.bonds?.count === window.atomToolsRenderer.primitiveLayer.bonds.count && view.primitiveLayer?.vectors?.length === 108 * 3)`), 'both views should display the same bonds and vector arrows');
  const jpg = await collectDownload('export-jpg');
  assert.equal(jpg.type, 'image/jpeg');
  assert.deepEqual(jpg.head.slice(0, 3), [255, 216, 255]);
  const eps = await collectDownload('export-eps');
  assert.deepEqual(eps.head.slice(0, 4), [37, 33, 80, 83]);
  const sixViews = await collectDownload('export-multiview');
  assert.equal(sixViews.type, 'image/png');
  assert.deepEqual(sixViews.head, [137, 80, 78, 71, 13, 10, 26, 10]);
  const visibleIds = await collectDownload('export-atom-indices');
  assert.ok(visibleIds.text?.includes('1'));
  await change('export-series-first', 1);
  await change('export-series-last', 2);
  for (const manualFrameChange of [false, true]) {
    const camera = await evaluate(`JSON.parse(JSON.stringify(Object.fromEntries(['yaw', 'pitch', 'distance', 'orthographicScale', 'projectionMode', 'target', 'pan'].map(key => [key, window.atomToolsRenderer[key]]))))`);
    await evaluate(`(() => {
      window.cancelledZipCount = 0;
      window.cancelOriginalUrl = URL.createObjectURL;
      window.cancelOriginalClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = function(blob) { if (blob.type.includes('zip')) window.cancelledZipCount++; return window.cancelOriginalUrl.call(this, blob); };
      HTMLAnchorElement.prototype.click = () => {};
      document.getElementById('export-frame-series').click();
      document.getElementById('cancel-frame-series').click();
      ${manualFrameChange ? `const slider = document.getElementById('frame-slider'); slider.value = '0'; slider.dispatchEvent(new Event('input', { bubbles: true }));` : ''}
    })()`);
    try {
      await waitFor('document.getElementById("export-series-status").textContent === "Export cancelled." && !document.getElementById("export-frame-series").disabled', 'immediate frame export cancellation');
      assert.equal(await evaluate('window.cancelledZipCount'), 0);
      await waitFor(`window.atomToolsRenderer.frame.frameIndex === ${manualFrameChange ? 0 : 1} && document.getElementById('loading').hidden`, 'cancelled export frame ownership');
      if (!manualFrameChange) compareSettings(await evaluate(`Object.fromEntries(['yaw', 'pitch', 'distance', 'orthographicScale', 'projectionMode', 'target', 'pan'].map(key => [key, window.atomToolsRenderer[key]]))`), camera, 'cancelled export camera');
    } finally {
      await evaluate('URL.createObjectURL = window.cancelOriginalUrl; HTMLAnchorElement.prototype.click = window.cancelOriginalClick');
    }
  }
  await click('frame-last');
  await waitFor('window.atomToolsRenderer.frame.frameIndex === 1 && document.getElementById("loading").hidden', 'frame restored before full export');
  const frameZip = await collectDownload('export-frame-series');
  assert.deepEqual(frameZip.head.slice(0, 4), [80, 75, 3, 4]);
  await waitFor('document.getElementById("export-series-status").textContent.includes("Exported") && !document.getElementById("export-frame-series").disabled', 'frame archive completion and restored view');

  const recipe = await exportConfiguration();
  assert.equal(recipe.settings.extensions.bonds.enabled, true);
  assert.equal(recipe.settings.extensions.vectors.enabled, true);
  assert.equal(recipe.settings.extensions.referenceStrain.enabled, true);
  assert.equal(recipe.settings.extensions.localShear.enabled, true);
  assert.equal(recipe.settings.extensions.rdf.enabled, true);
  assert.equal(recipe.settings.extensions.comparison.enabled, true);
  const recipePath = resolve(profile, 'atom-tools-recipe.json');
  await writeFile(recipePath, JSON.stringify(recipe));
  for (const id of ['cancel-bonds', 'cancel-rdf', 'cancel-reference-strain', 'cancel-local-shear']) await click(id);
  await change('show-vectors', false);
  await change('compare-view', false);
  const { root: recipeRoot } = await call('DOM.getDocument');
  const { nodeId: recipeInput } = await call('DOM.querySelector', { nodeId: recipeRoot.nodeId, selector: '#configuration-file' });
  await call('DOM.setFileInputFiles', { nodeId: recipeInput, files: [recipePath] });
  await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("reference-strain-state").textContent === "Calculated"', 'new-feature configuration replay');
  compareSettings((await exportConfiguration()).settings.extensions, recipe.settings.extensions, 'atom tools extensions');

  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await showTool('statistics');
  const phone = await evaluate(`(() => {
    const viewport = document.getElementById('viewport').getBoundingClientRect();
    const sidebar = document.getElementById('sidebar').getBoundingClientRect();
    const comparison = document.querySelector('.comparison-view').getBoundingClientRect();
    document.getElementById('sidebar').scrollTop = 250;
    const after = document.getElementById('viewport').getBoundingClientRect();
    return { below: sidebar.top >= viewport.bottom, fixed: after.top === viewport.top, inset: comparison.right <= viewport.right && comparison.bottom <= viewport.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  assert.deepEqual(phone, { below: true, fixed: true, inset: true, overflow: false });
  if (screenshots) {
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/alloyview-atom-tools-phone.png', Buffer.from(capture.data, 'base64'));
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const disabled = structuredClone(recipe);
  for (const kind of ['bonds', 'vectors', 'referenceStrain', 'localShear', 'rdf', 'measurements', 'comparison']) disabled.settings.extensions[kind].enabled = false;
  disabled.settings.extensions.appearance = { atoms: [], elements: [] };
  disabled.settings.display.colorMode = 'type';
  const disabledPath = resolve(profile, 'atom-tools-disabled.json');
  await writeFile(disabledPath, JSON.stringify(disabled));
  await call('DOM.setFileInputFiles', { nodeId: recipeInput, files: [disabledPath] });
  await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("bonds-state").textContent === "Not calculated"', 'disabled extensions configuration replay');
  for (const index of [1, 0]) {
    await click(index ? 'frame-last' : 'frame-first');
    await waitFor(`window.atomToolsRenderer.frame.frameIndex === ${index} && document.getElementById('loading').hidden`, 'cleared cached feature frame');
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.name.startsWith("reference") || ["localShear", "bondCoordination"].includes(property.name))'), false);
    assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.bonds || window.atomToolsRenderer.primitiveLayer?.vectors)'), false);
  }
  assert.equal(await evaluate('document.getElementById("show-vectors").checked || document.getElementById("compare-view").checked || document.getElementById("measure-mode").checked'), false);

  // PDB goes through the actual parser Worker. Open boundaries reject RDF.
  const pdbPath = resolve(profile, 'atom-tools.pdb');
  await writeFile(pdbPath, 'ATOM      1  CA  ALA A   1       1.000   2.000   3.000  1.00 10.00           C  \nATOM      2  N   ALA A   1       2.000   2.000   3.000  1.00 10.00           N  \nEND\n');
  await loadFile(pdbPath, 'atom-tools.pdb');
  assert.equal(await evaluate('window.atomToolsRenderer.atomCount'), 2);
  assert.deepEqual(await evaluate('window.atomToolsRenderer.frame.cell.pbc'), [false, false, false]);
  await showTool('statistics');
  await click('run-rdf');
  await waitFor('document.getElementById("rdf-state").textContent !== "Calculating…"', 'nonperiodic RDF rejection');
  assert.notEqual(await evaluate('document.getElementById("rdf-state").textContent'), 'Calculated');
  console.log(`AtomEye alignment browser checks passed: XYZ/PDB parsing; ID lookup and centering; distance/angle/dihedral picks; atom and element appearance; pair-cutoff bonds and vectors; coordination histogram and RDF CSV; reference strain and local shear; cancellation; ${workerCount} reused Workers; simultaneous views with matching primitives and phone layout; JPG/EPS, six-view PNG, frame ZIP and visible IDs; configuration replay.`);
}
