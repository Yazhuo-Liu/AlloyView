import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { baselinePick } from '../tests/helpers/pick-reference.js';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

const production = process.argv.includes('--production'), benchmark = process.argv.includes('--benchmark');
const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  if (production) {
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    const deadline = Date.now() + 30000;
    while (!(await evaluate('document.readyState === "complete" && document.querySelector("[data-tool-button=coordination]")'))) {
      if (Date.now() > deadline) throw new Error('Production page startup timed out.');
      await delay(25);
    }
  }
  return evaluate(`(async () => {
    const { scalarPreviewAtomVisible } = await import('/AlloyView/src/render/scalar-colormap.js');
    const { SLICE_EPSILON } = await import('/AlloyView/src/render/slicing.js');
    return await (${run.toString()})(${production}, ${benchmark}, ${baselinePick.toString()});
  })()`);
}, { requireGpu: false });
assert.equal(report.orientationDifferences, 0);
assert.ok(report.pickComparisons >= 1500);
assert.equal(report.pickDifferences, 0);
assert.equal(report.contextRestored, true);
assert.equal(report.glError, 0);
console.log(JSON.stringify(report, null, 2));

async function run(production, benchmark, originalPick) {
  const base = production ? new URL('./', document.querySelector('script[type=module][src]').src) : new URL('/AlloyView/src/', location.href);
  const [orientation, { WebGLRenderer }, { createCell, fractionalToCartesian }, { transformPoint }, { crystalFrame }] = await Promise.all([
    import(new URL('./render/orientation-colors.js', base)), import(new URL('./render/webgl-renderer.js', base)),
    import(new URL('./data/model.js', base)), import(new URL('./render/math.js', base)), import('/AlloyView/tests/helpers/crystals.js'),
  ]);
  let seed = 0x842913f2;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  function orientationFrame(count) {
    const orientations = new Float64Array(count * 4), structures = new Uint8Array(count), ids = new Uint32Array(count);
    for (let atom = 0; atom < count; atom++) {
      structures[atom] = atom % 101 ? [1, 2, 3][atom % 3] : 0;
      for (let axis = 0; axis < 4; axis++) orientations[atom * 4 + axis] = random() * 2 - 1;
      if (atom % 103 === 0) orientations[atom * 4] = NaN;
    }
    return { ids, ptm: { structures, orientations }, properties: [{ name: 'ptmStructureType', data: structures }] };
  }
  // This is the original resolver's per-atom helper path, including its reused
  // quaternion scratch and all RGB/weight allocations. It is also the oracle.
  function helperColors(frame, mode, settings) {
    const sample = orientation.orientationSampleDirection(settings), quaternion = [0, 0, 0, 0], colors = new Uint8Array(frame.ids.length * 3);
    for (let atom = 0; atom < frame.ids.length; atom++) {
      for (let axis = 0; axis < 4; axis++) quaternion[axis] = frame.ptm.orientations[atom * 4 + axis];
      const structure = frame.ptm.structures[atom], family = orientation.orientationFamily(structure);
      let rgb = null;
      if (family && mode === 'builtin:ptm:quaternion') rgb = orientation.rodriguesColor(quaternion, structure);
      else if (family) {
        const weights = orientation.ipfWeights(orientation.sampleToCrystalDirection(quaternion, sample), structure);
        if (weights && Math.max(...weights) > 0) rgb = orientation.ipfColorFromWeights(weights);
      }
      colors.set(rgb ?? orientation.UNDEFINED_ORIENTATION_COLOR, atom * 3);
    }
    return colors;
  }
  const resolver = new orientation.OrientationColorResolver(), settings = { direction: 'custom', custom: [.2, -.6, .9] };
  const orientFrame = orientationFrame(24000);
  let orientationDifferences = 0;
  for (const mode of ['builtin:ptm:ipf', 'builtin:ptm:quaternion']) {
    const expected = helperColors(orientFrame, mode, settings), actual = resolver.resolve(orientFrame, mode, settings).colors;
    for (let i = 0; i < expected.length; i++) if (actual[i] !== expected[i]) orientationDifferences++;
  }
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:640px;height:480px'; document.body.append(canvas);
  const renderer = new WebGLRenderer(canvas); renderer.requestRender = () => {};
  const frame = crystalFrame('fcc', 6, 3.52);
  frame.cell = createCell({ origin: [3, -2, 1], vectors: [-21.12, 1, 0, 4, 21.12, 2, -2, 3, 21.12], pbc: [true, false, true] });
  frame.positions = fractionalToCartesian(frame.fractional, frame.cell);
  renderer.setFrame(frame, new Uint8Array(frame.ids.length * 3).fill(170)); renderer.setReplications([2, 1, 2]);
  const radii = Float32Array.from(frame.ids, (_, atom) => .2 + atom % 13 * .12); renderer.setAtomRadii(radii);
  let pickComparisons = 0, pickDifferences = 0;
  function compare(x, y) {
    const expected = originalPick.call(renderer, x, y), pick = JSON.stringify(renderer.lastPick);
    const actual = renderer.pick(x, y);
    if (actual !== expected || JSON.stringify(renderer.lastPick) !== pick) pickDifferences++;
    pickComparisons++;
  }
  function checkPicks() {
    renderer.updateMatrices();
    const rect = canvas.getBoundingClientRect();
    for (let point = 0; point < 80; point++) compare(rect.left + random() * rect.width, rect.top + random() * rect.height);
    for (let atom = 0; atom < 30; atom++) {
      const replica = renderer.replicas[atom % renderer.replicas.length], index = atom * 3;
      const clip = transformPoint(renderer.viewProjectionMatrix, renderer.displayPositions[index] + replica.offset[0],
        renderer.displayPositions[index + 1] + replica.offset[1], renderer.displayPositions[index + 2] + replica.offset[2]);
      compare(rect.left + (clip[0] / clip[3] * .5 + .5) * rect.width, rect.top + (.5 - clip[1] / clip[3] * .5) * rect.height);
    }
  }
  for (const projection of ['perspective', 'orthographic']) {
    renderer.setProjection(projection);
    for (let scenario = 0; scenario < 7; scenario++) {
      renderer.yaw += .23; renderer.pitch -= .11; renderer.setRadiusScale(.1 + scenario * .4);
      renderer.setSlices(scenario % 2 ? [{ id: 'cut', enabled: true, normal: [.6, 0, .8], position: 17, side: 'positive' },
        { id: 'slab', enabled: true, slab: true, normal: [0, 1, 0], position: 10, thickness: 16 }] : []);
      renderer.setVisibility(Uint8Array.from(frame.ids, (_, atom) => atom % (scenario + 2) ? 255 : 0));
      if (scenario === 2) renderer.setPeriodicOrigin([.2, 0, -.15]);
      if (scenario === 3) renderer.scalarColorPreview = { hideOutside: true, minimum: .25, maximum: .8,
        input: { data: Float64Array.from(frame.ids, (_, atom) => atom % 23 ? atom / frame.ids.length : NaN) } };
      if (scenario === 4) { renderer.scalarColorPreview = null; const continuous = Float64Array.from(frame.positions, (value, i) => value + (i % 3 === 0 ? 21.12 : 0)); renderer.setDisplayPositions(continuous, { coordinateMode: 'unwrapped' }); }
      checkPicks();
    }
  }
  const extension = renderer.gl.getExtension('WEBGL_lose_context');
  if (!extension) throw new Error('Context recovery extension unavailable.');
  const wait = async predicate => { const deadline = performance.now() + 10000; while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Context recovery timed out.'); await new Promise(done => setTimeout(done, 10));
  } };
  extension.loseContext(); await wait(() => renderer.contextLost);
  compare(100, 100);
  extension.restoreContext(); await wait(() => !renderer.contextLost && !renderer.gl.isContextLost());
  renderer.render(performance.now(), { trackStats: false }); checkPicks();
  const glError = renderer.gl.getError();
  const timing = [];
  if (benchmark) {
    const large = orientationFrame(1000000), median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    for (const mode of ['builtin:ptm:ipf', 'builtin:ptm:quaternion']) {
      const old = [], optimized = [];
      helperColors(large, mode, settings); resolver.clear(); resolver.resolve(large, mode, settings);
      for (let repeat = 0; repeat < 3; repeat++) {
        const operations = repeat % 2 ? ['optimized', 'old'] : ['old', 'optimized'];
        let a, b;
        for (const operation of operations) {
          const start = performance.now();
          if (operation === 'old') { a = helperColors(large, mode, settings); old.push(performance.now() - start); }
          else { resolver.clear(); b = resolver.resolve(large, mode, settings).colors; optimized.push(performance.now() - start); }
        }
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`Million-atom color differs at ${i}.`);
      }
      timing.push({ operation: mode, atoms: large.ids.length, oldMedianMs: median(old), optimizedMedianMs: median(optimized), old, optimized, byteDifferences: 0 });
    }
    const largePick = Object.assign(Object.create(WebGLRenderer.prototype), {
      canvas, frame: { cell: frame.cell, fractional: new Float64Array(3000000) }, atomCount: 1000000,
      displayPositions: Float64Array.from({ length: 3000000 }, (_, i) => i % 3 === 2 ? -1 - random() * 100 : random() * 200 - 100),
      atomRadii: new Float32Array(1000000).fill(.2), radiusScale: 1, sliceMode: 'planes',
      slices: [{ enabled: true, normal: [.6, 0, .8], position: -30, side: 'positive' }], updateMatrices() {},
      viewMatrix: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      projectionMatrix: renderer.projectionMatrix,
    });
    const rect = canvas.getBoundingClientRect(), old = [], optimized = [];
    for (let repeat = -1; repeat < 5; repeat++) {
      const pointer = [rect.left + rect.width * (.45 + repeat * .01), rect.top + rect.height * .5];
      const start = performance.now(), a = originalPick.call(largePick, ...pointer), before = JSON.stringify(largePick.lastPick), oldMs = performance.now() - start;
      const later = performance.now(), b = largePick.pick(...pointer), optimizedMs = performance.now() - later;
      if (a !== b || before !== JSON.stringify(largePick.lastPick)) throw new Error('Million-atom picking differs.');
      if (repeat >= 0) { old.push(oldMs); optimized.push(optimizedMs); }
    }
    timing.push({ operation: 'pick · plane slice', atoms: largePick.atomCount, oldMedianMs: median(old), optimizedMedianMs: median(optimized), old, optimized, hitDifferences: 0 });
  }
  renderer.clearFrame();
  return { production, entry: production ? document.querySelector('script[type=module][src]').src : null,
    orientationDifferences, pickComparisons, pickDifferences, contextRestored: true, glError, timing,
    note: 'Times measure browser main-thread CPU loops only; cached colors, Worker execution, GPU computation and GL uploads are excluded. SwiftShader validates graphics correctness only.' };
}
