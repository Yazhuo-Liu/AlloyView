import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppearanceSnapshots, createDisplayDependencyTracker, displayDependencyStamp,
  sameDisplayDependencies } from '../src/render/appearance-snapshot.js';

const context = { sourceKey: 1, processingKey: 'plain', settingsKey: 'CNA:hiddenFCC', colorMode: 'property:structureType' };
const frame = (ids, extra = {}) => ({ ids: Uint32Array.from(ids), idSource: 'explicit', types: new Uint16Array(ids.length),
  typeLabels: ['Cu'], properties: [], ...extra });
function completed(cache, { target = frame([1, 2, 3]), frameIndex = 0, settings = context } = {}) {
  const property = { name: 'structureType', displayName: 'CNA', data: Uint8Array.of(1, 3, 1),
    categories: [{ id: 1, label: 'FCC', color: [1, 2, 3] }, { id: 3, label: 'BCC', color: [4, 5, 6] }] };
  const palette = { colors: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
    legend: { kind: 'types', title: 'CNA', property, atomCount: 3,
      items: property.categories.map((item, index) => ({ ...item, count: index === 0 ? 2 : 1, visible: index !== 0 })) } };
  const visibility = Uint8Array.of(0, 255, 0), radii = Float32Array.of(.5, .7, .9);
  const snapshot = cache.capture({ frame: target, frameIndex, palette, visibility, radii, context: settings });
  return { snapshot, target, property, palette, visibility, radii };
}
function preview(cache, target, extra = {}) {
  return cache.preview({ frame: target, frameIndex: 9, context,
    fallbackPalette: { colors: new Uint8Array(target.ids.length * 3).fill(200) },
    fallbackVisibility: new Uint8Array(target.ids.length).fill(255),
    fallbackRadii: new Float32Array(target.ids.length).fill(1.5), ...extra });
}

test('preview maps old colors, hidden categories, radii and counts by ID without publishing properties', () => {
  const cache = createAppearanceSnapshots();
  completed(cache);
  const target = frame([3, 1, 2]);
  const before = target.properties.slice(), result = preview(cache, target);
  assert.equal(result.preview, true); assert.equal(result.reliable, true);
  assert.deepEqual(Array.from(result.mapping), [2, 0, 1]);
  assert.deepEqual(Array.from(result.palette.colors), [7, 8, 9, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(result.visibility), [0, 0, 255]);
  assert.deepEqual(Array.from(result.radii), Array.from(Float32Array.of(.9, .5, .7)));
  assert.deepEqual(Array.from(result.palette.legend.property.data), [1, 1, 3]);
  assert.deepEqual(result.palette.legend.items.map(item => item.count), [2, 1]);
  assert.equal(result.sourceFrameIndex, 0); assert.equal(result.targetFrameIndex, 9);
  assert.deepEqual(target.properties, before);
});

test('unchanged explicit identity reuses detached appearance buffers without per-frame RGB/property copies', () => {
  const cache = createAppearanceSnapshots(), saved = completed(cache);
  const first = preview(cache, frame([1, 2, 3])), second = preview(cache, frame([1, 2, 3]));
  assert.equal(first.palette.colors, saved.snapshot.palette.colors);
  assert.equal(second.palette.colors, first.palette.colors);
  assert.equal(second.visibility, first.visibility);
  assert.equal(second.palette.legend.property.data, saved.snapshot.palette.legend.property.data);
  assert.notEqual(second.palette.legend.property, saved.property, 'formal frame property is never adopted');
  assert.equal(second.palette.legend.property.preview, true);
  assert.deepEqual(Array.from(second.mapping), [0, 1, 2]);
});

test('insertions and removals keep current defaults for unmatched IDs and report pending counts', () => {
  const cache = createAppearanceSnapshots(); completed(cache);
  const result = preview(cache, frame([2, 4]));
  assert.deepEqual(Array.from(result.mapping), [1, -1]);
  assert.deepEqual(Array.from(result.palette.colors), [4, 5, 6, 200, 200, 200]);
  assert.deepEqual(Array.from(result.visibility), [255, 255]);
  assert.deepEqual(Array.from(result.radii), Array.from(Float32Array.of(.7, 1.5)));
  assert.deepEqual(Array.from(result.palette.legend.property.data), [3, NaN]);
  assert.deepEqual(result.palette.legend.items.map(item => item.count), [0, 1]);
  assert.equal(result.palette.legend.pendingCount, 1); assert.equal(result.palette.legend.atomCount, 2);
  assert.equal(result.unmatchedCount, 1); assert.equal(result.matchedCount, 1);
  assert.equal(preview(cache, frame([4, 5])), null, 'unrelated identities do not receive a stale display');
});

test('changed species and absent current radius defaults never inherit an invented radius', () => {
  const cache = createAppearanceSnapshots(); completed(cache);
  const target = frame([1, 2], { types: Uint16Array.of(1, 0), typeLabels: ['Cu', 'Ni'] });
  const result = preview(cache, target, { fallbackRadii: null });
  assert.deepEqual(Array.from(result.mapping), [-1, 1]);
  assert.deepEqual(Array.from(result.palette.colors), [200, 200, 200, 4, 5, 6]);
  assert.equal(result.radii, null);
});

test('snapshot detaches IDs, colors, masks, radii and legend data from later caller mutation', () => {
  const cache = createAppearanceSnapshots(), saved = completed(cache);
  saved.target.ids[0] = 99; saved.palette.colors.fill(0); saved.visibility.fill(255); saved.radii.fill(5);
  saved.property.data.fill(9); saved.palette.legend.items[0].label = 'changed';
  const result = preview(cache, frame([1, 2]));
  assert.deepEqual(Array.from(result.palette.colors), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(result.visibility), [0, 255]);
  assert.deepEqual(Array.from(result.palette.legend.property.data), [1, 3]);
  assert.equal(result.palette.legend.items[0].label, 'FCC');
  assert.equal(result.radii[0], .5);
});

test('context changes and generated IDs reject previews rather than matching by row', () => {
  const cache = createAppearanceSnapshots(); completed(cache);
  for (const key of Object.keys(context)) assert.equal(preview(cache, frame([1, 2]), { context: { ...context, [key]: 'different' } }), null, key);
  assert.equal(preview(cache, frame([1, 2], { idSource: 'row-order' })), null);
  assert.equal(preview(cache, frame([1, 2], { idSource: undefined })), null);
  assert.equal(preview(cache, frame([1, 2]), { context: { ...context, sourceKey: undefined } }), null);
  assert.equal(completed(cache, { target: frame([1, 2, 3], { idSource: 'row-order' }) }).snapshot, null);
});

test('duplicate and malformed IDs fail closed, including numeric/text aliases', () => {
  const cache = createAppearanceSnapshots(); completed(cache);
  for (const ids of [[1, 1], [1, '1'], [Infinity, 2], ['a\n', 'b'], ['', 'b'], [NaN, 2]]) {
    assert.equal(preview(cache, frame(ids, { ids })), null, JSON.stringify(ids));
  }
  const duplicateSource = completed(cache, { target: frame([1, 1, 3]) });
  assert.equal(duplicateSource.snapshot, null);
});

test('compound replicated IDs retain unique image identity', () => {
  const cache = createAppearanceSnapshots();
  const ids = [1, '@AlloyView:copy:1:0:0:1', '@AlloyView:copy:2:0:0:1'];
  completed(cache, { target: frame(ids, { ids, physicalReplication: { repetitions: [3, 1, 1] } }) });
  const result = preview(cache, frame(ids, { ids: [ids[2], ids[0], ids[1]] }));
  assert.deepEqual(Array.from(result.mapping), [2, 0, 1]);
  assert.deepEqual(Array.from(result.visibility), [0, 0, 255]);
});

test('numeric text IDs follow existing atom ID semantics and sparse IDs work', () => {
  const cache = createAppearanceSnapshots();
  completed(cache, { target: frame([1, 2_000_000_000, 3]) });
  assert.deepEqual(Array.from(preview(cache, frame([1, 3], { ids: ['1', '3'] })).mapping), [0, 2]);
  assert.equal(preview(cache, frame([1], { ids: ['01'] })), null);
});

test('scalar preview keeps source range and maps values to a separate display-only property', () => {
  const cache = createAppearanceSnapshots(), target = frame([1, 2]);
  const property = { name: 'energy', unit: 'eV', data: Float64Array.of(1, 4) };
  cache.capture({ frame: target, frameIndex: 2, context, palette: { colors: Uint8Array.of(1, 2, 3, 4, 5, 6),
    legend: { kind: 'scalar', title: 'Energy', property, minimum: 0, maximum: 5, scheme: 'viridis' } } });
  const next = frame([2, 3, 1]), result = preview(cache, next);
  assert.equal(result.palette.legend.minimum, 0); assert.equal(result.palette.legend.maximum, 5);
  assert.deepEqual(Array.from(result.palette.legend.property.data), [4, NaN, 1]);
  assert.equal(result.palette.legend.property.preview, true);
  assert.notEqual(result.palette.legend.property, property);
  assert.deepEqual(next.properties, []);
});

test('orientation palettes without a scalar property also preserve display-only metadata', () => {
  const cache = createAppearanceSnapshots(), target = frame([1, 2]);
  cache.capture({ frame: target, context, palette: { colors: Uint8Array.of(1, 2, 3, 4, 5, 6),
    legend: { kind: 'orientation', title: 'IPF', keys: [{ title: 'cubic', labels: ['001'] }], undefinedCount: 0 } } });
  const result = preview(cache, frame([2, 1]));
  assert.equal(result.palette.legend.kind, 'orientation');
  assert.deepEqual(result.palette.legend.keys[0].labels, ['001']);
  assert.equal(result.palette.legend.preview, true);
});

test('byte and entry bounds evict old snapshots and never promote a preview to completed data', () => {
  const measure = createAppearanceSnapshots(), bytes = completed(measure).snapshot.bytes;
  const cache = createAppearanceSnapshots({ maxBytes: bytes * 2, maxEntries: 2 });
  completed(cache, { settings: { ...context, sourceKey: 0 } }); completed(cache);
  completed(cache, { settings: { ...context, sourceKey: 2 } });
  assert.equal(cache.stats.entries, 2); assert.ok(cache.stats.bytes <= cache.stats.maxBytes);
  assert.equal(preview(cache, frame([1]), { context: { ...context, sourceKey: 0 } }), null);
  assert.ok(preview(cache, frame([1])));
  const transient = preview(cache, frame([1, 2]));
  assert.equal(cache.capture({ frame: frame([1, 2]), context, palette: transient.palette }), null);
  assert.equal(completed(createAppearanceSnapshots({ maxBytes: bytes - 1 })).snapshot, null);
  cache.clear(); assert.deepEqual(cache.stats, { entries: 0, bytes: 0, maxBytes: bytes * 2, maxEntries: 2 });
});

test('recapturing the same frame/settings replaces its saved appearance', () => {
  const cache = createAppearanceSnapshots(); completed(cache); completed(cache);
  assert.equal(cache.stats.entries, 1);
  assert.equal(completed(createAppearanceSnapshots({ maxBytes: 0 })).snapshot, null);
  assert.equal(completed(createAppearanceSnapshots({ maxEntries: 0 })).snapshot, null);
});

test('display dependency stamps ignore unrelated properties and follow selected values/settings', () => {
  const tracker = createDisplayDependencyTracker(), target = frame([1, 2]);
  const property = { name: 'structureType', data: Uint8Array.of(1, 3), categories: [] };
  const inputs = { frame: target, colorMode: 'property:structureType', property, settingsKey: 'hide:1' };
  assert.equal(tracker.changed(inputs), true);
  target.properties.push({ name: 'centralSymmetry', data: Float32Array.of(0, 1) });
  assert.equal(tracker.changed(inputs), false);
  assert.equal(tracker.changed({ ...inputs, settingsKey: 'hide:1,3' }), true);
  assert.equal(tracker.changed({ ...inputs, property: { ...property, data: Uint8Array.of(1, 2) } }), true);
  tracker.clear(); assert.equal(tracker.changed(inputs), true);
  const a = displayDependencyStamp(inputs);
  assert.equal(sameDisplayDependencies(a, displayDependencyStamp(inputs)), true);
  assert.equal(sameDisplayDependencies(a, displayDependencyStamp({ ...inputs, orientationInputs: [property.data] })), false);
});

function largeAppearance(count = 20_000, settings = context) {
  const target = frame([], { ids: Uint32Array.from({ length: count }, (_, index) => index + 1), types: new Uint16Array(count) });
  const property = { name: 'energy', unit: 'eV', data: Float32Array.from(target.ids, id => id / 100) };
  return { frame: target, context: settings, frameIndex: 0, visibility: new Uint8Array(count).fill(255),
    palette: { colors: new Uint8Array(count * 3).fill(70), legend: { kind: 'scalar', title: 'Energy', property, minimum: 0, maximum: 200 } } };
}

test('time-sliced capture and preview match synchronous mapping exactly', async () => {
  const cache = createAppearanceSnapshots(), saved = largeAppearance();
  let yields = 0;
  const options = { budgetMs: 0, yieldTask: async () => { yields++; } };
  assert.ok(await cache.captureAsync(saved, options));
  const target = { ...saved.frame, ids: saved.frame.ids.slice().reverse() };
  const args = { frame: target, frameIndex: 1, context, fallbackPalette: saved.palette };
  const actual = await cache.previewAsync(args, options), expected = cache.preview(args);
  assert.ok(yields > 10, 'long preparation yields between chunks');
  assert.deepEqual(actual.mapping, expected.mapping);
  assert.deepEqual(actual.palette, expected.palette);
  assert.deepEqual(actual.visibility, expected.visibility);
});

test('timer cancellation interrupts async preparation and leaves no partial saved snapshot', async () => {
  const cache = createAppearanceSnapshots(), saved = largeAppearance(), controller = new AbortController();
  const prepared = cache.captureAsync(saved, { signal: controller.signal, budgetMs: 0,
    yieldTask: () => new Promise(resolve => setTimeout(resolve, 0)) });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(prepared, { name: 'AbortError' });
  assert.equal(cache.stats.entries, 0);
  assert.ok(cache.capture(saved));
  const previewController = new AbortController();
  const output = cache.previewAsync({ frame: saved.frame, context, fallbackPalette: saved.palette },
    { signal: previewController.signal, budgetMs: 0, yieldTask: () => new Promise(resolve => setTimeout(resolve, 0)) });
  setTimeout(() => previewController.abort(), 0);
  await assert.rejects(output, { name: 'AbortError' });
  assert.equal(cache.stats.entries, 1);
});

test('clear invalidates in-flight async captures and previews', async () => {
  const cache = createAppearanceSnapshots(), saved = largeAppearance();
  let cleared = false;
  const result = await cache.captureAsync(saved, { budgetMs: 0, yieldTask: async () => {
    if (!cleared) { cleared = true; cache.clear(); }
  } });
  assert.equal(result, null); assert.equal(cache.stats.entries, 0);
  cache.capture(saved); cleared = false;
  const output = await cache.previewAsync({ frame: saved.frame, context, fallbackPalette: saved.palette },
    { budgetMs: 0, yieldTask: async () => { if (!cleared) { cleared = true; cache.clear(); } } });
  assert.equal(output, null); assert.equal(cache.stats.entries, 0);
});

test('late async completion cannot overwrite a newer saved appearance', async () => {
  const cache = createAppearanceSnapshots(), saved = largeAppearance();
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const pending = cache.captureAsync(saved, { budgetMs: 0, yieldTask: () => gate });
  const current = cache.capture({ ...saved, frameIndex: 2 });
  assert.ok(current); resume();
  assert.equal(await pending, null);
  const output = cache.preview({ frame: saved.frame, context, fallbackPalette: saved.palette });
  assert.equal(output.sourceFrameIndex, 2);
});
