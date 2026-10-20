import assert from 'node:assert/strict';
import test from 'node:test';
import { attachFrameSummary, frameCoordinateBounds, frameTypeCounts, frameTypeOrder, fractionalToCartesianSummary } from '../src/data/frame-summary.js';
import { createCell, fractionalToCartesian, frameTransferables } from '../src/data/model.js';
import { replicateFrame } from '../src/data/replicate.js';
import { parseCfg } from '../src/io/cfg.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import { parseLammpsData } from '../src/io/lammps-data.js';
import { parsePdbFrame } from '../src/io/pdb.js';
import { parsePoscar } from '../src/io/poscar.js';
import { parseXyzFrame } from '../src/io/xyz.js';
import { colorsByType } from '../src/render/palette.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';
import { createAttributeRegistry } from '../src/properties/global-attributes.js';
import { TrajectoryProcessor } from '../src/workers/trajectory-processor.js';

function bounds(positions) {
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) for (let axis = 0; axis < 3; axis++) {
    minimum[axis] = Math.min(minimum[axis], positions[offset + axis]);
    maximum[axis] = Math.max(maximum[axis], positions[offset + axis]);
  }
  return { minimum, maximum };
}

function checkSummary(frame) {
  assert.equal(frame.summary.positions, frame.positions);
  assert.equal(frame.summary.types, frame.types);
  const counts = new Uint32Array(frame.typeLabels.length);
  for (const type of frame.types) counts[type]++;
  assert.deepEqual(frameTypeCounts(frame), counts);
  assert.deepEqual(frameTypeOrder(frame), [...new Set(frame.types)]);
  assert.deepEqual(frameCoordinateBounds(frame), bounds(frame.positions));
}

const dump = `ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n3\nITEM: BOX BOUNDS xy xz yz pp ff pp\n-2 12 1\n0 9 0.5\n0 7 -0.5\nITEM: ATOMS id type x y z ix iy iz\n9 7 11.1 -12 7.2 2 0 -1\n3 2 0.123456789 3.5 1.1 0 0 0\n6 7 -4.3 22 2.4 -1 0 1\n`;
const cfg = `Number of particles = 3\nH0(1,1) = 10.123456789\nH0(1,2) = 0\nH0(1,3) = 0\nH0(2,1) = 1.3\nH0(2,2) = 9\nH0(2,3) = 0\nH0(3,1) = 0.5\nH0(3,2) = 0.7\nH0(3,3) = 8\n.NO_VELOCITY.\nentry_count = 3\n55.845\nFe\n-0.001 0.3333333333 0.7\n0.2 0.3 1.1\n58.69\nNi\n0.7 0.1 0.3\n`;
const xyz = `3\nLattice="10.123456789 0 0 1.3 9 0 0.5 0.7 8" pbc="T F T"\nFe -0.001 0.3333333333 9.7\nNi 12.2 -0.3 1.1\nFe 0.7 21.1 0.3\n`;
const molecule = `3\nplain molecule\nFe -0 -0 -0\nNi 123.123456789 -4.2 0\nFe -9.1 0 2.3\n`;
const poscar = `tilted\n1\n10.123456789 0 0\n1.3 9 0\n0.5 0.7 8\nFe Ni\n2 1\nDirect\n-0.001 0.3333333333 0.7\n0.2 0.3 1.1\n0.7 0.1 0.3\n`;
const data = `LAMMPS data\n\n3 atoms\n2 atom types\n-2 12 xlo xhi\n0 9 ylo yhi\n0 8 zlo zhi\n1.3 0.5 0.7 xy xz yz\n\nAtoms # atomic\n\n9 2 11.1 -12 7.2 2 0 -1\n3 1 0.123456789 3.5 1.1 0 0 0\n6 2 -4.3 22 2.4 -1 0 1\n`;
const pdb = ['Fe', 'Ni', 'Fe'].map((element, index) => `ATOM  ${String(index + 1).padStart(5)}  CA  ALA A   1    ${[index + .123, -index - .5, index + .25].map(value => value.toFixed(3).padStart(8)).join('')}  1.00 12.50          ${element.padStart(2)}  `).join('\n');

test('all native parsers summarize the stored coordinates and exact populations', () => {
  for (const [parse, source] of [[parseLammpsFrame, dump], [parseCfg, cfg], [parseXyzFrame, xyz], [parseXyzFrame, molecule],
    [parsePoscar, poscar], [parseLammpsData, data], [parsePdbFrame, pdb]]) {
    checkSummary(parse(source));
    if ([parseLammpsFrame, parseCfg, parseXyzFrame].includes(parse)) checkSummary(parse(new TextEncoder().encode(source)));
  }
});

test('summary conversion preserves Float32 rounding, signed zero and non-finite extrema', () => {
  const cell = createCell({ origin: [1.123456789, 0, 0], vectors: [12.123456789, 0, 0, 1.7, -3, 0, .3, .2, 9] });
  const fractional = Float64Array.of(.333333333333, -.000000013, .7, 1.1234567, 1, -.7), types = Uint16Array.of(0, 1);
  const result = fractionalToCartesianSummary(fractional, cell, types, 2);
  assert.deepEqual(result.positions, fractionalToCartesian(fractional, cell));
  assert.deepEqual({ minimum: result.summary.minimum, maximum: result.summary.maximum }, bounds(result.positions));
  for (const positions of [Float32Array.of(-0, 0, -0, 0, -0, 0), Float64Array.of(NaN, Infinity, -Infinity, 2, 3, 4)]) {
    checkSummary(attachFrameSummary({ types, typeLabels: ['Fe', 'Ni'], positions }));
  }
});

test('structured frame transfers preserve summary aliases without coordinate copies', () => {
  const frame = parseLammpsFrame(dump), originalPositions = frame.positions, originalTypes = frame.types, originalCounts = frame.summary.typeCounts;
  const transferred = structuredClone(frame, { transfer: frameTransferables(frame) });
  assert.equal(originalPositions.byteLength, 0); assert.equal(originalTypes.byteLength, 0);
  assert.equal(originalCounts.byteLength, 0);
  checkSummary(transferred);
  assert.equal(transferred.summary.positions.buffer, transferred.positions.buffer);
  assert.equal(transferred.summary.types.buffer, transferred.types.buffer);
});

test('replaced arrays and explicit revisions reject old bounds and counts; unowned arrays are never memoized', () => {
  assert.deepEqual(frameTypeCounts({}), new Uint32Array());
  assert.equal(frameCoordinateBounds({}), null);
  const frame = parseXyzFrame(molecule), oldCounts = frame.summary.typeCounts;
  frame.positions = frame.positions.slice();
  assert.equal(frameCoordinateBounds(frame), null);
  frame.types = Uint16Array.of(1, 1, 1);
  assert.deepEqual(frameTypeCounts(frame), Uint32Array.of(0, 3));
  assert.deepEqual(frameTypeOrder(frame), [1]);
  frame.types[0] = 0;
  assert.deepEqual(frameTypeCounts(frame), Uint32Array.of(1, 2));
  assert.deepEqual(frameTypeOrder(frame), [0, 1]);
  attachFrameSummary(frame);
  frame.positions[0] = 900; frame.geometryRevision = 1;
  assert.equal(frameCoordinateBounds(frame), null);
  frame.types[0] = 1; frame.typesRevision = 1;
  assert.deepEqual(frameTypeCounts(frame), Uint32Array.of(0, 3));
  assert.deepEqual(frameTypeOrder(frame), [1]);
  assert.deepEqual(oldCounts, Uint32Array.of(2, 1));
});

test('geometry revision invalidates type summaries under the existing frame mutation contract', () => {
  const frame = parseXyzFrame(molecule);
  frame.types[0] = 1;
  frame.geometryRevision = 1;
  assert.equal(frameTypeCounts(frame, { scan: false }), null);
  assert.deepEqual(frameTypeCounts(frame), Uint32Array.of(1, 2));
  assert.deepEqual(frameTypeOrder(frame), [1, 0]);
  assert.deepEqual(colorsByType(frame).legend.items.map(item => item.count), [1, 2]);
  assert.equal(createAttributeRegistry({ frame }).get('Type.Fe.count').value, 1);
});

function renderer() {
  return Object.assign(Object.create(WebGLRenderer.prototype), {
    frame: null, contextLost: true, periodicOrigin: [0, 0, 0], coordinateMode: 'wrapped',
    selectedAtoms: new Int32Array(16).fill(-1), sliceSelectedAtoms: new Int32Array(3).fill(-1),
    repetitions: [1, 1, 1], clearScalarColorPreview() {}, cancelSelectionGesture() {}, requestRender() {},
    bondOptions: { radius: .08, visible: true }, onProjectionChange() {}, slicePlaneValues: new Float32Array(64),
  });
}

test('app frame display and metadata reuse summaries while public mutations and transformed displays refresh bounds', () => {
  const frame = parseXyzFrame(xyz), view = renderer(); let reads = 0;
  frame.positions = new Proxy(Array.from(frame.positions), { get(target, key) {
    if (/^\d+$/.test(String(key))) reads++; return target[key];
  } });
  attachFrameSummary(frame); reads = 0;
  view.setFrame(frame, new Uint8Array(9), frame.positions, null, [2, 1, 3], { useFrameSummary: true });
  assert.equal(reads, 0, 'opening the parsed frame requires no coordinate scan');
  view.setFrame(frame, new Uint8Array(9), frame.positions, null, [1, 1, 1], { useFrameSummary: true });
  assert.equal(reads, 0, 'cached revisits reuse the same source extrema');
  assert.deepEqual(view.selectionSourceBounds, bounds(frame.positions));
  view.selectionSourceBounds.minimum[0] = -9999;
  assert.notEqual(frame.summary.positionBounds.minimum[0], -9999);
  frame.positions[0] = -300; reads = 0;
  view.setDisplayPositions(frame.positions);
  assert.ok(reads > 0); assert.equal(view.selectionSourceBounds.minimum[0], -300);
  assert.equal(frameCoordinateBounds(frame), null, 'public same-array changes invalidate parser bounds');
  attachFrameSummary(frame);
  view.setPeriodicOrigin([.25, 0, -.5]);
  assert.notEqual(view.displayPositions, frame.positions);
  assert.deepEqual(view.selectionSourceBounds, bounds(view.displayPositions));
  const continuous = renderer(), unwrapped = Float64Array.from(frame.positions, (value, index) => value + (index % 3 === 0 ? 50 : 0));
  continuous.setFrame(frame, new Uint8Array(9), unwrapped, null, [1, 1, 1], { useFrameSummary: true, coordinateMode: 'unwrapped' });
  assert.deepEqual(continuous.selectionSourceBounds, bounds(unwrapped));
  assert.notEqual(frameCoordinateBounds(frame), null, 'an independent display array does not revoke wrapped-source bounds');
  const direct = renderer(); direct.setFrame(frame, new Uint8Array(9));
  assert.equal(frameCoordinateBounds(frame), null, 'default public setFrame rescans and revokes possibly stale bounds');
  frame.types = new Proxy(Array.from(frame.types), { get(target, key) {
    if (/^\d+$/.test(String(key))) reads++; return target[key];
  } });
  attachFrameSummary(frame); reads = 0;
  const registry = createAttributeRegistry({ frame });
  assert.equal(registry.get('Type.Fe.count').value, 2);
  assert.equal(reads, 0, 'type attributes use the parser histogram');
  assert.deepEqual(colorsByType(frame).legend.items.map(item => item.count), [2, 1]);
  assert.equal(reads, 3, 'colors still inspect each type only to write its RGB');
  delete frame.summary; reads = 0;
  assert.deepEqual(colorsByType(frame).legend.items.map(item => item.count), [2, 1]);
  assert.equal(reads, 3, 'unowned frames retain the original fused color/count pass');
});

test('smoothing and physical replication replace summary aliases and describe final coordinates', async () => {
  const frames = [0, 1, 2].map(offset => parseXyzFrame(xyz.replace('12.2', String(12.2 + offset))));
  const processor = new TrajectoryProcessor({ readFrame: async index => structuredClone(frames[index]), getFrameCount: async () => frames.length });
  const center = structuredClone(frames[1]), oldPositions = center.positions;
  const smoothed = await processor.prepare(center, 1, { smoothing: 1 });
  assert.notEqual(smoothed.positions, oldPositions);
  assert.notEqual(smoothed.summary.positions, oldPositions);
  checkSummary(smoothed);
  const transferred = structuredClone(smoothed, { transfer: frameTransferables(smoothed) });
  checkSummary(transferred);
  const replicated = await replicateFrame(transferred, [2, 1, 3]);
  checkSummary(replicated);
  assert.deepEqual(frameTypeCounts(replicated), Uint32Array.of(12, 6));
});
