import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import test, { after } from 'node:test';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { compareDxaScience, validateDxaScience } from '../scripts/lib/dxa-science-compare.mjs';
import { fccScrewPairFrame, fccJunctionNetworkFrame, fccPartialDipoleFrame } from './helpers/dxa-global-fixtures.js';
import { dumpText } from './helpers/crystals.js';

const frozen = JSON.parse(await readFile(new URL('./fixtures/dxa-global-baseline.json', import.meta.url)));
const manifest = JSON.parse(await readFile(new URL('./fixtures/dxa-ovito394-manifest.json', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
let kernel, profile;
const ready = (async () => {
  const { default: createDxa } = await import('../src/analysis/dxa-kernel-threaded.mjs');
  kernel = await createDxa({ wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel-threaded.wasm', import.meta.url)),
    dxaPoolSize: 3, onDxaProfile: value => { profile = value; } });
})();
after(async () => { await ready; kernel.PThread?.terminateAllThreads(); });

function extract(frame, threads) {
  const xyz = dxaCartesianCoordinates(frame), positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
  kernel.HEAPF64.set(xyz, positions / 8); kernel.HEAPF64.set(frame.cell.vectors, cell / 8);
  kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
  try {
    kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(threads); profile = null;
    const pointer = kernel._alloy_dxa_analyze(positions, xyz.length / 3, cell,
      frame.cell.pbc.reduce((bits, enabled, axis) => bits | (enabled ? 1 << axis : 0), 0), 1, 14, 9, 0, 1, 2.5);
    assert.ok(pointer, kernel.UTF8ToString(kernel._alloy_dxa_last_error()));
    assert.equal(kernel._alloy_dxa_thread_count(), threads, 'Delaunay is never forced to serial by a callback.');
    const result = JSON.parse(kernel.UTF8ToString(pointer)); delete result.parallelEdgePasses;
    const checked = validateDxaScience({ result });
    assert.equal(checked.valid, true, checked.errors.join('\n'));
    return { result, profile };
  } finally { kernel._alloy_dxa_dispose(); kernel._free(positions); kernel._free(cell); }
}

// A full endpoint partition plus the edge between every endpoint pair. IDs,
// junction-ring order and whole-line reversal do not change this signature.
// Every coordinate/length and reciprocal ring is validated separately.
function networkContract(result, family = 'perfect') {
  const groups = new Map(), membership = new Map(), segments = new Map(result.segments.map(segment => [segment.id, segment]));
  const burgersUnits = family === 'shockley' ? 6 : 2, idealVectors = new Map();
  for (const segment of result.segments) {
    assert.equal(segment.structureType, 1);
    const ideal = segment.burgersVector.map(component => Math.round(component * burgersUnits));
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(segment.burgersVector[axis] * burgersUnits - ideal[axis]) <= 64 * Number.EPSILON,
      'Resolve the known rational lattice coordinate only within floating-point arithmetic error, not a geometric fitting tolerance.');
    assert.deepEqual(ideal.map(Math.abs).sort(), family === 'shockley' ? [1, 1, 2] : [0, 1, 1],
      `Every line carries the prescribed FCC ${family === 'shockley' ? 'a/6<112>' : 'a/2<110>'} Burgers vector.`);
    idealVectors.set(segment.id, ideal);
    for (let end = 0; end < 2; end++) {
      const members = [{ segmentId: segment.id, end }, ...segment.junctions[end]];
      const key = members.map(member => `${member.segmentId}:${member.end}`).sort().join('|');
      groups.set(key, members); membership.set(`${segment.id}:${end}`, key);
    }
  }
  const nodeRows = Array.from(groups, ([key, members]) => {
    const vectors = members.map(member => idealVectors.get(member.segmentId).map(component => component * (member.end ? -1 : 1)));
    if (members.length > 1) for (let axis = 0; axis < 3; axis++)
      assert.equal(vectors.reduce((sum, vector) => sum + vector[axis], 0), 0, 'Burgers vector is conserved at every complete junction.');
    if (members.length > 2) {
      const points = members.map(member => {
        const line = segments.get(member.segmentId).points; return line[member.end ? line.length - 1 : 0];
      });
      for (const point of points) assert.deepEqual(point, points[0], 'All arms meet at one exact exported junction position.');
    }
    return { key, signature: { degree: members.length, outgoingBurgers: vectors.map(vector => vector.map(x => x || 0).join(',')).sort() } };
  }).sort((a, b) => JSON.stringify(a.signature).localeCompare(JSON.stringify(b.signature)));
  const nodes = nodeRows.map(node => node.signature);
  const edges = result.segments.map(segment => {
    const keys = [0, 1].map(end => membership.get(`${segment.id}:${end}`));
    const burgers = [1, -1].map(sign => idealVectors.get(segment.id).map(value => value * sign || 0).join(',')).sort()[0];
    return { degrees: keys.map(key => groups.get(key).length).sort(), self: keys[0] === keys[1],
      burgers, closed: segment.closed, infinite: segment.isInfinite };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // Enumerate only permutations within indistinguishable node-label classes.
  // Keeping endpoint IDs in every edge proves the complete incidence graph;
  // separate node/edge histograms alone could miss rewired junctions.
  const classes = [];
  for (const node of nodeRows) {
    const label = JSON.stringify(node.signature);
    if (classes.at(-1)?.label !== label) classes.push({ label, keys: [] });
    classes.at(-1).keys.push(node.key);
  }
  let canonical = null, states = 0;
  const mapping = new Map();
  const visitClass = (index, offset) => {
    if (index === classes.length) {
      assert.ok(++states <= 100000, 'Small-fixture complete graph canonicalization budget.');
      const incidence = result.segments.map(segment => {
        const ends = [0, 1].map(end => mapping.get(membership.get(`${segment.id}:${end}`)));
        const representations = [1, -1].map(sign => JSON.stringify([
          ...(sign === 1 ? ends : ends.toReversed()),
          idealVectors.get(segment.id).map(value => value * sign || 0), segment.closed, segment.isInfinite]));
        return representations.sort()[0];
      }).sort();
      const encoded = JSON.stringify(incidence);
      if (canonical === null || encoded < canonical) canonical = encoded;
      return;
    }
    const keys = classes[index].keys, used = new Set();
    const permute = position => {
      if (position === keys.length) { visitClass(index + 1, offset + keys.length); return; }
      for (const key of keys) if (!used.has(key)) {
        used.add(key); mapping.set(key, offset + position); permute(position + 1); used.delete(key); mapping.delete(key);
      }
    };
    permute(0);
  };
  visitClass(0, 0);
  return { burgersUnits, nodes, edges, incidence: canonical };
}

function checkPairWinding(result, frame, { lineAxis = 2, burgersAxis = 2 } = {}) {
  assert.equal(result.segments.length, 2);
  const lengthScale = Math.hypot(...frame.cell.vectors), coordinateError = 8 * 1e-10 * lengthScale;
  // Native tessellation perturbs each input coordinate by 1e-10 times the
  // cell length scale. This bound addresses only periodic endpoint closure,
  // not differences between independently triangulated core polylines.
  const charges = [];
  for (const segment of result.segments) {
    assert.equal(segment.closed, true); assert.equal(segment.isInfinite, true);
    const first = segment.points[0], last = segment.points.at(-1), winding = last[lineAxis] - first[lineAxis];
    for (let axis = 0; axis < 3; axis++) if (axis !== lineAxis) assert.ok(Math.abs(last[axis] - first[axis]) <= coordinateError);
    assert.ok(Math.abs(Math.abs(winding) - frame.cell.vectors[lineAxis * 4]) <= coordinateError, 'Each line winds once around its prescribed periodic axis.');
    charges.push(Math.sign(winding * segment.spatialBurgersVector[burgersAxis]));
    for (let end = 0; end < 2; end++) assert.deepEqual(segment.junctions[end], [{ segmentId: segment.id, end: 1 - end }]);
  }
  assert.deepEqual(charges.sort(), [-1, 1], 'The separated analytical dislocations have opposite signed Burgers winding.');
}

for (const [name, referenceName, makeFrame] of [['screw-pair', 'screw-pair', fccScrewPairFrame],
  ['junction-network', 'crossing-network', fccJunctionNetworkFrame], ['shockley-partials', 'shockley-partials', fccPartialDipoleFrame]]) {
  test(`true PDEL ${name} preserves independent network contracts and returns to exact BDEL in the same kernel`, async t => {
    await ready;
    const frame = makeFrame(), provenance = manifest.cases.find(item => item.name === referenceName);
    assert.equal(hash(dumpText([frame], { element: 'Ni' })), provenance.sourceSha256,
      'Independent OVITO reference was generated from this exact scientific input.');
    const compressed = await readFile(new URL(`./fixtures/${provenance.archive}`, import.meta.url));
    assert.equal(hash(compressed), provenance.archiveSha256);
    const referenceBytes = gunzipSync(compressed); assert.equal(hash(referenceBytes), provenance.jsonSha256);
    const report = JSON.parse(referenceBytes), reference = report.cases[0].science;
    assert.equal(report.ovitoVersion, '3.9.4'); assert.equal(report.complete, true);
    assert.deepEqual(report.cases[0].settings, provenance.settings);
    for (const [key, value] of Object.entries({ input_crystal_structure: 'Lattice.FCC', trial_circuit_length: 14,
      circuit_stretchability: 9, line_smoothing_level: 1, line_point_separation: 2.5, only_perfect_dislocations: false }))
      assert.equal(provenance.settings[key], value, `Reference uses the same ${key} setting as the native extraction.`);
    const volume = frame.cell.vectors[0] * frame.cell.vectors[4] * frame.cell.vectors[8];
    const referenceValidation = validateDxaScience({ result: { ...reference.result, lattice: 1, volume } });
    assert.equal(referenceValidation.valid, true, referenceValidation.errors.join('\n'));
    const family = name === 'shockley-partials' ? 'shockley' : 'perfect';
    const expectedContract = networkContract(reference.result, family);
    if (name === 'screw-pair') checkPairWinding(reference.result, frame);
    else if (name === 'shockley-partials') checkPairWinding(reference.result, frame, { lineAxis: 0, burgersAxis: 1 });
    else {
      assert.deepEqual(expectedContract.nodes.map(node => node.degree).sort(), [1, 1, 1, 1, 1, 1, 4, 4]);
      assert.equal(expectedContract.edges.filter(edge => edge.degrees.every(degree => degree === 4)).length, 1);
    }
    let serial;
    for (const threads of [1, 4, 1]) {
      const output = extract(frame, threads), result = output.result;
      assert.deepEqual(result.atomStructureTypes, reference.result.atomStructureTypes, 'Compare every independent atom label, not a histogram.');
      assert.deepEqual(networkContract(result, family), expectedContract, 'Compare all endpoint nodes, connecting edges and signed junction Burgers vectors.');
      if (name === 'screw-pair') checkPairWinding(result, frame);
      else if (name === 'shockley-partials') {
        checkPairWinding(result, frame, { lineAxis: 0, burgersAxis: 1 });
        const layers = new Map();
        result.atomStructureTypes.forEach((type, atom) => {
          if (type === 2) { const layer = Math.floor(atom / 2) % 24; layers.set(layer, (layers.get(layer) ?? 0) + 1); }
        });
        assert.deepEqual(Array.from(layers).sort((a, b) => a[0] - b[0]), [[11, 108], [12, 108]],
          'The two adjacent HCP layers identify the bounded intrinsic stacking-fault ribbon.');
      }
      if (threads === 1) {
        assert.equal(hash(JSON.stringify(result)), frozen.fixtures[name].scienceHash, 'Full native BDEL scientific output is frozen before P0/P1.');
        assert.ok(!Object.keys(output.profile.counters).some(key => key.startsWith('geogram.pdel.')));
        if (serial) assert.deepEqual(result, serial); else serial = result;
      } else {
        const counters = output.profile.counters, tail = counters['geogram.pdel.sequentialTailPoints'];
        assert.equal(counters['geogram.pdel.workerCount'], 4);
        assert.ok(counters['delaunay.totalPoints'] > counters['geogram.pdel.bootstrapPoints']);
        assert.ok(Object.entries(counters).some(([key, value]) => /^geogram\.pdel\.level\.\d+\.points$/.test(key) && value > 0));
        for (let worker = 1; worker < 4; worker++) assert.ok(counters[`geogram.pdel.worker.${worker}.insertedPoints`] > tail,
          'Each secondary worker inserts more points than the entire sequential tail, proving actual parallel insertion.');
        const comparison = compareDxaScience({ result: serial, cell: frame.cell }, { result, cell: frame.cell }, { mode: 'semantic' });
        if (family === 'perfect') assert.notEqual(comparison.status, 'different', comparison.reasons.join('\n'));
        // PDEL can choose a different legal core path. Partial lattice-vector
        // arithmetic can also differ in its last bits. The strict comparator
        // keeps its different/inconclusive status; it is never a tolerance-
        // based assertion of complete scientific equivalence.
        t.diagnostic(`BDEL/PDEL full science comparison: ${comparison.status}; ${comparison.reasons.join(' ')}`);
      }
    }
    // The full pinned external coordinates are retained. Topology and atom
    // labels above are independently verified; the differing core geometry
    // must not silently be promoted to full scientific equivalence.
    const scientificCell = cell => ({ vectors: Array.from(cell.vectors), origin: Array.from(cell.origin), pbc: Array.from(cell.pbc) });
    assert.deepEqual(scientificCell(reference.cell), scientificCell(frame.cell));
    const external = { result: { ...reference.result, lattice: 1, volume: serial.volume }, cell: scientificCell(reference.cell) };
    const comparison = compareDxaScience(external, { result: serial, cell: scientificCell(frame.cell) }, { mode: 'semantic' });
    t.diagnostic(`OVITO/native full science comparison: ${comparison.status}; ${comparison.reasons.join(' ')}`);
  });
}

// Synthetic graph mutation test, not an atomistic/physical fixture. The two
// networks have identical degree and Burgers histograms at every node and
// edge, but one connected ring has been rewired into two disconnected rings.
test('complete junction canonicalization rejects incidence rewiring with identical graph histograms', () => {
  const rings = sizes => {
    const segments = [], endpoints = new Map();
    let offset = 0;
    for (const size of sizes) {
      for (let vertex = 0; vertex < size; vertex++) for (let copy = 0; copy < 2; copy++) {
        const first = offset + vertex, last = offset + (vertex + 1) % size;
        const points = [[first, first * first, 0], [last, last * last, 0]];
        const segment = { id: segments.length, clusterId: 1, structureType: 1,
          burgersVector: [.5, .5, 0], spatialBurgersVector: [.5, .5, 0], points,
          length: Math.hypot(last - first, last * last - first * first), closed: false, isInfinite: false, junctions: [[], []] };
        segments.push(segment);
        for (const [end, node] of [[0, first], [1, last]]) {
          if (!endpoints.has(node)) endpoints.set(node, []);
          endpoints.get(node).push({ segmentId: segment.id, end });
        }
      }
      offset += size;
    }
    for (const members of endpoints.values()) for (const member of members)
      segments[member.segmentId].junctions[member.end] = members.filter(other => other !== member);
    return { segments, atomStructureTypes: [], lattice: 1, volume: 1,
      totalLength: segments.reduce((sum, segment) => sum + segment.length, 0) };
  };
  const first = rings([6]), rewired = rings([3, 3]);
  assert.equal(validateDxaScience({ result: first }).valid, true);
  assert.equal(validateDxaScience({ result: rewired }).valid, true);
  const one = networkContract(first), two = networkContract(rewired);
  assert.deepEqual(one.nodes, two.nodes); assert.deepEqual(one.edges, two.edges);
  assert.notEqual(one.incidence, two.incidence, 'Complete incidence distinguishes the two networks.');
});
