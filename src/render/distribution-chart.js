const SVG_NS = 'http://www.w3.org/2000/svg';
const number = value => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('en-US', { maximumSignificantDigits: 5 }) : '—';

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

/** SVG bars share one path, keeping even 4,096-bin plots small. The complete
 * numerical table is built only when its disclosure is opened. */
export function renderDistributionChart(container, distribution, {
  label = 'Distribution', xLabel = '', unit = distribution?.unit ?? '',
} = {}) {
  if (!container) return;
  const root = container.ownerDocument ?? document;
  const rows = distributionRows(distribution).filter(row => Number.isFinite(row.lower) && Number.isFinite(row.upper));
  container.replaceChildren();
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!rows.length || !total) {
    container.append(element(root, 'p', 'No qualifying samples.', 'help'));
    return;
  }
  const svg = svgElement(root, 'svg', { viewBox: '0 0 360 200', role: 'img', 'aria-label': `${label}; ${number(total)} samples` });
  svg.append(svgElement(root, 'title', {}, `${label}: raw counts; ${number(total)} samples in ${rows.length} bins.`));
  const left = 40, right = 344, top = 24, bottom = 154;
  const minimum = Math.min(...rows.map(row => row.lower)), maximum = Math.max(...rows.map(row => row.upper));
  const highest = Math.max(1, ...rows.map(row => row.count));
  const constant = maximum === minimum;
  const x = value => constant ? (left + right) / 2 : left + (value - minimum) / (maximum - minimum) * (right - left);
  let path = '';
  for (const row of rows) {
    if (!row.count) continue;
    const from = constant ? left + (right - left) * .25 : x(row.lower);
    const to = constant ? right - (right - left) * .25 : x(row.upper);
    const height = row.count / highest * (bottom - top);
    path += `M${from.toFixed(2)},${bottom}v${(-height).toFixed(2)}h${Math.max(.05, to - from).toFixed(2)}v${height.toFixed(2)}z`;
  }
  svg.append(svgElement(root, 'path', { d: path, class: 'chart-bar' }));
  svg.append(svgElement(root, 'path', { d: `M${left},${top}V${bottom}H${right}`, class: 'chart-axis', fill: 'none' }));
  for (const [px, py, text, anchor] of [
    [left - 5, top + 4, number(highest), 'end'], [left - 5, bottom + 4, '0', 'end'],
    [left, bottom + 18, constant ? '' : number(minimum), 'start'],
    [(left + right) / 2, bottom + 18, constant ? number(minimum) : number((minimum + maximum) / 2), 'middle'],
    [right, bottom + 18, constant ? '' : number(maximum), 'end'],
    [left, 12, 'Count', 'start'], [(left + right) / 2, 194, `${xLabel}${unit ? ` (${unit})` : ''}`, 'middle'],
  ]) svg.append(svgElement(root, 'text', { x: px, y: py, 'font-size': 10, 'text-anchor': anchor }, text));
  container.append(svg);
  const details = element(root, 'details', undefined, 'distribution-values');
  details.append(element(root, 'summary', 'View binned values'));
  let rendered = false;
  details.addEventListener('toggle', () => {
    if (!details.open || rendered) return;
    rendered = true;
    details.append(table(root, ['Lower', 'Upper', 'Count', 'Probability', 'Density'], rows.map(row => [
      number(row.lower), number(row.upper), number(row.count), number(row.probability), number(row.density),
    ]), `${label}${unit ? ` · ${unit}` : ''}`));
  });
  container.append(details);
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
