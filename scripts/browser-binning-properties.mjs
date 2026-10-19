import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Real app callbacks, external-property Worker, and trajectory reads. The
// controller tests separately cover cancellation while an average is running.
const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
  const origin = await evaluate('location.origin');
  await call('Page.navigate', { url: `${origin}/AlloyView/${production ? 'dist/' : ''}index.html` });
  async function wait(expression, label) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(25);
    }
    throw new Error(`${label}: ${await evaluate(`JSON.stringify({ state:document.getElementById('binning-state')?.textContent,
      summary:document.getElementById('binning-summary')?.textContent, status:document.getElementById('binning-status')?.textContent,
      readout:document.querySelector('#binning-chart output')?.textContent,
      expression:document.getElementById('expression-property-error')?.textContent,
      saveDisabled:document.getElementById('save-expression-property')?.disabled,
      external:document.getElementById('external-property-status')?.textContent, toast:document.getElementById('toast')?.textContent })`)}`);
  }
  await wait('document.readyState === "complete" && document.getElementById("run-binning")', 'Page startup');
  await evaluate(`(${installChecks.toString()})()`);
  await evaluate('binningPropertyChecks.open()');
  await wait(`binningPropertyChecks.renderer?.frame.ids.length === 3 && document.getElementById('frame-count').textContent === '3'
    && document.getElementById('loading').hidden && !document.getElementById('external-property-file').disabled`, 'Trajectory import');
  async function importColumn(filename, column, scale) {
    await evaluate(`binningPropertyChecks.importColumn(${JSON.stringify(filename)}, ${JSON.stringify(column)}, ${scale})`);
    await wait(`!document.getElementById('external-property-file').disabled
      && document.getElementById('external-property-status').textContent.includes(${JSON.stringify(`from ${filename}.`)})`, `${filename} import`);
  }
  async function calculated(column, value, average = true) {
    await wait(`document.getElementById('binning-state').textContent === 'Calculated'
      && document.querySelector('#binning-chart output')?.textContent.includes(${JSON.stringify(`Mean ${column} ${value} · 3 atoms`)})
      && document.getElementById('binning-summary').textContent.includes(${JSON.stringify(average ? 'averaged over 3 frames' : 'frame 1')})`, `${column} = ${value}`);
  }
  await importColumn('energy.csv', 'energy', 10);
  await evaluate(`document.querySelector('[data-tool-button="binning"]').click();
    binningPropertyChecks.change('binning-bins-1', '1');
    binningPropertyChecks.change('binning-quantity', 'property:energy');
    binningPropertyChecks.change('binning-average-frames', true);
    document.getElementById('run-binning').click()`);
  await calculated('energy', 20);
  const initialRequests = await evaluate('binningPropertyChecks.requests');
  await evaluate('binningPropertyChecks.warmWorker = binningPropertyChecks.client.worker');

  await importColumn('unrelated.csv', 'unused', 1);
  await evaluate('document.getElementById("run-binning").click()');
  await calculated('energy', 20);
  assert.equal(await evaluate('binningPropertyChecks.requests'), initialRequests, 'Unrelated imports retain the completed average');
  await evaluate('binningPropertyChecks.removeFile("energy.csv")');
  await wait(`document.getElementById('export-binning').disabled && document.getElementById('binning-state').textContent !== 'Calculated'`, 'Removal clears stale result and export');
  await importColumn('energy-replacement.csv', 'energy', 100);
  await calculated('energy', 200);
  await evaluate(`document.querySelector('[data-external-property-name="energy"]').value = 'temperature';
    document.querySelector('[data-external-rename="energy"]').click()`);
  await wait(`document.getElementById('external-property-status').textContent.startsWith('Renamed')`, 'Column rename');
  await evaluate('binningPropertyChecks.change("binning-quantity", "property:temperature")');
  await calculated('temperature', 200);

  // Computed properties are supported for the displayed frame. A transitive
  // consumer must refresh when its input recipe changes.
  await evaluate(`binningPropertyChecks.change('binning-average-frames', false);
    document.getElementById('tool-category-modification').click();
    document.querySelector('[data-tool-button="expressions"]').click();
    binningPropertyChecks.expression('scaled', 'temperature * 2')`);
  await wait(`binningPropertyChecks.renderer.frame.properties.some(property => property.name === 'scaled')`, 'First computed property');
  await evaluate(`binningPropertyChecks.expression('chained', 'scaled + 1')`);
  await wait(`Array.from(document.getElementById('binning-quantity').options).some(option => option.value === 'property:chained')`, 'Computed quantity becomes available');
  await evaluate(`binningPropertyChecks.change('binning-quantity', 'property:chained')`);
  await calculated('chained', 401, false);
  await evaluate(`document.querySelector('[data-expression-property="scaled"] .expression-property-actions button:nth-last-child(2)').click();
    binningPropertyChecks.expression('scaled', 'temperature * 3')`);
  await calculated('chained', 601, false);
  assert.equal(await evaluate('Boolean(binningPropertyChecks.warmWorker) && binningPropertyChecks.client.worker === binningPropertyChecks.warmWorker'), true,
    'Property edits retain the prewarmed binning Worker');
  assert.equal(await evaluate('binningPropertyChecks.renderer.frame.frameIndex'), 0, 'Averages keep the displayed frame');
  return { result: 'passed', tree: production ? 'production' : 'source', frames: 3,
    stages: ['import', 'unrelated cache reuse', 'remove', 'replace', 'rename', 'transitive computed edit'], preservedWarmWorker: true };
}, { requireGpu: false });
console.log(JSON.stringify(report, null, 2));

async function installChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { SpatialBinningClient }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/binning-client.js', app)),
  ]);
  const checks = window.binningPropertyChecks = { requests: 0 };
  const setFrame = WebGLRenderer.prototype.setFrame, accumulate = SpatialBinningClient.prototype.accumulate;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this;
    return setFrame.apply(this, args);
  };
  SpatialBinningClient.prototype.accumulate = function(...args) {
    checks.client = this; checks.requests++;
    return accumulate.apply(this, args);
  };
  const upload = (id, filename, text) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], filename));
    const input = document.getElementById(id); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.change = (id, value) => {
    const input = document.getElementById(id);
    if (typeof value === 'boolean') input.checked = value; else input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.open = () => upload('file-input', 'binning-properties.xyz', Array.from({ length: 3 }, (_, frame) => [
    '3', `Lattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T" Step=${frame}`,
    ...[1, 2, 3].map(id => `Fe ${id * 2} 3 4 ${id}`), '',
  ].join('\n')).join(''));
  checks.importColumn = (filename, column, scale) => upload('external-property-file', filename,
    `id,${column}\n${[1, 2, 3].map(id => `${id},${id * scale}`).join('\n')}\n`);
  checks.removeFile = filename => [...document.querySelectorAll('.external-property-file-group')]
    .find(group => group.querySelector('strong').textContent === filename).querySelector('[data-external-remove-file]').click();
  checks.expression = (name, expression) => {
    document.getElementById('expression-property-name').value = name;
    document.getElementById('expression-property-text').value = expression;
    document.getElementById('save-expression-property').click();
  };
}
