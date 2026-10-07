const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

/** Fit a window inside its viewport, including when the viewport is narrower
 * than the nominal minimum size. Values are pixels; persisted layouts are fractions. */
export function constrainFloatingWindow(rect, bounds, { minimumWidth = 220, minimumHeight = 180, margin = 8 } = {}) {
  if (![rect.left, rect.top, rect.width, rect.height, bounds.width, bounds.height].every(Number.isFinite)) {
    throw new Error('Floating-window positions and sizes must be finite.');
  }
  const width = Math.max(1, bounds.width), height = Math.max(1, bounds.height);
  const insetX = Math.min(margin, Math.max(0, (width - 1) / 2));
  const insetY = Math.min(margin, Math.max(0, (height - 1) / 2));
  const availableWidth = width - 2 * insetX, availableHeight = height - 2 * insetY;
  const fittedWidth = clamp(rect.width, Math.min(minimumWidth, availableWidth), availableWidth);
  const fittedHeight = clamp(rect.height, Math.min(minimumHeight, availableHeight), availableHeight);
  return { left: clamp(rect.left, insetX, width - insetX - fittedWidth),
    top: clamp(rect.top, insetY, height - insetY - fittedHeight), width: fittedWidth, height: fittedHeight };
}

export function normalizeFloatingWindow(rect, bounds) {
  return { left: rect.left / Math.max(1, bounds.width), top: rect.top / Math.max(1, bounds.height),
    width: rect.width / Math.max(1, bounds.width), height: rect.height / Math.max(1, bounds.height) };
}

export function defaultFloatingWindow(bounds, { narrow = false } = {}) {
  // Details occupies the upper right on desktop. A second view starts on
  // the opposite side, below the primary viewport's toolbar.
  // On a short phone viewport, the minimum height may move the titlebar up.
  // Start on the right as well, keeping the folded Details toggle free.
  const width = narrow ? Math.min(240, Math.max(180, bounds.width - 140))
    : Math.min(520, Math.max(240, bounds.width * .42));
  return constrainFloatingWindow({ left: narrow ? bounds.width - width - 12 : 12, top: narrow ? 112 : 56,
    width, height: Math.min(420, Math.max(190, bounds.height * .42)) }, bounds, { minimumWidth: narrow ? 180 : 220 });
}

/** Pointer gestures belong only to the titlebar/corner; canvas orbit, pan and
 * picking retain their own handlers. Keyboard arrows also move/resize the view. */
export function initializeFloatingWindow({ element, parent = element.parentElement, dragHandle, resizeHandle,
  onEdit = () => {}, onChange = () => {}, minimumWidth = 220, minimumHeight = 180 }) {
  const document = element.ownerDocument, window = document.defaultView;
  let preferred = null, rect = null, gesture = null;
  const listeners = [];
  const bounds = () => ({ width: Math.max(1, parent.clientWidth), height: Math.max(1, parent.clientHeight) });
  const isNarrow = () => window?.matchMedia?.('(max-width: 920px)').matches ?? false;
  const fit = candidate => constrainFloatingWindow(candidate, bounds(), { minimumWidth: isNarrow() ? Math.min(180, minimumWidth) : minimumWidth, minimumHeight });
  function apply(candidate) {
    rect = fit(candidate);
    Object.assign(element.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, right: 'auto', bottom: 'auto' });
    onChange(rect);
  }
  function reflow() {
    const size = bounds();
    apply(preferred ? { left: preferred.left * size.width, top: preferred.top * size.height,
      width: preferred.width * size.width, height: preferred.height * size.height }
      : defaultFloatingWindow(size, { narrow: isNarrow() }));
  }
  function commit(candidate) { apply(candidate); preferred = normalizeFloatingWindow(rect, bounds()); }
  function resized(start, dx, dy) {
    const size = bounds();
    return { ...start, width: Math.min(start.width + dx, size.width - start.left - Math.min(8, (size.width - 1) / 2)),
      height: Math.min(start.height + dy, size.height - start.top - Math.min(8, (size.height - 1) / 2)) };
  }
  function listen(target, type, callback, options) {
    target.addEventListener(type, callback, options); listeners.push(() => target.removeEventListener(type, callback, options));
  }
  function end(event, restore = false) {
    if (!gesture || (event.pointerId !== undefined && event.pointerId !== gesture.pointerId)) return;
    const current = gesture; gesture = null;
    if (restore) commit(current.rect);
    element.classList.remove('is-interacting');
    if (current.handle.hasPointerCapture?.(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
  }
  for (const [handle, mode] of [[dragHandle, 'move'], [resizeHandle, 'resize']]) {
    listen(handle, 'pointerdown', event => {
      if (event.button !== undefined && event.button !== 0 || gesture) return;
      if (mode === 'move' && event.target.closest?.('button,input,select,textarea,a')) return;
      event.preventDefault(); event.stopPropagation(); onEdit();
      handle.focus?.({ preventScroll: true });
      gesture = { mode, handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: { ...rect } };
      handle.setPointerCapture?.(event.pointerId); element.classList.add('is-interacting');
    });
    listen(handle, 'pointermove', event => {
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.handle !== handle) return;
      event.preventDefault(); event.stopPropagation();
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      commit(mode === 'move' ? { ...gesture.rect, left: gesture.rect.left + dx, top: gesture.rect.top + dy }
        : resized(gesture.rect, dx, dy));
    });
    listen(handle, 'pointerup', event => end(event));
    listen(handle, 'pointercancel', event => end(event));
    listen(handle, 'lostpointercapture', event => end(event));
    listen(handle, 'keydown', event => {
      if (event.target !== handle) return;
      if (event.key === 'Escape' && gesture) { event.preventDefault(); end({}, true); return; }
      if (event.key === 'Home') { event.preventDefault(); onEdit(); preferred = null; reflow(); return; }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); onEdit();
      const step = event.shiftKey ? 24 : 4;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      commit(mode === 'move' ? { ...rect, left: rect.left + dx, top: rect.top + dy }
        : resized(rect, dx, dy));
    });
  }
  const observer = window?.ResizeObserver ? new window.ResizeObserver(reflow) : null;
  observer?.observe(parent);
  if (!observer && window) listen(window, 'resize', reflow);
  reflow();
  return {
    reflow,
    serialize: () => normalizeFloatingWindow(rect, bounds()),
    restore(layout) { end({}); preferred = layout ? { ...layout } : null; reflow(); },
    reset() { end({}); preferred = null; reflow(); },
    dispose() { end({}); observer?.disconnect(); for (const remove of listeners) remove(); },
  };
}
