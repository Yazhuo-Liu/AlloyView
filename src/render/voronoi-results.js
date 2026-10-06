import { distributionRows, renderPopulationTable } from './distribution-chart.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const number = value => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('en-US', { maximumSignificantDigits: 5 }) : '—';
const percent = value => `${number(value * 100)}%`;
const population = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '—';
function coordinate(value, width = 0) {
  if (!Number.isFinite(value)) return '—';
  const digits = width > 0 && value !== 0 ? Math.max(5, Math.ceil(Math.log10(Math.abs(value) / width)) + 2) : 5;
  return value.toLocaleString('en-US', { maximumSignificantDigits: Math.min(17, digits) });
}
const chartPreferences = new WeakMap();
const QUANTITIES = Object.freeze({
  'voronoi-color-volume': 'atomicVolume', 'voronoi-color-coordination': 'voronoiCoordination',
  'voronoi-color-surface': 'voronoiSurfaceArea', 'voronoi-color-face-order': 'voronoiMaxFaceOrder',
  'voronoi-color-boundary': 'voronoiBoundaryFaces',
});

function node(root, tag, text, className) {
  const element = root.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function svgNode(root, tag, attributes, text) {
  const element = root.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

function range(values) {
  let minimum = Infinity, maximum = -Infinity;
  for (const value of values ?? []) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
  }
  return minimum === Infinity ? { min: null, max: null } : { min: minimum, max: maximum };
}

function mostCommon(entries, limit) {
  const values = [], compare = (a, b) => b.count - a.count || String(a.index).localeCompare(String(b.index));
  for (const entry of entries ?? []) {
    if (values.length < limit) values.push(entry);
    else if (compare(entry, values.at(-1)) < 0) values[values.length - 1] = entry;
    else continue;
    values.sort(compare);
  }
  return values;
}

/** Compact display metadata; input arrays and the complete statistics remain
 * unchanged, including cells hidden by the display. */
export function voronoiOverview(result) {
  const summary = result?.summary ?? {};
  const coordination = Number.isFinite(summary.minCoordination) && Number.isFinite(summary.maxCoordination)
    ? { min: summary.minCoordination, max: summary.maxCoordination } : range(result?.voronoiCoordination);
  const volume = Number.isFinite(summary.minVolume) && Number.isFinite(summary.maxVolume)
    ? { min: summary.minVolume, max: summary.maxVolume } : range(result?.atomicVolume);
  const count = summary.atomCount ?? result?.atomicVolume?.length ?? 0;
  const dominant = mostCommon(result?.indexCounts, 1)[0];
  const error = summary.volumeError;
  return {
    count,
    meanVolume: summary.meanVolume, minVolume: summary.minVolume ?? volume.min, maxVolume: summary.maxVolume ?? volume.max,
    meanCoordination: summary.meanCoordination, minCoordination: coordination.min, maxCoordination: coordination.max,
    meanSurfaceArea: summary.meanSurfaceArea,
    dominantIndex: dominant?.index ?? '—', dominantCount: dominant?.count ?? 0,
    dominantFraction: dominant ? dominant.fraction ?? (count ? dominant.count / count : 0) : 0,
    boundaryAtomCount: summary.boundaryAtomCount ?? 0,
    boundaryFraction: count ? (summary.boundaryAtomCount ?? 0) / count : 0,
    volumeError: error !== null && error !== undefined && Number.isFinite(error) ? error : null,
    totalVolume: summary.totalVolume, cellVolume: summary.cellVolume,
  };
}

function renderCards(container, result) {
  if (!container) return;
  const root = container.ownerDocument, values = voronoiOverview(result);
  const cards = [
    ['volume', 'Mean atomic volume', `${number(values.meanVolume)} Å³`, `${number(values.minVolume)}–${number(values.maxVolume)} Å³`],
    ['coordination', 'Mean neighbors', number(values.meanCoordination), `Range ${number(values.minCoordination)}–${number(values.maxCoordination)}`],
    ['surface', 'Mean surface area', `${number(values.meanSurfaceArea)} Å²`, `${population(values.count)} cells`],
    ['topology', 'Most common index', values.dominantIndex, `${percent(values.dominantFraction)} · ${population(values.dominantCount)} atoms`],
    ['boundary', 'Boundary atoms', population(values.boundaryAtomCount), `${percent(values.boundaryFraction)} of atoms`],
    ['volume-check', 'Cell volume check', values.volumeError === null ? 'Not available' :
      Math.abs(values.volumeError) <= 1e-4 ? 'Within 0.01%' : `${percent(Math.abs(values.volumeError))} difference`,
    values.volumeError === null ? 'Complete-domain totals required' :
      `Relative error ${values.volumeError === 0 ? '0' : values.volumeError.toExponential(2)}`],
  ];
  container.replaceChildren(...cards.map(([key, label, value, detail]) => {
    const card = node(root, 'div', undefined, 'voronoi-stat-card');
    card.setAttribute('data-voronoi-stat', key);
    card.append(node(root, 'span', label, 'voronoi-stat-label'), node(root, 'strong', value), node(root, 'span', detail, 'voronoi-stat-detail'));
    if (key === 'volume-check') card.title = `Sum of atomic volumes: ${number(values.totalVolume)} Å³; simulation cell: ${number(values.cellVolume)} Å³.`;
    return card;
  }));
}

function renderTopologies(container, entries, count) {
  if (!container) return;
  const root = container.ownerDocument;
  const values = mostCommon(entries, 6);
  container.replaceChildren();
  for (const entry of values) {
    const fraction = entry.fraction ?? (count ? entry.count / count : 0);
    const row = node(root, 'div', undefined, 'voronoi-topology-row');
    const heading = node(root, 'div', undefined, 'voronoi-topology-heading');
    heading.append(node(root, 'span', entry.index, 'voronoi-topology-index'), node(root, 'span', `${population(entry.count)} · ${percent(fraction)}`));
    const track = node(root, 'div', undefined, 'voronoi-topology-track');
    track.setAttribute('aria-hidden', 'true');
    const bar = node(root, 'span'); bar.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
    track.append(bar); row.append(heading, track); container.append(row);
  }
  if (!values.length) container.append(node(root, 'p', 'No face-order indices.', 'help'));
  else if (entries.length > 6) container.append(node(root, 'p', `${population(entries.length)} distinct indices; open the complete table below for the remaining populations.`, 'help'));
}

function histogramTable(container, rows, label, unit) {
  const root = container.ownerDocument, pageSize = 50;
  let page = 0;
  function render(focus) {
    const table = node(root, 'table'), head = node(root, 'thead'), headings = node(root, 'tr');
    table.append(node(root, 'caption', `${label}${unit ? ` · ${unit}` : ''}`));
    for (const text of ['Lower', 'Upper', 'Count', 'Probability']) {
      const th = node(root, 'th', text); th.setAttribute('scope', 'col'); headings.append(th);
    }
    head.append(headings); table.append(head);
    const body = node(root, 'tbody');
    for (const row of rows.slice(page * pageSize, (page + 1) * pageSize)) {
      const tr = node(root, 'tr');
      for (const value of [coordinate(row.lower, row.upper - row.lower), coordinate(row.upper, row.upper - row.lower), population(row.count), percent(row.probability)]) tr.append(node(root, 'td', value));
      body.append(tr);
    }
    table.append(body); container.replaceChildren(table);
    if (rows.length <= pageSize) return;
    const controls = node(root, 'div', undefined, 'statistics-population-controls');
    const previous = node(root, 'button', 'Previous', 'button button-secondary'), next = node(root, 'button', 'Next', 'button button-secondary');
    previous.type = next.type = 'button'; previous.disabled = page === 0; next.disabled = (page + 1) * pageSize >= rows.length;
    previous.setAttribute('aria-label', `Previous ${label} bins`); next.setAttribute('aria-label', `Next ${label} bins`);
    previous.addEventListener('click', () => { page--; render('previous'); });
    next.addEventListener('click', () => { page++; render('next'); });
    controls.append(previous, node(root, 'span', `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, rows.length)} of ${number(rows.length)}`), next);
    container.append(controls);
    if (focus) (focus === 'next' ? (next.disabled ? previous : next) : (previous.disabled ? next : previous)).focus?.();
  }
  render();
}

/** One SVG path for all bins, a single movable highlight and native slider:
 * chart DOM stays bounded even for thousands of bins. Pointer/touch and keyboard
 * inspection report the original counts rather than rounded plot coordinates. */
export function renderVoronoiHistogram(container, distribution, { label = 'Distribution', xLabel = '', unit = '', discrete = false } = {}) {
  if (!container) return;
  const root = container.ownerDocument;
  const rows = distributionRows(distribution).filter(row => Number.isFinite(row.lower) && Number.isFinite(row.upper));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  container.replaceChildren();
  if (!rows.length || !total) { container.append(node(root, 'p', 'No qualifying samples.', 'help')); return; }
  const preference = chartPreferences.get(container) ?? { mode: 'count', selected: 0 };
  preference.selected = Math.min(rows.length - 1, preference.selected);
  chartPreferences.set(container, preference);
  const modes = node(root, 'div', undefined, 'voronoi-chart-modes');
  modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', `${label} vertical axis`);
  const countButton = node(root, 'button', 'Count', 'button button-secondary'), probabilityButton = node(root, 'button', 'Probability', 'button button-secondary');
  countButton.type = probabilityButton.type = 'button';
  modes.append(countButton, probabilityButton); container.append(modes);
  const svg = svgNode(root, 'svg', { viewBox: '0 0 360 200', tabindex: 0, role: 'group', 'aria-label': `${label}; ${population(total)} samples. Use left and right arrows to inspect bins.` });
  svg.append(svgNode(root, 'title', {}, `${label}: ${population(total)} samples in ${rows.length} bins.`));
  const left = 46, right = 344, top = 24, bottom = 154;
  const minimum = Math.min(...rows.map(row => row.lower)), maximum = Math.max(...rows.map(row => row.upper));
  const constant = maximum === minimum;
  const x = value => constant ? (left + right) / 2 : left + (value - minimum) / (maximum - minimum) * (right - left);
  const bounds = row => constant ? [left + (right - left) * .25, right - (right - left) * .25] : [x(row.lower), x(row.upper)];
  const bars = svgNode(root, 'path', { class: 'chart-bar' }), highlight = svgNode(root, 'rect', { class: 'voronoi-chart-highlight', y: top, height: bottom - top, fill: 'none' });
  svg.append(bars, highlight, svgNode(root, 'path', { d: `M${left},${top}V${bottom}H${right}`, class: 'chart-axis', fill: 'none' }));
  const yMaximum = svgNode(root, 'text', { x: left - 5, y: top + 4, 'font-size': 10, 'text-anchor': 'end' });
  const yLabel = svgNode(root, 'text', { x: left, y: 12, 'font-size': 10, 'text-anchor': 'start' });
  svg.append(yMaximum, yLabel);
  const xTicks = discrete ? [...new Set([rows[0].center, Math.round((rows[0].center + rows.at(-1).center) / 2), rows.at(-1).center])]
    .map(value => [x(value), bottom + 18, number(value), 'middle']) : [
      [left, bottom + 18, constant ? '' : coordinate(minimum, (maximum - minimum) / 10), 'start'],
      [(left + right) / 2, bottom + 18, constant ? number(minimum) : coordinate((minimum + maximum) / 2, (maximum - minimum) / 10), 'middle'],
      [right, bottom + 18, constant ? '' : coordinate(maximum, (maximum - minimum) / 10), 'end'],
    ];
  for (const [px, py, text, anchor] of [[left - 5, bottom + 4, '0', 'end'], ...xTicks,
    [(left + right) / 2, 194, `${xLabel}${unit ? ` (${unit})` : ''}`, 'middle'],
  ]) svg.append(svgNode(root, 'text', { x: px, y: py, 'font-size': 10, 'text-anchor': anchor }, text));
  container.append(svg);
  const inspect = node(root, 'label', undefined, 'voronoi-bin-control');
  inspect.append(node(root, 'span', 'Inspect bin'));
  const slider = node(root, 'input', undefined, 'voronoi-bin-slider');
  slider.type = 'range'; slider.min = '0'; slider.max = String(rows.length - 1); slider.step = '1'; slider.value = String(preference.selected);
  slider.setAttribute('aria-label', `${label} bin`); inspect.append(slider); container.append(inspect);
  const readout = node(root, 'output', undefined, 'voronoi-bin-readout'); readout.setAttribute('aria-live', 'polite');
  container.append(readout);
  function select(index) {
    preference.selected = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[preference.selected], [from, to] = bounds(row);
    highlight.setAttribute('x', from); highlight.setAttribute('width', Math.max(.5, to - from));
    slider.value = String(preference.selected);
    const description = discrete ? `${xLabel || 'Value'} ${number(row.center)}` : row.lower === row.upper
      ? `${number(row.lower)}${unit ? ` ${unit}` : ''}` :
        `${coordinate(row.lower, row.upper - row.lower)}–${coordinate(row.upper, row.upper - row.lower)}${unit ? ` ${unit}` : ''}${preference.selected < rows.length - 1 ? ' (upper excluded)' : ''}`;
    readout.textContent = `${description} · ${population(row.count)} samples · ${percent(row.probability)}`;
    readout.title = `Lower: ${row.lower}; upper: ${row.upper}; count: ${row.count}; fraction: ${row.probability}`;
    slider.setAttribute('aria-valuetext', readout.textContent);
  }
  function plot(mode) {
    preference.mode = mode;
    const key = mode === 'probability' ? 'probability' : 'count';
    const highest = Math.max(...rows.map(row => row[key]));
    let path = '';
    for (const row of rows) {
      if (!row.count) continue;
      const [from, to] = bounds(row), height = row[key] / highest * (bottom - top);
      path += `M${from.toFixed(2)},${bottom}v${(-height).toFixed(2)}h${Math.max(.05, to - from).toFixed(2)}v${height.toFixed(2)}z`;
    }
    bars.setAttribute('d', path); yMaximum.textContent = mode === 'probability' ? percent(highest) : population(highest);
    yLabel.textContent = mode === 'probability' ? 'Probability' : 'Count';
    countButton.setAttribute('aria-pressed', String(mode === 'count')); probabilityButton.setAttribute('aria-pressed', String(mode === 'probability'));
    select(preference.selected);
  }
  function inspectPointer(event) {
    const rectangle = svg.getBoundingClientRect?.();
    if (!rectangle?.width || !Number.isFinite(event.clientX)) return;
    const px = (event.clientX - rectangle.left) / rectangle.width * 360;
    if (px < left || px > right) return;
    const value = constant ? minimum : minimum + (px - left) / (right - left) * (maximum - minimum);
    let low = 0, high = rows.length - 1;
    while (low < high) { const middle = (low + high) >> 1; if (rows[middle].upper <= value) low = middle + 1; else high = middle; }
    if (low > 0 && rows[low].lower > value && Math.abs(rows[low - 1].center - value) < Math.abs(rows[low].center - value)) low--;
    select(low);
  }
  countButton.addEventListener('click', () => plot('count')); probabilityButton.addEventListener('click', () => plot('probability'));
  slider.addEventListener('input', () => select(Number(slider.value)));
  svg.addEventListener('pointerdown', inspectPointer);
  svg.addEventListener('pointermove', event => { if (event.pointerType !== 'touch') inspectPointer(event); });
  svg.addEventListener('keydown', event => {
    const next = { ArrowLeft: preference.selected - 1, ArrowRight: preference.selected + 1, Home: 0, End: rows.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); select(next);
  });
  plot(preference.mode);
  const details = node(root, 'details', undefined, 'distribution-values');
  details.append(node(root, 'summary', 'View binned values'));
  const table = node(root, 'div'); let rendered = false;
  details.addEventListener('toggle', () => { if (details.open && !rendered) { rendered = true; histogramTable(table, rows, label, unit); details.append(table); } });
  container.append(details);
}

/** Result presentation has no calculation or renderer ownership. Color buttons
 * use the same Color by entry point as the existing legend. */
export function initializeVoronoiResults({ getElement, chooseProperty = () => {} }) {
  let result = null, enabled = false, topologyRendered = false;
  const $ = getElement;
  function updateControls() {
    for (const [id, property] of Object.entries(QUANTITIES)) if ($(id)) $(id).disabled = !enabled || !result?.[property]?.length;
  }
  for (const [id, property] of Object.entries(QUANTITIES)) $(id)?.addEventListener('click', () => {
    if (enabled && result?.[property]?.length) chooseProperty(property, { manual: true });
  });
  const topologyDetails = $('voronoi-topology-details');
  function renderCompleteTopology() {
    if (!result || topologyRendered || !topologyDetails?.open) return;
    topologyRendered = true;
    renderPopulationTable($('voronoi-index-frequency'), result.indexCounts);
  }
  topologyDetails?.addEventListener('toggle', renderCompleteTopology);
  return {
    setEnabled(value) { enabled = Boolean(value); updateControls(); },
    clear() {
      result = null; topologyRendered = false;
      for (const id of ['voronoi-stat-cards', 'voronoi-topology-populations', 'voronoi-index-frequency', 'voronoi-volume-chart', 'voronoi-coordination-chart', 'voronoi-face-chart']) $(id)?.replaceChildren();
      updateControls();
    },
    render(next) {
      result = next; topologyRendered = false;
      renderCards($('voronoi-stat-cards'), result);
      renderTopologies($('voronoi-topology-populations'), result.indexCounts, result.summary?.atomCount ?? result.atomicVolume?.length ?? 0);
      renderVoronoiHistogram($('voronoi-volume-chart'), result.volumeHistogram, { label: 'Voronoi atomic volumes', xLabel: 'Volume', unit: 'Å³' });
      renderVoronoiHistogram($('voronoi-coordination-chart'), result.coordinationHistogram, { label: 'Voronoi coordination', xLabel: 'Neighbors', discrete: true });
      renderVoronoiHistogram($('voronoi-face-chart'), result.faceAreaHistogram, { label: 'Voronoi neighbor face areas', xLabel: 'Face area', unit: 'Å²' });
      $('voronoi-index-frequency')?.replaceChildren(); renderCompleteTopology(); updateControls();
    },
  };
}
