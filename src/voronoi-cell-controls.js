/** Inspect a single cell through the resident pool. Whole-structure Voronoi
 * results and analysis inputs are never modified by this display option. */
export function initializeVoronoiCellControls({ renderer, pool, getFrame, getSelectedId,
  getSourceVersion, getResult, onEdit = () => {}, onChange = () => {}, root = document }) {
  const elements = Object.fromEntries(['show-voronoi-cell', 'voronoi-cell-color', 'voronoi-cell-opacity', 'voronoi-cell-status']
    .map(id => [id, root.getElementById(id)]));
  let options = { enabled: false, color: '#008b95', opacity: 0.22 }, controlsEnabled = true;
  let cache = new WeakMap(), request = null;
  function clear() { renderer.setVoronoiCellGeometry(null, options); onChange(); }
  function sync(message) {
    elements['show-voronoi-cell'].checked = options.enabled;
    const available = controlsEnabled && Boolean(getFrame()) && Boolean(getResult());
    elements['show-voronoi-cell'].disabled = !available;
    elements['voronoi-cell-color'].value = options.color;
    elements['voronoi-cell-opacity'].value = String(options.opacity);
    for (const id of ['voronoi-cell-color', 'voronoi-cell-opacity']) elements[id].disabled = !available || !options.enabled;
    if (message !== undefined) elements['voronoi-cell-status'].textContent = message;
  }
  function abortJobs() { request?.controller.abort(); request = null; clear(); }
  async function refresh() {
    const frame = getFrame(), id = getSelectedId(), result = getResult();
    const currentIndex = renderer.selected;
    const atomIndex = frame && id !== null && id !== undefined
      ? currentIndex >= 0 && frame.ids[currentIndex] === id ? currentIndex : frame.ids.findIndex(value => value === id) : -1;
    const version = getSourceVersion();
    if (!controlsEnabled || !options.enabled || !frame || !result || atomIndex < 0) {
      abortJobs();
      sync(!frame ? 'Load a structure to inspect its cells.' : !result ? 'Calculate Voronoi to inspect a cell.'
        : atomIndex < 0 ? 'Select an atom to inspect its cell.' : 'Enable the selected-cell preview.');
      return;
    }
    if (request && request.frame === frame && request.atomIndex === atomIndex && request.version === version) { sync(); return request.promise; }
    request?.controller.abort(); request = null;
    let cells = cache.get(frame);
    if (!cells) { cells = new Map(); cache.set(frame, cells); }
    const cached = cells.get(atomIndex);
    function publish(geometry) {
      renderer.setVoronoiCellGeometry(geometry, options); onChange();
      const volume = result.atomicVolume?.[atomIndex], coordination = result.voronoiCoordination?.[atomIndex];
      sync(`Atom ${String(id)} · ${geometry.faceOffsets.length - 1} faces${Number.isFinite(volume) ? ` · volume ${volume.toPrecision(6)} Å³` : ''}${Number.isFinite(coordination) ? ` · coordination ${coordination}` : ''}`);
    }
    if (cached) { publish(cached); return cached; }
    clear();
    const job = { frame, atomIndex, version, controller: new AbortController(), promise: null };
    request = job; sync(`Constructing cell for atom ${String(id)}…`);
    job.promise = (async () => {
      try {
        const geometry = await pool.analyzeCPU(frame, { kind: 'voronoiGeometry', atomIndex }, { signal: job.controller.signal });
        if (request !== job || job.controller.signal.aborted || getFrame() !== frame || getSourceVersion() !== version || getSelectedId() !== id) return;
        cells.set(atomIndex, geometry); if (cells.size > 8) cells.delete(cells.keys().next().value);
        publish(geometry); return geometry;
      } catch (error) {
        if (request === job && error.name !== 'AbortError') sync(`Cell preview unavailable: ${error.message}`);
      } finally { if (request === job) request = null; }
    })();
    return job.promise;
  }
  for (const id of ['show-voronoi-cell', 'voronoi-cell-color', 'voronoi-cell-opacity']) elements[id].addEventListener('change', () => {
    onEdit(); options = { enabled: elements['show-voronoi-cell'].checked, color: elements['voronoi-cell-color'].value,
      opacity: Math.max(0, Math.min(1, Number(elements['voronoi-cell-opacity'].value) || 0)) };
    void refresh();
  });
  sync();
  return {
    refresh, abortJobs, serialize: () => ({ ...options }),
    restore(saved) { options = { enabled: saved?.enabled ?? false, color: saved?.color ?? '#008b95', opacity: saved?.opacity ?? 0.22 }; sync(); return refresh(); },
    reset() { abortJobs(); cache = new WeakMap(); options = { enabled: false, color: '#008b95', opacity: 0.22 }; sync('Select an atom to inspect its cell.'); },
    setEnabled(enabled) { controlsEnabled = Boolean(enabled); void refresh(); },
  };
}
