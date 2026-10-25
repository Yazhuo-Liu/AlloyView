import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  const origin = await evaluate('location.origin');
  await call('Page.navigate', { url: `${origin}/AlloyView/${production ? 'dist/' : ''}index.html` });
  const deadline = Date.now() + 30_000;
  while (!(await evaluate('document.readyState === "complete" && document.getElementById("compare-view")'))) {
    if (Date.now() > deadline) throw new Error('Viewer startup timed out.');
    await delay(25);
  }
  return evaluate(`(${run.toString()})(${production})`);
}, { requireGpu: false });
assert.ok(report.scenarios.length >= 7);
for (const row of report.scenarios) {
  assert.equal(row.pixelDifferences, 0, row.name); assert.equal(row.exportDifferences, 0, row.name);
  assert.equal(row.pickDifferences, 0, row.name); assert.equal(row.boundsEqual, true, row.name);
  assert.equal(row.glError, 0, row.name);
}
assert.equal(report.context.pixelDifferences, 0); assert.equal(report.context.preparationRetained, true);
for (const [key, value] of Object.entries(report.sharing)) assert.equal(value, true, key);
for (const key of ['adopted', 'sameArrayCoordinatesFollow', 'sameArrayRadiusFollows', 'independentCamera', 'hiddenReleased', 'reopenRestoresCamera', 'pendingSceneMatchesMain', 'pendingCameraInteractive', 'committedSceneMatchesMain', 'sourceClosed']) {
  assert.equal(report.ui[key], true, key);
}
assert.equal(report.ui.reopenDimensionsReadyAtFramePublication, true);
console.log(JSON.stringify(report, null, 2));

async function run(production) {
  const base = new URL('./', document.querySelector('script[type=module][src]').src);
  const [{ WebGLRenderer }, { createCell, fractionalToCartesian }, { calculateBonds }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', base)), import(new URL('./data/model.js', base)),
    import(new URL('./analysis/bonds.js', base)),
  ]);
  const wait = async (predicate, label) => {
    const deadline = performance.now() + 20_000;
    while (!predicate()) { if (performance.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  // Capture the actual app renderers at the public frame boundary.
  const active = {}, setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') active.main = this;
    else if (this.canvas.closest?.('#comparison-view')) {
      active.second = this;
      active.secondFrameDimensions = [this.canvas.width, this.canvas.height, this.canvas.clientWidth, this.canvas.clientHeight];
    }
    return setFrame.apply(this, args);
  };
  if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click();
  const text = '3\nLattice="10 0 0 2 10 0 -1 1 10" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1\nFe 2 2 2 1\nFe 5 4 3 2\nFe 7 6 5 3\n';
  const transfer = new DataTransfer(); transfer.items.add(new File([text], 'comparison-preparation.xyz'));
  document.getElementById('file-input').files = transfer.files;
  document.getElementById('file-input').dispatchEvent(new Event('change', { bubbles: true }));
  await wait(() => active.main?.atomCount === 3 && document.getElementById('loading').hidden, 'Structure load timed out.');
  const sync = (enabled = true) => {
    const field = document.getElementById('compare-view'); field.checked = enabled;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  sync(); await wait(() => active.second?.frame === active.main.frame, 'Second view creation timed out.');
  const main = active.main, second = active.second;
  const ui = { adopted: second.displayPositions === main.displayPositions && second.displayFractional === main.displayFractional };
  second.orbitCamera(.31, -.17); second.pan[0] += .2;
  document.getElementById('compare-preset').value = 'custom';
  const camera = second.getCameraState(), mainCamera = JSON.stringify(main.getCameraState());
  main.rawDisplayPositions[0] += .75; main.setDisplayPositions(main.rawDisplayPositions, { coordinateMode: main.coordinateMode });
  sync(); await wait(() => second.sourceDisplayRevision === main.displayRevision, 'Same-array coordinate revision did not propagate.');
  ui.sameArrayCoordinatesFollow = second.displayPositions === main.displayPositions && second.sceneBounds.minimum[0] === main.sceneBounds.minimum[0];
  main.atomRadii[0] = 2.25; main.setAtomRadii(main.atomRadii); sync();
  await wait(() => second.maximumAtomRadius === 2.25, 'Same-array radius revision did not propagate.');
  ui.sameArrayRadiusFollows = second.atomRadii === main.atomRadii;
  ui.independentCamera = JSON.stringify(main.getCameraState()) === mainCamera
    && JSON.stringify(second.getCameraState()) === JSON.stringify(camera);
  sync(false); await wait(() => second.frame === null, 'Hidden second view retained its source.');
  ui.hiddenReleased = second.displayPositions === null && second.preparedDisplaySnapshot === null
    && second.preparedPrimitivePreparation === null && main.preparedDisplayUploads === null;
  second.canvas.width = second.canvas.height = 1; // A hidden RAF may leave this exact stale size.
  sync(); await wait(() => second.frame === main.frame, 'Second view reopening timed out.');
  const dimensions = active.secondFrameDimensions, dpr = Math.min(2, window.devicePixelRatio || 1);
  ui.reopenDimensionsReadyAtFramePublication = dimensions[0] === Math.round(dimensions[2] * dpr)
    && dimensions[1] === Math.round(dimensions[3] * dpr) && dimensions[0] > 1 && dimensions[1] > 1;
  const reopened = second.getCameraState();
  ui.reopenRestoresCamera = cameraNear(reopened, camera);

  // The comparison follows what the primary actually presents, not its
  // unpublished scientific target. Old-frame picking stays blocked while
  // each viewport can still orbit with its independent live camera.
  const initialFrame = main.frame, initialColors = main.atomColors, initialPositions = main.rawDisplayPositions;
  const initialRadii = main.atomRadii, initialMode = main.coordinateMode, initialRepetitions = main.repetitions;
  const targetFrame = { ...initialFrame, frameIndex: 777, positions: Float64Array.from(initialFrame.positions), fractional: Float64Array.from(initialFrame.fractional) };
  targetFrame.positions[0] += 1; targetFrame.fractional[0] += .1;
  const sceneToken = main.beginSceneUpdate();
  main.setFrame(targetFrame, initialColors, targetFrame.positions, initialRadii, initialRepetitions, { coordinateMode: initialMode });
  sync(); await wait(() => second.frame === initialFrame && second.presentationPending, 'Comparison did not retain the presented scene.');
  ui.pendingSceneMatchesMain = second.frame === main.presentedFrame && second.frame !== main.frame && second.pick(0, 0) === -1;
  const beforePendingOrbit = second.yaw; second.orbitCamera(.1, 0); second.render();
  ui.pendingCameraInteractive = Math.abs(second.yaw - beforePendingOrbit - .1) < 1e-10;
  main.commitSceneUpdate(sceneToken); sync();
  await wait(() => second.frame === targetFrame && !second.presentationPending, 'Comparison did not adopt the committed target.');
  ui.committedSceneMatchesMain = second.frame === main.frame && second.displayPositions === main.displayPositions;
  main.setFrame(initialFrame, initialColors, initialPositions, initialRadii, initialRepetitions, { coordinateMode: initialMode });
  sync(); await wait(() => second.frame === initialFrame, 'Restore initial comparison frame.');

  // Independent renderer computes the previous duplicate preparation path.
  // Only the candidate adopts the master's snapshot; GL contexts stay separate.
  const canvases = Array.from({ length: 3 }, () => {
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:420px;height:320px'; document.body.append(canvas); return canvas;
  });
  const [master, oracle, candidate] = canvases.map(canvas => new WebGLRenderer(canvas));
  for (const r of [master, oracle, candidate]) r.requestRender = () => {};
  const cell = createCell({ origin: [3, -2, 1], vectors: [-12, 1, 0, 3, 11, 1, -2, 2, 10], pbc: [true, false, true] });
  const fractional = Float64Array.from(Array.from({ length: 24 }, (_, atom) => [.1 + (atom % 4) * .2, .2 + Math.floor(atom / 4) % 3 * .2, .3 + Math.floor(atom / 12) * .35]).flat());
  const frame = { cell, fractional, positions: fractionalToCartesian(fractional, cell, new Float64Array(fractional.length)),
    ids: Uint32Array.from({ length: 24 }, (_, atom) => atom + 1), types: new Uint32Array(24), typeLabels: ['Fe'] };
  const colors = Uint8Array.from({ length: 72 }, (_, index) => [95, 160, 215][index % 3]);
  const radii = Float32Array.from({ length: 24 }, (_, atom) => .3 + (atom % 3) * .12);
  master.setFrame(frame, colors, frame.positions, radii, [2, 1, 2]); master.setDisplayPreparationSharing(true);
  const bonds = calculateBonds(frame, { cutoff: 3.5 });
  const arrows = Float32Array.from({ length: 72 }, (_, index) => Math.sin(index) * 1.2);
  master.setBonds(bonds, { radius: .07 });
  const pixels = r => {
    r.render(performance.now(), { trackStats: false });
    const bytes = new Uint8Array(r.canvas.width * r.canvas.height * 4);
    r.gl.readPixels(0, 0, r.canvas.width, r.canvas.height, r.gl.RGBA, r.gl.UNSIGNED_BYTE, bytes); return bytes;
  };
  const differences = (a, b) => { if (a.length !== b.length) return -1; let count = 0; for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) count++; return count; };
  const scenarios = [];
  function synchronize() {
    oracle.periodicOrigin = [...master.periodicOrigin];
    oracle.setFrame(frame, colors, master.rawDisplayPositions, radii, master.repetitions, { coordinateMode: master.coordinateMode });
    candidate.setFrame(frame, colors, master.rawDisplayPositions, radii, master.repetitions,
      { coordinateMode: master.coordinateMode, preparedDisplay: master.exportDisplaySnapshot() });
    for (const r of [oracle, candidate]) {
      r.setBackground('#f5f6f7'); r.resetCamera(); r.setView('front');
      r.setBonds(bonds, { radius: .07, ...(r === candidate ? { preparedBonds: master.preparedBondSnapshot } : {}) });
      r.setVectorFields([{ id: 'force', vectors: arrows, options: { scale: .7, color: '#ee9000' } }]);
      r.setSlices(master.slices ?? []); r.setSliceOutlines(true);
      r.setVisibility(master.visibility, { selectionVisibility: master.selectionVisibility });
      r.setRadiusScale(master.radiusScale); r.setSelectedAtoms([3, 10]);
    }
  }
  function compare(name) {
    synchronize();
    const left = pixels(oracle), right = pixels(candidate), options = { includeBackground: false, includeLegend: false, includeAxes: false };
    const exportBytes = r => { const image = r.captureImage(options); return image.getContext('2d').getImageData(0, 0, image.width, image.height).data; };
    let pickDifferences = 0;
    for (let point = 0; point < 100; point++) {
      const x = (point * 97 % 420) + .5, y = (point * 43 % 320) + .5;
      const a = oracle.canvas.getBoundingClientRect(), b = candidate.canvas.getBoundingClientRect();
      const indexA = oracle.pick(a.left + x, a.top + y), indexB = candidate.pick(b.left + x, b.top + y);
      if (indexA !== indexB || JSON.stringify(oracle.lastPick) !== JSON.stringify(candidate.lastPick)) pickDifferences++;
    }
    scenarios.push({ name, pixelDifferences: differences(left, right), exportDifferences: differences(exportBytes(oracle), exportBytes(candidate)), pickDifferences,
      boundsEqual: JSON.stringify(oracle.sceneBounds) === JSON.stringify(candidate.sceneBounds),
      coordinatesShared: candidate.displayPositions === master.displayPositions && candidate.displayFractional === master.displayFractional,
      uploadBytes: master.exportDisplaySnapshot().uploadByteLength, glError: candidate.gl.getError() });
  }
  compare('Float64 / zero origin / negative skew replicas');
  master.setPeriodicOrigin([.23, 9, -.17]); compare('wrapped periodic origin');
  const continuous = Float64Array.from(frame.positions, (value, index) => value + (index % 3 ? 0 : 24));
  master.setDisplayPositions(continuous, { coordinateMode: 'unwrapped' }); compare('unwrapped origin / independent fractional arrays');
  master.setReplications([1, 1, 3]); compare('changed negative skew replicas');
  master.setSlices([{ id: 'cut', normal: [1, 0, 1], position: 5, side: 'negative', enabled: true }]); compare('slices / bond image shifts');
  master.setVisibility(Uint8Array.from({ length: 24 }, (_, atom) => atom % 3 ? 255 : 0),
    { selectionVisibility: Uint8Array.from({ length: 24 }, (_, atom) => atom % 5 ? 255 : 0) }); compare('independent scene merge / selection-hidden arrows');
  radii[0] = 1.25; master.setAtomRadii(radii); master.setRadiusScale(.6); compare('same-array radii revision');
  continuous[0] -= 12; master.setDisplayPositions(continuous, { coordinateMode: 'unwrapped' }); compare('same-array display revision');
  pixels(master); pixels(candidate);
  const sharedGeometry = master.preparedPrimitivePreparation, sharedBonds = master.preparedBondSnapshot;
  const sharing = { samePositionRows: master.primitiveLayer.positionValues === candidate.primitiveLayer.positionValues,
    sameFractionRows: master.primitiveLayer.fractionalValues === candidate.primitiveLayer.fractionalValues,
    actualRowBytes: sharedGeometry.byteLength === master.primitiveLayer.positionValues.byteLength + master.primitiveLayer.fractionalValues.byteLength };
  master.setDisplayPreparationSharing(false); candidate.clearFrame();
  sharing.closedRowBytesZero = sharedGeometry.byteLength === 0;
  sharing.closedShiftBytesZero = sharedBonds.byteLength === 0;
  sharing.closedLayerRowsReleased = master.primitiveLayer.positionValues === null && master.primitiveLayer.fractionalValues === null;
  sharing.closedUploadMirrorsReleased = master.preparedDisplayUploads === null;
  synchronize(); pixels(master); pixels(candidate);
  sharing.reopenedRowsShared = master.primitiveLayer.positionValues === candidate.primitiveLayer.positionValues
    && master.primitiveLayer.fractionalValues === candidate.primitiveLayer.fractionalValues;
  const before = pixels(candidate), descriptor = candidate.preparedPrimitivePreparation, extension = candidate.gl.getExtension('WEBGL_lose_context');
  extension.loseContext(); await wait(() => candidate.contextLost, 'Context loss timed out.');
  extension.restoreContext(); await wait(() => !candidate.contextLost && !candidate.gl.isContextLost(), 'Context recovery timed out.');
  const context = { pixelDifferences: differences(before, pixels(candidate)), preparationRetained: candidate.preparedPrimitivePreparation === descriptor };
  master.clearFrame(); oracle.clearFrame(); candidate.clearFrame();
  document.getElementById('close-file').click(); await wait(() => main.frame === null && second.frame === null, 'Source close timed out.');
  ui.sourceClosed = main.preparedDisplayUploads === null && second.preparedDisplaySnapshot === null;
  return { production, scenarios, sharing, context, ui };

  function cameraNear(left, right) {
    for (const key of ['position', 'direction', 'up']) if (left[key]?.some((value, index) => Math.abs(value - right[key][index]) > 1e-9)) return false;
    for (const key of ['fieldWidth', 'fov', 'roll', 'distance']) if (Math.abs(left[key] - right[key]) > 1e-9) return false;
    return left.projectionMode === right.projectionMode;
  }
}
