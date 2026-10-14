import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const source = process.argv.includes('--source'), root = resolve(import.meta.dirname, '..');
if (!source) assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first, or pass --source.');
// Only completion order is controlled. Released CSP, Coordination and radical
// tessellations use the application's real warmed CPU/GPU Workers and kernels.
const report = await withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
  const origin = await evaluate('location.origin');
  await call('Page.navigate', { url: `${origin}/AlloyView/${source ? '' : 'dist/'}index.html` });
  async function wait(expression, label, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
    throw new Error(`${label}: ${await evaluate(`JSON.stringify({frame:document.getElementById('frame-label')?.textContent,
      csp:document.getElementById('csp-state')?.textContent,voronoi:document.getElementById('voronoi-state')?.textContent,
      status:document.getElementById('voronoi-status')?.textContent,error:document.getElementById('expression-property-error')?.textContent,
      toast:document.getElementById('toast')?.textContent,requests:radicalDependencies?.requests})`)}`);
  }
  await wait('document.readyState === "complete" && document.getElementById("voronoi-radius-property")', 'Page startup');
  const modulePath = await evaluate("new URL('.',document.querySelector('script[type=module][src]').src).pathname.replace(/\\/$/,'')");
  await evaluate(`(${installChecks.toString()})(${JSON.stringify(modulePath)})`);
  const run = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const set = (id, value) => evaluate(`radicalDependencies.change(${JSON.stringify(id)},${JSON.stringify(value)})`);
  const results = [];
  for (const gpu of [false, true]) {
    await evaluate(`radicalDependencies.release(); if((document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true')!==${gpu})document.getElementById('enable-gpu-computing').click();radicalDependencies.open()`);
    await wait('radicalDependencies.renderer?.atomCount===256 && document.getElementById("loading").hidden && document.getElementById("frame-count").textContent==="3"', 'Trajectory ready');
    await set('csp-neighbors', '12'); await run('run-csp');
    await wait('document.getElementById("csp-state").textContent==="Calculated"', 'Real initial CSP');
    for (const [name, expression] of [['base', '1 + CSP'], ['radii', 'sqrt(base)']]) {
      await evaluate(`radicalDependencies.change('expression-property-name',${JSON.stringify(name)});
        radicalDependencies.change('expression-property-unit','Å');radicalDependencies.change('expression-property-text',${JSON.stringify(expression)});
        document.getElementById('save-expression-property').click()`);
      await wait(`radicalDependencies.renderer.frame.properties.some(property=>property.name===${JSON.stringify(name)})`, `${name} computed`);
    }
    await set('voronoi-radical', true); await set('voronoi-radius-source', 'property');
    await set('voronoi-radius-property', 'radii'); if (gpu) await set('voronoi-gpu-kernel', true);
    await run('run-voronoi');
    await wait('document.getElementById("voronoi-state").textContent==="Calculated"', 'Initial radical tessellation');
    const initial = await evaluate('radicalDependencies.read()');
    assert.equal(initial.backend, gpu ? 'gpu' : 'cpu', initial.fallbackReason);
    assert.ok(initial.radii.every(radius => Math.abs(radius - 1) < 1e-12));
    const before = await evaluate('radicalDependencies.requests.filter(request=>request.kind==="voronoi").length');
    await evaluate("radicalDependencies.hold=true;radicalDependencies.warmWorkers=[...radicalDependencies.pool.slots].map(slot=>slot.worker);document.getElementById('frame-next').click()");
    await wait('document.getElementById("voronoi-state").textContent==="Waiting" && radicalDependencies.pending.some(entry=>!entry.signal.aborted)', 'Frame-change dependency wait');
    assert.equal(await evaluate('radicalDependencies.requests.filter(request=>request.kind==="voronoi").length'), before);
    assert.equal(await evaluate('document.getElementById("voronoi-radius-property").value'), 'radii');
    assert.match(await evaluate('document.getElementById("voronoi-status").textContent'), /Central symmetry/);
    assert.equal(await evaluate('document.getElementById("voronoi-results").hidden'), true);
    await set('cutoff', '3'); await run('run-analysis');
    await wait('document.getElementById("analysis-state").textContent==="Calculated"', 'Independent Coordination while radii wait');
    assert.equal(await evaluate('document.getElementById("voronoi-state").textContent'), 'Waiting');
    await set('legend-color-mode', 'builtin:position:x');
    await evaluate('radicalDependencies.release()');
    await wait('document.getElementById("voronoi-state").textContent==="Calculated" && document.getElementById("frame-label").textContent==="2 / 3"', 'Automatic radical replay');
    const resumed = await evaluate('radicalDependencies.read()');
    assert.equal(resumed.backend, gpu ? 'gpu' : 'cpu', resumed.fallbackReason);
    assert.ok(resumed.radii.every(radius => Math.abs(radius - 1) < 1e-12));
    assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'builtin:position:x');
    assert.equal(await evaluate('radicalDependencies.warmWorkers.every(worker=>[...radicalDependencies.pool.slots].some(slot=>slot.worker===worker))'), true, 'the warm CPU pool survives the dependent replay');

    await evaluate("radicalDependencies.hold=true;document.getElementById('frame-next').click()");
    await wait('document.getElementById("voronoi-state").textContent==="Waiting"', 'Waiting on failed producer');
    const failedCount = await evaluate('radicalDependencies.requests.filter(request=>request.kind==="voronoi").length');
    await evaluate("radicalDependencies.release('Controlled radius producer failure')");
    await wait('document.getElementById("csp-state").textContent==="Failed" && document.getElementById("voronoi-state").textContent==="Failed"', 'Terminal producer failure');
    assert.match(await evaluate('document.getElementById("voronoi-status").textContent'), /failed/);
    assert.equal(await evaluate('radicalDependencies.requests.filter(request=>request.kind==="voronoi").length'), failedCount);
    await run('run-csp');
    await wait('document.getElementById("csp-state").textContent==="Calculated" && document.getElementById("voronoi-state").textContent==="Calculated"', 'Valid producer retry resumes radical cells');

    await evaluate("radicalDependencies.hold=true;radicalDependencies.change('csp-neighbors','8')");
    await wait('document.getElementById("voronoi-state").textContent==="Waiting"', 'Same-frame producer edit waits despite existing owned values');
    assert.equal(await evaluate('radicalDependencies.renderer.frame.properties.some(property=>property.name==="centralSymmetry" && property.analysisKind==="centrosymmetry")'), true);
    const staleCount = await evaluate('radicalDependencies.requests.filter(request=>request.kind==="voronoi").length');
    await evaluate("radicalDependencies.release('Controlled same-frame producer failure')");
    await wait('document.getElementById("csp-state").textContent==="Failed" && document.getElementById("voronoi-state").textContent==="Failed"', 'Same-frame failure rejects stale owned radius inputs');
    assert.equal(await evaluate('radicalDependencies.requests.filter(request=>request.kind==="voronoi").length'), staleCount);
    assert.equal(await evaluate('radicalDependencies.renderer.frame.voronoiInputCache==null'), true, 'terminal failure releases the budgeted private cache');
    await run('run-csp');
    await wait('document.getElementById("csp-state").textContent==="Calculated" && document.getElementById("voronoi-state").textContent==="Calculated"', 'Same-frame producer retry resumes new radii');

    // A different CSP shell is a new producer job even when visited frames
    // remain cached; returning to an unchanged cached frame needs no wait.
    await evaluate("radicalDependencies.hold=true;radicalDependencies.change('csp-neighbors','12')");
    await wait('document.getElementById("voronoi-state").textContent==="Waiting"', 'Waiting request to cancel');
    await run('cancel-voronoi');
    const canceledCount = await evaluate('radicalDependencies.requests.filter(request=>request.kind==="voronoi").length');
    await evaluate('radicalDependencies.release()');
    await wait('document.getElementById("csp-state").textContent==="Calculated" && document.getElementById("loading").hidden', 'Producer completes after cancellation');
    assert.equal(await evaluate('document.getElementById("voronoi-state").textContent'), 'Not calculated');
    assert.equal(await evaluate('radicalDependencies.requests.filter(request=>request.kind==="voronoi").length'), canceledCount);
    assert.equal(await evaluate('radicalDependencies.renderer.frame.atomeyeResults?.voronoi==null'), true);
    assert.equal(await evaluate('radicalDependencies.renderer.frame.voronoiInputCache==null'), true);
    results.push({ backend: resumed.backend, waitingStartedNoVoronoiJob: true, independentCoordination: true,
      preservedWarmWorkers: true, producerFailureRecovered: true, sameFrameFailureRejectsStaleValues: true,
      privateCacheReleased: true, canceledLateInputIgnored: true });
  }
  return { result: 'passed', tree: source ? 'source' : 'production', adapter, results };
}, { software: useSoftwareAdapter(true) });
console.log(JSON.stringify(report, null, 2));

async function installChecks(modulePath) {
  const [{ AnalysisPool }, { WebGLRenderer }] = await Promise.all([
    import(`${modulePath}/analysis/analysis-pool.js`), import(`${modulePath}/render/webgl-renderer.js`)]);
  const checks = window.radicalDependencies = { requests: [], pending: [], hold: false };
  const setFrame = WebGLRenderer.prototype.setFrame, original = AnalysisPool.prototype.analyze;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this;
    return setFrame.apply(this, args);
  };
  AnalysisPool.prototype.analyze = async function(frame, parameters, options = {}) {
    checks.pool = this; checks.requests.push({ kind: parameters.kind, frameIndex: options.frameIndex });
    if (parameters.kind === 'centrosymmetry' && checks.hold) await new Promise((resolve, reject) => {
      const signal = options.signal, stop = () => reject(new DOMException('Stopped', 'AbortError'));
      const finish = error => { signal.removeEventListener('abort', stop); error ? reject(new Error(error)) : resolve(); };
      const entry = { signal, finish }; checks.pending.push(entry);
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    });
    return original.call(this, frame, parameters, options);
  };
  checks.release = (error = null) => {
    checks.hold = false;
    for (const entry of checks.pending.splice(0)) if (!entry.signal.aborted) entry.finish(error);
  };
  checks.change = (id, value) => {
    const input = document.getElementById(id); if (!input) throw new Error(`Missing ${id}`);
    if (typeof value === 'boolean') input.checked = value; else input.value = String(value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.open = () => {
    const rows = [], basis = [[0, 0, 0], [.5, .5, 0], [.5, 0, .5], [0, .5, .5]];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) for (const point of basis) {
      rows.push(`Cu ${(x + point[0]) * 4} ${(y + point[1]) * 4} ${(z + point[2]) * 4} ${rows.length + 1}`);
    }
    const text = [0, 1, 2].map(step => [String(rows.length),
      `Lattice="16 0 0 0 16 0 0 0 16" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T" Step=${step}`, ...rows, ''].join('\n')).join('');
    const files = new DataTransfer(), input = document.getElementById('file-input');
    files.items.add(new File([text], 'radical-dependencies.xyz')); input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.read = () => {
    const result = checks.renderer.frame.atomeyeResults.voronoi.result;
    return { backend: result.backend, fallbackReason: result.fallbackReason,
      radii: Array.from(result.radicalRadii), meanVolume: result.summary.meanVolume };
  };
}
