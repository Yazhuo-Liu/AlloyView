import { FrameCache } from './data/frame-cache.js';
import { ColorQuantityResolver, colorPropertyKey, initialColorQuantities } from './render/color-quantities.js';
import { colorsByDiscreteProperty, discreteValues } from './render/discrete-colors.js';
import { DEFAULT_ORIENTATION_SETTINGS, OrientationColorResolver, drawIpfKey, normalizeOrientationSettings, ORIENTATION_COLOR_MODES } from './render/orientation-colors.js';
import { framePreparationSignal } from './data/frame-preparation.js';
import { findAtomIndex } from './appearance.js';
import { chooseFrameCachePolicy, estimateFrameBytes } from './data/cache-policy.js';
import { normalizeRepetitions } from './render/replication.js';
import { GpuPrefetchScheduler } from './data/gpu-prefetch.js';
import { CpuPrefetchScheduler } from './data/cpu-prefetch.js';
import { DEFAULT_PLAYBACK_INTERVAL_MS, nextPlaybackFrame } from './data/playback.js';
import { recommendCoordinationCutoff, COORDINATION_CUTOFF_PRESETS,
  coordinationCutoffPresetForElement, inferCoordinationCutoffPreset } from './analysis/cutoff.js';
import { CoordinationPool } from './analysis/coordination-pool.js';
import { AnalysisPool } from './analysis/analysis-pool.js';
import { CpuBudget } from './analysis/cpu-budget.js';
import { DxaClient } from './analysis/dxa-client.js';
import { analysisProgressText as formatAnalysisProgress, analysisBackendLabel, analysisBackendDetails } from './analysis/status.js';
import { STRUCTURE_TYPES } from './analysis/cna.js';
import { PTM_ORDERING_TYPES, PTM_TYPES } from './analysis/ptm.js';
import { STRAIN_FIELDS } from './analysis/atomic-strain.js';
import { ELEMENT_LATTICES, STRAIN_STRUCTURES, referenceForElement, validateReferences } from './analysis/lattice.js';
import { estimateLatticeReferences } from './analysis/lattice-estimate.js';
import { clearAnalysisResults, replaceAnalysisProperty } from './analysis/results.js';
import {
  catalogLocalSources,
  detectStructureFormatHeader,
  inferStructureFormatFromPath,
  isPotentialStructurePath,
} from './io/file-sequences.js';
import { readStructureHeader } from './io/gzip.js';
import {
  colorsByProperty,
  colorsByCategory,
  colorsByType,
  coupleScalarRange,
  SCALAR_COLOR_SCHEMES,
  visibilityByProperty,
  visibilityByCategory,
  visibilityByType,
  combineVisibilityMasks,
} from './render/palette.js';
import { normalizeRadiusPercent, radiiByType } from './render/atomic-radii.js';
import { WebGLRenderer } from './render/webgl-renderer.js';
import { initializeBccLogo } from './render/bcc-logo.js';
import { StructureWorkerClient } from './worker-client.js';
import { initializeTheme } from './theme.js';
import { initializeCameraControls } from './camera-controls.js';
import { initializeExportResolutionControls } from './export-resolution-controls.js';
import { initializeAmbientOcclusionControls } from './ambient-occlusion-controls.js';
import { initializeKeyboardControls } from './keyboard-controls.js';
import { cameraCommand, createAutomationLock, createScriptHost, initializeScriptControls } from './script-controls.js';
import { initializeMovieControls } from './movie-controls.js';
import { initializeExternalPropertyControls } from './external-property-controls.js';
import { initializeExpressionControls } from './expression-controls.js';
import { removeComputedProperties } from './computed-properties.js';
import { SelectionExpansionClient } from './selection-expansion-client.js';
import { initializeTopologyTools } from './topology-tools.js';
import { initializeClusterTools } from './cluster-tools.js';
import { initializeGrainTools } from './grain-tools.js';
import { GrainSegmentationClient } from './grains-client.js';
import { initializeWignerSeitzTools } from './wigner-seitz-tools.js';
import { initializeSurfaceTools } from './surface-tools.js';
import { initializeBinningTools } from './binning-tools.js';
import { createGlobalAttributeSource } from './global-attribute-source.js';
import { initializeTextLabels } from './text-label-controls.js';
import { initializeTimeSeries } from './time-series-controls.js';
import { TIME_SERIES_DEFAULTS } from './time-series.js';
import { initializeTrajectoryToolControls } from './trajectory-tool-controls.js';
import { INFERRED_UNWRAP_SOURCE } from './data/trajectory-tools.js';
import { SpatialBinningClient } from './binning-client.js';
import { initializeVoronoiCellControls } from './voronoi-cell-controls.js';
import { initializeStatisticsExports } from './statistics-export-controls.js';
import { initializeSidebarResize } from './sidebar-resize.js';
import { initializeToolPanels } from './tool-panels.js';
import { initializeMobileControls } from './mobile-controls.js';
import { initializeFileDrop } from './file-drop.js';
import { initializeSliceControls } from './slice-controls.js';
import { initializeSliceGizmo } from './render/slice-gizmo.js';
import { initializeCrystalDragControls } from './crystal-drag-controls.js';
import { createConfiguration, parseConfiguration, matchesSource, downloadConfiguration } from './configuration.js';
import { initializeAtomEyeTools } from './atomeye-tools.js';
import { initializeDxaTools, DXA_STRUCTURE_PROPERTY } from './dxa-tools.js';
import { initializeFeatureHelp } from './feature-help.js';
import { normalizeSelectionGroups, selectionGroupVisibility } from './selection-groups.js';
import { initializeSelectionGroupControls } from './selection-group-controls.js';
import { initializeCrystalVisibilityControls, isCrystalStructureProperty } from './crystal-visibility-controls.js';
import { createLegendScale } from './render/legend-histogram.js';
import { createLegendRangeSlider } from './render/legend-range-slider.js';

const elements = Object.fromEntries([
  'file-input', 'folder-input', 'open-local', 'open-examples', 'empty-open', 'viewport', 'sidebar', 'enable-gpu-computing',
  'empty-state', 'file-name', 'file-meta', 'format-chip', 'close-file', 'file-drop-overlay', 'atom-count', 'frame-count',
  'cell-kind', 'pbc-flags', 'trajectory-section', 'frame-slider', 'frame-label', 'timestep-label',
  'cache-label', 'frame-first', 'frame-previous', 'frame-play', 'frame-next', 'frame-last', 'frame-ticks',
  'coordinate-mode', 'color-mode', 'radius-scale', 'radius-percent', 'voronoi-radius-scale', 'voronoi-radius-percent', 'projection-perspective', 'projection-orthographic',
  'background-picker', 'background-current', 'background', 'show-axes',
  'show-cell', 'png-background', 'png-legend', 'png-axes', 'slice-axis', 'slice-position', 'slice-value', 'cutoff', 'run-analysis',
  'analysis-state', 'cutoff-help', 'coordination-cutoff-preset', 'analysis-help', 'atom-details-overlay', 'selection-empty', 'selection-data', 'clear-selection', 'legend', 'color-legend',
  'cna-mode', 'cna-cutoff', 'cna-cutoff-field', 'run-cna', 'cna-state', 'cna-help', 'cna-status',
  'csp-neighbors', 'csp-auto-result', 'csp-help', 'run-csp', 'csp-state', 'csp-status', 'metric-cna', 'metric-csp',
  'ptm-rmsd', 'run-ptm', 'ptm-state', 'ptm-status', 'metric-ptm',
  'cancel-analysis', 'cancel-cna', 'cancel-csp', 'cancel-ptm', 'cancel-strain',
  'lattice-references', 'lattice-reset', 'lattice-estimate', 'lattice-estimate-cancel', 'lattice-estimate-status',
  'run-strain', 'strain-state', 'strain-status', 'metric-strain',
  'reset-camera', 'export-png', 'loading', 'loading-text', 'toast', 'interaction-hint',
  'axis-triad', 'axis-arrows', 'axis-x-line', 'axis-y-line', 'axis-z-line', 'axis-x-label', 'axis-y-label', 'axis-z-label',
  'metric-index', 'metric-parse', 'metric-upload', 'metric-analysis', 'metric-fps',
  'metric-memory',
  'replicate-a', 'replicate-b', 'replicate-c', 'replicate-atoms', 'apply-replicate', 'reset-replicate', 'replicate-summary',
  'export-configuration', 'import-configuration', 'configuration-file', 'configuration-status',
  'source-dialog', 'source-dialog-kicker', 'source-dialog-title', 'source-dialog-summary', 'source-dialog-close', 'source-options',
].map((id) => [id, document.getElementById(id)]));

const cache = new FrameCache(3);
const scalarColorRanges = new Map();
const colorQuantityResolver = new ColorQuantityResolver();
const scalarColorSchemes = new Map();
const scalarColorModes = new Map();
const orientationColorResolver = new OrientationColorResolver();
let orientationSettings = normalizeOrientationSettings(DEFAULT_ORIENTATION_SETTINGS);
const scalarHideOutside = new Map();
const hiddenStructureTypes = new Set();
const hiddenAtomTypes = new Set();
const hiddenCategories = new Map();
const crystalCategoryProperties = new Set(['structureType', 'ptmStructureType', 'centralSymmetryStructureType',
  'idealStrainStructureType', DXA_STRUCTURE_PROPERTY]);
const cpuBudget = new CpuBudget({ environment: globalThis });
const analysisPool = new AnalysisPool({ cpuBudget });
const dxaClient = new DxaClient({ cpuBudget, cpuStageBackend: analysisPool });
const coordinationPool = new CoordinationPool(analysisPool);
const analysisControllers = new Map();
const analysisTasks = new Map();
const ANALYSES = {
  cna: { prefix: 'cna', name: 'structureType', label: 'Crystal structure (CNA)', help: 'Calculate to color by crystal structure. The legend checkboxes control visibility.' },
  centrosymmetry: { prefix: 'csp', name: 'centralSymmetry', label: 'Central symmetry (normalized)', help: 'Runs on the complete structure, including hidden atoms.' },
  ptm: { prefix: 'ptm', name: 'ptmStructureType', label: 'Crystal structure (PTM)', help: 'Results include structure type, RMSD, nearest-neighbor distance, lattice orientation and binary chemical ordering.' },
  strain: { prefix: 'strain', name: 'atomicShearStrain', label: 'Atomic shear strain', help: 'Missing lattice references are estimated from the current structure. Editable references stay fixed across frames. This is not displacement strain between trajectory frames.' },
};
// PTM outputs besides the structure type, as [property name, selector label].
const PTM_EXTRA_OUTPUTS = Object.freeze([['ptmRmsd', 'PTM RMSD (best fit)'], ['ptmDistance', 'PTM nearest-neighbor distance [Å]'],
  ['ptmOrderingType', 'PTM chemical ordering'],
  ...['W', 'X', 'Y', 'Z'].map(axis => [`ptmOrientation${axis}`, `PTM orientation q${axis.toLowerCase()}`])]);

const state = {
  file: null,
  files: [],
  format: null,
  frameCount: 0,
  indexComplete: true,
  indexError: null,
  frameIndex: 0,
  frame: null,
  selectedId: null,
  selectionGroups: normalizeSelectionGroups(),
  frameRequest: 0,
  colorMode: 'type',
  coordinateMode: 'wrapped',
  periodicOrigin: [0, 0, 0],
  repetitions: [1, 1, 1],
  replicateAtoms: false,
  processingRevision: 0,
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
let playbackBuffer = null;
let framePrefetchController = null;
let frameNavigationController = null;
let interactionHintTimer = null;
let interactionHintFadeTimer = null;
let cutoffTimer = null;
let coordinationQueue = Promise.resolve();
let loadingOwner = null, loadingReadProgress = false;
let sourceOpenRequest = 0;
let sourceFetchController = null;
let sourceLoadingOwner = null;
let exampleCatalog = null;
let exampleCatalogPromise = null;
let latticeEstimateRequest = 0;
let renderer;
let atomEyeTools;
let cameraControls;
let exportResolutionControls;
let ambientOcclusion;
let externalProperties;
let expressionTools;
let topologyTools;
let clusterTools;
let grainTools;
let wignerSeitzTools;
let surfaceTools;
let binningTools;
let trajectoryTools;
let voronoiCells;
let statisticsExports;
let globalAttributes;
let textLabelControls;
let timeSeries;
let scriptControls;
let movieControls;
let dxaTools;
let crystalVisibility;
let currentColorLegend = null;
let commitScalarLegendEdit = null;
let selectionGroupControls;
let colorChoiceVersion = 0;
let backgroundCustomized = false;
let sliceControls;
let sliceGizmo;
let crystalDrag;
let pendingConfiguration = null;
let configurationRequest = 0;
let configurationReadRequest = 0;
let restorationOwner = null;
let gpuPreparationStatus = null;
let replicationController = null;
let replicationRequest = 0;
const analysisFrameSources = new WeakMap();
const cpuPrefetch = new CpuPrefetchScheduler({ pool: analysisPool, dxaClient });
const gpuPrefetch = new GpuPrefetchScheduler({
  pool: analysisPool,
  getFrame: (index, { signal, sourceKey }) => getFrame(index, { background: true, cacheFrame: false, signal, sourceKey }),
  onStatus: (status) => {
    gpuPreparationStatus = status;
    updateCacheLabel();
    updateGpuComputingTitle();
  },
});

initializeSidebarResize();
const toolPanels = initializeToolPanels({
  onDeactivateAnalysis: (kind) => {
    interruptConfigurationRestore('an analysis change');
    if (kind === 'bonds') topologyTools?.cancel('bondStatistics');
    if (kind === 'voronoi') topologyTools?.cancel('voronoi');
    else if (kind === 'dxa') dxaTools?.cancel();
    else if (kind === 'clusters') clusterTools?.cancel();
    else if (kind === 'grains') grainTools?.cancel();
    else if (kind === 'wignerSeitz') wignerSeitzTools?.cancel();
    else if (kind === 'surfaceMesh') surfaceTools?.cancel();
    else if (kind === 'binning') binningTools?.cancel();
    else if (kind === 'displacement') atomEyeTools?.cancelDisplacement();
    else if (state.analysis[kind]) cancelAnalysis(kind);
    else atomEyeTools?.deactivate(kind);
  },
  onDeactivateTool: (name) => {
    atomEyeTools?.deactivate(name);
    if (name === 'replicate') resetReplication();
    if (name === 'trajectory') void trajectoryTools?.deactivate();
    if (name === 'slice') toolPanels.setToolEnabled('slice', sliceControls.getState().slices.some(slice => slice.enabled));
    if (name === 'selectionGroups') toolPanels.setToolEnabled(name, state.selectionGroups.groups.length > 0);
    if (name === 'externalProperties') toolPanels.setToolEnabled(name, externalProperties.getState().files.length > 0);
    if (name === 'expressions') toolPanels.setToolEnabled(name, expressionTools.getState().properties.length > 0);
    if (name === 'textLabels') toolPanels.setToolEnabled(name, textLabelControls?.hasActiveLabels() ?? false);
    if (name === 'timeSeries') toolPanels.setToolEnabled(name, timeSeries?.hasSeries() ?? false);
    if (name === 'scripts') toolPanels.setToolEnabled(name, scriptControls?.isRunning() ?? false);
    if (name === 'movie') toolPanels.setToolEnabled(name, movieControls?.hasKeyframes() ?? false);
  },
  onSelectionChange: (name, { userInitiated = false } = {}) => {
    if (name !== 'slice') sliceControls?.setPicking(false);
    if (name === 'binning') binningTools?.warm();
    if (name === 'grains') grainTools?.warm();
    syncSliceGizmo();
    selectionGroupControls?.setActive(name === 'selectionGroups');
    syncSelectionGroupInteraction();
    if (name === 'vectors' && userInitiated && state.frame) atomEyeTools?.updateVectors();
    if (name === 'displacement' && userInitiated && state.frame && !toolPanels.isToolEnabled(name)) {
      interruptConfigurationRestore('a displacement calculation');
      void atomEyeTools?.runDisplacement();
    }
  },
});
initializeMobileControls();
initializeFeatureHelp();
initializeTheme((theme) => {
  if (!backgroundCustomized) {
    const background = theme === 'light' ? '#ffffff' : '#000000';
    if (renderer) setBackgroundColor(background, { automatic: true });
    else elements.background.value = background;
  }
});

function setGpuComputing(enabled) {
  analysisPool.setGpuEnabled(enabled);
  elements['enable-gpu-computing'].setAttribute('aria-pressed', String(enabled));
  if (enabled && state.frame && sourceLoadingOwner === null) scheduleGpuFramePrefetch();
  void gpuPrefetch.setEnabled(enabled);
  if (!enabled) analysisPool.releaseGpuResources({ whenIdle: true });
  // The Voronoi panel's WebGPU kernel option is usable only while this is on.
  topologyTools?.syncGpuAcceleration();
  updateCacheLabel();
  updateGpuComputingTitle();
}

function updateGpuComputingTitle() {
  const status = gpuPreparationStatus;
  elements['enable-gpu-computing'].title = !analysisPool.gpuEnabled
    ? 'GPU acceleration is off. Analyses use CPU Workers.'
    : status?.phase === 'unavailable'
      ? `GPU preparation unavailable: ${status.error} Supported analyses will use CPU Workers if needed.`
      : status?.phase === 'warming'
        ? 'Preparing the GPU device and analysis pipelines in the background.'
        : analysisPool.gpuCacheStatus?.exactPairs === false
          ? 'GPU acceleration is on. This GPU failed the exact double-float self-test, so Voronoi, strain and displacement analyses use CPU Workers.'
          : 'GPU acceleration is on. Structure frames are prepared in the background; calculate again to use this preference. Voronoi analysis uses CPU Workers unless its WebGPU kernel is turned on in the Voronoi panel.';
}

function scheduleGpuFramePrefetch({ committedFrame = null } = {}) {
  // A freshly parsed source can prepare its committed frame while the UI is
  // still finishing the load. Ordinary calls during source selection must
  // not upload the previous source's frame.
  if (!state.frame || (sourceLoadingOwner !== null && committedFrame !== state.frame)) return;
  analysisPool.associateGpuFrame(state.frame, state.frameIndex);
  void gpuPrefetch.setFrame({
    sourceKey: processingSourceKey(),
    frameCount: state.frameCount,
    currentIndex: state.frameIndex,
    frame: state.frame,
    playing: state.playing,
  });
}

elements['enable-gpu-computing'].addEventListener('click', () => {
  interruptConfigurationRestore('a GPU acceleration preference change');
  setGpuComputing(!analysisPool.gpuEnabled);
});
setGpuComputing(true);

try {
  renderer = new WebGLRenderer(elements.viewport, {
    onPick: handleAtomPick,
    onStats: ({ fps }) => { elements['metric-fps'].textContent = `${fps.toFixed(1)} FPS`; },
    onCameraChange: updateAxisTriad,
    onProjectionChange: syncProjectionControls,
    onRender: () => { sliceGizmo?.update(); ambientOcclusion?.update(); },
    // Exports wait for current ambient occlusion, after a legend edit commits.
    onBeforeCapture: () => { commitScalarLegendEdit?.(); ambientOcclusion?.ensureCurrent(); },
  });
} catch (error) {
  showToast(error.message);
  throw error;
}

cameraControls = initializeCameraControls({
  renderer,
  onEdit: () => interruptConfigurationRestore('a camera edit'),
  onDisplayChange: ({ cellWireframeMode }) => {
    interruptConfigurationRestore('a cell outline edit');
    renderer.setCellWireframeMode(cellWireframeMode);
    atomEyeTools?.syncComparison();
  },
});

exportResolutionControls = initializeExportResolutionControls({ renderer,
  onEdit: () => interruptConfigurationRestore('an image export size change'), notify: showToast });

ambientOcclusion = initializeAmbientOcclusionControls({ renderer,
  onEdit: () => interruptConfigurationRestore('an ambient occlusion change'),
  onChange: () => atomEyeTools?.syncComparison(), notify: showToast });

externalProperties = initializeExternalPropertyControls({
  getFrame: () => state.frame ? sourceFrame(state.frame) : null,
  getFrameAtIndex: async index => { const frame = await getFrame(index); return frame ? sourceFrame(frame) : null; },
  getSourceVersion: () => state.sourceVersion,
  onImported: refreshExternalProperties,
  onRemoved: refreshExternalProperties,
  notify: (message, success = false) => showToast(message, success),
});

selectionGroupControls = initializeSelectionGroupControls({
  getFrame: () => state.frame,
  getState: () => state.selectionGroups,
  setState: next => { state.selectionGroups = next; },
  onEdit: () => interruptConfigurationRestore('an atom selection edit'),
  onChange: (_next, { reason } = {}) => {
    if (reason === 'interaction' || reason === 'selection') renderer.cancelSelectionGesture();
    toolPanels.setToolEnabled('selectionGroups', state.selectionGroups.groups.length > 0);
    syncSelectionGroupInteraction();
    expressionTools?.refresh();
    if (state.frame && reason !== 'interaction' && reason !== 'selection') { applyColors(); restoreSelection(); }
    if (reason !== 'interaction' && reason !== 'selection') void clusterTools?.refreshSelectionGroups();
    if (reason !== 'interaction' && reason !== 'selection') void surfaceTools?.refreshSelectionGroups();
    if (reason !== 'interaction' && reason !== 'selection') trajectoryTools?.refresh();
  },
  onError: error => showToast(error.message ?? String(error)),
});

expressionTools = initializeExpressionControls({
  getFrame: () => state.frame,
  getSelectionGroups: () => state.selectionGroups,
  editSelectionGroups: transform => selectionGroupControls.apply(transform),
  onPropertiesChange: refreshComputedProperties,
  onChooseColor: name => selectColorMode(`property:${name}`),
  onEdit: () => interruptConfigurationRestore('an expression edit'),
  notify: (message, success = false) => showToast(message, success),
  expansionClient: new SelectionExpansionClient({ cpuBudget }),
});

function handleAtomPick(index) {
  if (sliceControls?.isPicking()) {
    if (state.frame && index >= 0 && index < state.frame.ids.length) {
      const id = state.frame.ids[index];
      const pick = renderer.lastPick?.index === index ? renderer.lastPick : null;
      sliceControls.addPickedAtom({ id, replicaIndices: pick?.replica ?? [0, 0, 0],
        position: pick?.position ?? Array.from(renderer.displayPositions.slice(index * 3, index * 3 + 3)) });
      selectAtom(index);
    }
    return;
  }
  if (selectionGroupControls?.getInteractionState().enabled) {
    if (state.frame && index >= 0 && index < state.frame.ids.length) {
      selectionGroupControls.selectAtoms([state.frame.ids[index]]);
    }
    return;
  }
  selectAtom(index);
}

// Repeated clicks belong to measurement, slice picking or group picking when
// those are active; otherwise a double-click anchors the camera on the atom.
renderer.allowsDoubleTapAnchor = () => !(sliceControls?.isPicking() || selectionGroupControls?.getInteractionState().enabled
  || document.getElementById('measure-mode')?.checked);

function selectGroupAtomIndices(indices) {
  const frame = state.frame;
  if (!frame || !selectionGroupControls?.getInteractionState().enabled) return;
  selectionGroupControls.selectAtoms(Array.from(indices, index => frame.ids[index]));
}

function syncSelectionGroupInteraction() {
  if (!renderer || !selectionGroupControls) return;
  const interaction = selectionGroupControls.getInteractionState();
  renderer.setSelectionInteraction({
    mode: state.frame && sourceLoadingOwner === null && interaction.enabled ? interaction.mode : 'off',
    context: `${state.selectionGroups.selectedGroupId ?? ''}:${interaction.operation}`,
    onPick: handleAtomPick,
    onBox: selectGroupAtomIndices,
    onError: error => showToast(error.message ?? String(error)),
  });
}

sliceControls = initializeSliceControls({
  getSelectedAtomId: () => state.selectedId,
  getCell: () => state.frame?.cell ?? null,
  resolveAtomPoint: (id, atom) => displayedAtomPoint(id, atom?.replicaIndices),
  getSelectedPoint: () => displayedAtomPoint(state.selectedId),
  getPickedPoints: () => atomEyeTools?.serialize().measurements.atomIds.map(id => ({ id, position: displayedAtomPoint(id) }))
    .filter(point => point.position) ?? [],
  onPickedAtomsChange: (ids) => {
    const frame = state.frame;
    const indices = frame && renderer.frame === frame ? ids.map(id => frame.ids.indexOf(id))
      .filter(index => index >= 0) : [];
    renderer.setSliceSelectedAtoms(indices);
    atomEyeTools?.syncComparison();
  },
  onPickModeChange: () => { syncSliceGizmo(); renderer.cancelSelectionGesture(); },
  getDefaultSlice: () => {
    const bounds = renderer.getDisplayBounds();
    return { normal: [0, 0, 1], position: bounds ? (bounds.minimum[2] + bounds.maximum[2]) / 2 : 0 };
  },
  onChange: updateSlices,
  onSelectionChange: syncSliceGizmo,
});
sliceGizmo = initializeSliceGizmo(renderer, {
  onChange: (id, changes) => {
    interruptConfigurationRestore('a slice edit');
    const saved = sliceControls.getState();
    sliceControls.setState({ ...saved, slices: saved.slices.map(slice => slice.id === id ? { ...slice, ...changes } : slice) });
    updateSlices();
  },
  onSelect: (selectedId) => {
    sliceControls.setState({ ...sliceControls.getState(), selectedId });
    syncSliceGizmo();
  },
});

const worker = new StructureWorkerClient(({ loaded, total, stage }) => {
  if (stage === 'index') {
    const percentage = total > 0 ? Math.round(loaded / total * 100) : 0;
    reportReadProgress(`Indexing trajectory frames… ${percentage}%`);
  } else if (stage === 'sequence-index') {
    reportReadProgress(`Checking CFG sequence… ${loaded} / ${total}`);
  } else if (stage === 'sequence-unwrap') {
    reportReadProgress(`Inferring continuous trajectory coordinates… ${loaded} / ${total}`);
  } else if (stage === 'trajectory-unwrap') {
    reportReadProgress(`Unwrapping frames in order… ${loaded} / ${total}`);
  } else if (stage === 'trajectory-smooth') {
    reportReadProgress(`Averaging frames… ${loaded} / ${total}`);
  } else if (stage === 'series-index') {
    const percentage = total > 0 ? Math.round(loaded / total * 100) : 0;
    reportReadProgress(`Indexing numbered LAMMPS dumps… ${percentage}%`);
  }
}, { cpuBudget, onSourceInfo: updateSourceIndex });

atomEyeTools = initializeAtomEyeTools({
  renderer, pool: analysisPool, tools: toolPanels,
  getFrame: () => state.frame, getFrameAt: getFrame,
  getFrameIndex: () => state.frameIndex, getFrameCount: () => state.frameCount,
  ensureIndexed: waitForSourceIndex,
  getFrames: () => new Set([state.frame, ...cache.frames.values()].filter(Boolean)),
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getPendingAnalysisKinds: () => [...Object.entries(state.analysis).filter(([kind, analysis]) => {
    const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
    return analysis.enabled && !['Failed', 'Calculated'].includes(elements[`${prefix}-state`].textContent);
  }).map(([kind]) => kind), ...(topologyTools?.pendingKinds() ?? []), ...(clusterTools?.pendingKinds() ?? []),
    ...(wignerSeitzTools?.pendingKinds() ?? []), ...(grainTools?.pendingKinds() ?? [])],
  getAnalysisPropertyKind: name => {
    for (const [kind, analysis] of Object.entries(state.analysis)) {
      if (!analysis.enabled) continue;
      const outputs = kind === 'coordination' ? ['coordination']
        : kind === 'strain' ? STRAIN_FIELDS
          : kind === 'ptm' ? [ANALYSES[kind].name, ...PTM_EXTRA_OUTPUTS.map(([field]) => field)]
            : kind === 'centrosymmetry' && analysis.parameters?.mode === 'auto'
              ? [ANALYSES[kind].name, 'centralSymmetryStructureType', 'centralSymmetryNeighbors']
              : [ANALYSES[kind].name];
      if (outputs.includes(name)) return kind;
    }
    return topologyTools?.getPropertyKind(name) ?? clusterTools?.getPropertyKind(name) ?? wignerSeitzTools?.getPropertyKind(name)
      ?? grainTools?.getPropertyKind(name) ?? null;
  },
  getSelectedIndex: () => state.selectedId === null || !state.frame ? -1 : findAtomIndex(state.frame.ids, state.selectedId),
  selectAtom: handleAtomPick,
  getSelectionGroups: () => state.selectionGroups.groups,
  refresh: () => { if (state.frame) { refreshColorOptions(); applyColors(); updateSelectionPanel(); } },
  chooseProperty: (name, { manual = false } = {}) => {
    if (manual) { colorChoiceVersion++; interruptConfigurationRestore('a color quantity change'); }
    state.colorMode = `property:${name}`; refreshColorOptions(); applyColors();
  },
  getColorMode: () => state.colorMode,
  getColorChoiceVersion: () => colorChoiceVersion,
  getExportOptions: () => ({ includeBackground: elements['png-background'].checked,
    includeAxes: elements['png-axes'].checked, legend: elements['png-legend'].checked ? paletteForCurrentMode().legend : null,
    ...exportResolutionControls.getOptions(),
    ...sliceOutlineExportOptions(), ...textLabelExportOptions() }),
  prepareExport: options => textLabelControls?.prepareExport(options),
  showFrame, stopPlayback: stopFramePlayback,
  getFileStem: () => (state.file?.name ?? 'alloyview').replace(/\.[^.]+$/, ''),
  notify: showToast, onEdit: () => interruptConfigurationRestore('a settings edit'), onMemoryChange: reassessFrameCache,
  onBondParametersChange: () => { void clusterTools?.refreshBondParameters(); return topologyTools?.refreshBondParameters(); },
  onBondStateChange: () => topologyTools?.syncBondEnabled(),
  getBondStatisticsEnabled: () => (topologyTools?.isEnabled('bondStatistics') ?? false) || (clusterTools?.usesBondCutoffs() ?? false),
});

// Dragging the crystal previews the origin in both views' shaders and commits
// through setPeriodicOrigin, exactly like a typed origin.
crystalDrag = initializeCrystalDragControls({
  renderer,
  getOrigin: () => state.periodicOrigin,
  getCoordinateMode: () => displayCoordinateMode(),
  commit: origin => setPeriodicOrigin(origin),
});
renderer.onCrystalDrag = () => atomEyeTools?.syncCrystalDrag();

crystalVisibility = initializeCrystalVisibilityControls({
  getFrame: () => state.frame,
  getColorMode: () => state.colorMode.startsWith('property:') ? state.colorMode.slice(9) : 'type',
  getHiddenCategories: hiddenCategoriesFor,
  onChange: () => {
    interruptConfigurationRestore('a crystal visibility change');
    if (!state.frame) return;
    applyScalarVisibility(currentColorLegend ?? paletteForCurrentMode().legend);
    atomEyeTools.syncComparison();
  },
});

dxaTools = initializeDxaTools({
  renderer, tools: toolPanels, client: dxaClient, getFrame: () => state.frame,
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getColorMode: () => state.colorMode,
  getColorChoiceVersion: () => colorChoiceVersion,
  onResultsChange: ({ selectProperty, clearSettings }) => {
    if (clearSettings) {
      hiddenCategories.delete(DXA_STRUCTURE_PROPERTY);
      crystalVisibility.forgetSource(DXA_STRUCTURE_PROPERTY);
    }
    if (!state.frame) return;
    if (selectProperty) {
      state.colorMode = `property:${selectProperty}`;
      crystalVisibility.restore({ source: selectProperty });
    }
    refreshColorOptions(); applyColors(); restoreSelection(); updateMemoryMetric();
  },
  onEdit: () => interruptConfigurationRestore('a DXA settings edit'),
  onDisplayChange: () => {
    atomEyeTools.syncComparison();
    statisticsExports?.refresh();
    globalAttributes?.refresh();
  },
  onMemoryChange: reassessFrameCache, notify: showToast,
  getFileStem: () => (state.file?.name ?? 'alloyview').replace(/\.[^.]+$/, ''),
  getFrameIndex: () => state.frameIndex,
});

topologyTools = initializeTopologyTools({
  renderer, pool: analysisPool, tools: toolPanels,
  getFrame: () => state.frame,
  getFrames: () => new Set([state.frame, ...cache.frames.values()].filter(Boolean)),
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getFrameIndex: () => state.frameIndex,
  getBondParameters: () => atomEyeTools.getBondParameters(),
  getBondEnabled: () => atomEyeTools.isEnabled('bonds'),
  getColorChoiceVersion: () => colorChoiceVersion,
  chooseProperty: (name, { manual = false } = {}) => {
    if (manual) { colorChoiceVersion++; interruptConfigurationRestore('a color quantity change'); }
    state.colorMode = `property:${name}`; refreshColorOptions(); applyColors();
  },
  onBeforeClear: (kind, { clearSettings }) => {
    if (clearSettings) atomEyeTools.cancelVectorDependency(kind);
  },
  onResultsChange: ({ kind, clearSettings } = {}) => {
    if (kind === 'voronoi' && clearSettings) voronoiCells?.reset();
    if (!state.frame) return;
    refreshColorOptions(); applyColors(); updateMemoryMetric();
    reassessFrameCache(state.frame);
    if (kind === 'voronoi') void voronoiCells?.refresh();
  },
  onEdit: () => interruptConfigurationRestore('a topology analysis edit'),
  // GPU prewarm prepares the Voronoi kernel only while the panel requests it.
  onGpuPreparationChange: kinds => { void gpuPrefetch.setAnalysisKinds(kinds); },
  notify: showToast,
});

clusterTools = initializeClusterTools({
  pool: analysisPool, tools: toolPanels,
  getFrame: () => state.frame,
  getFrames: () => new Set([state.frame, ...cache.frames.values()].filter(Boolean)),
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getFrameIndex: () => state.frameIndex,
  getBondParameters: () => atomEyeTools.getBondParameters(),
  getSelectionGroups: () => state.selectionGroups.groups,
  getColorChoiceVersion: () => colorChoiceVersion,
  chooseProperty: (name, { manual = false } = {}) => {
    if (manual) { colorChoiceVersion++; interruptConfigurationRestore('a color quantity change'); }
    state.colorMode = `property:${name}`; refreshColorOptions(); applyColors();
  },
  onBeforeClear: (kind, { clearSettings }) => {
    if (clearSettings) atomEyeTools.cancelVectorDependency(kind);
  },
  onResultsChange: () => {
    if (!state.frame) return;
    refreshColorOptions(); applyColors(); updateMemoryMetric();
    reassessFrameCache(state.frame);
  },
  onEdit: () => interruptConfigurationRestore('a cluster analysis edit'),
  notify: showToast,
});

grainTools = initializeGrainTools({
  client: new GrainSegmentationClient({ cpuBudget }), tools: toolPanels,
  getFrame: () => state.frame,
  getFrames: () => new Set([state.frame, ...cache.frames.values()].filter(Boolean)),
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getFrameIndex: () => state.frameIndex,
  getPtmParameters: () => ptmParameters(),
  ensurePtm: ptmForGrains,
  releasePtm: () => {
    if (state.analysis.ptm.enabled || state.analysis.strain.enabled) return;
    for (const frame of new Set([state.frame, ...cache.frames.values()])) if (frame) delete frame.ptm;
  },
  getColorChoiceVersion: () => colorChoiceVersion,
  chooseProperty: (name, { manual = false } = {}) => {
    if (manual) { colorChoiceVersion++; interruptConfigurationRestore('a color quantity change'); }
    state.colorMode = `property:${name}`; refreshColorOptions(); applyColors();
  },
  chooseColorMode: (mode) => {
    colorChoiceVersion++; interruptConfigurationRestore('a color quantity change');
    state.colorMode = mode; refreshColorOptions(); applyColors();
  },
  onResultsChange: () => {
    if (!state.frame) return;
    refreshColorOptions(); applyColors(); updateMemoryMetric();
    reassessFrameCache(state.frame);
  },
  onEdit: () => interruptConfigurationRestore('a grain segmentation edit'),
  notify: showToast,
});

wignerSeitzTools = initializeWignerSeitzTools({
  renderer, pool: analysisPool, tools: toolPanels,
  getFrame: () => state.frame, getFrameAt: getFrame,
  getFrames: () => new Set([state.frame, ...cache.frames.values()].filter(Boolean)),
  getFrameCount: () => state.frameCount,
  getFrameIndex: () => state.frameIndex,
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getColorChoiceVersion: () => colorChoiceVersion,
  chooseProperty: (name, { manual = false } = {}) => {
    if (manual) { colorChoiceVersion++; interruptConfigurationRestore('a color quantity change'); }
    state.colorMode = `property:${name}`; refreshColorOptions(); applyColors();
  },
  onBeforeClear: (kind, { clearSettings }) => {
    if (clearSettings) atomEyeTools.cancelVectorDependency(kind);
  },
  onResultsChange: () => {
    if (!state.frame) return;
    refreshColorOptions(); applyColors(); updateMemoryMetric();
    reassessFrameCache(state.frame);
  },
  onDisplayChange: () => atomEyeTools?.syncComparison(),
  onEdit: () => interruptConfigurationRestore('a Wigner–Seitz analysis edit'),
  notify: showToast,
});

surfaceTools = initializeSurfaceTools({
  renderer, tools: toolPanels, client: dxaClient,
  getFrame: () => state.frame,
  getFrames: () => new Set([state.frame, ...cache.frames.values()].filter(Boolean)),
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getFrameIndex: () => state.frameIndex,
  getSelectionGroups: () => state.selectionGroups.groups,
  getFileStem: () => (state.file?.name ?? 'alloyview').replace(/\.[^.]+$/, ''),
  onResultsChange: () => {
    if (!state.frame) return;
    updateMemoryMetric();
    reassessFrameCache(state.frame);
    statisticsExports?.refresh();
    globalAttributes?.refresh();
  },
  onDisplayChange: () => atomEyeTools?.syncComparison(),
  onEdit: () => interruptConfigurationRestore('a surface mesh edit'),
  notify: showToast,
});

binningTools = initializeBinningTools({
  tools: toolPanels,
  getFrame: () => state.frame,
  getFrameAt: (index, { signal } = {}) => getFrame(index, { background: true, cacheFrame: false, signal }),
  getFrameCount: () => state.frameCount,
  ensureIndexed: waitForSourceIndex,
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getFrameIndex: () => state.frameIndex,
  getSelectionGroups: () => state.selectionGroups.groups,
  onResultsChange: () => statisticsExports?.refresh(),
  onEdit: () => interruptConfigurationRestore('a spatial binning edit'),
  notify: showToast,
  client: new SpatialBinningClient({ cpuBudget }),
});

trajectoryTools = initializeTrajectoryToolControls({
  tools: toolPanels, renderer, worker,
  getFrame: () => state.frame,
  getFrameIndex: () => state.frameIndex,
  getFrameCount: () => state.frameCount,
  ensureIndexed: waitForSourceIndex,
  getSourceVersion: () => state.sourceVersion,
  getSelectionGroups: () => state.selectionGroups.groups,
  getCoordinateMode: () => state.coordinateMode,
  canInferUnwrap: () => canInferUnwrap(),
  onSmoothingChange: () => applyTrajectoryProcessing(),
  onLinesChange: () => atomEyeTools?.syncComparison(),
  onEdit: () => interruptConfigurationRestore('a trajectory tool edit'),
  notify: showToast,
  setBusy: text => { if (text) setLoading(true, text, 'trajectory-unwrap'); else if (loadingOwner === 'trajectory-unwrap') setLoading(false); },
});

voronoiCells = initializeVoronoiCellControls({
  renderer, pool: analysisPool,
  getFrame: () => state.frame,
  getSelectedId: () => state.selectedId,
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getResult: () => state.frame?.atomeyeResults?.voronoi?.result ?? null,
  onEdit: () => interruptConfigurationRestore('a Voronoi cell display edit'),
  onChange: () => atomEyeTools?.syncComparison(),
});

statisticsExports = initializeStatisticsExports({
  getFrame: () => state.frame,
  getFileName: () => state.file?.name ?? 'structure',
  getFrameIndex: () => state.frameIndex,
  getDxaNetwork: () => renderer.dislocationNetwork,
  getSelectionGroups: () => state.selectionGroups,
  getLegend: () => currentColorLegend,
  getResults: () => binningTools?.exportResults() ?? {},
  notify: showToast,
});

globalAttributes = createGlobalAttributeSource({
  getFrame: () => state.frame,
  getFrameIndex: () => state.frameIndex,
  getFrameCount: () => state.frameCount,
  getFrameAt: (index, { signal } = {}) => getFrame(index, { background: true, cacheFrame: false, signal }),
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getDxaNetwork: () => renderer.dislocationNetwork,
});

textLabelControls = initializeTextLabels({
  renderer, tools: toolPanels, attributes: globalAttributes,
  getFrameCount: () => state.frameCount,
  onEdit: () => interruptConfigurationRestore('a text label edit'),
  notify: showToast,
});

timeSeries = initializeTimeSeries({
  tools: toolPanels, attributes: globalAttributes,
  getFrame: () => state.frame,
  getFrameAt: (index, { signal } = {}) => getFrame(index, { background: true, cacheFrame: false, signal }),
  getFrameIndex: () => state.frameIndex,
  getFrameCount: () => state.frameCount,
  ensureIndexed: waitForSourceIndex,
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  getFileName: () => state.file?.name ?? 'structure',
  showFrame, stopPlayback: stopFramePlayback,
  onEdit: () => interruptConfigurationRestore('a time series edit'),
  notify: showToast,
});

const bccLogo = initializeBccLogo(elements['empty-state']);
void loadExampleCatalog().catch(() => {});

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
elements['close-file'].addEventListener('click', closeSource);

elements['frame-slider'].addEventListener('input', () => {
  gpuPrefetch.cancel();
  atomEyeTools.cancelBatch({ restore: false });
  interruptConfigurationRestore('a frame change');
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
elements['frame-last'].addEventListener('click', async () => {
  try { await waitForSourceIndex(); showFrameManually(state.frameCount - 1); }
  catch (error) { if (error.name !== 'AbortError') showToast(error.message); }
});

elements['color-mode'].addEventListener('change', () => {
  selectColorMode(elements['color-mode'].value);
});
elements['coordinate-mode'].addEventListener('change', () => { void updateCoordinateMode().catch(error => showToast(error.message)); });
for (const axis of ['a', 'b', 'c']) {
  document.getElementById(`display-origin-${axis}`).addEventListener('input', updatePeriodicOrigin);
  document.getElementById(`display-origin-${axis}`).addEventListener('change', updatePeriodicOrigin);
}
document.getElementById('origin-reset').addEventListener('click', () => crystalDrag?.reset());
document.getElementById('origin-center-selected').addEventListener('click', centerPeriodicOriginOnSelected);
for (const prefix of ['', 'voronoi-']) {
  elements[`${prefix}radius-scale`].addEventListener('input', () => setRadiusPercent(elements[`${prefix}radius-scale`].value, { source: 'slider' }));
  elements[`${prefix}radius-percent`].addEventListener('input', () => setRadiusPercent(elements[`${prefix}radius-percent`].value, { source: 'number' }));
  elements[`${prefix}radius-percent`].addEventListener('blur', () => {
    if (elements[`${prefix}radius-percent`].value.trim() === '') setRadiusPercent(state.radiusPercent);
  });
}
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
elements['show-cell'].addEventListener('change', () => { renderer.setCellVisible(elements['show-cell'].checked); atomEyeTools.syncComparison(); });
elements['apply-replicate'].addEventListener('click', applyReplication);
elements['reset-replicate'].addEventListener('click', resetReplication);
elements['replicate-atoms'].addEventListener('change', applyReplication);
elements['export-configuration'].addEventListener('click', exportConfiguration);
elements['import-configuration'].addEventListener('click', () => elements['configuration-file'].click());
elements['configuration-file'].addEventListener('change', importConfiguration);
elements['slice-axis'].addEventListener('change', updateSlice);
elements['slice-position'].addEventListener('input', updateSlice);
elements['run-analysis'].addEventListener('click', () => {
  clearTimeout(cutoffTimer);
  runCoordination({ automatic: false });
});
for (const preset of COORDINATION_CUTOFF_PRESETS) {
  const item = document.createElement('option');
  item.value = preset.symbol;
  item.textContent = `${preset.symbol} · ${preset.name} — ${preset.cutoff.toFixed(2)} Å`;
  elements['coordination-cutoff-preset'].append(item);
}
elements.cutoff.addEventListener('input', () => editCoordinationCutoff());
elements.cutoff.addEventListener('change', () => editCoordinationCutoff({ immediate: true }));
elements['coordination-cutoff-preset'].addEventListener('change', () => {
  interruptConfigurationRestore('a cutoff preset change');
  const preset = coordinationCutoffPresetForElement(elements['coordination-cutoff-preset'].value);
  if (preset) elements.cutoff.value = preset.cutoff.toFixed(2);
  updateCoordinationCutoffHelp();
  if (preset) scheduleCutoffAnalysis({ immediate: true });
});
elements['run-cna'].addEventListener('click', () => runStructureAnalysis('cna'));
elements['run-csp'].addEventListener('click', () => runStructureAnalysis('centrosymmetry'));
elements['run-ptm'].addEventListener('click', () => runStructureAnalysis('ptm'));
elements['run-strain'].addEventListener('click', () => runStructureAnalysis('strain'));
for (const kind of Object.keys(state.analysis)) {
  const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
  elements[`cancel-${prefix}`].addEventListener('click', () => {
    interruptConfigurationRestore('an analysis cancellation');
    cancelAnalysis(kind);
  });
}
elements['ptm-rmsd'].addEventListener('change', updatePtmSettings);
for (const checkbox of document.querySelectorAll('[data-ptm-template]')) checkbox.addEventListener('change', updatePtmSettings);
elements['lattice-reset'].addEventListener('click', () => {
  cancelLatticeEstimation();
  state.references = state.references.map((reference, type) => referenceForElement(reference.element || state.frame.typeLabels[type]));
  renderLatticeReferences();
  if (state.analysis.strain.enabled) runStructureAnalysis('strain');
});
elements['lattice-estimate'].addEventListener('click', () => {
  interruptConfigurationRestore('a lattice reference change');
  void estimateMissingReferences();
});
elements['lattice-estimate-cancel'].addEventListener('click', () => {
  if (state.analysis.strain.enabled && elements['strain-state'].textContent === 'Estimating reference…') cancelAnalysis('strain');
  else cancelLatticeEstimation('Estimation cancelled.');
});
elements['cna-mode'].addEventListener('change', () => {
  updateCnaMethodUi();
  if (state.analysis.cna.enabled) runStructureAnalysis('cna');
});
elements['cna-cutoff'].addEventListener('change', () => {
  if (state.analysis.cna.enabled && elements['cna-mode'].value === 'fixed') runStructureAnalysis('cna');
});
elements['csp-neighbors'].addEventListener('change', () => {
  updateCspMethodUi();
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
      ...exportResolutionControls.getOptions(),
      ...sliceOutlineExportOptions(),
      ...textLabelExportOptions(),
    });
  } catch (error) {
    showToast(error.message);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopFramePlayback();
});
for (const name of ['input', 'change']) {
  document.addEventListener(name, (event) => {
    if (event.target.id !== 'configuration-file' && event.target.closest('#sidebar')) {
      atomEyeTools.cancelBatch({ restore: false });
      interruptConfigurationRestore('a settings edit');
    }
  });
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('#sidebar button');
  if (button && !['import-configuration', 'export-configuration'].includes(button.id)) {
    if (!button.id.startsWith('export-') && button.id !== 'cancel-frame-series') atomEyeTools.cancelBatch({ restore: false });
    interruptConfigurationRestore('a settings change');
  }
});

syncProjectionControls('perspective');
updateCspMethodUi();
setBackgroundColor(elements.background.value, { automatic: true });

const keyboardControls = initializeKeyboardControls({
  renderer,
  getSliceControls: () => sliceControls,
  getCrystalDrag: () => crystalDrag,
  onEdit: () => interruptConfigurationRestore('a keyboard view or slice edit'),
});

// A script, a camera-path preview or a movie export runs one at a time. Their
// frame changes behave like the trajectory buttons and resolve once the
// frame's analyses have finished.
const automationLock = createAutomationLock();
// Every analysis panel reports its work in a state pill; a frame being read shows the loading overlay.
const analysesSettled = () => elements.loading.hidden && ![...document.querySelectorAll('.analysis-section .state-pill')]
  .some(pill => /…$|^Queued$|^Waiting$/.test(pill.textContent.trim()));
const showFrameForAutomation = (index) => {
  atomEyeTools.cancelBatch({ restore: false });
  interruptConfigurationRestore('a frame change');
  stopFramePlayback();
  return showFrame(index);
};
movieControls = initializeMovieControls({
  renderer, tools: toolPanels, lock: automationLock,
  getFrameIndex: () => state.frameIndex, getFrameCount: () => state.frameCount,
  getSourceVersion: () => `${state.sourceVersion}:${state.processingRevision}`,
  ensureIndexed: waitForSourceIndex, showFrame: showFrameForAutomation, stopPlayback: stopFramePlayback,
  getExportOptions: imageExportOptions, getResolution: () => exportResolutionControls.getState(), analysesSettled,
  prepareExport: options => textLabelControls?.prepareExport(options),
  getFileStem: exportFileStem,
  onEdit: () => interruptConfigurationRestore('a camera path or movie edit'), notify: showToast,
});
scriptControls = initializeScriptControls({
  registry: keyboardControls.registry, tools: toolPanels, lock: automationLock,
  getToolIds: () => [...document.querySelectorAll('[data-tool-panel]')].map(panel => panel.dataset.toolPanel),
  getCameraCommand: () => (state.frame ? cameraCommand(renderer) : ''),
  getFileStem: exportFileStem,
  onEdit: () => interruptConfigurationRestore('a script edit'), notify: showToast,
  host: createScriptHost({
    renderer, registry: keyboardControls.registry, tools: toolPanels,
    getFrameIndex: () => state.frameIndex, getFrameCount: () => state.frameCount,
    showFrame: showFrameForAutomation, ensureIndexed: waitForSourceIndex,
    getColorOptions: () => [...elements['color-mode'].options].map(item => ({ value: item.value, label: item.textContent })),
    chooseColor: selectColorMode,
    getSliceControls: () => sliceControls,
    captureImage: () => renderer.captureImage(imageExportOptions()),
    getImageName: () => `${exportFileStem()}-frame-${state.frameIndex + 1}`,
    addKeyframe: options => movieControls.addKeyframe(options),
    clearKeyframes: () => movieControls.clearKeyframes(),
    analysesSettled,
    onEdit: () => interruptConfigurationRestore('a script command'),
  }),
});

const fileDrop = initializeFileDrop({
  overlay: elements['file-drop-overlay'],
  onFiles: files => {
    if (elements['source-dialog'].open) elements['source-dialog'].close();
    inspectLocalEntries(fileEntries(files), {
      singleFiles: true,
      originLabel: 'dropped files',
    });
  },
});

for (const range of document.querySelectorAll('.range')) setRangeProgress(range);
window.addEventListener('beforeunload', () => {
  cpuPrefetch.cancel();
  gpuPrefetch.cancel();
  bccLogo.dispose();
  renderer?.interactions?.dispose();
  fileDrop.dispose();
  sourceFetchController?.abort();
  clearTimeout(cutoffTimer);
  worker.close();
  coordinationPool.close();
  void dxaClient.close();
  sliceGizmo.dispose();
  cameraControls?.dispose();
  keyboardControls.dispose();
  scriptControls?.stop();
  movieControls?.dispose();
  externalProperties?.reset();
  topologyTools?.abortJobs();
  clusterTools?.abortJobs();
  grainTools?.dispose();
  wignerSeitzTools?.abortJobs();
  surfaceTools?.abortJobs();
  binningTools?.dispose();
  voronoiCells?.abortJobs();
  statisticsExports?.dispose();
});

function beginSourceOpen() {
  cancelLatticeEstimation();
  replicationController?.abort();
  replicationRequest++;
  cpuPrefetch.cancel();
  gpuPrefetch.pause();
  interruptConfigurationRestore('a new source selection');
  sourceFetchController?.abort();
  sourceFetchController = null;
  elements['close-file'].hidden = false;
  sourceLoadingOwner = ++sourceOpenRequest;
  stopFramePlayback();
  setControlsEnabled(false);
  syncSliceGizmo();
  return sourceOpenRequest;
}

function finishSourceOpen(request) {
  if (sourceLoadingOwner !== request) return;
  sourceLoadingOwner = null;
  setControlsEnabled(Boolean(state.frame));
  syncSliceGizmo();
  if (state.frame) void cpuPrefetch.setFrame({ sourceKey: state.sourceVersion, frame: state.frame });
  scheduleGpuFramePrefetch();
}

function closeSource() {
  externalProperties?.reset();
  expressionTools?.reset();
  toolPanels.setToolEnabled('expressions', false);
  cameraControls?.close();
  replicationController?.abort();
  replicationRequest++;
  configurationRequest++;
  restorationOwner = null;
  commitScalarLegendEdit = null;
  colorQuantityResolver.clear();
  sourceLoadingOwner = null;
  sourceOpenRequest++;
  sourceFetchController?.abort();
  sourceFetchController = null;
  state.sourceVersion++;
  state.frameRequest++;
  state.prefetchToken++;
  clearTimeout(frameTimer);
  clearTimeout(cutoffTimer);
  clearTimeout(toastTimer);
  clearTimeout(interactionHintTimer);
  clearTimeout(interactionHintFadeTimer);
  stopFramePlayback();
  abortAnalysisJobs();
  cpuPrefetch.clearSource();
  analysisPool.clearVoronoiFrames();
  void gpuPrefetch.clearSource();
  atomEyeTools.reset();
  dxaTools.reset();
  topologyTools?.reset();
  clusterTools?.reset();
  grainTools?.reset();
  wignerSeitzTools?.reset();
  surfaceTools?.reset();
  binningTools?.reset();
  trajectoryTools?.reset();
  voronoiCells?.reset();
  timeSeries?.reset();
  movieControls?.reset();
  globalAttributes?.reset();
  framePrefetchController?.abort();
  framePrefetchController = null;
  frameNavigationController?.abort();
  frameNavigationController = null;
  worker.reset();
  state.pendingFrames.clear();
  cache.clear();
  cache.setLimit(3);
  Object.assign(state, {
    file: null, files: [], frame: null, format: null, frameCount: 0, frameIndex: 0, indexComplete: true, indexError: null,
    selectedId: null, colorMode: 'type', coordinateMode: 'wrapped', periodicOrigin: [0, 0, 0], repetitions: [1, 1, 1], replicateAtoms: false,
    source: null, availableSources: [], availableEntries: [], cachePlan: null,
    references: [], referenceLabels: [],
  });
  state.referenceByLabel.clear();
  state.selectionGroups = normalizeSelectionGroups();
  selectionGroupControls.refresh();
  toolPanels.setToolEnabled('selectionGroups', false);
  scalarColorRanges.clear(); scalarColorSchemes.clear(); scalarHideOutside.clear(); scalarColorModes.clear();
  orientationColorResolver.clear(); orientationSettings = normalizeOrientationSettings(DEFAULT_ORIENTATION_SETTINGS);
  hiddenStructureTypes.clear(); hiddenAtomTypes.clear(); hiddenCategories.clear();
  crystalVisibility.reset();
  currentColorLegend = null;
  for (const [kind, analysis] of Object.entries(state.analysis)) {
    analysis.request++;
    analysis.enabled = false;
    if (kind === 'coordination') analysis.cutoff = null;
    else { analysis.key = null; analysis.parameters = null; }
    toolPanels.setToolEnabled(kind, false);
    const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
    elements[`${prefix}-state`].textContent = 'Not calculated';
    elements[`${prefix}-state`].classList.remove('ready');
    elements[`metric-${prefix}`].textContent = '—';
    if (kind !== 'coordination') elements[`${prefix}-status`].textContent = ANALYSES[kind].help;
  }
  renderer.clearFrame();
  updateCspMethodUi();
  elements['file-name'].textContent = 'No structure loaded';
  elements['file-meta'].textContent = 'CFG / LAMMPS / XYZ / PDB';
  for (const id of ['format-chip', 'atom-count', 'frame-count', 'cell-kind', 'pbc-flags',
    'metric-index', 'metric-parse', 'metric-upload', 'metric-fps']) elements[id].textContent = '—';
  elements['pbc-flags'].removeAttribute('title');
  elements['trajectory-section'].hidden = true;
  elements.viewport.parentElement.classList.remove('trajectory-visible');
  elements['frame-slider'].max = elements['frame-slider'].value = '0';
  elements['frame-label'].textContent = '0 / 0';
  elements['frame-ticks'].replaceChildren();
  elements['timestep-label'].textContent = 'timestep —';
  updateFrameNavigation(); updateCacheLabel();
  elements['color-mode'].replaceChildren(option('type', 'Atom type'));
  elements['coordinate-mode'].value = 'wrapped';
  elements['coordinate-mode'].querySelector('[value="unwrapped"]').disabled = true;
  elements['lattice-references'].replaceChildren();
  elements['selection-data'].replaceChildren();
  updateSelectionPanel();
  elements.legend.hidden = true;
  elements['color-legend'].replaceChildren();
  elements['slice-position'].value = '100';
  sliceControls.reset();
  updateSlices();
  setRadiusPercent(100);
  toolPanels.selectTool('display');
  elements.sidebar.scrollTop = 0;
  setControlsEnabled(false);
  setLoading(false);
  elements.toast.hidden = elements['interaction-hint'].hidden = true;
  elements['interaction-hint'].classList.remove('is-hiding');
  elements['close-file'].hidden = true;
  if (elements['source-dialog'].open) elements['source-dialog'].close();
  elements['source-options'].replaceChildren();
  elements['file-input'].value = elements['folder-input'].value = '';
  fileDrop.clear();
  elements['empty-state'].hidden = false;
  updateMemoryMetric();
  elements['empty-open'].focus({ preventScroll: true });
}

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
  singleFiles = false,
} = {}) {
  const request = beginSourceOpen();
  const isCurrent = () => request === sourceOpenRequest;
  try {
    if (entries.length > FOLDER_FILE_LIMIT) {
      throw new Error(`The selection contains more than ${formatInteger(FOLDER_FILE_LIMIT)} files. Choose a smaller structure folder.`);
    }
    setLoading(true, `Detecting structures and numbered sequences in ${originLabel}…`);
    const orderedEntries = [...entries].sort((left, right) => (
      localPathCollator.compare(left.relativePath, right.relativePath)
    ));
    const classified = await classifyStructureEntries(orderedEntries, originLabel, isCurrent);
    if (!isCurrent()) return;
    const catalog = catalogLocalSources(classified, { allowManualCfgSequence, singleFiles });
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
    showSourceChooser(catalog, originLabel, classified, { singleFiles });
  } catch (error) {
    if (!isCurrent()) return;
    setLoading(false);
    elements['close-file'].hidden = !state.frame;
    showToast(error.message ?? String(error));
  } finally {
    finishSourceOpen(request);
  }
}

async function classifyStructureEntries(entries, originLabel, isCurrent) {
  const classified = new Array(entries.length);
  let cursor = 0;
  let completed = 0;
  const scanNext = async () => {
    while (cursor < entries.length && isCurrent()) {
      const index = cursor;
      const entry = entries[index];
      cursor += 1;
      let format = null;
      if (isPotentialStructurePath(entry.relativePath)) {
        const header = await readStructureHeader(entry.file);
        if (!isCurrent()) return;
        const detectedFormat = detectStructureFormatHeader(header);
        const filenameHint = inferStructureFormatFromPath(entry.relativePath);
        format = detectedFormat ?? (['cfg', 'xyz', 'pdb', 'poscar'].includes(filenameHint) ? filenameHint : null);
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
  return `No CFG, LAMMPS, XYZ, PDB or POSCAR data was recognized in ${count} candidate file${count === 1 ? '' : 's'}. First candidate: “${first.relativePath}” (${formatBytes(first.file.size)}), beginning “${compactPreview}”.`;
}

function showSourceChooser(catalog, originLabel, entries = state.availableEntries, { singleFiles = false } = {}) {
  elements['source-dialog-kicker'].textContent = 'LOCAL SOURCES';
  elements['source-dialog-title'].textContent = singleFiles ? 'Choose a file to open' : 'Choose a structure or sequence';
  elements['source-dialog-summary'].textContent = singleFiles
    ? `Choose one of the ${catalog.supportedCount} recognized structure files. Each file opens individually.`
    : `The browser supplied ${entries.length} files from the ${originLabel}. ${catalog.supportedCount} structure files and ${catalog.sequenceCount} numbered structure sequence${catalog.sequenceCount === 1 ? '' : 's'} were recognized.`;
  const fragment = document.createDocumentFragment();
  const sequences = catalog.sources.filter((source) => source.kind === 'sequence');
  if (sequences.length > 0) {
    fragment.append(sourceListHeading('Detected sequences', `${sequences.length}`));
    for (const source of sequences) {
      fragment.append(sourceOption(
        source,
        `${sourceFormatLabel(source.format)} sequence`,
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
      fragment.append(sourceOption(single, sourceFormatLabel(entry.format), single.detail));
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
  if (exampleCatalog) renderExampleCatalog(exampleCatalog);
  else {
    elements['source-options'].replaceChildren();
    elements['source-dialog-summary'].textContent = 'Loading bundled examples…';
  }
  void loadExampleCatalog({ refresh: true }).then(catalog => {
    if (elements['source-dialog'].open && elements['source-dialog-kicker'].textContent === 'EXAMPLES') renderExampleCatalog(catalog);
  }).catch(error => {
    if (!elements['source-dialog'].open || elements['source-dialog-kicker'].textContent !== 'EXAMPLES') return;
    elements['source-dialog-summary'].textContent = error.message;
    if (!exampleCatalog) elements['source-options'].replaceChildren(exampleOption('Retry loading examples', 'Retry', '', showExampleChooser));
  });
  elements['source-dialog'].showModal();
}

function loadExampleCatalog({ refresh = false } = {}) {
  if (exampleCatalog && !refresh) return Promise.resolve(exampleCatalog);
  if (exampleCatalogPromise) return exampleCatalogPromise;
  exampleCatalogPromise = fetch(new URL('../examples/manifest.json', import.meta.url), { cache: 'no-cache' }).then(async response => {
    if (!response.ok) throw new Error(`Example list request failed: HTTP ${response.status}`);
    const catalog = await response.json();
    if (catalog.version !== 1 || !Array.isArray(catalog.examples)) throw new Error('Invalid example list.');
    exampleCatalog = catalog;
    return catalog;
  }).finally(() => { exampleCatalogPromise = null; });
  return exampleCatalogPromise;
}

function renderExampleCatalog(catalog) {
  elements['source-dialog-summary'].textContent = catalog.examples.length
    ? 'Files and folders bundled under examples/.' : 'No supported structure files are bundled under examples/.';
  const fragment = document.createDocumentFragment();
  fragment.append(sourceListHeading('examples/', `${catalog.examples.length} items`));
  for (const entry of catalog.examples) fragment.append(exampleOption(
    entry.label, entry.kind === 'sequence' ? 'Folder' : sourceFormatLabel(entry.format),
    entry.detail, () => loadCatalogExample(entry),
  ));
  elements['source-options'].replaceChildren(fragment);
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

async function loadCatalogExample(entry) {
  const request = beginSourceOpen();
  const controller = new AbortController();
  sourceFetchController = controller;
  try {
    setLoading(true, 'Loading example…');
    const files = await Promise.all(entry.files.map(async file => {
      const response = await fetch(new URL(file.url, import.meta.url), { signal: controller.signal });
      if (!response.ok) throw new Error(`Example request failed for ${file.name}: HTTP ${response.status}`);
      return new File([await response.blob()], file.name, { type: 'text/plain' });
    }));
    if (request !== sourceOpenRequest) return;
    await loadFiles(files, entry.kind === 'sequence'
      ? { kind: 'sequence', detected: true, label: entry.label, format: entry.format } : null);
  } catch (error) {
    if (request !== sourceOpenRequest) return;
    setLoading(false);
    elements['close-file'].hidden = !state.frame;
    showToast(error.message);
  } finally {
    if (sourceFetchController === controller) sourceFetchController = null;
    finishSourceOpen(request);
  }
}

async function loadFiles(inputFiles, sourceDescriptor = null) {
  const selectionRequest = beginSourceOpen();
  clearTimeout(cutoffTimer);
  abortAnalysisJobs();
  analysisPool.clearVoronoiFrames();
  void gpuPrefetch.clearSource();
  stopFramePlayback();
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const files = [...inputFiles].sort((left, right) => collator.compare(left.name, right.name));
  const sourceVersion = state.sourceVersion + 1;
  state.sourceVersion = sourceVersion;
  // Module initialization overlaps file indexing. The parsed atom count grows
  // these same pools before the user starts an analysis.
  void cpuPrefetch.warmModules({ sourceKey: sourceVersion });
  state.prefetchToken += 1;
  framePrefetchController?.abort();
  framePrefetchController = null;
  frameNavigationController?.abort();
  frameNavigationController = null;
  state.pendingFrames.clear();
  const request = state.frameRequest + 1;
  state.frameRequest = request;
  worker.reset();
  elements['file-name'].textContent = sourceDescriptor?.label ?? (files.length > 1
    ? `${files[0].name} … ${files.at(-1).name}` : files[0].name);
  setLoading(true, files.length > 1 ? `Reading ${files.length} local CFG files…` : 'Reading local file…');
  try {
    const result = await worker.load(files);
    if (selectionRequest !== sourceOpenRequest || request !== state.frameRequest || sourceVersion !== state.sourceVersion) return;
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
    const initialIndex = worker.sourceInfo ?? result;
    state.frameCount = Math.max(result.frameCount, initialIndex.frameCount);
    state.indexComplete = initialIndex.indexComplete !== false;
    state.indexError = initialIndex.error ?? null;
    result.frameCount = state.frameCount;
    state.frameIndex = 0;
    analysisPool.associateGpuFrame(result.frame, 0);
    state.selectedId = null;
    state.selectionGroups = normalizeSelectionGroups();
    selectionGroupControls.refresh();
    toolPanels.setToolEnabled('selectionGroups', false);
    state.colorMode = 'type';
    state.coordinateMode = 'wrapped';
    state.periodicOrigin = [0, 0, 0];
    renderer.setPeriodicOrigin(state.periodicOrigin, { coordinateMode: state.coordinateMode });
    renderer.setCellWireframeMode('mono');
    externalProperties.reset();
    expressionTools.reset();
    toolPanels.setToolEnabled('expressions', false);
    result.frame.frameIndex = 0;
    state.repetitions = [1, 1, 1];
    state.replicateAtoms = false;
    state.processingRevision++;
    sliceControls.reset();
    state.source = sourceDescriptor;
    state.analysis.coordination = { enabled: false, cutoff: null, request: 0 };
    state.analysis.cna = { enabled: false, parameters: null, key: null, request: 0 };
    state.analysis.centrosymmetry = { enabled: false, parameters: null, key: null, request: 0 };
    state.analysis.ptm = { enabled: false, parameters: null, key: null, request: 0 };
    state.analysis.strain = { enabled: false, parameters: null, key: null, request: 0 };
    atomEyeTools.reset();
    dxaTools.reset();
    topologyTools?.reset();
    clusterTools?.reset();
    grainTools?.reset();
    wignerSeitzTools?.reset();
    surfaceTools?.reset();
    binningTools?.reset();
    trajectoryTools?.reset();
    voronoiCells?.reset();
    timeSeries?.reset();
    movieControls?.reset();
    globalAttributes?.reset();
    for (const kind of Object.keys(state.analysis)) toolPanels.setToolEnabled(kind, false);
    toolPanels.setToolEnabled('replicate', false);
    state.references = result.frame.typeLabels.map(referenceForElement);
    state.referenceLabels = [...result.frame.typeLabels];
    state.referenceByLabel.clear();
    renderLatticeReferences(result.frame);
    hiddenStructureTypes.clear();
    hiddenAtomTypes.clear();
    hiddenCategories.clear();
    crystalVisibility.reset();
    elements['metric-cna'].textContent = elements['metric-csp'].textContent = '—';
    elements['metric-ptm'].textContent = elements['metric-strain'].textContent = '—';
    scalarColorRanges.clear();
    scalarColorSchemes.clear();
    scalarHideOutside.clear();
    scalarColorModes.clear(); orientationColorResolver.clear(); orientationSettings = normalizeOrientationSettings(DEFAULT_ORIENTATION_SETTINGS);
    setRadiusPercent(100);
    configureSuggestedCutoff(result.frame);
    elements['metric-index'].textContent = formatDuration(Math.max(0, result.indexMs));
    configureSourceUi(result);
    await displayFrame(result.frame, { resetCamera: true });
    if (selectionRequest !== sourceOpenRequest || request !== state.frameRequest || sourceVersion !== state.sourceVersion) return;
    elements['empty-state'].hidden = true;
    finishSourceOpen(selectionRequest);
    setLoading(false);
    updateSourceIndex(worker.sourceInfo ?? result);
    showInteractionHint();
    scheduleFramePrefetch(0);
    if (state.indexError) showToast(`Trajectory indexing stopped: ${state.indexError}`);
    else showToast(
      files.length > 1
        ? `Loaded ${result.frameCount} frames from ${files.length} local files; the first frame has ${formatInteger(result.frame.ids.length)} atoms.`
        : `Loaded ${formatInteger(result.frame.ids.length)} atoms locally.`,
      true,
    );
    if (pendingConfiguration && matchesSource(pendingConfiguration, state.files, state.format)) {
      const saved = pendingConfiguration;
      const restoreRequest = configurationRequest;
      pendingConfiguration = null;
      try { await restoreConfiguration(saved); }
      catch (error) {
        if (selectionRequest === sourceOpenRequest && restoreRequest === configurationRequest) {
          elements['configuration-status'].textContent = `Could not restore configuration: ${error.message}`;
          showToast(error.message);
        }
      }
    }
  } catch (error) {
    if (selectionRequest === sourceOpenRequest && request === state.frameRequest) {
      setLoading(false);
      elements['close-file'].hidden = !state.frame;
      showToast(error.message);
    }
  } finally {
    finishSourceOpen(selectionRequest);
  }
}

function configureSuggestedCutoff(frame) {
  const recommendation = inferCoordinationCutoffPreset(frame);
  elements.cutoff.value = recommendation.value.toFixed(2);
  elements['cna-cutoff'].value = recommendation.value.toFixed(2);
  elements['coordination-cutoff-preset'].value = recommendation.symbol ?? 'custom';
  elements['cutoff-help'].textContent = `Suggested cutoff: ${recommendation.message}`;
}

function editCoordinationCutoff({ immediate = false } = {}) {
  interruptConfigurationRestore('a cutoff edit');
  elements['coordination-cutoff-preset'].value = 'custom';
  updateCoordinationCutoffHelp();
  scheduleCutoffAnalysis({ immediate });
}

function updateCoordinationCutoffHelp() {
  const preset = coordinationCutoffPresetForElement(elements['coordination-cutoff-preset'].value);
  elements['cutoff-help'].textContent = preset
    ? `${preset.symbol} (${preset.name}): ${preset.cutoff.toFixed(2)} Å starting estimate. Verify against the first minimum of g(r); edit the radius for a custom value.`
    : 'Custom cutoff: enter a positive radius in Å. Verify against the first minimum of g(r).';
}

function configureSourceUi(result) {
  const totalBytes = state.files.reduce((total, file) => total + file.size, 0);
  elements['file-name'].textContent = state.source?.label ?? (state.files.length > 1
    ? `${state.files[0].name} … ${state.files.at(-1).name}`
    : state.file.name);
  elements['file-meta'].textContent = state.files.length > 1
    ? `${formatBytes(totalBytes)} · ${state.files.length} local files${state.source?.detected ? ' · numbered sequence' : ''}`
    : `${formatBytes(totalBytes)} · local browser file`;
  elements['format-chip'].textContent = sourceFormatLabel(result.format);
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

function updateSourceIndex(info) {
  if (!state.file || !state.frame || sourceLoadingOwner !== null || info.format !== state.format) return;
  const previousCount = state.frameCount;
  const previousError = state.indexError;
  state.frameCount = Math.max(1, info.frameCount);
  state.indexComplete = info.indexComplete !== false;
  state.indexError = info.error ?? null;
  elements['frame-count'].textContent = `${formatInteger(state.frameCount)}${state.indexComplete ? '' : '+'}`;
  elements['frame-slider'].max = String(state.frameCount - 1);
  elements['frame-label'].textContent = `${state.frameIndex + 1} / ${state.frameCount}${state.indexComplete ? '' : '+'}`;
  elements['trajectory-section'].hidden = state.frameCount <= 1 && state.indexComplete;
  elements.viewport.parentElement.classList.toggle('trajectory-visible', state.frameCount > 1 || !state.indexComplete);
  elements['metric-index'].textContent = formatDuration(Math.max(0, info.indexMs ?? 0));
  if (previousCount !== state.frameCount) {
    state.cachePlan = chooseFrameCachePolicy(state.frame, state.frameCount, {
      heapLimit: performance.memory?.jsHeapSizeLimit, heapUsed: performance.memory?.usedJSHeapSize,
      deviceMemoryGiB: navigator.deviceMemory,
    });
    cache.setLimit(state.cachePlan.limit);
    renderFrameTicks(state.frameCount);
    for (const name of ['reference-frame', 'displacement-reference-frame', 'export-series-first', 'export-series-last']) {
      const input = document.getElementById(name);
      if (!input) continue;
      if (name === 'export-series-last' && Number(input.value) === previousCount) input.value = String(state.frameCount);
      input.max = String(state.frameCount);
    }
    updateCacheLabel();
    trajectoryTools?.refresh();
    movieControls?.refresh();
    if (state.indexComplete) scheduleFramePrefetch(state.frameIndex);
  }
  if (info.error && info.error !== previousError) showToast(`Trajectory indexing stopped: ${info.error}`);
  updateFrameNavigation();
  setRangeProgress(elements['frame-slider']);
}

async function waitForSourceIndex({ signal } = {}) {
  if (signal?.aborted) throw new DOMException('Trajectory indexing wait cancelled.', 'AbortError');
  const version = state.sourceVersion;
  if (!state.indexComplete) {
    await worker.waitForIndex({ signal });
    if (version !== state.sourceVersion) throw new DOMException('Structure source closed.', 'AbortError');
    if (worker.sourceInfo) updateSourceIndex(worker.sourceInfo);
  }
  if (state.indexError) throw new Error(`Trajectory indexing stopped: ${state.indexError}`);
}

function sourceFormatLabel(format) {
  const sequence = format.endsWith('-sequence');
  const base = sequence ? format.slice(0, -9) : format;
  return `${({ cfg: 'CFG', 'lammps-dump': 'LAMMPS', 'lammps-data': 'LAMMPS data', xyz: 'XYZ', pdb: 'PDB', poscar: 'POSCAR' })[base] ?? base.toUpperCase()}${sequence ? ' · sequence' : ''}`;
}

async function showFrame(index) {
  if (sourceLoadingOwner !== null) return false;
  if (!Number.isInteger(index) || index < 0 || index >= state.frameCount) return false;
  const navigation = beginFrameNavigation();
  if (index !== state.frameIndex) cancelLatticeEstimation();
  const interruptedReplication = Boolean(replicationController);
  if (interruptedReplication) {
    replicationController.abort();
    replicationRequest++;
    configureReplicationUi();
  }
  const request = state.frameRequest + 1;
  state.frameRequest = request;
  // The displayed frame is kept unless a smoothing change has not reached it,
  // for example when this request interrupts the one that applies the change.
  if (index === state.frameIndex && displayedSmoothingWindow() === trajectoryTools.smoothingWindow()) {
    elements['frame-slider'].value = String(index);
    elements['frame-label'].textContent = `${index + 1} / ${state.frameCount}`;
    setRangeProgress(elements['frame-slider']);
    setLoading(false);
    if (interruptedReplication) await displayFrame(state.frame);
    if (request !== state.frameRequest) return false;
    scheduleGpuFramePrefetch();
    return true;
  }
  gpuPrefetch.cancel();
  cancelFramePrefetch();
  const requiresLoad = !cache.has(index);
  if (requiresLoad) setLoading(true, `Preparing frame ${index + 1}…`, navigation, true);
  try {
    const frame = await getFrame(index, { signal: navigation.signal });
    if (request !== state.frameRequest) return false;
    if (!frame) return false;
    if (state.coordinateMode === 'unwrapped' && trajectoryTools.needsInferredUnwrap(frame)) {
      // A frame cached before Unwrapped was chosen: attach its inferred
      // coordinates first, rather than showing it wrapped for a moment.
      try { await trajectoryTools.ensureInferredUnwrap(frame, index, { signal: navigation.signal, showProgress: requiresLoad }); }
      catch (error) { if (error.name === 'AbortError') return false; showToast(error.message); }
      if (request !== state.frameRequest) return false;
    }
    state.frameIndex = index;
    if (state.playing) preparePlaybackBuffer();
    await displayFrame(frame);
    if (request !== state.frameRequest) return false;
    scheduleFramePrefetch(index);
    return true;
  } catch (error) {
    if (request === state.frameRequest) {
      elements['frame-slider'].value = String(state.frameIndex);
      showToast(error.message);
      scheduleGpuFramePrefetch();
    }
    return false;
  } finally {
    // Also when another request took over without showing the indicator.
    if (loadingOwner === navigation) setLoading(false);
  }
}

async function displayFrame(frame, { resetCamera = false } = {}) {
  abortAnalysisJobs();
  state.frame = frame;
  // Prepare modules, snapshots and neighbour indices alongside the first
  // render. Automatic analyses retain priority over both background queues.
  void cpuPrefetch.setFrame({ sourceKey: state.sourceVersion, frame });
  scheduleGpuFramePrefetch({ committedFrame: frame });
  selectionGroupControls.refresh();
  syncSelectionGroupInteraction();
  // Previous-frame "Calculated" labels cannot describe pending outputs in the
  // newly selected frame. Keep chosen computed vector sources while replaying.
  for (const [kind, analysis] of Object.entries(state.analysis)) {
    if (!analysis.enabled) continue;
    const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
    elements[`${prefix}-state`].textContent = 'Queued';
    elements[`${prefix}-state`].classList.remove('ready');
  }
  renderLatticeReferences(frame);
  syncAxisVisibility();
  configureCoordinateMode(frame);
  refreshColorOptions();
  const palette = atomEyeTools.customizePalette(paletteForCurrentMode());
  const uploadMs = renderer.setFrame(frame, palette.colors, displayPositionsForFrame(frame), radiiByType(frame), displayRepetitions(),
    { coordinateMode: displayCoordinateMode(frame) });
  trajectoryTools?.onFrame();
  if (state.coordinateMode === 'unwrapped' && trajectoryTools?.needsInferredUnwrap(frame)) {
    // Frames shown outside normal navigation (replication, restore) catch up.
    void trajectoryTools.ensureInferredUnwrap(frame, state.frameIndex, { showProgress: false }).then(ready => {
      if (ready && state.frame === frame && state.coordinateMode === 'unwrapped') applyCoordinateMode({ resetCamera: false });
    }).catch(() => {});
  }
  configurePeriodicOriginUi();
  sliceControls.refreshPickedAtoms();
  configureReplicationUi();
  applyScalarVisibility(palette.legend);
  renderLegend(palette.legend);
  statisticsExports?.refresh();
  globalAttributes?.refresh();
  if (resetCamera) renderer.resetCamera();
  updateSlices();
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
  updateCspMethodUi();
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
  pending.push(atomEyeTools.onFrame({ suggestedCutoff: recommendCoordinationCutoff(frame).value }));
  pending.push(dxaTools.onFrame());
  pending.push(topologyTools.onFrame());
  pending.push(clusterTools.onFrame({ suggestedCutoff: recommendCoordinationCutoff(frame).value }));
  pending.push(grainTools.onFrame());
  pending.push(wignerSeitzTools.onFrame());
  pending.push(surfaceTools.onFrame());
  pending.push(binningTools.onFrame());
  syncCancelButton('coordination');
  await Promise.all(pending);
}

async function getFrame(index, { background = false, cacheFrame = true, signal, sourceKey } = {}) {
  if (signal?.aborted || (sourceKey && sourceKey !== processingSourceKey())) return null;
  const cached = cacheFrame ? cache.get(index) : cache.frames.get(index);
  if (cached) {
    analysisPool.associateGpuFrame(cached, index);
    return cached;
  }
  const existing = state.pendingFrames.get(index);
  if (existing && !existing.signal?.aborted && (background || !existing.background)) {
    if (cacheFrame) existing.cacheFrame = true;
    return existing.promise;
  }
  const sourceVersion = state.sourceVersion;
  const processingRevision = state.processingRevision;
  const physical = state.replicateAtoms, repetitions = [...state.repetitions];
  const pending = { cacheFrame, promise: null, background, signal };
  // Smoothing and inferred unwrapping run in the structure Worker. Without
  // them the request is unchanged; smoothing edits bump processingRevision.
  const trajectory = trajectoryTools?.frameRequestOptions() ?? null;
  pending.promise = worker.frame(index, { reportProgress: !background, background, signal, trajectory })
    .then(async (result) => {
      const preparationSignal = framePreparationSignal(signal, () =>
        sourceVersion === state.sourceVersion && processingRevision === state.processingRevision
          && (!sourceKey || sourceKey === processingSourceKey()));
      if (preparationSignal.aborted) return null;
      result.frame.frameIndex = index;
      await externalProperties.applyToFrame(result.frame);
      if (preparationSignal.aborted) return null;
      const frame = physical ? await prepareAnalysisFrame(result.frame, repetitions, true, { signal: preparationSignal, background }) : result.frame;
      if (preparationSignal.aborted) return null;
      analysisPool.associateGpuFrame(frame, index);
      // GPU residency can extend beyond the CPU window without evicting the
      // displayed frame or retaining the whole sequence twice in host memory.
      if (pending.cacheFrame && state.pendingFrames.get(index) === pending) {
        if (background && cache.has(state.frameIndex)) cache.get(state.frameIndex);
        cache.set(index, frame);
        updateCacheLabel();
      }
      return frame;
    })
    .finally(() => {
      if (state.pendingFrames.get(index) === pending) state.pendingFrames.delete(index);
    });
  state.pendingFrames.set(index, pending);
  return pending.promise;
}

function cancelFramePrefetch() {
  state.prefetchToken++;
  framePrefetchController?.abort();
  framePrefetchController = null;
  worker.cancelPrefetch();
}

function scheduleFramePrefetch(centerIndex) {
  cancelFramePrefetch();
  if (state.frameCount <= 1 || !state.cachePlan) return;
  const controller = new AbortController();
  framePrefetchController = controller;
  const token = state.prefetchToken;
  const indices = prefetchOrder(centerIndex, state.frameCount, state.cachePlan.limit, state.cachePlan.fullTrajectory);
  const concurrency = Math.max(1, Math.min(4, cpuBudget.limit - 1, state.cachePlan.limit - 1,
    Math.floor(128 * 1024 ** 2 / Math.max(1, state.cachePlan.estimatedFrameBytes))));
  let cursor = 0;
  const lane = async () => {
    while (cursor < indices.length && token === state.prefetchToken && !controller.signal.aborted) {
      const index = indices[cursor++];
      if (cache.has(index)) continue;
      try {
        await getFrame(index, { background: true, signal: controller.signal });
        if (cache.has(centerIndex)) cache.get(centerIndex);
      } catch (error) {
        if (error.name === 'AbortError' || controller.signal.aborted) return;
        // A malformed speculative frame must not stop the other available
        // frames; requesting it explicitly will display the parser's error.
      }
    }
  };
  const run = () => { if (!controller.signal.aborted) void Promise.all(Array.from({ length: concurrency }, lane)); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 800 });
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
  elements['frame-last'].disabled = atEnd && state.indexComplete;
  elements['frame-play'].disabled = state.frameCount <= 1;
}

function showFrameManually(index) {
  atomEyeTools.cancelBatch({ restore: false });
  interruptConfigurationRestore('a frame change');
  stopFramePlayback();
  void showFrame(index);
}

function toggleFramePlayback() {
  atomEyeTools.cancelBatch({ restore: false });
  interruptConfigurationRestore('trajectory playback');
  if (state.playing) {
    stopFramePlayback();
    return;
  }
  if (state.frameCount <= 1) return;
  state.playing = true;
  updatePlaybackButton();
  preparePlaybackBuffer();
  schedulePlaybackStep();
}

function preparePlaybackBuffer() {
  if (!state.playing || state.frameCount <= 1) return;
  const index = nextPlaybackFrame(state.frameIndex, state.frameCount);
  const sourceVersion = state.sourceVersion;
  if (playbackBuffer?.index === index && playbackBuffer.sourceVersion === sourceVersion) return;
  playbackBuffer?.controller.abort();
  const controller = new AbortController();
  const promise = getFrame(index, { signal: controller.signal }); // Reserved foreground lane.
  promise.catch(() => {});
  playbackBuffer = { index, sourceVersion, promise, controller };
}

function schedulePlaybackStep() {
  clearTimeout(playbackTimer);
  playbackTimer = setTimeout(async () => {
    if (!state.playing || state.frameCount <= 1) return;
    const sourceVersion = state.sourceVersion;
    if (!state.indexComplete && state.frameIndex === state.frameCount - 1) {
      schedulePlaybackStep(); // Wait for the next discovered frame instead of wrapping early.
      return;
    }
    const next = nextPlaybackFrame(state.frameIndex, state.frameCount);
    try {
      if (playbackBuffer?.index === next && playbackBuffer.sourceVersion === sourceVersion) await playbackBuffer.promise;
      const displayed = await showFrame(next);
      if (!displayed || !state.playing || sourceVersion !== state.sourceVersion) { stopFramePlayback(); return; }
      preparePlaybackBuffer();
      schedulePlaybackStep();
    } catch (error) {
      stopFramePlayback();
      if (error.name !== 'AbortError' && sourceVersion === state.sourceVersion) showToast(error.message);
    }
  }, DEFAULT_PLAYBACK_INTERVAL_MS);
}

function stopFramePlayback() {
  clearTimeout(playbackTimer);
  playbackTimer = null;
  playbackBuffer?.controller.abort();
  playbackBuffer = null;
  if (!state.playing) return;
  state.playing = false;
  updatePlaybackButton();
  // The frame playback stopped on stays displayed: prepare it without the playback delay.
  scheduleGpuFramePrefetch();
}

function updatePlaybackButton() {
  elements['frame-play'].textContent = state.playing ? '❚❚' : '▶';
  elements['frame-play'].title = state.playing ? 'Pause trajectory' : 'Play at 1 frame per second';
  elements['frame-play'].setAttribute('aria-label', state.playing ? 'Pause trajectory' : 'Play trajectory');
  elements['frame-play'].setAttribute('aria-pressed', String(state.playing));
  elements['frame-play'].classList.toggle('active', state.playing);
}

function updateCacheLabel() {
  const label = elements['cache-label'];
  const cpuLabel = !state.cachePlan ? `cached ${cache.size}` : state.cachePlan.fullTrajectory
    ? `cached ${cache.size} / ${state.frameCount} · lazy all-frame`
    : `cached ${cache.size} / ${state.cachePlan.limit} · adaptive window`;
  const status = analysisPool.gpuEnabled ? gpuPreparationStatus : null;
  const gpuCache = status?.cacheStatus ? analysisPool.gpuCacheStatus ?? status.cacheStatus : null;
  const cachedFrames = gpuCache?.cachedFrameIndexes?.length ?? 0;
  label.dataset.gpuCacheState = status?.phase ?? 'off';
  label.dataset.gpuCachedFrames = String(cachedFrames);
  label.dataset.gpuCacheCapacity = String(gpuCache?.capacity ?? 0);
  label.dataset.gpuCacheIndexes = JSON.stringify(gpuCache?.cachedFrameIndexes ?? []);
  // The device self-test of double-float pairs: true, false, or unknown before it ran.
  label.dataset.gpuExactPairs = String(gpuCache?.exactPairs ?? 'unknown');
  const gpuLabel = status?.phase === 'warming' ? ' · GPU preparing'
    : status?.phase === 'unavailable' ? ' · GPU unavailable'
      : gpuCache && state.frameCount > 0
        ? ` · GPU ${cachedFrames} / ${Math.min(state.frameCount, gpuCache.capacity)} ${gpuCache.fullTrajectory ? 'frames' : 'nearby frames'}${status.phase === 'preparing' ? ' · preparing' : ''}`
        : '';
  label.textContent = cpuLabel + gpuLabel;
}

function reassessFrameCache(frame) {
  updateCacheLabel();
  if (!state.cachePlan || state.frameCount <= 1) return;
  const revised = chooseFrameCachePolicy(frame, state.frameCount, {
    heapLimit: performance.memory?.jsHeapSizeLimit,
    heapUsed: performance.memory?.usedJSHeapSize,
    deviceMemoryGiB: navigator.deviceMemory,
  });
  if (revised.limit >= cache.limit) return;
  state.cachePlan = revised;
  cancelFramePrefetch();
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
  for (const prefix of ['', 'voronoi-']) {
    elements[`${prefix}radius-scale`].value = String(sliderPercentage);
    elements[`${prefix}radius-percent`].value = String(percentage);
    setRangeProgress(elements[`${prefix}radius-scale`]);
  }
  renderer.setRadiusScale(percentage / 100);
  atomEyeTools?.syncComparison();
}

/** File image data wins; inferred coordinates serve display paths only. */
function unwrappedPositionsOf(frame) {
  return frame?.unwrappedPositions ?? frame?.inferredUnwrap?.unwrappedPositions ?? null;
}

/** Inference needs more than one frame and the source atoms themselves:
 * physical replication derives copies from image flags, so it is excluded. */
function canInferUnwrap(frame = state.frame) {
  return Boolean(frame) && !frame.unwrappedPositions && (state.frameCount > 1 || !state.indexComplete) && !state.replicateAtoms;
}

/** The mode actually drawn: Unwrapped waits for inferred coordinates. */
function displayCoordinateMode(frame = state.frame) {
  return state.coordinateMode === 'unwrapped' && unwrappedPositionsOf(frame) ? 'unwrapped' : 'wrapped';
}

function configureCoordinateMode(frame) {
  const unwrappedOption = elements['coordinate-mode'].querySelector('option[value="unwrapped"]');
  const inferable = canInferUnwrap(frame);
  const available = Boolean(frame.unwrappedPositions) || inferable;
  unwrappedOption.disabled = !available;
  unwrappedOption.textContent = frame.unwrappedPositions
    ? `Unwrapped coordinates (${frame.unwrapSource})`
    : inferable ? `Unwrapped coordinates (${INFERRED_UNWRAP_SOURCE})` : 'Unwrapped coordinates (not available)';
  if (!available && state.coordinateMode === 'unwrapped') {
    state.coordinateMode = 'wrapped';
    showToast('This frame has no unwrapped coordinates; display returned to wrapped coordinates.');
  }
  elements['coordinate-mode'].value = state.coordinateMode;
}

function displayPositionsForFrame(frame = state.frame) {
  return displayCoordinateMode(frame) === 'unwrapped' ? unwrappedPositionsOf(frame) : frame?.positions;
}

function displayedAtomPoint(id, replicaIndices = [0, 0, 0]) {
  if (id === null || id === undefined || !state.frame || !renderer.displayPositions) return null;
  const counts = displayRepetitions();
  if (replicaIndices.length !== 3 || replicaIndices.some((value, axis) => !Number.isInteger(value) || value < 0 || value >= counts[axis])) return null;
  const index = state.frame.ids.indexOf(id);
  if (index < 0) return null;
  const point = Array.from(renderer.displayPositions.slice(index * 3, index * 3 + 3));
  for (let axis = 0; axis < 3; axis++) {
    for (let component = 0; component < 3; component++) point[component] += replicaIndices[axis] * state.frame.cell.vectors[axis * 3 + component];
  }
  return point;
}

function configurePeriodicOriginUi(enabled = Boolean(state.frame) && sourceLoadingOwner === null) {
  for (const [axis, name] of ['a', 'b', 'c'].entries()) {
    const input = document.getElementById(`display-origin-${name}`);
    if (document.activeElement !== input) input.value = String(state.periodicOrigin[axis]);
    input.disabled = !enabled || !state.frame?.cell.pbc[axis];
    input.title = state.frame?.cell.pbc[axis] ? `Fractional display origin along cell vector ${name}` : 'This cell direction is not periodic.';
  }
  document.getElementById('origin-reset').disabled = !enabled;
  document.getElementById('origin-center-selected').disabled = !enabled || state.selectedId === null;
  crystalDrag?.setEnabled(enabled && Boolean(state.frame?.cell.pbc.some(Boolean)));
}

function setPeriodicOrigin(values, { preserveInput = false } = {}) {
  if (!state.frame) return;
  const origin = values.map((value, axis) => state.frame.cell.pbc[axis] ? Number(value) : 0);
  if (origin.length !== 3 || origin.some(value => !Number.isFinite(value) || Math.abs(value) > 1e12)) return;
  interruptConfigurationRestore('a periodic display origin edit');
  atomEyeTools?.cancelBatch({ restore: false });
  state.periodicOrigin = origin;
  renderer.setPeriodicOrigin(origin, { coordinateMode: displayCoordinateMode() });
  if (!preserveInput) for (const [axis, name] of ['a', 'b', 'c'].entries()) {
    const input = document.getElementById(`display-origin-${name}`);
    input.value = String(origin[axis]);
    input.setCustomValidity('');
  }
  configurePeriodicOriginUi();
  sliceControls.refreshPickedAtoms();
  sliceGizmo?.update();
  restoreSelection();
  atomEyeTools?.updateMeasurements();
  atomEyeTools?.syncComparison();
}

function updatePeriodicOrigin() {
  const controls = ['a', 'b', 'c'].map(axis => document.getElementById(`display-origin-${axis}`));
  const values = controls.map((input, axis) => state.frame?.cell.pbc[axis] ? input.valueAsNumber : 0);
  for (const [axis, input] of controls.entries()) input.setCustomValidity(
    Number.isFinite(values[axis]) && Math.abs(values[axis]) <= 1e12 ? '' : 'Enter a finite fractional offset.');
  if (values.every(value => Number.isFinite(value) && Math.abs(value) <= 1e12)) setPeriodicOrigin(values, { preserveInput: true });
}

function centerPeriodicOriginOnSelected() {
  if (!state.frame || state.selectedId === null) return;
  const index = state.frame.ids.indexOf(state.selectedId);
  if (index < 0) return;
  setPeriodicOrigin([0, 1, 2].map(axis => state.frame.cell.pbc[axis] ? state.frame.fractional[index * 3 + axis] - 0.5 : 0));
}

async function refreshExternalProperties({ restoring = false, reason, oldName, name } = {}) {
  if (!externalProperties || !state.frame) return;
  if (!restoring) interruptConfigurationRestore('an external attribute edit');
  const version = state.sourceVersion;
  const frames = new Set([state.frame, ...cache.frames.values()]);
  for (const frame of [...frames]) frames.add(sourceFrame(frame));
  for (const frame of frames) {
    await externalProperties.applyToFrame(frame, { sourceFrame: sourceFrame(frame) });
    if (version !== state.sourceVersion) return;
  }
  if (reason === 'rename') {
    if (state.colorMode === `property:${oldName}`) state.colorMode = `property:${name}`;
    for (const preferences of [scalarColorRanges, scalarColorSchemes, scalarHideOutside, scalarColorModes, hiddenCategories]) {
      const oldKey = colorPropertyKey(oldName), key = colorPropertyKey(name);
      if (!preferences.has(oldKey)) continue;
      preferences.set(key, preferences.get(oldKey));
      preferences.delete(oldKey);
    }
    atomEyeTools?.renameProperty(oldName, name);
  }
  externalProperties.refresh();
  toolPanels.setToolEnabled('externalProperties', externalProperties.getState().files.length > 0);
  refreshColorOptions();
  applyColors();
  restoreSelection();
  atomEyeTools?.refreshProperties();
  reassessFrameCache(state.frame);
  updateMemoryMetric();
  if (externalProperties.getPendingFiles().length) elements['configuration-status'].textContent =
    `Reselect external property files in Modification → External properties: ${externalProperties.getPendingFiles().map(file => file.name).join(', ')}. Their values have not been restored.`;
  else if (!restoring && /external property files/i.test(elements['configuration-status'].textContent)) {
    elements['configuration-status'].textContent = 'External property data restored. Saved property and vector settings are ready.';
  }
}

/** Computed property definitions changed. The displayed frame is recalculated
 * by refreshColorOptions(); cached frames recalculate when displayed. A renamed
 * property keeps its color choice and legend settings. */
function refreshComputedProperties({ reason, name, removed = [] } = {}) {
  for (const oldName of removed) {
    const oldKey = colorPropertyKey(oldName), key = colorPropertyKey(name);
    const renamed = reason === 'replace' && name !== undefined;
    for (const preferences of [scalarColorRanges, scalarColorSchemes, scalarHideOutside, scalarColorModes, hiddenCategories]) {
      if (renamed && preferences.has(oldKey)) preferences.set(key, preferences.get(oldKey));
      preferences.delete(oldKey);
    }
    if (renamed && state.colorMode === `property:${oldName}`) state.colorMode = `property:${name}`;
  }
  for (const frame of cache.frames.values()) if (frame !== state.frame) removeComputedProperties(frame);
  toolPanels.setToolEnabled('expressions', expressionTools.getState().properties.length > 0);
  if (!state.frame) return;
  refreshColorOptions();
  applyColors();
  restoreSelection();
  atomEyeTools?.refreshProperties();
  updateMemoryMetric();
}

async function updateCoordinateMode() {
  if (!state.frame) return;
  const requested = elements['coordinate-mode'].value;
  if (requested === 'unwrapped' && !unwrappedPositionsOf(state.frame) && !canInferUnwrap()) {
    elements['coordinate-mode'].value = 'wrapped';
    showToast('Unwrapped display requires explicit image data, meaningful out-of-cell CFG coordinates, or more than one trajectory frame.');
    return;
  }
  if (requested !== 'unwrapped') trajectoryTools.cancelUnwrap();
  state.coordinateMode = requested;
  if (requested === 'unwrapped' && trajectoryTools.needsInferredUnwrap(state.frame)) {
    const frame = state.frame, index = state.frameIndex;
    // Neighboring frames prefetched from now on carry inferred coordinates.
    scheduleFramePrefetch(index);
    try {
      if (!await trajectoryTools.ensureInferredUnwrap(frame, index)) throw new Error('Unwrapped coordinates could not be inferred for this frame.');
    } catch (error) {
      if (state.frame === frame && state.coordinateMode === 'unwrapped') {
        state.coordinateMode = 'wrapped';
        elements['coordinate-mode'].value = 'wrapped';
        if (error.name !== 'AbortError') showToast(error.message);
      }
      return;
    }
    if (state.frame !== frame || state.coordinateMode !== 'unwrapped') return;
  }
  applyCoordinateMode();
}

function applyCoordinateMode({ resetCamera = true } = {}) {
  elements['metric-upload'].textContent = formatDuration(renderer.setDisplayPositions(displayPositionsForFrame(), { coordinateMode: displayCoordinateMode() }));
  if (resetCamera) renderer.resetCamera();
  if (state.colorMode.startsWith('builtin:position:')) applyColors();
  restoreSelection();
  atomEyeTools.updateMeasurements();
  atomEyeTools.syncComparison();
  sliceControls.refreshPickedAtoms();
}

function selectColorMode(value) {
  if (!state.frame || ![...elements['color-mode'].options].some(item => item.value === value)) return;
  interruptConfigurationRestore('a color quantity change');
  atomEyeTools.cancelBatch({ restore: false });
  colorChoiceVersion++;
  state.colorMode = value;
  if (isCrystalStructureProperty(value.slice(9))) crystalVisibility.restore({ source: value.slice(9) });
  elements['color-mode'].value = value;
  applyColors();
}

function refreshColorOptions() {
  const previous = state.colorMode;
  expressionTools?.sync(state.frame);
  elements['color-mode'].replaceChildren(option('type', 'Atom type'));
  const propertyNames = new Set();
  initialColorQuantities(state.frame).forEach(({ value, label }) => {
    if (value.startsWith('property:')) {
      const name = value.slice(9);
      if (propertyNames.has(name)) return;
      propertyNames.add(name);
    }
    elements['color-mode'].append(option(value, label));
  });
  if (((state.analysis.ptm.enabled && !['Failed', 'Calculated'].includes(elements['ptm-state'].textContent))
      || (state.analysis.strain.enabled && !['Failed', 'Calculated'].includes(elements['strain-state'].textContent)))
      && ![...elements['color-mode'].options].some(item => item.value === 'builtin:ptm:ipf')) {
    elements['color-mode'].append(option('builtin:ptm:ipf', 'PTM orientation · inverse pole figure (calculating…)'),
      option('builtin:ptm:quaternion', 'PTM orientation · Rodrigues RGB (calculating…)'));
  }
  // Keep a saved external quantity selected while its local file is pending,
  // or while a frame-scoped column is unavailable in the current frame.
  for (const file of externalProperties?.getState().files ?? []) {
    for (const column of file.columns) {
      if (!column.enabled || propertyNames.has(column.name)) continue;
      propertyNames.add(column.name);
      elements['color-mode'].append(option(`property:${column.name}`, `${column.name}${column.unit ? ` [${column.unit}]` : ''} (waiting for external data…)`));
    }
  }
  for (const { name, label } of expressionTools?.pendingColorProperties() ?? []) {
    if (propertyNames.has(name)) continue;
    propertyNames.add(name);
    elements['color-mode'].append(option(`property:${name}`, `${label} (waiting for expression inputs…)`));
  }
  if (state.analysis.coordination.enabled && !propertyNames.has('coordination')) {
    elements['color-mode'].append(option('property:coordination', 'coordination (calculating…)'));
  }
  for (const [kind, { name, label, prefix }] of Object.entries(ANALYSES)) {
    if (state.analysis[kind].enabled && elements[`${prefix}-state`].textContent !== 'Failed') {
      const outputs = kind === 'strain' ? STRAIN_FIELDS.map(field => [field, field === name ? label : field])
        : kind === 'ptm' ? [[name, label], ...PTM_EXTRA_OUTPUTS]
          : [[name, label]];
      for (const [field, fieldLabel] of outputs) {
        if (!propertyNames.has(field)) elements['color-mode'].append(option(`property:${field}`, `${fieldLabel} (calculating…)`));
      }
    }
  }
  if (state.analysis.centrosymmetry.enabled && state.analysis.centrosymmetry.parameters?.mode === 'auto'
      && elements['csp-state'].textContent !== 'Failed') {
    for (const [name, label] of [['centralSymmetryStructureType', 'Local structure (Auto symmetry)'],
      ['centralSymmetryNeighbors', 'Central symmetry neighbor count']]) {
      if (!propertyNames.has(name)) elements['color-mode'].append(option(`property:${name}`, `${label} (calculating…)`));
    }
  }
  for (const { name, label } of atomEyeTools.pendingColorProperties()) {
    if (!propertyNames.has(name)) elements['color-mode'].append(option(`property:${name}`, `${label} (calculating…)`));
  }
  for (const { name, label } of dxaTools?.pendingColorProperties() ?? []) {
    if (!propertyNames.has(name)) elements['color-mode'].append(option(`property:${name}`, `${label} (calculating…)`));
  }
  for (const { name, label } of topologyTools?.pendingColorProperties() ?? []) {
    if (!propertyNames.has(name)) elements['color-mode'].append(option(`property:${name}`, `${label} (calculating…)`));
  }
  for (const { name, label } of clusterTools?.pendingColorProperties() ?? []) {
    if (!propertyNames.has(name)) elements['color-mode'].append(option(`property:${name}`, `${label} (calculating…)`));
  }
  for (const { name, label } of grainTools?.pendingColorProperties() ?? []) {
    if (!propertyNames.has(name)) elements['color-mode'].append(option(`property:${name}`, `${label} (calculating…)`));
  }
  for (const { value, label } of grainTools?.pendingColorModes() ?? []) {
    if (![...elements['color-mode'].options].some(item => item.value === value)) elements['color-mode'].append(option(value, `${label} (calculating…)`));
  }
  for (const { name, label } of wignerSeitzTools?.pendingColorProperties() ?? []) {
    if (!propertyNames.has(name)) elements['color-mode'].append(option(`property:${name}`, `${label} (calculating…)`));
  }
  const available = [...elements['color-mode'].options].some((item) => item.value === previous);
  state.colorMode = available ? previous : 'type';
  elements['color-mode'].value = state.colorMode;
  atomEyeTools?.updateVectors();
}

function applyColors() {
  if (!state.frame) return;
  try {
    const palette = atomEyeTools.customizePalette(paletteForCurrentMode());
    renderer.setColors(palette.colors);
    applyScalarVisibility(palette.legend);
    renderLegend(palette.legend);
    atomEyeTools.applyRadii();
    atomEyeTools.updateStatistics();
    statisticsExports?.refresh();
    globalAttributes?.refresh();
    void binningTools?.refresh();
  } catch (error) {
    showToast(error.message);
  }
}

function applyScalarVisibility(legend, { includeScalarRange = true } = {}) {
  currentColorLegend = legend;
  let colorMask = null;
  if (legend.kind === 'types' && legend.property) {
    colorMask = visibilityByCategory(legend.property, hiddenCategoriesFor(legend.property.name));
  } else if (legend.kind === 'scalar' && includeScalarRange) {
    colorMask = visibilityByProperty(
      legend.property,
      legend.customRange ? { minimum: legend.minimum, maximum: legend.maximum } : null,
      scalarHideOutside.get(legend.property.name) !== false,
    );
  }
  const mask = combineVisibilityMasks(
    visibilityByType(state.frame, hiddenAtomTypes), colorMask, crystalVisibility?.getMask(),
  );
  renderer.setVisibility(atomEyeTools.filterVisibility(mask), {
    selectionVisibility: selectionGroupVisibility(state.frame, state.selectionGroups.groups),
  });
  // A surface restricted to the visible atoms follows the display filters.
  surfaceTools?.refreshVisibility();
  restoreSelection();
}

function hiddenCategoriesFor(name) {
  if (!hiddenCategories.has(name)) hiddenCategories.set(name, new Set());
  return hiddenCategories.get(name);
}

function paletteForCurrentMode() {
  if (ORIENTATION_COLOR_MODES.includes(state.colorMode)) {
    colorQuantityResolver.clear();
    return orientationColorResolver.resolve(state.frame, state.colorMode, orientationSettings) ?? colorsByType(state.frame, hiddenAtomTypes);
  }
  orientationColorResolver.clear();
  if (state.colorMode === 'type') { colorQuantityResolver.clear(); return colorsByType(state.frame, hiddenAtomTypes); }
  const property = colorQuantityResolver.resolve(state.frame, state.colorMode, { coordinateMode: state.coordinateMode });
  if (!property) {
    return colorsByType(state.frame, hiddenAtomTypes);
  }
  if (property.categories) return colorsByCategory(property, hiddenCategoriesFor(property.name));
  if (scalarColorModes.get(property.name) === 'discrete') {
    const palette = colorsByDiscreteProperty(property, hiddenCategoriesFor(property.name));
    if (palette) return palette;
  }
  return colorsByProperty(
    property,
    scalarColorRanges.get(property.name),
    scalarColorSchemes.get(property.name) ?? 'atomeye',
    hiddenCategoriesFor(property.name),
    selectionGroupVisibility(state.frame, state.selectionGroups.groups),
  );
}

function abortAnalysisJobs() {
  cancelLatticeEstimation();
  atomEyeTools?.abortJobs();
  dxaTools?.abortJobs();
  topologyTools?.abortJobs();
  clusterTools?.abortJobs();
  grainTools?.abortJobs();
  wignerSeitzTools?.abortJobs();
  surfaceTools?.abortJobs();
  binningTools?.abortJobs();
  voronoiCells?.abortJobs();
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
  if (kind === 'strain') cancelLatticeEstimation();
  atomEyeTools?.cancelVectorDependency?.(kind);
  const analysis = state.analysis[kind];
  // Invalidate results immediately, including work that has already completed
  // in a Worker but has not yet reached the UI.
  analysis.request += 1;
  analysis.enabled = false;
  toolPanels.setToolEnabled(kind, false);
  if (kind === 'coordination') {
    clearTimeout(cutoffTimer);
    analysis.cutoff = null;
    if (loadingOwner === 'coordination') setLoading(false);
  } else { analysis.key = null; analysis.parameters = null; }
  analysisControllers.get(kind)?.abort();
  analysisControllers.delete(kind);
  analysisTasks.delete(kind);
  const frames = new Set([state.frame, ...cache.frames.values()]);
  const removedCrystalSources = new Set();
  const canceledCrystalSource = { cna: 'structureType', ptm: 'ptmStructureType',
    centrosymmetry: 'centralSymmetryStructureType', strain: 'idealStrainStructureType' }[kind];
  if (canceledCrystalSource) {
    removedCrystalSources.add(canceledCrystalSource);
    hiddenCategories.delete(canceledCrystalSource);
  }
  for (const frame of frames) {
    if (!frame) continue;
    for (const name of clearAnalysisResults(frame, kind)) {
      scalarColorRanges.delete(name);
      scalarColorSchemes.delete(name);
      scalarHideOutside.delete(name);
      scalarColorModes.delete(name);
      hiddenCategories.delete(name);
      if (isCrystalStructureProperty(name)) removedCrystalSources.add(name);
    }
    if (['ptm', 'strain'].includes(kind) && !state.analysis.ptm.enabled && !state.analysis.strain.enabled && !grainTools?.isEnabled()) delete frame.ptm;
  }
  for (const name of removedCrystalSources) crystalVisibility.forgetSource(name);
  if (!state.analysis.cna.enabled && !state.analysis.ptm.enabled
      && !(state.analysis.centrosymmetry.enabled && state.analysis.centrosymmetry.parameters?.mode === 'auto')) hiddenStructureTypes.clear();
  const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
  elements[`${prefix}-state`].textContent = 'Not calculated';
  elements[`${prefix}-state`].classList.remove('ready');
  elements[`run-${prefix}`].disabled = !state.frame;
  elements[`metric-${prefix}`].textContent = '—';
  if (kind !== 'coordination') elements[`${prefix}-status`].textContent = ANALYSES[kind].help;
  syncCancelButton(kind);
  if (kind === 'centrosymmetry') updateCspMethodUi();
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

function cspParameters() {
  return elements['csp-neighbors'].value === 'auto'
    ? { mode: 'auto' }
    : { mode: 'manual', neighbors: Number(elements['csp-neighbors'].value) };
}

function updateCspMethodUi({ property, calculating = false } = {}) {
  const auto = elements['csp-neighbors'].value === 'auto';
  const analysis = state.analysis.centrosymmetry;
  property ??= analysis.enabled ? state.frame?.properties.find(item => item.name === 'centralSymmetry'
    && item.analysisKind === 'centrosymmetry' && item.analysisKey === analysis.key) : null;
  const summary = auto && !calculating ? property?.cspSummary : null;
  const option = elements['csp-neighbors'].querySelector('[value="auto"]');
  option.textContent = auto && calculating ? 'Auto · identifying…' : 'Auto';
  elements['csp-auto-result'].hidden = !summary;
  elements['csp-auto-result'].textContent = '';
  if (!summary) return;
  const phases = [['FCC', summary.fcc, 12], ['HCP', summary.hcp, 12], ['BCC', summary.bcc, 8]];
  const recognized = phases.filter(([, count]) => count > 0);
  const names = recognized.map(([label]) => label).join(' + ');
  option.textContent = recognized.length > 1 ? `Auto · Mixed (${names})` : `Auto · ${names || 'Unrecognized'}`;
  const details = recognized.map(([label, count, neighbors]) => `${label}: ${formatInteger(count)} atoms · ${neighbors} neighbors`);
  if (summary.other) details.push(`Other: ${formatInteger(summary.other)}`);
  if (summary.ico) details.push(`ICO: ${formatInteger(summary.ico)} · no automatic shell`);
  if (summary.inferred) details.push(`Local neighbor settings inferred: ${formatInteger(summary.inferred)}`);
  if (summary.unresolved) details.push(`Undefined (NaN): ${formatInteger(summary.unresolved)}`);
  if (summary.hcp) details.push('Ideal HCP has a non-zero central-symmetry baseline.');
  elements['csp-auto-result'].textContent = details.join('; ');
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
  void grainTools?.refreshPtmParameters();
}

/** A PTM fit of this frame with its template neighbor lists, for grain
 * segmentation. It uses the PTM panel's templates and RMSD threshold. A
 * completed fit with the same settings is reused; one that the PTM tool is
 * calculating is awaited rather than repeated. */
async function ptmForGrains(frame, { signal, onProgress = () => {} } = {}) {
  const parameters = ptmParameters(), key = JSON.stringify({ flags: parameters.flags, rmsdCutoff: parameters.rmsdCutoff });
  const stopped = () => { if (signal?.aborted) throw new DOMException('Grain segmentation was cancelled.', 'AbortError'); };
  const fitted = () => frame.ptm?.key === key && frame.ptm.neighborIndices?.length === frame.ids.length * 16
    && frame.ptm.neighborCounts?.length === frame.ids.length ? frame.ptm : null;
  if (fitted()) return { ptm: frame.ptm, reused: true };
  // A PTM or strain run started in this same task registers itself before this resumes.
  await Promise.resolve();
  for (const kind of ['ptm', 'strain']) {
    const analysis = state.analysis[kind], running = analysisTasks.get(kind);
    if (!analysis.enabled || running?.frame !== frame || !analysis.parameters
        || JSON.stringify({ flags: analysis.parameters.flags, rmsdCutoff: analysis.parameters.rmsdCutoff }) !== key) continue;
    try { await running.promise; } catch { /* Cancelling that tool does not cancel a separate grain request. */ }
    stopped();
    if (fitted()) return { ptm: frame.ptm, reused: true };
  }
  const result = await analysisPool.analyze(frame, { kind: 'ptm', ...parameters, neighborLists: true },
    { signal, frameIndex: state.frameIndex, onProgress });
  stopped();
  const previous = frame.ptm?.key === key ? frame.ptm : null;
  if (previous && previous.structures.length === result.structures.length && previous.structures.every((type, atom) => type === result.structures[atom])) {
    // The PTM tool shows this fit; keep its arrays and add the lists.
    Object.assign(previous, { neighborCounts: result.neighborCounts, neighborIndices: result.neighborIndices, neighborSpan: result.neighborSpan });
  } else storePtmResult(frame, result, parameters, false);
  reassessFrameCache(frame);
  return { ptm: frame.ptm, reused: false, engine: result.engine };
}

const LATTICE_ESTIMATE_HELP = 'Missing references can be estimated from PTM geometry. Existing values are kept. Estimates include the current frame’s bulk strain; edit them to use a known stress-free lattice.';

function missingReferenceTypes(frame = state.frame) {
  if (!frame) return [];
  return [...new Set(frame.types)].filter(type => {
    const reference = state.references[type];
    return !reference || !Number.isFinite(reference.a)
      || ([2, 7].includes(reference.structure) && !Number.isFinite(reference.c));
  });
}

function compatiblePtm(frame, flags, rmsdCutoff) {
  if (!frame.ptm) return null;
  try {
    const cached = JSON.parse(frame.ptm.key);
    return cached.rmsdCutoff === rmsdCutoff && (cached.flags & flags) === flags ? cached : null;
  } catch { return null; }
}

function cancelLatticeEstimation(message = LATTICE_ESTIMATE_HELP) {
  latticeEstimateRequest += 1;
  analysisControllers.get('lattice-reference')?.abort();
  analysisControllers.delete('lattice-reference');
  elements['lattice-estimate'].disabled = !state.frame || sourceLoadingOwner !== null;
  elements['lattice-estimate-cancel'].disabled = true;
  elements['lattice-estimate-cancel'].hidden = true;
  elements['lattice-estimate-status'].textContent = message;
}

async function estimateMissingReferences({ frame = state.frame, forStrain = false } = {}) {
  if (!frame) return false;
  const missing = missingReferenceTypes(frame);
  if (!missing.length) {
    elements['lattice-estimate-status'].textContent = 'Existing reference values kept. Clear a lattice value to estimate it from this structure.';
    return true;
  }
  cancelLatticeEstimation();
  const request = latticeEstimateRequest;
  const sourceVersion = state.sourceVersion;
  const controller = new AbortController();
  analysisControllers.set('lattice-reference', controller);
  const isCurrent = () => request === latticeEstimateRequest && !controller.signal.aborted
    && frame === state.frame && sourceVersion === state.sourceVersion;
  elements['lattice-estimate'].disabled = true;
  elements['lattice-estimate-cancel'].disabled = false;
  elements['lattice-estimate-cancel'].hidden = false;
  const progressText = text => {
    if (!isCurrent()) return;
    elements['lattice-estimate-status'].textContent = text;
    if (forStrain) elements['strain-status'].textContent = text;
  };
  const parameters = { flags: 127, rmsdCutoff: .1 };
  try {
    if (!compatiblePtm(frame, parameters.flags, parameters.rmsdCutoff)) {
      progressText('Identifying reference crystals and fitting their lattice geometry…');
      const result = await analysisPool.analyze(frame, { kind: 'ptm', ...parameters }, {
        frameIndex: state.frameIndex, signal: controller.signal,
        onProgress: progress => progressText(analysisProgressText(progress, 'ptm')),
      });
      if (!isCurrent()) return false;
      storePtmResult(frame, result, parameters, false);
      reassessFrameCache(frame);
    }
    const estimates = await estimateLatticeReferences(frame, frame.ptm, {
      signal: controller.signal,
      onProgress: (completed, total) => progressText(`Estimating lattice references… ${formatInteger(completed)} / ${formatInteger(total)}`),
    });
    if (!isCurrent()) return false;
    const details = [];
    for (const type of missing) {
      const estimate = estimates[type];
      const reference = state.references[type] ?? referenceForElement(frame.typeLabels[type]);
      const label = frame.typeLabels[type];
      if (estimate?.status !== 'estimated') {
        details.push(`${label}: ${estimate?.status === 'ambiguous' ? 'mixed crystal phases; choose a reference manually' : 'no reliable crystal reference; enter lattice values manually'}`);
        continue;
      }
      if (!Number.isFinite(reference.a)) {
        reference.structure = estimate.structure;
        reference.a = estimate.a;
        if (estimate.c !== undefined && !Number.isFinite(reference.c)) reference.c = estimate.c;
      } else if (reference.structure === estimate.structure && [2, 7].includes(reference.structure)
          && !Number.isFinite(reference.c)) reference.c = estimate.c;
      else {
        details.push(`${label}: detected ${PTM_TYPES.find(item => item.id === estimate.structure).label}; selected reference kept, enter its missing values manually`);
        continue;
      }
      state.references[type] = reference;
      details.push(`${label}: ${PTM_TYPES.find(item => item.id === reference.structure).label}, a = ${reference.a.toFixed(6)} Å${[2, 7].includes(reference.structure) && Number.isFinite(reference.c) ? `, c = ${reference.c.toFixed(6)} Å` : ''}`);
    }
    renderLatticeReferences(frame);
    elements['lattice-estimate-status'].textContent = `${details.join('; ')}. Estimated from the current frame; existing values kept.`;
    if (!forStrain && state.analysis.strain.enabled) void runStructureAnalysis('strain');
    return true;
  } catch (error) {
    if (!isCurrent() || error.name === 'AbortError') return false;
    progressText(error.message);
    if (!forStrain) showToast(error.message);
    return false;
  } finally {
    if (request === latticeEstimateRequest) {
      analysisControllers.delete('lattice-reference');
      elements['lattice-estimate'].disabled = !state.frame || sourceLoadingOwner !== null;
      elements['lattice-estimate-cancel'].disabled = true;
      elements['lattice-estimate-cancel'].hidden = true;
    }
  }
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
      input.addEventListener('input', () => cancelLatticeEstimation());
      input.addEventListener('change', () => {
        reference[axis] = input.valueAsNumber;
        if (state.analysis.strain.enabled) runStructureAnalysis('strain');
      });
      return input;
    };
    const a = number('a'), c = number('c');
    const cField = field('c (Å)', c);
    cField.hidden = ![2, 7].includes(reference.structure);
    row.append(field(`${label} · Element`, element), field('Reference crystal', structure), field('a (Å)', a), cField);
    element.addEventListener('change', () => {
      cancelLatticeEstimation();
      state.references[type] = referenceForElement(element.value);
      renderLatticeReferences(frame);
      if (state.analysis.strain.enabled) runStructureAnalysis('strain');
    });
    structure.addEventListener('change', () => {
      cancelLatticeEstimation();
      reference.structure = Number(structure.value);
      if ([2, 7].includes(reference.structure) && !Number.isFinite(reference.c)
          && Number.isFinite(reference.a) && reference.a > 0) {
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
  const key = JSON.stringify({ flags: parameters.flags, rmsdCutoff: parameters.rmsdCutoff });
  // Neighbor lists for grain segmentation belong to the fit, not to one run:
  // an identical later fit without them keeps the lists already stored.
  const lists = result.neighborIndices ? result : frame.ptm?.key === key && frame.ptm.structures?.length === result.structures.length
    && frame.ptm.structures.every((type, atom) => type === result.structures[atom]) ? frame.ptm : null;
  frame.ptm = { key,
    structures: result.structures, rmsd: result.rmsd, scales: result.scales,
    deformation: result.deformation, distances: result.distances,
    orientations: result.orientations, orderings: result.orderings,
    ...(lists?.neighborIndices ? { neighborCounts: lists.neighborCounts, neighborIndices: lists.neighborIndices, neighborSpan: lists.neighborSpan } : {}) };
  if (!expose) return;
  const fromStrain = Boolean(result.atomicShearStrain);
  const metadata = { analysisKind: 'ptm', analysisMs: fromStrain ? (result.ptmElapsedMs ?? result.elapsedMs) : result.elapsedMs,
    analysisGpuRequested: result.gpuRequested ?? analysisPool.gpuEnabled,
    analysisEngine: result.ptmBackend === 'cpu' && fromStrain
      ? (result.ptmEngine ?? result.engine.split('+')[0]) : result.engine,
    analysisFallbackReason: fromStrain ? result.neighborFallbackReason : result.fallbackReason,
    analysisKey: frame.ptm.key, unit: '' };
  const properties = [
    { ...metadata, name: 'ptmStructureType', displayName: 'Crystal structure (PTM)', data: result.structures, categories: PTM_TYPES },
    { ...metadata, name: 'ptmRmsd', displayName: 'PTM RMSD (best fit)', data: result.rmsd },
    { ...metadata, name: 'ptmDistance', displayName: 'PTM nearest-neighbor distance', unit: 'Å', data: result.distances },
  ];
  if (result.orderings && result.orientations) {
    properties.push({ ...metadata, name: 'ptmOrderingType', displayName: 'PTM chemical ordering',
      data: result.orderings, categories: PTM_ORDERING_TYPES });
    // Unit quaternion (w, x, y, z) of the lattice orientation, NaN when unmatched.
    ['W', 'X', 'Y', 'Z'].forEach((axis, component) => {
      const data = new Float32Array(result.orientations.length / 4);
      for (let atom = 0; atom < data.length; atom += 1) data[atom] = result.orientations[atom * 4 + component];
      properties.push({ ...metadata, name: `ptmOrientation${axis}`, displayName: `PTM orientation q${axis.toLowerCase()}`, data });
    });
  }
  for (const property of properties) replaceAnalysisProperty(frame, property);
}

async function runStructureAnalysis(kind, { automatic = false, frame = state.frame } = {}) {
  if (!automatic) interruptConfigurationRestore('an analysis change');
  if (!frame) return;
  const analysis = state.analysis[kind];
  const { prefix, name, label } = ANALYSES[kind];
  const invocation = ++analysis.request;
  analysisControllers.get(kind)?.abort();
  let parameters = analysis.parameters;
  try {
    if (!automatic) {
      if (kind === 'cna') parameters = { mode: elements['cna-mode'].value,
        ...(elements['cna-mode'].value === 'fixed' ? { cutoff: elements['cna-cutoff'].valueAsNumber } : {}) };
      else if (kind === 'centrosymmetry') parameters = cspParameters();
      else parameters = ptmParameters();
    }
    if (kind === 'strain') {
      if (missingReferenceTypes(frame).length) {
        analysis.enabled = true;
        analysis.parameters = parameters;
        toolPanels.setToolEnabled(kind, true, { reveal: !automatic });
        elements['strain-state'].textContent = 'Estimating reference…';
        elements['strain-state'].classList.remove('ready');
        elements['run-strain'].disabled = true;
        syncCancelButton(kind);
        const estimated = await estimateMissingReferences({ frame, forStrain: true });
        if (frame !== state.frame || analysis !== state.analysis.strain || invocation !== analysis.request) return;
        if (!estimated) {
          elements['strain-state'].textContent = 'Not calculated';
          elements['run-strain'].disabled = false;
          return;
        }
      }
      parameters = { ...parameters, references: state.references.map(reference => ({ ...reference })) };
      validateReferences(parameters.references, frame.types);
      // Always include the templates needed by the selected reference phases.
      parameters.flags |= parameters.references.reduce((mask, reference) => mask | (1 << (reference.structure - 1)), 0);
      const fitted = compatiblePtm(frame, parameters.flags, parameters.rmsdCutoff);
      if (fitted) parameters.flags = fitted.flags;
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
  toolPanels.setToolEnabled(kind, true, { reveal: !automatic });
  analysis.parameters = parameters;
  analysis.key = JSON.stringify(parameters);
  syncCancelButton(kind);
  if (!automatic) {
    state.colorMode = `property:${name}`;
    const crystalSource = kind === 'strain' ? 'idealStrainStructureType'
      : kind === 'centrosymmetry' && parameters.mode === 'auto' ? 'centralSymmetryStructureType'
        : isCrystalStructureProperty(name) ? name : null;
    if (crystalSource) crystalVisibility.restore({ source: crystalSource });
  }
  refreshColorOptions();
  const key = analysis.key;
  const gpuRequested = analysisPool.gpuEnabled;
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
        : parameters.mode === 'auto'
          ? 'Local structure recognition selects 12 neighbors for FCC/HCP and 8 for BCC. Unresolved environments are gray.'
        : `Calculated with ${parameters.neighbors} neighbors.${property.incomplete ? ` ${property.incomplete} undefined environments are gray.` : ''}`;
    if (kind === 'centrosymmetry') updateCspMethodUi({ property });
    const backend = { engine: property.analysisEngine, fallbackReason: property.analysisFallbackReason };
    elements[`metric-${prefix}`].textContent = `${formatDuration(property.analysisMs)} · ${analysisBackendLabel(backend)}`;
    elements[`metric-${prefix}`].title = analysisBackendDetails(backend);
    elements[`run-${prefix}`].disabled = false;
  };
  const cached = frame.properties.find(property => property.name === name && property.analysisKey === key
    && (!['strain', 'cna', 'centrosymmetry', 'ptm'].includes(kind) || Boolean(property.analysisGpuRequested) === gpuRequested));
  if (cached) {
    ready(cached); refreshColorOptions(); applyColors();
    analysisControllers.delete(kind);
    return;
  }
  elements[`run-${prefix}`].disabled = true;
  elements[`${prefix}-state`].textContent = 'Calculating…';
  elements[`${prefix}-state`].classList.remove('ready');
  if (kind === 'centrosymmetry') updateCspMethodUi({ calculating: true });
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
    if (kind === 'centrosymmetry' && parameters.mode === 'auto') {
      const cnaTask = analysisTasks.get('cna');
      if (cnaTask?.frame === frame && cnaTask.key === JSON.stringify({ mode: 'adaptive' })) {
        elements['csp-status'].textContent = 'Waiting for the adaptive CNA structure recognition already running…';
        try { await cnaTask.promise; }
        catch {
          if (!isCurrent() || controller.signal.aborted) return;
        }
      }
      if (!isCurrent()) return;
    }
    const adaptiveCna = kind === 'centrosymmetry' && parameters.mode === 'auto'
      ? frame.properties.find(property => property.name === 'structureType' && property.analysisKind === 'cna'
        && property.analysisKey === JSON.stringify({ mode: 'adaptive' })) : null;
    const inputs = { kind, ...parameters,
      // Grain segmentation reuses this fit when it also returns neighbor lists.
      ...(['ptm', 'strain'].includes(kind) && grainTools?.isEnabled() ? { neighborLists: true } : {}),
      ...(adaptiveCna ? { structureInput: adaptiveCna.data } : {}),
      ...(kind === 'strain' && frame.ptm?.key === ptmKey ? { ptmInput: frame.ptm } : {}) };
    const task = analysisPool.analyze(frame, inputs, {
      signal: controller.signal,
      frameIndex: state.frameIndex,
      onProgress: (progress) => {
        if (isCurrent()) elements[`${prefix}-status`].textContent = analysisProgressText(progress, kind);
      },
    });
    analysisTasks.set(kind, { frame, key, request, promise: task });
    const result = await task;
    if (!isCurrent()) return;
    const metadata = { unit: '', analysisKind: kind, analysisKey: key, analysisMs: result.elapsedMs,
      analysisGpuRequested: result.gpuRequested ?? gpuRequested,
      analysisEngine: result.engine, analysisFallbackReason: result.fallbackReason, incomplete: result.incomplete ?? 0 };
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
      const structures = result.structures ?? frame.ptm?.structures;
      if (structures) properties.push({ ...metadata, name: 'idealStrainStructureType',
        displayName: 'Crystal structure (Ideal strain)', data: structures, categories: PTM_TYPES });
    } else {
      if (kind === 'centrosymmetry' && parameters.mode !== 'auto' && !result.centrosymmetry.some(Number.isFinite)) throw new Error('No valid central-symmetry environments: too few neighbors or coincident atoms.');
      properties = [{ ...metadata, name, displayName: label, data: result.structures ?? result.centrosymmetry,
        ...(kind === 'centrosymmetry' && result.cspSummary ? { cspSummary: result.cspSummary } : {}),
        ...(kind === 'cna' ? { categories: STRUCTURE_TYPES } : {}) }];
      if (kind === 'centrosymmetry') {
        clearAnalysisResults(frame, kind);
        if (result.cspStructureTypes) properties.push({ ...metadata, name: 'centralSymmetryStructureType',
          displayName: 'Local structure (Auto symmetry)', data: result.cspStructureTypes, categories: STRUCTURE_TYPES });
        if (result.cspNeighborCounts) properties.push({ ...metadata, name: 'centralSymmetryNeighbors',
          displayName: 'Central symmetry neighbor count', data: result.cspNeighborCounts });
      }
    }
    for (const property of properties) replaceAnalysisProperty(frame, property);
    if (kind === 'centrosymmetry' && !result.cspStructureTypes) crystalVisibility.forgetSource('centralSymmetryStructureType');
    reassessFrameCache(frame); ready(properties[0]);
    refreshColorOptions(); applyColors(); restoreSelection(); updateMemoryMetric();
    if (result.warning) showToast(result.warning);
  } catch (error) {
    if (!isCurrent() || error.name === 'AbortError') return;
    elements[`${prefix}-state`].textContent = 'Failed';
    elements[`${prefix}-status`].textContent = error.message;
    if (kind === 'centrosymmetry') updateCspMethodUi();
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
  if (!automatic) interruptConfigurationRestore('an analysis change');
  if (!frame) return;
  const analysis = state.analysis.coordination;
  const cutoff = automatic ? state.analysis.coordination.cutoff : Number(elements.cutoff.value);
  if (!Number.isFinite(cutoff) || cutoff <= 0) {
    showToast('The cutoff radius must be greater than zero.');
    return;
  }
  if (!automatic) {
    analysis.enabled = true;
    toolPanels.setToolEnabled('coordination', true, { reveal: true });
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
  if (existing?.analysisCutoff === cutoff && Boolean(existing.analysisGpuRequested) === analysisPool.gpuEnabled) {
    if (frame === state.frame) {
      refreshColorOptions();
      applyColors();
      elements['analysis-state'].textContent = 'Calculated';
      elements['analysis-state'].classList.add('ready');
      const backend = { engine: existing.analysisEngine, fallbackReason: existing.analysisFallbackReason };
      elements['metric-analysis'].textContent = `${formatDuration(existing.analysisMs)} · ${analysisBackendLabel(backend)}`;
      elements['metric-analysis'].title = analysisBackendDetails(backend);
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
        onProgress: (progress) => {
          if (frame !== state.frame || !isCurrent()) return;
          elements['loading-text'].textContent = analysisProgressText(progress, 'coordination');
        },
      });
    });
    coordinationQueue = task.catch(() => {});
    const result = await task;
    // An edit or source change can supersede an active request. Keep its older
    // result out of the property cache and UI, including after a cache hit.
    if (!result || !isCurrent()) return;
    const property = { name: 'coordination', unit: '', data: result.coordination, analysisCutoff: cutoff,
      histogram: result.histogram, meanCoordination: result.meanCoordination,
      analysisKind: 'coordination', analysisMs: result.elapsedMs, analysisEngine: result.engine,
      analysisFallbackReason: result.fallbackReason,
      analysisGpuRequested: result.gpuRequested ?? analysisPool.gpuEnabled };
    replaceAnalysisProperty(frame, property);
    reassessFrameCache(frame);
    if (frame !== state.frame || frameIndex !== state.frameIndex
        || !state.analysis.coordination.enabled || state.analysis.coordination.cutoff !== cutoff) return;
    refreshColorOptions();
    applyColors();
    elements['analysis-state'].textContent = 'Calculated';
    elements['analysis-state'].classList.add('ready');
    elements['metric-analysis'].textContent = `${formatDuration(result.elapsedMs)} · ${analysisBackendLabel(result)}`;
    elements['metric-analysis'].title = analysisBackendDetails(result);
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
  toolPanels.setToolEnabled('slice', percentage < 100);
  if (state.selectedId !== null) restoreSelection();
}

function selectAtom(index) {
  if (!state.frame || index < 0 || index >= state.frame.ids.length) {
    state.selectedId = null;
    renderer.setSelected(-1);
    updateSelectionPanel();
    atomEyeTools?.selected(-1);
    sliceControls?.refreshPickedAtoms();
    configurePeriodicOriginUi();
    void voronoiCells?.refresh();
    return;
  }
  state.selectedId = state.frame.ids[index];
  renderer.setSelected(index);
  updateSelectionPanel(index);
  atomEyeTools?.selected(index);
  sliceControls?.refreshPickedAtoms();
  configurePeriodicOriginUi();
  void voronoiCells?.refresh();
}

function restoreSelection() {
  void voronoiCells?.refresh();
  if (state.selectedId === null || !state.frame) {
    renderer.setSelected(-1);
    updateSelectionPanel();
    return;
  }
  const index = state.frame.ids.indexOf(state.selectedId);
  if (index < 0) {
    state.selectedId = null;
    renderer.setSelected(-1);
    updateSelectionPanel();
    return;
  }
  if (!renderer.isAnyReplicaVisible(index)) {
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
  const previousHideClass = document.getElementById('hide-selected-class');
  if (previousHideClass) previousHideClass.hidden = true;
  if (index === null && state.selectedId !== null && state.frame) {
    const found = state.frame.ids.indexOf(state.selectedId);
    if (found >= 0) index = found;
  }
  if (index !== null && !renderer.isAnyReplicaVisible(index)) {
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
  const inferred = !frame.unwrappedPositions && state.coordinateMode === 'unwrapped' ? frame.inferredUnwrap : null;
  const coordinateRows = frame.unwrappedPositions || inferred
    ? [
        ['Cartesian (wrapped)', formatVector(frame.positions, base, ' Å')],
        [inferred ? 'Cartesian (unwrapped, inferred)' : 'Cartesian (unwrapped)', formatVector(unwrappedPositionsOf(frame), base, ' Å')],
        ['Fractional (wrapped)', formatVector(frame.fractional, base)],
      ]
    : [
        ['Cartesian', formatVector(frame.positions, base, ' Å')],
        ['Fractional', formatVector(frame.fractional, base)],
      ];
  const rows = [
    ['ID', String(frame.ids[index])],
    ['Type', frame.typeLabels[frame.types[index]]],
    ...(frame.imageFlags ? [['Image flags (ix, iy, iz)', formatVector(frame.imageFlags, base)]]
      : inferred ? [['Image counts (inferred)', formatVector(inferred.imageFlags, base)]] : []),
    ...coordinateRows,
    ...frame.properties.map((property) => [
      property.name,
      property.categories
        ? `${property.categories.find((item) => item.id === property.data[index])?.label ?? property.unlistedCategories?.label ?? 'Other'} (${property.data[index]})`
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
  let hideClass = document.getElementById('hide-selected-class');
  if (!hideClass) {
    hideClass = document.createElement('button');
    hideClass.id = 'hide-selected-class';
    hideClass.type = 'button';
    hideClass.className = 'button button-secondary';
    elements['selection-data'].after(hideClass);
  }
  const legend = currentColorLegend;
  hideClass.hidden = legend?.kind !== 'types';
  if (!hideClass.hidden) {
    const raw = legend.atomTypes ? frame.typeLabels[frame.types[index]] : legend.property.data[index];
    const value = typeof raw === 'number' && !Number.isFinite(raw) ? 'NaN' : raw;
    const item = legend.items.find(item => (legend.atomTypes ? item.label : item.id) === value)
      ?? legend.items.find(item => item.id === 'other');
    hideClass.textContent = `Hide ${item?.label ?? String(value)} atoms`;
    hideClass.onclick = () => {
      interruptConfigurationRestore('a category visibility change');
      const hidden = legend.atomTypes ? hiddenAtomTypes : hiddenCategoriesFor(legend.property.name);
      hidden.add(legend.atomTypes ? value : item?.id ?? value);
      applyColors();
      atomEyeTools.syncComparison();
    };
  }
  elements['selection-empty'].hidden = true;
  elements['selection-data'].hidden = false;
  elements['clear-selection'].hidden = false;
}

function renderLegend(legend) {
  commitScalarLegendEdit = null;
  currentColorLegend = legend;
  crystalVisibility?.refresh();
  elements['color-legend'].replaceChildren();
  const propertyControl = document.createElement('label');
  propertyControl.className = 'legend-property';
  const propertyLabel = document.createElement('span');
  propertyLabel.textContent = 'Color by';
  const propertySelect = document.createElement('select');
  propertySelect.id = 'legend-color-mode';
  for (const sourceOption of elements['color-mode'].options) {
    const item = option(sourceOption.value, sourceOption.textContent);
    item.disabled = sourceOption.disabled;
    propertySelect.append(item);
  }
  propertySelect.value = state.colorMode;
  propertySelect.title = propertySelect.selectedOptions[0]?.textContent ?? 'Choose the coloring quantity';
  propertySelect.addEventListener('change', () => {
    const focused = document.activeElement === propertySelect;
    selectColorMode(propertySelect.value);
    if (focused) document.getElementById('legend-color-mode')?.focus({ preventScroll: true });
  });
  propertyControl.append(propertyLabel, propertySelect);
  elements['color-legend'].append(propertyControl);
  const title = document.createElement('div');
  title.className = 'legend-title';
  const label = document.createElement('strong');
  label.textContent = legend.title;
  title.append(label);
  if ((legend.kind === 'scalar' || legend.discrete) && legend.unit) {
    const unit = document.createElement('span');
    unit.textContent = legend.unit;
    title.append(unit);
  }
  elements['color-legend'].append(title);
  if (legend.kind === 'orientation') {
    renderOrientationLegend(legend);
    elements.legend.hidden = false;
    return;
  }
  if ((legend.property && !legend.property.categories) || legend.discrete) {
    const eligible = discreteValues(legend.discrete ? { ...legend.property, categories: undefined } : legend.property);
    if (eligible || scalarColorModes.get(legend.property.name) === 'discrete') {
      const control = document.createElement('label');
      control.className = 'legend-property';
      const caption = document.createElement('span'); caption.textContent = 'Color scale';
      const select = document.createElement('select'); select.id = 'legend-scale-mode';
      select.append(option('continuous', 'Continuous'), option('discrete', `Discrete integer values (up to 32)`));
      select.value = legend.discrete ? 'discrete' : 'continuous';
      select.options[1].disabled = !eligible;
      if (!eligible) select.title = 'This frame needs 1–32 distinct safe integer values for discrete colors.';
      select.addEventListener('change', () => {
        interruptConfigurationRestore('a color scale change');
        scalarColorModes.set(legend.property.name, select.value);
        applyColors(); updateSelectionPanel();
      });
      control.append(caption, select); elements['color-legend'].append(control);
    }
  }
  if (legend.kind === 'scalar' && legend.emptyRange) {
    const message = document.createElement('p');
    message.id = 'legend-empty-range';
    message.className = 'help';
    message.textContent = 'No visible finite values';
    const automatic = document.createElement('button');
    automatic.type = 'button';
    automatic.id = 'legend-auto';
    automatic.className = 'legend-auto active';
    automatic.textContent = 'Auto';
    automatic.disabled = true;
    automatic.setAttribute('aria-pressed', 'true');
    automatic.setAttribute('aria-label', 'Automatic color range on');
    automatic.title = 'Show group atoms to fit an automatic color range.';
    elements['color-legend'].append(message, automatic);
    elements.legend.hidden = false;
    return;
  }
  if (legend.kind === 'types') {
    const items = document.createElement('div');
    items.className = 'legend-items crystal-items';
    const hidden = legend.atomTypes ? hiddenAtomTypes : hiddenCategoriesFor(legend.property.name);
    const controls = [];
    for (const item of legend.items) {
      const row = document.createElement('label');
      row.className = 'legend-item';
      const swatch = document.createElement('i');
      swatch.className = 'legend-swatch';
      swatch.style.background = `rgb(${item.color.join(' ')})`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.visible;
      checkbox.dataset.categoryId = String(item.id);
      checkbox.dataset.categoryProperty = legend.property?.name ?? 'type';
      if (legend.atomTypes) checkbox.dataset.atomType = item.label;
      else if (crystalCategoryProperties.has(legend.property.name)) checkbox.dataset.structureType = String(item.id);
      checkbox.setAttribute('aria-label', `Show ${item.label} atoms`);
      row.title = item.description ?? `Show or hide ${item.label} atoms`;
      row.classList.toggle('is-hidden', !item.visible);
      checkbox.addEventListener('change', () => {
        interruptConfigurationRestore('a category visibility change');
        const key = legend.atomTypes ? item.label : item.id;
        if (checkbox.checked) hidden.delete(key);
        else hidden.add(key);
        row.classList.toggle('is-hidden', !checkbox.checked);
        // Visibility edits keep the displayed legend; recoloring every atom is unnecessary.
        applyScalarVisibility(currentColorLegend ?? paletteForCurrentMode().legend);
        atomEyeTools.syncComparison();
      });
      row.append(checkbox);
      row.append(swatch, document.createTextNode(item.label));
      const count = document.createElement('span');
      count.className = 'legend-count';
      count.textContent = `${formatInteger(item.count)} · ${(legend.atomCount ? 100 * item.count / legend.atomCount : 0).toFixed(1)}%`;
      row.append(count);
      items.append(row);
      controls.push({ checkbox, row, key: legend.atomTypes ? item.label : item.id });
    }
    const actions = document.createElement('div');
    actions.className = 'legend-category-actions';
    for (const [name, text, checked] of [['select-all', 'Select all', true], ['unselect-all', 'Unselect all', false]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.legendAction = name;
      button.textContent = text;
      button.setAttribute('aria-label', `${checked ? 'Show' : 'Hide'} every ${legend.title} category`);
      button.addEventListener('click', () => {
        interruptConfigurationRestore('a category visibility change');
        for (const { checkbox, row, key } of controls) {
          if (checked) hidden.delete(key);
          else hidden.add(key);
          checkbox.checked = checked;
          row.classList.toggle('is-hidden', !checked);
        }
        // Visibility edits keep the displayed legend; recoloring every atom is unnecessary.
        applyScalarVisibility(currentColorLegend ?? paletteForCurrentMode().legend);
        atomEyeTools.syncComparison();
      });
      actions.append(button);
    }
    elements['color-legend'].append(actions, items);
  } else {
    let scale = createLegendScale(document, legend, { format: formatValue });
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
    automatic.id = 'legend-auto';
    automatic.className = 'legend-auto';
    automatic.textContent = 'Auto';
    const syncAutomatic = () => {
      const enabled = !scalarColorRanges.has(legend.property.name);
      automatic.classList.toggle('active', enabled);
      automatic.setAttribute('aria-pressed', String(enabled));
      automatic.setAttribute('aria-label', `Automatic color range ${enabled ? 'on' : 'off'}`);
      automatic.title = enabled
        ? 'Auto on: limits follow each frame. Click to keep the current range.'
        : 'Auto off: limits stay fixed across frames. Click to fit the current frame.';
    };
    syncAutomatic();
    actions.append(automatic);
    let pendingSliderRange = null;
    let previewActive = false;
    const finishSliderPreview = (limits = pendingSliderRange ?? scalarColorRanges.get(legend.property.name)) => {
      pendingSliderRange = null;
      if (!rangeSlider.element.isConnected || !limits) return;
      previewActive = false;
      commitScalarLegendEdit = null;
      applyRange(limits);
    };
    const rangeSlider = createLegendRangeSlider(document, {
      minimum: legend.minimum, maximum: editableMaximum, dataMinimum: legend.dataMinimum, dataMaximum: legend.dataMaximum,
      step, format: formatValue,
      onInput: (requested, changed) => {
        interruptConfigurationRestore('a color range edit');
        const limits = coupleScalarRange(requested.minimum, requested.maximum, changed, step);
        if (!limits) return;
        minimumControl.input.value = formatEditableNumber(limits.minimum);
        maximumControl.input.value = formatEditableNumber(limits.maximum);
        // Save the exact limits immediately (also for export before the next
        // animation frame), while drawing the temporary preview once per frame.
        scalarColorRanges.set(legend.property.name, limits);
        scalarHideOutside.set(legend.property.name, visibilityCheckbox.checked);
        commitScalarLegendEdit = () => finishSliderPreview();
        syncAutomatic();
        if (!pendingSliderRange) {
          requestAnimationFrame(() => {
            const pending = pendingSliderRange;
            pendingSliderRange = null;
            // A frame change may have replaced this legend and its property.
            if (pending && rangeSlider.element.isConnected) previewRange(pending);
          });
        }
        pendingSliderRange = limits;
      },
      onCommit: (limits) => finishSliderPreview(limits),
    });
    controls.append(schemeControl, rangeSlider.element, minimumControl.label, maximumControl.label, visibility, actions);
    const freezeCurrentRange = () => {
      const limits = scalarColorRanges.get(legend.property.name)
        ?? { minimum: legend.minimum, maximum: editableMaximum };
      scalarColorRanges.set(legend.property.name, limits);
      return limits;
    };
    const applyRange = (limits) => {
      pendingSliderRange = null;
      previewActive = false;
      commitScalarLegendEdit = null;
      const palette = atomEyeTools.customizePalette(colorsByProperty(legend.property, limits, legend.scheme,
        hiddenCategoriesFor(legend.property.name), selectionGroupVisibility(state.frame, state.selectionGroups.groups)));
      scalarColorRanges.set(legend.property.name, limits);
      scalarHideOutside.set(legend.property.name, visibilityCheckbox.checked);
      renderer.setColors(palette.colors);
      applyScalarVisibility(palette.legend);
      atomEyeTools.syncComparison();
      // The histogram and hover probe describe the displayed range.
      const nextScale = createLegendScale(document, palette.legend, { format: formatValue });
      scale.replaceWith(nextScale);
      scale = nextScale;
      minimum.textContent = formatValue(limits.minimum);
      maximum.textContent = formatValue(limits.maximum);
      syncAutomatic();
    };
    const previewRange = (limits) => {
      const previewLegend = { ...legend, ...limits, customRange: true };
      if (!previewActive || !renderer.scalarColorPreview) {
        const overrides = atomEyeTools.customizePalette({ colors: renderer.atomColors, legend }, { trackColorOverrides: true }).colorOverrides;
        // Preserve element, structure, appearance and selection filters once;
        // the moving scalar range is evaluated by both atom and bond shaders.
        applyScalarVisibility(previewLegend, { includeScalarRange: false });
        const preview = renderer.setScalarColorPreview(legend.property.data, { ...previewLegend, colorOverrides: overrides,
          hideOutside: visibilityCheckbox.checked, onCommit: () => finishSliderPreview() });
        if (!preview) { applyRange(limits); return; }
        atomEyeTools.syncComparison();
        previewActive = true;
      } else {
        const preview = renderer.setScalarColorPreview(legend.property.data, { ...previewLegend, input: renderer.scalarColorPreview.input,
          hideOutside: visibilityCheckbox.checked, onCommit: () => finishSliderPreview() });
        if (!preview) { applyRange(limits); return; }
        atomEyeTools.syncScalarColorPreview();
      }
      currentColorLegend = previewLegend;
      // Rebuilding histogram counts would scan all atoms per tick. Keep the
      // gradient/value probe responsive and restore exact counts on release.
      const nextScale = createLegendScale(document, previewLegend, { format: formatValue, histogram: false });
      scale.replaceWith(nextScale); scale = nextScale;
      minimum.textContent = formatValue(limits.minimum);
      maximum.textContent = formatValue(limits.maximum);
    };
    const applyLiveRange = (changed) => {
      interruptConfigurationRestore('a color range edit');
      // Even an incomplete edit turns Auto off. Preserve the last valid range
      // until both numbers are valid, without replacing the active input.
      const wasAutomatic = !scalarColorRanges.has(legend.property.name);
      const previousRange = freezeCurrentRange();
      syncAutomatic();
      const coupled = coupleScalarRange(
        minimumControl.input.valueAsNumber,
        maximumControl.input.valueAsNumber,
        changed,
        step,
      );
      if (!coupled) {
        if (wasAutomatic) applyRange(previousRange);
        return;
      }
      const { minimum: requestedMinimum, maximum: requestedMaximum } = coupled;
      // Preserve the active field's editing state (e.g. typing a decimal).
      // Only adjust its opposite bound when enforcing the ordered range.
      if (changed !== 'minimum') minimumControl.input.value = formatEditableNumber(requestedMinimum);
      if (changed !== 'maximum') maximumControl.input.value = formatEditableNumber(requestedMaximum);
      const limits = { minimum: requestedMinimum, maximum: requestedMaximum };
      // A typed limit beyond the data widens the slider track.
      rangeSlider.set(limits);
      applyRange(limits);
    };
    minimumControl.input.addEventListener('input', () => applyLiveRange('minimum'));
    maximumControl.input.addEventListener('input', () => applyLiveRange('maximum'));
    minimumControl.input.addEventListener('change', () => applyLiveRange('minimum'));
    maximumControl.input.addEventListener('change', () => applyLiveRange('maximum'));
    schemeSelect.addEventListener('change', () => {
      interruptConfigurationRestore('a color map change');
      scalarColorSchemes.set(legend.property.name, schemeSelect.value);
      applyColors();
    });
    visibilityCheckbox.addEventListener('change', () => {
      interruptConfigurationRestore('a color visibility change');
      scalarHideOutside.set(legend.property.name, visibilityCheckbox.checked);
      applyScalarVisibility(currentColorLegend ?? paletteForCurrentMode().legend);
      atomEyeTools.syncComparison();
    });
    automatic.addEventListener('click', () => {
      interruptConfigurationRestore('a color range change');
      if (scalarColorRanges.has(legend.property.name)) scalarColorRanges.delete(legend.property.name);
      else freezeCurrentRange();
      applyColors();
    });
    elements['color-legend'].append(scale, range, controls);
  }
  elements.legend.hidden = false;
}

function renderOrientationLegend(legend) {
  if (legend.mode === 'ipf') {
    const control = document.createElement('label'); control.className = 'legend-property';
    const caption = document.createElement('span'); caption.textContent = 'Sample direction';
    const select = document.createElement('select'); select.id = 'legend-ipf-direction';
    for (const value of ['x', 'y', 'z', 'custom']) select.append(option(value, value === 'custom' ? 'Custom vector' : value.toUpperCase()));
    select.value = orientationSettings.direction;
    select.addEventListener('change', () => {
      interruptConfigurationRestore('an orientation color change');
      orientationSettings = normalizeOrientationSettings({ ...orientationSettings, direction: select.value }); applyColors();
    });
    control.append(caption, select); elements['color-legend'].append(control);
    if (orientationSettings.direction === 'custom') {
      const row = document.createElement('div'); row.className = 'legend-ipf-custom';
      const inputs = ['X', 'Y', 'Z'].map((axis, component) => {
        const label = document.createElement('label'); label.textContent = axis;
        const input = document.createElement('input'); input.type = 'number'; input.step = '.1';
        input.id = `legend-ipf-${axis.toLowerCase()}`; input.value = String(orientationSettings.custom[component]);
        label.append(input); row.append(label); return input;
      });
      for (const input of inputs) input.addEventListener('change', () => {
        try {
          const custom = inputs.map(input => input.value.trim() === '' ? NaN : Number(input.value));
          const settings = normalizeOrientationSettings({ direction: 'custom', custom });
          interruptConfigurationRestore('an orientation color change'); orientationSettings = settings; applyColors();
        } catch (error) { showToast(error.message); }
      });
      elements['color-legend'].append(row);
    }
    for (const key of legend.keys) {
      const title = document.createElement('p'); title.className = 'legend-ipf-family'; title.textContent = key.title;
      const canvas = document.createElement('canvas'); canvas.className = 'legend-ipf-key';
      canvas.width = 240; canvas.height = 126; canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${key.title} inverse pole figure key: ${key.labels.join(', ')}`);
      const color = getComputedStyle(elements['color-legend']).getPropertyValue('--text-soft').trim() || '#355563';
      drawIpfKey(canvas.getContext('2d'), key, 0, 0, canvas.width, canvas.height, { color, fontSize: 11 });
      elements['color-legend'].append(title, canvas);
    }
  }
  const explanation = document.createElement('p'); explanation.className = 'help';
  explanation.textContent = legend.mode === 'ipf'
    ? 'Crystal symmetry reduces the chosen sample direction to the RGB key. Other and unsupported structures are gray.'
    : 'Red, green and blue encode the Rodrigues vector of the orientation reduced to the crystal\'s fundamental zone, scaled to the zone\'s extent. Symmetry-equivalent orientations share a color. This display is not an IPF key.';
  elements['color-legend'].append(explanation);
  if (legend.source === 'grains') {
    const grains = document.createElement('p'); grains.className = 'help';
    grains.textContent = 'Every atom has the color of its grain\'s mean orientation. Atoms in no grain are gray.';
    elements['color-legend'].append(grains);
  }
  if (legend.undefinedCount) {
    const count = document.createElement('p'); count.className = 'help';
    count.textContent = `Undefined: ${formatInteger(legend.undefinedCount)} · ${(100 * legend.undefinedCount / legend.atomCount).toFixed(1)}%`;
    elements['color-legend'].append(count);
  }
}

function legendNumberControl(name, value, step) {
  const label = document.createElement('label');
  const text = document.createElement('span');
  text.textContent = name;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = formatEditableNumber(value);
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
  const precision = Math.max(Math.abs(legend.minimum), Math.abs(legend.maximum)) * Number.EPSILON * 2;
  return Math.max(span > 0 ? 10 ** Math.floor(Math.log10(span / 100)) : 0.01, precision);
}

function formatEditableNumber(value) {
  return String(value);
}

let axisTriadKey = '';
function updateAxisTriad(directions) {
  // Every render reports the camera, including frame changes and recoloring
  // that leave it still. The triad depends only on these three directions.
  const key = ['x', 'y', 'z'].map(axis => `${directions[axis].x},${directions[axis].y},${directions[axis].depth}`).join(';');
  if (key === axisTriadKey) return;
  axisTriadKey = key;
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
  atomEyeTools?.syncComparison();
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
  cameraControls?.setEnabled(enabled);
  externalProperties?.setEnabled(enabled);
  expressionTools?.setEnabled(enabled);
  configurePeriodicOriginUi(enabled);
  elements['atom-details-overlay'].hidden = !state.frame;
  atomEyeTools?.setEnabled(enabled);
  dxaTools?.setEnabled(enabled);
  topologyTools?.setEnabled(enabled);
  clusterTools?.setEnabled(enabled);
  grainTools?.setEnabled(enabled);
  wignerSeitzTools?.setEnabled(enabled);
  surfaceTools?.setEnabled(enabled);
  binningTools?.setEnabled(enabled);
  trajectoryTools?.setEnabled(enabled);
  voronoiCells?.setEnabled(enabled);
  statisticsExports?.setEnabled(enabled);
  textLabelControls?.setEnabled(enabled);
  timeSeries?.setEnabled(enabled);
  scriptControls?.setEnabled(enabled);
  movieControls?.setEnabled(enabled);
  exportResolutionControls?.setEnabled(enabled);
  ambientOcclusion?.setEnabled(enabled);
  selectionGroupControls?.setEnabled(enabled);
  syncSelectionGroupInteraction();
  for (const id of [
    'reset-camera', 'export-png', 'export-configuration', 'frame-slider',
    'coordinate-mode', 'color-mode', 'radius-scale', 'radius-percent', 'voronoi-radius-scale', 'voronoi-radius-percent', 'projection-perspective', 'projection-orthographic',
    'background', 'show-axes', 'show-cell', 'png-background', 'png-legend', 'png-axes',
    'slice-axis', 'slice-position', 'cutoff', 'coordination-cutoff-preset', 'run-analysis',
    'cna-mode', 'cna-cutoff', 'run-cna', 'csp-neighbors', 'run-csp',
    'ptm-rmsd', 'run-ptm', 'lattice-reset', 'lattice-estimate', 'run-strain',
    'apply-replicate', 'reset-replicate', 'replicate-atoms',
  ]) {
    elements[id].disabled = !enabled;
  }
  for (const button of document.querySelectorAll('[data-view]')) button.disabled = !enabled;
  elements['lattice-estimate'].disabled = !enabled || analysisControllers.has('lattice-reference');
  elements['lattice-estimate-cancel'].disabled = !enabled || !analysisControllers.has('lattice-reference');
  for (const input of document.querySelectorAll('[data-ptm-template], #lattice-references input, #lattice-references select')) input.disabled = !enabled;
  for (const button of document.querySelectorAll('[data-background]')) button.disabled = !enabled;
  for (const kind of Object.keys(state.analysis)) {
    const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
    if (enabled) syncCancelButton(kind);
    else elements[`cancel-${prefix}`].disabled = true;
  }
  elements['background-picker'].classList.toggle('is-disabled', !enabled);
  if (!enabled) elements['background-picker'].open = false;
  configureReplicationUi(enabled);
  sliceControls.setEnabled(enabled);
  syncAxisVisibility();
}

function updateSlices() {
  if (!sliceControls) return;
  const { slices, showOutlines } = sliceControls.getState();
  renderer.setSlices(slices);
  renderer.setSliceOutlines(showOutlines);
  toolPanels.setToolEnabled('slice', slices.some(slice => slice.enabled));
  syncSliceGizmo();
  if (state.frame) restoreSelection();
  atomEyeTools?.syncComparison();
}

// Exports include shown cut outlines unless the Slice panel opts out.
function sliceOutlineExportOptions() {
  return sliceControls.getState().exportOutlines ? {} : { includeSliceOutlines: false };
}

// Labels are resolved when each image is captured, so every frame of a
// frame-image export stamps its own values. No labels leave options unchanged.
function textLabelExportOptions() {
  const labels = textLabelControls?.exportLabels();
  return labels ? { textLabels: labels } : {};
}

// The PNG button's options, for script and movie images.
function imageExportOptions() {
  return { includeBackground: elements['png-background'].checked, includeAxes: elements['png-axes'].checked,
    legend: elements['png-legend'].checked ? paletteForCurrentMode().legend : null,
    ...exportResolutionControls.getOptions(), ...sliceOutlineExportOptions(), ...textLabelExportOptions() };
}

function exportFileStem() { return (state.file?.name ?? 'alloyview').replace(/\.[^.]+$/, ''); }

function syncSliceGizmo() {
  if (!sliceControls || !sliceGizmo) return;
  sliceGizmo.setState({ ...sliceControls.getState(), visible: Boolean(state.frame) && sourceLoadingOwner === null
    && toolPanels.getActiveTool() === 'slice' && !sliceControls.isPicking() });
}

function interruptConfigurationRestore(reason) {
  if (restorationOwner === null) return;
  configurationRequest++;
  restorationOwner = null;
  elements['configuration-status'].textContent = `Configuration restore interrupted by ${reason}.`;
}

function analysisProgressText(progress, kind) {
  return formatAnalysisProgress(progress, { frameIndex: state.frameIndex, kind });
}

function captureConfiguration() {
  const ptmFlags = [...document.querySelectorAll('[data-ptm-template]:checked')]
    .reduce((flags, input) => flags | Number(input.dataset.ptmTemplate), 0);
  const sliceState = sliceControls.getState();
  return createConfiguration({
    source: state.frame ? {
      kind: state.files.length > 1 ? 'sequence' : 'file',
      label: state.source?.label ?? state.file.name, format: state.format,
      frameIndex: state.frameIndex, frameCount: state.frameCount,
      files: state.files.map(file => ({ name: file.name, size: file.size, lastModified: file.lastModified,
        ...(file.webkitRelativePath ? { relativePath: file.webkitRelativePath } : {}) })),
    } : null,
    settings: {
      selectionGroups: state.selectionGroups,
      compute: { gpuEnabled: analysisPool.gpuEnabled },
      display: { coordinateMode: state.coordinateMode, colorMode: state.colorMode,
        periodicOrigin: [...state.periodicOrigin], cellWireframeMode: renderer.cellWireframeMode,
        radiusPercent: state.radiusPercent, background: elements.background.value,
        showCell: elements['show-cell'].checked, showAxes: elements['show-axes'].checked,
        projectionMode: renderer.projectionMode,
        png: { background: elements['png-background'].checked, legend: elements['png-legend'].checked, axes: elements['png-axes'].checked,
          resolution: exportResolutionControls.getState() },
        ambientOcclusion: ambientOcclusion.getState() },
      analyses: {
        coordination: { enabled: state.analysis.coordination.enabled, cutoff: elements.cutoff.valueAsNumber,
          preset: elements['coordination-cutoff-preset'].value },
        cna: { enabled: state.analysis.cna.enabled, mode: elements['cna-mode'].value, cutoff: elements['cna-cutoff'].valueAsNumber },
        centrosymmetry: { enabled: state.analysis.centrosymmetry.enabled, ...cspParameters(),
          neighbors: elements['csp-neighbors'].value === 'auto' ? 12 : Number(elements['csp-neighbors'].value) },
        ptm: { enabled: state.analysis.ptm.enabled, flags: ptmFlags, rmsdCutoff: elements['ptm-rmsd'].valueAsNumber },
        strain: { enabled: state.analysis.strain.enabled, references: state.references.map((reference, type) => ({ ...reference, label: state.referenceLabels[type] })) },
      },
      replicate: [...state.repetitions],
      replicateAtoms: state.replicateAtoms,
      slices: { items: sliceState.slices, selectedId: sliceState.selectedId, showGizmo: true,
        showOutlines: sliceState.showOutlines, exportOutlines: sliceState.exportOutlines },
      colors: {
        crystalVisibilitySource: crystalVisibility.serialize().source,
        ranges: [...scalarColorRanges].map(([property, range]) => ({ property, ...range })),
        schemes: [...scalarColorSchemes].map(([property, scheme]) => ({ property, scheme })),
        hideOutside: [...scalarHideOutside].map(([property, hide]) => ({ property, hide })),
        modes: [...scalarColorModes].map(([property, mode]) => ({ property, mode })),
        orientation: { ...orientationSettings, custom: [...orientationSettings.custom] },
        hiddenStructureTypes: [...hiddenStructureTypes],
        hiddenAtomTypes: [...hiddenAtomTypes],
        hiddenCategories: [...hiddenCategories].map(([property, ids]) => ({ property, ids: [...ids] })),
      },
      camera: { yaw: renderer.yaw, pitch: renderer.pitch, target: [...renderer.target], pan: [...renderer.pan],
        roll: renderer.roll, fov: renderer.fov, constrainUp: renderer.constrainUp,
        distance: renderer.distance, orthographicScale: renderer.orthographicScale, projectionMode: renderer.projectionMode },
      activeTool: toolPanels.getActiveTool(), selectedAtomId: state.selectedId,
      activeCategory: toolPanels.getActiveCategory(),
      extensions: { ...atomEyeTools.serialize(), ...topologyTools.serialize(), voronoiDisplay: voronoiCells.serialize(), dxa: dxaTools.serialize(), externalProperties: externalProperties.getState(),
        expressions: expressionTools.getState(),
        clusters: clusterTools.serialize(), grains: grainTools.serialize(), wignerSeitz: wignerSeitzTools.serialize(), binning: binningTools.serialize(), trajectory: trajectoryTools.serialize(),
        // The surface mesh is saved only once it is used or changed.
        ...(surfaceTools.isUntouched() ? {} : { surfaceMesh: surfaceTools.serialize() }),
        ...attributeExtensions() },
      theme: document.documentElement.dataset.theme,
    },
  });
}

// Labels, time series and the strain reference are saved only when used, so
// recipes that do not use them are unchanged.
function attributeExtensions() {
  const extensions = {}, labels = textLabelControls.serialize(), series = timeSeries.serialize();
  if (labels) extensions.textLabels = labels;
  if (series.autoCollect || JSON.stringify(series.attributes) !== JSON.stringify(TIME_SERIES_DEFAULTS.attributes)) extensions.timeSeries = series;
  if (globalAttributes.getStrainReferenceFrame() !== 0) extensions.globalAttributes = globalAttributes.serialize();
  // Scripts and the camera path are saved as text and numbers; importing never runs a script.
  const scripts = scriptControls?.serialize(), movie = movieControls?.serialize();
  if (scripts) extensions.scripts = scripts;
  if (movie) extensions.movie = movie;
  return extensions;
}

function exportConfiguration() {
  try {
    if (sourceLoadingOwner !== null) throw new Error('Wait for the selected source to finish loading before exporting its configuration.');
    const config = captureConfiguration();
    const stem = state.file?.name.replace(/\.[^.]+$/, '') ?? 'alloyview';
    downloadConfiguration(config, `${stem}-configuration.json`);
    elements['configuration-status'].textContent = 'Configuration exported. Source file names and settings are included; atom data will be read from your local files.';
  } catch (error) { showToast(error.message); }
}

async function importConfiguration() {
  const [file] = elements['configuration-file'].files;
  elements['configuration-file'].value = '';
  if (!file) return;
  const readRequest = ++configurationReadRequest;
  let acceptedRequest = null;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('Configuration files must be no larger than 8 MiB.');
    const config = parseConfiguration(await file.text());
    if (readRequest !== configurationReadRequest) return;
    configurationRequest++;
    acceptedRequest = configurationRequest;
    restorationOwner = null;
    pendingConfiguration = null;
    if (sourceLoadingOwner === null && (!config.source || matchesSource(config, state.files, state.format))) await restoreConfiguration(config);
    else {
      pendingConfiguration = config;
      document.getElementById('configuration-section').scrollIntoView({ block: 'nearest' });
      const names = config.source?.files.map(item => item.relativePath || item.name).join(', ') ?? 'the source currently loading';
      elements['configuration-status'].textContent = `Waiting for source files: ${names}. Use Open local to select them; matching file names and sizes will restore the saved operations automatically.`;
    }
  } catch (error) {
    if (readRequest === configurationReadRequest && (acceptedRequest === null || acceptedRequest === configurationRequest)) showToast(error.message);
  }
}

async function restoreConfiguration(config) {
  cancelLatticeEstimation();
  replicationController?.abort();
  replicationRequest++;
  const request = configurationRequest, sourceVersion = state.sourceVersion, sourceRequest = sourceOpenRequest;
  const current = () => request === configurationRequest && sourceVersion === state.sourceVersion && sourceRequest === sourceOpenRequest;
  const saved = config.settings;
  const targetIndex = config.source?.frameIndex ?? state.frameIndex;
  const previousSmoothing = trajectoryTools.getSmoothing();
  let displayed = false, smoothingRequest = null;
  restorationOwner = request;
  try {
    clearTimeout(frameTimer);
    if (config.source && targetIndex >= state.frameCount && !state.indexComplete) await waitForSourceIndex();
    if (!current()) return;
    if (config.source && targetIndex >= state.frameCount) throw new Error('The saved frame is not available in the loaded source.');
    // Smoothing defines the analyzed coordinates, so it applies before the
    // target frame is prepared. Recipes without it restore file coordinates.
    if (state.frame && trajectoryTools.setSmoothing(saved.extensions.trajectory?.smoothing ?? { enabled: false })) {
      abortAnalysisJobs();
      invalidateProcessedFrames();
    }
    if (state.frame) smoothingRequest = state.frameRequest;
    let existingTarget = null, repetitions = saved.replicate, targetFrame = null;
    if (state.frame) {
      const preparation = {};
      if (!cache.has(targetIndex)) setLoading(true, `Preparing frame ${targetIndex + 1}…`, preparation, true);
      try {
        existingTarget = await getFrame(targetIndex);
        if (existingTarget) {
          repetitions = normalizeRepetitions(saved.replicate, sourceFrame(existingTarget).cell.pbc);
          targetFrame = await prepareAnalysisFrame(existingTarget, repetitions, saved.replicateAtoms,
            { signal: { get aborted() { return !current(); } } });
        }
      } finally {
        if (loadingOwner === preparation) setLoading(false);
      }
    }
    if (!current()) return;
    if (targetFrame && saved.display.coordinateMode === 'unwrapped' && !targetFrame.unwrappedPositions
      && !(state.frameCount > 1 && !saved.replicateAtoms)) {
      throw new Error('The saved unwrapped view requires coordinates that this source does not provide.');
    }
    const references = targetFrame ? targetFrame.typeLabels.map((label, type) => {
      const reference = saved.analyses.strain.references.find(item => item.label === label)
        ?? (saved.analyses.strain.references[type]?.label ? null : saved.analyses.strain.references[type]);
      return reference ? { ...reference } : referenceForElement(label);
    }) : saved.analyses.strain.references.map(reference => ({ ...reference }));
    if (targetFrame && saved.analyses.strain.enabled) validateReferences(references, targetFrame.types);
    elements['configuration-status'].textContent = 'Restoring configuration and recalculating enabled analyses…';
    stopFramePlayback();
    clearTimeout(cutoffTimer);
    for (const kind of Object.keys(state.analysis)) cancelAnalysis(kind);
    atomEyeTools.reset();
    dxaTools.reset();
    topologyTools?.reset();
    clusterTools?.reset();
    grainTools?.reset();
    wignerSeitzTools?.reset();
    surfaceTools?.reset();
    binningTools?.reset();
    voronoiCells?.reset();
    globalAttributes.restore(saved.extensions.globalAttributes);
    textLabelControls.restore(saved.extensions.textLabels);
    // Saved scripts replace the panel's scripts and wait for Run; a recipe without scripts keeps them.
    if (saved.extensions.scripts) scriptControls.restore(saved.extensions.scripts);
    movieControls.restore(saved.extensions.movie);
    if (targetFrame) {
      await commitReplicationFrame(targetFrame, repetitions, saved.replicateAtoms, targetIndex, { resetCamera: false });
      displayed = true;
    } else { state.repetitions = [...repetitions]; state.replicateAtoms = saved.replicateAtoms; }
    if (!current()) return;

    document.getElementById(`theme-${saved.theme}`).click();
    state.selectionGroups = normalizeSelectionGroups(saved.selectionGroups);
    selectionGroupControls.refresh();
    toolPanels.setToolEnabled('selectionGroups', state.selectionGroups.groups.length > 0);
    setGpuComputing(saved.compute.gpuEnabled);
    setBackgroundColor(saved.display.background);
    for (const [id, value] of [
      ['show-cell', saved.display.showCell], ['show-axes', saved.display.showAxes],
      ['png-background', saved.display.png.background], ['png-legend', saved.display.png.legend], ['png-axes', saved.display.png.axes],
    ]) elements[id].checked = value;
    exportResolutionControls.restore(saved.display.png.resolution);
    ambientOcclusion.restore(saved.display.ambientOcclusion);
    renderer.setCellVisible(saved.display.showCell);
    renderer.setCellWireframeMode(saved.display.cellWireframeMode);
    state.periodicOrigin = [...saved.display.periodicOrigin];
    syncAxisVisibility();
    setRadiusPercent(saved.display.radiusPercent);
    state.coordinateMode = saved.display.coordinateMode;
    if (state.frame) {
      configureCoordinateMode(state.frame);
      if (state.coordinateMode === 'unwrapped' && trajectoryTools.needsInferredUnwrap(state.frame)) {
        await trajectoryTools.ensureInferredUnwrap(state.frame, state.frameIndex);
        if (!current()) return;
      }
      renderer.setDisplayPositions(displayPositionsForFrame(), { coordinateMode: displayCoordinateMode() });
      renderer.setPeriodicOrigin(state.periodicOrigin, { coordinateMode: displayCoordinateMode() });
      renderer.setReplications(displayRepetitions());
    }
    configureReplicationUi();
    configurePeriodicOriginUi();
    externalProperties.setState(saved.extensions.externalProperties ?? { files: [] });
    await refreshExternalProperties({ restoring: true });
    if (!current()) return;
    expressionTools.setState(saved.extensions.expressions ?? { properties: [] });
    refreshComputedProperties();
    sliceControls.setState({ slices: saved.slices.items.map(slice => ({ ...slice,
      showGizmo: saved.slices.showGizmo && slice.showGizmo })), selectedId: saved.slices.selectedId,
      showOutlines: saved.slices.showOutlines, exportOutlines: saved.slices.exportOutlines });
    updateSlices();

    elements.cutoff.value = String(saved.analyses.coordination.cutoff);
    const savedCutoffPreset = coordinationCutoffPresetForElement(saved.analyses.coordination.preset);
    // The saved numeric radius is authoritative, including recipes made before
    // presets existed or with an older recommendation for the same element.
    elements['coordination-cutoff-preset'].value = savedCutoffPreset?.cutoff === saved.analyses.coordination.cutoff
      ? savedCutoffPreset.symbol : 'custom';
    updateCoordinationCutoffHelp();
    elements['cna-mode'].value = saved.analyses.cna.mode;
    elements['cna-cutoff'].value = String(saved.analyses.cna.cutoff);
    elements['csp-neighbors'].value = saved.analyses.centrosymmetry.mode === 'auto' ? 'auto' : String(saved.analyses.centrosymmetry.neighbors);
    elements['ptm-rmsd'].value = String(saved.analyses.ptm.rmsdCutoff);
    for (const checkbox of document.querySelectorAll('[data-ptm-template]')) checkbox.checked = Boolean(saved.analyses.ptm.flags & Number(checkbox.dataset.ptmTemplate));
    state.references = references;
    state.referenceLabels = state.frame ? [...state.frame.typeLabels] : [];
    state.referenceByLabel.clear();
    renderLatticeReferences();
    updateCnaMethodUi();
    scalarColorRanges.clear(); scalarColorSchemes.clear(); scalarHideOutside.clear(); scalarColorModes.clear();
    orientationSettings = normalizeOrientationSettings(saved.colors.orientation);
    orientationColorResolver.clear();
    hiddenStructureTypes.clear(); hiddenAtomTypes.clear(); hiddenCategories.clear();
    for (const { property, minimum, maximum } of saved.colors.ranges) scalarColorRanges.set(property, { minimum, maximum });
    for (const { property, scheme } of saved.colors.schemes) scalarColorSchemes.set(property, scheme);
    for (const { property, hide } of saved.colors.hideOutside) scalarHideOutside.set(property, hide);
    for (const { property, mode } of saved.colors.modes ?? []) scalarColorModes.set(property, mode);
    for (const id of saved.colors.hiddenStructureTypes) hiddenStructureTypes.add(id);
    // Older version 1 recipes used one shared crystal-type filter. Apply it
    // once to the crystal fields; new per-property choices override it below.
    if (hiddenStructureTypes.size) {
      for (const property of crystalCategoryProperties) {
        // DXA has its own lattice IDs; old shared CNA/PTM filters do not apply.
        if (property !== DXA_STRUCTURE_PROPERTY) hiddenCategories.set(property, new Set(hiddenStructureTypes));
      }
    }
    for (const label of saved.colors.hiddenAtomTypes) hiddenAtomTypes.add(label);
    for (const { property, ids } of saved.colors.hiddenCategories) hiddenCategories.set(property, new Set(ids));
    crystalVisibility.restore({ source: saved.colors.crystalVisibilitySource ?? null });

    for (const [kind, parameters] of Object.entries(saved.analyses)) {
      const analysis = state.analysis[kind];
      analysis.enabled = Boolean(state.frame) && parameters.enabled;
      if (kind === 'coordination') analysis.cutoff = parameters.cutoff;
      else {
        analysis.parameters = kind === 'cna' ? { mode: parameters.mode, ...(parameters.mode === 'fixed' ? { cutoff: parameters.cutoff } : {}) }
          : kind === 'centrosymmetry' ? (parameters.mode === 'auto' ? { mode: 'auto' } : { mode: 'manual', neighbors: parameters.neighbors })
            : { flags: saved.analyses.ptm.flags, rmsdCutoff: saved.analyses.ptm.rmsdCutoff };
        analysis.key = JSON.stringify(analysis.parameters);
      }
      toolPanels.setToolEnabled(kind, analysis.enabled);
      syncCancelButton(kind);
    }
    updateCspMethodUi();
    state.colorMode = saved.display.colorMode;
    state.selectedId = saved.selectedAtomId;
    if (saved.camera) {
      for (const name of ['yaw', 'pitch', 'distance', 'orthographicScale', 'roll', 'fov', 'constrainUp']) renderer[name] = saved.camera[name];
      renderer.target = [...saved.camera.target]; renderer.pan = [...saved.camera.pan];
      renderer.setProjection(saved.camera.projectionMode);
    } else renderer.setProjection(saved.display.projectionMode);
    renderer.requestRender();
    toolPanels.setActiveCategory(saved.activeCategory);
    if (saved.activeTool) toolPanels.selectTool(saved.activeTool);
    else toolPanels.closeTool(toolPanels.getActiveTool(), { deactivate: false });
    syncSelectionGroupInteraction();
    syncSliceGizmo();
    if (state.frame) { refreshColorOptions(); applyColors(); restoreSelection(); }
    // Grains is restored first, so a PTM run started below also returns the
    // neighbor lists it needs and one fit serves both tools.
    const grainRestore = grainTools.restore(saved.extensions.grains, { isCurrent: current });
    const tasks = Object.keys(state.analysis).filter(kind => state.analysis[kind].enabled).map(kind => kind === 'coordination'
      ? runCoordination({ automatic: true }) : runStructureAnalysis(kind, { automatic: true }));
    await Promise.all([...tasks, grainRestore, atomEyeTools.restore(saved.extensions, { isCurrent: current }),
      dxaTools.restore(saved.extensions.dxa, { isCurrent: current }),
      topologyTools.restore(saved.extensions, { isCurrent: current }),
      clusterTools.restore(saved.extensions.clusters, { isCurrent: current }),
      wignerSeitzTools.restore(saved.extensions.wignerSeitz, { isCurrent: current }),
      surfaceTools.restore(saved.extensions.surfaceMesh, { isCurrent: current }),
      binningTools.restore(saved.extensions.binning, { isCurrent: current }),
      timeSeries.restore(saved.extensions.timeSeries, { isCurrent: current }),
      trajectoryTools.restoreLines(saved.extensions.trajectory?.lines ?? null, { isCurrent: current })]);
    if (!current()) return;
    await voronoiCells.restore(saved.extensions.voronoiDisplay);
    if (!current()) return;
    if (state.frame) {
      state.colorMode = saved.display.colorMode;
      refreshColorOptions(); applyColors(); restoreSelection();
    }
    const failed = [...Object.keys(state.analysis).filter(kind => {
      const prefix = kind === 'coordination' ? 'analysis' : ANALYSES[kind].prefix;
      return state.analysis[kind].enabled && elements[`${prefix}-state`].textContent === 'Failed';
    }), ...atomEyeTools.failed(), ...topologyTools.failed(), ...clusterTools.failed(), ...grainTools.failed(), ...wignerSeitzTools.failed(), ...surfaceTools.failed(), ...binningTools.failed(), ...(dxaTools.failed() ? ['dxa'] : [])];
    elements['configuration-status'].textContent = failed.length
      ? `Configuration restored; these analyses could not complete: ${failed.join(', ')}.`
      : externalProperties.getPendingFiles().length
        ? 'Configuration restored. Select the external property files in Modification → External properties to restore their data.'
        : 'Configuration restored. Enabled analyses and saved display settings are ready.';
  } finally {
    if (restorationOwner === request) restorationOwner = null;
    // A recipe that was rejected or interrupted before its frame was shown
    // has already applied its smoothing setting. Unless a newer restoration,
    // source or frame request takes over, the setting returns to the one of
    // the frame still on screen.
    if (!displayed && smoothingRequest === state.frameRequest && restorationOwner === null
      && sourceVersion === state.sourceVersion && sourceRequest === sourceOpenRequest) {
      matchSmoothingToDisplayedFrame(previousSmoothing.window);
    }
  }
}

/** Half window of the average that produced the displayed frame; 0 for file coordinates. */
function displayedSmoothingWindow() {
  return state.frame ? sourceFrame(state.frame).smoothing?.window ?? 0 : 0;
}

/** Make the smoothing setting describe the displayed frame, after a change
 * that never reached the screen. `window` is kept for a disabled setting. */
function matchSmoothingToDisplayedFrame(window) {
  if (!state.frame) return;
  const shown = displayedSmoothingWindow();
  if (!trajectoryTools.setSmoothing(shown ? { enabled: true, window: shown } : { enabled: false, window })) return;
  abortAnalysisJobs();
  invalidateProcessedFrames();
  scheduleFramePrefetch(state.frameIndex);
}

function configureReplicationUi(enabled = Boolean(state.frame)) {
  if (!state.replicateAtoms && state.frame && renderer.frame === state.frame) state.repetitions = [...renderer.repetitions];
  for (const [axis, name] of ['a', 'b', 'c'].entries()) {
    const input = elements[`replicate-${name}`];
    input.value = String(state.repetitions[axis]);
    input.disabled = !enabled || !state.frame?.cell.pbc[axis];
    input.title = state.frame?.cell.pbc[axis] ? `Total copies along cell vector ${name}` : 'This cell direction is not periodic.';
  }
  const copies = state.repetitions.reduce((product, count) => product * count, 1);
  elements['replicate-atoms'].checked = state.replicateAtoms;
  elements['replicate-atoms'].disabled = !enabled;
  atomEyeTools?.syncComparison();
  toolPanels.setToolEnabled('replicate', copies > 1 || state.replicateAtoms);
  elements['replicate-summary'].textContent = state.frame
    ? state.replicateAtoms
      ? `${formatInteger(copies)} source cells · ${formatInteger(state.frame.ids.length)} atoms. All analyses use the enlarged structure and cell.`
      : `${formatInteger(copies)} cells · ${formatInteger(state.frame.ids.length * copies)} displayed atoms. Analysis uses the ${formatInteger(state.frame.ids.length)} source atoms.`
    : 'Load a structure to enable its periodic directions.';
}

async function applyReplication() {
  if (!state.frame) return;
  try {
    interruptConfigurationRestore('a replication change');
    const counts = normalizeRepetitions(['a', 'b', 'c'].map(name => elements[`replicate-${name}`].valueAsNumber), sourceFrame(state.frame).cell.pbc);
    await changeReplication(counts, elements['replicate-atoms'].checked);
  } catch (error) {
    if (error.name !== 'AbortError') { showToast(error.message); configureReplicationUi(); }
  }
}

async function resetReplication() {
  if (!state.frame) { state.repetitions = [1, 1, 1]; state.replicateAtoms = false; configureReplicationUi(); return; }
  try {
    interruptConfigurationRestore('a replication reset');
    await changeReplication([1, 1, 1], false);
  } catch (error) {
    if (error.name !== 'AbortError') { showToast(error.message); configureReplicationUi(); }
  }
}

function processingSourceKey() {
  return `${state.sourceVersion}:${sourceOpenRequest}:${state.processingRevision}`;
}

function displayRepetitions() {
  return state.replicateAtoms ? [1, 1, 1] : state.repetitions;
}

function sourceFrame(frame) {
  return analysisFrameSources.get(frame) ?? frame;
}

async function prepareAnalysisFrame(frame, counts, physical, { signal, onProgress, background = false } = {}) {
  const raw = sourceFrame(frame);
  // Retain only imported values, including ones temporarily replaced by an
  // analysis. Source geometry is shared until physical copies are requested.
  const source = { ...raw, properties: raw.properties.flatMap(property => {
    if (!property.analysisKind) return [property];
    const original = raw.analysisOriginalProperties?.get(property.name);
    return original ? [original] : [];
  }) };
  delete source.ptm;
  delete source.atomeyeResults;
  delete source.analysisOriginalProperties;
  delete source.processingSourceBytes;
  let warming = false;
  const replicationProgress = progress => {
    // Validation and expansion run off the main thread. The first progress
    // message contains the validated target count, so preparation overlaps the
    // copy without another O(N) source-ID scan in the rendering thread.
    if (!warming && !signal?.aborted) {
      warming = true;
      void cpuPrefetch.setAtomCount({ sourceKey: state.sourceVersion, atomCount: progress.totalAtoms, signal });
    }
    onProgress?.(progress);
  };
  // External columns expand in their persistent Worker, rather than being
  // copied once here and a second time when the property registry refreshes.
  // Display-only inferred coordinates describe the source atoms, not copies.
  const replicationSource = physical ? { ...source, properties: source.properties.filter(property => !property.externalImportId),
    inferredUnwrap: undefined } : source;
  const prepared = physical ? await worker.replicate(replicationSource, counts, { signal, onProgress: replicationProgress, background }) : source;
  analysisFrameSources.set(prepared, source);
  if (externalProperties && !signal?.aborted) await externalProperties.applyToFrame(prepared, { sourceFrame: source });
  if (signal?.aborted) throw new DOMException('Replication cancelled.', 'AbortError');
  if (prepared !== source) prepared.processingSourceBytes = estimateFrameBytes(source);
  return prepared;
}

/** Discard processed frames and every per-frame cache keyed by them. */
function invalidateProcessedFrames() {
  state.processingRevision++;
  cancelFramePrefetch();
  state.pendingFrames.clear();
  analysisPool.clearVoronoiFrames();
  void gpuPrefetch.clearSource();
  cache.clear();
}

/** Smoothing replaces analyzed coordinates. Prepare the displayed frame
 * again; analyses rerun on it and neighbors are prefetched as usual. */
async function applyTrajectoryProcessing() {
  if (!state.frame || sourceLoadingOwner !== null) return;
  stopFramePlayback();
  clearTimeout(frameTimer);
  atomEyeTools.cancelBatch({ restore: false });
  const navigation = beginFrameNavigation();
  abortAnalysisJobs();
  invalidateProcessedFrames();
  const request = ++state.frameRequest, index = state.frameIndex;
  setLoading(true, trajectoryTools.smoothingWindow() ? 'Averaging frames…' : 'Preparing frame…', navigation, true);
  try {
    const frame = await getFrame(index, { signal: navigation.signal });
    if (!frame || request !== state.frameRequest) return;
    if (state.coordinateMode === 'unwrapped' && trajectoryTools.needsInferredUnwrap(frame)) {
      await trajectoryTools.ensureInferredUnwrap(frame, index, { signal: navigation.signal, showProgress: false });
      if (request !== state.frameRequest) return;
    }
    await displayFrame(frame);
    if (request === state.frameRequest) scheduleFramePrefetch(index);
  } catch (error) {
    if (error.name === 'AbortError' || request !== state.frameRequest) return;
    if (!trajectoryTools.smoothingWindow()) throw error;
    // For example, frames without explicit IDs whose atom counts differ.
    trajectoryTools.setSmoothing({ enabled: false });
    showToast(`Smoothing was turned off: ${error.message}`);
    await applyTrajectoryProcessing();
  } finally {
    if (loadingOwner === navigation) setLoading(false);
  }
}

async function commitReplicationFrame(frame, counts, physical, index, { resetCamera = true } = {}) {
  abortAnalysisJobs();
  const processingChanged = Boolean(physical) !== state.replicateAtoms
    || (physical && counts.some((count, axis) => count !== state.repetitions[axis]));
  if (processingChanged) {
    state.processingRevision++;
    cancelFramePrefetch();
    state.pendingFrames.clear();
    analysisPool.clearVoronoiFrames();
    void gpuPrefetch.clearSource();
    cache.clear();
  }
  const revision = state.processingRevision;
  state.frameRequest++;
  state.repetitions = [...counts];
  state.replicateAtoms = Boolean(physical);
  state.frameIndex = index;
  state.cachePlan = chooseFrameCachePolicy(frame, state.frameCount, {
    heapLimit: performance.memory?.jsHeapSizeLimit, heapUsed: performance.memory?.usedJSHeapSize,
    deviceMemoryGiB: navigator.deviceMemory,
  });
  cache.setLimit(state.cachePlan.limit);
  cache.set(index, frame);
  await displayFrame(frame, { resetCamera });
  if (state.frame === frame && revision === state.processingRevision) scheduleFramePrefetch(index);
}

async function changeReplication(counts, physical) {
  const interrupted = replicationController;
  interrupted?.abort();
  replicationController = null;
  if (interrupted && loadingOwner === interrupted) setLoading(false);
  const request = ++replicationRequest;
  const frame = state.frame, index = state.frameIndex, version = state.sourceVersion;
  const current = () => request === replicationRequest && version === state.sourceVersion && sourceLoadingOwner === null;
  if (!physical && !state.replicateAtoms) {
    state.repetitions = [...counts];
    renderer.setReplications(counts);
    configureReplicationUi(); restoreSelection(); renderer.resetCamera(); syncSliceGizmo();
    if (interrupted) await displayFrame(frame);
    scheduleGpuFramePrefetch();
    return;
  }
  if (physical === state.replicateAtoms && counts.every((value, axis) => value === state.repetitions[axis])) {
    configureReplicationUi();
    if (interrupted) await displayFrame(frame);
    scheduleGpuFramePrefetch();
    return;
  }
  const controller = new AbortController();
  replicationController = controller;
  stopFramePlayback();
  clearTimeout(frameTimer);
  state.frameRequest++;
  abortAnalysisJobs();
  gpuPrefetch.pause();
  renderer.cancelSelectionGesture();
  setLoading(true, 'Preparing replicated structure…', controller);
  try {
    const prepared = await prepareAnalysisFrame(frame, counts, physical, {
      signal: controller.signal,
      onProgress: ({ completedAtoms, totalAtoms }) => {
        if (current() && loadingOwner === controller) elements['loading-text'].textContent = `Replicating atoms… ${formatInteger(completedAtoms)} / ${formatInteger(totalAtoms)}`;
      },
    });
    if (!current() || controller.signal.aborted || state.frame !== frame || state.frameIndex !== index) return;
    await commitReplicationFrame(prepared, counts, physical, index);
  } catch (error) {
    // A rejected expansion leaves the original structure usable, including
    // analyses interrupted while its replacement was being prepared.
    if (current() && state.frame === frame && error.name !== 'AbortError') await displayFrame(frame);
    throw error;
  } finally {
    if (replicationController === controller) replicationController = null;
    if (loadingOwner === controller) setLoading(false);
    if (current()) scheduleGpuFramePrefetch();
  }
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

/** Show or hide the loading indicator. Whoever shows it hides it; a caller
 * that others can interrupt passes an `owner`, and hides it only while
 * `loadingOwner` is still that owner. `readProgress` lets structure Worker
 * progress replace the text. */
function setLoading(visible, text = '', owner = null, readProgress = owner === null) {
  elements.loading.hidden = !visible;
  loadingOwner = visible ? owner : null;
  loadingReadProgress = visible && readProgress;
  if (text) elements['loading-text'].textContent = text;
}

/** Progress of a structure Worker read describes a wait that some caller
 * announced and will end. A read nobody announced stays silent, rather than
 * showing an indicator that nothing hides. */
function reportReadProgress(text) {
  if (loadingReadProgress) elements['loading-text'].textContent = text;
}

/** Abort the frame request in flight, hide the indicator it showed, and
 * return the controller that owns the next request. */
function beginFrameNavigation() {
  const interrupted = frameNavigationController;
  interrupted?.abort();
  if (interrupted && loadingOwner === interrupted) setLoading(false);
  return frameNavigationController = new AbortController();
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
