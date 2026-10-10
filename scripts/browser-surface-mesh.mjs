import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Production UI, real parser, DXA Worker and Wasm kernel. The surface mesh of
// a crystal with a void is compared with the direct kernel, drawn, capped at
// the periodic cell faces, exported and restored from a recipe. The DXA defect
// mesh is extracted on the HEA example, and both analyses are timed on the
// examples. Runs once without and once with cross-origin isolation.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-surface-mesh-'));
const fixture = 'surface-fixture.xyz', fixturePath = resolve(temporary, fixture);
const heaPath = resolve(root, 'examples/hea-fcc-screw.dump'), loopPath = resolve(root, 'examples/Fe_disloc_loop.dump');

// FCC copper, 7 × 7 × 7 cells of 4 Å with a spherical void around the cell
// corner: radius 7 Å in frame 1 and 9 Å in frame 2. The void crosses all six
// periodic faces. Fewer than 2,048 atoms keep the kernel on one thread, so
// results can be compared bit for bit in both hosting modes.
const a = 4, n = 7, length = a * n;
const sites = [];
for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) for (let k = 0; k < n; k += 1) {
  for (const basis of [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]]) sites.push([(i + basis[0]) * a, (j + basis[1]) * a, (k + basis[2]) * a]);
}
const fromCorner = position => Math.hypot(...position.map(value => value - length * Math.round(value / length)));
function xyz(radius, step) {
  const atoms = sites.filter(position => fromCorner(position) > radius);
  return { count: atoms.length, text: [String(atoms.length), `Lattice="${length} 0 0 0 ${length} 0 0 0 ${length}" Properties=species:S:1:pos:R:3 pbc="T T T" Step=${step}`,
    ...atoms.map(position => `Cu ${position.map(value => value.toFixed(6)).join(' ')}`), ''].join('\n') };
}
const frames = [xyz(7, 0), xyz(9, 1)];
await writeFile(fixturePath, frames.map(frame => frame.text).join(''));
const sphere = radius => 4 / 3 * Math.PI * radius ** 3;

async function exercise({ isolated }) {
  return withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 180_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(40);
      }
      throw new Error(`${label}: ${await evaluate(`JSON.stringify({ state: document.getElementById('surface-mesh-state')?.textContent,
        status: document.getElementById('surface-mesh-status')?.textContent, dxa: document.getElementById('dxa-state')?.textContent,
        dxaStatus: document.getElementById('dxa-status')?.textContent, toast: document.getElementById('toast')?.textContent,
        recipe: document.getElementById('configuration-status')?.textContent })`)}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("run-surface-mesh")', 'Surface mesh production page startup');
    await evaluate(`(${initializeChecks.toString()})()`);
    await waitFor('window.meshChecks?.ready', 'Surface mesh check modules');
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
    if (isolated) assert.equal(await evaluate('crossOriginIsolated && typeof SharedArrayBuffer === "function"'), true);
    else assert.equal(await evaluate('crossOriginIsolated'), false);
    async function openFile(path, name, frameCount = 1) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(name)} && meshChecks.renderer?.frame
        && document.getElementById('loading').hidden && !document.getElementById('run-surface-mesh').disabled
        && document.getElementById('frame-label').textContent.endsWith('/ ${frameCount}')`, `${name} import`);
    }
    const change = (id, value, checkbox = false, event = 'change') => evaluate(
      `meshChecks.change(${JSON.stringify(id)}, ${JSON.stringify(value)}, ${checkbox}, ${JSON.stringify(event)})`);
    async function calculated(label, frameIndex) {
      await waitFor(`document.getElementById('surface-mesh-state').textContent === 'Calculated' && meshChecks.renderer.frame.frameIndex === ${frameIndex}
        && meshChecks.shown('surface')?.mesh.vertices === meshChecks.renderer.frame.atomeyeResults?.surfaceMesh?.result.vertices`, label);
      return evaluate('meshChecks.parity()');
    }

    // --- Surface of a crystal with a void at the cell corner.
    await openFile(fixturePath, fixture, 2);
    await evaluate('meshChecks.showTool("surfaceMesh")');
    assert.equal(await evaluate('document.getElementById("surface-mesh-radius").value'), '3.4', 'Cu suggestion');
    assert.match(await evaluate('document.getElementById("surface-mesh-radius-help").textContent'), /Suggested: 3\.40 Å = 1\.15 × the 2\.95 Å/);
    await change('surface-mesh-radius', '3.5');
    await change('surface-mesh-smoothing', '0');
    await evaluate('document.getElementById("run-surface-mesh").click()');
    const first = await calculated('First surface', 0);
    assert.equal(first.identical, true, `Worker arrays must equal the direct kernel (${first.mismatch})`);
    assert.equal(first.workerCount, 1);
    assert.equal(first.sharedMemory, isolated);
    assert.deepEqual(first.counts, [1, 1, 1, 1], 'one solid, one void, one surface sheet');
    assert.ok(first.voidVolume > sphere(7) && first.voidVolume < sphere(7 + a / 2), `void volume ${first.voidVolume}`);
    assert.ok(Math.abs(first.filledVolume + first.voidVolume - length ** 3) < 1e-6, 'solid plus void fills the cell');
    assert.equal(first.inputCount, frames[0].count);
    const view = await evaluate(`({ summary: document.getElementById('surface-mesh-summary').textContent,
      rows: Array.from(document.querySelectorAll('#surface-mesh-table-body tr'), row => Array.from(row.children, cell => cell.textContent)),
      regions: Array.from(document.querySelectorAll('#surface-mesh-region-body tr'), row => Array.from(row.children, cell => cell.textContent)),
      backend: document.getElementById('surface-mesh-backend').textContent, status: document.getElementById('surface-mesh-status').textContent,
      enabledDot: !document.querySelector('[data-tool-button="surfaceMesh"] .tool-enabled-dot').hidden })`);
    assert.match(view.summary, new RegExp(`triangles · .* vertices · ${frames[0].count.toLocaleString('en-US')} atoms · probe radius 3\\.5 Å · smoothing 0`));
    assert.deepEqual(view.rows.map(row => row[0]), ['Surface area', 'Solid volume', 'Empty volume', 'Void volume', 'Solid regions', 'Empty regions',
      'Surface components', 'Specific surface area']);
    assert.equal(view.rows[5][1], '1 (1 voids)');
    assert.deepEqual(view.regions.map(row => row[1]), ['Solid', 'Void']);
    assert.match(view.backend, /^Wasm CPU · 1 thread$/);
    assert.match(view.status, /^Wasm CPU · 1 thread · \d/);
    assert.equal(view.enabledDot, true);

    // The capped display mesh is closed and encloses exactly the solid volume.
    const geometry = await evaluate('meshChecks.geometry("surface")');
    assert.equal(geometry.openEdges, 0);
    assert.equal(geometry.caps, 6, 'the void crosses every periodic face');
    assert.ok(Math.abs(geometry.volume - first.filledVolume) < 1e-6 * first.filledVolume, `capped volume ${geometry.volume} vs ${first.filledVolume}`);
    assert.ok(Math.abs(geometry.surfaceArea - first.surfaceArea) < 1e-9 * first.surfaceArea);

    // Pixels: green outside, blue caps, red interior. A capped solid shows no interior.
    for (const [id, color] of [['surface-mesh-color', '#00ff00'], ['surface-mesh-cap-color', '#0000ff'], ['surface-mesh-interior-color', '#ff0000']]) await change(id, color, false, 'input');
    const capped = await evaluate('meshChecks.pixels({ png: true })');
    assert.ok(capped.blue > 20000, `caps in the PNG export (${JSON.stringify(capped)})`);
    assert.ok(capped.green > 300, `void surface seen through the cap openings (${JSON.stringify(capped)})`);
    assert.equal(capped.red, 0, 'no interior face of a closed solid is visible');
    const cappedOblique = await evaluate('meshChecks.pixels({ oblique: true })');
    assert.ok(cappedOblique.blue > 20000 && cappedOblique.red === 0, `closed from an oblique view too (${JSON.stringify(cappedOblique)})`);
    await change('surface-mesh-caps', false, true);
    const uncapped = await evaluate('meshChecks.pixels({ oblique: true })');
    assert.equal(uncapped.blue, 0);
    assert.ok(uncapped.green > 300, JSON.stringify(uncapped));
    assert.ok(uncapped.red > 300, `the open cut shows the inside of the solid (${JSON.stringify(uncapped)})`);
    assert.equal(await evaluate('meshChecks.geometry("surface").openEdges > 0'), true);
    await change('surface-mesh-caps', true, true);
    await change('surface-mesh-visible', false, true);
    assert.deepEqual(await evaluate('meshChecks.pixels()'), { red: 0, green: 0, blue: 0, other: 0 });
    await change('surface-mesh-visible', true, true);
    const sliced = await evaluate(`meshChecks.pixels({ slices: [{ normal: [1, 0, 0], position: ${length / 2} }] })`);
    assert.ok(sliced.blue > 0.3 * capped.blue && sliced.blue < 0.7 * capped.blue, `a slice clips the mesh (${JSON.stringify(sliced)})`);
    // Seen from an oblique direction, one of the two halves shows its cut-open inside.
    const cut = [];
    for (const normal of [[1, 0, 0], [-1, 0, 0]]) {
      cut.push(await evaluate(`meshChecks.pixels({ oblique: true, slices: [{ normal: ${JSON.stringify(normal)}, position: ${normal[0] * length / 2} }] })`));
    }
    assert.ok(Math.max(...cut.map(image => image.red)) > 300, `a slice exposes the interior color (${JSON.stringify(cut)})`);
    // Half-transparent: the caps blend with the black background and what lies behind them.
    await change('surface-mesh-opacity', '0.5', false, 'input');
    const translucent = await evaluate('meshChecks.pixels({ sample: true })');
    assert.ok(translucent.center[2] > 40 && translucent.center[2] < 0.8 * capped.sample[2], `blended cap color ${translucent.center} vs ${capped.sample}`);
    const translucentMatch = await evaluate('meshChecks.screenMatch()');
    assert.ok(translucentMatch.changedFraction < 0.002, `translucent offscreen export matches the view: ${JSON.stringify(translucentMatch)}`);
    await change('surface-mesh-opacity', '1', false, 'input');
    const opaqueMatch = await evaluate('meshChecks.screenMatch()');
    assert.ok(opaqueMatch.changedFraction < 0.002, `offscreen export matches the view: ${JSON.stringify(opaqueMatch)}`);
    assert.equal(await evaluate('meshChecks.jobs'), 1, 'display choices never recalculate');

    // Periodic display origin: the void moves to the cell center, the caps become full faces.
    for (const axis of ['a', 'b', 'c']) await change(`display-origin-${axis}`, '0.5');
    await waitFor('meshChecks.renderer.periodicOrigin.every(value => value === 0.5)', 'Periodic origin');
    const centered = await evaluate('meshChecks.geometry("surface")');
    assert.equal(centered.openEdges, 0);
    assert.equal(centered.caps, 6);
    assert.ok(Math.abs(centered.capArea - 6 * length * length) < 1e-6, `full cap faces ${centered.capArea}`);
    assert.equal(centered.triangles - centered.capTriangles, first.faceCount, 'no surface face is cut any more');
    assert.ok(Math.abs(centered.volume - first.filledVolume) < 1e-6 * first.filledVolume);
    const centeredPixels = await evaluate('meshChecks.pixels()');
    assert.ok(centeredPixels.blue > capped.blue && centeredPixels.green === 0 && centeredPixels.red === 0, `closed block ${JSON.stringify(centeredPixels)}`);
    // Dragging the crystal previews the committed pieces without caps, then rebuilds.
    const dragging = await evaluate('meshChecks.dragPixels([0.25, 0, 0])');
    assert.equal(dragging.blue, 0, 'caps of the committed cut are hidden during a drag');
    assert.ok(dragging.red + dragging.green > 300, `the shifted surface is previewed (${JSON.stringify(dragging)})`);
    assert.deepEqual(await evaluate('meshChecks.pixels()'), centeredPixels, 'ending the drag restores the committed display');
    for (const axis of ['a', 'b', 'c']) await change(`display-origin-${axis}`, '0');
    await waitFor('meshChecks.renderer.periodicOrigin.every(value => value === 0)', 'Periodic origin reset');
    assert.equal((await evaluate('meshChecks.geometry("surface")')).triangles, geometry.triangles);

    // Display replication draws every copy and caps only the outer faces.
    await evaluate('meshChecks.showTool("replicate")');
    await change('replicate-a', '2');
    await evaluate('document.getElementById("apply-replicate").click()');
    await waitFor('meshChecks.renderer.replicas.length === 2', 'Display replication');
    const replicated = await evaluate('meshChecks.drawn()');
    assert.equal(replicated.triangles, 2 * (geometry.triangles - geometry.capTriangles) + geometry.capTriangles + geometry.capTrianglesOffA,
      'two surface copies, caps on the outer a faces and on b and c of both copies');
    assert.ok(replicated.bounds[1][0] > 2 * length - 1e-6);
    await evaluate('document.getElementById("reset-replicate").click()');
    await waitFor('meshChecks.renderer.replicas.length === 1', 'Replication reset');
    await evaluate('meshChecks.showTool("surfaceMesh")');

    // The second view shows the same mesh with the same style.
    await change('compare-view', true, true);
    await waitFor(`meshChecks.comparison?.surfaceMeshes?.().length === 1 && meshChecks.comparison.surfaceMeshes()[0].mesh === meshChecks.shown('surface').mesh
      && meshChecks.comparison.surfaceMeshes()[0].options.color === '#00ff00'`, 'Second view mesh');
    await evaluate('document.getElementById("surface-mesh-results").scrollIntoView({ block: "center" })');
    const { data: desktop } = await call('Page.captureScreenshot', { format: 'png' });
    const desktopScreenshot = resolve(tmpdir(), `alloyview-surface-mesh-desktop${isolated ? '-isolated' : ''}.png`);
    await writeFile(desktopScreenshot, Buffer.from(desktop, 'base64'));
    await change('compare-view', false, true);

    // Mesh files and the statistics summary.
    const stl = await evaluate('meshChecks.download("export-surface-mesh-stl", "binary")');
    assert.equal(stl.filename, 'surface-fixture-frame-1-surface.stl');
    assert.equal(stl.bytes, 84 + stl.stlFacets * 50);
    assert.ok(stl.stlFacets >= first.faceCount && stl.stlFacets <= geometry.triangles);
    const ply = await evaluate('meshChecks.download("export-surface-mesh-ply", "binary")');
    assert.match(ply.head, /^ply\nformat binary_little_endian 1\.0\n/);
    assert.match(ply.head, new RegExp(`element face ${geometry.triangles}\\n`));
    const obj = await evaluate('meshChecks.download("export-surface-mesh-obj")');
    assert.equal(obj.text.split('\n').filter(line => line.startsWith('f ')).length, geometry.triangles);
    assert.ok(obj.text.includes('g surface') && obj.text.includes('g caps'));
    await evaluate('meshChecks.showTool("statistics")');
    const csv = await evaluate('meshChecks.download("export-statistics-summary")');
    const rows = csv.text.trim().split(/\r\n/).map(line => line.split(',')).filter(row => row[3] === 'surfaceMesh');
    const metric = name => rows.find(row => row[4] === name);
    assert.equal(Number(metric('surface_area')[6]), first.surfaceArea);
    assert.equal(Number(metric('void_volume')[6]), first.voidVolume);
    assert.equal(Number(metric('void_region_count')[6]), 1);
    assert.deepEqual(rows.filter(row => row[4] === 'region_volume').map(row => row[5]), ['filled 0', 'void 1']);
    await evaluate('meshChecks.showTool("surfaceMesh")');

    // Frame changes recalculate; a visited frame redraws from its cache.
    await change('frame-slider', '1', false, 'input');
    const second = await calculated('Second frame', 1);
    assert.equal(second.identical, true, second.mismatch);
    assert.ok(second.voidVolume > sphere(9) && second.voidVolume < sphere(9 + a / 2) && second.voidVolume > first.voidVolume);
    assert.equal(await evaluate('meshChecks.jobs'), 2);
    await change('frame-slider', '0', false, 'input');
    assert.equal((await calculated('Back to the first frame', 0)).voidVolume, first.voidVolume);
    assert.equal(await evaluate('meshChecks.jobs'), 2, 'the cached frame needs no new job');

    // A recipe stores the settings and replays the analysis after import.
    const recipe = await evaluate('meshChecks.exportRecipe()');
    assert.deepEqual(recipe.settings.extensions.surfaceMesh, { enabled: true, radius: 3.5, smoothingLevel: 0, atoms: 'all', selectionGroupId: null,
      visible: true, caps: true, opacity: 1, color: '#00ff00', interiorColor: '#ff0000', capColor: '#0000ff' });
    Object.assign(recipe.settings.extensions.surfaceMesh, { smoothingLevel: 6, opacity: 0.8, caps: false, color: '#c9d4e3' });
    await evaluate(`meshChecks.importRecipe(${JSON.stringify(JSON.stringify(recipe))})`);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'Surface recipe restoration');
    const restored = await calculated('Restored recipe', 0);
    assert.equal(restored.identical, true, restored.mismatch);
    assert.equal(restored.smoothingLevel, 6);
    assert.ok(restored.surfaceArea < first.surfaceArea, 'smoothing reduces the area');
    assert.equal(restored.filledVolume, first.filledVolume);
    assert.deepEqual(await evaluate(`[document.getElementById('surface-mesh-smoothing').value, document.getElementById('surface-mesh-opacity').value,
      document.getElementById('surface-mesh-caps').checked, meshChecks.shown('surface').options.color, meshChecks.shown('surface').options.opacity]`),
    ['6', '0.8', false, '#c9d4e3', 0.8]);
    await change('surface-mesh-caps', true, true);
    await change('surface-mesh-opacity', '1', false, 'input');

    // Phone layout keeps the controls inside the viewport.
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('meshChecks.showTool("surfaceMesh"); document.getElementById("run-surface-mesh").scrollIntoView({ block: "center" })');
    await delay(150);
    const mobile = await evaluate(`(() => ['surface-mesh-radius', 'surface-mesh-smoothing', 'surface-mesh-selection', 'run-surface-mesh', 'surface-mesh-color',
      'surface-mesh-opacity', 'export-surface-mesh-stl', 'export-surface-mesh-obj'].map(id => {
      const box = document.getElementById(id).getBoundingClientRect();
      return { id, width: box.width, fits: box.left >= 0 && box.right <= innerWidth };
    }))()`);
    assert.ok(mobile.every(item => item.fits && item.width > 0), JSON.stringify(mobile));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const { data: phone } = await call('Page.captureScreenshot', { format: 'png' });
    const phoneScreenshot = resolve(tmpdir(), `alloyview-surface-mesh-mobile${isolated ? '-isolated' : ''}.png`);
    await writeFile(phoneScreenshot, Buffer.from(phone, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    await evaluate('document.getElementById("cancel-surface-mesh").click()');
    await waitFor(`document.getElementById('surface-mesh-state').textContent === 'Not calculated' && !meshChecks.shown('surface')
      && !meshChecks.renderer.frame.atomeyeResults?.surfaceMesh`, 'Cancel clears the surface');

    // --- HEA example (28,800 atoms, free in x and y): surface and DXA defect mesh.
    await openFile(heaPath, 'hea-fcc-screw.dump');
    await evaluate('meshChecks.showTool("surfaceMesh")');
    const heaRadius = await evaluate('document.getElementById("surface-mesh-radius").value');
    await evaluate('document.getElementById("run-surface-mesh").click()');
    await waitFor(`document.getElementById('surface-mesh-state').textContent === 'Calculated' && meshChecks.shown('surface')`, 'HEA surface');
    const hea = await evaluate('meshChecks.timeSurface()', { timeoutMs: 600_000 });
    assert.equal(hea.faceCount, hea.direct.faceCount);
    assert.ok(Math.abs(hea.surfaceArea - hea.direct.surfaceArea) < 1e-9 * hea.direct.surfaceArea, 'threads do not change the surface area');
    assert.ok(Math.abs(hea.filledVolume - hea.direct.filledVolume) < 1e-9 * hea.direct.filledVolume);
    assert.deepEqual(hea.counts, [1, 1, 0, 1], 'one block with free surfaces: exterior space, no void');
    if (isolated) assert.ok(hea.workerCount > 1, 'isolated hosts tessellate on several threads');
    else assert.equal(hea.workerCount, 1);
    await evaluate('document.getElementById("cancel-surface-mesh").click()');

    await evaluate('meshChecks.showTool("dxa")');
    await change('dxa-lattice', 'fcc');
    await evaluate('document.getElementById("run-dxa").click()');
    await waitFor('document.getElementById("dxa-state").textContent === "Calculated" && meshChecks.lastDxa?.result', 'DXA without the defect mesh', 600_000);
    const plain = await evaluate('meshChecks.dxaSummary()');
    assert.equal(plain.hasMesh, false);
    assert.equal(plain.requested, false, 'the default request carries no mesh option');
    assert.equal(await evaluate('Boolean(meshChecks.shown("dxaDefect"))'), false);
    assert.equal(await evaluate('document.getElementById("dxa-defect-mesh-controls").hidden'), true);
    await change('dxa-defect-mesh', true, true);
    await waitFor('document.getElementById("dxa-state").textContent === "Calculated" && meshChecks.lastDxa?.result?.defectMesh && meshChecks.shown("dxaDefect")',
      'DXA with the defect mesh', 600_000);
    const withMesh = await evaluate('meshChecks.dxaSummary()');
    assert.deepEqual(withMesh.requested, { smoothingLevel: 8 });
    assert.deepEqual([withMesh.mesh.vertexCount, withMesh.mesh.triangleCount], [2192, 4384]);
    assert.equal(withMesh.reverse, true);
    assert.equal(withMesh.segments, plain.segments);
    // One global thread is deterministic: the lines must be bit-identical.
    // Several threads tessellate in a varying order, so two extractions of
    // the same frame differ in the last digits with or without the mesh.
    if (!isolated) assert.equal(withMesh.pointsDigest, plain.pointsDigest, 'identical line points with and without the mesh');
    assert.ok(Math.abs(withMesh.totalLength - plain.totalLength) <= (isolated ? 1e-3 : 0) * plain.totalLength, 'the mesh does not change the lines');
    assert.match(await evaluate('document.getElementById("dxa-defect-mesh-summary").textContent'), /^4,384 triangles · .* Å² surface area · smoothing 8$/);
    for (const [id, color] of [['dxa-defect-mesh-color', '#00ff00'], ['dxa-defect-mesh-interior-color', '#ff0000'], ['dxa-defect-mesh-cap-color', '#0000ff']]) await change(id, color, false, 'input');
    const defectPixels = await evaluate('meshChecks.pixels({ hideLines: true })');
    assert.ok(defectPixels.red + defectPixels.green > 20000, `defect mesh pixels (${JSON.stringify(defectPixels)})`);
    await change('dxa-defect-mesh-visible', false, true);
    const hiddenPixels = await evaluate('meshChecks.pixels({ hideLines: true })');
    assert.equal(hiddenPixels.red + hiddenPixels.green + hiddenPixels.blue, 0);
    await change('dxa-defect-mesh-visible', true, true);
    const defectStl = await evaluate('meshChecks.download("export-dxa-defect-mesh-stl", "binary")');
    assert.equal(defectStl.filename, 'hea-fcc-screw-frame-1-dxa-defect-mesh.stl');
    assert.equal(defectStl.bytes, 84 + defectStl.stlFacets * 50);
    assert.ok(defectStl.stlFacets >= 4384);
    const dxaRecipe = await evaluate('meshChecks.exportRecipe()');
    assert.deepEqual(dxaRecipe.settings.extensions.dxa.defectMesh, { enabled: true, smoothingLevel: 8, visible: true, caps: true, opacity: 1,
      color: '#00ff00', interiorColor: '#ff0000', capColor: '#0000ff' });
    assert.equal(Object.hasOwn(dxaRecipe.settings.extensions, 'surfaceMesh'), true, 'the edited surface style is kept in the recipe');
    await evaluate('document.getElementById("dxa-results").scrollIntoView({ block: "end" })');
    const { data: defect } = await call('Page.captureScreenshot', { format: 'png' });
    const defectScreenshot = resolve(tmpdir(), `alloyview-dxa-defect-mesh${isolated ? '-isolated' : ''}.png`);
    await writeFile(defectScreenshot, Buffer.from(defect, 'base64'));
    // Switching the mesh off hides it without another extraction.
    const extractions = await evaluate('meshChecks.dxaJobs');
    await change('dxa-defect-mesh', false, true);
    assert.equal(await evaluate('Boolean(meshChecks.shown("dxaDefect"))'), false);
    assert.equal(await evaluate('meshChecks.dxaJobs'), extractions);
    const heaDxa = await evaluate('meshChecks.timeDxa("fcc")', { timeoutMs: 900_000 });
    await evaluate('document.getElementById("cancel-dxa").click()');

    // --- Fe loop (60,229 atoms, fully periodic, triclinic): no surface; timings.
    await openFile(loopPath, 'Fe_disloc_loop.dump');
    await evaluate('meshChecks.showTool("surfaceMesh")');
    await evaluate('document.getElementById("run-surface-mesh").click()');
    await waitFor(`document.getElementById('surface-mesh-state').textContent === 'Calculated'`, 'Fe loop surface', 600_000);
    assert.match(await evaluate('document.getElementById("surface-mesh-display-status").textContent'), /fills the whole cell/);
    const loop = await evaluate('meshChecks.timeSurface()', { timeoutMs: 900_000 });
    assert.deepEqual([loop.faceCount, ...loop.counts], [0, 1, 0, 0, 0]);
    assert.ok(Math.abs(loop.filledVolume - loop.cellVolume) < 1e-9 * loop.cellVolume, 'the periodic crystal is solid everywhere');
    const loopDxa = await evaluate('meshChecks.timeDxa("bcc")', { timeoutMs: 900_000 });
    return { adapter, isolated, sharedMemory: first.sharedMemory, fixture: { faces: first.faceCount, voidVolume: first.voidVolume, surfaceArea: first.surfaceArea,
      pixels: { capped, cappedOblique, uncapped, sliced, cut, centered: centeredPixels, dragging }, geometry, screenMatch: [opaqueMatch, translucentMatch] },
    restored: { smoothingLevel: restored.smoothingLevel, surfaceArea: restored.surfaceArea },
    hea: { radius: heaRadius, surface: hea, defectMesh: withMesh.mesh, defectPixels, dxa: heaDxa }, loop: { surface: loop, dxa: loopDxa }, mobile,
    screenshots: [desktopScreenshot, phoneScreenshot, defectScreenshot] };
  }, { software: useSoftwareAdapter(true), isolated, requireGpu: false });
}

try {
  const reports = [];
  for (const isolated of [false, true]) reports.push(await exercise({ isolated }));
  assert.equal(reports[0].sharedMemory, false);
  assert.equal(reports[1].sharedMemory, true);
  // One thread everywhere: both hosting modes give the same fixture surface.
  assert.equal(reports[0].fixture.surfaceArea, reports[1].fixture.surfaceArea);
  assert.equal(reports[0].fixture.voidVolume, reports[1].fixture.voidVolume);
  console.log(JSON.stringify(reports, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { DxaClient }, { calculateSurfaceMesh }, geometryModule] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/dxa-client.js', app)),
    import(new URL('./analysis/surface-mesh.js', app)), import(new URL('./render/surface-mesh-geometry.js', app)),
  ]);
  const { displayMeshArea, displayMeshOpenEdges, displayMeshVolume } = geometryModule;
  const checks = window.meshChecks = { jobs: 0, dxaJobs: 0 };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this; else checks.comparison = this;
    return setFrame.apply(this, args);
  };
  const surface = DxaClient.prototype.surface;
  DxaClient.prototype.surface = async function(frame, parameters, options) {
    checks.client = this;
    if (!checks.timing) checks.jobs += 1;
    const result = await surface.call(this, frame, parameters, options);
    if (!checks.timing) checks.lastSurface = { frame, parameters, mask: options?.mask ?? null, result };
    return result;
  };
  const analyze = DxaClient.prototype.analyze;
  DxaClient.prototype.analyze = async function(frame, parameters, options) {
    checks.client = this;
    if (!checks.timing) checks.dxaJobs += 1;
    const result = await analyze.call(this, frame, parameters, options);
    if (!checks.timing) checks.lastDxa = { frame, parameters, requested: options?.defectMesh ?? false, result };
    return result;
  };
  checks.change = (id, value, checkbox = false, event = 'change') => {
    const input = document.getElementById(id);
    if (checkbox) input.checked = value; else input.value = String(value);
    input.dispatchEvent(new Event(event, { bubbles: true }));
  };
  checks.showTool = name => {
    if (document.querySelector(`[data-tool-panel="${name}"]`).hidden) document.querySelector(`[data-tool-button="${name}"]`).click();
  };
  checks.shown = id => checks.renderer?.surfaceMeshes().find(entry => entry.id === id) ?? null;
  const ARRAYS = ['vertices', 'triangles', 'vertexAtoms', 'faceRegions', 'regionVolumes', 'regionAreas', 'regionFilled', 'regionExterior'];
  const SCALARS = ['surfaceArea', 'filledVolume', 'emptyVolume', 'voidVolume', 'filledRegionCount', 'emptyRegionCount', 'voidRegionCount', 'surfaceComponentCount', 'inputCount'];
  checks.parity = async () => {
    const frame = checks.renderer.frame, { parameters, mask, result } = checks.lastSurface;
    if (checks.lastSurface.frame !== frame && frame.atomeyeResults?.surfaceMesh?.result !== result) {
      // A cached frame: compare the cached result instead.
      checks.lastSurface = { frame, parameters: frame.atomeyeResults.surfaceMesh.result.parameters, mask: null, result: frame.atomeyeResults.surfaceMesh.result };
    }
    const current = checks.lastSurface.result;
    const direct = await calculateSurfaceMesh(frame, checks.lastSurface.parameters, { mask: checks.lastSurface.mask, workerCount: 1 });
    let mismatch = null;
    for (const name of ARRAYS) {
      if (current[name].constructor !== direct[name].constructor || current[name].length !== direct[name].length) { mismatch = `${name} shape`; break; }
      for (let index = 0; index < direct[name].length; index += 1) if (!Object.is(current[name][index], direct[name][index])) { mismatch = `${name}[${index}]`; break; }
      if (mismatch) break;
    }
    for (const name of SCALARS) if (!mismatch && !Object.is(current[name], direct[name])) mismatch = name;
    if (frame.atomeyeResults?.surfaceMesh?.result !== current) mismatch ??= 'published result';
    return { identical: mismatch === null, mismatch, workerCount: current.workerCount, sharedMemory: current.sharedMemory, faceCount: current.faceCount,
      surfaceArea: current.surfaceArea, filledVolume: current.filledVolume, voidVolume: current.voidVolume, inputCount: current.inputCount,
      smoothingLevel: current.smoothingLevel, counts: [current.filledRegionCount, current.emptyRegionCount, current.voidRegionCount, current.surfaceComponentCount] };
  };
  checks.geometry = id => {
    const display = checks.shown(id).display, capTriangles = display.capIndexCount / 3;
    // Cap triangles that are not on the two a faces, for the replication count.
    const offA = display.capRanges.filter(range => range.axis !== 0).reduce((sum, range) => sum + range.count / 3, 0);
    return { openEdges: displayMeshOpenEdges(display), volume: displayMeshVolume(display), caps: display.capRanges.length,
      surfaceArea: displayMeshArea(display, 0, display.surfaceIndexCount), capArea: displayMeshArea(display, display.surfaceIndexCount, display.capIndexCount),
      triangles: display.indices.length / 3, capTriangles, capTrianglesOffA: offA };
  };
  checks.drawn = () => {
    const renderer = checks.renderer;
    renderer.render();
    const bounds = renderer.getDisplayBounds();
    return { triangles: renderer.surfaceMeshLayer.renderedTriangleCount, bounds: [bounds.minimum, bounds.maximum] };
  };
  const classify = canvas => {
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, counts = { red: 0, green: 0, blue: 0, other: 0 };
    for (let pixel = 0; pixel < image.length; pixel += 4) {
      const r = image[pixel], g = image[pixel + 1], b = image[pixel + 2];
      if (r > 50 && r > g + 30 && r > b + 30) counts.red += 1;
      else if (g > 50 && g > r + 30 && g > b + 30) counts.green += 1;
      else if (b > 50 && b > r + 30 && b > g + 30) counts.blue += 1;
      else if (r + g + b > 60) counts.other += 1;
    }
    return counts;
  };
  /** Mesh pixels of an exported image: atoms, cell and lines hidden on black. */
  checks.pixels = async ({ png = false, slices = null, sample = false, hideLines = false, oblique = false } = {}) => {
    const renderer = checks.renderer, visibility = renderer.visibility, background = renderer.background, cell = renderer.cellVisible;
    const network = renderer.dislocationNetwork, lineOptions = renderer.dislocationOptions;
    renderer.setVisibility(new Uint8Array(renderer.atomCount));
    renderer.setBackground('#000000'); renderer.setCellVisible(false); renderer.setView('front');
    if (oblique) renderer.resetCamera();
    if (hideLines && network) renderer.setDislocationNetwork(network, { ...lineOptions, enabled: false });
    if (slices) renderer.setSlices(slices);
    try {
      let canvas;
      if (png) {
        const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
        let resolveBlob; const received = new Promise(resolve => { resolveBlob = resolve; });
        URL.createObjectURL = function(blob) { if (blob.type === 'image/png') resolveBlob(blob); return createUrl.call(this, blob); };
        HTMLAnchorElement.prototype.click = () => {};
        try {
          document.getElementById('export-png').click();
          const bitmap = await createImageBitmap(await received);
          canvas = document.createElement('canvas');
          canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
        } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
      } else canvas = renderer.captureImage({ includeBackground: true });
      const counts = classify(canvas);
      if (png || sample) {
        // The image center lies on the front cap.
        const center = Array.from(canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3));
        if (png) counts.sample = center; else counts.center = center;
      }
      return counts;
    } finally {
      if (slices) renderer.setSlices([]);
      if (hideLines && network) renderer.setDislocationNetwork(network, lineOptions);
      renderer.setBackground(`#${Array.from(background, value => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`);
      renderer.setCellVisible(cell); renderer.setVisibility(visibility);
    }
  };
  checks.dragPixels = async shift => {
    checks.renderer.setCrystalDragShift(shift);
    try { return await checks.pixels(); } finally { checks.renderer.setCrystalDragShift(null); }
  };
  // An offscreen render at the canvas size must look like the view.
  checks.screenMatch = () => {
    const renderer = checks.renderer; renderer.render();
    const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const resolution = { mode: 'custom', width: renderer.canvas.width, height: renderer.canvas.height };
    const screen = pixels(renderer.captureImage({ includeAxes: true })), offscreen = pixels(renderer.captureImage({ includeAxes: true, resolution }));
    let changed = 0, maxDifference = 0;
    for (let pixel = 0; pixel < screen.length / 4; pixel += 1) {
      let difference = 0;
      for (let channel = 0; channel < 4; channel += 1) difference = Math.max(difference, Math.abs(screen[pixel * 4 + channel] - offscreen[pixel * 4 + channel]));
      if (difference > 5) changed += 1;
      maxDifference = Math.max(maxDifference, difference);
    }
    return { width: resolution.width, height: resolution.height, maxDifference, changedFraction: changed / (screen.length / 4), opacity: checks.shown('surface').options.opacity };
  };
  const median = values => values.toSorted((first, second) => first - second)[values.length >> 1];
  /** Repeated Worker runs on the displayed frame, and one direct single-thread run. */
  checks.timeSurface = async () => {
    const frame = checks.renderer.frame, { parameters, result } = checks.lastSurface;
    checks.timing = true;
    const runs = [];
    let last = result;
    try {
      for (let run = 0; run < 3; run += 1) {
        const startedAt = performance.now();
        last = await checks.client.surface(frame, parameters);
        runs.push({ totalMs: Math.round(performance.now() - startedAt), kernelMs: Math.round(last.elapsedMs), threads: last.workerCount });
      }
    } finally { checks.timing = false; }
    const startedAt = performance.now();
    const direct = await calculateSurfaceMesh(frame, parameters, { workerCount: 1 });
    const directMs = Math.round(performance.now() - startedAt);
    const entry = checks.shown('surface');
    return { atoms: frame.ids.length, radius: parameters.radius, smoothingLevel: parameters.smoothingLevel, firstMs: Math.round(result.elapsedMs), runs,
      medianMs: median(runs.map(run => run.totalMs)), workerCount: last.workerCount, sharedMemory: last.sharedMemory, directMainThreadMs: directMs,
      faceCount: last.faceCount, vertexCount: last.vertexCount, surfaceArea: last.surfaceArea, filledVolume: last.filledVolume, emptyVolume: last.emptyVolume,
      cellVolume: last.cellVolume, counts: [last.filledRegionCount, last.emptyRegionCount, last.voidRegionCount, last.surfaceComponentCount],
      displayBuildMs: entry ? Math.round(entry.buildMs * 10) / 10 : null, displayTriangles: entry ? entry.display.indices.length / 3 : 0,
      stages: last.stageTimings.map(stage => [stage.phase, Math.round(stage.elapsedMs)]),
      direct: { faceCount: direct.faceCount, surfaceArea: direct.surfaceArea, filledVolume: direct.filledVolume } };
  };
  /** DXA on the displayed frame with the defect mesh off and on, alternating. */
  checks.timeDxa = async lattice => {
    const frame = checks.renderer.frame, off = [], on = [];
    checks.timing = true;
    let mesh, threads, stage;
    try {
      for (let run = 0; run < 3; run += 1) {
        let startedAt = performance.now();
        const plain = await checks.client.analyze(frame, { lattice });
        off.push(Math.round(performance.now() - startedAt));
        startedAt = performance.now();
        const meshed = await checks.client.analyze(frame, { lattice }, { defectMesh: true });
        on.push(Math.round(performance.now() - startedAt));
        mesh = meshed.defectMesh; threads = meshed.nativeWorkerCount;
        stage = meshed.stageTimings.find(entry => /defect mesh/i.test(entry.phase))?.elapsedMs;
        if (plain.segments.length !== meshed.segments.length) throw new Error('The defect mesh changed the number of dislocation segments.');
      }
    } finally { checks.timing = false; }
    return { atoms: frame.ids.length, threads, offMs: off, onMs: on, medianOffMs: median(off), medianOnMs: median(on),
      meshStageMs: stage === undefined ? null : Math.round(stage * 10) / 10, triangles: mesh.triangleCount, vertices: mesh.vertexCount, surfaceArea: mesh.surfaceArea };
  };
  checks.dxaSummary = () => {
    const { result, requested } = checks.lastDxa, shown = checks.shown('dxaDefect');
    let digest = 0x811c9dc5;
    const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
    for (const segment of result.segments) for (const value of segment.points) {
      view.setFloat64(0, value);
      for (const byte of bytes) digest = Math.imul(digest ^ byte, 0x01000193);
    }
    return { requested, hasMesh: Boolean(result.defectMesh), segments: result.segments.length, totalLength: result.totalLength, pointsDigest: digest >>> 0,
      reverse: shown?.mesh.reverse ?? null, mesh: result.defectMesh ? { vertexCount: result.defectMesh.vertexCount, triangleCount: result.defectMesh.triangleCount,
        surfaceArea: result.defectMesh.surfaceArea, smoothingLevel: result.defectMesh.smoothingLevel, goodCellCount: result.defectMesh.goodCellCount,
        defectCellCount: result.defectMesh.defectCellCount } : null };
  };
  checks.download = async (id, kind = 'text') => {
    const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    let saved, filename;
    URL.createObjectURL = function(blob) { saved = blob; return createUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = function() { filename = this.download; };
    try {
      document.getElementById(id).click();
      const deadline = Date.now() + 30_000;
      while (!saved && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (!saved) throw new Error(`${id} did not produce a download: ${document.getElementById('toast')?.textContent}`);
      if (kind === 'text') return { text: await saved.text(), filename };
      const buffer = await saved.arrayBuffer();
      return { filename, bytes: buffer.byteLength, stlFacets: buffer.byteLength >= 84 ? new DataView(buffer).getUint32(80, true) : 0,
        head: new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(400, buffer.byteLength))) };
    } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
  checks.exportRecipe = async () => JSON.parse((await checks.download('export-configuration')).text);
  checks.importRecipe = text => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], 'surface-recipe.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.ready = true;
}
