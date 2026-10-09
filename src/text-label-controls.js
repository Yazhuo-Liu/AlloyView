import { formatAttributeValue, LABEL_POSITIONS, MAX_TEXT_LABELS, createTextLabel, normalizeTextLabelState,
  parseLabelTemplate, renderLabelTemplate, DEFAULT_LABEL_TEMPLATE, LABEL_FONT_SIZE_RANGE, LABEL_OFFSET_LIMIT } from './text-labels.js';
import { TEXT_LABEL_FONT, TEXT_LABEL_LINE_HEIGHT, textLabelColors, textLabelOrigin } from './render/text-label-overlay.js';

const POSITION_LABELS = { 'top-left': 'Top left', top: 'Top', 'top-right': 'Top right', left: 'Left', center: 'Center',
  right: 'Right', 'bottom-left': 'Bottom left', bottom: 'Bottom', 'bottom-right': 'Bottom right' };
const HINTS = new Map([['CNA', 'Calculate CNA for this frame.'], ['PTM', 'Calculate PTM for this frame.'], ['DXA', 'Calculate DXA for this frame.'],
  ['Clusters', 'Calculate clusters for this frame.'], ['WignerSeitz', 'Calculate Wigner–Seitz defects for this frame.'],
  ['Strain', 'The strain reference frame is being read, or it is beyond the frames indexed so far.'],
  ['Timestep', 'This file stores no timestep.'], ['Mean', 'No numeric property with this name in this frame.']]);
const CONTROL_IDS = ['text-label-list', 'add-text-label', 'delete-text-label', 'text-label-enabled', 'text-label-text', 'text-label-position',
  'text-label-offset-x', 'text-label-offset-y', 'text-label-size', 'text-label-color-mode', 'text-label-color', 'text-label-box',
  'text-label-box-color', 'attribute-strain-reference', 'text-label-attribute-filter'];

/** Text labels: an editor in the Labels panel, a DOM overlay over the
 * viewport, and resolved labels for every image export. Templates are
 * parsed by text-labels.js and filled from the global attribute registry. */
export function initializeTextLabels({ renderer, tools, attributes, getFrameCount = () => 1, onEdit = () => {}, notify = () => {},
  documentRoot = globalThis.document } = {}) {
  const $ = id => documentRoot?.getElementById(id) ?? null;
  let state = normalizeTextLabelState({ labels: [], selectedId: null }), sequence = 0, controlsEnabled = false;
  const parsed = new Map();
  const overlay = documentRoot?.createElement('div');
  if (overlay) {
    overlay.id = 'text-label-overlay'; overlay.className = 'text-label-overlay'; overlay.setAttribute('aria-hidden', 'true');
    renderer?.canvas?.parentElement?.insertBefore(overlay, renderer.canvas.nextSibling);
  }

  function template(label) {
    const cached = parsed.get(label.id);
    if (cached?.text === label.text) return cached.parsed;
    const value = parseLabelTemplate(label.text);
    parsed.set(label.id, { text: label.text, parsed: value });
    return value;
  }

  function resolve(label, registry = attributes.current()) {
    const result = renderLabelTemplate(template(label), name => registry?.get(name) ?? null);
    if (registry && result.missing.some(name => /^strain\./i.test(name))) attributes.requestReference();
    return result;
  }

  function activeLabels() { return state.labels.filter(label => label.enabled && label.text.trim()); }

  /** Labels for an image export, resolved for the displayed frame now. */
  function exportLabels() {
    const registry = attributes.current();
    if (!registry) return null;
    const labels = activeLabels().map(label => ({ text: resolve(label, registry).text, position: label.position, offset: [...label.offset],
      fontSize: label.fontSize, color: label.color, box: label.box, boxColor: label.boxColor })).filter(label => label.text);
    return labels.length ? labels : null;
  }

  function selected() { return state.labels.find(label => label.id === state.selectedId) ?? null; }

  function renderOverlay(registry = attributes.current()) {
    if (!overlay) return;
    const labels = registry ? activeLabels() : [];
    overlay.hidden = !labels.length;
    const elements = labels.map(label => {
      const element = documentRoot.createElement('div');
      element.className = 'text-label';
      element.dataset.labelId = label.id;
      element.textContent = resolve(label, registry).text;
      const colors = textLabelColors(label, { includeBackground: true, theme: { panel: 'var(--overlay)', border: 'var(--line-strong)', title: 'var(--text-soft)' } });
      Object.assign(element.style, { fontSize: `${label.fontSize}px`, fontFamily: TEXT_LABEL_FONT, lineHeight: String(TEXT_LABEL_LINE_HEIGHT),
        color: colors.text, background: colors.box?.fill ?? 'transparent', borderColor: colors.box?.stroke ?? 'transparent',
        textAlign: label.position.endsWith('left') || label.position === 'left' ? 'left'
          : label.position.endsWith('right') || label.position === 'right' ? 'right' : 'center' });
      return element;
    });
    overlay.replaceChildren(...elements);
    layoutOverlay();
  }

  function layoutOverlay() {
    if (!overlay || overlay.hidden) return;
    const width = renderer?.canvas?.clientWidth ?? 0, height = renderer?.canvas?.clientHeight ?? 0;
    for (const element of overlay.children) {
      const label = state.labels.find(item => item.id === element.dataset.labelId);
      if (!label) continue;
      const { x, y } = textLabelOrigin(label.position, element.offsetWidth, element.offsetHeight, width, height, 1, label.offset);
      element.style.left = `${x}px`; element.style.top = `${y}px`;
    }
  }

  function describeMissing(name, registry) {
    const group = name.split('.')[0];
    const hint = HINTS.get(group) ?? (registry?.list().some(entry => entry.name.toLowerCase().startsWith(`${group.toLowerCase()}.`))
      ? 'Check the name in Available attributes.' : 'Unknown attribute; see Available attributes.');
    return `[?${name}] ${hint}`;
  }

  function renderStatus(registry = attributes.current()) {
    const label = selected();
    const preview = $('text-label-preview'), problems = $('text-label-problems');
    if (!label) {
      if (preview) preview.textContent = '';
      if (problems) problems.textContent = 'Add a label to stamp attributes such as the timestep or crystal fractions on images.';
      return;
    }
    const result = resolve(label, registry);
    if (preview) preview.textContent = registry ? result.text : 'Open a structure to preview this label.';
    const messages = [...result.problems.map(problem => `Column ${problem.column}: ${problem.message}`),
      ...(registry ? result.missing.map(name => describeMissing(name, registry)) : []),
      ...result.invalid.map(raw => `${raw} has an invalid number format.`)];
    if (problems) {
      problems.textContent = messages.length ? messages.join(' ') : label.enabled ? 'Shown in the viewport and stamped into image exports.'
        : 'This label is hidden. Check Show label to display and export it.';
      problems.classList.toggle('error', messages.length > 0);
    }
  }

  function renderAttributeTable(registry = attributes.current()) {
    const container = $('text-label-attributes');
    if (!container || !container.closest('details')?.open) return;
    const filter = ($('text-label-attribute-filter')?.value ?? '').trim().toLowerCase();
    if (!registry) { container.replaceChildren(node('p', 'Open a structure to list its attributes.', 'help')); return; }
    attributes.requestReference();
    const entries = registry.list().filter(entry => !filter || entry.name.toLowerCase().includes(filter));
    const table = node('table'), body = node('tbody');
    const head = node('thead'), headRow = node('tr');
    for (const text of ['Attribute', 'Value', 'Source']) headRow.append(node('th', text));
    head.append(headRow);
    for (const entry of entries.slice(0, 500)) {
      const row = node('tr'), nameCell = node('td'), button = node('button', entry.name, 'text-button attribute-insert');
      button.type = 'button'; button.title = `${entry.description}. Click to insert [${entry.name}].`;
      button.addEventListener('click', () => insertPlaceholder(entry.name));
      nameCell.append(button);
      const value = registry.get(entry.name)?.value;
      row.append(nameCell, node('td', `${formatAttributeValue(value)}${entry.unit ? ` ${entry.unit}` : ''}`),
        node('td', entry.kind === 'file' ? 'File' : 'Analysis'));
      body.append(row);
    }
    table.append(head, body);
    container.replaceChildren(table, ...(entries.length > 500 ? [node('p', `Showing 500 of ${entries.length} attributes; type to filter.`, 'help')] : []));
  }

  function node(tag, text, className) {
    const element = documentRoot.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function insertPlaceholder(name) {
    const input = $('text-label-text'), label = selected();
    if (!input || !label || input.disabled) return;
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    const value = `${input.value.slice(0, start)}[${name}]${input.value.slice(end)}`;
    if (value.length > input.maxLength && input.maxLength > 0) { notify('The label text is too long.'); return; }
    input.value = value; input.focus?.();
    input.setSelectionRange?.(start + name.length + 2, start + name.length + 2);
    readEditor();
  }

  function syncTool() { tools?.setToolEnabled('textLabels', activeLabels().length > 0); }

  function updateControls() {
    const label = selected();
    for (const id of CONTROL_IDS) if ($(id)) $(id).disabled = !controlsEnabled;
    for (const id of ['delete-text-label', 'text-label-enabled', 'text-label-text', 'text-label-position', 'text-label-offset-x',
      'text-label-offset-y', 'text-label-size', 'text-label-color-mode', 'text-label-box']) if ($(id)) $(id).disabled = !controlsEnabled || !label;
    if ($('add-text-label')) $('add-text-label').disabled = !controlsEnabled || state.labels.length >= MAX_TEXT_LABELS;
    if ($('text-label-color')) $('text-label-color').disabled = !controlsEnabled || !label || label.color === null;
    if ($('text-label-box-color')) $('text-label-box-color').disabled = !controlsEnabled || !label || label.box !== 'custom';
    if ($('text-label-editor')) $('text-label-editor').hidden = !label;
  }

  function loadEditor() {
    const list = $('text-label-list');
    if (list) {
      list.replaceChildren(...state.labels.map((label, index) => {
        const item = node('option', `${index + 1}. ${label.text.split('\n')[0].slice(0, 40) || '(empty)'}${label.enabled ? '' : ' · hidden'}`);
        item.value = label.id; return item;
      }));
      list.value = state.selectedId ?? '';
    }
    const label = selected();
    if (label) {
      if ($('text-label-enabled')) $('text-label-enabled').checked = label.enabled;
      if ($('text-label-text') && $('text-label-text').value !== label.text) $('text-label-text').value = label.text;
      if ($('text-label-position')) $('text-label-position').value = label.position;
      if ($('text-label-offset-x')) $('text-label-offset-x').value = String(label.offset[0]);
      if ($('text-label-offset-y')) $('text-label-offset-y').value = String(label.offset[1]);
      if ($('text-label-size')) $('text-label-size').value = String(label.fontSize);
      if ($('text-label-color-mode')) $('text-label-color-mode').value = label.color === null ? 'theme' : 'custom';
      if ($('text-label-color') && label.color) $('text-label-color').value = label.color;
      if ($('text-label-box')) $('text-label-box').value = label.box;
      if ($('text-label-box-color')) $('text-label-box-color').value = label.boxColor;
    }
    updateControls();
  }

  function numberValue(id, fallback, minimum, maximum) {
    const value = $(id)?.valueAsNumber ?? Number($(id)?.value);
    return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
  }

  /** Copy the editor into the selected label. */
  function readEditor() {
    const label = selected();
    if (!label) return;
    onEdit();
    const text = ($('text-label-text')?.value ?? label.text).replace(/\r\n?/g, '\n');
    Object.assign(label, {
      enabled: $('text-label-enabled')?.checked ?? label.enabled,
      text: text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' '),
      position: LABEL_POSITIONS.includes($('text-label-position')?.value) ? $('text-label-position').value : label.position,
      offset: [numberValue('text-label-offset-x', label.offset[0], -LABEL_OFFSET_LIMIT, LABEL_OFFSET_LIMIT),
        numberValue('text-label-offset-y', label.offset[1], -LABEL_OFFSET_LIMIT, LABEL_OFFSET_LIMIT)],
      fontSize: numberValue('text-label-size', label.fontSize, ...LABEL_FONT_SIZE_RANGE),
      color: $('text-label-color-mode')?.value === 'custom' ? ($('text-label-color')?.value ?? '#ffffff').toLowerCase() : null,
      box: ['theme', 'custom', 'none'].includes($('text-label-box')?.value) ? $('text-label-box').value : label.box,
      boxColor: ($('text-label-box-color')?.value ?? label.boxColor).toLowerCase(),
    });
    changed();
  }

  function changed() {
    loadEditor(); syncTool();
    const registry = attributes.current();
    renderOverlay(registry); renderStatus(registry);
  }

  function addLabel() {
    if (state.labels.length >= MAX_TEXT_LABELS) { notify(`Add up to ${MAX_TEXT_LABELS} labels.`); return; }
    onEdit();
    let id;
    do { id = `label-${++sequence}`; } while (state.labels.some(label => label.id === id));
    const used = new Set(state.labels.map(label => label.position));
    const position = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'top', 'bottom'].find(item => !used.has(item)) ?? 'top-right';
    const text = state.labels.length ? 'Timestep [Timestep]' : getFrameCount() > 1 ? DEFAULT_LABEL_TEMPLATE : 'Atoms [AtomCount]';
    state.labels.push(createTextLabel({ id, text, position }));
    state.selectedId = id;
    changed();
  }

  function deleteLabel() {
    const label = selected();
    if (!label) return;
    onEdit();
    const index = state.labels.indexOf(label);
    state.labels.splice(index, 1); parsed.delete(label.id);
    state.selectedId = state.labels[Math.min(index, state.labels.length - 1)]?.id ?? null;
    changed();
  }

  function syncStrainReference() {
    const input = $('attribute-strain-reference');
    if (input && documentRoot.activeElement !== input) {
      input.value = String(attributes.getStrainReferenceFrame() + 1);
      input.max = String(Math.max(1, getFrameCount()));
    }
  }

  attributes.subscribe(registry => {
    renderOverlay(registry); renderStatus(registry); renderAttributeTable(registry); syncStrainReference();
  });
  $('add-text-label')?.addEventListener('click', addLabel);
  $('delete-text-label')?.addEventListener('click', deleteLabel);
  $('text-label-list')?.addEventListener('change', () => { state.selectedId = $('text-label-list').value || null; changed(); });
  $('text-label-text')?.addEventListener('input', readEditor);
  for (const id of ['text-label-enabled', 'text-label-position', 'text-label-offset-x', 'text-label-offset-y', 'text-label-size',
    'text-label-color-mode', 'text-label-color', 'text-label-box', 'text-label-box-color']) {
    $(id)?.addEventListener(id.endsWith('color') ? 'input' : 'change', readEditor);
  }
  $('attribute-strain-reference')?.addEventListener('change', () => {
    const value = $('attribute-strain-reference').valueAsNumber;
    if (!Number.isInteger(value) || value < 1 || value > Math.max(1, getFrameCount())) {
      notify(`Choose a reference frame from 1 to ${Math.max(1, getFrameCount())}.`); syncStrainReference(); return;
    }
    onEdit(); attributes.setStrainReferenceFrame(value - 1);
  });
  $('text-label-attribute-filter')?.addEventListener('input', () => renderAttributeTable());
  $('text-label-attributes')?.closest('details')?.addEventListener('toggle', () => renderAttributeTable());
  if ($('text-label-position') && !$('text-label-position').options.length) {
    $('text-label-position').replaceChildren(...LABEL_POSITIONS.map(position => { const item = node('option', POSITION_LABELS[position]); item.value = position; return item; }));
  }
  if (typeof ResizeObserver === 'function' && renderer?.canvas) new ResizeObserver(() => layoutOverlay()).observe(renderer.canvas);
  loadEditor(); renderStatus(null);

  return Object.freeze({
    exportLabels,
    /** Before a frame-image export: read the strain reference if a label needs it. */
    async prepareExport({ signal } = {}) {
      const strain = activeLabels().some(label => template(label).parts.some(part => part.type === 'field' && /^strain\./i.test(part.name)));
      if (strain) await attributes.ensureReference({ signal }).catch(() => null);
    },
    refresh: () => attributes.refresh(),
    setEnabled(value) { controlsEnabled = Boolean(value); updateControls(); if (!value) renderOverlay(null); else attributes.refresh({ force: true }); },
    hasActiveLabels: () => activeLabels().length > 0,
    getState: () => ({ labels: state.labels.map(label => ({ ...label, offset: [...label.offset] })), selectedId: state.selectedId }),
    serialize() { return state.labels.length ? { labels: state.labels.map(label => ({ ...label, offset: [...label.offset] })), selectedId: state.selectedId } : undefined; },
    /** Replace all labels with validated saved ones (an empty list when absent). */
    restore(saved) {
      state = normalizeTextLabelState(saved ?? { labels: [] });
      parsed.clear();
      sequence = Math.max(0, ...state.labels.map(label => Number(/^label-(\d+)$/.exec(label.id)?.[1] ?? 0)));
      changed();
    },
    layout: layoutOverlay,
  });
}
