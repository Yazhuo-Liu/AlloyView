import { FrameCache } from './data/frame-cache.js';
import { colorsByProperty, colorsByType } from './render/palette.js';
import { WebGLRenderer } from './render/webgl-renderer.js';
import { StructureWorkerClient } from './worker-client.js';

const elements = Object.fromEntries([
  'file-input', 'open-file', 'empty-open', 'load-fcc', 'load-bcc', 'viewport',
  'empty-state', 'file-name', 'file-meta', 'format-chip', 'atom-count', 'frame-count',
  'cell-kind', 'pbc-flags', 'trajectory-section', 'frame-slider', 'frame-label', 'timestep-label',
  'cache-label', 'coordinate-mode', 'color-mode', 'radius', 'radius-value', 'projection', 'background',
  'show-cell', 'png-background', 'slice-axis', 'slice-position', 'slice-value', 'cutoff', 'run-analysis',
  'analysis-state', 'analysis-help', 'selection-empty', 'selection-data', 'clear-selection', 'legend',
  'reset-camera', 'toggle-projection', 'export-png', 'loading', 'loading-text', 'toast',
  'metric-index', 'metric-parse', 'metric-upload', 'metric-analysis', 'metric-fps',
  'metric-memory',
].map((id) => [id, document.getElementById(id)]));

const cache = new FrameCache(3);
const state = {
  file: null,
  format: null,
  frameCount: 0,
  frameIndex: 0,
  frame: null,
  selectedId: null,
  frameRequest: 0,
  colorMode: 'type',
  coordinateMode: 'wrapped',
};

let toastTimer = null;
let frameTimer = null;
let renderer;

try {
  renderer = new WebGLRenderer(elements.viewport, {
    onPick: selectAtom,
    onStats: ({ fps }) => { elements['metric-fps'].textContent = `${fps.toFixed(1)} FPS`; },
  });
} catch (error) {
  showToast(error.message);
  throw error;
}

const worker = new StructureWorkerClient(({ loaded, total, stage }) => {
  if (stage === 'index') {
    const percentage = total > 0 ? Math.round(loaded / total * 100) : 0;
    setLoading(true, `Indexing trajectory frames… ${percentage}%`);
  }
});

elements['open-file'].addEventListener('click', openPicker);
elements['empty-open'].addEventListener('click', openPicker);
elements['file-input'].addEventListener('change', () => {
  const [file] = elements['file-input'].files;
  if (file) loadFile(file);
  elements['file-input'].value = '';
});
elements['load-fcc'].addEventListener('click', () => loadExample('./examples/fcc-vacancy.cfg', 'fcc-vacancy.cfg'));
elements['load-bcc'].addEventListener('click', () => loadExample('./examples/bcc-trajectory.dump', 'bcc-trajectory.dump'));

elements['frame-slider'].addEventListener('input', () => {
  const index = Number(elements['frame-slider'].value);
  elements['frame-label'].textContent = `${index + 1} / ${state.frameCount}`;
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => showFrame(index), 70);
});

elements['color-mode'].addEventListener('change', () => {
  state.colorMode = elements['color-mode'].value;
  applyColors();
});
elements['coordinate-mode'].addEventListener('change', updateCoordinateMode);
elements.radius.addEventListener('input', () => {
  const value = Number(elements.radius.value);
  elements['radius-value'].textContent = `${value.toFixed(2)} Å`;
  setRangeProgress(elements.radius);
  renderer.setRadius(value);
});
elements.projection.addEventListener('change', () => renderer.setProjection(elements.projection.value));
elements.background.addEventListener('input', () => renderer.setBackground(elements.background.value));
elements['show-cell'].addEventListener('change', () => renderer.setCellVisible(elements['show-cell'].checked));
elements['slice-axis'].addEventListener('change', updateSlice);
elements['slice-position'].addEventListener('input', updateSlice);
elements['run-analysis'].addEventListener('click', runCoordination);
elements['clear-selection'].addEventListener('click', () => selectAtom(-1));
elements['reset-camera'].addEventListener('click', () => renderer.resetCamera());
elements['toggle-projection'].addEventListener('click', () => {
  const mode = elements.projection.value === 'perspective' ? 'orthographic' : 'perspective';
  elements.projection.value = mode;
  renderer.setProjection(mode);
});
elements['export-png'].addEventListener('click', () => {
  if (!state.frame) return;
  const stem = (state.file?.name ?? 'alloyview').replace(/\.[^.]+$/, '');
  renderer.exportPng(`${stem}-frame-${state.frameIndex + 1}.png`, {
    includeBackground: elements['png-background'].checked,
  });
});

for (const eventName of ['dragenter', 'dragover']) {
  elements.viewport.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
}
elements.viewport.addEventListener('drop', (event) => {
  event.preventDefault();
  const [file] = event.dataTransfer.files;
  if (file) loadFile(file);
});

for (const range of document.querySelectorAll('.range')) setRangeProgress(range);
window.addEventListener('beforeunload', () => worker.close());

function openPicker() { elements['file-input'].click(); }

async function loadExample(url, name) {
  try {
    setLoading(true, 'Loading example…');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Example request failed: HTTP ${response.status}`);
    const blob = await response.blob();
    await loadFile(new File([blob], name, { type: 'text/plain' }));
  } catch (error) {
    setLoading(false);
    showToast(error.message);
  }
}

async function loadFile(file) {
  const request = state.frameRequest + 1;
  state.frameRequest = request;
  setLoading(true, 'Reading local file…');
  try {
    const result = await worker.load(file);
    if (request !== state.frameRequest) return;
    cache.clear();
    cache.set(0, result.frame);
    state.file = file;
    state.format = result.format;
    state.frameCount = result.frameCount;
    state.frameIndex = 0;
    state.selectedId = null;
    state.colorMode = 'type';
    state.coordinateMode = 'wrapped';
    elements['metric-index'].textContent = formatDuration(Math.max(0, result.indexMs));
    configureSourceUi(result);
    displayFrame(result.frame, { resetCamera: true });
    elements['empty-state'].hidden = true;
    setControlsEnabled(true);
    setLoading(false);
    showToast(`Loaded ${formatInteger(result.frame.ids.length)} atoms locally.`, true);
  } catch (error) {
    if (request === state.frameRequest) {
      setLoading(false);
      showToast(error.message);
    }
  }
}

function configureSourceUi(result) {
  elements['file-name'].textContent = state.file.name;
  elements['file-meta'].textContent = `${formatBytes(state.file.size)} · local browser file`;
  elements['format-chip'].textContent = result.format === 'cfg' ? 'CFG' : 'LAMMPS';
  elements['frame-count'].textContent = formatInteger(result.frameCount);
  elements['trajectory-section'].hidden = result.frameCount <= 1;
  elements['frame-slider'].min = '0';
  elements['frame-slider'].max = String(Math.max(0, result.frameCount - 1));
  elements['frame-slider'].value = '0';
  elements['frame-label'].textContent = `1 / ${result.frameCount}`;
  setRangeProgress(elements['frame-slider']);
}

async function showFrame(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.frameCount || index === state.frameIndex) return;
  const request = state.frameRequest + 1;
  state.frameRequest = request;
  const cached = cache.get(index);
  if (cached) {
    state.frameIndex = index;
    displayFrame(cached);
    return;
  }
  setLoading(true, `Parsing frame ${index + 1}…`);
  try {
    const result = await worker.frame(index);
    if (request !== state.frameRequest) return;
    cache.set(index, result.frame);
    state.frameIndex = index;
    displayFrame(result.frame);
    setLoading(false);
  } catch (error) {
    if (request === state.frameRequest) {
      setLoading(false);
      elements['frame-slider'].value = String(state.frameIndex);
      showToast(error.message);
    }
  }
}

function displayFrame(frame, { resetCamera = false } = {}) {
  state.frame = frame;
  configureCoordinateMode(frame);
  refreshColorOptions();
  const palette = paletteForCurrentMode();
  const uploadMs = renderer.setFrame(frame, palette.colors, displayPositionsForFrame(frame));
  renderLegend(palette.legend);
  if (resetCamera) renderer.resetCamera();
  updateSlice();
  restoreSelection();
  elements['atom-count'].textContent = formatInteger(frame.ids.length);
  elements['cell-kind'].textContent = frame.cell.triclinic ? 'Triclinic' : 'Orthogonal';
  const periodicAxes = frame.cell.pbc.flatMap((periodic, axis) => (periodic ? ['XYZ'[axis]] : []));
  elements['pbc-flags'].textContent = periodicAxes.length > 0 ? periodicAxes.join(' ') : 'None';
  elements['pbc-flags'].title = `Periodic axes: ${periodicAxes.length > 0 ? periodicAxes.join(', ') : 'none'}`;
  elements['analysis-help'].textContent = periodicAxes.length > 0
    ? `Minimum images are used along ${periodicAxes.join(', ')}; non-periodic axes use direct distances. Camera movement does not rerun analysis.`
    : 'No periodic axes: all distances are direct. Camera movement does not rerun analysis.';
  elements['timestep-label'].textContent = frame.timestep === null ? 'Single frame' : `timestep ${frame.timestep}`;
  elements['frame-label'].textContent = `${state.frameIndex + 1} / ${state.frameCount}`;
  elements['frame-slider'].value = String(state.frameIndex);
  elements['cache-label'].textContent = `cache ${cache.size} / ${cache.limit}`;
  elements['metric-parse'].textContent = formatDuration(frame.parseMs);
  elements['metric-upload'].textContent = formatDuration(uploadMs);
  elements['analysis-state'].textContent = frame.properties.some((property) => property.name === 'coordination') ? 'Calculated' : 'Not calculated';
  elements['analysis-state'].classList.toggle('ready', elements['analysis-state'].textContent === 'Calculated');
  updateMemoryMetric();
  setRangeProgress(elements['frame-slider']);
}

function configureCoordinateMode(frame) {
  const unwrappedOption = elements['coordinate-mode'].querySelector('option[value="unwrapped"]');
  const available = Boolean(frame.unwrappedPositions);
  unwrappedOption.disabled = !available;
  unwrappedOption.textContent = available
    ? `Unwrapped coordinates (${frame.unwrapSource})`
    : 'Unwrapped coordinates (not available)';
  if (!available && state.coordinateMode === 'unwrapped') {
    state.coordinateMode = 'wrapped';
    showToast('This frame has no unwrapped coordinates; display returned to wrapped coordinates.');
  }
  elements['coordinate-mode'].value = state.coordinateMode;
}

function displayPositionsForFrame(frame = state.frame) {
  return state.coordinateMode === 'unwrapped' && frame?.unwrappedPositions
    ? frame.unwrappedPositions
    : frame?.positions;
}

function updateCoordinateMode() {
  if (!state.frame) return;
  const requested = elements['coordinate-mode'].value;
  if (requested === 'unwrapped' && !state.frame.unwrappedPositions) {
    elements['coordinate-mode'].value = 'wrapped';
    showToast('Unwrapped display requires xu/yu/zu, xsu/ysu/zsu, or complete ix/iy/iz image flags.');
    return;
  }
  state.coordinateMode = requested;
  elements['metric-upload'].textContent = formatDuration(renderer.setDisplayPositions(displayPositionsForFrame()));
  renderer.resetCamera();
  restoreSelection();
}

function refreshColorOptions() {
  const previous = state.colorMode;
  elements['color-mode'].replaceChildren(option('type', 'Atom type'));
  state.frame.properties.forEach((property, index) => {
    elements['color-mode'].append(option(`property:${index}`, `${property.name}${property.unit ? ` [${property.unit}]` : ''}`));
  });
  const available = [...elements['color-mode'].options].some((item) => item.value === previous);
  state.colorMode = available ? previous : 'type';
  elements['color-mode'].value = state.colorMode;
}

function applyColors() {
  if (!state.frame) return;
  try {
    const palette = paletteForCurrentMode();
    renderer.setColors(palette.colors);
    renderLegend(palette.legend);
  } catch (error) {
    showToast(error.message);
  }
}

function paletteForCurrentMode() {
  if (state.colorMode === 'type') return colorsByType(state.frame);
  const propertyIndex = Number(state.colorMode.slice('property:'.length));
  const property = state.frame.properties[propertyIndex];
  if (!property) {
    state.colorMode = 'type';
    elements['color-mode'].value = 'type';
    return colorsByType(state.frame);
  }
  return colorsByProperty(property);
}

async function runCoordination() {
  if (!state.frame) return;
  const cutoff = Number(elements.cutoff.value);
  if (!Number.isFinite(cutoff) || cutoff <= 0) {
    showToast('The cutoff radius must be greater than zero.');
    return;
  }
  const frame = state.frame;
  const frameIndex = state.frameIndex;
  elements['run-analysis'].disabled = true;
  elements['analysis-state'].textContent = 'Calculating…';
  elements['analysis-state'].classList.remove('ready');
  try {
    const result = await worker.coordination(frame, cutoff);
    if (frame !== state.frame || frameIndex !== state.frameIndex) return;
    const existing = frame.properties.findIndex((property) => property.name === 'coordination');
    const property = { name: 'coordination', unit: '', data: result.coordination };
    if (existing >= 0) frame.properties[existing] = property;
    else frame.properties.push(property);
    state.colorMode = `property:${existing >= 0 ? existing : frame.properties.length - 1}`;
    refreshColorOptions();
    applyColors();
    elements['analysis-state'].textContent = 'Calculated';
    elements['analysis-state'].classList.add('ready');
    elements['metric-analysis'].textContent = `${formatDuration(result.elapsedMs)} · ${result.engine}`;
    updateSelectionPanel();
    updateMemoryMetric();
    if (result.warning) showToast(result.warning);
  } catch (error) {
    elements['analysis-state'].textContent = 'Failed';
    showToast(error.message);
  } finally {
    elements['run-analysis'].disabled = false;
  }
}

function updateSlice() {
  const axis = Number(elements['slice-axis'].value);
  const percentage = Number(elements['slice-position'].value);
  elements['slice-value'].textContent = `${percentage}%`;
  setRangeProgress(elements['slice-position']);
  renderer.setSlice(axis, percentage / 100);
  if (state.selectedId !== null) restoreSelection();
}

function selectAtom(index) {
  if (!state.frame || index < 0 || index >= state.frame.ids.length) {
    state.selectedId = null;
    renderer.setSelected(-1);
    updateSelectionPanel();
    return;
  }
  state.selectedId = state.frame.ids[index];
  renderer.setSelected(index);
  updateSelectionPanel(index);
}

function restoreSelection() {
  if (state.selectedId === null || !state.frame) {
    renderer.setSelected(-1);
    updateSelectionPanel();
    return;
  }
  const index = state.frame.ids.findIndex((id) => id === state.selectedId);
  if (index < 0) {
    state.selectedId = null;
    renderer.setSelected(-1);
    updateSelectionPanel();
    return;
  }
  const fractional = state.frame.fractional[index * 3 + Number(elements['slice-axis'].value)];
  if (fractional > Number(elements['slice-position'].value) / 100) {
    renderer.setSelected(-1);
    updateSelectionPanel();
    return;
  }
  renderer.setSelected(index);
  updateSelectionPanel(index);
}

function updateSelectionPanel(index = null) {
  if (index === null && state.selectedId !== null && state.frame) {
    const found = state.frame.ids.findIndex((id) => id === state.selectedId);
    if (found >= 0) index = found;
  }
  if (index === null || index < 0 || !state.frame) {
    elements['selection-empty'].hidden = false;
    elements['selection-data'].hidden = true;
    elements['clear-selection'].hidden = true;
    return;
  }
  const frame = state.frame;
  const base = index * 3;
  const coordinateRows = frame.unwrappedPositions
    ? [
        ['Cartesian (wrapped)', formatVector(frame.positions, base, ' Å')],
        ['Cartesian (unwrapped)', formatVector(frame.unwrappedPositions, base, ' Å')],
        ['Fractional (wrapped)', formatVector(frame.fractional, base)],
      ]
    : [
        ['Cartesian', formatVector(frame.positions, base, ' Å')],
        ['Fractional', formatVector(frame.fractional, base)],
      ];
  const rows = [
    ['ID', String(frame.ids[index])],
    ['Type', frame.typeLabels[frame.types[index]]],
    ...coordinateRows,
    ...frame.properties.map((property) => [
      property.name,
      `${formatValue(property.data[index])}${property.unit ? ` ${property.unit}` : ''}`,
    ]),
  ];
  const fragment = document.createDocumentFragment();
  for (const [name, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = name;
    const definition = document.createElement('dd');
    definition.textContent = value;
    fragment.append(term, definition);
  }
  elements['selection-data'].replaceChildren(fragment);
  elements['selection-empty'].hidden = true;
  elements['selection-data'].hidden = false;
  elements['clear-selection'].hidden = false;
}

function renderLegend(legend) {
  elements.legend.replaceChildren();
  const title = document.createElement('div');
  title.className = 'legend-title';
  const label = document.createElement('strong');
  label.textContent = legend.title;
  title.append(label);
  if (legend.kind === 'scalar' && legend.unit) {
    const unit = document.createElement('span');
    unit.textContent = legend.unit;
    title.append(unit);
  }
  elements.legend.append(title);
  if (legend.kind === 'types') {
    const items = document.createElement('div');
    items.className = 'legend-items';
    for (const item of legend.items) {
      const row = document.createElement('span');
      row.className = 'legend-item';
      const swatch = document.createElement('i');
      swatch.className = 'legend-swatch';
      swatch.style.background = `rgb(${item.color.join(' ')})`;
      row.append(swatch, document.createTextNode(item.label));
      items.append(row);
    }
    elements.legend.append(items);
  } else {
    const gradient = document.createElement('div');
    gradient.className = 'legend-gradient';
    const range = document.createElement('div');
    range.className = 'legend-range';
    const minimum = document.createElement('span');
    minimum.textContent = formatValue(legend.minimum);
    const maximum = document.createElement('span');
    maximum.textContent = formatValue(legend.maximum);
    range.append(minimum, maximum);
    elements.legend.append(gradient, range);
  }
  elements.legend.hidden = false;
}

function setControlsEnabled(enabled) {
  for (const id of [
    'coordinate-mode', 'color-mode', 'radius', 'projection', 'background', 'show-cell', 'png-background',
    'slice-axis', 'slice-position', 'cutoff', 'run-analysis',
  ]) {
    elements[id].disabled = !enabled;
  }
}

function setLoading(visible, text = '') {
  elements.loading.hidden = !visible;
  if (text) elements['loading-text'].textContent = text;
}

function showToast(message, success = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('success', success);
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, success ? 2600 : 6500);
}

function setRangeProgress(range) {
  const minimum = Number(range.min || 0);
  const maximum = Number(range.max || 100);
  const value = Number(range.value);
  const percentage = maximum > minimum ? (value - minimum) / (maximum - minimum) * 100 : 0;
  range.style.setProperty('--range-progress', `${percentage}%`);
}

function updateMemoryMetric() {
  if (performance.memory?.usedJSHeapSize) {
    elements['metric-memory'].textContent = formatBytes(performance.memory.usedJSHeapSize);
  }
}

function option(value, label) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  return milliseconds < 1000 ? `${milliseconds.toFixed(1)} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatInteger(value) { return new Intl.NumberFormat('en-US').format(value); }

function formatValue(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 1e4 || (Math.abs(value) > 0 && Math.abs(value) < 1e-4)) return value.toExponential(5);
  return Number(value.toPrecision(7)).toString();
}

function formatVector(array, index, suffix = '') {
  return `(${formatValue(array[index])}, ${formatValue(array[index + 1])}, ${formatValue(array[index + 2])})${suffix}`;
}
