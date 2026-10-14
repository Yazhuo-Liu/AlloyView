import assert from 'node:assert/strict';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

// CPU preparation only. Each real WebGL context still submits its own uploads;
// these numbers do not measure GPU draw time or end-to-end frame rate.
const count = Number(process.argv.find(value => /^--atoms=/.test(value))?.split('=')[1] ?? 1_000_000);
assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 1_000_000);
function renderer() {
  return Object.assign(Object.create(WebGLRenderer.prototype), {
    frame: null, contextLost: true, periodicOrigin: [.23, .17, -.11], coordinateMode: 'wrapped',
    repetitions: [1, 1, 1], voronoiDisplayRevision: 0, displayRevision: 0,
    clearScalarColorPreview() {}, cancelSelectionGesture() {}, requestRender() {}, onProjectionChange() {},
  });
}
const cell = createCell({ vectors: [100, 0, 0, 17, 100, 0, -11, 9, 100] });
const fractional = Float64Array.from({ length: count * 3 }, (_, index) => (index * .6180339887498949) % 1);
const frame = { cell, fractional, positions: fractionalToCartesian(fractional, cell, new Float64Array(fractional.length)),
  ids: Uint32Array.from({ length: count }, (_, atom) => atom + 1) };
const colors = new Uint8Array(count * 3), radii = new Float32Array(count).fill(.7);
const main = renderer(), previous = renderer(), shared = renderer();
main.setFrame(frame, colors, frame.positions, radii); const snapshot = main.exportDisplaySnapshot();
const sample = (target, prepared) => {
  const started = performance.now();
  target.setFrame(frame, colors, frame.positions, radii, [1, 1, 1], { coordinateMode: 'wrapped', ...(prepared ? { preparedDisplay: snapshot } : {}) });
  return performance.now() - started;
};
for (let warmup = 0; warmup < 3; warmup++) { sample(previous, false); sample(shared, true); }
const oldTimes = [], newTimes = [];
for (let trial = 0; trial < 7; trial++) {
  if (trial % 2) { newTimes.push(sample(shared, true)); oldTimes.push(sample(previous, false)); }
  else { oldTimes.push(sample(previous, false)); newTimes.push(sample(shared, true)); }
}
assert.deepEqual(shared.displayPositions, previous.displayPositions);
assert.deepEqual(shared.displayFractional, previous.displayFractional);
assert.deepEqual(shared.sceneBounds, previous.sceneBounds);
assert.equal(shared.displayPositions, main.displayPositions);
assert.equal(shared.displayFractional, main.displayFractional);
const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
console.log(JSON.stringify({ atomCount: count, scope: 'Second-view CPU display preparation; excludes GL uploads, GPU rendering and main preparation',
  samples: 7, previousMs: median(oldTimes), sharedMs: median(newTimes), previousTimesMs: oldTimes, sharedTimesMs: newTimes,
  avoidedPerRevision: { transformedCoordinates: count * 3, transformedFractional: count * 3, coordinateBounds: count * 3, radiusReads: count },
  exactCoordinatesAndBounds: true, processedBuffersShared: true }, null, 2));
