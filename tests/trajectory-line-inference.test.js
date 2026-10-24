import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { TrajectoryLineBuilder } from '../src/data/trajectory-tools.js';
import { TrajectoryProcessor } from '../src/workers/trajectory-processor.js';

const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [true, true, true] });
function frame(x, index, { fileX, image } = {}) {
  const fractional = Float32Array.of(x, .2, .3);
  const result = { frameIndex:index, ids:Float64Array.of(1), idSource:'explicit', cell, fractional,
    positions:fractionalToCartesian(fractional, cell), types:Uint16Array.of(0), typeLabels:['Fe'], properties:[] };
  if (fileX !== undefined) result.filePositions = Float32Array.of(fileX, 2, 3);
  if (image !== undefined) {
    result.imageFlags = Int32Array.of(image, 0, 0);
    result.unwrapSource = 'ix/iy/iz';
  }
  return result;
}
const xValues = result => Array.from({length:result.vertexCount}, (_,index)=>result.vertices[index*4]);
const close = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  for (let index=0; index<actual.length; index++) assert.ok(Math.abs(actual[index]-expected[index])<1e-5, `${actual} versus ${expected}`);
};

test('trajectory lines preserve boundary jumps unless missing-image inference is enabled', () => {
  for (const inferMissingImages of [false, true]) {
    const builder = new TrajectoryLineBuilder([1], [2, 8], { inferMissingImages });
    builder.add(frame(.95, 2)); builder.add(frame(.05, 8));
    close(xValues(builder.finish()), inferMissingImages ? [9.5, 10.5] : [9.5, .5]);
  }
});

test('trajectory lines use literal source positions when inference is off, including physical-copy offsets', () => {
  const builder = new TrajectoryLineBuilder(['@AlloyView:copy:1:0:0:1'], [2, 8], {
    inferMissingImages:false, physicalReplication:{repetitions:[2,1,1]},
  });
  builder.add(frame(.95, 2, { fileX:19.5 })); builder.add(frame(.05, 8, { fileX:10.5 }));
  close(xValues(builder.finish()), [29.5, 20.5]);
});

test('authoritative continuous source positions remain valid while inferred crossings are disabled', () => {
  const builder = new TrajectoryLineBuilder([1], [0, 1], { inferMissingImages:false });
  const first = frame(.95, 0), second = frame(.05, 1);
  first.unwrappedPositions = Float32Array.of(29.5, 2, 3);
  second.unwrappedPositions = Float32Array.of(30.5, 2, 3);
  builder.add(first); builder.add(second);
  close(xValues(builder.finish()), [29.5, 30.5]);
});

test('processor line inference settings only read sampled frames and never advance the global unwrap frontier', async () => {
  for (const inferMissingImages of [false, true]) {
    const reads = [];
    const processor = new TrajectoryProcessor({ getFrameCount:async()=>9, readFrame:async index=>{
      reads.push(index); return frame(index===2?.95:.05, index);
    } });
    const result = await processor.lines({ids:[1],first:2,last:8,stride:6,inferMissingImages});
    close(xValues(result), inferMissingImages ? [9.5,10.5] : [9.5,.5]);
    assert.deepEqual([...new Set(reads)].sort((a,b)=>a-b), [2,8]);
    assert.equal(processor.unwrapper.frontier, -1);
    processor.close();
  }
});

test('processor lines resolve lazy file image counts without cross-frame inference', async () => {
  const reads = [];
  const processor = new TrajectoryProcessor({ getFrameCount:async()=>9, readFrame:async index=>{
    reads.push(index); return frame(index===2?.95:.05, index, {image:index===2?2:3});
  } });
  const result = await processor.lines({ids:[1],first:2,last:8,stride:6,inferMissingImages:false});
  close(xValues(result), [29.5,30.5]);
  assert.deepEqual([...new Set(reads)].sort((a,b)=>a-b), [2,8]);
  assert.equal(processor.unwrapper.frontier, -1);
  processor.close();
});
