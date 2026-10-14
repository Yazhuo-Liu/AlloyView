import test from 'node:test';
import assert from 'node:assert/strict';
import { solveMatte } from '../src/render/offscreen-export.js';

// Independent pre-R5 formula, including its aliasing and byte-rounding order.
function original(black, white, output, count) {
  for (let pixel = 0; pixel < count * 4; pixel += 4) {
    const transmission = (white[pixel] - black[pixel] + white[pixel + 1] - black[pixel + 1] + white[pixel + 2] - black[pixel + 2]) / 765;
    const alpha = Math.round(255 * Math.min(1, Math.max(0, 1 - transmission)));
    for (let channel = 0; channel < 3; channel++) output[pixel + channel] = alpha ? Math.min(255, Math.round(black[pixel + channel] * 255 / alpha)) : 0;
    output[pixel + 3] = alpha;
  }
  return output;
}

function pixels(count) {
  const black = new Uint8Array(count * 4), white = new Uint8Array(black.length);
  let state = 5381;
  const randomByte = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 24);
  for (let pixel = 0; pixel < count; pixel++) {
    const alpha = randomByte();
    for (let channel = 0; channel < 3; channel++) {
      const offset = pixel * 4 + channel, value = randomByte();
      black[offset] = pixel % 4 === 0 ? 0 : pixel % 4 === 1 ? value : Math.round(value * alpha / 255);
      white[offset] = pixel % 4 === 0 ? 255 : pixel % 4 === 1 ? value : pixel % 4 === 2 ? black[offset] + 255 - alpha : randomByte();
    }
    black[pixel * 4 + 3] = randomByte(); white[pixel * 4 + 3] = randomByte();
  }
  return { black, white };
}

test('packed matte matches the original for opaque, empty, translucent and irregular RGB with arbitrary input alpha', () => {
  const { black, white } = pixels(65_537);
  for (const Type of [Uint8Array, Uint8ClampedArray]) {
    const expected = original(black, white, new Type(black.length), black.length / 4);
    const output = new Type(black.length);
    assert.equal(solveMatte(black, white, output, black.length / 4), output);
    assert.deepEqual(output, expected);
  }
  assert.deepEqual([...solveMatte(Uint8Array.of(9, 100, 200, 0), Uint8Array.of(9, 100, 200, 17), new Uint8Array(4), 1)], [9, 100, 200, 255]);
});

test('aligned, unaligned, shared and plain-array matte views retain exact values and untouched guard bytes', () => {
  const fixture = pixels(257);
  for (const offset of [0, 1, 4, 5]) for (const shared of [false, true]) {
    const BufferType = shared ? SharedArrayBuffer : ArrayBuffer;
    const black = new Uint8Array(new BufferType(fixture.black.length + offset + 9), offset, fixture.black.length);
    const white = new Uint8Array(new BufferType(fixture.white.length + offset + 9), offset, fixture.white.length);
    const output = new Uint8ClampedArray(new BufferType(fixture.black.length + offset + 9), offset, fixture.black.length);
    black.set(fixture.black); white.set(fixture.white);
    const full = new Uint8Array(output.buffer); full.fill(77);
    const expected = original(black, white, new Uint8ClampedArray(output), 256);
    solveMatte(black, white, output, 256);
    assert.deepEqual(output, expected);
    assert.ok(full.subarray(0, offset).every(value => value === 77));
    assert.ok(full.subarray(offset + output.length).every(value => value === 77));
  }
  const expected = original([...fixture.black], [...fixture.white], [], 257);
  assert.deepEqual(solveMatte([...fixture.black], [...fixture.white], [], 257), expected);
});

test('in-place and partially overlapping matte outputs preserve the original mutation order', () => {
  const { black: initial } = pixels(261);
  for (const [darkOffset, lightOffset, outputOffset] of [[0, 4, 0], [0, 4, 4], [0, 0, 0], [8, 0, 4], [0, 8, 12], [1, 4, 2]]) {
    const first = initial.slice(), second = initial.slice(), length = 256 * 4;
    const views = buffer => [darkOffset, lightOffset, outputOffset].map(offset => new Uint8Array(buffer.buffer, offset, length));
    original(...views(first), 256); solveMatte(...views(second), 256);
    assert.deepEqual(second, first, `${darkOffset}/${lightOffset}/${outputOffset}`);
  }
  const { black, white } = pixels(257);
  for (const outputName of ['black', 'white']) {
    const first = { black: black.slice(), white: white.slice() }, second = { black: black.slice(), white: white.slice() };
    original(first.black, first.white, first[outputName], 257);
    solveMatte(second.black, second.white, second[outputName], 257);
    assert.deepEqual(second[outputName], first[outputName]);
  }
});

test('legacy empty and fractional counts keep their original no-op or tail behavior', () => {
  const { black, white } = pixels(5);
  for (const count of [0, -0, -1, NaN, 2.5]) {
    const expected = original(black, white, new Uint8Array(20).fill(77), count);
    assert.deepEqual(solveMatte(black, white, new Uint8Array(20).fill(77), count), expected);
  }
  const buffer = new ArrayBuffer(8), detached = new Uint8Array(buffer);
  structuredClone(buffer, { transfer: [buffer] });
  assert.equal(solveMatte(detached, detached, detached, 0), detached);
});
