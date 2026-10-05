import { visibilityByCategory } from './render/palette.js';

export const CRYSTAL_VISIBILITY_SOURCE_NAMES = Object.freeze([
  'structureType', 'ptmStructureType', 'centralSymmetryStructureType',
  'idealStrainStructureType', 'dxaStructureType',
]);

const sourceLabels = Object.freeze({
  structureType: 'CNA',
  ptmStructureType: 'PTM',
  centralSymmetryStructureType: 'Auto symmetry',
  idealStrainStructureType: 'Ideal-lattice strain',
  dxaStructureType: 'DXA',
});

export function isCrystalStructureProperty(name) {
  return CRYSTAL_VISIBILITY_SOURCE_NAMES.includes(name);
}

/** Structure classifications remain attached to their own property vocabulary.
 * Only the chosen classification filters atoms, independently of their colors.
 * Frame arrays are read directly and never modified or retained in source metadata.
 */
export function createCrystalVisibilityState({ getFrame, getColorMode = () => 'type',
  getHiddenCategories, onChange = () => {} }) {
  let source = null, cachedMask = null, cachedData = null, cachedHidden = '', cachedSource = null;
  const hiddenBySource = new Map(), knownSources = new Map(), countsByData = new WeakMap();

  function getHidden(name = source) {
    if (!isCrystalStructureProperty(name)) return new Set();
    if (getHiddenCategories) return getHiddenCategories(name);
    if (!hiddenBySource.has(name)) hiddenBySource.set(name, new Set());
    return hiddenBySource.get(name);
  }

  function currentProperties() {
    const frame = getFrame();
    if (!frame?.ids) return [];
    return (frame.properties ?? []).filter(property => isCrystalStructureProperty(property.name)
      && Array.isArray(property.categories) && property.categories.length > 0
      && (Array.isArray(property.data) || ArrayBuffer.isView(property.data))
      && property.data?.length === frame.ids.length);
  }

  function refresh() {
    const available = currentProperties();
    for (const property of available) knownSources.set(property.name, {
      name: property.name, title: property.displayName ?? sourceLabels[property.name],
      categories: property.categories,
    });
    if (source === null && available.length) {
      source = available.find(property => property.name === getColorMode())?.name ?? available[0].name;
    }
    return getSources(available);
  }

  function getSources(available = currentProperties()) {
    const present = new Set(available.map(property => property.name));
    const names = CRYSTAL_VISIBILITY_SOURCE_NAMES.filter(name => knownSources.has(name) || name === source);
    return names.map(name => ({ name, label: sourceLabels[name],
      title: knownSources.get(name)?.title ?? sourceLabels[name], available: present.has(name) }));
  }

  function getSummary() {
    refresh();
    if (source === null) return null;
    const property = currentProperties().find(property => property.name === source) ?? null;
    const metadata = knownSources.get(source);
    let counts = property && countsByData.get(property.data);
    if (property && !counts) {
      counts = new Map();
      for (const id of property.data) counts.set(id, (counts.get(id) ?? 0) + 1);
      countsByData.set(property.data, counts);
    }
    const hidden = getHidden();
    return { source, label: sourceLabels[source], title: metadata?.title ?? sourceLabels[source],
      available: Boolean(property), property, atomCount: property?.data.length ?? 0,
      items: (metadata?.categories ?? []).map(item => ({ ...item,
        count: property ? counts.get(item.id) ?? 0 : null, visible: !hidden.has(item.id) })) };
  }

  function getMask() {
    refresh();
    const property = currentProperties().find(property => property.name === source);
    const hidden = getHidden();
    if (!property || hidden.size === 0) {
      cachedData = null;
      cachedMask = null;
      return null;
    }
    // Shared legend controls may edit the Set directly, so include its small
    // category signature instead of relying solely on this controller's events.
    const signature = [...hidden].sort((a, b) => a - b).join(',');
    if (cachedData !== property.data || cachedSource !== source || cachedHidden !== signature) {
      cachedMask = visibilityByCategory(property, hidden);
      cachedData = property.data;
      cachedSource = source;
      cachedHidden = signature;
    }
    return cachedMask;
  }

  function changed(reason) { onChange(reason); }

  function setSource(name) {
    if (!isCrystalStructureProperty(name)) throw new Error('Unknown crystal visibility source.');
    if (source === name) return false;
    source = name;
    changed('source');
    return true;
  }

  function setCategoryVisible(id, visible) {
    const summary = getSummary();
    if (!summary?.available || !summary.items.some(item => item.id === id)) return false;
    const hidden = getHidden();
    if (hidden.has(id) === !visible) return false;
    if (visible) hidden.delete(id);
    else hidden.add(id);
    changed('category');
    return true;
  }

  function setAllVisible(visible) {
    const summary = getSummary();
    if (!summary?.available) return false;
    const hidden = getHidden();
    let edited = false;
    for (const { id } of summary.items) {
      if (hidden.has(id) !== !visible) edited = true;
      if (visible) hidden.delete(id);
      else hidden.add(id);
    }
    if (edited) changed('all');
    return edited;
  }

  function serialize() {
    return { source, hiddenBySource: Object.fromEntries(CRYSTAL_VISIBILITY_SOURCE_NAMES
      .map(name => [name, [...getHidden(name)].sort((a, b) => a - b)])
      .filter(([, ids]) => ids.length)) };
  }

  function restore(saved = {}) {
    const nextSource = saved.source ?? null;
    if (nextSource !== null && !isCrystalStructureProperty(nextSource)) throw new Error('Unknown crystal visibility source.');
    const savedHidden = saved.hiddenBySource;
    if (savedHidden !== undefined) {
      if (!savedHidden || typeof savedHidden !== 'object' || Array.isArray(savedHidden)) {
        throw new Error('Crystal visibility categories must be an object.');
      }
      for (const [name, ids] of Object.entries(savedHidden)) {
        if (!isCrystalStructureProperty(name) || !Array.isArray(ids)
          || ids.some(id => !Number.isSafeInteger(id) || id < 0)) {
          throw new Error('Invalid crystal visibility category.');
        }
      }
      for (const name of CRYSTAL_VISIBILITY_SOURCE_NAMES) {
        const hidden = getHidden(name);
        hidden.clear();
        for (const id of savedHidden[name] ?? []) hidden.add(id);
      }
    }
    source = nextSource;
    cachedData = null;
    cachedMask = null;
    refresh();
  }

  function forgetSource(name) {
    const wasKnown = knownSources.delete(name), wasSelected = source === name;
    if (!wasKnown && !wasSelected) return false;
    if (wasSelected) source = null;
    cachedData = null;
    cachedMask = null;
    refresh();
    return true;
  }

  function reset() {
    for (const name of CRYSTAL_VISIBILITY_SOURCE_NAMES) getHidden(name).clear();
    knownSources.clear();
    source = null;
    cachedData = null;
    cachedMask = null;
  }

  return { refresh, getSources, getSummary, getMask, getHidden, setSource,
    setCategoryVisible, setAllVisible, serialize, restore, forgetSource, reset };
}

export function initializeCrystalVisibilityControls({ getFrame, getColorMode = () => 'type',
  getHiddenCategories, onChange = () => {}, container = document.getElementById('crystal-visibility') }) {
  let renderedData = null, renderedLayout = '', rows = [], sourceSelect = null;
  const state = createCrystalVisibilityState({ getFrame, getColorMode, getHiddenCategories,
    onChange(reason) { render(); onChange(reason); } });

  function render() {
    const sources = state.refresh(), summary = state.getSummary();
    container.hidden = !summary || !getFrame();
    if (container.hidden) return;
    const sharedWithColor = summary.available && summary.source === getColorMode();
    const layout = JSON.stringify([summary.source, sharedWithColor, summary.available,
      sources.map(item => [item.name, item.title, item.available]),
      summary.items.map(item => [item.id, item.label])]);
    if (renderedLayout === layout && renderedData === summary.property?.data) {
      const hidden = state.getHidden();
      for (const { checkbox, row, id } of rows) {
        checkbox.checked = !hidden.has(id);
        row.classList.toggle('is-hidden', !checkbox.checked);
      }
      return;
    }
    const focusedSource = sourceSelect && document.activeElement === sourceSelect;
    renderedLayout = layout;
    renderedData = summary.property?.data;
    rows = [];
    const heading = document.createElement('strong');
    heading.className = 'crystal-visibility-title';
    heading.textContent = 'Crystal visibility';
    const sourceControl = document.createElement('label');
    sourceControl.className = 'crystal-visibility-source legend-property';
    sourceControl.hidden = sources.length < 2;
    const sourceLabel = document.createElement('span');
    sourceLabel.textContent = 'Classified by';
    sourceSelect = document.createElement('select');
    sourceSelect.id = 'crystal-visibility-source';
    for (const item of sources) {
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = `${item.label}${item.available ? '' : ' (pending)'}`;
      sourceSelect.append(option);
    }
    sourceSelect.value = summary.source;
    sourceSelect.title = summary.title;
    sourceSelect.addEventListener('change', () => state.setSource(sourceSelect.value));
    sourceControl.append(sourceLabel, sourceSelect);
    const sourceName = document.createElement('div');
    sourceName.className = 'crystal-visibility-source-name';
    sourceName.textContent = `Classified by ${summary.label}`;
    sourceName.hidden = sources.length > 1;
    const help = document.createElement('p');
    help.className = 'crystal-visibility-help';
    help.setAttribute('role', 'status');
    help.textContent = !summary.available
      ? `${summary.label} results are pending in this frame. The filter applies when results are available.`
      : sharedWithColor ? 'Use the structure checkboxes above to show or hide atoms.'
        : 'Show or hide structures independently of atom colors.';
    container.replaceChildren(heading, sourceControl, sourceName, help);
    if (!sharedWithColor && summary.items.length) {
      const actions = document.createElement('div');
      actions.className = 'crystal-visibility-actions legend-category-actions';
      for (const [name, text, visible] of [['select-all', 'Select all', true], ['unselect-all', 'Unselect all', false]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.dataset.crystalAction = name;
        button.disabled = !summary.available;
        button.setAttribute('aria-label', `${visible ? 'Show' : 'Hide'} every ${summary.label} structure category`);
        button.addEventListener('click', () => state.setAllVisible(visible));
        actions.append(button);
      }
      const items = document.createElement('div');
      items.className = 'crystal-visibility-items';
      items.setAttribute('role', 'group');
      items.setAttribute('aria-label', `Atom visibility by ${summary.label} structure`);
      for (const item of summary.items) {
        const row = document.createElement('label');
        row.className = 'crystal-visibility-item';
        row.title = item.description ?? `Show or hide ${item.label} atoms`;
        row.classList.toggle('is-hidden', !item.visible);
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = item.visible;
        checkbox.disabled = !summary.available;
        checkbox.dataset.crystalSource = summary.source;
        checkbox.dataset.crystalType = String(item.id);
        checkbox.setAttribute('aria-label', `Show ${item.label} atoms classified by ${summary.label}`);
        checkbox.addEventListener('change', () => state.setCategoryVisible(item.id, checkbox.checked));
        const swatch = document.createElement('i');
        swatch.className = 'legend-swatch';
        swatch.style.background = `rgb(${(item.color ?? [242, 242, 242]).join(' ')})`;
        swatch.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.textContent = item.label;
        const count = document.createElement('span');
        count.className = 'crystal-visibility-count';
        count.textContent = item.count === null ? '—'
          : `${Number(item.count).toLocaleString('en-US')} · ${(summary.atomCount ? 100 * item.count / summary.atomCount : 0).toFixed(1)}%`;
        row.append(checkbox, swatch, name, count);
        items.append(row);
        rows.push({ checkbox, row, id: item.id });
      }
      container.append(actions, items);
    }
    if (focusedSource) sourceSelect.focus({ preventScroll: true });
  }

  return { ...state, refresh: render,
    restore(saved) { state.restore(saved); render(); },
    forgetSource(name) { const changed = state.forgetSource(name); render(); return changed; },
    reset() { state.reset(); renderedLayout = ''; renderedData = null; container.hidden = true; } };
}
