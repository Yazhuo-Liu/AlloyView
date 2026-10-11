import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateBondStatistics, prepareBondStatisticsContext, calculatePreparedBondStatistics } from '../src/analysis/bond-statistics.js';
import { calculateCentrosymmetry, prepareCentrosymmetryContext, calculatePreparedCentrosymmetry } from '../src/analysis/centrosymmetry.js';
import { calculateRdf, rdfNormalization, prepareRdfContext, calculatePreparedRdf } from '../src/analysis/rdf.js';
import { prepareDisplacements, prepareDisplacementCalculation, calculatePreparedDisplacements } from '../src/analysis/displacement.js';
import { calculateCna } from '../src/analysis/cna.js';
import { crystalFrame } from './helpers/crystals.js';

function countedSome(array) {
  let calls = 0;
  array.some = function(callback) { calls++; return Object.getPrototypeOf(array).some.call(array, callback); };
  return () => calls;
}

test('prepared bond and CSP ranges validate complete type/structure inputs once, while direct calls still revalidate', () => {
  const frame = crystalFrame('fcc', 3), parameters = { cutoff: 3 };
  const typeScans = countedSome(frame.types);
  const bonds = prepareBondStatisticsContext(frame, parameters);
  for (let atom = 0; atom < frame.types.length; atom += 16) {
    calculatePreparedBondStatistics(bonds, { startAtom: atom, endAtom: Math.min(frame.types.length, atom + 16) });
  }
  assert.equal(typeScans(), 1);
  calculateBondStatistics(frame, parameters);
  assert.equal(typeScans(), 2);
  assert.throws(() => calculatePreparedBondStatistics({ validated: true }), /context is invalid/);
  frame.types = Float64Array.from(frame.types); frame.types[0] = -1;
  assert.throws(() => calculateBondStatistics(frame, { ...parameters, preparedContext: bonds, validated: true }), /nonnegative integer/);

  const structureInput = calculateCna(frame).structures, labelScans = countedSome(structureInput);
  const symmetry = prepareCentrosymmetryContext(frame, { mode: 'auto', structureInput });
  for (let atom = 0; atom < frame.types.length; atom += 16) {
    calculatePreparedCentrosymmetry(symmetry, { startAtom: atom, endAtom: Math.min(frame.types.length, atom + 16) });
  }
  assert.equal(labelScans(), 1);
  structureInput[0] = 255;
  assert.throws(() => calculateCentrosymmetry(frame, { mode: 'auto', structureInput, preparedContext: symmetry, validated: true }), /complete adaptive CNA/);
  assert.equal(labelScans(), 2);
  assert.throws(() => calculatePreparedCentrosymmetry({ validated: true }), /context is invalid/);
});

test('RDF populations and displacement mapping are scanned during preparation rather than every sparse range', async () => {
  const frame = crystalFrame('fcc', 3), parameters = { cutoff: 3, bins: 23 };
  let populationScans = 0;
  const iterateTypes = frame.types[Symbol.iterator].bind(frame.types);
  frame.types[Symbol.iterator] = function() { populationScans++; return iterateTypes(); };
  const normalization = rdfNormalization(frame, parameters), context = prepareRdfContext(frame, parameters, normalization);
  for (let atom = 0; atom < frame.types.length; atom += 16) {
    calculatePreparedRdf(context, { startAtom: atom, endAtom: Math.min(frame.types.length, atom + 16) });
  }
  assert.equal(populationScans, 1);
  frame.types[0] = 1;
  const actual = calculateRdf(frame, { ...parameters, firstType: 1, rdfNormalization: normalization, validated: true });
  assert.equal(populationScans, 2); assert.equal(actual.normalization.centerCount, 1);
  assert.throws(() => calculatePreparedRdf({ validated: true }), /context is invalid/);

  const inputs = await prepareDisplacements(frame, frame);
  let mappingScans = 0;
  const iterateMapping = inputs.referenceMapping[Symbol.iterator].bind(inputs.referenceMapping);
  inputs.referenceMapping[Symbol.iterator] = function() { mappingScans++; return iterateMapping(); };
  const displacement = prepareDisplacementCalculation(frame, inputs);
  for (let atom = 0; atom < frame.types.length; atom += 16) {
    calculatePreparedDisplacements(frame, { ...inputs, preparedContext: displacement,
      startAtom: atom, endAtom: Math.min(frame.types.length, atom + 16) });
  }
  assert.equal(mappingScans, 1);
  inputs.referenceMapping[0] = frame.types.length;
  assert.throws(() => calculatePreparedDisplacements(frame, inputs), /outside the reference/);
  assert.equal(mappingScans, 2);
  assert.throws(() => calculatePreparedDisplacements(frame, { ...inputs, preparedContext: { ...displacement } }), /does not match/);
});

function poolFor(sharedMemory) {
  const replies = [];
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory },
    workerFactory() {
      const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
      return { addEventListener(name, listener) { worker.on(name, data => {
        if (name === 'message' && data.ok) replies.push(data.result);
        listener(name === 'message' ? { data } : data);
      }); }, postMessage(data, transfer) { worker.postMessage(data, transfer); }, terminate() { worker.terminate(); } };
    } });
  return { pool, replies };
}

for (const sharedMemory of [false, true]) test(`resident Worker chunks prepare inputs once per slot and preserve results (${sharedMemory ? 'shared' : 'private'})`, async () => {
  const { pool } = poolFor(sharedMemory), frame = crystalFrame('fcc', 11);
  const structureInput = calculateCna(frame).structures;
  try {
    for (const parameters of [{ kind: 'bondStatistics', cutoff: 3, lengthBins: 13, angleBins: 17 },
      { kind: 'centrosymmetry', mode: 'auto', structureInput }, { kind: 'rdf', cutoff: 3, bins: 17 },
      { kind: 'displacement', ...await prepareDisplacements(frame, frame) }]) {
      const result = await pool.analyzeCPU(frame, parameters);
      assert.ok(result.chunkCount > result.workerCount);
      // A single dynamic runner can rotate through previously warmed slots.
      // Preparation is bounded by those resident slots, never chunk count.
      assert.ok(result.inputPreparations > 0 && result.inputPreparations <= pool.slots.size, parameters.kind);
      const direct = parameters.kind === 'bondStatistics' ? calculateBondStatistics(frame, parameters)
        : parameters.kind === 'centrosymmetry' ? calculateCentrosymmetry(frame, parameters)
          : parameters.kind === 'rdf' ? calculateRdf(frame, parameters) : calculatePreparedDisplacements(frame, parameters);
      const fields = parameters.kind === 'bondStatistics' ? ['coordination', 'q4', 'q6', 'lengthCounts', 'angleCounts']
        : parameters.kind === 'centrosymmetry' ? ['centrosymmetry', 'cspStructureTypes', 'cspNeighborCounts', 'cspSummary']
          : parameters.kind === 'rdf' ? ['counts', 'radii', 'values', 'normalization'] : ['vectors', 'magnitudes'];
      for (const field of fields) assert.deepEqual(result[field], direct[field], `${parameters.kind}: ${field}`);
    }

    const before = await pool.analyzeCPU(frame, { kind: 'rdf', cutoff: 3, firstType: 0 });
    frame.types[0] = 1;
    const changed = await pool.analyzeCPU(frame, { kind: 'rdf', cutoff: 3, firstType: 0 });
    assert.notEqual(changed.frameKey, before.frameKey);
    assert.equal(changed.normalization.centerCount, frame.types.length - 1);
    assert.deepEqual(changed.counts, calculateRdf(frame, { cutoff: 3, firstType: 0 }).counts);
    const empty = await pool.analyzeCPU(frame, { kind: 'bondStatistics', cutoff: 1 });
    assert.equal(empty.inputPreparations, empty.workerCount); assert.equal(empty.lengthDistribution.total, 0);

    structureInput[0] = 255;
    await assert.rejects(pool.analyzeCPU(frame, { kind: 'centrosymmetry', mode: 'auto', structureInput }), /complete adaptive CNA/);
    const inputs = await prepareDisplacements(frame, frame); inputs.referenceMapping[0] = frame.types.length;
    await assert.rejects(pool.analyzeCPU(frame, { kind: 'displacement', ...inputs, preparedContext: {}, validated: true }), /outside the reference/);
  } finally { pool.close(); }
});
