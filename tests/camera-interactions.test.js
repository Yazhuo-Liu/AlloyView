import assert from 'node:assert/strict';
import test from 'node:test';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

class Events {
  handlers = new Map();
  addEventListener(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.handlers.get(name)?.delete(handler); }
  emit(type, values = {}) {
    const event = { type, pointerType: 'touch', pointerId: 1, button: 0, preventDefault() {}, ...values };
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

function fixture(mode = 'perspective') {
  const canvas = new Events(), document = new Events();
  document.defaultView = new Events();
  canvas.ownerDocument = document;
  canvas.clientHeight = 400;
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 400 });
  const captures = new Set();
  canvas.setPointerCapture = id => captures.add(id);
  canvas.hasPointerCapture = id => captures.has(id);
  canvas.releasePointerCapture = id => { captures.delete(id); canvas.emit('lostpointercapture', { pointerId: id }); };
  const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
    canvas, frame: {}, yaw: -.62, pitch: .38, pan: [0, 0, 0], distance: 10,
    orthographicScale: 5, fov: 40 * Math.PI / 180, projectionMode: mode,
    requestRender() {}, picks: [], pick: () => 7,
    onPick(atom) { this.picks.push(atom); },
  });
  renderer.installInteractions();
  const touch = (type, id, x, y, extra) => canvas.emit(type, { pointerId: id, clientX: x, clientY: y, ...extra });
  const amount = () => mode === 'orthographic' ? renderer.orthographicScale : renderer.distance;
  const units = () => 2 * (mode === 'orthographic' ? renderer.orthographicScale : Math.tan(renderer.fov / 2) * renderer.distance) / 400;
  return { renderer, canvas, document, captures, touch, amount, units };
}
function close(a, b) { assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`); }
function closeVector(a, b) { a.forEach((value, axis) => close(value, b[axis])); }

for (const mode of ['perspective', 'orthographic']) {
  test(`${mode}: opening and closing two fingers zooms without orbiting or selecting`, () => {
    const { renderer: r, touch, amount } = fixture(mode);
    const start = amount(), orientation = [r.yaw, r.pitch];
    touch('pointerdown', 1, 160, 220); touch('pointerdown', 2, 260, 220);
    touch('pointermove', 1, 110, 220); touch('pointermove', 2, 310, 220);
    close(amount(), start / 2);
    closeVector(r.pan, [0, 0, 0]);
    touch('pointermove', 1, 160, 220); touch('pointermove', 2, 260, 220);
    close(amount(), start);
    closeVector(r.pan, [0, 0, 0]);
    touch('pointerup', 1, 160, 220); touch('pointerup', 2, 260, 220);
    assert.deepEqual([r.yaw, r.pitch], orientation);
    assert.deepEqual(r.picks, []);
  });

  test(`${mode}: translating two fingers pans exactly in screen space`, () => {
    const { renderer: r, touch, amount, units } = fixture(mode);
    const start = amount(), w = units(), { right, up } = r.cameraBasis();
    touch('pointerdown', 1, 160, 220); touch('pointerdown', 2, 260, 220);
    touch('pointermove', 1, 190, 240); touch('pointermove', 2, 290, 240);
    close(amount(), start);
    closeVector(r.pan, right.map((value, axis) => -30 * w * value + 20 * w * up[axis]));
    assert.equal(r.yaw, -.62); assert.equal(r.pitch, .38);
  });

  test(`${mode}: combined pinch and pan preserves the point beneath the fingers`, () => {
    const { renderer: r, touch, units } = fixture(mode);
    const w0 = units(), { right, up } = r.cameraBasis();
    touch('pointerdown', 1, 180, 250); touch('pointerdown', 2, 280, 250);
    touch('pointermove', 1, 150, 265); touch('pointermove', 2, 350, 265);
    const w1 = units();
    // Canvas center (210,220), old midpoint (230,250), new (250,265).
    const expected = right.map((value, axis) => value * (20 * w0 - 40 * w1) + up[axis] * (45 * w1 - 30 * w0));
    closeVector(r.pan, expected);
    const reverse = fixture(mode);
    reverse.touch('pointerdown', 1, 180, 250); reverse.touch('pointerdown', 2, 280, 250);
    reverse.touch('pointermove', 2, 350, 265); reverse.touch('pointermove', 1, 150, 265);
    closeVector(reverse.renderer.pan, expected); // Independent of which pointer moves first.
  });
}

test('adding or removing fingers rebases gestures without a jump or an accidental selection', () => {
  const { renderer: r, touch } = fixture();
  touch('pointerdown', 1, 160, 220); touch('pointermove', 1, 170, 220);
  const yaw = r.yaw;
  touch('pointerdown', 2, 260, 220);
  assert.equal(r.yaw, yaw); assert.equal(r.distance, 10);
  touch('pointermove', 2, 310, 220);
  const pan = [...r.pan], distance = r.distance;
  touch('pointerdown', 3, 230, 250); touch('pointerup', 2, 310, 220);
  closeVector(r.pan, pan); close(r.distance, distance);
  touch('pointerup', 3, 230, 250);
  touch('pointermove', 1, 180, 220);
  close(r.yaw, yaw - .08);
  touch('pointerup', 1, 180, 220);
  assert.deepEqual(r.picks, []);
});

test('tap selects; dragging out and back and multi-touch taps do not select', () => {
  const { renderer: r, touch } = fixture();
  touch('pointerdown', 1, 160, 220); touch('pointerup', 1, 160, 220);
  assert.deepEqual(r.picks, [7]);
  touch('pointerdown', 1, 160, 220); touch('pointermove', 1, 190, 220);
  touch('pointermove', 1, 160, 220); touch('pointerup', 1, 160, 220);
  touch('pointerdown', 1, 160, 220); touch('pointerdown', 2, 260, 220);
  touch('pointerup', 1, 160, 220); touch('pointerup', 2, 260, 220);
  assert.deepEqual(r.picks, [7]);
});

test('cancel, lost capture, backgrounding and blur clean up gestures', () => {
  for (const kind of ['pointercancel', 'lostpointercapture', 'visibilitychange', 'blur']) {
    const { renderer: r, touch, document, captures } = fixture();
    touch('pointerdown', 1, 160, 220); touch('pointerdown', 2, 260, 220);
    if (kind === 'blur') document.defaultView.emit(kind);
    else if (kind === 'visibilitychange') { document.hidden = true; document.emit(kind); }
    else { touch(kind, 1, 160, 220); touch(kind, 2, 260, 220); }
    touch('pointermove', 1, 110, 220); touch('pointerup', 2, 260, 220);
    assert.equal(r.distance, 10); assert.equal(r.yaw, -.62);
    assert.deepEqual(r.picks, []); assert.equal(captures.size, 0);
    touch('pointerdown', 3, 200, 220); touch('pointermove', 3, 210, 220);
    close(r.yaw, -.70);
  }
});

test('coincident fingers keep zoom finite and bounded', () => {
  const { renderer: r, touch } = fixture();
  touch('pointerdown', 1, 210, 220); touch('pointerdown', 2, 210, 220);
  touch('pointermove', 2, 310, 220);
  assert.ok(Number.isFinite(r.distance) && r.distance >= .02);
  touch('pointermove', 1, 310, 220);
  assert.ok(Number.isFinite(r.distance) && r.pan.every(Number.isFinite));
});

test('desktop left drag, right/Shift drag, click and wheel retain their controls', () => {
  const { renderer: r, canvas, touch, units } = fixture();
  const mouse = (type, id, x, y, extra) => touch(type, id, x, y, { pointerType: 'mouse', ...extra });
  mouse('pointerdown', 1, 160, 220); mouse('pointermove', 1, 170, 240); mouse('pointerup', 1, 170, 240);
  close(r.yaw, -.70); close(r.pitch, .54); assert.deepEqual(r.picks, []);
  mouse('pointerdown', 1, 160, 220); mouse('pointerup', 1, 160, 220);
  assert.deepEqual(r.picks, [7]);
  for (const extra of [{ button: 2 }, { button: 0, shiftKey: true }]) {
    r.pan = [0, 0, 0];
    const { right, up } = r.cameraBasis(), w = units();
    mouse('pointerdown', 1, 160, 220, extra); mouse('pointermove', 1, 170, 240, extra); mouse('pointerup', 1, 170, 240, extra);
    closeVector(r.pan, right.map((value, axis) => -10 * w * value + 20 * w * up[axis]));
  }
  canvas.emit('wheel', { deltaY: -100 }); close(r.distance, 10 * Math.exp(-.18));
  r.interactions.dispose();
  const before = r.yaw;
  mouse('pointerdown', 1, 160, 220); mouse('pointermove', 1, 190, 220);
  assert.equal(r.yaw, before);
});
