import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Production UI, real CPU Workers and scientifically known fixtures. Browser
// graphics use SwiftShader; no hardware GPU performance claim is made here.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const fixtures = await mkdtemp(resolve(tmpdir(), 'alloyview-topology-fixtures-'));
const artifacts = resolve(tmpdir(), 'alloyview-topology-tools');
const screenshotsOnly = process.argv.includes('--screenshots-only');
await mkdir(artifacts, { recursive: true });
const rightAngle = [[2, 2, 2], [3, 2, 2], [2, 3, 2]];
const fccBasis = [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]];
const bccBasis = [[0, 0, 0], [.5, .5, .5]];
function xyz(points, { lattice = [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc = 'F F F', step = 17, types } = {}) {
  return [String(points.length), `Lattice="${lattice.join(' ')}" pbc="${pbc}" Properties=species:S:1:pos:R:3:id:I:1:energy:R:1 Step=${step}`,
    ...points.map((position, index) => `${types?.[index] ?? 'Ni'} ${position.join(' ')} ${101 + index * 11} ${index === points.length - 1 ? 'NaN' : index / 10}`), ''].join('\n');
}
function crystal(basis, repeats = 1, a = 4) {
  const positions = [];
  for (let x = 0; x < repeats; x++) for (let y = 0; y < repeats; y++) for (let z = 0; z < repeats; z++) {
    for (const point of basis) positions.push(point.map((fractional, axis) => a * (fractional + [x, y, z][axis])));
  }
  return xyz(positions, { lattice: [a * repeats, 0, 0, 0, a * repeats, 0, 0, 0, a * repeats], pbc: 'T T T' });
}
await Promise.all([
  // Wide periodic cell preserves the three-point geometry and permits the
  // display/physical replication checks below. Open cells are tested separately.
  writeFile(resolve(fixtures, 'right-angle.xyz'), xyz(rightAngle, { pbc: 'T T T' })
    + xyz(rightAngle.map(point => point.map(value => value + .2)), { pbc: 'T T T', step: 18 })),
  writeFile(resolve(fixtures, 'isolated-atom.xyz'), xyz([...rightAngle, [8, 8, 8]])),
  writeFile(resolve(fixtures, 'mixed-elements.xyz'), xyz(rightAngle, { types: ['Ni', 'Cu', 'Ni'] })),
  writeFile(resolve(fixtures, 'sc.xyz'), crystal([[0, 0, 0]])),
  writeFile(resolve(fixtures, 'fcc.xyz'), crystal(fccBasis)),
  writeFile(resolve(fixtures, 'bcc.xyz'), crystal(bccBasis)),
  writeFile(resolve(fixtures, 'fcc-supercell.xyz'), crystal(fccBasis, 2)),
  writeFile(resolve(fixtures, 'open-voronoi.xyz'), xyz([[.25, .5, .5], [.75, .5, .5]], { lattice: [1, 0, 0, 0, 1, 0, 0, 0, 1] })),
]);

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
    const origin = await evaluate('location.origin');
    let mobile = false;
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeout = 60_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
      throw new Error(`${label}: ${JSON.stringify(await evaluate(`({file:document.getElementById('file-name')?.textContent,bondState:document.getElementById('bond-statistics-state')?.textContent,bondStatus:document.getElementById('bond-statistics-status')?.textContent,voronoiState:document.getElementById('voronoi-state')?.textContent,voronoiStatus:document.getElementById('voronoi-status')?.textContent,exportStatus:document.getElementById('statistics-export-status')?.textContent,configuration:document.getElementById('configuration-status')?.textContent,toast:document.getElementById('toast')?.textContent})`))}`);
    }
    await waitFor('document.readyState==="complete" && document.getElementById("run-voronoi")', 'topology production page');
    await evaluate(`(${initializeChecks.toString()})()`);
    await evaluate(`if(document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true') document.getElementById('enable-gpu-computing').click()`);
    async function change(id, value, { checkbox = false, event = 'change' } = {}) {
      await evaluate(`(() => {const field=document.getElementById(${JSON.stringify(id)});if(!field)throw new Error('Missing '+${JSON.stringify(id)});${checkbox ? 'field.checked' : 'field.value'}=${JSON.stringify(value)};field.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
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
    async function inputFile(selector, name) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector });
      assert.ok(nodeId, `${selector} exists`);
      await call('DOM.setFileInputFiles', { nodeId, files: [resolve(fixtures, name)] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function load(name, atomCount, { replay = false } = {}) {
      const before = await evaluate('topologyChecks.history.length');
      await inputFile('#file-input', name);
      await waitFor(`document.getElementById('file-name').textContent===${JSON.stringify(name)} && document.getElementById('loading').hidden && topologyChecks.renderer?.atomCount===${atomCount}`, `load ${name}`);
      await delay(100);
      if (!replay) assert.equal(await evaluate('topologyChecks.history.length'), before, 'loading a structure does not calculate requested statistics');
    }
    async function bonds(cutoff, { held = false } = {}) {
      await showTool('bonds'); await expand('.bond-statistics-section');
      await change('bonds-cutoff', String(cutoff));
      await change('bond-statistics-length-bins', '11'); await change('bond-statistics-angle-bins', '180');
      if (held) await evaluate('topologyChecks.holdKind="bondStatistics"');
      await press('#run-bond-statistics');
      await waitFor(held ? 'topologyChecks.held?.kind==="bondStatistics"' : 'document.getElementById("bond-statistics-state").textContent==="Calculated"', 'CPU bond distributions and Q4/Q6');
      if (!held) {
        assert.match(await evaluate('document.getElementById("bond-statistics-backend").textContent'), /CPU|js-worker/i);
        assert.equal(await evaluate('topologyChecks.readResult("bondStatistics").backend'), 'cpu');
      }
    }
    async function voronoi({ held = false } = {}) {
      await showTool('voronoi');
      if (held) await evaluate('topologyChecks.holdKind="voronoi"');
      await press('#run-voronoi');
      await waitFor(held ? 'topologyChecks.held?.kind==="voronoi"' : 'document.getElementById("voronoi-state").textContent==="Calculated"', 'CPU Voronoi tessellation');
      if (!held) {
        assert.match(await evaluate('document.getElementById("voronoi-backend").textContent'), /CPU|worker|wasm/i);
        assert.equal(await evaluate('topologyChecks.readResult("voronoi").backend'), 'cpu');
      }
    }
    async function exportCsv(id) {
      const before = await evaluate('topologyChecks.history.length');
      await evaluate('topologyChecks.beginDownload()'); await press(`#${id}`);
      await waitFor('topologyChecks.download!==null', `download ${id}`);
      const output = await evaluate('topologyChecks.finishDownload()');
      assert.match(output.type, /^text\/csv/); assert.ok(output.text.endsWith('\r\n')); assert.ok(!/(?<!\r)\n/.test(output.text), 'CSV uses CRLF');
      assert.equal(await evaluate('topologyChecks.history.length'), before, 'CSV formatting does not launch an analysis');
      await writeFile(resolve(artifacts, output.filename), output.text);
      const rows = parseCsv(output.text), columns = rows.shift();
      assert.deepEqual(columns.slice(0, 3), ['source_file', 'frame_number', 'timestep']);
      assert.ok(rows.every(row => row.length === columns.length));
      return { ...output, columns, rows, objects: rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))) };
    }
    const result = kind => evaluate(`topologyChecks.readResult(${JSON.stringify(kind)})`);
    const property = name => evaluate(`topologyChecks.property(${JSON.stringify(name)})`);
    const recipe = () => evaluate('topologyChecks.recipe()');
    async function screenshot(name, focus = null) {
      if (focus) await evaluate(`(() => {const sidebar=document.getElementById('sidebar'),target=document.querySelector(${JSON.stringify(focus)});sidebar.scrollTop+=target.getBoundingClientRect().top-sidebar.getBoundingClientRect().top-16;})()`);
      await delay(80);
      const capture = await call('Page.captureScreenshot', { format: 'png' }); const path = resolve(artifacts, name); await writeFile(path, Buffer.from(capture.data, 'base64')); return path;
    }

    if (screenshotsOnly) {
      await load('right-angle.xyz', 3); await bonds(1.1);
      const bondsScreenshot = await screenshot('bond-statistics.png', '#bond-statistics-results');
      await press('#cancel-bond-statistics'); await load('fcc-supercell.xyz', 32); await voronoi();
      await evaluate(`(() => {const r=topologyChecks.renderer;topologyChecks.roundoffProperty=r.frame.properties.find(property=>property.name==='atomicVolume').data;topologyChecks.roundoffRaw=Array.from(topologyChecks.roundoffProperty);})()`);
      const rawVolumes = await property('atomicVolume');
      assert.ok(Math.max(...rawVolumes) > Math.min(...rawVolumes), 'the fixture retains the real Voronoi floating-point spread');
      const colorCount = () => evaluate(`(() => {const colors=topologyChecks.renderer.atomColors;return new Set(Array.from({length:topologyChecks.renderer.atomCount},(_unused,index)=>Array.from(colors.slice(index*3,index*3+3)).join(','))).size;})()`);
      assert.equal(await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")'), 'true');
      assert.equal(await colorCount(), 1, 'Auto colors numerically equal FCC volumes uniformly');
      close(await evaluate('Array.from(document.querySelectorAll(".legend-controls input[type=number]"),input=>input.valueAsNumber)'), [Math.min(...rawVolumes), Math.max(...rawVolumes)], 0);
      await evaluate(`(() => {const values=topologyChecks.roundoffRaw,[minimum,maximum]=document.querySelectorAll('.legend-controls input[type=number]');minimum.value=String(Math.min(...values));maximum.value=String(Math.max(...values));minimum.dispatchEvent(new Event('input',{bubbles:true}));maximum.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      assert.equal(await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")'), 'false');
      assert.ok(await colorCount() > 1, 'a precise manual range still resolves the floating-point differences');
      await press('#legend-auto');
      assert.equal(await colorCount(), 1, 'returning to Auto restores uniform colors');
      assert.equal(await evaluate('topologyChecks.renderer.frame.properties.find(property=>property.name==="atomicVolume").data===topologyChecks.roundoffProperty'), true);
      close(await property('atomicVolume'), rawVolumes, 0);
      const rawCsv = await exportCsv('export-voronoi-csv');
      close(rawCsv.objects.map(row => Number(row['volume [Å³]'])), rawVolumes, 0);
      const voronoiScreenshot = await screenshot('voronoi-analysis.png', '#voronoi-results');
      return { adapter, computation: 'CPU Workers', purpose: 'Focused visual review and floating-point Auto/manual color regression', rawVolumeMinimum: Math.min(...rawVolumes), rawVolumeMaximum: Math.max(...rawVolumes), screenshots: [bondsScreenshot, voronoiScreenshot] };
    }

    assert.equal(await evaluate('document.getElementById("run-bond-statistics").disabled && document.getElementById("run-voronoi").disabled'), true);
    await load('right-angle.xyz', 3);
    assert.equal(await evaluate('document.getElementById("export-bond-order-atoms").disabled && document.getElementById("export-voronoi-csv").disabled'), true, 'uncalculated exports are disabled');
    await bonds(1.1);
    let values = await result('bondStatistics');
    assert.equal(values.lengthDistribution.total, 2); assert.equal(values.angleDistribution.total, 1);
    close([values.statistics.length.mean, values.statistics.angle.mean], [1, 90]);
    assert.deepEqual(values.coordination, [2, 1, 1]);
    close(values.q4, [Math.sqrt(.6875), 1, 1]); close(values.q6, [Math.sqrt(.34375), 1, 1]);
    close(await property('bondQ4'), values.q4); close(await property('bondQ6'), values.q6);
    assert.equal(await evaluate('document.getElementById("bond-statistics-results").hidden'), false);
    assert.equal(await evaluate('["bond-length-chart","bond-angle-chart","bond-order-chart"].every(id=>document.getElementById(id).textContent.trim().length>0)'), true, 'charts contain meaningful result labels');
    const lengthCsv = await exportCsv('export-bond-length-distribution'), angleCsv = await exportCsv('export-bond-angle-distribution');
    assert.equal(lengthCsv.objects.reduce((sum, row) => sum + Number(row.count), 0), 2);
    assert.equal(angleCsv.objects.reduce((sum, row) => sum + Number(row.count), 0), 1);
    close([lengthCsv.objects.reduce((sum, row) => sum + Number(row.probability), 0)], [1]);
    const atomCsv = await exportCsv('export-bond-order-atoms');
    assert.deepEqual(atomCsv.objects.map(row => Number(row.atom_id)), [101, 112, 123]);
    close(atomCsv.objects.map(row => Number(row.Q4)), values.q4, 0);
    assert.ok(atomCsv.objects.every(row => row.source_file === 'right-angle.xyz' && row.frame_number === '1' && row.timestep === '17'));
    await press('#run-bonds'); await waitFor('document.getElementById("bonds-state").textContent==="Calculated"', 'bond drawing with independent statistics');
    await press('#cancel-bonds');
    assert.equal(await evaluate('document.getElementById("bond-statistics-state").textContent'), 'Calculated');
    assert.equal(await evaluate('document.querySelector("[data-tool-button=bonds]").classList.contains("enabled")'), true, 'canceling bond drawing retains the enabled statistics indicator');
    close(await property('bondQ4'), values.q4);
    await change('frame-slider', '1', { event: 'input' });
    await waitFor('topologyChecks.renderer.frame.frameIndex===1 && document.getElementById("bond-statistics-state").textContent==="Calculated" && document.getElementById("loading").hidden', 'bond metrics follow the trajectory independently of drawing');
    assert.equal(Number(await evaluate('document.getElementById("bonds-cutoff").value')), 1.1, 'frame changes retain the active statistics cutoff with bond drawing disabled');
    assert.equal(await evaluate('document.getElementById("bonds-state").textContent'), 'Not calculated');
    await change('frame-slider', '0', { event: 'input' });
    await waitFor('topologyChecks.renderer.frame.frameIndex===0 && document.getElementById("bond-statistics-state").textContent==="Calculated" && document.getElementById("loading").hidden', 'return to initial metrics frame');
    await showTool('display'); await change('color-mode', 'property:bondQ6');
    assert.equal(await evaluate('document.getElementById("legend").hidden'), false);
    assert.match(await evaluate('document.getElementById("legend").textContent'), /Q6/i);
    const beforeDisplay = await evaluate('topologyChecks.history.length');
    await showTool('replicate'); await change('replicate-a', '2'); await press('#apply-replicate');
    assert.equal(await evaluate('topologyChecks.renderer.atomCount'), 3);
    await showTool('bonds'); await expand('.bond-statistics-section');
    assert.equal((await exportCsv('export-bond-order-atoms')).objects.length, 3, 'display copies never enter statistics CSV');
    assert.equal(await evaluate('topologyChecks.history.length'), beforeDisplay, 'display replication does not recalculate statistics');
    await showTool('replicate'); await change('replicate-atoms', true, { checkbox: true });
    await waitFor('topologyChecks.renderer.atomCount===6 && document.getElementById("bond-statistics-state").textContent==="Calculated"', 'physical copies recalculate bond statistics');
    await showTool('bonds'); await expand('.bond-statistics-section');
    assert.equal((await exportCsv('export-bond-order-atoms')).objects.length, 6, 'physical copies enter statistics CSV');
    await showTool('replicate'); await change('replicate-atoms', false, { checkbox: true });
    await waitFor('topologyChecks.renderer.atomCount===3 && document.getElementById("bond-statistics-state").textContent==="Calculated"', 'return to original analysis cell');
    await change('replicate-a', '1'); await press('#apply-replicate');
    await showTool('bonds'); await expand('.bond-statistics-section');
    const bondsScreenshot = await screenshot('bond-statistics.png', '#bond-statistics-results');
    await press('#cancel-bond-statistics');
    assert.equal(await evaluate('document.getElementById("bond-statistics-state").textContent'), 'Not calculated');
    assert.equal(await evaluate('document.getElementById("export-bond-order-atoms").disabled'), true);
    assert.deepEqual(await property('bondQ4'), []);
    await bonds(1.1, { held: true }); await press('#cancel-bond-statistics');
    assert.equal(await evaluate('topologyChecks.held.signal.aborted'), true);
    await evaluate('topologyChecks.release()'); await delay(100);
    assert.deepEqual(await property('bondQ4'), [], 'a late completed CPU result cannot republish after Cancel');
    await bonds(1.5); values = await result('bondStatistics');
    assert.equal(values.lengthDistribution.total, 3); assert.equal(values.angleDistribution.total, 3);
    close([values.statistics.length.mean, values.statistics.angle.mean], [(2 + Math.SQRT2) / 3, 60]);
    await press('#cancel-bond-statistics');
    console.log('Topology tools: real right-angle geometry, display/physical copies, cancellation, legends and CSV passed.');

    await load('isolated-atom.xyz', 4); await bonds(1.1);
    const isolatedCsv = await exportCsv('export-bond-order-atoms');
    assert.equal(isolatedCsv.objects[3].Q4, 'NaN'); assert.equal(isolatedCsv.objects[3].Q6, 'NaN');
    const orderCsv = await exportCsv('export-bond-order-statistics');
    assert.ok(orderCsv.objects.every(row => row.finite_count === '3' && row.nan_count === '1'));
    await press('#cancel-bond-statistics');

    await load('mixed-elements.xyz', 3); await bonds(1.1);
    await evaluate(`(() => {const row=[...document.querySelectorAll('.bond-pair-cutoff-row')].find(row=>row.textContent.includes('Cu')&&row.textContent.includes('Ni'));if(!row)throw new Error('Missing Ni–Cu pair cutoff');const input=row.querySelector('input');input.value='.01';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor('document.getElementById("bond-statistics-state").textContent==="Calculated" && topologyChecks.readResult("bondStatistics").lengthDistribution.total===1', 'bond statistics reuse element-pair cutoffs');
    assert.deepEqual((await result('bondStatistics')).coordination, [1, 0, 1]);
    await press('#cancel-bond-statistics');

    const referenceResults = [];
    for (const [name, count, cutoff, cn, q4, q6, volume, index] of [
      ['sc.xyz', 1, 4.01, 6, .7637626158259734, .3535533905932738, 64, '<0,6,0,0>'],
      ['fcc.xyz', 4, 3, 12, .1909406539564933, .5745242597140698, 16, '<0,12,0,0>'],
      ['bcc.xyz', 2, 4.01, 14, .0363696483726654, .5106882308569509, 32, '<0,6,0,8>'],
    ]) {
      await load(name, count); await bonds(cutoff); values = await result('bondStatistics');
      assert.deepEqual(values.coordination, Array(count).fill(cn)); close(values.q4, Array(count).fill(q4)); close(values.q6, Array(count).fill(q6));
      if (name === 'sc.xyz') {
        assert.equal(values.lengthDistribution.total, 3, 'periodic self-image bonds count each undirected connection once');
        assert.equal(values.angleDistribution.total, 15); close([values.statistics.angle.mean], [108]);
      }
      await voronoi(); const cells = await result('voronoi');
      close(cells.atomicVolume, Array(count).fill(volume), 1e-6);
      assert.deepEqual(cells.voronoiCoordination, Array(count).fill(cn)); assert.deepEqual(cells.voronoiIndices, Array(count).fill(index));
      close([cells.atomicVolume.reduce((sum, value) => sum + value, 0)], [64], 1e-6);
      assert.deepEqual(cells.voronoiBoundaryFaces, Array(count).fill(0));
      close(await property('atomicVolume'), cells.atomicVolume);
      assert.equal(await evaluate('["atomicVolume","voronoiSurfaceArea","voronoiCoordination","voronoiBoundaryFaces","voronoiMaxFaceOrder"].every(name=>[...document.getElementById("color-mode").options].some(option=>option.value===`property:${name}`))'), true, 'all numerical Voronoi fields are available for coloring');
      const exported = await exportCsv('export-voronoi-csv');
      assert.equal(exported.objects.length, count); assert.ok(exported.objects.every(row => row.voronoi_index === index));
      close(exported.objects.map(row => Number(row['volume [Å³]'])), cells.atomicVolume, 0);
      referenceResults.push({ source: name, neighbors: cn, q4, q6, volume, index });
      if (name === 'bcc.xyz') {
        const populations = await exportCsv('export-voronoi-distributions');
        assert.ok(populations.objects.some(row => row.distribution === 'voronoi_index' && row.category === index && Number(row.count) === count));
        await expand('#voronoi-face-data');
        const faces = await exportCsv('export-voronoi-faces');
        assert.equal(faces.objects.length, 28); assert.ok(faces.objects.every(row => Number(row['face_area [Å²]']) > 0));
        const saved = await recipe();
        assert.equal(saved.settings.extensions.bondStatistics.enabled, true); assert.equal(saved.settings.extensions.voronoi.enabled, true);
        assert.equal(saved.settings.extensions.bondStatistics.lengthBins, 11);
        await writeFile(resolve(fixtures, 'topology-recipe.json'), JSON.stringify(saved));
        await press('#close-file'); await inputFile('#configuration-file', 'topology-recipe.json');
        await waitFor('document.getElementById("configuration-status").textContent.includes("Waiting for source files")', 'topology recipe waits for local source');
        const beforeReplay = await evaluate('topologyChecks.history.length');
        await load(name, count, { replay: true });
        await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("bond-statistics-state").textContent==="Calculated" && document.getElementById("voronoi-state").textContent==="Calculated"', 'topology recipe recalculates actual results');
        assert.ok(await evaluate(`topologyChecks.history.slice(${beforeReplay}).some(entry=>entry.kind==='bondStatistics') && topologyChecks.history.slice(${beforeReplay}).some(entry=>entry.kind==='voronoi')`));
        close(await property('atomicVolume'), Array(count).fill(volume), 1e-6);
        const replayed = await recipe();
        assert.deepEqual(replayed.settings.extensions.bondStatistics, saved.settings.extensions.bondStatistics);
        assert.deepEqual(replayed.settings.extensions.voronoi, saved.settings.extensions.voronoi);
      }
      await showTool('voronoi'); await press('#cancel-voronoi'); await showTool('bonds'); await expand('.bond-statistics-section'); await press('#cancel-bond-statistics');
    }
    console.log('Topology tools: SC/FCC/BCC Q4/Q6 and Voronoi volumes, neighbors, indices, faces and recipe replay passed.');

    await load('open-voronoi.xyz', 2); await voronoi();
    let cells = await result('voronoi'); close(cells.atomicVolume, [.5, .5]);
    assert.deepEqual(cells.voronoiCoordination, [1, 1]); assert.deepEqual(cells.voronoiBoundaryFaces, [5, 5]); assert.deepEqual(cells.voronoiIndices, ['<0,1,0,0>', '<0,1,0,0>']);
    await expand('.voronoi-face-filter-controls');
    await change('voronoi-face-area-threshold', '2');
    await waitFor('document.getElementById("voronoi-state").textContent==="Calculated" && topologyChecks.readResult("voronoi").voronoiCoordination.every(value=>value===0)', 'small-face thresholds filter neighbor counts');
    cells = await result('voronoi'); close(cells.atomicVolume, [.5, .5]); assert.deepEqual(cells.voronoiCoordination, [0, 0]);
    await change('voronoi-face-area-threshold', '0');
    await waitFor('document.getElementById("voronoi-state").textContent==="Calculated" && topologyChecks.readResult("voronoi").voronoiCoordination.every(value=>value===1)', 'reset face threshold');
    const voronoiScreenshot = await screenshot('voronoi-analysis.png', '#voronoi-results');
    await press('#cancel-voronoi'); assert.equal(await evaluate('document.getElementById("export-voronoi-csv").disabled'), true);
    assert.deepEqual(await property('atomicVolume'), []);
    await voronoi({ held: true }); await press('#cancel-voronoi'); assert.equal(await evaluate('topologyChecks.held.signal.aborted'), true);
    await evaluate('topologyChecks.release()'); await delay(100); assert.deepEqual(await property('atomicVolume'), [], 'late tessellation results stay cleared');

    await load('fcc-supercell.xyz', 32);
    await showTool('cna'); await press('#run-cna'); await waitFor('document.getElementById("cna-state").textContent==="Calculated"', 'categorical statistics from actual CNA');
    await showTool('statistics');
    await expand('.statistics-csv-section');
    const categories = await exportCsv('export-categorical-populations');
    assert.ok(categories.objects.some(row => /FCC/i.test(row.category) && Number(row.count) === 32));
    const scalarCsv = await exportCsv('export-property-statistics');
    assert.ok(scalarCsv.objects.some(row => row.property === 'energy' && row.nan_count === '1' && row.finite_count === '31'));
    const atomsCsv = await exportCsv('export-atom-properties'); assert.equal(atomsCsv.objects.length, 32);
    await change('rdf-cutoff', '3'); await change('rdf-bins', '20'); await press('#run-rdf');
    await waitFor('document.getElementById("rdf-state").textContent==="Calculated"', 'actual RDF for distribution export');
    const rdf = await exportCsv('export-rdf'); assert.equal(rdf.objects.length, 20);
    assert.ok(rdf.objects.some(row => Number(row.directed_pair_count) > 0));
    const summary = await exportCsv('export-statistics-summary'); assert.ok(summary.objects.length > 0);
    await showTool('dxa'); await press('#run-dxa');
    await waitFor('document.getElementById("dxa-state").textContent==="Calculated"', 'actual perfect-FCC DXA');
    const dxaSummary = await exportCsv('export-dxa-summary');
    assert.equal(Number(dxaSummary.objects.find(row => row.metric === 'segment_count')?.value), 0);
    close([Number(dxaSummary.objects.find(row => row.metric === 'total_length')?.value)], [0], 0);
    close([Number(dxaSummary.objects.find(row => row.metric === 'cell_volume')?.value)], [512], 1e-6);
    const dxaLines = await exportCsv('export-dxa-lines');
    assert.equal(dxaLines.objects.length, 0, 'a perfect crystal exports a valid empty dislocation table');
    assert.ok(dxaLines.columns.includes('line_id') && dxaLines.columns.includes('length [Å]') && dxaLines.columns.includes('burgers_x') && dxaLines.columns.includes('spatial_burgers_x [Å]'));
    console.log('Topology tools: open boundaries, face filtering, canceled Voronoi and unified statistics CSV passed.');
    mobile = true;
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 640, deviceScaleFactor: 1, mobile });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true });
    await showTool('voronoi'); await voronoi();
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true, 'phone charts fit their tool panel');
    const beforeScroll = await evaluate(`(() => {const box=topologyChecks.renderer.canvas.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height,page:scrollY};})()`);
    await expand('#voronoi-face-data');
    assert.equal((await exportCsv('export-voronoi-faces')).objects.length, 32 * 12);
    const afterScroll = await evaluate(`(() => {const box=topologyChecks.renderer.canvas.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height,page:scrollY};})()`);
    assert.deepEqual(afterScroll, beforeScroll, 'scrolling to phone CSV controls leaves the rendering viewport fixed');
    const phoneScreenshot = await screenshot('voronoi-390x640.png');
    return { adapter, computation: 'CPU Workers', referenceResults, screenshots: [bondsScreenshot, voronoiScreenshot, phoneScreenshot], csvDirectory: artifacts };
  }, { software: true });
  await writeFile(resolve(artifacts, screenshotsOnly ? 'screenshots-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(fixtures, { recursive: true, force: true }); }

function close(actual, expected, tolerance = 2e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Number.isFinite(value) && Math.abs(value - expected[index]) <= tolerance * Math.max(1, Math.abs(expected[index])), `${value} differs from ${expected[index]}`));
}

// Quoted indices contain commas, and source filenames may contain quotation
// marks. Parse the actual CSV format rather than splitting row text on commas.
function parseCsv(csv) {
  const rows = [], row = []; let cell = '', quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (character === '\r' && csv[index + 1] === '\n' && !quoted) { row.push(cell); rows.push([...row]); row.length = 0; cell = ''; index++; }
    else cell += character;
  }
  assert.equal(quoted, false, 'CSV quotation is balanced');
  assert.equal(cell, '', 'CSV has a final CRLF'); assert.equal(row.length, 0);
  return rows;
}

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const [{ WebGLRenderer }, { AnalysisPool }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)),
  ]);
  const checks = window.topologyChecks = { history: [], latest: {}, holdKind: null, held: null, download: null };
  const setFrame = WebGLRenderer.prototype.setFrame, analyze = AnalysisPool.prototype.analyze;
  WebGLRenderer.prototype.setFrame = function(...args) { if (this.canvas.id === 'viewport') checks.renderer = this; return setFrame.apply(this, args); };
  AnalysisPool.prototype.analyze = async function(frame, parameters, options) {
    const entry = { frame, kind: parameters.kind, parameters, signal: options?.signal };
    checks.history.push(entry);
    const hold = checks.holdKind === parameters.kind; if (hold) checks.holdKind = null;
    const result = await analyze.call(this, frame, parameters, options); entry.result = result;
    checks.latest[parameters.kind] = { frame, result };
    if (hold) { checks.held = entry; await new Promise(resolve => { checks.release = () => { checks.held = null; resolve(); }; }); }
    return result;
  };
  const plain = value => JSON.parse(JSON.stringify(value, (_key, item) => Number.isNaN(item) ? 'NaN' : ArrayBuffer.isView(item) ? Array.from(item) : item));
  checks.readResult = kind => {
    const cached = checks.renderer.frame.atomeyeResults?.[kind];
    const result = cached?.result ?? (checks.latest[kind]?.frame === checks.renderer.frame ? checks.latest[kind].result : null);
    if (!result) throw new Error(`No current-frame result for ${kind}`);
    return plain(result);
  };
  checks.property = name => Array.from(checks.renderer.frame.properties.find(property => property.name === name)?.data ?? [], value => Number.isNaN(value) ? 'NaN' : value);
  checks.beginDownload = () => {
    const urls = new Map(), create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    checks.download = null;
    URL.createObjectURL = function(blob) { const url = create.call(this, blob); urls.set(url, blob); return url; };
    HTMLAnchorElement.prototype.click = function() { const blob = urls.get(this.href); if (blob) checks.download = { blob, filename: this.download }; };
    checks.restoreDownload = () => { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; };
  };
  checks.finishDownload = async () => { try { const { blob, filename } = checks.download; return { filename, type: blob.type, text: await blob.text() }; } finally { checks.restoreDownload(); checks.download = null; } };
  checks.recipe = async () => { checks.beginDownload(); document.getElementById('export-configuration').click(); const output = await checks.finishDownload(); return JSON.parse(output.text); };
}
