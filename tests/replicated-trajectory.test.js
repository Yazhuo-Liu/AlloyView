import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculatePreparedDisplacements, computeDisplacements, minimumImageDisplacement, prepareDisplacements } from '../src/analysis/displacement.js';
import { calculateReferenceStrain, createReferenceMapping, REFERENCE_STRAIN_FIELDS } from '../src/analysis/reference-strain.js';
import { prepareGpuDisplacementParameters } from '../src/analysis/gpu/displacement.js';
import { prepareGpuReferenceParameters } from '../src/analysis/gpu/reference-strain.js';
import { cellFaceHeights, createCell, fractionalToCartesian, imageLatticeCell, invert3, wrapFractional, wrappedSourceRepetitions } from '../src/data/model.js';
import { replicateFrame } from '../src/data/replicate.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import { crystalFrame } from './helpers/crystals.js';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const COUNTS = [1, 2, 3].flatMap(a => [1, 2, 3].flatMap(b => [1, 2, 3].map(c => [a, b, c])));

function near(actual, expected, tolerance = 2e-6, label = '') {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance, `${label} [${index}]: ${actual[index]} != ${expected[index]}`);
  }
}

function workerFactory() {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); }, terminate() { worker.terminate(); } };
  };
}

/** A wrapped two-frame source: the current frame is the reference deformed by
 * the row-major matrix F (x' = F x) and moved by a uniform reduced shift, then
 * folded into its cell as a dump without image flags stores it. `continuous`
 * keeps the unwrapped reduced coordinates that define the expected motion;
 * `offset` only places reference atoms beside the faces they then cross. */
function wrappedPair(source, { matrix = IDENTITY, offset = [0, 0, 0], shift = [0, 0, 0] } = {}) {
  const count = source.ids.length, pbc = source.cell.pbc, h = source.cell.vectors;
  const start = wrapFractional(source.fractional.map((value, index) => value + offset[index % 3]), pbc, new Float64Array(count * 3));
  const continuous = Float64Array.from(start, (value, index) => value + shift[index % 3]);
  const vectors = [];
  for (let vector = 0; vector < 3; vector += 1) for (let row = 0; row < 3; row += 1) {
    vectors.push(matrix[row * 3] * h[vector * 3] + matrix[row * 3 + 1] * h[vector * 3 + 1] + matrix[row * 3 + 2] * h[vector * 3 + 2]);
  }
  const cell = createCell({ vectors, pbc, triclinic: true });
  const frame = (fractional, frameCell) => {
    const wrapped = wrapFractional(fractional, pbc, new Float64Array(count * 3));
    return { ...source, cell: frameCell, fractional: wrapped, idSource: 'explicit',
      positions: fractionalToCartesian(wrapped, frameCell, new Float64Array(count * 3)) };
  };
  return { reference: frame(start, source.cell), current: frame(continuous, cell), start, continuous };
}

/** Continuous motion of every physical copy, in the row order replicateFrame writes. */
function expectedCopyDisplacements({ reference, current, start, continuous }, counts) {
  const count = reference.ids.length, expected = [];
  for (let k = 0; k < counts[2]; k += 1) for (let j = 0; j < counts[1]; j += 1) for (let i = 0; i < counts[0]; i += 1) {
    for (let atom = 0; atom < count; atom += 1) for (let axis = 0; axis < 3; axis += 1) {
      let value = 0;
      for (const [direction, image] of [i, j, k].entries()) {
        value += (continuous[atom * 3 + direction] + image) * current.cell.vectors[direction * 3 + axis]
          - (start[atom * 3 + direction] + image) * reference.cell.vectors[direction * 3 + axis];
      }
      expected.push(value);
    }
  }
  return expected;
}

async function replicatePair(pair, counts) {
  const [reference, current] = await Promise.all([pair.reference, pair.current].map(frame => replicateFrame(frame, counts)));
  return { reference, current };
}

function strain(current, reference, cutoff, sourceRepetitions = wrappedSourceRepetitions(current, reference)) {
  return calculateReferenceStrain(current, { referenceFractional: reference.fractional, referenceCell: reference.cell,
    referenceMapping: createReferenceMapping(current, reference), cutoff, sourceRepetitions });
}

test('wrapped sources report their repeat counts; image data, unit repeats and unreplicated frames do not', async () => {
  const source = { ...crystalFrame('fcc', 1, 4), idSource: 'explicit' };
  const flagged = { ...source, imageFlags: new Int32Array(source.ids.length * 3) };
  const unwrapped = { ...source, unwrappedPositions: Float64Array.from(source.positions) };
  const wrapped = await replicateFrame(source, [2, 1, 3]);
  assert.deepEqual(wrapped.physicalReplication, { repetitions: [2, 1, 3], sourceAtomCount: 4, wrappedSource: true });
  assert.deepEqual(wrappedSourceRepetitions(wrapped), [2, 1, 3]);
  assert.deepEqual(wrappedSourceRepetitions(wrapped, await replicateFrame(source, [2, 1, 3])), [2, 1, 3]);
  assert.notEqual(wrappedSourceRepetitions(wrapped), wrapped.physicalReplication.repetitions, 'callers receive their own array');
  for (const continuous of [flagged, unwrapped]) {
    const replicated = await replicateFrame(continuous, [2, 1, 3]);
    assert.equal(replicated.physicalReplication.wrappedSource, false);
    assert.equal(wrappedSourceRepetitions(replicated, await replicateFrame(continuous, [2, 1, 3])), null);
    // One wrapped frame of the pair is enough to need the source lattice.
    assert.deepEqual(wrappedSourceRepetitions(replicated, wrapped), [2, 1, 3]);
    assert.deepEqual(wrappedSourceRepetitions(wrapped, replicated), [2, 1, 3]);
    assert.deepEqual(wrappedSourceRepetitions(replicated, source), [2, 1, 3]);
  }
  assert.equal(wrappedSourceRepetitions(source), null);
  assert.equal(wrappedSourceRepetitions(source, wrapped), null, 'the current cell is the lattice when it is not replicated');
  assert.equal(wrappedSourceRepetitions(await replicateFrame(source, [1, 1, 1])), null);
  assert.equal(wrappedSourceRepetitions({ ...source, physicalReplication: { sourceAtomCount: 4 } }), null);
  // The record survives a structured clone, as from the replication Worker.
  assert.deepEqual(wrappedSourceRepetitions(structuredClone({ physicalReplication: wrapped.physicalReplication })), [2, 1, 3]);
});

test('the image lattice divides each cell vector by its repeat count and validates the counts', () => {
  const cell = createCell({ origin: [1, 2, 3], vectors: [12, 0, 0, 3, 9, 0, 2, -4, 18], pbc: [true, false, true], triclinic: true });
  assert.equal(imageLatticeCell(cell), cell);
  assert.equal(imageLatticeCell(cell, null), cell);
  const lattice = imageLatticeCell(cell, [3, 1, 2]);
  assert.deepEqual([...lattice.vectors], [4, 0, 0, 3, 9, 0, 1, -2, 9]);
  assert.deepEqual([lattice.origin, lattice.pbc, lattice.triclinic], [cell.origin, cell.pbc, true]);
  assert.deepEqual([...cell.vectors], [12, 0, 0, 3, 9, 0, 2, -4, 18], 'the frame cell is not modified');
  near(cellFaceHeights(lattice), Array.from(cellFaceHeights(cell), (height, axis) => height / [3, 1, 2][axis]), 1e-12);
  assert.deepEqual([...imageLatticeCell(cell, [1, 1, 1]).vectors], [...cell.vectors]);
  for (const counts of [[2, 1], [2, 1, 1.5], [0, 1, 1], [-2, 1, 1], [2, 2, 1], [NaN, 1, 1], ['2', 1, 1]]) {
    assert.throws(() => imageLatticeCell(cell, counts), /Source repeat counts/, JSON.stringify(counts));
  }
});

for (const [name, vectors, pbc] of [
  ['orthogonal', [12, 0, 0, 0, 9, 0, 0, 0, 15], [true, true, true]],
  ['rotated orthogonal', [7.2, 9.6, 0, -7.2, 5.4, 0, 0, 0, 15], [true, true, true]],
  ['triclinic', [12, 0, 0, 5, 9, 0, -3, 4, 15], [true, true, true]],
  ['strongly skewed', [12, 0, 0, 11, 2, 0, 1, 1, 15], [true, true, true]],
  ['partially periodic triclinic', [12, 0, 0, 5, 9, 0, -3, 4, 15], [true, false, true]],
  ['single periodic axis', [12, 0, 0, 0, 9, 0, 0, 0, 15], [false, false, true]],
]) {
  test(`source-lattice minimum images are the shortest vector for every repeat count: ${name}`, () => {
    const cell = createCell({ vectors, pbc, triclinic: true });
    let seed = 17;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    for (const counts of COUNTS.filter(candidate => candidate.every((count, axis) => count === 1 || pbc[axis]))) {
      const lattice = imageLatticeCell(cell, counts), h = lattice.vectors;
      const minimumHeight = Math.min(...Array.from(cellFaceHeights(lattice)).filter((_, axis) => pbc[axis]));
      for (let sample = 0; sample < 12; sample += 1) {
        // Shorter than half the shortest source lattice vector, so it is the unique
        // minimum image; then moved by a source lattice vector.
        const short = [0, 1, 2].map(() => random() * 0.5 * minimumHeight);
        const jump = [0, 1, 2].map(axis => pbc[axis] ? Math.round(random() * 8) : 0);
        const moved = short.map((value, axis) => value + jump[0] * h[axis] + jump[1] * h[3 + axis] + jump[2] * h[6 + axis]);
        const resolved = minimumImageDisplacement(moved, cell, counts);
        near(resolved, short, 1e-9, `${counts} ${jump}`);
        // No source lattice image is shorter, and open axes are never shifted.
        const squared = resolved.reduce((sum, value) => sum + value * value, 0);
        for (let a = -3; a <= 3; a += 1) for (let b = -3; b <= 3; b += 1) for (let c = -3; c <= 3; c += 1) {
          if ((a && !pbc[0]) || (b && !pbc[1]) || (c && !pbc[2])) continue;
          const candidate = short.map((value, axis) => value + a * h[axis] + b * h[3 + axis] + c * h[6 + axis]);
          assert.ok(squared <= candidate.reduce((sum, value) => sum + value * value, 0) + 1e-9);
        }
      }
      // Unit repeat counts are the ordinary cell lattice, bit for bit.
      if (counts.every(count => count === 1)) {
        const vector = [20.3, -7.7, 31.1];
        assert.deepEqual(minimumImageDisplacement(vector, cell, counts), minimumImageDisplacement(vector, cell));
      }
    }
  });
}

test('a jump of one source vector is only removed by the source lattice', () => {
  const cell = createCell({ vectors: [20, 0, 0, 0, 10, 0, 0, 0, 10] });
  near(minimumImageDisplacement([-9.9, 0, 0], cell), [-9.9, 0, 0]);
  near(minimumImageDisplacement([-9.9, 0, 0], cell, [2, 1, 1]), [.1, 0, 0]);
  near(minimumImageDisplacement([10.1, 0, 0], cell, [2, 1, 1]), [.1, 0, 0]);
  // Half a source cell is the resolvable limit, as in the unreplicated analysis.
  near(minimumImageDisplacement([4.9, 0, 0], cell, [2, 1, 1]), [4.9, 0, 0]);
  near(minimumImageDisplacement([5.1, 0, 0], cell, [2, 1, 1]), [-4.9, 0, 0]);
});

for (const [name, kind, repeat, lattice, cutoff, options] of [
  ['orthogonal FCC', 'fcc', 2, 3.52, 2.8, { offset: [.23, .02, .23], shift: [.03, -.04, .05] }],
  ['triclinic HCP with a changed cell', 'hcp', 3, 2.5, 2.7,
    { matrix: [1.02, .012, .003, 0, .98, .005, 0, 0, 1.04], offset: [.1, .02, .15], shift: [.07, -.05, .03] }],
]) {
  test(`replicated wrapped trajectories give the continuous displacement and the applied deformation: ${name}`, async () => {
    const pair = wrappedPair(crystalFrame(kind, repeat, lattice), options), matrix = options.matrix ?? IDENTITY;
    for (const counts of COUNTS) {
      const { reference, current } = await replicatePair(pair, counts);
      assert.deepEqual(wrappedSourceRepetitions(current, reference), counts.every(count => count === 1) ? null : counts);
      const displacement = await computeDisplacements(current, reference);
      near(displacement.vectors, expectedCopyDisplacements(pair, counts), 2e-6, `displacement ${counts}`);
      assert.equal(displacement.unmatched, 0);
      const result = strain(current, reference, cutoff);
      assert.equal(result.incomplete, 0, `strain ${counts}`);
      for (let k = 0; k < 9; k += 1) {
        near(result[`referenceF${Math.floor(k / 3) + 1}${k % 3 + 1}`], new Array(current.ids.length).fill(matrix[k]), 2e-6, `F ${counts}`);
      }
      assert.ok(result.referenceD2min.every(value => value === 0), `affine motion has no residual ${counts}`);
    }
  });
}

test('partially periodic cells replicate and resolve images only along their periodic vectors', async () => {
  const source = crystalFrame('fcc', 2, 3.52);
  source.cell = createCell({ ...source.cell, pbc: [true, false, true] });
  const pair = wrappedPair(source, { matrix: [1.01, 0, 0, 0, 1, 0, 0, 0, .99], offset: [.2, 0, 0], shift: [.06, .01, -.04] });
  for (const counts of [[3, 1, 2], [1, 1, 3], [2, 1, 1]]) {
    const { reference, current } = await replicatePair(pair, counts);
    near((await computeDisplacements(current, reference)).vectors, expectedCopyDisplacements(pair, counts), 2e-6, `${counts}`);
    const result = strain(current, reference, 2.8);
    assert.equal(result.incomplete, 0);
    near(result.referenceF11, new Array(current.ids.length).fill(1.01));
    near(result.referenceF33, new Array(current.ids.length).fill(.99));
    assert.ok(result.referenceD2min.every(value => value === 0));
  }
});

test('a uniform shift across a boundary, replicated 2x1x1, is exactly the shift with zero strain', async () => {
  // Binary fractions keep every coordinate exact: a = 4 Å, four cells, shift −0.125 Å.
  const source = { ...crystalFrame('fcc', 4, 4), idSource: 'explicit' };
  const moved = Float64Array.from(source.fractional, (value, index) => index % 3 ? value : value - 0.125 / 16);
  const crossing = moved.filter((value, index) => index % 3 === 0 && value < 0).length;
  assert.equal(crossing, 32, 'the x = 0 plane wraps to the opposite face');
  const wrapped = wrapFractional(moved, source.cell.pbc, new Float64Array(moved.length));
  const shifted = { ...source, fractional: wrapped, positions: fractionalToCartesian(wrapped, source.cell, new Float64Array(moved.length)) };
  const unreplicated = await computeDisplacements(shifted, source);
  const reference = await replicateFrame(source, [2, 1, 1]), current = await replicateFrame(shifted, [2, 1, 1]);
  assert.equal(current.ids.length, 512);
  const displacement = await computeDisplacements(current, reference);
  assert.deepEqual([...displacement.vectors], Array.from({ length: 512 * 3 }, (_, index) => index % 3 ? 0 : -0.125));
  assert.deepEqual([...displacement.vectors], [...unreplicated.vectors, ...unreplicated.vectors]);
  const result = strain(current, reference, 3.0);
  assert.equal(result.incomplete, 0);
  for (const field of REFERENCE_STRAIN_FIELDS) {
    const match = /^referenceF(\d)(\d)$/.exec(field), expected = match && match[1] === match[2] ? 1 : 0;
    assert.ok(result[field].every(value => value === expected), `${field} is exactly ${expected}`);
  }
  // The enlarged cell's own lattice reproduces the defect: 14.3 Å jumps and undefined fits.
  const enlarged = calculatePreparedDisplacements(current, { ...await prepareDisplacements(current, reference), sourceRepetitions: null });
  assert.equal(Math.max(...enlarged.magnitudes), 15.875);
  const broken = strain(current, reference, 3.0, null);
  assert.ok(broken.incomplete > 0 && Math.max(...broken.referenceShearStrain.filter(Number.isFinite)) > 1);
});

test('a LAMMPS dump without image flags gives the same displacement and strain before and after 2x1x1 replication', async () => {
  // The reported case: 256 atoms move by −0.1 Å along x and 32 of them wrap.
  const a = 3.6, cells = 4, length = a * cells, rows = [];
  for (let i = 0; i < cells; i += 1) for (let j = 0; j < cells; j += 1) for (let k = 0; k < cells; k += 1) {
    for (const [x, y, z] of [[0, 0, 0], [.5, .5, 0], [.5, 0, .5], [0, .5, .5]]) rows.push([(i + x) * a, (j + y) * a, (k + z) * a]);
  }
  const dump = (step, images) => ['ITEM: TIMESTEP', step, 'ITEM: NUMBER OF ATOMS', rows.length, 'ITEM: BOX BOUNDS pp pp pp',
    `0 ${length}`, `0 ${length}`, `0 ${length}`, `ITEM: ATOMS id type x y z${images ? ' ix iy iz' : ''}`,
    ...rows.map(([x, y, z], atom) => {
      const moved = x - 0.1 * step, image = Math.floor(moved / length);
      return `${atom + 1} 1 ${(moved - image * length).toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}${images ? ` ${image} 0 0` : ''}`;
    }), ''].join('\n');
  const summary = values => [Math.min(...values), Math.max(...values)];
  for (const images of [false, true]) {
    const frames = [0, 1].map(step => parseLammpsFrame(dump(step, images), 'shift.dump'));
    assert.equal(Boolean(frames[1].imageFlags), images);
    const source = { displacement: await computeDisplacements(frames[1], frames[0]), strain: strain(frames[1], frames[0], 3.0) };
    const [reference, current] = await Promise.all(frames.map(frame => replicateFrame(frame, [2, 1, 1])));
    assert.deepEqual(wrappedSourceRepetitions(current, reference), images ? null : [2, 1, 1]);
    const prepared = await prepareDisplacements(current, reference);
    const displacement = calculatePreparedDisplacements(current, prepared), result = strain(current, reference, 3.0);
    for (const [label, magnitudes, shear, incomplete] of [
      ['source', calculatePreparedDisplacements(frames[1], await prepareDisplacements(frames[1], frames[0])).magnitudes, source.strain.referenceShearStrain, source.strain.incomplete],
      ['replicated', displacement.magnitudes, result.referenceShearStrain, result.incomplete]]) {
      near(summary(magnitudes), [.1, .1], 2e-6, `${label} displacement, images ${images}`);
      near(summary(shear), [0, 0], 2e-6, `${label} shear strain, images ${images}`);
      assert.equal(incomplete, 0);
    }
    near(displacement.vectors, [...source.displacement.vectors, ...source.displacement.vectors], 2e-6);
  }
});

test('replicated wrapped frames agree with the same trajectory replicated from image flags', async () => {
  const pair = wrappedPair(crystalFrame('hcp', 3, 2.5), { matrix: [1.01, .008, 0, 0, .99, .004, 0, 0, 1.02], offset: [.1, .02, .15], shift: [.07, -.05, .03] });
  // The same source frames with the images a dump would record for the current frame.
  const flagged = {
    reference: { ...pair.reference, imageFlags: new Int32Array(pair.reference.fractional.length) },
    current: { ...pair.current, imageFlags: Int32Array.from(pair.continuous, (value, index) => pair.reference.cell.pbc[index % 3] ? Math.floor(value) : 0) },
  };
  assert.ok(flagged.current.imageFlags.some(image => image !== 0));
  for (const counts of [[2, 1, 1], [3, 2, 2]]) {
    const wrapped = await replicatePair(pair, counts), continuous = await replicatePair(flagged, counts);
    assert.deepEqual(wrappedSourceRepetitions(wrapped.current, wrapped.reference), counts);
    assert.equal(wrappedSourceRepetitions(continuous.current, continuous.reference), null);
    near((await computeDisplacements(wrapped.current, wrapped.reference)).vectors,
      (await computeDisplacements(continuous.current, continuous.reference)).vectors, 2e-6, `displacement ${counts}`);
    const a = strain(wrapped.current, wrapped.reference, 2.7), b = strain(continuous.current, continuous.reference, 2.7);
    for (const field of REFERENCE_STRAIN_FIELDS) near(a[field], b[field], 2e-6, `${field} ${counts}`);
  }
});

test('copies built from image flags keep the enlarged cell and its longer unambiguous range', async () => {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const source = (x, image) => ({ cell, ids: Float64Array.from([1]), idSource: 'explicit', fractional: Float64Array.from([x / 10, .2, .3]),
    positions: Float64Array.from([x, 2, 3]), imageFlags: Int32Array.from([image, 0, 0]), types: new Uint16Array(1), typeLabels: ['Ni'], properties: [] });
  // The atom moves by 6 Å: more than half the source cell, less than half the enlarged one.
  const reference = await replicateFrame(source(7, 0), [2, 1, 1]), current = await replicateFrame(source(3, 1), [2, 1, 1]);
  const prepared = await prepareDisplacements(current, reference);
  assert.equal(prepared.sourceRepetitions, null);
  near(calculatePreparedDisplacements(current, prepared).vectors, [6, 0, 0, 6, 0, 0]);
  assert.equal((await prepareDisplacements(current, reference, { minimumImage: false })).sourceRepetitions, null);
});

test('CPU Workers receive the source repeat counts in copied and shared memory modes', async () => {
  // Each frame is large enough for the pool to split its analysis over two Workers.
  const options = { matrix: [1.002, .001, 0, 0, .999, .0005, 0, 0, 1.001], offset: [.005, .005, .99], shift: [-.008, .004, .012] };
  const counts = [2, 1, 1], large = wrappedPair(crystalFrame('sc', 30, 2.5), options), small = wrappedPair(crystalFrame('sc', 16, 2.5), options);
  const moved = await replicatePair(large, counts), strained = await replicatePair(small, counts);
  const prepared = await prepareDisplacements(moved.current, moved.reference);
  assert.deepEqual(prepared.sourceRepetitions, counts);
  const directDisplacement = calculatePreparedDisplacements(moved.current, prepared);
  near(directDisplacement.vectors, expectedCopyDisplacements(large, counts), 2e-5);
  const directStrain = strain(strained.current, strained.reference, 2.6);
  assert.equal(directStrain.incomplete, 0);
  near(directStrain.referenceF11, new Array(strained.current.ids.length).fill(1.002));
  const strainParameters = { kind: 'referenceStrain', cutoff: 2.6, referenceFractional: strained.reference.fractional,
    referenceCell: strained.reference.cell, referenceMapping: createReferenceMapping(strained.current, strained.reference),
    sourceRepetitions: wrappedSourceRepetitions(strained.current, strained.reference) };
  for (const sharedMemory of [false, true]) {
    const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory }, workerFactory: workerFactory() });
    try {
      const displacement = await pool.analyze(moved.current, { kind: 'displacement', ...prepared });
      assert.equal(displacement.sharedMemory, sharedMemory); assert.equal(displacement.workerCount, 2);
      assert.deepEqual(displacement.vectors, directDisplacement.vectors);
      assert.deepEqual(displacement.magnitudes, directDisplacement.magnitudes);
      const result = await pool.analyze(strained.current, strainParameters);
      assert.equal(result.sharedMemory, sharedMemory); assert.equal(result.workerCount, 2); assert.equal(result.incomplete, 0);
      for (const field of REFERENCE_STRAIN_FIELDS) assert.deepEqual(result[field], directStrain[field], field);
    } finally { pool.close(); }
  }
});

test('GPU settings carry the source lattice: displacement matrices and frame-strain image periods', async () => {
  const double = (floats, offset) => floats[offset] + floats[offset + 1];
  const pair = wrappedPair(crystalFrame('hcp', 3, 2.5), { offset: [.1, .02, .15], shift: [.07, -.05, .03] });
  const counts = [3, 1, 2], { reference, current } = await replicatePair(pair, counts);
  const lattice = imageLatticeCell(current.cell, counts), inverse = invert3(lattice.vectors);
  const prepared = await prepareDisplacements(current, reference);
  const displacement = new Float32Array(prepareGpuDisplacementParameters(current, prepared).settings);
  near(displacement.subarray(12, 15), cellFaceHeights(lattice), 1e-6);
  for (let component = 0; component < 9; component += 1) {
    assert.ok(Math.abs(double(displacement, 16 + component * 2) - lattice.vectors[component]) < 1e-12);
    assert.ok(Math.abs(double(displacement, 34 + component * 2) - inverse[component]) < 1e-12);
  }
  // Without minimum images no lattice is uploaded at all.
  const raw = new Float32Array(prepareGpuDisplacementParameters(current, await prepareDisplacements(current, reference, { minimumImage: false })).settings);
  assert.ok(raw.subarray(12, 52).every(value => value === 0));

  const parameters = { cutoff: 2.7, referenceFractional: reference.fractional, referenceCell: reference.cell,
    referenceMapping: createReferenceMapping(current, reference) };
  const replicated = prepareGpuReferenceParameters(current, { ...parameters, sourceRepetitions: counts });
  const floats = new Float32Array(replicated.settings);
  assert.equal(replicated.settings.byteLength, 256);
  assert.deepEqual([...floats.subarray(60, 64)], [3, 1, 2, 0]);
  near(floats.subarray(8, 11), cellFaceHeights(lattice), 1e-6);
  // The current cell itself still converts reduced bonds to Cartesian vectors.
  for (let component = 0; component < 9; component += 1) assert.ok(Math.abs(double(floats, 42 + component * 2) - current.cell.vectors[component]) < 1e-12);
  for (const sourceRepetitions of [undefined, null]) {
    const plain = new Float32Array(prepareGpuReferenceParameters(current, { ...parameters, sourceRepetitions }).settings);
    assert.deepEqual([...plain.subarray(60, 64)], [1, 1, 1, 0]);
    near(plain.subarray(8, 11), cellFaceHeights(current.cell), 1e-6);
  }
  assert.throws(() => prepareGpuReferenceParameters(current, { ...parameters, sourceRepetitions: [2, 0, 1] }), /Source repeat counts/);
});
