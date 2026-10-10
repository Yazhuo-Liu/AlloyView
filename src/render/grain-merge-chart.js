const SVG_NS = 'http://www.w3.org/2000/svg';
const number = (value, digits = 4) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumSignificantDigits: digits }) : '—';
const integer = value => Number(value).toLocaleString('en-US');

/** Points drawn at most; the largest distances, where grains meet, are all kept. */
export const GRAIN_CHART_MAX_POINTS = 12_000;
const GRAIN_CHART_KEPT_TAIL = 2_000;

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

/** Indices of the points to draw, ascending. Points arrive sorted by
 * distance, so a uniform stride thins the dense small merges. */
export function grainChartPoints(count, maximum = GRAIN_CHART_MAX_POINTS, tail = GRAIN_CHART_KEPT_TAIL) {
  if (count <= maximum) return Uint32Array.from({ length: count }, (_, index) => index);
  const head = count - tail, slots = maximum - tail, indices = new Uint32Array(maximum);
  for (let slot = 0; slot < slots; slot += 1) indices[slot] = Math.floor(slot * head / slots);
  for (let slot = 0; slot < tail; slot += 1) indices[slots + slot] = head + slot;
  return indices;
}

/**
 * Scatter of merge distance against merge size (the smaller of the two merged
 * clusters, on a logarithmic axis) with the applied threshold as a vertical
 * line. Merges at or below the threshold were applied and join atoms of one
 * grain; those beyond it would join different grains. The two groups differ
 * in color and lie on opposite sides of the line, and a legend names them.
 * Pointer and keyboard inspection report one merge. With `onSelect`, clicking
 * the plot reports the distance under the pointer as a new threshold.
 *
 * plot: { distance, size, unit: 'log' | 'degrees' }, sorted by distance.
 */
export function renderGrainMergeChart(container, plot, { threshold = null, onSelect = null } = {}) {
  if (!container) return;
  const root = container.ownerDocument;
  container.replaceChildren();
  const total = plot?.distance?.length ?? 0;
  if (!total) {
    container.append(node(root, 'p', 'No merges of clusters with at least 20 atoms: the structure has no crystalline region of that size.', 'help'));
    return;
  }
  const degrees = plot.unit === 'degrees', quantity = degrees ? 'Disorientation' : 'Log merge distance', unit = degrees ? '°' : '';
  const shown = grainChartPoints(total), points = shown.length;
  const marked = Number.isFinite(threshold);
  let low = Infinity, high = -Infinity, largest = 0, smallest = Infinity;
  for (let index = 0; index < total; index += 1) {
    low = Math.min(low, plot.distance[index]); high = Math.max(high, plot.distance[index]);
    largest = Math.max(largest, plot.size[index]); smallest = Math.min(smallest, plot.size[index]);
  }
  if (marked) { low = Math.min(low, threshold); high = Math.max(high, threshold); }
  if (!(high > low)) { low -= .5; high += .5; }
  const span = high - low;
  low -= span * .04; high += span * .04;
  const sizeLow = Math.floor(Math.log10(Math.max(1, smallest))), sizeHigh = Math.max(sizeLow + 1, Math.ceil(Math.log10(largest) - 1e-9));
  const left = 44, right = 344, top = 20, bottom = 154;
  const x = value => left + (value - low) / (high - low) * (right - left);
  const y = size => bottom - (Math.log10(size) - sizeLow) / (sizeHigh - sizeLow) * (bottom - top);
  const applied = marked ? Array.from(shown).filter(index => plot.distance[index] <= threshold).length : points;
  const appliedTotal = marked ? Array.from(plot.distance).filter(value => value <= threshold).length : total;
  const svg = svgNode(root, 'svg', { viewBox: '0 0 360 200', tabindex: 0, role: 'group',
    'aria-label': `${quantity} against merge size for ${integer(total)} merges${marked ? `; threshold ${number(threshold)}${unit}` : ''}. Use left and right arrows to inspect merges.` });
  svg.append(svgNode(root, 'title', {}, `${integer(appliedTotal)} merges at or below the threshold, ${integer(total - appliedTotal)} above it.`));
  for (let decade = Math.ceil(sizeLow); decade <= sizeHigh; decade += 1) {
    svg.append(svgNode(root, 'path', { d: `M${left},${y(10 ** decade).toFixed(2)}H${right}`, class: 'chart-grid', fill: 'none' }));
  }
  // One path per group; a zero-length segment with a round cap draws a dot.
  const paths = ['', ''];
  for (let slot = 0; slot < points; slot += 1) {
    const index = shown[slot];
    paths[slot < applied ? 0 : 1] += `M${x(plot.distance[index]).toFixed(1)},${y(plot.size[index]).toFixed(1)}h0`;
  }
  if (paths[0]) svg.append(svgNode(root, 'path', { d: paths[0], class: 'chart-points', fill: 'none' }));
  if (paths[1]) svg.append(svgNode(root, 'path', { d: paths[1], class: 'chart-points chart-points-rejected', fill: 'none' }));
  if (marked) svg.append(svgNode(root, 'path', { d: `M${x(threshold).toFixed(2)},${top}V${bottom}`, class: 'chart-threshold', fill: 'none' }));
  const crosshair = svgNode(root, 'path', { class: 'chart-crosshair', fill: 'none' });
  const marker = svgNode(root, 'circle', { class: 'chart-marker', r: 3.5 });
  svg.append(crosshair, marker, svgNode(root, 'path', { d: `M${left},${top}V${bottom}H${right}`, class: 'chart-axis', fill: 'none' }));
  const ticks = [[left, bottom + 18, number(low, 3), 'start'], [(left + right) / 2, bottom + 18, number((low + high) / 2, 3), 'middle'],
    [right, bottom + 18, number(high, 3), 'end'], [left, 12, 'Merge size (atoms)', 'start'],
    [(left + right) / 2, 194, degrees ? 'Disorientation (°)' : 'Log merge distance', 'middle']];
  for (let decade = Math.ceil(sizeLow); decade <= sizeHigh; decade += 1) ticks.push([left - 5, y(10 ** decade) + 4, integer(10 ** decade), 'end']);
  if (marked) {
    // The label sits on the side of the line with more room.
    const px = x(threshold), onLeft = px > (left + right) / 2;
    ticks.push([px + (onLeft ? -4 : 4), top + 8, `Threshold ${number(threshold)}${unit}`, onLeft ? 'end' : 'start']);
  }
  for (const [px, py, text, anchor] of ticks) svg.append(svgNode(root, 'text', { x: px, y: py, 'font-size': 10, 'text-anchor': anchor }, text));
  container.append(svg);

  if (marked) {
    const legend = node(root, 'p', undefined, 'chart-legend');
    for (const [className, label] of [['chart-key', `Merged into grains (${integer(appliedTotal)})`],
      ['chart-key chart-key-rejected', `Not merged (${integer(total - appliedTotal)})`]]) {
      const entry = node(root, 'span'), key = node(root, 'i', undefined, className);
      entry.append(key, node(root, 'span', label));
      legend.append(entry);
    }
    container.append(legend);
  }
  const readout = node(root, 'output', undefined, 'chart-readout'); readout.setAttribute('aria-live', 'polite');
  container.append(readout);
  let selected = 0;
  function select(slot) {
    selected = Math.max(0, Math.min(points - 1, slot));
    const index = shown[selected], px = x(plot.distance[index]), py = y(plot.size[index]);
    crosshair.setAttribute('d', `M${px.toFixed(2)},${top}V${bottom}`);
    marker.setAttribute('cx', px.toFixed(2)); marker.setAttribute('cy', py.toFixed(2));
    readout.textContent = `${quantity} ${number(plot.distance[index], 6)}${unit} · merge size ${integer(plot.size[index])} atoms`
      + (marked ? ` · ${plot.distance[index] <= threshold ? 'merged' : 'not merged'}` : '')
      + (points < total ? ` · showing ${integer(points)} of ${integer(total)} merges` : '');
    readout.title = `Distance: ${plot.distance[index]}; size of the smaller merged cluster: ${plot.size[index]}`;
  }
  /** The drawn point nearest to the pointer, in plot pixels. */
  function nearest(event) {
    const rectangle = svg.getBoundingClientRect?.();
    if (!rectangle?.width || !Number.isFinite(event.clientX)) return null;
    const scale = 360 / rectangle.width, px = (event.clientX - rectangle.left) * scale;
    if (px < left || px > right) return null;
    const py = Number.isFinite(event.clientY) && rectangle.height ? (event.clientY - rectangle.top) * (200 / rectangle.height) : null;
    let best = 0, distance = Infinity;
    for (let slot = 0; slot < points; slot += 1) {
      const dx = x(plot.distance[shown[slot]]) - px, dy = py === null ? 0 : y(plot.size[shown[slot]]) - py, d = dx * dx + dy * dy;
      if (d < distance) { distance = d; best = slot; }
    }
    return { slot: best, value: low + (px - left) / (right - left) * (high - low) };
  }
  svg.addEventListener('pointerdown', event => { const hit = nearest(event); if (hit) select(hit.slot); });
  // Touch scrolling should move the page, not scrub the plot.
  svg.addEventListener('pointermove', event => { if (event.pointerType !== 'touch') { const hit = nearest(event); if (hit) select(hit.slot); } });
  if (onSelect) svg.addEventListener('click', event => { const hit = nearest(event); if (hit) onSelect(hit.value); });
  svg.addEventListener('keydown', event => {
    const next = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: points - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); select(next);
  });
  // Start at the last applied merge, the one that sets the grain structure.
  select(marked ? Math.max(0, applied - 1) : points - 1);
}
