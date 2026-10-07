const SVG_NS = 'http://www.w3.org/2000/svg';
const number = (value, digits = 4) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumSignificantDigits: digits }) : '—';
const population = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '—';
// The inspected radius survives recalculation, so changing bins or a type
// pair keeps the same shell under inspection instead of a stale bin index.
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

/** The smallest 1, 2, 2.5 or 5 × 10ⁿ at or above a positive value. */
export function niceCeiling(value) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].find(step => step * power >= value * (1 - 1e-12)) * power;
}

/** One SVG path for every bin, plus a single movable crosshair and native
 * slider, as in the Voronoi histograms. Pointer, touch and keyboard inspection
 * report the exact bin edges, g(r) and raw directed pair count. */
export function renderRdfChart(container, result) {
  if (!container) return;
  const root = container.ownerDocument;
  container.replaceChildren();
  const radii = result?.radii ?? [], values = result?.values ?? [], bins = radii.length;
  if (!bins) { container.append(node(root, 'p', 'No RDF bins.', 'help')); return; }
  // Bins are uniform from zero; their centers recover the range if a result
  // lacks its normalization record.
  const cutoff = result.normalization?.cutoff ?? (bins > 1 ? radii.at(-1) + (radii[1] - radii[0]) / 2 : 2 * radii[0]);
  const width = cutoff / bins;
  let peak = 0;
  for (let index = 1; index < bins; index++) if (values[index] > values[peak]) peak = index;
  const preference = chartPreferences.get(container) ?? { radius: radii[peak] };
  chartPreferences.set(container, preference);

  const left = 40, right = 344, top = 20, bottom = 154;
  const yTop = niceCeiling(Math.max(1, values[peak]));
  const x = radius => left + radius / cutoff * (right - left);
  const y = value => bottom - Math.max(0, value) / yTop * (bottom - top);
  const svg = svgNode(root, 'svg', { viewBox: '0 0 360 200', tabindex: 0, role: 'group',
    'aria-label': `Radial distribution function g(r) to ${number(cutoff)} Å in ${bins} bins. Use left and right arrows to inspect bins.` });
  svg.append(svgNode(root, 'title', {}, `g(r): ${bins} bins to ${number(cutoff)} Å; highest peak ${number(values[peak])} at ${number(radii[peak])} Å.`));
  for (const value of [yTop / 2, yTop]) {
    svg.append(svgNode(root, 'path', { d: `M${left},${y(value).toFixed(2)}H${right}`, class: 'chart-grid', fill: 'none' }));
  }
  // g(r) = 1 is the uncorrelated (ideal-gas) reference for every pair type.
  svg.append(svgNode(root, 'path', { d: `M${left},${y(1).toFixed(2)}H${right}`, class: 'chart-reference', fill: 'none' }));
  let path = '';
  for (let index = 0; index < bins; index++) path += `${index ? 'L' : 'M'}${x(radii[index]).toFixed(2)},${y(values[index]).toFixed(2)}`;
  const crosshair = svgNode(root, 'path', { class: 'chart-crosshair', fill: 'none' });
  const marker = svgNode(root, 'circle', { class: 'chart-marker', r: 3.5 });
  svg.append(svgNode(root, 'path', { d: path, class: 'chart-line' }), crosshair, marker,
    svgNode(root, 'path', { d: `M${left},${top}V${bottom}H${right}`, class: 'chart-axis', fill: 'none' }));
  const ticks = [[left - 5, bottom + 4, '0', 'end'], [left - 5, y(yTop / 2) + 4, number(yTop / 2), 'end'],
    [left - 5, y(yTop) + 4, number(yTop), 'end'], [left, bottom + 18, '0', 'start'],
    [(left + right) / 2, bottom + 18, number(cutoff / 2), 'middle'], [right, bottom + 18, number(cutoff), 'end'],
    [left, 12, 'g(r)', 'start'], [(left + right) / 2, 194, 'r (Å)', 'middle']];
  // Label the reference only where it does not collide with an axis tick.
  if (Math.abs(y(1) - y(yTop / 2)) > 10 && Math.abs(y(1) - bottom) > 10) ticks.push([left - 5, y(1) + 4, '1', 'end']);
  for (const [px, py, text, anchor] of ticks) svg.append(svgNode(root, 'text', { x: px, y: py, 'font-size': 10, 'text-anchor': anchor }, text));
  container.append(svg);

  const inspect = node(root, 'label', undefined, 'chart-inspect-control');
  inspect.append(node(root, 'span', 'Inspect radius'));
  const slider = node(root, 'input', undefined, 'chart-inspect-slider');
  slider.type = 'range'; slider.min = '0'; slider.max = String(bins - 1); slider.step = '1';
  slider.setAttribute('aria-label', 'g(r) bin'); inspect.append(slider); container.append(inspect);
  const readout = node(root, 'output', undefined, 'chart-readout'); readout.setAttribute('aria-live', 'polite');
  container.append(readout);
  let selected = 0;
  function select(index) {
    selected = Math.max(0, Math.min(bins - 1, index));
    preference.radius = radii[selected];
    const px = x(radii[selected]), py = y(values[selected]);
    crosshair.setAttribute('d', `M${px.toFixed(2)},${top}V${bottom}`);
    marker.setAttribute('cx', px.toFixed(2)); marker.setAttribute('cy', py.toFixed(2));
    slider.value = String(selected);
    const lower = selected * width, upper = (selected + 1) * width, count = result.counts?.[selected];
    readout.textContent = `r = ${number(radii[selected])} Å (${number(lower)}–${number(upper)} Å) · g(r) = ${number(values[selected])}`
      + (count === undefined ? '' : ` · ${population(count)} pairs`);
    readout.title = `Lower: ${lower}; upper: ${upper}; center: ${radii[selected]}; g(r): ${values[selected]}${count === undefined ? '' : `; directed pairs: ${count}`}`;
    slider.setAttribute('aria-valuetext', readout.textContent);
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
  // Touch scrolling should move the page, not scrub the plot.
  svg.addEventListener('pointermove', event => { if (event.pointerType !== 'touch') inspectPointer(event); });
  svg.addEventListener('keydown', event => {
    const next = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: bins - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); select(next);
  });
  select(Number.isFinite(preference.radius) && preference.radius < cutoff ? Math.floor(preference.radius / width) : peak);
}
