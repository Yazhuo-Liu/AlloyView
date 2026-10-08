import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Real production UI, WebGL shaders and secondary viewport. Software rendering
// validates buffer traffic/pixels; its wall times are not GPU speed claims.
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-legend-preview-'));
const count = 20_000, file = resolve(directory, 'scalar-trajectory.xyz');
const frame = step => [`${count}`, `Lattice="100 0 0 0 100 0 0 0 100" pbc="F F F" Properties=species:S:1:pos:R:3:id:I:1:energy:R:1 Step=${step}`,
  ...Array.from({ length: count }, (_, atom) => `Ni ${2 + atom % 40 * 2} ${2 + Math.floor(atom / 40) % 25 * 2} ${2 + Math.floor(atom / 1000) * 2} ${atom + 1} ${(atom % 101) / 100 + step}`), ''].join('\n');
await writeFile(file, frame(0) + frame(1));

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(navigator,"hardwareConcurrency",{get:()=>6})' });
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/index.html` });
    async function wait(expression, label, timeout = 60_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
      throw new Error(label);
    }
    await wait('document.readyState==="complete" && document.getElementById("color-mode")', 'application loaded');
    await evaluate(`(${installChecks.toString()})()`);
    await evaluate(`if(document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true')document.getElementById('enable-gpu-computing').click()`);
    const { root } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
    await call('DOM.setFileInputFiles', { nodeId, files: [file] });
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    await wait(`legendPreviewChecks.main?.atomCount===${count} && document.getElementById('loading').hidden`, 'trajectory loaded');
    await evaluate(`legendPreviewChecks.watchScalars();legendPreviewChecks.change('color-mode','property:energy');legendPreviewChecks.change('compare-view',true,true)`);
    await wait('legendPreviewChecks.comparison?.atomCount===legendPreviewChecks.main.atomCount && document.querySelector(".legend-slider")', 'scalar legend and second view');
    const original = await evaluate('legendPreviewChecks.stats()');

    // The first tick prepares immutable scalars and masks. Subsequent ticks
    // must read no atom properties or re-upload full color/mask buffers.
    await evaluate('legendPreviewChecks.tick(.1)');
    const prepared = await evaluate('legendPreviewChecks.stats()');
    assert.ok(prepared.mainPreview && prepared.comparisonPreview);
    assert.ok(prepared.sharedInput);
    for (const fraction of [.12, .15, .18, .2, .25, .28, .3, .32, .35]) await evaluate(`legendPreviewChecks.tick(${fraction})`);
    const dragged = await evaluate('legendPreviewChecks.stats()');
    for (const name of ['colorUploads', 'visibilityUploads', 'scalarUploads', 'textureUploads', 'colorCommits', 'scalarReads']) {
      assert.equal(dragged[name], prepared[name], `${name} stays constant throughout a drag`);
    }
    assert.equal(dragged.glError, 0, 'both scalar vertex shaders compile and draw');
    assert.equal(dragged.auto, 'false');
    assert.equal(dragged.histogram, false, 'histogram scans wait for the exact commit');
    assert.ok(await evaluate('legendPreviewChecks.main.isAtomVisible(0)===false && legendPreviewChecks.main.isAtomVisible(60)===true'),
      'picking follows the live inclusive scalar range');

    await evaluate('document.querySelector(".legend-slider input[data-limit=minimum]").dispatchEvent(new Event("pointercancel"))');
    assert.ok(await evaluate('legendPreviewChecks.exact()'), 'cancel restores exact CPU colors in both views');
    assert.equal((await evaluate('legendPreviewChecks.stats()')).histogram, true);

    // Export immediately after input, before its scheduled animation frame.
    // Both primary and secondary captures must flush the exact CPU palette.
    for (const viewport of ['main', 'comparison']) {
      await evaluate(`legendPreviewChecks.input(.2);legendPreviewChecks.${viewport}.captureImage({includeBackground:false});`);
      assert.ok(await evaluate('legendPreviewChecks.exact()'), `${viewport} export flushes pending preview limits`);
    }

    // Real keyboard input and a real mouse drag exercise browser-native change
    // ordering, rather than only dispatching synthetic completion events.
    await evaluate('document.querySelector(".legend-slider input[data-limit=minimum]").focus()');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    assert.ok(await evaluate('legendPreviewChecks.exact()'), 'keyboard completion commits the exact palette');
    const point = await evaluate(`(() => {const input=document.querySelector('.legend-slider input[data-limit=minimum]');input.scrollIntoView({block:'nearest'});const b=input.getBoundingClientRect();return {x:b.left+10+(b.width-20)*Number(input.value)/Number(input.max),y:b.top+b.height/2};})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 30, y: point.y, button: 'left', buttons: 1 });
    await delay(60);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 30, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    assert.ok(await evaluate('legendPreviewChecks.exact()'), 'pointer release commits the exact palette');

    // Frame changes discard a stale slider callback and honor Auto off.
    const fixed = await evaluate('legendPreviewChecks.range()');
    await evaluate('legendPreviewChecks.input(.25);legendPreviewChecks.change("frame-slider","1",false,"input")');
    await wait('legendPreviewChecks.main.frame.timestep===1', 'second frame');
    assert.deepEqual(await evaluate('legendPreviewChecks.range()'), fixed.map((value, index) => index ? value : 0.25), 'manual bounds persist across frames');
    assert.ok(await evaluate('legendPreviewChecks.exact()'), 'replacement frame has exact colors');
    const pixels = await evaluate('legendPreviewChecks.smallScene()');
    assert.equal(pixels.finalEqualsExact, true, 'committed WebGL pixels match exact CPU colors');
    assert.ok(pixels.maximumPreviewDifference <= 2, `preview differs by at most float32 byte rounding: ${JSON.stringify(pixels)}`);
    assert.ok(pixels.voronoiMaximumPreviewDifference <= 2, 'all-cell faces and edges follow the live range mask');
    assert.equal(pixels.voronoiFinalEqualsExact, true, 'committed Voronoi pixels match exact CPU masking');
    assert.equal(pixels.glError, 0);
    return { atoms: count, original, prepared, dragged, pixels };
  }, { software: true, requireGpu: false });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }

async function installChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const [{ WebGLRenderer }, { colorsByProperty, visibilityByProperty }, { createCell }, { createVoronoiCellBatch }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./render/palette.js', app)), import(new URL('./data/model.js', app)),
    import(new URL('./render/voronoi-cell-layer.js', app)),
  ]);
  const checks = window.legendPreviewChecks = { colorUploads: 0, visibilityUploads: 0, scalarUploads: 0, textureUploads: 0, colorCommits: 0, scalarReads: 0 };
  const frame = WebGLRenderer.prototype.setFrame, colors = WebGLRenderer.prototype.setColors;
  WebGLRenderer.prototype.setFrame = function(...args) { checks[this.canvas.id === 'viewport' ? 'main' : 'comparison'] = this; return frame.apply(this, args); };
  WebGLRenderer.prototype.setColors = function(...args) { checks.colorCommits++; return colors.apply(this, args); };
  const upload = WebGL2RenderingContext.prototype.bufferData, texture = WebGL2RenderingContext.prototype.texImage2D, subTexture = WebGL2RenderingContext.prototype.texSubImage2D;
  WebGL2RenderingContext.prototype.bufferData = function(...args) {
    const bound = this.getParameter(this.ARRAY_BUFFER_BINDING);
    for (const renderer of [checks.main, checks.comparison]) if (renderer?.gl === this) {
      if (bound === renderer.colorBuffer) checks.colorUploads++;
      if (bound === renderer.visibilityBuffer) checks.visibilityUploads++;
      if (bound === renderer.scalarColorBuffer) checks.scalarUploads++;
    }
    return upload.apply(this, args);
  };
  WebGL2RenderingContext.prototype.texImage2D = function(...args) { checks.textureUploads++; return texture.apply(this, args); };
  WebGL2RenderingContext.prototype.texSubImage2D = function(...args) { checks.textureUploads++; return subTexture.apply(this, args); };
  checks.change = (id, value, checkbox = false, event = 'change') => {
    const element = document.getElementById(id); element[checkbox ? 'checked' : 'value'] = value;
    element.dispatchEvent(new Event(event, { bubbles: true }));
  };
  checks.watchScalars = () => {
    const property = checks.main.frame.properties.find(property => property.name === 'energy'), data = property.data;
    property.data = new Proxy(data, { get(target, key) {
      if (key === Symbol.iterator) return function*() { for (let atom = 0; atom < target.length; atom++) { checks.scalarReads++; yield target[atom]; } };
      if (/^\d+$/.test(String(key))) checks.scalarReads++;
      return Reflect.get(target, key, target);
    } });
  };
  checks.input = fraction => {
    const input = document.querySelector('.legend-slider input[data-limit=minimum]');
    input.value = String(Math.round(Number(input.max) * fraction)); input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  checks.tick = async fraction => { checks.input(fraction); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
  checks.range = () => Array.from(document.querySelectorAll('.legend-controls input[type=number]'), input => input.valueAsNumber);
  checks.stats = () => ({ ...Object.fromEntries(['colorUploads', 'visibilityUploads', 'scalarUploads', 'textureUploads', 'colorCommits', 'scalarReads'].map(key => [key, checks[key]])),
    mainPreview: Boolean(checks.main.scalarColorPreview), comparisonPreview: Boolean(checks.comparison.scalarColorPreview),
    sharedInput: Boolean(checks.main.scalarColorPreview && checks.main.scalarColorPreview.input === checks.comparison.scalarColorPreview?.input),
    histogram: Boolean(document.querySelector('.legend-histogram')), auto: document.getElementById('legend-auto').getAttribute('aria-pressed'),
    glError: checks.main.gl.getError() || checks.comparison.gl.getError() });
  checks.exact = () => {
    const [minimum, maximum] = checks.range(), property = checks.main.frame.properties.find(property => property.name === 'energy');
    const scheme = document.querySelector('.legend-scheme select').value, expected = colorsByProperty(property, { minimum, maximum }, scheme).colors;
    return [checks.main, checks.comparison].every(renderer => !renderer.scalarColorPreview && renderer.atomColors.every((value, index) => value === expected[index]));
  };
  checks.smallScene = () => {
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:420px;height:280px'; document.body.append(canvas);
    const renderer = new WebGLRenderer(canvas), data = Float64Array.of(0, .2, .4, .6, .8, 1, NaN);
    const positions = Float64Array.of(2, 2, 2, 5, 2, 2, 8, 2, 2, 2, 5, 2, 5, 5, 2, 8, 5, 2, 5, 8, 2);
    const frame = { ids: Uint32Array.of(1, 2, 3, 4, 5, 6, 7), types: new Uint8Array(7), typeLabels: ['Ni'], positions,
      fractional: Float64Array.from(positions, value => value / 10), cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
    renderer.setFrame(frame, colorsByProperty({ name: 'value', data }).colors);
    renderer.setBonds({ indices: Uint32Array.of(0, 1, 1, 2, 3, 4, 4, 5), vectors: Float32Array.of(3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0), count: 4 });
    renderer.setCellVisible(false); renderer.setView('top'); renderer.resetCamera(); renderer.setProjection('orthographic');
    const palette = colorsByProperty({ name: 'value', data }, { minimum: 0.1, maximum: 0.9 }, 'viridis');
    const overrides = new Uint8Array(7); overrides[0] = 255; palette.colors.set([255, 0, 255], 0);
    renderer.atomColors.set([255, 0, 255], 0); renderer.setColors(renderer.atomColors);
    const pixels = () => { renderer.render(); const values = new Uint8Array(canvas.width * canvas.height * 4); renderer.gl.readPixels(0, 0, canvas.width, canvas.height, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, values); return values; };
    renderer.setScalarColorPreview(data, { ...palette.legend, colorOverrides: overrides, hideOutside: false, onCommit: () => renderer.setColors(palette.colors) });
    const preview = pixels(); renderer.finishScalarColorPreview(); const final = pixels(); renderer.setColors(palette.colors); const exact = pixels();
    let maximumPreviewDifference = 0;
    for (let index = 0; index < exact.length; index++) maximumPreviewDifference = Math.max(maximumPreviewDifference, Math.abs(preview[index] - exact[index]));
    // Seven owner cells use a different position atlas width than the shared
    // scalar atlas (7 versus 3), exercising both face and outline lookups.
    const vertices = Float64Array.of(-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1);
    const faceOffsets = Uint32Array.of(0, 4, 8, 12, 16, 20, 24), faceVertices = Uint32Array.of(0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 5, 4, 1, 2, 6, 5, 2, 3, 7, 6, 3, 0, 4, 7);
    const mesh = createVoronoiCellBatch(Array.from(data, (_, atomIndex) => ({ atomIndex, vertices, faceOffsets, faceVertices, faceNeighbors: new Int32Array(6).fill(-1) })));
    renderer.setVoronoiAllCellGeometry({ chunks: [mesh], cellCount: data.length, complete: true }, { allEnabled: true, scale: .8 });
    renderer.setSelected(2);
    const mask = visibilityByProperty({ name: 'value', data }, { minimum: .1, maximum: .9 });
    renderer.setScalarColorPreview(data, { ...palette.legend, colorOverrides: overrides, hideOutside: true,
      onCommit: () => { renderer.setColors(palette.colors); renderer.setVisibility(mask); } });
    const cellPreview = pixels(); renderer.finishScalarColorPreview(); const cellFinal = pixels(); renderer.setColors(palette.colors); renderer.setVisibility(mask); const cellExact = pixels();
    let voronoiMaximumPreviewDifference = 0;
    for (let index = 0; index < cellExact.length; index++) voronoiMaximumPreviewDifference = Math.max(voronoiMaximumPreviewDifference, Math.abs(cellPreview[index] - cellExact[index]));
    canvas.remove(); renderer.resizeObserver.disconnect();
    return { maximumPreviewDifference, finalEqualsExact: final.every((value, index) => value === exact[index]),
      voronoiMaximumPreviewDifference, voronoiFinalEqualsExact: cellFinal.every((value, index) => value === cellExact[index]), glError: renderer.gl.getError() };
  };
}
