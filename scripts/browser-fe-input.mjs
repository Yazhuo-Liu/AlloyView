import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');

const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, get: () => 8 });
  ` });
  const origin = await evaluate('location.origin');
  await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });

  async function waitFor(expression, label, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    const state = await evaluate(`({
      source: document.getElementById('file-name')?.textContent,
      estimate: document.getElementById('lattice-estimate-status')?.textContent,
      strain: document.getElementById('strain-state')?.textContent,
      strainStatus: document.getElementById('strain-status')?.textContent,
      toast: document.getElementById('toast')?.textContent,
      analyses: window.feInputChecks?.analyses,
    })`);
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(state)}`);
  }

  await waitFor('document.readyState === "complete" && document.getElementById("lattice-estimate") && !document.getElementById("brand-logo").src.endsWith("undefined")', 'production application startup');
  assert.match(await evaluate('document.querySelector("script[type=module][src]").src'), /\/dist\/assets\/[^/]+\/src\/app\.js$/,
    'The regression must exercise the content-versioned production application.');
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type=module][src]').src;
    const [{ AnalysisPool }, { WebGLRenderer }] = await Promise.all([
      import(new URL('./analysis/analysis-pool.js', appUrl)),
      import(new URL('./render/webgl-renderer.js', appUrl)),
    ]);
    const checks = window.feInputChecks = { analyses: [], holdNextPtm: false, held: false, released: false };
    const setFrame = WebGLRenderer.prototype.setFrame;
    WebGLRenderer.prototype.setFrame = function(...args) {
      if (this.canvas.id === 'viewport') checks.renderer = this;
      return setFrame.apply(this, args);
    };
    const analyze = AnalysisPool.prototype.analyze;
    AnalysisPool.prototype.analyze = function(frame, parameters, ...rest) {
      checks.pool = this;
      const row = { kind: parameters.kind, gpuEnabled: this.gpuEnabled, atoms: frame.ids.length,
        flags: parameters.flags, cachedPtmInput: Boolean(parameters.ptmInput) };
      checks.analyses.push(row);
      return analyze.call(this, frame, parameters, ...rest).then(result => {
        row.finished = true;
        row.elapsedMs = result.elapsedMs;
        row.gpuRequested = result.gpuRequested;
        row.fallbackReason = result.fallbackReason ?? null;
        if (parameters.kind === 'ptm' && checks.holdNextPtm) {
          checks.holdNextPtm = false;
          checks.held = true;
          return new Promise(resolve => {
            checks.releasePtm = () => { checks.released = true; resolve(result); };
          });
        }
        return result;
      });
    };
    checks.change = (selector, value) => {
      const input = document.querySelector(selector);
      if (!input) throw new Error('Missing reference control: ' + selector);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    checks.references = () => ({
      element: document.querySelector('[data-reference-element="0"]')?.value,
      structure: document.querySelector('[data-reference-structure="0"]')?.value,
      a: document.querySelector('[data-lattice-a="0"]')?.value,
      c: document.querySelector('[data-lattice-c="0"]')?.value,
    });
    const toggle = document.getElementById('enable-gpu-computing');
    if (toggle.getAttribute('aria-pressed') === 'true') toggle.click();
  })()`);
  assert.equal(await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")'), 'false');

  async function chooseExample(name) {
    await evaluate('document.getElementById("open-examples").click()');
    await waitFor(`document.getElementById('source-dialog').open && [...document.querySelectorAll('.source-option')].some(button => button.textContent.includes(${JSON.stringify(name)}))`, `${name} in the generated example catalog`);
    await evaluate(`[...document.querySelectorAll('.source-option')].find(button => button.textContent.includes(${JSON.stringify(name)})).click()`);
  }
  async function waitForExample(name, atoms) {
    await waitFor(`document.getElementById('file-name').textContent.includes(${JSON.stringify(name)}) && document.getElementById('loading').hidden && window.feInputChecks.renderer?.frame.ids.length === ${atoms}`, `${name} import`);
  }
  async function loadExample(name, atoms) {
    await chooseExample(name);
    await waitForExample(name, atoms);
  }

  await loadExample('Fe_disloc_loop.dump', 60229);
  assert.equal(await evaluate('document.getElementById("atom-count").textContent.replace(/[^0-9]/g, "")'), '60229');
  assert.deepEqual(await evaluate('feInputChecks.renderer.frame.typeLabels'), ['Type 1']);
  assert.equal(await evaluate(`document.querySelector('#legend [data-atom-type="Type 1"]')?.getAttribute('aria-label')`), 'Show Type 1 atoms');
  assert.equal(await evaluate('Boolean(document.querySelector("#legend [data-atom-type=Fe]"))'), false);
  assert.equal((await evaluate('feInputChecks.references()')).a, '');

  async function checkEstimatedReference(label) {
    await waitFor(`document.querySelector('[data-reference-structure="0"]').value === '3' && Number(document.querySelector('[data-lattice-a="0"]').value) > 0 && document.getElementById('lattice-estimate-cancel').disabled`, label);
    const reference = await evaluate('feInputChecks.references()');
    assert.equal(reference.element, '', 'Geometric estimation must retain an unknown chemical element.');
    assert.equal(reference.structure, '3');
    assert.ok(Math.abs(Number(reference.a) - 2.836575) <= .005, `Expected the actual dump's BCC lattice, got ${reference.a}`);
    return reference;
  }

  await evaluate('document.getElementById("lattice-estimate").click()');
  const estimated = await checkEstimatedReference('explicit BCC lattice estimation');
  assert.match(await evaluate('document.getElementById("lattice-estimate-status").textContent'), /BCC/i);
  await evaluate('document.getElementById("run-strain").click()');
  await waitFor('document.getElementById("strain-state").textContent === "Calculated"', 'elastic strain using the estimated lattice');
  const finiteStrainAtoms = await evaluate(`feInputChecks.renderer.frame.properties.find(property => property.name === 'atomicShearStrain').data.reduce((count, value) => count + Number(Number.isFinite(value)), 0)`);
  assert.ok(finiteStrainAtoms > 59000, `Expected finite strain in the BCC bulk, got ${finiteStrainAtoms} atoms`);
  const initialAnalyses = await evaluate('feInputChecks.analyses');
  assert.deepEqual(initialAnalyses.map(row => row.kind), ['ptm', 'strain']);
  assert.equal(initialAnalyses[1].cachedPtmInput, true, 'Strain must reuse the full geometric fit from estimation.');
  assert.equal(initialAnalyses[1].flags, initialAnalyses[0].flags, 'Strain must preserve the cached fit\'s superset of PTM templates.');

  async function exportConfiguration() {
    return evaluate(`(async () => {
      const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
      let saved;
      URL.createObjectURL = function(blob) { saved = blob; return createUrl.call(this, blob); };
      HTMLAnchorElement.prototype.click = () => {};
      try {
        document.getElementById('export-configuration').click();
        if (!saved) throw new Error('Configuration export did not create a Blob.');
        return JSON.parse(await saved.text());
      } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
    })()`);
  }
  const configuration = await exportConfiguration();
  const savedReference = configuration.settings.analyses.strain.references[0];
  assert.equal(configuration.settings.compute.gpuEnabled, false);
  assert.equal(savedReference.label, 'Type 1');
  assert.equal(savedReference.structure, 3);
  assert.equal(savedReference.element, '');
  assert.equal(savedReference.a, Number(estimated.a));
  assert.ok(Object.keys(savedReference).every(key => ['label', 'element', 'structure', 'a', 'c'].includes(key)),
    'Estimator sample counts, phase histograms, and confidence diagnostics must not enter the portable reference.');

  // Complete manually entered hexagonal a/c values must survive an estimate.
  await evaluate(`document.getElementById('cancel-strain').click();
    feInputChecks.change('[data-lattice-a="0"]', '2.9');
    feInputChecks.change('[data-reference-structure="0"]', '2');
    feInputChecks.change('[data-lattice-c="0"]', '4.7');`);
  const manual = await evaluate('feInputChecks.references()');
  await evaluate('document.getElementById("lattice-estimate").click()');
  await waitFor('document.getElementById("lattice-estimate-cancel").disabled', 'manual reference preservation');
  assert.deepEqual(await evaluate('feInputChecks.references()'), manual);

  await evaluate(`(() => {
    const file = new File([${JSON.stringify(JSON.stringify(configuration))}], 'fe-estimated-reference.json', { type: 'application/json' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('configuration-file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('document.getElementById("configuration-status").textContent.includes("Configuration restored") && document.getElementById("strain-state").textContent === "Calculated"', 'exported estimated-reference configuration replay');
  assert.doesNotMatch(await evaluate('document.getElementById("configuration-status").textContent'), /could not complete/);
  assert.deepEqual(await evaluate('feInputChecks.references()'), estimated);
  assert.deepEqual((await exportConfiguration()).settings.analyses.strain.references[0], savedReference,
    'Import and replay must preserve the exported numeric label and geometric lattice exactly.');
  await evaluate('document.getElementById("cancel-strain").click()');

  async function holdMissingReferenceFit() {
    await evaluate(`document.getElementById('lattice-reset').click();
      feInputChecks.held = false; feInputChecks.released = false; feInputChecks.holdNextPtm = true;
      document.getElementById('lattice-estimate').click();`);
    await waitFor('feInputChecks.held && !document.getElementById("lattice-estimate-cancel").disabled', 'completed PTM fit held before reference publication');
  }
  async function releaseHeldFit() {
    await evaluate(`feInputChecks.releasePtm(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await delay(200);
    assert.equal(await evaluate('feInputChecks.released'), true);
  }

  await holdMissingReferenceFit();
  await evaluate('document.getElementById("lattice-estimate-cancel").click()');
  await releaseHeldFit();
  assert.equal((await evaluate('feInputChecks.references()')).a, '', 'Cancelling an estimate must reject a late fit.');
  assert.match(await evaluate('document.getElementById("lattice-estimate-status").textContent'), /cancel/i);

  await holdMissingReferenceFit();
  await evaluate(`feInputChecks.change('[data-lattice-a="0"]', '2.92')`);
  const edited = await evaluate('feInputChecks.references()');
  await releaseHeldFit();
  assert.deepEqual(await evaluate('feInputChecks.references()'), edited, 'Editing a reference must supersede a pending fit.');
  await evaluate('document.getElementById("lattice-reset").click()');

  // Calculate strain performs the same inference when numeric references are missing.
  await evaluate(`feInputChecks.change('[data-reference-structure="0"]', '2')`);
  const incompleteHexagonal = await evaluate('feInputChecks.references()');
  assert.equal(incompleteHexagonal.a, '');
  assert.equal(incompleteHexagonal.c, '', 'Selecting HCP without a must leave c missing rather than inventing zero.');
  await evaluate('document.getElementById("run-strain").click()');
  await waitFor('document.getElementById("strain-state").textContent === "Calculated"', 'automatic missing-reference estimation before strain');
  const automatic = await checkEstimatedReference('automatic BCC reference');
  await evaluate('document.getElementById("cancel-strain").click()');

  await holdMissingReferenceFit();
  await evaluate(`(() => {
    const fetch = window.fetch;
    feInputChecks.sourceFetchHeld = false;
    window.fetch = (url, ...options) => {
      if (!String(url).endsWith('/fcc-vacancy.cfg')) return fetch.call(window, url, ...options);
      feInputChecks.sourceFetchHeld = true;
      return new Promise(resolve => {
        feInputChecks.releaseSourceFetch = () => {
          window.fetch = fetch;
          resolve(fetch.call(window, url, ...options));
        };
      });
    };
  })()`);
  await chooseExample('fcc-vacancy.cfg');
  await waitFor('feInputChecks.sourceFetchHeld', 'replacement source fetch held before completion');
  const sourceLoadingControlsDisabled = `document.getElementById('lattice-estimate-cancel').hidden
    && document.getElementById('lattice-estimate-cancel').disabled
    && document.getElementById('lattice-estimate').disabled
    && document.getElementById('run-strain').disabled
    && [...document.querySelectorAll('#lattice-references input, #lattice-references select')].every(input => input.disabled)`;
  assert.equal(await evaluate(sourceLoadingControlsDisabled), true,
    'Selecting another source must immediately cancel estimation and disable lattice inputs while fetching.');
  await releaseHeldFit();
  assert.equal((await evaluate('feInputChecks.references()')).a, '',
    'The previous fit must remain rejected while the replacement fetch is still pending.');
  assert.equal(await evaluate(sourceLoadingControlsDisabled), true,
    'A late fit must not reenable lattice controls while the replacement source is loading.');
  await evaluate('feInputChecks.releaseSourceFetch()');
  await waitForExample('fcc-vacancy.cfg', 31);
  const replacement = await evaluate('feInputChecks.references()');
  assert.equal(replacement.element, 'Al');
  assert.equal(replacement.structure, '1');
  assert.equal(Number(replacement.a), 4.05);
  assert.deepEqual(await evaluate('feInputChecks.references()'), replacement,
    'A pending fit from the Fe source must not replace the next source\'s lattice reference.');
  const analyses = await evaluate('feInputChecks.analyses');
  assert.ok(analyses.length > 0 && analyses.every(row => row.gpuEnabled === false), 'All fitting and strain jobs must use the CPU pool.');

  // Preference changes invalidate visible PTM cache entries, even when the GPU
  // request falls back to the resident CPU fitter because neighbors are unsupported.
  const beforePreferenceChecks = analyses.length;
  await evaluate(`(() => {
    const backend = feInputChecks.pool.gpuBackend;
    const supports = backend.supports;
    backend.supports = function(kind) { return kind === 'ptmNeighbors' ? false : supports.call(this, kind); };
    feInputChecks.restoreGpuSupport = () => { backend.supports = supports; };
    feInputChecks.ptmMetadata = () => {
      const property = feInputChecks.renderer.frame.properties.find(item => item.name === 'ptmStructureType');
      return { gpuRequested: property?.analysisGpuRequested, elapsedMs: property?.analysisMs,
        fallbackReason: property?.analysisFallbackReason ?? null,
        metric: document.getElementById('metric-ptm').textContent,
        metricDetails: document.getElementById('metric-ptm').title };
    };
    document.getElementById('run-ptm').click();
  })()`);
  await waitFor(`feInputChecks.analyses.length === ${beforePreferenceChecks + 1} && document.getElementById('ptm-state').textContent === 'Calculated' && feInputChecks.ptmMetadata().gpuRequested === false`, 'CPU PTM preference metadata');
  const cpuPtm = await evaluate('feInputChecks.ptmMetadata()');
  assert.equal(cpuPtm.fallbackReason, null);
  assert.ok(Number.isFinite(cpuPtm.elapsedMs) && cpuPtm.elapsedMs >= 0);

  await evaluate(`document.getElementById('enable-gpu-computing').click(); document.getElementById('run-ptm').click()`);
  await waitFor(`feInputChecks.analyses.length === ${beforePreferenceChecks + 2} && document.getElementById('ptm-state').textContent === 'Calculated' && feInputChecks.ptmMetadata().gpuRequested === true`, 'PTM GPU preference cache invalidation and CPU fallback');
  const fallbackPtm = await evaluate('feInputChecks.ptmMetadata()');
  assert.match(fallbackPtm.fallbackReason, /no GPU kernel/);
  assert.match(fallbackPtm.metric, /CPU/);
  assert.match(fallbackPtm.metricDetails, /no GPU kernel/);

  await evaluate(`document.getElementById('enable-gpu-computing').click(); document.getElementById('run-ptm').click()`);
  await waitFor(`feInputChecks.analyses.length === ${beforePreferenceChecks + 3} && document.getElementById('ptm-state').textContent === 'Calculated' && feInputChecks.ptmMetadata().gpuRequested === false`, 'PTM return to CPU clears stale fallback metadata');
  const restoredCpuPtm = await evaluate('feInputChecks.ptmMetadata()');
  assert.equal(restoredCpuPtm.fallbackReason, null);
  assert.doesNotMatch(restoredCpuPtm.metricDetails, /no GPU kernel/);
  const preferenceAnalyses = await evaluate(`feInputChecks.analyses.slice(${beforePreferenceChecks})`);
  assert.deepEqual(preferenceAnalyses.map(row => row.gpuEnabled), [false, true, false]);
  assert.deepEqual(preferenceAnalyses.map(row => row.kind), ['ptm', 'ptm', 'ptm']);
  for (const [index, metadata] of [cpuPtm, fallbackPtm, restoredCpuPtm].entries()) {
    assert.equal(metadata.elapsedMs, preferenceAnalyses[index].elapsedMs, 'Visible PTM timing must use the completed fit\'s elapsed time.');
  }
  await evaluate('feInputChecks.restoreGpuSupport()');

  return { scope: 'Production Fe dump input, numeric legend, geometric lattice estimation, CPU strain and stale-fit guards',
    atoms: 60229, typeLabels: ['Type 1'], estimated, automatic, finiteStrainAtoms,
    configurationReference: savedReference, exportedReferenceReplay: true, manualValuesPreserved: true,
    missingHcpReferenceInferred: true, sourceSelectionCancelledBeforeFetch: true,
    cancelledFitRejected: true, manualEditSupersededFit: true, previousSourceFitRejected: true,
    strainReusedEstimatedPtm: true,
    ptmPreferenceCacheAndFallback: { cpu: cpuPtm, fallback: fallbackPtm, restoredCpu: restoredCpuPtm, analyses: preferenceAnalyses }, analyses };
}, { software: true, isolated: false });

console.log(JSON.stringify(report, null, 2));
