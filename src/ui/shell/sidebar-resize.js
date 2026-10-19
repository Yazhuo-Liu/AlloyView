const DEFAULT_WIDTH = 342;
const MIN_WIDTH = 280;
const MAX_WIDTH = 640;
const MIN_VIEWPORT_WIDTH = 480;
const STORAGE_KEY = 'alloyview-sidebar-width';

export function initializeSidebarResize() {
  const workspace = document.getElementById('workspace');
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resizer');
  const narrow = matchMedia('(max-width: 920px)');
  let preferredWidth = DEFAULT_WIDTH;
  let drag = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null && Number.isFinite(Number(saved))) preferredWidth = Number(saved);
  } catch { /* Layout preferences are optional. */ }

  function maximumWidth() {
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, workspace.clientWidth - MIN_VIEWPORT_WIDTH - 8));
  }

  function syncWidth() {
    const maximum = maximumWidth();
    const width = Math.round(Math.max(MIN_WIDTH, Math.min(maximum, preferredWidth)));
    workspace.style.setProperty('--sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    handle.setAttribute('aria-valuemax', String(maximum));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `${width} pixels wide`);
  }

  function saveWidth() {
    try { localStorage.setItem(STORAGE_KEY, String(preferredWidth)); } catch { /* Storage is optional. */ }
  }

  function finishDrag() {
    if (!drag) return;
    const pointerId = drag.pointerId;
    drag = null;
    document.body.classList.remove('is-resizing-sidebar');
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    saveWidth();
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || narrow.matches) return;
    event.preventDefault();
    handle.focus();
    drag = { pointerId: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-sidebar');
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    preferredWidth = Math.max(MIN_WIDTH, Math.min(maximumWidth(), drag.width + drag.x - event.clientX));
    syncWidth();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(name, finishDrag);
  window.addEventListener('blur', finishDrag);

  function resetWidth() {
    preferredWidth = DEFAULT_WIDTH;
    syncWidth();
    saveWidth();
  }
  handle.addEventListener('dblclick', resetWidth);
  handle.addEventListener('keydown', (event) => {
    if (narrow.matches) return;
    const width = sidebar.getBoundingClientRect().width;
    const step = event.shiftKey ? 40 : 20;
    if (event.key === 'ArrowLeft') preferredWidth = Math.min(maximumWidth(), width + step);
    else if (event.key === 'ArrowRight') preferredWidth = Math.max(MIN_WIDTH, width - step);
    else if (event.key === 'Home') preferredWidth = MIN_WIDTH;
    else if (event.key === 'End') preferredWidth = maximumWidth();
    else if (event.key === 'Enter') { event.preventDefault(); resetWidth(); return; }
    else return;
    event.preventDefault();
    syncWidth();
    saveWidth();
  });
  window.addEventListener('resize', syncWidth);
  narrow.addEventListener('change', () => {
    finishDrag();
    syncWidth();
  });
  syncWidth();
}
