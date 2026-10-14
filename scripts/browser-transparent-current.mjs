import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Native drawing-buffer matte checks. The references use the same MSAA sample
// locations and actual layers, and change only the clear color. No renderer
// shader or geometry is substituted. --source runs before the unified build.
const source = process.argv.includes('--source');
const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  if (!source) {
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    const deadline = Date.now() + 30_000;
    while (!(await evaluate('document.readyState === "complete" && document.querySelector("[data-tool-button=coordination]")'))) {
      if (Date.now() > deadline) throw new Error('Production page startup timed out.');
      await delay(25);
    }
  }
  return evaluate(`(${run.toString()})(${source})`);
}, { requireGpu: false });
console.log(JSON.stringify(report, null, 2));
assert.equal(report.rows.every(row => row.opaqueDifferences === 0 && row.foregroundPixels > 0
  && row.blackError <= 2 && row.whiteError <= 2 && row.themeError <= (row.scene === 'all-xray' ? 3 : 2)
  && row.independentMatteDifferences === 0 && row.stateRestored), true);
assert.ok(report.rows.some(row => row.samples === 0));
assert.ok(report.rows.some(row => row.samples > 0));
assert.ok(report.negativeControls.some(row => row.differingPixels > 0 && row.maximumCompositeError > 2),
  'Changing Voronoi style between black/white must expose the old matte error.');
assert.equal(report.failureRestored, true);

async function run(source) {
  const base = source ? new URL('/AlloyView/src/app.js', location.href) : document.querySelector('script[type=module][src]').src;
  const module = path => import(new URL(path, base));
  const [{ WebGLRenderer }, { createCell, fractionalToCartesian }, { calculateVoronoiGeometry },
    { createVoronoiCellBatch }, { DXA_FAMILIES }] = await Promise.all([
    module('./render/webgl-renderer.js'), module('./data/model.js'), module('./analysis/voronoi.js'),
    module('./render/voronoi-cell-layer.js'), module('./analysis/dxa.js'),
  ]);
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const cell = createCell({ vectors: [2, 0, 0, 0, 2, 0, 0, 0, 2] });
  const fractional = [];
  for (const a of [.25, .75]) for (const b of [.25, .75]) for (const c of [.25, .75]) fractional.push(a, b, c);
  const frame = { cell, fractional: Float64Array.from(fractional), ids: Uint32Array.from({ length: 8 }, (_, i) => i + 1),
    types: new Uint32Array(8), typeNames: ['Fe'], properties: [] };
  frame.positions = fractionalToCartesian(frame.fractional, cell);
  const geometries = [];
  for (let atomIndex = 0; atomIndex < 8; atomIndex++) geometries.push(await calculateVoronoiGeometry(frame, { atomIndex }));
  const batch = { chunks: [createVoronoiCellBatch(geometries)], cellCount: 8, complete: true };
  const bonds = { indices: Uint32Array.of(0, 1, 0, 2, 0, 4), vectors: Float32Array.of(0, 0, 1, 0, 1, 0, 1, 0, 0), shifts: new Int32Array(9), count: 3 };
  const arrows = Float32Array.from({ length: 24 }, (_, i) => i % 3 === 0 ? .45 : i % 3 === 1 ? .2 : .1);
  const network = { parameters: { lattice: 'fcc' }, segments: [{ id: 1, familyId: DXA_FAMILIES.fcc[0].id,
    points: Float64Array.of(.25, .25, .4, 1, .3, .65, 1.7, .5, 1.3), closed: false }], totalLength: 2, density: .25 };
  const rows = [], negativeControls = [];
  const different = (first, second) => {
    let count = 0; for (let index = 0; index < first.length; index++) count += Number(first[index] !== second[index]); return count;
  };
  const state = renderer => JSON.stringify({ camera: renderer.getCameraState(), background: renderer.background,
    appearance: renderer.exportAppearanceBackground, viewport: Array.from(renderer.gl.getParameter(renderer.gl.VIEWPORT)),
    width: renderer.canvas.width, height: renderer.canvas.height, samples: renderer.gl.getParameter(renderer.gl.SAMPLES) });
  const flip = (bytes, width, height) => {
    const image = new Uint8ClampedArray(bytes.length), stride = width * 4;
    for (let row = 0; row < height; row++) image.set(bytes.subarray((height - row - 1) * stride, (height - row) * stride), row * stride);
    return image;
  };
  const bytes = image => image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
  const read = renderer => {
    renderer.render(performance.now(), { trackStats: false });
    const output = new Uint8Array(renderer.canvas.width * renderer.canvas.height * 4), gl = renderer.gl;
    gl.readPixels(0, 0, renderer.canvas.width, renderer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, output);
    require(gl.getError() === gl.NO_ERROR, 'The real scene produced a GL error.');
    return flip(output, renderer.canvas.width, renderer.canvas.height);
  };
  // Style background is independent of clear color in the correct references.
  const reference = (renderer, background, freezeAppearance = true) => {
    const oldBackground = renderer.background, appearance = renderer.exportAppearanceBackground;
    renderer.background = background;
    renderer.exportAppearanceBackground = freezeAppearance ? oldBackground : undefined;
    try { return read(renderer); }
    finally { renderer.background = oldBackground; renderer.exportAppearanceBackground = appearance; read(renderer); }
  };
  const compareComposite = (transparent, opaque, background) => {
    let maximum = 0, differingPixels = 0;
    for (let index = 0; index < opaque.length; index += 4) {
      const alpha = transparent[index + 3] / 255; let differs = false;
      for (let channel = 0; channel < 3; channel++) {
        const composed = Math.round(transparent[index + channel] * alpha + background[channel] * 255 * (1 - alpha));
        const error = Math.abs(composed - opaque[index + channel]); maximum = Math.max(maximum, error); differs ||= error > 2;
      }
      differingPixels += Number(differs);
    }
    return { maximum, differingPixels };
  };
  const oldMatte = (black, white) => {
    const output = new Uint8ClampedArray(black.length);
    for (let index = 0; index < black.length; index += 4) {
      const alpha = Math.round(255 * Math.min(1, Math.max(0, 1 - (white[index] - black[index]
        + white[index + 1] - black[index + 1] + white[index + 2] - black[index + 2]) / 765)));
      for (let channel = 0; channel < 3; channel++) output[index + channel] = alpha ? Math.min(255, Math.round(black[index + channel] * 255 / alpha)) : 0;
      output[index + 3] = alpha;
    }
    return output;
  };
  let failureRestored = false;
  for (const antialias of [false, true]) for (const view of ['main', 'second']) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${view === 'main' ? 288 : 212}px;height:${view === 'main' ? 216 : 154}px`;
    document.body.append(canvas);
    canvas.getContext('webgl2', { alpha: true, antialias, preserveDrawingBuffer: true });
    const renderer = new WebGLRenderer(canvas); renderer.requestRender = () => {};
    renderer.setFrame(frame, Uint8Array.from({ length: 24 }, (_, i) => [160, 85, 210][i % 3]));
    renderer.setRadiusScale(.28); renderer.setView('front'); renderer.setProjection(view === 'main' ? 'perspective' : 'orthographic');
    renderer.yaw = -.45; renderer.pitch = .3; renderer.setSelected(-1); renderer.setCellVisible(true);
    try {
      for (const theme of ['light', 'dark']) for (const scene of ['atoms', 'primitives', 'single-cell', 'all-xray', 'all-surface', 'slice']) {
        renderer.setBackground(theme === 'light' ? '#edf4fa' : '#10202d');
        renderer.setBonds(scene === 'primitives' ? bonds : null, { radius: .055 });
        renderer.setVectors(scene === 'primitives' ? arrows : null, { scale: 1, radius: .035, color: '#ee9235' });
        renderer.setDislocationNetwork(scene === 'primitives' ? network : null, { radius: .05 });
        renderer.setVoronoiCellGeometry(scene === 'single-cell' ? geometries[0] : null,
          { enabled: scene === 'single-cell', allEnabled: scene.startsWith('all-'), color: '#3b82f6', opacity: .5,
            style: scene === 'all-surface' ? 'surface' : 'xray', scale: .9 });
        renderer.setVoronoiAllCellGeometry(scene.startsWith('all-') ? batch : null);
        renderer.setSlices(scene === 'slice' ? [{ id: 'cut', normal: [.6, 0, .8], position: 1.6, side: 'negative', enabled: true }] : []);
        renderer.setSliceOutlines(scene === 'slice'); renderer.resetCamera();
        const expectedOpaque = read(renderer), savedState = state(renderer), background = renderer.background;
        const opaque = await renderer.captureImage({ includeBackground: true });
        const opaqueDifferences = different(bytes(opaque), expectedOpaque);
        require(opaqueDifferences === 0, `${theme}/${scene}/${view}: opaque native readback differs at ${opaqueDifferences} bytes`);
        const black = reference(renderer, [0, 0, 0]), white = reference(renderer, [1, 1, 1]);
        const transparent = await renderer.captureImage({ includeBackground: false }), transparentBytes = bytes(transparent);
        require(transparent.width === canvas.width && transparent.height === canvas.height, 'Current export changed native dimensions.');
        // Use the frozen pre-R5 byte formula on independent readbacks, then
        // the same real 2D canvas conversion. This checks the matte itself
        // strictly, including Canvas premultiply/unpremultiply quantization.
        const independent = document.createElement('canvas'); independent.width = canvas.width; independent.height = canvas.height;
        const independentContext = independent.getContext('2d'), independentImage = independentContext.createImageData(canvas.width, canvas.height);
        independentImage.data.set(oldMatte(black, white)); independentContext.putImageData(independentImage, 0, 0);
        const independentMatteDifferences = different(transparentBytes, bytes(independent));
        let foregroundPixels = 0;
        for (let index = 3; index < transparentBytes.length; index += 4) foregroundPixels += Number(transparentBytes[index] > 0);
        const checks = [compareComposite(transparentBytes, black, [0, 0, 0]), compareComposite(transparentBytes, white, [1, 1, 1]),
          compareComposite(transparentBytes, expectedOpaque, background)];
        const maximumCompositeError = Math.max(...checks.map(check => check.maximum));
        const row = { antialias, samples: renderer.gl.getParameter(renderer.gl.SAMPLES), view, theme, scene,
          width: canvas.width, height: canvas.height, opaqueDifferences, foregroundPixels, maximumCompositeError,
          independentMatteDifferences,
          blackError: checks[0].maximum, whiteError: checks[1].maximum, themeError: checks[2].maximum,
          stateRestored: state(renderer) === savedState && renderer.background === background && different(read(renderer), expectedOpaque) === 0 };
        rows.push(row);
        require(row.foregroundPixels > 0 && row.independentMatteDifferences === 0 && row.blackError <= 2 && row.whiteError <= 2
          && row.themeError <= (scene === 'all-xray' ? 3 : 2) && row.stateRestored, JSON.stringify(row));
        if (view === 'main' && scene === 'single-cell') {
          const invalid = oldMatte(reference(renderer, [0, 0, 0], false), reference(renderer, [1, 1, 1], false));
          const comparison = compareComposite(invalid, expectedOpaque, background);
          negativeControls.push({ antialias, theme, scene, maximumCompositeError: comparison.maximum, differingPixels: comparison.differingPixels });
        }
      }
      if (antialias && view === 'main') {
        const originalRead = renderer.gl.readPixels.bind(renderer.gl), saved = state(renderer), background = renderer.background;
        let reads = 0;
        renderer.gl.readPixels = (...args) => { if (++reads === 2) throw new Error('Injected white readback failure'); return originalRead(...args); };
        let failed = false;
        try { renderer.captureImage({ includeBackground: false }); } catch (error) { failed = /Injected white readback failure/.test(error.message); }
        finally { renderer.gl.readPixels = originalRead; }
        failureRestored = failed && state(renderer) === saved && renderer.background === background;
        require(failureRestored, 'Failed white readback did not restore the camera/background/viewport/appearance.');
      }
    } finally { renderer.clearFrame(); renderer.interactions?.dispose(); renderer.resizeObserver?.disconnect(); canvas.remove(); }
  }
  return { source, rows, negativeControls, failureRestored,
    note: 'Opaque native readback and independent pre-R5 matte are byte-identical. Measured black/white composites differ by at most two 8-bit levels; themed composites by two, or three for these layered all-xray fixtures, from successive RGBA8 blends and Canvas quantization. This measured bound is not a general theoretical guarantee. Real default single-sample/4x MSAA, main/second viewport aspects and actual layers. SwiftShader validates correctness, not hardware performance.' };
}
