import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Real source/production UI, retained structure Worker, physical replication,
// a named group, line generation, second view, PNG and configuration replay.
const source = process.argv.includes('--source');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-copy-trajectories-'));
const path = resolve(directory, 'changing-cell-copy-paths.dump');
const count = 6, rows = [];
const positions = [];
for (let frame = 0; frame < count; frame++) {
  const origin = [1 + frame * .11, -2 + frame * .05, .5 - frame * .03];
  const Lx = 10 + frame * .2, Ly = 8 + frame * .1, Lz = 7 + frame * .05, xy = -1.4, xz = .9, yz = .6;
  const continuous = Array.from({ length: 3 }, (_, atom) => [.83 + frame * .16 + atom * .07, .17 - frame * .12 + atom * .13, .4 + atom * .12]);
  const h = [Lx, 0, 0, xy, Ly, 0, xz, yz, Lz];
  positions.push(continuous.map(point => origin.map((value, axis) => value + point.reduce((sum, coordinate, direction) => sum + coordinate * h[direction * 3 + axis], 0))));
  const atoms = continuous.map((point, atom) => `${atom + 1} 1 ${point.map(value => value - Math.floor(value)).join(' ')} ${point.map(Math.floor).join(' ')}`);
  if (frame % 2) atoms.reverse();
  rows.push(['ITEM: TIMESTEP', frame, 'ITEM: NUMBER OF ATOMS', 3, 'ITEM: BOX BOUNDS xy xz yz pp pp pp',
    `${origin[0] + Math.min(0, xy, xz, xy + xz)} ${origin[0] + Lx + Math.max(0, xy, xz, xy + xz)} ${xy}`,
    `${origin[1] + Math.min(0, yz)} ${origin[1] + Ly + Math.max(0, yz)} ${xz}`,
    `${origin[2]} ${origin[2] + Lz} ${yz}`, 'ITEM: ATOMS id type xs ys zs ix iy iz', ...atoms, ''].join('\n'));
}
await writeFile(path, rows.join(''));

async function exercise(isolated) {
  return withWebGpuBrowser(async ({ evaluate, call }) => {
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/${source ? '' : 'dist/'}index.html` });
    const wait = async (condition, label) => {
      const deadline = Date.now() + 60_000;
      while (!await evaluate(condition)) {
        if (Date.now() > deadline) throw new Error(`${label}: ${await evaluate(`JSON.stringify({ status: document.getElementById('trajectory-lines-status')?.textContent,
          toast: document.getElementById('toast')?.textContent, configuration: document.getElementById('configuration-status')?.textContent,
          frame: copyChecks?.renderer?.frame?.frameIndex, replicated: copyChecks?.renderer?.frame?.physicalReplication })`)}`);
        await delay(30);
      }
    };
    await wait('document.readyState === "complete" && document.getElementById("generate-trajectory-lines")', 'Page startup');
    await evaluate(`(${initialize.toString()})()`);
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
    const document = (await call('DOM.getDocument')).root;
    const input = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
    await call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path] });
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change", {bubbles:true}))');
    await wait(`copyChecks.renderer?.frame?.ids.length === 3 && document.getElementById('frame-count').textContent === '${count}'
      && document.getElementById('loading').hidden`, 'Trajectory open');
    await evaluate(`copyChecks.show('replicate'); copyChecks.change('replicate-a', 2); copyChecks.change('replicate-b', 2);
      copyChecks.change('replicate-atoms', true, true); document.getElementById('apply-replicate').click()`);
    await wait('copyChecks.renderer.frame.ids.length === 12 && document.getElementById("loading").hidden', 'Physical replication');
    const ids = [1, '@AlloyView:copy:1:0:0:1', '@AlloyView:copy:1:1:0:2'];
    await evaluate(`copyChecks.show('selectionGroups'); document.getElementById('add-selection-group').click();
      copyChecks.change('selection-group-name', 'Physical copy paths'); document.getElementById('selection-group-ids').value = ${JSON.stringify(ids.join(' '))};
      document.getElementById('apply-selection-group-ids').click()`);
    await wait('document.getElementById("selection-group-count").textContent.includes("3")', 'Copy selection group');
    await evaluate(`copyChecks.show('trajectory'); const source = document.getElementById('trajectory-lines-source');
      copyChecks.change(source.id, [...source.options].find(option => option.value.startsWith('group:')).value);
      copyChecks.change('trajectory-lines-first', 1); copyChecks.change('trajectory-lines-last', ${count});
      document.getElementById('generate-trajectory-lines').click()`);
    await wait('copyChecks.renderer.trajectoryLines?.lineCount === 3', 'Physical-copy paths');
    const result = await evaluate(`({ vertices: [...copyChecks.renderer.trajectoryLines.vertices], ids: copyChecks.renderer.trajectoryLines.lineAtomIds,
      missing: copyChecks.renderer.trajectoryLines.missingCount, requests: copyChecks.requests })`);
    assert.deepEqual(result.ids, ids);
    assert.equal(result.missing, 0);
    const offsets = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];
    let maximumError = 0;
    for (let line = 0; line < ids.length; line++) for (let frame = 0; frame < count; frame++) for (let axis = 0; axis < 3; axis++) {
      const h = [10 + frame * .2, 0, 0, -1.4, 8 + frame * .1, 0, .9, .6, 7 + frame * .05];
      const expected = positions[frame][line === 2 ? 1 : 0][axis] + offsets[line].reduce((sum, value, direction) => sum + value * h[direction * 3 + axis], 0);
      maximumError = Math.max(maximumError, Math.abs(result.vertices[(line * count + frame) * 4 + axis] - expected));
    }
    assert.ok(maximumError < 4e-6, `source/copy Cartesian error ${maximumError}`);
    assert.deepEqual(result.requests[0].physicalReplication, { repetitions: [2, 2, 1] });
    await evaluate(`copyChecks.change('frame-slider', 3)`);
    await wait('copyChecks.renderer.frame.frameIndex === 3 && document.getElementById("loading").hidden', 'Changing-cell navigation');
    assert.deepEqual(await evaluate('[...copyChecks.renderer.trajectoryLines.vertices]'), result.vertices);
    await evaluate(`copyChecks.show('display'); copyChecks.change('compare-view', true, true)`);
    await wait('copyChecks.second?.trajectoryLines === copyChecks.renderer.trajectoryLines', 'Second-view copy paths');
    const pixels = await evaluate('copyChecks.imageDifference()');
    assert.ok(pixels > 0, `PNG line pixels ${pixels}`);
    const recipe = await evaluate('copyChecks.recipe()');
    assert.equal(recipe.settings.replicateAtoms, true);
    assert.deepEqual(recipe.settings.selectionGroups.groups.find(group => group.name === 'Physical copy paths').atomIds, ids);
    await evaluate(`document.getElementById('reset-replicate').click()`);
    await wait('copyChecks.renderer.frame.ids.length === 3 && !copyChecks.renderer.trajectoryLines && document.getElementById("loading").hidden', 'Physical reset clears copy paths');
    await evaluate(`copyChecks.restore(${JSON.stringify(JSON.stringify(recipe))})`);
    await wait('document.getElementById("configuration-status").textContent.includes("restored") && copyChecks.renderer.trajectoryLines?.lineCount === 3', 'Copy-path configuration replay');
    assert.deepEqual(await evaluate('[...copyChecks.renderer.trajectoryLines.vertices]'), result.vertices);
    assert.equal(await evaluate('copyChecks.renderer.gl.getError()'), 0);
    return { isolated, source, paths: result.ids.length, points: result.vertices.length / 4, maximumCartesianError: maximumError,
      imageChangedPixels: pixels, configurationRestored: true, requestBytes: JSON.stringify(result.requests[0]).length };
  }, { requireGpu: false, isolated });
}

async function initialize() {
  const base = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { StructureWorkerClient }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', base)), import(new URL('./data/structure-worker-client.js', base))]);
  const checks = window.copyChecks = { requests: [] };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this; else checks.second = this;
    return setFrame.apply(this, args);
  };
  const generate = StructureWorkerClient.prototype.trajectoryLines;
  StructureWorkerClient.prototype.trajectoryLines = function(request, options) { checks.requests.push(structuredClone(request)); return generate.call(this, request, options); };
  checks.change = (id, value, checkbox = false) => {
    const input = document.getElementById(id); if (checkbox) input.checked = value; else input.value = String(value);
    input.dispatchEvent(new Event(['frame-slider', 'selection-group-name'].includes(id) ? 'input' : 'change', { bubbles: true }));
    if (id === 'frame-slider') input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.show = name => { if (document.querySelector(`[data-tool-panel="${name}"]`).hidden) document.querySelector(`[data-tool-button="${name}"]`).click(); };
  checks.imageDifference = () => {
    const renderer = checks.renderer;
    const capture = () => { const canvas = renderer.captureImage(); return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; };
    const first = capture(); checks.change('trajectory-lines-visible', false, true); const second = capture(); checks.change('trajectory-lines-visible', true, true);
    let pixels = 0; for (let index = 0; index < first.length; index += 4) if ([0, 1, 2].some(channel => Math.abs(first[index + channel] - second[index + channel]) > 12)) pixels++;
    return pixels;
  };
  checks.recipe = async () => {
    const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    let blob;
    URL.createObjectURL = value => { blob = value; return create.call(URL, value); }; HTMLAnchorElement.prototype.click = () => {};
    try {
      document.getElementById('export-configuration').click();
      const deadline = Date.now() + 30_000;
      while (!blob) { if (Date.now() > deadline) throw new Error('Configuration download timeout'); await new Promise(done => setTimeout(done, 20)); }
      return JSON.parse(await blob.text());
    } finally { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; }
  };
  checks.restore = text => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], 'copy-paths.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
}

try {
  const reports = [];
  for (const isolated of [false, true]) reports.push(await exercise(isolated));
  console.log(JSON.stringify(reports, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
