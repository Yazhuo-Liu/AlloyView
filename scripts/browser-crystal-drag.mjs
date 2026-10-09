import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Production DOM with real mouse, keyboard and touch input: dragging the
// crystal through periodic boundaries previews in the shaders without buffer
// uploads, and the release rebuilds bonds, Voronoi cells, DXA lines and the
// second view exactly as typing the same origin does.
// `--performance` adds hardware-GPU frame timings on the 60,229-atom Fe loop,
// also with a 2 × 2 × 2 display (481,832 atoms).
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-crystal-drag-fixtures-'));
const artifacts = resolve(tmpdir(), 'alloyview-crystal-drag');
await mkdir(artifacts, { recursive: true });
const performanceRun = process.argv.includes('--performance');
const example = resolve(root, 'examples/Fe_disloc_loop.dump');

// A tilted BCC-like crystal: all three cell vectors are skewed.
const repeat = 4, lattice = 2.87;
const vectors = [[repeat * lattice, 0, 0], [1.9, repeat * lattice, 0], [-1.3, 1.1, repeat * lattice]];
const atoms = [];
for (let i = 0; i < repeat; i++) for (let j = 0; j < repeat; j++) for (let k = 0; k < repeat; k++) {
  for (const site of [[0, 0, 0], [.5, .5, .5]]) {
    const f = [(i + site[0]) / repeat, (j + site[1]) / repeat, (k + site[2]) / repeat];
    atoms.push([0, 1, 2].map(axis => f[0] * vectors[0][axis] + f[1] * vectors[1][axis] + f[2] * vectors[2][axis]));
  }
}
function xyz(pbc) {
  return [String(atoms.length), `Lattice="${vectors.flat().join(' ')}" Properties=species:S:1:pos:R:3:id:I:1 pbc="${pbc}"`,
    ...atoms.map((position, index) => `Fe ${position.join(' ')} ${index + 1}`), ''].join('\n');
}
await writeFile(resolve(temporary, 'tilted-bcc.xyz'), xyz('T T T'));
await writeFile(resolve(temporary, 'tilted-slab.xyz'), xyz('T T F'));

async function session(run, options) {
  return withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    async function waitFor(expression, label, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(35);
      }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({file:document.getElementById("file-name")?.textContent,dxa:document.getElementById("dxa-state")?.textContent,voronoi:document.getElementById("voronoi-state")?.textContent,toast:document.getElementById("toast")?.textContent})')}`);
    }
    // A fresh page drops analyses enabled by earlier phases.
    async function open() {
      await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html?run=${Math.random()}` });
      await delay(200);
      await waitFor('document.readyState === "complete" && document.getElementById("toggle-crystal-drag") && !window.crystalChecks', 'production page');
      await evaluate(`(${initializeChecks.toString()})()`);
      await evaluate('if (document.getElementById("enable-gpu-computing").getAttribute("aria-pressed") === "true") document.getElementById("enable-gpu-computing").click()');
    }
    await open();
    let mobile = false;
    const helpers = {
      call, evaluate, waitFor, open,
      setMobile(value) { mobile = value; },
      frames: (count = 2) => evaluate(`new Promise(resolve => { let left = ${count}; const step = () => --left ? requestAnimationFrame(step) : resolve(); requestAnimationFrame(step); })`),
      async inputFiles(selector, paths) {
        const { root: document } = await call('DOM.getDocument');
        const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector });
        await call('DOM.setFileInputFiles', { nodeId, files: paths });
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
      },
      async load(path, name, count) {
        await helpers.inputFiles('#file-input', [path]);
        await waitFor(`document.getElementById('file-name').textContent===${JSON.stringify(name)} && document.getElementById('loading').hidden && crystalChecks.renderer?.atomCount===${count} && !document.getElementById('origin-drag-mode').disabled`, `load ${name}`);
      },
      async point(selector) {
        const target = await evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing control '+${JSON.stringify(selector)});element.scrollIntoView({block:'nearest',inline:'nearest'});const box=element.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2,hit=document.elementFromPoint(x,y);return{x,y,enabled:!element.disabled,reachable:element===hit||element.contains(hit)||hit?.control===element,hit:hit?.id||hit?.tagName};})()`);
        assert.ok(target.enabled && target.reachable, `${selector} is reachable: ${JSON.stringify(target)}`);
        return target;
      },
      async press(selector) {
        const { x, y } = await helpers.point(selector);
        if (mobile) {
          await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
          await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
          await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        }
        await delay(45);
      },
      async showTool(name) {
        const category = await evaluate(`document.querySelector('[data-tool-button="${name}"]').closest('[data-tool-category-panel]').dataset.toolCategoryPanel`);
        if (await evaluate(`document.getElementById('tool-category-${category}').getAttribute('aria-selected')!=='true'`)) await helpers.press(`#tool-category-${category}`);
        if (await evaluate(`document.querySelector('[data-tool-button="${name}"]').getAttribute('aria-expanded')!=='true'`)) await helpers.press(`[data-tool-button="${name}"]`);
      },
      async expand(selector) { if (await evaluate(`!document.querySelector(${JSON.stringify(selector)}).open`)) await helpers.press(`${selector} > summary`); },
      async key(key, { shift = false } = {}) {
        const named = { Escape: { code: 'Escape', keyCode: 27 } }[key];
        const code = named?.code ?? `Key${key.toUpperCase()}`, keyCode = named?.keyCode ?? key.toUpperCase().charCodeAt(0);
        const text = named ? undefined : shift ? key.toUpperCase() : key;
        const modifiers = shift ? 8 : 0, value = shift && !named ? key.toUpperCase() : key;
        await call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: value, code, text, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
        await call('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
        await delay(40);
      },
      async type(selector, value) {
        await evaluate(`(() => {const field=document.querySelector(${JSON.stringify(selector)});field.scrollIntoView({block:'nearest'});field.focus();field.select();})()`);
        await call('Input.insertText', { text: value });
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
        await delay(40);
      },
      /** A pointer drag through `points`; `during` runs before the release. */
      async drag(points, { modifiers = 0, during = null, release = true } = {}) {
        const [first] = points;
        if (mobile) await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...first }] });
        else {
          await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first, modifiers });
          await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...first, button: 'left', buttons: 1, clickCount: 1, modifiers });
        }
        for (const point of points.slice(1)) {
          if (mobile) await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, ...point }] });
          else await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1, modifiers });
          await helpers.frames(1);
        }
        await helpers.frames(2);
        const result = during ? await during() : null;
        if (release) {
          const last = points.at(-1);
          if (mobile) await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          else await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...last, button: 'left', buttons: 0, clickCount: 1, modifiers });
          await helpers.frames(2);
        }
        return result;
      },
      async screenshot(name) {
        const capture = await call('Page.captureScreenshot', { format: 'png' });
        const path = resolve(artifacts, name);
        await writeFile(path, Buffer.from(capture.data, 'base64'));
        return path;
      },
      path: points => points,
    };
    return run(helpers);
  }, options);
}

const started = Date.now();
const progress = label => console.log(`[${((Date.now() - started) / 1000).toFixed(1)} s] ${label}`);
const line = (start, dx, dy, steps = 8) => Array.from({ length: steps + 1 }, (_, step) => ({ x: start.x + dx * step / steps, y: start.y + dy * step / steps }));

try {
  const report = await session(async h => {
    const { evaluate, waitFor } = h;
    const result = {};
    progress('page ready');
    await h.load(resolve(temporary, 'tilted-bcc.xyz'), 'tilted-bcc.xyz', atoms.length);
    progress('tilted fixture loaded');
    await h.showTool('bonds');
    await h.press('#run-bonds');
    await waitFor('document.getElementById("bonds-state").textContent==="Calculated" && crystalChecks.renderer.atomBonds?.count > 0', 'bonds');
    await evaluate('crystalChecks.addArrows()');
    await h.showTool('display');
    await h.expand('.periodic-origin-controls');
    const center = await evaluate('crystalChecks.canvasPoint()');

    progress('The toolbar toggle makes a plain left drag move the crystal.');
    // The toolbar toggle makes a plain left drag move the crystal.
    assert.equal(await evaluate('getComputedStyle(document.getElementById("toggle-crystal-drag")).display'), 'grid');
    await h.press('#toggle-crystal-drag');
    assert.deepEqual(await evaluate('["toggle-crystal-drag","origin-drag-mode"].map(id => document.getElementById(id).getAttribute("aria-pressed"))'), ['true', 'true']);
    const camera = await evaluate('crystalChecks.camera()');
    await evaluate('crystalChecks.resetUploads()');
    const preview = await h.drag(line(center, 96, -41), { during: async () => {
      await h.frames(2);
      return evaluate('crystalChecks.duringDrag()');
    } });
    assert.ok(preview.dragging, `the drag previews: ${JSON.stringify(preview)}`);
    assert.equal(preview.uploads, 0, 'pointer moves upload no buffers or textures');
    assert.match(preview.status, /^Origin a \d\.\d{4} · b \d\.\d{4} · c \d\.\d{4} — release to apply/);
    assert.deepEqual(preview.inputs, ['0', '0', '0'], 'origin fields change on release');
    assert.ok(preview.renderedWhileDragging >= 2, 'frames were drawn while dragging');
    const dragged = await evaluate('crystalChecks.snapshot()');
    assert.notDeepEqual(dragged.origin, [0, 0, 0]);
    assert.deepEqual(dragged.inputs, dragged.origin.map(String), 'origin fields show the committed origin');
    assert.ok(dragged.uploads > 0, 'release uploads the rebuilt display');
    assert.equal(dragged.dragging, false);
    assert.deepEqual(await evaluate('crystalChecks.camera()'), camera, 'moving the crystal does not move the camera');
    assert.ok(dragged.pixelDifference.foreground > 10_000 && dragged.pixelDifference.differing / dragged.pixelDifference.foreground < 0.002,
      `the preview frame matches the committed frame: ${JSON.stringify(dragged.pixelDifference)}`);
    // Typing the same origin reproduces the committed state exactly.
    await h.press('#origin-reset');
    assert.deepEqual((await evaluate('crystalChecks.snapshot()')).origin, [0, 0, 0], 'Reset origin undoes the drag');
    for (const [index, axis] of ['a', 'b', 'c'].entries()) await h.type(`#display-origin-${axis}`, String(dragged.origin[index]));
    const typed = await evaluate('crystalChecks.snapshot()');
    for (const key of ['origin', 'positions', 'fractional', 'bondShifts']) assert.deepEqual(typed[key], dragged[key], `${key} equals the typed-origin state`);
    result.desktopDrag = { origin: dragged.origin, pixelDifference: dragged.pixelDifference, uploadsDuringDrag: preview.uploads };

    progress('Escape cancels and restores; release after Escape commits nothing.');
    // Escape cancels and restores; release after Escape commits nothing.
    const before = await evaluate('crystalChecks.snapshot()');
    const cancelled = await h.drag(line(center, -70, 55), { during: async () => {
      const active = await evaluate('crystalChecks.duringDrag()');
      await h.key('Escape'); await h.frames(2);
      return { active, after: await evaluate('crystalChecks.duringDrag()') };
    } });
    assert.ok(cancelled.active.dragging); assert.equal(cancelled.after.dragging, false);
    assert.equal(cancelled.after.statusHidden, true);
    const afterEscape = await evaluate('crystalChecks.snapshot()');
    for (const key of ['origin', 'inputs', 'positions']) assert.deepEqual(afterEscape[key], before[key], `Escape restores ${key}`);

    progress('Tap still selects in the mode; Alt-drag works without it; keys nudge.');
    // Tap still selects in the mode; Alt-drag works without it; keys nudge.
    await h.press('#toggle-crystal-drag');
    assert.equal(await evaluate('document.getElementById("toggle-crystal-drag").getAttribute("aria-pressed")'), 'false');
    await h.drag(line(center, 40, 0));
    assert.deepEqual((await evaluate('crystalChecks.snapshot()')).origin, before.origin, 'without the mode a drag orbits');
    assert.notDeepEqual(await evaluate('crystalChecks.camera()'), camera);
    await h.drag(line(center, 0, 60), { modifiers: 1 });
    const altOrigin = (await evaluate('crystalChecks.snapshot()')).origin;
    assert.notDeepEqual(altOrigin, before.origin, 'Alt-drag moves the crystal without the mode');
    await evaluate('document.getElementById("viewport").focus()');
    await h.key('x');
    const nudged = (await evaluate('crystalChecks.snapshot()')).origin;
    assert.ok(Math.abs(((altOrigin[0] - nudged[0] + 1) % 1) - .05) < 1e-12, `X moves the crystal +a by 0.05: ${altOrigin} → ${nudged}`);
    await h.key('z', { shift: true });
    const nudgedBack = (await evaluate('crystalChecks.snapshot()')).origin;
    assert.ok(Math.abs(((nudgedBack[2] - nudged[2] + 1) % 1) - .05) < 1e-12, 'Shift+Z moves the crystal −c');
    await h.key('m');
    assert.equal(await evaluate('document.getElementById("origin-drag-mode").getAttribute("aria-pressed")'), 'true', 'M toggles the mode');
    await h.key('m');

    progress('Voronoi cells, the second view and DXA follow the committed origin.');
    // Voronoi cells, the second view and DXA follow the committed origin.
    await h.showTool('voronoi');
    await h.press('#run-voronoi');
    await waitFor('document.getElementById("voronoi-state").textContent==="Calculated"', 'Voronoi');
    await h.expand('#voronoi-cell-display');
    await evaluate('(() => {const field=document.getElementById("show-all-voronoi-cells");field.checked=true;field.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await waitFor('crystalChecks.renderer.voronoiAllCellGeometry?.complete', 'all Voronoi cells');
    await h.showTool('display');
    await evaluate('(() => {const field=document.getElementById("compare-view");field.checked=true;field.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await waitFor('crystalChecks.comparison?.frame', 'second view');
    await h.frames(3);
    const free = await evaluate('crystalChecks.canvasPoint({ avoidComparison: true })');
    await h.press('#toggle-crystal-drag');
    const voronoiBefore = await evaluate('crystalChecks.layers()');
    const layered = await h.drag(line(free, -60, 30), { during: () => evaluate('crystalChecks.layers()') });
    assert.ok(layered.comparisonDragging, 'the second view previews the same shift');
    assert.equal(layered.voronoiDraws, voronoiBefore.voronoiDraws, 'Voronoi cells are hidden while dragging');
    const voronoiAfter = await evaluate('crystalChecks.layers()');
    assert.ok(voronoiAfter.voronoiDraws > voronoiBefore.voronoiDraws, 'Voronoi cells reappear after release');
    assert.equal(voronoiAfter.voronoiPositionsCurrent, true, 'all-cell positions were refreshed for the committed origin');
    assert.notEqual(voronoiAfter.voronoiRevision, voronoiBefore.voronoiRevision);
    assert.equal(voronoiAfter.comparisonDragging, false);
    assert.equal(voronoiAfter.comparisonMatches, true, 'the second view rebuilt the same display');
    result.layers = { voronoiBefore, voronoiAfter };
    await h.press('#toggle-crystal-drag');
    await evaluate('(() => {const field=document.getElementById("compare-view");field.checked=false;field.dispatchEvent(new Event("change",{bubbles:true}));})()');

    progress('An open c axis neither moves nor accepts an origin.');
    // An open c axis neither moves nor accepts an origin.
    await h.load(resolve(temporary, 'tilted-slab.xyz'), 'tilted-slab.xyz', atoms.length);
    await h.expand('.periodic-origin-controls');
    await h.drag(line(await evaluate('crystalChecks.canvasPoint()'), 70, 70), { modifiers: 1 });
    const slab = await evaluate('crystalChecks.snapshot()');
    assert.equal(slab.origin[2], 0); assert.ok(slab.origin[0] !== 0 || slab.origin[1] !== 0);
    assert.equal(await evaluate('document.getElementById("display-origin-c").disabled'), true);

    progress('DXA lines on the 60,229-atom Fe loop');
    // DXA lines on the 60,229-atom Fe loop: translated and clipped while
    // dragging, rebuilt on release exactly as for the typed origin.
    await h.open();
    await h.load(example, 'Fe_disloc_loop.dump', 60229);
    progress('Fe loop loaded');
    await h.showTool('dxa');
    await evaluate('(() => {const field=document.getElementById("dxa-lattice");field.value="bcc";field.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await h.press('#run-dxa');
    await waitFor('document.getElementById("dxa-state").textContent==="Calculated" && crystalChecks.renderer.dislocationLayer?.count > 0', 'DXA', 300_000);
    progress('DXA calculated');
    await h.showTool('display');
    await h.expand('.periodic-origin-controls');
    // Lines only, so the preview/commit image comparison measures the lines.
    await evaluate(`(document.querySelector('[data-legend-action="unselect-all"]') ?? document.querySelector('[data-crystal-action="unselect-all"]')).click()`);
    await waitFor('crystalChecks.renderer.visibility.every(value => value === 0)', 'hide all atoms');
    const dxaBefore = await evaluate('crystalChecks.snapshot({ dxa: true })');
    progress('atoms hidden');
    await evaluate('crystalChecks.resetUploads()');
    const dxaPreview = await h.drag(line(await evaluate('crystalChecks.canvasPoint()'), 120, 35), { modifiers: 1,
      during: () => evaluate('crystalChecks.duringDrag()') });
    progress('Fe loop dragged');
    assert.ok(dxaPreview.dragging); assert.equal(dxaPreview.uploads, 0, 'no uploads while dragging 60,229 atoms');
    assert.ok(dxaPreview.dislocationDraws > dxaBefore.dislocationDraws, 'DXA lines are previewed while dragging');
    const dxaDragged = await evaluate('crystalChecks.snapshot({ dxa: true })');
    assert.notEqual(dxaDragged.dxa, dxaBefore.dxa, 'DXA lines were rebuilt for the new origin');
    const lines = dxaDragged.pixelDifference;
    assert.ok(lines.foreground > 1000 && lines.differing / lines.foreground < 0.05,
      `the clipped line preview matches the rebuilt lines: ${JSON.stringify(lines)}`);
    await h.press('#origin-reset');
    assert.equal((await evaluate('crystalChecks.snapshot({ dxa: true })')).dxa, dxaBefore.dxa, 'Reset origin restores the original lines');
    for (const [index, axis] of ['a', 'b', 'c'].entries()) await h.type(`#display-origin-${axis}`, String(dxaDragged.origin[index]));
    const dxaTyped = await evaluate('crystalChecks.snapshot({ dxa: true })');
    for (const key of ['origin', 'positions', 'fractional', 'dxa']) assert.deepEqual(dxaTyped[key], dxaDragged[key], `Fe loop ${key} equals the typed-origin state`);
    result.dxa = { origin: dxaDragged.origin, uploadsDuringDrag: dxaPreview.uploads, linePixels: lines, lineHash: dxaDragged.dxa.slice(0, 16) };
    result.desktopScreenshot = await h.screenshot('crystal-drag-desktop.png');

    progress('Phone layout and touch');
    // Phones: the toolbar keeps its footprint; the origin controls toggle the
    // mode and one finger drags the crystal.
    h.setMobile(true);
    await h.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await h.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await h.open();
    await h.load(resolve(temporary, 'tilted-bcc.xyz'), 'tilted-bcc.xyz', atoms.length);
    const layout = await evaluate(`(() => {
      const boxes = ['.view-toolbar', '#toggle-atom-details', '#toggle-view-controls'].map(selector => document.querySelector(selector).getBoundingClientRect());
      // The footprint without the desktop-only button, for comparison.
      const button = document.getElementById('toggle-crystal-drag'), next = button.nextSibling, toolbar = button.parentElement;
      button.remove(); const without = toolbar.getBoundingClientRect().width; toolbar.insertBefore(button, next);
      return { toolbarWidthChange: boxes[0].width - without, hidden: getComputedStyle(button).display === 'none',
        overlap: !boxes.every((box, index) => box.left >= 0 && box.right <= innerWidth && boxes.slice(index + 1).every(other => box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top)) };
    })()`);
    assert.deepEqual(layout, { toolbarWidthChange: 0, hidden: true, overlap: false }, 'phone toolbar layout is unchanged');
    await h.showTool('display');
    await h.expand('.periodic-origin-controls');
    await h.press('#origin-drag-mode');
    assert.equal(await evaluate('document.getElementById("origin-drag-mode").getAttribute("aria-pressed")'), 'true');
    const phoneCenter = await evaluate('crystalChecks.canvasPoint()');
    await evaluate('crystalChecks.resetUploads()');
    const touchPreview = await h.drag(line(phoneCenter, 60, -25), { during: async () => {
      const state = await evaluate('crystalChecks.duringDrag()');
      return { ...state, screenshot: await h.screenshot('crystal-drag-phone.png') };
    } });
    assert.ok(touchPreview.dragging, 'one finger drags the crystal'); assert.equal(touchPreview.uploads, 0);
    assert.equal(touchPreview.statusInsideCanvas, true, 'the drag status stays inside the phone viewport');
    assert.match(touchPreview.status, /release to apply$/, 'touch drags omit the Escape hint');
    assert.equal(touchPreview.statusClear, true, 'the drag status leaves the overlay toggles uncovered');
    const touched = await evaluate('crystalChecks.snapshot()');
    assert.notDeepEqual(touched.origin, [0, 0, 0], 'touch release commits the origin');
    const atom = await evaluate('crystalChecks.atomPoint()');
    await h.drag([atom]);
    assert.equal(await evaluate('crystalChecks.renderer.selected'), atom.index, 'a tap in the mode still selects the atom');
    assert.deepEqual((await evaluate('crystalChecks.snapshot()')).origin, touched.origin, 'a tap does not move the crystal');
    result.phone = { layout, origin: touched.origin, screenshot: touchPreview.screenshot };
    return result;
  }, { software: true, requireGpu: false });

  if (performanceRun) report.performance = await session(async h => {
    const { evaluate, waitFor } = h;
    await h.load(example, 'Fe_disloc_loop.dump', 60229);
    await h.showTool('display');
    const measure = async label => {
      await evaluate('crystalChecks.resetUploads()');
      const pointer = await h.drag(line(await evaluate('crystalChecks.canvasPoint()'), 160, 60, 40), { modifiers: 1,
        during: () => evaluate('crystalChecks.duringDrag()') });
      const timing = await evaluate('crystalChecks.timing()');
      return { label, displayedAtoms: await evaluate('crystalChecks.renderer.displayAtomCount'), uploadsDuringDrag: pointer.uploads,
        rafIntervalMs: pointer.frameIntervals, ...timing };
    };
    const rows = [await measure('atoms')];
    await h.showTool('bonds'); await h.press('#run-bonds');
    await waitFor('document.getElementById("bonds-state").textContent==="Calculated"', 'Fe bonds', 300_000);
    rows.push({ ...await measure('atoms + bonds'), bonds: await evaluate('crystalChecks.renderer.atomBonds.count') });
    await evaluate('(() => {const field=document.getElementById("show-bonds");field.checked=false;field.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await h.showTool('replicate');
    for (const axis of ['a', 'b', 'c']) await h.type(`#replicate-${axis}`, '2');
    await h.press('#apply-replicate');
    await waitFor('crystalChecks.renderer.displayAtomCount === 481832', 'replicated display');
    await h.showTool('display');
    rows.push(await measure('2 × 2 × 2 display'));
    return rows;
  }, { software: false, requireGpu: false });

  const reportPath = resolve(artifacts, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Crystal drag browser regression passed. Report: ${reportPath}`);
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
  const { AtomPrimitiveLayer } = await import(new URL('./render/atom-primitives.js', app));
  const { DislocationLayer } = await import(new URL('./render/dislocation-layer.js', app));
  const { VoronoiAllCellLayer } = await import(new URL('./render/voronoi-cell-layer.js', app));
  const checks = window.crystalChecks = { uploads: 0, renders: 0, dislocationDraws: 0, voronoiDraws: 0, bondShifts: null, frameTimes: [] };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this; else checks.comparison = this;
    return setFrame.apply(this, args);
  };
  const render = WebGLRenderer.prototype.render;
  WebGLRenderer.prototype.render = function(...args) {
    if (this === checks.renderer) {
      checks.renders++;
      const started = performance.now();
      const value = render.apply(this, args);
      if (this.crystalDrag) checks.frameTimes.push(performance.now() - started);
      return value;
    }
    return render.apply(this, args);
  };
  // Every way to upload buffer or texture data to the main view's context.
  for (const name of ['bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D']) {
    const original = WebGL2RenderingContext.prototype[name];
    WebGL2RenderingContext.prototype[name] = function(...args) {
      if (this.canvas?.id === 'viewport') checks.uploads++;
      return original.apply(this, args);
    };
  }
  const uploadShifts = AtomPrimitiveLayer.prototype.uploadShifts;
  AtomPrimitiveLayer.prototype.uploadShifts = function(buffers, shifts) {
    if (this === checks.renderer?.primitiveLayer && buffers === this.bondBuffers) checks.bondShifts = shifts;
    return uploadShifts.call(this, buffers, shifts);
  };
  const dislocationRender = DislocationLayer.prototype.render;
  DislocationLayer.prototype.render = function(renderer) { if (renderer === checks.renderer) checks.dislocationDraws++; return dislocationRender.call(this, renderer); };
  const voronoiRender = VoronoiAllCellLayer.prototype.render;
  VoronoiAllCellLayer.prototype.render = function(renderer) { if (renderer === checks.renderer) checks.voronoiDraws++; return voronoiRender.call(this, renderer); };
  const hash = async values => {
    if (!values) return null;
    const bytes = ArrayBuffer.isView(values) ? new Uint8Array(values.buffer, values.byteOffset, values.byteLength) : new TextEncoder().encode(values);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  };
  checks.resetUploads = () => { checks.uploads = 0; checks.renderStart = checks.renders; checks.frameTimes = []; checks.rafs = []; };
  checks.camera = () => { const r = checks.renderer; return { yaw: r.yaw, pitch: r.pitch, target: [...r.target], pan: [...r.pan], distance: r.distance }; };
  checks.canvasPoint = ({ avoidComparison = false } = {}) => {
    const box = checks.renderer.canvas.getBoundingClientRect();
    for (const [fx, fy] of avoidComparison ? [[.72, .55], [.8, .45], [.65, .7]] : [[.5, .5], [.55, .6], [.45, .4]]) {
      const x = box.left + box.width * fx, y = box.top + box.height * fy;
      if (document.elementFromPoint(x, y) === checks.renderer.canvas) return { x, y };
    }
    throw new Error('The viewport center is covered.');
  };
  checks.atomPoint = () => {
    const r = checks.renderer, box = r.canvas.getBoundingClientRect();
    r.updateMatrices();
    for (let atom = 0; atom < r.atomCount; atom++) {
      const [x, y, z] = r.displayPositions.subarray(atom * 3, atom * 3 + 3), m = r.viewProjectionMatrix;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      const point = { x: box.left + ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * .5 + .5) * box.width,
        y: box.top + (.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w * .5) * box.height };
      if (document.elementFromPoint(point.x, point.y) === r.canvas && r.pick(point.x, point.y) === atom) return { ...point, index: atom };
    }
    throw new Error('No atom is reachable.');
  };
  // Arbitrary per-atom arrows exercise the vector shader.
  checks.addArrows = () => {
    const r = checks.renderer, vectors = new Float32Array(r.atomCount * 3);
    for (let atom = 0; atom < r.atomCount; atom++) for (let axis = 0; axis < 3; axis++) vectors[atom * 3 + axis] = axis === 2 ? .9 : .4 * Math.sin(atom + axis);
    r.setVectorFields([{ id: 'crystal-drag-test', vectors, options: { color: '#f7a633', scale: 1 } }]);
  };
  const pixels = () => {
    const canvas = checks.renderer.captureImage({ includeBackground: true });
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  };
  checks.duringDrag = () => {
    const r = checks.renderer, status = document.getElementById('crystal-drag-status');
    checks.previewPixels = r.crystalDrag ? pixels() : null;
    const statusBox = status.getBoundingClientRect(), canvasBox = r.canvas.getBoundingClientRect();
    const intervals = (checks.rafs ?? []).slice(1).map((time, index) => time - checks.rafs[index]).sort((a, b) => a - b);
    return { dragging: Boolean(r.crystalDrag), uploads: checks.uploads, status: status.textContent, statusHidden: status.hidden,
      statusClear: ['#toggle-legend', '#toggle-atom-details', '#toggle-view-controls', '.view-toolbar'].map(selector => document.querySelector(selector)?.getBoundingClientRect())
        .filter(box => box?.width).every(box => box.right <= statusBox.left || statusBox.right <= box.left || box.bottom <= statusBox.top || statusBox.bottom <= box.top),
      statusInsideCanvas: statusBox.left >= canvasBox.left && statusBox.right <= canvasBox.right && statusBox.bottom <= canvasBox.bottom && statusBox.top >= canvasBox.top,
      inputs: ['a', 'b', 'c'].map(axis => document.getElementById(`display-origin-${axis}`).value),
      renderedWhileDragging: checks.renders - (checks.renderStart ?? 0), dislocationDraws: checks.dislocationDraws,
      frameIntervals: intervals.length ? { median: intervals[intervals.length >> 1], p90: intervals[Math.floor(intervals.length * .9)], count: intervals.length } : null };
  };
  (function frame(time) { if (checks.renderer?.crystalDrag) (checks.rafs ??= []).push(time); requestAnimationFrame(frame); })(performance.now());
  checks.snapshot = async ({ dxa = false } = {}) => {
    const r = checks.renderer;
    let pixelDifference = null;
    if (checks.previewPixels) {
      const committed = pixels(), preview = checks.previewPixels;
      let differing = 0, foreground = 0;
      for (let offset = 0; offset < committed.length; offset += 4) {
        if ([0, 1, 2].some(channel => Math.abs(committed[offset + channel] - preview[offset + channel]) > 24)) differing++;
        if ([0, 1, 2].some(channel => Math.abs(committed[offset + channel] - committed[channel]) > 24)) foreground++;
      }
      pixelDifference = { differing, foreground, total: committed.length / 4 };
      checks.previewPixels = null;
    }
    return { origin: [...r.periodicOrigin], inputs: ['a', 'b', 'c'].map(axis => document.getElementById(`display-origin-${axis}`).value),
      positions: await hash(Float64Array.from(r.displayPositions)), fractional: await hash(Float64Array.from(r.displayFractional)),
      bondShifts: await hash(checks.bondShifts), dragging: Boolean(r.crystalDrag), uploads: checks.uploads, pixelDifference,
      dislocationDraws: checks.dislocationDraws,
      dxa: dxa ? await hash(JSON.stringify(r.dislocationLayer.geometry.curves.map(curve => Array.from(curve.points)))) : null };
  };
  checks.layers = async () => {
    const r = checks.renderer, c = checks.comparison, layer = r.voronoiAllCellLayer;
    return { voronoiDraws: checks.voronoiDraws, voronoiRevision: r.voronoiDisplayRevision,
      voronoiPositionsCurrent: layer?.positions === r.displayPositions && layer.positionRevision === r.voronoiDisplayRevision,
      comparisonDragging: Boolean(c?.crystalDrag),
      comparisonMatches: Boolean(c) && await hash(Float64Array.from(c.displayPositions)) === await hash(Float64Array.from(r.displayPositions)) };
  };
  // Hardware timings: synchronous frames (draw + GPU finish) without a drag
  // and with a drag preview (uniforms only), against the typed-origin path
  // (CPU rebuild, uploads, draw).
  checks.timing = () => {
    const r = checks.renderer, gl = r.gl, pixel = new Uint8Array(4), median = values => values.sort((a, b) => a - b)[values.length >> 1];
    const finish = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const origin = [...r.periodicOrigin], still = [], preview = [], typed = [];
    for (let step = 0; step < 12; step++) {
      const started = performance.now();
      r.render(performance.now(), { trackStats: false }); finish();
      still.push(performance.now() - started);
    }
    for (let step = 0; step < 12; step++) {
      const started = performance.now();
      r.setCrystalDragShift([.013 * step, .007 * step, -.011 * step]);
      r.render(performance.now(), { trackStats: false }); finish();
      preview.push(performance.now() - started);
    }
    r.setCrystalDragShift(null);
    const field = document.getElementById('display-origin-a');
    for (let step = 0; step < 6; step++) {
      const started = performance.now();
      field.value = String(Math.round((origin[0] + .0137 * (step + 1)) * 1e4) / 1e4);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      r.render(performance.now(), { trackStats: false }); finish();
      typed.push(performance.now() - started);
    }
    return { staticFrameMs: median(still), previewFrameMs: median(preview), typedOriginMs: median(typed),
      renderDuringPointerDragMs: checks.frameTimes.length ? median([...checks.frameTimes]) : null };
  };
}
