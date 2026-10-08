import { DEFAULT_EXPORT_RESOLUTION, normalizeExportResolution, resolveExportSize } from './render/export-resolution.js';

export function initializeExportResolutionControls({ renderer, onEdit = () => {}, notify = () => {} }) {
  const mode = document.getElementById('export-resolution'), width = document.getElementById('export-width');
  const height = document.getElementById('export-height'), lock = document.getElementById('export-aspect-lock');
  const custom = document.getElementById('export-custom-size'), status = document.getElementById('export-size-status');
  let enabled = false, ratio = DEFAULT_EXPORT_RESOLUTION.width / DEFAULT_EXPORT_RESOLUTION.height, previousMode = 'current';
  let lastSize = { width: DEFAULT_EXPORT_RESOLUTION.width, height: DEFAULT_EXPORT_RESOLUTION.height };
  const currentAspect = () => {
    const value = renderer.canvas.width / renderer.canvas.height;
    return Number.isFinite(value) && value > 0 ? value : lastSize.width / lastSize.height;
  };
  function getState() {
    let size = { width: width.valueAsNumber, height: height.valueAsNumber };
    if (mode.value !== 'custom') {
      try { normalizeExportResolution(size); } catch { size = lastSize; }
    }
    const value = normalizeExportResolution({ mode: mode.value, ...size, lockAspect: lock.checked });
    lastSize = { width: value.width, height: value.height };
    return value;
  }
  function refresh() {
    custom.hidden = mode.value !== 'custom';
    mode.disabled = !enabled;
    for (const element of [width, height, lock]) element.disabled = !enabled || custom.hidden;
    try {
      const settings = getState();
      // Current viewport keeps the legacy capture's dimensions and limits.
      // The chosen-resolution budget applies only to new offscreen targets.
      const size = settings.mode === 'current' ? { width: renderer.canvas.width, height: renderer.canvas.height }
        : resolveExportSize(settings, renderer.canvas.width, renderer.canvas.height);
      status.textContent = `${size.width.toLocaleString()} × ${size.height.toLocaleString()} pixels · ${(size.width * size.height / 1e6).toFixed(2)} MP`;
      status.classList.remove('error');
    } catch (error) { status.textContent = error.message; status.classList.add('error'); }
  }
  function changed(event) {
    if (event.target === mode && mode.value !== 'custom') {
      const saved = getState(); width.value = String(saved.width); height.value = String(saved.height);
    }
    if (event.target === mode && mode.value === 'custom' && previousMode !== 'custom') {
      try {
        const size = resolveExportSize({ mode: previousMode }, renderer.canvas.width, renderer.canvas.height);
        width.value = String(size.width); height.value = String(size.height);
      } catch { /* Preserve the last valid custom dimensions if a scaled viewport is too large. */ }
      ratio = lock.checked ? currentAspect() : width.valueAsNumber / height.valueAsNumber;
      if (lock.checked && Number.isFinite(width.valueAsNumber)) height.value = String(Math.max(1, Math.round(width.valueAsNumber / ratio)));
    } else if (event.target === lock && lock.checked) {
      ratio = currentAspect();
      if (Number.isFinite(width.valueAsNumber)) height.value = String(Math.max(1, Math.round(width.valueAsNumber / ratio)));
    } else if (lock.checked && event.target === width && Number.isFinite(width.valueAsNumber)) {
      ratio = currentAspect(); height.value = String(Math.max(1, Math.round(width.valueAsNumber / ratio)));
    } else if (lock.checked && event.target === height && Number.isFinite(height.valueAsNumber)) {
      ratio = currentAspect(); width.value = String(Math.max(1, Math.round(height.valueAsNumber * ratio)));
    }
    previousMode = mode.value;
    onEdit(); refresh();
    try { getState(); } catch (error) { notify(error.message); }
  }
  for (const element of [mode, width, height, lock]) element.addEventListener('change', changed);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => requestAnimationFrame(refresh)) : null;
  observer?.observe(renderer.canvas);
  refresh();
  return { getState, getOptions: () => ({ resolution: getState() }), refresh,
    setEnabled(value) { enabled = Boolean(value); refresh(); },
    restore(value) {
      const saved = normalizeExportResolution(value);
      mode.value = saved.mode; width.value = String(saved.width); height.value = String(saved.height); lock.checked = saved.lockAspect;
      previousMode = saved.mode; ratio = saved.width / saved.height; lastSize = { width: saved.width, height: saved.height }; refresh();
    },
    dispose() { observer?.disconnect(); for (const element of [mode, width, height, lock]) element.removeEventListener('change', changed); },
  };
}
