import assert from 'node:assert/strict';
import { solveMatte } from '../../src/render/offscreen-export.js';

// Pre-R5 pixel formula. Interleave the two implementations on the same
// buffers; all timings include the complete matte pass, excluding fixtures.
function original(black, white, output, count) {
  for (let pixel = 0; pixel < count * 4; pixel += 4) {
    const transmission = (white[pixel] - black[pixel] + white[pixel + 1] - black[pixel + 1] + white[pixel + 2] - black[pixel + 2]) / 765;
    const alpha = Math.round(255 * Math.min(1, Math.max(0, 1 - transmission)));
    for (let channel = 0; channel < 3; channel++) output[pixel + channel] = alpha ? Math.min(255, Math.round(black[pixel + channel] * 255 / alpha)) : 0;
    output[pixel + 3] = alpha;
  }
  return output;
}

const width = 3840, height = 2160, count = width * height;
const black = new Uint8Array(count * 4), white = new Uint8Array(black.length), outputs = [new Uint8Array(black.length), new Uint8Array(black.length)];
const report = [];
for (const fixture of ['mostly-empty', 'all-translucent']) {
  for (let pixel = 0; pixel < count; pixel++) {
    const alpha = fixture === 'all-translucent' ? 1 + pixel % 254 : pixel % 200 < 156 ? 0 : pixel % 200 < 199 ? 255 : 128;
    for (let channel = 0; channel < 3; channel++) {
      const color = (pixel * 17 + channel * 91) % 256;
      black[pixel * 4 + channel] = Math.round(color * alpha / 255);
      white[pixel * 4 + channel] = Math.round(color * alpha / 255 + 255 - alpha);
    }
    black[pixel * 4 + 3] = white[pixel * 4 + 3] = 255;
  }
  const functions = [original, solveMatte], timings = [[], []];
  for (let run = 0; run < 11; run++) {
    for (const index of run % 2 ? [1, 0] : [0, 1]) {
      const started = performance.now(); functions[index](black, white, outputs[index], count);
      if (run >= 4) timings[index].push(performance.now() - started);
    }
    assert.deepEqual(outputs[0], outputs[1]);
  }
  const median = values => values.slice().sort((a, b) => a - b)[values.length >> 1];
  report.push({ fixture, width, height, count, exact: true, baselineMs: median(timings[0]), optimizedMs: median(timings[1]), samples: timings });
}
console.log(JSON.stringify({ node: process.version, report }, null, 2));
