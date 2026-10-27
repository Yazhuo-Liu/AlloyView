import { discreteValues } from '../../render/discrete-colors.js';
import { drawIpfKey, normalizeOrientationSettings } from '../../render/orientation-colors.js';
import { colorsByProperty, coupleScalarRange, SCALAR_COLOR_SCHEMES } from '../../render/palette.js';
import { createLegendScale, updateLegendScale } from '../../render/legend-histogram.js';
import { createLegendRangeSlider } from '../../render/legend-range-slider.js';
import { selectionGroupVisibility } from '../../data/selection-groups.js';
import { isCrystalStructureProperty } from '../../data/structure-properties.js';
import { formatInteger, formatValue, option } from '../shell/format.js';

/** The color legend beside the viewport: category checkboxes, the scalar
 * range editor with its live preview, the color-map and range-policy
 * selectors, and orientation keys. A legend view is rebuilt only when its
 * schema changes; otherwise the existing controls refresh in place so focus
 * and keyboard navigation survive frame changes.
 *
 * The panel owns the displayed legend (`currentLegend`) and any uncommitted
 * slider edit (`commitPendingEdit`). Color preferences (ranges, schemes,
 * hide-outside flags, discrete modes, hidden atom types) are the shared Maps
 * and Sets the application serializes into configurations. */
export function createLegendPanel({ elements, renderer, displayRefresh,
  scalarColorRanges, scalarColorSchemes, scalarHideOutside, scalarColorModes, hiddenAtomTypes,
  getFrame, getColorMode, getSelectionGroups, getDisplayCompletion, getCrystalVisibility, getAtomEyeTools,
  getOrientationSettings, setOrientationSettings, hiddenCategoriesFor, currentPalette,
  applyColors, applyScalarVisibility, refreshSelectionPanel, chooseColorMode, onEdit, notify }) {
  let legendView = null;
  const previewLegendControls = new Map();
  let currentColorLegend = null;
  let commitScalarLegendEdit = null;

  function renderLegend(legend) {
    for (const [control, disabled] of previewLegendControls) control.disabled = disabled;
    previewLegendControls.clear();
    const held = renderer.presentationPending && getDisplayCompletion()?.retainedLegend;
    if (!held) renderLegendContents(legend);
    if (held || legend.preview) {
      for (const control of elements['color-legend'].querySelectorAll('input, select, button')) {
        if (control.id === 'legend-color-mode') continue;
        previewLegendControls.set(control, control.disabled);
        control.disabled = true;
      }
    }
  }

  function renderLegendContents(legend) {
    currentColorLegend = legend;
    getCrystalVisibility()?.refresh();
    const eligible = legend.property && (!legend.property.categories || legend.discrete)
      ? discreteValues(legend.discrete ? { ...legend.property, categories: undefined } : legend.property) : null;
    const scaleModeVisible = Boolean(eligible || legend.property && scalarColorModes.get(legend.property.name) === 'discrete');
    const schema = JSON.stringify([getColorMode(), legend.kind, legend.property?.name, Boolean(legend.atomTypes), Boolean(legend.discrete),
      Boolean(legend.emptyRange), Boolean(legend.unit), scaleModeVisible,
      legend.items?.map(item => [item.id, item.label]), legend.mode, legend.source,
      legend.kind === 'orientation' && getOrientationSettings().direction === 'custom', legend.keys?.map(key => [key.title, key.labels])]);
    if (legendView?.schema === schema && legendView.root === elements['color-legend']) {
      legendView.refresh(legend, eligible);
      elements.legend.hidden = false;
      return;
    }
    commitScalarLegendEdit = null;
    // Color by is shared across schemas, so choosing a different quantity does
    // not detach its own focused select or interrupt keyboard navigation.
    const retainedPropertyControl = legendView?.propertyControl?.isConnected ? legendView.propertyControl : null;
    const view = legendView = { schema, root: elements['color-legend'], frame: getFrame() };
    const refreshers = [];
    view.refresh = (next, nextEligible = eligible) => {
      legend = next; view.frame = getFrame();
      for (const refresh of refreshers) refresh(nextEligible);
    };
    const isCurrent = () => legendView === view && getFrame() === view.frame && Boolean(getFrame());
    for (const child of [...elements['color-legend'].childNodes]) if (child !== retainedPropertyControl) child.remove();
    const propertyControl = view.propertyControl = retainedPropertyControl ?? document.createElement('label');
    propertyControl.className = 'legend-property';
    const propertyLabel = retainedPropertyControl?.querySelector('span') ?? document.createElement('span');
    propertyLabel.textContent = 'Color by';
    const propertySelect = retainedPropertyControl?.querySelector('select') ?? document.createElement('select');
    propertySelect.id = 'legend-color-mode';
    const refreshPropertyOptions = () => {
      const existing = new Map([...propertySelect.options].map(item => [item.value, item]));
      for (let index = 0; index < elements['color-mode'].options.length; index++) {
        const sourceOption = elements['color-mode'].options[index];
        const item = existing.get(sourceOption.value) ?? option(sourceOption.value, sourceOption.textContent);
        existing.delete(sourceOption.value);
        if (item.textContent !== sourceOption.textContent) item.textContent = sourceOption.textContent;
        item.disabled = sourceOption.disabled;
        if (propertySelect.options[index] !== item) propertySelect.insertBefore(item, propertySelect.options[index] ?? null);
      }
      for (const item of existing.values()) item.remove();
      propertySelect.value = getColorMode();
      propertySelect.title = propertySelect.selectedOptions[0]?.textContent ?? 'Choose the coloring quantity';
    };
    refreshers.push(refreshPropertyOptions); refreshPropertyOptions();
    if (!retainedPropertyControl) {
      propertySelect.addEventListener('change', () => {
        if (propertySelect.isConnected && getFrame()) chooseColorMode(propertySelect.value);
      });
      propertyControl.append(propertyLabel, propertySelect);
      elements['color-legend'].append(propertyControl);
    }
    const title = document.createElement('div');
    title.className = 'legend-title';
    const label = document.createElement('strong');
    label.textContent = legend.title;
    title.append(label);
    refreshers.push(() => { label.textContent = legend.title; });
    if ((legend.kind === 'scalar' || legend.discrete) && legend.unit) {
      const unit = document.createElement('span');
      unit.textContent = legend.unit;
      title.append(unit);
      refreshers.push(() => { unit.textContent = legend.unit; });
    }
    elements['color-legend'].append(title);
    if (legend.kind === 'orientation') {
      refreshers.push(renderOrientationLegend(() => legend, isCurrent));
      elements.legend.hidden = false;
      return;
    }
    if ((legend.property && !legend.property.categories) || legend.discrete) {
      if (scaleModeVisible) {
        const control = document.createElement('label');
        control.className = 'legend-property';
        const caption = document.createElement('span'); caption.textContent = 'Color scale';
        const select = document.createElement('select'); select.id = 'legend-scale-mode';
        select.append(option('continuous', 'Continuous'), option('discrete', `Discrete integer values (up to 32)`));
        select.value = legend.discrete ? 'discrete' : 'continuous';
        select.options[1].disabled = !eligible;
        if (!eligible) select.title = 'This frame needs 1–32 distinct safe integer values for discrete colors.';
        refreshers.push(nextEligible => {
          select.value = legend.discrete ? 'discrete' : 'continuous';
          select.options[1].disabled = !nextEligible;
          select.title = nextEligible ? '' : 'This frame needs 1–32 distinct safe integer values for discrete colors.';
        });
        select.addEventListener('change', () => {
          if (!isCurrent()) return;
          onEdit('a color scale change');
          scalarColorModes.set(legend.property.name, select.value);
          applyColors(); refreshSelectionPanel();
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
        else if (isCrystalStructureProperty(legend.property.name)) checkbox.dataset.structureType = String(item.id);
        checkbox.setAttribute('aria-label', `Show ${item.label} atoms`);
        row.title = item.description ?? `Show or hide ${item.label} atoms`;
        row.classList.toggle('is-hidden', !item.visible);
        checkbox.addEventListener('change', () => {
          if (!isCurrent()) return;
          onEdit('a category visibility change');
          const key = legend.atomTypes ? item.label : item.id;
          if (checkbox.checked) hidden.delete(key);
          else hidden.add(key);
          row.classList.toggle('is-hidden', !checkbox.checked);
          // Visibility edits keep the displayed legend; recoloring every atom is unnecessary.
          applyScalarVisibility(currentColorLegend ?? currentPalette().legend);
          getAtomEyeTools().syncComparison();
        });
        row.append(checkbox);
        row.append(swatch, document.createTextNode(item.label));
        const count = document.createElement('span');
        count.className = 'legend-count';
        count.textContent = `${formatInteger(item.count)} · ${(legend.atomCount ? 100 * item.count / legend.atomCount : 0).toFixed(1)}%`;
        row.append(count);
        items.append(row);
        controls.push({ checkbox, row, swatch, count, key: legend.atomTypes ? item.label : item.id });
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
          if (!isCurrent()) return;
          onEdit('a category visibility change');
          for (const { checkbox, row, key } of controls) {
            if (checked) hidden.delete(key);
            else hidden.add(key);
            checkbox.checked = checked;
            row.classList.toggle('is-hidden', !checked);
          }
          // Visibility edits keep the displayed legend; recoloring every atom is unnecessary.
          applyScalarVisibility(currentColorLegend ?? currentPalette().legend);
          getAtomEyeTools().syncComparison();
        });
        actions.append(button);
      }
      refreshers.push(() => {
        controls.forEach(({ checkbox, row, swatch, count }, index) => {
          const item = legend.items[index];
          checkbox.checked = item.visible;
          row.classList.toggle('is-hidden', !item.visible);
          row.title = item.description ?? `Show or hide ${item.label} atoms`;
          swatch.style.background = `rgb(${item.color.join(' ')})`;
          count.textContent = `${formatInteger(item.count)} · ${(legend.atomCount ? 100 * item.count / legend.atomCount : 0).toFixed(1)}%`;
        });
        for (const button of actions.children) button.setAttribute('aria-label',
          `${button.dataset.legendAction === 'select-all' ? 'Show' : 'Hide'} every ${legend.title} category`);
      });
      elements['color-legend'].append(actions, items);
    } else {
      const scale = createLegendScale(document, legend, { format: formatValue });
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
      const rangePolicyControl = document.createElement('label');
      rangePolicyControl.className = 'legend-scheme';
      const rangePolicyLabel = document.createElement('span'); rangePolicyLabel.textContent = 'Range across frames';
      const rangePolicy = document.createElement('select'); rangePolicy.id = 'legend-range-policy';
      rangePolicy.append(option('frame', 'Fit each frame'), option('fixed', 'Keep fixed range'));
      rangePolicyControl.append(rangePolicyLabel, rangePolicy);
      let step = scalarLegendStep(legend);
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
        rangePolicy.value = enabled ? 'frame' : 'fixed';
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
        if (!isCurrent() || !rangeSlider.element.isConnected || !limits) return;
        previewActive = false;
        commitScalarLegendEdit = null;
        applyRange(limits);
      };
      const rangeSlider = createLegendRangeSlider(document, {
        minimum: legend.minimum, maximum: editableMaximum, dataMinimum: legend.dataMinimum, dataMaximum: legend.dataMaximum,
        step, format: formatValue,
        onInput: (requested, changed) => {
          if (!isCurrent()) return;
          onEdit('a color range edit');
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
              if (pending && isCurrent() && rangeSlider.element.isConnected) previewRange(pending);
            });
          }
          pendingSliderRange = limits;
        },
        onCommit: (limits) => finishSliderPreview(limits),
      });
      controls.append(schemeControl, rangePolicyControl, rangeSlider.element, minimumControl.label, maximumControl.label, visibility, actions);
      const freezeCurrentRange = () => {
        const limits = scalarColorRanges.get(legend.property.name)
          ?? { minimum: legend.minimum, maximum: legend.maximum > legend.minimum ? legend.maximum : legend.minimum + step };
        scalarColorRanges.set(legend.property.name, limits);
        return limits;
      };
      const applyRange = (limits) => {
        if (!isCurrent()) return;
        pendingSliderRange = null;
        previewActive = false;
        commitScalarLegendEdit = null;
        const palette = getAtomEyeTools().customizePalette(colorsByProperty(legend.property, limits, legend.scheme,
          hiddenCategoriesFor(legend.property.name), selectionGroupVisibility(getFrame(), getSelectionGroups())));
        scalarColorRanges.set(legend.property.name, limits);
        scalarHideOutside.set(legend.property.name, visibilityCheckbox.checked);
        renderer.setColors(palette.colors);
        applyScalarVisibility(palette.legend);
        getAtomEyeTools().syncComparison();
        // The histogram and hover probe describe the displayed range.
        legend = palette.legend;
        updateLegendScale(scale, legend, { histogram: true });
        minimum.textContent = formatValue(limits.minimum);
        maximum.textContent = formatValue(limits.maximum);
        syncAutomatic();
        displayRefresh.flush();
      };
      const previewRange = (limits) => {
        if (!isCurrent()) return;
        const previewLegend = { ...legend, ...limits, customRange: true };
        if (!previewActive || !renderer.scalarColorPreview) {
          const overrides = getAtomEyeTools().customizePalette({ colors: renderer.atomColors, legend }, { trackColorOverrides: true }).colorOverrides;
          // Preserve element, structure, appearance and selection filters once;
          // the moving scalar range is evaluated by both atom and bond shaders.
          applyScalarVisibility(previewLegend, { includeScalarRange: false });
          const preview = renderer.setScalarColorPreview(legend.property.data, { ...previewLegend, colorOverrides: overrides,
            hideOutside: visibilityCheckbox.checked, onCommit: () => finishSliderPreview() });
          if (!preview) { applyRange(limits); return; }
          getAtomEyeTools().syncComparison();
          previewActive = true;
        } else {
          const preview = renderer.setScalarColorPreview(legend.property.data, { ...previewLegend, input: renderer.scalarColorPreview.input,
            hideOutside: visibilityCheckbox.checked, onCommit: () => finishSliderPreview() });
          if (!preview) { applyRange(limits); return; }
          getAtomEyeTools().syncScalarColorPreview();
        }
        currentColorLegend = previewLegend;
        // Rebuilding histogram counts would scan all atoms per tick. Keep the
        // gradient/value probe responsive and restore exact counts on release.
        updateLegendScale(scale, previewLegend, { histogram: false });
        minimum.textContent = formatValue(limits.minimum);
        maximum.textContent = formatValue(limits.maximum);
      };
      const applyLiveRange = (changed) => {
        if (!isCurrent()) return;
        onEdit('a color range edit');
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
        if (!isCurrent()) return;
        onEdit('a color map change');
        scalarColorSchemes.set(legend.property.name, schemeSelect.value);
        applyColors();
      });
      visibilityCheckbox.addEventListener('change', () => {
        if (!isCurrent()) return;
        onEdit('a color visibility change');
        scalarHideOutside.set(legend.property.name, visibilityCheckbox.checked);
        applyScalarVisibility(currentColorLegend ?? currentPalette().legend);
        getAtomEyeTools().syncComparison();
      });
      automatic.addEventListener('click', () => {
        if (!isCurrent()) return;
        onEdit('a color range change');
        if (scalarColorRanges.has(legend.property.name)) scalarColorRanges.delete(legend.property.name);
        else freezeCurrentRange();
        applyColors();
      });
      rangePolicy.addEventListener('change', () => {
        if (!isCurrent()) return;
        onEdit('a color range policy change');
        if (rangePolicy.value === 'frame') scalarColorRanges.delete(legend.property.name);
        else freezeCurrentRange();
        applyColors();
      });
      refreshers.push(() => {
        step = scalarLegendStep(legend);
        const upper = legend.maximum > legend.minimum ? legend.maximum : legend.minimum + step;
        minimumControl.input.step = maximumControl.input.step = String(step);
        // Preserve a focused field's browser editing buffer, including incomplete
        // number syntax. Its opposite bound and the displayed range still update.
        if (document.activeElement !== minimumControl.input) minimumControl.input.value = formatEditableNumber(legend.minimum);
        if (document.activeElement !== maximumControl.input) maximumControl.input.value = formatEditableNumber(upper);
        rangeSlider.update({ minimum: legend.minimum, maximum: upper, dataMinimum: legend.dataMinimum, dataMaximum: legend.dataMaximum, step });
        minimum.textContent = formatValue(legend.minimum); maximum.textContent = formatValue(legend.maximum);
        schemeSelect.value = legend.scheme;
        visibilityCheckbox.checked = scalarHideOutside.get(legend.property.name) !== false;
        previewActive = Boolean(renderer.scalarColorPreview);
        updateLegendScale(scale, legend, { histogram: !previewActive });
        syncAutomatic();
      });
      for (const input of [minimumControl.input, maximumControl.input]) input.addEventListener('blur', () => {
        if (isCurrent()) input.value = formatEditableNumber(input === minimumControl.input ? legend.minimum
          : legend.maximum > legend.minimum ? legend.maximum : legend.minimum + step);
      });
      elements['color-legend'].append(scale, range, controls);
    }
    elements.legend.hidden = false;
  }

  function renderOrientationLegend(getLegend, isCurrent) {
    let legend = getLegend();
    const refreshers = [];
    if (legend.mode === 'ipf') {
      const control = document.createElement('label'); control.className = 'legend-property';
      const caption = document.createElement('span'); caption.textContent = 'Sample direction';
      const select = document.createElement('select'); select.id = 'legend-ipf-direction';
      for (const value of ['x', 'y', 'z', 'custom']) select.append(option(value, value === 'custom' ? 'Custom vector' : value.toUpperCase()));
      select.value = getOrientationSettings().direction;
      refreshers.push(() => { select.value = getOrientationSettings().direction; });
      select.addEventListener('change', () => {
        if (!isCurrent()) return;
        onEdit('an orientation color change');
        setOrientationSettings(normalizeOrientationSettings({ ...getOrientationSettings(), direction: select.value })); applyColors();
      });
      control.append(caption, select); elements['color-legend'].append(control);
      if (getOrientationSettings().direction === 'custom') {
        const row = document.createElement('div'); row.className = 'legend-ipf-custom';
        const inputs = ['X', 'Y', 'Z'].map((axis, component) => {
          const label = document.createElement('label'); label.textContent = axis;
          const input = document.createElement('input'); input.type = 'number'; input.step = '.1';
          input.id = `legend-ipf-${axis.toLowerCase()}`; input.value = String(getOrientationSettings().custom[component]);
          label.append(input); row.append(label); return input;
        });
        for (const input of inputs) input.addEventListener('change', () => {
          if (!isCurrent()) return;
          try {
            const custom = inputs.map(input => input.value.trim() === '' ? NaN : Number(input.value));
            const settings = normalizeOrientationSettings({ direction: 'custom', custom });
            onEdit('an orientation color change'); setOrientationSettings(settings); applyColors();
          } catch (error) { notify(error.message); }
        });
        refreshers.push(() => inputs.forEach((input, index) => {
          if (document.activeElement !== input) input.value = String(getOrientationSettings().custom[index]);
        }));
        elements['color-legend'].append(row);
      }
      for (const key of legend.keys) {
        const title = document.createElement('p'); title.className = 'legend-ipf-family'; title.textContent = key.title;
        const canvas = document.createElement('canvas'); canvas.className = 'legend-ipf-key';
        canvas.width = 240; canvas.height = 126; canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${key.title} inverse pole figure key: ${key.labels.join(', ')}`);
        let previousColor = null;
        const refreshKey = () => {
          const color = getComputedStyle(elements['color-legend']).getPropertyValue('--text-soft').trim() || '#355563';
          if (color === previousColor) return;
          previousColor = color;
          drawIpfKey(canvas.getContext('2d'), key, 0, 0, canvas.width, canvas.height, { color, fontSize: 11 });
        };
        refreshers.push(refreshKey); refreshKey();
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
    const count = document.createElement('p'); count.className = 'help';
    const refreshCount = () => {
      count.hidden = !legend.undefinedCount;
      count.textContent = `Undefined: ${formatInteger(legend.undefinedCount)} · ${(legend.atomCount ? 100 * legend.undefinedCount / legend.atomCount : 0).toFixed(1)}%`;
    };
    refreshers.push(refreshCount); refreshCount();
    elements['color-legend'].append(count);
    return () => { legend = getLegend(); for (const refresh of refreshers) refresh(); };
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

  /** Forget the rendered view and any preview state, e.g. when a source closes. */
  function reset() {
    previewLegendControls.clear();
    legendView = null;
    currentColorLegend = null;
    commitScalarLegendEdit = null;
  }

  return {
    render: renderLegend, reset,
    /** Apply a slider edit that is still previewing, e.g. before an export captures the scene. */
    commitPendingEdit: () => commitScalarLegendEdit?.(),
    get currentLegend() { return currentColorLegend; },
    set currentLegend(legend) { currentColorLegend = legend; },
  };
}
