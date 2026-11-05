import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fccScrewFrame } from '../../tests/helpers/dislocations.js';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

const root = resolve(import.meta.dirname, '../..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-dxa-vectors-fixture-'));
const artifacts = resolve(tmpdir(), 'alloyview-dxa-vectors');
await mkdir(artifacts, { recursive: true });
const screw = fccScrewFrame(), source = resolve(temporary, 'fcc-vector-screw.xyz');
await writeFile(source, [String(screw.ids.length),
  `Lattice="${Array.from(screw.cell.vectors).join(' ')}" Properties=species:S:1:pos:R:3:id:I:1 pbc="F F T"`,
  ...Array.from(screw.ids, (id, index) => `Ni ${Array.from(screw.positions.subarray(index * 3, index * 3 + 3)).join(' ')} ${id}`), ''].join('\n'));

const close = (actual, expected, tolerance = 1e-8) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance, `${actual} vs ${expected}`));
};
const vectorSizes = [
  { key: 'burgersVectorRadius', id: 'dxa-burgers-radius', initial: .84, value: 1.2, arrow: 'burgers', dimension: 'radius' },
  { key: 'burgersVectorScale', id: 'dxa-burgers-scale', initial: 2, value: 3, arrow: 'burgers', dimension: 'length' },
  { key: 'lineDirectionRadius', id: 'dxa-line-direction-radius', initial: .84, value: 1.1, arrow: 'line', dimension: 'radius' },
  { key: 'lineDirectionScale', id: 'dxa-line-direction-scale', initial: 1, value: 1.5, arrow: 'line', dimension: 'length' },
];
try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(40);
      }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({dxa:document.getElementById("dxa-status")?.textContent,toast:document.getElementById("toast")?.textContent,recipe:document.getElementById("configuration-status")?.textContent})')}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("dxa-show-burgers-vectors")', 'vector controls');
    await evaluate(`(${initializeChecks.toString()})()`);
    async function inputFile(selector, path) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function mousePoint(point, type, buttons = 0) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `finite mouse coordinates: ${JSON.stringify(point)}`);
      await call('Input.dispatchMouseEvent', { type, x: point.x, y: point.y,
        button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    async function clickPoint(point) {
      await mousePoint(point, 'mouseMoved'); await mousePoint(point, 'mousePressed', 1); await mousePoint(point, 'mouseReleased');
      await delay(50);
    }
    async function click(selector) {
      const point = await evaluate(`(() => {
        const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'});
        const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
        return {x,y,ready:!e.disabled&&(hit===e||e.contains(hit)||hit?.control===e)};
      })()`);
      assert.ok(point.ready, `${selector} must be clickable`); await clickPoint(point);
    }
    const object = () => evaluate('dxaVectorChecks.object()');
    const recipe = () => evaluate('dxaVectorChecks.exportRecipe()');
    async function change(id, value) {
      await evaluate(`(() => { const input=document.getElementById(${JSON.stringify(id)});
        input.value=${JSON.stringify(String(value))}; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    }
    await inputFile('#file-input', source);
    await waitFor('dxaVectorChecks.renderer?.frame && !document.getElementById("run-dxa").disabled', 'source import');
    const category = await evaluate('document.querySelector("[data-tool-button=dxa]").closest("[data-tool-category-panel]").dataset.toolCategoryPanel');
    if (await evaluate(`document.getElementById('tool-category-${category}').getAttribute('aria-selected')!=='true'`)) await click(`#tool-category-${category}`);
    await click('[data-tool-button=dxa]'); await click('#run-dxa');
    await waitFor('document.getElementById("dxa-state").textContent === "Calculated"', 'complete DXA');
    assert.equal(await evaluate('dxaVectorChecks.renderer.dislocationOptions.radius'), .75);
    assert.equal(await evaluate('document.getElementById("dxa-line-radius").value'), '0.75');
    for (const { key, id, initial } of vectorSizes) {
      assert.equal(await evaluate(`dxaVectorChecks.renderer.dislocationOptions.${key}`), initial);
      assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).value`), String(initial));
    }
    await evaluate('dxaVectorChecks.sourceScience=dxaVectorChecks.science(); dxaVectorChecks.renderer.setVisibility(new Uint8Array(dxaVectorChecks.renderer.atomCount)); dxaVectorChecks.renderer.setView("right")');
    await click('#dxa-show-line-directions');
    const lineIndices = await evaluate('dxaVectorChecks.renderer.dislocationLayer.vectorGeometry.indexCount');
    assert.ok(lineIndices > 0);
    await click('#dxa-show-burgers-vectors');
    await waitFor('document.querySelector("svg.dislocation-vector-gizmo .dxa-burgers-hit")', 'selectable Burgers arrow');
    assert.ok(await evaluate('dxaVectorChecks.renderer.dislocationLayer.vectorGeometry.indexCount') > lineIndices);
    const initial = await object(), camera = await evaluate('dxaVectorChecks.camera()');
    assert.equal(initial.position, .5);
    const arrowPoint = await evaluate('dxaVectorChecks.arrowPoint()');
    await clickPoint(arrowPoint);
    await waitFor('dxaVectorChecks.renderer.dislocationOptions.selectedVectorId !== null && !document.getElementById("dxa-vector-selection").hidden', 'arrow selection');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await evaluate('document.querySelector(".dxa-burgers-hit").getAttribute("aria-pressed")'), 'true');
    const handle = await evaluate('dxaVectorChecks.rootPoint()'), destination = await evaluate('dxaVectorChecks.pathPoint(.25)');
    const rootHit = await evaluate(`document.elementFromPoint(${handle.x},${handle.y})?.outerHTML`);
    assert.match(rootHit, /class="dxa-burgers-root"/, `selected root must receive the drag: ${rootHit}`);
    assert.match(rootHit, /data-vector-action="drag"/, 'selected root offers a drag gesture');
    assert.ok(Math.hypot(handle.x - destination.x, handle.y - destination.y) > 10, 'the drag has visible screen length');
    await mousePoint(handle, 'mouseMoved'); await mousePoint(handle, 'mousePressed', 1);
    for (let step = 1; step <= 6; step++) {
      await mousePoint({ x: handle.x + (destination.x - handle.x) * step / 6,
        y: handle.y + (destination.y - handle.y) * step / 6 }, 'mouseMoved', 1);
      await delay(20);
    }
    await mousePoint(destination, 'mouseReleased'); await delay(70);
    const moved = await object();
    assert.ok(Math.abs(moved.position - .25) < .04, `root should slide to curve fraction .25, got ${moved.position}`);
    assert.notDeepEqual(moved.root, initial.root);
    assert.equal(await evaluate('dxaVectorChecks.science() === dxaVectorChecks.sourceScience'), true);
    assert.deepEqual(await evaluate('dxaVectorChecks.camera()'), camera, 'arrow drag does not rotate or pan the camera');
    assert.equal(await evaluate('dxaVectorChecks.analyses'), 1, 'display interaction does not repeat DXA');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Alt', code: 'AltLeft', modifiers: 1, windowsVirtualKeyCode: 18 });
    assert.equal(await evaluate('document.querySelector("svg.dislocation-vector-gizmo").style.display'), 'none', 'Alt leaves the canvas available for crystal dragging');
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', modifiers: 0, windowsVirtualKeyCode: 18 });
    await waitFor('document.querySelector("svg.dislocation-vector-gizmo").style.display !== "none"', 'vector controls return after Alt');

    await evaluate('document.querySelector(".dxa-burgers-root").focus()');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 });
    await delay(50);
    const flipped = await object();
    assert.equal(flipped.flipped, true); close(flipped.burgers, moved.burgers.map(value => -value));
    close(flipped.tangent, moved.tangent.map(value => -value)); close(flipped.root, moved.root);
    close(flipped.lineStart, moved.lineEnd); close(flipped.lineEnd, moved.lineStart);
    await click('#dxa-vector-flip');
    const unflipped = await object();
    assert.equal(unflipped.flipped, false); close(unflipped.burgers, moved.burgers); close(unflipped.tangent, moved.tangent);
    await click('#dxa-vector-flip');
    assert.equal(await evaluate('dxaVectorChecks.science() === dxaVectorChecks.sourceScience'), true);
    const expectedSizes = Object.fromEntries(vectorSizes.map(({ key, initial }) => [key, initial]));
    const dimensionChecks = [];
    for (const { key, id, value, arrow, dimension } of vectorSizes) {
      const before = await evaluate('dxaVectorChecks.appearance()'), previousValue = expectedSizes[key];
      await change(id, value); expectedSizes[key] = value;
      const after = await evaluate('dxaVectorChecks.appearance()'), other = arrow === 'line' ? 'burgers' : 'line';
      assert.deepEqual(after.options, expectedSizes, `${id} updates only its corresponding option`);
      assert.deepEqual(after[other], before[other], `${id} leaves the other arrow geometry unchanged`);
      assert.notEqual(after[arrow].meshHash, before[arrow].meshHash, `${id} updates the drawn mesh`);
      close(after.root, before.root); close(after.lineCenter, before.lineCenter);
      close([after[arrow][dimension] / before[arrow][dimension]], [value / previousValue], 1e-4);
      const unchangedDimension = dimension === 'radius' ? 'length' : 'radius';
      close([after[arrow][unchangedDimension]], [before[arrow][unchangedDimension]], 1e-4);
      if (dimension === 'radius') assert.deepEqual(after.endpoints, before.endpoints, 'arrow thickness does not move either endpoint');
      await change(id, 0);
      assert.deepEqual(await evaluate('dxaVectorChecks.appearance()'), after, 'invalid size does not change the render');
      assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).value`), String(value));
      dimensionChecks.push({ control: id, dimension, ratio: after[arrow][dimension] / before[arrow][dimension] });
    }
    assert.equal(await evaluate('dxaVectorChecks.science() === dxaVectorChecks.sourceScience'), true);
    assert.equal(await evaluate('dxaVectorChecks.analyses'), 1, 'resizing arrows does not repeat DXA');
    assert.deepEqual(await evaluate('dxaVectorChecks.camera()'), camera, 'resizing arrows leaves the camera unchanged');
    const saved = await recipe(), settings = saved.settings.extensions.dxa;
    assert.equal(settings.showLineDirections, true); assert.equal(settings.showBurgersVectors, true);
    assert.equal(settings.vectorAnnotations.length, 1); assert.equal(settings.vectorAnnotations[0].flipped, true);
    assert.match(settings.vectorAnnotations[0].signature, /^[a-f0-9]{16}$/);
    for (const { key, value } of vectorSizes) assert.equal(settings[key], value);
    await writeFile(resolve(temporary, 'vectors-recipe.json'), JSON.stringify(saved));
    await click('#dxa-show-burgers-vectors');
    assert.equal(await evaluate('document.querySelector("svg.dislocation-vector-gizmo").style.display'), 'none');
    await inputFile('#configuration-file', resolve(temporary, 'vectors-recipe.json'));
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("dxa-state").textContent === "Calculated"', 'vector recipe restore');
    const restored = (await recipe()).settings.extensions.dxa;
    assert.deepEqual(restored.vectorAnnotations, settings.vectorAnnotations);
    assert.equal(restored.showLineDirections, true); assert.equal(restored.showBurgersVectors, true);
    for (const { key, id, value } of vectorSizes) {
      assert.equal(restored[key], value);
      assert.equal(await evaluate(`dxaVectorChecks.renderer.dislocationOptions.${key}`), value);
      assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).value`), String(value));
    }
    assert.equal(await evaluate('dxaVectorChecks.science() === dxaVectorChecks.sourceScience'), true);
    await evaluate('dxaVectorChecks.renderer.setVisibility(new Uint8Array(dxaVectorChecks.renderer.atomCount)); dxaVectorChecks.renderer.setCameraState({fieldWidth:40})');
    await delay(100);
    const exported = await evaluate('dxaVectorChecks.exportPixels()');
    assert.ok(exported.shown.yellow > 10, `yellow line arrows are drawn in the PNG: ${JSON.stringify(exported.shown)}`);
    assert.ok(exported.shown.cyan > 10, `cyan Burgers arrows are drawn in the PNG: ${JSON.stringify(exported.shown)}`);
    assert.ok(exported.shown.yellow > exported.hidden.yellow + 10, 'yellow line arrows add pixels beyond the unannotated network');
    assert.ok(exported.shown.cyan > exported.hidden.cyan + 10, 'cyan Burgers arrows add pixels beyond blue tube highlights');
    const exportedPng = resolve(artifacts, 'vectors-export.png');
    await writeFile(exportedPng, Buffer.from(exported.png.split(',')[1], 'base64'));
    const screenshot = resolve(artifacts, 'vectors.png');
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(screenshot, Buffer.from(capture.data, 'base64'));
    assert.equal(await evaluate('dxaVectorChecks.renderer.gl.getError()'), 0);
    return { atoms: screw.ids.length, initialPosition: initial.position, draggedPosition: moved.position,
      radius: .75, sourceUnchanged: true, cameraUnchanged: true, scientificRunsBeforeRestore: 1,
      simultaneousFlip: true, independentSizes: expectedSizes, dimensionChecks, recipeRestored: true, screenshot, exportedPng,
      exportPixels: { shown: exported.shown, hidden: exported.hidden } };
  }, { software: true, requireGpu: false, isolated: true });
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const [{ WebGLRenderer }, { DxaClient }, { transformPoint }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/dxa-client.js', app)), import(new URL('./render/math.js', app)),
  ]);
  const checks = window.dxaVectorChecks = { analyses: 0 }, setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) { if (this.canvas.id === 'viewport') checks.renderer = this; return setFrame.apply(this, args); };
  const analyze = DxaClient.prototype.analyze;
  DxaClient.prototype.analyze = function(frame, parameters, options = {}) {
    checks.analyses++;
    // Hold Delaunay tie choices stable for the configuration/signature check.
    return analyze.call(this, frame, parameters, { ...options, workerCount: 1 });
  };
  checks.object = () => {
    const object = checks.renderer.dislocationLayer.vectorGeometry.objects[0];
    return { segmentId: object.segmentId, position: object.position, flipped: object.flipped,
      root: object.root, tangent: object.tangent, burgers: object.burgers, lineStart: object.lineStart, lineEnd: object.lineEnd };
  };
  checks.appearance = () => {
    const r = checks.renderer, geometry = r.dislocationLayer.vectorGeometry, object = geometry.objects[0];
    if (geometry.objects.length !== 1) throw new Error('This geometry check expects the single screw dislocation fixture.');
    const from = { line: object.lineStart, burgers: object.root }, to = { line: object.lineEnd, burgers: object.burgersEnd };
    const arrows = Object.fromEntries(['line', 'burgers'].map(name => {
      const delta = to[name].map((value, axis) => value - from[name][axis]), length = Math.hypot(...delta);
      return [name, { length, radius: 0, meshHash: 2166136261, axis: delta.map(value => value / length) }];
    }));
    const { values } = geometry, words = new Uint32Array(values.buffer, values.byteOffset, values.length);
    for (let index = 0; index < values.length; index += 12) {
      const name = values[index + 9] > values[index + 10] ? 'line' : 'burgers', arrow = arrows[name];
      const delta = [0, 1, 2].map(axis => values[index + axis] + values[index + axis + 3] - from[name][axis]);
      const along = delta.reduce((sum, value, axis) => sum + value * arrow.axis[axis], 0);
      arrow.radius = Math.max(arrow.radius, Math.hypot(...delta.map((value, axis) => value - along * arrow.axis[axis])));
      for (let field = 0; field < 12; field++) arrow.meshHash = Math.imul(arrow.meshHash ^ words[index + field], 16777619) >>> 0;
    }
    for (const arrow of Object.values(arrows)) delete arrow.axis;
    return { ...arrows, root: object.root, endpoints: { line: [object.lineStart, object.lineEnd], burgers: [object.root, object.burgersEnd] },
      lineCenter: object.lineStart.map((value, axis) => (value + object.lineEnd[axis]) / 2),
      options: Object.fromEntries(['burgersVectorRadius', 'burgersVectorScale', 'lineDirectionRadius', 'lineDirectionScale']
        .map(key => [key, r.dislocationOptions[key]])) };
  };
  checks.science = () => JSON.stringify(checks.renderer.dislocationNetwork.segments.map(segment => ({
    id: segment.id, points: Array.from(segment.points), burgers: Array.from(segment.burgersVector),
    spatial: Array.from(segment.spatialBurgersVector), junctions: segment.junctions,
  })));
  checks.camera = () => {
    const r = checks.renderer;
    return { yaw: r.yaw, pitch: r.pitch, roll: r.roll, distance: r.distance, pan: Array.from(r.pan), target: Array.from(r.target) };
  };
  checks.arrowPoint = () => {
    const line = document.querySelector('.dxa-burgers-hit'), rect = line.closest('svg').getBoundingClientRect();
    const x1 = Number(line.getAttribute('x1')), x2 = Number(line.getAttribute('x2'));
    const y1 = Number(line.getAttribute('y1')), y2 = Number(line.getAttribute('y2'));
    return { x: rect.left + x1 * .3 + x2 * .7, y: rect.top + y1 * .3 + y2 * .7 };
  };
  checks.rootPoint = () => {
    const root = document.querySelector('.dxa-burgers-root'), rect = root.closest('svg').getBoundingClientRect();
    return { x: rect.left + Number(root.getAttribute('cx')), y: rect.top + Number(root.getAttribute('cy')) };
  };
  checks.pathPoint = fraction => {
    const r = checks.renderer, object = r.dislocationLayer.vectorGeometry.objects[0];
    for (const path of object.paths) for (let index = 1; index < path.fractions.length; index++) {
      if (path.fractions[index - 1] > fraction || path.fractions[index] < fraction) continue;
      const amount = (fraction - path.fractions[index - 1]) / (path.fractions[index] - path.fractions[index - 1]);
      const point = [0, 1, 2].map(axis => path.points[(index - 1) * 3 + axis] * (1 - amount) + path.points[index * 3 + axis] * amount);
      const projected = transformPoint(r.viewProjectionMatrix, ...point), rect = r.canvas.getBoundingClientRect();
      return { x: rect.left + (projected[0] / projected[3] + 1) * rect.width / 2,
        y: rect.top + (1 - projected[1] / projected[3]) * rect.height / 2 };
    }
    throw new Error('No displayed curve interval contains the target fraction.');
  };
  checks.exportRecipe = async () => {
    const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click; let blob;
    URL.createObjectURL = function(value) { blob = value; return createUrl.call(this, value); };
    HTMLAnchorElement.prototype.click = () => {};
    try { document.getElementById('export-configuration').click(); if (!blob) throw new Error('Missing configuration Blob.'); return JSON.parse(await blob.text()); }
    finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
  checks.exportPixels = () => {
    const r = checks.renderer, options = { ...r.dislocationOptions };
    const capture = () => r.captureImage({ includeBackground: true, includeAxes: false });
    const count = canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let yellow = 0, cyan = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const [red, green, blue] = pixels.subarray(i, i + 3);
        if (red > 70 && green > 40 && blue < Math.min(red, green) * .65) yellow++;
        if (green > 50 && blue > 50 && Math.min(green, blue) > red * 1.4) cyan++;
      }
      return { yellow, cyan };
    };
    const visible = capture();
    try {
      r.setDislocationNetwork(r.dislocationNetwork, { ...options, showLineDirections: false, showBurgersVectors: false });
      return { shown: count(visible), hidden: count(capture()), png: visible.toDataURL('image/png') };
    } finally { r.setDislocationNetwork(r.dislocationNetwork, options); }
  };
}
