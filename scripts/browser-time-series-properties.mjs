import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Exercise the real external-property Worker and app refresh hook. A missing
// series must become readable after import, and rename/removal/replacement
// must never leave old points in subsequent CSV downloads.
const root = resolve(import.meta.dirname, '..'), source = process.argv.includes('--source');
if (!source) assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-series-properties-'));
const count = 4, structure = resolve(directory, 'series-attributes.dump');
await mkdir(resolve(directory, 'original'));
await mkdir(resolve(directory, 'replacement'));
const original = resolve(directory, 'original', 'attributes.csv');
const replacement = resolve(directory, 'replacement', 'attributes.csv');
await Promise.all([
  writeFile(structure, Array.from({ length: count }, (_, frame) => [
    'ITEM: TIMESTEP', frame * 25, 'ITEM: NUMBER OF ATOMS', 3, 'ITEM: BOX BOUNDS pp pp pp',
    '0 10', '0 10', '0 10', 'ITEM: ATOMS id type xs ys zs q',
    ...[1, 2, 3].map((_, atom) => {
      const id = frame % 2 ? 3 - atom : atom + 1;
      return `${id} 1 ${id * .2} .3 .4 ${frame + id}`;
    }), '',
  ].join('\n')).join('')),
  writeFile(original, 'id,energy\n3,30\n1,10\n2,20\n'),
  writeFile(replacement, 'id,energy\n2,200\n3,300\n1,100\n'),
]);

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/${source ? '' : 'dist/'}index.html` });
    async function wait(expression, label) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(25);
      }
      const status = await evaluate(`JSON.stringify({series:document.getElementById('time-series-status')?.textContent,
        external:document.getElementById('external-property-status')?.textContent,toast:document.getElementById('toast')?.textContent})`);
      throw new Error(`${label}: ${status}`);
    }
    await wait('document.readyState==="complete"&&document.querySelector("[data-tool-button=timeSeries]")', 'Application startup');
    await evaluate(`(async () => {
      const app = document.querySelector('script[type=module][src]').src;
      const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
      const checks = window.seriesPropertyChecks = { downloads: [] };
      const setFrame = WebGLRenderer.prototype.setFrame;
      WebGLRenderer.prototype.setFrame = function(...args) {
        if (this.canvas.id === 'viewport') checks.renderer = this;
        return setFrame.apply(this, args);
      };
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob.type.startsWith('text/csv')) checks.downloads.push(blob); return create(blob); };
      HTMLAnchorElement.prototype.click = function() {};
      checks.change = (id, value) => { const field = document.getElementById(id); field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); };
      checks.add = name => { document.getElementById('time-series-attribute').value = name; document.getElementById('add-time-series-attribute').click(); };
      if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click();
    })()`);
    async function upload(selector, path) {
      const { root: dom } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: dom.nodeId, selector });
      assert.ok(nodeId, `${selector} exists`);
      await call('DOM.setFileInputFiles', { nodeId, files: [path] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`);
    }
    async function showTool(name) {
      await evaluate(`(() => {
        const button = document.querySelector('[data-tool-button="${name}"]');
        const category = button.closest('[data-tool-category-panel]').dataset.toolCategoryPanel;
        document.getElementById('tool-category-' + category).click();
        if (!button.classList.contains('active')) button.click();
      })()`);
    }
    async function collect(label) {
      await showTool('timeSeries');
      await evaluate(`document.getElementById('collect-time-series').click()`);
      await wait(`document.getElementById('cancel-time-series').disabled
        && document.getElementById('time-series-status').textContent.includes(' Read ')`, label);
    }
    async function table() {
      const prior = await evaluate('seriesPropertyChecks.downloads.length');
      await evaluate(`document.getElementById('export-time-series').click()`);
      await wait(`seriesPropertyChecks.downloads.length === ${prior + 1}`, 'CSV download');
      const text = await evaluate('seriesPropertyChecks.downloads.at(-1).text()');
      const [columns, ...rows] = text.trim().split('\r\n').map(row => row.split(','));
      assert.equal(rows.length, count);
      return { columns, rows };
    }
    function check(table, names) {
      for (const [name, expected] of Object.entries(names)) {
        const index = table.columns.indexOf(name);
        assert.ok(index >= 0, `${name} is in the exported CSV`);
        assert.deepEqual(table.rows.map(row => row[index]), expected.map(String), `${name} values in every trajectory frame`);
      }
      assert.deepEqual(table.rows.map(row => Number(row[1])), [1, 2, 3, 4]);
      assert.deepEqual(table.rows.map(row => Number(row[2])), [0, 25, 50, 75]);
    }
    const absent = Array(count).fill(''), initialValues = Array(count).fill(20), replacedValues = Array(count).fill(200);
    await upload('#file-input', structure);
    await wait(`seriesPropertyChecks.renderer?.frame?.frameIndex === 0
      && document.getElementById('frame-count').textContent === '${count}' && document.getElementById('loading').hidden`, 'Indexed trajectory');
    await showTool('timeSeries');
    await evaluate(`seriesPropertyChecks.add('mean.energy'); seriesPropertyChecks.add('Mean.q')`);
    await collect('Collect initially absent column');
    check(await table(), { 'mean.energy': absent, 'Mean.q': [2, 3, 4, 5], 'Cell.volume [Å³]': Array(count).fill(1000) });

    await showTool('externalProperties');
    await upload('#external-property-file', original);
    await wait(`document.getElementById('external-property-status').textContent.startsWith('Imported')
      && seriesPropertyChecks.renderer.frame.properties.some(property => property.name === 'energy')`, 'Real external CSV import');
    await collect('Read newly available property');
    check(await table(), { 'mean.energy': initialValues, 'Mean.q': [2, 3, 4, 5] });
    await wait(`document.querySelector('#time-series-chart path[data-series="mean.energy"]')?.dataset.pointCount === '${count}'`, 'Imported series chart');

    await showTool('externalProperties');
    await evaluate(`document.querySelector('[data-external-property-name="energy"]').value = 'temperature';
      document.querySelector('[data-external-rename="energy"]').click()`);
    await wait(`document.getElementById('external-property-status').textContent.startsWith('Renamed')
      && seriesPropertyChecks.renderer.frame.properties.some(property => property.name === 'temperature')`, 'Rename external property');
    await showTool('timeSeries');
    await evaluate(`seriesPropertyChecks.add('Mean.temperature')`);
    await collect('Read renamed property and clear previous name');
    check(await table(), { 'mean.energy': absent, 'Mean.temperature': initialValues });

    await showTool('externalProperties');
    await evaluate(`document.querySelector('[data-external-remove-file]').click()`);
    await wait(`document.getElementById('external-property-status').textContent.startsWith('Removed')
      && !seriesPropertyChecks.renderer.frame.properties.some(property => property.externalImportId)`, 'Remove original CSV');
    await upload('#external-property-file', replacement);
    await wait(`document.getElementById('external-property-status').textContent.startsWith('Imported')
      && seriesPropertyChecks.renderer.frame.properties.some(property => property.name === 'energy' && property.data[0] === 100)`, 'Import replacement CSV');
    await collect('Read replacement property values');
    check(await table(), { 'mean.energy': replacedValues, 'Mean.temperature': absent, 'Mean.q': [2, 3, 4, 5] });

    await showTool('externalProperties');
    await evaluate(`document.querySelector('[data-external-remove-file]').click()`);
    await wait(`document.getElementById('external-property-status').textContent.startsWith('Removed')
      && !seriesPropertyChecks.renderer.frame.properties.some(property => property.externalImportId)`, 'Remove replacement CSV');
    await collect('Read after external CSV removal');
    check(await table(), { 'mean.energy': absent, 'Mean.temperature': absent, 'Mean.q': [2, 3, 4, 5], 'Cell.volume [Å³]': Array(count).fill(1000) });
    assert.equal(await evaluate('seriesPropertyChecks.renderer.frame.frameIndex'), 0, 'Background collection keeps the displayed frame');
    return { result: 'passed', tree: source ? 'source' : 'production', frames: count, stages: ['missing', 'import', 'rename', 'replace', 'remove'] };
  }, { requireGpu: false });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
