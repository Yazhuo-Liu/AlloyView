import { add, scale } from './math.js';

const TAP_DISTANCE = 4;
// A second tap or click on the same atom within this time and distance makes
// it the rotation center, like AtomEye's right-click anchor.
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PIXELS = 12;

// Pointer Events keep mouse controls and touch gestures on the same canvas.
export function installCameraInteractions(renderer) {
  const { canvas } = renderer;
  const document = canvas.ownerDocument;
  const window = document?.defaultView;
  const touches = new Map();
  const listeners = [];
  let drag = null, gesture = null, marquee = null, selectionJob = 0, lastTap = null;

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
    drag = gesture = lastTap = null;
    cancelBox();
    for (const id of ids) release(id);
  }
  function hideMarquee() { marquee?.remove(); marquee = null; }
  function cancelBox() {
    selectionJob += 1;
    renderer.selectionController?.abort();
    hideMarquee();
  }
  function showMarquee(pointer) {
    const parent = canvas.parentElement;
    if (!parent || !document?.createElement) return;
    if (!marquee) {
      marquee = document.createElement('div');
      marquee.className = 'selection-marquee';
      marquee.setAttribute('aria-hidden', 'true');
      Object.assign(marquee.style, { position: 'absolute', pointerEvents: 'none', zIndex: '6', boxSizing: 'border-box',
        border: '1px solid var(--cyan, #2bb8c7)', background: 'rgba(43, 184, 199, 0.15)' });
      parent.append(marquee);
    }
    const bounds = parent.getBoundingClientRect();
    const viewport = canvas.getBoundingClientRect();
    const x0 = Math.max(viewport.left, Math.min(viewport.left + viewport.width, pointer.startX));
    const y0 = Math.max(viewport.top, Math.min(viewport.top + viewport.height, pointer.startY));
    const x1 = Math.max(viewport.left, Math.min(viewport.left + viewport.width, pointer.x));
    const y1 = Math.max(viewport.top, Math.min(viewport.top + viewport.height, pointer.y));
    Object.assign(marquee.style, { left: `${Math.min(x0, x1) - bounds.left - (parent.clientLeft ?? 0) + (parent.scrollLeft ?? 0)}px`,
      top: `${Math.min(y0, y1) - bounds.top - (parent.clientTop ?? 0) + (parent.scrollTop ?? 0)}px`,
      width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
  }
  function finishBox(pointer) {
    const interaction = renderer.selectionInteraction;
    const job = ++selectionJob;
    void renderer.selectInRectangle({ left: pointer.startX, top: pointer.startY, right: pointer.x, bottom: pointer.y }).then(indices => {
      if (job !== selectionJob) return;
      if (interaction !== renderer.selectionInteraction) { hideMarquee(); return; }
      hideMarquee();
      return interaction.onBox?.(indices);
    }).catch(error => {
      if (job !== selectionJob) return;
      hideMarquee();
      if (error.name !== 'AbortError') interaction.onError?.(error);
    });
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
    if (renderer.projectionMode === 'orthographic') {
      const aspect = Math.max(1, canvas.width || canvas.clientWidth || 1)
        / Math.max(1, canvas.height || canvas.clientHeight || 1);
      // Match the precise field-width control, so wheel/pinch gestures do not
      // jump out of a valid narrow parallel view after a numeric edit.
      renderer.orthographicScale = Math.max(0.001 / (2 * aspect), renderer.orthographicScale * factor);
    }
    else renderer.distance = Math.max(0.02, renderer.distance * factor);
  }
  function rotate(dx, dy) {
    renderer.orbitCamera(-dx * 0.008, dy * 0.008);
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
    canvas.focus?.({ preventScroll: true });
    if (event.pointerType === 'touch') {
      event.preventDefault();
      if (drag) { const id = drag.id; drag = null; release(id); }
      touches.set(event.pointerId, { ...point(event), mode: renderer.selectionInteraction?.mode === 'box' ? 'box' : 'rotate' });
      if (touches.size >= 2) {
        cancelBox();
        for (const pointer of touches.values()) { pointer.multi = true; pointer.mode = 'rotate'; }
      } else if (renderer.selectionInteraction?.mode === 'box') {
        cancelBox(); showMarquee(touches.get(event.pointerId));
      }
      gesture = measure(); // Rebase when fingers are added; never move the camera here.
    } else {
      if (touches.size || drag || ![0, 1, 2].includes(event.button)) return;
      cancelBox();
      drag = { ...point(event), mode: event.button !== 0 || event.shiftKey ? 'pan'
        : renderer.selectionInteraction?.mode === 'box' ? 'box' : 'rotate', button: event.button };
      if (drag.mode === 'box') { event.preventDefault(); showMarquee(drag); }
    }
    canvas.setPointerCapture(event.pointerId);
  });
  listen(canvas, 'pointermove', event => {
    const pointer = touches.get(event.pointerId);
    if (pointer) {
      event.preventDefault();
      const [dx, dy] = update(pointer, event);
      if (touches.size >= 2) transformTouches(measure());
      else if (pointer.mode === 'box') showMarquee(pointer);
      else rotate(dx, dy);
    } else if (drag?.id === event.pointerId) {
      const [dx, dy] = update(drag, event);
      if (drag.mode === 'box') { event.preventDefault(); showMarquee(drag); }
      else if (drag.mode === 'pan') pan(dx, dy);
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
    if (pointer.mode === 'box') {
      if (event.type === 'pointerup' && pointer.moved && !pointer.multi && renderer.selectionInteraction?.mode === 'box') finishBox(pointer);
      else cancelBox();
    } else if (select) {
      const atom = renderer.pick(event.clientX, event.clientY);
      // The picked replica's position, read before handlers can pick again.
      const position = renderer.lastPick?.index === atom ? renderer.lastPick.position : null;
      if (renderer.selectionInteraction?.mode === 'click' && renderer.selectionInteraction.onPick) renderer.selectionInteraction.onPick(atom);
      else renderer.onPick(atom);
      const time = event.timeStamp ?? performance.now();
      // Picking modes (measurement, slice or group picking) own repeated clicks.
      if (position && (renderer.allowsDoubleTapAnchor?.() ?? true) && lastTap?.atom === atom && time - lastTap.time <= DOUBLE_TAP_MS
          && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= DOUBLE_TAP_PIXELS) {
        renderer.centerOnPoint(position);
        lastTap = null;
      } else lastTap = position ? { atom, time, x: event.clientX, y: event.clientY } : null;
    }
  }
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, name, end);
  // As with native double-clicks, pressing anything else in between starts over.
  listen(document, 'pointerdown', event => { if (event.target !== canvas) lastTap = null; }, true);
  listen(canvas, 'contextmenu', event => event.preventDefault());
  listen(canvas, 'wheel', event => {
    if (!renderer.frame) return;
    event.preventDefault();
    if (drag?.mode === 'box' || [...touches.values()].some(pointer => pointer.mode === 'box')) reset();
    else cancelBox();
    zoom(Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.0018));
    renderer.requestRender();
  }, { passive: false });
  listen(window, 'blur', reset);
  listen(document, 'keydown', event => { if (event.key === 'Escape') reset(); });
  listen(document, 'visibilitychange', () => { if (document.hidden) reset(); });

  return { reset, dispose() { reset(); for (const remove of listeners) remove(); } };
}
