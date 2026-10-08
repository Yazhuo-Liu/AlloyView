import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { crystalFrame } from '../tests/helpers/crystals.js';

/** Integration coverage uses real local files, shared Workers and WebGL layers. */
export async function runAtomToolsSmoke({ call, evaluate, waitFor, showTool, exportConfiguration, reloadPage, compareSettings, profile, screenshots = false }) {
  await reloadPage();
  await waitFor('document.readyState === "complete" && !document.getElementById("export-configuration").hidden', 'fresh atom tools page');
  assert.equal(await evaluate('document.querySelector("[data-tool-button=configuration]")'), null);
  assert.equal(await evaluate('document.querySelector("[data-tool-button=selection]")'), null, 'Atom details is a viewport overlay rather than a sidebar tool');
  assert.equal(await evaluate('document.getElementById("tool-selection")'), null);
  assert.equal(await evaluate('document.getElementById("configuration-section").hidden'), false, 'configuration import is available before opening a structure');
  assert.equal(await evaluate('document.getElementById("export-eps")'), null, 'raster EPS export is removed');
  const configurationPlacement = await evaluate(`(() => {
    const section = document.getElementById('configuration-section');
    const structure = document.getElementById('file-name').closest('.side-section');
    const tools = document.querySelector('[data-tool-button]').closest('.side-section');
    return Boolean(structure.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(section.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING)
      && !section.hasAttribute('data-tool-panel');
  })()`);
  assert.equal(configurationPlacement, true, 'configuration belongs between Structure and Tools');
  await waitFor('Boolean(document.querySelector(".feature-help-link")) && Boolean(document.getElementById("feature-help-styles")?.sheet)', 'feature documentation help');
  const documentation = await evaluate(`(async () => {
    const github = document.getElementById('github-link');
    const overview = document.getElementById('documentation-link');
    const panels = [...document.querySelectorAll('[data-tool-panel], [data-feature-help]'), document.getElementById('configuration-section')];
    const links = panels.map(panel => panel.querySelector('.feature-help-link'));
    const urls = [...new Set([overview.href, ...links.map(link => link?.href)])];
    const pages = await Promise.all(urls.map(async url => {
      const response = await fetch(url), html = await response.text();
      return { url, status: response.status, isPage: /<html[\\s>]/i.test(html) && /<h1[\\s>]/i.test(html) };
    }));
    return {
      github: github.href,
      panelLinks: links.every(link => link?.target === '_blank' && Boolean(link.getAttribute('aria-describedby'))),
      pages,
    };
  })()`);
  assert.match(documentation.github, /^https:\/\/github\.com\/Yazhuo-Liu\/AlloyView\/?$/);
  assert.equal(documentation.panelLinks, true, 'each tool, Atom details overlay, and configuration panel opens its own help page');
  assert.ok(documentation.pages.every(page => page.status === 200 && page.isPage), JSON.stringify(documentation.pages));
  assert.ok(documentation.pages.every(page => new URL(page.url).pathname.startsWith('/AlloyView/docs/')), 'documentation links retain the GitHub Pages project prefix');
  await evaluate(`document.querySelector('#configuration-section .feature-help-link').focus()`);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#configuration-section .feature-help-tooltip")).display'), 'block', 'help text appears for keyboard focus');
  await evaluate(`document.querySelector('#configuration-section .feature-help-link').blur()`);
  const displayHelp = await evaluate(`(async () => {
    const link = document.querySelector('#tool-display .feature-help-link'); link.focus();
    await new Promise(requestAnimationFrame);
    const tooltip = document.getElementById(link.getAttribute('aria-describedby'));
    const rect = tooltip.getBoundingClientRect();
    const within = rect.left >= 7 && rect.top >= 7 && rect.right <= innerWidth - 7 && rect.bottom <= innerHeight - 7;
    const visible = getComputedStyle(tooltip).display === 'block';
    const bounds = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    const anchor = link.getBoundingClientRect();
    const diagnostics = { bounds, viewport: [innerWidth, innerHeight], client: [document.documentElement.clientWidth, document.documentElement.clientHeight], anchor: [anchor.left, anchor.top, anchor.right, anchor.bottom], position: getComputedStyle(tooltip).position, inlineStyle: tooltip.style.cssText, focused: document.activeElement === link };
    link.blur(); return { within, visible, diagnostics };
  })()`);
  assert.ok(displayHelp.within && displayHelp.visible, `the short Display heading places its help bubble inside the viewport: ${JSON.stringify(displayHelp)}`);
  const displayHelpPoint = await evaluate(`(() => { const rect = document.querySelector('#tool-display .feature-help-link').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...displayHelpPoint });
  const hoveredHelp = await evaluate(`(async () => {
    await new Promise(requestAnimationFrame);
    const tooltip = document.querySelector('#tool-display .feature-help-tooltip'), rect = tooltip.getBoundingClientRect();
    return { visible: getComputedStyle(tooltip).display === 'block', within: rect.left >= 7 && rect.top >= 7 && rect.right <= innerWidth - 7 && rect.bottom <= innerHeight - 7 };
  })()`);
  assert.deepEqual(hoveredHelp, { visible: true, within: true }, 'genuine mouse hover also positions the help bubble within the viewport');
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20 });
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', appUrl));
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const analyze = AnalysisPool.prototype.analyze;
    window.atomToolsAnalysisCalls = 0;
    window.atomToolsAnalysisKinds = [];
    AnalysisPool.prototype.analyze = function(...args) { window.atomToolsAnalysisCalls++; window.atomToolsAnalysisKinds.push(args[1]?.kind); return analyze.apply(this, args); };
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
  async function openAtomDetails() {
    const activeTool = await evaluate('document.querySelector("[data-tool-button][aria-expanded=true]")?.dataset.toolButton');
    await evaluate(`if (document.getElementById('toggle-atom-details').getAttribute('aria-expanded') !== 'true') document.getElementById('toggle-atom-details').click()`);
    await waitFor('document.getElementById("toggle-atom-details").getAttribute("aria-expanded") === "true" && !document.getElementById("atom-details").inert', 'Atom details overlay');
    assert.equal(await evaluate('document.querySelector("[data-tool-button][aria-expanded=true]")?.dataset.toolButton'), activeTool, 'opening Atom details preserves the active sidebar tool');
  }
  async function openAtomAppearance() {
    await evaluate(`if (!document.getElementById('selected-atom-appearance').open) document.querySelector('#selected-atom-appearance summary').click()`);
  }
  async function assertVectorGroups(expected) {
    const groups = await evaluate(`(() => {
      const ids = ['vector-components', 'vector-component-scales'];
      return Object.fromEntries(ids.map(id => {
        const element = document.getElementById(id), rect = element.getBoundingClientRect();
        return [id, { hidden: element.hidden, display: getComputedStyle(element).display, width: rect.width, height: rect.height }];
      }));
    })()`);
    for (const [id, visible] of Object.entries(expected)) {
      assert.equal(groups[id].hidden, !visible, `${id}: semantic visibility`);
      if (visible) {
        assert.notEqual(groups[id].display, 'none', `${id}: visible computed style`);
        assert.ok(groups[id].width > 0 && groups[id].height > 0, `${id}: visible layout box`);
      } else {
        assert.equal(groups[id].display, 'none', `${id}: hidden overrides grid CSS`);
        assert.equal(groups[id].width, 0, `${id}: hidden layout width`);
        assert.equal(groups[id].height, 0, `${id}: hidden layout height`);
      }
    }
  }
  async function waitVectorFields(prefix) {
    await waitFor(`['X', 'Y', 'Z', 'Magnitude'].every(suffix => window.atomToolsRenderer.frame.properties.some(property => property.name === ${JSON.stringify(prefix)} + suffix))`, `${prefix} physical scalar fields`);
  }
  async function arrowGpuCoverage(rendererExpression) {
    return evaluate(`(async () => {
      const renderer = ${rendererExpression}, gl = renderer.gl, layer = renderer.primitiveLayer;
      const originalDraw = gl.drawArraysInstanced, cellVisible = renderer.cellVisible;
      const queries = [];
      gl.drawArraysInstanced = function(...args) {
        const vectors = gl.getParameter(gl.CURRENT_PROGRAM) === layer.program && Boolean(gl.getUniform(layer.program, layer.uniforms.uVectorMode));
        if (!vectors) return originalDraw.apply(gl, args);
        const query = gl.createQuery(); queries.push(query);
        gl.beginQuery(gl.ANY_SAMPLES_PASSED, query);
        try { return originalDraw.apply(gl, args); } finally { gl.endQuery(gl.ANY_SAMPLES_PASSED); }
      };
      try {
        renderer.setCellVisible(false); renderer.render(performance.now(), { trackStats: false });
      } finally { gl.drawArraysInstanced = originalDraw; renderer.setCellVisible(cellVisible); }
      for (let attempt = 0; attempt < 100 && queries.some(query => !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      const results = queries.map(query => Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT)));
      queries.forEach(query => gl.deleteQuery(query));
      return { passes: results.length, covered: results.some(Boolean), error: gl.getError(), allAtomsHidden: renderer.visibility.every(value => value === 0) };
    })()`);
  }
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
    trajectory.push(String(source.ids.length), `Lattice="${Array.from(source.cell.vectors, value => value * scale).join(' ')}" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1:force:R:3:energy:R:1:all_nan:R:1 Step=${frame}`);
    for (let atom = 0; atom < source.ids.length; atom += 1) {
      const xyz = Array.from(source.positions.subarray(atom * 3, atom * 3 + 3), value => value * scale);
      trajectory.push(`Cu ${xyz.join(' ')} ${source.ids[atom]} 1 0.5 -0.25 ${atom / 100} NaN`);
    }
  }
  const xyzPath = resolve(profile, 'worker-tools.extxyz');
  await writeFile(xyzPath, trajectory.join('\n') + '\n');
  await loadFile(xyzPath, 'worker-tools.extxyz');
  assert.equal(await evaluate('window.atomToolsRenderer.atomCount'), 108);
  assert.equal(await evaluate('document.getElementById("frame-count").textContent'), '2');
  assert.deepEqual(await evaluate('window.atomToolsRenderer.frame.properties.map(property => property.name)'), ['force_0', 'force_1', 'force_2', 'energy', 'all_nan']);
  assert.deepEqual(await evaluate('window.atomToolsRenderer.frame.cell.pbc'), [true, true, true]);
  await showTool('vectors');
  assert.equal(await evaluate('document.getElementById("vector-mode").value'), 'generic', 'Vector is display-only and starts with custom components');
  assert.equal(await evaluate('document.getElementById("show-vectors").checked'), false);
  await assertVectorGroups({ 'vector-components': true, 'vector-component-scales': true });
  assert.equal(await evaluate('document.getElementById("vector-reference-controls")'), null, 'reference controls belong to Displacement rather than Vector');
  assert.deepEqual(await evaluate('Array.from(document.getElementById("vector-mode").options, option => option.value).filter(value => ["force", "velocity", "displacement"].includes(value))'), ['force'], 'only available imported presets appear before calculation');
  assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.name.startsWith("displacement"))'), false, 'opening a file or Vector panel does not calculate displacement');
  await showTool('displacement');
  await waitFor('document.getElementById("displacement-state").textContent === "Calculated"', 'opening Displacement starts its analysis');
  await waitVectorFields('displacement');
  assert.ok(await evaluate('window.atomToolsRenderer.frame.properties.filter(property => property.name.startsWith("displacement")).every(property => property.analysisKind === "displacement")'));
  assert.ok(await evaluate('window.atomToolsRenderer.frame.properties.find(property => property.name === "displacementMagnitude").data.every(value => value === 0)'), 'the first frame computes zero displacement independently of arrows');
  assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false);
  assert.ok(await evaluate('["displacementX", "displacementY", "displacementZ", "displacementMagnitude"].every(name => Array.from(document.getElementById("legend-color-mode").options).some(option => option.value === "property:" + name))'), 'computed vector components and magnitude are color choices');
  await change('legend-color-mode', 'property:displacementMagnitude');
  assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:displacementMagnitude');
  assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false, 'vector magnitude coloring does not enable arrows');
  await click('cancel-displacement');
  assert.equal(await evaluate('document.getElementById("displacement-state").textContent'), 'Not calculated');
  assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "displacement")'), false);
  assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'type', 'cancelling a selected displacement field restores type coloring');
  assert.equal(await evaluate('Array.from(document.getElementById("vector-mode").options).some(option => option.value === "displacement")'), false, 'cancelled displacement disappears from Vector sources');
  await change('legend-color-mode', 'property:all_nan');
  assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:all_nan');
  assert.match(await evaluate('document.querySelector(".legend-items").textContent'), /NaN/);
  await change('legend-color-mode', 'type');
  for (const tool of ['bonds', 'vectors', 'statistics', 'referenceStrain', 'localShear']) {
    await showTool(tool);
    assert.equal(await evaluate('[...document.querySelectorAll("[data-tool-panel]")].filter(panel => !panel.hidden).length'), 1);
  }

  await openAtomDetails();
  assert.equal(await evaluate('document.getElementById("selected-atom-appearance").open'), false, 'selected atom appearance starts collapsed');
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
  await openAtomAppearance();
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
  await change('vector-mode', 'generic');
  await assertVectorGroups({ 'vector-components': true, 'vector-component-scales': true });
  const namesBeforeVectorDisplay = await evaluate('window.atomToolsRenderer.frame.properties.map(property => property.name)');
  const importedForceValues = await evaluate('["force_0", "force_1", "force_2"].map(name => Array.from(window.atomToolsRenderer.frame.properties.find(property => property.name === name).data.slice(0, 8)))');
  for (const [id, value] of [['vector-x', 'force_0'], ['vector-y', 'force_1'], ['vector-z', 'force_2']]) await change(id, value);
  await change('vector-scale', .7);
  await change('show-vectors', true);
  assert.equal(await evaluate('window.atomToolsRenderer.primitiveLayer.vectors.length'), 108 * 3);
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.primitiveLayer.vectors.slice(0, 3))'), [1, .5, -.25]);
  assert.deepEqual(await evaluate('window.atomToolsRenderer.frame.properties.map(property => property.name)'), namesBeforeVectorDisplay, 'custom arrow display does not add computed scalar fields');
  await change('vector-mode', 'force');
  await waitFor('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)', 'force preset arrows');
  assert.equal(await evaluate('document.getElementById("vector-components").hidden'), true, 'common vector types replace custom component menus');
  await assertVectorGroups({ 'vector-components': false, 'vector-component-scales': false });
  assert.deepEqual(await evaluate('window.atomToolsRenderer.frame.properties.map(property => property.name)'), namesBeforeVectorDisplay, 'imported vector presets do not generate magnitude or component properties');
  await change('show-vectors', false);
  assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false);
  await change('legend-color-mode', 'property:force_0');
  assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:force_0');
  assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false);
  await change('legend-color-mode', 'type');
  await change('show-vectors', true);
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.primitiveLayer.vectors.slice(0, 3))'), [1, .5, -.25]);
  assert.equal(await evaluate('Array.from(document.getElementById("vector-mode").options).some(option => option.value === "velocity")'), false, 'unavailable velocity is absent from Vector sources');
  await change('vector-mode', 'generic');
  for (const [axis, scale] of [['x', 2], ['y', -3], ['z', .5]]) await change(`vector-scale-${axis}`, scale);
  await waitFor('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)', 'independent signed component scales');
  assert.equal(await evaluate('document.getElementById("vector-components").hidden'), false);
  await assertVectorGroups({ 'vector-components': true, 'vector-component-scales': true });
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.primitiveLayer.vectors.slice(0, 3))'), [2, -1.5, -.125]);
  assert.deepEqual(await evaluate('["force_0", "force_1", "force_2"].map(name => Array.from(window.atomToolsRenderer.frame.properties.find(property => property.name === name).data.slice(0, 8)))'), importedForceValues, 'signed component display scales preserve imported physical values');
  assert.deepEqual(await evaluate('window.atomToolsRenderer.frame.properties.map(property => property.name)'), namesBeforeVectorDisplay);
  for (const axis of ['x', 'y', 'z']) await change(`vector-scale-${axis}`, 1);
  assert.equal(await evaluate('document.getElementById("vector-link-dimensions").checked'), true);
  await change('vector-radius', .12);
  assert.deepEqual(await evaluate('["vector-radius", "vector-head-radius", "vector-head-length"].map(id => document.getElementById(id).valueAsNumber)'), [.12, .3, .6], 'linked sizing preserves shaft/head proportions');
  await change('vector-head-length', .3);
  assert.deepEqual(await evaluate('["vector-radius", "vector-head-radius", "vector-head-length"].map(id => document.getElementById(id).valueAsNumber)'), [.06, .15, .3], 'head length can drive the linked size group');
  await change('vector-link-dimensions', false);
  await change('vector-head-radius', .22);
  assert.deepEqual(await evaluate('["vector-radius", "vector-head-radius", "vector-head-length"].map(id => document.getElementById(id).valueAsNumber)'), [.06, .22, .3], 'unlinked head size preserves shaft thickness and head length');
  for (const anchor of ['head', 'center', 'tail']) {
    await change('vector-anchor', anchor);
    assert.equal(await evaluate('window.atomToolsRenderer.vectorOptions.anchor'), anchor);
  }
  const arrowImages = [];
  // The fixture uses 0.9 Å atom spheres: arrows must extend beyond them for
  // the exported pixel comparison to measure the actual arrow geometry.
  await change('vector-scale', 3);
  assert.deepEqual(await evaluate('["force_0", "force_1", "force_2"].map(name => Array.from(window.atomToolsRenderer.frame.properties.find(property => property.name === name).data.slice(0, 8)))'), importedForceValues, 'overall arrow length scale preserves imported physical values');
  for (const dimension of ['3d', '2d']) {
    await change('vector-dimension', dimension);
    const image = await evaluate(`(() => {
      const r = window.atomToolsRenderer;
      const png = r.captureImage({ includeBackground: false }).toDataURL();
      return { dimension: r.vectorOptions.dimension, error: r.gl.getError(), png };
    })()`);
    assert.equal(image.dimension, dimension);
    assert.equal(image.error, 0, `${dimension} arrows render without a GPU error`);
    arrowImages.push(image.png);
  }
  assert.notEqual(arrowImages[0], arrowImages[1], '3D solids and 2D flat arrows produce different exported pixels');
  await change('vector-scale', .7);
  await change('vector-dimension', '3d');
  await change('vector-head-radius', .15);
  await change('vector-link-dimensions', true);

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
  await showTool('vectors');
  await change('show-vectors', false);
  await showTool('displacement');
  await change('displacement-reference-frame', 1);
  await waitVectorFields('displacement');
  await waitFor('window.atomToolsRenderer.frame.properties.find(property => property.name === "displacementMagnitude")?.data.some(value => value > .1)', 'displacement magnitude computed with arrows disabled');
  const physicalDisplacement = await evaluate(`(() => {
    const frame = window.atomToolsRenderer.frame;
    const components = ['X', 'Y', 'Z'].map(axis => frame.properties.find(property => property.name === 'displacement' + axis).data);
    const magnitude = frame.properties.find(property => property.name === 'displacementMagnitude').data;
    let componentError = 0, magnitudeError = 0, maximum = 0;
    for (let atom = 0; atom < frame.ids.length; atom++) {
      const expected = Array.from(frame.positions.subarray(atom * 3, atom * 3 + 3), value => value * (1 - 1 / 1.02));
      for (let axis = 0; axis < 3; axis++) componentError = Math.max(componentError, Math.abs(components[axis][atom] - expected[axis]));
      magnitudeError = Math.max(magnitudeError, Math.abs(magnitude[atom] - Math.hypot(...expected)));
      maximum = Math.max(maximum, magnitude[atom]);
    }
    return { componentError, magnitudeError, maximum };
  })()`);
  assert.ok(physicalDisplacement.maximum > .1 && physicalDisplacement.componentError < 2e-6 && physicalDisplacement.magnitudeError < 2e-6, JSON.stringify(physicalDisplacement));
  assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false, 'physical displacement calculation does not require arrow drawing');
  for (const name of ['displacementX', 'displacementY', 'displacementZ', 'displacementMagnitude']) {
    await change('legend-color-mode', `property:${name}`);
    assert.equal(await evaluate('document.getElementById("color-mode").value'), `property:${name}`);
    assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false);
  }
  await showTool('vectors');
  await change('vector-mode', 'displacement');
  await assertVectorGroups({ 'vector-components': false, 'vector-component-scales': false });
  const displacementRawSample = await evaluate('["X", "Y", "Z", "Magnitude"].map(axis => Array.from(window.atomToolsRenderer.frame.properties.find(property => property.name === "displacement" + axis).data.slice(0, 8)))');
  await change('vector-scale', 12);
  assert.deepEqual(await evaluate('["X", "Y", "Z", "Magnitude"].map(axis => Array.from(window.atomToolsRenderer.frame.properties.find(property => property.name === "displacement" + axis).data.slice(0, 8)))'), displacementRawSample, 'displacement physical values remain independent of arrow scale while hidden');
  await change('vector-scale', .7);
  await change('displacement-reference-frame', 2);
  await waitFor('window.atomToolsRenderer.frame.properties.find(property => property.name === "displacementMagnitude")?.data.every(value => value === 0)', 'reference changes recompute displacement while arrows are off');
  assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false);
  await change('displacement-reference-frame', 1);
  await waitFor('window.atomToolsRenderer.frame.properties.find(property => property.name === "displacementMagnitude")?.data.some(value => value > .1)', 'nonzero reference restored while arrows are off');
  await evaluate('document.querySelector("[data-tool-button=vectors]").click()');
  assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'property:displacementMagnitude');
  assert.ok(await evaluate('window.atomToolsRenderer.frame.properties.find(property => property.name === "displacementMagnitude").data.some(value => value > .1)'), 'closing Vector settings preserves selected magnitude data');
  await showTool('vectors');
  await change('legend-color-mode', 'type');
  await change('show-vectors', true);
  await waitFor('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors) && /ready|arrows|vectors/i.test(document.getElementById("vector-status").textContent)', 'reference-frame displacement arrows');
  assert.equal(await evaluate('document.getElementById("vector-components").hidden'), true);
  assert.equal(await evaluate('document.getElementById("vector-component-scales").hidden'), true);
  const displacement = await evaluate(`(() => {
    const r = window.atomToolsRenderer, vectors = r.primitiveLayer.vectors;
    let error = 0, maximum = 0;
    for (let i = 0; i < vectors.length; i++) {
      error = Math.max(error, Math.abs(vectors[i] - r.frame.positions[i] * (1 - 1 / 1.02)));
      maximum = Math.max(maximum, Math.abs(vectors[i]));
    }
    return { error, maximum };
  })()`);
  assert.ok(displacement.maximum > .1 && displacement.error < 2e-6, JSON.stringify(displacement));
  await change('displacement-reference-frame', 2);
  await waitFor('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors) && window.atomToolsRenderer.primitiveLayer.vectors.every(value => value === 0)', 'current frame has zero displacement relative to itself');
  await change('displacement-reference-frame', 1);
  await change('vector-anchor', 'center');
  await change('vector-dimension', '2d');
  await waitFor('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors) && window.atomToolsRenderer.primitiveLayer.vectors.some(value => value > .1)', 'displacement restored after reference selection');
  await evaluate(`(async () => {
    const reference = document.getElementById('displacement-reference-frame');
    reference.value = '1'; reference.dispatchEvent(new Event('change', { bubbles: true }));
    const mode = document.getElementById('vector-mode');
    mode.value = 'force'; mode.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
  })()`);
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.primitiveLayer.vectors.slice(0, 3))'), [1, .5, -.25], 'a superseded reference lookup cannot overwrite the newer force preset');
  await change('displacement-reference-frame', 1);
  await change('vector-mode', 'displacement');
  await waitFor('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors) && window.atomToolsRenderer.primitiveLayer.vectors.some(value => value > .1)', 'displacement after superseded reference lookup');

  // Force a real cold reference lookup, then cancel before its result reaches
  // the UI. Disabled displacement must remain absent on both cached frames.
  await showTool('displacement');
  await change('displacement-reference-frame', 2);
  await waitFor('document.getElementById("displacement-state").textContent === "Calculated" && window.atomToolsRenderer.frame.properties.find(property => property.name === "displacementMagnitude")?.data.every(value => value === 0)', 'self-reference before cancellation race');
  await showTool('vectors');
  await change('vector-mode', 'generic');
  for (const axis of ['x', 'y', 'z']) await change(`vector-${axis}`, `displacement${axis.toUpperCase()}`);
  await change('show-vectors', true);
  assert.ok(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), 'custom XYZ can display the calculated displacement components');
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { FrameCache } = await import(new URL('./data/frame-cache.js', appUrl));
    const { StructureWorkerClient } = await import(new URL('./worker-client.js', appUrl));
    const get = FrameCache.prototype.get, frame = StructureWorkerClient.prototype.frame;
    let miss = true, hold = true;
    window.displacementReferenceHeld = false;
    FrameCache.prototype.get = function(index) { if (index === 0 && miss) { miss = false; return undefined; } return get.call(this, index); };
    StructureWorkerClient.prototype.frame = function(index, ...rest) {
      const result = frame.call(this, index, ...rest);
      if (index !== 0 || !hold) return result;
      hold = false;
      return result.then(value => new Promise(resolve => { window.displacementReferenceHeld = true; window.releaseDisplacementReference = () => resolve(value); }));
    };
    window.restoreDisplacementReferenceHooks = () => { FrameCache.prototype.get = get; StructureWorkerClient.prototype.frame = frame; };
  })()`);
  try {
    await change('displacement-minimum-image', false);
    await change('displacement-reference-frame', 1);
    await waitFor('window.displacementReferenceHeld', 'held displacement reference response');
    assert.deepEqual(await evaluate('["x", "y", "z"].map(axis => document.getElementById("vector-" + axis).value)'), ['displacementX', 'displacementY', 'displacementZ'], 'pending custom displacement component choices remain identifiable');
    assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false, 'pending custom components do not draw stale arrows');
    await click('cancel-displacement');
    assert.equal(await evaluate('document.getElementById("displacement-state").textContent'), 'Not calculated');
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "displacement")'), false);
    assert.equal(await evaluate('document.getElementById("vector-mode").value'), 'generic');
    assert.equal(await evaluate('document.getElementById("show-vectors").checked'), false);
    await evaluate('window.releaseDisplacementReference(); window.restoreDisplacementReferenceHooks(); new Promise(resolve => setTimeout(resolve, 60))');
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "displacement")'), false, 'late cancelled reference cannot recreate fields');
  } finally { await evaluate('window.restoreDisplacementReferenceHooks(); window.releaseDisplacementReference?.()'); }
  for (const [button, index] of [['frame-first', 0], ['frame-last', 1]]) {
    await click(button);
    await waitFor(`window.atomToolsRenderer.frame.frameIndex === ${index} && document.getElementById('loading').hidden`, 'frame navigation after displacement cancellation');
    assert.equal(await evaluate('document.getElementById("displacement-state").textContent'), 'Not calculated');
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "displacement")'), false, 'cancellation clears cached displacement and stops frame recomputation');
  }
  await evaluate('document.getElementById("run-displacement").click(); document.getElementById("cancel-displacement").click(); new Promise(resolve => setTimeout(resolve, 60))');
  assert.equal(await evaluate('document.getElementById("displacement-state").textContent'), 'Not calculated');
  assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "displacement")'), false, 'cancelling immediately after start prevents asynchronous field publication');
  await change('displacement-minimum-image', true);
  await click('run-displacement');
  await waitFor('document.getElementById("displacement-state").textContent === "Calculated" && window.atomToolsRenderer.frame.properties.find(property => property.name === "displacementMagnitude")?.data.some(value => value > .1)', 'independent displacement restarted');
  await showTool('vectors');
  await change('vector-mode', 'displacement');
  await change('show-vectors', true);
  await showTool('referenceStrain');
  await change('reference-frame', 1);
  await change('reference-cutoff', 3.1);
  await click('run-reference-strain');
  await waitFor('document.getElementById("reference-strain-state").textContent === "Calculated"', 'Worker reference frame strain');
  assert.ok(await evaluate('window.atomToolsRenderer.frame.properties.find(property => property.name === "referenceHydrostaticStrain").data.every(value => Number.isFinite(value) && Math.abs(value - .0202) < 1e-4)'));
  assert.ok(await evaluate('window.atomToolsRenderer.frame.properties.find(property => property.name === "referenceShearStrain").data.every(value => Number.isFinite(value) && Math.abs(value) < 1e-4)'));
  await waitFor('["bonds-state", "rdf-state", "local-shear-state"].every(id => document.getElementById(id).textContent === "Calculated")', 'concurrent frame analysis completion');
  workerCount = await evaluate('window.atomToolsWorkers.length');
  // cpuWorkerLimit(): hardwareConcurrency − 2 Workers for every analysis together.
  const workerLimit = await evaluate('Math.max(1, (navigator.hardwareConcurrency || 2) - 2)');
  assert.ok(workerCount > 0 && workerCount <= workerLimit, `concurrent analyses must share the bounded Worker pool (${workerCount} of ${workerLimit})`);
  await click('cancel-local-shear');
  await click('run-local-shear');
  await waitFor('document.getElementById("local-shear-state").textContent === "Calculated"', 'local shear after shared pool warmup');
  assert.equal(await evaluate('window.atomToolsWorkers.length'), workerCount, 'repeating an analysis should reuse warm Workers');

  const namedStrainSource = 'property:referencee1';
  await showTool('vectors');
  assert.ok(await evaluate(`Array.from(document.getElementById('vector-mode').options).some(option => option.value === ${JSON.stringify(namedStrainSource)})`), 'completed reference strain exposes a complete named tensor-row triplet');
  await change('vector-mode', namedStrainSource);
  await change('show-vectors', true);
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { FrameCache } = await import(new URL('./data/frame-cache.js', appUrl));
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const get = FrameCache.prototype.get, analyze = AnalysisPool.prototype.analyze;
    let miss = true, hold = true;
    window.namedVectorAnalysisHeld = false;
    FrameCache.prototype.get = function(index) { if (index === 0 && miss) { miss = false; return undefined; } return get.call(this, index); };
    AnalysisPool.prototype.analyze = function(frame, input, ...rest) {
      const result = analyze.call(this, frame, input, ...rest);
      if (input.kind !== 'referenceStrain' || !hold) return result;
      hold = false;
      return result.then(value => new Promise(resolve => { window.namedVectorAnalysisHeld = true; window.releaseNamedVectorAnalysis = () => resolve(value); }));
    };
    window.restoreNamedVectorHooks = () => { FrameCache.prototype.get = get; AnalysisPool.prototype.analyze = analyze; };
  })()`);
  try {
    await click('frame-first');
    await waitFor('window.atomToolsRenderer.frame.frameIndex === 0 && window.namedVectorAnalysisHeld', 'named vector source pending on a real uncached frame');
    assert.deepEqual(await evaluate('({ value: document.getElementById("vector-mode").value, disabled: document.getElementById("vector-mode").selectedOptions[0].disabled, label: document.getElementById("vector-mode").selectedOptions[0].text, shown: document.getElementById("show-vectors").checked, drawn: Boolean(window.atomToolsRenderer.primitiveLayer?.vectors) })'), { value: '', disabled: true, label: 'Waiting for calculated vector…', shown: true, drawn: false }, 'a pending analysis retains the named source preference without guessing another vector');
    await evaluate('window.releaseNamedVectorAnalysis(); window.restoreNamedVectorHooks()');
    await waitFor(`document.getElementById('reference-strain-state').textContent === 'Calculated' && document.getElementById('vector-mode').value === ${JSON.stringify(namedStrainSource)} && Boolean(window.atomToolsRenderer.primitiveLayer?.vectors) && document.getElementById('loading').hidden`, 'named vector resumes after the uncached frame calculation');
  } finally { await evaluate('window.releaseNamedVectorAnalysis?.(); window.restoreNamedVectorHooks()'); }
  await click('frame-last');
  await waitFor(`window.atomToolsRenderer.frame.frameIndex === 1 && document.getElementById('reference-strain-state').textContent === 'Calculated' && document.getElementById('vector-mode').value === ${JSON.stringify(namedStrainSource)} && Boolean(window.atomToolsRenderer.primitiveLayer?.vectors) && document.getElementById('loading').hidden`, 'named vector remains selected on return to the expanded frame');
  await change('vector-mode', 'displacement');

  for (const [tool, runId, stateId] of [['cna', 'run-cna', 'cna-state'], ['ptm', 'run-ptm', 'ptm-state'], ['centrosymmetry', 'run-csp', 'csp-state']]) {
    await showTool(tool); await click(runId);
    await waitFor(`document.getElementById(${JSON.stringify(stateId)}).textContent === 'Calculated'`, `${tool} quantity selector input`);
  }
  workerCount = await evaluate('window.atomToolsWorkers.length');
  const beforeQuantityEdits = await evaluate('window.atomToolsAnalysisCalls');
  for (const property of ['structureType', 'ptmStructureType', 'ptmRmsd', 'centralSymmetry', 'centralSymmetryStructureType', 'centralSymmetryNeighbors', 'referenceHydrostaticStrain', 'referenceShearStrain', 'localShear', 'bondCoordination', 'coordination', 'energy', 'all_nan']) {
    await change('legend-color-mode', `property:${property}`);
    assert.equal(await evaluate('document.getElementById("color-mode").value'), `property:${property}`);
    assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), `property:${property}`);
    assert.deepEqual(await evaluate('Array.from(document.getElementById("legend-color-mode").options, option => [option.value, option.text])'), await evaluate('Array.from(document.getElementById("color-mode").options, option => [option.value, option.text])'));
  }
  await change('legend-color-mode', 'property:referenceHydrostaticStrain');
  await evaluate(`(() => {
    const [minimum, maximum] = document.querySelectorAll('.legend-controls input[type="number"]');
    minimum.value = '-.05'; minimum.dispatchEvent(new Event('input'));
    maximum.value = '.1'; maximum.dispatchEvent(new Event('input'));
    const scheme = document.querySelector('.legend-scheme select'); scheme.value = 'coolwarm'; scheme.dispatchEvent(new Event('change'));
  })()`);
  await change('legend-color-mode', 'property:ptmStructureType');
  assert.equal(await evaluate('document.querySelectorAll("#legend .crystal-items input[type=checkbox]").length'), 9);
  await change('legend-color-mode', 'property:referenceHydrostaticStrain');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".legend-controls input[type=number]"), input => input.valueAsNumber)'), [-.05, .1]);
  assert.equal(await evaluate('document.querySelector(".legend-scheme select").value'), 'coolwarm');
  assert.equal(await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")'), 'false');
  await change('color-mode', 'property:localShear');
  assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'property:localShear');
  assert.equal(await evaluate('window.atomToolsAnalysisCalls'), beforeQuantityEdits, 'choosing available quantities must not launch any analysis');
  await click('cancel-local-shear');
  assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'type');
  assert.equal(await evaluate('document.getElementById("color-mode").value'), 'type');
  assert.equal(await evaluate('Array.from(document.getElementById("legend-color-mode").options).some(option => option.value === "property:localShear")'), false);
  const beforePendingChoice = await evaluate('window.atomToolsAnalysisKinds.length');
  await evaluate(`(() => {
    document.getElementById('run-local-shear').click();
    const select = document.getElementById('legend-color-mode'); select.value = 'type'; select.dispatchEvent(new Event('change'));
  })()`);
  await waitFor('document.getElementById("local-shear-state").textContent === "Calculated"', 'restored local shear after selector removal');
  assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'type', 'a finished analysis must preserve a later manual legend quantity choice');
  assert.equal(await evaluate('document.getElementById("color-mode").value'), 'type');
  const pendingKinds = await evaluate(`window.atomToolsAnalysisKinds.slice(${beforePendingChoice})`);
  assert.equal(pendingKinds.filter(kind => kind === 'localShear').length, 1);
  assert.ok(pendingKinds.every(kind => kind?.startsWith('localShear')), 'the pending quantity edit must not launch other calculations');
  await change('legend-color-mode', 'property:referenceHydrostaticStrain');
  assert.equal((await exportConfiguration()).settings.display.colorMode, 'property:referenceHydrostaticStrain');
  if (screenshots) {
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/alloyview-legend-quantities.png', Buffer.from(capture.data, 'base64'));
  }
  for (const [button, index] of [['frame-first', 0], ['frame-next', 1]]) {
    await click(button);
    await waitFor(`window.atomToolsRenderer.frame.frameIndex === ${index} && document.getElementById('loading').hidden && document.getElementById('reference-strain-state').textContent === 'Calculated' && window.atomToolsRenderer.frame.properties.some(property => property.name === 'referenceHydrostaticStrain')`, 'selected extension quantity across frame recomputation');
    assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'property:referenceHydrostaticStrain');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:referenceHydrostaticStrain');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".legend-controls input[type=number]"), input => input.valueAsNumber)'), [-.05, .1]);
    assert.equal(await evaluate('document.querySelector(".legend-scheme select").value'), 'coolwarm');
    assert.equal(await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")'), 'false');
  }
  workerCount = await evaluate('window.atomToolsWorkers.length');

  await showTool('display');
  await change('compare-preset', 'top');
  await change('compare-view', true);
  await waitFor('Boolean(document.querySelector(".comparison-view canvas"))', 'simultaneous second view');
  // Both overlays occupy the right of the viewport. Collapse Atom details
  // before exercising the second canvas with genuine mouse gestures.
  await evaluate(`if (document.getElementById('toggle-atom-details').getAttribute('aria-expanded') === 'true') document.getElementById('toggle-atom-details').click()`);
  await waitFor('document.getElementById("atom-details").hidden && document.getElementById("atom-details").inert', 'second viewport available after collapsing Atom details');
  const secondRenderer = 'window.atomToolsRenderers.find(view => view.frame && view.canvas.id !== "viewport")';
  const cameraFields = ['yaw', 'pitch', 'roll', 'fov', 'constrainUp', 'distance', 'orthographicScale', 'projectionMode', 'target', 'pan'];
  const cameraSnapshot = renderer => `Object.fromEntries(${JSON.stringify(cameraFields)}.map(key => [key, ${renderer}[key]]))`;
  async function secondCanvasPoint() {
    return evaluate(`(() => {
      const canvas = document.querySelector('.comparison-view canvas'), rect = canvas.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (document.elementFromPoint(x, y) !== canvas) throw new Error('The second-view pointer target is covered by another control.');
      return { x, y };
    })()`);
  }
  async function dragSecondView(button, dx, dy) {
    const point = await secondCanvasPoint();
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 });
    for (let step = 1; step <= 4; step += 1) await call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x + dx * step / 4, y: point.y + dy * step / 4,
      button, buttons: button === 'right' ? 2 : 1,
    });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + dx, y: point.y + dy, button, clickCount: 1 });
  }
  async function assertInheritedAppearance(label) {
    const matching = await evaluate(`(() => {
      const main = window.atomToolsRenderer, second = ${secondRenderer};
      return second.radiusScale === main.radiusScale && ['atomRadii', 'atomColors', 'visibility'].every(key =>
        second[key].length === main[key].length && second[key].every((value, index) => value === main[key][index]));
    })()`);
    assert.equal(matching, true, label);
  }
  const primaryCamera = await evaluate('JSON.parse(JSON.stringify([window.atomToolsRenderer.yaw, window.atomToolsRenderer.pitch, window.atomToolsRenderer.projectionMode]))');
  for (const direction of ['top', 'bottom', 'front', 'back', 'left', 'right']) {
    await evaluate(`document.querySelector('.comparison-toolbar [data-compare-view="${direction}"]').click()`);
    assert.equal(await evaluate('document.getElementById("compare-preset").value'), direction, 'second viewport toolbar updates the direction selector');
    assert.equal(await evaluate(`document.querySelector('.comparison-toolbar [data-compare-view="${direction}"]').getAttribute('aria-pressed')`), 'true', 'the selected second-view direction is highlighted');
    assert.equal(await evaluate('document.querySelectorAll(".comparison-toolbar [data-compare-view][aria-pressed=true]").length'), 1);
    assert.deepEqual(await evaluate('JSON.parse(JSON.stringify([window.atomToolsRenderer.yaw, window.atomToolsRenderer.pitch, window.atomToolsRenderer.projectionMode]))'), primaryCamera, 'second view direction preserves the main camera');
  }
  for (const mode of ['perspective', 'orthographic']) {
    await evaluate(`document.querySelector('.comparison-toolbar [data-compare-projection="${mode}"]').click()`);
    assert.equal(await evaluate('window.atomToolsRenderers.find(view => view.frame && view.canvas.id !== "viewport").projectionMode'), mode);
    assert.deepEqual(await evaluate('JSON.parse(JSON.stringify([window.atomToolsRenderer.yaw, window.atomToolsRenderer.pitch, window.atomToolsRenderer.projectionMode]))'), primaryCamera, 'second projection control preserves the main projection');
  }
  await evaluate(`document.querySelector('.comparison-toolbar [data-compare-view="left"]').click()`);
  const primaryBeforeInteraction = await evaluate(cameraSnapshot('window.atomToolsRenderer'));
  const presetCamera = await evaluate(cameraSnapshot(secondRenderer));
  await dragSecondView('right', 18, 12);
  await waitFor(`${secondRenderer}.pan.some((value, index) => value !== ${JSON.stringify(presetCamera.pan)}[index])`, 'real mouse panning in the second view');
  assert.equal(await evaluate('document.querySelector(".comparison-toolbar [data-compare-view=left]").getAttribute("aria-pressed")'), 'true', 'panning retains the selected direction');
  const zoomBefore = await evaluate(`${secondRenderer}.orthographicScale`);
  await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...await secondCanvasPoint(), deltaX: 0, deltaY: 90 });
  await waitFor(`${secondRenderer}.orthographicScale !== ${zoomBefore}`, 'real wheel zoom in the second view');
  assert.equal(await evaluate('document.querySelector(".comparison-toolbar [data-compare-view=left]").getAttribute("aria-pressed")'), 'true', 'zooming retains the selected direction');
  await dragSecondView('left', 25, 18);
  await waitFor(`${secondRenderer}.yaw !== ${presetCamera.yaw} && document.querySelectorAll('.comparison-toolbar [data-compare-view][aria-pressed=true]').length === 0`, 'manual orbit clears the preset highlight');
  assert.equal(await evaluate('document.querySelector(".comparison-label").textContent'), 'Custom');
  assert.equal(await evaluate('document.getElementById("compare-preset").value'), 'custom', 'a manually rotated camera is no longer Left');
  compareSettings(await evaluate(cameraSnapshot('window.atomToolsRenderer')), primaryBeforeInteraction, 'independent second-camera mouse interactions');
  const customCamera = await evaluate(cameraSnapshot(secondRenderer));
  await assertInheritedAppearance('the second view initially inherits all atom display buffers');
  const arrowDisplayBefore = await evaluate('Object.fromEntries(["vector-mode", "vector-scale", "vector-dimension", "legend-color-mode"].map(id => [id, document.getElementById(id).value]))');
  const customComponentsBeforeCancellation = await evaluate('["x", "y", "z"].map(axis => document.getElementById("vector-" + axis).value)');
  async function assertArrowVisibilityInBothViews(shown, label) {
    const visibility = await evaluate(`({ checked: document.getElementById('show-vectors').checked,
      main: Boolean(window.atomToolsRenderer.atomVectors) && Boolean(window.atomToolsRenderer.primitiveLayer?.vectors),
      second: Boolean(${secondRenderer}.atomVectors) && Boolean(${secondRenderer}.primitiveLayer?.vectors) })`);
    assert.deepEqual(visibility, { checked: shown, main: shown, second: shown }, label);
  }
  async function restartReferenceStrain(label) {
    await click('run-reference-strain');
    await waitFor('document.getElementById("reference-strain-state").textContent === "Calculated"', label);
  }
  await showTool('vectors');
  await change('vector-mode', namedStrainSource);
  await change('show-vectors', true);
  await assertArrowVisibilityInBothViews(true, 'the named calculated tensor-row source draws in both views');
  await click('cancel-reference-strain');
  await assertArrowVisibilityInBothViews(false, 'cancelling a named calculated vector source unchecks Show arrows and clears both views');
  assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "referenceStrain")'), false);
  await restartReferenceStrain('reference strain recalculated after named-vector cancellation');
  await assertArrowVisibilityInBothViews(false, 'recalculating a cancelled named source does not enable arrows again');
  await showTool('vectors');
  await change('vector-mode', 'generic');
  const mixedReferenceComponents = ['referenceE11', 'force_1', 'force_2'];
  for (const [axis, name] of mixedReferenceComponents.entries()) await change(`vector-${'xyz'[axis]}`, name);
  await change('show-vectors', true);
  await assertArrowVisibilityInBothViews(true, 'custom XYZ draws a calculated component mixed with imported components');
  await click('cancel-reference-strain');
  await assertArrowVisibilityInBothViews(false, 'cancelling even one calculated Custom XYZ component turns the entire overlay off in both views');
  assert.deepEqual(await evaluate('({ value: document.getElementById("vector-x").value, disabled: document.getElementById("vector-x").selectedOptions[0].disabled })'), { value: 'referenceE11', disabled: true }, 'a cancelled custom quantity remains a disabled placeholder rather than switching to Force');
  await restartReferenceStrain('reference strain recalculated after mixed Custom XYZ cancellation');
  await assertArrowVisibilityInBothViews(false, 'recalculating a custom component leaves Show arrows off');
  await showTool('vectors');
  for (const [axis, name] of mixedReferenceComponents.entries()) await change(`vector-${'xyz'[axis]}`, name);
  await change('show-vectors', true);
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { FrameCache } = await import(new URL('./data/frame-cache.js', appUrl));
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const get = FrameCache.prototype.get, analyze = AnalysisPool.prototype.analyze;
    let miss = true, hold = true;
    window.customVectorAnalysisHeld = false;
    FrameCache.prototype.get = function(index) { if (index === 0 && miss) { miss = false; return undefined; } return get.call(this, index); };
    AnalysisPool.prototype.analyze = function(frame, input, ...rest) {
      const result = analyze.call(this, frame, input, ...rest);
      if (input.kind !== 'referenceStrain' || !hold) return result;
      hold = false;
      return result.then(value => new Promise(resolve => { window.customVectorAnalysisHeld = true; window.releaseCustomVectorAnalysis = () => resolve(value); }));
    };
    window.restoreCustomVectorHooks = () => { FrameCache.prototype.get = get; AnalysisPool.prototype.analyze = analyze; };
  })()`);
  try {
    await click('frame-first');
    await waitFor('window.atomToolsRenderer.frame.frameIndex === 0 && window.customVectorAnalysisHeld', 'a Custom XYZ component pending on a real cold frame');
    assert.deepEqual(await evaluate('["x", "y", "z"].map(axis => document.getElementById("vector-" + axis).value)'), mixedReferenceComponents, 'cold-frame recomputation retains the custom component selection');
    assert.equal(await evaluate('document.getElementById("vector-x").selectedOptions[0].disabled'), true, 'an unavailable pending component has a disabled placeholder');
    assert.equal(await evaluate('document.getElementById("show-vectors").checked'), true, 'ordinary recomputation preserves the requested arrow visibility');
    assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false, 'pending custom data cannot draw stale arrows');
    await click('cancel-reference-strain');
    await assertArrowVisibilityInBothViews(false, 'cancelling a missing cold-frame component uses its calculation provenance to turn arrows off');
    await evaluate('window.releaseCustomVectorAnalysis(); window.restoreCustomVectorHooks()');
    await waitFor('document.getElementById("loading").hidden', 'cancelled cold-frame analysis finishes without publication');
    assert.equal(await evaluate('document.getElementById("reference-strain-state").textContent'), 'Not calculated');
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "referenceStrain")'), false, 'late cancelled component data cannot reappear');
    await assertArrowVisibilityInBothViews(false, 'late cancelled results cannot reenable either view');
  } finally { await evaluate('window.releaseCustomVectorAnalysis?.(); window.restoreCustomVectorHooks()'); }
  await click('frame-last');
  await waitFor('window.atomToolsRenderer.frame.frameIndex === 1 && document.getElementById("loading").hidden', 'return to the expanded frame after component cancellation');
  await restartReferenceStrain('reference strain enabled before unrelated imported-vector cancellation');
  await showTool('vectors');
  await change('vector-mode', 'force');
  await change('show-vectors', true);
  const forceBeforeUnrelatedCancellation = await evaluate('Array.from(window.atomToolsRenderer.primitiveLayer.vectors)');
  await click('cancel-reference-strain');
  await assertArrowVisibilityInBothViews(true, 'cancelling reference strain leaves unrelated imported Force arrows on in both views');
  assert.equal(await evaluate('document.getElementById("vector-mode").value'), 'force');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.primitiveLayer.vectors)'), forceBeforeUnrelatedCancellation);
  await change('vector-mode', 'generic');
  for (const [axis, name] of ['coordination', 'force_1', 'force_2'].entries()) await change(`vector-${'xyz'[axis]}`, name);
  await assertArrowVisibilityInBothViews(true, 'Custom XYZ can draw the main coordination quantity');
  await click('cancel-analysis');
  await assertArrowVisibilityInBothViews(false, 'the main coordination analysis also turns off Custom XYZ arrows that use its quantity');
  assert.deepEqual(await evaluate('({ value: document.getElementById("vector-x").value, disabled: document.getElementById("vector-x").selectedOptions[0].disabled })'), { value: 'coordination', disabled: true }, 'the cancelled main quantity remains a disabled custom selection');
  await evaluate('document.getElementById("run-analysis").click(); document.querySelector("[data-tool-button=vectors]").click()');
  await waitFor('document.getElementById("analysis-state").textContent === "Calculated"', 'coordination recalculated after custom-vector dependency cancellation');
  assert.equal(await evaluate('document.getElementById("tool-vectors").hidden'), false, 'the Vector panel remains open as a primary analysis finishes');
  assert.deepEqual(await evaluate('({ value: document.getElementById("vector-x").value, disabled: document.getElementById("vector-x").selectedOptions[0].disabled })'), { value: 'coordination', disabled: false }, 'a newly recalculated primary quantity enters the custom menu immediately');
  await assertArrowVisibilityInBothViews(false, 'recalculating a main analysis does not turn its previous arrows back on');
  await change('vector-mode', 'force');
  await change('show-vectors', true);
  await click('cancel-analysis');
  await assertArrowVisibilityInBothViews(true, 'cancelling coordination leaves unrelated imported Force arrows enabled');
  await click('run-analysis');
  await waitFor('document.getElementById("analysis-state").textContent === "Calculated"', 'coordination restored before the remaining viewer checks');
  await restartReferenceStrain('reference strain restored before the remaining viewer checks');
  await showTool('vectors');
  for (const [axis, name] of customComponentsBeforeCancellation.entries()) await change(`vector-${'xyz'[axis]}`, name);
  for (const [id, value] of Object.entries(arrowDisplayBefore)) await change(id, value);
  await change('show-vectors', true);
  await assertArrowVisibilityInBothViews(true, 'original displacement overlay restored after dependency cancellation checks');
  await change('legend-color-mode', 'type');
  await evaluate('document.querySelector("#legend [data-legend-action=unselect-all]").click()');
  assert.ok(await evaluate('Array.from(document.querySelectorAll("#legend input[data-atom-type]")).every(input => !input.checked)'));
  assert.ok(await evaluate('window.atomToolsRenderer.visibility.every(value => value === 0)'));
  await assertInheritedAppearance('unselecting all atoms synchronizes the second visibility mask');
  await change('vector-mode', 'force');
  await change('vector-scale', 3);
  for (const dimension of ['3d', '2d']) {
    await change('vector-dimension', dimension);
    for (const renderer of ['window.atomToolsRenderer', secondRenderer]) {
      const coverage = await arrowGpuCoverage(renderer);
      assert.ok(coverage.allAtomsHidden && coverage.passes >= 2 && coverage.covered && coverage.error === 0, `${dimension} arrows render after all atoms are hidden in ${renderer}: ${JSON.stringify(coverage)}`);
    }
  }
  await change('show-vectors', false);
  assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false, 'Show arrows exclusively controls the glyph overlay');
  await change('show-vectors', true);
  await evaluate('document.querySelector("#legend [data-legend-action=select-all]").click()');
  assert.ok(await evaluate('Array.from(document.querySelectorAll("#legend input[data-atom-type]")).every(input => input.checked)'));
  assert.ok(await evaluate('window.atomToolsRenderer.visibility.every(value => value === 255)'));
  await evaluate(`(() => { const input = document.querySelector('#element-style-controls input[type="checkbox"]'); input.checked = false; input.dispatchEvent(new Event('change')); })()`);
  for (const renderer of ['window.atomToolsRenderer', secondRenderer]) {
    const coverage = await arrowGpuCoverage(renderer);
    assert.ok(coverage.allAtomsHidden && coverage.covered && coverage.error === 0, `element appearance hides atoms while retaining arrows in ${renderer}: ${JSON.stringify(coverage)}`);
  }
  const originalSlices = await evaluate('window.atomToolsRenderer.slices');
  await evaluate('window.atomToolsRenderer.setSlices([{id:"arrow-test", normal:[1,0,0], position:-100, side:"negative", enabled:true}])');
  const slicedArrows = await arrowGpuCoverage('window.atomToolsRenderer');
  assert.ok(slicedArrows.passes >= 2 && !slicedArrows.covered && slicedArrows.error === 0, 'arrows still obey world-space slices when atom visibility is independent');
  await evaluate(`window.atomToolsRenderer.setSlices(${JSON.stringify(originalSlices)})`);
  await evaluate(`(() => { const input = document.querySelector('#element-style-controls input[type="checkbox"]'); input.checked = true; input.dispatchEvent(new Event('change')); })()`);
  for (const [id, value] of Object.entries(arrowDisplayBefore)) await change(id, value);
  const inheritedBefore = await evaluate(`({ radiusPercent: document.getElementById('radius-percent').value, colorMode: document.getElementById('color-mode').value })`);
  await change('radius-percent', 83, 'input');
  assert.equal(await evaluate(`${secondRenderer}.radiusScale`), .83);
  await assertInheritedAppearance('main radius scaling immediately updates the second view');
  await change('color-mode', 'property:energy');
  await assertInheritedAppearance('scalar-property colors immediately update the second view');
  await change('color-mode', 'type');
  await evaluate(`(() => {
    const row = document.querySelector('#element-style-controls .element-style-row');
    const color = row.querySelector('input[type="color"]'), radius = row.querySelector('input[type="number"]');
    color.value = '#3388ff'; color.dispatchEvent(new Event('change'));
    radius.value = '1.1'; radius.dispatchEvent(new Event('change'));
  })()`);
  assert.ok(await evaluate(`${secondRenderer}.atomRadii.every(value => Math.abs(value - 1.1) < 1e-6)`));
  assert.deepEqual(await evaluate(`Array.from(${secondRenderer}.atomColors.slice(0, 3))`), [51, 136, 255]);
  await assertInheritedAppearance('element radius and color overrides immediately update the second view');
  await openAtomDetails();
  await openAtomAppearance();
  await change('atom-search-id', 2);
  await click('find-atom');
  await change('selected-atom-color', '#ff0088');
  await change('selected-atom-radius', .45);
  await click('apply-atom-style');
  assert.ok(Math.abs(await evaluate(`${secondRenderer}.atomRadii[1]`) - .45) < 1e-6);
  assert.deepEqual(await evaluate(`Array.from(${secondRenderer}.atomColors.slice(3, 6))`), [255, 0, 136]);
  await change('selected-atom-visible', false);
  await click('apply-atom-style');
  assert.equal(await evaluate(`${secondRenderer}.visibility[1]`), 0);
  await assertInheritedAppearance('per-atom color, radius and visibility overrides immediately update the second view');
  await change('color-mode', 'property:energy');
  await evaluate(`(() => {
    const [minimum, maximum] = document.querySelectorAll('.legend-controls input[type="number"]');
    minimum.value = '.2'; minimum.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '2' }));
    maximum.value = '.6'; maximum.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '6' }));
  })()`);
  await assertInheritedAppearance('live legend range edits immediately synchronize colors and visibility');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.atomColors.slice(3, 6))'), [255, 0, 136], 'live scalar ranges preserve a per-atom color override');
  assert.ok(await evaluate(`${secondRenderer}.visibility.some(value => value === 0)`), 'the second view inherits scalar range filtering');
  await evaluate(`(() => {
    const input = document.querySelector('.legend-visibility input');
    input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await assertInheritedAppearance('turning off scalar range filtering immediately updates the second view');
  assert.equal(await evaluate(`${secondRenderer}.visibility[1]`), 0, 'scalar filter edits preserve explicitly hidden atoms');
  assert.equal(await evaluate(`${secondRenderer}.visibility[0]`), 255);
  await evaluate(`(() => {
    const input = document.querySelector('.legend-visibility input');
    input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await assertInheritedAppearance('turning on scalar range filtering immediately updates the second view');
  await click('reset-atom-style');
  await showTool('display');
  await evaluate(`(() => {
    const row = document.querySelector('#element-style-controls .element-style-row');
    const color = row.querySelector('input[type="color"]'), radius = row.querySelector('input[type="number"]');
    color.value = '#66ccaa'; color.dispatchEvent(new Event('change'));
    radius.value = '.9'; radius.dispatchEvent(new Event('change'));
  })()`);
  await change('radius-percent', inheritedBefore.radiusPercent, 'input');
  await change('color-mode', inheritedBefore.colorMode);
  compareSettings(await evaluate(cameraSnapshot(secondRenderer)), customCamera, 'display edits preserve the independent second camera');
  assert.equal(await evaluate('document.querySelectorAll(".comparison-toolbar [data-compare-view][aria-pressed=true]").length'), 0, 'display refresh does not restore an obsolete direction highlight');
  for (const [button, index] of [['frame-first', 0], ['frame-next', 1]]) {
    await click(button);
    await waitFor(`window.atomToolsRenderer.frame.frameIndex === ${index} && ${secondRenderer}.frame.frameIndex === ${index} && document.getElementById('loading').hidden && document.getElementById('reference-strain-state').textContent === 'Calculated'`, 'both views update across trajectory frames');
    await assertInheritedAppearance('a frame change keeps both views on the same atom display buffers');
    compareSettings(await evaluate(cameraSnapshot(secondRenderer)), customCamera, 'a frame change preserves the custom second camera');
    assert.equal(await evaluate('document.querySelectorAll(".comparison-toolbar [data-compare-view][aria-pressed=true]").length'), 0, 'a frame change preserves the custom camera label');
  }
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
  assert.equal(recipe.settings.extensions.vectors.mode, 'displacement');
  assert.deepEqual(recipe.settings.extensions.displacement, { enabled: true, referenceFrame: 0, minimumImage: true, tiles: [0, 0, 0] });
  assert.equal(recipe.settings.extensions.vectors.anchor, 'center');
  assert.equal(recipe.settings.extensions.vectors.dimension, '2d');
  assert.equal(recipe.settings.extensions.vectors.linkDimensions, true);
  assert.equal(recipe.settings.extensions.referenceStrain.enabled, true);
  assert.equal(recipe.settings.extensions.localShear.enabled, true);
  assert.equal(recipe.settings.extensions.rdf.enabled, true);
  assert.equal(recipe.settings.extensions.comparison.enabled, true);
  assert.equal(recipe.settings.extensions.comparison.preset, 'custom', 'configuration records a freely rotated second camera');
  const recipePath = resolve(profile, 'atom-tools-recipe.json');
  await writeFile(recipePath, JSON.stringify(recipe));
  for (const id of ['cancel-bonds', 'cancel-rdf', 'cancel-reference-strain', 'cancel-local-shear', 'cancel-displacement']) await click(id);
  await change('show-vectors', false);
  await change('compare-view', false);
  const { root: recipeRoot } = await call('DOM.getDocument');
  const { nodeId: recipeInput } = await call('DOM.querySelector', { nodeId: recipeRoot.nodeId, selector: '#configuration-file' });
  await call('DOM.setFileInputFiles', { nodeId: recipeInput, files: [recipePath] });
  await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("reference-strain-state").textContent === "Calculated"', 'new-feature configuration replay');
  compareSettings((await exportConfiguration()).settings.extensions, recipe.settings.extensions, 'atom tools extensions');
  compareSettings(await evaluate(cameraSnapshot(secondRenderer)), recipe.settings.extensions.comparison.camera, 'configuration restores the exact custom second-camera orientation');
  assert.equal(await evaluate('document.querySelector(".comparison-label").textContent'), 'Custom');
  assert.equal(await evaluate('document.querySelectorAll(".comparison-toolbar [data-compare-view][aria-pressed=true]").length'), 0, 'restored custom cameras do not highlight a standard direction');

  const namedRecipe = structuredClone(recipe);
  namedRecipe.settings.extensions.vectors.mode = namedStrainSource;
  const namedVectors = namedRecipe.settings.extensions.vectors;
  namedVectors.fields.find(field => field.id === namedVectors.selectedId).mode = namedStrainSource;
  const namedRecipePath = resolve(profile, 'named-strain-vector-recipe.json');
  await writeFile(namedRecipePath, JSON.stringify(namedRecipe));

  // Hold an actual reference-frame Worker response during replay. A manual
  // second-camera edit must take precedence over the saved camera after the
  // outstanding displacement and reference-strain work eventually completes.
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { FrameCache } = await import(new URL('./data/frame-cache.js', appUrl));
    const { StructureWorkerClient } = await import(new URL('./worker-client.js', appUrl));
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const get = FrameCache.prototype.get, frame = StructureWorkerClient.prototype.frame, analyze = AnalysisPool.prototype.analyze;
    let miss = true, hold = true, holdAnalysis = true;
    window.comparisonRestoreHeld = false;
    window.comparisonAnalysisHeld = false;
    FrameCache.prototype.get = function(index) {
      if (index === 0 && miss) { miss = false; return undefined; }
      return get.call(this, index);
    };
    StructureWorkerClient.prototype.frame = function(index, ...rest) {
      const response = frame.call(this, index, ...rest);
      if (index !== 0 || !hold) return response;
      hold = false;
      return response.then(value => new Promise(resolve => {
        window.comparisonRestoreHeld = true;
        window.releaseComparisonRestore = () => resolve(value);
      }));
    };
    AnalysisPool.prototype.analyze = function(frame, input, ...rest) {
      const result = analyze.call(this, frame, input, ...rest);
      if (input.kind !== 'referenceStrain' || !holdAnalysis) return result;
      holdAnalysis = false;
      return result.then(value => new Promise(resolve => { window.comparisonAnalysisHeld = true; window.releaseComparisonAnalysis = () => resolve(value); }));
    };
    window.restoreComparisonHooks = () => { FrameCache.prototype.get = get; StructureWorkerClient.prototype.frame = frame; AnalysisPool.prototype.analyze = analyze; };
  })()`);
  try {
    await call('DOM.setFileInputFiles', { nodeId: recipeInput, files: [namedRecipePath] });
    await waitFor('window.comparisonRestoreHeld && window.comparisonAnalysisHeld && !document.querySelector(".comparison-view").hidden', 'held reference lookup and reference-strain result while restoring the second camera');
    assert.equal(await evaluate('document.getElementById("vector-mode").value'), '', 'replaying a named calculated source waits for its enabled analysis');
    assert.match(await evaluate('document.getElementById("vector-mode").selectedOptions[0].text'), /Waiting for calculated vector/);
    await evaluate(`document.querySelector('.comparison-toolbar [data-compare-view="bottom"]').click(); document.querySelector('.comparison-toolbar [data-compare-projection="perspective"]').click()`);
    const editedCamera = await evaluate(`JSON.parse(JSON.stringify(Object.fromEntries(['yaw', 'pitch', 'distance', 'orthographicScale', 'projectionMode', 'target', 'pan'].map(key => [key, window.atomToolsRenderers.find(view => view.frame && view.canvas.id !== 'viewport')[key]]))))`);
    assert.equal(editedCamera.projectionMode, 'perspective');
    await waitFor('document.getElementById("configuration-status").textContent.includes("interrupted")', 'second camera edit interrupts pending configuration replay');
    await evaluate('window.releaseComparisonRestore(); window.releaseComparisonAnalysis()');
    await waitFor('document.getElementById("reference-strain-state").textContent === "Calculated" && Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)', 'superseded replay numerical jobs finish');
    assert.equal(await evaluate('document.getElementById("vector-mode").value'), namedStrainSource, 'configuration replay retains the named source when its fields become available');
    assert.equal((await exportConfiguration()).settings.extensions.vectors.mode, namedStrainSource);
    compareSettings(await evaluate(`Object.fromEntries(['yaw', 'pitch', 'distance', 'orthographicScale', 'projectionMode', 'target', 'pan'].map(key => [key, window.atomToolsRenderers.find(view => view.frame && view.canvas.id !== 'viewport')[key]]))`), editedCamera, 'manual second camera wins over stale replay');
    assert.equal(await evaluate('document.getElementById("compare-preset").value'), 'bottom');
  } finally {
    await evaluate('window.releaseComparisonRestore?.(); window.releaseComparisonAnalysis?.(); window.restoreComparisonHooks()');
  }

  // A fresh Custom recipe has no previously recorded component provenance:
  // cancellation must recognize the pending output of its enabled analysis.
  const customRecipe = structuredClone(recipe);
  Object.assign(customRecipe.settings.extensions.vectors, { mode: 'generic', components: ['referenceE11', 'force_1', 'force_2'], enabled: true });
  const customVectors = customRecipe.settings.extensions.vectors;
  Object.assign(customVectors.fields.find(field => field.id === customVectors.selectedId), {
    mode: 'generic', components: ['referenceE11', 'force_1', 'force_2'], enabled: true,
  });
  const customRecipePath = resolve(profile, 'custom-pending-vector-recipe.json');
  await writeFile(customRecipePath, JSON.stringify(customRecipe));
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const analyze = AnalysisPool.prototype.analyze;
    let hold = true;
    window.customRestoreHeld = false;
    AnalysisPool.prototype.analyze = function(frame, input, ...rest) {
      const result = analyze.call(this, frame, input, ...rest);
      if (input.kind !== 'referenceStrain' || !hold) return result;
      hold = false;
      return result.then(value => new Promise(resolve => { window.customRestoreHeld = true; window.releaseCustomRestore = () => resolve(value); }));
    };
    window.restoreCustomReplayHook = () => { AnalysisPool.prototype.analyze = analyze; };
  })()`);
  try {
    await call('DOM.setFileInputFiles', { nodeId: recipeInput, files: [customRecipePath] });
    await waitFor('window.customRestoreHeld && document.getElementById("reference-strain-state").textContent === "Calculating…"', 'fresh Custom XYZ replay before its reference-strain output is published');
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "referenceStrain")'), false, 'the replay has no completed reference-strain fields to identify the dependency');
    assert.deepEqual(await evaluate('({ value: document.getElementById("vector-x").value, disabled: document.getElementById("vector-x").selectedOptions[0].disabled, checked: document.getElementById("show-vectors").checked })'), { value: 'referenceE11', disabled: true, checked: true }, 'the fresh recipe retains its pending component and requested arrow visibility');
    await click('cancel-reference-strain');
    await assertArrowVisibilityInBothViews(false, 'cancelling a fresh pending Custom recipe recognizes the enabled calculation before any field exists');
    await waitFor('document.getElementById("configuration-status").textContent.includes("interrupted")', 'component cancellation interrupts pending configuration replay');
    await evaluate('window.releaseCustomRestore(); window.restoreCustomReplayHook(); new Promise(resolve => setTimeout(resolve, 60))');
    assert.equal(await evaluate('document.getElementById("reference-strain-state").textContent'), 'Not calculated');
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "referenceStrain")'), false);
    await assertArrowVisibilityInBothViews(false, 'late replay results cannot republish or enable the cancelled custom vector');
    assert.equal((await exportConfiguration()).settings.extensions.vectors.enabled, false, 'the saved arrow visibility agrees with the cancelled overlay');
  } finally { await evaluate('window.releaseCustomRestore?.(); window.restoreCustomReplayHook()'); }

  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const analyze = AnalysisPool.prototype.analyze, held = new Set();
    window.namedRestoreHeld = false; window.unrelatedRestoreHeld = false;
    AnalysisPool.prototype.analyze = function(frame, input, ...rest) {
      const result = analyze.call(this, frame, input, ...rest);
      if (!['referenceStrain', 'localShear'].includes(input.kind) || held.has(input.kind)) return result;
      held.add(input.kind);
      return result.then(value => new Promise(resolve => {
        if (input.kind === 'referenceStrain') { window.namedRestoreHeld = true; window.releaseNamedRestore = () => resolve(value); }
        else { window.unrelatedRestoreHeld = true; window.releaseUnrelatedRestore = () => resolve(value); }
      }));
    };
    window.restoreNamedReplayHook = () => { AnalysisPool.prototype.analyze = analyze; };
  })()`);
  try {
    await call('DOM.setFileInputFiles', { nodeId: recipeInput, files: [namedRecipePath] });
    await waitFor('window.namedRestoreHeld && window.unrelatedRestoreHeld', 'fresh named-vector replay with another analysis still pending');
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "referenceStrain")'), false);
    assert.equal(await evaluate('document.getElementById("vector-mode").value'), '', 'a fresh named source waits for its first calculated components');
    assert.equal(await evaluate('document.getElementById("show-vectors").checked'), true);
    await click('cancel-reference-strain');
    assert.equal(await evaluate('document.getElementById("local-shear-state").textContent'), 'Calculating…', 'the unrelated analysis remains pending at cancellation');
    await assertArrowVisibilityInBothViews(false, 'cancelling a fresh named source turns arrows off despite another enabled pending calculation');
    assert.equal(await evaluate('document.getElementById("vector-mode").value'), '', 'a cancelled named field preserves its unavailable source');
    assert.equal(await evaluate('document.getElementById("vector-mode").selectedOptions[0].disabled'), true);
    assert.doesNotMatch(await evaluate('document.getElementById("vector-mode").selectedOptions[0].text'), /Waiting/, 'the cancelled named source cannot keep waiting on unrelated work');
    assert.equal((await exportConfiguration()).settings.extensions.vectors.mode, namedStrainSource, 'the disabled field remembers its source for a later calculation');
    await evaluate('window.releaseNamedRestore(); window.releaseUnrelatedRestore(); window.restoreNamedReplayHook()');
    await waitFor('document.getElementById("local-shear-state").textContent === "Calculated"', 'unrelated calculation completes after named-source cancellation');
    assert.equal(await evaluate('document.getElementById("reference-strain-state").textContent'), 'Not calculated');
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "referenceStrain")'), false);
    await assertArrowVisibilityInBothViews(false, 'neither late source nor unrelated results can reenable the cancelled named vector');
  } finally { await evaluate('window.releaseNamedRestore?.(); window.releaseUnrelatedRestore?.(); window.restoreNamedReplayHook()'); }
  await call('DOM.setFileInputFiles', { nodeId: recipeInput, files: [recipePath] });
  await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("reference-strain-state").textContent === "Calculated"', 'recipe replay after an interrupted comparison edit');
  compareSettings((await exportConfiguration()).settings.extensions, recipe.settings.extensions, 'comparison settings replay after interruption');

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
  for (const kind of ['bonds', 'vectors', 'displacement', 'referenceStrain', 'localShear', 'rdf', 'measurements', 'comparison']) disabled.settings.extensions[kind].enabled = false;
  for (const field of disabled.settings.extensions.vectors.fields) field.enabled = false;
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
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "displacement")'), false);
    assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.bonds || window.atomToolsRenderer.primitiveLayer?.vectors)'), false);
  }
  assert.equal(await evaluate('document.getElementById("show-vectors").checked || document.getElementById("compare-view").checked || document.getElementById("measure-mode").checked'), false);

  const legacyDisplacement = structuredClone(disabled);
  delete legacyDisplacement.settings.extensions.displacement;
  delete legacyDisplacement.settings.extensions.vectors.fields;
  delete legacyDisplacement.settings.extensions.vectors.selectedId;
  Object.assign(legacyDisplacement.settings.extensions.vectors, { mode: 'displacement', enabled: false, referenceFrame: 0, minimumImage: true });
  const legacyPath = resolve(profile, 'legacy-displacement-vector.json');
  await writeFile(legacyPath, JSON.stringify(legacyDisplacement));
  await call('DOM.setFileInputFiles', { nodeId: recipeInput, files: [legacyPath] });
  await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("displacement-state").textContent === "Calculated"', 'legacy Vector displacement migrates to independent analysis');
  assert.deepEqual((await exportConfiguration()).settings.extensions.displacement, { enabled: true, referenceFrame: 0, minimumImage: true, tiles: [0, 0, 0] });
  assert.equal(await evaluate('document.getElementById("show-vectors").checked'), false);
  assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false);
  assert.ok(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.name === "displacementMagnitude")'));

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

  await change('legend-color-mode', 'type');
  assert.equal(await evaluate('document.querySelectorAll("#legend input[data-atom-type]").length'), 2, 'all atom-type legend rows have visibility checkboxes');
  await evaluate('document.querySelector("#legend input[data-atom-type=C]").click()');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [0, 255]);
  await change('legend-color-mode', 'property:bfactor');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [0, 255], 'element visibility remains effective under scalar coloring');
  await change('legend-color-mode', 'type');
  assert.equal(await evaluate('document.querySelector("#legend input[data-atom-type=C]").checked'), false);
  assert.equal(await evaluate('document.querySelector("#legend input[data-atom-type=N]").checked'), true);
  const elementFilterRecipe = await exportConfiguration();
  assert.deepEqual(elementFilterRecipe.settings.colors.hiddenAtomTypes, ['C']);
  await evaluate('document.querySelector("#legend input[data-atom-type=C]").click()');
  await evaluate('document.querySelector("#legend [data-legend-action=unselect-all]").click()');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [0, 0]);
  await evaluate('document.querySelector("#legend [data-legend-action=select-all]").click()');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [255, 255]);

  // Two synthetic categorical data fields exercise the same supported palette
  // interface as crystal classifications while intentionally reusing their IDs
  // for unrelated labels. Register through a normal Displacement refresh.
  await evaluate(`(() => {
    const frame = window.atomToolsRenderer.frame;
    frame.properties.push(
      { name: 'testCategoryA', displayName: 'Category A', data: new Uint8Array([0, 1]), categories: [{ id: 0, label: 'Alpha', color: [200, 50, 70] }, { id: 1, label: 'Beta', color: [40, 150, 80] }, { id: 2, label: 'Unused', color: [130, 130, 130] }] },
      { name: 'testCategoryB', displayName: 'Category B', data: new Uint8Array([0, 1]), categories: [{ id: 0, label: 'Low', color: [30, 100, 220] }, { id: 1, label: 'High', color: [200, 170, 30] }] },
    );
  })()`);
  await showTool('displacement');
  await waitFor('Array.from(document.getElementById("legend-color-mode").options).some(option => option.value === "property:testCategoryB")', 'additional category fields registered');
  await change('legend-color-mode', 'property:testCategoryA');
  assert.equal(await evaluate('document.querySelectorAll("#legend input[data-category-property=testCategoryA]").length'), 3, 'zero-count categories stay available');
  await evaluate(`document.querySelector('#legend input[data-category-property="testCategoryA"][data-category-id="0"]').click()`);
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [0, 255]);
  await change('legend-color-mode', 'property:testCategoryB');
  assert.ok(await evaluate('Array.from(document.querySelectorAll("#legend input[data-category-property=testCategoryB]")).every(input => input.checked)'), 'numeric category IDs do not transfer unrelated filters');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [255, 255]);
  await evaluate(`document.querySelector('#legend input[data-category-property="testCategoryB"][data-category-id="1"]').click()`);
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [255, 0]);
  await change('legend-color-mode', 'property:testCategoryA');
  assert.equal(await evaluate('document.querySelector("#legend input[data-category-property=testCategoryA][data-category-id=\\"0\\"]").checked'), false);
  assert.equal(await evaluate('document.querySelector("#legend input[data-category-property=testCategoryA][data-category-id=\\"1\\"]").checked'), true);
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [0, 255], 'each category field remembers its own filters');
  await evaluate('document.querySelector("#legend [data-legend-action=unselect-all]").click()');
  assert.ok(await evaluate('Array.from(document.querySelectorAll("#legend input[data-category-property=testCategoryA]")).every(input => !input.checked)'), 'bulk unselect includes zero-count categories');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [0, 0]);
  await change('legend-color-mode', 'property:testCategoryB');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [255, 0], 'bulk category actions do not affect other fields');
  await change('legend-color-mode', 'property:testCategoryA');
  await evaluate('document.querySelector("#legend [data-legend-action=select-all]").click()');
  assert.ok(await evaluate('Array.from(document.querySelectorAll("#legend input[data-category-property=testCategoryA]")).every(input => input.checked)'));
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [255, 255]);
  await evaluate(`document.querySelector('#legend input[data-category-property="testCategoryA"][data-category-id="0"]').click()`);
  const categoryRecipe = await exportConfiguration();
  assert.deepEqual(categoryRecipe.settings.colors.hiddenCategories.find(entry => entry.property === 'testCategoryA'), { property: 'testCategoryA', ids: [0] });
  assert.deepEqual(categoryRecipe.settings.colors.hiddenCategories.find(entry => entry.property === 'testCategoryB'), { property: 'testCategoryB', ids: [1] });

  // The next source reverses atom/type order between frames. Element filters
  // must follow labels while Vector simply displays imported velocity values.
  const velocityPath = resolve(profile, 'velocity-categories.extxyz');
  await writeFile(velocityPath, [
    '2', 'Lattice="10 0 0 0 10 0 0 0 10" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1:velocity:R:3:moment:R:3:partial:R:2 Step=0',
    'Cu 2 2 2 1 1 2 3 7 8 9 0 1', 'Ni 6 6 6 2 4 5 6 10 11 12 2 3',
    '2', 'Lattice="10 0 0 0 10 0 0 0 10" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1:velocity:R:3:moment:R:3:partial:R:2 Step=1',
    'Ni 6.2 6.2 6.2 2 4 5 6 10 11 12 2 3', 'Cu 2.2 2.2 2.2 1 1 2 3 7 8 9 0 1',
  ].join('\n') + '\n');
  await loadFile(velocityPath, 'velocity-categories.extxyz');
  await showTool('vectors');
  assert.equal(await evaluate('document.getElementById("vector-mode").value'), 'generic');
  assert.equal(await evaluate('document.getElementById("show-vectors").checked'), false);
  assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "displacement" || property.name.startsWith("testCategory"))'), false, 'computed and categorical fields from an earlier source cannot reappear');
  assert.equal(await evaluate('Array.from(document.getElementById("vector-mode").options).some(option => option.value === "force" || option.value === "displacement")'), false, 'new sources omit unavailable imported or calculated vector presets');
  assert.equal(await evaluate('Array.from(document.getElementById("vector-mode").options).some(option => option.value === "property:moment")'), true, 'other complete imported triplets appear automatically');
  assert.equal(await evaluate('Array.from(document.getElementById("vector-mode").options).some(option => option.value === "property:partial")'), false, 'incomplete triplets are not vector presets');
  const importedVelocityProperties = await evaluate('window.atomToolsRenderer.frame.properties.map(property => property.name)');
  await change('vector-mode', 'property:moment');
  await change('show-vectors', true);
  await waitFor('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)', 'dynamic imported triplet arrows');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.primitiveLayer.vectors.slice(0, 3))'), [7, 8, 9]);
  assert.deepEqual(await evaluate('window.atomToolsRenderer.frame.properties.map(property => property.name)'), importedVelocityProperties);
  await change('show-vectors', false);
  await change('vector-mode', 'velocity');
  await assertVectorGroups({ 'vector-components': false, 'vector-component-scales': false });
  const rawVelocitySample = await evaluate('["velocity_0", "velocity_1", "velocity_2"].map(name => Array.from(window.atomToolsRenderer.frame.properties.find(property => property.name === name).data))');
  assert.deepEqual(rawVelocitySample, [[1, 4], [2, 5], [3, 6]]);
  assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind || property.name === "velocityMagnitude")'), false, 'Vector does not generate derived properties for imported presets');
  assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false);
  await change('vector-scale', 9);
  assert.deepEqual(await evaluate('["velocity_0", "velocity_1", "velocity_2"].map(name => Array.from(window.atomToolsRenderer.frame.properties.find(property => property.name === name).data))'), rawVelocitySample);
  await change('legend-color-mode', 'type');
  await evaluate('document.querySelector("#legend input[data-atom-type=Cu]").click()');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [0, 255]);
  await change('legend-color-mode', 'property:velocity_0');
  assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:velocity_0');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [0, 255]);
  await click('frame-next');
  await waitFor('window.atomToolsRenderer.frame.frameIndex === 1 && document.getElementById("loading").hidden', 'imported velocity follows a reordered frame');
  assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'property:velocity_0');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [255, 0], 'element labels retain visibility when frame type indices change');
  assert.equal(await evaluate('Boolean(window.atomToolsRenderer.primitiveLayer?.vectors)'), false);
  await change('legend-color-mode', 'type');
  assert.equal(await evaluate('document.querySelector("#legend input[data-atom-type=Cu]").checked'), false);
  assert.equal(await evaluate('document.querySelector("#legend input[data-atom-type=Ni]").checked'), true);
  await evaluate('document.querySelector("#legend input[data-atom-type=Cu]").click()');
  assert.deepEqual(await evaluate('Array.from(window.atomToolsRenderer.visibility)'), [255, 255]);

  await showTool('displacement');
  await waitFor('document.getElementById("displacement-state").textContent === "Calculated"', 'displacement on a reordered stable-ID source');
  assert.ok(await evaluate(`(() => {
    const properties = window.atomToolsRenderer.frame.properties;
    return ['X', 'Y', 'Z', 'Magnitude'].every(axis => properties.find(property => property.name === 'displacement' + axis).data.every(value => Math.abs(value - (axis === 'Magnitude' ? Math.hypot(.2, .2, .2) : .2)) < 2e-6));
  })()`), 'stable IDs match reordered atoms rather than rows when calculating displacement');
  await change('legend-color-mode', 'property:displacementMagnitude');
  await showTool('vectors');
  await change('vector-mode', 'displacement');
  await change('show-vectors', true);
  await change('displacement-reference-frame', 2);
  await waitFor('document.getElementById("displacement-state").textContent === "Calculated" && window.atomToolsRenderer.frame.properties.find(property => property.name === "displacementMagnitude")?.data.every(value => value === 0)', 'self-reference before source replacement');
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { FrameCache } = await import(new URL('./data/frame-cache.js', appUrl));
    const { StructureWorkerClient } = await import(new URL('./worker-client.js', appUrl));
    const get = FrameCache.prototype.get, frame = StructureWorkerClient.prototype.frame;
    let miss = true, hold = true;
    window.displacementSourceHeld = false;
    FrameCache.prototype.get = function(index) { if (index === 0 && miss) { miss = false; return undefined; } return get.call(this, index); };
    StructureWorkerClient.prototype.frame = function(index, ...rest) {
      const result = frame.call(this, index, ...rest);
      if (index !== 0 || !hold) return result;
      hold = false;
      return result.then(value => new Promise(resolve => { window.displacementSourceHeld = true; window.releaseDisplacementSource = () => resolve(value); }));
    };
    window.restoreDisplacementSourceHooks = () => { FrameCache.prototype.get = get; StructureWorkerClient.prototype.frame = frame; };
  })()`);
  try {
    await change('displacement-minimum-image', false);
    await change('displacement-reference-frame', 1);
    await waitFor('window.displacementSourceHeld', 'held displacement during source replacement');
    await loadFile(pdbPath, 'atom-tools.pdb');
    await evaluate('window.releaseDisplacementSource(); window.restoreDisplacementSourceHooks(); new Promise(resolve => setTimeout(resolve, 60))');
    assert.equal(await evaluate('document.getElementById("displacement-state").textContent'), 'Not calculated');
    assert.equal(await evaluate('window.atomToolsRenderer.frame.properties.some(property => property.analysisKind === "displacement")'), false, 'a stale source result cannot attach displacement to a new file');
    assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'type');
    assert.equal(await evaluate('document.getElementById("vector-mode").value'), 'generic');
    assert.equal(await evaluate('document.getElementById("show-vectors").checked'), false);
    assert.equal(await evaluate('Array.from(document.getElementById("vector-mode").options).some(option => option.value === "displacement")'), false);
  } finally { await evaluate('window.restoreDisplacementSourceHooks(); window.releaseDisplacementSource?.()'); }
  console.log('Legend quantity checks passed: all-category checkboxes and Select all/Unselect all, per-field category filters without ID leakage, stable element-label filters across modes/reordered frames, saved filters and synchronized scalar choices.');
  console.log('Independent displacement and display-only Vector passed: explicit enable, scientific dilation/components/magnitude, stable IDs, reference changes, cancellation during/after processing and across cached frames/sources, old recipe migration, available imported triplets, unchanged source values, and 2D/3D arrow GPU coverage with all atoms hidden in both views.');
  console.log(`AtomEye alignment browser checks passed: XYZ/PDB parsing; ID lookup and centering; distance/angle/dihedral picks; atom and element appearance; pair-cutoff bonds and vectors; coordination histogram and RDF CSV; reference strain and local shear; cancellation; ${workerCount} reused Workers; simultaneous views with matching primitives and phone layout; JPG, six-view PNG, frame ZIP and visible IDs; persistent configuration replay and removed EPS.`);
}
