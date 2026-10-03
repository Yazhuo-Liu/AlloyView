import { applyAppearance, hexColor, rgbHex } from './appearance.js';
import { radiusForElement } from './render/atomic-radii.js';
import { colorsByType } from './render/palette.js';
import { WebGLRenderer } from './render/webgl-renderer.js';
import { replaceAnalysisProperty, clearAnalysisResults } from './analysis/results.js';
import { createReferenceMappingAsync, REFERENCE_STRAIN_FIELDS } from './analysis/reference-strain.js';
import { measureAtoms } from './measurements.js';
import { createImageArchive, downloadBlob } from './export-archive.js';
import { imageToEps } from './export-eps.js';

const JOBS = {
  bonds: { prefix: 'bonds', tool: 'bonds', property: 'bondCoordination' },
  rdf: { prefix: 'rdf', tool: 'statistics' },
  referenceStrain: { prefix: 'reference-strain', tool: 'referenceStrain', property: 'referenceShearStrain' },
  localShear: { prefix: 'local-shear', tool: 'localShear', property: 'localShear' },
};
const $ = id => document.getElementById(id);
const number = id => {
  const value = $(id).valueAsNumber;
  if (!Number.isFinite(value) || value <= 0) throw new Error('Enter a positive, finite value.');
  return value;
};
const canvasBlob = (canvas, type = 'image/png') => new Promise((resolve, reject) => canvas.toBlob(
  blob => blob ? resolve(blob) : reject(new Error('Could not encode the image.')), type, 0.94));

/** All numerical jobs share the existing analysis pool. This controller owns
 * display-only settings and invalidates pending results on source/frame edits. */
export function initializeAtomEyeTools({ renderer, pool, tools, getFrame, getFrameAt,
  getFrameIndex, getFrameCount, getFrames, getSourceVersion, getSelectedIndex,
  selectAtom, refresh, chooseProperty, getColorMode, getColorChoiceVersion = () => 0, getExportOptions, showFrame,
  stopPlayback, getFileStem, notify = () => {}, onEdit = () => {}, onMemoryChange = () => {} }) {
  const jobs = Object.fromEntries(Object.keys(JOBS).map(kind => [kind, { enabled: false, parameters: null, controller: null, request: 0 }]));
  let generation = 0, measurements = [], appearance = { elements: [], atoms: [] };
  let pairCutoffs = [], currentFrame = null, comparison = null, comparisonContainer = null;
  let colors = null, batch = null, restoring = false;

  function changed() { if (!restoring) { cancelBatch({ restore: false }); onEdit(); } }
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
  }
  function cancel(kind, { redraw = true } = {}) {
    const job = jobs[kind];
    if (!job) return;
    job.request++; job.enabled = false; job.controller?.abort(); job.controller = null;
    tools.setToolEnabled(JOBS[kind].tool, false);
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
      const key = JSON.stringify(parameters);
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
          const result = await pool.analyze(frame, input, { signal: controller.signal, onProgress: progress => {
            if (!current()) return;
            const { phase, prepared = 0, completed = 0, workerCount = 1, completedAtoms, totalAtoms } = progress;
            $(`${JOBS[kind].prefix}-status`).textContent = phase === 'preparing'
              ? `Preparing inputs… ${prepared} / ${workerCount} Workers`
              : phase === 'queued' ? 'Waiting for available analysis Workers…'
                : `Frame ${getFrameIndex() + 1} · ${workerCount} Workers · ${completed} complete${totalAtoms ? ` · ${completedAtoms ?? 0} / ${totalAtoms} atoms` : ''}`;
          } });
          if (!current()) return;
          cached = { key, result };
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
        stateFor(kind, 'Calculated', `${kind === 'bonds' ? `${result.count.toLocaleString()} bonds · ` : ''}${(result.elapsedMs / 1000).toFixed(2)} s · ${result.engine}`);
        onMemoryChange(frame); updateStatistics(); syncComparison();
      } catch (error) {
        if (current() && error.name !== 'AbortError') { stateFor(kind, 'Failed', error.message); notify(error.message); }
      } finally {
        if (job.controller === controller) job.controller = null;
      }
    } catch (error) { notify(error.message); }
  }

  function option(value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; }
  function configureSelectors(frame) {
    const numeric = frame.properties.filter(property => !property.categories).map(property => property.name);
    for (const [axis, component] of ['x', 'y', 'z'].entries()) {
      const select = $(`vector-${component}`), previous = select.value;
      select.replaceChildren(option('', 'Choose component'), ...numeric.map(name => option(name, name)));
      select.value = numeric.includes(previous) ? previous : '';
      if (!select.value) {
        const matched = numeric.find(name => new RegExp(`^(force|forces|velocity|velocities|displacement|displacements|f|v|u)[._]?(${component}|${axis})$`, 'i').test(name));
        if (matched) select.value = matched;
      }
    }
    for (const id of ['rdf-first-type', 'rdf-second-type']) {
      const select = $(id), previous = select.value;
      select.replaceChildren(option('', 'All elements'), ...frame.typeLabels.map(label => option(label, label)));
      select.value = frame.typeLabels.includes(previous) ? previous : '';
    }
    $('reference-frame').max = String(getFrameCount());
    if (Number($('reference-frame').value) > getFrameCount()) $('reference-frame').value = '1';
    $('export-series-first').max = $('export-series-last').max = String(getFrameCount());
  }
  function updateVectors() {
    const frame = getFrame();
    if (!frame || !$('show-vectors').checked) { renderer.setVectors(null); comparison?.setVectors(null); tools.setToolEnabled('vectors', false); return; }
    try {
      const properties = ['x', 'y', 'z'].map(axis => frame.properties.find(property => property.name === $(`vector-${axis}`).value));
      if (properties.some(property => !property || property.categories)) throw new Error('Choose three numeric vector components.');
      const vectors = new Float32Array(frame.ids.length * 3);
      for (let atom = 0; atom < frame.ids.length; atom++) for (let axis = 0; axis < 3; axis++) vectors[atom * 3 + axis] = properties[axis].data[atom];
      renderer.setVectors(vectors, { scale: number('vector-scale'), color: $('vector-color').value });
      tools.setToolEnabled('vectors', true); syncComparison();
    } catch (error) { renderer.setVectors(null); comparison?.setVectors(null); notify(error.message); }
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
      if (indices.length >= 2) rows.push(`Distance: ${result.distance.toPrecision(7)} Å`);
      if (indices.length >= 3) rows.push(`Angle: ${result.angle.toPrecision(7)}°`);
      if (indices.length >= 4) rows.push(`Dihedral: ${result.dihedral.toPrecision(7)}°`);
      for (const row of rows) { const item = document.createElement('p'); item.textContent = row; container.append(item); }
    } catch (error) { container.textContent = error.message; }
  }
  function customizePalette(palette) {
    const frame = getFrame();
    if (!frame) return palette;
    const result = applyAppearance(frame, palette.colors, null, appearance, { elementColors: getColorMode() === 'type' });
    if (getColorMode() === 'type') palette.legend.items = palette.legend.items.map(item => ({ ...item,
      color: appearance.elements.find(entry => entry.label === item.label)?.color ? hexColor(appearance.elements.find(entry => entry.label === item.label).color) : item.color }));
    colors = result.colors;
    return { ...palette, colors: result.colors };
  }
  function filterVisibility(mask) {
    const frame = getFrame(); if (!frame) return mask;
    return applyAppearance(frame, colors ?? colorsByType(frame).colors, mask, appearance, { elementColors: false }).visibility;
  }
  function applyRadii() {
    const frame = getFrame(); if (!frame) return;
    renderer.setAtomRadii(applyAppearance(frame, colors ?? colorsByType(frame).colors, null, appearance).radii);
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
      label.className = 'comparison-label'; close.className = 'comparison-close'; close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close comparison view');
      close.addEventListener('click', () => { $('compare-view').checked = false; changed(); syncComparison(); });
      comparisonContainer.append(canvas, label, close); renderer.canvas.parentElement.append(comparisonContainer);
      comparison = new WebGLRenderer(canvas, { onPick: index => selectAtom(index) });
    }
    comparisonContainer.hidden = false;
    comparisonContainer.querySelector('.comparison-label').textContent = $('compare-preset').value;
    if (comparison.frame !== frame) {
      comparison.setFrame(frame, colors ?? colorsByType(frame).colors, renderer.displayPositions, renderer.atomRadii, renderer.repetitions);
      comparison.resetCamera(); comparison.setView($('compare-preset').value);
    } else {
      comparison.setColors(colors ?? colorsByType(frame).colors); comparison.setAtomRadii(renderer.atomRadii);
      if (comparison.displayPositions !== renderer.displayPositions) comparison.setDisplayPositions(renderer.displayPositions);
      if (comparison.repetitions.some((value, axis) => value !== renderer.repetitions[axis])) comparison.setReplications(renderer.repetitions);
    }
    comparison.setVisibility(renderer.visibility);
    if (renderer.sliceMode === 'legacy') comparison.setSlice(renderer.sliceAxis, renderer.sliceMaximum);
    else comparison.setSlices(renderer.slices);
    comparison.setBackground(rgbHex(renderer.background.map(value => value * 255)));
    comparison.setCellVisible(renderer.cellVisible); comparison.setRadiusScale(renderer.radiusScale);
    const bond = frame.atomeyeResults?.bonds;
    comparison.setBonds(jobs.bonds.enabled && bond?.key === JSON.stringify(jobs.bonds.parameters) ? bond.result : null,
      { visible: $('show-bonds').checked, radius: number('bonds-radius') });
    comparison.setVectors(renderer.atomVectors ?? null, renderer.vectorOptions);
  }
  async function onFrame({ suggestedCutoff } = {}) {
    abortJobs(); currentFrame = getFrame();
    if (!currentFrame) return;
    for (const id of ['bonds-cutoff', 'reference-cutoff', 'local-shear-cutoff', 'rdf-cutoff']) if (!$(id).value || (!jobs[({ 'bonds-cutoff': 'bonds', 'reference-cutoff': 'referenceStrain', 'local-shear-cutoff': 'localShear', 'rdf-cutoff': 'rdf' })[id]].enabled && suggestedCutoff)) $(id).value = String(suggestedCutoff ?? 3);
    configureSelectors(currentFrame); renderPairs(currentFrame); renderElements(currentFrame); applyRadii(); updateMeasurements(); updateVectors(); updateStatistics();
    renderer.setBonds(null);
    await Promise.all(Object.keys(jobs).map(kind => jobs[kind].enabled ? run(kind, { automatic: true }) : stateFor(kind, 'Not calculated')));
    syncComparison();
  }
  function reset() {
    generation++; abortJobs(); cancelBatch({ restore: false });
    for (const kind of Object.keys(jobs)) { cancel(kind, { redraw: false }); jobs[kind].parameters = null; }
    measurements = []; appearance = { elements: [], atoms: [] }; pairCutoffs = []; currentFrame = null; colors = null;
    $('show-vectors').checked = $('measure-mode').checked = $('compare-view').checked = false;
    $('show-bonds').checked = true;
    $('element-style-controls').replaceChildren(); $('bond-pair-cutoffs').replaceChildren(); $('rdf-chart').replaceChildren();
    $('export-series-first').value = '1'; $('export-series-last').value = String(getFrameCount() || 1);
    renderer.setBonds(null); renderer.setVectors(null); renderer.setSelectedAtoms([]);
    comparison?.clearFrame(); if (comparisonContainer) comparisonContainer.hidden = true;
    updateMeasurements();
  }
  function serialize() {
    const frame = getFrame();
    const cutoff = id => Number.isFinite($(id).valueAsNumber) && $(id).valueAsNumber > 0 ? $(id).valueAsNumber : null;
    return {
      bonds: { enabled: jobs.bonds.enabled, cutoff: cutoff('bonds-cutoff'), pairCutoffs: pairCutoffs.map(entry => ({ ...entry })), radius: number('bonds-radius'), visible: $('show-bonds').checked },
      vectors: { enabled: $('show-vectors').checked, components: ['x', 'y', 'z'].map(axis => $(`vector-${axis}`).value || null), scale: number('vector-scale'), color: $('vector-color').value },
      referenceStrain: { enabled: jobs.referenceStrain.enabled, frameIndex: Math.max(0, Number($('reference-frame').value) - 1), cutoff: cutoff('reference-cutoff') },
      localShear: { enabled: jobs.localShear.enabled, cutoff: cutoff('local-shear-cutoff'), subtractMean: $('local-shear-subtract-mean').checked },
      rdf: { enabled: jobs.rdf.enabled, cutoff: cutoff('rdf-cutoff'), bins: Number($('rdf-bins').value), firstType: $('rdf-first-type').value || null, secondType: $('rdf-second-type').value || null },
      measurements: { enabled: $('measure-mode').checked, minimumImage: $('measure-pbc').checked, atomIds: [...measurements] },
      appearance: { elements: appearance.elements.map(entry => ({ ...entry })), atoms: appearance.atoms.map(entry => ({ ...entry })) },
      comparison: { enabled: $('compare-view').checked && Boolean(frame), preset: $('compare-preset').value },
    };
  }
  async function restore(saved) {
    if (!saved) return;
    restoring = true;
    try {
      reset(); appearance = saved.appearance; pairCutoffs = saved.bonds.pairCutoffs.map(entry => ({ ...entry }));
      for (const [id, value] of [['bonds-cutoff', saved.bonds.cutoff], ['bonds-radius', saved.bonds.radius], ['reference-frame', saved.referenceStrain.frameIndex + 1],
        ['reference-cutoff', saved.referenceStrain.cutoff], ['local-shear-cutoff', saved.localShear.cutoff], ['rdf-cutoff', saved.rdf.cutoff], ['rdf-bins', saved.rdf.bins],
        ['vector-scale', saved.vectors.scale], ['vector-color', saved.vectors.color], ['compare-preset', saved.comparison.preset]]) if (value !== null) $(id).value = String(value);
      for (const kind of Object.keys(jobs)) {
        jobs[kind].enabled = Boolean(getFrame()) && saved[kind].enabled;
        jobs[kind].parameters = kind === 'bonds' ? { cutoff: saved.bonds.cutoff, pairCutoffs: saved.bonds.pairCutoffs.map(entry => ({ first: getFrame()?.typeLabels.indexOf(entry.first), second: getFrame()?.typeLabels.indexOf(entry.second), cutoff: entry.cutoff })).filter(entry => entry.first >= 0 && entry.second >= 0) }
          : kind === 'referenceStrain' ? { frameIndex: saved[kind].frameIndex, cutoff: saved[kind].cutoff }
            : kind === 'localShear' ? { cutoff: saved[kind].cutoff, subtractMean: saved[kind].subtractMean }
              : { cutoff: saved[kind].cutoff, bins: saved[kind].bins, firstType: saved[kind].firstType, secondType: saved[kind].secondType };
        tools.setToolEnabled(JOBS[kind].tool, jobs[kind].enabled);
      }
      $('local-shear-subtract-mean').checked = saved.localShear.subtractMean;
      $('show-bonds').checked = saved.bonds.visible;
      $('show-vectors').checked = saved.vectors.enabled; $('measure-mode').checked = saved.measurements.enabled;
      $('measure-pbc').checked = saved.measurements.minimumImage; measurements = [...saved.measurements.atomIds];
      $('compare-view').checked = saved.comparison.enabled;
      if (getFrame()) {
        configureSelectors(getFrame());
        for (const [axis, name] of saved.vectors.components.entries()) $(`vector-${'xyz'[axis]}`).value = name ?? '';
        $('rdf-first-type').value = saved.rdf.firstType ?? ''; $('rdf-second-type').value = saved.rdf.secondType ?? '';
        await onFrame(); refresh();
      }
    } finally { restoring = false; }
  }
  function setEnabled(enabled) {
    for (const panel of document.querySelectorAll('[data-tool-panel="bonds"], [data-tool-panel="vectors"], [data-tool-panel="statistics"], [data-tool-panel="referenceStrain"], [data-tool-panel="localShear"]')) for (const input of panel.querySelectorAll('input, select, button')) input.disabled = !enabled;
    for (const id of ['find-atom', 'atom-search-id', 'measure-mode', 'measure-pbc', 'clear-measurements', 'compare-view', 'compare-preset', 'export-jpg', 'export-eps', 'export-atom-indices', 'export-multiview', 'export-frame-series', 'export-series-first', 'export-series-last', 'export-series-step']) $(id).disabled = !enabled;
    updateAtomStyle();
    for (const [kind, job] of Object.entries(jobs)) $(`cancel-${JOBS[kind].prefix}`).disabled = !enabled || !job.enabled;
    $('export-rdf').disabled = !enabled || !getFrame()?.atomeyeResults?.rdf;
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
  });
  for (const id of ['show-bonds', 'bonds-radius']) $(id).addEventListener('change', () => {
    const result = getFrame()?.atomeyeResults?.bonds?.result;
    try { renderer.setBonds(result ?? null, { visible: $('show-bonds').checked, radius: number('bonds-radius') }); syncComparison(); } catch (error) { notify(error.message); }
  });
  for (const id of ['vector-x', 'vector-y', 'vector-z', 'vector-scale', 'vector-color', 'show-vectors']) $(id).addEventListener('change', () => { changed(); updateVectors(); });
  $('find-atom').addEventListener('click', () => {
    const frame = getFrame(), index = frame?.ids.findIndex(id => String(id) === $('atom-search-id').value.trim()) ?? -1;
    if (index < 0) { notify('No atom has that ID in this frame.'); return; }
    selectAtom(index); renderer.centerOnAtom(index); tools.selectTool('selection');
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
  for (const id of ['compare-view', 'compare-preset']) $(id).addEventListener('change', () => { changed(); syncComparison(); if (comparison && $('compare-view').checked) comparison.setView($('compare-preset').value); });
  $('export-rdf').addEventListener('click', () => {
    const result = getFrame()?.atomeyeResults?.rdf?.result; if (!result) return;
    const rows = ['r_A,g_r,count', ...Array.from(result.radii, (radius, index) => `${radius},${result.values[index]},${result.counts[index]}`)];
    downloadBlob(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), `${getFileStem()}-rdf.csv`);
  });
  $('export-jpg').addEventListener('click', () => { if (getFrame()) renderer.exportJpg(`${getFileStem()}-frame-${getFrameIndex() + 1}.jpg`, getExportOptions()); });
  $('export-eps').addEventListener('click', async () => {
    if (!getFrame()) return;
    const button = $('export-eps'), stem = getFileStem(), index = getFrameIndex(); button.disabled = true;
    try {
      const canvas = renderer.captureImage({ ...getExportOptions(), includeBackground: true });
      const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      downloadBlob(await imageToEps(image), `${stem}-frame-${index + 1}.eps`);
    } catch (error) { notify(error.message); }
    finally { button.disabled = !getFrame(); }
  });
  $('export-atom-indices').addEventListener('click', () => {
    const frame = getFrame(); if (!frame) return;
    const ids = Array.from(frame.ids).filter((_, index) => renderer.isAnyReplicaVisible(index));
    downloadBlob(new Blob([ids.join('\n') + '\n'], { type: 'text/plain' }), `${getFileStem()}-visible-atom-ids.txt`);
  });
  $('export-frame-series').addEventListener('click', () => void exportSeries().catch(error => notify(error.message)));
  $('cancel-frame-series').addEventListener('click', () => cancelBatch());
  $('export-multiview').addEventListener('click', () => void exportViews().catch(error => notify(error.message)));

  return { onFrame, reset, abortJobs, cancel, run, selected, customizePalette, filterVisibility, applyRadii,
    updateStatistics, updateVectors, updateMeasurements, syncComparison, serialize, restore, setEnabled, cancelBatch,
    refresh: () => { updateStatistics(); updateMeasurements(); applyRadii(); },
    deactivate: name => { if (name === 'statistics') cancel('rdf'); else if (name === 'vectors') { $('show-vectors').checked = false; updateVectors(); } else if (JOBS[name]) cancel(name); },
    failed: () => Object.entries(JOBS).filter(([, { prefix }]) => $(`${prefix}-state`).textContent === 'Failed').map(([kind]) => kind),
    pendingColorProperties: () => Object.entries(JOBS).flatMap(([kind, { prefix, property }]) =>
      jobs[kind].enabled && property && $(`${prefix}-state`).textContent !== 'Failed'
        ? (kind === 'referenceStrain' ? REFERENCE_STRAIN_FIELDS : [property]).map(name => ({
          name, label: name === 'bondCoordination' ? 'Coordination (bond cutoffs)' : name,
        })) : []),
  };
}

function cameraSnapshot(renderer) {
  return Object.fromEntries(['yaw', 'pitch', 'distance', 'orthographicScale', 'projectionMode', 'target', 'pan'].map(name => [name, Array.isArray(renderer[name]) ? [...renderer[name]] : renderer[name]]));
}
function restoreCamera(renderer, camera) { Object.assign(renderer, camera); renderer.setProjection(camera.projectionMode); renderer.requestRender(); }
