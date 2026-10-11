import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Exercise the production UI and real WebGL color buffers. SwiftShader checks
// correctness without claiming a hardware GPU performance improvement.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-initial-colors-'));
const trajectory = resolve(directory, 'tilted-velocity.dump');
const plain = resolve(directory, 'positions-only.xyz');
const dumpFrame = step => [
  'ITEM: TIMESTEP', String(step), 'ITEM: NUMBER OF ATOMS', '4',
  'ITEM: BOX BOUNDS xy xz yz pp pp pp', '0 13 2', '0 11 1', '0 10 1',
  'ITEM: ATOMS id type xs ys zs ix iy iz vx vy vz energy',
  `1 1 ${.1 + step * .1} .1 .1 1 0 0 ${3 + step} 4 0 -1`,
  `2 1 ${.7 + step * .1} .5 .9 -1 0 0 0 0 2 -2`,
  `3 1 ${.1 + step * .1} .7 .3 0 0 0 -2 0 0 -3`,
  `4 1 ${.6 + step * .1} .7 .7 0 0 0 1 -2 2 -4`, '',
].join('\n');
await Promise.all([
  writeFile(trajectory, dumpFrame(0) + dumpFrame(1)),
  writeFile(plain, '3\nNo velocity data\nNi 0 0 0\nNi 2 1 3\nNi 4 3 1\n'),
]);

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
    const choose = mode => evaluate(`initialColorChecks.change('legend-color-mode',${JSON.stringify(mode)})`);
    const range = () => evaluate('initialColorChecks.range()');
    const automatic = () => evaluate('if(document.getElementById("legend-auto").getAttribute("aria-pressed")!=="true")document.getElementById("legend-auto").click()');
    async function download(id) {
      await evaluate(`initialColorChecks.beginDownload();document.getElementById(${JSON.stringify(id)}).click()`);
      try {
        await waitFor('Boolean(initialColorChecks.download)', `${id} creates a downloadable Blob`);
        return await evaluate('initialColorChecks.finishDownload()');
      } finally { await evaluate('initialColorChecks.restoreDownload()'); }
    }
    await upload('#file-input', trajectory);
    await waitFor('initialColorChecks.renderer?.frame.ids.length===4 && document.getElementById("loading").hidden', 'Tilted trajectory load');
    assert.deepEqual(await evaluate('initialColorChecks.uploads'), { frames: 1, colors: 0, radii: 0 },
      'first palette/radii upload is final: no duplicate color or radius upload during frame setup');
    const options = await evaluate('initialColorChecks.options()');
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(options.some(option => option.value === `builtin:position:${axis}`), `initial Position ${axis.toUpperCase()} choice`);
      assert.ok(options.some(option => option.value === `property:v${axis}` && new RegExp('Velocity '+axis.toUpperCase()).test(option.label)),
        `initial Velocity ${axis.toUpperCase()} choice keeps its imported property name`);
    }
    assert.ok(options.some(option => option.value === 'builtin:velocity:magnitude'), 'initial speed choice');
    assert.equal(await evaluate('document.getElementById("show-vectors").checked'), false, 'color quantities need no vector glyph analysis');
    assert.deepEqual(await evaluate('initialColorChecks.rawProperties()'), { vx: [3, 0, -2, 1], vy: [4, 0, 0, -2], vz: [0, 2, 0, 2], energy: [-1, -2, -3, -4] });

    const typeColors = await evaluate('Array.from(initialColorChecks.renderer.atomColors)');
    await choose('builtin:position:x');
    assert.deepEqual(await evaluate('initialColorChecks.exact("position",0)'), { colors: true, glError: 0 });
    assert.notDeepEqual(await evaluate('Array.from(initialColorChecks.renderer.atomColors)'), typeColors, 'coordinate colors reach WebGL');
    const wrappedRange = await range();
    near(wrappedRange, await evaluate('initialColorChecks.expectedRange("position",0)'), 'wrapped Cartesian X bounds');
    await evaluate('initialColorChecks.change("coordinate-mode","unwrapped")');
    const unwrappedRange = await range();
    near(unwrappedRange, await evaluate('initialColorChecks.expectedRange("position",0)'), 'unwrapped Cartesian X bounds');
    assert.notDeepEqual(unwrappedRange, wrappedRange, 'image flags affect the selected coordinate quantity');
    assert.deepEqual(await evaluate('initialColorChecks.exact("position",0)'), { colors: true, glError: 0 });
    await evaluate('initialColorChecks.change("coordinate-mode","wrapped")');
    near(await range(), wrappedRange, 'wrapped bounds restored');
    for (const axis of [0, 1, 2]) {
      await choose(`builtin:position:${'xyz'[axis]}`);
      assert.deepEqual(await evaluate(`initialColorChecks.exact("position",${axis})`), { colors: true, glError: 0 });
      await choose(`property:v${'xyz'[axis]}`);
      assert.deepEqual(await evaluate(`initialColorChecks.exact("velocity",${axis})`), { colors: true, glError: 0 });
    }
    await choose('builtin:position:x');
    await evaluate('initialColorChecks.manual(-20,30)');
    const fixedRange = await range();
    assert.equal(await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")'), 'false');
    await evaluate('document.getElementById("frame-next").click()');
    await waitFor('initialColorChecks.renderer.frame.frameIndex===1 && document.getElementById("loading").hidden', 'Second frame');
    assert.deepEqual(await range(), fixedRange, 'manual coordinate bounds persist across frames');
    assert.deepEqual(await evaluate('initialColorChecks.exact("position",0)'), { colors: true, glError: 0 });
    assert.deepEqual(await evaluate('initialColorChecks.rawProperties()'), { vx: [4, 0, -2, 1], vy: [4, 0, 0, -2], vz: [0, 2, 0, 2], energy: [-1, -2, -3, -4] });

    const recipes = [];
    for (const mode of ['builtin:position:x', 'builtin:velocity:magnitude']) {
      await choose(mode);
      if (mode.endsWith('magnitude')) {
        await automatic();
        near(await range(), [2, Math.hypot(4, 4, 0)], 'speed bounds use physical imported components');
        assert.deepEqual(await evaluate('initialColorChecks.exact("speed")'), { colors: true, glError: 0 });
      }
      const encoded = await download('export-configuration');
      const recipe = JSON.parse(encoded.text);
      assert.equal(recipe.settings.display.colorMode, mode, 'configuration saves the builtin quantity');
      const path = resolve(directory, `recipe-${recipes.length}.json`);
      await writeFile(path, encoded.text);
      await choose('type');
      await upload('#configuration-file', path);
      await waitFor(`document.getElementById('legend-color-mode')?.value===${JSON.stringify(mode)} && document.getElementById('configuration-status').textContent.includes('restored')`, 'Builtin quantity recipe replay');
      assert.equal(JSON.parse((await download('export-configuration')).text).settings.display.colorMode, mode);
      if (mode === 'builtin:position:x') assert.deepEqual(await range(), fixedRange, 'recipe restores the manual coordinate range');
      recipes.push(mode);
    }
    await choose('property:vx');
    assert.deepEqual(await evaluate('initialColorChecks.exact("velocity",0)'), { colors: true, glError: 0 });
    await choose('builtin:velocity:magnitude');
    await evaluate('document.getElementById("png-legend").checked=true;document.getElementById("png-legend").dispatchEvent(new Event("change",{bubbles:true}))');
    const png = await download('export-png');
    assert.equal(png.type, 'image/png');
    assert.deepEqual(png.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(png.size > 100);
    assert.deepEqual(await evaluate('initialColorChecks.lastCapture.data'), [Math.hypot(4, 4, 0), 2, 2, 3], 'PNG legend carries the selected physical speed');
    assert.equal(await evaluate('initialColorChecks.renderer.gl.getError()'), 0);
    assert.equal(await evaluate('initialColorChecks.renderer.frame.properties.some(property=>property.analysisKind==="vectors")'), false, 'coloring leaves imported properties untouched');
    assert.equal(await evaluate('initialColorChecks.uploads.radii'), 0, 'color quantities, ranges and frame visits do not reupload unchanged radii');

    await upload('#file-input', plain);
    await waitFor('initialColorChecks.renderer.frame.ids.length===3 && document.getElementById("file-name").textContent==="positions-only.xyz" && document.getElementById("loading").hidden', 'Position-only XYZ load');
    const plainOptions = await evaluate('initialColorChecks.options()');
    assert.equal(plainOptions.some(option => option.value === 'builtin:velocity:magnitude' || /^property:v[xyz]$/.test(option.value)), false, 'missing velocity does not add fabricated choices');
    for (const axis of ['x', 'y', 'z']) assert.ok(plainOptions.some(option => option.value === `builtin:position:${axis}`));
    await choose('builtin:position:z');
    assert.deepEqual(await evaluate('initialColorChecks.exact("position",2)'), { colors: true, glError: 0 });
    return { initialChoices: options.filter(option => option.value.startsWith('builtin:') || /^property:v[xyz]$/.test(option.value)), wrappedRange,
      unwrappedRange, fixedRange, restoredModes: recipes, pngBytes: png.size, positionOnlyChoices: plainOptions.filter(option => option.value.startsWith('builtin:')) };
  }, { software: true, requireGpu: false });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }

function near(actual, expected, label) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-6, `${label}: ${actual} versus ${expected}`));
}

async function installChecks() {
  const app = document.querySelector('script[type="module"][src]').src;
  const [{ WebGLRenderer }, { colorsByProperty }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./render/palette.js', app)),
  ]);
  const checks = window.initialColorChecks = { uploads: { frames: 0, colors: 0, radii: 0 } };
  const setFrame = WebGLRenderer.prototype.setFrame, capture = WebGLRenderer.prototype.captureImage;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') { checks.renderer = this; checks.uploads.frames++; }
    return setFrame.apply(this, args);
  };
  for (const [method, counter] of [['setColors', 'colors'], ['setAtomRadii', 'radii']]) {
    const original = WebGLRenderer.prototype[method];
    WebGLRenderer.prototype[method] = function(...args) {
      if (this.canvas.id === 'viewport') checks.uploads[counter]++;
      return original.apply(this, args);
    };
  }
  WebGLRenderer.prototype.captureImage = function(options) {
    if (this.canvas.id === 'viewport') checks.lastCapture = { title: options?.legend?.title, data: Array.from(options?.legend?.property?.data ?? []) };
    return capture.call(this, options);
  };
  checks.change = (id, value) => {
    const element = document.getElementById(id); element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.options = () => Array.from(document.getElementById('legend-color-mode').options, option => ({ value: option.value, label: option.textContent }));
  checks.range = () => Array.from(document.querySelectorAll('.legend-controls input[type=number]'), input => input.valueAsNumber);
  checks.manual = (minimum, maximum) => {
    for (const [axis, value] of [minimum, maximum].entries()) {
      const input = document.querySelectorAll('.legend-controls input[type=number]')[axis];
      input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  checks.rawProperties = () => Object.fromEntries(['vx', 'vy', 'vz', 'energy'].map(name => [name,
    Array.from(checks.renderer.frame.properties.find(property => property.name === name).data)]));
  checks.data = (quantity, axis = 0) => {
    const frame = checks.renderer.frame;
    if (quantity === 'velocity') return frame.properties.find(property => property.name === `v${'xyz'[axis]}`).data;
    if (quantity === 'speed') {
      const components = ['vx', 'vy', 'vz'].map(name => frame.properties.find(property => property.name === name).data);
      return Float64Array.from(frame.ids, (_, atom) => Math.hypot(...components.map(values => values[atom])));
    }
    const positions = document.getElementById('coordinate-mode').value === 'unwrapped' ? frame.unwrappedPositions : frame.positions;
    return Float64Array.from(frame.ids, (_, atom) => positions[atom * 3 + axis]);
  };
  checks.expectedRange = (quantity, axis) => {
    const data = checks.data(quantity, axis); return [Math.min(...data), Math.max(...data)];
  };
  checks.exact = (quantity, axis) => {
    const [minimum, maximum] = checks.range(), scheme = document.querySelector('.legend-scheme select').value;
    const expected = colorsByProperty({ name: 'expected', data: checks.data(quantity, axis) }, { minimum, maximum }, scheme).colors;
    checks.renderer.render();
    return { colors: checks.renderer.atomColors.every((value, index) => value === expected[index]), glError: checks.renderer.gl.getError() };
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
    return { type: blob.type, size: blob.size, text: blob.type.includes('json') ? await blob.text() : '',
      signature: Array.from(new Uint8Array(await blob.slice(0, 8).arrayBuffer())) };
  };
}
