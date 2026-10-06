import test from 'node:test';
import assert from 'node:assert/strict';
import { createCell } from '../src/data/model.js';
import { calculateVoronoiGeometry } from '../src/analysis/voronoi.js';
import { createVoronoiCellBatch, VoronoiAllCellLayer } from '../src/render/voronoi-cell-layer.js';

async function cube(atomIndex = 0) {
  const geometry = await calculateVoronoiGeometry({ fractional: new Float64Array(3),
    cell: createCell({ vectors: [2,0,0, 0,2,0, 0,0,2] }) }, { atomIndex: 0 });
  return { ...geometry, atomIndex };
}

function mockGl() {
  const calls = [], gl = {};
  for (const name of ['VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS', 'ARRAY_BUFFER',
    'ELEMENT_ARRAY_BUFFER', 'FLOAT', 'STATIC_DRAW', 'UNSIGNED_INT', 'TEXTURE0', 'TEXTURE_2D', 'RGBA32F', 'RGBA',
    'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER', 'NEAREST', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'CLAMP_TO_EDGE',
    'MAX_TEXTURE_SIZE', 'BLEND', 'SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'CULL_FACE', 'POLYGON_OFFSET_FILL',
    'FRONT', 'BACK', 'TRIANGLES', 'LINES']) gl[name] = name === 'TEXTURE0' ? 33984 : name;
  for (const name of ['createProgram', 'createShader', 'createVertexArray', 'createBuffer', 'createTexture']) gl[name] = () => ({});
  gl.getUniformLocation = (_program, name) => name;
  gl.getShaderParameter = gl.getProgramParameter = () => true;
  gl.getParameter = () => 4096;
  for (const name of ['shaderSource', 'compileShader', 'attachShader', 'deleteShader', 'linkProgram', 'bindVertexArray',
    'bindBuffer', 'bufferData', 'enableVertexAttribArray', 'vertexAttribPointer', 'vertexAttribIPointer',
    'deleteVertexArray', 'deleteBuffer', 'bindTexture', 'texImage2D', 'activeTexture', 'texParameteri', 'useProgram',
    'uniform1i', 'uniform1f', 'uniform3f', 'uniform4fv', 'uniformMatrix4fv', 'enable', 'disable',
    'blendFuncSeparate', 'depthMask', 'polygonOffset', 'cullFace', 'drawElements', 'drawArrays']) {
    gl[name] = (...arguments_) => calls.push({ name, arguments: arguments_ });
  }
  return { gl, calls };
}

test('packed cell groups retain physical polygons, integer source IDs and local bounds', async () => {
  const cells = [await cube(3), await cube(16777217)];
  const snapshot = cells[0].vertices.slice(), batch = createVoronoiCellBatch(cells);
  assert.equal(batch.cellCount, 2);
  assert.equal(batch.vertexCount, 48);
  assert.equal(batch.indexCount, 72);
  assert.equal(batch.edgeCount, 48);
  assert.deepEqual([...new Set(batch.atomIndices)], [3,16777217], 'source atom IDs survive beyond Float32 integer precision');
  const expectedBounds = [3,-1,-1,-1,1,1,1, 16777217,-1,-1,-1,1,1,1];
  batch.bounds.forEach((value, index) => assert.ok(Math.abs(value - expectedBounds[index]) < 1e-12));
  const volume = new Map();
  for (let index = 0; index < batch.indices.length; index += 3) {
    const indices = [...batch.indices.subarray(index, index + 3)];
    const atom = batch.atomIndices[indices[0]];
    assert.ok(indices.every(vertex => batch.atomIndices[vertex] === atom), 'a triangle never crosses cells');
    const [a,b,c] = indices.map(vertex => [...batch.values.subarray(vertex*6, vertex*6+3)]);
    const cross = [b[1]*c[2]-b[2]*c[1], b[2]*c[0]-b[0]*c[2], b[0]*c[1]-b[1]*c[0]];
    const signed = a.reduce((sum, value, axis) => sum + value*cross[axis], 0)/6;
    volume.set(atom, (volume.get(atom) ?? 0) + signed);
  }
  for (const value of volume.values()) assert.ok(Math.abs(value - 8) < 1e-12, 'closed outward triangles preserve the exact cube volume');
  assert.deepEqual(cells[0].vertices, snapshot, 'render packing leaves scientific cell data untouched');
});

test('all-cell rendering appends/reuses bounded GPU buffers and shares dynamic coordinates and visibility', async () => {
  const { gl, calls } = mockGl(), layer = new VoronoiAllCellLayer(gl);
  const mesh = createVoronoiCellBatch([await cube(0), await cube(1)]);
  const geometry = { chunks: [mesh], cellCount: 2 };
  const renderer = { frame: {}, atomCount: 2, displayPositions: Float64Array.from([0,0,0, 2,0,0]),
    visibility: Uint8Array.from([255,0]), voronoiDisplayRevision: 1,
    replicas: [{offset:[0,0,0]}, {offset:[4,0,0]}], viewMatrix: new Float32Array(16), projectionMatrix: new Float32Array(16),
    sliceMode:'planes', sliceCount: 0 };
  layer.setGeometry(geometry, {allEnabled:true});
  const uploads = calls.filter(call => call.name === 'bufferData').length;
  layer.render(renderer);
  assert.equal(layer.renderedReplicaCount, 2);
  assert.equal(layer.renderedChunkCount, 2);
  assert.equal(calls.filter(call => call.name === 'drawElements').length, 4, 'two faces draws per chunk per replica, independent of its atom count');
  assert.equal(calls.filter(call => call.name === 'drawArrays').length, 2);
  assert.deepEqual([...layer.textureValues], [0,0,0,1, 2,0,0,0], 'atom hiding controls every attached cell fragment');
  layer.setGeometry(geometry, {color:'#abcdef'});
  assert.equal(calls.filter(call => call.name === 'bufferData').length, uploads, 'appearance changes do not upload meshes again');
  renderer.displayPositions[0] = 1.5; renderer.visibility[1] = 255; renderer.voronoiDisplayRevision++;
  layer.render(renderer);
  assert.deepEqual([...layer.textureValues], [1.5,0,0,1, 2,0,0,1], 'periodic display-origin and masks update independently of local geometry');
  geometry.chunks.push(mesh); geometry.cellCount = 4;
  layer.setGeometry(geometry);
  assert.equal(calls.filter(call => call.name === 'bufferData').length, uploads + 3, 'streaming uploads only the new chunk');
  const minimum = [0,0,0], maximum = [2,2,2];
  renderer.maximumOffset = [4,0,0];
  layer.extendBounds(renderer, minimum, maximum);
  assert.deepEqual(minimum, [0,-1,-1]); assert.deepEqual(maximum, [7,2,2]);
  layer.setGeometry(geometry, {allEnabled:false});
  layer.render(renderer); assert.equal(layer.renderedChunkCount, 0);
  layer.clear(); assert.equal(layer.chunks.length, 0); assert.equal(layer.textureValues, null);
  assert.equal(calls.filter(call => call.name === 'deleteBuffer').length, 6, 'old-frame meshes release all GPU buffer groups');
});
