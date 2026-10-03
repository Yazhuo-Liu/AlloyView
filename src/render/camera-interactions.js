import { add, scale } from './math.js';

const MAX_ORBIT_PITCH = Math.PI / 2 - 0.008;
const TAP_DISTANCE = 4;

// Pointer Events keep mouse controls and touch gestures on the same canvas.
export function installCameraInteractions(renderer) {
  const { canvas } = renderer;
  const document = canvas.ownerDocument;
  const window = document?.defaultView;
  const touches = new Map();
  const listeners = [];
  let drag = null, gesture = null;

  function listen(target, name, handler, options) {
    if (!target) return;
    target.addEventListener(name, handler, options);
    listeners.push(() => target.removeEventListener(name, handler, options));
  }
  function release(id) {
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function reset() {
    const ids = [...touches.keys(), ...(drag ? [drag.id] : [])];
    touches.clear();
    drag = gesture = null;
    for (const id of ids) release(id);
  }
  function point(event) {
    return { id: event.pointerId, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, moved: false, multi: false };
  }
  function update(pointer, event) {
    const delta = [event.clientX - pointer.x, event.clientY - pointer.y];
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.moved ||= Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) >= TAP_DISTANCE;
    return delta;
  }
  function measure() {
    if (touches.size < 2) return null;
    const [a, b] = touches.values();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
      span: Math.max(8, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
  function worldPerPixel() {
    const halfHeight = renderer.projectionMode === 'orthographic'
      ? renderer.orthographicScale : Math.tan(renderer.fov / 2) * renderer.distance;
    return 2 * halfHeight / Math.max(1, canvas.clientHeight);
  }
  function zoom(factor) {
    if (renderer.projectionMode === 'orthographic') renderer.orthographicScale = Math.max(0.02, renderer.orthographicScale * factor);
    else renderer.distance = Math.max(0.02, renderer.distance * factor);
  }
  function rotate(dx, dy) {
    renderer.yaw -= dx * 0.008;
    // Keep global Z upright and prevent rolling over an orbit pole.
    renderer.pitch = Math.max(-MAX_ORBIT_PITCH, Math.min(MAX_ORBIT_PITCH, renderer.pitch + dy * 0.008));
  }
  function pan(dx, dy) {
    const { right, up } = renderer.cameraBasis();
    const units = worldPerPixel();
    renderer.pan = add(renderer.pan, add(scale(right, -dx * units), scale(up, dy * units)));
  }
  function transformTouches(next) {
    const before = worldPerPixel();
    zoom(gesture.span / next.span);
    const after = worldPerPixel();
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;
    const { right, up } = renderer.cameraBasis();
    // Keep the point under the previous midpoint beneath the new midpoint.
    // This handles simultaneous pinch and translation without a camera jump.
    const dx = (gesture.x - centerX) * before - (next.x - centerX) * after;
    const dy = (next.y - centerY) * after - (gesture.y - centerY) * before;
    renderer.pan = add(renderer.pan, add(scale(right, dx), scale(up, dy)));
    gesture = next;
  }

  listen(canvas, 'pointerdown', event => {
    if (!renderer.frame) return;
    if (event.pointerType === 'touch') {
      event.preventDefault();
      if (drag) { const id = drag.id; drag = null; release(id); }
      touches.set(event.pointerId, point(event));
      if (touches.size >= 2) for (const pointer of touches.values()) pointer.multi = true;
      gesture = measure(); // Rebase when fingers are added; never move the camera here.
    } else {
      if (touches.size || drag || (event.button !== 0 && event.button !== 2)) return;
      drag = { ...point(event), mode: event.button === 2 || event.shiftKey ? 'pan' : 'rotate', button: event.button };
    }
    canvas.setPointerCapture(event.pointerId);
  });
  listen(canvas, 'pointermove', event => {
    const pointer = touches.get(event.pointerId);
    if (pointer) {
      event.preventDefault();
      const [dx, dy] = update(pointer, event);
      if (touches.size >= 2) transformTouches(measure());
      else rotate(dx, dy);
    } else if (drag?.id === event.pointerId) {
      const [dx, dy] = update(drag, event);
      if (drag.mode === 'pan') pan(dx, dy);
      else rotate(dx, dy);
    } else return;
    renderer.requestRender();
  });
  function end(event) {
    const pointer = touches.get(event.pointerId) ?? (drag?.id === event.pointerId ? drag : null);
    if (!pointer) return;
    if (event.type === 'pointerup') update(pointer, event);
    const select = event.type === 'pointerup' && !pointer.moved && !pointer.multi
      && (touches.has(event.pointerId) || pointer.button === 0);
    touches.delete(event.pointerId);
    if (drag?.id === event.pointerId) drag = null;
    gesture = measure();
    release(event.pointerId);
    if (select) renderer.onPick(renderer.pick(event.clientX, event.clientY));
  }
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, name, end);
  listen(canvas, 'contextmenu', event => event.preventDefault());
  listen(canvas, 'wheel', event => {
    if (!renderer.frame) return;
    event.preventDefault();
    zoom(Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.0018));
    renderer.requestRender();
  }, { passive: false });
  listen(window, 'blur', reset);
  listen(document, 'visibilitychange', () => { if (document.hidden) reset(); });

  return { reset, dispose() { reset(); for (const remove of listeners) remove(); } };
}
