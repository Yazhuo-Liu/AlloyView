import { colorsByProperty } from './palette.js';
import { binBounds } from '../analysis/spatial-binning.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const AXES = ['a', 'b', 'c'];
const number = (value, digits = 4) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumSignificantDigits: digits }) : '—';
const atoms = value => {
  const rounded = Number.isInteger(value) ? value.toLocaleString('en-US') : number(value, 5);
  return `${rounded} atom${value === 1 ? '' : 's'}`;
};
// The inspected position (reduced coordinates) survives recalculation, so a
// new frame or bin count keeps the same region under inspection.
const chartPreferences = new WeakMap();
let gradientSerial = 0;

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

/** Rounded limits enclosing [minimum, maximum] with a 1, 2, 2.5 or 5 × 10ⁿ
 * step; count-like quantities pass `zero` so their baseline is 0. */
export function niceRange(minimum, maximum, { zero = false } = {}) {
  let low = zero ? Math.min(0, minimum) : minimum, high = zero ? Math.max(0, maximum) : maximum;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1];
  if (high === low) {
    const pad = Math.abs(high) > 0 ? Math.abs(high) * 0.05 : 1;
    if (zero && low === 0) high = 1; else { low -= pad; high += pad; }
    if (zero && low < 0 && minimum >= 0) low = 0;
  }
  const raw = (high - low) / 4, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find(factor => factor * power >= raw * (1 - 1e-12)) * power;
  const lower = Math.floor(low / step + 1e-9) * step, upper = Math.ceil(high / step - 1e-9) * step;
  return [lower, upper > lower ? upper : lower + step];
}

/** Text description shared by the readout and its tooltip. */
export function describeBin(result, index, { valueLabel = 'Value', unit = '' } = {}) {
  const dimensions = result.bins.length;
  const coordinates = dimensions === 1 ? [index] : [Math.floor(index / result.bins[1]), index % result.bins[1]];
  const parts = coordinates.map((bin, dimension) => {
    const bounds = binBounds(result, dimension, bin), axis = AXES[result.axes[dimension]];
    return `${axis} bin ${bin + 1} of ${result.bins[dimension]}: ${number(bounds.lowerLength)}–${number(bounds.upperLength)} Å`;
  });
  const value = result.values[index], skipped = result.skipped?.[index] ?? 0;
  const text = `${parts.join(' · ')} · ${valueLabel} ${Number.isFinite(value) ? `${number(value, 5)}${unit ? ` ${unit}` : ''}` : 'NaN (no finite values)'}`
    + ` · ${atoms(result.counts[index])}${skipped ? ` (${number(skipped, 5)} non-finite skipped)` : ''}`;
  return { coordinates, text };
}

/** One-dimensional profiles draw a step line over bin centers along the cell
 * vector; maps draw one pixel per bin in reduced coordinates with a color bar.
 * Pointer, touch and keyboard inspection report exact bin values. */
export function renderBinningChart(container, result, options = {}) {
  if (!container) return;
  container.replaceChildren();
  if (!result?.values?.length) { container.append(node(container.ownerDocument, 'p', 'No bins.', 'help')); return; }
  if (result.bins.length === 1) renderProfile(container, result, options);
  else renderMap(container, result, options);
}

function finiteRange(values) {
  let minimum = Infinity, maximum = -Infinity;
  for (const value of values) if (Number.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  return minimum <= maximum ? [minimum, maximum] : null;
}

function inspectControl(root, label, count, value) {
  const control = node(root, 'label', undefined, 'chart-inspect-control');
  control.append(node(root, 'span', label));
  const slider = node(root, 'input', undefined, 'chart-inspect-slider');
  slider.type = 'range'; slider.min = '0'; slider.max = String(count - 1); slider.step = '1'; slider.value = String(value);
  slider.setAttribute('aria-label', label); control.append(slider);
  return { control, slider };
}

function renderProfile(container, result, { valueLabel = 'Value', unit = '', zero = false } = {}) {
  const root = container.ownerDocument;
  const bins = result.bins[0], length = result.axisLengths[0], axis = AXES[result.axes[0]];
  const range = finiteRange(result.values);
  const preference = chartPreferences.get(container) ?? {};
  chartPreferences.set(container, preference);
  const left = 52, right = 344, top = 20, bottom = 154;
  const [yLow, yHigh] = range ? niceRange(range[0], range[1], { zero }) : [0, 1];
  const x = distance => left + (length > 0 ? distance / length : 0) * (right - left);
  const y = value => bottom - (value - yLow) / (yHigh - yLow) * (bottom - top);
  const title = `${valueLabel}${unit ? ` (${unit})` : ''}`;
  const svg = svgNode(root, 'svg', { viewBox: '0 0 360 200', tabindex: 0, role: 'group',
    'aria-label': `${title} in ${bins} bins along cell vector ${axis}. Use left and right arrows to inspect bins.` });
  svg.append(svgNode(root, 'title', {}, `${title} in ${bins} slabs along ${axis}, ${number(length)} Å long.`));
  for (const value of [(yLow + yHigh) / 2, yHigh]) svg.append(svgNode(root, 'path', { d: `M${left},${y(value).toFixed(2)}H${right}`, class: 'chart-grid', fill: 'none' }));
  if (yLow < 0 && yHigh > 0) svg.append(svgNode(root, 'path', { d: `M${left},${y(0).toFixed(2)}H${right}`, class: 'chart-reference', fill: 'none' }));
  // A step per bin; bins without a finite value break the line.
  let path = '', open = false;
  for (let index = 0; index < bins; index++) {
    const value = result.values[index];
    if (!Number.isFinite(value)) { open = false; continue; }
    const bounds = binBounds(result, 0, index), py = y(value).toFixed(2);
    path += open ? `V${py}H${x(bounds.upperLength).toFixed(2)}` : `M${x(bounds.lowerLength).toFixed(2)},${py}H${x(bounds.upperLength).toFixed(2)}`;
    open = true;
  }
  const crosshair = svgNode(root, 'path', { class: 'chart-crosshair', fill: 'none' });
  const marker = svgNode(root, 'circle', { class: 'chart-marker', r: 3.5 });
  svg.append(svgNode(root, 'path', { d: path, class: 'chart-line binning-profile-line' }), crosshair, marker,
    svgNode(root, 'path', { d: `M${left},${top}V${bottom}H${right}`, class: 'chart-axis', fill: 'none' }));
  const ticks = [[left - 5, bottom + 4, number(yLow), 'end'], [left - 5, y((yLow + yHigh) / 2) + 4, number((yLow + yHigh) / 2), 'end'],
    [left - 5, y(yHigh) + 4, number(yHigh), 'end'], [left, bottom + 18, '0', 'start'], [(left + right) / 2, bottom + 18, number(length / 2), 'middle'],
    [right, bottom + 18, number(length), 'end'], [left, 12, title, 'start'], [(left + right) / 2, 194, `Distance along ${axis} from the cell origin (Å)`, 'middle']];
  for (const [px, py, text, anchor] of ticks) svg.append(svgNode(root, 'text', { x: px, y: py, 'font-size': 10, 'text-anchor': anchor }, text));
  if (!range) svg.append(svgNode(root, 'text', { x: (left + right) / 2, y: (top + bottom) / 2, 'font-size': 10, 'text-anchor': 'middle' }, 'No bin has a finite value.'));
  container.append(svg);
  const { control, slider } = inspectControl(root, 'Inspect bin', bins, 0);
  container.append(control);
  const readout = node(root, 'output', undefined, 'chart-readout'); readout.setAttribute('aria-live', 'polite');
  container.append(readout);
  let selected = 0;
  function select(index) {
    selected = Math.max(0, Math.min(bins - 1, index));
    const bounds = binBounds(result, 0, selected), value = result.values[selected];
    preference.center = bounds.center;
    const px = x(bounds.centerLength);
    crosshair.setAttribute('d', `M${px.toFixed(2)},${top}V${bottom}`);
    marker.setAttribute('cx', px.toFixed(2));
    marker.setAttribute('cy', (Number.isFinite(value) ? y(value) : bottom).toFixed(2));
    if (marker.style) marker.style.display = Number.isFinite(value) ? '' : 'none';
    slider.value = String(selected);
    const { text } = describeBin(result, selected, { valueLabel, unit });
    readout.textContent = text;
    readout.title = `Reduced ${axis}: ${bounds.lower}–${bounds.upper}; value: ${value}; atoms: ${result.counts[selected]}`;
    slider.setAttribute('aria-valuetext', text);
  }
  function inspectPointer(event) {
    const rectangle = svg.getBoundingClientRect?.();
    if (!rectangle?.width || !Number.isFinite(event.clientX)) return;
    const px = (event.clientX - rectangle.left) / rectangle.width * 360;
    if (px < left || px > right) return;
    select(Math.floor((px - left) / (right - left) * bins));
  }
  slider.addEventListener('input', () => select(Number(slider.value)));
  svg.addEventListener('pointerdown', inspectPointer);
  // Touch scrolling moves the page; a tap still inspects.
  svg.addEventListener('pointermove', event => { if (event.pointerType !== 'touch') inspectPointer(event); });
  svg.addEventListener('keydown', event => {
    const next = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: bins - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); select(next);
  });
  let initial = 0;
  if (Number.isFinite(preference.center)) initial = Math.min(bins - 1, Math.floor(preference.center * bins));
  else if (range) { for (let index = 1; index < bins; index++) if (result.values[index] > result.values[initial] || !Number.isFinite(result.values[initial])) initial = index; }
  select(initial);
  container.append(valuesTable(root, result, { valueLabel, unit }));
}

/** Paged table of bin bounds, values and counts. */
function valuesTable(root, result, { valueLabel, unit }) {
  const details = node(root, 'details', undefined, 'distribution-values');
  details.append(node(root, 'summary', 'View binned values'));
  const holder = node(root, 'div'), pageSize = 50, bins = result.bins[0];
  let page = 0, rendered = false;
  function render() {
    const table = node(root, 'table'), head = node(root, 'thead'), headings = node(root, 'tr');
    for (const text of ['Bin', 'From (Å)', 'To (Å)', `${valueLabel}${unit ? ` (${unit})` : ''}`, 'Atoms']) {
      const cell = node(root, 'th', text); cell.setAttribute('scope', 'col'); headings.append(cell);
    }
    head.append(headings); table.append(head);
    const body = node(root, 'tbody');
    for (let index = page * pageSize; index < Math.min(bins, (page + 1) * pageSize); index++) {
      const bounds = binBounds(result, 0, index), row = node(root, 'tr');
      for (const value of [String(index + 1), number(bounds.lowerLength, 5), number(bounds.upperLength, 5),
        Number.isFinite(result.values[index]) ? number(result.values[index], 5) : 'NaN', number(result.counts[index], 6)]) row.append(node(root, 'td', value));
      body.append(row);
    }
    table.append(body); holder.replaceChildren(table);
    if (bins <= pageSize) return;
    const controls = node(root, 'div', undefined, 'statistics-population-controls');
    const previous = node(root, 'button', 'Previous', 'button button-secondary'), next = node(root, 'button', 'Next', 'button button-secondary');
    previous.type = next.type = 'button'; previous.disabled = page === 0; next.disabled = (page + 1) * pageSize >= bins;
    previous.addEventListener('click', () => { page--; render(); });
    next.addEventListener('click', () => { page++; render(); });
    controls.append(previous, node(root, 'span', `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, bins)} of ${bins}`), next);
    holder.append(controls);
  }
  details.addEventListener('toggle', () => { if (details.open && !rendered) { rendered = true; render(); details.append(holder); } });
  return details;
}

/** Bin colors from an existing scalar palette; NaN bins are gray as for atoms. */
export function binningMapColors(values, scheme = 'viridis') {
  const { colors, legend } = colorsByProperty({ name: 'binning', data: values }, null, scheme);
  return { colors, legend: legend.kind === 'scalar' ? legend : null };
}

function renderMap(container, result, { valueLabel = 'Value', unit = '', scheme = 'viridis' } = {}) {
  const root = container.ownerDocument;
  const [columns, rows] = result.bins, [first, second] = result.axes.map(axis => AXES[axis]);
  const [width, height] = result.axisLengths;
  const preference = chartPreferences.get(container) ?? {};
  chartPreferences.set(container, preference);
  const { colors, legend } = binningMapColors(result.values, scheme);
  const left = 52, right = 344, top = 12, plotWidth = right - left;
  // Keep the cell's proportions within limits that remain readable.
  const plotHeight = Math.round(Math.max(96, Math.min(300, plotWidth * (width > 0 ? height / width : 1))));
  const bottom = top + plotHeight, barTop = bottom + 50, viewHeight = barTop + 26;
  const title = `${valueLabel}${unit ? ` (${unit})` : ''}`;
  const svg = svgNode(root, 'svg', { viewBox: `0 0 360 ${viewHeight}`, tabindex: 0, role: 'group',
    'aria-label': `${title} map: ${columns} bins along ${first} by ${rows} bins along ${second}. Use the arrow keys to inspect bins.` });
  svg.append(svgNode(root, 'title', {}, `${title}: ${columns} × ${rows} bins along ${first} and ${second}.`));
  const canvas = root.createElement('canvas');
  const context = canvas.getContext?.('2d');
  if (context) {
    canvas.width = columns; canvas.height = rows;
    const image = context.createImageData(columns, rows);
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < rows; row++) {
        const bin = column * rows + row, pixel = ((rows - 1 - row) * columns + column) * 4;
        image.data[pixel] = colors[bin * 3]; image.data[pixel + 1] = colors[bin * 3 + 1]; image.data[pixel + 2] = colors[bin * 3 + 2]; image.data[pixel + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    svg.append(svgNode(root, 'image', { x: left, y: top, width: plotWidth, height: plotHeight, preserveAspectRatio: 'none',
      href: canvas.toDataURL('image/png'), class: 'binning-map-image' }));
  }
  const highlight = svgNode(root, 'rect', { class: 'chart-highlight binning-map-highlight', fill: 'none' });
  svg.append(highlight, svgNode(root, 'path', { d: `M${left},${top}V${bottom}H${right}`, class: 'chart-axis', fill: 'none' }));
  const ticks = [[left, bottom + 14, '0', 'start'], [(left + right) / 2, bottom + 14, number(width / 2), 'middle'], [right, bottom + 14, number(width), 'end'],
    [left - 5, bottom, '0', 'end'], [left - 5, top + plotHeight / 2 + 4, number(height / 2), 'end'], [left - 5, top + 8, number(height), 'end'],
    [(left + right) / 2, bottom + 28, `Along ${first} from the cell origin (Å)`, 'middle']];
  for (const [px, py, text, anchor] of ticks) svg.append(svgNode(root, 'text', { x: px, y: py, 'font-size': 10, 'text-anchor': anchor }, text));
  const middle = top + plotHeight / 2;
  svg.append(svgNode(root, 'text', { x: 12, y: middle, 'font-size': 10, 'text-anchor': 'middle', transform: `rotate(-90 12 ${middle})` }, `Along ${second} (Å)`));
  if (legend) {
    const id = `binning-gradient-${++gradientSerial}`;
    const gradient = svgNode(root, 'linearGradient', { id, x1: 0, x2: 1, y1: 0, y2: 0 });
    for (const [position, red, green, blue] of legend.colorStops) gradient.append(svgNode(root, 'stop', { offset: position, 'stop-color': `rgb(${red},${green},${blue})` }));
    const defs = svgNode(root, 'defs', {}); defs.append(gradient); svg.append(defs);
    svg.append(svgNode(root, 'rect', { x: left, y: barTop, width: plotWidth, height: 10, fill: `url(#${id})`, class: 'binning-colorbar' }));
    for (const [px, text, anchor] of [[left, number(legend.minimum), 'start'], [(left + right) / 2, number((legend.minimum + legend.maximum) / 2), 'middle'],
      [right, number(legend.maximum), 'end']]) svg.append(svgNode(root, 'text', { x: px, y: barTop + 22, 'font-size': 10, 'text-anchor': anchor }, text));
    svg.append(svgNode(root, 'text', { x: left, y: barTop - 5, 'font-size': 10, 'text-anchor': 'start' }, title));
  } else svg.append(svgNode(root, 'text', { x: (left + right) / 2, y: barTop + 10, 'font-size': 10, 'text-anchor': 'middle' }, 'No bin has a finite value; gray bins are NaN.'));
  container.append(svg);
  const firstControl = inspectControl(root, `Inspect ${first}`, columns, 0), secondControl = inspectControl(root, `Inspect ${second}`, rows, 0);
  container.append(firstControl.control, secondControl.control);
  const readout = node(root, 'output', undefined, 'chart-readout'); readout.setAttribute('aria-live', 'polite');
  container.append(readout);
  let column = 0, row = 0;
  function select(nextColumn, nextRow) {
    column = Math.max(0, Math.min(columns - 1, nextColumn)); row = Math.max(0, Math.min(rows - 1, nextRow));
    preference.center = [(column + 0.5) / columns, (row + 0.5) / rows];
    highlight.setAttribute('x', (left + column / columns * plotWidth).toFixed(2));
    highlight.setAttribute('y', (top + (rows - 1 - row) / rows * plotHeight).toFixed(2));
    highlight.setAttribute('width', Math.max(1, plotWidth / columns).toFixed(2));
    highlight.setAttribute('height', Math.max(1, plotHeight / rows).toFixed(2));
    firstControl.slider.value = String(column); secondControl.slider.value = String(row);
    const bin = column * rows + row, { text } = describeBin(result, bin, { valueLabel, unit });
    readout.textContent = text;
    readout.title = `Reduced ${first}: ${column / columns}–${(column + 1) / columns}; reduced ${second}: ${row / rows}–${(row + 1) / rows}; value: ${result.values[bin]}; atoms: ${result.counts[bin]}`;
    firstControl.slider.setAttribute('aria-valuetext', text); secondControl.slider.setAttribute('aria-valuetext', text);
  }
  function inspectPointer(event) {
    const rectangle = svg.getBoundingClientRect?.();
    if (!rectangle?.width || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const px = (event.clientX - rectangle.left) / rectangle.width * 360, py = (event.clientY - rectangle.top) / rectangle.height * viewHeight;
    if (px < left || px > right || py < top || py > bottom) return;
    select(Math.floor((px - left) / plotWidth * columns), rows - 1 - Math.floor((py - top) / plotHeight * rows));
  }
  firstControl.slider.addEventListener('input', () => select(Number(firstControl.slider.value), row));
  secondControl.slider.addEventListener('input', () => select(column, Number(secondControl.slider.value)));
  svg.addEventListener('pointerdown', inspectPointer);
  svg.addEventListener('pointermove', event => { if (event.pointerType !== 'touch') inspectPointer(event); });
  svg.addEventListener('keydown', event => {
    const next = { ArrowLeft: [column - 1, row], ArrowRight: [column + 1, row], ArrowUp: [column, row + 1], ArrowDown: [column, row - 1],
      Home: [0, 0], End: [columns - 1, rows - 1] }[event.key];
    if (!next) return;
    event.preventDefault(); select(...next);
  });
  const [centerColumn, centerRow] = Array.isArray(preference.center) ? preference.center : [0.5, 0.5];
  select(Math.min(columns - 1, Math.floor(centerColumn * columns)), Math.min(rows - 1, Math.floor(centerRow * rows)));
}
