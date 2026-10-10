import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuRuntime, EXACT_PAIR_ANALYSIS_KINDS, usesExactPairs } from '../src/analysis/gpu/runtime.js';
import { EXACT_PAIR_TEST_ROWS, EXACT_PAIR_TEST_SHADER, exactPairTestVectors, exactPairExpected, verifyExactPairs } from '../src/analysis/gpu/exact-pairs.js';
import { NEIGHBOR_RESIDUAL_WGSL, NEIGHBOR_BINDINGS_WGSL } from '../src/analysis/gpu/neighbors.js';
import { DOUBLE_SINGLE_WGSL, ATOMIC_STRAIN_SHADER } from '../src/analysis/gpu/atomic-strain-shaders.js';
import { DOUBLE_DOUBLE_WGSL, VORONOI_INITIALIZE_SHADER, VORONOI_CLIP_SHADER, VORONOI_RADICAL_CLIP_SHADER } from '../src/analysis/gpu/voronoi-shaders.js';
import { REFERENCE_STRAIN_SHADER } from '../src/analysis/gpu/reference-strain-shaders.js';
import { DISPLACEMENT_SHADER } from '../src/analysis/gpu/displacement-shaders.js';
import { COORDINATION_SHADER } from '../src/analysis/gpu/coordination.js';
import { analyzeGpuVoronoi, prepareGpuVoronoiFrame } from '../src/analysis/gpu/voronoi.js';
import { analyzeGpuDisplacement } from '../src/analysis/gpu/displacement.js';
import { analyzeGpuReferenceStrain } from '../src/analysis/gpu/reference-strain.js';
import { analyzeGpuAtomicStrain } from '../src/analysis/gpu/atomic-strain.js';
import { prepareDisplacements } from '../src/analysis/displacement.js';
import { createReferenceMapping } from '../src/analysis/reference-strain.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { crystalFrame } from './helpers/crystals.js';
import { fakeGpu } from './helpers/fake-gpu.js';

const PAIR_SHADERS = [ATOMIC_STRAIN_SHADER, REFERENCE_STRAIN_SHADER, DISPLACEMENT_SHADER,
  VORONOI_INITIALIZE_SHADER, VORONOI_CLIP_SHADER, VORONOI_RADICAL_CLIP_SHADER];
const ROW_WORDS = exactPairExpected().length / EXACT_PAIR_TEST_ROWS;
const functionBody = (source, name) => {
  const start = source.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `${name} is missing`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};

// IEEE Float32 evaluation of the shipped helpers on the self-test operands.
// `rewrite` applies one cancellation that real shader compilers perform.
const f = Math.fround, bits = new Uint32Array(1), single = new Float32Array(bits.buffer);
const truncate = value => { single[0] = value; bits[0] &= 0xfffff000; return single[0]; };
function evaluate(positions, rewrite = null) {
  const results = new Float32Array(EXACT_PAIR_TEST_ROWS * ROW_WORDS);
  const add = (a, b) => {
    const sum = f(a + b);
    // NVIDIA/Vulkan: (a + b) - a becomes b, then every error term cancels.
    if (rewrite === 'operand') return [sum, 0];
    const recovered = f(sum - a), residual = f(f(a - f(sum - recovered)) + f(b - recovered)), high = f(sum + residual);
    return [high, f(residual - f(high - sum))];
  };
  const multiply = (a, b) => {
    const product = f(a * b);
    if (rewrite === 'operand') return [product, 0];
    const aHigh = truncate(a), aLow = f(a - aHigh), bHigh = truncate(b), bLow = f(b - bHigh);
    const error = f(f(f(f(aHigh * bHigh - product) + f(aHigh * bLow)) + f(aLow * bHigh)) + f(aLow * bLow)), high = f(product + error);
    return [high, f(error - f(high - product))];
  };
  const residual = (first, second) => {
    const difference = f(first - second), recovered = f(first - difference);
    // SPIRV-Tools: difference + (first - difference) becomes first.
    const restored = rewrite === 'operand' || rewrite === 'restored' ? first : f(difference + recovered);
    return f(f(first - restored) + f(recovered - second));
  };
  for (let row = 0; row < EXACT_PAIR_TEST_ROWS; row += 1) {
    const partner = (row + 1) % EXACT_PAIR_TEST_ROWS;
    for (let axis = 0; axis < 3; axis += 1) {
      const a = positions[row * 8 + axis], b = positions[partner * 8 + axis];
      results.set([...add(a, b), ...multiply(a, b), ...add(a, b), ...multiply(a, b)], row * ROW_WORDS + axis * 8);
      results[row * ROW_WORDS + 24 + axis] = residual(a, b);
    }
  }
  return results;
}
// A fake device whose self-test dispatch stores `compute(positions)`.
const pairGpu = compute => fakeGpu({ execute: ([input, output]) => {
  if (output?.size !== EXACT_PAIR_TEST_ROWS * ROW_WORDS * 4) return;
  output.data.set(new Uint8Array(compute(new Float32Array(input.data.buffer.slice(0))).buffer));
} });
async function runtimeFor(gpu) {
  const runtime = new GpuRuntime({ environment: { navigator: { gpu } } });
  await runtime.initialize();
  return runtime;
}

test('every double-float helper multiplies its rounded intermediates by the runtime one', () => {
  for (const [source, add, multiply, error] of [[DOUBLE_SINGLE_WGSL, 'dsAdd', 'dsMultiply', 'residual'], [DOUBLE_DOUBLE_WGSL, 'ddAdd', 'ddMul', 'error']]) {
    const addition = functionBody(source, add), product = functionBody(source, multiply);
    for (const body of [addition, product]) assert.ok(body.includes('let one = runtimeOne();'), 'the guard must come from runtimeOne()');
    for (const guard of ['let sum = (a.x + b.x) * one;', 'let recovered = (sum - a.x) * one;', `let high = (sum + ${error}) * one;`]) {
      assert.ok(addition.includes(guard), `${add} lost its guard: ${guard}`);
    }
    for (const guard of ['let product = (a.x * b.x) * one;', `let high = (product + ${error}) * one;`]) {
      assert.ok(product.includes(guard), `${multiply} lost its guard: ${guard}`);
    }
    // The significand split has no rounded intermediate that could cancel.
    assert.equal(product.match(/bitcast<f32>\(bitcast<u32>\([ab]\.x\) & 0xfffff000u\)/g).length, 2);
    assert.equal(/4097\.0 \*/.test(product), false);
  }
  const residual = functionBody(NEIGHBOR_RESIDUAL_WGSL, 'deltaResidual');
  for (const guard of ['let one = runtimeOne();', 'let difference = highDelta * one;', 'let recoveredSecond = (first - difference) * one;',
    '(first - (difference + recoveredSecond)) + (recoveredSecond - second)']) {
    assert.ok(residual.includes(guard), `deltaResidual lost its guard: ${guard}`);
  }
});

test('each kernel takes the runtime one from the length of one of its bound buffers', () => {
  assert.ok(NEIGHBOR_BINDINGS_WGSL.endsWith(NEIGHBOR_RESIDUAL_WGSL), 'neighbor kernels share the guarded residual helpers');
  for (const source of [...PAIR_SHADERS, COORDINATION_SHADER, EXACT_PAIR_TEST_SHADER]) {
    const definitions = [...source.matchAll(/fn runtimeOne\(\) -> f32 \{ return f32\(min\(arrayLength\(&(\w+)\), 1u\)\); \}/g)];
    assert.equal(definitions.length, 1, 'exactly one runtime-valued definition');
    assert.equal(source.match(/fn runtimeOne\(/g).length, 1);
    assert.match(source, new RegExp(`var<storage, read(?:_write)?> ${definitions[0][1]}: array<`), 'the length must belong to a bound runtime-sized array');
  }
});

test('the kernels that need exact pairs are the Voronoi, ideal-strain, reference-strain and displacement shaders', async () => {
  const fake = pairGpu(evaluate), compiled = [];
  const createShaderModule = fake.device.createShaderModule;
  fake.device.createShaderModule = options => { compiled.push(options.code); return createShaderModule(options); };
  const runtime = await runtimeFor(fake.gpu);
  try {
    assert.equal(runtime.exactPairs, true);
    compiled.length = 0;
    await runtime.warmup();
    assert.equal(compiled.length, 21, 'the general warmup compiles every kernel that automatic selection runs');
    await runtime.warmup({ analysisKinds: ['voronoi', 'voronoiRadical'] });
    assert.equal(compiled.length, 24, 'and the Voronoi kernels compile on request');
    assert.deepEqual(new Set(compiled.filter(usesExactPairs)), new Set(PAIR_SHADERS));
    assert.deepEqual([...EXACT_PAIR_ANALYSIS_KINDS].sort(), ['displacement', 'referenceStrain', 'strain', 'voronoi']);
    assert.equal(usesExactPairs(EXACT_PAIR_TEST_SHADER), true);
  } finally { runtime.close(); }
});

test('self-test operands have exact, mostly nonzero error terms', () => {
  const positions = exactPairTestVectors(), expected = exactPairExpected(positions);
  assert.deepEqual(exactPairTestVectors(), positions, 'the operands are fixed');
  const integer = (value, scale) => { const scaled = value * 2 ** scale; assert.ok(Number.isInteger(scaled)); return BigInt(scaled); };
  const nonzero = { sum: 0, product: 0, residual: 0 };
  for (let row = 0; row < EXACT_PAIR_TEST_ROWS; row += 1) {
    const partner = (row + 1) % EXACT_PAIR_TEST_ROWS;
    assert.deepEqual(Array.from(positions.subarray(row * 8 + 3, row * 8 + 8)), [0, 0, 0, 0, 0], 'low words stay zero');
    for (let axis = 0; axis < 3; axis += 1) {
      const a = positions[row * 8 + axis], b = positions[partner * 8 + axis], offset = row * ROW_WORDS + axis * 8;
      assert.ok(Math.abs(a) >= .125 && Math.abs(a) < 8);
      const [sum, sumError, product, productError] = expected.subarray(offset, offset + 4);
      assert.deepEqual(expected.subarray(offset + 4, offset + 8), expected.subarray(offset, offset + 4), 'ds and dd helpers share expectations');
      assert.equal(sum, Math.fround(a + b)); assert.equal(product, Math.fround(a * b));
      assert.equal(integer(sum, 26) + integer(sumError, 26), integer(a, 26) + integer(b, 26));
      assert.equal(integer(product, 52) + integer(productError, 52), integer(a, 26) * integer(b, 26));
      const residual = expected[row * ROW_WORDS + 24 + axis];
      assert.equal(integer(Math.fround(a - b), 26) + integer(residual, 26), integer(a, 26) - integer(b, 26));
      nonzero.sum += sumError !== 0; nonzero.product += productError !== 0; nonzero.residual += residual !== 0;
    }
  }
  for (const count of Object.values(nonzero)) assert.ok(count >= EXACT_PAIR_TEST_ROWS, JSON.stringify(nonzero));
});

test('the self-test accepts IEEE Float32 pair arithmetic and rejects the observed compiler cancellations', async () => {
  const positions = exactPairTestVectors(), expected = exactPairExpected(positions);
  assert.deepEqual(evaluate(positions), expected, 'the shipped algorithms are error-free transforms');
  assert.equal(await verifyExactPairs(pairGpu(evaluate).device), true);
  // Every operand cancelled (NVIDIA) or only the restored first operand (SPIRV-Tools).
  for (const rewrite of ['operand', 'restored']) {
    assert.notDeepEqual(evaluate(positions, rewrite), expected);
    assert.equal(await verifyExactPairs(pairGpu(values => evaluate(values, rewrite)).device), false, rewrite);
  }
  const oneBit = values => { const results = evaluate(values); results[ROW_WORDS * 5 + 3] *= 1 + 2 ** -23; return results; };
  assert.equal(await verifyExactPairs(pairGpu(oneBit).device), false, 'a single changed bit fails');
  const negativeZero = values => evaluate(values).map(value => value === 0 ? -0 : value);
  assert.equal(await verifyExactPairs(pairGpu(negativeZero).device), true, 'the sign of a zero error is not compared');
});

test('a device that cannot compile or run the self-test is reported as inexact, with its buffers released', async () => {
  const idle = fakeGpu(), created = [], createBuffer = idle.device.createBuffer;
  idle.device.createBuffer = options => { const buffer = createBuffer(options); created.push(buffer); return buffer; };
  assert.equal(await verifyExactPairs(idle.device), false, 'no shader ran');
  assert.equal(created.length, 3); assert.ok(created.every(buffer => buffer.destroyed));
  const rejecting = pairGpu(evaluate);
  rejecting.device.createComputePipelineAsync = async () => { throw new Error('Shader compilation failed.'); };
  assert.equal(await verifyExactPairs(rejecting.device), false);
  const invalid = pairGpu(evaluate);
  invalid.device.popErrorScope = async () => ({ message: 'Invalid shader.' });
  assert.equal(await verifyExactPairs(invalid.device), false);
});

test('a runtime without exact pairs refuses pair pipelines, skips them in warmup and still prepares frames', async () => {
  const fake = fakeGpu(), compiled = [];
  const createShaderModule = fake.device.createShaderModule;
  fake.device.createShaderModule = options => { compiled.push(options.code); return createShaderModule(options); };
  const runtime = await runtimeFor(fake.gpu), frame = crystalFrame('fcc', 2);
  try {
    assert.equal(runtime.exactPairs, false); assert.equal(runtime.cacheStatus().exactPairs, false);
    assert.equal(runtime.cacheStatus().pipelineCount, 0, 'the self-test pipeline is not a cached kernel');
    assert.throws(() => runtime.requireExactPairs(), { name: 'GpuUnavailableError', message: /exact double-float arithmetic/ });
    for (const source of PAIR_SHADERS) {
      await assert.rejects(runtime.compilePipeline(source), { name: 'GpuUnavailableError', message: /exact double-float arithmetic/ });
    }
    await runtime.compilePipeline(COORDINATION_SHADER);
    compiled.length = 0;
    assert.equal((await runtime.warmup({ analysisKinds: ['voronoi', 'voronoiRadical'] })).pipelineCount, 3, 'only the neighbor index pipelines are added');
    assert.equal(compiled.some(usesExactPairs), false);
    assert.equal((await runtime.warmup()).pipelineCount, 18);
    assert.equal(compiled.some(usesExactPairs), false);
    runtime.configureCache({ frameCount: 1, currentIndex: 0 });
    const status = await runtime.prepareFrame(frame, { frameIndex: 0, analysisKinds: ['voronoi'] });
    assert.equal(status.uploadCount, 1); assert.deepEqual(status.cachedFrameIndexes, [0]);
    assert.deepEqual(status.preparedVoronoiFrameIds, []); assert.equal(status.voronoiWorkspaceAtoms, 0);
  } finally { runtime.close(); }
});

test('pair kernels raise GpuUnavailableError on a runtime without exact pairs and leave no workspace behind', async () => {
  const runtime = await runtimeFor(fakeGpu().gpu), frame = crystalFrame('fcc', 2);
  const mapping = createReferenceMapping(frame, frame);
  const unavailable = { name: 'GpuUnavailableError', message: /exact double-float arithmetic/ };
  try {
    await assert.rejects(analyzeGpuVoronoi(runtime, frame), unavailable);
    assert.ok(runtime.voronoiWorkspace === null, 'no cell workspace is reserved');
    assert.equal(runtime.allocatedBytes, 0, 'Voronoi fails before any upload');
    await assert.rejects(analyzeGpuVoronoi(runtime, frame, { radii: new Float64Array(frame.types.length).fill(1.2) }), unavailable);
    await assert.rejects(prepareGpuVoronoiFrame(runtime, frame), unavailable);
    assert.ok(runtime.voronoiWorkspace === null && runtime.frames.size === 0, 'direct Voronoi preparation stops before its upload');
    await assert.rejects(analyzeGpuReferenceStrain(runtime, frame, { referenceFrame: frame, referenceFractional: frame.fractional,
      referenceCell: frame.cell, referenceMapping: mapping, cutoff: 3.1 }), unavailable);
    await assert.rejects(analyzeGpuDisplacement(runtime, frame, await prepareDisplacements(frame, frame)), unavailable);
    await assert.rejects(analyzeGpuAtomicStrain(runtime, frame, { references: [{ structure: 1, a: 4 }], ptmInput: await calculatePtm(frame) }), unavailable);
    assert.equal(runtime.analysisFramePins.size, 0);
    const indexBytes = [...runtime.indexes.values()].flatMap(index => [index.configBuffer, index.headsBuffer, index.nextBuffer])
      .reduce((bytes, buffer) => bytes + buffer.size, 0);
    assert.equal(runtime.allocatedBytes, runtime.residentBytes + indexBytes + runtime.stagingPoolBytes,
      'only resident inputs, the reference index and pooled staging remain allocated');
  } finally { runtime.close(); }
});

test('displacement magnitudes never divide by a root that a driver returned as zero', async () => {
  const { DISPLACEMENT_SHADER } = await import('../src/analysis/gpu/displacement-shaders.js');
  const guard = DISPLACEMENT_SHADER.indexOf('if (!(root >= 0.5)) { flags[index] = 2u; return; }');
  const root = DISPLACEMENT_SHADER.indexOf('let root = sqrt(max(0.0, dsValue(squared)));');
  const division = DISPLACEMENT_SHADER.indexOf('dsDivide(error, vec2f(2.0 * root, 0.0))');
  // Flag 2 sends the atom to the exact CPU correction (see gpu/displacement.js).
  assert.ok(root >= 0 && guard > root && division > guard);
});
