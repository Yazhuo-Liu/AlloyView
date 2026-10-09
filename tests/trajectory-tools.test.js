import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import {
  MAX_TRAJECTORY_LINE_VERTICES, SmoothingAccumulator, TrajectoryLineBuilder, TrajectoryUnwrapper, inferredUnwrappedPositions,
  smoothTrajectoryFrame, smoothingWindow, trajectoryLineFrames, trajectoryLineVertexCount, trajectoryVertexTime,
} from '../src/data/trajectory-tools.js';
import { TrajectoryProcessor } from '../src/workers/trajectory-processor.js';

const cubic = (length = 10, pbc = [true, true, true]) => createCell({ vectors: [length, 0, 0, 0, length, 0, 0, 0, length], pbc });
const wrap = value => value - Math.floor(value);

/** A frame from continuous reduced coordinates, wrapped on periodic axes. */
function frameFrom(continuous, { cell = cubic(), ids = continuous.map((_, atom) => atom + 1), frameIndex = 0, keepImages = false } = {}) {
  const count = continuous.length, fractional = new Float32Array(count * 3), images = new Int32Array(count * 3);
  continuous.forEach((point, atom) => point.forEach((value, axis) => {
    const wrapped = cell.pbc[axis] ? wrap(value) : value;
    fractional[atom * 3 + axis] = wrapped;
    images[atom * 3 + axis] = cell.pbc[axis] ? Math.floor(value) : 0;
  }));
  const frame = { frameIndex, ids: Float64Array.from(ids), idSource: 'explicit', types: new Uint16Array(count), typeLabels: ['Fe'],
    fractional, positions: fractionalToCartesian(fractional, cell), cell, properties: [] };
  if (keepImages) {
    frame.imageFlags = images;
    frame.unwrappedPositions = inferredUnwrappedPositions(fractional, images, cell);
  }
  return { frame, images };
}

/** Random walk of `atoms` atoms whose steps stay below half a cell. */
function walk(frames, atoms, { step = 0.31, seed = 7, cell = cubic() } = {}) {
  let state = seed;
  const random = () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
  const points = Array.from({ length: atoms }, () => [random(), random(), random()]);
  const trajectory = [];
  for (let frame = 0; frame < frames; frame += 1) {
    if (frame) for (const point of points) for (let axis = 0; axis < 3; axis += 1) point[axis] += (random() * 2 - 1) * step;
    trajectory.push(frameFrom(points.map(point => [...point]), { cell, frameIndex: frame }));
  }
  return trajectory;
}

test('unwrapping detects crossings in both directions and accumulates multiple images', () => {
  const unwrapper = new TrajectoryUnwrapper();
  const path = [0.9, 1.05, 1.2, 0.95, 0.6, 0.3, -0.1, -0.3, 0.1];
  const expected = [];
  path.forEach((x, index) => {
    const { frame, images } = frameFrom([[x, 0.5, 0.5], [0.5, 0.6 + index * 0.4, 0.5]], { frameIndex: index });
    unwrapper.append(index, frame);
    expected.push(images);
    assert.deepEqual(Array.from(unwrapper.imageFlags(index, frame.ids)), Array.from(images), `frame ${index}`);
  });
  // Random access behind the frontier uses the crossing log.
  for (let index = 0; index < path.length; index += 1) {
    assert.deepEqual(Array.from(unwrapper.imageFlags(index, Float64Array.from([1, 2]))), Array.from(expected[index]));
  }
  const last = frameFrom([[path.at(-1), 0.5, 0.5], [0.5, 0.6 + 8 * 0.4, 0.5]]).frame;
  const unwrapped = inferredUnwrappedPositions(last.fractional, unwrapper.imageFlags(8, last.ids), last.cell);
  assert.ok(Math.abs(unwrapped[0] - 1) < 1e-5);
  assert.ok(Math.abs(unwrapped[4] - 38) < 1e-4);
});

test('triclinic and changing cells unwrap per reduced axis; open axes never shift', () => {
  const unwrapper = new TrajectoryUnwrapper();
  const reduced = [[0.8, 0.1, 0.5], [1.1, -0.2, 0.95], [1.4, -0.4, 0.05], [1.7, -0.8, 0.4]];
  reduced.forEach((point, index) => {
    const cell = createCell({ vectors: [10 + index * 0.2, 0, 0, 3, 9, 0, 2, 1.5, 8], pbc: [true, true, false], triclinic: true });
    const { frame } = frameFrom([point], { cell, frameIndex: index });
    unwrapper.append(index, frame);
    const flags = unwrapper.imageFlags(index, frame.ids);
    assert.deepEqual(Array.from(flags), [Math.floor(point[0]), Math.floor(point[1]), 0], `frame ${index}`);
    const positions = inferredUnwrappedPositions(frame.fractional, flags, cell);
    const exact = fractionalToCartesian(Float64Array.from(point), cell, new Float64Array(3));
    for (let axis = 0; axis < 3; axis += 1) assert.ok(Math.abs(positions[axis] - exact[axis]) < 1e-4);
  });
});

test('atoms missing from some frames resume from their last observed position; new atoms start at image zero', () => {
  const unwrapper = new TrajectoryUnwrapper();
  const frames = [
    frameFrom([[0.9, 0.5, 0.5], [0.2, 0.2, 0.2]], { ids: [1, 2] }).frame,
    frameFrom([[0.2, 0.2, 0.2]], { ids: [2] }).frame,
    frameFrom([[0.25, 0.2, 0.2], [1.1, 0.5, 0.5], [0.95, 0.5, 0.5]], { ids: [2, 1, 3] }).frame,
    frameFrom([[1.02, 0.5, 0.5], [0.3, 0.2, 0.2], [1.2, 0.5, 0.5]], { ids: [3, 2, 1] }).frame,
  ];
  frames.forEach((frame, index) => unwrapper.append(index, frame));
  assert.deepEqual(Array.from(unwrapper.imageFlags(2, frames[2].ids)), [0, 0, 0, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(unwrapper.imageFlags(3, frames[3].ids)), [1, 0, 0, 0, 0, 0, 1, 0, 0]);
  assert.throws(() => unwrapper.append(5, frames[0]), /continue at frame 5/);
  assert.throws(() => unwrapper.append(4, { ...frames[0], ids: Float64Array.from([1, 1]) }), /twice/);
  // A rejected frame leaves the frontier and images unchanged.
  assert.equal(unwrapper.frontier, 3);
  assert.deepEqual(Array.from(unwrapper.imageFlags(3, frames[3].ids)), [1, 0, 0, 0, 0, 0, 1, 0, 0]);
});

function fakeSource(trajectory, { delay = () => 0 } = {}) {
  const reads = [];
  return {
    reads,
    processor: options => new TrajectoryProcessor({
      readFrame: async (index, { signal } = {}) => {
        reads.push(index);
        await new Promise(resolve => setTimeout(resolve, delay(index)));
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        const { frame } = trajectory[index];
        return { ...frame, fractional: frame.fractional.slice(), ids: frame.ids.slice(), positions: frame.positions.slice() };
      },
      getFrameCount: async () => trajectory.length,
      ...options,
    }),
  };
}

test('out-of-order requests and a truncated crossing log give the in-order image flags exactly', async () => {
  const trajectory = walk(14, 40);
  // Reverse every other frame's atom order to exercise ID matching.
  trajectory.forEach(({ frame }, index) => {
    if (index % 2 === 0) return;
    const order = Array.from({ length: frame.ids.length }, (_, atom) => frame.ids.length - 1 - atom);
    frame.ids = Float64Array.from(order, atom => frame.ids[atom]);
    frame.fractional = Float32Array.from(order.flatMap(atom => Array.from(frame.fractional.subarray(atom * 3, atom * 3 + 3))));
    frame.positions = fractionalToCartesian(frame.fractional, frame.cell);
    trajectory[index].images = Int32Array.from(order.flatMap(atom => Array.from(trajectory[index].images.subarray(atom * 3, atom * 3 + 3))));
  });
  const ordered = new TrajectoryUnwrapper();
  trajectory.forEach(({ frame }, index) => ordered.append(index, frame));
  for (const options of [{}, { eventBudgetBytes: 0 }]) {
    const { processor } = fakeSource(trajectory, { delay: index => (index * 7) % 5 });
    const shuffled = processor(options);
    const requests = [9, 3, 13, 0, 6, 12, 1].map(async index => [index, await shuffled.imageFlagsAt(index, trajectory[index].frame.ids)]);
    for (const [index, flags] of await Promise.all(requests)) {
      assert.deepEqual(Array.from(flags), Array.from(ordered.imageFlags(index, trajectory[index].frame.ids)), `frame ${index}`);
      assert.deepEqual(Array.from(flags), Array.from(trajectory[index].images), `true images at frame ${index}`);
    }
  }
});

test('frame preparation attaches inferred display coordinates without altering file data or analysis fields', async () => {
  const trajectory = walk(6, 5);
  const { processor } = fakeSource(trajectory);
  const tools = processor();
  const parsed = { ...trajectory[4].frame, fractional: trajectory[4].frame.fractional.slice() };
  await tools.prepare(parsed, 4, { unwrap: true });
  assert.equal(parsed.unwrappedPositions, undefined);
  assert.equal(parsed.imageFlags, undefined);
  assert.deepEqual(Array.from(parsed.inferredUnwrap.imageFlags), Array.from(trajectory[4].images));
  assert.deepEqual(parsed.fractional, trajectory[4].frame.fractional);
  const again = await tools.inferredUnwrap(4);
  assert.deepEqual(again.unwrappedPositions, parsed.inferredUnwrap.unwrappedPositions);
  const withImages = frameFrom([[1.2, 0.5, 0.5]], { keepImages: true }).frame;
  const before = withImages.unwrappedPositions;
  await tools.prepare(withImages, 0, { unwrap: true });
  assert.equal(withImages.unwrappedPositions, before);
  assert.equal(withImages.inferredUnwrap, undefined);
});

test('the smoothing window is truncated at the trajectory ends', () => {
  assert.deepEqual(smoothingWindow(0, 2, 10), { first: 0, last: 2 });
  assert.deepEqual(smoothingWindow(5, 2, 10), { first: 3, last: 7 });
  assert.deepEqual(smoothingWindow(9, 3, 10), { first: 6, last: 9 });
  assert.deepEqual(smoothingWindow(0, 4, 1), { first: 0, last: 0 });
  assert.throws(() => smoothingWindow(0, 51, 10), /0 to 50/);
  assert.throws(() => smoothingWindow(10, 1, 10), /outside/);
});

test('smoothing averages minimum-image displacements across a periodic boundary', () => {
  const frames = [0.98, 0.02, 0.99].map((x, index) => frameFrom([[x, 0.5, 0.25], [0.5, 0.5, 0.5]], { frameIndex: index }).frame);
  const result = smoothTrajectoryFrame(frames[1], [frames[0], frames[2]]);
  const expected = wrap(Math.fround(0.02) + ((Math.fround(0.98) - 1 - Math.fround(0.02)) + (Math.fround(0.99) - 1 - Math.fround(0.02))) / 3);
  assert.ok(Math.abs(result.fractional[0] - expected) < 1e-7, `${result.fractional[0]} vs ${expected}`);
  assert.ok(result.fractional[0] > 0.99);
  assert.ok(Math.abs(result.fractional[1] - 0.5) < 1e-7);
  // Without the minimum image the naive average would be near the middle.
  assert.ok(Math.abs(result.positions[0] - 10 * expected) < 1e-4);
});

test('smoothing matches atoms by ID, averages the cell and keeps raw arrays for a one-frame window', () => {
  const cells = [10, 11, 12].map(length => cubic(length));
  const points = [[[0.1, 0.2, 0.3], [0.6, 0.6, 0.6]], [[0.12, 0.2, 0.3], [0.62, 0.58, 0.6]], [[0.14, 0.2, 0.3], [0.64, 0.56, 0.6]]];
  const frames = points.map((atoms, index) => frameFrom(atoms, { cell: cells[index], frameIndex: index }).frame);
  const reversed = frameFrom([...points[2]].reverse(), { cell: cells[2], ids: [2, 1], frameIndex: 2 }).frame;
  const ordered = smoothTrajectoryFrame(frames[1], [frames[0], frames[2]]);
  const shuffled = smoothTrajectoryFrame(frames[1], [reversed, frames[0]]);
  assert.deepEqual(shuffled.fractional, ordered.fractional);
  assert.deepEqual(Array.from(ordered.cell.vectors), [11, 0, 0, 0, 11, 0, 0, 0, 11]);
  assert.ok(Math.abs(ordered.fractional[0] - 0.12) < 1e-6);
  assert.ok(Math.abs(ordered.positions[0] - 0.12 * 11) < 1e-5);
  const single = smoothTrajectoryFrame(frames[1], []);
  assert.equal(single.fractional, frames[1].fractional);
  assert.equal(single.positions, frames[1].positions);
  assert.equal(single.cell, frames[1].cell);
  const rowOrder = { ...frames[0], idSource: 'row-order', ids: Float64Array.from([1]), fractional: frames[0].fractional.slice(0, 3) };
  assert.throws(() => smoothTrajectoryFrame({ ...frames[1], idSource: 'row-order' }, [rowOrder]), /same atoms in the same order/);
});

test('smoothing shifts image flags when the average leaves the cell', () => {
  const frames = [1.03, 0.99, 1.05].map((x, index) => frameFrom([[x, 0.5, 0.5]], { frameIndex: index, keepImages: true }).frame);
  const accumulator = new SmoothingAccumulator(frames[1]);
  accumulator.add(frames[0]); accumulator.add(frames[1], { center: true }); accumulator.add(frames[2]);
  const result = accumulator.finish();
  assert.deepEqual(Array.from(result.imageFlags), [1, 0, 0]);
  assert.ok(result.fractional[0] < 0.1);
  assert.ok(Math.abs(result.unwrappedPositions[0] - 10 * (Math.fround(0.99) + (Math.fround(0.03) + 1 - Math.fround(0.99) + Math.fround(0.05) + 1 - Math.fround(0.99)) / 3)) < 1e-4);
});

test('processor smoothing equals the direct average and is identical for any request order', async () => {
  const trajectory = walk(9, 12, { step: 0.08 });
  const direct = index => {
    const { first, last } = smoothingWindow(index, 2, trajectory.length);
    const others = [];
    for (let frame = first; frame <= last; frame += 1) if (frame !== index) others.push(trajectory[frame].frame);
    return smoothTrajectoryFrame(trajectory[index].frame, others);
  };
  const { processor } = fakeSource(trajectory, { delay: index => (index * 3) % 4 });
  const tools = processor({ coordinateBudgetBytes: 1 });
  const results = await Promise.all([8, 0, 4].map(async index => {
    const frame = { ...trajectory[index].frame };
    await tools.prepare(frame, index, { smoothing: 2 });
    return [index, frame];
  }));
  for (const [index, frame] of results) {
    const expected = direct(index);
    assert.deepEqual(frame.fractional, expected.fractional);
    assert.deepEqual(frame.positions, expected.positions);
    assert.deepEqual(frame.smoothing, { window: 2, ...{ firstFrame: Math.max(0, index - 2), lastFrame: Math.min(8, index + 2) },
      frameCount: Math.min(8, index + 2) - Math.max(0, index - 2) + 1 });
  }
});

test('trajectory lines sample with a stride and stay continuous across periodic boundaries', () => {
  assert.deepEqual(trajectoryLineFrames(2, 11, 3), [2, 5, 8, 11]);
  assert.deepEqual(trajectoryLineFrames(0, 4, 10), [0]);
  assert.throws(() => trajectoryLineFrames(5, 4, 1), /first ≤ last/);
  const trajectory = Array.from({ length: 10 }, (_, index) => frameFrom([[0.7 + index * 0.17, 0.5, 0.5], [0.4, 0.2 - index * 0.12, 0.5], [0.5, 0.5, 0.5]],
    { frameIndex: index, ids: index % 2 ? [3, 2, 1] : [1, 2, 3] }).frame);
  // Odd frames list atoms in reverse; reorder their coordinates accordingly.
  for (const [index, frame] of trajectory.entries()) {
    if (index % 2 === 0) continue;
    const coordinates = frame.fractional.slice();
    for (let atom = 0; atom < 3; atom += 1) frame.fractional.set(coordinates.subarray((2 - atom) * 3, (2 - atom) * 3 + 3), atom * 3);
  }
  const frames = trajectoryLineFrames(0, 9, 2);
  const builder = new TrajectoryLineBuilder([1, 2, 99], frames);
  for (const index of frames) builder.add(trajectory[index]);
  const lines = builder.finish();
  assert.equal(lines.lineCount, 2);
  assert.deepEqual(lines.lineAtomIds, [1, 2]);
  assert.deepEqual(Array.from(lines.lineOffsets), [0, 5, 10]);
  assert.equal(lines.missingCount, 1);
  for (let sample = 0; sample < 5; sample += 1) {
    const x = lines.vertices[sample * 4], y = lines.vertices[(5 + sample) * 4 + 1];
    assert.ok(Math.abs(x - 10 * (0.7 + frames[sample] * 0.17)) < 1e-4, `x ${x}`);
    assert.ok(Math.abs(y - 10 * (0.2 - frames[sample] * 0.12)) < 1e-4, `y ${y}`);
  }
  assert.ok(lines.vertices[4 * 4 + 3] < 0 && Math.abs(trajectoryVertexTime(lines.vertices[4 * 4 + 3]) - 1) < 1e-7);
  assert.equal(lines.vertices[3], 0);
  assert.ok(Math.abs(lines.vertices[2 * 4 + 3] - 0.5) < 1e-7);
  assert.ok(lines.bounds.maximum[0] > 10, 'the unwrapped path leaves the cell');
});

test('trajectory lines use file unwrapped coordinates and enforce the vertex limit before reading', () => {
  const frames = [0, 1, 2];
  const builder = new TrajectoryLineBuilder([1], frames);
  [0.6, 1.1, 1.65].forEach((x, index) => builder.add(frameFrom([[x, 0.5, 0.5]], { frameIndex: index, keepImages: true }).frame));
  const lines = builder.finish();
  assert.ok(Math.abs(lines.vertices[8] - 16.5) < 1e-4);
  assert.equal(trajectoryLineVertexCount(1000, 2000), 2_000_000);
  assert.throws(() => trajectoryLineVertexCount(1000, 2001), RangeError);
  assert.throws(() => new TrajectoryLineBuilder(Array.from({ length: 3 }, (_, index) => index), [0, 1], { maxVertices: 5 }), /limit is 5/);
  assert.equal(MAX_TRAJECTORY_LINE_VERTICES, 2_000_000);
  assert.throws(() => new TrajectoryLineBuilder([1, 1], [0, 1]), /listed twice/);
});

test('processor lines read sampled frames and can be cancelled', async () => {
  const trajectory = walk(8, 4, { step: 0.2 });
  const { processor, reads } = fakeSource(trajectory, { delay: () => 2 });
  const tools = processor({ coordinateBudgetBytes: 1 });
  const lines = await tools.lines({ ids: [1, 3], first: 1, last: 7, stride: 3 });
  assert.deepEqual(Array.from(lines.frames), [1, 4, 7]);
  assert.equal(lines.vertexCount, 6);
  assert.ok(reads.every(index => [1, 4, 7].includes(index)));
  const controller = new AbortController();
  const pending = tools.lines({ ids: [1], first: 0, last: 7, stride: 1 }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await assert.rejects(tools.lines({ ids: [1], first: 0, last: 8, stride: 1 }), /outside this 8-frame trajectory/);
});

test('text, sparse and huge IDs are matched exactly, and smoothing averages atoms over the frames that contain them', () => {
  const ids = [['Fe-1', 1e12, 3], [3, 'Fe-1', 1e12], ['Fe-1', 3]];
  const points = [[[0.95, 0.5, 0.5], [0.1, 0.1, 0.1], [0.5, 0.2, 0.5]], [[0.52, 0.2, 0.5], [0.05, 0.5, 0.5], [0.12, 0.1, 0.1]],
    [[0.15, 0.5, 0.5], [0.56, 0.2, 0.5]]];
  const frames = points.map((atoms, index) => {
    const { frame } = frameFrom(atoms, { frameIndex: index });
    frame.ids = ids[index];
    return frame;
  });
  const unwrapper = new TrajectoryUnwrapper();
  frames.forEach((frame, index) => unwrapper.append(index, frame));
  assert.deepEqual(Array.from(unwrapper.imageFlags(1, frames[1].ids)), [0, 0, 0, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(unwrapper.imageFlags(2, ['Fe-1', 3])), [1, 0, 0, 0, 0, 0]);
  assert.throws(() => unwrapper.imageFlags(2, ['Fe-2']), /has not been integrated/);
  const smoothed = smoothTrajectoryFrame(frames[1], [frames[0], frames[2]]);
  // Atom 1e12 is absent from frame 3: its average uses frames 1 and 2 only.
  const expected = (Math.fround(0.1) + Math.fround(0.12)) / 2;
  assert.ok(Math.abs(smoothed.fractional[6] - expected) < 1e-7);
  // 'Fe-1' moves 0.95 → 1.05 → 1.15 across the boundary: the mean is 1.05.
  assert.ok(Math.abs(smoothed.fractional[3] - 0.05) < 1e-6);
  assert.ok(Math.abs(smoothed.fractional[0] - (Math.fround(0.5) + Math.fround(0.52) + Math.fround(0.56)) / 3) < 1e-6);
  // Integer IDs switch to a hash map when a text ID appears later.
  const mixed = new TrajectoryUnwrapper();
  mixed.append(0, { ...frameFrom([[0.9, 0, 0], [0.5, 0, 0]]).frame, ids: Float64Array.from([4, 9]) });
  mixed.append(1, { ...frameFrom([[0.5, 0, 0], [0.2, 0, 0], [0.05, 0, 0]]).frame, ids: [9, 'x', 4] });
  assert.deepEqual(Array.from(mixed.imageFlags(1, [4, 'x', '9'])), [1, 0, 0, 0, 0, 0, 0, 0, 0]);
});
