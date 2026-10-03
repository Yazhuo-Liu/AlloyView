import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConfiguration,
  downloadConfiguration,
  matchesSource,
  MAX_CONFIGURATION_BYTES,
  MAX_CONFIGURATION_SLICES,
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
  assert.deepEqual(recipe.settings.analyses.centrosymmetry, { enabled: false, mode: 'auto', neighbors: 12 });
  assert.equal(matchesSource(recipe, []), true);
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)), recipe);
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
      },
      camera: { yaw: 0.42, pitch: 0.38, target: [1, 2, 3], pan: [0.4, 0, -0.3], distance: 12, orthographicScale: 5, projectionMode: 'orthographic' },
      activeTool: 'slice', selectedAtomId: 43, theme: 'light',
    },
  };
}
