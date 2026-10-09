import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AMBIENT_OCCLUSION_SEED, AmbientOcclusionController, DEFAULT_AMBIENT_OCCLUSION, MAX_AMBIENT_OCCLUSION_INSTANCES,
  accumulateVisiblePixels, ambientOcclusionBounds, ambientOcclusionBrightness, ambientOcclusionCamera, ambientOcclusionDirections,
  ambientOcclusionInputs, ambientOcclusionInputsMatch, normalizeAmbientOcclusion, normalizeAmbientOcclusionSettings,
} from '../src/render/ambient-occlusion.js';
import { ambientOcclusionStatusText, initializeAmbientOcclusionControls } from '../src/ambient-occlusion-controls.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';
import { transformPoint } from '../src/render/math.js';

test('sample directions are deterministic unit vectors spread evenly over the whole sphere', () => {
  for (const count of [16, 40, 100, 200]) {
    const directions = ambientOcclusionDirections(count);
    assert.equal(directions.length, count * 3);
    assert.deepEqual(directions, ambientOcclusionDirections(count, AMBIENT_OCCLUSION_SEED), 'a fixed seed repeats exactly');
    const sum = [0, 0, 0];
    let closest = Infinity;
    for (let index = 0; index < count; index++) {
      const vector = directions.subarray(index * 3, index * 3 + 3);
      assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-12);
      for (let axis = 0; axis < 3; axis++) sum[axis] += vector[axis];
      for (let other = 0; other < index; other++) {
        const dot = vector[0] * directions[other * 3] + vector[1] * directions[other * 3 + 1] + vector[2] * directions[other * 3 + 2];
        closest = Math.min(closest, Math.acos(Math.min(1, dot)));
      }
    }
    // Balanced: the mean vanishes, and no two samples nearly coincide.
    assert.ok(Math.hypot(...sum) / count < 0.02, `mean of ${count} directions`);
    assert.ok(closest > 2 / Math.sqrt(count), `closest pair of ${count} directions: ${closest}`);
    // Every half-space receives about half of the samples.
    for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.6, 0, 0.8]]) {
      let positive = 0;
      for (let index = 0; index < count; index++) if (axis[0] * directions[index * 3] + axis[1] * directions[index * 3 + 1] + axis[2] * directions[index * 3 + 2] > 0) positive++;
      assert.ok(Math.abs(positive - count / 2) <= Math.max(2, count * 0.06), `${positive} of ${count} toward ${axis}`);
    }
  }
  // The rotation keeps samples off the lattice axes.
  const directions = ambientOcclusionDirections(40);
  for (let index = 0; index < 40; index++) for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(directions[index * 3 + axis]) < 0.999);
  assert.notDeepEqual(ambientOcclusionDirections(40, 1), directions);
  for (const count of [0, -1, 1.5, 5000, NaN]) assert.throws(() => ambientOcclusionDirections(count), /1–4096/);
});

test('ID pixels are counted per instance; background and foreign IDs are not', () => {
  const encode = id => [id & 255, id >>> 8 & 255, id >>> 16 & 255, id >>> 24 & 255];
  const pixels = new Uint8Array([...encode(0), ...encode(1), ...encode(1), ...encode(3), ...encode(70_000), ...encode(4), ...encode(0x01000001)]);
  const counts = new Uint32Array(70_000);
  assert.deepEqual(accumulateVisiblePixels(pixels, counts), { covered: 5, invalid: 1 });
  assert.equal(counts[0], 2); assert.equal(counts[2], 1); assert.equal(counts[3], 1); assert.equal(counts[69_999], 1);
  assert.equal(counts.reduce((sum, value) => sum + value, 0), 5);
  // Unaligned views decode the same bytes.
  const shifted = new Uint8Array(pixels.length + 1); shifted.set(pixels, 1);
  const other = new Uint32Array(70_000);
  accumulateVisiblePixels(shifted.subarray(1), other);
  assert.deepEqual(other, counts);
  assert.throws(() => accumulateVisiblePixels(new Uint8Array(3), counts), /RGBA/);
  assert.throws(() => accumulateVisiblePixels(pixels, new Float32Array(4)), /Uint32Array/);
});

test('exposure is normalized by squared radius and by the most exposed instance', () => {
  // Two atoms, two replicas. Atom 1 is twice as large, so four times the pixels
  // means the same exposure as atom 0.
  const counts = new Uint32Array([10, 40, 5, 0]), radii = new Float32Array([1, 2]);
  const { factors, maximum } = normalizeAmbientOcclusion(counts, radii, 2);
  assert.deepEqual(Array.from(factors), [1, 1, 0.5, 0]);
  assert.equal(maximum, 10);
  assert.ok(factors instanceof Float32Array);
  assert.deepEqual(Array.from(normalizeAmbientOcclusion(new Uint32Array(3), new Float32Array([1, 1, 1]), 3).factors), [0, 0, 0], 'nothing visible gives zeros, not NaN');
  assert.throws(() => normalizeAmbientOcclusion(new Uint32Array(3), new Float32Array(2), 2), /atom count/);
  assert.throws(() => normalizeAmbientOcclusion(new Uint32Array(4), new Float32Array(3), 2), /radii/);
  assert.equal(ambientOcclusionBrightness(0.25, 0), 1, 'zero intensity leaves colors alone');
  assert.equal(ambientOcclusionBrightness(0.25, 1), 0.25);
  assert.ok(Math.abs(ambientOcclusionBrightness(0.25, 0.7) - (1 * 0.3 + 0.25 * 0.7)) < 1e-15, 'matches GLSL mix(1, value, intensity)');
});

test('settings are validated over defaults', () => {
  assert.deepEqual(normalizeAmbientOcclusionSettings(), DEFAULT_AMBIENT_OCCLUSION);
  assert.deepEqual(normalizeAmbientOcclusionSettings({ enabled: true, intensity: 0 }), { ...DEFAULT_AMBIENT_OCCLUSION, enabled: true, intensity: 0 });
  assert.deepEqual(normalizeAmbientOcclusionSettings({ directions: 200 }, { enabled: true, intensity: 1, directions: 16, resolution: 256 }),
    { enabled: true, intensity: 1, directions: 200, resolution: 256 });
  for (const [value, message] of [[{ enabled: 'yes' }, /on or off/], [{ intensity: 1.5 }, /between 0 and 1/], [{ intensity: NaN }, /between 0 and 1/],
    [{ intensity: '0.5' }, /between 0 and 1/], [{ directions: 41 }, /16, 40, 100 or 200 directions/], [{ resolution: 300 }, /256, 512, 1024 or 2048/],
    [{ samples: 4 }, /Unknown/], [null, /object/], [[], /object/]]) {
    assert.throws(() => normalizeAmbientOcclusionSettings(value), message);
  }
});

function fakeRenderer(atomCount = 3, { replicas = 1 } = {}) {
  const renderer = {
    frame: {}, atomCount, gl: {}, radiusScale: 1, sliceMode: 'legacy', sliceAxis: 2, sliceMaximum: 1, sliceCount: 0,
    slicePlaneValues: new Float32Array(128), repetitions: [replicas, 1, 1],
    replicas: Array.from({ length: replicas }, (_, index) => ({ indices: [index, 0, 0], offset: [10 * index, 0, 0] })),
    minimumOffset: [0, 0, 0], maximumOffset: [10 * (replicas - 1), 0, 0],
    displayPositions: Float32Array.from({ length: atomCount * 3 }, (_, index) => index % 3 === 0 ? index / 3 : 0),
    displayFractional: new Float32Array(atomCount * 3), visibility: new Uint8Array(atomCount).fill(255),
    atomRadii: new Float32Array(atomCount).fill(0.5), colors: new Uint8Array(atomCount * 3),
    ambientOcclusionFactors: null, ambientOcclusionIntensity: 1, uploads: 0,
    setAmbientOcclusion(factors, { intensity = this.ambientOcclusionIntensity } = {}) {
      if (factors !== this.ambientOcclusionFactors) this.uploads++;
      this.ambientOcclusionFactors = factors; this.ambientOcclusionIntensity = intensity;
    },
  };
  return renderer;
}

test('cached results are keyed by geometry, visibility, slices, replication and sampling, not colors or intensity', () => {
  const renderer = fakeRenderer(), settings = { ...DEFAULT_AMBIENT_OCCLUSION, enabled: true };
  let inputs = ambientOcclusionInputs(renderer, settings);
  const same = () => ambientOcclusionInputsMatch(inputs, renderer, settings);
  assert.equal(same(), true);
  renderer.colors = new Uint8Array(9).fill(7); renderer.ambientOcclusionIntensity = 0.2;
  assert.equal(same(), true, 'colors and intensity do not invalidate');
  // A replaced array with equal contents is adopted after one comparison.
  const visibility = renderer.visibility.slice(); renderer.visibility = visibility;
  assert.equal(same(), true); assert.equal(inputs.visibility, visibility);
  renderer.visibility = Uint8Array.from([255, 0, 255]); assert.equal(same(), false, 'hiding an atom invalidates');
  renderer.visibility = visibility; assert.equal(same(), true);
  renderer.atomRadii = Float32Array.from([0.5, 0.5, 0.6]); assert.equal(same(), false, 'radii');
  renderer.atomRadii = new Float32Array(3).fill(0.5); assert.equal(same(), true);
  const edits = [
    [() => { renderer.radiusScale = 1.5; }, () => { renderer.radiusScale = 1; }],
    [() => { renderer.displayPositions = renderer.displayPositions.slice(); }, null],
    [() => { renderer.sliceMaximum = 0.5; }, () => { renderer.sliceMaximum = 1; }],
    [() => { renderer.sliceAxis = 0; }, () => { renderer.sliceAxis = 2; }],
    [() => { renderer.sliceMode = 'planes'; renderer.sliceCount = 1; renderer.slicePlaneValues[3] = 2; }, null],
    [() => { renderer.slicePlaneValues = renderer.slicePlaneValues.slice(); renderer.slicePlaneValues[3] = 2.5; }, null],
    [() => { renderer.replicas = [...renderer.replicas, { indices: [1, 0, 0], offset: [4, 0, 0] }]; }, () => { renderer.replicas = renderer.replicas.slice(0, 1); }],
    [() => { renderer.replicas = [{ indices: [0, 0, 0], offset: [0, 0, 1] }]; }, null],
  ];
  for (const [change, revert] of edits) {
    change();
    assert.equal(same(), false, String(change));
    if (revert) { revert(); assert.equal(same(), true, String(revert)); }
    inputs = ambientOcclusionInputs(renderer, settings);
  }
  assert.equal(ambientOcclusionInputsMatch(inputs, renderer, { ...settings, directions: 100 }), false);
  assert.equal(ambientOcclusionInputsMatch(inputs, renderer, { ...settings, resolution: 512 }), false);
  assert.equal(ambientOcclusionInputsMatch(inputs, renderer, { ...settings, intensity: 0.1 }), true);
  assert.equal(ambientOcclusionInputsMatch(null, renderer, settings), false);
  renderer.atomCount = 4; assert.equal(same(), false);
});

test('bounds cover unhidden atoms in every replica and a parallel camera frames them', () => {
  const renderer = fakeRenderer(3, { replicas: 2 });
  renderer.visibility = Uint8Array.from([255, 255, 0]);
  renderer.atomRadii = Float32Array.from([0.5, 1, 4]); renderer.radiusScale = 2;
  const bounds = ambientOcclusionBounds(renderer);
  // Atoms 0 and 1 at x = 0 and 1, the second replica 10 further: x from 0 to 11.
  assert.deepEqual(bounds.center.map(value => Number(value.toFixed(6))), [5.5, 0, 0]);
  assert.ok(Math.abs(bounds.radius - (5.5 + 2) * (1 + 1e-4) - 1e-6) < 1e-9, 'the hidden large atom does not widen the buffer');
  assert.equal(bounds.visible, 2);
  renderer.visibility.fill(0); assert.equal(ambientOcclusionBounds(renderer), null);
  const camera = ambientOcclusionCamera([0, 0, 1], { center: [1, 2, 3], radius: 4 });
  const project = point => { const view = transformPoint(camera.view, ...point); return transformPoint(camera.projection, ...view.slice(0, 3)); };
  assert.deepEqual(project([1, 2, 3]).map(value => Number(value.toFixed(6))), [0, 0, 0, 1]);
  assert.ok(Math.abs(project([5, 2, 3])[0] - 1) < 1e-6 || Math.abs(project([5, 2, 3])[1] - 1) < 1e-6, 'radius spans the buffer');
  assert.ok(project([1, 2, 7])[2] < -0.999 && project([1, 2, -1])[2] > 0.999, 'near and far planes enclose the sphere');
});

class FakePass {
  constructor(log) { this.log = log; this.allocated = 0; }
  allocate(resolution) { this.allocated = resolution; }
  // Atom 0 is seen by two pixels, atom 1 by one, atom 2 never; replicas repeat it.
  render(renderer, direction, bounds, pixels) {
    if (this.fail) throw new Error('GPU failed');
    this.log.push(Array.from(direction));
    pixels.fill(0);
    const ids = [1, 1, 2];
    for (let copy = 1; copy < renderer.replicas.length; copy++) ids.push(copy * renderer.atomCount + 1);
    ids.forEach((id, texel) => { pixels[texel * 4] = id & 255; pixels[texel * 4 + 1] = id >> 8 & 255; });
  }
  release() { this.released = true; }
  dispose() { this.disposed = true; }
}

function controllerFixture(options = {}) {
  const renderer = fakeRenderer(3, options), log = [], statuses = [], timers = [];
  let clock = 0, changes = 0;
  const pass = new FakePass(log);
  const controller = new AmbientOcclusionController(renderer, {
    onChange: () => changes++, onStatus: status => statuses.push(status), createPass: () => pass,
    now: () => clock, budgetMs: 10, delayMs: 150,
    schedule: (callback, delay) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
  });
  // Each rendered direction advances the fake clock by 4 ms.
  const render = pass.render.bind(pass); pass.render = (...args) => { clock += 4; return render(...args); };
  const runTimers = () => { while (timers.length) { const timer = timers.shift(); if (!timer.cancelled) timer.callback(); } };
  return { renderer, controller, pass, log, statuses, timers, runTimers, changes: () => changes, elapse: milliseconds => { clock += milliseconds; } };
}

test('the controller computes in budgeted slices, applies the result and reuses it until inputs change', () => {
  const { renderer, controller, log, statuses, timers, runTimers, changes } = controllerFixture();
  controller.setSettings({ enabled: true, directions: 16, resolution: 256 });
  assert.equal(timers[0].delay, 0, 'turning occlusion on starts at once');
  assert.equal(statuses.at(-1).state, 'queued');
  timers.shift().callback();
  assert.equal(log.length, 3, 'a 10 ms budget fits three 4 ms directions');
  assert.deepEqual(statuses.at(-1), { state: 'computing', completed: 3, total: 16 });
  assert.equal(renderer.ambientOcclusionFactors, null, 'nothing is shown before the first result');
  runTimers();
  assert.equal(log.length, 16);
  assert.deepEqual(Array.from(renderer.ambientOcclusionFactors), [1, 0.5, 0]);
  assert.equal(statuses.at(-1).state, 'ready'); assert.equal(statuses.at(-1).instances, 3);
  assert.equal(changes(), 1);
  // Unchanged inputs: update() is a no-op on every frame.
  controller.update(); controller.update();
  assert.equal(timers.length, 0); assert.equal(controller.ensureCurrent(), true); assert.equal(log.length, 16);
  // Intensity is a uniform: no recomputation.
  controller.setSettings({ intensity: 0.3 });
  assert.equal(renderer.ambientOcclusionIntensity, 0.3); assert.equal(timers.length, 0); assert.equal(renderer.uploads, 1);
  // A visibility change waits for edits to pause and keeps the old result meanwhile.
  const previous = renderer.ambientOcclusionFactors;
  renderer.visibility = Uint8Array.from([255, 255, 0]);
  controller.update();
  assert.equal(timers.at(-1).delay, 150); assert.equal(renderer.ambientOcclusionFactors, previous);
  renderer.visibility = Uint8Array.from([0, 255, 0]);
  controller.update();
  assert.equal(timers.filter(timer => !timer.cancelled).length, 1, 'a further edit restarts the wait');
  runTimers();
  assert.notEqual(renderer.ambientOcclusionFactors, previous);
  assert.equal(log.length, 32);
  // Returning to inputs of the current result cancels nothing and computes nothing.
  controller.update(); assert.equal(timers.length, 0);
});

test('exports finish the computation synchronously, including a partly completed one', () => {
  const { renderer, controller, log, timers } = controllerFixture();
  controller.setSettings({ enabled: true, directions: 16 });
  timers.shift().callback();
  assert.equal(log.length, 3);
  assert.equal(controller.ensureCurrent(), true);
  assert.equal(log.length, 16, 'the remaining directions only');
  assert.ok(timers.every(timer => timer.cancelled), 'the background slice is cancelled');
  assert.deepEqual(Array.from(renderer.ambientOcclusionFactors), [1, 0.5, 0]);
  // Inputs changed after the last result: computed from scratch at once.
  renderer.radiusScale = 2;
  controller.update();
  assert.equal(controller.ensureCurrent(), true);
  assert.equal(log.length, 32);
  assert.ok(timers.every(timer => timer.cancelled), 'the queued update is dropped');
  controller.setSettings({ enabled: false });
  assert.equal(controller.ensureCurrent(), false); assert.equal(renderer.ambientOcclusionFactors, null);
});

test('background work reads images back behind fences without waiting for the GPU', () => {
  const { renderer, controller, pass, log, timers, elapse } = controllerFixture();
  // A pass with two readback slots whose fences signal when the test says so.
  const slots = [{ busy: false }, { busy: false }], signaled = new Set();
  const draw = pass.render.bind(pass);
  Object.assign(pass, {
    asynchronous: true,
    available: () => slots.some(slot => !slot.busy),
    ready: slot => signaled.has(slot),
    render(target, direction, bounds, pixels = null) {
      if (pixels) return draw(target, direction, bounds, pixels);
      const slot = slots.find(candidate => !candidate.busy);
      slot.busy = true; slot.image = new Uint8Array(256 * 256 * 4); draw(target, direction, bounds, slot.image);
      return slot;
    },
    collect(slot, pixels) { pixels.set(slot.image); this.free(slot); },
    free(slot) { slot.busy = false; signaled.delete(slot); },
  });
  controller.setSettings({ enabled: true, directions: 16, resolution: 256 });
  timers.shift().callback();
  assert.equal(log.length, 2, 'two slots: two directions submitted');
  assert.equal(timers.at(-1).delay, 1, 'polls the fences soon');
  timers.shift().callback();
  assert.equal(log.length, 2, 'nothing is collected or submitted before a fence signals');
  signaled.add(slots[0]);
  timers.shift().callback();
  assert.equal(log.length, 3); assert.deepEqual(controller.status, { state: 'computing', completed: 1, total: 16 });
  // A slice ends at its time budget even with finished images waiting.
  signaled.add(slots[0]); signaled.add(slots[1]);
  const collect = pass.collect; pass.collect = function(...args) { elapse(20); return collect.apply(this, args); };
  timers.shift().callback();
  assert.equal(controller.status.completed, 2, 'one 20 ms readback exhausts a 10 ms budget');
  pass.collect = collect;
  // An export collects the images in flight and renders the rest at once.
  controller.ensureCurrent();
  assert.equal(log.length, 16);
  assert.deepEqual(Array.from(renderer.ambientOcclusionFactors), [1, 0.5, 0]);
  assert.ok(slots.every(slot => !slot.busy));
  // Abandoned work releases its slots.
  renderer.radiusScale = 3; controller.update(); timers.at(-1).callback();
  assert.ok(slots.some(slot => slot.busy));
  controller.cancel();
  assert.ok(slots.every(slot => !slot.busy));
});

test('each displayed replica receives its own factors', () => {
  const { renderer, controller } = controllerFixture({ replicas: 2 });
  controller.setSettings({ enabled: true, directions: 16 });
  controller.ensureCurrent();
  assert.deepEqual(Array.from(renderer.ambientOcclusionFactors), [1, 0.5, 0, 0.5, 0, 0]);
});

test('cancel stops work until an input changes or Recompute; errors are reported', () => {
  const { renderer, controller, log, statuses, timers, runTimers } = controllerFixture();
  controller.setSettings({ enabled: true, directions: 16 });
  timers.shift().callback();
  controller.cancel();
  assert.equal(statuses.at(-1).state, 'cancelled');
  runTimers(); controller.update(); runTimers();
  assert.equal(log.length, 3, 'no work after Cancel');
  controller.recompute(); runTimers();
  assert.equal(log.length, 19); assert.equal(statuses.at(-1).state, 'ready');
  renderer.sliceMaximum = 0.5; controller.update(); controller.cancel();
  renderer.sliceMaximum = 0.4; controller.update(); runTimers();
  assert.equal(statuses.at(-1).state, 'ready', 'a new edit resumes');
  controller.setSettings({ resolution: 2048 }); controller.update({ immediate: true }); timers.shift().callback(); controller.cancel();
  assert.equal(statuses.at(-1).state, 'cancelled');
  controller.setSettings({ resolution: 1024 });
  assert.equal(statuses.at(-1).state, 'ready', 'returning to the displayed result reports it as current');
  controller.pass.fail = true;
  renderer.sliceMaximum = 0.3; controller.update(); runTimers();
  assert.equal(statuses.at(-1).state, 'error'); assert.match(statuses.at(-1).message, /GPU failed/);
  assert.equal(renderer.ambientOcclusionFactors, null);
  controller.update(); assert.equal(timers.length, 0, 'a failure is not retried on every frame');
  assert.throws(() => controller.ensureCurrent(), /GPU failed/, 'exports report the failure');
  controller.pass.fail = false;
  renderer.atomCount = MAX_AMBIENT_OCCLUSION_INSTANCES; renderer.replicas = [renderer.replicas[0], renderer.replicas[0]];
  assert.throws(() => controller.ensureCurrent(), /supports up to 16,777,216 displayed atoms/);
  renderer.frame = null; controller.update();
  assert.equal(statuses.at(-1).state, 'idle');
  controller.dispose(); assert.equal(controller.pass, null);
});

test('status text describes each state', () => {
  assert.match(ambientOcclusionStatusText({ state: 'off' }), /^Off/);
  assert.equal(ambientOcclusionStatusText({ state: 'computing', completed: 3, total: 40 }), 'Computing… 3 / 40 directions');
  assert.equal(ambientOcclusionStatusText({ state: 'ready', total: 40, resolution: 1024, instances: 60229, elapsedMs: 1234 }),
    'Current: 40 directions at 1024 × 1024 px, 60,229 displayed atoms, 1.23 s.');
  assert.match(ambientOcclusionStatusText({ state: 'error', message: 'Too large.' }), /Unavailable: Too large/);
});

test('configuration JSON validates ambient occlusion and keeps older recipes unchanged', () => {
  const settings = { enabled: true, intensity: 0.45, directions: 100, resolution: 512 };
  const configuration = createConfiguration({ settings: { display: { ambientOcclusion: settings } } });
  assert.deepEqual(configuration.settings.display.ambientOcclusion, settings);
  assert.deepEqual(parseConfiguration(JSON.stringify(configuration)), configuration, 'round trip');
  assert.deepEqual(createConfiguration({ settings: { display: { ambientOcclusion: { enabled: true } } } }).settings.display.ambientOcclusion,
    { ...DEFAULT_AMBIENT_OCCLUSION, enabled: true });
  const legacy = createConfiguration({ settings: { display: {} } });
  assert.equal(Object.hasOwn(legacy.settings.display, 'ambientOcclusion'), false, 'absent stays absent');
  for (const [patch, message] of [[{ intensity: 2 }, /ambientOcclusion\.intensity must be a finite number from 0 to 1/],
    [{ directions: 64 }, /ambientOcclusion\.directions is unsupported/], [{ resolution: '1024' }, /ambientOcclusion\.resolution is unsupported/],
    [{ enabled: 1 }, /ambientOcclusion\.enabled must be true or false/], [{ samples: 4 }, /ambientOcclusion\.samples is not a supported setting/]]) {
    const value = structuredClone(configuration); Object.assign(value.settings.display.ambientOcclusion, patch);
    assert.throws(() => parseConfiguration(JSON.stringify(value)), message);
  }
  const notObject = structuredClone(configuration); notObject.settings.display.ambientOcclusion = true;
  assert.throws(() => parseConfiguration(JSON.stringify(notObject)), /ambientOcclusion must be an object/);
});

test('the renderer uploads factors into a per-instance attribute and ignores mismatched sizes', () => {
  const calls = [];
  const renderer = Object.create(WebGLRenderer.prototype);
  Object.assign(renderer, { frame: {}, atomCount: 2, replicas: [{}, {}], sphereVao: 'vao', requestRender() { calls.push('render'); } });
  renderer.gl = new Proxy({ ARRAY_BUFFER: 'ARRAY_BUFFER', STATIC_DRAW: 'STATIC', FLOAT: 'FLOAT' }, {
    get(target, name) { return name in target ? target[name] : (...args) => { calls.push([name, ...args]); return name === 'createBuffer' ? 'buffer' : undefined; }; },
  });
  const factors = new Float32Array([1, 0.5, 0.25, 0]);
  renderer.setAmbientOcclusion(factors, { intensity: 0.6 });
  assert.equal(renderer.ambientOcclusionActive(), true);
  assert.deepEqual(calls.filter(call => Array.isArray(call)).map(call => call[0]), ['createBuffer', 'bindBuffer', 'bufferData']);
  assert.deepEqual(calls.find(call => call[0] === 'bufferData'), ['bufferData', 'ARRAY_BUFFER', factors, 'STATIC']);
  calls.length = 0;
  renderer.setAmbientOcclusion(factors, { intensity: 0.2 });
  assert.deepEqual(calls, ['render'], 'an intensity edit uploads nothing');
  renderer.replicas = [{}];
  assert.equal(renderer.ambientOcclusionActive(), false, 'factors for another replica count stay unused');
  assert.throws(() => renderer.setAmbientOcclusion([1, 2]), /Float32Array/);
  assert.throws(() => renderer.setAmbientOcclusion(factors, { intensity: 1.5 }), /between 0 and 1/);
  calls.length = 0;
  renderer.setAmbientOcclusion(null);
  assert.ok(calls.some(call => call[0] === 'bufferData' && call[2] === 0), 'Off releases the GPU copy');
  assert.equal(renderer.ambientOcclusionFactors, null); assert.equal(renderer.ambientOcclusionActive(), false);
});

test('Display controls drive the controller, restore recipes and default old recipes to Off', () => {
  const nodes = {};
  const node = (id, value = '') => (nodes[id] = { id, value, checked: false, disabled: false, hidden: false, textContent: '', max: 1, listeners: new Map(),
    style: { setProperty() {} }, classList: { toggle() {} },
    addEventListener(name, callback) { this.listeners.set(name, callback); }, removeEventListener(name) { this.listeners.delete(name); } });
  node('ambient-occlusion'); node('ambient-occlusion-intensity', '0.7'); node('ambient-occlusion-intensity-value');
  node('ambient-occlusion-directions', '40'); node('ambient-occlusion-resolution', '1024'); node('ambient-occlusion-status');
  node('ambient-occlusion-progress'); node('ambient-occlusion-recompute'); node('ambient-occlusion-cancel');
  const oldDocument = globalThis.document;
  globalThis.document = { getElementById: id => nodes[id] };
  const applied = [], edits = [], notices = [];
  let fake;
  try {
    const controls = initializeAmbientOcclusionControls({ renderer: {}, onEdit: () => edits.push(1), notify: message => notices.push(message),
      createController: (renderer, options) => (fake = { settings: { ...DEFAULT_AMBIENT_OCCLUSION }, options,
        setSettings(patch) { this.settings = normalizeAmbientOcclusionSettings(patch, this.settings); applied.push({ ...patch }); },
        recompute() { applied.push('recompute'); }, cancel() { applied.push('cancel'); }, update() {}, ensureCurrent() { return true; }, dispose() {} }) });
    const fire = (id, name = 'change') => nodes[id].listeners.get(name)({ type: name, target: nodes[id] });
    assert.equal(nodes['ambient-occlusion'].disabled, true, 'disabled without a structure');
    controls.setEnabled(true);
    assert.equal(nodes['ambient-occlusion'].disabled, false);
    assert.equal(nodes['ambient-occlusion-intensity'].disabled, true, 'parameters wait for the switch');
    nodes['ambient-occlusion'].checked = true; fire('ambient-occlusion');
    assert.deepEqual(applied.at(-1), { enabled: true, intensity: 0.7, directions: 40, resolution: 1024 });
    assert.equal(nodes['ambient-occlusion-intensity'].disabled, false);
    nodes['ambient-occlusion-intensity'].value = '0.25'; fire('ambient-occlusion-intensity', 'input');
    assert.deepEqual(applied.at(-1), { intensity: 0.25 }, 'dragging sends the intensity only');
    assert.equal(nodes['ambient-occlusion-intensity-value'].textContent, '0.25');
    fake.options.onStatus({ state: 'computing', completed: 5, total: 40 });
    assert.equal(nodes['ambient-occlusion-status'].textContent, 'Computing… 5 / 40 directions');
    assert.equal(nodes['ambient-occlusion-progress'].hidden, false); assert.equal(nodes['ambient-occlusion-progress'].value, 5);
    assert.equal(nodes['ambient-occlusion-cancel'].disabled, false); assert.equal(nodes['ambient-occlusion-recompute'].disabled, true);
    nodes['ambient-occlusion-cancel'].listeners.get('click')(); assert.equal(applied.at(-1), 'cancel');
    nodes['ambient-occlusion-recompute'].listeners.get('click')(); assert.equal(applied.at(-1), 'recompute');
    assert.ok(edits.length >= 3);
    controls.restore({ enabled: true, intensity: 0.45, directions: 100, resolution: 512 });
    assert.deepEqual(controls.getState(), { enabled: true, intensity: 0.45, directions: 100, resolution: 512 });
    assert.equal(nodes['ambient-occlusion-directions'].value, '100');
    controls.restore(undefined);
    assert.deepEqual(controls.getState(), DEFAULT_AMBIENT_OCCLUSION, 'recipes without the entry restore Off');
    assert.equal(nodes['ambient-occlusion'].checked, false);
    assert.deepEqual(notices, []);
    controls.dispose();
    assert.equal(nodes['ambient-occlusion'].listeners.size, 0);
  } finally {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  }
});
