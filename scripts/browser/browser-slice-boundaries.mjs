import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Full production controls with a crystal whose open Z direction contains
// vacuum. Atom-boundary cuts must start at the atoms, not at the distant box.
const root = resolve(import.meta.dirname, '../..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-slice-boundary-fixture-'));
const artifacts = resolve(tmpdir(), 'alloyview-slice-boundaries');
await mkdir(artifacts, { recursive: true });
const points = [];
for (const x of [2, 5, 8]) for (const y of [4, 10, 16]) for (const z of [8, 12, 16, 20, 24]) points.push([x, y, z]);
const source = resolve(temporary, 'open-surface.xyz');
await writeFile(source, [String(points.length),
  'Lattice="10 0 0 0 20 0 0 0 30" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T F"',
  ...points.map((point, index) => `Cu ${point.join(' ')} ${index + 1}`), ''].join('\n'));

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
      throw new Error(`${label}: ${await evaluate('JSON.stringify({file:document.getElementById("file-name")?.textContent,trim:document.getElementById("slice-boundary-status")?.textContent,toast:document.getElementById("toast")?.textContent})')}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("add-slab")', 'new Slice controls');
    await evaluate(`(${initializeChecks.toString()})()`);
    async function inputFile(selector, path) {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector });
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    async function click(selector) {
      const target = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Missing '+${JSON.stringify(selector)});
        for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
        element.scrollIntoView({ block: 'nearest' });
        const rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, enabled: !element.disabled, reachable: element === hit || element.contains(hit) || hit?.control === element };
      })()`);
      assert.ok(target.enabled && target.reachable, `${selector} is reachable: ${JSON.stringify(target)}`);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
      await delay(35);
    }
    async function value(id, next) {
      await evaluate(`(() => { const input=document.getElementById(${JSON.stringify(id)}); input.value=${JSON.stringify(next)}; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    }
    const recipe = () => evaluate('sliceBoundaryChecks.exportRecipe()');
    const count = () => evaluate('sliceBoundaryChecks.visibleCount()');
    await inputFile('#file-input', source);
    await waitFor(`document.getElementById('loading').hidden && sliceBoundaryChecks.renderer?.atomCount===${points.length}`, 'source load');
    const category = await evaluate('document.querySelector("[data-tool-button=slice]").closest("[data-tool-category-panel]").dataset.toolCategoryPanel');
    if (await evaluate(`document.getElementById('tool-category-${category}').getAttribute('aria-selected')!=='true'`)) await click(`#tool-category-${category}`);
    await click('[data-tool-button=slice]');
    assert.equal(await count(), 45);
    assert.deepEqual(await evaluate('["a","b","c"].map(axis=>document.getElementById("slice-boundary-"+axis).checked)'), [false, false, true]);

    await click('#add-slab');
    await value('slice-offset', '16');
    await value('slice-thickness', '8');
    const slab = (await recipe()).settings.slices.items[0];
    assert.equal(slab.slab, true); assert.equal(slab.thickness, 8);
    assert.equal(await count(), 27, '8 Å slab keeps Z layers 12, 16 and 20 including both faces');
    assert.equal(await evaluate('sliceBoundaryChecks.uniformVisibleCount()'), 27);
    await click('#slice-enabled');
    assert.equal(await count(), 45);
    await value('slice-boundary-thickness', '4');
    await click('#slice-boundary-apply');
    const saved = await recipe();
    assert.equal(saved.settings.slices.items.length, 2);
    assert.deepEqual(saved.settings.slices.items[0], { ...slab, enabled: false });
    const cut = saved.settings.slices.items[1];
    assert.equal(cut.slab, true); assert.equal(cut.position, 16); assert.equal(cut.thickness, 8);
    assert.equal(await count(), 27, 'cut 4 Å from the actual top and bottom surfaces, ignoring vacuum');
    assert.equal(await evaluate('sliceBoundaryChecks.uniformVisibleCount()'), 27);
    assert.equal(await evaluate('sliceBoundaryChecks.renderer.frame.ids.length'), 45, 'display trim preserves all physical source atoms');

    await value('slice-boundary-thickness', '100');
    await click('#slice-boundary-apply');
    assert.deepEqual((await recipe()).settings.slices, saved.settings.slices, 'oversized thickness commits no partial preset');
    assert.equal(await count(), 27);
    await click('#delete-slice');
    assert.equal(await count(), 45);
    await value('slice-boundary-thickness', '4');
    await value('slice-boundary-reference', 'cell');
    await click('#slice-boundary-apply');
    const cellCut = (await recipe()).settings.slices.items[1];
    assert.equal(cellCut.position, 15); assert.equal(cellCut.thickness, 22);
    assert.equal(await count(), 45, 'cell mode starts at box faces when there is vacuum');

    const recipePath = resolve(temporary, 'boundary-recipe.json');
    await writeFile(recipePath, JSON.stringify(saved));
    await inputFile('#configuration-file', recipePath);
    await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', 'boundary recipe restoration');
    assert.deepEqual((await recipe()).settings.slices, saved.settings.slices);
    assert.equal(await count(), 27);

    await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
    await delay(100);
    const mobile = await evaluate(`(() => {
      const panel=document.getElementById('tool-slice'), ids=['add-slab','slice-boundary-thickness','slice-boundary-reference','slice-boundary-apply','slice-thickness'];
      for(const id of ids) { const element=document.getElementById(id); for(let p=element.parentElement;p;p=p.parentElement) if(p.tagName==='DETAILS') p.open=true; }
      const bounds=panel.getBoundingClientRect();
      return { overflow: panel.scrollWidth-panel.clientWidth, outside: ids.filter(id=>{const r=document.getElementById(id).getBoundingClientRect(); return r.width<=0 || r.left<bounds.left-.5 || r.right>bounds.right+.5;}) };
    })()`);
    assert.deepEqual(mobile, { overflow: 0, outside: [] });
    await evaluate('document.getElementById("slice-boundary-apply").scrollIntoView({block:"center"})');
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    const screenshot = resolve(artifacts, 'boundary-phone.png');
    await writeFile(screenshot, Buffer.from(capture.data, 'base64'));
    assert.equal(await evaluate('sliceBoundaryChecks.renderer.gl.getError()'), 0);
    return { sourceAtoms: 45, slabAtoms: 27, trimmedAtoms: 27, cellReferenceAtoms: 45, sourcePreserved: true,
      restored: true, mobile, screenshot, checks: ['direct slab', 'physical thickness', 'open-axis default',
        'atom extent through vacuum', 'cell-face option', 'picking and shader clipping', 'atomic failure', 'configuration restore', 'mobile layout'] };
  }, { software: true, requireGpu: false });
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
  const checks = window.sliceBoundaryChecks = {}, setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this;
    return setFrame.apply(this, args);
  };
  checks.visibleCount = () => Array.from({ length: checks.renderer.atomCount }, (_, atom) => checks.renderer.isAtomVisible(atom)).filter(Boolean).length;
  checks.uniformVisibleCount = () => {
    const r = checks.renderer, values = r.slicePlaneValues;
    let kept = 0;
    for (let atom = 0; atom < r.atomCount; atom++) {
      let visible = true;
      for (let plane = 0; plane < r.sliceCount; plane++) {
        let distance = 0;
        for (let axis = 0; axis < 3; axis++) distance += values[plane * 4 + axis] * r.displayPositions[atom * 3 + axis];
        if (distance > values[plane * 4 + 3] + 1e-5) { visible = false; break; }
      }
      kept += visible;
    }
    return kept;
  };
  checks.exportRecipe = async () => {
    const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click; let blob;
    URL.createObjectURL = function(value) { blob = value; return createUrl.call(this, value); };
    HTMLAnchorElement.prototype.click = () => {};
    try {
      document.getElementById('export-configuration').click();
      if (!blob) throw new Error('Configuration export produced no Blob.');
      return JSON.parse(await blob.text());
    } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
  };
}
