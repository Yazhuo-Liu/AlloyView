import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DxaClient } from '../src/analysis/dxa-client.js';
import { DXA_DEFECT_MESH_SMOOTHING, calculateDxa, normalizeDefectMeshRequest } from '../src/analysis/dxa.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { DXA_DEFECT_MESH_DEFAULTS, DXA_STRUCTURE_PROPERTY, initializeDxaTools } from '../src/dxa-tools.js';
import { createAttributeRegistry } from '../src/global-attributes.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import {
  buildSurfaceDisplayMesh, displayMeshArea, displayMeshOpenEdges, displayMeshVolume, surfaceMeshArea,
} from '../src/render/surface-mesh-geometry.js';
import { buildStatisticsTable, serializeCsv } from '../src/statistics-export.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';
import { fccBlock, periodicDistance, subsetFrame } from './helpers/surfaces.js';

const L = 40, block = fccBlock(10, 4);
/** FCC crystal with a spherical void: its free surface is a defect region. */
const voidFrame = subsetFrame(block, position => periodicDistance(position, [L / 2, L / 2, L / 2], L) > 9);

/** Whether every triangle edge is shared with exactly one oppositely directed edge. */
function closedManifold(triangles) {
  const edges = new Map();
  for (let index = 0; index < triangles.length; index += 3) {
    for (let side = 0; side < 3; side += 1) {
      const key = `${triangles[index + side]}>${triangles[index + (side + 1) % 3]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    const [from, to] = key.split('>');
    if (count !== 1 || edges.get(`${to}>${from}`) !== 1) return false;
  }
  return true;
}

/** Everything DXA reported before the defect mesh existed. */
function scientific(result) {
  return { segments: result.segments.map(segment => ({ ...segment, points: Array.from(segment.points) })), totalLength: result.totalLength,
    density: result.density, volume: result.volume, counts: result.counts, familyLengths: result.familyLengths,
    structureCounts: result.structureCounts, atomStructureTypes: Array.from(result.atomStructureTypes), parameters: result.parameters,
    parallelEdgePasses: result.parallelEdgePasses, lattice: result.lattice, algorithm: result.algorithm };
}

test('the defect mesh request is validated apart from the DXA parameters', async () => {
  assert.equal(DXA_DEFECT_MESH_SMOOTHING, 8);
  for (const off of [undefined, null, false]) assert.equal(normalizeDefectMeshRequest(off), null);
  assert.deepEqual(normalizeDefectMeshRequest(true), { smoothingLevel: 8 });
  assert.deepEqual(normalizeDefectMeshRequest({}), { smoothingLevel: 8 });
  assert.deepEqual(normalizeDefectMeshRequest({ smoothingLevel: 0 }), { smoothingLevel: 0 });
  for (const invalid of [{ smoothingLevel: -1 }, { smoothingLevel: 2.5 }, { smoothingLevel: 101 }, { smoothingLevel: '8' }]) {
    assert.throws(() => normalizeDefectMeshRequest(invalid), /smoothing/);
  }
  await assert.rejects(calculateDxa(voidFrame, {}, { defectMesh: { smoothingLevel: 500 } }), /smoothing/);
});

test('DXA output is bit-identical with the defect mesh off and on, and the mesh is closed', async () => {
  const off = await calculateDxa(voidFrame, {});
  assert.equal(Object.hasOwn(off, 'defectMesh'), false, 'no mesh and no extra key by default');
  const on = await calculateDxa(voidFrame, {}, { defectMesh: true });
  assert.deepEqual(scientific(on), scientific(off));
  for (let segment = 0; segment < off.segments.length; segment += 1) {
    assert.ok(off.segments[segment].points.every((value, index) => Object.is(value, on.segments[segment].points[index])));
  }
  const mesh = on.defectMesh;
  assert.equal(mesh.smoothingLevel, 8);
  assert.equal(mesh.error, undefined);
  assert.ok(mesh.triangleCount > 100 && mesh.vertexCount > 50);
  assert.equal(mesh.vertices.length, mesh.vertexCount * 3);
  assert.equal(mesh.triangles.length, mesh.triangleCount * 3);
  assert.ok(mesh.vertices instanceof Float64Array && mesh.triangles instanceof Uint32Array);
  assert.ok(mesh.triangles.every(vertex => vertex < mesh.vertexCount));
  assert.ok(mesh.goodCellCount > 0 && mesh.defectCellCount > 0);
  assert.equal(closedManifold(mesh.triangles), true);
  // A closed surface around the void: genus zero, and the kernel's area is the triangles' area.
  assert.equal(mesh.vertexCount - mesh.triangleCount / 2, 2);
  assert.ok(Math.abs(surfaceMeshArea(mesh, voidFrame.cell) - mesh.surfaceArea) < 1e-9 * mesh.surfaceArea);
  // Reversed, as OVITO displays it, the mesh encloses the defect region (the void and its surface layer).
  const display = buildSurfaceDisplayMesh(mesh, voidFrame.cell, { reverse: true });
  assert.equal(displayMeshOpenEdges(display), 0);
  assert.equal(display.capRanges.length, 0, 'the centered void touches no cell face');
  const enclosed = displayMeshVolume(display), sphere = 4 / 3 * Math.PI * 9 ** 3;
  assert.ok(enclosed > sphere && enclosed < 4 / 3 * Math.PI * 16 ** 3, `defect region volume ${enclosed}`);
  // Moving the void across the cell faces cuts and caps the same closed volume.
  const moved = buildSurfaceDisplayMesh(mesh, voidFrame.cell, { reverse: true, origin: [0.5, 0.5, 0.5] });
  assert.equal(displayMeshOpenEdges(moved), 0);
  assert.equal(moved.capRanges.length, 6);
  assert.ok(Math.abs(displayMeshVolume(moved) - enclosed) < 1e-8 * enclosed);
  assert.ok(Math.abs(displayMeshArea(moved, 0, moved.surfaceIndexCount) - mesh.surfaceArea) < 1e-9 * mesh.surfaceArea);
  // Smoothing changes vertex positions only; lines stay identical for every level.
  const sharp = await calculateDxa(voidFrame, {}, { defectMesh: { smoothingLevel: 0 } });
  assert.deepEqual(scientific(sharp), scientific(off));
  assert.deepEqual(sharp.defectMesh.triangles, mesh.triangles);
  assert.notDeepEqual(sharp.defectMesh.vertices, mesh.vertices);
  assert.ok(sharp.defectMesh.surfaceArea > mesh.surfaceArea, 'smoothing reduces the area of the faceted mesh');
  // The request does not persist in the retained kernel.
  const again = await calculateDxa(voidFrame, {});
  assert.equal(Object.hasOwn(again, 'defectMesh'), false);
  assert.deepEqual(scientific(again), scientific(off));
});

test('perfect crystals have no defect mesh and a dislocation line keeps its exact geometry', async () => {
  const perfect = await calculateDxa(crystalFrame('bcc', 5, 2.87), { lattice: 'bcc' }, { defectMesh: true });
  assert.deepEqual([perfect.defectMesh.vertexCount, perfect.defectMesh.triangleCount, perfect.defectMesh.defectCellCount, perfect.defectMesh.surfaceArea], [0, 0, 0, 0]);
  assert.equal(perfect.segments.length, 0);
  const screw = fccScrewFrame();
  const off = await calculateDxa(screw, {}), on = await calculateDxa(screw, {}, { defectMesh: true });
  assert.equal(on.segments.length, 1);
  assert.deepEqual(scientific(on), scientific(off));
  assert.ok(on.defectMesh.defectCellCount > 0);
  assert.equal(on.defectMesh.error, undefined);
  // This cell is open in x and y: the space outside the crystal counts as a
  // defect region, so the mesh is the crystal's free surface. It is a closed
  // manifold, but the unbounded region it encloses cannot be capped.
  assert.ok(on.defectMesh.triangleCount > 0);
  assert.equal(closedManifold(on.defectMesh.triangles), true);
  const display = buildSurfaceDisplayMesh(on.defectMesh, screw.cell, { reverse: true });
  assert.ok(Math.abs(displayMeshArea(display, 0, display.surfaceIndexCount) - on.defectMesh.surfaceArea) < 1e-9 * on.defectMesh.surfaceArea);
  assert.ok(display.positions.every(Number.isFinite));
});

test('the HEA example has a closed defect mesh and unchanged dislocation lines', async () => {
  const frame = parseLammpsFrame(await readFile(new URL('../examples/hea-fcc-screw.dump', import.meta.url), 'utf8'));
  const off = await calculateDxa(frame, { lattice: 'fcc' }), on = await calculateDxa(frame, { lattice: 'fcc' }, { defectMesh: true });
  assert.deepEqual(scientific(on), scientific(off));
  const mesh = on.defectMesh;
  assert.deepEqual([mesh.vertexCount, mesh.triangleCount], [2192, 4384]);
  assert.ok(Math.abs(surfaceMeshArea(mesh, frame.cell) - mesh.surfaceArea) < 1e-9 * mesh.surfaceArea);
  // Free in x and y, periodic in z: the mesh is the free surface of the sample,
  // a closed tube through the periodic boundary (Euler characteristic 0).
  assert.deepEqual(frame.cell.pbc, [false, false, true]);
  assert.equal(closedManifold(mesh.triangles), true);
  assert.equal(mesh.vertexCount - mesh.triangleCount / 2, 0);
  for (const origin of [[0, 0, 0], [0.3, 0.6, 0.37]]) {
    const display = buildSurfaceDisplayMesh(mesh, frame.cell, { reverse: true, origin });
    assert.ok(Math.abs(displayMeshArea(display, 0, display.surfaceIndexCount) - mesh.surfaceArea) < 1e-9 * mesh.surfaceArea, 'the wrapped mesh keeps its area');
    const height = frame.cell.vectors[8];
    assert.ok(display.minimum[2] >= -1e-9 && display.maximum[2] <= height + 1e-9, 'cut into the cell along the periodic direction');
  }
});

function nodeWorkerFactory(created, messages) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-dxa-worker.mjs', import.meta.url));
    created.push(worker);
    return {
      addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { messages.push(data); worker.postMessage(data, transfer); },
      terminate() { void worker.terminate(); },
    };
  };
}

test('the DXA Worker transfers the same defect mesh and omits it unless requested', async t => {
  const created = [], messages = [], client = new DxaClient({ workerFactory: nodeWorkerFactory(created, messages), codeWarmupMinAtoms: Infinity });
  t.after(() => client.close());
  const direct = await calculateDxa(voidFrame, {}, { defectMesh: { smoothingLevel: 3 } });
  const plain = await client.analyze(voidFrame, {});
  assert.equal(Object.hasOwn(plain, 'defectMesh'), false);
  assert.equal(Object.hasOwn(messages.at(-1), 'defectMesh'), false, 'the default request is unchanged');
  const remote = await client.analyze(voidFrame, {}, { defectMesh: { smoothingLevel: 3 } });
  assert.deepEqual(messages.at(-1).defectMesh, { smoothingLevel: 3 });
  assert.deepEqual(scientific(remote), scientific(direct));
  assert.deepEqual(scientific(plain), scientific(direct));
  assert.deepEqual(remote.defectMesh.vertices, direct.defectMesh.vertices);
  assert.deepEqual(remote.defectMesh.triangles, direct.defectMesh.triangles);
  assert.equal(remote.defectMesh.surfaceArea, direct.defectMesh.surfaceArea);
  await assert.rejects(client.analyze(voidFrame, {}, { defectMesh: { smoothingLevel: -2 } }), /smoothing/);
  assert.equal(created.length, 1);
});

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map();
    this.style = {}; this.value = ''; this.checked = false; this.hidden = false; this.textContent = ''; this.disabled = false;
    this.classList = { toggle() {} };
  }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(selector === 'input' && child.tagName === 'INPUT' ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
}

function toolHarness(t) {
  const previousDocument = globalThis.document;
  const ids = ['dxa-lattice', 'dxa-trial-length', 'dxa-stretchability', 'dxa-smoothing', 'dxa-point-interval', 'dxa-perfect-only',
    'dxa-line-radius', 'run-dxa', 'cancel-dxa', 'dxa-families', 'dxa-state', 'dxa-results', 'dxa-summary', 'dxa-status',
    'dxa-defect-mesh', 'dxa-defect-mesh-smoothing', 'dxa-defect-mesh-visible', 'dxa-defect-mesh-caps', 'dxa-defect-mesh-opacity',
    'dxa-defect-mesh-color', 'dxa-defect-mesh-interior-color', 'dxa-defect-mesh-cap-color', 'dxa-defect-mesh-controls',
    'dxa-defect-mesh-summary', 'export-dxa-defect-mesh-stl', 'export-dxa-defect-mesh-ply'];
  const fields = Object.fromEntries(ids.map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => fields[id], createElement: tag => new Element(tag) };
  t.after(() => { globalThis.document = previousDocument; });
  const frame = { ...voidFrame, properties: [] };
  const pending = [], meshCalls = [], downloads = [], notifications = [];
  const client = { analyze(inputFrame, parameters, options) { return new Promise((resolve, reject) => pending.push({ inputFrame, parameters, options, resolve, reject })); }, release() {} };
  const renderer = { frame, periodicOrigin: [0, 0, 0], coordinateMode: 'wrapped', setDislocationNetwork() {},
    setSurfaceMesh(id, mesh, options) { meshCalls.push({ id, mesh, options: { ...options } }); return { id, mesh, options, error: null }; } };
  const tools = initializeDxaTools({ renderer, client, tools: { setToolEnabled() {} }, getFrame: () => frame, getSourceVersion: () => 'a',
    getColorMode: () => 'property:other', getFileStem: () => 'sample', getFrameIndex: () => 2,
    notify: message => notifications.push(message), onDownload: (blob, filename) => downloads.push({ blob, filename }) });
  tools.setEnabled(true);
  return { tools, fields, pending, meshCalls, downloads, notifications, frame };
}

test('the DXA panel requests, displays, styles and exports the defect mesh', async t => {
  const h = toolHarness(t), { tools, fields } = h;
  const withMesh = await calculateDxa(voidFrame, {}, { defectMesh: true }), { defectMesh, ...withoutMesh } = withMesh;
  assert.equal(fields['dxa-defect-mesh'].checked, false, 'off by default');
  assert.equal(fields['dxa-defect-mesh-smoothing'].value, '8');
  assert.equal(Object.hasOwn(tools.serialize(), 'defectMesh'), false, 'untouched settings are not saved');
  // Default run: no mesh requested, none displayed.
  const first = tools.run();
  assert.equal(Object.hasOwn(h.pending[0].options, 'defectMesh'), false);
  h.pending[0].resolve(withoutMesh); await first;
  assert.equal(h.meshCalls.at(-1).mesh, null);
  assert.equal(fields['dxa-defect-mesh-controls'].hidden, true);
  // Switching the mesh on needs a new extraction; the request carries the smoothing level.
  fields['dxa-defect-mesh'].checked = true; fields['dxa-defect-mesh'].dispatch('change');
  assert.equal(h.pending.length, 2);
  assert.deepEqual(h.pending[1].options.defectMesh, { smoothingLevel: 8 });
  assert.deepEqual(h.pending[1].parameters, h.pending[0].parameters, 'the DXA parameters are the same');
  h.pending[1].resolve(withMesh);
  await new Promise(resolve => setImmediate(resolve));
  const shown = h.meshCalls.at(-1);
  assert.equal(shown.id, 'dxaDefect');
  assert.equal(shown.mesh.vertices, defectMesh.vertices);
  assert.equal(shown.mesh.reverse, true, 'OVITO shows the defect mesh with reversed orientation');
  assert.deepEqual(shown.options, { visible: true, caps: true, opacity: 1, color: '#d9c06a', interiorColor: '#c7ae5c', capColor: '#b39b52' });
  assert.equal(fields['dxa-defect-mesh-controls'].hidden, false);
  assert.match(fields['dxa-defect-mesh-summary'].textContent, /triangles · .* Å² surface area · smoothing 8/);
  assert.equal(fields['export-dxa-defect-mesh-stl'].disabled, false);
  assert.equal(h.frame.properties.find(property => property.name === DXA_STRUCTURE_PROPERTY).analysisKey, JSON.stringify(h.pending[0].parameters),
    'the analysis key of the structure output does not depend on the mesh');
  // Styles redraw the same mesh; hiding or switching it off does not recalculate.
  fields['dxa-defect-mesh-opacity'].value = '0.5'; fields['dxa-defect-mesh-opacity'].dispatch('input');
  fields['dxa-defect-mesh-cap-color'].value = '#123456'; fields['dxa-defect-mesh-cap-color'].dispatch('change');
  fields['dxa-defect-mesh-caps'].checked = false; fields['dxa-defect-mesh-caps'].dispatch('change');
  assert.equal(h.meshCalls.at(-1).mesh, shown.mesh);
  assert.deepEqual(h.meshCalls.at(-1).options, { visible: true, caps: false, opacity: 0.5, color: '#d9c06a', interiorColor: '#c7ae5c', capColor: '#123456' });
  fields['dxa-defect-mesh'].checked = false; fields['dxa-defect-mesh'].dispatch('change');
  assert.equal(h.meshCalls.at(-1).mesh, null);
  assert.equal(h.pending.length, 2);
  // Switching it back on reuses the cached result; another smoothing level recalculates.
  fields['dxa-defect-mesh'].checked = true; fields['dxa-defect-mesh'].dispatch('change');
  assert.equal(h.pending.length, 2);
  assert.equal(h.meshCalls.at(-1).mesh, shown.mesh);
  fields['dxa-defect-mesh-smoothing'].value = '2'; fields['dxa-defect-mesh-smoothing'].dispatch('change');
  assert.equal(h.pending.length, 3);
  assert.deepEqual(h.pending[2].options.defectMesh, { smoothingLevel: 2 });
  h.pending[2].resolve({ ...withMesh, defectMesh: { ...defectMesh, smoothingLevel: 2 } });
  await new Promise(resolve => setImmediate(resolve));
  // Settings round-trip through a validated configuration.
  const saved = tools.serialize();
  assert.deepEqual(saved.defectMesh, { ...DXA_DEFECT_MESH_DEFAULTS, enabled: true, smoothingLevel: 2, caps: false, opacity: 0.5, capColor: '#123456' });
  const parsed = parseConfiguration(JSON.stringify(createConfiguration({ settings: { extensions: { dxa: saved } } }))).settings.extensions.dxa;
  assert.deepEqual(parsed.defectMesh, { enabled: true, smoothingLevel: 2, visible: true, caps: false, opacity: 0.5,
    color: '#d9c06a', interiorColor: '#c7ae5c', capColor: '#123456' });
  // Exports: the wrapped, reversed mesh as displayed.
  const stl = tools.exportDefectMesh('stl');
  assert.equal(h.downloads.at(-1).filename, 'sample-frame-3-dxa-defect-mesh.stl');
  assert.ok(stl.triangleCount >= defectMesh.triangleCount);
  fields['export-dxa-defect-mesh-ply'].dispatch('click');
  assert.equal(h.downloads.at(-1).filename, 'sample-frame-3-dxa-defect-mesh.ply');
  // Restore: old recipes leave the mesh off; saved ones request it again.
  const restoring = tools.restore({ ...parsed, enabled: true });
  assert.equal(fields['dxa-defect-mesh'].checked, true);
  assert.equal(fields['dxa-defect-mesh-smoothing'].value, '2');
  assert.deepEqual(h.pending.at(-1).options.defectMesh, { smoothingLevel: 2 });
  h.pending.at(-1).resolve({ ...withMesh, defectMesh: { ...defectMesh, smoothingLevel: 2 } }); await restoring;
  const { defectMesh: ignored, ...oldRecipe } = parsed;
  const old = tools.restore({ ...oldRecipe, enabled: true });
  assert.equal(fields['dxa-defect-mesh'].checked, false);
  assert.equal(Object.hasOwn(h.pending.at(-1).options, 'defectMesh'), false);
  h.pending.at(-1).resolve(withoutMesh); await old;
  assert.equal(h.meshCalls.at(-1).mesh, null);
  assert.equal(tools.exportDefectMesh('stl'), null);
  assert.match(h.notifications.at(-1), /Extract dislocations with the defect mesh/);
  // A mesh the kernel could not close is explained, never drawn.
  fields['dxa-defect-mesh'].checked = true;
  const failing = tools.run();
  h.pending.at(-1).resolve({ ...withMesh, defectMesh: { smoothingLevel: 8, vertexCount: 0, triangleCount: 0, goodCellCount: 5, defectCellCount: 3,
    surfaceArea: 0, error: 'The DXA defect mesh is not a closed manifold.', vertices: new Float64Array(0), triangles: new Uint32Array(0) } });
  await failing;
  assert.equal(h.meshCalls.at(-1).mesh, null);
  assert.match(fields['dxa-defect-mesh-summary'].textContent, /could not be generated: The DXA defect mesh is not a closed manifold/);
  assert.equal(fields['dxa-state'].textContent, 'Calculated', 'the dislocation result is kept');
});

test('defect mesh settings in shared recipes are validated, and its area is a global attribute', async () => {
  const dxa = extension => () => createConfiguration({ settings: { extensions: { dxa: extension } } });
  const old = dxa({ enabled: true, lattice: 'bcc' })().settings.extensions.dxa;
  assert.equal(Object.hasOwn(old, 'defectMesh'), false, 'recipes without the mesh are unchanged');
  assert.deepEqual(dxa({ defectMesh: {} })().settings.extensions.dxa.defectMesh, { enabled: false, smoothingLevel: 8, visible: true, caps: true, opacity: 1,
    color: '#d9c06a', interiorColor: '#c7ae5c', capColor: '#b39b52' });
  assert.throws(dxa({ defectMesh: { smoothingLevel: 101 } }), /smoothingLevel/);
  assert.throws(dxa({ defectMesh: { enabled: 'yes' } }), /true or false/);
  assert.throws(dxa({ defectMesh: { opacity: -1 } }), /opacity/);
  assert.throws(dxa({ defectMesh: { color: '#12345' } }), /color/);
  assert.throws(dxa({ defectMesh: { vertices: [1, 2, 3] } }), /not a supported setting/);
  assert.throws(dxa({ defectMesh: [] }), /must be an object/);
  const network = await calculateDxa(voidFrame, {}, { defectMesh: true });
  const frame = { ...voidFrame, properties: [{ name: 'dxaStructureType', analysisKind: 'dxa', analysisKey: 'k', data: network.atomStructureTypes, categories: [{ id: 1, label: 'FCC' }] }] };
  const registry = createAttributeRegistry({ frame, frameIndex: 0, dxaNetwork: network });
  assert.equal(registry.get('DXA.defect_mesh_area').value, network.defectMesh.surfaceArea);
  assert.equal(registry.get('DXA.defect_mesh_area').unit, 'Å²');
  const { defectMesh, ...plain } = network;
  assert.equal(createAttributeRegistry({ frame, frameIndex: 0, dxaNetwork: plain }).has('DXA.defect_mesh_area'), false);
  const table = snapshotNetwork => serializeCsv(buildStatisticsTable({ frame: { ...frame, atomCount: frame.ids.length, properties: [] }, results: {},
    dxaNetwork: snapshotNetwork }, 'dxa-summary')).split(/\r?\n/).map(line => line.split(',').slice(3));
  const summary = { counts: network.counts, familyLengths: network.familyLengths, totalLength: network.totalLength, density: network.density, volume: network.volume, segmentCount: 0 };
  assert.deepEqual(table({ ...summary, defectMeshArea: defectMesh.surfaceArea }).find(row => row[0] === 'defect_mesh_area'), ['defect_mesh_area', '', String(defectMesh.surfaceArea), 'Å²']);
  assert.equal(table(summary).some(row => row[0] === 'defect_mesh_area'), false);
});
