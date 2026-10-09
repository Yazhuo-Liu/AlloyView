import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConfiguration,
  downloadConfiguration,
  matchesSource,
  MAX_CONFIGURATION_BYTES,
  MAX_CONFIGURATION_SLICES,
  MAX_CONFIGURATION_PAIR_CUTOFFS,
  MAX_CONFIGURATION_ATOM_OVERRIDES,
  MAX_CONFIGURATION_RDF_BINS,
  MAX_CONFIGURATION_SELECTION_GROUPS,
  parseConfiguration,
} from '../src/configuration.js';

test('processing recipes round-trip full source, camera, analyses, filters and editable planes', () => {
  const snapshot = fullSnapshot();
  const configuration = createConfiguration(snapshot);
  const restored = parseConfiguration(JSON.stringify(configuration));
  assert.deepEqual(restored, configuration);
  assert.equal(restored.app, 'AlloyView');
  assert.equal(restored.version, 1);
  assert.equal(restored.source.frameIndex, 4);
  assert.equal(restored.settings.slices.items[0].side, 'positive');
  assert.equal(restored.settings.slices.items[1].showGizmo, false);
  assert.deepEqual(restored.settings.analyses.strain.references, snapshot.settings.analyses.strain.references);
  assert.deepEqual(restored.settings.colors, snapshot.settings.colors);
  assert.equal(restored.settings.display.radiusPercent, 500);
  assert.equal(restored.settings.display.background, '#ffffff');
  // Recipes and restored recipes own their arrays rather than modifying UI state.
  snapshot.settings.camera.target[0] = 99;
  restored.settings.camera.target[1] = 88;
  assert.deepEqual(configuration.settings.camera.target, [1, 2, 3]);
  assert.deepEqual(Object.keys(configuration.source.files[0]).sort(), ['lastModified', 'name', 'relativePath', 'size']);
  assert.equal(JSON.stringify(configuration).includes('positions'), false);
});

test('display-only recipes work without source files and use stable defaults', () => {
  const recipe = createConfiguration();
  assert.equal(recipe.source, null);
  assert.equal(recipe.settings.display.colorMode, 'type');
  assert.deepEqual(recipe.settings.replicate, [1, 1, 1]);
  assert.deepEqual(recipe.settings.slices.items, []);
  assert.equal(recipe.settings.slices.selectedId, null);
  assert.equal(recipe.settings.display.png.axes, false);
  assert.equal(recipe.settings.compute.gpuEnabled, true);
  assert.deepEqual(recipe.settings.analyses.centrosymmetry, { enabled: false, mode: 'auto', neighbors: 12 });
  assert.equal(matchesSource(recipe, []), true);
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)), recipe);
});

test('advanced view recipes retain independent vector fields, free camera and periodic origin without atom arrays', () => {
  const snapshot = fullSnapshot();
  Object.assign(snapshot.settings.display, { periodicOrigin: [0.4, -0.25, 1.1], cellWireframeMode: 'rgb-origin' });
  Object.assign(snapshot.settings.camera, { pitch: Math.PI * 0.7, roll: 0.3, fov: 0.8, constrainUp: false });
  snapshot.settings.activeCategory = 'modification';
  snapshot.settings.activeTool = 'externalProperties';
  snapshot.settings.extensions = { vectors: { fields: [
    { id: 'forces', name: 'Force arrows', enabled: true, mode: 'force', color: '#123abc', dimension: '2d', upMode: 'fixed', up: [0, 0, 1] },
    { id: 'velocity', name: 'Velocity arrows', enabled: false, mode: 'velocity', scale: 2 },
  ], selectedId: 'velocity' }, externalProperties: { files: [{
    id: 'external-one', file: { name: 'forces.csv', size: 45 }, mapping: 'id', scope: 'all-frames', frameIndex: 4,
    columns: [{ sourceName: 'forceX', name: 'forceX', unit: 'eV/A', enabled: true }],
  }] } };
  const recipe = createConfiguration(snapshot);
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored, recipe);
  assert.deepEqual(restored.settings.display.periodicOrigin, [0.4, -0.25, 1.1]);
  assert.equal(restored.settings.camera.pitch, Math.PI * 0.7);
  assert.equal(restored.settings.camera.constrainUp, false);
  assert.equal(restored.settings.extensions.vectors.fields[0].upMode, 'fixed');
  assert.equal(restored.settings.extensions.vectors.fields[1].scale, 2);
  assert.equal(restored.settings.extensions.vectors.selectedId, 'velocity');
  assert.equal(restored.settings.extensions.externalProperties.files[0].file.name, 'forces.csv');
  assert.equal(restored.settings.activeCategory, 'modification');
  assert.equal(JSON.stringify(recipe).includes('values'), false);
  snapshot.settings.display.periodicOrigin[0] = 99;
  snapshot.settings.extensions.vectors.fields[0].up[0] = 99;
  assert.equal(recipe.settings.display.periodicOrigin[0], 0.4);
  assert.deepEqual(recipe.settings.extensions.vectors.fields[0].up, [0, 0, 1]);
});

test('advanced recipes reject invalid geometry, ambiguous vector IDs and external atom payloads before restoration', () => {
  const recipe = createConfiguration(fullSnapshot());
  for (const mutate of [
    value => { value.settings.display.periodicOrigin = [1, 2]; },
    value => { value.settings.display.cellWireframeMode = 'rainbow'; },
    value => { value.settings.camera.roll = '30'; },
    value => { value.settings.camera.fov = Math.PI; },
    value => { value.settings.camera.pitch = Math.PI; },
    value => { value.settings.extensions.vectors.fields = [{ id: 'same' }, { id: 'same' }]; },
    value => { value.settings.extensions.vectors.fields = [{ id: 'field', up: [0, 0, 0] }]; },
    value => { value.settings.extensions.vectors.fields = [{ id: 'field' }]; value.settings.extensions.vectors.selectedId = 'missing'; },
    value => { value.settings.extensions.externalProperties = { files: [{
      id: 'f', file: { name: 'a.csv', size: 5 }, mapping: 'id', scope: 'all-frames', frameIndex: 10,
      columns: [{ sourceName: 'stress', name: 'stress', unit: '', enabled: true }],
    }] }; },
    value => { value.settings.extensions.externalProperties = { files: [], values: [1, 2] }; },
  ]) {
    const invalid = structuredClone(recipe);
    mutate(invalid);
    assert.throws(() => parseConfiguration(JSON.stringify(invalid)));
  }
});

test('coordination recipes save elemental cutoff choices while preserving legacy numeric values', () => {
  for (const [preset, cutoff] of [['custom', 3.17], ['Ni', 2.85], ['Al', 3.3], ['Ta', 3.3]]) {
    const coordination = { enabled: true, cutoff, preset };
    const recipe = createConfiguration({ settings: { analyses: { coordination } } });
    assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.analyses.coordination, coordination);
  }
  const oldRecipe = createConfiguration({ settings: { analyses: { coordination: { enabled: true, cutoff: 3.17 } } } });
  assert.deepEqual(parseConfiguration(JSON.stringify(oldRecipe)).settings.analyses.coordination, { enabled: true, cutoff: 3.17 });
  assert.equal(Object.hasOwn(oldRecipe.settings.analyses.coordination, 'preset'), false);
  for (const preset of ['Type 1', 'Fe.cfg', 'ni', '__proto__', null, 3]) {
    const invalid = structuredClone(oldRecipe);
    invalid.settings.analyses.coordination.preset = preset;
    assert.throws(() => parseConfiguration(JSON.stringify(invalid)), /settings\.analyses\.coordination\.preset/);
  }
});

test('GPU acceleration defaults on while explicit saved off preferences round-trip', () => {
  const recipe = createConfiguration({ settings: { compute: { gpuEnabled: true } } });
  assert.equal(parseConfiguration(JSON.stringify(recipe)).settings.compute.gpuEnabled, true);
  recipe.settings.compute.gpuEnabled = false;
  assert.equal(parseConfiguration(JSON.stringify(recipe)).settings.compute.gpuEnabled, false);
  assert.equal(createConfiguration({ settings: { compute: { gpuEnabled: false } } }).settings.compute.gpuEnabled, false);
  delete recipe.settings.compute;
  assert.equal(parseConfiguration(JSON.stringify(recipe)).settings.compute.gpuEnabled, true);
  recipe.settings.compute = {};
  assert.equal(parseConfiguration(JSON.stringify(recipe)).settings.compute.gpuEnabled, true);
  assert.throws(() => createConfiguration({ settings: { compute: { gpuEnabled: 'true' } } }), /settings\.compute\.gpuEnabled/);
  assert.throws(() => createConfiguration({ settings: { compute: { unknown: true } } }), /settings\.compute/);
});

test('named selection recipes restore stable IDs, styling, visibility and the selected editor', () => {
  const selectionGroups = { groups: [
    { id: 'boundary', name: 'Grain boundary', color: '#112233', visible: false, atomIds: [42, '9007199254740993'] },
    { id: 'grain', name: 'Grain 2', color: '#abcdef', visible: true, atomIds: [9, 10] },
  ], selectedGroupId: 'boundary' };
  const recipe = createConfiguration({ settings: { selectionGroups, activeTool: 'selectionGroups' } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored.settings.selectionGroups, selectionGroups);
  assert.equal(restored.settings.activeTool, 'selectionGroups');
  selectionGroups.groups[0].atomIds.push(999);
  assert.deepEqual(recipe.settings.selectionGroups.groups[0].atomIds, [42, '9007199254740993']);
  delete recipe.settings.selectionGroups;
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.selectionGroups, { groups: [], selectedGroupId: null });
});

test('named selection recipe validation rejects ambiguous IDs and malformed editor state before restoration', () => {
  const recipe = createConfiguration({ settings: { selectionGroups: {
    groups: [{ id: 'a', name: 'A', color: '#112233', visible: true, atomIds: [1] }], selectedGroupId: 'a',
  } } });
  for (const mutate of [
    value => { value.groups[0].atomIds = [42, '42']; },
    value => { value.groups[0].atomIds = [Number.MAX_SAFE_INTEGER + 1]; },
    value => { value.groups[0].color = '#fff'; },
    value => { value.groups[0].visible = 1; },
    value => { value.selectedGroupId = 'missing'; },
    value => { value.groups[0].positions = []; },
    value => { value.groups = Array.from({ length: MAX_CONFIGURATION_SELECTION_GROUPS + 1 }, (_, i) => ({ id: `g${i}`, name: 'G', color: '#112233', atomIds: [] })); },
  ]) {
    const invalid = structuredClone(recipe);
    mutate(invalid.settings.selectionGroups);
    assert.throws(() => parseConfiguration(JSON.stringify(invalid)), /Invalid AlloyView configuration: settings\.selectionGroups/);
  }
});

test('physical replication preference round-trips while older recipes retain display-only repeats', () => {
  const recipe = createConfiguration({ settings: { replicate: [2, 3, 1], replicateAtoms: true } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.equal(restored.settings.replicateAtoms, true);
  assert.deepEqual(restored.settings.replicate, [2, 3, 1]);
  delete recipe.settings.replicateAtoms;
  assert.equal(parseConfiguration(JSON.stringify(recipe)).settings.replicateAtoms, false);
  assert.throws(() => createConfiguration({ settings: { replicateAtoms: 1 } }), /settings\.replicateAtoms/);
});

test('AtomEye extension recipes round-trip processing settings without computed data', () => {
  const extensions = extensionSnapshot();
  const recipe = createConfiguration({ settings: { extensions, activeTool: 'referenceStrain' } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored.settings.extensions, extensions);
  assert.equal(restored.version, 1);
  assert.equal(restored.settings.activeTool, 'referenceStrain');
  extensions.bonds.pairCutoffs[0].cutoff = 99;
  extensions.vectors.components[0] = 'changed';
  extensions.measurements.atomIds.push(100);
  extensions.appearance.atoms[0].visible = true;
  assert.equal(recipe.settings.extensions.bonds.pairCutoffs[0].cutoff, 2.4);
  assert.equal(recipe.settings.extensions.vectors.components[0], 'force_x');
  assert.deepEqual(recipe.settings.extensions.measurements.atomIds, [1, 2, 3, 4]);
  assert.equal(recipe.settings.extensions.appearance.atoms[0].visible, false);
  assert.equal(JSON.stringify(recipe).includes('positions'), false);
  assert.equal(JSON.stringify(recipe).includes('histogram'), false);
  for (const activeTool of ['bonds', 'vectors', 'displacement', 'statistics', 'referenceStrain', 'localShear']) {
    assert.equal(createConfiguration({ settings: { activeTool } }).settings.activeTool, activeTool);
  }
});

test('older version 1 recipes disable every new computation and use portable defaults', () => {
  const recipe = createConfiguration();
  delete recipe.settings.extensions;
  const extensions = parseConfiguration(JSON.stringify(recipe)).settings.extensions;
  assert.deepEqual(extensions, {
    bonds: { enabled: false, cutoff: null, pairCutoffs: [], radius: 0.12, visible: true },
    vectors: { enabled: false, components: [null, null, null], mode: 'generic', componentScales: [1, 1, 1],
      scale: 1, color: '#f9ca57', radius: .06, headRadius: .15,
      headLength: .3, linkDimensions: true, anchor: 'tail', dimension: '3d', upMode: 'camera', up: [0, 1, 0] },
    displacement: { enabled: false, referenceFrame: 0, minimumImage: true, tiles: [0, 0, 0] },
    referenceStrain: { enabled: false, cutoff: null, frameIndex: 0 },
    localShear: { enabled: false, cutoff: null, subtractMean: false },
    rdf: { enabled: false, cutoff: null, bins: 100, firstType: null, secondType: null },
    measurements: { enabled: false, minimumImage: true, atomIds: [] },
    appearance: { elements: [], atoms: [] },
    comparison: { enabled: false, preset: 'top', projectionMode: 'orthographic', camera: null },
  });
  assert.deepEqual(createConfiguration().settings.extensions, extensions);
});

test('extension settings reject invalid cutoffs, resources, properties and appearance values', () => {
  const recipe = createConfiguration({ settings: { extensions: extensionSnapshot() } });
  for (const mutate of [
    value => { value.bonds.cutoff = null; },
    value => { value.bonds.cutoff = 0; },
    value => { value.bonds.radius = -1; },
    value => { value.bonds.visible = 'false'; },
    value => { value.bonds.pairCutoffs[0].cutoff = '2.4'; },
    value => { value.bonds.pairCutoffs[0].first = ' '; },
    value => { value.bonds.pairCutoffs.push({ first: 'C', second: 'Fe', cutoff: 3 }); },
    value => { value.bonds.pairCutoffs = Array(MAX_CONFIGURATION_PAIR_CUTOFFS + 1).fill({ first: 'Fe', second: 'Fe', cutoff: 3 }); },
    value => { value.vectors.components = ['force_x', 'force_y']; },
    value => { value.vectors.components[2] = null; },
    value => { value.vectors.components[0] = '__proto__'; },
    value => { value.vectors.scale = 0; },
    value => { value.vectors.color = 'red'; },
    value => { value.referenceStrain.frameIndex = 0.5; },
    value => { value.referenceStrain.frameIndex = -1; },
    value => { value.referenceStrain.cutoff = null; },
    value => { value.localShear.subtractMean = 'false'; },
    value => { value.rdf.bins = 0; },
    value => { value.rdf.bins = MAX_CONFIGURATION_RDF_BINS + 1; },
    value => { value.rdf.bins = 2.5; },
    value => { value.rdf.firstType = 'constructor'; },
    value => { value.measurements.minimumImage = 1; },
    value => { value.measurements.atomIds = [1, '1']; },
    value => { value.measurements.atomIds = [1, 2, 3, 4, 5]; },
    value => { value.appearance.elements[0].color = '#fff'; },
    value => { value.appearance.elements[0].radius = 0; },
    value => { value.appearance.elements.push({ label: 'Fe' }); },
    value => { value.appearance.atoms.push({ id: '2' }); },
    value => { value.appearance.atoms = Array(MAX_CONFIGURATION_ATOM_OVERRIDES + 1).fill({ id: 1 }); },
    value => { value.appearance.atoms[0].visible = 'false'; },
    value => { value.comparison.preset = 'isometric'; },
    value => { value.comparison.enabled = 1; },
    value => { value.rdf.histogram = [1, 2, 3]; },
    value => { value.referenceStrain.positions = [[0, 0, 0]]; },
  ]) {
    const mutated = structuredClone(recipe);
    mutate(mutated.settings.extensions);
    assert.throws(() => parseConfiguration(JSON.stringify(mutated)), /Invalid AlloyView configuration/);
  }
  const polluted = JSON.stringify(recipe).replace('"extensions":{', '"extensions":{"__proto__":{"polluted":true},');
  assert.throws(() => parseConfiguration(polluted), /__proto__/);
  assert.equal({}.polluted, undefined);
});

test('disabled extension inputs normalize unconfigured values but cannot hide malformed settings', () => {
  const recipe = createConfiguration({ settings: { extensions: {
    bonds: { cutoff: NaN }, referenceStrain: { cutoff: NaN }, localShear: { cutoff: NaN }, rdf: { cutoff: NaN },
    appearance: { elements: [{ label: 'Fe', color: '#ABCDEF', radius: NaN }] },
  } } });
  for (const name of ['bonds', 'referenceStrain', 'localShear', 'rdf']) {
    assert.equal(recipe.settings.extensions[name].enabled, false);
    assert.equal(recipe.settings.extensions[name].cutoff, null);
  }
  assert.deepEqual(recipe.settings.extensions.appearance.elements, [{ label: 'Fe', color: '#abcdef', radius: null, visible: true }]);
  assert.throws(() => createConfiguration({ settings: { extensions: { bonds: { cutoff: -1 } } } }), /cutoff/);
  assert.throws(() => createConfiguration({ settings: { extensions: { vectors: { enabled: true } } } }), /three properties/);
  assert.throws(() => createConfiguration({ settings: { extensions: { rdf: { enabled: true } } } }), /required/);
  const pairOff = createConfiguration({ settings: { extensions: { bonds: {
    pairCutoffs: [{ first: 'Fe', second: 'C', cutoff: 0 }],
  } } } });
  assert.equal(pairOff.settings.extensions.bonds.pairCutoffs[0].cutoff, 0);
  assert.equal(createConfiguration({ settings: { extensions: { rdf: { bins: 1 } } } }).settings.extensions.rdf.bins, 1);
});

test('reference-frame recipes validate known trajectory bounds before restoration', () => {
  const snapshot = fullSnapshot();
  snapshot.settings.extensions = extensionSnapshot();
  snapshot.settings.extensions.referenceStrain.frameIndex = 7;
  snapshot.source.frameCount = 8;
  assert.equal(createConfiguration(snapshot).settings.extensions.referenceStrain.frameIndex, 7);
  snapshot.settings.extensions.referenceStrain.frameIndex = 8;
  assert.throws(() => createConfiguration(snapshot), /referenceStrain\.frameIndex/);
  snapshot.settings.extensions.referenceStrain.enabled = false;
  assert.equal(createConfiguration(snapshot).settings.extensions.referenceStrain.frameIndex, 8);
});

test('XYZ and PDB recipes match either a trajectory or its corresponding numbered sequence', () => {
  for (const format of ['xyz', 'pdb']) {
    const recipe = createConfiguration({ source: { format: `${format}-sequence`, files: [{ name: `frame.${format}`, size: 300 }] } });
    assert.equal(matchesSource(recipe, [{ name: `frame.${format}`, size: 300 }], format), true);
    assert.equal(matchesSource(recipe, [{ name: `frame.${format}`, size: 300 }], `${format}-sequence`), true);
    assert.equal(matchesSource(recipe, [{ name: `frame.${format}`, size: 300 }], 'cfg'), false);
    assert.equal(matchesSource(recipe, [{ name: `frame.${format}`, size: 300 }], format === 'xyz' ? 'pdb' : 'xyz'), false);
    assert.deepEqual(parseConfiguration(JSON.stringify(recipe)), recipe);
  }
});

function extensionSnapshot() {
  return {
    bonds: { enabled: true, cutoff: 3.1, pairCutoffs: [{ first: 'Fe', second: 'C', cutoff: 2.4 }], radius: 0.18, visible: false },
    vectors: { enabled: true, components: ['force_x', 'force_y', 'force_z'], mode: 'generic', componentScales: [1, 1, 1],
      scale: 2, color: '#ffb84a', radius: .06, headRadius: .15,
      headLength: .3, linkDimensions: true, anchor: 'tail', dimension: '3d', upMode: 'camera', up: [0, 1, 0] },
    displacement: { enabled: false, referenceFrame: 0, minimumImage: true, tiles: [0, 0, 0] },
    referenceStrain: { enabled: true, cutoff: 3.1, frameIndex: 2 },
    localShear: { enabled: true, cutoff: 3.1, subtractMean: true },
    rdf: { enabled: true, cutoff: 8, bins: 256, firstType: 'Fe', secondType: 'C' },
    measurements: { enabled: true, minimumImage: true, atomIds: [1, 2, 3, 4] },
    appearance: { elements: [{ label: 'Fe', color: '#ff1122', radius: 1.5, visible: true }], atoms: [{ id: 2, color: null, radius: null, visible: false }] },
    comparison: { enabled: true, preset: 'right', projectionMode: 'orthographic', camera: null },
  };
}

test('legacy displacement vector recipes migrate analysis settings and retain glyph settings', () => {
  const vectors = { enabled: true, mode: 'displacement', referenceFrame: 1, minimumImage: false,
    componentScales: [2, -3, 0], scale: 4, anchor: 'head', dimension: '2d',
    radius: .2, headRadius: .6, headLength: .8, linkDimensions: false };
  const recipe = createConfiguration({ settings: { extensions: { vectors }, activeTool: 'vectors' } });
  const restored = parseConfiguration(JSON.stringify(recipe)).settings.extensions;
  for (const [key, value] of Object.entries(vectors)) {
    if (!['referenceFrame', 'minimumImage'].includes(key)) assert.deepEqual(restored.vectors[key], value);
  }
  assert.deepEqual(restored.displacement, { enabled: true, referenceFrame: 1, minimumImage: false, tiles: [0, 0, 0] });
  assert.deepEqual(restored.vectors.components, [null, null, null]);
  assert.equal(Object.hasOwn(restored.vectors, 'referenceFrame'), false);
  assert.equal(Object.hasOwn(restored.vectors, 'minimumImage'), false);
  for (const invalid of [{ mode: 'unknown' }, { referenceFrame: -1 }, { radius: 0 }, { headRadius: -1 },
    { headLength: Infinity }, { dimension: '4d' }, { anchor: 'origin' }, { componentScales: [1, null, 1] }]) {
    assert.throws(() => createConfiguration({ settings: { extensions: { vectors: { ...vectors, ...invalid } } } }), /settings\.extensions\.vectors/);
  }
});

test('old displacement calculation survives migration when arrow visibility is disabled', () => {
  const recipe = createConfiguration({ settings: { extensions: { vectors: {
    mode: 'displacement', enabled: false, referenceFrame: 2, minimumImage: false,
  } } } });
  assert.equal(recipe.settings.extensions.vectors.enabled, false);
  assert.deepEqual(recipe.settings.extensions.displacement, { enabled: true, referenceFrame: 2, minimumImage: false, tiles: [0, 0, 0] });
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)), recipe);
});

test('independent displacement settings round-trip and override legacy vector calculation settings', () => {
  const displacement = { enabled: false, referenceFrame: 4, minimumImage: true, tiles: [2, 0, 3] };
  const recipe = createConfiguration({ settings: { activeTool: 'displacement', extensions: {
    displacement, vectors: { mode: 'displacement', enabled: true, referenceFrame: 1, minimumImage: false },
  } } });
  assert.deepEqual(recipe.settings.extensions.displacement, displacement);
  assert.equal(recipe.settings.activeTool, 'displacement');
  assert.equal(recipe.settings.extensions.vectors.enabled, true);
  assert.equal(recipe.settings.extensions.vectors.mode, 'displacement');
  assert.equal(Object.hasOwn(recipe.settings.extensions.vectors, 'referenceFrame'), false);
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)), recipe);
  for (const invalid of [{ enabled: 1 }, { referenceFrame: -1 }, { referenceFrame: .5 }, { minimumImage: 'true' }, { tiles: [1, 2] }, { tiles: [0, 65, 0] }, { tiles: [0, 1.5, 0] }]) {
    assert.throws(() => createConfiguration({ settings: { extensions: { displacement: { ...displacement, ...invalid } } } }), /settings\.extensions\.displacement/);
  }
});

test('displacement reference bounds are checked whenever the independent analysis is enabled', () => {
  const source = { format: 'xyz', frameCount: 2, files: [{ name: 'frames.xyz', size: 42 }] };
  const displacement = { enabled: true, referenceFrame: 1, minimumImage: false, tiles: [0, 0, 0] };
  assert.deepEqual(createConfiguration({ source, settings: { extensions: { displacement } } }).settings.extensions.displacement, displacement);
  assert.throws(() => createConfiguration({ source, settings: { extensions: { displacement: { ...displacement, referenceFrame: 2 } } } }), /settings\.extensions\.displacement\.referenceFrame/);
  assert.equal(createConfiguration({ source, settings: { extensions: { displacement: { ...displacement, enabled: false, referenceFrame: 9 } } } }).settings.extensions.displacement.referenceFrame, 9);
  assert.throws(() => createConfiguration({ source, settings: { extensions: { vectors: { mode: 'displacement', enabled: false, referenceFrame: 2 } } } }), /settings\.extensions\.displacement\.referenceFrame/);
});

test('discovered vector sources retain their stable family key without enabling an absent analysis', () => {
  for (const mode of ['force', 'velocity', 'displacement', 'property:dipole', 'property:磁矩']) {
    const recipe = createConfiguration({ settings: { extensions: {
      vectors: { mode, enabled: false }, displacement: { enabled: false },
    } } });
    const restored = parseConfiguration(JSON.stringify(recipe));
    assert.equal(restored.settings.extensions.vectors.mode, mode);
    assert.equal(restored.settings.extensions.vectors.enabled, false);
    assert.equal(restored.settings.extensions.displacement.enabled, false);
    assert.deepEqual(restored.settings.extensions.vectors.components, [null, null, null]);
  }
  for (const mode of ['property:', 'property:  ', 'property:__proto__', 'property:constructor', 'unrecognized', `property:${'a'.repeat(250)}`]) {
    assert.throws(() => createConfiguration({ settings: { extensions: { vectors: { mode } } } }), /settings\.extensions\.vectors\.mode/);
  }
});

test('legacy atom-details tools migrate to Display while retaining selected atoms and measurements', () => {
  const recipe = createConfiguration({ settings: {
    activeTool: 'selection', selectedAtomId: 42,
    extensions: { measurements: { enabled: true, minimumImage: false, atomIds: [42, 43] } },
  } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.equal(restored.settings.activeTool, 'display');
  assert.equal(restored.settings.selectedAtomId, 42);
  assert.deepEqual(restored.settings.extensions.measurements, { enabled: true, minimumImage: false, atomIds: [42, 43] });
});

test('legacy configuration selection resolves outside Tools and old vector settings remain supported', () => {
  const recipe = createConfiguration({ settings: { activeTool: 'configuration', extensions: {
    vectors: { enabled: true, components: ['fx', 'fy', 'fz'], scale: 2, color: '#ffffff' },
  } } });
  assert.equal(recipe.settings.activeTool, null);
  assert.equal(recipe.settings.extensions.vectors.mode, 'generic');
  assert.deepEqual(recipe.settings.extensions.vectors.componentScales, [1, 1, 1]);
  assert.equal(recipe.settings.extensions.vectors.linkDimensions, true);
});

test('custom second-view orientations round-trip without claiming a fixed direction', () => {
  const comparison = { enabled: true, preset: 'custom', projectionMode: 'perspective', camera: {
    yaw: -.7, pitch: .3, target: [1, 2, 3], pan: [.1, .2, .3], distance: 10,
    orthographicScale: 5, projectionMode: 'perspective', roll: 0, fov: 40 * Math.PI / 180, constrainUp: true,
  } };
  const recipe = createConfiguration({ settings: { extensions: { comparison } } });
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.extensions.comparison, comparison);
});

test('floating second-view layouts round-trip portably and reject offscreen or invalid rectangles', () => {
  const layout = { left: .1, top: .2, width: .4, height: .5 };
  const recipe = createConfiguration({ settings: { extensions: { comparison: { enabled: true, layout } } } });
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.extensions.comparison.layout, layout);
  assert.equal(Object.hasOwn(createConfiguration().settings.extensions.comparison, 'layout'), false);
  for (const patch of [{ left: -.1 }, { top: Infinity }, { width: 0 }, { height: 1.1 },
    { left: .8 }, { top: .8 }, { width: '40%' }, { arbitrary: true }]) {
    const invalid = structuredClone(recipe);
    Object.assign(invalid.settings.extensions.comparison.layout, patch);
    assert.throws(() => parseConfiguration(JSON.stringify(invalid)), /comparison.layout/);
  }
});

test('new scalar schemes round-trip with fixed ranges and automatic ranges remain absent', () => {
  for (const scheme of ['magma', 'inferno', 'cividis', 'turbo', 'spectral']) {
    const colors = {
      schemes: [{ property: 'energy', scheme }, { property: 'coordination', scheme }],
      ranges: [{ property: 'energy', minimum: -2, maximum: 4 }],
      hideOutside: [], hiddenStructureTypes: [],
      hiddenAtomTypes: [], hiddenCategories: [],
    };
    const recipe = createConfiguration({ settings: { colors } });
    assert.deepEqual(recipe.settings.colors, colors);
    const restored = parseConfiguration(JSON.stringify(recipe));
    assert.deepEqual(restored.settings.colors, colors);
    assert.equal(restored.settings.colors.ranges.some(({ property }) => property === 'coordination'), false);
    assert.equal(restored.version, 1);
  }
  const invalid = createConfiguration();
  invalid.settings.colors.schemes = [{ property: 'energy', scheme: 'unrecognized' }];
  assert.throws(() => parseConfiguration(JSON.stringify(invalid)), /settings\.colors\.schemes\[0\]\.scheme/);
});

test('legend visibility recipes keep element labels and category IDs scoped to their property', () => {
  const colors = {
    hiddenAtomTypes: ['Ni', 'Type 4'],
    hiddenCategories: [
      { property: 'structureType', ids: [0, 2] },
      { property: 'ptmStructureType', ids: [1] },
      { property: 'phase', ids: [0] },
      { property: 'undefinedField', ids: ['NaN'] },
    ],
  };
  const recipe = createConfiguration({ settings: { colors } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored.settings.colors.hiddenAtomTypes, colors.hiddenAtomTypes);
  assert.deepEqual(restored.settings.colors.hiddenCategories, colors.hiddenCategories);
  assert.deepEqual(restored.settings.colors.hiddenStructureTypes, []);
  colors.hiddenAtomTypes.push('Fe');
  colors.hiddenCategories[0].ids.push(3);
  assert.deepEqual(restored.settings.colors.hiddenAtomTypes, ['Ni', 'Type 4']);
  assert.deepEqual(restored.settings.colors.hiddenCategories[0].ids, [0, 2]);
});

test('old version 1 visibility recipes remain valid without new legend filter fields', () => {
  const recipe = createConfiguration({ settings: { colors: { hiddenStructureTypes: [0, 3] } } });
  delete recipe.settings.colors.hiddenAtomTypes;
  delete recipe.settings.colors.hiddenCategories;
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored.settings.colors.hiddenStructureTypes, [0, 3]);
  assert.deepEqual(restored.settings.colors.hiddenAtomTypes, []);
  assert.deepEqual(restored.settings.colors.hiddenCategories, []);
  assert.equal(Object.hasOwn(restored.settings.colors, 'crystalVisibilitySource'), false);
});

test('independent crystal visibility restores its source while keeping classifier vocabularies separate', () => {
  const colors = {
    crystalVisibilitySource: 'dxaStructureType',
    hiddenCategories: [
      { property: 'dxaStructureType', ids: [3, 4] },
      { property: 'ptmStructureType', ids: [4, 6] },
    ],
  };
  const recipe = createConfiguration({ settings: {
    display: { colorMode: 'property:centralSymmetry' }, colors,
  } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.equal(restored.settings.display.colorMode, 'property:centralSymmetry');
  assert.equal(restored.settings.colors.crystalVisibilitySource, 'dxaStructureType');
  assert.deepEqual(restored.settings.colors.hiddenCategories, colors.hiddenCategories);
  for (const source of [null, 'structureType', 'ptmStructureType', 'centralSymmetryStructureType',
    'idealStrainStructureType', 'dxaStructureType']) {
    recipe.settings.colors.crystalVisibilitySource = source;
    assert.equal(parseConfiguration(JSON.stringify(recipe)).settings.colors.crystalVisibilitySource, source);
  }
  for (const source of ['centralSymmetry', 'phase', '__proto__', 3, false]) {
    recipe.settings.colors.crystalVisibilitySource = source;
    assert.throws(() => parseConfiguration(JSON.stringify(recipe)), /settings\.colors\.crystalVisibilitySource/);
  }
});

test('legend filter validation rejects duplicate or malformed choices before restoration', () => {
  const recipe = createConfiguration();
  for (const colors of [
    { hiddenAtomTypes: ['Ni', 'Ni'] },
    { hiddenAtomTypes: [3] },
    { hiddenAtomTypes: [''] },
    { hiddenCategories: [{ property: 'phase', ids: [1, 1] }] },
    { hiddenCategories: [{ property: 'phase', ids: [1.5] }] },
    { hiddenCategories: [{ property: 'phase', ids: [true] }] },
    { hiddenCategories: [{ property: 'phase', ids: [{}] }] },
    { hiddenCategories: [{ property: 'phase', ids: [] }, { property: 'phase', ids: [0] }] },
    { hiddenCategories: [{ property: '__proto__', ids: [0] }] },
  ]) {
    const malformed = structuredClone(recipe);
    Object.assign(malformed.settings.colors, colors);
    assert.throws(() => parseConfiguration(JSON.stringify(malformed)), /settings\.colors/);
  }
});

test('central symmetry recipes retain Auto and manual neighbor settings', () => {
  for (const mode of ['auto', 'manual']) {
    for (const neighbors of [8, 12]) {
      const settings = { enabled: true, mode, neighbors };
      const recipe = createConfiguration({ settings: { analyses: { centrosymmetry: settings } } });
      assert.deepEqual(recipe.settings.analyses.centrosymmetry, settings);
      assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.analyses.centrosymmetry, settings);
    }
  }
});

test('older version 1 central symmetry recipes restore manual neighbor counts', () => {
  for (const neighbors of [8, 12]) {
    const recipe = createConfiguration();
    recipe.settings.analyses.centrosymmetry = { enabled: true, neighbors };
    assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.analyses.centrosymmetry, {
      enabled: true, mode: 'manual', neighbors,
    });
  }
  const recipe = createConfiguration();
  delete recipe.settings.analyses.centrosymmetry;
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)).settings.analyses.centrosymmetry, {
    enabled: false, mode: 'auto', neighbors: 12,
  });
});

test('central symmetry recipes reject unknown modes and unsupported neighbor counts', () => {
  for (const invalid of [{ mode: 'hcp' }, { mode: 'Auto' }, { mode: 'auto', neighbors: 14 }, { mode: null }]) {
    const recipe = createConfiguration();
    recipe.settings.analyses.centrosymmetry = { enabled: true, neighbors: 12, ...invalid };
    assert.throws(() => parseConfiguration(JSON.stringify(recipe)), /settings\.analyses\.centrosymmetry/);
  }
});

test('unconfigured disabled lattice constants export as null but enabled strain needs valid references', () => {
  const snapshot = { settings: { analyses: {
    ptm: { enabled: false, flags: 0 },
    strain: { enabled: false, references: [{ element: '', structure: 2, a: NaN, c: NaN }] },
  } } };
  const recipe = createConfiguration(snapshot);
  assert.deepEqual(recipe.settings.analyses.strain.references, [{ element: '', structure: 2, a: null, c: null }]);
  assert.equal(recipe.settings.analyses.ptm.flags, 0);
  snapshot.settings.analyses.strain.enabled = true;
  assert.throws(() => createConfiguration(snapshot), /positive lattice constants/);
  assert.throws(() => createConfiguration({ settings: { analyses: { strain: { enabled: true } } } }), /required for enabled strain/);
  assert.throws(() => createConfiguration({ settings: { analyses: { ptm: { enabled: true, flags: 0 } } } }), /flags/);
});

test('source matching accepts reordered files and changing modification times with matching sizes', () => {
  const recipe = createConfiguration(fullSnapshot());
  const files = recipe.source.files.map(({ name, size, relativePath }) => ({ name, size, webkitRelativePath: relativePath, lastModified: 99999 }));
  assert.equal(matchesSource(recipe, files.toReversed(), 'lammps-dump'), true);
  assert.equal(matchesSource(recipe, files.toReversed().map(file => ({ file, relativePath: file.webkitRelativePath })), 'lammps-dump-sequence'), true);
  assert.equal(matchesSource(recipe, files, 'cfg'), false);
  assert.equal(matchesSource(recipe, files.slice(0, 1)), false);
  assert.equal(matchesSource(recipe, [{ ...files[0], size: files[0].size + 1 }, files[1]]), false);
  assert.equal(matchesSource(recipe, [{ ...files[0], name: 'unrelated.dump' }, files[1]]), false);
});

test('source matching uses directory paths to disambiguate equal basenames and sizes', () => {
  const recipe = createConfiguration({ source: { format: 'cfg-sequence', files: [
    { name: 'frame.cfg', relativePath: 'one/frame.cfg', size: 400 },
    { name: 'frame.cfg', relativePath: 'two/frame.cfg', size: 400 },
  ] } });
  assert.equal(matchesSource(recipe, [
    { name: 'frame.cfg', size: 400, webkitRelativePath: 'two/frame.cfg' },
    { name: 'frame.cfg', size: 400, webkitRelativePath: 'one/frame.cfg' },
  ], 'cfg'), true);
  assert.equal(matchesSource(recipe, [
    { name: 'frame.cfg', size: 400 }, { name: 'frame.cfg', size: 400 },
  ]), false);
  assert.equal(matchesSource(recipe, [
    { name: 'frame.cfg', size: 400, webkitRelativePath: 'two/frame.cfg' },
    { name: 'frame.cfg', size: 400 },
  ]), true);
  assert.equal(matchesSource(recipe, [
    { name: 'frame.cfg', size: 400, webkitRelativePath: 'wrong/frame.cfg' },
    { name: 'frame.cfg', size: 400, webkitRelativePath: 'one/frame.cfg' },
  ]), false);
});

test('a unique basename matches a manually reselected file without a directory path', () => {
  const recipe = createConfiguration({ source: { format: 'cfg', files: [{ name: 'structure.cfg', size: 300, relativePath: 'folder/structure.cfg' }] } });
  assert.equal(matchesSource(recipe, [{ name: 'structure.cfg', size: 300 }]), true);
  assert.equal(matchesSource(recipe, [{ file: { name: 'structure.cfg', size: 300 }, relativePath: 'folder\\structure.cfg' }]), true);
});

test('unrecognized versions, instructions and prototype keys are rejected before application', () => {
  const recipe = createConfiguration();
  for (const mutation of [
    value => { value.version = 2; },
    value => { value.app = 'Other'; },
    value => { value.settings.analyses.execute = { command: 'surprise' }; },
    value => { value.settings.camera = { position: [0, 0, 0] }; },
    value => { value.settings.constructor = { polluted: true }; },
    value => { value.settings.colors.ranges = [{ property: '__proto__', minimum: 0, maximum: 1 }]; },
  ]) {
    const mutated = structuredClone(recipe);
    mutation(mutated);
    assert.throws(() => parseConfiguration(JSON.stringify(mutated)), /Invalid AlloyView configuration/);
  }
  const prototypeJSON = JSON.stringify(recipe).replace('"settings":{', '"settings":{"__proto__":{"polluted":true},');
  assert.throws(() => parseConfiguration(prototypeJSON), /__proto__/);
  assert.equal({}.polluted, undefined);
});

test('invalid numeric and structured settings reject the entire recipe', () => {
  const recipe = createConfiguration(fullSnapshot());
  for (const mutation of [
    value => { value.settings.camera.distance = -1; },
    value => { value.settings.camera.target[1] = '2'; },
    value => { value.settings.camera.pitch = 5; },
    value => { value.settings.analyses.coordination.cutoff = null; },
    value => { value.settings.analyses.cna.cutoff = -1; },
    value => { value.settings.analyses.ptm.rmsdCutoff = '0.1'; },
    value => { value.settings.colors.ranges[0].maximum = value.settings.colors.ranges[0].minimum; },
    value => { value.settings.colors.hideOutside[0].hide = 'false'; },
    value => { value.settings.colors.hiddenStructureTypes = [0, 0]; },
    value => { value.settings.colors.schemes[0].scheme = 'unknown'; },
    value => { value.settings.replicate = [4096, 2, 1]; },
    value => { value.settings.replicate[0] = 1.5; },
    value => { value.settings.display.background = 'red'; },
    value => { value.settings.display.radiusPercent = 501; },
    value => { value.settings.display.showCell = 'false'; },
    value => { value.settings.theme = 'system'; },
    value => { value.settings.activeTool = 'arbitrary'; },
  ]) {
    const mutated = structuredClone(recipe);
    mutation(mutated);
    assert.throws(() => parseConfiguration(JSON.stringify(mutated)), /Invalid AlloyView configuration/);
  }
  assert.throws(() => parseConfiguration(JSON.stringify(recipe).replace('"distance":12', '"distance":1e1000')), /camera.distance/);
});

test('multi-plane validation enforces unit normals, unique string IDs, valid selection and renderer limit', () => {
  const recipe = createConfiguration(fullSnapshot());
  for (const mutation of [
    value => { value.settings.slices.items[0].normal = [0, 0, 0]; },
    value => { value.settings.slices.items[0].normal = [1, 1, 0]; },
    value => { value.settings.slices.items[0].id = 4; },
    value => { value.settings.slices.items[0].id = '  '; },
    value => { value.settings.slices.items[1].id = value.settings.slices.items[0].id; },
    value => { value.settings.slices.selectedId = 'missing-plane'; },
    value => { value.settings.slices.items[0].side = 'above'; },
    value => { value.settings.slices.items[0].showGizmo = 1; },
    value => { value.settings.slices.items[0].name = ''; },
    value => { value.settings.slices.items[0].name = '  '; },
    value => { value.settings.slices.items = Array.from({ length: MAX_CONFIGURATION_SLICES + 1 }, (_, index) => ({ ...value.settings.slices.items[0], id: `slice-${index}` })); },
  ]) {
    const mutated = structuredClone(recipe);
    mutation(mutated);
    assert.throws(() => parseConfiguration(JSON.stringify(mutated)), /Invalid AlloyView configuration/);
  }
  const roundoff = structuredClone(recipe);
  roundoff.settings.slices.items[0].normal = [0.60000000001, 0.80000000001, 0];
  const normal = parseConfiguration(JSON.stringify(roundoff)).settings.slices.items[0].normal;
  assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-14);
  roundoff.settings.slices.selectedId = null;
  assert.equal(parseConfiguration(JSON.stringify(roundoff)).settings.slices.selectedId, null);
});

test('slab, sweep step, Miller indices and outline options round-trip and older planes keep their meaning', () => {
  const snapshot = fullSnapshot();
  Object.assign(snapshot.settings.slices.items[0], { slab: true, thickness: 2.0784609690826525, step: 2.0784609690826525, miller: [1, -1, 1] });
  Object.assign(snapshot.settings.slices, { showOutlines: true, exportOutlines: false });
  const recipe = createConfiguration(snapshot);
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored, recipe);
  assert.deepEqual(restored.settings.slices.items[0], { ...snapshot.settings.slices.items[0] });
  assert.deepEqual([restored.settings.slices.showOutlines, restored.settings.slices.exportOutlines], [true, false]);

  // A recipe saved before these fields existed: half-spaces, 1 Å steps, no outlines.
  const legacy = parseConfiguration(JSON.stringify(createConfiguration(fullSnapshot())));
  for (const [index, item] of fullSnapshot().settings.slices.items.entries()) {
    assert.deepEqual(legacy.settings.slices.items[index], { ...item, slab: false, thickness: 2, step: 1, miller: null });
  }
  assert.deepEqual([legacy.settings.slices.showOutlines, legacy.settings.slices.exportOutlines], [false, true]);

  for (const mutation of [
    value => { value.settings.slices.items[0].slab = 'true'; },
    value => { value.settings.slices.items[0].thickness = 0; },
    value => { value.settings.slices.items[0].thickness = -2; },
    value => { value.settings.slices.items[0].step = '1'; },
    value => { value.settings.slices.items[0].step = 1e-9; },
    value => { value.settings.slices.items[0].miller = [0, 0, 0]; },
    value => { value.settings.slices.items[0].miller = [1, 1.5, 0]; },
    value => { value.settings.slices.items[0].miller = [1, 1]; },
    value => { value.settings.slices.items[0].miller = [2e6, 0, 0]; },
    value => { value.settings.slices.items[0].miller = '111'; },
    value => { value.settings.slices.items[0].uvw = [1, 1, 1]; },
    value => { value.settings.slices.showOutlines = 1; },
    value => { value.settings.slices.exportOutlines = 'no'; },
  ]) {
    const mutated = structuredClone(recipe);
    mutation(mutated);
    assert.throws(() => parseConfiguration(JSON.stringify(mutated)), /Invalid AlloyView configuration/);
  }
});

test('source metadata rejects invalid frame bounds, absolute paths and path traversal', () => {
  const recipe = createConfiguration(fullSnapshot());
  for (const mutation of [
    value => { value.source.frameIndex = value.source.frameCount; },
    value => { value.source.frameIndex = -1; },
    value => { value.source.files = []; },
    value => { value.source.files[0].size = -1; },
    value => { value.source.files[0].name = 'folder/file.dump'; },
    value => { value.source.files[0].relativePath = '../frame.0.dump'; },
    value => { value.source.files[0].relativePath = '/frame.0.dump'; },
    value => { value.source.files[0].relativePath = 'C:\\frame.0.dump'; },
    value => { value.source.files[0].relativePath = 'folder/wrong.dump'; },
    value => { value.source.files[1] = { ...value.source.files[0] }; },
    value => { value.source.kind = 'file'; },
    value => { value.source.format = 'javascript'; },
  ]) {
    const mutated = structuredClone(recipe);
    mutation(mutated);
    assert.throws(() => parseConfiguration(JSON.stringify(mutated)), /Invalid AlloyView configuration/);
  }
});

test('malformed and oversized JSON including multibyte content cannot reach restore', () => {
  assert.throws(() => parseConfiguration('{'), /invalid JSON/);
  assert.throws(() => parseConfiguration(null), /JSON text/);
  assert.throws(() => parseConfiguration(' '.repeat(MAX_CONFIGURATION_BYTES + 1)), /too large/);
  assert.throws(() => parseConfiguration('"' + '界'.repeat(Math.floor(MAX_CONFIGURATION_BYTES / 3) + 1) + '"'), /too large/);
  assert.throws(() => parseConfiguration('{"app":"AlloyView","version":1,"exportedAt":"2026-10-03T10:00:00Z"}'), /source is missing/);
  const recipe = createConfiguration();
  recipe.exportedAt = 'not a timestamp';
  assert.throws(() => parseConfiguration(JSON.stringify(recipe)), /ISO timestamp/);
});

test('recipe downloads validate before creating browser URLs and contain no source data', (t) => {
  const recipe = createConfiguration(fullSnapshot());
  let downloadedBlob;
  let clicked = false;
  let removed = false;
  let cleanup;
  const anchor = { click() { clicked = true; }, remove() { removed = true; } };
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => anchor, body: { append: element => assert.equal(element, anchor) } };
  t.after(() => { globalThis.document = oldDocument; });
  t.mock.method(URL, 'createObjectURL', blob => { downloadedBlob = blob; return 'blob:configuration'; });
  const revoke = t.mock.method(URL, 'revokeObjectURL');
  t.mock.method(globalThis, 'setTimeout', callback => { cleanup = callback; });
  const validated = downloadConfiguration(recipe, 'folder/recipe.json');
  assert.equal(anchor.href, 'blob:configuration');
  assert.equal(anchor.download, 'folder_recipe.json');
  assert.equal(downloadedBlob.type, 'application/json');
  assert.equal(clicked, true);
  assert.equal(removed, true);
  assert.deepEqual(validated, recipe);
  assert.equal(revoke.mock.callCount(), 0);
  cleanup();
  assert.equal(revoke.mock.calls[0].arguments[0], 'blob:configuration');
  recipe.settings.analyses.unknown = {};
  assert.throws(() => downloadConfiguration(recipe), /not a supported setting/);
  assert.equal(URL.createObjectURL.mock.callCount(), 1);
});

test('bond statistics and Voronoi recipes restore independent analysis settings without cached atom data', () => {
  const extensions = extensionSnapshot();
  extensions.bonds.enabled = false;
  extensions.bondStatistics = { enabled: true, lengthBins: 80, angleBins: 120 };
  extensions.voronoi = { enabled: true, faceAreaThreshold: .02, relativeFaceAreaThreshold: .001, bins: 75 };
  const recipe = createConfiguration({ settings: { extensions, activeTool: 'voronoi',
    display: { colorMode: 'property:atomicVolume' } } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored, recipe);
  assert.equal(restored.settings.activeTool, 'voronoi');
  assert.equal(restored.settings.extensions.bonds.enabled, false);
  assert.deepEqual(restored.settings.extensions.bondStatistics, extensions.bondStatistics);
  assert.deepEqual(restored.settings.extensions.voronoi, { ...extensions.voronoi, selectedTypes: null });
  assert.equal(restored.settings.extensions.bonds.cutoff, extensions.bonds.cutoff);
  const defaults = createConfiguration({ settings: { extensions: { bondStatistics: {}, voronoi: {} } } });
  assert.deepEqual(defaults.settings.extensions.bondStatistics, { enabled: false, lengthBins: 100, angleBins: 180 });
  assert.deepEqual(defaults.settings.extensions.voronoi, { enabled: false, faceAreaThreshold: 0, relativeFaceAreaThreshold: 0, bins: 50, selectedTypes: null });
  const legacy = createConfiguration();
  assert.equal(Object.hasOwn(legacy.settings.extensions, 'bondStatistics'), false);
  assert.equal(Object.hasOwn(legacy.settings.extensions, 'voronoi'), false);
});

test('Voronoi recipes preserve type labels and independent selected/all-cell display without geometry payloads', () => {
  const recipe = createConfiguration({ settings: { extensions: {
    voronoi: { enabled: true, selectedTypes: ['Ni', 'Cu', 'Ni'] },
    voronoiDisplay: { enabled: false, allEnabled: true, color: '#123456', opacity: .3 },
  } } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored.settings.extensions.voronoi.selectedTypes, ['Cu', 'Ni']);
  assert.deepEqual(restored.settings.extensions.voronoiDisplay, { enabled: false, allEnabled: true, color: '#123456', opacity: .3, style: 'xray', scale: 1 }, 'older recipes default to the see-through view at true cell size');
  const old = createConfiguration({ settings: { extensions: { voronoi: {}, voronoiDisplay: {} } } });
  assert.equal(old.settings.extensions.voronoi.selectedTypes, null);
  assert.equal(old.settings.extensions.voronoiDisplay.allEnabled, false);
  for (const patch of [{ allEnabled: 'yes' }, { chunks: [] }]) {
    const invalid = structuredClone(recipe); Object.assign(invalid.settings.extensions.voronoiDisplay, patch);
    assert.throws(() => parseConfiguration(JSON.stringify(invalid)), /voronoiDisplay/);
  }
});

test('radical Voronoi recipes round-trip validated radii while older recipes keep their shape', () => {
  const voronoi = { enabled: true, faceAreaThreshold: 0, relativeFaceAreaThreshold: 0, bins: 50, selectedTypes: null,
    radical: true, radiusSource: 'types', typeRadii: [{ label: 'Zr', radius: 1.6 }, { label: 'Cu', radius: 1.28 }, { label: 'H', radius: 0 }],
    radiusProperty: 'radius' };
  const recipe = createConfiguration({ settings: { extensions: { voronoi } } });
  assert.deepEqual(recipe.settings.extensions.voronoi.typeRadii, [{ label: 'Cu', radius: 1.28 }, { label: 'H', radius: 0 }, { label: 'Zr', radius: 1.6 }]);
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)), recipe);
  const property = createConfiguration({ settings: { extensions: { voronoi: { enabled: true, radical: true, radiusSource: 'property' } } } });
  assert.deepEqual(property.settings.extensions.voronoi, { enabled: true, faceAreaThreshold: 0, relativeFaceAreaThreshold: 0, bins: 50,
    selectedTypes: null, radical: true, radiusSource: 'property', typeRadii: [], radiusProperty: null });
  const older = createConfiguration({ settings: { extensions: { voronoi: { enabled: true, bins: 20 } } } });
  assert.equal(Object.hasOwn(older.settings.extensions.voronoi, 'radical'), false, 'recipes without radii remain standard Voronoi');
  for (const mutate of [
    value => { value.radical = 'yes'; },
    value => { value.radiusSource = 'mass'; },
    value => { value.typeRadii = [{ label: 'Cu', radius: -1 }]; },
    value => { value.typeRadii = [{ label: 'Cu', radius: '1.2' }]; },
    value => { value.typeRadii = [{ label: 'Cu', radius: 1 }, { label: 'Cu', radius: 2 }]; },
    value => { value.typeRadii = [{ label: '', radius: 1 }]; },
    value => { value.typeRadii = [{ label: 'Cu', radius: 1, color: 'red' }]; },
    value => { value.typeRadii = { Cu: 1 }; },
    value => { value.radiusProperty = '__proto__'; },
    value => { value.radiusProperty = 7; },
  ]) {
    const invalid = structuredClone(recipe);
    mutate(invalid.settings.extensions.voronoi);
    assert.throws(() => parseConfiguration(JSON.stringify(invalid)), /Invalid AlloyView configuration: settings\.extensions\.voronoi/);
  }
  const infinite = JSON.stringify(recipe).replace('"radius":1.6', '"radius":1e400');
  assert.throws(() => parseConfiguration(infinite), /typeRadii\[2\]\.radius/);
});

test('topology recipes reject invalid histograms, face filters and missing shared bond cutoff before restore', () => {
  const recipe = createConfiguration({ settings: { extensions: {
    bonds: { cutoff: 3 }, bondStatistics: { enabled: true }, voronoi: { enabled: true },
  } } });
  for (const mutate of [
    value => { value.bonds.cutoff = null; },
    value => { value.bondStatistics.lengthBins = 0; },
    value => { value.bondStatistics.angleBins = 4097; },
    value => { value.bondStatistics.angleBins = 1.5; },
    value => { value.bondStatistics.enabled = 1; },
    value => { value.bondStatistics.q6 = [1, 2]; },
    value => { value.voronoi.faceAreaThreshold = -1; },
    value => { value.voronoi.relativeFaceAreaThreshold = 1.01; },
    value => { value.voronoi.bins = 1.2; },
    value => { value.voronoi.atomicVolume = [1, 2]; },
    value => { value.voronoi.selectedTypes = 'Ni'; },
    value => { value.voronoi.selectedTypes = [0]; },
    value => { value.voronoi.selectedTypes = ['']; },
    value => { value.voronoi.selectedTypes = ['Ni\u0000']; },
  ]) {
    const invalid = structuredClone(recipe);
    mutate(invalid.settings.extensions);
    assert.throws(() => parseConfiguration(JSON.stringify(invalid)), /Invalid AlloyView configuration/);
  }
});

function fullSnapshot() {
  return {
    exportedAt: '2026-10-03T10:00:00.000Z',
    source: {
      kind: 'sequence', label: 'frame.{number}.dump', format: 'lammps-dump-sequence', frameIndex: 4, frameCount: 10,
      files: [
        { name: 'frame.0.dump', relativePath: 'folder/frame.0.dump', size: 1234, lastModified: 1000 },
        { name: 'frame.1.dump', relativePath: 'folder/frame.1.dump', size: 2345, lastModified: 1001 },
      ],
    },
    settings: {
      display: {
        coordinateMode: 'unwrapped', colorMode: 'property:atomicShearStrain', radiusPercent: 500,
        background: '#FFFFFF', showCell: false, showAxes: false,
        png: { background: false, legend: false, axes: true }, projectionMode: 'orthographic',
      },
      analyses: {
        coordination: { enabled: true, cutoff: 3.1 },
        cna: { enabled: true, mode: 'fixed', cutoff: 3.3 },
        centrosymmetry: { enabled: true, mode: 'manual', neighbors: 8 },
        ptm: { enabled: true, flags: 7, rmsdCutoff: 0.12 },
        strain: { enabled: true, references: [
          { label: 'Cu', element: 'Cu', structure: 1, a: 3.61 },
          { label: 'Ti', element: 'Ti', structure: 2, a: 2.95, c: 4.6846 },
        ] },
      },
      replicate: [2, 3, 1],
      slices: {
        items: [
          { id: 'slice-0', name: 'Defect plane', normal: [0.6, 0.8, 0], position: -3.2, enabled: true, side: 'positive', showGizmo: true },
          { id: 'slice-1', name: 'Upper surface', normal: [0, 0, 1], position: 4.5, enabled: false, side: 'negative', showGizmo: false },
        ], selectedId: 'slice-1', showGizmo: true,
      },
      colors: {
        ranges: [{ property: 'atomicShearStrain', minimum: 0.01, maximum: 0.2 }],
        schemes: [{ property: 'atomicShearStrain', scheme: 'viridis' }],
        hideOutside: [{ property: 'atomicShearStrain', hide: false }],
        hiddenStructureTypes: [0, 2],
        hiddenAtomTypes: ['Cu'],
        hiddenCategories: [{ property: 'phase', ids: [1, 2] }],
      },
      camera: { yaw: 0.42, pitch: 0.38, target: [1, 2, 3], pan: [0.4, 0, -0.3], distance: 12, orthographicScale: 5, projectionMode: 'orthographic' },
      activeTool: 'slice', selectedAtomId: 43, theme: 'light',
    },
  };
}

test('trajectory recipes round-trip smoothing and line settings; older recipes omit them', () => {
  const snapshot = fullSnapshot();
  snapshot.settings.selectionGroups = { groups: [{ id: 'solutes', name: 'Solutes', color: '#22c1c3', visible: true, atomIds: [3, 'X7'] }], selectedGroupId: null };
  snapshot.settings.activeTool = 'trajectory';
  delete snapshot.settings.activeCategory;
  snapshot.settings.extensions = { trajectory: {
    smoothing: { enabled: true, window: 4 },
    lines: { enabled: true, source: 'group', selectionGroupId: 'solutes', atomIds: [], firstFrame: 1, lastFrame: 9, stride: 2,
      visible: false, color: '#AA3300', width: 3.5, colorByTime: true, colorScheme: 'magma' },
  } };
  const recipe = createConfiguration(snapshot);
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored, recipe);
  assert.equal(restored.settings.activeCategory, 'modification');
  assert.deepEqual(restored.settings.extensions.trajectory, { smoothing: { enabled: true, window: 4 },
    lines: { enabled: true, source: 'group', selectionGroupId: 'solutes', atomIds: [], firstFrame: 1, lastFrame: 9, stride: 2,
      visible: false, color: '#aa3300', width: 3.5, colorByTime: true, colorScheme: 'magma' } });
  const explicit = createConfiguration({ ...snapshot, settings: { ...snapshot.settings, extensions: { trajectory: {
    lines: { enabled: true, atomIds: [5, -2, 'Fe12'], lastFrame: null } } } } });
  assert.deepEqual(explicit.settings.extensions.trajectory, { smoothing: { enabled: false, window: 2 },
    lines: { enabled: true, source: 'ids', selectionGroupId: null, atomIds: [5, -2, 'Fe12'], firstFrame: 0, lastFrame: null, stride: 1,
      visible: true, color: '#ff9f1c', width: 2, colorByTime: false, colorScheme: 'viridis' } });
  assert.equal(Object.hasOwn(createConfiguration().settings.extensions, 'trajectory'), false);
});

test('trajectory recipes are validated before restoration', () => {
  const recipe = createConfiguration(fullSnapshot());
  const invalid = trajectory => {
    const copy = structuredClone(recipe);
    copy.settings.extensions.trajectory = trajectory;
    return () => parseConfiguration(JSON.stringify(copy));
  };
  assert.throws(invalid({ smoothing: { enabled: true, window: 0 } }), /smoothing\.window/);
  assert.throws(invalid({ smoothing: { enabled: true, window: 51 } }), /smoothing\.window/);
  assert.throws(invalid({ smoothing: { enabled: 'yes' } }), /smoothing\.enabled/);
  assert.throws(invalid({ smoothing: { code: 'x' } }), /smoothing\.code is not a supported setting/);
  assert.throws(invalid({ lines: { enabled: true, atomIds: [] } }), /must list atoms/);
  assert.throws(invalid({ lines: { atomIds: [1, 1] } }), /contains duplicates/);
  assert.throws(invalid({ lines: { atomIds: Array.from({ length: 100_001 }, (_, index) => index) } }), /atomIds must contain 0–100000 entries/);
  assert.throws(invalid({ lines: { atomIds: '1 2 3' } }), /atomIds must contain/);
  assert.throws(invalid({ lines: { source: 'group' } }), /selectionGroupId is required/);
  assert.throws(invalid({ lines: { source: 'group', selectionGroupId: 'missing' } }), /must identify a saved selection group/);
  assert.throws(invalid({ lines: { firstFrame: 5, lastFrame: 4 } }), /must not precede/);
  assert.throws(invalid({ lines: { enabled: true, atomIds: [1], firstFrame: 10 } }), /smaller than the source frame count/);
  assert.throws(invalid({ lines: { stride: 0 } }), /stride/);
  assert.throws(invalid({ lines: { width: 20 } }), /width/);
  assert.throws(invalid({ lines: { color: 'red' } }), /color/);
  assert.throws(invalid({ lines: { colorScheme: 'rainbow' } }), /colorScheme/);
  // Disabled lines may keep frames beyond a shorter source for later reuse.
  assert.doesNotThrow(invalid({ lines: { enabled: false, atomIds: [1], firstFrame: 10 } }));
});
