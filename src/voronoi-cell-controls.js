import { createVoronoiCellBatch, MINIMUM_VORONOI_CELL_SCALE } from './render/voronoi-cell-layer.js';

/** Geometry is an optional display step. Selected-cell inspection remains
 * bounded; full tessellations stream through the resident parallel CPU pool. */
export function initializeVoronoiCellControls({ renderer, pool, getFrame, getSelectedId,
  getSourceVersion, getResult, onEdit = () => {}, onChange = () => {}, root = document }) {
  const elements = Object.fromEntries(['show-voronoi-cell', 'show-all-voronoi-cells', 'voronoi-cell-color',
    'voronoi-cell-opacity', 'voronoi-cell-style', 'voronoi-cell-scale', 'voronoi-cell-status', 'voronoi-all-cells-status'].map(id => [id, root.getElementById(id)]));
  const defaults = () => ({ enabled: false, allEnabled: false, color: '#3b82f6', opacity: 0.5, style: 'xray', scale: 1 });
  let options = defaults(), controlsEnabled = true, cache = null, request = null, allRequest = null;
  const allStatus = message => { if (elements['voronoi-all-cells-status']) elements['voronoi-all-cells-status'].textContent = message; };
  function clearSelected() { renderer.setVoronoiCellGeometry(null, options); }
  function clearAll() { renderer.setVoronoiAllCellGeometry?.(null, options); }
  function sync(message) {
    elements['show-voronoi-cell'].checked = options.enabled;
    if (elements['show-all-voronoi-cells']) elements['show-all-voronoi-cells'].checked = options.allEnabled;
    const available = controlsEnabled && Boolean(getFrame()) && Boolean(getResult());
    elements['show-voronoi-cell'].disabled = !available;
    if (elements['show-all-voronoi-cells']) elements['show-all-voronoi-cells'].disabled = !available;
    elements['voronoi-cell-color'].value = options.color;
    elements['voronoi-cell-opacity'].value = String(options.opacity);
    for (const id of ['voronoi-cell-color', 'voronoi-cell-opacity', 'voronoi-cell-scale']) if (elements[id]) {
      elements[id].disabled = !available || !(options.enabled || options.allEnabled);
    }
    if (elements['voronoi-cell-style']) { elements['voronoi-cell-style'].value = options.style; elements['voronoi-cell-style'].disabled = !available || !options.allEnabled; }
    if (elements['voronoi-cell-scale']) elements['voronoi-cell-scale'].value = String(options.scale);
    if (message !== undefined) elements['voronoi-cell-status'].textContent = message;
  }
  function abortSelected() { request?.controller.abort(); request = null; clearSelected(); }
  function abortAll() { allRequest?.controller.abort(); allRequest = null; clearAll(); }
  function abortJobs() { abortSelected(); abortAll(); onChange(); }
  function active(job) {
    return !job.controller.signal.aborted && controlsEnabled && getFrame() === job.frame
      && getResult() === job.result && getSourceVersion() === job.version;
  }
  function included(result, atomIndex) {
    // The scientific result decides membership. Display filtering never changes
    // tessellation sites, and excluded atom selections cannot invent new cells.
    if (result.analyzedAtomIndices) {
      if (!cache.membership) cache.membership = new Set(result.analyzedAtomIndices);
      return cache.membership.has(atomIndex);
    }
    return Number.isFinite(result.atomicVolume?.[atomIndex]);
  }
  async function refreshSelected(frame, result, version) {
    const id = getSelectedId(), currentIndex = renderer.selected;
    const atomIndex = frame && id !== null && id !== undefined
      ? currentIndex >= 0 && frame.ids[currentIndex] === id ? currentIndex : frame.ids.findIndex(value => value === id) : -1;
    if (!controlsEnabled || !options.enabled || !frame || !result || atomIndex < 0 || !included(result, atomIndex)) {
      abortSelected(); onChange();
      sync(!frame ? 'Load a structure to inspect its cells.' : !result ? 'Calculate Voronoi to inspect a cell.'
        : atomIndex < 0 ? 'Select an atom to inspect its cell.' : !included(result, atomIndex)
          ? 'This atom type is excluded from the Voronoi analysis.' : 'Enable the selected-cell preview.');
      return;
    }
    if (request && request.atomIndex === atomIndex) { sync(); return request.promise; }
    request?.controller.abort(); request = null;
    function publish(geometry) {
      renderer.setVoronoiCellGeometry(geometry, options); onChange();
      const volume = result.atomicVolume?.[atomIndex], coordination = result.voronoiCoordination?.[atomIndex];
      sync(`Atom ${String(id)} · ${geometry.faceOffsets.length - 1} faces${Number.isFinite(volume) ? ` · volume ${volume.toPrecision(6)} Å³` : ''}${Number.isFinite(coordination) ? ` · coordination ${coordination}` : ''}`);
    }
    const cached = cache.cells.get(atomIndex);
    if (cached) { publish(cached); return cached; }
    clearSelected(); onChange();
    const job = { frame, result, atomIndex, version, controller: new AbortController(), promise: null };
    request = job; sync(`Constructing cell for atom ${String(id)}…`);
    job.promise = (async () => {
      try {
        const parameters = { kind: 'voronoiGeometry', atomIndex };
        if (result.selectedTypes != null) parameters.selectedTypes = result.selectedTypes;
        const geometry = await pool.analyzeCPU(frame, parameters, { signal: job.controller.signal });
        if (request !== job || !active(job) || !options.enabled || getSelectedId() !== id) return;
        cache.cells.set(atomIndex, geometry); if (cache.cells.size > 8) cache.cells.delete(cache.cells.keys().next().value);
        publish(geometry); return geometry;
      } catch (error) {
        if (request === job && error.name !== 'AbortError') sync(`Cell preview unavailable: ${error.message}`);
      } finally { if (request === job) request = null; }
    })();
    return job.promise;
  }
  async function refreshAll(frame, result, version) {
    if (!controlsEnabled || !options.allEnabled || !frame || !result) {
      if (allRequest) abortAll();
      renderer.setVoronoiAllCellGeometry?.(controlsEnabled && frame && result ? cache?.allGeometry ?? null : null, options); onChange();
      allStatus(!frame ? 'Load a structure to display its cells.' : !result ? 'Calculate Voronoi to display all cells.'
        : 'Enable all cells to display the complete analyzed tessellation.');
      return;
    }
    if (allRequest) {
      renderer.setVoronoiAllCellGeometry(allRequest.geometry, options); onChange(); return allRequest.promise;
    }
    if (cache.allGeometry) {
      renderer.setVoronoiAllCellGeometry(cache.allGeometry, options); onChange();
      allStatus(`${cache.allGeometry.cellCount.toLocaleString()} cells displayed.`); return cache.allGeometry;
    }
    const geometry = { chunks: [], cellCount: 0, complete: false };
    const job = { frame, result, version, geometry, controller: new AbortController(), promise: null };
    allRequest = job; clearAll(); onChange(); allStatus('Constructing all analyzed cells…');
    job.promise = (async () => {
      let lastComparison = 0;
      try {
        const parameters = { kind: 'voronoiGeometryBatch', atomIndices: result.analyzedAtomIndices ?? null };
        if (result.selectedTypes != null) parameters.selectedTypes = result.selectedTypes;
        const batch = await pool.analyzeCPU(frame, parameters, { signal: job.controller.signal, retainCells: false,
          async onGeometryChunk(cells, progress = {}) {
            if (allRequest !== job || !active(job) || !options.allEnabled) return;
            // Rendering chunks are capped independently of the native worker
            // work unit, so a returned group never becomes a giant allocation.
            for (let start = 0; start < cells.length; start += 128) {
              if (allRequest !== job || !active(job) || !options.allEnabled) return;
              const chunk = createVoronoiCellBatch(cells.slice(start, start + 128));
              geometry.chunks.push(chunk); geometry.cellCount += chunk.cellCount;
              renderer.setVoronoiAllCellGeometry(geometry, options);
              // Yield between bounded uploads, including to the checkbox used
              // to cancel a large optional tessellation display.
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            if (allRequest !== job || !active(job) || !options.allEnabled) return;
            renderer.setVoronoiAllCellGeometry(geometry, options);
            allStatus(`Constructing cells… ${geometry.cellCount.toLocaleString()}${progress.totalAtoms ? ` / ${progress.totalAtoms.toLocaleString()}` : ''}`);
            const now = Date.now();
            if (now - lastComparison > 120) { lastComparison = now; onChange(); }
          },
        });
        if (allRequest !== job || !active(job) || !options.allEnabled) return;
        // Compatibility with pools without the streaming callback still keeps
        // each rendering upload bounded and never silently omits any cell.
        if (!geometry.cellCount && batch.cells?.length) for (let start = 0; start < batch.cells.length; start += 128) {
          const chunk = createVoronoiCellBatch(batch.cells.slice(start, start + 128));
          geometry.chunks.push(chunk); geometry.cellCount += chunk.cellCount;
        }
        const expected = batch.analyzedAtomIndices?.length ?? result.analyzedAtomIndices?.length;
        if (expected !== undefined && geometry.cellCount !== expected) throw new Error(`Received ${geometry.cellCount} of ${expected} analyzed cells.`);
        geometry.complete = true; cache.allGeometry = geometry;
        renderer.setVoronoiAllCellGeometry(geometry, options); onChange();
        allStatus(`${geometry.cellCount.toLocaleString()} cells displayed${batch.workerCount ? ` · ${batch.workerCount} Workers` : ''}.`);
        return geometry;
      } catch (error) {
        if (allRequest === job) {
          clearAll(); onChange();
          if (error.name !== 'AbortError') allStatus(`All-cell display unavailable: ${error.message}`);
        }
      } finally { if (allRequest === job) allRequest = null; }
    })();
    return job.promise;
  }
  function refresh() {
    const frame = getFrame(), result = getResult(), version = getSourceVersion();
    if (!cache || cache.frame !== frame || cache.result !== result || cache.version !== version) {
      abortJobs(); cache = { frame, result, version, cells: new Map(), allGeometry: null, membership: null };
    }
    return Promise.all([refreshSelected(frame, result, version), refreshAll(frame, result, version)]);
  }
  for (const id of ['show-voronoi-cell', 'show-all-voronoi-cells', 'voronoi-cell-color', 'voronoi-cell-opacity', 'voronoi-cell-style', 'voronoi-cell-scale']) elements[id]?.addEventListener('change', () => {
    onEdit(); options = { enabled: elements['show-voronoi-cell'].checked, allEnabled: elements['show-all-voronoi-cells']?.checked ?? false,
      color: elements['voronoi-cell-color'].value, opacity: Math.max(0, Math.min(1, Number(elements['voronoi-cell-opacity'].value) || 0)),
      style: elements['voronoi-cell-style']?.value === 'surface' ? 'surface' : 'xray',
      scale: Math.max(MINIMUM_VORONOI_CELL_SCALE, Math.min(1, Number(elements['voronoi-cell-scale']?.value) || 1)) };
    void refresh();
  });
  sync();
  return {
    refresh, abortJobs, serialize: () => ({ ...options }),
    restore(saved) { options = { ...defaults(), ...saved }; sync(); return refresh(); },
    reset() { abortJobs(); cache = null; options = defaults(); sync('Select an atom to inspect its cell.'); allStatus('Enable all cells to display the complete analyzed tessellation.'); },
    setEnabled(enabled) { controlsEnabled = Boolean(enabled); void refresh(); },
  };
}
