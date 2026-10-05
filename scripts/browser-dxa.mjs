import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fccScrewFrame } from '../tests/helpers/dislocations.js';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-dxa-browser-'));
const screw = fccScrewFrame(), perfect = fccScrewFrame({ screw: false });
// XYZ intentionally goes through the application's Float32 coordinate parser.
// Delaunay tie ordering can then add a small wiggle to the extracted curve;
// its arc length need not equal the ideal straight periodic winding exactly.
const lengthTolerance = 2e-3;
function xyz(frame, step = 0) {
  const lines = [String(frame.ids.length), `Lattice="${Array.from(frame.cell.vectors).join(' ')}" Properties=species:S:1:pos:R:3:id:I:1 pbc="F F T" Step=${step}`];
  for (let atom = 0; atom < frame.ids.length; atom++) lines.push(`Ni ${Array.from(frame.positions.subarray(atom * 3, atom * 3 + 3)).join(' ')} ${atom + 1}`);
  return `${lines.join('\n')}\n`;
}
const source = resolve(directory, 'fcc-screw.xyz'), trajectory = resolve(directory, 'fcc-screw-trajectory.xyz');
await writeFile(source, xyz(screw));
await writeFile(trajectory, xyz(screw) + xyz(perfect, 1));

try {
  const report = await withWebGpuBrowser(async ({ evaluate, call, adapter }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(40);
      }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({dxa:document.getElementById("dxa-status")?.textContent,toast:document.getElementById("toast")?.textContent,recipe:document.getElementById("configuration-status")?.textContent})')}`);
    }
    await waitFor('document.readyState === "complete" && document.querySelector("[data-tool-button=dxa]")', 'Production application startup');
    await evaluate(`(async () => {
      const app = document.querySelector('script[type=module][src]').src;
      const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
      const { DxaClient } = await import(new URL('./analysis/dxa-client.js', app));
      window.dxaChecks = { analyses: 0, rows: [], workers: [], progress: [], cancelAtNativeStage: false };
      const checks = window.dxaChecks, setFrame = WebGLRenderer.prototype.setFrame;
      WebGLRenderer.prototype.setFrame = function(...args) {
        if (this.canvas.id === 'viewport') checks.renderer = this;
        return setFrame.apply(this, args);
      };
      const analyze = DxaClient.prototype.analyze;
      DxaClient.prototype.analyze = function(frame, parameters, options = {}) {
        checks.analyses++; checks.progress = []; checks.client = this;
        return analyze.call(this, frame, parameters, { ...options, onProgress: progress => {
          checks.progress.push(progress); options.onProgress?.(progress);
          if (checks.cancelAtNativeStage && progress.completedStages > 0 && progress.completedStages < 12) {
            checks.cancelAtNativeStage = false; checks.cancelStage = progress;
            document.getElementById('cancel-dxa').click();
          }
        } }).then(result => { checks.rows.push({ atoms: frame.ids.length, segments: result.segments.length,
          length: result.totalLength, engine: result.engine, backend: result.backend, elapsedMs: result.elapsedMs,
          gpuFallback: result.gpuFallback }); return result; });
      };
      const ensureWorker = DxaClient.prototype.ensureWorker, tracked = new WeakSet();
      DxaClient.prototype.ensureWorker = function() {
        const worker = ensureWorker.call(this);
        if (!tracked.has(worker)) {
          tracked.add(worker); const row = { terminated: false }; checks.workers.push(row);
          const terminate = worker.terminate.bind(worker);
          worker.terminate = () => { row.terminated = true; return terminate(); };
        }
        return worker;
      };
      checks.showTool = name => { if (document.querySelector('[data-tool-panel="' + name + '"]').hidden)
        document.querySelector('[data-tool-button="' + name + '"]').click(); };
      checks.change = (id, value, checkbox = false) => {
        const input = document.getElementById(id); if (checkbox) input.checked = value; else input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      checks.pixelCount = () => {
        const renderer = checks.renderer, gl = renderer.gl;
        renderer.render(performance.now(), { trackStats: false });
        const pixels = new Uint8Array(renderer.canvas.width * renderer.canvas.height * 4);
        gl.readPixels(0, 0, renderer.canvas.width, renderer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let colored = 0;
        for (let pixel = 0; pixel < pixels.length; pixel += 4) if (pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2] > 20) colored++;
        return { colored, error: gl.getError() };
      };
    })()`);
    async function openFile(path) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor('window.dxaChecks.renderer?.frame && !document.getElementById("run-dxa").disabled', 'XYZ source import');
    }
    const extract = async () => {
      await evaluate('dxaChecks.showTool("dxa"); document.getElementById("run-dxa").click()');
      await waitFor('document.getElementById("dxa-state").textContent === "Calculated"', 'Complete native DXA extraction');
    };
    await openFile(source); await extract();
    const initial = await evaluate(`(() => {
      const r = dxaChecks.renderer, n = r.dislocationNetwork;
      return { isolated: crossOriginIsolated, atoms: r.frame.ids.length, segments: n.segments.length, length: n.totalLength,
        family: n.segments[0]?.familyId, burgersMagnitude: Math.hypot(...n.segments[0].spatialBurgersVector),
        engine: n.engine, backend: n.backend, gpuFallback: n.gpuFallback, status: document.getElementById('dxa-status').textContent,
        elapsedMs: n.elapsedMs, stageEvents: dxaChecks.progress.length };
    })()`);
    assert.equal(initial.isolated, false, 'DXA must work under GitHub Pages without COOP/COEP.');
    assert.equal(initial.atoms, screw.ids.length); assert.equal(initial.segments, 1); assert.equal(initial.family, 'perfect');
    assert.ok(Math.abs(initial.length - screw.expected.totalLength) < lengthTolerance, JSON.stringify({ initial, expected: screw.expected }));
    assert.ok(Math.abs(initial.burgersMagnitude - screw.expected.burgersMagnitude) < 1e-3, JSON.stringify({ initial, expected: screw.expected }));
    assert.equal(initial.backend, 'hybrid'); assert.equal(initial.gpuFallback, false);
    assert.match(initial.status, /WebGPU/); assert.doesNotMatch(initial.status, /fallback/);

    const appearance = await evaluate(`(() => {
      const checks = dxaChecks, renderer = checks.renderer, atoms = renderer.atomColors, before = checks.analyses;
      const row = document.getElementById('dxa-families').children[0];
      const visible = row.querySelector('input[type=checkbox]'), color = row.querySelector('input[type=color]');
      color.value = '#ff00ff'; color.dispatchEvent(new Event('input', { bubbles: true }));
      checks.change('dxa-line-radius', '0.6');
      renderer.setBackground('#000000'); renderer.setCellVisible(false); renderer.setSelected(-1);
      renderer.setVisibility(new Uint8Array(renderer.frame.ids.length)); renderer.setView('front');
      const shown = checks.pixelCount();
      visible.checked = false; visible.dispatchEvent(new Event('change', { bubbles: true }));
      const hidden = checks.pixelCount();
      visible.checked = true; visible.dispatchEvent(new Event('change', { bubbles: true }));
      const canvas = renderer.captureImage({ includeBackground: true, includeAxes: false });
      const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let exportedPixels = 0;
      for (let pixel = 0; pixel < image.length; pixel += 4) if (image[pixel] + image[pixel + 1] + image[pixel + 2] > 20) exportedPixels++;
      return { shown, hidden, exportedPixels, png: canvas.toDataURL('image/png').startsWith('data:image/png;base64,'),
        atomColorsUnchanged: renderer.atomColors === atoms, analysesUnchanged: checks.analyses === before,
        radius: renderer.dislocationOptions.radius, color: renderer.dislocationOptions.familyColors.perfect };
    })()`);
    assert.equal(appearance.shown.error, 0); assert.equal(appearance.hidden.error, 0);
    assert.ok(appearance.shown.colored > 0, 'Dislocation cylinders must draw when every atom is hidden.');
    assert.equal(appearance.hidden.colored, 0, 'Family visibility must hide its actual drawn pixels.');
    assert.ok(appearance.exportedPixels > 0); assert.equal(appearance.png, true);
    assert.equal(appearance.analysesUnchanged, true); assert.equal(appearance.atomColorsUnchanged, true); assert.equal(appearance.radius, .6);

    const recipe = await evaluate(`(async () => {
      const createUrl = URL.createObjectURL, anchorClick = HTMLAnchorElement.prototype.click; let saved;
      URL.createObjectURL = function(blob) { saved = blob; return createUrl.call(this, blob); };
      HTMLAnchorElement.prototype.click = () => {};
      try { document.getElementById('export-configuration').click();
        if (!saved) throw new Error('DXA recipe export failed: ' + document.getElementById('toast').textContent);
        dxaChecks.recipe = await saved.text(); return JSON.parse(dxaChecks.recipe);
      } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = anchorClick; }
    })()`);
    assert.equal(recipe.settings.extensions.dxa.enabled, true); assert.equal(recipe.settings.extensions.dxa.radius, .6);
    assert.equal(recipe.settings.extensions.dxa.familyColors.find(entry => entry.family === 'perfect').color, '#ff00ff');
    assert.equal(JSON.stringify(recipe).includes('burgersVector'), false);
    await evaluate(`document.getElementById('cancel-dxa').click(); (() => {
      const transfer = new DataTransfer(); transfer.items.add(new File([dxaChecks.recipe], 'dxa-recipe.json', { type: 'application/json' }));
      const input = document.getElementById('configuration-file'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
    })()`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored") && document.getElementById("dxa-state").textContent === "Calculated"', 'DXA recipe replay');
    const recipeReplay = await evaluate('({analyses:dxaChecks.analyses,radius:dxaChecks.renderer.dislocationOptions.radius,segments:dxaChecks.renderer.dislocationNetwork.segments.length})');
    assert.equal(recipeReplay.analyses, 2); assert.equal(recipeReplay.segments, 1); assert.equal(recipeReplay.radius, .6);

    await evaluate(`document.getElementById('enable-gpu-computing').click(); dxaChecks.showTool('coordination');
      dxaChecks.change('cutoff','2.8'); document.getElementById('run-analysis').click();`);
    await waitFor('document.getElementById("analysis-state").textContent === "Calculated"', 'Independent CPU coordination analysis');
    await evaluate(`dxaChecks.coordination = dxaChecks.renderer.frame.properties.find(p => p.name === 'coordination');
      dxaChecks.showTool('dxa'); dxaChecks.cancelAtNativeStage = true; dxaChecks.change('dxa-point-interval','3');`);
    await waitFor('dxaChecks.cancelStage && document.getElementById("dxa-state").textContent === "Not calculated"', 'Cancel during a native DXA stage');
    const cancellation = await evaluate(`({ nativeStage: dxaChecks.cancelStage, terminated: dxaChecks.workers.at(-1).terminated,
      cleared: dxaChecks.renderer.dislocationNetwork === null,
      coordinationPreserved: dxaChecks.renderer.frame.properties.includes(dxaChecks.coordination),
      coordinationState: document.getElementById('analysis-state').textContent })`);
    assert.equal(cancellation.terminated, true); assert.equal(cancellation.cleared, true);
    assert.equal(cancellation.coordinationPreserved, true); assert.equal(cancellation.coordinationState, 'Calculated');
    await extract();
    const recovery = await evaluate('({workers:dxaChecks.workers.length,segments:dxaChecks.renderer.dislocationNetwork.segments.length,backend:dxaChecks.renderer.dislocationNetwork.backend})');
    assert.equal(recovery.segments, 1); assert.equal(recovery.backend, 'cpu');

    const beforeRepeat = await evaluate('dxaChecks.analyses');
    await evaluate(`dxaChecks.showTool('replicate'); dxaChecks.change('replicate-c','2'); document.getElementById('apply-replicate').click();`);
    await waitFor('dxaChecks.renderer.repetitions[2] === 2', 'Display replication');
    assert.equal(await evaluate('dxaChecks.analyses'), beforeRepeat, 'Display replication must reuse the source DXA result.');
    await evaluate(`dxaChecks.change('replicate-atoms',true,true); document.getElementById('apply-replicate').click();`);
    await waitFor(`dxaChecks.renderer.frame.ids.length === ${screw.ids.length * 2} && document.getElementById('dxa-state').textContent === 'Calculated'`, 'Physical replication and automatic DXA');
    const realRepeat = await evaluate(`(() => {
      const renderer = dxaChecks.renderer, network = renderer.dislocationNetwork, points = network.segments[0].points;
      return { atoms: renderer.frame.ids.length, length: network.totalLength, analyses: dxaChecks.analyses,
        segments: network.segments.length, periodicWindingZ: Math.abs(points.at(-1) - points[2]),
        burgersMagnitude: Math.hypot(...network.segments[0].spatialBurgersVector) };
    })()`);
    assert.ok(realRepeat.analyses > beforeRepeat); assert.equal(realRepeat.segments, 1);
    // Coarsening changed above to exercise cancellation. Compare the exact
    // periodic winding, while allowing its non-straight curve's arc length.
    assert.ok(Math.abs(realRepeat.periodicWindingZ - screw.expected.totalLength * 2) < 1e-3, JSON.stringify(realRepeat));
    assert.ok(realRepeat.length >= realRepeat.periodicWindingZ && realRepeat.length / realRepeat.periodicWindingZ < 1.001, JSON.stringify(realRepeat));
    assert.ok(Math.abs(realRepeat.burgersMagnitude - screw.expected.burgersMagnitude) < 1e-3);

    await openFile(trajectory);
    await waitFor('document.getElementById("frame-label").textContent === "1 / 2"', 'Fresh trajectory import');
    assert.equal(await evaluate('dxaChecks.renderer.dislocationNetwork'), null, 'New source must clear the previous graph.');
    assert.equal(await evaluate('document.getElementById("dxa-state").textContent'), 'Not calculated');
    await extract();
    await evaluate(`dxaChecks.change('frame-slider','1'); document.getElementById('frame-slider').dispatchEvent(new Event('input',{bubbles:true}));`);
    await waitFor('dxaChecks.renderer.frame.frameIndex === 1 && document.getElementById("frame-label").textContent === "2 / 2" && document.getElementById("dxa-state").textContent === "Calculated"', 'Automatic DXA on the next frame');
    const nextFrame = await evaluate('({segments:dxaChecks.renderer.dislocationNetwork.segments.length,length:dxaChecks.renderer.dislocationNetwork.totalLength})');
    assert.equal(nextFrame.segments, 0); assert.equal(nextFrame.length, 0);

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('dxaChecks.showTool("dxa")'); await delay(100);
    const mobile = await evaluate(`(() => {
      const viewport = document.getElementById('viewport').getBoundingClientRect(), panel = document.getElementById('tool-dxa').getBoundingClientRect();
      return { visible: !document.getElementById('tool-dxa').hidden, belowViewport: panel.top >= viewport.bottom - 1,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    })()`);
    assert.equal(mobile.visible, true); assert.equal(mobile.belowViewport, true); assert.equal(mobile.horizontalOverflow, false);
    const final = await evaluate('({rows:dxaChecks.rows,analyses:dxaChecks.analyses,workers:dxaChecks.workers,glError:dxaChecks.renderer.gl.getError()})');
    assert.equal(final.glError, 0);
    return { scope: 'Production DXA Worker, analysis UI, rendering, PNG and recipe replay; no COOP/COEP',
      adapter, fixture: { ...initial, expected: screw.expected, lengthTolerance }, appearance, recipeReplay, cancellation, recovery, realRepeat, nextFrame, mobile, final };
  }, { software: useSoftwareAdapter(true) });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
