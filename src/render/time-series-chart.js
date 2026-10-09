import { niceRange } from './binning-chart.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const number = (value, digits = 5) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumSignificantDigits: digits }) : '—';
// The inspected frame survives redraws while values arrive.
const chartPreferences = new WeakMap();

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

/** Series sharing a unit share a panel; different units never share a y
 * axis (one panel each), so no chart has two y scales. */
export function timeSeriesPanels(series, { separatePanels = false } = {}) {
  const panels = [];
  for (const item of series) {
    const panel = separatePanels ? null : panels.find(entry => entry.unit === item.unit);
    if (panel) panel.series.push(item);
    else panels.push({ unit: item.unit, series: [item] });
  }
  return panels;
}

/**
 * data: { axis: { label, values }, frames: [frameIndex], series: [{ name, unit, slot, values }] }.
 * values[i] belongs to frames[i]; undefined marks a missing point, drawn as
 * a gap. One crosshair spans every panel; pointer, touch and keyboard
 * inspection report every series at the chosen frame.
 */
export function renderTimeSeriesChart(container, data, { separatePanels = false } = {}) {
  if (!container) return;
  const root = container.ownerDocument;
  container.replaceChildren();
  const frames = data?.frames ?? [], xs = data?.axis?.values ?? [], series = data?.series ?? [];
  if (!frames.length || !series.length) { container.append(node(root, 'p', series.length ? 'Choose a frame range.' : 'Add an attribute to plot.', 'help')); return; }
  const preference = chartPreferences.get(container) ?? {};
  chartPreferences.set(container, preference);
  let xMin = Infinity, xMax = -Infinity;
  for (const value of xs) if (Number.isFinite(value)) { xMin = Math.min(xMin, value); xMax = Math.max(xMax, value); }
  if (!(xMax > xMin)) { xMin -= 1; xMax += 1; }
  const left = 56, right = 344, top = 22, bottom = 118, height = 150;
  const x = value => left + (value - xMin) / (xMax - xMin) * (right - left);
  const panels = timeSeriesPanels(series, { separatePanels });
  const crosshairs = [], markers = [];
  const legend = node(root, 'ul', undefined, 'time-series-legend');
  for (const item of series) {
    const count = item.values.reduce((sum, value) => sum + Number(Number.isFinite(value)), 0);
    const entry = node(root, 'li');
    entry.append(node(root, 'span', undefined, `series-key series-${item.slot}`), node(root, 'span', item.name, 'time-series-name'),
      node(root, 'span', `${item.unit ? `${item.unit} · ` : ''}${count.toLocaleString('en-US')} / ${frames.length.toLocaleString('en-US')} frames`, 'time-series-count'));
    entry.title = count < frames.length ? `${frames.length - count} frames in the range have no value yet.` : 'Every frame in the range has a value.';
    legend.append(entry);
  }
  container.append(legend);
  const svgs = [];
  for (const panel of panels) {
    let minimum = Infinity, maximum = -Infinity;
    for (const item of panel.series) for (const value of item.values) if (Number.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    const [yLow, yHigh] = minimum <= maximum ? niceRange(minimum, maximum) : [0, 1];
    const y = value => bottom - (value - yLow) / (yHigh - yLow) * (bottom - top);
    const title = panel.series.length === 1 ? `${panel.series[0].name}${panel.unit ? ` (${panel.unit})` : ''}` : panel.unit ? `Values (${panel.unit})` : 'Values';
    const svg = svgNode(root, 'svg', { viewBox: `0 0 360 ${height}`, tabindex: 0, role: 'group',
      'aria-label': `${title} versus ${data.axis.label.toLowerCase()} for ${frames.length} frames. Use left and right arrows to inspect frames.` });
    svg.append(svgNode(root, 'title', {}, `${panel.series.map(item => item.name).join(', ')} versus ${data.axis.label.toLowerCase()}.`));
    for (const value of [(yLow + yHigh) / 2, yHigh]) svg.append(svgNode(root, 'path', { d: `M${left},${y(value).toFixed(2)}H${right}`, class: 'chart-grid', fill: 'none' }));
    if (yLow < 0 && yHigh > 0) svg.append(svgNode(root, 'path', { d: `M${left},${y(0).toFixed(2)}H${right}`, class: 'chart-reference', fill: 'none' }));
    const crosshair = svgNode(root, 'path', { class: 'chart-crosshair', fill: 'none' });
    svg.append(crosshair); crosshairs.push(crosshair);
    for (const item of panel.series) {
      let path = '', open = false, points = 0;
      const dots = [];
      item.values.forEach((value, index) => {
        if (!Number.isFinite(value) || !Number.isFinite(xs[index])) { open = false; return; }
        const px = x(xs[index]).toFixed(2), py = y(value).toFixed(2);
        path += `${open ? 'L' : 'M'}${px},${py}`; open = true; points++;
        const isolated = !Number.isFinite(item.values[index - 1]) && !Number.isFinite(item.values[index + 1]);
        if (isolated || frames.length <= 30) dots.push(svgNode(root, 'circle', { cx: px, cy: py, r: 2.25, class: `series-dot series-${item.slot}` }));
      });
      svg.append(svgNode(root, 'path', { d: path || 'M0,0', class: `series-line series-${item.slot}`, fill: 'none',
        'data-series': item.name, 'data-point-count': points }), ...dots);
      const marker = svgNode(root, 'circle', { r: 4, class: `chart-marker series-marker series-${item.slot}` });
      marker.style.display = 'none';
      svg.append(marker); markers.push({ marker, item, y });
    }
    svg.append(svgNode(root, 'path', { d: `M${left},${top}V${bottom}H${right}`, class: 'chart-axis', fill: 'none' }));
    const ticks = [[left - 5, bottom + 4, number(yLow, 4), 'end'], [left - 5, y((yLow + yHigh) / 2) + 4, number((yLow + yHigh) / 2, 4), 'end'],
      [left - 5, y(yHigh) + 4, number(yHigh, 4), 'end'], [left, bottom + 16, number(xMin, 6), 'start'],
      [right, bottom + 16, number(xMax, 6), 'end'], [left, 13, title, 'start'], [(left + right) / 2, bottom + 30, data.axis.label, 'middle']];
    for (const [px, py, text, anchor] of ticks) svg.append(svgNode(root, 'text', { x: px, y: py, 'font-size': 10, 'text-anchor': anchor }, text));
    if (!(minimum <= maximum)) svg.append(svgNode(root, 'text', { x: (left + right) / 2, y: (top + bottom) / 2, 'font-size': 10, 'text-anchor': 'middle' }, 'No values collected yet.'));
    container.append(svg); svgs.push(svg);
  }

  const inspect = node(root, 'label', undefined, 'chart-inspect-control');
  inspect.append(node(root, 'span', 'Inspect frame'));
  const slider = node(root, 'input', undefined, 'chart-inspect-slider');
  slider.type = 'range'; slider.min = '0'; slider.max = String(frames.length - 1); slider.step = '1';
  slider.setAttribute('aria-label', 'Time series frame'); inspect.append(slider); container.append(inspect);
  const readout = node(root, 'output', undefined, 'chart-readout time-series-readout'); readout.setAttribute('aria-live', 'polite');
  container.append(readout);
  let selected = 0;
  function select(index) {
    selected = Math.max(0, Math.min(frames.length - 1, index));
    preference.frame = frames[selected];
    const px = Number.isFinite(xs[selected]) ? x(xs[selected]) : left;
    for (const crosshair of crosshairs) crosshair.setAttribute('d', `M${px.toFixed(2)},${top}V${bottom}`);
    for (const { marker, item, y } of markers) {
      const value = item.values[selected];
      marker.style.display = Number.isFinite(value) ? '' : 'none';
      if (Number.isFinite(value)) { marker.setAttribute('cx', px.toFixed(2)); marker.setAttribute('cy', y(value).toFixed(2)); }
    }
    slider.value = String(selected);
    const heading = data.axis.kind === 'timestep' ? `Timestep ${xs[selected]} (frame ${frames[selected] + 1})` : `Frame ${frames[selected] + 1}`;
    const rows = series.map(item => {
      const value = item.values[selected], row = node(root, 'span', undefined, 'time-series-reading');
      row.append(node(root, 'span', undefined, `series-key series-${item.slot}`),
        node(root, 'strong', Number.isFinite(value) ? `${number(value, 6)}${item.unit ? ` ${item.unit}` : ''}` : 'missing'), node(root, 'span', ` ${item.name}`));
      return row;
    });
    readout.replaceChildren(node(root, 'span', heading, 'time-series-reading-heading'), ...rows);
    readout.title = series.map(item => `${item.name}: ${item.values[selected] ?? 'missing'}`).join('\n');
    slider.setAttribute('aria-valuetext', `${heading}: ${series.map(item => `${item.name} ${Number.isFinite(item.values[selected]) ? item.values[selected] : 'missing'}`).join(', ')}`);
  }
  function inspectPointer(event, svg) {
    const rectangle = svg.getBoundingClientRect?.();
    if (!rectangle?.width || !Number.isFinite(event.clientX)) return;
    const px = (event.clientX - rectangle.left) / rectangle.width * 360;
    if (px < left - 8 || px > right + 8) return;
    const target = xMin + (Math.max(left, Math.min(right, px)) - left) / (right - left) * (xMax - xMin);
    let best = 0;
    for (let index = 1; index < xs.length; index++) if (Math.abs(xs[index] - target) < Math.abs(xs[best] - target)) best = index;
    select(best);
  }
  slider.addEventListener('input', () => select(Number(slider.value)));
  for (const svg of svgs) {
    svg.addEventListener('pointerdown', event => inspectPointer(event, svg));
    // Touch scrolling should move the page, not scrub the plot.
    svg.addEventListener('pointermove', event => { if (event.pointerType !== 'touch') inspectPointer(event, svg); });
    svg.addEventListener('keydown', event => {
      const next = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: frames.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault(); select(next);
    });
  }
  const remembered = frames.indexOf(preference.frame);
  select(remembered >= 0 ? remembered : frames.length - 1);
}
