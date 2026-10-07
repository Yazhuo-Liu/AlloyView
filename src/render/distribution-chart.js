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
// Count/probability mode and the inspected bin survive recalculation.
const chartPreferences = new WeakMap();

/** Accept normalized bond distributions and Voronoi's object-row histograms. */
export function distributionRows(distribution) {
  if (!distribution) return [];
  if (Array.isArray(distribution)) {
    const total = distribution.reduce((sum, row) => sum + Number(row.count || 0), 0);
    return distribution.map(row => {
      const discrete = Number.isFinite(row.value);
      const lower = discrete ? row.value - .5 : Number(row.lower);
      const upper = discrete ? row.value + .5 : Number(row.upper);
      return { lower, upper, center: discrete ? row.value : (lower + upper) / 2,
        count: Number(row.count || 0), probability: row.fraction ?? (total ? row.count / total : 0),
        density: upper > lower ? (row.fraction ?? (total ? row.count / total : 0)) / (upper - lower) : null };
    });
  }
  const counts = distribution.counts ?? [];
  const total = distribution.total ?? Array.from(counts).reduce((sum, count) => sum + count, 0);
  return Array.from(counts, (count, index) => {
    const lower = Number(distribution.edges?.[index] ?? distribution.centers?.[index]);
    const upper = Number(distribution.edges?.[index + 1] ?? distribution.centers?.[index]);
    const probability = Number(distribution.probability?.[index] ?? (total ? count / total : 0));
    return { lower, upper, center: Number(distribution.centers?.[index] ?? (lower + upper) / 2), count,
      probability, density: distribution.density?.[index] ?? (upper > lower ? probability / (upper - lower) : null) };
  });
}

function element(root, tag, text, className) {
  const result = root.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function svgElement(root, tag, attributes, text) {
  const result = root.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, String(value));
  if (text !== undefined) result.textContent = text;
  return result;
}

// Continuous bins also list probability density; integer bins have unit width.
function histogramTable(container, rows, label, unit, { density = true } = {}) {
  const root = container.ownerDocument, pageSize = 50;
  let page = 0;
  function render(focus) {
    const table = element(root, 'table'), head = element(root, 'thead'), headings = element(root, 'tr');
    table.append(element(root, 'caption', `${label}${unit ? ` · ${unit}` : ''}`));
    for (const text of ['Lower', 'Upper', 'Count', 'Probability', ...(density ? ['Density'] : [])]) {
      const th = element(root, 'th', text); th.setAttribute('scope', 'col'); headings.append(th);
    }
    head.append(headings); table.append(head);
    const body = element(root, 'tbody');
    for (const row of rows.slice(page * pageSize, (page + 1) * pageSize)) {
      const tr = element(root, 'tr');
      for (const value of [coordinate(row.lower, row.upper - row.lower), coordinate(row.upper, row.upper - row.lower), population(row.count), percent(row.probability),
        ...(density ? [number(row.density)] : [])]) tr.append(element(root, 'td', value));
      body.append(tr);
    }
    table.append(body); container.replaceChildren(table);
    if (rows.length <= pageSize) return;
    const controls = element(root, 'div', undefined, 'statistics-population-controls');
    const previous = element(root, 'button', 'Previous', 'button button-secondary'), next = element(root, 'button', 'Next', 'button button-secondary');
    previous.type = next.type = 'button'; previous.disabled = page === 0; next.disabled = (page + 1) * pageSize >= rows.length;
    previous.setAttribute('aria-label', `Previous ${label} bins`); next.setAttribute('aria-label', `Next ${label} bins`);
    previous.addEventListener('click', () => { page--; render('previous'); });
    next.addEventListener('click', () => { page++; render('next'); });
    controls.append(previous, element(root, 'span', `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, rows.length)} of ${number(rows.length)}`), next);
    container.append(controls);
    if (focus) (focus === 'next' ? (next.disabled ? previous : next) : (previous.disabled ? next : previous)).focus?.();
  }
  render();
}

function table(root, headings, rows, caption) {
  const output = element(root, 'table');
  if (caption) output.append(element(root, 'caption', caption));
  const head = element(root, 'thead'), headingRow = element(root, 'tr');
  for (const heading of headings) {
    const cell = element(root, 'th', heading); cell.setAttribute('scope', 'col'); headingRow.append(cell);
  }
  head.append(headingRow); output.append(head);
  const body = element(root, 'tbody');
  for (const values of rows) {
    const row = element(root, 'tr');
    for (const value of values) row.append(element(root, 'td', String(value)));
    body.append(row);
  }
  output.append(body);
  return output;
}

/** One SVG path for all bins, a single movable highlight and native slider:
 * chart DOM stays bounded even for thousands of bins. Pointer/touch and keyboard
 * inspection report the original counts rather than rounded plot coordinates. */
export function renderInteractiveHistogram(container, distribution, { label = 'Distribution', xLabel = '', unit = '', discrete = false } = {}) {
  if (!container) return;
  const root = container.ownerDocument ?? document;
  const rows = distributionRows(distribution).filter(row => Number.isFinite(row.lower) && Number.isFinite(row.upper));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  container.replaceChildren();
  if (!rows.length || !total) { container.append(element(root, 'p', 'No qualifying samples.', 'help')); return; }
  // A new chart starts on its most populated bin rather than an empty edge bin.
  let mostPopulated = 0;
  for (let index = 1; index < rows.length; index++) if (rows[index].count > rows[mostPopulated].count) mostPopulated = index;
  const preference = chartPreferences.get(container) ?? { mode: 'count', selected: mostPopulated };
  preference.selected = Math.min(rows.length - 1, preference.selected);
  chartPreferences.set(container, preference);
  const modes = element(root, 'div', undefined, 'chart-modes');
  modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', `${label} vertical axis`);
  const countButton = element(root, 'button', 'Count', 'button button-secondary'), probabilityButton = element(root, 'button', 'Probability', 'button button-secondary');
  countButton.type = probabilityButton.type = 'button';
  modes.append(countButton, probabilityButton); container.append(modes);
  const svg = svgElement(root, 'svg', { viewBox: '0 0 360 200', tabindex: 0, role: 'group', 'aria-label': `${label}; ${population(total)} samples. Use left and right arrows to inspect bins.` });
  svg.append(svgElement(root, 'title', {}, `${label}: ${population(total)} samples in ${rows.length} bins.`));
  const left = 46, right = 344, top = 24, bottom = 154;
  const minimum = Math.min(...rows.map(row => row.lower)), maximum = Math.max(...rows.map(row => row.upper));
  const constant = maximum === minimum;
  const x = value => constant ? (left + right) / 2 : left + (value - minimum) / (maximum - minimum) * (right - left);
  const bounds = row => constant ? [left + (right - left) * .25, right - (right - left) * .25] : [x(row.lower), x(row.upper)];
  const bars = svgElement(root, 'path', { class: 'chart-bar' }), highlight = svgElement(root, 'rect', { class: 'chart-highlight', y: top, height: bottom - top, fill: 'none' });
  svg.append(bars, highlight, svgElement(root, 'path', { d: `M${left},${top}V${bottom}H${right}`, class: 'chart-axis', fill: 'none' }));
  const yMaximum = svgElement(root, 'text', { x: left - 5, y: top + 4, 'font-size': 10, 'text-anchor': 'end' });
  const yLabel = svgElement(root, 'text', { x: left, y: 12, 'font-size': 10, 'text-anchor': 'start' });
  svg.append(yMaximum, yLabel);
  const xTicks = discrete ? [...new Set([rows[0].center, Math.round((rows[0].center + rows.at(-1).center) / 2), rows.at(-1).center])]
    .map(value => [x(value), bottom + 18, number(value), 'middle']) : [
      [left, bottom + 18, constant ? '' : coordinate(minimum, (maximum - minimum) / 10), 'start'],
      [(left + right) / 2, bottom + 18, constant ? number(minimum) : coordinate((minimum + maximum) / 2, (maximum - minimum) / 10), 'middle'],
      [right, bottom + 18, constant ? '' : coordinate(maximum, (maximum - minimum) / 10), 'end'],
    ];
  for (const [px, py, text, anchor] of [[left - 5, bottom + 4, '0', 'end'], ...xTicks,
    [(left + right) / 2, 194, `${xLabel}${unit ? ` (${unit})` : ''}`, 'middle'],
  ]) svg.append(svgElement(root, 'text', { x: px, y: py, 'font-size': 10, 'text-anchor': anchor }, text));
  container.append(svg);
  const inspect = element(root, 'label', undefined, 'chart-inspect-control');
  inspect.append(element(root, 'span', 'Inspect bin'));
  const slider = element(root, 'input', undefined, 'chart-inspect-slider');
  slider.type = 'range'; slider.min = '0'; slider.max = String(rows.length - 1); slider.step = '1'; slider.value = String(preference.selected);
  slider.setAttribute('aria-label', `${label} bin`); inspect.append(slider); container.append(inspect);
  const readout = element(root, 'output', undefined, 'chart-readout'); readout.setAttribute('aria-live', 'polite');
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
  const details = element(root, 'details', undefined, 'distribution-values');
  details.append(element(root, 'summary', 'View binned values'));
  const table = element(root, 'div'); let rendered = false;
  details.addEventListener('toggle', () => { if (details.open && !rendered) { rendered = true; histogramTable(table, rows, label, unit, { density: !discrete }); details.append(table); } });
  container.append(details);
}

/** Bond length and angle distributions share the interactive histogram. */
export function renderDistributionChart(container, distribution, { label = 'Distribution', xLabel = '', unit = distribution?.unit ?? '' } = {}) {
  renderInteractiveHistogram(container, distribution, { label, xLabel, unit });
}

export function renderStatisticsTable(container, statistics, { labels = {}, units = {} } = {}) {
  if (!container) return;
  const root = container.ownerDocument ?? document;
  const rows = Object.entries(statistics ?? {}).map(([name, values]) => [
    `${labels[name] ?? name}${units[name] ? ` (${units[name]})` : ''}`, number(values.count),
    number(values.mean), number(values.stddev), number(values.min), number(values.max),
  ]);
  container.replaceChildren(table(root, ['Quantity', 'Count', 'Mean', 'Std. dev.', 'Min', 'Max'], rows));
}

export function renderPopulationTable(container, entries, { valueKey = 'index', label = 'Index' } = {}) {
  if (!container) return;
  const root = container.ownerDocument ?? document;
  const values = entries ?? [], total = values.reduce((sum, entry) => sum + entry.count, 0);
  const pageSize = 50;
  let page = 0;
  function render(focusDirection) {
    container.replaceChildren(table(root, [label, 'Atoms', 'Fraction'], values.slice(page * pageSize, (page + 1) * pageSize).map(entry => [
      entry[valueKey], number(entry.count), `${number(100 * (entry.fraction ?? (total ? entry.count / total : 0)))}%`,
    ])));
    if (values.length <= pageSize) return;
    const controls = element(root, 'div', undefined, 'statistics-population-controls');
    const previous = element(root, 'button', 'Previous', 'button button-secondary');
    const next = element(root, 'button', 'Next', 'button button-secondary');
    previous.type = next.type = 'button';
    previous.disabled = page === 0; next.disabled = (page + 1) * pageSize >= values.length;
    const range = element(root, 'span', `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, values.length)} of ${number(values.length)}`);
    range.setAttribute('aria-live', 'polite');
    previous.setAttribute('aria-label', `Previous ${label} population page`);
    next.setAttribute('aria-label', `Next ${label} population page`);
    previous.addEventListener('click', () => { page--; render('previous'); });
    next.addEventListener('click', () => { page++; render('next'); });
    controls.append(previous, range, next); container.append(controls);
    if (focusDirection) {
      const target = focusDirection === 'next' ? (next.disabled ? previous : next) : (previous.disabled ? next : previous);
      target.focus?.();
    }
  }
  render();
}
