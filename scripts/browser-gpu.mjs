import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  await evaluate(`(async () => {
    const { AnalysisPool } = await import('./src/analysis/analysis-pool.js');
    const { crystalFrame } = await import('./tests/helpers/crystals.js');
    const { createCell, fractionalToCartesian } = await import('./src/data/model.js');
    window.gpuTests = { AnalysisPool, crystalFrame, createCell, fractionalToCartesian, rows: [] };
    window.gpuTests.cpu = new AnalysisPool();
    window.gpuTests.gpu = new AnalysisPool();
    window.gpuTests.gpu.setGpuEnabled(true);
    window.gpuTests.check = (condition, message) => { if (!condition) throw new Error(message); };
    window.gpuTests.isGpu = result => result.backend === 'gpu' || /webgpu/i.test(result.engine ?? '');
    window.gpuTests.compare = (actual, expected, tolerance = 0) => {
      if (actual.length !== expected.length) throw new Error('Result length differs.');
      let maxAbsoluteError = 0;
      for (let atom = 0; atom < actual.length; atom += 1) {
        if (Number.isNaN(actual[atom]) && Number.isNaN(expected[atom])) continue;
        if (!Number.isFinite(actual[atom]) || !Number.isFinite(expected[atom])) {
          if (actual[atom] === expected[atom]) continue;
          throw new Error('Nonfinite result differs at ' + atom);
        }
        const error = Math.abs(actual[atom] - expected[atom]);
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
        if (error > tolerance) throw new Error('Result differs at ' + atom + ': GPU ' + actual[atom] + ', CPU ' + expected[atom] + ', tolerance ' + tolerance);
      }
      return maxAbsoluteError;
    };
    window.gpuTests.run = async (label, frame, parameters, field, tolerance = 0, requireGpu = true) => {
      const expected = await window.gpuTests.cpu.analyze(frame, parameters);
      const actual = await window.gpuTests.gpu.analyze(frame, parameters);
      if (requireGpu && !window.gpuTests.isGpu(actual)) throw new Error(label + ' silently fell back: ' + JSON.stringify({ engine: actual.engine, fallbackReason: actual.fallbackReason }));
      const maxAbsoluteError = window.gpuTests.compare(actual[field], expected[field], tolerance);
      if (parameters.kind === 'localShear') {
        window.gpuTests.compare(actual.coordination, expected.coordination);
        window.gpuTests.check(actual.coordinationMode === expected.coordinationMode, label + ' coordination mode differs.');
      }
      if (parameters.kind === 'rdf') window.gpuTests.compare(actual.counts, expected.counts);
      window.gpuTests.rows.push({ label, kind: parameters.kind, atoms: frame.ids.length, backend: actual.backend,
        engine: actual.engine, maxAbsoluteError, fallbackReason: actual.fallbackReason ?? null,
        correctedPairs: actual.correctedPairs ?? actual.precisionCorrections ?? 0,
        correctedAtoms: actual.correctedAtoms ?? actual.gpuCorrectionAtoms ?? 0, inputReused: actual.inputReused ?? null,
        gpuInputReused: actual.gpuInputReused ?? null });
    };
  })()`);
  const rows = await evaluate(`(async () => {
    const { cpu, gpu, crystalFrame, createCell, fractionalToCartesian, check, isGpu, run, rows } = window.gpuTests;
    try {
      const fcc = crystalFrame('fcc', 4, 3.52);
      const defaultResult = await cpu.analyze(fcc, { kind: 'coordination', cutoff: 2.8 });
      check(!isGpu(defaultResult), 'GPU computing must default to disabled.');
      await run('FCC coordination', fcc, { kind: 'coordination', cutoff: 2.8 }, 'coordination');
      await run('BCC coordination', crystalFrame('bcc', 4, 2.86), { kind: 'coordination', cutoff: 2.6 }, 'coordination');
      const hcp = crystalFrame('hcp', 4, 2.5);
      await run('Triclinic HCP coordination', hcp, { kind: 'coordination', cutoff: 2.7 }, 'coordination');
      const mixed = crystalFrame('fcc', 3, 3.52);
      mixed.cell = createCell({ vectors: mixed.cell.vectors, pbc: [true, false, true] });
      await run('Mixed periodic boundaries', mixed, { kind: 'coordination', cutoff: 2.8 }, 'coordination');
      const thin = crystalFrame('fcc', 1, 3.52);
      await run('Thin cell without repeated IDs', thin, { kind: 'coordination', cutoff: 2.8 }, 'coordination');
      const rdfFrame = crystalFrame('fcc', 4, 3.52);
      for (let atom = 0; atom < rdfFrame.types.length; atom += 1) rdfFrame.types[atom] = atom % 2;
      await run('Total RDF', rdfFrame, { kind: 'rdf', cutoff: 4.8, bins: 40 }, 'values', 1e-8);
      await run('Partial RDF', rdfFrame, { kind: 'rdf', cutoff: 4.8, bins: 40, firstType: 0, secondType: 1 }, 'values', 1e-8);
      await run('Triclinic RDF', hcp, { kind: 'rdf', cutoff: 4.01, bins: 31 }, 'values', 1e-8);
      const boundary = { fractional: Float64Array.from([.1, .1, .1, .2, .1, .1, .35, .1, .1]),
        ids: Uint32Array.from([1, 2, 3]), types: Uint16Array.from([0, 1, 0]),
        cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
      await run('RDF exact shell boundaries', boundary, { kind: 'rdf', cutoff: 4, bins: 4 }, 'counts');
      await run('Coordination exact cutoff', boundary, { kind: 'coordination', cutoff: 1 }, 'coordination');
      const opposite = { fractional: Float64Array.from([0, 0, 0, .5, 0, 0]),
        ids: Uint32Array.from([1, 2]), types: Uint16Array.from([0, 0]),
        cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
      await run('RDF exact cutoff and opposite images', opposite, { kind: 'rdf', cutoff: 5, bins: 10 }, 'counts');
      await run('Geometric shear', fcc, { kind: 'localShear', cutoff: 2.8 }, 'localShear', 2e-5);
      await run('Triclinic geometric shear', hcp, { kind: 'localShear', cutoff: 2.7 }, 'localShear', 3e-5);
      await run('Thin FCC repeated atom images', thin, { kind: 'localShear', cutoff: 2.8 }, 'localShear', 3e-5);
      await run('Single-site periodic self images', crystalFrame('sc', 1, 2), { kind: 'localShear', cutoff: 2.1 }, 'localShear', 3e-5);
      const strained = crystalFrame('fcc', 4, 3.52);
      strained.cell = createCell({ vectors: [14.08 * 1.04, .18, 0, 0, 14.08 * .98, 0, 0, 0, 14.08] });
      await run('Homogeneous strain with mean subtraction', strained, { kind: 'localShear', cutoff: 2.8, subtractMean: true }, 'localShear', 3e-5);
      const stretched = crystalFrame('sc', 1, 1);
      stretched.cell = createCell({ vectors: [1.2, 0, 0, 0, 1, 0, 0, 0, 1] });
      for (const subtractMean of [false, true]) await run('Stretched single-site crystal / subtractMean=' + subtractMean,
        stretched, { kind: 'localShear', cutoff: 1.3, subtractMean }, 'localShear', 3e-5);
      const distorted = crystalFrame('fcc', 4, 3.52);
      distorted.fractional[0] += .009;
      distorted.fractional[4] -= .007;
      distorted.positions = fractionalToCartesian(distorted.fractional, distorted.cell);
      await run('Distorted geometric shear', distorted, { kind: 'localShear', cutoff: 2.8, subtractMean: true }, 'localShear', 3e-5);
      await run('Geometric shear exact cutoff', boundary, { kind: 'localShear', cutoff: 1 }, 'localShear', 3e-5);
      const tie = { fractional: Float64Array.from([.5, .5, .5, .6, .5, .5, .4, .5, .5, .5, .6 - 1e-10, .5, .5, .4, .5]),
        ids: Uint32Array.from([1, 2, 3, 4, 5]), types: new Uint16Array(5),
        cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
      await run('Geometric shear nearest-K tie correction', tie, { kind: 'localShear', cutoff: 1.1, subtractMean: true }, 'localShear', 3e-5);
      const isolated = { fractional: Float64Array.from([.1, .1, .1, .5, .5, .5]),
        ids: Uint32Array.from([1, 2]), types: new Uint16Array(2),
        cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
      await run('Isolated geometric shear NaN', isolated, { kind: 'localShear', cutoff: .1 }, 'localShear');
      const outside = crystalFrame('fcc', 3, 3.52);
      outside.cell = createCell({ vectors: outside.cell.vectors, pbc: [false, true, true] });
      outside.fractional[0] = -0.1;
      await run('Unsupported open-cell positions CPU fallback', outside, { kind: 'coordination', cutoff: 2.8 }, 'coordination', 0, false);
      check(!isGpu(rows.at(-1)) && rows.at(-1).fallbackReason, 'Unsupported geometry must identify its CPU fallback.');
      // CNA remains a CPU algorithm even when the GPU preference is enabled.
      await run('CNA CPU fallback', fcc, { kind: 'cna', mode: 'adaptive' }, 'structures', 0, false);
      check(!isGpu(rows.at(-1)), 'CNA must use its existing CPU implementation.');
      const controller = new AbortController();
      let cancelled = false;
      try {
        await gpu.analyze(crystalFrame('fcc', 15, 3.52), { kind: 'coordination', cutoff: 2.8 }, {
          signal: controller.signal,
          onProgress: () => controller.abort(),
        });
      } catch (error) { cancelled = error.name === 'AbortError'; }
      check(cancelled, 'GPU cancellation must reject with AbortError.');
      await run('GPU recovery after cancellation', fcc, { kind: 'coordination', cutoff: 2.8 }, 'coordination');
      const computingController = new AbortController();
      let cancelledDuringComputing = false, observedGpuComputing = false;
      try {
        await gpu.analyze(crystalFrame('fcc', 20, 3.52), { kind: 'coordination', cutoff: 2.8 }, {
          signal: computingController.signal,
          onProgress: (progress) => {
            if (progress.backend === 'gpu' && progress.phase === 'analyzing' && progress.completedAtoms > 0) {
              observedGpuComputing = true;
              computingController.abort();
            }
          },
        });
      } catch (error) { cancelledDuringComputing = error.name === 'AbortError'; }
      check(observedGpuComputing && cancelledDuringComputing, 'An executing GPU job must cancel between batches.');
      await run('GPU recovery after cancelling dispatched work', fcc, { kind: 'coordination', cutoff: 2.8 }, 'coordination');
      return rows;
    } finally { cpu.close(); gpu.close(); }
  })()`);
  assert.ok(rows.some((row) => /webgpu/i.test(row.engine ?? '') || row.backend === 'gpu'), 'No real GPU analysis was performed.');
  const application = await runApplicationSmoke({ evaluate });
  return { adapter, softwareTiming: adapter.isFallbackAdapter || /swiftshader|software|llvmpipe/i.test(`${adapter.architecture} ${adapter.description}`),
    checks: rows, application };
}, { software: useSoftwareAdapter(true) });
console.log(JSON.stringify(report, null, 2));

async function runApplicationSmoke({ evaluate }) {
  async function waitFor(expression, label) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await evaluate(expression)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${label}; ${await evaluate('document.getElementById("toast")?.textContent')}`);
  }
  await evaluate('location.href = new URL("./index.html", location.href).href');
  await waitFor('document.readyState === "complete" && document.getElementById("enable-gpu-computing") && document.getElementById("open-examples")', 'homepage');
  assert.equal(await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")'), 'false');
  await evaluate(`document.getElementById('open-examples').click();
    [...document.querySelectorAll('.source-option')].find(button => button.textContent.includes('fcc-vacancy.cfg')).click();`);
  await waitFor('document.getElementById("file-name").textContent === "fcc-vacancy.cfg" && document.getElementById("loading").hidden && !document.getElementById("run-analysis").disabled', 'FCC vacancy example');
  const cases = [
    { tool: 'coordination', button: 'run-analysis', state: 'analysis-state', status: 'metric-analysis', cutoff: 'cutoff', value: 3.1, color: 'property:coordination' },
    { tool: 'localShear', button: 'run-local-shear', state: 'local-shear-state', status: 'local-shear-status', cutoff: 'local-shear-cutoff', value: 3.1, color: 'property:localShear' },
    { tool: 'statistics', button: 'run-rdf', state: 'rdf-state', status: 'rdf-status', cutoff: 'rdf-cutoff', value: 3.9 },
  ];
  const results = [];
  for (const test of cases) {
    await evaluate(`(() => {
      const button = document.querySelector('[data-tool-button="${test.tool}"]');
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
      document.getElementById('${test.cutoff}').value = '${test.value}';
    })()`);
    for (const enabled of [true, false]) {
      await evaluate(`(() => {
        const toggle = document.getElementById('enable-gpu-computing');
        if (toggle.getAttribute('aria-pressed') !== '${enabled}') toggle.click();
        document.getElementById('${test.button}').click();
      })()`);
      const engine = enabled ? 'webgpu' : 'js-worker';
      await waitFor(`document.getElementById('${test.state}').textContent === 'Calculated' && document.getElementById('${test.status}').textContent.includes('${engine}')`, `${test.tool} ${engine}`);
      const result = await evaluate(`({ tool: '${test.tool}', enabled: ${enabled},
        status: document.getElementById('${test.status}').textContent,
        legend: document.getElementById('legend-color-mode')?.value })`);
      if (test.color) assert.equal(result.legend, test.color, `${test.tool} analysis updates the rendered color legend.`);
      results.push(result);
    }
  }
  return results;
}
