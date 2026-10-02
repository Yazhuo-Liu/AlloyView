import { FrameCache } from './data/frame-cache.js';
import { chooseFrameCachePolicy } from './data/cache-policy.js';
import { DEFAULT_PLAYBACK_INTERVAL_MS, nextPlaybackFrame } from './data/playback.js';
import { recommendCoordinationCutoff } from './analysis/cutoff.js';
import { CoordinationPool } from './analysis/coordination-pool.js';
import { AnalysisPool } from './analysis/analysis-pool.js';
import { STRUCTURE_TYPES } from './analysis/cna.js';
import { PTM_TYPES } from './analysis/ptm.js';
import { STRAIN_FIELDS } from './analysis/atomic-strain.js';
import { ELEMENT_LATTICES, STRAIN_STRUCTURES, referenceForElement, validateReferences } from './analysis/lattice.js';
import { clearAnalysisResults, replaceAnalysisProperty } from './analysis/results.js';
import {
  catalogLocalSources,
  detectStructureFormatHeader,
  inferStructureFormatFromPath,
  isPotentialStructurePath,
} from './io/file-sequences.js';
import {
  colorsByProperty,
  colorsByCategory,
  colorsByType,
  coupleScalarRange,
  SCALAR_COLOR_SCHEMES,
  visibilityByProperty,
  visibilityByCategory,
} from './render/palette.js';
import { normalizeRadiusPercent, radiiByType } from './render/atomic-radii.js';
import { WebGLRenderer } from './render/webgl-renderer.js';
import { StructureWorkerClient } from './worker-client.js';
import { initializeTheme } from './theme.js';
import { initializeSidebarResize } from './sidebar-resize.js';

const elements = Object.fromEntries([
  'file-input', 'folder-input', 'open-local', 'open-examples', 'empty-open', 'viewport',
  'empty-state', 'file-name', 'file-meta', 'format-chip', 'atom-count', 'frame-count',
  'cell-kind', 'pbc-flags', 'trajectory-section', 'frame-slider', 'frame-label', 'timestep-label',
  'cache-label', 'frame-first', 'frame-previous', 'frame-play', 'frame-next', 'frame-last', 'frame-ticks',
  'coordinate-mode', 'color-mode', 'radius-scale', 'radius-percent', 'projection-perspective', 'projection-orthographic',
  'background-picker', 'background-current', 'background', 'show-axes',
  'show-cell', 'png-background', 'png-legend', 'png-axes', 'slice-axis', 'slice-position', 'slice-value', 'cutoff', 'run-analysis',
  'analysis-state', 'cutoff-help', 'analysis-help', 'selection-empty', 'selection-data', 'clear-selection', 'legend',
  'cna-mode', 'cna-cutoff', 'cna-cutoff-field', 'run-cna', 'cna-state', 'cna-help', 'cna-status',
  'csp-neighbors', 'run-csp', 'csp-state', 'csp-status', 'metric-cna', 'metric-csp',
  'ptm-rmsd', 'run-ptm', 'ptm-state', 'ptm-status', 'metric-ptm',
  'cancel-analysis', 'cancel-cna', 'cancel-csp', 'cancel-ptm', 'cancel-strain',
  'lattice-references', 'lattice-reset', 'run-strain', 'strain-state', 'strain-status', 'metric-strain',
  'reset-camera', 'export-png', 'loading', 'loading-text', 'toast', 'interaction-hint',
  'axis-triad', 'axis-arrows', 'axis-x-line', 'axis-y-line', 'axis-z-line', 'axis-x-label', 'axis-y-label', 'axis-z-label',
  'metric-index', 'metric-parse', 'metric-upload', 'metric-analysis', 'metric-fps',
  'metric-memory',
  'source-dialog', 'source-dialog-kicker', 'source-dialog-title', 'source-dialog-summary', 'source-dialog-close', 'source-options',
].map((id) => [id, document.getElementById(id)]));

const cache = new FrameCache(3);
const scalarColorRanges = new Map();
const scalarColorSchemes = new Map();
const scalarHideOutside = new Map();
const hiddenStructureTypes = new Set();
const analysisPool = new AnalysisPool();
const coordinationPool = new CoordinationPool(analysisPool);
const analysisControllers = new Map();
const analysisTasks = new Map();
const ANALYSES = {
  cna: { prefix: 'cna', name: 'structureType', label: 'Crystal structure (CNA)', help: 'Calculate to color by crystal structure. The legend checkboxes control visibility.' },
  centrosymmetry: { prefix: 'csp', name: 'centralSymmetry', label: 'Central symmetry (normalized)', help: 'Runs on the complete structure, including hidden atoms.' },
  ptm: { prefix: 'ptm', name: 'ptmStructureType', label: 'Crystal structure (PTM)', help: 'Results include structure type, RMSD and nearest-neighbor distance.' },
  strain: { prefix: 'strain', name: 'atomicShearStrain', label: 'Atomic shear strain', help: 'Unknown numeric atom types need an element or explicit lattice parameters. This is not displacement strain between trajectory frames.' },
};
const state = {
  file: null,
  files: [],
  format: null,
  frameCount: 0,
  frameIndex: 0,
  frame: null,
  selectedId: null,
  frameRequest: 0,
  colorMode: 'type',
  coordinateMode: 'wrapped',
  radiusPercent: 100,
  source: null,
  availableSources: [],
  availableEntries: [],
  sourceVersion: 0,
  pendingFrames: new Map(),
  cachePlan: null,
  prefetchToken: 0,
  playing: false,
  references: [],
  referenceLabels: [],
  referenceByLabel: new Map(),
  analysis: {
    coordination: { enabled: false, cutoff: null, request: 0 },
    cna: { enabled: false, parameters: null, key: null, request: 0 },
    centrosymmetry: { enabled: false, parameters: null, key: null, request: 0 },
    ptm: { enabled: false, parameters: null, key: null, request: 0 },
    strain: { enabled: false, parameters: null, key: null, request: 0 },
  },
};

const FOLDER_FILE_LIMIT = 20_000;
const localPathCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

let toastTimer = null;
let frameTimer = null;
let playbackTimer = null;
let interactionHintTimer = null;
let interactionHintFadeTimer = null;
let cutoffTimer = null;
let coordinationQueue = Promise.resolve();
let loadingOwner = null;
let renderer;
let backgroundCustomized = false;

initializeSidebarResize();
initializeTheme((theme) => {
  if (!backgroundCustomized) {
    const background = theme === 'light' ? '#ffffff' : '#000000';
    if (renderer) setBackgroundColor(background, { automatic: true });
    else elements.background.value = background;
  }
});

try {
  renderer = new WebGLRenderer(elements.viewport, {
    onPick: selectAtom,
    onStats: ({ fps }) => { elements['metric-fps'].textContent = `${fps.toFixed(1)} FPS`; },
    onCameraChange: updateAxisTriad,
    onProjectionChange: syncProjectionControls,
  });
} catch (error) {
  showToast(error.message);
  throw error;
}

const worker = new StructureWorkerClient(({ loaded, total, stage }) => {
  if (stage === 'index') {
    const percentage = total > 0 ? Math.round(loaded / total * 100) : 0;
    setLoading(true, `Indexing trajectory frames… ${percentage}%`);
  } else if (stage === 'sequence-index') {
    setLoading(true, `Checking CFG sequence… ${loaded} / ${total}`);
  } else if (stage === 'sequence-unwrap') {
    setLoading(true, `Inferring continuous trajectory coordinates… ${loaded} / ${total}`);
  } else if (stage === 'series-index') {
    const percentage = total > 0 ? Math.round(loaded / total * 100) : 0;
    setLoading(true, `Indexing numbered LAMMPS dumps… ${percentage}%`);
  }
});

elements['open-local'].addEventListener('click', showLocalPicker);
elements['empty-open'].addEventListener('click', showLocalPicker);
elements['file-input'].addEventListener('change', () => {
  const entries = fileEntries(elements['file-input'].files);
  if (entries.length > 0) inspectLocalEntries(entries, {
    allowManualCfgSequence: true,
    originLabel: 'selected files',
  });
  elements['file-input'].value = '';
});
elements['folder-input'].addEventListener('change', () => {
  const entries = fileEntries(elements['folder-input'].files);
  if (entries.length > 0) inspectLocalEntries(entries, {
    originLabel: 'selected folder',
    showAllFiles: true,
  });
  elements['folder-input'].value = '';
});
elements['source-dialog-close'].addEventListener('click', () => elements['source-dialog'].close());
elements['open-examples'].addEventListener('click', showExampleChooser);

elements['frame-slider'].addEventListener('input', () => {
  stopFramePlayback();
  const index = Number(elements['frame-slider'].value);
  elements['frame-label'].textContent = `${index + 1} / ${state.frameCount}`;
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => showFrame(index), 70);
});
elements['frame-first'].addEventListener('click', () => showFrameManually(0));
elements['frame-previous'].addEventListener('click', () => showFrameManually(Math.max(0, state.frameIndex - 1)));
elements['frame-play'].addEventListener('click', toggleFramePlayback);
elements['frame-next'].addEventListener('click', () => showFrameManually(Math.min(state.frameCount - 1, state.frameIndex + 1)));
elements['frame-last'].addEventListener('click', () => showFrameManually(state.frameCount - 1));

elements['color-mode'].addEventListener('change', () => {
  state.colorMode = elements['color-mode'].value;
  applyColors();
});
elements['coordinate-mode'].addEventListener('change', updateCoordinateMode);
elements['radius-scale'].addEventListener('input', () => setRadiusPercent(elements['radius-scale'].value, { source: 'slider' }));
elements['radius-percent'].addEventListener('input', () => setRadiusPercent(elements['radius-percent'].value, { source: 'number' }));
elements['radius-percent'].addEventListener('blur', () => {
  if (elements['radius-percent'].value.trim() === '') setRadiusPercent(state.radiusPercent);
});
elements['projection-perspective'].addEventListener('click', () => renderer.setProjection('perspective'));
elements['projection-orthographic'].addEventListener('click', () => renderer.setProjection('orthographic'));
elements.background.addEventListener('input', () => setBackgroundColor(elements.background.value));
elements.background.addEventListener('change', () => { elements['background-picker'].open = false; });
for (const button of document.querySelectorAll('[data-background]')) {
  button.addEventListener('click', () => setBackgroundColor(button.dataset.background, { close: true }));
}
elements['background-picker'].addEventListener('click', (event) => {
  if (elements['background-picker'].classList.contains('is-disabled')) event.preventDefault();
});
document.addEventListener('pointerdown', (event) => {
  if (!elements['background-picker'].contains(event.target)) elements['background-picker'].open = false;
});
elements['show-axes'].addEventListener('change', syncAxisVisibility);
elements['show-cell'].addEventListener('change', () => renderer.setCellVisible(elements['show-cell'].checked));
elements['slice-axis'].addEventListener('change', updateSlice);
elements['slice-position'].addEventListener('input', updateSlice);
elements['run-analysis'].addEventListener('click', () => {
  clearTimeout(cutoffTimer);
  runCoordination({ automatic: false });
});
elements.cutoff.addEventListener('input', scheduleCutoffAnalysis);
elements.cutoff.addEventListener('change', () => scheduleCutoffAnalysis({ immediate: true }));
elements['run-cna'].addEventListener('click', () => runStructureAnalysis('cna'));
elements['run-csp'].addEventListener('click', () => runStructureAnalysis('centrosymmetry'));
elements['run-ptm'].addEventListener('click', () => runStructureAnalysis('ptm'));
elements['run-strain'].addEventListener('click', () => runStructureAnalysis('strain'));
for (const kind of Object.keys(state.analysis)) {
  const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
  elements[`cancel-${prefix}`].addEventListener('click', () => cancelAnalysis(kind));
}
elements['ptm-rmsd'].addEventListener('change', updatePtmSettings);
for (const checkbox of document.querySelectorAll('[data-ptm-template]')) checkbox.addEventListener('change', updatePtmSettings);
elements['lattice-reset'].addEventListener('click', () => {
  state.references = state.references.map((reference, type) => referenceForElement(reference.element || state.frame.typeLabels[type]));
  renderLatticeReferences();
  if (state.analysis.strain.enabled) runStructureAnalysis('strain');
});
elements['cna-mode'].addEventListener('change', () => {
  updateCnaMethodUi();
  if (state.analysis.cna.enabled) runStructureAnalysis('cna');
});
elements['cna-cutoff'].addEventListener('change', () => {
  if (state.analysis.cna.enabled && elements['cna-mode'].value === 'fixed') runStructureAnalysis('cna');
});
elements['csp-neighbors'].addEventListener('change', () => {
  if (state.analysis.centrosymmetry.enabled) runStructureAnalysis('centrosymmetry');
});
elements['clear-selection'].addEventListener('click', () => selectAtom(-1));
elements['reset-camera'].addEventListener('click', () => renderer.resetCamera());
for (const eventName of ['pointerdown', 'wheel', 'touchstart']) {
  elements.viewport.addEventListener(eventName, dismissInteractionHint, { passive: true });
}
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => renderer.setView(button.dataset.view));
}
elements['export-png'].addEventListener('click', () => {
  if (!state.frame) return;
  const stem = (state.file?.name ?? 'alloyview').replace(/\.[^.]+$/, '');
  try {
    renderer.exportPng(`${stem}-frame-${state.frameIndex + 1}.png`, {
      includeBackground: elements['png-background'].checked,
      includeAxes: elements['png-axes'].checked,
      legend: elements['png-legend'].checked ? paletteForCurrentMode().legend : null,
    });
  } catch (error) {
    showToast(error.message);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopFramePlayback();
});

syncProjectionControls('perspective');
setBackgroundColor(elements.background.value, { automatic: true });

for (const eventName of ['dragenter', 'dragover']) {
  elements.viewport.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
}
elements.viewport.addEventListener('drop', (event) => {
  event.preventDefault();
  const entries = fileEntries(event.dataTransfer.files);
  if (entries.length > 0) inspectLocalEntries(entries, {
    allowManualCfgSequence: true,
    originLabel: 'dropped files',
  });
});

for (const range of document.querySelectorAll('.range')) setRangeProgress(range);
window.addEventListener('beforeunload', () => {
  clearTimeout(cutoffTimer);
  worker.close();
  coordinationPool.close();
});

function showLocalPicker() {
  elements['source-dialog-kicker'].textContent = 'LOCAL SOURCES';
  elements['source-dialog-title'].textContent = 'Open local structures';
  elements['source-dialog-summary'].textContent = 'Choose individual files or a folder. All structure data is processed on this device.';
  elements['source-options'].replaceChildren(
    exampleOption('Choose files…', 'Files', 'Open CFG or LAMMPS files, or select multiple trajectory frames.', () => elements['file-input'].click()),
    exampleOption('Choose folder…', 'Folder', 'Browse all files and automatically detect numbered sequences.', () => elements['folder-input'].click()),
  );
  elements['source-dialog'].showModal();
}

async function inspectLocalEntries(entries, {
  allowManualCfgSequence = false,
  originLabel = 'local selection',
  showAllFiles = false,
} = {}) {
  try {
    if (entries.length > FOLDER_FILE_LIMIT) {
      throw new Error(`The selection contains more than ${formatInteger(FOLDER_FILE_LIMIT)} files. Choose a smaller structure folder.`);
    }
    setLoading(true, `Detecting structures and numbered sequences in ${originLabel}…`);
    const orderedEntries = [...entries].sort((left, right) => (
      localPathCollator.compare(left.relativePath, right.relativePath)
    ));
    const classified = await classifyStructureEntries(orderedEntries, originLabel);
    const catalog = catalogLocalSources(classified, { allowManualCfgSequence });
    if (catalog.sources.length === 0 && !showAllFiles) {
      throw new Error(await unrecognizedFilesMessage(entries.filter((entry) => isPotentialStructurePath(entry.relativePath))));
    }
    state.availableSources = catalog.sources;
    state.availableEntries = classified;
    if (catalog.sources.length === 1 && !showAllFiles) {
      await loadFiles(catalog.sources[0].files, catalog.sources[0]);
      return;
    }
    setLoading(false);
    showSourceChooser(catalog, originLabel, classified);
  } catch (error) {
    setLoading(false);
    showToast(error.message ?? String(error));
  }
}

async function classifyStructureEntries(entries, originLabel) {
  const classified = new Array(entries.length);
  let cursor = 0;
  let completed = 0;
  const scanNext = async () => {
    while (cursor < entries.length) {
      const index = cursor;
      const entry = entries[index];
      cursor += 1;
      let format = null;
      if (isPotentialStructurePath(entry.relativePath)) {
        const header = await entry.file.slice(0, 64 * 1024).text();
        const detectedFormat = detectStructureFormatHeader(header);
        const filenameHint = inferStructureFormatFromPath(entry.relativePath);
        format = detectedFormat ?? (filenameHint === 'cfg' ? 'cfg' : null);
      }
      classified[index] = { ...entry, format };
      completed += 1;
      if (completed % 25 === 0 || completed === entries.length) {
        setLoading(true, `Inspecting ${originLabel}… ${completed} / ${entries.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, scanNext));
  return classified;
}

async function unrecognizedFilesMessage(candidates) {
  const count = candidates.length;
  if (count === 0) return 'The selected folder contains no supported or numbered candidate files.';
  const first = candidates[0];
  const preview = await first.file.slice(0, 120).text();
  const compactPreview = preview.replace(/\s+/g, ' ').trim().slice(0, 72) || '(empty file)';
  return `No CFG or LAMMPS text data was recognized in ${count} candidate file${count === 1 ? '' : 's'}. First candidate: “${first.relativePath}” (${formatBytes(first.file.size)}), beginning “${compactPreview}”.`;
}

function showSourceChooser(catalog, originLabel, entries = state.availableEntries) {
  elements['source-dialog-kicker'].textContent = 'LOCAL SOURCES';
  elements['source-dialog-title'].textContent = 'Choose a structure or sequence';
  elements['source-dialog-summary'].textContent = `The browser supplied ${entries.length} files from the ${originLabel}. ${catalog.supportedCount} structure files and ${catalog.sequenceCount} numbered structure sequence${catalog.sequenceCount === 1 ? '' : 's'} were recognized.`;
  const fragment = document.createDocumentFragment();
  const sequences = catalog.sources.filter((source) => source.kind === 'sequence');
  if (sequences.length > 0) {
    fragment.append(sourceListHeading('Detected sequences', `${sequences.length}`));
    for (const source of sequences) {
      fragment.append(sourceOption(
        source,
        source.format === 'cfg' ? 'CFG sequence' : 'Dump series',
        source.detail,
      ));
    }
  }
  fragment.append(sourceListHeading('All files', `${entries.length}`));
  const sequenceByPath = new Map();
  for (const sequence of sequences) {
    for (const entry of sequence.entries) sequenceByPath.set(entry.relativePath, sequence);
  }
  const singleByPath = new Map(catalog.sources
    .filter((source) => source.kind === 'file')
    .map((source) => [source.entries[0].relativePath, source]));
  for (const entry of entries) {
    const sequence = sequenceByPath.get(entry.relativePath);
    const single = singleByPath.get(entry.relativePath);
    if (sequence) {
      fragment.append(sourceOption(
        sequence,
        'Sequence member',
        `Opens detected sequence · ${sequence.detail}`,
        entry.relativePath,
      ));
    } else if (single) {
      fragment.append(sourceOption(single, entry.format === 'cfg' ? 'CFG' : 'LAMMPS', single.detail));
    } else {
      fragment.append(sourceOption(null, 'Other', 'Not recognized as CFG or LAMMPS structure data', entry.relativePath));
    }
  }
  elements['source-options'].replaceChildren(fragment);
  elements['source-dialog'].showModal();
}

function sourceListHeading(title, count) {
  const heading = document.createElement('div');
  heading.className = 'source-list-heading';
  const label = document.createElement('strong');
  label.textContent = title;
  const total = document.createElement('small');
  total.textContent = count;
  heading.append(label, total);
  return heading;
}

function sourceOption(source, kindLabel, detailText, labelOverride = null) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-option';
  button.disabled = !source;
  const title = document.createElement('strong');
  title.textContent = labelOverride ?? source?.label ?? 'Unknown file';
  const kind = document.createElement('span');
  kind.className = 'source-option-kind';
  kind.textContent = kindLabel;
  const detail = document.createElement('small');
  detail.textContent = detailText;
  button.append(title, kind, detail);
  if (source) {
    button.addEventListener('click', () => {
      elements['source-dialog'].close();
      loadFiles(source.files, source);
    });
  }
  return button;
}

function showExampleChooser() {
  elements['source-dialog-kicker'].textContent = 'EXAMPLES';
  elements['source-dialog-title'].textContent = 'Choose an example';
  elements['source-dialog-summary'].textContent = 'Files and folders bundled under examples/.';
  const fragment = document.createDocumentFragment();
  fragment.append(sourceListHeading('examples/', '3 items'));
  fragment.append(exampleOption(
    'examples/fixed_end_climb/',
    'Folder',
    '40 numbered CFG files · NEB sequence',
    loadNebExample,
  ));
  fragment.append(exampleOption(
    'examples/fcc-vacancy.cfg',
    'CFG',
    'FCC crystal with one vacancy',
    () => loadExample('./examples/fcc-vacancy.cfg', 'fcc-vacancy.cfg'),
  ));
  fragment.append(exampleOption(
    'examples/bcc-trajectory.dump',
    'LAMMPS',
    'Multi-frame BCC text trajectory',
    () => loadExample('./examples/bcc-trajectory.dump', 'bcc-trajectory.dump'),
  ));
  elements['source-options'].replaceChildren(fragment);
  elements['source-dialog'].showModal();
}

function exampleOption(labelText, kindLabel, detailText, action) {
  const button = sourceOption(null, kindLabel, detailText, labelText);
  button.disabled = false;
  button.addEventListener('click', () => {
    elements['source-dialog'].close();
    action();
  });
  return button;
}

function fileEntries(files) {
  return [...files].map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

async function loadExample(url, name) {
  try {
    setLoading(true, 'Loading example…');
    const response = await fetch(new URL(`../${url}`, import.meta.url));
    if (!response.ok) throw new Error(`Example request failed: HTTP ${response.status}`);
    const blob = await response.blob();
    await loadFiles([new File([blob], name, { type: 'text/plain' })]);
  } catch (error) {
    setLoading(false);
    showToast(error.message);
  }
}

async function loadNebExample() {
  try {
    setLoading(true, 'Loading NEB example images…');
    const files = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const name = `replica.${index}.cfg`;
      const response = await fetch(new URL(`../examples/fixed_end_climb/${name}`, import.meta.url));
      if (!response.ok) throw new Error(`NEB example request failed for ${name}: HTTP ${response.status}`);
      return new File([await response.blob()], name, { type: 'text/plain' });
    }));
    await loadFiles(files, {
      kind: 'sequence',
      detected: true,
      label: 'examples/fixed_end_climb/',
      format: 'cfg',
    });
  } catch (error) {
    setLoading(false);
    showToast(error.message);
  }
}

async function loadFiles(inputFiles, sourceDescriptor = null) {
  clearTimeout(cutoffTimer);
  abortAnalysisJobs();
  stopFramePlayback();
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const files = [...inputFiles].sort((left, right) => collator.compare(left.name, right.name));
  const sourceVersion = state.sourceVersion + 1;
  state.sourceVersion = sourceVersion;
  state.prefetchToken += 1;
  state.pendingFrames.clear();
  const request = state.frameRequest + 1;
  state.frameRequest = request;
  setLoading(true, files.length > 1 ? `Reading ${files.length} local CFG files…` : 'Reading local file…');
  try {
    const result = await worker.load(files);
    if (request !== state.frameRequest || sourceVersion !== state.sourceVersion) return;
    cache.clear();
    state.cachePlan = chooseFrameCachePolicy(result.frame, result.frameCount, {
      heapLimit: performance.memory?.jsHeapSizeLimit,
      heapUsed: performance.memory?.usedJSHeapSize,
      deviceMemoryGiB: navigator.deviceMemory,
    });
    cache.setLimit(state.cachePlan.limit);
    cache.set(0, result.frame);
    state.file = files[0];
    state.files = files;
    state.format = result.format;
    state.frameCount = result.frameCount;
    state.frameIndex = 0;
    state.selectedId = null;
    state.colorMode = 'type';
    state.coordinateMode = 'wrapped';
    state.source = sourceDescriptor;
    state.analysis.coordination = { enabled: false, cutoff: null, request: 0 };
    state.analysis.cna = { enabled: false, parameters: null, key: null, request: 0 };
    state.analysis.centrosymmetry = { enabled: false, parameters: null, key: null, request: 0 };
    state.analysis.ptm = { enabled: false, parameters: null, key: null, request: 0 };
    state.analysis.strain = { enabled: false, parameters: null, key: null, request: 0 };
    state.references = result.frame.typeLabels.map(referenceForElement);
    state.referenceLabels = [...result.frame.typeLabels];
    state.referenceByLabel.clear();
    renderLatticeReferences(result.frame);
    hiddenStructureTypes.clear();
    elements['metric-cna'].textContent = elements['metric-csp'].textContent = '—';
    elements['metric-ptm'].textContent = elements['metric-strain'].textContent = '—';
    scalarColorRanges.clear();
    scalarColorSchemes.clear();
    scalarHideOutside.clear();
    setRadiusPercent(100);
    configureSuggestedCutoff(result.frame);
    elements['metric-index'].textContent = formatDuration(Math.max(0, result.indexMs));
    configureSourceUi(result);
    await displayFrame(result.frame, { resetCamera: true });
    elements['empty-state'].hidden = true;
    setControlsEnabled(true);
    setLoading(false);
    showInteractionHint();
    scheduleFramePrefetch(0);
    showToast(
      files.length > 1
        ? `Loaded ${result.frameCount} frames from ${files.length} local files; the first frame has ${formatInteger(result.frame.ids.length)} atoms.`
        : `Loaded ${formatInteger(result.frame.ids.length)} atoms locally.`,
      true,
    );
  } catch (error) {
    if (request === state.frameRequest) {
      setLoading(false);
      showToast(error.message);
    }
  }
}

function configureSuggestedCutoff(frame) {
  const recommendation = recommendCoordinationCutoff(frame);
  elements.cutoff.value = recommendation.value.toFixed(2);
  elements['cna-cutoff'].value = recommendation.value.toFixed(2);
  elements['cutoff-help'].textContent = `Suggested cutoff: ${recommendation.message}`;
}

function configureSourceUi(result) {
  const totalBytes = state.files.reduce((total, file) => total + file.size, 0);
  elements['file-name'].textContent = state.source?.label ?? (state.files.length > 1
    ? `${state.files[0].name} … ${state.files.at(-1).name}`
    : state.file.name);
  elements['file-meta'].textContent = state.files.length > 1
    ? `${formatBytes(totalBytes)} · ${state.files.length} local files${state.source?.detected ? ' · numbered sequence' : ''}`
    : `${formatBytes(totalBytes)} · local browser file`;
  elements['format-chip'].textContent = result.format === 'cfg'
    ? 'CFG'
    : result.format === 'cfg-sequence' ? 'CFG · sequence' : 'LAMMPS';
  elements['frame-count'].textContent = formatInteger(result.frameCount);
  elements['trajectory-section'].hidden = result.frameCount <= 1;
  elements.viewport.parentElement.classList.toggle('trajectory-visible', result.frameCount > 1);
  elements['frame-slider'].min = '0';
  elements['frame-slider'].max = String(Math.max(0, result.frameCount - 1));
  elements['frame-slider'].value = '0';
  elements['frame-label'].textContent = `1 / ${result.frameCount}`;
  renderFrameTicks(result.frameCount);
  updateFrameNavigation();
  setRangeProgress(elements['frame-slider']);
}

async function showFrame(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.frameCount) return false;
  const request = state.frameRequest + 1;
  state.frameRequest = request;
  if (index === state.frameIndex) {
    elements['frame-slider'].value = String(index);
    elements['frame-label'].textContent = `${index + 1} / ${state.frameCount}`;
    setRangeProgress(elements['frame-slider']);
    setLoading(false);
    return true;
  }
  const requiresLoad = !cache.has(index);
  if (requiresLoad) setLoading(true, `Preparing frame ${index + 1}…`);
  try {
    const frame = await getFrame(index);
    if (request !== state.frameRequest) return false;
    if (!frame) return false;
    state.frameIndex = index;
    await displayFrame(frame);
    if (requiresLoad) setLoading(false);
    scheduleFramePrefetch(index);
    return true;
  } catch (error) {
    if (request === state.frameRequest) {
      if (requiresLoad) setLoading(false);
      elements['frame-slider'].value = String(state.frameIndex);
      showToast(error.message);
    }
    return false;
  }
}

async function displayFrame(frame, { resetCamera = false } = {}) {
  abortAnalysisJobs();
  state.frame = frame;
  renderLatticeReferences(frame);
  syncAxisVisibility();
  configureCoordinateMode(frame);
  refreshColorOptions();
  const palette = paletteForCurrentMode();
  const uploadMs = renderer.setFrame(frame, palette.colors, displayPositionsForFrame(frame), radiiByType(frame));
  applyScalarVisibility(palette.legend);
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
  elements['timestep-label'].textContent = state.format === 'cfg-sequence'
    ? `frame ${state.frameIndex + 1}`
    : frame.timestep === null ? 'Single frame' : `timestep ${frame.timestep}`;
  elements['frame-label'].textContent = `${state.frameIndex + 1} / ${state.frameCount}`;
  elements['frame-slider'].value = String(state.frameIndex);
  updateCacheLabel();
  elements['metric-parse'].textContent = formatDuration(frame.parseMs);
  elements['metric-upload'].textContent = formatDuration(uploadMs);
  elements['analysis-state'].textContent = frame.properties.some((property) => property.name === 'coordination')
    ? 'Calculated'
    : state.analysis.coordination.enabled ? 'Queued' : 'Not calculated';
  elements['analysis-state'].classList.toggle('ready', elements['analysis-state'].textContent === 'Calculated');
  updateFrameNavigation();
  updateMemoryMetric();
  setRangeProgress(elements['frame-slider']);
  updateCnaMethodUi();
  const pending = [];
  const strainRequest = state.analysis.strain.request;
  for (const kind of Object.keys(ANALYSES)) {
    const prefix = ANALYSES[kind].prefix;
    elements[`${prefix}-state`].textContent = 'Not calculated';
    elements[`${prefix}-state`].classList.remove('ready');
    elements[`run-${prefix}`].disabled = false;
    elements[`${prefix}-status`].textContent = ANALYSES[kind].help;
    syncCancelButton(kind);
    if (!state.analysis[kind].enabled) continue;
    if (kind === 'strain' && state.analysis.ptm.enabled) continue;
    const task = runStructureAnalysis(kind, { automatic: true, frame });
    pending.push(kind === 'ptm' ? task.then(() => {
      if (state.analysis.strain.enabled && strainRequest === state.analysis.strain.request && frame === state.frame) return runStructureAnalysis('strain', { automatic: true, frame });
    }) : task);
  }
  if (state.analysis.coordination.enabled) pending.push(runCoordination({ automatic: true, frame, frameIndex: state.frameIndex }));
  syncCancelButton('coordination');
  await Promise.all(pending);
}

async function getFrame(index, { background = false } = {}) {
  const cached = cache.get(index);
  if (cached) return cached;
  const existing = state.pendingFrames.get(index);
  if (existing) return existing;
  const sourceVersion = state.sourceVersion;
  const pending = worker.frame(index, { reportProgress: !background })
    .then((result) => {
      if (sourceVersion !== state.sourceVersion) return null;
      cache.set(index, result.frame);
      updateCacheLabel();
      return result.frame;
    })
    .finally(() => {
      if (state.pendingFrames.get(index) === pending) state.pendingFrames.delete(index);
    });
  state.pendingFrames.set(index, pending);
  return pending;
}

function scheduleFramePrefetch(centerIndex) {
  if (state.frameCount <= 1 || !state.cachePlan) return;
  const token = state.prefetchToken + 1;
  state.prefetchToken = token;
  const indices = prefetchOrder(centerIndex, state.frameCount, state.cachePlan.limit, state.cachePlan.fullTrajectory);
  const run = async () => {
    for (const index of indices) {
      if (token !== state.prefetchToken) return;
      if (cache.has(index)) continue;
      try {
        await getFrame(index, { background: true });
        if (cache.has(centerIndex)) cache.get(centerIndex);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(() => run(), { timeout: 800 });
  else setTimeout(run, 40);
}

function prefetchOrder(center, count, limit, fullTrajectory) {
  if (fullTrajectory) return Array.from({ length: count - 1 }, (_, offset) => (center + offset + 1) % count);
  const indices = [];
  for (let distance = 1; indices.length < Math.max(0, limit - 1) && distance < count; distance += 1) {
    if (center + distance < count) indices.push(center + distance);
    if (indices.length >= limit - 1) break;
    if (center - distance >= 0) indices.push(center - distance);
  }
  return indices;
}

function renderFrameTicks(frameCount) {
  elements['frame-ticks'].replaceChildren();
  if (frameCount <= 1) return;
  const interval = frameCount <= 60 ? 5 : niceFrameInterval(frameCount);
  const frames = new Set([1, frameCount]);
  for (let frame = interval; frame < frameCount; frame += interval) frames.add(frame);
  const fragment = document.createDocumentFragment();
  for (const frame of [...frames].sort((left, right) => left - right)) {
    const tick = document.createElement('span');
    tick.className = 'frame-tick';
    tick.textContent = String(frame);
    tick.style.left = `${(frame - 1) / (frameCount - 1) * 100}%`;
    fragment.append(tick);
  }
  elements['frame-ticks'].append(fragment);
}

function niceFrameInterval(frameCount) {
  const rough = frameCount / 10;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Math.max(5, multiplier * magnitude);
}

function updateFrameNavigation() {
  const atStart = state.frameIndex <= 0;
  const atEnd = state.frameIndex >= state.frameCount - 1;
  elements['frame-first'].disabled = atStart;
  elements['frame-previous'].disabled = atStart;
  elements['frame-next'].disabled = atEnd;
  elements['frame-last'].disabled = atEnd;
  elements['frame-play'].disabled = state.frameCount <= 1;
}

function showFrameManually(index) {
  stopFramePlayback();
  void showFrame(index);
}

function toggleFramePlayback() {
  if (state.playing) {
    stopFramePlayback();
    return;
  }
  if (state.frameCount <= 1) return;
  state.playing = true;
  updatePlaybackButton();
  schedulePlaybackStep();
}

function schedulePlaybackStep() {
  clearTimeout(playbackTimer);
  playbackTimer = setTimeout(async () => {
    if (!state.playing || state.frameCount <= 1) return;
    const sourceVersion = state.sourceVersion;
    const next = nextPlaybackFrame(state.frameIndex, state.frameCount);
    const displayed = await showFrame(next);
    if (!displayed || !state.playing || sourceVersion !== state.sourceVersion) {
      stopFramePlayback();
      return;
    }
    schedulePlaybackStep();
  }, DEFAULT_PLAYBACK_INTERVAL_MS);
}

function stopFramePlayback() {
  clearTimeout(playbackTimer);
  playbackTimer = null;
  if (!state.playing) return;
  state.playing = false;
  updatePlaybackButton();
}

function updatePlaybackButton() {
  elements['frame-play'].textContent = state.playing ? '❚❚' : '▶';
  elements['frame-play'].title = state.playing ? 'Pause trajectory' : 'Play at 1 frame per second';
  elements['frame-play'].setAttribute('aria-label', state.playing ? 'Pause trajectory' : 'Play trajectory');
  elements['frame-play'].setAttribute('aria-pressed', String(state.playing));
  elements['frame-play'].classList.toggle('active', state.playing);
}

function updateCacheLabel() {
  if (!state.cachePlan) {
    elements['cache-label'].textContent = `cached ${cache.size}`;
    return;
  }
  elements['cache-label'].textContent = state.cachePlan.fullTrajectory
    ? `cached ${cache.size} / ${state.frameCount} · lazy all-frame`
    : `cached ${cache.size} / ${state.cachePlan.limit} · adaptive window`;
}

function reassessFrameCache(frame) {
  if (!state.cachePlan || state.frameCount <= 1) return;
  const revised = chooseFrameCachePolicy(frame, state.frameCount, {
    heapLimit: performance.memory?.jsHeapSizeLimit,
    heapUsed: performance.memory?.usedJSHeapSize,
    deviceMemoryGiB: navigator.deviceMemory,
  });
  if (revised.limit >= cache.limit) return;
  state.cachePlan = revised;
  state.prefetchToken += 1;
  cache.setLimit(revised.limit);
  updateCacheLabel();
}

function setRadiusPercent(rawValue, { source = 'number' } = {}) {
  const normalized = normalizeRadiusPercent(rawValue, {
    source,
    sliderMinimum: Number(elements['radius-scale'].min),
    sliderMaximum: Number(elements['radius-scale'].max),
    inputMinimum: Number(elements['radius-percent'].min),
    inputMaximum: Number(elements['radius-percent'].max),
  });
  if (!normalized) return;
  const { percentage, sliderPercentage } = normalized;
  state.radiusPercent = percentage;
  elements['radius-scale'].value = String(sliderPercentage);
  elements['radius-percent'].value = String(percentage);
  setRangeProgress(elements['radius-scale']);
  renderer.setRadiusScale(percentage / 100);
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
    showToast('Unwrapped display requires explicit image data, meaningful out-of-cell CFG coordinates, or an ordered multi-CFG sequence.');
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
  const propertyNames = new Set();
  state.frame.properties.forEach((property) => {
    if (propertyNames.has(property.name)) return;
    propertyNames.add(property.name);
    elements['color-mode'].append(option(`property:${property.name}`, `${property.displayName ?? property.name}${property.unit ? ` [${property.unit}]` : ''}`));
  });
  if (state.analysis.coordination.enabled && !propertyNames.has('coordination')) {
    elements['color-mode'].append(option('property:coordination', 'coordination (calculating…)'));
  }
  for (const [kind, { name, label, prefix }] of Object.entries(ANALYSES)) {
    if (state.analysis[kind].enabled && !propertyNames.has(name) && elements[`${prefix}-state`].textContent !== 'Failed') {
      elements['color-mode'].append(option(`property:${name}`, `${label} (calculating…)`));
    }
  }
  const available = [...elements['color-mode'].options].some((item) => item.value === previous);
  state.colorMode = available ? previous : 'type';
  elements['color-mode'].value = state.colorMode;
}

function applyColors() {
  if (!state.frame) return;
  try {
    const palette = paletteForCurrentMode();
    renderer.setColors(palette.colors);
    applyScalarVisibility(palette.legend);
    renderLegend(palette.legend);
  } catch (error) {
    showToast(error.message);
  }
}

function applyScalarVisibility(legend) {
  if (legend.kind === 'types' && legend.property?.categories) {
    renderer.setVisibility(visibilityByCategory(legend.property, hiddenStructureTypes));
    restoreSelection();
    return;
  }
  if (legend.kind !== 'scalar') {
    renderer.setVisibility(null);
    return;
  }
  renderer.setVisibility(visibilityByProperty(
    legend.property,
    legend.customRange ? { minimum: legend.minimum, maximum: legend.maximum } : null,
    scalarHideOutside.get(legend.property.name) !== false,
  ));
}

function paletteForCurrentMode() {
  if (state.colorMode === 'type') return colorsByType(state.frame);
  const propertyName = state.colorMode.slice('property:'.length);
  const property = state.frame.properties.find((candidate) => candidate.name === propertyName);
  if (!property) {
    return colorsByType(state.frame);
  }
  if (property.categories) return colorsByCategory(property, hiddenStructureTypes);
  return colorsByProperty(
    property,
    scalarColorRanges.get(property.name),
    scalarColorSchemes.get(property.name) ?? 'atomeye',
  );
}

function abortAnalysisJobs() {
  for (const controller of analysisControllers.values()) controller.abort();
  analysisControllers.clear();
  analysisTasks.clear();
}

function syncCancelButton(kind) {
  const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
  elements[`cancel-${prefix}`].disabled = !state.frame || (!state.analysis[kind].enabled
    && elements[`${prefix}-state`].textContent !== 'Failed');
}

function cancelAnalysis(kind) {
  const analysis = state.analysis[kind];
  // Invalidate results immediately, including work that has already completed
  // in a Worker but has not yet reached the UI.
  analysis.request += 1;
  analysis.enabled = false;
  if (kind === 'coordination') {
    clearTimeout(cutoffTimer);
    analysis.cutoff = null;
    if (loadingOwner === 'coordination') setLoading(false);
  } else { analysis.key = null; analysis.parameters = null; }
  analysisControllers.get(kind)?.abort();
  analysisControllers.delete(kind);
  analysisTasks.delete(kind);
  const frames = new Set([state.frame, ...cache.frames.values()]);
  for (const frame of frames) {
    if (!frame) continue;
    for (const name of clearAnalysisResults(frame, kind)) {
      scalarColorRanges.delete(name);
      scalarColorSchemes.delete(name);
      scalarHideOutside.delete(name);
    }
    if (['ptm', 'strain'].includes(kind) && !state.analysis.ptm.enabled && !state.analysis.strain.enabled) delete frame.ptm;
  }
  if (!state.analysis.cna.enabled && !state.analysis.ptm.enabled) hiddenStructureTypes.clear();
  const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
  elements[`${prefix}-state`].textContent = 'Not calculated';
  elements[`${prefix}-state`].classList.remove('ready');
  elements[`run-${prefix}`].disabled = !state.frame;
  elements[`metric-${prefix}`].textContent = '—';
  if (kind !== 'coordination') elements[`${prefix}-status`].textContent = ANALYSES[kind].help;
  syncCancelButton(kind);
  if (state.frame) {
    refreshColorOptions(); applyColors(); restoreSelection(); updateMemoryMetric();
  }
}

function updateCnaMethodUi() {
  const fixed = elements['cna-mode'].value === 'fixed';
  elements['cna-cutoff-field'].hidden = !fixed;
  elements['cna-help'].textContent = fixed
    ? 'FCC/HCP need a cutoff between the first and second shells; BCC needs one between the second and third shells. All distances are in Å.'
    : 'Adaptive CNA chooses a local cutoff for each atom. Identifies FCC, HCP, BCC and icosahedral environments; other environments are marked Other.';
}

function ptmParameters() {
  const flags = [...document.querySelectorAll('[data-ptm-template]:checked')]
    .reduce((mask, input) => mask | Number(input.dataset.ptmTemplate), 0);
  const rmsdCutoff = elements['ptm-rmsd'].valueAsNumber;
  if (!flags) throw new Error('Select at least one PTM template.');
  if (!Number.isFinite(rmsdCutoff) || rmsdCutoff < 0) throw new Error('PTM RMSD threshold must be non-negative.');
  return { flags, rmsdCutoff };
}

function updatePtmSettings() {
  if (state.analysis.ptm.enabled) runStructureAnalysis('ptm');
  if (state.analysis.strain.enabled) runStructureAnalysis('strain');
}

function renderLatticeReferences(frame = state.frame) {
  if (!frame) return;
  if (state.referenceLabels.join('\0') !== frame.typeLabels.join('\0')) {
    state.referenceLabels = [...frame.typeLabels];
    state.references = frame.typeLabels.map(label => state.referenceByLabel.get(label) ?? referenceForElement(label));
  }
  elements['lattice-references'].replaceChildren();
  state.references.forEach((reference, type) => {
    const label = frame.typeLabels[type];
    state.referenceByLabel.set(label, reference);
    const row = document.createElement('div');
    row.className = 'lattice-reference';
    const field = (caption, control) => {
      const holder = document.createElement('label');
      holder.append(document.createTextNode(caption), control);
      return holder;
    };
    const element = document.createElement('select');
    element.dataset.referenceElement = String(type);
    element.setAttribute('aria-label', `Reference element for ${label}`);
    element.append(option('', `${label} · Unknown`));
    for (const symbol of Object.keys(ELEMENT_LATTICES)) element.append(option(symbol, symbol));
    element.value = reference.element;
    const structure = document.createElement('select');
    structure.dataset.referenceStructure = String(type);
    structure.setAttribute('aria-label', `Reference crystal for ${label}`);
    for (const id of STRAIN_STRUCTURES) structure.append(option(String(id), PTM_TYPES.find(item => item.id === id).label));
    structure.value = String(reference.structure);
    const number = (axis) => {
      const input = document.createElement('input');
      input.type = 'number'; input.min = '.001'; input.step = '.001';
      input.value = Number.isFinite(reference[axis]) ? String(reference[axis]) : '';
      input.placeholder = 'Enter reference';
      input.dataset[`lattice${axis.toUpperCase()}`] = String(type);
      input.setAttribute('aria-label', `Reference ${axis} in angstroms for ${label}`);
      input.addEventListener('change', () => {
        reference[axis] = input.valueAsNumber;
        if (state.analysis.strain.enabled) runStructureAnalysis('strain');
      });
      return input;
    };
    const a = number('a'), c = number('c');
    const cField = field('c (Å)', c);
    cField.hidden = ![2, 7].includes(reference.structure);
    row.append(field(`Type ${label} · Element`, element), field('Reference crystal', structure), field('a (Å)', a), cField);
    element.addEventListener('change', () => {
      state.references[type] = referenceForElement(element.value);
      renderLatticeReferences(frame);
      if (state.analysis.strain.enabled) runStructureAnalysis('strain');
    });
    structure.addEventListener('change', () => {
      reference.structure = Number(structure.value);
      if ([2, 7].includes(reference.structure) && !Number.isFinite(reference.c)) {
        reference.c = reference.a * Math.sqrt(8 / 3);
        c.value = Number.isFinite(reference.c) ? String(reference.c) : '';
      }
      cField.hidden = ![2, 7].includes(reference.structure);
      if (state.analysis.strain.enabled) runStructureAnalysis('strain');
    });
    elements['lattice-references'].append(row);
  });
}

function storePtmResult(frame, result, parameters, expose = true) {
  if (!result.structures) return;
  frame.ptm = { key: JSON.stringify({ flags: parameters.flags, rmsdCutoff: parameters.rmsdCutoff }),
    structures: result.structures, rmsd: result.rmsd, scales: result.scales,
    deformation: result.deformation, distances: result.distances };
  if (!expose) return;
  const metadata = { analysisKind: 'ptm', analysisMs: result.elapsedMs, analysisEngine: result.engine, analysisKey: frame.ptm.key, unit: '' };
  const properties = [
    { ...metadata, name: 'ptmStructureType', displayName: 'Crystal structure (PTM)', data: result.structures, categories: PTM_TYPES },
    { ...metadata, name: 'ptmRmsd', displayName: 'PTM RMSD (best fit)', data: result.rmsd },
    { ...metadata, name: 'ptmDistance', displayName: 'PTM nearest-neighbor distance', unit: 'Å', data: result.distances },
  ];
  for (const property of properties) replaceAnalysisProperty(frame, property);
}

async function runStructureAnalysis(kind, { automatic = false, frame = state.frame } = {}) {
  if (!frame) return;
  const analysis = state.analysis[kind];
  const { prefix, name, label } = ANALYSES[kind];
  let parameters = analysis.parameters;
  try {
    if (!automatic) {
      if (kind === 'cna') parameters = { mode: elements['cna-mode'].value,
        ...(elements['cna-mode'].value === 'fixed' ? { cutoff: elements['cna-cutoff'].valueAsNumber } : {}) };
      else if (kind === 'centrosymmetry') parameters = { neighbors: Number(elements['csp-neighbors'].value) };
      else parameters = ptmParameters();
    }
    if (kind === 'strain') {
      parameters = { ...parameters, references: state.references.map(reference => ({ ...reference })) };
      validateReferences(parameters.references, frame.types);
      // Always include the templates needed by the selected reference phases.
      parameters.flags |= parameters.references.reduce((mask, reference) => mask | (1 << (reference.structure - 1)), 0);
    }
    if (parameters.mode === 'fixed' && (!Number.isFinite(parameters.cutoff) || parameters.cutoff <= 0)) {
      throw new Error('CNA cutoff must be greater than zero.');
    }
  } catch (error) {
    analysisControllers.get(kind)?.abort();
    analysis.request += 1;
    elements[`${prefix}-state`].textContent = 'Failed';
    elements[`${prefix}-state`].classList.remove('ready');
    elements[`${prefix}-status`].textContent = error.message;
    elements[`run-${prefix}`].disabled = false;
    syncCancelButton(kind);
    showToast(error.message);
    return;
  }
  analysis.enabled = true;
  analysis.parameters = parameters;
  analysis.key = JSON.stringify(parameters);
  syncCancelButton(kind);
  if (!automatic) state.colorMode = `property:${name}`;
  refreshColorOptions();
  const key = analysis.key;
  const request = ++analysis.request;
  const sourceVersion = state.sourceVersion;
  const isCurrent = () => frame === state.frame && sourceVersion === state.sourceVersion
    && analysis === state.analysis[kind] && request === analysis.request && key === analysis.key;
  analysisControllers.get(kind)?.abort();
  const controller = new AbortController();
  analysisControllers.set(kind, controller);
  const ready = property => {
    elements[`${prefix}-state`].textContent = 'Calculated';
    elements[`${prefix}-state`].classList.add('ready');
    elements[`${prefix}-status`].textContent = kind === 'cna' || kind === 'ptm'
      ? 'Use the legend checkboxes to show or hide each structure type. Filters do not change the analysis.'
      : kind === 'strain'
        ? 'Green–Lagrange strain relative to the reference lattice.'
        : `Calculated with ${parameters.neighbors} neighbors.${property.incomplete ? ` ${property.incomplete} undefined environments are gray.` : ''}`;
    elements[`metric-${prefix}`].textContent = `${formatDuration(property.analysisMs)} · ${property.analysisEngine}`;
    elements[`run-${prefix}`].disabled = false;
  };
  const cached = frame.properties.find(property => property.name === name && property.analysisKey === key);
  if (cached) {
    ready(cached); refreshColorOptions(); applyColors();
    analysisControllers.delete(kind);
    return;
  }
  elements[`run-${prefix}`].disabled = true;
  elements[`${prefix}-state`].textContent = 'Calculating…';
  elements[`${prefix}-state`].classList.remove('ready');
  try {
    const ptmKey = JSON.stringify({ flags: parameters.flags, rmsdCutoff: parameters.rmsdCutoff });
    if (kind === 'strain') {
      const ptmTask = analysisTasks.get('ptm');
      if (ptmTask?.frame === frame && ptmTask.key === ptmKey) {
        try { await ptmTask.promise; }
        catch {
          // Cancelling PTM does not cancel a separate strain request. If its
          // prerequisite was stopped, strain can obtain its own geometry fit.
          if (!isCurrent() || controller.signal.aborted) return;
        }
      }
      if (!isCurrent()) return;
    }
    const inputs = { kind, ...parameters,
      ...(kind === 'strain' && frame.ptm?.key === ptmKey ? { ptmInput: frame.ptm } : {}) };
    const task = analysisPool.analyze(frame, inputs, {
      signal: controller.signal,
      onProgress: ({ completed, total, workerCount }) => {
        if (isCurrent()) elements[`${prefix}-status`].textContent = `Analyzing frame ${state.frameIndex + 1} with ${workerCount} Worker${workerCount > 1 ? 's' : ''}… ${completed} / ${total}`;
      },
    });
    analysisTasks.set(kind, { frame, key, request, promise: task });
    const result = await task;
    if (!isCurrent()) return;
    const metadata = { unit: '', analysisKind: kind, analysisKey: key, analysisMs: result.elapsedMs,
      analysisEngine: result.engine, incomplete: result.incomplete ?? 0 };
    let properties;
    if (kind === 'ptm') {
      storePtmResult(frame, result, parameters);
      properties = [frame.properties.find(property => property.name === name)];
    } else if (kind === 'strain') {
      const visiblePtmKey = JSON.stringify(state.analysis.ptm.parameters);
      storePtmResult(frame, result, parameters, state.analysis.ptm.enabled && visiblePtmKey === ptmKey);
      const labels = { atomicShearStrain: 'Atomic shear strain', atomicHydrostaticStrain: 'Atomic hydrostatic strain',
        atomicVolumeChange: 'Atomic volume change' };
      properties = STRAIN_FIELDS.map(field => ({ ...metadata, name: field,
        displayName: labels[field] ?? `${field.replace('strain', '')} (crystal frame)`, data: result[field] }));
    } else {
      if (kind === 'centrosymmetry' && !result.centrosymmetry.some(Number.isFinite)) throw new Error('No valid central-symmetry environments: too few neighbors or coincident atoms.');
      properties = [{ ...metadata, name, displayName: label, data: result.structures ?? result.centrosymmetry,
        ...(kind === 'cna' ? { categories: STRUCTURE_TYPES } : {}) }];
    }
    for (const property of properties) replaceAnalysisProperty(frame, property);
    reassessFrameCache(frame); ready(properties[0]);
    refreshColorOptions(); applyColors(); restoreSelection(); updateMemoryMetric();
    if (result.warning) showToast(result.warning);
  } catch (error) {
    if (!isCurrent() || error.name === 'AbortError') return;
    elements[`${prefix}-state`].textContent = 'Failed';
    elements[`${prefix}-status`].textContent = error.message;
    reassessFrameCache(frame); updateMemoryMetric();
    refreshColorOptions(); showToast(error.message);
  } finally {
    if (isCurrent()) elements[`run-${prefix}`].disabled = false;
    if (analysisControllers.get(kind) === controller) analysisControllers.delete(kind);
    if (analysisTasks.get(kind)?.request === request) analysisTasks.delete(kind);
  }
}

function scheduleCutoffAnalysis({ immediate = false } = {}) {
  clearTimeout(cutoffTimer);
  const cutoff = elements.cutoff.valueAsNumber;
  if (!state.frame || elements.cutoff.disabled || !Number.isFinite(cutoff) || cutoff <= 0) return;
  // Let a multi-digit edit settle before starting a potentially large analysis.
  // Empty or incomplete number input keeps the last valid result on screen.
  cutoffTimer = setTimeout(() => runCoordination({ automatic: false }), immediate ? 0 : 300);
}

async function runCoordination({ automatic = false, frame = state.frame, frameIndex = state.frameIndex } = {}) {
  if (!frame) return;
  const analysis = state.analysis.coordination;
  const cutoff = automatic ? state.analysis.coordination.cutoff : Number(elements.cutoff.value);
  if (!Number.isFinite(cutoff) || cutoff <= 0) {
    showToast('The cutoff radius must be greater than zero.');
    return;
  }
  if (!automatic) {
    analysis.enabled = true;
    analysis.cutoff = cutoff;
    state.colorMode = 'property:coordination';
    refreshColorOptions();
  }
  syncCancelButton('coordination');
  const request = ++analysis.request;
  const sourceVersion = state.sourceVersion;
  const isCurrent = () => frame === state.frame && frameIndex === state.frameIndex && sourceVersion === state.sourceVersion
    && analysis === state.analysis.coordination && request === analysis.request
    && analysis.enabled && analysis.cutoff === cutoff;
  analysisControllers.get('coordination')?.abort();
  const controller = new AbortController();
  analysisControllers.set('coordination', controller);
  const existing = frame.properties.find((property) => property.name === 'coordination');
  if (existing?.analysisCutoff === cutoff) {
    if (frame === state.frame) {
      refreshColorOptions();
      applyColors();
      elements['analysis-state'].textContent = 'Calculated';
      elements['analysis-state'].classList.add('ready');
      elements['run-analysis'].disabled = false;
      if (loadingOwner === 'coordination') setLoading(false);
    }
    analysisControllers.delete('coordination');
    return;
  }
  elements['run-analysis'].disabled = true;
  elements['analysis-state'].textContent = 'Calculating…';
  elements['analysis-state'].classList.remove('ready');
  setLoading(true, `Calculating coordination for frame ${frameIndex + 1}…`, 'coordination');
  try {
    // Keep one analysis active. Rapid edits replace queued requests with the
    // latest cutoff rather than launching overlapping Worker pools.
    const task = coordinationQueue.then(() => {
      if (!isCurrent()) return null;
      return coordinationPool.analyze(frame, cutoff, {
        signal: controller.signal,
        onProgress: ({ completed, total, workerCount }) => {
          if (frame !== state.frame || !isCurrent()) return;
          elements['loading-text'].textContent = workerCount > 1
            ? `Calculating coordination with ${workerCount} Workers… ${completed} / ${total}`
            : 'Calculating coordination in a Worker…';
        },
      });
    });
    coordinationQueue = task.catch(() => {});
    const result = await task;
    // An edit or source change can supersede an active request. Keep its older
    // result out of the property cache and UI, including after a cache hit.
    if (!result || !isCurrent()) return;
    const property = { name: 'coordination', unit: '', data: result.coordination, analysisCutoff: cutoff,
      analysisKind: 'coordination', analysisMs: result.elapsedMs, analysisEngine: result.engine };
    replaceAnalysisProperty(frame, property);
    reassessFrameCache(frame);
    if (frame !== state.frame || frameIndex !== state.frameIndex
        || !state.analysis.coordination.enabled || state.analysis.coordination.cutoff !== cutoff) return;
    refreshColorOptions();
    applyColors();
    elements['analysis-state'].textContent = 'Calculated';
    elements['analysis-state'].classList.add('ready');
    elements['metric-analysis'].textContent = `${formatDuration(result.elapsedMs)} · ${result.engine}`;
    updateSelectionPanel();
    updateMemoryMetric();
    if (result.warning) showToast(result.warning);
  } catch (error) {
    if (isCurrent() && error.name !== 'AbortError') {
      elements['analysis-state'].textContent = 'Failed';
      showToast(error.message);
    }
  } finally {
    if (isCurrent()) {
      elements['run-analysis'].disabled = false;
      if (loadingOwner === 'coordination') setLoading(false);
    }
    if (analysisControllers.get('coordination') === controller) analysisControllers.delete('coordination');
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
  if (renderer.visibility?.[index] === 0) {
    renderer.setSelected(-1);
    elements['selection-empty'].hidden = false;
    elements['selection-data'].hidden = true;
    elements['clear-selection'].hidden = false;
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
  if (index !== null && renderer.visibility?.[index] === 0) {
    elements['selection-empty'].hidden = false;
    elements['selection-data'].hidden = true;
    elements['clear-selection'].hidden = state.selectedId === null;
    return;
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
    ...(frame.imageFlags ? [['Image flags (ix, iy, iz)', formatVector(frame.imageFlags, base)]] : []),
    ...coordinateRows,
    ...frame.properties.map((property) => [
      property.name,
      property.categories
        ? `${property.categories.find((item) => item.id === property.data[index])?.label ?? 'Other'} (${property.data[index]})`
        : `${formatValue(property.data[index])}${property.unit ? ` ${property.unit}` : ''}`,
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
    if (legend.property?.categories) items.classList.add('crystal-items');
    for (const item of legend.items) {
      const row = document.createElement(legend.property?.categories ? 'label' : 'span');
      row.className = 'legend-item';
      const swatch = document.createElement('i');
      swatch.className = 'legend-swatch';
      swatch.style.background = `rgb(${item.color.join(' ')})`;
      if (legend.property?.categories) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = item.visible;
        checkbox.dataset.structureType = String(item.id);
        checkbox.setAttribute('aria-label', `Show ${item.label} atoms`);
        row.title = item.description;
        row.classList.toggle('is-hidden', !item.visible);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) hiddenStructureTypes.delete(item.id);
          else hiddenStructureTypes.add(item.id);
          row.classList.toggle('is-hidden', !checkbox.checked);
          applyScalarVisibility(paletteForCurrentMode().legend);
        });
        row.append(checkbox);
      }
      row.append(swatch, document.createTextNode(item.label));
      if (legend.property?.categories) {
        const count = document.createElement('span');
        count.className = 'legend-count';
        count.textContent = `${formatInteger(item.count)} · ${(100 * item.count / legend.property.data.length).toFixed(1)}%`;
        row.append(count);
      }
      items.append(row);
    }
    elements.legend.append(items);
  } else {
    const gradient = document.createElement('div');
    gradient.className = 'legend-gradient';
    gradient.style.background = legend.gradient;
    const range = document.createElement('div');
    range.className = 'legend-range';
    const minimum = document.createElement('span');
    minimum.textContent = formatValue(legend.minimum);
    const maximum = document.createElement('span');
    maximum.textContent = formatValue(legend.maximum);
    range.append(minimum, maximum);
    const controls = document.createElement('div');
    controls.className = 'legend-controls';
    const schemeControl = document.createElement('label');
    schemeControl.className = 'legend-scheme';
    const schemeLabel = document.createElement('span');
    schemeLabel.textContent = 'Color map';
    const schemeSelect = document.createElement('select');
    for (const scheme of SCALAR_COLOR_SCHEMES) {
      schemeSelect.append(option(scheme.value, scheme.label));
    }
    schemeSelect.value = legend.scheme;
    schemeControl.append(schemeLabel, schemeSelect);
    const step = scalarLegendStep(legend);
    const minimumControl = legendNumberControl('Min', legend.minimum, step);
    const editableMaximum = legend.maximum > legend.minimum ? legend.maximum : legend.minimum + step;
    const maximumControl = legendNumberControl('Max', editableMaximum, step);
    const actions = document.createElement('div');
    actions.className = 'legend-actions';
    const visibility = document.createElement('label');
    visibility.className = 'legend-visibility';
    const visibilityCheckbox = document.createElement('input');
    visibilityCheckbox.type = 'checkbox';
    visibilityCheckbox.checked = scalarHideOutside.get(legend.property.name) !== false;
    visibility.append(visibilityCheckbox, document.createTextNode('Hide values outside range'));
    const automatic = document.createElement('button');
    automatic.type = 'button';
    automatic.textContent = 'Auto';
    automatic.disabled = !legend.customRange;
    actions.append(automatic);
    controls.append(schemeControl, minimumControl.label, maximumControl.label, visibility, actions);
    const applyLiveRange = (changed) => {
      const coupled = coupleScalarRange(
        minimumControl.input.valueAsNumber,
        maximumControl.input.valueAsNumber,
        changed,
        step,
      );
      if (!coupled) return;
      const { minimum: requestedMinimum, maximum: requestedMaximum } = coupled;
      // Preserve the active field's editing state (e.g. typing a decimal).
      // Only adjust its opposite bound when enforcing the ordered range.
      if (changed !== 'minimum') minimumControl.input.value = formatEditableNumber(requestedMinimum);
      if (changed !== 'maximum') maximumControl.input.value = formatEditableNumber(requestedMaximum);
      const limits = { minimum: requestedMinimum, maximum: requestedMaximum };
      scalarColorRanges.set(legend.property.name, limits);
      scalarHideOutside.set(legend.property.name, visibilityCheckbox.checked);
      const palette = colorsByProperty(legend.property, limits, legend.scheme);
      renderer.setColors(palette.colors);
      applyScalarVisibility(palette.legend);
      minimum.textContent = formatValue(requestedMinimum);
      maximum.textContent = formatValue(requestedMaximum);
      automatic.disabled = false;
    };
    minimumControl.input.addEventListener('input', () => applyLiveRange('minimum'));
    maximumControl.input.addEventListener('input', () => applyLiveRange('maximum'));
    minimumControl.input.addEventListener('change', () => applyLiveRange('minimum'));
    maximumControl.input.addEventListener('change', () => applyLiveRange('maximum'));
    schemeSelect.addEventListener('change', () => {
      scalarColorSchemes.set(legend.property.name, schemeSelect.value);
      applyColors();
    });
    visibilityCheckbox.addEventListener('change', () => {
      scalarHideOutside.set(legend.property.name, visibilityCheckbox.checked);
      const limits = scalarColorRanges.get(legend.property.name) ?? null;
      renderer.setVisibility(visibilityByProperty(legend.property, limits, visibilityCheckbox.checked));
    });
    automatic.addEventListener('click', () => {
      scalarColorRanges.delete(legend.property.name);
      applyColors();
    });
    elements.legend.append(gradient, range, controls);
  }
  elements.legend.hidden = false;
}

function legendNumberControl(name, value, step) {
  const label = document.createElement('label');
  const text = document.createElement('span');
  text.textContent = name;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = Number(value.toPrecision(8)).toString();
  label.append(text, input);
  return { label, input };
}

function scalarLegendStep(legend) {
  if (legend.property.data instanceof Uint8Array
      || legend.property.data instanceof Uint16Array
      || legend.property.data instanceof Uint32Array
      || legend.property.data instanceof Int8Array
      || legend.property.data instanceof Int16Array
      || legend.property.data instanceof Int32Array) return 1;
  const span = Math.abs(legend.dataMaximum - legend.dataMinimum);
  return span > 0 ? 10 ** Math.floor(Math.log10(span / 100)) : 0.01;
}

function formatEditableNumber(value) {
  return Number(value.toPrecision(10)).toString();
}

function updateAxisTriad(directions) {
  const origin = 48;
  const length = 35;
  const renderOrder = [];
  for (const axis of ['x', 'y', 'z']) {
    const direction = directions[axis];
    const endpointX = origin + direction.x * length;
    const endpointY = origin + direction.y * length;
    const projectedLength = Math.hypot(direction.x, direction.y);
    const unitX = projectedLength > 1e-5 ? direction.x / projectedLength : 0;
    const unitY = projectedLength > 1e-5 ? direction.y / projectedLength : -1;
    const perpendicularX = -unitY;
    const perpendicularY = unitX;
    const labelDistance = projectedLength > 0.08 ? 7.5 / projectedLength : 0;
    const line = elements[`axis-${axis}-line`];
    const label = elements[`axis-${axis}-label`];
    const group = line.parentElement;
    const shadow = group.querySelector('.axis-shadow');
    const shaftHighlight = group.querySelector('.axis-shaft-highlight');
    const cone = group.querySelector('.axis-cone');
    const coneBase = group.querySelector('.axis-cone-base');
    const coneHighlight = group.querySelector('.axis-cone-highlight');
    const depth = Math.max(0, Math.min(1, (direction.depth + 1) / 2));
    const viewAligned = projectedLength < 0.08;
    const visibleLength = projectedLength * length;
    const coneLength = Math.min(10.5 + depth * 2, Math.max(3.5, visibleLength * 0.42));
    const coneRadius = 4.2 + depth * 1.35;
    const shaftEndX = endpointX - unitX * coneLength;
    const shaftEndY = endpointY - unitY * coneLength;
    const coneSideAX = shaftEndX + perpendicularX * coneRadius;
    const coneSideAY = shaftEndY + perpendicularY * coneRadius;
    const coneSideBX = shaftEndX - perpendicularX * coneRadius;
    const coneSideBY = shaftEndY - perpendicularY * coneRadius;
    const highlightOffset = -0.85;
    const lineWidth = 4.2 + depth * 1.25;

    for (const shaft of [line, shadow]) {
      shaft.setAttribute('x2', shaftEndX.toFixed(2));
      shaft.setAttribute('y2', shaftEndY.toFixed(2));
    }
    shaftHighlight.setAttribute('x1', (origin + perpendicularX * highlightOffset).toFixed(2));
    shaftHighlight.setAttribute('y1', (origin + perpendicularY * highlightOffset).toFixed(2));
    shaftHighlight.setAttribute('x2', (shaftEndX + perpendicularX * highlightOffset).toFixed(2));
    shaftHighlight.setAttribute('y2', (shaftEndY + perpendicularY * highlightOffset).toFixed(2));
    cone.setAttribute('points', `${coneSideAX.toFixed(2)},${coneSideAY.toFixed(2)} ${endpointX.toFixed(2)},${endpointY.toFixed(2)} ${coneSideBX.toFixed(2)},${coneSideBY.toFixed(2)}`);
    coneBase.setAttribute('cx', '0');
    coneBase.setAttribute('cy', '0');
    coneBase.setAttribute('rx', (viewAligned ? coneRadius + 3 : 1.55 + depth * 0.65).toFixed(2));
    coneBase.setAttribute('ry', (viewAligned ? coneRadius + 3 : coneRadius).toFixed(2));
    coneBase.setAttribute('transform', viewAligned
      ? `translate(${origin} ${origin})`
      : `translate(${shaftEndX.toFixed(2)} ${shaftEndY.toFixed(2)}) rotate(${(Math.atan2(unitY, unitX) * 180 / Math.PI).toFixed(2)})`);
    coneHighlight.setAttribute('x1', (shaftEndX + perpendicularX * coneRadius * 0.36).toFixed(2));
    coneHighlight.setAttribute('y1', (shaftEndY + perpendicularY * coneRadius * 0.36).toFixed(2));
    coneHighlight.setAttribute('x2', (endpointX - unitX * 1.35).toFixed(2));
    coneHighlight.setAttribute('y2', (endpointY - unitY * 1.35).toFixed(2));
    label.setAttribute('x', (viewAligned ? origin : endpointX + direction.x * labelDistance).toFixed(2));
    label.setAttribute('y', (viewAligned ? origin - 9 : endpointY + direction.y * labelDistance + 3).toFixed(2));
    line.style.strokeWidth = lineWidth.toFixed(2);
    shadow.style.strokeWidth = (lineWidth + 2.8).toFixed(2);
    group.style.opacity = String(0.5 + depth * 0.5);
    for (const item of [line, shadow, shaftHighlight, cone, coneHighlight]) {
      item.style.display = viewAligned ? 'none' : '';
    }
    group.classList.toggle('view-aligned', viewAligned);

    const shaftGradient = document.getElementById(`axis-${axis}-shaft-gradient`);
    const coneGradient = document.getElementById(`axis-${axis}-cone-gradient`);
    for (const gradient of [shaftGradient, coneGradient]) {
      gradient.setAttribute('x1', (origin + perpendicularX * lineWidth).toFixed(2));
      gradient.setAttribute('y1', (origin + perpendicularY * lineWidth).toFixed(2));
      gradient.setAttribute('x2', (origin - perpendicularX * lineWidth).toFixed(2));
      gradient.setAttribute('y2', (origin - perpendicularY * lineWidth).toFixed(2));
    }
    renderOrder.push({ depth: direction.depth, group });
  }
  renderOrder.sort((left, right) => left.depth - right.depth);
  for (const { group } of renderOrder) elements['axis-arrows'].append(group);
}

function syncProjectionControls(mode) {
  for (const value of ['perspective', 'orthographic']) {
    const button = elements[`projection-${value}`];
    const active = value === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function setBackgroundColor(value, { close = false, automatic = false } = {}) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return;
  if (!automatic) backgroundCustomized = true;
  elements.background.value = value;
  renderer.setBackground(value);
  syncBackgroundControl(value);
  if (close) elements['background-picker'].open = false;
}

function syncBackgroundControl(value) {
  const normalized = value.toLowerCase();
  elements['background-current'].style.setProperty('--swatch', normalized);
  for (const button of document.querySelectorAll('[data-background]')) {
    const active = button.dataset.background.toLowerCase() === normalized;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function setControlsEnabled(enabled) {
  for (const id of [
    'coordinate-mode', 'color-mode', 'radius-scale', 'radius-percent', 'projection-perspective', 'projection-orthographic',
    'background', 'show-axes', 'show-cell', 'png-background', 'png-legend', 'png-axes',
    'slice-axis', 'slice-position', 'cutoff', 'run-analysis',
    'cna-mode', 'cna-cutoff', 'run-cna', 'csp-neighbors', 'run-csp',
    'ptm-rmsd', 'run-ptm', 'lattice-reset', 'run-strain',
  ]) {
    elements[id].disabled = !enabled;
  }
  for (const button of document.querySelectorAll('[data-view]')) button.disabled = !enabled;
  for (const input of document.querySelectorAll('[data-ptm-template], #lattice-references input, #lattice-references select')) input.disabled = !enabled;
  for (const button of document.querySelectorAll('[data-background]')) button.disabled = !enabled;
  for (const kind of Object.keys(state.analysis)) {
    const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
    if (enabled) syncCancelButton(kind);
    else elements[`cancel-${prefix}`].disabled = true;
  }
  elements['background-picker'].classList.toggle('is-disabled', !enabled);
  if (!enabled) elements['background-picker'].open = false;
  syncAxisVisibility();
}

function syncAxisVisibility() {
  const hidden = !state.frame || !elements['show-axes'].checked;
  elements['axis-triad'].toggleAttribute('hidden', hidden);
  elements['axis-triad'].setAttribute('aria-hidden', String(hidden));
}

function showInteractionHint() {
  clearTimeout(interactionHintTimer);
  clearTimeout(interactionHintFadeTimer);
  elements['interaction-hint'].classList.remove('is-hiding');
  elements['interaction-hint'].hidden = false;
  interactionHintTimer = setTimeout(dismissInteractionHint, 5000);
}

function dismissInteractionHint() {
  clearTimeout(interactionHintTimer);
  clearTimeout(interactionHintFadeTimer);
  if (elements['interaction-hint'].hidden) return;
  elements['interaction-hint'].classList.add('is-hiding');
  interactionHintFadeTimer = setTimeout(() => {
    elements['interaction-hint'].hidden = true;
    elements['interaction-hint'].classList.remove('is-hiding');
  }, 300);
}

function setLoading(visible, text = '', owner = null) {
  elements.loading.hidden = !visible;
  loadingOwner = visible ? owner : null;
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
