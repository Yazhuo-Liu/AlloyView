import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Production DOM with real pointer and keyboard input: Miller-index planes,
// stepping, flip, slab mode, cut outlines in PNG exports and recipe restore.
// The fixture is an FCC crystal of 3×3×3 conventional cells, so its (111)
// atomic planes are the (3 3 3) planes of the cell and every atom lies on one.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-slice-sweep-fixtures-'));
const artifacts = resolve(tmpdir(), 'alloyview-slice-sweep');
await mkdir(artifacts, { recursive: true });
const a = 3.6, repeats = 3, basis = [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]];
const atoms = [];
for (let i = 0; i < repeats; i += 1) for (let j = 0; j < repeats; j += 1) for (let k = 0; k < repeats; k += 1) {
  for (const site of basis) atoms.push({ position: [i + site[0], j + site[1], k + site[2]].map(value => value * a),
    // (x + y + z)/a is the index m of the atom's (111) plane, n · r = m d.
    plane: i + j + k + site[0] + site[1] + site[2] });
}
const length = a * repeats;
await writeFile(resolve(temporary, 'fcc-sweep.xyz'), [String(atoms.length),
  `Lattice="${length} 0 0 0 ${length} 0 0 0 ${length}" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T"`,
  ...atoms.map((atom, index) => `Cu ${atom.position.join(' ')} ${index + 1}`), ''].join('\n'));
const count = predicate => atoms.filter(atom => predicate(atom.plane)).length;
const spacing = a / Math.sqrt(3);

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(35);
      }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({file:document.getElementById("file-name")?.textContent,status:document.getElementById("slice-status")?.textContent,configuration:document.getElementById("configuration-status")?.textContent,toast:document.getElementById("toast")?.textContent})')}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("add-slice")', 'production page');
    await evaluate(`(${initializeChecks.toString()})()`);
    async function inputFiles(selector, names) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector });
      assert.ok(nodeId, `file input ${selector} exists`);
      await call('DOM.setFileInputFiles', { nodeId, files: names.map(name => resolve(temporary, name)) });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function point(selector) {
      const target = await evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing control '+${JSON.stringify(selector)});element.scrollIntoView({block:'nearest',inline:'nearest'});const box=element.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2,hit=document.elementFromPoint(x,y);return{x,y,enabled:!element.disabled,reachable:element===hit||element.contains(hit)||hit?.control===element,hit:hit?.id||hit?.tagName};})()`);
      assert.ok(target.enabled && target.reachable, `${selector} is reachable: ${JSON.stringify(target)}`);
      return target;
    }
    let mobile = false;
    async function press(selector, { holdMs = 0 } = {}) {
      const { x, y } = await point(selector);
      if (mobile) {
        await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
        if (holdMs) await delay(holdMs);
        await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await delay(45);
        return;
      }
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      if (holdMs) await delay(holdMs);
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      await delay(45);
    }
    const KEYS = { Enter: { code: 'Enter', keyCode: 13, text: '\r' }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 } };
    async function key(selector, name) {
      const { code, keyCode, text } = KEYS[name];
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code, text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      await delay(30);
    }
    async function type(selector, value) {
      await evaluate(`(() => {const field=document.querySelector(${JSON.stringify(selector)});field.value='';field.focus();})()`);
      await call('Input.insertText', { text: value });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function showTool(name) {
      const category = await evaluate(`document.querySelector('[data-tool-button="${name}"]').closest('[data-tool-category-panel]').dataset.toolCategoryPanel`);
      if (await evaluate(`document.getElementById('tool-category-${category}').getAttribute('aria-selected')!=='true'`)) await press(`#tool-category-${category}`);
      if (await evaluate(`document.querySelector('[data-tool-button="${name}"]').getAttribute('aria-expanded')!=='true'`)) await press(`[data-tool-button="${name}"]`);
    }
    async function screenshot(name) {
      const capture = await call('Page.captureScreenshot', { format: 'png' });
      const path = resolve(artifacts, name);
      await writeFile(path, Buffer.from(capture.data, 'base64'));
      return path;
    }
    const plane = () => evaluate('sliceSweepChecks.plane()');
    const visible = () => evaluate('sliceSweepChecks.visibleCount()');
    const order = async () => {
      const { position } = await plane();
      const value = position / spacing;
      assert.ok(Math.abs(value - Math.round(value)) < 1e-6, `plane ${position} Å lies on a (111) atomic plane`);
      return Math.round(value);
    };

    await inputFiles('#file-input', ['fcc-sweep.xyz']);
    await waitFor(`document.getElementById('file-name').textContent==='fcc-sweep.xyz' && document.getElementById('loading').hidden && sliceSweepChecks.renderer?.atomCount===${atoms.length}`, 'load FCC fixture');
    await showTool('slice');
    await press('#add-slice');
    await type('#slice-offset', '5');
    for (const index of ['h', 'k', 'l']) await type(`#slice-miller-${index}`, '3');
    assert.equal(await evaluate('document.getElementById("slice-miller-result").textContent'),
      `n = (0.57735, 0.57735, 0.57735) · d = ${Number(spacing.toPrecision(6))} Å`);
    await press('#slice-apply-miller');
    let current = await plane();
    for (const component of current.normal) assert.ok(Math.abs(component - 1 / Math.sqrt(3)) < 1e-12, 'the (3 3 3) cell normal is the crystal [111]');
    assert.ok(Math.abs(current.step - spacing) < 1e-12 && Math.abs(current.thickness - spacing) < 1e-12, 'step and slab thickness default to d₁₁₁');
    assert.deepEqual(current.miller, [3, 3, 3]);
    let m = await order();
    assert.equal(m, 4, 'the plane moves to the (111) plane nearest its previous center');
    assert.equal(await visible(), count(plane => plane <= m), 'negative side keeps n · r ≤ d');
    const keptAt4 = await visible();

    await press('#slice-step-forward');
    assert.equal(await order(), m + 1, 'one pointer press moves one step');
    assert.equal(await visible(), count(plane => plane <= m + 1));
    await key('#slice-step-back', 'Enter');
    assert.equal(await order(), m, 'keyboard activation steps once');
    await key('#slice-offset', 'ArrowUp');
    assert.equal(await order(), m + 1, 'Arrow Up in the position field moves one step');
    await key('#slice-offset', 'ArrowDown');
    await press('#slice-step-forward', { holdMs: 900 });
    const held = await order();
    assert.ok(held - m >= 3, `holding repeats the step (${held - m} steps)`);
    for (let step = held; step > m; step -= 1) await key('#slice-offset', 'ArrowDown');
    assert.equal(await order(), m);
    assert.equal(await visible(), keptAt4, 'stepping back restores the same kept atoms');

    await press('#slice-flip');
    current = await plane();
    assert.equal(current.side, 'positive');
    assert.equal(await evaluate('document.getElementById("slice-side").value'), 'positive');
    assert.equal(await visible(), count(plane => plane >= m), 'flip keeps n · r ≥ d, including the atoms on the plane');
    await press('#slice-slab');
    current = await plane();
    assert.equal(current.slab, true);
    assert.equal(await evaluate('document.getElementById("slice-side").disabled && document.getElementById("slice-flip").disabled'), true);
    assert.equal(await visible(), count(plane => plane === m), 'a slab one spacing thick keeps exactly one (111) plane');
    await press('#slice-step-back');
    assert.equal(await visible(), count(plane => plane === m - 1), 'stepping a slab sweeps plane by plane');
    await type('#slice-thickness', String(spacing * 3));
    assert.equal(await visible(), count(plane => Math.abs(plane - (m - 1)) <= 1), 'thickness 3d keeps three planes');
    await type('#slice-thickness', String(spacing));
    assert.equal(await evaluate('sliceSweepChecks.uniformVisibleCount()'), count(plane => plane === m - 1),
      'the shader half-space uniforms keep the same slab as picking');

    // Outlines persist outside the slice tool and follow the export choice.
    await press('#slice-show-outlines');
    assert.equal(await evaluate('sliceSweepChecks.renderer.sliceOutlinesVisible'), true);
    await showTool('display');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("svg.slice-gizmo")).display'), 'none', 'editing overlay hides with the tool');
    const withOutline = await evaluate('sliceSweepChecks.exportPng(true)');
    const outlinePng = resolve(artifacts, 'slice-outline-export.png');
    await writeFile(outlinePng, Buffer.from(withOutline.data, 'base64'));
    const background = await evaluate('document.getElementById("background").value');
    const setBackground = value => evaluate(`(() => {const field=document.getElementById('background');field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await setBackground('#000000');
    const dark = await evaluate('sliceSweepChecks.compareCapture()');
    assert.ok(dark.changed > 50, `the cut outline draws outside the slice tool (${dark.changed} pixels)`);
    assert.ok(dark.green > dark.red + 40 && dark.blue > dark.red + 30, `outlines use the accent cyan on black: ${JSON.stringify(dark)}`);
    await setBackground('#ffffff');
    const light = await evaluate('sliceSweepChecks.compareCapture()');
    assert.ok(light.changed > 50 && light.green > light.red + 20 && light.green < dark.green && light.red < dark.red,
      `outlines use a deeper teal on white: ${JSON.stringify(light)}`);
    assert.ok(await evaluate('sliceSweepChecks.renderer.sliceOutlineColor[1] < 0.6'), 'a light background selects the dark outline color');
    await setBackground(background);
    await showTool('slice');
    await press('#slice-export-outlines');
    const withoutOutline = await evaluate('sliceSweepChecks.exportPng(false)');
    assert.ok(withoutOutline.changedPixels > 50, 'unchecking the export option removes the outline from PNG export');
    await press('#slice-export-outlines');
    assert.equal((await evaluate('sliceSweepChecks.exportPng(false)')).changedPixels, 0, 'the export option restores the outline');
    await setBackground('#000000');
    await press('#slice-export-outlines');
    const panelScreenshot = await screenshot('slice-sweep-panel.png');

    // Recipes keep every new option; a recipe without them restores a half-space.
    const recipe = await evaluate('sliceSweepChecks.exportRecipe()');
    const saved = recipe.settings.slices;
    assert.deepEqual([saved.showOutlines, saved.exportOutlines], [true, false]);
    assert.deepEqual({ slab: saved.items[0].slab, miller: saved.items[0].miller, side: saved.items[0].side },
      { slab: true, miller: [3, 3, 3], side: 'positive' });
    assert.ok(Math.abs(saved.items[0].step - spacing) < 1e-12 && Math.abs(saved.items[0].thickness - spacing) < 1e-12);
    async function restore(value) {
      await writeFile(resolve(temporary, 'slice-recipe.json'), JSON.stringify(value));
      await inputFiles('#configuration-file', ['slice-recipe.json']);
      await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'configuration restore');
      await delay(100);
    }
    await inputFiles('#file-input', ['fcc-sweep.xyz']);
    await waitFor(`document.getElementById('loading').hidden && sliceSweepChecks.renderer?.atomCount===${atoms.length} && sliceSweepChecks.renderer.slices.length===0`, 'reload resets slices');
    await restore(recipe);
    current = await plane();
    assert.deepEqual({ slab: current.slab, miller: current.miller, outlines: await evaluate('sliceSweepChecks.renderer.sliceOutlinesVisible') },
      { slab: true, miller: [3, 3, 3], outlines: true });
    assert.equal(await visible(), count(plane => plane === m - 1), 'the restored slab keeps the same plane');
    assert.equal(await evaluate('document.getElementById("slice-export-outlines").checked'), false);
    const legacy = structuredClone(recipe);
    for (const item of legacy.settings.slices.items) for (const field of ['slab', 'thickness', 'step', 'miller']) delete item[field];
    delete legacy.settings.slices.showOutlines;
    delete legacy.settings.slices.exportOutlines;
    await restore(legacy);
    current = await plane();
    assert.deepEqual({ slab: current.slab, step: current.step, miller: current.miller, outlines: await evaluate('sliceSweepChecks.renderer.sliceOutlinesVisible') },
      { slab: false, step: 1, miller: null, outlines: false });
    assert.equal(await visible(), count(plane => plane >= m - 1), 'an older recipe restores the same half-space');

    // A compact phone fits every new control in the tools pane, and a tap steps once.
    mobile = true;
    await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 1, mobile });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await delay(150);
    await showTool('slice');
    const overflow = await evaluate(`(() => {
      const pane = document.getElementById('tool-slice'), bounds = pane.getBoundingClientRect();
      const ids = ['slice-miller-h', 'slice-miller-l', 'slice-apply-miller', 'slice-step-back', 'slice-step', 'slice-step-forward',
        'slice-flip', 'slice-slab', 'slice-thickness', 'slice-show-outlines', 'slice-export-outlines'];
      return { scroll: pane.scrollWidth - pane.clientWidth, outside: ids.map(id => ({ id, box: document.getElementById(id).getBoundingClientRect() }))
        .filter(({ box }) => box.width <= 0 || box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5).map(({ id }) => id) };
    })()`);
    assert.deepEqual(overflow, { scroll: 0, outside: [] }, 'slice controls fit a 360 px phone');
    const beforeTap = (await plane()).position, target = await point('#slice-step-forward');
    const touchStarted = Date.now();
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: target.x, y: target.y }] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const touchMs = Date.now() - touchStarted;
    await delay(45);
    const tapped = (await plane()).position - beforeTap;
    // A slow automation round trip can outlast the 0.4 s repeat delay.
    if (touchMs < 350) assert.ok(Math.abs(tapped - 1) < 1e-12, `a touch tap moves exactly one step (moved ${tapped} Å)`);
    else assert.ok(tapped >= 1 && Math.abs(tapped - Math.round(tapped)) < 1e-12, `a ${touchMs} ms touch moves whole steps`);
    const phoneScreenshot = await screenshot('slice-sweep-phone.png');
    return { atoms: atoms.length, spacing, keptAtPlane4: keptAt4, heldSteps: held - m, outlinePixels: { dark, light },
      checks: ['Miller (3 3 3) normal and d-spacing', 'pointer, held and keyboard stepping', 'flip', 'slab sweep (picking test and shader uniforms)',
        'persistent cut outlines', 'outline PNG export option', 'light-background outline color', 'recipe round trip and older recipe', '360 px phone layout and touch step'],
      pngPixels: withOutline.pixels, pixelsWithoutOutline: withoutOutline.changedPixels, screenshots: { panelScreenshot, outlinePng, phoneScreenshot } };
  }, { software: true, requireGpu: false });
  const reportPath = resolve(artifacts, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Slice sweep browser regression passed. Report: ${reportPath}`);
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
  const checks = window.sliceSweepChecks = {};
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) { if (this.canvas.id === 'viewport') checks.renderer = this; return setFrame.apply(this, args); };
  checks.plane = async () => (await checks.exportRecipe()).settings.slices.items[0];
  checks.visibleCount = () => Array.from({ length: checks.renderer.atomCount }, (_, atom) => checks.renderer.isAtomVisible(atom)).filter(Boolean).length;
  // Every shader tests the uploaded half-spaces in single precision; apply
  // the same test to the uploaded values.
  checks.uniformVisibleCount = () => {
    const r = checks.renderer, values = r.slicePlaneValues;
    let kept = 0;
    for (let atom = 0; atom < r.atomCount; atom += 1) {
      const p = [0, 1, 2].map(axis => Math.fround(r.displayPositions[atom * 3 + axis]));
      let shown = true;
      for (let plane = 0; plane < r.sliceCount; plane += 1) {
        const distance = Math.fround(Math.fround(values[plane * 4] * p[0]) + Math.fround(values[plane * 4 + 1] * p[1]) + Math.fround(values[plane * 4 + 2] * p[2]));
        if (distance > Math.fround(values[plane * 4 + 3] + 1e-5)) { shown = false; break; }
      }
      kept += shown;
    }
    return kept;
  };
  checks.exportRecipe = async () => {
    const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click; let blob;
    URL.createObjectURL = function(value) { blob = value; return createUrl.call(this, value); };
    HTMLAnchorElement.prototype.click = () => {};
    try { document.getElementById('export-configuration').click(); if (!blob) throw new Error('Configuration export produced no Blob.'); return JSON.parse(await blob.text()); }
    finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
  const pixelsOf = async source => {
    const bitmap = await createImageBitmap(source), canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  checks.exportPng = async saveReference => {
    const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    let resolveBlob; const received = new Promise(resolve => { resolveBlob = resolve; });
    URL.createObjectURL = function(blob) { if (blob.type === 'image/png') resolveBlob(blob); return createUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = () => {};
    try {
      document.getElementById('export-png').click();
      const blob = await received, pixels = await pixelsOf(blob);
      let changedPixels = 0;
      if (saveReference) checks.pngReference = pixels;
      else if (pixels.length !== checks.pngReference.length) throw new Error('The PNG size changed.');
      else for (let offset = 0; offset < pixels.length; offset += 4) {
        if ([0, 1, 2, 3].some(channel => pixels[offset + channel] !== checks.pngReference[offset + channel])) changedPixels++;
      }
      const data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
      return { pixels: pixels.length / 4, changedPixels, data };
    } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
  // Mean color of the pixels the outline adds to the current view.
  checks.compareCapture = async () => {
    const r = checks.renderer;
    const shown = await pixelsOf(r.captureImage({ includeSliceOutlines: true }));
    const hidden = await pixelsOf(r.captureImage({ includeSliceOutlines: false }));
    let changed = 0; const sum = [0, 0, 0];
    for (let offset = 0; offset < shown.length; offset += 4) {
      if ([0, 1, 2].every(channel => shown[offset + channel] === hidden[offset + channel])) continue;
      changed++;
      for (let channel = 0; channel < 3; channel += 1) sum[channel] += shown[offset + channel];
    }
    const [red, green, blue] = sum.map(value => changed ? value / changed : 0);
    return { changed, red, green, blue };
  };
}
