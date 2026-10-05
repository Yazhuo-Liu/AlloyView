import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crystalFrame } from '../tests/helpers/crystals.js';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Exercise the actual production UI and 60,229-atom Fe dump. SwiftShader is
// only the WebGL display adapter; the application's GPU-computing switch is
// disabled before any analysis. These timings do not measure hardware speed.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
// Optional visual comparison reuses the original renderer from Git without
// changing source files or the native result. Regular regression needs no Git.
const legacyLayerSource = process.argv.includes('--capture-baseline')
  ? execFileSync('git', ['show', 'HEAD:src/render/dislocation-layer.js'], { cwd: root, encoding: 'utf8' }) : null;
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-dxa-visual-fixtures-'));
const screenshotArgument = process.argv.find(argument => argument.startsWith('--screenshot-dir='));
const screenshots = resolve(screenshotArgument?.slice('--screenshot-dir='.length)
  ?? process.env.ALLOYVIEW_DXA_SCREENSHOT_DIR ?? resolve(tmpdir(), 'alloyview-dxa-visual'));
await mkdir(screenshots, { recursive: true });
const perfect = crystalFrame('bcc', 4, 2.86);
const perfectPath = resolve(temporary, 'perfect-bcc.xyz');
await writeFile(perfectPath, [String(perfect.ids.length),
  `Lattice="${Array.from(perfect.cell.vectors).join(' ')}" Properties=species:S:1:pos:R:3:id:I:1:energy:R:1 pbc="T T T"`,
  ...Array.from(perfect.ids, (id, atom) => `Fe ${Array.from(perfect.positions.subarray(atom * 3, atom * 3 + 3)).join(' ')} ${id} ${atom / 1000}`),
  '',
].join('\n'));

try {
  const report = await withWebGpuBrowser(async ({ evaluate, call, adapter }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1060, deviceScaleFactor: 1, mobile: false });
    // The UI reserves two reported logical processors, leaving six for DXA.
    await call('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 8 });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 120_000) {
      const started = Date.now(), deadline = started + timeoutMs;
      let lastReport = started;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        if (Date.now() - lastReport >= 30_000) {
          console.log(JSON.stringify({ phase: label, elapsedMs: Date.now() - started,
            status: await evaluate('document.getElementById("dxa-status")?.textContent') }));
          lastReport = Date.now();
        }
        await delay(50);
      }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({dxa:document.getElementById("dxa-status")?.textContent,toast:document.getElementById("toast")?.textContent,recipe:document.getElementById("configuration-status")?.textContent})')}`);
    }
    await waitFor('document.readyState === "complete" && document.querySelector("[data-tool-button=dxa]")', 'Production application startup');
    await evaluate(`(${initializeChecks.toString()})()`);
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true')
      document.getElementById('enable-gpu-computing').click()`);
    assert.equal(await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")'), 'false');

    async function openFile(path, name) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(name)}
        && visualDxa.renderer?.frame && document.getElementById('loading').hidden
        && !document.getElementById('run-dxa').disabled`, `${name} import`);
    }
    async function extract() {
      await evaluate('visualDxa.showTool("dxa"); document.getElementById("run-dxa").click()');
      await waitFor('document.getElementById("dxa-state").textContent === "Calculated"', 'CPU DXA extraction', 240_000);
    }
    async function exportConfiguration() {
      return evaluate(`(async () => {
        const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
        let saved;
        URL.createObjectURL = function(blob) { saved = blob; return createUrl.call(this, blob); };
        HTMLAnchorElement.prototype.click = () => {};
        try {
          document.getElementById('export-configuration').click();
          if (!saved) throw new Error('Configuration download did not contain a Blob.');
          visualDxa.recipe = await saved.text(); return JSON.parse(visualDxa.recipe);
        } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
      })()`);
    }
    async function screenshot(name, viewportOnly = false) {
      await evaluate('visualDxa.renderer.render(performance.now(), { trackStats: false })');
      const clip = viewportOnly ? await evaluate(`(() => {
        const { x, y, width, height } = document.getElementById('viewport').getBoundingClientRect();
        return { x, y, width, height, scale: 1 };
      })()`) : undefined;
      const { data } = await call('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
      const path = resolve(screenshots, name);
      await writeFile(path, Buffer.from(data, 'base64'));
      return path;
    }

    await openFile(resolve(root, 'examples/Fe_disloc_loop.dump'), 'Fe_disloc_loop.dump');
    await evaluate('visualDxa.change("dxa-lattice","bcc"); visualDxa.sourceCoordinates = visualDxa.renderer.frame.fractional.slice()');
    assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'type');
    await extract();
    const scientific = await evaluate(`(() => {
      const r = visualDxa.renderer, n = r.dislocationNetwork, s = n.segments[0];
      const p = r.frame.properties.find(p => p.name === 'dxaStructureType');
      visualDxa.sourceNetwork = visualDxa.snapshotNetwork(n);
      return { atoms: r.frame.ids.length, isolated: crossOriginIsolated, backend: n.backend,
        workerCount: n.workerCount, segments: n.segments.length, length: n.totalLength,
        density: n.density, volume: n.volume, family: s.familyId, structureType: s.structureType,
        segmentId: s.id, closed: s.closed, infinite: s.isInfinite, points: s.points.length / 3, junctions: s.junctions,
        endpointError: Math.max(...[0,1,2].map(axis => Math.abs(s.points[axis] - s.points[s.points.length - 3 + axis]))),
        burgersMagnitude: Math.hypot(...s.burgersVector), spatialBurgersMagnitude: Math.hypot(...s.spatialBurgersVector),
        sourceCoordinatesUnchanged: r.frame.fractional.every((value, i) => value === visualDxa.sourceCoordinates[i]),
        categories: Array.from(p.categories, category => ({ id: category.id, label: category.label })),
        analysisKind: p.analysisKind, displayName: p.displayName,
        counts: Array.from(p.data).reduce((counts, id) => { counts[id] = (counts[id] ?? 0) + 1; return counts; }, {}),
        selectedColor: document.getElementById('legend-color-mode').value,
        colorOptions: ['color-mode', 'legend-color-mode'].map(id => Array.from(document.getElementById(id).options)
          .filter(option => option.value === 'property:dxaStructureType').map(option => option.textContent)),
        legendRows: visualDxa.legendRows(), elapsedMs: n.elapsedMs };
    })()`);
    assert.equal(scientific.atoms, 60229); assert.equal(scientific.backend, 'cpu');
    assert.equal(scientific.segments, 1); assert.equal(scientific.family, 'half111');
    assert.equal(scientific.structureType, 3); assert.equal(scientific.closed, true); assert.equal(scientific.infinite, false);
    assert.ok(scientific.endpointError < 1e-6);
    assert.deepEqual(scientific.junctions, [[{ segmentId: scientific.segmentId, end: 1 }], [{ segmentId: scientific.segmentId, end: 0 }]]);
    // Parallel Delaunay tie ordering can select another equivalent loop
    // representative. Require physical parity with the serial native reference.
    assert.ok(Math.abs(scientific.length - 103.9618) / 103.9618 < .01, JSON.stringify(scientific));
    assert.ok(Math.abs(scientific.burgersMagnitude - Math.sqrt(3) / 2) < 1e-10);
    assert.ok(scientific.spatialBurgersMagnitude > 2.4 && scientific.spatialBurgersMagnitude < 2.5);
    assert.ok(Math.abs(scientific.density - scientific.length / scientific.volume) < 1e-15);
    assert.equal(scientific.sourceCoordinatesUnchanged, true);
    assert.deepEqual(scientific.counts, { 0: 222, 3: 60007 });
    assert.equal(scientific.analysisKind, 'dxa'); assert.equal(scientific.displayName, 'Crystal structure (DXA)');
    assert.equal(scientific.selectedColor, 'property:dxaStructureType');
    assert.deepEqual(scientific.colorOptions, [['Crystal structure (DXA)'], ['Crystal structure (DXA)']]);
    assert.deepEqual(scientific.categories.map(category => category.label), ['Other', 'FCC', 'HCP', 'BCC', 'Cubic diamond', 'Hexagonal diamond']);
    assert.ok(scientific.legendRows.find(row => row.id === '3')?.count.includes('60,007'));
    assert.ok(scientific.legendRows.find(row => row.id === '0')?.count.includes('222'));
    console.log(JSON.stringify({ phase: 'Real Fe CPU DXA and crystal legend', ...scientific }));

    const geometry = await evaluate('visualDxa.checkTubeGeometry()');
    console.log(JSON.stringify({ phase: 'Smooth connected Fe loop geometry', ...geometry }));
    assert.equal(geometry.curves, 1); assert.equal(geometry.closed, true);
    assert.equal(geometry.capStart, false); assert.equal(geometry.capEnd, false);
    assert.equal(geometry.closedSeamUsesFirstRing, true);
    assert.equal(geometry.connectedMesh, true); assert.equal(geometry.finite, true);
    assert.ok(geometry.ringCount > scientific.points, 'The display curve must subdivide native bends smoothly.');
    assert.equal(geometry.sourceNetworkUnchanged, true);

    await evaluate(`visualDxa.showTool('centrosymmetry'); visualDxa.change('csp-neighbors','8');
      document.getElementById('run-csp').click()`);
    await waitFor('document.getElementById("csp-state").textContent === "Calculated"', 'Independent normalized central symmetry');
    await evaluate(`visualDxa.change('legend-color-mode','property:centralSymmetry');
      visualDxa.change('crystal-visibility-source','dxaStructureType'); visualDxa.showTool('dxa')`);
    const atomFilters = await evaluate(`(() => {
      visualDxa.crystalCategory('dxaStructureType', 3, false);
      const withoutBcc = visualDxa.visibleAtoms();
      const identity = visualDxa.renderer.dislocationNetwork, analyses = visualDxa.analyses;
      visualDxa.change('dxa-smoothing', document.getElementById('dxa-smoothing').value);
      return { withoutBcc, selectedColor: document.getElementById('legend-color-mode').value,
        afterAutomaticRefresh: visualDxa.visibleAtoms(), analysesUnchanged: visualDxa.analyses === analyses,
        networkReused: visualDxa.renderer.dislocationNetwork === identity };
    })()`);
    assert.equal(atomFilters.withoutBcc, 222); assert.equal(atomFilters.afterAutomaticRefresh, 222);
    assert.equal(atomFilters.selectedColor, 'property:centralSymmetry');
    assert.equal(atomFilters.analysesUnchanged, true); assert.equal(atomFilters.networkReused, true);
    const coreScreenshot = await screenshot('fe-loop-dxa-core-atoms.png');

    const scalarRange = await evaluate(`(() => {
      const r = visualDxa.renderer, values = r.frame.properties.find(p => p.name === 'centralSymmetry').data;
      const types = r.frame.properties.find(p => p.name === 'dxaStructureType').data;
      const coreValues = Array.from(values).filter((value, atom) => types[atom] === 0 && Number.isFinite(value)).sort((a,b) => a-b);
      const upper = coreValues[Math.floor(coreValues.length / 2)];
      const fields = document.querySelectorAll('#color-legend .legend-controls input[type=number]');
      if (!document.querySelector('#color-legend .legend-visibility input').checked) throw new Error('Scalar Hide outside must be enabled.');
      const analyses = visualDxa.analyses, atomAnalyses = visualDxa.atomAnalyses;
      fields[1].value = String(upper); fields[1].dispatchEvent(new Event('input', { bubbles: true }));
      const minimum = fields[0].valueAsNumber, maximum = fields[1].valueAsNumber;
      const inRange = value => Number.isFinite(value) && value >= minimum && value <= maximum;
      const expectedScalar = values.reduce((count, value) => count + Number(inRange(value)), 0);
      const expectedOther = values.reduce((count, value, atom) => count + Number(types[atom] === 0 && inRange(value)), 0);
      const afterLiveEdit = visualDxa.visibleAtoms();
      visualDxa.crystalCategory('dxaStructureType', 3, true);
      const afterShowingBcc = visualDxa.visibleAtoms();
      visualDxa.crystalCategory('dxaStructureType', 3, false);
      return { minimum, maximum, expectedScalar, expectedOther, afterLiveEdit, afterShowingBcc,
        afterHidingBcc: visualDxa.visibleAtoms(), analysesUnchanged: visualDxa.analyses === analyses && visualDxa.atomAnalyses === atomAnalyses,
        excludedStayHidden: r.visibility.every((visible, atom) => !visible || inRange(values[atom])),
        selectedColor: document.getElementById('legend-color-mode').value };
    })()`);
    assert.ok(scalarRange.expectedOther > 0 && scalarRange.expectedOther < 222, JSON.stringify(scalarRange));
    assert.equal(scalarRange.afterLiveEdit, scalarRange.expectedOther);
    assert.equal(scalarRange.afterShowingBcc, scalarRange.expectedScalar);
    assert.equal(scalarRange.afterHidingBcc, scalarRange.expectedOther);
    assert.equal(scalarRange.excludedStayHidden, true); assert.equal(scalarRange.analysesUnchanged, true);
    assert.equal(scalarRange.selectedColor, 'property:centralSymmetry');

    await evaluate(`document.querySelector('#crystal-visibility [data-crystal-action="unselect-all"]').click();
      visualDxa.change('dxa-line-radius', '0.5'); visualDxa.change('show-cell', false, true);
      visualDxa.change('show-axes', false, true); document.querySelector('[data-background="#ffffff"]').click();
      visualDxa.frameLoop()`);
    const linesOnly = await evaluate('visualDxa.pixels()');
    assert.equal(await evaluate('visualDxa.visibleAtoms()'), 0);
    assert.equal(linesOnly.error, 0); assert.ok(linesOnly.foreground > 1000, JSON.stringify(linesOnly));
    assert.equal(linesOnly.components, 1, 'The enlarged finite loop must draw one connected surface.');
    let legacyScreenshot = null;
    if (legacyLayerSource !== null) {
      const baseline = await evaluate(`(async () => {
        const r = visualDxa.renderer, current = r.dislocationLayer;
        const app = document.querySelector('script[type=module][src]').src;
        const moduleUrl = new URL('./render/dislocation-layer.js', app);
        const source = ${JSON.stringify(legacyLayerSource)}.replace(/from\\s+(['"])(\\.[^'"]+)\\1/g,
          (_match, _quote, specifier) => 'from ' + JSON.stringify(new URL(specifier, moduleUrl).href));
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        let legacy;
        try {
          const { DislocationLayer } = await import(url); legacy = new DislocationLayer(r.gl);
          legacy.setNetwork(r, r.dislocationNetwork, r.dislocationOptions); r.dislocationLayer = legacy;
          return r.captureImage({ includeBackground: true, includeAxes: false }).toDataURL('image/png');
        } finally {
          r.dislocationLayer = current; legacy?.dispose?.(); URL.revokeObjectURL(url); r.requestRender();
        }
      })()`);
      legacyScreenshot = resolve(screenshots, 'fe-loop-dxa-legacy-export.png');
      await writeFile(legacyScreenshot, Buffer.from(baseline.split(',')[1], 'base64'));
    }
    const viewportScreenshot = await screenshot('fe-loop-dxa-continuous-tube.png', true);
    await evaluate('document.getElementById("dxa-results").scrollIntoView({ block: "nearest", inline: "nearest" })');
    const controlsScreenshot = await screenshot('fe-loop-dxa-controls.png');
    const exported = await evaluate(`(() => {
      const r = visualDxa.renderer, canvas = r.captureImage({ includeBackground: true, includeAxes: false });
      return { png: canvas.toDataURL('image/png'), pixels: visualDxa.pixelSummary(canvas.getContext('2d')
        .getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height),
        sourceNetworkUnchanged: visualDxa.snapshotNetwork(r.dislocationNetwork) === visualDxa.sourceNetwork };
    })()`);
    assert.ok(exported.png.startsWith('data:image/png;base64,')); assert.ok(exported.pixels.foreground > 1000);
    assert.equal(exported.sourceNetworkUnchanged, true);
    const exportScreenshot = resolve(screenshots, 'fe-loop-dxa-export.png');
    await writeFile(exportScreenshot, Buffer.from(exported.png.split(',')[1], 'base64'));

    const independentFamilies = await evaluate(`(() => {
      const checkbox = Array.from(document.querySelectorAll('#dxa-families input[type=checkbox]'))
        .find(input => input.getAttribute('aria-label').includes('1/2'));
      const network = visualDxa.renderer.dislocationNetwork, colors = visualDxa.renderer.atomColors;
      const analyses = visualDxa.analyses;
      checkbox.checked = false; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      const hidden = visualDxa.pixels();
      checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      const shown = visualDxa.pixels();
      return { hidden, shown, atomsHidden: visualDxa.visibleAtoms() === 0,
        analysesUnchanged: visualDxa.analyses === analyses, colorsUnchanged: colors === visualDxa.renderer.atomColors,
        sourceNetworkUnchanged: network === visualDxa.renderer.dislocationNetwork
          && visualDxa.snapshotNetwork(network) === visualDxa.sourceNetwork };
    })()`);
    assert.equal(independentFamilies.hidden.foreground, 0); assert.ok(independentFamilies.shown.foreground > 1000);
    assert.equal(independentFamilies.atomsHidden, true); assert.equal(independentFamilies.analysesUnchanged, true);
    assert.equal(independentFamilies.colorsUnchanged, true); assert.equal(independentFamilies.sourceNetworkUnchanged, true);

    const recipe = await exportConfiguration();
    assert.equal(recipe.settings.compute.gpuEnabled, false);
    assert.equal(recipe.settings.display.colorMode, 'property:centralSymmetry');
    assert.equal(recipe.settings.colors.crystalVisibilitySource, 'dxaStructureType');
    assert.equal(recipe.settings.colors.ranges.find(entry => entry.property === 'centralSymmetry').maximum, scalarRange.maximum);
    assert.equal(recipe.settings.extensions.dxa.radius, .5);
    assert.deepEqual(recipe.settings.colors.hiddenCategories.find(entry => entry.property === 'dxaStructureType').ids.toSorted(),
      [0, 1, 2, 3, 4, 5]);
    assert.equal(JSON.stringify(recipe).includes('burgersVector'), false);
    await evaluate(`document.getElementById('cancel-dxa').click(); (() => {
      const transfer = new DataTransfer(); transfer.items.add(new File([visualDxa.recipe], 'dxa-recipe.json', { type: 'application/json' }));
      const input = document.getElementById('configuration-file'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("dxa-state").textContent === "Calculated"', 'Fe DXA configuration replay', 240_000);
    const replay = await evaluate(`({ analyses: visualDxa.analyses, hidden: visualDxa.visibleAtoms() === 0,
      colorMode: document.getElementById('legend-color-mode').value,
      crystalSource: document.getElementById('crystal-visibility-source').value,
      radius: visualDxa.renderer.dislocationOptions.radius,
      counts: visualDxa.renderer.dislocationNetwork.structureCounts, pixels: visualDxa.pixels(),
      sourceCoordinatesUnchanged: visualDxa.renderer.frame.fractional.every((value, i) => value === visualDxa.sourceCoordinates[i]) })`);
    assert.equal(replay.analyses, 2); assert.equal(replay.hidden, true); assert.equal(replay.radius, .5);
    assert.equal(replay.colorMode, 'property:centralSymmetry'); assert.equal(replay.crystalSource, 'dxaStructureType');
    assert.ok(replay.pixels.foreground > 1000);
    assert.equal(replay.sourceCoordinatesUnchanged, true);
    const replayRange = await evaluate(`(() => {
      visualDxa.crystalCategory('dxaStructureType',0,true); const visibleOther = visualDxa.visibleAtoms();
      visualDxa.crystalCategory('dxaStructureType',0,false); return { visibleOther, hiddenAgain: visualDxa.visibleAtoms() === 0 };
    })()`);
    assert.equal(replayRange.visibleOther, scalarRange.expectedOther); assert.equal(replayRange.hiddenAgain, true);

    // A small perfect crystal verifies zero-line results and independent CNA /
    // PTM ownership without repeating large unrelated analyses on the Fe dump.
    await openFile(perfectPath, 'perfect-bcc.xyz');
    await evaluate('visualDxa.change("dxa-lattice","bcc"); visualDxa.showTool("cna"); document.getElementById("run-cna").click()');
    await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'Independent CNA');
    await evaluate('visualDxa.showTool("ptm"); document.getElementById("run-ptm").click()');
    await waitFor('document.getElementById("ptm-state").textContent === "Calculated"', 'Independent PTM');
    await evaluate(`visualDxa.preservedProperties = visualDxa.renderer.frame.properties.filter(p => ['cna', 'ptm'].includes(p.analysisKind));
      visualDxa.change('legend-color-mode', 'property:structureType'); visualDxa.category('structureType',3,false);
      visualDxa.change('legend-color-mode', 'type')`);
    await extract();
    await evaluate('visualDxa.change("crystal-visibility-source","dxaStructureType")');
    const noLines = await evaluate(`({ segments: visualDxa.renderer.dislocationNetwork.segments.length,
      visibleAtoms: visualDxa.visibleAtoms(), colorMode: document.getElementById('legend-color-mode').value,
      types: Array.from(visualDxa.renderer.frame.properties.find(p => p.name === 'dxaStructureType').data),
      rows: visualDxa.legendRows() })`);
    assert.equal(noLines.segments, 0); assert.equal(noLines.visibleAtoms, perfect.ids.length);
    assert.equal(noLines.colorMode, 'property:dxaStructureType');
    assert.ok(noLines.types.every(type => type === 3)); assert.equal(noLines.rows.length, 6);
    await evaluate('visualDxa.category("dxaStructureType",3,false); document.getElementById("cancel-dxa").click()');
    const cancellation = await evaluate(`({ networkCleared: visualDxa.renderer.dislocationNetwork === null,
      selectedColor: document.getElementById('legend-color-mode').value,
      dxaPropertiesRemoved: !visualDxa.renderer.frame.properties.some(p => p.analysisKind === 'dxa'),
      optionRemoved: !Array.from(document.getElementById('legend-color-mode').options).some(o => o.value === 'property:dxaStructureType'),
      propertiesPreserved: visualDxa.preservedProperties.length > 0 && visualDxa.preservedProperties.every(p => visualDxa.renderer.frame.properties.includes(p)),
      cnaState: document.getElementById('cna-state').textContent, ptmState: document.getElementById('ptm-state').textContent })`);
    assert.equal(cancellation.networkCleared, true); assert.equal(cancellation.dxaPropertiesRemoved, true);
    assert.equal(cancellation.optionRemoved, true); assert.equal(cancellation.selectedColor, 'type');
    assert.equal(cancellation.propertiesPreserved, true); assert.equal(cancellation.cnaState, 'Calculated'); assert.equal(cancellation.ptmState, 'Calculated');
    const cancelledRecipe = await exportConfiguration();
    assert.equal(cancelledRecipe.settings.colors.hiddenCategories.find(entry => entry.property === 'dxaStructureType')?.ids.length ?? 0, 0);
    assert.deepEqual(cancelledRecipe.settings.colors.hiddenCategories.find(entry => entry.property === 'structureType').ids, [3]);
    const sourceRange = await evaluate(`(() => {
      visualDxa.change('legend-color-mode','property:energy'); visualDxa.change('crystal-visibility-source','ptmStructureType');
      const analyses = visualDxa.analyses, atomAnalyses = visualDxa.atomAnalyses;
      const fields = document.querySelectorAll('#color-legend .legend-controls input[type=number]');
      fields[1].value = '0.0645'; fields[1].dispatchEvent(new Event('input', { bubbles: true }));
      const beforeSourceChange = visualDxa.visibleAtoms();
      visualDxa.change('crystal-visibility-source','structureType'); const hiddenByCna = visualDxa.visibleAtoms();
      visualDxa.change('crystal-visibility-source','ptmStructureType');
      return { beforeSourceChange, hiddenByCna, afterSourceChange: visualDxa.visibleAtoms(),
        excludedStayHidden: visualDxa.renderer.visibility.every((visible, atom) => !visible || visualDxa.renderer.frame.properties
          .find(p => p.name === 'energy').data[atom] <= .0645),
        selectedColor: document.getElementById('legend-color-mode').value,
        analysesUnchanged: visualDxa.analyses === analyses && visualDxa.atomAnalyses === atomAnalyses };
    })()`);
    assert.equal(sourceRange.beforeSourceChange, 65); assert.equal(sourceRange.hiddenByCna, 0);
    assert.equal(sourceRange.afterSourceChange, 65); assert.equal(sourceRange.excludedStayHidden, true);
    assert.equal(sourceRange.selectedColor, 'property:energy'); assert.equal(sourceRange.analysesUnchanged, true);
    await evaluate('visualDxa.change("legend-color-mode","type")');
    await evaluate(`visualDxa.showTool('dxa'); document.getElementById('run-dxa').click();
      visualDxa.change('legend-color-mode','property:ptmStructureType')`);
    await waitFor('document.getElementById("dxa-state").textContent === "Calculated"', 'DXA late coloring guard');
    assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'property:ptmStructureType',
      'A color choice made while DXA is running must survive its reply.');
    return { fixture: 'examples/Fe_disloc_loop.dump', adapter, gpuComputing: false,
      scientific, geometry, atomFilters, scalarRange, linesOnly, independentFamilies, replay, replayRange,
      noLines: { ...noLines, types: undefined }, cancellation, sourceRange,
      screenshots: { legacyScreenshot, coreScreenshot, viewportScreenshot, controlsScreenshot, exportScreenshot } };
  }, { software: useSoftwareAdapter(true), isolated: !process.argv.includes('--no-isolation') });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { DxaClient }, { createDislocationTubeGeometry }, { AnalysisPool }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/dxa-client.js', app)),
    import(new URL('./render/dislocation-layer.js', app)),
    import(new URL('./analysis/analysis-pool.js', app)),
  ]);
  const checks = window.visualDxa = { analyses: 0, atomAnalyses: 0, createDislocationTubeGeometry };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this;
    return setFrame.apply(this, args);
  };
  const analyze = DxaClient.prototype.analyze;
  DxaClient.prototype.analyze = function(...args) { checks.analyses++; return analyze.apply(this, args); };
  const atomAnalyze = AnalysisPool.prototype.analyze;
  AnalysisPool.prototype.analyze = function(...args) { checks.atomAnalyses++; return atomAnalyze.apply(this, args); };
  checks.change = (id, value, checkbox = false) => {
    const input = document.getElementById(id);
    if (checkbox) input.checked = value; else input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.showTool = name => {
    if (document.querySelector(`[data-tool-panel="${name}"]`).hidden) document.querySelector(`[data-tool-button="${name}"]`).click();
  };
  checks.category = (property, id, checked) => {
    const input = document.querySelector(`#legend input[data-category-property="${property}"][data-category-id="${id}"]`);
    if (!input) throw new Error(`Missing ${property} legend category ${id}.`);
    input.checked = checked; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.crystalCategory = (property, id, checked) => {
    const input = document.querySelector(`#crystal-visibility input[data-crystal-source="${property}"][data-crystal-type="${id}"]`);
    if (!input) throw new Error(`Missing independent ${property} visibility category ${id}.`);
    input.checked = checked; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.legendRows = () => Array.from(document.querySelectorAll('#legend input[data-category-id]'), input => ({
    id: input.dataset.categoryId, property: input.dataset.categoryProperty, label: input.getAttribute('aria-label'),
    checked: input.checked, count: input.closest('.legend-item').querySelector('.legend-count').textContent,
  }));
  checks.visibleAtoms = () => checks.renderer.visibility.reduce((count, value) => count + Number(value > 0), 0);
  checks.snapshotNetwork = network => JSON.stringify({ segments: network.segments.map(segment => ({ ...segment,
    points: Array.from(segment.points), burgersVector: Array.from(segment.burgersVector),
    spatialBurgersVector: Array.from(segment.spatialBurgersVector) })), totalLength: network.totalLength,
    density: network.density, counts: network.counts, structureCounts: network.structureCounts });
  checks.frameLoop = () => {
    const r = checks.renderer, points = r.dislocationNetwork.segments[0].points;
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (let point = 0; point < points.length; point++) {
      const axis = point % 3; minimum[axis] = Math.min(minimum[axis], points[point]); maximum[axis] = Math.max(maximum[axis], points[point]);
    }
    r.centerOnPoint(minimum.map((value, axis) => (value + maximum[axis]) / 2));
    const normal = r.dislocationNetwork.segments[0].spatialBurgersVector, norm = Math.hypot(...normal);
    r.yaw = Math.atan2(normal[0], -normal[1]); r.pitch = Math.asin(normal[2] / norm);
    r.setProjection('orthographic');
    r.orthographicScale = Math.hypot(...maximum.map((value, axis) => value - minimum[axis])) * .43;
    r.requestRender();
  };
  checks.pixelSummary = (pixels, width, height) => {
    const marked = new Uint8Array(width * height), queue = new Uint32Array(width * height);
    let foreground = 0, components = 0, largest = 0;
    for (let i = 0; i < marked.length; i++) {
      if (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2] < 745) { marked[i] = 1; foreground++; }
    }
    for (let i = 0; i < marked.length; i++) {
      if (marked[i] !== 1) continue;
      components++; let head = 0, tail = 1; queue[0] = i; marked[i] = 2;
      while (head < tail) {
        const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          const neighbor = pixel + dy * width + dx;
          if (marked[neighbor] === 1) { marked[neighbor] = 2; queue[tail++] = neighbor; }
        }
      }
      largest = Math.max(largest, tail);
    }
    return { foreground, components, largest, width, height };
  };
  checks.pixels = () => {
    const r = checks.renderer, gl = r.gl;
    r.render(performance.now(), { trackStats: false });
    const pixels = new Uint8Array(r.canvas.width * r.canvas.height * 4);
    gl.readPixels(0, 0, r.canvas.width, r.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { ...checks.pixelSummary(pixels, r.canvas.width, r.canvas.height), error: gl.getError() };
  };
  checks.checkTubeGeometry = () => {
    const r = checks.renderer, geometry = createDislocationTubeGeometry(r.dislocationNetwork, r.frame.cell, r.dislocationOptions);
    const curve = geometry.curves[0], adjacency = Array.from({ length: geometry.values.length / 12 }, () => []);
    for (let triangle = 0; triangle < geometry.indices.length; triangle += 3) {
      const [a, b, c] = geometry.indices.subarray(triangle, triangle + 3);
      adjacency[a].push(b, c); adjacency[b].push(a, c); adjacency[c].push(a, b);
    }
    const seen = new Set([0]), pending = [0];
    while (pending.length) for (const other of adjacency[pending.pop()]) if (!seen.has(other)) { seen.add(other); pending.push(other); }
    const firstRing = curve.vertexStart, lastRing = firstRing + (curve.ringCount - 1) * curve.radialSegments;
    let closedSeamUsesFirstRing = false;
    for (let triangle = curve.indexStart; triangle < curve.indexStart + curve.indexCount; triangle += 3) {
      const vertices = geometry.indices.subarray(triangle, triangle + 3);
      if (vertices.some(index => index >= firstRing && index < firstRing + curve.radialSegments)
        && vertices.some(index => index >= lastRing && index < lastRing + curve.radialSegments)) closedSeamUsesFirstRing = true;
    }
    return { curves: geometry.curves.length, ringCount: curve.ringCount, radialSegments: curve.radialSegments,
      vertices: geometry.values.length / 12, indices: geometry.indices.length, closed: curve.closed,
      capStart: curve.capStart, capEnd: curve.capEnd, closedSeamUsesFirstRing,
      connectedMesh: seen.size === adjacency.length, finite: geometry.values.every(Number.isFinite),
      sourceNetworkUnchanged: checks.snapshotNetwork(r.dislocationNetwork) === checks.sourceNetwork };
  };
}
