import { frameTypeOrder } from '../../data/frame-summary.js';
import { ELEMENT_LATTICES, STRAIN_STRUCTURES, referenceForElement } from '../../analysis/lattice.js';
import { estimateLatticeReferences } from '../../analysis/lattice-estimate.js';
import { PTM_TYPES, retainPtmNeighborLists } from '../../analysis/ptm.js';
import { formatInteger, option } from '../shell/format.js';

/** The per-element lattice references used by atomic strain: the editable
 * rows under the Strain panel, and estimation of missing values from a PTM
 * fit of the current frame. The controller owns the reference list; the
 * application reads it for analysis parameters and configurations. */
export function createLatticeReferenceControls({ elements, pool,
  getFrame, getFrameIndex, getSourceVersion, isSourceLoading, isStrainEnabled,
  runStrain, storePtmResult, reassessFrameCache, formatProgress, notify }) {
  let references = [];
  let referenceLabels = [];
  const referenceByLabel = new Map();
  let latticeEstimateRequest = 0;
  let estimateController = null;

  const LATTICE_ESTIMATE_HELP = 'Missing references can be estimated from PTM geometry. Existing values are kept. Estimates include the current frame’s bulk strain; edit them to use a known stress-free lattice.';

  function missingReferenceTypes(frame = getFrame()) {
    if (!frame) return [];
    return frameTypeOrder(frame).filter(type => {
      const reference = references[type];
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
    estimateController?.abort();
    estimateController = null;
    elements['lattice-estimate'].disabled = !getFrame() || isSourceLoading();
    elements['lattice-estimate-cancel'].disabled = true;
    elements['lattice-estimate-cancel'].hidden = true;
    elements['lattice-estimate-status'].textContent = message;
  }

  async function estimateMissingReferences({ frame = getFrame(), forStrain = false } = {}) {
    if (!frame) return false;
    const missing = missingReferenceTypes(frame);
    if (!missing.length) {
      elements['lattice-estimate-status'].textContent = 'Existing reference values kept. Clear a lattice value to estimate it from this structure.';
      return true;
    }
    cancelLatticeEstimation();
    const request = latticeEstimateRequest;
    const sourceVersion = getSourceVersion();
    const controller = new AbortController();
    estimateController = controller;
    const isCurrent = () => request === latticeEstimateRequest && !controller.signal.aborted
      && frame === getFrame() && sourceVersion === getSourceVersion();
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
        const result = await pool.analyze(frame, { kind: 'ptm', ...parameters,
          neighborLists: retainPtmNeighborLists(frame) }, {
          frameIndex: getFrameIndex(), signal: controller.signal,
          onProgress: progress => progressText(formatProgress(progress, 'ptm')),
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
        const reference = references[type] ?? referenceForElement(frame.typeLabels[type]);
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
        references[type] = reference;
        details.push(`${label}: ${PTM_TYPES.find(item => item.id === reference.structure).label}, a = ${reference.a.toFixed(6)} Å${[2, 7].includes(reference.structure) && Number.isFinite(reference.c) ? `, c = ${reference.c.toFixed(6)} Å` : ''}`);
      }
      renderLatticeReferences(frame);
      elements['lattice-estimate-status'].textContent = `${details.join('; ')}. Estimated from the current frame; existing values kept.`;
      if (!forStrain && isStrainEnabled()) void runStrain();
      return true;
    } catch (error) {
      if (!isCurrent() || error.name === 'AbortError') return false;
      progressText(error.message);
      if (!forStrain) notify(error.message);
      return false;
    } finally {
      if (request === latticeEstimateRequest) {
        estimateController = null;
        elements['lattice-estimate'].disabled = !getFrame() || isSourceLoading();
        elements['lattice-estimate-cancel'].disabled = true;
        elements['lattice-estimate-cancel'].hidden = true;
      }
    }
  }

  function renderLatticeReferences(frame = getFrame()) {
    if (!frame) return;
    if (referenceLabels.join('\0') !== frame.typeLabels.join('\0')) {
      referenceLabels = [...frame.typeLabels];
      references = frame.typeLabels.map(label => referenceByLabel.get(label) ?? referenceForElement(label));
    }
    elements['lattice-references'].replaceChildren();
    references.forEach((reference, type) => {
      const label = frame.typeLabels[type];
      referenceByLabel.set(label, reference);
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
          if (isStrainEnabled()) runStrain();
        });
        return input;
      };
      const a = number('a'), c = number('c');
      const cField = field('c (Å)', c);
      cField.hidden = ![2, 7].includes(reference.structure);
      row.append(field(`${label} · Element`, element), field('Reference crystal', structure), field('a (Å)', a), cField);
      element.addEventListener('change', () => {
        cancelLatticeEstimation();
        references[type] = referenceForElement(element.value);
        renderLatticeReferences(frame);
        if (isStrainEnabled()) runStrain();
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
        if (isStrainEnabled()) runStrain();
      });
      elements['lattice-references'].append(row);
    });
  }

  /** References for a freshly loaded frame: one default per type label. */
  function resetFor(frame) {
    references = frame.typeLabels.map(referenceForElement);
    referenceLabels = [...frame.typeLabels];
    referenceByLabel.clear();
    renderLatticeReferences(frame);
  }

  /** The Reset button: tabulated values for each row's element, or its type label. */
  function resetToElements() {
    cancelLatticeEstimation();
    const frame = getFrame();
    references = references.map((reference, type) => referenceForElement(reference.element || frame.typeLabels[type]));
    renderLatticeReferences();
  }

  /** Saved references, already matched to the frame's type labels by the caller. */
  function restore(saved) {
    references = saved;
    const frame = getFrame();
    referenceLabels = frame ? [...frame.typeLabels] : [];
    referenceByLabel.clear();
    renderLatticeReferences();
  }

  function clear() {
    references = [];
    referenceLabels = [];
    referenceByLabel.clear();
    elements['lattice-references'].replaceChildren();
  }

  return {
    render: renderLatticeReferences, resetFor, resetToElements, restore, clear,
    getReferences: () => references,
    serialize: () => references.map((reference, type) => ({ ...reference, label: referenceLabels[type] })),
    missingTypes: missingReferenceTypes, compatiblePtm,
    estimateMissing: estimateMissingReferences, cancelEstimation: cancelLatticeEstimation,
    isEstimating: () => estimateController !== null,
  };
}
