import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Exercise computed properties and expression selections in the production
// UI: Color by, WebGL colors, PNG legends, CSV, trajectory recalculation,
// configuration replay and the expansion Worker against brute force.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-expressions-'));
const trajectory = resolve(directory, 'tilted-expressions.dump');
const count = 96, [xy, xz, yz] = [3, 2, 1];
let seed = 12345;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const atoms = Array.from({ length: count }, (_, index) => ({ id: 1000 + 7 * index, type: 1 + index % 2,
  fractional: [random(), random(), random()], velocity: [random() * 8 - 4, random() * 8 - 4, random() * 8 - 4] }));
const dumpFrame = step => [
  'ITEM: TIMESTEP', String(step * 100), 'ITEM: NUMBER OF ATOMS', String(count),
  'ITEM: BOX BOUNDS xy xz yz pp pp pp', `0 ${14 + xy + xz} ${xy}`, `0 ${13 + yz} ${xz}`, `0 12 ${yz}`,
  'ITEM: ATOMS id type xs ys zs vx vy vz c_csp c_s[1]',
  ...atoms.map((atom, index) => [atom.id, atom.type, ...atom.fractional.map(value => value.toFixed(6)),
    ...atom.velocity.map(value => (value * (1 + step)).toFixed(4)), ((index * 37 + step * 11) % 13).toFixed(2), (index - 40 * step).toFixed(1)].join(' ')),
  '',
].join('\n');
await writeFile(trajectory, dumpFrame(0) + dumpFrame(1));

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Page.addScriptToEvaluateOnNewDocument', { source:
      'Object.defineProperty(Navigator.prototype,"hardwareConcurrency",{configurable:true,get:()=>4});' });
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(25);
      }
      throw new Error(`${label}: ${await evaluate('document.getElementById("toast")?.textContent')}`);
    }
    await waitFor('document.readyState==="complete" && document.getElementById("color-mode")', 'Application startup');
    await evaluate(`(${installChecks.toString()})()`);
    await evaluate('if(document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true")document.getElementById("enable-gpu-computing").click()');
    async function upload(selector, path) {
      const { root: dom } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: dom.nodeId, selector });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function download(id) {
      await evaluate(`expressionChecks.beginDownload();document.getElementById(${JSON.stringify(id)}).click()`);
      try {
        await waitFor('Boolean(expressionChecks.download)', `${id} creates a downloadable Blob`);
        return await evaluate('expressionChecks.finishDownload()');
      } finally { await evaluate('expressionChecks.restoreDownload()'); }
    }
    const fill = values => evaluate(`expressionChecks.fill(${JSON.stringify(values)})`);
    const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const groups = async () => JSON.parse((await download('export-configuration')).text).settings.selectionGroups.groups;
    const status = () => evaluate('document.getElementById("expression-selection-status").textContent');

    await upload('#file-input', trajectory);
    await waitFor(`expressionChecks.renderer?.frame.ids.length===${count} && document.getElementById("loading").hidden`, 'Trajectory load');
    await evaluate('document.getElementById("tool-category-modification").click();document.querySelector("[data-tool-button=expressions]").click()');
    assert.equal(await evaluate('document.getElementById("tool-expressions").hidden'), false, 'Expressions opens in Modification tools');
    assert.equal(await evaluate('document.getElementById("save-expression-property").disabled'), false);

    // Compute a property and a dependent property.
    await fill({ 'expression-property-name': 'speedSq', 'expression-property-unit': 'Å²/ps²', 'expression-property-text': 'vx^2 + vy^2 + vz^2' });
    await click('save-expression-property');
    await waitFor('expressionChecks.options().some(option => option.value === "property:speedSq")', 'Computed property in Color by');
    assert.ok((await evaluate('expressionChecks.options()')).some(option => option.value === 'property:speedSq' && option.label === 'speedSq [Å²/ps²]'));
    assert.ok(await evaluate('expressionChecks.matches("speedSq", (p, i) => p.vx[i] ** 2 + p.vy[i] ** 2 + p.vz[i] ** 2)'), 'speedSq values in frame 1');
    await fill({ 'expression-property-name': 'bad', 'expression-property-text': 'c_cps > 1' });
    await click('save-expression-property');
    await waitFor('!document.getElementById("expression-property-error").hidden', 'Expression error display');
    assert.equal(await evaluate('document.getElementById("expression-property-error").textContent'), 'Unknown variable “c_cps” at column 1. Did you mean c_csp?');
    assert.deepEqual(await evaluate('(() => { const field = document.getElementById("expression-property-text"); return [field.getAttribute("aria-invalid"), field.selectionStart, field.selectionEnd]; })()'), ['true', 0, 5]);
    await fill({ 'expression-property-name': 'hot', 'expression-property-unit': '', 'expression-property-text': 'speedSq > 10 && Type == "Type 2"' });
    await click('save-expression-property');
    await waitFor('expressionChecks.options().some(option => option.value === "property:hot")', 'Dependent computed property');
    assert.equal(await evaluate('document.getElementById("expression-property-error").hidden'), true);
    assert.ok(await evaluate('expressionChecks.matches("hot", (p, i, frame) => p.vx[i] ** 2 + p.vy[i] ** 2 + p.vz[i] ** 2 > 10 && frame.types[i] === 1 ? 1 : 0)'));
    assert.equal(await evaluate('document.querySelectorAll("#expression-property-list .expression-property-row").length'), 2);

    // Color by the computed property: exact WebGL colors and PNG legend data.
    await evaluate('expressionChecks.change("legend-color-mode","property:speedSq")');
    assert.deepEqual(await evaluate('expressionChecks.exact("speedSq")'), { colors: true, glError: 0 });
    await evaluate('document.getElementById("png-legend").checked=true;document.getElementById("png-legend").dispatchEvent(new Event("change",{bubbles:true}))');
    const png = await download('export-png');
    assert.deepEqual(png.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(await evaluate('expressionChecks.lastCapture.title'), 'speedSq');
    assert.ok(await evaluate('expressionChecks.lastCapture.data.every((value, index) => value === expressionChecks.property("speedSq").data[index])'));
    const csv = await download('export-atom-properties');
    const header = csv.text.split(/\r?\n/)[0];
    assert.ok(header.includes('speedSq [Å²/ps²]') && header.includes('hot'), `Atom CSV header: ${header}`);

    // A new trajectory frame recalculates the values and keeps the color choice.
    const firstFrameValues = await evaluate('Array.from(expressionChecks.property("speedSq").data)');
    await evaluate('document.getElementById("frame-next").click()');
    await waitFor('expressionChecks.renderer.frame.frameIndex===1 && document.getElementById("loading").hidden && expressionChecks.property("speedSq")', 'Second frame');
    assert.ok(await evaluate('expressionChecks.matches("speedSq", (p, i) => p.vx[i] ** 2 + p.vy[i] ** 2 + p.vz[i] ** 2)'), 'speedSq values in frame 2');
    assert.notDeepEqual(await evaluate('Array.from(expressionChecks.property("speedSq").data)'), firstFrameValues);
    assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'property:speedSq');
    assert.deepEqual(await evaluate('expressionChecks.exact("speedSq")'), { colors: true, glError: 0 });

    // Selection by expression with each operation.
    await fill({ 'expression-selection-text': 'c_csp > 4 && Type == 2' });
    await click('apply-expression-selection');
    await waitFor('/atoms match/.test(document.getElementById("expression-selection-status").textContent)', 'Expression selection');
    const expectedIds = await evaluate('expressionChecks.ids((p, i, frame) => p.c_csp[i] > 4 && frame.types[i] === 1)');
    let saved = await groups();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'Expression: c_csp > 4 && Type == 2');
    assert.deepEqual(saved[0].atomIds, expectedIds);
    assert.match(await status(), new RegExp(`^${expectedIds.length} of ${count} atoms match`));
    assert.equal(await evaluate('document.getElementById("expression-selection-group").value'), saved[0].id, 'the new group becomes the target');
    await fill({ 'expression-selection-text': 'ReducedPosition.Z < 0.5' });
    await evaluate('expressionChecks.change("expression-selection-operation","intersect")');
    await click('apply-expression-selection');
    await waitFor('/Intersected/.test(document.getElementById("expression-selection-status").textContent)', 'Intersect');
    const intersected = await evaluate('expressionChecks.ids((p, i, frame) => p.c_csp[i] > 4 && frame.types[i] === 1 && frame.fractional[i * 3 + 2] < 0.5)');
    assert.deepEqual((await groups())[0].atomIds, intersected);
    await evaluate('document.querySelector(".expression-selection-tools").open = true');
    await click('invert-expression-selection');
    await waitFor('/Inverted/.test(document.getElementById("expression-selection-status").textContent)', 'Invert');
    const inverted = await evaluate(`expressionChecks.ids((p, i, frame) => !${JSON.stringify(intersected)}.includes(frame.ids[i]))`);
    assert.deepEqual([...(await groups())[0].atomIds].sort((a, b) => a - b), [...inverted].sort((a, b) => a - b));

    // Expansion in the Worker matches periodic brute force in the tilted cell.
    const frameData = await evaluate('({ fractional: Array.from(expressionChecks.renderer.frame.fractional), vectors: Array.from(expressionChecks.renderer.frame.cell.vectors), ids: Array.from(expressionChecks.renderer.frame.ids) })');
    await fill({ 'expression-selection-text': 'Index % 17 == 0' });
    await evaluate('expressionChecks.change("expression-selection-operation","replace")');
    await click('apply-expression-selection');
    await waitFor('/Replaced/.test(document.getElementById("expression-selection-status").textContent)', 'Replace');
    const seeds = frameData.ids.filter((_, index) => index % 17 === 0);
    const cutoff = safeCutoff(frameData, 2.9);
    await evaluate(`expressionChecks.change("expand-selection-mode","cutoff");expressionChecks.fill({ "expand-selection-cutoff": "${cutoff}", "expand-selection-iterations": "2" })`);
    await click('expand-expression-selection');
    await waitFor('/Added \\d+ neighboring atoms/.test(document.getElementById("expression-selection-status").textContent)', 'Cutoff expansion');
    const cutoffExpected = bruteExpand(frameData, seeds, { mode: 'cutoff', cutoff, iterations: 2 });
    assert.deepEqual([...(await groups())[0].atomIds].sort((a, b) => a - b), cutoffExpected);
    assert.ok(cutoffExpected.length > seeds.length);
    await click('apply-expression-selection');
    await waitFor('/Replaced/.test(document.getElementById("expression-selection-status").textContent)', 'Replace again');
    await evaluate('expressionChecks.change("expand-selection-mode","nearest");expressionChecks.fill({ "expand-selection-count": "3", "expand-selection-iterations": "1" })');
    assert.equal(await evaluate('document.getElementById("expand-selection-cutoff-field").hidden && !document.getElementById("expand-selection-count-field").hidden'), true);
    await click('expand-expression-selection');
    await waitFor('/Added \\d+ neighboring atoms/.test(document.getElementById("expression-selection-status").textContent)', 'Nearest expansion');
    assert.deepEqual([...(await groups())[0].atomIds].sort((a, b) => a - b), bruteExpand(frameData, seeds, { mode: 'nearest', count: 3, iterations: 1 }));

    // Configuration replay restores definitions, values and the color choice.
    const recipeText = (await download('export-configuration')).text;
    const recipe = JSON.parse(recipeText);
    assert.deepEqual(recipe.settings.extensions.expressions, { properties: [
      { name: 'speedSq', unit: 'Å²/ps²', expression: 'vx^2 + vy^2 + vz^2' },
      { name: 'hot', unit: '', expression: 'speedSq > 10 && Type == "Type 2"' }] });
    assert.equal(recipeText.includes('"data"'), false, 'no computed values in the recipe');
    await evaluate('document.querySelector("[data-expression-property=hot] .expression-property-actions button:last-child").click()');
    await waitFor('!expressionChecks.options().some(option => option.value === "property:hot")', 'Remove dependent property');
    await evaluate('document.querySelector("[data-expression-property=speedSq] .expression-property-actions button:last-child").click()');
    await waitFor('!expressionChecks.options().some(option => option.value === "property:speedSq")', 'Remove property');
    assert.equal(await evaluate('document.getElementById("legend-color-mode")?.value ?? document.getElementById("color-mode").value'), 'type');
    const recipePath = resolve(directory, 'recipe.json');
    await writeFile(recipePath, recipeText);
    await upload('#configuration-file', recipePath);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && expressionChecks.property("hot")', 'Recipe replay');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:speedSq');
    assert.ok(await evaluate('expressionChecks.matches("speedSq", (p, i) => p.vx[i] ** 2 + p.vy[i] ** 2 + p.vz[i] ** 2)'));
    const members = recipe.settings.selectionGroups.groups[0].atomIds;
    assert.ok(members.length < count);
    assert.deepEqual(await evaluate(`expressionChecks.exact("speedSq", ${JSON.stringify(members)})`), { colors: true, glError: 0 });

    // Renaming keeps the color choice; a property used below cannot be renamed.
    const editButton = name => `document.querySelector("[data-expression-property=${name}] .expression-property-actions button:nth-last-child(2)").click()`;
    await evaluate('expressionChecks.change("legend-color-mode","property:hot")');
    await evaluate(editButton('speedSq'));
    assert.equal(await evaluate('document.getElementById("save-expression-property").textContent'), 'Update property');
    await fill({ 'expression-property-name': 'speed2' });
    await click('save-expression-property');
    await waitFor('!document.getElementById("expression-property-error").hidden', 'Rename guard');
    assert.match(await evaluate('document.getElementById("expression-property-error").textContent'), /“hot” uses “speedSq”/);
    await click('cancel-expression-edit');
    await evaluate(editButton('hot'));
    await fill({ 'expression-property-name': 'hotAtoms' });
    await click('save-expression-property');
    await waitFor('expressionChecks.options().some(option => option.value === "property:hotAtoms")', 'Rename');
    assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:hotAtoms');
    assert.equal(await evaluate('expressionChecks.options().some(option => option.value === "property:hot")'), false);

    // A hostile recipe is rejected by the parser and never executed.
    const hostile = JSON.parse(recipeText);
    hostile.settings.extensions.expressions.properties[0].expression = 'globalThis.pwned = constructor.constructor("window.pwned=1")()';
    const hostilePath = resolve(directory, 'hostile.json');
    await writeFile(hostilePath, JSON.stringify(hostile));
    await evaluate('document.getElementById("toast").textContent = ""');
    await upload('#configuration-file', hostilePath);
    await waitFor('/Invalid AlloyView configuration/.test(document.getElementById("toast").textContent)', 'Hostile recipe rejection');
    assert.equal(await evaluate('window.pwned'), undefined);
    assert.ok(await evaluate('Boolean(expressionChecks.property("speedSq"))'), 'the current settings stay intact');

    // Narrow screens keep the panel within its width.
    await call('Emulation.setDeviceMetricsOverride', { width: 375, height: 760, deviceScaleFactor: 2, mobile: true });
    await delay(200);
    const overflow = await evaluate('(() => { const panel = document.getElementById("tool-expressions"); return { scroll: panel.scrollWidth, client: panel.clientWidth }; })()');
    assert.ok(overflow.scroll <= overflow.client + 1, `panel overflow on a phone: ${JSON.stringify(overflow)}`);
    assert.equal(await evaluate('expressionChecks.renderer.gl.getError()'), 0);
    return { properties: recipe.settings.extensions.expressions.properties.map(property => property.name), matched: expectedIds.length,
      intersected: intersected.length, inverted: inverted.length, cutoff, cutoffExpanded: cutoffExpected.length, pngBytes: png.size, phonePanel: overflow };
  }, { software: true, requireGpu: false });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }

/** Pairs at least 1e-4 Å from the cutoff, so float rounding cannot decide. */
function safeCutoff(frame, preferred) {
  let cutoff = preferred;
  for (let attempt = 0; attempt < 50; attempt++, cutoff += 0.013) {
    const close = frame.ids.some((_, atom) => candidates(frame, atom).some(item => Math.abs(item.distance - cutoff) < 1e-4));
    if (!close) return Number(cutoff.toFixed(3));
  }
  throw new Error('No unambiguous cutoff found.');
}

function candidates(frame, atom) {
  const h = frame.vectors, result = [];
  for (let other = 0; other < frame.ids.length; other++) for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let c = -2; c <= 2; c++) {
    if (other === atom && !a && !b && !c) continue;
    const d = [a, b, c].map((image, axis) => frame.fractional[other * 3 + axis] + image - frame.fractional[atom * 3 + axis]);
    result.push({ atom: other, distance: Math.hypot(...[0, 1, 2].map(axis => d[0] * h[axis] + d[1] * h[3 + axis] + d[2] * h[6 + axis])) });
  }
  return result.sort((first, second) => first.distance - second.distance);
}

function bruteExpand(frame, seedIds, { mode, cutoff, count: neighbors, iterations }) {
  const selected = new Set(seedIds.map(id => frame.ids.indexOf(id)));
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const atom of [...selected]) {
      const list = candidates(frame, atom);
      for (const { atom: other } of mode === 'cutoff' ? list.filter(item => item.distance <= cutoff) : list.slice(0, neighbors)) selected.add(other);
    }
  }
  return [...selected].map(index => frame.ids[index]).sort((a, b) => a - b);
}

async function installChecks() {
  const app = document.querySelector('script[type="module"][src]').src;
  const [{ WebGLRenderer }, { colorsByProperty }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./render/palette.js', app)),
  ]);
  const checks = window.expressionChecks = {};
  const setFrame = WebGLRenderer.prototype.setFrame, capture = WebGLRenderer.prototype.captureImage;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this;
    return setFrame.apply(this, args);
  };
  WebGLRenderer.prototype.captureImage = function(options) {
    if (this.canvas.id === 'viewport') checks.lastCapture = { title: options?.legend?.title, data: Array.from(options?.legend?.property?.data ?? []) };
    return capture.call(this, options);
  };
  checks.change = (id, value) => {
    const element = document.getElementById(id); element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.fill = values => {
    for (const [id, value] of Object.entries(values)) {
      const element = document.getElementById(id); element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  checks.options = () => Array.from(document.getElementById('color-mode').options, option => ({ value: option.value, label: option.textContent }));
  checks.property = name => checks.renderer?.frame.properties.find(property => property.name === name);
  checks.raw = () => Object.fromEntries(checks.renderer.frame.properties.map(property => [property.name, property.data]));
  checks.matches = (name, source) => {
    const frame = checks.renderer.frame, property = checks.property(name), raw = checks.raw();
    if (!property) return false;
    return Array.from(frame.ids).every((_, index) => {
      const expected = Number(source(raw, index, frame));
      return Math.abs(property.data[index] - expected) <= 1e-12 * Math.max(1, Math.abs(expected));
    });
  };
  checks.ids = predicate => {
    const frame = checks.renderer.frame, raw = checks.raw();
    return Array.from(frame.ids).filter((_, index) => predicate(raw, index, frame));
  };
  checks.range = () => Array.from(document.querySelectorAll('.legend-controls input[type=number]'), input => input.valueAsNumber);
  // Selection group colors override the palette, so their members are skipped.
  checks.exact = (name, groupIds = []) => {
    const [minimum, maximum] = checks.range(), scheme = document.querySelector('.legend-scheme select').value;
    const expected = colorsByProperty({ name: 'expected', data: checks.property(name).data }, { minimum, maximum }, scheme).colors;
    const skip = new Set(groupIds), ids = checks.renderer.frame.ids;
    checks.renderer.render();
    return { colors: checks.renderer.atomColors.every((value, index) => skip.has(ids[Math.floor(index / 3)]) || value === expected[index]),
      glError: checks.renderer.gl.getError() };
  };
  const originalUrl = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
  checks.beginDownload = () => {
    checks.download = null;
    URL.createObjectURL = function(blob) { checks.download = blob; return originalUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = () => {};
  };
  checks.restoreDownload = () => { URL.createObjectURL = originalUrl; HTMLAnchorElement.prototype.click = originalClick; };
  checks.finishDownload = async () => {
    const blob = checks.download;
    return { type: blob.type, size: blob.size, text: /json|csv|text/.test(blob.type) ? await blob.text() : '',
      signature: Array.from(new Uint8Array(await blob.slice(0, 8).arrayBuffer())) };
  };
}
