import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Production DOM, real local files, CPU Workers and real pointer gestures.
// SwiftShader supplies browser graphics; these checks do not measure hardware GPU performance.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-advanced-tools-fixtures-'));
const artifacts = resolve(tmpdir(), 'alloyview-advanced-tools');
await mkdir(artifacts, { recursive: true });
const ids = [101, 202, 303, 404, 505, 606];
const atoms = [[9.5, 2, 2], [.5, 4, 3], [4, 5, 4], [6, 8, 7], [2, 2, 6], [3, 8, 2]];
const lattice = [10, 0, 0, 0, 10, 0, 0, 0, 10];
const skewLattice = [10, 0, 0, 3, 8, 0, 1, 2, 9];
const skewFractional = [[.95, .2, .8], [.05, .4, .1], [.4, .5, .6], [.6, .8, .7], [.2, .2, .6], [.3, .8, .2]];
const xyz = (points, cell = lattice, pbc = 'T T T', step = 0, order = points.map((_point, index) => index)) => [
  String(points.length),
  `Lattice="${cell.join(' ')}" pbc="${pbc}" Properties=species:S:1:pos:R:3:id:I:1:force:R:3:velocity:R:3:energy:R:1:all_nan:R:1 Step=${step}`,
  ...order.map(index => `Ni ${points[index].map(value => value + step * .1).join(' ')} ${ids[index]} 1 .5 -.25 -.2 .3 .4 ${index / 10 + step} NaN`), '',
].join('\n');
const skewAtoms = skewFractional.map(fractional => [0, 1, 2].map(axis =>
  fractional[0] * skewLattice[axis] + fractional[1] * skewLattice[3 + axis] + fractional[2] * skewLattice[6 + axis]));
const sliceAtoms = [[2, 2, 2], [6, 2, 2], [2, 6, 2], [4, 2, 2], [7, 7, 7], [7, 3, 5]];
const csv = ['id,temperature,quality,x', '606,60,6,900', '101,10,1,901', '303,NaN,3,902',
  '202,20,2,903', '505,50,5,904', '404,40,4,905', ''].join('\n');
await Promise.all([
  writeFile(resolve(temporary, 'advanced-trajectory.xyz'), xyz(atoms) + xyz(atoms, lattice, 'T T T', 1, [5, 3, 1, 4, 2, 0])),
  writeFile(resolve(temporary, 'advanced-skew.xyz'), xyz(skewAtoms, skewLattice, 'T F T')),
  writeFile(resolve(temporary, 'advanced-slices.xyz'), xyz(sliceAtoms)),
  writeFile(resolve(temporary, 'advanced-attributes.csv'), csv),
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
      throw new Error(`${label}: ${await evaluate('JSON.stringify({file:document.getElementById("file-name")?.textContent,atoms:window.advancedToolsChecks?.renderer?.atomCount,analysis:document.getElementById("analysis-state")?.textContent,slice:document.getElementById("slice-pick-help")?.textContent,external:document.getElementById("external-property-status")?.textContent,configuration:document.getElementById("configuration-status")?.textContent,toast:document.getElementById("toast")?.textContent})')}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("toggle-camera-controls")', 'advanced production page');
    await evaluate(`(${initializeChecks.toString()})()`);
    await evaluate(`if(document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true') document.getElementById('enable-gpu-computing').click()`);
    async function inputFiles(selector, names) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector });
      assert.ok(nodeId, `file input ${selector} exists`);
      await call('DOM.setFileInputFiles', { nodeId, files: names.map(name => resolve(temporary, name)) });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function change(id, value, { checkbox = false, event = 'change' } = {}) {
      await evaluate(`(() => {const field=document.getElementById(${JSON.stringify(id)});if(!field)throw new Error('Missing control '+${JSON.stringify(id)});${checkbox ? 'field.checked' : 'field.value'}=${JSON.stringify(value)};field.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
    }
    async function press(selector) {
      const point = await evaluate(`(() => {const button=document.querySelector(${JSON.stringify(selector)});if(!button)throw new Error('Missing control '+${JSON.stringify(selector)});button.scrollIntoView({block:'nearest',inline:'nearest'});const box=button.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2,hit=document.elementFromPoint(x,y);return{x,y,enabled:!button.disabled,reachable:button===hit||button.contains(hit),hitId:hit?.id};})()`);
      assert.ok(point.enabled && point.reachable, `${selector} is reachable: ${JSON.stringify(point)}`);
      await tap(point);
      await delay(45);
    }
    async function tap(point) {
      if (mobile) {
        await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: point.x, y: point.y }] });
        await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      }
    }
    async function showTool(name) {
      const category = await evaluate(`document.querySelector('[data-tool-button="${name}"]').closest('[data-tool-category-panel]').dataset.toolCategoryPanel`);
      if (await evaluate(`document.getElementById('tool-category-${category}').getAttribute('aria-selected')!=='true'`)) await press(`#tool-category-${category}`);
      if (await evaluate(`document.querySelector('[data-tool-button="${name}"]').getAttribute('aria-expanded')!=='true'`)) await press(`[data-tool-button="${name}"]`);
    }
    async function expand(selector) {
      if (await evaluate(`!document.querySelector(${JSON.stringify(selector)}).open`)) await press(`${selector} > summary`);
    }
    async function load(name, { allowAnalyses = false } = {}) {
      const before = await evaluate('advancedToolsChecks.analyses');
      await inputFiles('#file-input', [name]);
      await waitFor(`document.getElementById('file-name').textContent===${JSON.stringify(name)} && document.getElementById('loading').hidden && advancedToolsChecks.renderer?.atomCount===6`, `load ${name}`);
      if (!allowAnalyses) assert.equal(await evaluate('advancedToolsChecks.analyses'), before, 'source loading does not calculate properties');
      await delay(100);
    }
    async function closeOverlays() {
      await evaluate(`for(const id of ['toggle-atom-details','toggle-view-controls','toggle-legend','toggle-camera-controls']){const button=document.getElementById(id);if(button?.getAttribute('aria-expanded')==='true')button.click()}`);
    }
    async function preparePicks() {
      await closeOverlays();
      await evaluate(`(() => {const r=advancedToolsChecks.renderer;r.setView('top');r.centerOnPoint([5,5,5]);r.setCameraState({projectionMode:'orthographic',fieldWidth:15});r.render(performance.now(),{trackStats:false});})()`);
    }
    async function pick(index = null, { slice = false, replica = [0, 0, 0] } = {}) {
      const point = await evaluate(`advancedToolsChecks.pickPoint(${index},${JSON.stringify(replica)})`);
      if (!point) {
        await screenshot('unreachable-atom-debug.png');
        assert.fail(`atom ${index ?? '(any)'} in cell ${replica} has no unobstructed pointer target: ${JSON.stringify(await evaluate('advancedToolsChecks.pickDebug()'))}`);
      }
      await tap(point);
      if (slice) await waitFor(`document.getElementById('slice-pick-help').textContent.includes(${JSON.stringify(String(ids[point.index]))})`, `slice atom pointer pick ${ids[point.index]}`);
      else await waitFor(`advancedToolsChecks.renderer.selected===${point.index}`, `atom pointer pick ${ids[point.index]}`);
      return point;
    }
    const recipe = () => evaluate('advancedToolsChecks.exportRecipe()');
    async function restore(saved, { pending = false } = {}) {
      await writeFile(resolve(temporary, 'advanced-recipe.json'), JSON.stringify(saved));
      await inputFiles('#configuration-file', ['advanced-recipe.json']);
      await waitFor(pending ? 'document.getElementById("configuration-status").textContent.includes("Waiting for source files")'
        : 'document.getElementById("configuration-status").textContent.includes("restored")', 'configuration restore');
      if (!pending) assert.doesNotMatch(await evaluate('document.getElementById("configuration-status").textContent'), /could not complete|interrupted/);
    }
    async function runCoordination({ held = false } = {}) {
      await showTool('coordination');
      await change('cutoff', '3.1', { event: 'input' });
      if (held) await evaluate('advancedToolsChecks.holdNextAnalysis=true');
      await press('#run-analysis');
      await waitFor(held ? 'advancedToolsChecks.analysisHeld' : 'document.getElementById("analysis-state").textContent==="Calculated"', 'CPU coordination');
    }
    async function screenshot(name) {
      const capture = await call('Page.captureScreenshot', { format: 'png' });
      const path = resolve(artifacts, name); await writeFile(path, Buffer.from(capture.data, 'base64')); return path;
    }

    assert.equal(await evaluate('document.getElementById("camera-controls").hidden && document.getElementById("camera-controls").inert'), true, 'camera adjustment starts folded');
    assert.equal(await evaluate('document.getElementById("export-png").nextElementSibling.id'), 'toggle-camera-controls', 'camera adjustment sits beside PNG download');
    await load('advanced-trajectory.xyz');
    await runCoordination({ held: true });
    await press('#tool-category-modification');
    assert.equal(await evaluate('advancedToolsChecks.heldSignal?.aborted'), false, 'category switch preserves the in-flight analysis signal');
    assert.notEqual(await evaluate('document.getElementById("analysis-state").textContent'), 'Not calculated');
    await press('#tool-category-visualization');
    assert.equal(await evaluate('advancedToolsChecks.activeTool()'), 'coordination', 'returning to a category restores its settings');
    await evaluate('advancedToolsChecks.releaseAnalysis()');
    await waitFor('document.getElementById("analysis-state").textContent==="Calculated"', 'held CPU coordination completes');

    await showTool('display');
    assert.equal(await evaluate('document.querySelector(".periodic-origin-controls").open'), false);
    await expand('.periodic-origin-controls');
    await evaluate('advancedToolsChecks.saveScience()');
    await change('display-origin-a', '.5');
    await waitFor('advancedToolsChecks.renderer.periodicOrigin[0]===.5', 'periodic display origin');
    assert.equal(await evaluate('advancedToolsChecks.scienceUnchanged()'), true, 'origin changes preserve source bytes and completed coordination');
    close(await evaluate('Array.from(advancedToolsChecks.renderer.displayPositions.slice(0,3))'), [4.5, 2, 2]);
    close(await evaluate('Array.from(advancedToolsChecks.renderer.displayPositions.slice(3,6))'), [5.5, 4, 3]);
    assert.deepEqual((await recipe()).settings.display.periodicOrigin, [.5, 0, 0]);
    await preparePicks(); await pick(0);
    await press('#origin-center-selected');
    const centered = await evaluate('Array.from(advancedToolsChecks.renderer.displayFractional.slice(0,3))');
    close(centered, [.5, .5, .5]);
    assert.equal(await evaluate('advancedToolsChecks.scienceUnchanged()'), true);
    await press('#origin-reset');
    assert.deepEqual(await evaluate('advancedToolsChecks.renderer.periodicOrigin'), [0, 0, 0]);
    console.log('Advanced tools: periodic origin, source bytes, coordination and real atom picks passed.');

    await load('advanced-skew.xyz'); await showTool('display'); await expand('.periodic-origin-controls');
    assert.equal(await evaluate('document.getElementById("display-origin-b").disabled'), true, 'open cell direction cannot be rewrapped');
    await change('display-origin-a', '.6'); await change('display-origin-c', '.3');
    const skew = await evaluate('({fractional:Array.from(advancedToolsChecks.renderer.displayFractional),positions:Array.from(advancedToolsChecks.renderer.displayPositions),source:Array.from(advancedToolsChecks.renderer.frame.positions),cell:Array.from(advancedToolsChecks.renderer.frame.cell.vectors)})');
    const expectedFractional = skewFractional.flatMap(fractional => [((fractional[0] - .6) % 1 + 1) % 1, fractional[1], ((fractional[2] - .3) % 1 + 1) % 1]);
    close(skew.fractional, expectedFractional);
    close(skew.positions, Array.from({ length: 6 }, (_value, index) => [0, 1, 2].map(axis =>
      expectedFractional[index * 3] * skewLattice[axis] + expectedFractional[index * 3 + 1] * skewLattice[3 + axis] + expectedFractional[index * 3 + 2] * skewLattice[6 + axis])).flat());
    close(skew.source, skewAtoms.flat()); assert.deepEqual(skew.cell, skewLattice);
    await preparePicks(); await pick(0);

    await load('advanced-slices.xyz'); await showTool('slice'); await expand('.slice-atom-controls'); await preparePicks();
    await press('#slice-pick-atoms'); await pick(0, { slice: true }); await pick(1, { slice: true });
    await press('#slice-from-two');
    let slices = (await recipe()).settings.slices.items;
    assert.equal(slices.length, 1); close(slices[0].normal, [1, 0, 0]); assert.equal(slices[0].position, 4); assert.equal(slices[0].side, 'positive');
    await change('slice-enabled', false, { checkbox: true });
    await press('#slice-clear-picks'); await press('#slice-pick-atoms');
    for (const index of [0, 1, 2]) await pick(index, { slice: true });
    assert.equal(await evaluate('document.getElementById("slice-pick-atoms").getAttribute("aria-pressed")'), 'false', 'three atom picks finish the picking gesture');
    await press('#slice-from-three');
    slices = (await recipe()).settings.slices.items;
    assert.equal(slices.length, 2); close(slices[1].normal, [0, 0, 1]); assert.equal(slices[1].position, 2);
    await change('slice-name', 'Selected defect plane', { event: 'input' });
    await press('#slice-clear-picks'); await press('#slice-pick-atoms'); await pick(4, { slice: true }); await press('#slice-to-atom');
    const moved = (await recipe()).settings.slices.items[1];
    assert.equal(moved.position, 7); assert.equal(moved.id, slices[1].id); assert.equal(moved.name, 'Selected defect plane'); close(moved.normal, [0, 0, 1]);
    await change('slice-enabled', false, { checkbox: true });
    await pick(5); await press('#slice-to-atom');
    assert.equal((await recipe()).settings.slices.items[1].position, 5, 'a later ordinary atom selection supersedes the previous slice pick');
    await press('#slice-clear-picks'); await press('#slice-pick-atoms');
    for (const index of [0, 1, 3]) await pick(index, { slice: true });
    const beforeInvalid = (await recipe()).settings.slices;
    await press('#slice-from-three');
    assert.match(await evaluate('document.getElementById("slice-status").textContent'), /collinear/);
    assert.deepEqual((await recipe()).settings.slices, beforeInvalid, 'rejected collinear picks leave every existing slice unchanged');
    await showTool('replicate'); await change('replicate-a', '2'); await press('#apply-replicate');
    await showTool('slice'); await closeOverlays();
    await evaluate(`(() => {const r=advancedToolsChecks.renderer;r.setView('top');r.centerOnPoint([10,5,5]);r.setCameraState({projectionMode:'orthographic',fieldWidth:27});r.render(performance.now(),{trackStats:false});})()`);
    await press('#slice-clear-picks'); await press('#slice-pick-atoms');
    await pick(0, { slice: true, replica: [1, 0, 0] }); await pick(1, { slice: true, replica: [1, 0, 0] });
    await press('#slice-from-two');
    const replicaSlice = (await recipe()).settings.slices.items.at(-1);
    close(replicaSlice.normal, [1, 0, 0]); assert.equal(replicaSlice.position, 14, 'slice construction uses the actual clicked displayed replica');
    await change('slice-enabled', false, { checkbox: true }); await press('#slice-clear-picks'); await press('#slice-pick-atoms');
    await pick(4, { slice: true, replica: [1, 0, 0] }); await press('#slice-to-atom');
    assert.equal((await recipe()).settings.slices.items.at(-1).position, 17, 'moving a plane preserves the clicked replica anchor');
    close(await evaluate('Array.from(advancedToolsChecks.renderer.frame.positions)'), sliceAtoms.flat());
    const sliceScreenshot = await screenshot('slices-from-atoms.png');
    console.log('Advanced tools: real two/three-atom slice picks, gizmo separation, move and collinear rejection passed.');

    await load('advanced-trajectory.xyz'); await runCoordination(); await evaluate('advancedToolsChecks.saveScience()');
    await showTool('vectors');
    await change('vector-mode', 'force'); await change('show-vectors', true, { checkbox: true });
    await change('vector-field-name', 'Force arrows'); await change('vector-color', '#f02030');
    await press('#add-vector-field');
    await change('vector-mode', 'velocity'); await change('show-vectors', true, { checkbox: true });
    await change('vector-field-name', 'Velocity arrows'); await change('vector-color', '#2040e0');
    await waitFor('advancedToolsChecks.renderer.atomVectorFields.length===2', 'two visible independent vector fields');
    close(await evaluate('Array.from(advancedToolsChecks.renderer.atomVectorFields[0].vectors.slice(0,3))'), [1, .5, -.25]);
    close(await evaluate('Array.from(advancedToolsChecks.renderer.atomVectorFields[1].vectors.slice(0,3))'), [-.2, .3, .4]);
    const fields = (await recipe()).settings.extensions.vectors.fields;
    assert.equal(fields.length, 2); assert.deepEqual(fields.map(field => field.name), ['Force arrows', 'Velocity arrows']);
    const vectorDraws = await evaluate('advancedToolsChecks.vectorDraws()');
    assert.equal(vectorDraws.length, 4, 'both arrow fields submit a shaft and an arrowhead');
    assert.ok(vectorDraws.every(draw => draw.count === 6));
    close(vectorDraws[0].color, [240 / 255, 32 / 255, 48 / 255]); close(vectorDraws[2].color, [32 / 255, 64 / 255, 224 / 255]);
    const forceId = fields[0].id, velocityId = fields[1].id;
    await change('vector-field-list', forceId); await change('vector-color', '#20d050');
    close(await evaluate(`advancedToolsChecks.renderer.atomVectorFields.find(field=>field.id===${JSON.stringify(forceId)}).options.color`), [32 / 255, 208 / 255, 80 / 255]);
    close(await evaluate(`advancedToolsChecks.renderer.atomVectorFields.find(field=>field.id===${JSON.stringify(velocityId)}).options.color`), [32 / 255, 64 / 255, 224 / 255]);
    await change('show-vectors', false, { checkbox: true });
    assert.equal((await evaluate('advancedToolsChecks.vectorDraws()')).length, 2, 'hiding one vector field preserves the other field');
    await change('show-vectors', true, { checkbox: true });
    assert.equal(await evaluate('advancedToolsChecks.scienceUnchanged()'), true, 'vector styling preserves imported data and computed coordination');
    const vectorRecipe = await recipe();
    await change('vector-field-list', velocityId); await press('#delete-vector-field');
    assert.equal((await recipe()).settings.extensions.vectors.fields.length, 1);
    await restore(vectorRecipe);
    assert.deepEqual((await recipe()).settings.extensions.vectors.fields, vectorRecipe.settings.extensions.vectors.fields, 'all vector groups replay with their own names, visibility and styles');
    assert.equal((await evaluate('advancedToolsChecks.vectorDraws()')).length, 4);
    const conflictingIdRecipe = structuredClone(vectorRecipe);
    conflictingIdRecipe.settings.extensions.vectors.fields[0].id = 'vector-3';
    conflictingIdRecipe.settings.extensions.vectors.fields[1].id = 'manual-field';
    conflictingIdRecipe.settings.extensions.vectors.selectedId = 'vector-3';
    await restore(conflictingIdRecipe); await showTool('vectors'); await press('#add-vector-field');
    const addedFields = (await recipe()).settings.extensions.vectors.fields;
    assert.equal(addedFields.length, 3); assert.equal(new Set(addedFields.map(field => field.id)).size, 3,
      'adding a vector after a manually edited recipe preserves every field and assigns a unique ID');
    await restore(vectorRecipe);
    await change('vector-field-list', forceId); await change('vector-dimension', '2d'); await change('vector-up-mode', 'fixed');
    for (const [axis, value] of [['x', '1'], ['y', '.5'], ['z', '-.25']]) await change(`vector-up-${axis}`, value);
    assert.equal(await evaluate('(() => {advancedToolsChecks.vectorDraws();return advancedToolsChecks.renderer.gl.getError();})()'), 0, 'a fixed arrow plane parallel to the source remains renderable');
    await restore(vectorRecipe);
    await change('frame-slider', '1', { event: 'input' });
    await waitFor('advancedToolsChecks.renderer.frame.frameIndex===1 && document.getElementById("loading").hidden', 'second frame for displacement arrows');
    await showTool('displacement');
    await waitFor('document.getElementById("displacement-state").textContent==="Calculated"', 'CPU displacement vector source');
    await showTool('vectors'); await change('vector-field-list', velocityId); await change('vector-mode', 'displacement');
    await waitFor('advancedToolsChecks.renderer.atomVectorFields.length===2', 'force and displacement are rendered together');
    await showTool('displacement'); await press('#cancel-displacement');
    await waitFor('advancedToolsChecks.renderer.atomVectorFields.length===1', 'cancelling a vector analysis only removes its dependent group');
    assert.equal(await evaluate('advancedToolsChecks.renderer.atomVectorFields[0].id'), forceId);
    await showTool('vectors'); await change('vector-field-list', forceId);
    assert.equal(await evaluate('document.getElementById("vector-field-name").value'), 'Force arrows');
    assert.equal(await evaluate('document.getElementById("vector-color").value'), '#20d050');
    await restore(vectorRecipe);
    await waitFor('advancedToolsChecks.renderer.frame.frameIndex===0 && document.getElementById("loading").hidden', 'vector recipe restores its source frame');
    await showTool('vectors');
    for (const fieldId of [forceId, velocityId]) { await change('vector-field-list', fieldId); await change('vector-scale', '4'); }
    await change('radius-percent', '25', { event: 'input' });
    await evaluate('advancedToolsChecks.renderer.centerOnPoint([5.5,5,4.5]);advancedToolsChecks.renderer.setCameraState({yaw:-.8,pitch:.45,projectionMode:"perspective",distance:23,fov:50*Math.PI/180});advancedToolsChecks.renderer.render(performance.now(),{trackStats:false})');
    assert.equal((await evaluate('advancedToolsChecks.vectorDraws()')).length, 4);
    const vectorScreenshot = await screenshot('multiple-vector-fields.png');
    await restore(vectorRecipe);
    await evaluate('advancedToolsChecks.saveScience()');

    await showTool('externalProperties'); await change('external-property-mapping', 'id');
    await inputFiles('#external-property-file', ['advanced-attributes.csv']);
    await waitFor('advancedToolsChecks.renderer.frame.properties.some(property=>property.name==="temperature") && document.getElementById("external-property-status").textContent.startsWith("Imported")', 'ID-mapped external CSV');
    assert.deepEqual(await evaluate('advancedToolsChecks.propertyValues("temperature")'), [10, 20, 'NaN', 40, 50, 60]);
    assert.equal(await evaluate('advancedToolsChecks.scienceUnchanged()'), true, 'external x column remains an attribute and imported data leaves analyses intact');
    await showTool('display'); await change('color-mode', 'property:temperature');
    assert.deepEqual(await evaluate('Array.from(advancedToolsChecks.renderer.atomColors.slice(6,9))'), [130, 130, 130], 'a NaN external value receives the neutral missing-value color');
    assert.notDeepEqual(await evaluate('Array.from(advancedToolsChecks.renderer.atomColors.slice(0,3))'), [130, 130, 130], 'finite external values receive the selected colormap');
    await showTool('externalProperties');
    await evaluate(`document.querySelector('[data-external-property-name="temperature"]').value='temperature_external'`);
    await press('[data-external-rename="temperature"]');
    await waitFor('advancedToolsChecks.renderer.frame.properties.some(property=>property.name==="temperature_external")', 'rename imported CSV column');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:temperature_external', 'renaming the selected scalar quantity preserves its color mapping');
    await showTool('display'); await change('color-mode', 'property:temperature_external'); await showTool('externalProperties');
    await press('[data-external-remove="quality"]');
    await waitFor('!advancedToolsChecks.renderer.frame.properties.some(property=>property.name==="quality")', 'remove imported column');
    await change('frame-slider', '1', { event: 'input' });
    await waitFor('advancedToolsChecks.renderer.frame.frameIndex===1 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent==="Calculated"', 'external attributes follow trajectory row reorder');
    assert.deepEqual(await evaluate('advancedToolsChecks.propertyValues("temperature_external")'), [60, 40, 20, 50, 'NaN', 10]);
    assert.equal(await evaluate('advancedToolsChecks.renderer.frame.properties.some(property=>property.name==="quality")'), false);
    await change('frame-slider', '0', { event: 'input' });
    await waitFor('advancedToolsChecks.renderer.frame.frameIndex===0 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent==="Calculated"', 'initial source frame returns');
    const sourceCoordination = await evaluate('advancedToolsChecks.propertyValues("coordination")');
    await showTool('replicate'); await change('replicate-a', '2'); await press('#apply-replicate');
    await change('replicate-atoms', true, { checkbox: true });
    await waitFor('advancedToolsChecks.renderer.atomCount===12 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent==="Calculated"', 'external attributes on physical copies');
    assert.deepEqual(await evaluate('advancedToolsChecks.propertyValues("temperature_external")'), [10, 20, 'NaN', 40, 50, 60, 10, 20, 'NaN', 40, 50, 60]);
    assert.deepEqual(await evaluate('advancedToolsChecks.propertyValues("coordination")'), [...sourceCoordination, ...sourceCoordination], 'replication keeps the same scientific values for a cell wider than twice the cutoff');
    assert.ok((await evaluate('advancedToolsChecks.vectorDraws()')).every(draw => draw.count === 12), 'enabled vector fields use the physically expanded atom arrays');
    await change('replicate-atoms', false, { checkbox: true });
    await waitFor('advancedToolsChecks.renderer.atomCount===6 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent==="Calculated"', 'physical copies return to display copies');
    await change('replicate-a', '1'); await press('#apply-replicate');
    const externalRecipe = await recipe();
    assert.equal(externalRecipe.settings.display.colorMode, 'property:temperature_external');
    const externalFile = externalRecipe.settings.extensions.externalProperties.files[0];
    assert.equal(externalFile.mapping, 'id');
    assert.equal(externalFile.columns.find(column => column.sourceName === 'temperature').name, 'temperature_external');
    assert.equal(externalFile.columns.find(column => column.sourceName === 'quality').enabled, false);
    await press('#close-file'); await restore(externalRecipe, { pending: true });
    await load('advanced-trajectory.xyz', { allowAnalyses: true });
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("external-property-status").textContent.includes("Reselect external files")', 'recipe explicitly waits for external local files');
    assert.equal(await evaluate('advancedToolsChecks.renderer.frame.properties.some(property=>property.name==="temperature_external")'), false, 'recipe metadata does not invent attribute values');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:temperature_external', 'a pending external field retains the saved color quantity');
    await showTool('externalProperties'); await inputFiles('#external-property-file', ['advanced-attributes.csv']);
    await waitFor('document.getElementById("external-property-status").textContent.startsWith("Restored") && advancedToolsChecks.renderer.frame.properties.some(property=>property.name==="temperature_external")', 'reselect external file');
    assert.deepEqual(await evaluate('advancedToolsChecks.propertyValues("temperature_external")'), [10, 20, 'NaN', 40, 50, 60]);
    assert.equal(await evaluate('advancedToolsChecks.renderer.frame.properties.some(property=>property.name==="quality")'), false);
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:temperature_external', 'reselected external data restores its saved color quantity');
    assert.deepEqual((await recipe()).settings.extensions.externalProperties, externalRecipe.settings.extensions.externalProperties, 'reselection preserves the saved renamed and removed columns');
    const externalScreenshot = await screenshot('external-attributes.png');
    await press('[data-tool-button="externalProperties"]');
    assert.equal(await evaluate('document.querySelector("[data-tool-button=externalProperties]").classList.contains("enabled")'), true);
    assert.equal(await evaluate('document.querySelector("[data-tool-button=externalProperties] .tool-enabled-dot").hidden'), false, 'closing attribute settings keeps the attached-data indicator enabled');
    console.log('Advanced tools: vector group drawing, independent styles, replay and external attributes passed.');

    await closeOverlays(); await showTool('display');
    await press('#toggle-camera-controls');
    assert.equal(await evaluate('document.getElementById("camera-controls").hidden || document.getElementById("camera-controls").inert'), false);
    await change('camera-projection', 'perspective'); await change('camera-fov', '55');
    close([await evaluate('advancedToolsChecks.renderer.getCameraState().fov * 180 / Math.PI')], [55]);
    await change('camera-constrain-up', false, { checkbox: true }); await change('camera-roll', '30');
    close([await evaluate('advancedToolsChecks.renderer.getCameraState().roll * 180 / Math.PI')], [30]);
    const positionX = await evaluate('advancedToolsChecks.renderer.getCameraState().position[0]');
    await change('camera-position-0', String(positionX + 1));
    close([await evaluate('advancedToolsChecks.renderer.getCameraState().position[0]')], [positionX + 1]);
    const sliderPoint = await evaluate(`(() => {const slider=document.getElementById('camera-yaw-slider');slider.scrollIntoView({block:'nearest'});const box=slider.getBoundingClientRect();return{x:box.left+box.width*.7,y:box.top+box.height/2};})()`);
    await tap(sliderPoint);
    await waitFor('Math.abs(Number(document.getElementById("camera-yaw").value)-advancedToolsChecks.renderer.yaw*180/Math.PI)<.01', 'graphical yaw slider synchronizes numeric angle');
    await evaluate(`(() => {const inputs=[0,1,2].map(axis=>document.getElementById('camera-direction-'+axis));inputs.forEach((input,axis)=>input.value=String([2,-3,4][axis]));inputs[0].focus();inputs[0].dispatchEvent(new Event('change',{bubbles:true}));})()`);
    close(await evaluate('advancedToolsChecks.renderer.getCameraState().direction'), [2, -3, 4].map(value => value / Math.sqrt(29)));
    close([await evaluate('Number(document.getElementById("camera-direction-0").value)')], [2 / Math.sqrt(29)]);
    assert.equal(await evaluate('document.activeElement.id'), 'camera-direction-0', 'normalization updates a committed input while it remains focused');
    await evaluate(`(() => {const inputs=[0,1,2].map(axis=>document.getElementById('camera-direction-'+axis));inputs.forEach((input,axis)=>input.value=String([0,0,-1][axis]));inputs[2].dispatchEvent(new Event('change',{bubbles:true}));})()`);
    close(await evaluate('advancedToolsChecks.renderer.getCameraState().direction'), [0, 0, -1]);
    await change('camera-roll', '90');
    const rollSpace = await evaluate('advancedToolsChecks.viewportSpace()');
    const beforeRollDrag = await evaluate('({direction:advancedToolsChecks.renderer.getCameraState().direction,basis:advancedToolsChecks.renderer.cameraBasis()})');
    await drag(rollSpace, { x: rollSpace.x + 30, y: rollSpace.y });
    const afterRollDirection = await evaluate('advancedToolsChecks.renderer.getCameraState().direction');
    const screenChange = afterRollDirection.map((value, axis) => value - beforeRollDrag.direction[axis]);
    const rightChange = screenChange.reduce((sum, value, axis) => sum + value * beforeRollDrag.basis.right[axis], 0);
    const upChange = screenChange.reduce((sum, value, axis) => sum + value * beforeRollDrag.basis.up[axis], 0);
    assert.ok(Math.abs(rightChange) > .05 && Math.abs(upChange) < .02, 'horizontal orbit follows screen right when the camera has a 90 degree roll');
    await change('camera-roll', '30');
    const globePoint = await evaluate(`(() => {const globe=document.getElementById('camera-trackball');globe.scrollIntoView({block:'nearest'});const box=globe.getBoundingClientRect();return{x:box.left+box.width/2,y:box.top+box.height/2};})()`);
    const beforeGlobe = await evaluate('advancedToolsChecks.renderer.getCameraState()');
    await drag(globePoint, { x: globePoint.x + 35, y: globePoint.y + 12 });
    assert.notDeepEqual(await evaluate('advancedToolsChecks.renderer.getCameraState().direction'), beforeGlobe.direction, 'dragging the camera globe changes the view');
    let space = await evaluate('advancedToolsChecks.viewportSpace()');
    assert.ok(space, 'there is exposed viewport space beside the camera popup');
    const beforeDrag = await evaluate('advancedToolsChecks.renderer.getCameraState()');
    await drag(space, { x: space.x + 30, y: space.y + 15 });
    assert.notDeepEqual(await evaluate('advancedToolsChecks.renderer.getCameraState().direction'), beforeDrag.direction, 'real viewport drag changes camera direction');
    assert.equal(await evaluate('document.getElementById("camera-controls").hidden'), false, 'viewport dragging keeps precision controls open');
    assert.equal(await evaluate('advancedToolsChecks.cameraFieldsCurrent()'), true, 'precision numbers follow viewport orbit');
    space = await evaluate('advancedToolsChecks.viewportSpace()');
    const beforePan = await evaluate('advancedToolsChecks.renderer.getCameraState().position');
    await drag(space, { x: space.x + 20, y: space.y + 10 }, 'right');
    assert.notDeepEqual(await evaluate('advancedToolsChecks.renderer.getCameraState().position'), beforePan, 'real pan updates camera position');
    assert.equal(await evaluate('advancedToolsChecks.cameraFieldsCurrent()'), true);
    const beforeWheel = await evaluate('advancedToolsChecks.renderer.getCameraState().distance');
    await evaluate('document.getElementById("camera-position-0").focus()');
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: space.x, y: space.y, deltaX: 0, deltaY: -120 });
    await waitFor(`advancedToolsChecks.renderer.getCameraState().distance!==${beforeWheel}`, 'real perspective wheel zoom');
    assert.equal(await evaluate('advancedToolsChecks.cameraFieldsCurrent()'), true);
    assert.equal(await evaluate('document.activeElement.id'), 'camera-position-0', 'wheel zoom synchronizes an already committed focused position input');
    const originalDirection = await evaluate('advancedToolsChecks.renderer.getCameraState().direction');
    await evaluate(`(() => {const input=document.getElementById('camera-direction-0');input.focus();input.value='2';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const beforeDirtyWheel = await evaluate('advancedToolsChecks.renderer.getCameraState().distance');
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: space.x, y: space.y, deltaX: 0, deltaY: 100 });
    await waitFor(`advancedToolsChecks.renderer.getCameraState().distance!==${beforeDirtyWheel}`, 'wheel while a camera edit is pending');
    assert.equal(await evaluate('document.getElementById("camera-direction-0").value'), '2', 'a pending typed number survives camera render updates');
    await evaluate('document.getElementById("camera-direction-0").dispatchEvent(new Event("change",{bubbles:true}))');
    const pendingDirection = [2, originalDirection[1], originalDirection[2]];
    close(await evaluate('advancedToolsChecks.renderer.getCameraState().direction'), pendingDirection.map(value => value / Math.hypot(...pendingDirection)));
    assert.equal(await evaluate('advancedToolsChecks.cameraFieldsCurrent()'), true, 'committing the typed vector shows its normalized components');
    // Editing a Cartesian view direction can intentionally point the eye away
    // from the source. Center the structure while retaining this orientation.
    await evaluate('advancedToolsChecks.renderer.centerOnPoint([5,5,5]); advancedToolsChecks.renderer.render(performance.now(),{trackStats:false})');
    await pick();
    await change('camera-projection', 'orthographic'); await change('camera-field-width', '18');
    close([await evaluate('advancedToolsChecks.renderer.getCameraState().fieldWidth')], [18]);
    assert.equal(await evaluate('document.getElementById("camera-fov").disabled'), true);
    space = await evaluate('advancedToolsChecks.viewportSpace()');
    const beforeOrthoWheel = await evaluate('advancedToolsChecks.renderer.getCameraState().fieldWidth');
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: space.x, y: space.y, deltaX: 0, deltaY: 120 });
    await waitFor(`advancedToolsChecks.renderer.getCameraState().fieldWidth!==${beforeOrthoWheel}`, 'real parallel wheel zoom');
    assert.equal(await evaluate('advancedToolsChecks.cameraFieldsCurrent()'), true);
    await pick();
    await change('camera-cell-outline', 'rgb');
    assert.equal(await evaluate('advancedToolsChecks.renderer.cellWireframeMode'), 'rgb');
    const cellColors = await evaluate('advancedToolsChecks.cellColors()');
    assert.equal(new Set(cellColors.map(color => color.join(','))).size, 3, 'RGB cell directions submit three distinct colors');
    cellColors.forEach((color, axis) => assert.equal(color.indexOf(Math.max(...color)), axis, 'each cell basis direction uses its corresponding RGB color'));
    const cameraRecipe = await recipe();
    const pngOpen = await evaluate('advancedToolsChecks.exportPng(true)');
    await writeFile(resolve(artifacts, 'camera-popup-open-viewport.png'), Buffer.from(pngOpen.data, 'base64'));
    await press('#close-camera-controls');
    const pngClosed = await evaluate('advancedToolsChecks.exportPng(false)');
    assert.equal(pngClosed.changedPixels, 0, 'PNG capture excludes the camera popup without changing rendered pixels');
    await change('coordinate-mode', 'wrapped');
    await restore(cameraRecipe);
    const replayedCamera = (await recipe()).settings.camera;
    for (const key of ['roll', 'fov', 'constrainUp', 'projectionMode']) assert.equal(replayedCamera[key], cameraRecipe.settings.camera[key]);
    await press('#toggle-camera-controls');
    const cameraScreenshot = await screenshot('precise-camera-controls.png');
    console.log('Advanced tools: camera numeric/graphical edits, real drag/pan/wheel synchronization and identical PNG pixels passed.');

    const compactPhones = [];
    for (const [width, height] of [[390, 640], [320, 568], [640, 400]]) {
      mobile = true;
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      await closeOverlays();
      await showTool('coordination');
      const beforeCategory = await evaluate('advancedToolsChecks.propertyValues("coordination")');
      await press('#tool-category-modification'); await press('#tool-category-visualization');
      assert.deepEqual(await evaluate('advancedToolsChecks.propertyValues("coordination")'), beforeCategory, 'phone category switches retain calculated properties');
      assert.equal(await evaluate('document.getElementById("analysis-state").textContent'), 'Calculated');
      assert.equal(await evaluate('document.getElementById("camera-controls").hidden && document.getElementById("camera-controls").inert'), true, 'compact phone camera panel remains folded until requested');
      await showTool('display');
      const beforeScroll = await evaluate('advancedToolsChecks.cameraAndViewport()');
      const pane = await evaluate(`(() => {const panel=document.getElementById('sidebar');panel.scrollTop=0;const box=panel.getBoundingClientRect();return{x:box.left+8,y:Math.min(innerHeight-18,box.bottom-18),height:box.height,scrollable:panel.scrollHeight>panel.clientHeight};})()`);
      assert.equal(pane.scrollable, true, 'compact phone sidebar can scroll');
      const distance = Math.max(24, Math.min(90, pane.height - 32));
      await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: pane.x, y: pane.y }] });
      for (let step = 1; step <= 5; step++) {
        await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: pane.x, y: pane.y - distance * step / 5 }] });
        await delay(25);
      }
      await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitFor('document.getElementById("sidebar").scrollTop>0', 'compact phone tools scrolling');
      await evaluate(`(async()=>{const panel=document.getElementById('sidebar');let previous=panel.scrollTop,stable=0;for(let attempt=0;attempt<50&&stable<3;attempt++){await new Promise(resolve=>setTimeout(resolve,40));const current=panel.scrollTop;stable=current===previous?stable+1:0;previous=current;}})()`);
      assert.deepEqual(await evaluate('advancedToolsChecks.cameraAndViewport()'), beforeScroll, 'phone tools scroll keeps viewport and camera fixed');
      await evaluate(`(() => {const sidebar=document.getElementById('sidebar'),tools=document.getElementById('tool-category-visualization').closest('.side-section');sidebar.scrollTop+=tools.getBoundingClientRect().top-sidebar.getBoundingClientRect().top-8;})()`);
      compactPhones.push({ width, height, screenshot: await screenshot(`tools-${width}x${height}.png`) });
    }

    async function drag(start, end, button = 'left') {
      const buttons = button === 'right' ? 2 : 1;
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button, buttons, clickCount: 1 });
      for (let step = 1; step <= 4; step++) {
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (end.x - start.x) * step / 4, y: start.y + (end.y - start.y) * step / 4, button, buttons });
        await delay(20);
      }
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button, buttons: 0, clickCount: 1 });
      await delay(50);
    }
    return { softwareBrowser: true, compute: 'CPU Workers', adapter, atoms: 6,
      checks: ['periodic display origin', 'mixed-PBC skew cell', 'slice planes from real picks', 'multiple independent vector fields',
        'ID-mapped external attributes', 'metadata recipe and local file reselection', 'physical copies of external data',
        'precise camera controls', 'real viewport gestures and synchronized numeric controls', 'PNG excludes camera popup', 'compact phone category navigation and scrolling'],
      modelCoverage: ['tests/periodic-origin.test.js: periodic bond image shifts and DXA curve continuity'],
      screenshots: { sliceScreenshot, vectorScreenshot, externalScreenshot, cameraScreenshot }, compactPhones };
  }, { software: true });
  const reportPath = resolve(artifacts, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Advanced tools browser regression passed. Report: ${reportPath}`);
} finally { await rm(temporary, { recursive: true, force: true }); }

function close(actual, expected, epsilon = 1e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < epsilon, `${actual} differs from ${expected}`));
}

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const [{ WebGLRenderer }, { AnalysisPool }, { transformPoint }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)), import(new URL('./render/math.js', app)),
  ]);
  const checks = window.advancedToolsChecks = { analyses: 0, analysisHeld: false, holdNextAnalysis: false };
  const setFrame = WebGLRenderer.prototype.setFrame, analyze = AnalysisPool.prototype.analyze;
  WebGLRenderer.prototype.setFrame = function(...args) { if (this.canvas.id === 'viewport') checks.renderer = this; return setFrame.apply(this, args); };
  AnalysisPool.prototype.analyze = async function(...args) {
    checks.analyses++;
    const hold = checks.holdNextAnalysis; checks.holdNextAnalysis = false;
    const result = await analyze.apply(this, args);
    if (hold) {
      checks.heldSignal = args[2]?.signal; checks.analysisHeld = true;
      await new Promise(resolve => { checks.releaseAnalysis = () => { checks.analysisHeld = false; resolve(); }; });
    }
    return result;
  };
  checks.activeTool = () => document.querySelector('[data-tool-button][aria-expanded="true"]')?.dataset.toolButton ?? null;
  checks.propertyValues = name => Array.from(checks.renderer.frame.properties.find(property => property.name === name)?.data ?? [], value => Number.isNaN(value) ? 'NaN' : value);
  checks.saveScience = () => {
    const r = checks.renderer;
    checks.science = { positions: Array.from(new Uint8Array(r.frame.positions.buffer, r.frame.positions.byteOffset, r.frame.positions.byteLength)),
      fractional: Array.from(new Uint8Array(r.frame.fractional.buffer, r.frame.fractional.byteOffset, r.frame.fractional.byteLength)),
      coordination: r.frame.properties.find(property => property.name === 'coordination')?.data,
      coordinationValues: checks.propertyValues('coordination') };
  };
  checks.scienceUnchanged = () => {
    const r = checks.renderer, saved = checks.science;
    const sameBytes = (array, bytes) => JSON.stringify(Array.from(new Uint8Array(array.buffer, array.byteOffset, array.byteLength))) === JSON.stringify(bytes);
    return sameBytes(r.frame.positions, saved.positions) && sameBytes(r.frame.fractional, saved.fractional)
      && r.frame.properties.find(property => property.name === 'coordination')?.data === saved.coordination
      && JSON.stringify(checks.propertyValues('coordination')) === JSON.stringify(saved.coordinationValues);
  };
  checks.pickPoint = (wanted, replicaIndices = [0, 0, 0]) => {
    const r = checks.renderer; r.render(performance.now(), { trackStats: false });
    const box = r.canvas.getBoundingClientRect();
    for (let index = 0; index < r.atomCount; index++) {
      if (wanted !== null && wanted !== index) continue;
      const replica = r.replicas.find(item => item.indices.every((value, axis) => value === replicaIndices[axis]));
      if (!replica) continue;
      const position = Array.from(r.displayPositions.slice(index * 3, index * 3 + 3), (value, axis) => value + replica.offset[axis]);
      const p = transformPoint(r.viewProjectionMatrix, ...position);
      const x = box.left + (p[0] / p[3] * .5 + .5) * box.width, y = box.top + (.5 - p[1] / p[3] * .5) * box.height;
      if (document.elementFromPoint(x, y) === r.canvas && r.pick(x, y) === index
        && r.lastPick?.replica.every((value, axis) => value === replicaIndices[axis])) return { x, y, index, id: r.frame.ids[index], position };
    }
    return null;
  };
  checks.pickDebug = () => {
    const r = checks.renderer, box = r.canvas.getBoundingClientRect();
    return { camera: r.getCameraState(), box: { x: box.x, y: box.y, width: box.width, height: box.height },
      atoms: Array.from(r.frame.ids, (id, index) => {const p=transformPoint(r.viewProjectionMatrix,...r.displayPositions.slice(index*3,index*3+3)),x=box.left+(p[0]/p[3]*.5+.5)*box.width,y=box.top+(.5-p[1]/p[3]*.5)*box.height;return{id,index,x,y,hit:document.elementFromPoint(x,y)?.id,picked:r.pick(x,y),visibility:r.visibility[index]};}) };
  };
  checks.vectorDraws = () => {
    const r = checks.renderer, layer = r.primitiveLayer, draws = [];
    const original = layer.drawMesh;
    layer.drawMesh = function(...args) { if (args[5]) draws.push({ count: args[0].count, color: [...this.vectorOptions.color] }); return original.apply(this, args); };
    try { r.render(performance.now(), { trackStats: false }); } finally { layer.drawMesh = original; }
    return draws;
  };
  checks.cellColors = () => {
    const r = checks.renderer, gl = r.gl, colors = [], original = gl.uniform3f;
    gl.uniform3f = function(location, ...values) { if (location === r.lineUniforms.uColor) colors.push(values); return original.call(this, location, ...values); };
    try { r.render(performance.now(), { trackStats: false }); } finally { gl.uniform3f = original; }
    return colors;
  };
  checks.viewportSpace = () => {
    const r = checks.renderer, box = r.canvas.getBoundingClientRect();
    for (const vertical of [.7, .6, .5, .4, .3]) for (const horizontal of [.3, .4, .5, .2, .6]) {
      const x = box.left + box.width * horizontal, y = box.top + box.height * vertical;
      if ([[-2, -2], [35, 15], [0, 0]].every(([dx, dy]) => document.elementFromPoint(x + dx, y + dy) === r.canvas)) return { x, y };
    }
    return null;
  };
  checks.cameraFieldsCurrent = () => {
    const state = checks.renderer.getCameraState();
    const close = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
    return ['position', 'direction', 'up'].every(name => state[name].every((value, axis) => close(Number(document.getElementById(`camera-${name}-${axis}`).value), value)))
      && ['yaw', 'pitch', 'roll'].every(name => close(Number(document.getElementById(`camera-${name}`).value), Math.atan2(Math.sin(state[name]), Math.cos(state[name])) * 180 / Math.PI))
      && close(Number(document.getElementById('camera-field-width').value), state.fieldWidth);
  };
  checks.cameraAndViewport = () => {
    const r = checks.renderer, box = r.canvas.getBoundingClientRect();
    return { state: r.getCameraState(), canvas: { x: box.x, y: box.y, width: box.width, height: box.height }, pageScroll: scrollY };
  };
  checks.exportRecipe = async () => {
    const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click; let blob;
    URL.createObjectURL = function(value) { blob = value; return createUrl.call(this, value); };
    HTMLAnchorElement.prototype.click = () => {};
    try { document.getElementById('export-configuration').click(); if (!blob) throw new Error('Configuration export produced no Blob.'); return JSON.parse(await blob.text()); }
    finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
  checks.exportPng = async saveReference => {
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
      else {
        if (pixels.length !== checks.pngReference.length) throw new Error('Popup changed PNG dimensions.');
        for (let offset = 0; offset < pixels.length; offset += 4) if ([0, 1, 2, 3].some(channel => pixels[offset + channel] !== checks.pngReference[offset + channel])) changedPixels++;
      }
      const data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
      return { width: canvas.width, height: canvas.height, changedPixels, data };
    } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
}
