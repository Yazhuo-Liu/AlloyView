import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Exercise the real app callbacks, external-attribute Worker and CPU cluster
// pool. Instrumentation only observes requests and published frame results.
const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
  const origin = await evaluate('location.origin');
  await call('Page.navigate', { url: `${origin}/AlloyView/${production ? 'dist/' : ''}index.html` });
  async function wait(expression, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(30);
    }
    throw new Error(`${label}: ${await evaluate(`JSON.stringify({
      clusters: document.getElementById('clusters-state')?.textContent,
      status: document.getElementById('clusters-status')?.textContent,
      external: document.getElementById('external-property-status')?.textContent,
      toast: document.getElementById('toast')?.textContent,
      requests: window.clusterPropertyChecks?.requests.length,
      result: window.clusterPropertyChecks?.read() })`)}`);
  }
  await wait('document.readyState === "complete" && document.getElementById("run-clusters")', 'Page startup');
  await evaluate(`(${installChecks.toString()})()`);
  await evaluate('clusterPropertyChecks.open()');
  await wait(`clusterPropertyChecks.renderer?.frame.ids.length === 10 && document.getElementById('loading').hidden
    && !document.getElementById('external-property-file').disabled`, 'Structure import');
  assert.equal(await evaluate('Boolean(clusterPropertyChecks.mass())'), false, 'The structure has no native mass column');

  async function importColumn(filename, column, firstValue = 1) {
    await evaluate(`clusterPropertyChecks.importColumn(${JSON.stringify(filename)}, ${JSON.stringify(column)}, ${firstValue})`);
    await wait(`!document.getElementById('external-property-file').disabled
      && document.getElementById('external-property-status').textContent.includes(${JSON.stringify(`from ${filename}.`)})`, `${filename} import`);
  }
  async function removeFile(filename) {
    await evaluate(`clusterPropertyChecks.removeFile(${JSON.stringify(filename)})`);
    await wait(`document.getElementById('external-property-status').textContent === ${JSON.stringify(`Removed attributes from ${filename}.`)}`,
      `${filename} removal`);
  }
  async function calculated(weighting, center, label) {
    // File/display preparation stores fractional coordinates at Float32 precision.
    await wait(`document.getElementById('clusters-state').textContent === 'Calculated'
      && clusterPropertyChecks.read()?.weighting === ${JSON.stringify(weighting)}
      && Math.abs(clusterPropertyChecks.read().centerX - ${center}) < 1e-6`, label);
    return evaluate('clusterPropertyChecks.read()');
  }

  await importColumn('mass-original.csv', 'mass');
  await evaluate(`document.querySelector('[data-tool-button="clusters"]').click();
    document.getElementById('clusters-cutoff').value = '1.05';
    document.getElementById('run-clusters').click()`);
  const initial = await calculated('mass', 3.5, 'Initial mass-weighted clusters');
  assert.equal(initial.requests, 1);
  await evaluate('clusterPropertyChecks.warmWorkers = [...clusterPropertyChecks.pool.slots].map(slot => slot.worker)');

  await importColumn('energy.csv', 'energy');
  assert.equal(await evaluate('clusterPropertyChecks.requests.length'), 1, 'An unrelated import must not start another analysis');
  await removeFile('energy.csv');
  await evaluate('document.getElementById("run-clusters").click()');
  const reused = await calculated('mass', 3.5, 'Unrelated edits preserve the cache');
  assert.equal(reused.requests, 1, 'Manual Run must also reuse the unchanged mass dependency');

  await removeFile('mass-original.csv');
  const removed = await calculated('uniform', 3.5, 'Mass removal automatically restores equal weights');
  assert.equal(removed.requests, 2);
  await importColumn('mass-replacement.csv', 'mass', 100);
  const replacement = await calculated('mass', 120 / 105, 'New masses automatically replace the old centers');
  assert.equal(replacement.requests, 3);
  assert.ok(Math.abs(replacement.rg - 0.7095078297976829) < 1e-6);
  assert.deepEqual(replacement.table, ['6', '0.70951', '1.1429, 20, 20']);
  await evaluate('document.getElementById("run-clusters").click()');
  const manual = await calculated('mass', 120 / 105, 'Manual Run keeps the new result');
  assert.equal(manual.requests, 3);
  assert.equal(await evaluate(`clusterPropertyChecks.warmWorkers.length > 0
    && clusterPropertyChecks.warmWorkers.every(worker => [...clusterPropertyChecks.pool.slots].some(slot => slot.worker === worker))`), true,
  'Updating masses retains the warmed CPU Workers');
  return { result: 'passed', tree: production ? 'production' : 'source', initial, reused, removed, replacement, manual,
    preservedWarmWorkers: true };
}, { requireGpu: false });
console.log(JSON.stringify(report, null, 2));

async function installChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { AnalysisPool }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)),
  ]);
  const checks = window.clusterPropertyChecks = { requests: [] };
  const setFrame = WebGLRenderer.prototype.setFrame, analyze = AnalysisPool.prototype.analyze;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this;
    return setFrame.apply(this, args);
  };
  AnalysisPool.prototype.analyze = function(frame, parameters, ...args) {
    if (parameters.kind === 'clusters') { checks.pool = this; checks.frame = frame; checks.requests.push(parameters); }
    return analyze.call(this, frame, parameters, ...args);
  };
  const upload = (id, filename, text) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], filename));
    const input = document.getElementById(id); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.open = () => upload('file-input', 'cluster-mass.xyz', ['10',
    'Lattice="40 0 0 0 40 0 0 0 40" Properties=species:S:1:pos:R:3:id:I:1 pbc="F F F"',
    ...Array.from({ length: 10 }, (_, atom) => `Fe ${1 + atom + (atom >= 6 ? 4 : 0)} 20 20 ${101 + atom}`), '',
  ].join('\n'));
  checks.importColumn = (filename, column, firstValue) => upload('external-property-file', filename,
    `id,${column}\n${[...checks.renderer.frame.ids].map((id, index) => `${id},${index ? 1 : firstValue}`).join('\n')}\n`);
  checks.removeFile = filename => {
    const group = [...document.querySelectorAll('.external-property-file-group')]
      .find(element => element.querySelector('strong').textContent === filename);
    if (!group) throw new Error(`Missing external file: ${filename}`);
    group.querySelector('[data-external-remove-file]').click();
  };
  checks.mass = () => checks.renderer.frame.properties.find(property => property.name === 'mass');
  checks.read = () => {
    const result = checks.frame?.atomeyeResults?.clusters?.result;
    return result ? { weighting: result.weighting, centerX: result.centers[0], rg: result.radiiOfGyration[0],
      requests: checks.requests.length,
      table: [...document.querySelectorAll('#clusters-table-body tr:first-child td')].slice(1).map(cell => cell.textContent) } : null;
  };
}
