import { applyAppearance, hexColor, rgbHex } from './appearance.js';
import { radiusForElement } from './render/atomic-radii.js';
import { colorsByType } from './render/palette.js';
import { analysisProgressText, analysisBackendLabel, analysisBackendDetails } from './analysis/status.js';
import { WebGLRenderer } from './render/webgl-renderer.js';
import { cameraViewPreset } from './render/camera-presets.js';
import { replaceAnalysisProperty, clearAnalysisResults } from './analysis/results.js';
import { createReferenceMappingAsync, REFERENCE_STRAIN_FIELDS } from './analysis/reference-strain.js';
import { STRAIN_FIELDS } from './analysis/atomic-strain.js';
import { measureAtoms } from './measurements.js';
import { createImageArchive, downloadBlob } from './export-archive.js';
import { prepareDisplacements } from './analysis/displacement.js';
import { registerVectorProperties, vectorPropertyNames } from './analysis/vector-properties.js';
import { availableVectorSources, createVectorField, linkedArrowDimensions, renameVectorFieldProperty, vectorFieldData } from './vector-settings.js';

const JOBS = {
  bonds: { prefix: 'bonds', tool: 'bonds', property: 'bondCoordination' },
  rdf: { prefix: 'rdf', tool: 'statistics' },
  referenceStrain: { prefix: 'reference-strain', tool: 'referenceStrain', property: 'referenceShearStrain' },
  localShear: { prefix: 'local-shear', tool: 'localShear', property: 'localShear' },
};
const $ = id => document.getElementById(id);
  const VECTOR_SIZE_IDS = { radius: 'vector-radius', headRadius: 'vector-head-radius', headLength: 'vector-head-length' };
const number = id => {
  const value = $(id).valueAsNumber;
  if (!Number.isFinite(value) || value <= 0) throw new Error('Enter a positive, finite value.');
  return value;
};
const canvasBlob = (canvas, type = 'image/png') => new Promise((resolve, reject) => canvas.toBlob(
  blob => blob ? resolve(blob) : reject(new Error('Could not encode the image.')), type, 0.94));

/** Own analysis lifecycles separately from display-only vector settings, and
 * invalidate pending results on source/frame edits. */
export function initializeAtomEyeTools({ renderer, pool, tools, getFrame, getFrameAt,
  getFrameIndex, getFrameCount, getFrames, getSourceVersion, getSelectedIndex,
  selectAtom, refresh, chooseProperty, getColorMode, getSelectionGroups = () => [], getColorChoiceVersion = () => 0, getPendingAnalysisKinds = () => [], getAnalysisPropertyKind = () => null, getExportOptions, showFrame,
  stopPlayback, getFileStem, notify = () => {}, onEdit = () => {}, onMemoryChange = () => {},
  onBondParametersChange = () => {}, onBondStateChange = () => {}, getBondStatisticsEnabled = () => false }) {
  const jobs = Object.fromEntries(Object.keys(JOBS).map(kind => [kind, { enabled: false, parameters: null, controller: null, request: 0 }]));
  let generation = 0, measurements = [], appearance = { elements: [], atoms: [] };
  let pairCutoffs = [], currentFrame = null, comparison = null, comparisonContainer = null;
  let colors = null, batch = null;
  const displacement = { enabled: false, parameters: null, controller: null, request: 0 };
  let preferredVectorSource = 'generic';
  let preferredVectorAnalysisKinds = new Set();
  let preferredVectorComponents = ['', '', ''];
  const vectorComponentKinds = new Map();
  let vectorDimensions = { radius: .06, headRadius: .15, headLength: .3 };
  let vectorFields = [createVectorField()], selectedVectorId = vectorFields[0].id, vectorSequence = 1;
  const vectorSourceKinds = new Map();
  const vectorDataCache = new Map();
  const vectorResolvedComponents = new Map();

  function selectedVectorField() { return vectorFields.find(field => field.id === selectedVectorId) ?? vectorFields[0]; }
  function saveVectorEditor() {
    const field = selectedVectorField();
    if (!field) return;
    Object.assign(field, { name: $('vector-field-name')?.value.trim() || field.name, enabled: $('show-vectors').checked,
      mode: preferredVectorSource, components: preferredVectorComponents.map(name => name || null),
      componentScales: ['x', 'y', 'z'].map(axis => $(`vector-scale-${axis}`).valueAsNumber),
      scale: $('vector-scale').valueAsNumber, color: $('vector-color').value,
      radius: $('vector-radius').valueAsNumber, headRadius: $('vector-head-radius').valueAsNumber, headLength: $('vector-head-length').valueAsNumber,
      linkDimensions: $('vector-link-dimensions').checked, anchor: $('vector-anchor').value, dimension: $('vector-dimension').value,
      upMode: $('vector-up-mode')?.value ?? 'camera', up: ['x', 'y', 'z'].map((axis, index) => $(`vector-up-${axis}`)?.valueAsNumber ?? field.up[index]),
    });
    vectorSourceKinds.set(field.id, new Set(preferredVectorAnalysisKinds));
  }
  function loadVectorEditor(field = selectedVectorField()) {
    preferredVectorSource = field.mode; preferredVectorComponents = field.components.map(name => name ?? '');
    preferredVectorAnalysisKinds = new Set(vectorSourceKinds.get(field.id) ?? []);
    $('show-vectors').checked = field.enabled;
    for (const [id, value] of [['vector-scale', field.scale], ['vector-color', field.color], ['vector-anchor', field.anchor], ['vector-dimension', field.dimension], ['vector-up-mode', field.upMode]]) if ($(id)) $(id).value = String(value);
    for (const [axis, scale] of field.componentScales.entries()) $(`vector-scale-${'xyz'[axis]}`).value = String(scale);
    for (const [axis, value] of field.up.entries()) if ($(`vector-up-${'xyz'[axis]}`)) $(`vector-up-${'xyz'[axis]}`).value = String(value);
    $('vector-link-dimensions').checked = field.linkDimensions;
    vectorDimensions = Object.fromEntries(Object.entries(VECTOR_SIZE_IDS).map(([name, id]) => { $(id).value = String(field[name]); return [name, field[name]]; }));
    if ($('vector-field-name')) $('vector-field-name').value = field.name;
    for (const [axis, name] of preferredVectorComponents.entries()) $(`vector-${'xyz'[axis]}`).value = name;
    syncVectorFieldList();
  }
  function syncVectorFieldList() {
    const list = $('vector-field-list');
    if (list) { list.replaceChildren(...vectorFields.map(field => option(field.id, `${field.name}${field.enabled ? '' : ' (hidden)'}`))); list.value = selectedVectorId; }
    if ($('vector-up-controls')) $('vector-up-controls').hidden = $('vector-dimension').value !== '2d' || $('vector-up-mode')?.value !== 'fixed';
  }

  function changed() { cancelBatch({ restore: false }); onEdit(); }
  function stateFor(kind, text, status = '') {
    const { prefix } = JOBS[kind];
    $(`${prefix}-state`).textContent = text;
    $(`${prefix}-state`).classList.toggle('ready', text === 'Calculated');
    if (status) $(`${prefix}-status`).textContent = status;
    $(`run-${prefix}`).disabled = !getFrame() || text === 'Calculating…';
    $(`cancel-${prefix}`).disabled = !getFrame() || (!jobs[kind].enabled && text !== 'Failed');
  }
  function abortJobs() {
    for (const job of Object.values(jobs)) { job.request++; job.controller?.abort(); job.controller = null; }
    displacement.request++; displacement.controller?.abort(); displacement.controller = null;
  }
  function resultKey(kind, parameters, gpuRequested = pool.gpuEnabled) {
    return JSON.stringify(['rdf', 'localShear', 'bonds', 'referenceStrain', 'displacement'].includes(kind)
      ? { ...parameters, gpuRequested } : parameters);
  }
  function cancel(kind, { redraw = true } = {}) {
    const job = jobs[kind];
    if (!job) return;
    cancelVectorDependency(kind);
    job.request++; job.enabled = false; job.controller?.abort(); job.controller = null;
    tools.setToolEnabled(JOBS[kind].tool, false);
    if (kind === 'bonds') onBondStateChange();
    for (const frame of getFrames()) {
      clearAnalysisResults(frame, kind);
      if (frame.atomeyeResults) delete frame.atomeyeResults[kind];
    }
    stateFor(kind, 'Not calculated', 'Calculation cleared.');
    if (kind === 'bonds') { renderer.setBonds(null); comparison?.setBonds(null); }
    if (kind === 'rdf') { $('rdf-chart').replaceChildren(); $('export-rdf').disabled = true; }
    if (redraw && getFrame()) refresh();
  }
  function readParameters(kind, frame) {
    if (kind === 'bonds') return { cutoff: number('bonds-cutoff'), pairCutoffs: pairCutoffs.map(entry => ({
      first: frame.typeLabels.indexOf(entry.first), second: frame.typeLabels.indexOf(entry.second), cutoff: entry.cutoff,
    })).filter(entry => entry.first >= 0 && entry.second >= 0) };
    if (kind === 'localShear') return { cutoff: number('local-shear-cutoff'), subtractMean: $('local-shear-subtract-mean').checked };
    if (kind === 'referenceStrain') {
      const frameIndex = number('reference-frame') - 1;
      if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= getFrameCount()) throw new Error('Choose an available reference frame.');
      return { frameIndex, cutoff: number('reference-cutoff') };
    }
    const bins = number('rdf-bins');
    if (!Number.isInteger(bins) || bins < 1 || bins > 4096) throw new Error('Use between 1 and 4096 RDF bins.');
    return { cutoff: number('rdf-cutoff'), bins,
      firstType: $('rdf-first-type').value || null, secondType: $('rdf-second-type').value || null };
  }
  async function run(kind, { automatic = false } = {}) {
    const frame = getFrame(), job = jobs[kind];
    if (!frame || !job) return;
    try {
      if (!automatic) {
        changed(); job.parameters = readParameters(kind, frame); job.enabled = true;
        tools.setToolEnabled(JOBS[kind].tool, true, { reveal: true });
      }
      if (!job.enabled) return;
      if (kind === 'bonds') job.parameters = { ...job.parameters, pairCutoffs: pairCutoffs.map(entry => ({
        first: frame.typeLabels.indexOf(entry.first), second: frame.typeLabels.indexOf(entry.second), cutoff: entry.cutoff,
      })).filter(entry => entry.first >= 0 && entry.second >= 0) };
      job.controller?.abort();
      const controller = new AbortController(), request = ++job.request;
      job.controller = controller;
      const source = getSourceVersion(), token = generation, colorChoice = getColorChoiceVersion(), parameters = { ...job.parameters };
      const key = resultKey(kind, parameters);
      const current = () => frame === getFrame() && source === getSourceVersion() && token === generation
        && request === job.request && job.enabled && !controller.signal.aborted;
      stateFor(kind, 'Calculating…', 'Waiting for available analysis Workers…');
      try {
        let cached = frame.atomeyeResults?.[kind];
        if (cached?.key !== key) {
          const input = { ...parameters, kind };
          if (kind === 'referenceStrain') {
            const reference = parameters.frameIndex === getFrameIndex() ? frame : await getFrameAt(parameters.frameIndex);
            if (!current()) return;
            if (!reference) throw new Error('The reference frame is no longer available.');
            input.referenceFractional = reference.fractional; input.referenceCell = reference.cell;
            input.referenceFrame = reference;
            input.referenceFrameIndex = parameters.frameIndex;
            input.referenceMapping = await createReferenceMappingAsync(frame, reference, { signal: controller.signal,
              onProgress: ({ completed, total }) => { if (current()) $('reference-strain-status').textContent = `Matching atom IDs… ${completed} / ${total}`; } });
            if (!current()) return;
            delete input.frameIndex;
          }
          if (kind === 'rdf') {
            for (const name of ['firstType', 'secondType']) {
              if (input[name] !== null) {
                const type = frame.typeLabels.indexOf(input[name]);
                if (type < 0) throw new Error(`Element ${input[name]} is absent from this frame.`);
                input[name] = type;
              }
            }
          }
          const result = await pool.analyze(frame, input, { signal: controller.signal, frameIndex: getFrameIndex(), onProgress: progress => {
            if (!current()) return;
            $(`${JOBS[kind].prefix}-status`).textContent = analysisProgressText(progress, { frameIndex: getFrameIndex(), kind });
          } });
          if (!current()) return;
          cached = { key: resultKey(kind, parameters, result.gpuRequested), result };
          frame.atomeyeResults ??= {}; frame.atomeyeResults[kind] = cached;
        }
        if (!current()) return;
        const { result } = cached;
        if (kind === 'bonds') {
          replaceAnalysisProperty(frame, { name: 'bondCoordination', displayName: 'Coordination (bond cutoffs)', unit: '', data: result.coordination, analysisKind: kind,
            histogram: result.histogram, meanCoordination: result.meanCoordination });
          renderer.setBonds(result, { visible: $('show-bonds').checked, radius: number('bonds-radius') });
        } else if (kind === 'rdf') renderRdf(result);
        else {
          for (const [name, data] of Object.entries(result)) {
            if (data instanceof Float32Array && data.length === frame.ids.length && (name.startsWith('reference') || name === 'localShear')) {
              replaceAnalysisProperty(frame, { name, unit: '', data, analysisKind: kind });
            }
          }
        }
        if (!automatic && JOBS[kind].property && colorChoice === getColorChoiceVersion()) chooseProperty(JOBS[kind].property);
        else refresh();
        stateFor(kind, 'Calculated', `${kind === 'bonds' ? `${result.count.toLocaleString()} bonds · ` : ''}${(result.elapsedMs / 1000).toFixed(2)} s · ${analysisBackendLabel(result)}`);
        $(`${JOBS[kind].prefix}-status`).title = analysisBackendDetails(result);
        onMemoryChange(frame); updateStatistics(); syncComparison();
      } catch (error) {
        if (current() && error.name !== 'AbortError') { stateFor(kind, 'Failed', error.message); notify(error.message); }
      } finally {
        if (job.controller === controller) job.controller = null;
      }
    } catch (error) { notify(error.message); }
  }

  function option(value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; }
  function pendingVectorComponentKind(name) {
    if (displacement.enabled && Object.values(vectorPropertyNames('displacement')).includes(name)) return 'displacement';
    for (const [kind, { property }] of Object.entries(JOBS)) {
      if (jobs[kind].enabled && (kind === 'referenceStrain' ? REFERENCE_STRAIN_FIELDS.includes(name) : property === name)) return kind;
    }
    return getAnalysisPropertyKind(name);
  }
  function rememberVectorComponentKinds(frame) {
    for (const name of preferredVectorComponents) {
      const property = frame?.properties.find(property => property.name === name);
      if (property) vectorComponentKinds.set(name, property.analysisKind ?? null);
      else {
        const kind = pendingVectorComponentKind(name);
        if (kind) vectorComponentKinds.set(name, kind);
      }
    }
  }
  function pendingVectorSourceKinds(mode) {
    if (mode === 'displacement') return new Set(displacement.enabled ? ['displacement'] : []);
    if (!mode.startsWith('property:')) return new Set();
    const empty = new Float32Array(0);
    const properties = [...REFERENCE_STRAIN_FIELDS, ...STRAIN_FIELDS].flatMap(name => {
      const analysisKind = pendingVectorComponentKind(name);
      return analysisKind ? [{ name, analysisKind, data: empty }] : [];
    });
    const source = availableVectorSources({ ids: [], properties }).find(source => source.value === mode);
    return new Set((source?.components ?? []).map(property => property.analysisKind));
  }
  function cancelVectorDependency(kind) {
    saveVectorEditor();
    const frame = getFrame();
    const sources = availableVectorSources(frame, { displacementEnabled: displacement.enabled });
    let affected = 0;
    for (const field of vectorFields) {
      const source = sources.find(source => source.value === field.mode);
      const dependent = field.mode === 'generic'
        ? field.components.some(name => {
          const property = frame?.properties.find(property => property.name === name);
          if (property) return property.analysisKind === kind;
          if (vectorComponentKinds.has(name)) return vectorComponentKinds.get(name) === kind;
          if ([...getFrames()].some(frame => frame.properties.some(property => property.name === name && property.analysisKind === kind))) return true;
          return pendingVectorComponentKind(name) === kind;
        })
        : source ? source.components?.some(property => property.analysisKind === kind)
          : vectorSourceKinds.get(field.id)?.has(kind) || pendingVectorSourceKinds(field.mode).has(kind);
      if (dependent) { field.enabled = false; affected++; }
    }
    if (!affected) return;
    $('show-vectors').checked = selectedVectorField().enabled;
    updateVectors();
    $('vector-status').textContent = `${affected} vector field${affected === 1 ? '' : 's'} hidden because the source calculation was cancelled. Other fields remain available.`;
  }
  function configureVectorSelectors(frame) {
    const properties = frame.properties.filter(property => !property.categories);
    const suggested = availableVectorSources(frame, { displacementEnabled: displacement.enabled }).find(source => source.components)?.components;
    if (displacement.enabled) for (const [component, name] of Object.entries(vectorPropertyNames('displacement'))) {
      if (!properties.some(property => property.name === name)) properties.push({ name, displayName: `Displacement ${component === 'magnitude' ? 'magnitude' : component.toUpperCase()} (calculating…)` });
    }
    const numeric = properties.map(property => property.name);
    for (const [axis, component] of ['x', 'y', 'z'].entries()) {
      const select = $(`vector-${component}`), previous = preferredVectorComponents[axis] || select.value;
      select.replaceChildren(option('', 'Choose component'), ...properties.map(property => {
        const item = option(property.name, property.displayName ?? property.name); item.disabled = !property.data; return item;
      }));
      if (previous && !numeric.includes(previous)) {
        const unavailable = option(previous, `${previous} (unavailable)`); unavailable.disabled = true; select.append(unavailable);
      }
      select.value = previous;
      if (!previous && suggested) select.value = suggested[axis].name;
      preferredVectorComponents[axis] = select.value;
    }
    rememberVectorComponentKinds(frame);
  }
  function configureSelectors(frame) {
    configureVectorSelectors(frame);
    for (const id of ['rdf-first-type', 'rdf-second-type']) {
      const select = $(id), previous = select.value;
      select.replaceChildren(option('', 'All elements'), ...frame.typeLabels.map(label => option(label, label)));
      select.value = frame.typeLabels.includes(previous) ? previous : '';
    }
    $('reference-frame').max = String(getFrameCount());
    if (Number($('reference-frame').value) > getFrameCount()) $('reference-frame').value = '1';
    $('displacement-reference-frame').max = String(getFrameCount());
    if (Number($('displacement-reference-frame').value) > getFrameCount()) $('displacement-reference-frame').value = '1';
    $('export-series-first').max = $('export-series-last').max = String(getFrameCount());
  }
  function syncVectorSourceUi() {
    const sources = availableVectorSources(getFrame(), { displacementEnabled: displacement.enabled });
    const selected = sources.find(source => source.value === preferredVectorSource);
    if (selected) preferredVectorAnalysisKinds = new Set((selected.components ?? []).map(property => property.analysisKind).filter(Boolean));
    else {
      const pending = pendingVectorSourceKinds(preferredVectorSource);
      if (pending.size) preferredVectorAnalysisKinds = pending;
    }
    // Preserve a field's source across cold/heterogeneous trajectory frames.
    // Rendering waits for data; selecting arrows never starts an analysis.
    $('vector-mode').replaceChildren(...sources.map(source => option(source.value, source.label)));
    if (!selected) {
      const pendingAnalyses = getPendingAnalysisKinds().length || Object.entries(JOBS).some(([kind, { prefix }]) => jobs[kind].enabled
        && !['Calculated', 'Failed'].includes($(`${prefix}-state`).textContent));
      const waiting = preferredVectorAnalysisKinds.size
        ? [...preferredVectorAnalysisKinds].some(kind => kind === 'displacement' ? displacement.enabled : tools.isToolEnabled(kind)) : pendingAnalyses;
      const unavailable = option('', waiting ? 'Waiting for calculated vector…' : `${preferredVectorSource} (unavailable in this frame)`);
      unavailable.disabled = true; $('vector-mode').prepend(unavailable);
    }
    $('vector-mode').value = selected ? preferredVectorSource : '';
    $('vector-components').hidden = $('vector-component-scales').hidden = preferredVectorSource !== 'generic';
    $('vector-source-help').textContent = !selected ? 'This source is unavailable in the current frame. Enable its analysis separately if needed.'
      : preferredVectorSource === 'generic' ? 'Choose existing numeric properties and scale each Cartesian component for drawing. Vector arrows do not calculate atom properties.'
        : `Using ${selected.components.map(property => property.name).join(', ')}. The scale controls arrow lengths without changing these properties.`;
    return selected ?? null;
  }
  function updateVectors() {
    const frame = getFrame();
    if (frame) configureVectorSelectors(frame);
    syncVectorSourceUi(); saveVectorEditor(); syncVectorFieldList();
    if (frame && renderer.frame !== frame) {
      $('vector-status').textContent = 'Waiting for the current structure to finish loading before displaying arrows.';
      return;
    }
    const rendered = [], unavailable = [], invalid = [];
    const sources = availableVectorSources(frame, { displacementEnabled: displacement.enabled });
    for (const field of vectorFields) {
      const source = sources.find(source => source.value === field.mode);
      if (source?.components) vectorResolvedComponents.set(field.id, source.components.map(property => property.name));
      if (source) vectorSourceKinds.set(field.id, new Set((source.components ?? []).map(property => property.analysisKind).filter(Boolean)));
      else { const pending = pendingVectorSourceKinds(field.mode); if (pending.size) vectorSourceKinds.set(field.id, pending); }
      const components = field.mode === 'generic' ? field.components : source?.components?.map(property => property.name) ?? [];
      for (const name of components) {
        const property = frame?.properties.find(property => property.name === name);
        const kind = property ? property.analysisKind ?? null : pendingVectorComponentKind(name);
        if (property || kind != null) vectorComponentKinds.set(name, kind);
      }
      try {
        const result = vectorFieldData(frame, field, { displacementEnabled: displacement.enabled, sources, cache: vectorDataCache });
        if (result) rendered.push(result);
        else if (field.enabled) unavailable.push(field.name);
      } catch (error) { invalid.push(`${field.name}: ${error.message}`); }
    }
    renderer.setVectorFields(rendered);
    tools.setToolEnabled('vectors', rendered.length > 0);
    $('vector-status').textContent = !frame ? 'Open a structure to display existing vectors.'
      : invalid.length ? invalid.join(' ')
        : `${rendered.length} vector field${rendered.length === 1 ? '' : 's'} displayed.${unavailable.length ? ` Waiting for existing source properties: ${unavailable.join(', ')}.` : rendered.length ? ' Arrows have independent visibility and settings for each field.' : ' Enable a field to display arrows.'}`;
    syncComparison();
  }
  function renameProperty(oldName, name) {
    if (oldName === name) return;
    saveVectorEditor();
    for (const field of vectorFields) {
      const resolved = vectorResolvedComponents.get(field.id) ?? [];
      if (renameVectorFieldProperty(field, oldName, name, resolved)) {
        vectorDataCache.delete(field.id); vectorResolvedComponents.delete(field.id);
      }
    }
    if (vectorComponentKinds.has(oldName)) {
      vectorComponentKinds.set(name, vectorComponentKinds.get(oldName)); vectorComponentKinds.delete(oldName);
    }
    loadVectorEditor(); updateVectors(); updateMeasurements();
  }
  function displacementState(text, status) {
    $('displacement-state').textContent = text;
    $('displacement-state').classList.toggle('ready', text === 'Calculated');
    $('run-displacement').disabled = !getFrame() || text === 'Calculating…';
    $('cancel-displacement').disabled = !getFrame() || !displacement.enabled;
    if (text !== 'Calculated') $('displacement-status').removeAttribute('title');
    if (status) $('displacement-status').textContent = status;
  }
  function clearDisplacementResults() {
    for (const frame of getFrames()) {
      clearAnalysisResults(frame, 'displacement');
      frame.vectorPropertyResults?.delete('displacement');
      if (frame.atomeyeResults) delete frame.atomeyeResults.displacement;
      onMemoryChange(frame);
    }
  }
  function cancelDisplacement({ redraw = true } = {}) {
    if (redraw) changed();
    cancelVectorDependency('displacement');
    const displacementNames = new Set(Object.values(vectorPropertyNames('displacement')));
    displacement.request++; displacement.enabled = false;
    displacement.controller?.abort(); displacement.controller = null; displacement.parameters = null;
    clearDisplacementResults();
    for (const field of vectorFields) field.components = field.components.map(name => displacementNames.has(name) && !getFrame()?.properties.some(property => property.name === name) ? null : name);
    preferredVectorComponents = selectedVectorField().components.map(name => name ?? '');
    for (const [axis, name] of preferredVectorComponents.entries()) $(`vector-${'xyz'[axis]}`).value = name;
    tools.setToolEnabled('displacement', false);
    displacementState('Not calculated', 'Calculation cleared. Frame changes will not calculate displacement until you enable this tool again.');
    if (getFrame()) configureVectorSelectors(getFrame());
    updateVectors();
    if (redraw && getFrame()) refresh();
  }
  async function runDisplacement({ automatic = false } = {}) {
    const frame = getFrame();
    if (!frame || (automatic && !displacement.enabled)) return;
    try {
      if (!automatic) {
        changed();
        const referenceFrame = number('displacement-reference-frame') - 1;
        if (!Number.isInteger(referenceFrame) || referenceFrame < 0 || referenceFrame >= getFrameCount()) throw new Error('Choose an available displacement reference frame.');
        const parameters = { referenceFrame, minimumImage: $('displacement-minimum-image').checked };
        if (JSON.stringify(parameters) !== JSON.stringify(displacement.parameters)) clearDisplacementResults();
        displacement.parameters = parameters; displacement.enabled = true;
        tools.setToolEnabled('displacement', true, { reveal: true });
      }
      displacement.controller?.abort();
      const controller = new AbortController(), request = ++displacement.request;
      displacement.controller = controller;
      const source = getSourceVersion(), token = generation, colorChoice = getColorChoiceVersion();
      const parameters = { ...displacement.parameters }, key = resultKey('displacement', parameters);
      const current = () => displacement.enabled && request === displacement.request && frame === getFrame()
        && source === getSourceVersion() && token === generation && !controller.signal.aborted;
      displacementState('Calculating…', `Calculating displacement from frame ${parameters.referenceFrame + 1}…`);
      updateVectors();
      try {
        let cached = frame.atomeyeResults?.displacement;
        if (cached?.key !== key) {
          const reference = parameters.referenceFrame === getFrameIndex() ? frame : await getFrameAt(parameters.referenceFrame);
          if (!current()) return;
          if (!reference) throw new Error('The displacement reference frame is no longer available.');
          const prepared = await prepareDisplacements(frame, reference, { minimumImage: parameters.minimumImage, signal: controller.signal,
            onProgress: ({ completed, total }) => { if (current()) $('displacement-status').textContent = `Matching atom IDs… ${completed} / ${total}`; } });
          if (!current()) return;
          const result = await pool.analyze(frame, { kind: 'displacement', ...prepared, referenceFrameIndex: parameters.referenceFrame },
            { signal: controller.signal, frameIndex: getFrameIndex(), onProgress: progress => {
              if (current()) $('displacement-status').textContent = analysisProgressText(progress, { frameIndex: getFrameIndex(), kind: 'displacement' });
            } });
          if (!current()) return;
          cached = { key: resultKey('displacement', parameters, result.gpuRequested), result };
          frame.atomeyeResults ??= {}; frame.atomeyeResults.displacement = cached;
        }
        if (!current()) return;
        const { vectors, magnitudes, unmatched = 0, mappingMode = 'id' } = cached.result;
        registerVectorProperties(frame, { mode: 'displacement', vectors, magnitudes });
        configureVectorSelectors(frame);
        displacementState('Calculated', `${(frame.ids.length - unmatched).toLocaleString()} atoms calculated · ${analysisBackendLabel(cached.result)}${Number.isFinite(cached.result.elapsedMs) ? ` · ${Math.round(cached.result.elapsedMs).toLocaleString()} ms` : ''}. Displacement X, Y, Z and magnitude are available in Color by and Vector arrows.${unmatched ? ` ${unmatched.toLocaleString()} unmatched IDs have NaN.` : ''}${mappingMode === 'row-order' ? ' No explicit IDs: matching by row order requires consistent atom ordering.' : ''}`);
        $('displacement-status').title = analysisBackendDetails(cached.result);
        if (!automatic && colorChoice === getColorChoiceVersion()) chooseProperty('displacementMagnitude');
        else refresh();
        onMemoryChange(frame); updateVectors();
      } catch (error) {
        if (current() && error.name !== 'AbortError') {
          displacementState('Failed', error.message); refresh(); updateVectors(); notify(error.message);
        }
      } finally { if (displacement.controller === controller) displacement.controller = null; }
    } catch (error) { notify(error.message); }
  }
  function renderPairs(frame) {
    const container = $('bond-pair-cutoffs'); container.replaceChildren();
    const details = document.createElement('details'), title = document.createElement('summary');
    title.textContent = 'Element-pair cutoffs (blank uses default)'; details.append(title);
    const limit = Math.min(frame.typeLabels.length, 32);
    for (let first = 0; first < limit; first++) for (let second = first; second < limit; second++) {
      const a = frame.typeLabels[first], b = frame.typeLabels[second];
      const label = document.createElement('label'); label.className = 'bond-pair-cutoff-row';
      const text = document.createElement('span'); text.textContent = `${a} – ${b}`;
      const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.step = '.05';
      input.setAttribute('aria-label', `${a} – ${b} cutoff`);
      input.value = String(pairCutoffs.find(entry => entry.first === a && entry.second === b)?.cutoff ?? '');
      input.addEventListener('change', () => {
        changed(); const value = input.valueAsNumber;
        if (input.value !== '' && (!Number.isFinite(value) || value < 0)) { notify('A pair cutoff must be zero or positive.'); return; }
        pairCutoffs = pairCutoffs.filter(entry => !(entry.first === a && entry.second === b));
        if (input.value !== '') pairCutoffs.push({ first: a, second: b, cutoff: value });
        if (jobs.bonds.enabled) void run('bonds');
        onBondParametersChange();
      });
      label.append(text, input); details.append(label);
    }
    container.append(details);
  }
  function renderElements(frame) {
    const container = $('element-style-controls'), base = colorsByType(frame); container.replaceChildren();
    frame.typeLabels.forEach((label, type) => {
      const override = appearance.elements.find(entry => entry.label === label);
      const row = document.createElement('div'); row.className = 'element-style-row';
      const text = document.createElement('span'); text.textContent = label;
      const color = document.createElement('input'); color.type = 'color'; color.value = override?.color ?? rgbHex(base.legend.items[type].color);
      color.setAttribute('aria-label', `${label} atom color`);
      const radius = document.createElement('input'); radius.type = 'number'; radius.min = '.001'; radius.step = '.05'; radius.value = String(override?.radius ?? radiusForElement(label));
      radius.setAttribute('aria-label', `${label} radius in angstroms`);
      const visible = document.createElement('input'); visible.type = 'checkbox'; visible.checked = override?.visible !== false; visible.setAttribute('aria-label', `Show ${label} atoms`);
      const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset'; reset.className = 'text-button';
      const update = () => {
        if (!Number.isFinite(radius.valueAsNumber) || radius.valueAsNumber <= 0) return;
        changed(); appearance.elements = appearance.elements.filter(entry => entry.label !== label);
        appearance.elements.push({ label, color: color.value, radius: radius.valueAsNumber, visible: visible.checked }); refresh();
      };
      for (const input of [color, radius, visible]) input.addEventListener('change', update);
      reset.addEventListener('click', () => { changed(); appearance.elements = appearance.elements.filter(entry => entry.label !== label); renderElements(frame); refresh(); });
      row.append(text, color, radius, visible, reset); container.append(row);
    });
  }
  function updateAtomStyle(index = getSelectedIndex()) {
    const frame = getFrame(), enabled = Boolean(frame && index >= 0);
    for (const id of ['center-atom', 'selected-atom-color', 'selected-atom-radius', 'selected-atom-visible', 'apply-atom-style', 'reset-atom-style']) $(id).disabled = !enabled;
    if (!enabled) return;
    const atom = appearance.atoms.find(entry => String(entry.id) === String(frame.ids[index]));
    $('selected-atom-color').value = atom?.color ?? rgbHex(colors?.subarray(index * 3, index * 3 + 3) ?? colorsByType(frame).colors.subarray(index * 3, index * 3 + 3));
    $('selected-atom-radius').value = String(atom?.radius ?? renderer.atomRadii[index]);
    $('selected-atom-visible').checked = atom?.visible !== false;
  }
  function selected(index) {
    if ($('measure-mode').checked && index >= 0 && getFrame()) {
      const id = getFrame().ids[index];
      if (!measurements.some(value => String(value) === String(id))) { if (measurements.length === 4) measurements.shift(); measurements.push(id); }
    }
    updateAtomStyle(index); updateMeasurements();
  }
  function updateMeasurements() {
    const frame = getFrame(), container = $('measurement-data'); container.replaceChildren();
    if (!frame || !$('measure-mode').checked) { renderer.setSelectedAtoms([]); return; }
    const indices = measurements.map(id => frame.ids.findIndex(value => String(value) === String(id))).filter(index => index >= 0);
    renderer.setSelectedAtoms(indices);
    if (!indices.length) { container.textContent = 'Select up to four atoms to measure.'; return; }
    if (indices.length === 1) { container.textContent = `Atom: ${frame.ids[indices[0]]}. Select another atom to measure.`; return; }
    try {
      const result = measureAtoms(frame, indices, { minimumImage: $('measure-pbc').checked, positions: renderer.displayPositions });
      const rows = [`Atoms: ${indices.map(index => frame.ids[index]).join(' → ')}`];
      if (indices.length >= 2) {
        rows.push(`Distance: ${result.distance.toPrecision(7)} Å`);
        rows.push(`Distance vector: ${result.displacement.map((value, axis) => `Δ${'xyz'[axis]} = ${value.toPrecision(7)} Å`).join(', ')}`);
      }
      if (indices.length >= 3) rows.push(`Angle: ${result.angle.toPrecision(7)}°`);
      if (indices.length >= 4) rows.push(`Dihedral: ${result.dihedral.toPrecision(7)}°`);
      for (const row of rows) { const item = document.createElement('p'); item.textContent = row; container.append(item); }
    } catch (error) { container.textContent = error.message; }
  }
  function customizePalette(palette) {
    const frame = getFrame();
    if (!frame) return palette;
    const result = applyAppearance(frame, palette.colors, null, appearance, { elementColors: getColorMode() === 'type', selectionGroups: getSelectionGroups() });
    if (getColorMode() === 'type') palette.legend.items = palette.legend.items.map(item => ({ ...item,
      color: appearance.elements.find(entry => entry.label === item.label)?.color ? hexColor(appearance.elements.find(entry => entry.label === item.label).color) : item.color }));
    colors = result.colors;
    return { ...palette, colors: result.colors };
  }
  function filterVisibility(mask) {
    const frame = getFrame(); if (!frame) return mask;
    return applyAppearance(frame, colors ?? colorsByType(frame).colors, mask, appearance, { elementColors: false, selectionGroups: getSelectionGroups() }).visibility;
  }
  function applyRadii() {
    const frame = getFrame(); if (!frame) return;
    renderer.setAtomRadii(applyAppearance(frame, colors ?? colorsByType(frame).colors, null, appearance, { selectionGroups: getSelectionGroups() }).radii);
    updateAtomStyle(); syncComparison();
  }
  function updateStatistics() {
    const frame = getFrame(), container = $('coordination-histogram'); container.replaceChildren();
    const property = frame?.properties.find(entry => entry.name === 'bondCoordination') ?? frame?.properties.find(entry => entry.name === 'coordination');
    if (!property) { container.textContent = 'Calculate coordination or bonds to see the distribution.'; return; }
    const histogram = new Map((property.histogram ?? []).map(entry => [entry.coordination, entry.count])); let mean = property.meanCoordination;
    if (!histogram.size) {
      let sum = 0;
      for (const value of property.data) { histogram.set(value, (histogram.get(value) ?? 0) + 1); sum += value; }
      mean = sum / property.data.length;
    }
    const text = document.createElement('p'); text.textContent = `${property.name} · mean ${mean.toFixed(3)} · ${property.data.length.toLocaleString()} atoms`; container.append(text);
    const entries = [...histogram].sort((a, b) => a[0] - b[0]);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 360 180');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Coordination number histogram');
    const maximum = Math.max(...entries.map(([, count]) => count)), width = 310 / entries.length;
    for (const [index, [coordination, count]] of entries.entries()) {
      const rectangle = document.createElementNS(svg.namespaceURI, 'rect'), height = count / maximum * 135;
      rectangle.setAttribute('x', String(35 + index * width)); rectangle.setAttribute('y', String(150 - height));
      rectangle.setAttribute('width', String(Math.max(.1, width - 2))); rectangle.setAttribute('height', String(height)); rectangle.setAttribute('fill', 'currentColor');
      const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = `${coordination} neighbors: ${count} atoms`; rectangle.append(title); svg.append(rectangle);
      if (entries.length < 20 || index === 0 || index === entries.length - 1) {
        const label = document.createElementNS(svg.namespaceURI, 'text'); label.textContent = String(coordination); label.setAttribute('x', String(35 + (index + .5) * width));
        label.setAttribute('y', '168'); label.setAttribute('text-anchor', 'middle'); label.setAttribute('fill', 'currentColor'); label.setAttribute('font-size', '11'); svg.append(label);
      }
    }
    container.append(svg);
    const table = document.createElement('table');
    for (const [coordination, count] of entries) {
      const row = document.createElement('tr');
      for (const value of [coordination, count, `${(100 * count / property.data.length).toFixed(2)}%`]) { const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell); }
      table.append(row);
    }
    container.append(table);
  }
  function renderRdf(result) {
    const container = $('rdf-chart'); container.replaceChildren();
    const maximum = Math.max(1, ...result.values), xmax = result.radii.at(-1) || 1;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 360 190'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Radial distribution function g(r)');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', Array.from(result.radii, (radius, index) => `${index ? 'L' : 'M'}${(38 + radius / xmax * 305).toFixed(2)},${(160 - result.values[index] / maximum * 140).toFixed(2)}`).join(' '));
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '2'); svg.append(path);
    for (const [x, y, text] of [[4, 16, 'g(r)'], [38, 181, '0'], [295, 181, `${xmax.toFixed(2)} Å`], [4, 32, maximum.toFixed(1)]]) {
      const label = document.createElementNS(svg.namespaceURI, 'text'); label.setAttribute('x', String(x)); label.setAttribute('y', String(y)); label.setAttribute('fill', 'currentColor'); label.setAttribute('font-size', '11'); label.textContent = text; svg.append(label);
    }
    container.append(svg); $('export-rdf').disabled = false;
  }
  function syncComparison() {
    const frame = getFrame();
    if (!frame || !$('compare-view').checked) { if (comparisonContainer) comparisonContainer.hidden = true; tools.setToolEnabled('display', false); return; }
    if (!comparison) {
      comparisonContainer = document.createElement('div'); comparisonContainer.className = 'comparison-view';
      const canvas = document.createElement('canvas'), label = document.createElement('span'), close = document.createElement('button');
      canvas.addEventListener('pointerdown', changed);
      canvas.addEventListener('wheel', changed, { passive: true });
      label.className = 'comparison-label'; close.className = 'comparison-close'; close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close comparison view');
      close.addEventListener('click', () => { $('compare-view').checked = false; changed(); syncComparison(); });
      const toolbar = document.createElement('div'); toolbar.className = 'comparison-toolbar'; toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', 'Second view camera controls');
      for (const [view, text] of [['top', 'Top'], ['bottom', 'Bottom'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right']]) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.compareView = view; button.textContent = text;
        button.setAttribute('aria-label', `Second view: ${text}`);
        button.addEventListener('click', () => { changed(); $('compare-preset').value = view; comparison.setView(view); syncComparisonToolbar(); });
        toolbar.append(button);
      }
      for (const [mode, text] of [['perspective', 'Perspective'], ['orthographic', 'Ortho']]) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.compareProjection = mode; button.textContent = text;
        button.addEventListener('click', () => { changed(); comparison.setProjection(mode); syncComparisonToolbar(); }); toolbar.append(button);
      }
      const fit = document.createElement('button'); fit.type = 'button'; fit.textContent = 'Fit'; fit.dataset.compareReset = ''; fit.setAttribute('aria-label', 'Fit second view to structure');
      fit.addEventListener('click', () => { changed(); const { yaw, pitch, roll, constrainUp } = comparison; comparison.resetCamera(); Object.assign(comparison, { yaw, pitch, roll, constrainUp }); syncComparisonToolbar(); }); toolbar.append(fit);
      comparisonContainer.append(canvas, label, toolbar, close); renderer.canvas.parentElement.append(comparisonContainer);
      comparison = new WebGLRenderer(canvas, { onPick: index => selectAtom(index), onProjectionChange: syncComparisonToolbar, onCameraChange: syncComparisonToolbar });
    }
    comparisonContainer.hidden = false;
    const positions = renderer.rawDisplayPositions ?? renderer.displayPositions;
    const coordinateMode = renderer.coordinateMode ?? 'wrapped';
    if (comparison.frame !== frame) {
      const camera = comparison.frame ? cameraSnapshot(comparison) : null;
      comparison.setFrame(frame, renderer.atomColors, positions, renderer.atomRadii, renderer.repetitions, { coordinateMode });
      if (camera) restoreCamera(comparison, camera);
      else { comparison.resetCamera(); if ($('compare-preset').value !== 'custom') comparison.setView($('compare-preset').value); }
    } else {
      comparison.setColors(renderer.atomColors); comparison.setAtomRadii(renderer.atomRadii);
      if (comparison.rawDisplayPositions !== positions || comparison.coordinateMode !== coordinateMode) comparison.setDisplayPositions(positions, { coordinateMode });
      if (comparison.repetitions.some((value, axis) => value !== renderer.repetitions[axis])) comparison.setReplications(renderer.repetitions);
    }
    const origin = renderer.periodicOrigin ?? [0, 0, 0];
    if (origin.some((value, axis) => value !== (comparison.periodicOrigin?.[axis] ?? 0))) comparison.setPeriodicOrigin(origin, { coordinateMode });
    comparison.setVisibility(renderer.visibility, { selectionVisibility: renderer.selectionVisibility });
    if (renderer.sliceMode === 'legacy') comparison.setSlice(renderer.sliceAxis, renderer.sliceMaximum);
    else comparison.setSlices(renderer.slices);
    comparison.setBackground(rgbHex(renderer.background.map(value => value * 255)));
    comparison.setCellVisible(renderer.cellVisible); comparison.setRadiusScale(renderer.radiusScale);
    comparison.setCellWireframeMode(renderer.cellWireframeMode ?? 'mono');
    comparison.setBonds(renderer.atomBonds ?? null,
      { visible: $('show-bonds').checked, radius: number('bonds-radius') });
    comparison.setVectorFields(renderer.atomVectorFields ?? []);
    comparison.setDislocationNetwork(renderer.dislocationNetwork, renderer.dislocationOptions);
    syncComparisonToolbar();
  }
  function syncComparisonToolbar() {
    if (!comparison?.frame || !comparisonContainer || !$('compare-view').checked) return;
    const view = cameraViewPreset(comparison);
    $('compare-preset').value = view;
    comparisonContainer.querySelector('.comparison-label').textContent = view === 'custom' ? 'Custom' : view;
    for (const button of comparisonContainer.querySelectorAll('[data-compare-view]')) button.setAttribute('aria-pressed', String(button.dataset.compareView === view));
    for (const button of comparisonContainer.querySelectorAll('[data-compare-projection]')) button.setAttribute('aria-pressed', String(button.dataset.compareProjection === comparison.projectionMode));
  }
  async function onFrame({ suggestedCutoff } = {}) {
    abortJobs(); currentFrame = getFrame();
    vectorDataCache.clear();
    if (!currentFrame) return;
    for (const [id, kind] of Object.entries({ 'bonds-cutoff': 'bonds', 'reference-cutoff': 'referenceStrain', 'local-shear-cutoff': 'localShear', 'rdf-cutoff': 'rdf' })) {
      const enabled = jobs[kind].enabled || (kind === 'bonds' && getBondStatisticsEnabled());
      if (!$(id).value || (!enabled && suggestedCutoff)) $(id).value = String(suggestedCutoff ?? 3);
    }
    configureSelectors(currentFrame); renderPairs(currentFrame); renderElements(currentFrame); applyRadii(); updateMeasurements(); updateStatistics();
    renderer.setBonds(null);
    updateVectors();
    await Promise.all([displacement.enabled ? runDisplacement({ automatic: true }) : displacementState('Not calculated'),
      ...Object.keys(jobs).map(kind => jobs[kind].enabled ? run(kind, { automatic: true }) : stateFor(kind, 'Not calculated'))]);
    updateVectors();
    syncComparison();
  }
  function reset() {
    generation++; abortJobs(); cancelBatch({ restore: false });
    for (const kind of Object.keys(jobs)) { cancel(kind, { redraw: false }); jobs[kind].parameters = null; }
    measurements = []; appearance = { elements: [], atoms: [] }; pairCutoffs = []; currentFrame = null; colors = null;
    $('show-vectors').checked = $('measure-mode').checked = $('compare-view').checked = false;
    cancelDisplacement({ redraw: false }); preferredVectorSource = 'generic'; preferredVectorAnalysisKinds.clear(); preferredVectorComponents = ['', '', '']; vectorComponentKinds.clear();
    vectorFields = [createVectorField()]; selectedVectorId = vectorFields[0].id; vectorSequence = 1; vectorSourceKinds.clear(); vectorDataCache.clear(); vectorResolvedComponents.clear(); loadVectorEditor();
    $('show-bonds').checked = true;
    $('element-style-controls').replaceChildren(); $('bond-pair-cutoffs').replaceChildren(); $('rdf-chart').replaceChildren();
    $('export-series-first').value = '1'; $('export-series-last').value = String(getFrameCount() || 1);
    renderer.setBonds(null); renderer.setVectorFields([]); renderer.setSelectedAtoms([]);
    comparison?.clearFrame(); if (comparisonContainer) comparisonContainer.hidden = true;
    updateMeasurements(); syncVectorSourceUi();
  }
  function serialize() {
    saveVectorEditor();
    const frame = getFrame();
    const { id: _id, name: _name, ...selectedVectorSettings } = createVectorField(selectedVectorField());
    const cutoff = id => Number.isFinite($(id).valueAsNumber) && $(id).valueAsNumber > 0 ? $(id).valueAsNumber : null;
    return {
      bonds: { enabled: jobs.bonds.enabled, cutoff: cutoff('bonds-cutoff'), pairCutoffs: pairCutoffs.map(entry => ({ ...entry })), radius: number('bonds-radius'), visible: $('show-bonds').checked },
      displacement: { enabled: displacement.enabled, referenceFrame: number('displacement-reference-frame') - 1, minimumImage: $('displacement-minimum-image').checked },
      vectors: { ...selectedVectorSettings, fields: vectorFields.map(field => createVectorField(field)), selectedId: selectedVectorId },
      referenceStrain: { enabled: jobs.referenceStrain.enabled, frameIndex: Math.max(0, Number($('reference-frame').value) - 1), cutoff: cutoff('reference-cutoff') },
      localShear: { enabled: jobs.localShear.enabled, cutoff: cutoff('local-shear-cutoff'), subtractMean: $('local-shear-subtract-mean').checked },
      rdf: { enabled: jobs.rdf.enabled, cutoff: cutoff('rdf-cutoff'), bins: Number($('rdf-bins').value), firstType: $('rdf-first-type').value || null, secondType: $('rdf-second-type').value || null },
      measurements: { enabled: $('measure-mode').checked, minimumImage: $('measure-pbc').checked, atomIds: [...measurements] },
      appearance: { elements: appearance.elements.map(entry => ({ ...entry })), atoms: appearance.atoms.map(entry => ({ ...entry })) },
      comparison: { enabled: $('compare-view').checked && Boolean(frame), preset: $('compare-view').checked && frame && comparison?.frame === frame ? cameraViewPreset(comparison) : $('compare-preset').value,
        projectionMode: comparison?.projectionMode ?? 'orthographic', camera: frame && comparison?.frame === frame ? cameraSnapshot(comparison) : null },
    };
  }
  async function restore(saved, { isCurrent = () => true } = {}) {
    if (!saved || !isCurrent()) return;
    const restoredFields = (saved.vectors.fields?.length ? saved.vectors.fields : [saved.vectors]).map((field, index) => createVectorField(field, `vector-${index + 1}`));
    const sourceKinds = new Map(restoredFields.map(field => {
      const source = [...getFrames()].flatMap(frame => availableVectorSources(frame, { displacementEnabled: saved.displacement.enabled })).find(source => source.value === field.mode);
      return [field.id, source ? new Set((source.components ?? []).map(property => property.analysisKind).filter(Boolean)) : new Set(vectorSourceKinds.get(field.id) ?? [])];
    }));
    const componentKinds = restoredFields.flatMap(field => field.components.map(name => {
      const property = getFrame()?.properties.find(property => property.name === name)
        ?? [...getFrames()].flatMap(frame => frame.properties).find(property => property.name === name);
      return [name, property ? property.analysisKind ?? null : vectorComponentKinds.get(name)];
    }));
    reset(); appearance = saved.appearance; pairCutoffs = saved.bonds.pairCutoffs.map(entry => ({ ...entry }));
    vectorFields = restoredFields; selectedVectorId = vectorFields.some(field => field.id === saved.vectors.selectedId) ? saved.vectors.selectedId : vectorFields[0].id;
    vectorSequence = Math.max(vectorFields.length, ...vectorFields.map(field => {
      const suffix = Number(field.id.match(/^vector-(\d+)$/)?.[1]);
      return Number.isSafeInteger(suffix) && suffix < 1e6 ? suffix : 0;
    }));
    for (const [id, kinds] of sourceKinds) vectorSourceKinds.set(id, kinds);
    for (const [name, kind] of componentKinds) if (name && kind !== undefined) vectorComponentKinds.set(name, kind);
    loadVectorEditor();
    const token = generation, sourceVersion = getSourceVersion();
    const current = () => isCurrent() && token === generation && sourceVersion === getSourceVersion();
    for (const [id, value] of [['bonds-cutoff', saved.bonds.cutoff], ['bonds-radius', saved.bonds.radius], ['reference-frame', saved.referenceStrain.frameIndex + 1],
      ['reference-cutoff', saved.referenceStrain.cutoff], ['local-shear-cutoff', saved.localShear.cutoff], ['rdf-cutoff', saved.rdf.cutoff], ['rdf-bins', saved.rdf.bins],
      ['compare-preset', saved.comparison.preset]]) if (value !== null) $(id).value = String(value);
    $('displacement-reference-frame').value = String(saved.displacement.referenceFrame + 1);
    $('displacement-minimum-image').checked = saved.displacement.minimumImage;
    displacement.enabled = Boolean(getFrame()) && saved.displacement.enabled;
    displacement.parameters = { referenceFrame: saved.displacement.referenceFrame, minimumImage: saved.displacement.minimumImage };
    tools.setToolEnabled('displacement', displacement.enabled);
    for (const kind of Object.keys(jobs)) {
      jobs[kind].enabled = Boolean(getFrame()) && saved[kind].enabled;
      jobs[kind].parameters = kind === 'bonds' ? { cutoff: saved.bonds.cutoff, pairCutoffs: saved.bonds.pairCutoffs.map(entry => ({ first: getFrame()?.typeLabels.indexOf(entry.first), second: getFrame()?.typeLabels.indexOf(entry.second), cutoff: entry.cutoff })).filter(entry => entry.first >= 0 && entry.second >= 0) }
        : kind === 'referenceStrain' ? { frameIndex: saved[kind].frameIndex, cutoff: saved[kind].cutoff }
          : kind === 'localShear' ? { cutoff: saved[kind].cutoff, subtractMean: saved[kind].subtractMean }
            : { cutoff: saved[kind].cutoff, bins: saved[kind].bins, firstType: saved[kind].firstType, secondType: saved[kind].secondType };
      tools.setToolEnabled(JOBS[kind].tool, jobs[kind].enabled);
      if (kind === 'bonds') onBondStateChange();
    }
    $('local-shear-subtract-mean').checked = saved.localShear.subtractMean;
    $('show-bonds').checked = saved.bonds.visible;
    $('show-vectors').checked = selectedVectorField().enabled; $('measure-mode').checked = saved.measurements.enabled;
    $('measure-pbc').checked = saved.measurements.minimumImage; measurements = [...saved.measurements.atomIds];
    $('compare-view').checked = saved.comparison.enabled;
    if (getFrame()) {
      configureSelectors(getFrame());
      for (const [axis, name] of selectedVectorField().components.entries()) $(`vector-${'xyz'[axis]}`).value = name ?? '';
      $('rdf-first-type').value = saved.rdf.firstType ?? ''; $('rdf-second-type').value = saved.rdf.secondType ?? '';
      await onFrame();
      if (!current()) return;
      if (comparison && saved.comparison.enabled) {
        if (saved.comparison.camera) restoreCamera(comparison, saved.comparison.camera);
        comparison.setProjection(saved.comparison.projectionMode); syncComparisonToolbar();
      }
      refresh();
    }
  }
  function setEnabled(enabled) {
    for (const panel of document.querySelectorAll('[data-tool-panel="bonds"], [data-tool-panel="vectors"], [data-tool-panel="displacement"], [data-tool-panel="statistics"], [data-tool-panel="referenceStrain"], [data-tool-panel="localShear"]')) for (const input of panel.querySelectorAll('input, select, button')) input.disabled = !enabled;
    for (const id of ['find-atom', 'atom-search-id', 'measure-mode', 'measure-pbc', 'clear-measurements', 'compare-view', 'compare-preset', 'export-jpg', 'export-atom-indices', 'export-multiview', 'export-frame-series', 'export-series-first', 'export-series-last', 'export-series-step']) $(id).disabled = !enabled;
    updateAtomStyle();
    for (const [kind, job] of Object.entries(jobs)) $(`cancel-${JOBS[kind].prefix}`).disabled = !enabled || !job.enabled;
    $('export-rdf').disabled = !enabled || !getFrame()?.atomeyeResults?.rdf;
    $('run-displacement').disabled = !enabled || $('displacement-state').textContent === 'Calculating…';
    $('cancel-displacement').disabled = !enabled || !displacement.enabled;
  }
  function cancelBatch({ restore = true } = {}) { if (batch) { batch.cancelled = true; batch.restore = restore; } }
  async function exportSeries() {
    if (!getFrame() || batch) return;
    const first = number('export-series-first') - 1, last = number('export-series-last') - 1, step = number('export-series-step');
    if (![first, last, step].every(Number.isInteger) || first < 0 || last < first || last >= getFrameCount()) throw new Error('Choose a valid frame range and integer step.');
    const count = Math.floor((last - first) / step) + 1;
    if (count > 500) throw new Error('Export at most 500 frames in one archive.');
    const task = { cancelled: false, restore: true, source: getSourceVersion() }; batch = task;
    const original = getFrameIndex(), camera = cameraSnapshot(renderer), entries = []; let total = 0;
    let completed = false, failure = null;
    stopPlayback(); $('cancel-frame-series').disabled = false; $('export-frame-series').disabled = true;
    try {
      for (let index = first; index <= last; index += step) {
        if (task.cancelled || task.source !== getSourceVersion()) return;
        $('export-series-status').textContent = `Rendering frame ${index + 1} · ${entries.length} / ${count} exported`;
        if (!await showFrame(index)) throw new Error(`Could not load frame ${index + 1}.`);
        if (task.cancelled || task.source !== getSourceVersion()) return;
        const image = renderer.captureImage(getExportOptions()), blob = await canvasBlob(image), bytes = new Uint8Array(await blob.arrayBuffer());
        total += bytes.length;
        if (total > 256 * 1024 ** 2) throw new Error('Image export exceeds 256 MiB. Select fewer frames.');
        entries.push({ name: `${getFileStem()}-frame-${String(index + 1).padStart(6, '0')}.png`, bytes });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (!task.cancelled && task.source === getSourceVersion()) { downloadBlob(createImageArchive(entries), `${getFileStem()}-frames.zip`); completed = true; }
    } catch (error) {
      failure = error;
      if (!task.cancelled) throw error;
    } finally {
      if (task.restore && task.source === getSourceVersion()) { await showFrame(original); restoreCamera(renderer, camera); }
      $('export-series-status').textContent = completed ? `Exported ${entries.length} frames in one ZIP archive.` : failure && !task.cancelled ? `Export failed: ${failure.message}` : 'Export cancelled.';
      if (batch === task) batch = null;
      $('cancel-frame-series').disabled = true; $('export-frame-series').disabled = !getFrame();
    }
  }
  async function exportViews() {
    if (!getFrame()) return;
    const camera = cameraSnapshot(renderer), views = ['front', 'back', 'left', 'right', 'top', 'bottom'];
    const sheet = document.createElement('canvas'); sheet.width = renderer.canvas.width * 3; sheet.height = (renderer.canvas.height + 28) * 2;
    const context = sheet.getContext('2d');
    try {
      for (const [index, view] of views.entries()) {
        renderer.setView(view); const image = renderer.captureImage(getExportOptions());
        const x = index % 3 * image.width, y = Math.floor(index / 3) * (image.height + 28);
        context.drawImage(image, x, y); context.fillStyle = '#ffffff'; context.fillRect(x, y + image.height, image.width, 28);
        context.fillStyle = '#14252b'; context.font = '16px sans-serif'; context.fillText(view, x + 10, y + image.height + 20);
      }
      downloadBlob(await canvasBlob(sheet), `${getFileStem()}-six-views.png`);
    } finally { restoreCamera(renderer, camera); }
  }

  for (const [kind, { prefix }] of Object.entries(JOBS)) {
    $(`run-${prefix}`).addEventListener('click', () => void run(kind));
    $(`cancel-${prefix}`).addEventListener('click', () => { changed(); cancel(kind); });
  }
  for (const id of ['bonds-cutoff', 'local-shear-cutoff', 'local-shear-subtract-mean', 'reference-frame', 'reference-cutoff', 'rdf-cutoff', 'rdf-bins', 'rdf-first-type', 'rdf-second-type']) $(id).addEventListener('change', () => {
    const kind = id.startsWith('bonds') ? 'bonds' : id.startsWith('local') ? 'localShear' : id.startsWith('reference') ? 'referenceStrain' : 'rdf';
    if (jobs[kind].enabled) void run(kind);
    if (kind === 'bonds') onBondParametersChange();
  });
  for (const id of ['show-bonds', 'bonds-radius']) $(id).addEventListener('change', () => {
    const result = getFrame()?.atomeyeResults?.bonds?.result;
    try { renderer.setBonds(result ?? null, { visible: $('show-bonds').checked, radius: number('bonds-radius') }); syncComparison(); } catch (error) { notify(error.message); }
  });
  $('run-displacement').addEventListener('click', () => void runDisplacement());
  $('cancel-displacement').addEventListener('click', () => cancelDisplacement());
  for (const id of ['displacement-reference-frame', 'displacement-minimum-image'])
    $(id).addEventListener('change', () => { if (displacement.enabled) void runDisplacement(); });
  $('vector-mode').addEventListener('change', () => { changed(); preferredVectorSource = $('vector-mode').value; preferredVectorAnalysisKinds.clear(); vectorResolvedComponents.delete(selectedVectorId); updateVectors(); });
  for (const [axis, id] of ['vector-x', 'vector-y', 'vector-z'].entries())
    $(id).addEventListener('change', () => { changed(); preferredVectorComponents[axis] = $(id).value; updateVectors(); });
  for (const id of ['vector-scale-x', 'vector-scale-y', 'vector-scale-z', 'vector-scale', 'vector-color', 'vector-anchor', 'vector-dimension', 'vector-link-dimensions', 'show-vectors'])
    $(id).addEventListener('change', () => { changed(); updateVectors(); });
  for (const id of ['vector-up-mode', 'vector-up-x', 'vector-up-y', 'vector-up-z'])
    $(id)?.addEventListener('change', () => { changed(); updateVectors(); });
  $('vector-field-list')?.addEventListener('change', () => {
    saveVectorEditor(); selectedVectorId = $('vector-field-list').value; loadVectorEditor(); updateVectors(); changed();
  });
  $('vector-field-name')?.addEventListener('change', () => { changed(); updateVectors(); });
  $('add-vector-field')?.addEventListener('click', () => {
    if (vectorFields.length >= 16) { notify('Display up to 16 vector fields.'); return; }
    saveVectorEditor();
    let index;
    do { index = ++vectorSequence; } while (vectorFields.some(field => field.id === `vector-${index}`));
    const palette = ['#f7a633', '#35b8cb', '#da6f96', '#77bf62', '#a38adb'];
    const field = createVectorField({ id: `vector-${index}`, name: `Vector ${index}`, color: palette[(index - 1) % palette.length] });
    vectorFields.push(field); selectedVectorId = field.id; loadVectorEditor(); updateVectors(); changed();
  });
  $('delete-vector-field')?.addEventListener('click', () => {
    vectorSourceKinds.delete(selectedVectorId); vectorDataCache.delete(selectedVectorId); vectorResolvedComponents.delete(selectedVectorId); vectorFields = vectorFields.filter(field => field.id !== selectedVectorId);
    if (!vectorFields.length) vectorFields = [createVectorField({ id: `vector-${++vectorSequence}`, name: `Vector ${vectorSequence}` })];
    selectedVectorId = vectorFields[0].id; loadVectorEditor(); updateVectors(); changed();
  });
  for (const [name, id] of Object.entries(VECTOR_SIZE_IDS)) $(id).addEventListener('change', () => {
    try {
      const value = number(id);
      const next = $('vector-link-dimensions').checked ? linkedArrowDimensions(vectorDimensions, name, value) : { ...vectorDimensions, [name]: value };
      for (const [key, size] of Object.entries(next)) $(VECTOR_SIZE_IDS[key]).value = String(Number(size.toPrecision(12)));
      vectorDimensions = next; changed(); updateVectors();
    } catch (error) { $(id).value = String(vectorDimensions[name]); notify(error.message); }
  });
  $('find-atom').addEventListener('click', () => {
    const frame = getFrame(), index = frame?.ids.findIndex(id => String(id) === $('atom-search-id').value.trim()) ?? -1;
    if (index < 0) { notify('No atom has that ID in this frame.'); return; }
    selectAtom(index); renderer.centerOnAtom(index);
  });
  $('atom-search-id').addEventListener('keydown', event => { if (event.key === 'Enter') $('find-atom').click(); });
  $('center-atom').addEventListener('click', () => { const index = getSelectedIndex(); if (index >= 0) renderer.centerOnAtom(index); });
  for (const id of ['measure-mode', 'measure-pbc']) $(id).addEventListener('change', () => { changed(); updateMeasurements(); });
  $('clear-measurements').addEventListener('click', () => { changed(); measurements = []; updateMeasurements(); });
  $('apply-atom-style').addEventListener('click', () => {
    const frame = getFrame(), index = getSelectedIndex(); if (!frame || index < 0) return;
    try {
      const radius = number('selected-atom-radius'); changed(); const id = frame.ids[index];
      appearance.atoms = appearance.atoms.filter(entry => String(entry.id) !== String(id));
      appearance.atoms.push({ id, color: $('selected-atom-color').value, radius, visible: $('selected-atom-visible').checked }); refresh();
    } catch (error) { notify(error.message); }
  });
  $('reset-atom-style').addEventListener('click', () => { const frame = getFrame(), index = getSelectedIndex(); if (frame && index >= 0) { changed(); appearance.atoms = appearance.atoms.filter(entry => String(entry.id) !== String(frame.ids[index])); refresh(); } });
  for (const id of ['compare-view', 'compare-preset']) $(id).addEventListener('change', () => {
    const view = $('compare-preset').value;
    changed(); syncComparison();
    if (comparison && $('compare-view').checked && view !== 'custom'
      && (id === 'compare-preset' || cameraViewPreset(comparison) !== view)) { comparison.setView(view); syncComparisonToolbar(); }
  });
  $('export-jpg').addEventListener('click', () => { if (getFrame()) renderer.exportJpg(`${getFileStem()}-frame-${getFrameIndex() + 1}.jpg`, getExportOptions()); });
  $('export-atom-indices').addEventListener('click', () => {
    const frame = getFrame(); if (!frame) return;
    const ids = Array.from(frame.ids).filter((_, index) => renderer.isAnyReplicaVisible(index));
    downloadBlob(new Blob([ids.join('\n') + '\n'], { type: 'text/plain' }), `${getFileStem()}-visible-atom-ids.txt`);
  });
  $('export-frame-series').addEventListener('click', () => void exportSeries().catch(error => notify(error.message)));
  $('cancel-frame-series').addEventListener('click', () => cancelBatch());
  $('export-multiview').addEventListener('click', () => void exportViews().catch(error => notify(error.message)));

  loadVectorEditor(); syncVectorSourceUi();

  return { onFrame, reset, abortJobs, cancel, run, selected, customizePalette, filterVisibility, applyRadii,
    getBondParameters: () => getFrame() ? readParameters('bonds', getFrame()) : null,
    isEnabled: kind => Boolean(jobs[kind]?.enabled),
    updateStatistics, updateVectors, renameProperty, cancelVectorDependency, runDisplacement, cancelDisplacement, updateMeasurements, syncComparison, serialize, restore, setEnabled, cancelBatch,
    refreshProperties: () => { const frame = getFrame(); if (frame) configureSelectors(frame); updateVectors(); updateMeasurements(); },
    refresh: () => { updateStatistics(); updateMeasurements(); applyRadii(); },
    deactivate: name => { if (name === 'statistics') cancel('rdf'); else if (name === 'displacement') cancelDisplacement(); else if (name === 'vectors') { for (const field of vectorFields) field.enabled = false; $('show-vectors').checked = false; updateVectors(); } else if (JOBS[name]) cancel(name); },
    failed: () => [...Object.entries(JOBS).filter(([, { prefix }]) => $(`${prefix}-state`).textContent === 'Failed').map(([kind]) => kind), ...($('displacement-state').textContent === 'Failed' ? ['displacement'] : [])],
    pendingColorProperties: () => [...Object.entries(JOBS).flatMap(([kind, { prefix, property }]) =>
      jobs[kind].enabled && property && $(`${prefix}-state`).textContent !== 'Failed'
        ? (kind === 'referenceStrain' ? REFERENCE_STRAIN_FIELDS : [property]).map(name => ({
          name, label: name === 'bondCoordination' ? 'Coordination (bond cutoffs)' : name,
        })) : []), ...(displacement.enabled && getFrame() && $('displacement-state').textContent !== 'Failed' ? Object.entries(vectorPropertyNames('displacement')).map(([component, name]) => ({
          name, label: `Displacement ${component === 'magnitude' ? 'magnitude' : component.toUpperCase()}`,
        })) : [])],
  };
}

function cameraSnapshot(renderer) {
  return Object.fromEntries(['yaw', 'pitch', 'roll', 'fov', 'constrainUp', 'distance', 'orthographicScale', 'projectionMode', 'target', 'pan'].map(name => [name, Array.isArray(renderer[name]) ? [...renderer[name]] : renderer[name]]));
}
function restoreCamera(renderer, camera) { Object.assign(renderer, camera); renderer.setProjection(camera.projectionMode); renderer.requestRender(); }
