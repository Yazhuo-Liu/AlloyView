import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinationPolyhedraGeometry, normalizeCoordinationPolyhedraOptions } from '../src/render/coordination-polyhedra-layer.js';
import { VoronoiAllCellLayer } from '../src/render/voronoi-cell-layer.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const tetrahedron = atomIndex => ({ atomIndex,
  vertices: Float64Array.of(1,1,1, -1,-1,1, -1,1,-1, 1,-1,-1),
  faceOffsets: Uint32Array.of(0,3,6,9,12), faceVertices: Uint32Array.of(0,1,2, 0,3,1, 0,2,3, 1,3,2) });

function fixture() {
  const calls = [], gl = {};
  for (const name of ['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','ARRAY_BUFFER','ELEMENT_ARRAY_BUFFER',
    'FLOAT','STATIC_DRAW','UNSIGNED_INT','TEXTURE0','TEXTURE_2D','RGBA32F','RGBA','TEXTURE_MIN_FILTER','TEXTURE_MAG_FILTER',
    'NEAREST','TEXTURE_WRAP_S','TEXTURE_WRAP_T','CLAMP_TO_EDGE','MAX_TEXTURE_SIZE','SAMPLE_ALPHA_TO_COVERAGE',
    'BLEND','SRC_ALPHA','ONE_MINUS_SRC_ALPHA','ONE','CULL_FACE','DEPTH_TEST','POLYGON_OFFSET_FILL','FRONT','BACK',
    'TRIANGLES','ZERO','LEQUAL','GREATER']) gl[name] = name === 'TEXTURE0' ? 33984 : name;
  for (const name of ['createProgram','createShader','createVertexArray','createBuffer','createTexture']) gl[name] = () => ({});
  gl.getUniformLocation = (_, name) => name;
  gl.getShaderParameter = gl.getProgramParameter = () => true;
  gl.getParameter = () => 4096;
  gl.isEnabled = gl.isContextLost = () => false;
  for (const name of ['shaderSource','compileShader','attachShader','deleteShader','linkProgram','bindVertexArray',
    'bindBuffer','bufferData','enableVertexAttribArray','vertexAttribPointer','vertexAttribIPointer','deleteVertexArray',
    'deleteBuffer','bindTexture','texImage2D','activeTexture','texParameteri','useProgram','uniform1i','uniform1f','uniform2f',
    'uniform3f','uniform4fv','uniformMatrix4fv','enable','disable','vertexAttribDivisor','vertexAttribI4ui','blendFuncSeparate',
    'depthMask','depthFunc','polygonOffset','cullFace','drawElements','drawElementsInstanced','drawArrays','drawArraysInstanced']) {
    gl[name] = (...args) => calls.push({ name, args });
  }
  const r = Object.assign(Object.create(WebGLRenderer.prototype), { gl, frame: {}, atomCount: 2,
    displayPositions: Float64Array.of(0,0,0, 2,0,0), visibility: Uint8Array.of(255,255), voronoiDisplayRevision: 1,
    replicas: [{offset:[0,0,0]}, {offset:[4,0,0]}], minimumOffset:[0,0,0], maximumOffset:[4,0,0],
    viewMatrix: new Float32Array(16), projectionMatrix: new Float32Array(16), background:[1,1,1],
    selected: -1, sliceMode: 'planes', sliceCount: 1, slicePlaneValues: Float32Array.of(1,0,0,4),
    requestRender() {}, updateSceneBounds() {} });
  return { r, gl, calls };
}

test('coordination hull packing keeps complete independent faces and caches direct-kernel geometry', () => {
  const result = {cells:[tetrahedron(0), tetrahedron(1)]};
  const geometry = coordinationPolyhedraGeometry(result, 2), mesh = geometry.chunks[0];
  assert.equal(geometry.cellCount, 2);
  assert.equal(mesh.indexCount, 24); assert.equal(mesh.edgeCount, 24);
  assert.equal(mesh.foreignFaces.length + mesh.foreignEdges.length, 0);
  assert.equal(coordinationPolyhedraGeometry(result, 2), geometry);
  assert.equal(coordinationPolyhedraGeometry({geometry}, 2), geometry, 'Worker packed arrays require no repacking');
  assert.deepEqual([...mesh.bounds], [0,-1,-1,-1,1,1,1, 1,-1,-1,-1,1,1,1]);
  assert.throws(() => coordinationPolyhedraGeometry(result, 1), /outside/);
  assert.throws(() => coordinationPolyhedraGeometry({geometry:{chunks:[{...mesh, cellCount:3}],cellCount:3}}, 2), /geometry/);
});

test('polyhedra and Voronoi coexist; appearance, edge visibility and center highlights reuse hull buffers', () => {
  const {r, gl, calls} = fixture(), result = {cells:[tetrahedron(0),tetrahedron(1)]};
  const voronoi = r.voronoiAllCellLayer = new VoronoiAllCellLayer(gl);
  const voronoiGeometry = {chunks:[], cellCount:0}; voronoi.setGeometry(voronoiGeometry, {allEnabled:true});
  r.setCoordinationPolyhedra(result);
  const layer = r.coordinationPolyhedraLayer, uploads = calls.filter(call => call.name === 'bufferData').length;
  assert.notEqual(layer, voronoi); assert.equal(voronoi.geometry, voronoiGeometry);
  layer.render(r);
  assert.equal(layer.renderedReplicaCount, 2);
  assert.equal(calls.filter(call => call.name === 'drawArraysInstanced').length, 2, 'one polygon-edge batch per replica');
  r.setCoordinationPolyhedra(result, {color:'#ff6600',opacity:.6,showEdges:false});
  calls.length = 0; layer.render(r);
  assert.equal(calls.filter(call => call.name === 'drawArraysInstanced').length, 0);
  r.selected = 1; layer.render(r);
  assert.equal(layer.highlightedCellCount, 1); assert.equal(layer.renderedHighlightReplicaCount, 2);
  assert.equal(calls.filter(call => call.name === 'drawArraysInstanced').length, 2, 'selection retains a legible outline even with base edges off');
  assert.ok(calls.some(call => call.name === 'uniform1i' && call.args[0] === 'uSliceCount' && call.args[1] === 1));
  assert.equal(calls.filter(call => call.name === 'bufferData').length, 0, 'style and selection do not upload hulls');
  assert.ok(uploads > 0);
  r.setCoordinationPolyhedra(null);
  assert.equal(r.coordinationPolyhedraLayer, layer, 'clearing retains reusable GL objects');
  assert.equal(layer.chunks.length, 0); assert.equal(layer.textureValues, null);
  assert.equal(voronoi.geometry, voronoiGeometry, 'clearing hulls leaves Voronoi intact');
});

test('polyhedra follow displayed centers, masks, replicas and bounds without touching scientific vertices', () => {
  const {r,calls} = fixture(), cell = tetrahedron(1), snapshot = cell.vertices.slice(), result = {cells:[cell]};
  r.setCoordinationPolyhedra(result); const layer = r.coordinationPolyhedraLayer;
  layer.render(r); const uploads = calls.filter(call => call.name === 'bufferData').length;
  r.displayPositions[3] = -2; r.visibility[1] = 0; r.voronoiDisplayRevision++;
  r.selected = 1; layer.render(r);
  assert.deepEqual([...layer.textureValues], [0,0,0,1, -2,0,0,0]);
  assert.equal(layer.highlightedCellCount, 0, 'hidden centers hide their polyhedron highlight');
  const minimum = [0,0,0], maximum = [0,0,0];
  layer.extendBounds(r,minimum,maximum);
  assert.deepEqual(minimum,[-3,-1,-1]); assert.deepEqual(maximum,[3,1,1]);
  assert.equal(calls.filter(call => call.name === 'bufferData').length, uploads);
  assert.deepEqual(cell.vertices,snapshot);
  r.setCoordinationPolyhedra(result,{visible:false}); layer.render(r);
  assert.equal(layer.renderedReplicaCount,0);
});

test('polyhedron display options and geometry reject invalid changes transactionally', () => {
  const {r} = fixture(), result = {cells:[tetrahedron(0)]}; r.setCoordinationPolyhedra(result);
  const options = r.coordinationPolyhedraOptions;
  assert.deepEqual(normalizeCoordinationPolyhedraOptions(), {visible:true,color:'#3b82f6',opacity:.35,showEdges:true});
  for (const bad of [{opacity:NaN},{opacity:1.1},{color:'invalid'},{visible:'yes'},{showEdges:1}]) {
    assert.throws(() => r.setCoordinationPolyhedra(result,bad));
    assert.equal(r.coordinationPolyhedraOptions,options);
  }
  assert.throws(() => r.setCoordinationPolyhedra({cells:[tetrahedron(2)]}), /outside/);
  const enormous = tetrahedron(0); enormous.vertices = enormous.vertices.map(value => value * 1e40);
  assert.throws(() => r.setCoordinationPolyhedra({cells:[enormous]}), /numeric range/);
  assert.equal(r.coordinationPolyhedra,result);
});
