import test from 'node:test';
import assert from 'node:assert/strict';
import { createCell } from '../src/data/model.js';
import { calculateVoronoiGeometry } from '../src/analysis/voronoi.js';
import { createVoronoiCellBatch, normalizeVoronoiCellOptions, VoronoiCellLayer, VoronoiAllCellLayer } from '../src/render/voronoi-cell-layer.js';

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
    'MAX_TEXTURE_SIZE', 'BLEND', 'SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'CULL_FACE', 'DEPTH_TEST', 'POLYGON_OFFSET_FILL',
    'FRONT', 'BACK', 'TRIANGLES', 'LINES', 'ZERO', 'LEQUAL', 'GREATER']) gl[name] = name === 'TEXTURE0' ? 33984 : name;
  for (const name of ['createProgram', 'createShader', 'createVertexArray', 'createBuffer', 'createTexture']) gl[name] = () => ({});
  gl.getUniformLocation = (_program, name) => name;
  gl.getShaderParameter = gl.getProgramParameter = () => true;
  gl.getParameter = () => 4096;
  for (const name of ['shaderSource', 'compileShader', 'attachShader', 'deleteShader', 'linkProgram', 'bindVertexArray',
    'bindBuffer', 'bufferData', 'enableVertexAttribArray', 'vertexAttribPointer', 'vertexAttribIPointer',
    'deleteVertexArray', 'deleteBuffer', 'bindTexture', 'texImage2D', 'activeTexture', 'texParameteri', 'useProgram',
    'uniform1i', 'uniform1f', 'uniform2f', 'uniform3f', 'uniform4fv', 'uniformMatrix4fv', 'enable', 'disable',
    'vertexAttribDivisor', 'vertexAttribI4ui', 'blendFuncSeparate', 'depthMask', 'depthFunc', 'polygonOffset', 'cullFace', 'drawElements', 'drawArrays', 'drawArraysInstanced']) {
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
  assert.deepEqual([...batch.cellRanges], [3,0,36,48,24, 16777217,36,36,72,24],
    'each source cell has complete, contiguous face and edge draw ranges');
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

test('Voronoi defaults use translucent blue faces and preserve explicit appearance settings', () => {
  assert.deepEqual(normalizeVoronoiCellOptions(), { enabled:false, allEnabled:false, color:'#3b82f6', opacity:0.5, style:'xray', scale:1 });
  assert.deepEqual(normalizeVoronoiCellOptions({color:'#ff6600',opacity:0,style:'surface',scale:.7}, {allEnabled:true}),
    { enabled:false, allEnabled:true, color:'#ff6600', opacity:0, style:'surface', scale:.7 });
  assert.throws(() => normalizeVoronoiCellOptions({style:'wireframe'}), /style/);
  assert.throws(() => normalizeVoronoiCellOptions({scale:.1}), /scale/);
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
  assert.equal(calls.filter(call => call.name === 'drawArraysInstanced').length, 2);
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

test('selection highlights only existing source-cell triangles and edges in every replica without a preview or mesh upload', async () => {
  const { gl, calls } = mockGl(), layer = new VoronoiAllCellLayer(gl);
  const mesh = createVoronoiCellBatch([await cube(1), await cube(3)]);
  layer.setGeometry({ chunks:[mesh], cellCount:2, complete:true }, {allEnabled:true, enabled:false, style:'surface'});
  const renderer = { frame:{}, atomCount:4, selected:3, selectedAtoms:Int32Array.from([-1,3,-1]),
    displayPositions:Float64Array.from([0,0,0, 2,0,0, 4,0,0, 6,0,0]),
    visibility:Uint8Array.from([255,255,255,255]), voronoiDisplayRevision:1,
    replicas:[{offset:[0,0,0]},{offset:[0,4,0]}], viewMatrix:new Float32Array(16), projectionMatrix:new Float32Array(16),
    sliceMode:'planes', sliceCount:1, slicePlaneValues:Float32Array.from([1,0,0,7]), background:[1,1,1] };
  const uploads = calls.filter(call => call.name === 'bufferData').length;
  layer.render(renderer);
  assert.equal(layer.highlightedCellCount, 1);
  assert.equal(layer.renderedHighlightReplicaCount, 2);
  const triangles = calls.filter(call => call.name === 'drawElements');
  assert.deepEqual(triangles.slice(-4).map(call => call.arguments),
    Array.from({length:4}, () => [gl.TRIANGLES,36,gl.UNSIGNED_INT,36*4]),
    'highlight draws the complete selected cell range from the original element buffer');
  const lines = calls.filter(call => call.name === 'drawArraysInstanced');
  assert.deepEqual(lines.slice(-2).map(call => call.arguments),
    Array.from({length:2}, () => [gl.TRIANGLES,0,6,12]), 'highlight ribbons reuse all twelve original cell edges');
  assert.deepEqual(calls.filter(call => call.name === 'vertexAttribIPointer').slice(-2).map(call => call.arguments),
    Array.from({length:2}, () => [2,1,gl.UNSIGNED_INT,8,72*4]), 'highlight ribbons address the selected original source-cell range');
  assert.ok(calls.some(call => call.name === 'uniform1i' && call.arguments[0] === 'uSliceCount' && call.arguments[1] === 1),
    'the common clipping shader applies equally to base cells and selected ranges');
  assert.ok(calls.some(call => call.name === 'uniform3f' && call.arguments[0] === 'uEdgeColor'
    && call.arguments.slice(1).every(channel => channel < 0.35)), 'base outlines use dark ink on the light background');
  assert.ok(calls.some(call => call.name === 'depthMask' && call.arguments[0] === true)
    && calls.some(call => call.name === 'blendFuncSeparate' && call.arguments[0] === gl.ZERO),
    'nearest-surface mode resolves cell depth without changing the image');
  assert.ok(calls.some(call => call.name === 'depthFunc' && call.arguments[0] === gl.GREATER)
    && calls.at(-1) && calls.filter(call => call.name === 'depthFunc').at(-1).arguments[0] === gl.LEQUAL,
    'hidden parts of a selection are ghosted and the renderer depth test is restored');
  assert.equal(calls.filter(call => call.name === 'bufferData').length, uploads, 'selection needs no mesh extraction or upload');

  renderer.visibility[3] = 0; renderer.voronoiDisplayRevision++;
  layer.render(renderer);
  assert.equal(layer.highlightedCellCount, 0, 'hiding an atom hides its attached highlight');
  assert.equal(layer.renderedHighlightReplicaCount, 0);
  assert.equal(layer.textureValues[3*4+3], 0);
  renderer.selected = 0; renderer.selectedAtoms.fill(-1);
  layer.render(renderer);
  assert.equal(layer.highlightedCellCount, 0, 'an omitted tessellation site never highlights another atom');

  renderer.selected = 1; renderer.background = [.02,.03,.04];
  layer.render(renderer);
  assert.equal(layer.highlightedCellCount, 1);
  assert.ok(calls.some(call => call.name === 'uniform3f' && call.arguments[0] === 'uEdgeColor'
    && call.arguments.slice(1).every(channel => channel >= 0.75)), 'dark backgrounds also retain visibly light outlines');
  layer.clear();
  assert.equal(layer.highlightedCellCount, 0); assert.equal(layer.renderedHighlightReplicaCount, 0);
});

test('retained meshes without cell ranges still support exact selected-cell draw ranges', async () => {
  const { gl, calls } = mockGl(), layer = new VoronoiAllCellLayer(gl);
  const mesh = createVoronoiCellBatch([await cube(2)]);
  delete mesh.cellRanges;
  layer.setGeometry({chunks:[mesh],cellCount:1},{allEnabled:true});
  layer.render({frame:{},atomCount:3,selected:2,displayPositions:new Float64Array(9),visibility:Uint8Array.from([255,255,255]),
    voronoiDisplayRevision:1,replicas:[{offset:[0,0,0]}],viewMatrix:new Float32Array(16),projectionMatrix:new Float32Array(16),sliceMode:'planes',sliceCount:0});
  assert.equal(layer.highlightedCellCount, 1);
  assert.deepEqual(calls.filter(call => call.name === 'drawElements').at(-1).arguments,[gl.TRIANGLES,36,gl.UNSIGNED_INT,0]);
  assert.deepEqual(calls.filter(call => call.name === 'drawArraysInstanced').at(-1).arguments,[gl.TRIANGLES,0,6,12]);
});

test('single selected-cell preview highlights amber and draws pale, CSS-sized edge ribbons without new geometry', async () => {
  const {gl,calls} = mockGl(), layer = new VoronoiCellLayer(gl), geometry = await cube(1);
  const renderer = {frame:{},atomCount:2,selected:1,displayPositions:Float64Array.from([0,0,0,2,0,0]),
    visibility:Uint8Array.from([255,255]), selectedAtoms:new Int32Array(16).fill(-1), sliceSelectedAtoms:new Int32Array(3).fill(-1),
    replicas:[{offset:[0,0,0]},{offset:[4,0,0]}], viewMatrix:new Float32Array(16),projectionMatrix:new Float32Array(16),
    canvas:{width:800,height:400,clientWidth:400},sliceMode:'planes',sliceCount:1,slicePlaneValues:Float32Array.from([1,0,0,3]),
    background:[1,1,1]};
  layer.setGeometry(geometry,{enabled:true,allEnabled:false,color:'#336699',opacity:.5});
  const uploads = calls.filter(call=>call.name==='bufferData').length;
  layer.render(renderer);
  assert.equal(layer.highlightedCellCount,1,'single-preview mode uses the same selection highlight as all-cell mode');
  assert.equal(layer.renderedReplicaCount,2);
  assert.ok(calls.some(call=>call.name==='uniform3f' && call.arguments[0]==='uColor'
    && call.arguments.slice(1).join(',')==='1,0.68,0.16'),'picked cell faces are amber instead of the unselected blue');
  assert.ok(calls.some(call=>call.name==='uniform3f' && call.arguments[0]==='uEdgeColor'
    && call.arguments.slice(1).join(',')==='1,0.95,0.75'),'picked cell edges are pale yellow');
  assert.ok(calls.some(call=>call.name==='uniform1f' && call.arguments[0]==='uEdgeWidth' && call.arguments[1]===5.6),
    '2.8 CSS-pixel ribbons retain their size on a device-pixel-ratio-two canvas');
  assert.deepEqual(calls.filter(call=>call.name==='drawArraysInstanced').map(call=>call.arguments),
    [[gl.TRIANGLES,0,6,12],[gl.TRIANGLES,0,6,12]],'each replica contains all original twelve cube edges');
  assert.equal(calls.filter(call=>call.name==='drawArrays').length,0,'visibility does not rely on implementation-dependent GL line widths');
  assert.ok(calls.some(call=>call.name==='uniform1i' && call.arguments[0]==='uSliceCount' && call.arguments[1]===1));
  assert.ok(!calls.some(call=>call.name==='disable' && call.arguments[0]===gl.DEPTH_TEST),'atom occlusion remains enabled');
  const lastFace = calls.findLastIndex(call=>call.name==='drawElements'), firstEdge = calls.findIndex(call=>call.name==='drawArraysInstanced');
  assert.ok(firstEdge>lastFace,'all translucent faces precede their outlines');
  renderer.selected=-1;renderer.background=[0,0,0];
  const before = calls.length; layer.render(renderer);
  assert.equal(layer.highlightedCellCount,0);
  assert.ok(calls.slice(before).some(call=>call.name==='uniform3f' && call.arguments[0]==='uColor'
    && call.arguments.slice(1).join(',')==='0.2,0.4,0.6'),'unselected cells retain the user-selected base color');
  assert.equal(calls.filter(call=>call.name==='bufferData').length,uploads,'changing selection or background never uploads or recomputes cell geometry');
  renderer.visibility[1]=0;layer.render(renderer);assert.equal(layer.renderedReplicaCount,0);assert.equal(layer.highlightedCellCount,0);
});

test('default see-through mode keeps two-sided translucent faces and fades deeper cells; scale shrinks every cell', async () => {
  const { gl, calls } = mockGl(), layer = new VoronoiAllCellLayer(gl);
  layer.setGeometry({ chunks:[createVoronoiCellBatch([await cube(0)])], cellCount:1 }, {allEnabled:true, scale:.8});
  layer.render({ frame:{}, atomCount:1, displayPositions:new Float64Array(3), visibility:Uint8Array.from([255]), voronoiDisplayRevision:1,
    replicas:[{offset:[0,0,0]}], viewMatrix:new Float32Array(16), projectionMatrix:new Float32Array(16), sliceMode:'planes', sliceCount:0,
    background:[0,0,0], depthRange:[2,9] });
  assert.equal(calls.filter(call => call.name === 'drawElements').length, 2, 'rear and front faces, no depth pass');
  assert.ok(!calls.some(call => call.name === 'depthMask' && call.arguments[0] === true && calls.indexOf(call) < calls.findIndex(c => c.name === 'drawArraysInstanced')));
  assert.ok(calls.some(call => call.name === 'uniform1f' && call.arguments[0] === 'uDepthFade' && call.arguments[1] > 0));
  assert.ok(calls.some(call => call.name === 'uniform2f' && call.arguments[0] === 'uDepthRange' && call.arguments[2] === 9));
  assert.equal(calls.filter(call => call.name === 'uniform1f' && call.arguments[0] === 'uScale').every(call => call.arguments[1] === .8), true);
  assert.ok(calls.some(call => call.name === 'uniform3f' && call.arguments[0] === 'uEdgeColor'
    && call.arguments.slice(1).every(channel => channel >= 0.75)), 'dark backgrounds use pale outlines');
});
