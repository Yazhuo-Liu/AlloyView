import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { cartesianToFractional, cellVertices, createCell, fractionalToCartesian } from '../src/data/model.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import { AtomPrimitiveLayer, normalizeVectorOptions } from '../src/render/atom-primitives.js';
import { createReplication } from '../src/render/replication.js';
import { normalizeTrajectoryLineOptions } from '../src/render/trajectory-line-layer.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const layerNames = ['primitiveLayer', 'dislocationLayer', 'siteMarkerLayer', 'surfaceMeshLayer',
  'trajectoryLineLayer', 'voronoiCellLayer', 'voronoiAllCellLayer'];

// The original per-atom merge is the oracle, including the order of additions
// for skew replica offsets, and its NaN/signed-zero behavior.
function previousBounds(renderer) {
  const vertices = cellVertices(renderer.displayCell ?? renderer.frame.cell);
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  const sourceMinimum = [...minimum], sourceMaximum = [...maximum];
  for (const array of [vertices, renderer.displayPositions]) {
    for (let index = 0; index < array.length; index += 3) {
      for (let component = 0; component < 3; component++) {
        const atoms = array === renderer.displayPositions;
        if (atoms) {
          sourceMinimum[component] = Math.min(sourceMinimum[component], array[index + component]);
          sourceMaximum[component] = Math.max(sourceMaximum[component], array[index + component]);
        }
        minimum[component] = Math.min(minimum[component], array[index + component] + (atoms ? renderer.minimumOffset?.[component] ?? 0 : 0));
        maximum[component] = Math.max(maximum[component], array[index + component] + (atoms ? renderer.maximumOffset?.[component] ?? 0 : 0));
      }
    }
  }
  for (const name of layerNames) {
    if (name === 'primitiveLayer' && renderer[name]) previousVectorBounds(renderer[name], renderer, minimum, maximum);
    else renderer[name]?.extendBounds(renderer, minimum, maximum);
  }
  return { bounds: { minimum, maximum }, source: { minimum: sourceMinimum, maximum: sourceMaximum } };
}

function previousVectorBounds(layer, renderer, minimum, maximum) {
  for (const { vectors, options } of layer.vectorFields ?? []) {
    if (!options.visible) continue;
    const shift = { tail: 0, head: -1, center: -.5 }[options.anchor ?? 'tail'];
    const padding = Math.max(options.radius, options.headRadius ?? .15);
    for (let offset = 0; offset < vectors.length; offset += 3) {
      if (renderer.selectionVisibility?.[offset / 3] === 0) continue;
      if (!Number.isFinite(vectors[offset]) || !Number.isFinite(vectors[offset + 1]) || !Number.isFinite(vectors[offset + 2])) continue;
      for (let axis = 0; axis < 3; axis++) {
        const delta = vectors[offset + axis] * options.scale;
        const tail = renderer.displayPositions[offset + axis] + delta * shift, tip = tail + delta;
        minimum[axis] = Math.min(minimum[axis], Math.min(tail, tip) + (renderer.minimumOffset?.[axis] ?? 0) - padding);
        maximum[axis] = Math.max(maximum[axis], Math.max(tail, tip) + (renderer.maximumOffset?.[axis] ?? 0) + padding);
      }
    }
  }
}

function identical(actual, expected) {
  for (const edge of ['minimum', 'maximum']) {
    for (let axis = 0; axis < 3; axis++) assert.ok(Object.is(actual[edge][axis], expected[edge][axis]),
      `${edge} ${axis}: ${actual[edge][axis]} != ${expected[edge][axis]}`);
  }
}

function fixture(cell = createCell({ vectors: [-8, 1, 0, 2, 9, 1, -3, 2, 7] }), positions = Float64Array.from([1, 2, 3, 4, 5, 6])) {
  const frame = { cell, ids: Uint32Array.from({ length: positions.length / 3 }, (_, atom) => atom + 1), positions,
    fractional: cartesianToFractional(positions, cell, new Float64Array(positions.length)) };
  const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
    frame, atomCount: frame.ids.length, displayPositions: positions, rawDisplayPositions: positions, displayFractional: frame.fractional,
    periodicOrigin: [0, 0, 0], coordinateMode: 'wrapped', radiusScale: 1,
    atomColors: new Uint8Array(frame.ids.length * 3), atomRadii: new Float32Array(frame.ids.length).fill(.7),
    selectedAtoms: new Int32Array(16).fill(-1), sliceSelectedAtoms: new Int32Array(3).fill(-1),
    atomVectorFields: [], vectorOptions: normalizeVectorOptions(), bondOptions: { visible: true, radius: .08 },
    trajectoryLineOptions: normalizeTrajectoryLineOptions(), gl: { ARRAY_BUFFER: 1, STATIC_DRAW: 2, DYNAMIC_DRAW: 3, bindBuffer() {}, bufferData() {} },
    cancelSelectionGesture() {}, requestRender() {}, onProjectionChange() {},
    ...createReplication(cell, [2, 3, 1]),
  });
  return { renderer, frame };
}

test('indexed bounds exactly match the previous merge across skewed cells, origins and negative replicas', () => {
  let seed = 812;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 100; trial++) {
    const cell = createCell({ origin: [1e4 * random(), -5, 2],
      vectors: [(trial % 2 ? -1 : 1) * 8, 2, 0, 3, -7, 1, -4, 2, 6], pbc: [true, trial % 3 !== 0, true] });
    const positions = Float64Array.from({ length: trial * 3 }, () => random() * 100 - 50);
    const { renderer } = fixture(cell, positions), expected = previousBounds(renderer);
    identical(renderer.updateSceneBounds(), expected.bounds); identical(renderer.selectionSourceBounds, expected.source);
    identical(renderer.updateSceneBounds({ reuseSourceBounds: true }), expected.bounds);
    renderer.setPeriodicOrigin([.2, 0, -.3], { coordinateMode: trial % 2 ? 'wrapped' : 'unwrapped' });
    identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  }
  for (const positions of [Float64Array.of(-0, 0, -0, 0, -0, 0), Float64Array.of(NaN, 1, 2),
    Float64Array.of(Infinity, -Infinity, 0)]) {
    const { renderer } = fixture(undefined, positions);
    identical(renderer.updateSceneBounds(), previousBounds(renderer).bounds);
    identical(renderer.selectionSourceBounds, previousBounds(renderer).source);
  }
});

test('public refreshes and coordinate setters discover in-place edits of the same source array', () => {
  const { renderer, frame } = fixture(); renderer.updateSceneBounds();
  frame.positions[0] = -100;
  identical(renderer.updateSceneBounds(), previousBounds(renderer).bounds);
  frame.positions[3] = 150;
  renderer.setDisplayPositions(frame.positions);
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  frame.positions[1] = -200;
  renderer.setFrame(frame, renderer.atomColors, frame.positions, renderer.atomRadii, [2, 3, 1]);
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  const replacement = frame.positions.slice(); replacement[5] = 300;
  renderer.displayPositions = replacement;
  identical(renderer.updateSceneBounds({ reuseSourceBounds: true }), previousBounds(renderer).bounds);
  renderer.clearFrame(); assert.equal(renderer.sourceBoundsCache, null);
});

test('empty and style-only layer updates reuse source extrema while cell and layer bounds still merge', () => {
  const { renderer, frame } = fixture(); let reads = 0, extensions = 0;
  renderer.displayPositions = new Proxy(Array.from(frame.positions), {
    get(target, key) { if (/^\d+$/.test(String(key))) reads++; return target[key]; },
  });
  renderer.updateSceneBounds(); assert.equal(reads, frame.positions.length);
  renderer.trajectoryLineLayer = { setLines() {}, extendBounds(r, minimum, maximum) { extensions++; maximum[2] = Math.max(maximum[2], 30); } };
  renderer.surfaceMeshLayer = { entries: new Map(), setMesh() { return {}; }, extendBounds() { extensions++; }, clear() {} };
  reads = 0;
  renderer.setTrajectoryLines(null); renderer.setSurfaceMesh('surface', null, { opacity: .5 }); renderer.setReplications([3, 1, 2]);
  assert.equal(reads, 0); assert.equal(extensions, 6); assert.equal(renderer.sceneBounds.maximum[2], 30);
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  renderer.selectionSourceBounds.minimum[0] = -1e9;
  renderer.setTrajectoryLines(null);
  assert.equal(renderer.selectionSourceBounds.minimum[0], Math.min(frame.positions[0], frame.positions[3]), 'public bounds cannot mutate cached extrema');
});

test('cached source bounds still follow vector scale, anchors, selection hiding and negative replicas', () => {
  const { renderer } = fixture(); renderer.updateSceneBounds();
  const layer = renderer.primitiveLayer = {
    vectorFields: [], vectorOptions: normalizeVectorOptions(), extendBounds: AtomPrimitiveLayer.prototype.extendBounds,
    setVectorFields(r, fields) {
      this.vectorFields = fields.map(field => ({ ...field, options: normalizeVectorOptions(field.options) }));
      this.vectors = this.vectorFields[0]?.vectors; this.vectorOptions = this.vectorFields[0]?.options ?? normalizeVectorOptions();
    },
  };
  const fields = [{ id: 'first', vectors: Float32Array.of(-30, 2, 0, 40, 0, 5), options: { scale: 2, anchor: 'center' } },
    { id: 'second', vectors: Float32Array.of(0, -50, 0, 0, -40, 0), options: { scale: 1.5, anchor: 'head' } }];
  for (const selectionHidden of [null, Uint8Array.of(0, 255), Uint8Array.of(0, 0)]) {
    renderer.selectionVisibility = selectionHidden;
    renderer.visibility = Uint8Array.of(0, 0); // Ordinary atom hiding does not hide vector fields.
    for (const scale of [1, 3]) {
      renderer.setVectorFields(fields.map(field => ({ ...field, options: { ...field.options, scale } })));
      identical(renderer.sceneBounds, previousBounds(renderer).bounds);
      renderer.setReplications([1, 2, 3]); identical(renderer.sceneBounds, previousBounds(renderer).bounds);
    }
  }
  renderer.setVectorFields(fields.map(field => ({ ...field, options: { visible: false } })));
  assert.ok(layer.vectorFields.every(field => !field.options.visible));
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
});

test('indexed radius scans retain full validation and detect edits of reused Float32 radii', () => {
  const { renderer, frame } = fixture(); const radii = Float32Array.of(.6, .8);
  renderer.setFrame(frame, renderer.atomColors, frame.positions, radii);
  assert.equal(renderer.maximumAtomRadius, radii[1]);
  radii[0] = 2; renderer.setAtomRadii(radii); assert.equal(renderer.maximumAtomRadius, 2);
  const previousRevision = renderer.radiusRevision;
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.throws(() => renderer.setAtomRadii(Float32Array.of(.6, invalid)), /finite and greater than zero/);
    assert.equal(renderer.atomRadii, radii); assert.equal(renderer.maximumAtomRadius, 2); assert.equal(renderer.radiusRevision, previousRevision);
  }
});

test('per-field cached extrema skip coordinate/vector scans for layer, radius and replica changes', () => {
  const { renderer, frame } = fixture(); let positionReads = 0, vectorReads = 0;
  renderer.displayPositions = new Proxy(Array.from(frame.positions), {
    get(target, key) { if (/^\d+$/.test(String(key))) positionReads++; return target[key]; },
  });
  renderer.updateSceneBounds();
  const field = { id: 'force', vectors: new Proxy([20, 0, 0, 0, 40, 0], {
    get(target, key) { if (/^\d+$/.test(String(key))) vectorReads++; return target[key]; },
  }), options: normalizeVectorOptions({ anchor: 'center' }) };
  renderer.primitiveLayer = Object.assign(Object.create(AtomPrimitiveLayer.prototype), { vectorFields: [field] });
  renderer.updateSceneBounds({ reuseSourceBounds: true });
  positionReads = vectorReads = 0;
  field.options.radius = .8; field.options.color = [0, 1, 0];
  renderer.setTrajectoryLines(null); renderer.setReplications([3, 1, 2]);
  assert.equal(positionReads, 0); assert.equal(vectorReads, 0);
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  for (const scale of [-3, 1, 2]) for (const anchor of ['tail', 'head', 'center']) {
    field.options.scale = scale; field.options.anchor = anchor;
    renderer.updateSceneBounds({ reuseSourceBounds: true });
    identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  }
  field.options.visible = false; positionReads = vectorReads = 0;
  renderer.updateSceneBounds({ reuseSourceBounds: true });
  assert.equal(positionReads, 0); assert.equal(vectorReads, 0);
  renderer.setDisplayPositions(frame.positions.slice());
  assert.equal(renderer.primitiveLayer.vectorBoundsCache.size, 0, 'hidden fields release obsolete coordinate references');
});

test('explicit vector and selection setters refresh same-array edits and clearing fields releases cached sources', () => {
  const { renderer, frame } = fixture(); renderer.updateSceneBounds();
  const layer = renderer.primitiveLayer = Object.assign(Object.create(AtomPrimitiveLayer.prototype), {
    gl: renderer.gl, vectorFields: [], vectorOptions: normalizeVectorOptions(),
    vectorBuffers: { indices: {}, vectors: {}, shifts: {} }, bondBuffers: { indices: {}, vectors: {}, shifts: {} },
  });
  const vectors = Float32Array.of(-80, 0, 0, 0, 30, 0), fields = [{ id: 'force', vectors }];
  renderer.setVectorFields(fields); const first = renderer.sceneBounds.minimum[0];
  vectors[0] = -180; renderer.setVectorFields(fields);
  assert.ok(renderer.sceneBounds.minimum[0] < first); identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  frame.positions[0] = -60; renderer.setDisplayPositions(frame.positions);
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  const mask = Uint8Array.of(0, 255);
  renderer.setVisibility(Uint8Array.of(255, 255), { selectionVisibility: mask });
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  mask[0] = 255;
  renderer.setVisibility(Uint8Array.of(255, 255), { selectionVisibility: mask });
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  renderer.setVisibility(Uint8Array.of(0, 0)); // Ordinary hiding retains arrows.
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  renderer.setVectorFields([]);
  assert.equal(layer.vectorBoundsCache.size, 0); assert.equal(layer.vectorBoundsSource, null); assert.equal(layer.vectorBoundsFrame, null);
});

test('the actual HEA example retains exact bounds in wrapped and continuous displays', async () => {
  const frame = parseLammpsFrame(await readFile(new URL('../examples/hea-fcc-screw.dump', import.meta.url), 'utf8'));
  const { renderer } = fixture(frame.cell, frame.positions);
  renderer.frame = frame;
  renderer.setFrame(frame, renderer.atomColors, frame.positions, renderer.atomRadii, [2, 1, 1]);
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  const continuous = frame.unwrappedPositions ?? fractionalToCartesian(Float64Array.from(frame.fractional, (value, index) => value + (index % 3 === 0 ? 2 : 0)), frame.cell);
  renderer.setDisplayPositions(continuous, { coordinateMode: 'unwrapped' });
  identical(renderer.sceneBounds, previousBounds(renderer).bounds);
  renderer.setPeriodicOrigin([.3, .1, 0]); identical(renderer.sceneBounds, previousBounds(renderer).bounds);
});
