import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser, useSoftwareAdapter } from './webgpu-browser.mjs';

const production = process.argv.includes('--production');
const result = await withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
  if (production) {
    await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.mappingWorkerUrls = [];
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(url, options) { super(url, options); mappingWorkerUrls.push(new URL(url, location.href).href); }
      };
    ` });
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !await evaluate('document.readyState === "complete" && document.querySelector("[data-tool-button=coordination]")')) await delay(25);
    assert.equal(await evaluate('document.readyState === "complete" && Boolean(document.querySelector("[data-tool-button=coordination]"))'), true, 'Built application startup');
  }
  return { adapter, ...await evaluate(`(${run.toString()})(${production})`) };
}, { software: useSoftwareAdapter() });
assert.equal(result.gpuReferenceIdentical, true);
assert.equal(result.gpuDisplacementIdentical, true);
assert.equal(result.sourceIntact, true);
assert.ok(result.measurements.every(row => row.exact && row.slices > 1));
assert.ok(result.measurements.some(row => row.name === 'numeric warm' && row.cacheBytes === 12_000_000));
if (production) {
  assert.match(result.runtimeRoot, /\/AlloyView\/dist\/assets\/[a-f0-9]+\/$/);
  assert.ok(result.gpuWorkerUrls.length > 0, 'Actual bundled GPU Worker dispatch');
  assert.ok(result.gpuWorkerUrls.every(url => url === new URL('src/analysis/gpu/worker.js', result.runtimeRoot).href), 'GPU Workers must use the built versioned entry');
}
console.log(JSON.stringify(result, null, 2));

async function run(production) {
  const appUrl = production ? document.querySelector('script[type=module][src]').src : null;
  const runtimeRoot = production ? new URL('../', appUrl).href : new URL('./', location.href).href;
  if (production && !/\/dist\/assets\/[a-f0-9]+\/src\/app\.js$/.test(new URL(appUrl).pathname)) throw new Error('Unversioned production app entry.');
  const runtimeUrl = path => new URL(path, runtimeRoot).href;
  const fixtureUrl = new URL('/AlloyView/tests/helpers/crystals.js', location.href).href;
  const [{ createReferenceMapping, createReferenceMappingAsync, referenceMappingCacheBytes, REFERENCE_STRAIN_FIELDS },
    { prepareDisplacements }, { GpuAnalysisClient }, { crystalFrame }] = await Promise.all([
    import(runtimeUrl('src/analysis/reference-strain.js')), import(runtimeUrl('src/analysis/displacement.js')),
    import(runtimeUrl('src/analysis/gpu/client.js')), import(fixtureUrl),
  ]);
  const equal = (first, second) => first.length === second.length && first.every((value, row) => Object.is(value, second[row]));
  const yieldMain = () => scheduler.yield();
  const originalMapping = async (current, reference) => {
    const byId = new Map(), seen = new Set(), mapping = new Int32Array(current.ids.length);
    for (let row = 0; row < reference.ids.length; row++) {
      const key = String(reference.ids[row]); if (byId.has(key)) throw new Error('Duplicate reference ID.'); byId.set(key, row);
      if ((row + 1) % 65_536 === 0) await yieldMain();
    }
    if (reference.ids.length % 65_536) await yieldMain();
    for (let row = 0; row < current.ids.length; row++) {
      const key = String(current.ids[row]); if (seen.has(key)) throw new Error('Duplicate current ID.'); seen.add(key);
      mapping[row] = byId.get(key) ?? -1;
      if ((row + 1) % 65_536 === 0) await yieldMain();
    }
    return mapping;
  };
  const count = 1_000_000, ids = Uint32Array.from({ length: count }, (_, row) => row + 1);
  const reference = { ids, fractional: new Float32Array(count * 3) }, current = { ...reference, ids: ids.slice().reverse() };
  current.ids[37] = count + 10;
  const measurements = [];
  let expected;
  for (const [name, calculate] of [['original text', originalMapping], ['numeric cold', createReferenceMappingAsync], ['numeric warm', createReferenceMappingAsync]]) {
    const times = [], nativeYield = scheduler.yield.bind(scheduler);
    let last = performance.now(), slices = 0;
    scheduler.yield = async function() { times.push(performance.now() - last); slices++; await nativeYield(); last = performance.now(); };
    const started = performance.now();
    try {
      const mapping = await calculate(current, reference);
      times.push(performance.now() - last);
      if (!expected) expected = mapping;
      measurements.push({ name, atoms: count, elapsedMs: performance.now() - started, slices,
        longestSliceMs: Math.max(...times), exact: equal(mapping, expected), cacheBytes: referenceMappingCacheBytes(reference.ids) });
    } finally { scheduler.yield = nativeYield; }
  }
  // Identical canonical mappings feed the actual persistent WebGPU worker,
  // so pre-dispatch optimization must not alter any output field or arrow.
  const ref = crystalFrame('fcc', 3), frame = { ...ref, ids: ref.ids.slice(), fractional: ref.fractional.slice(), positions: ref.positions.slice() };
  [frame.ids[0], frame.ids[1]] = [frame.ids[1], frame.ids[0]]; frame.ids[7] = 7000;
  const beforeIds = ref.ids.slice(), beforePositions = ref.positions.slice(), client = new GpuAnalysisClient();
  let gpuReferenceIdentical, gpuDisplacementIdentical, sourceIntact;
  try {
    const parameters = { kind: 'referenceStrain', referenceFrame: ref, referenceFractional: ref.fractional, referenceCell: ref.cell,
      referenceMapping: createReferenceMapping(frame, ref), cutoff: 3 };
    const baseline = await client.analyze(frame, parameters, { frameIndex: 1 });
    const mapping = await createReferenceMappingAsync(frame, ref);
    const actual = await client.analyze(frame, { ...parameters, referenceMapping: mapping }, { frameIndex: 1 });
    gpuReferenceIdentical = REFERENCE_STRAIN_FIELDS.every(name => equal(baseline[name], actual[name]));
    const displacement = await prepareDisplacements(frame, ref, { minimumImage: false });
    const original = await client.analyze(frame, { kind: 'displacement', ...displacement, referenceMapping: parameters.referenceMapping }, { frameIndex: 1 });
    const matched = await client.analyze(frame, { kind: 'displacement', ...displacement }, { frameIndex: 1 });
    gpuDisplacementIdentical = equal(original.vectors, matched.vectors) && equal(original.magnitudes, matched.magnitudes);
    sourceIntact = equal(ref.ids, beforeIds) && equal(ref.positions, beforePositions) && mapping.byteLength > 0;
  } finally { client.close(); }
  const gpuWorkerUrls = (window.mappingWorkerUrls ?? []).filter(url => new URL(url).pathname.endsWith('/analysis/gpu/worker.js'));
  return { production, runtimeRoot, gpuWorkerUrls, measurements, gpuReferenceIdentical, gpuDisplacementIdentical, sourceIntact };
}
