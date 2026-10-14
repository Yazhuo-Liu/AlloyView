import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createCell } from '../src/data/model.js';
import { createPrimitivePreparation } from '../src/render/prepared-primitive-inputs.js';

const count = Number(process.argv[2] ?? 1_000_000), iterations = Number(process.argv[3] ?? 9);
if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(iterations) || iterations < 3) {
  throw new Error('Use positive atom count and at least three iterations.');
}
const positions = Float64Array.from({ length: count * 3 }, (_, i) => Math.sin(i) * 12345);
const fractional = Float64Array.from(positions, value => value / 10000);
const cell = createCell({ vectors: [10, 0, 0, 3, 8, 0, -2, 1, 7] }), frame = { cell };
const width = Math.ceil(Math.sqrt(count)), height = Math.ceil(count / width), pixels = width * height;
function legacyPack(source) {
  const output = new Float32Array(pixels * 4);
  for (let atom = 0; atom < count; atom++) {
    const index = atom * 3, target = atom * 4;
    output[target] = source[index]; output[target + 1] = source[index + 1]; output[target + 2] = source[index + 2];
  }
  return output;
}
function previous() { return [legacyPack(positions), legacyPack(fractional), legacyPack(positions), legacyPack(fractional)]; }
function prepared() {
  const token = createPrimitivePreparation({ frame, positions, fractional, displayRevision: 1 });
  const main = token.textureRows(width, height), second = token.textureRows(width, height);
  assert.equal(main, second);
  return [main.positionValues, main.fractionalValues, second.positionValues, second.fractionalValues];
}
// Scientific/source generation is outside the measured region. Both variants
// include fresh allocation and CPU packing; neither includes GL uploads.
let checksum = 0;
const timings = { previous: [], prepared: [] };
for (let iteration = -4; iteration < iterations; iteration++) {
  for (const [name, run] of iteration % 2 ? [['previous', previous], ['prepared', prepared]] : [['prepared', prepared], ['previous', previous]]) {
    globalThis.gc?.();
    const started = performance.now(), arrays = run(), elapsed = performance.now() - started;
    checksum += arrays[0][count * 4 - 4] + arrays[3][count * 4 - 4];
    if (iteration >= 0) timings[name].push(elapsed);
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({ count, iterations, pixels, previousMedianMs: median(timings.previous),
  preparedMedianMs: median(timings.prepared), previousCoordinateMirrorBytes: pixels * 4 * 4 * 4,
  preparedCoordinateMirrorBytes: pixels * 4 * 4 * 2, checksum, timings }, null, 2));
