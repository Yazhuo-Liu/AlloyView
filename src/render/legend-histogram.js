const SVG_NS = 'http://www.w3.org/2000/svg';
export const LEGEND_HISTOGRAM_BINS = 48;
// Legends re-render on every color edit and playback frame; the histogram
// depends only on the data array and the displayed range.
const cache = new WeakMap();

// Integer properties with at most this many values in range get one band per
// integer, so the probe never reports the empty gaps between integers.
const MAXIMUM_INTEGER_BANDS = 64;

/** Counts of finite values per band of [minimum, maximum], plus the finite
 * values outside that range. Integer data uses one band per integer value. */
export function scalarLegendHistogram(data, minimum, maximum, bins = LEGEND_HISTOGRAM_BINS) {
  const cached = cache.get(data);
  if (cached && cached.minimum === minimum && cached.maximum === maximum && cached.bins === bins) return cached;
  const span = maximum - minimum, first = Math.ceil(minimum), last = Math.floor(maximum);
  // Count both band layouts in one pass; integer bands are kept only if every
  // in-range value is an integer and few enough values are possible.
  const integerCandidate = last >= first && last - first < MAXIMUM_INTEGER_BANDS;
  const bands = new Uint32Array(bins), integers = integerCandidate ? new Uint32Array(last - first + 1) : null;
  let below = 0, above = 0, integer = integerCandidate;
  for (const value of data) {
    if (!Number.isFinite(value)) continue;
    if (value < minimum) { below++; continue; }
    if (value > maximum) { above++; continue; }
    bands[span > 0 ? Math.min(bins - 1, Math.floor((value - minimum) / span * bins)) : 0]++;
    if (integer) { if (Number.isInteger(value)) integers[value - first]++; else integer = false; }
  }
  const counts = integer ? integers : bands;
  let peak = 0;
  for (const count of counts) peak = Math.max(peak, count);
  const result = { minimum, maximum, bins, counts, below, above, peak, integer, first };
  if (data && typeof data === 'object') cache.set(data, result);
  return result;
}

/** A faint per-band histogram behind the color gradient and a hover/tap probe
 * reporting the value under the pointer and how many atoms share its band. */
export function createLegendScale(root, legend, { format = String, histogram: showHistogram = true } = {}) {
  const scale = root.createElement('div');
  scale.className = 'legend-scale';
  const { minimum, maximum } = legend, span = maximum - minimum;
  const position = value => span > 0 ? (value - minimum) / span : 0.5;
  const histogram = showHistogram && legend.property?.data ? scalarLegendHistogram(legend.property.data, minimum, maximum) : null;
  if (histogram?.peak) {
    const svg = root.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'legend-histogram'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', '0 0 1000 1'); svg.setAttribute('preserveAspectRatio', 'none');
    // Integer bands are narrow bars centered on their values.
    const integerWidth = Math.max(6, Math.min(40, 600 / Math.max(1, span)));
    let path = '';
    histogram.counts.forEach((count, index) => {
      if (!count) return;
      // End bars stay within the gradient instead of straddling its edges.
      const from = histogram.integer ? Math.max(0, Math.min(1000 - integerWidth, position(histogram.first + index) * 1000 - integerWidth / 2))
        : index * 1000 / histogram.counts.length;
      const width = histogram.integer ? integerWidth : 1000 / histogram.counts.length;
      // Square-root heights keep sparse bands visible next to a dominant peak.
      path += `M${from.toFixed(2)},1V${(1 - Math.sqrt(count / histogram.peak)).toFixed(4)}h${width.toFixed(2)}V1z`;
    });
    const bars = root.createElementNS(SVG_NS, 'path'); bars.setAttribute('d', path);
    svg.append(bars); scale.append(svg);
  }
  const gradient = root.createElement('div');
  gradient.className = 'legend-gradient';
  gradient.style.background = legend.gradient;
  const marker = root.createElement('span'), label = root.createElement('span');
  marker.className = 'legend-probe'; label.className = 'legend-probe-label';
  marker.hidden = label.hidden = true;
  label.setAttribute('role', 'status');
  scale.append(gradient, marker, label);
  const unit = legend.unit ? ` ${legend.unit}` : '';
  const atoms = count => `${count.toLocaleString('en-US')} atom${count === 1 ? '' : 's'}`;
  // Digits finer than a band (or a pixel-scale step) are noise in the probe.
  const resolution = span / (histogram && !histogram.integer ? histogram.counts.length : 100);
  const decimals = resolution > 0 ? Math.max(0, Math.min(20, 1 - Math.floor(Math.log10(resolution)))) : null;
  const rounded = value => format(decimals === null ? value : Number(value.toFixed(decimals)));
  function describe(fraction) {
    const value = minimum + fraction * span;
    if (!histogram) return { fraction, text: `${rounded(value)}${unit}` };
    if (histogram.integer) {
      const index = Math.max(0, Math.min(histogram.counts.length - 1, Math.round(value) - histogram.first));
      return { fraction: position(histogram.first + index),
        text: `${format(histogram.first + index)}${unit}\n${atoms(histogram.counts[index])} with this value` };
    }
    // Name the band explicitly: the bar under the pointer counts the atoms
    // whose values fall between these two limits.
    const bands = histogram.counts.length, index = Math.min(bands - 1, Math.floor(fraction * bands));
    const lower = minimum + index * span / bands, upper = index === bands - 1 ? maximum : minimum + (index + 1) * span / bands;
    return { fraction, text: `${rounded(value)}${unit}\n${atoms(histogram.counts[index])} between ${rounded(lower)} and ${rounded(upper)}` };
  }
  function probe(event) {
    const rectangle = scale.getBoundingClientRect?.();
    if (!rectangle?.width || !Number.isFinite(event.clientX)) return;
    const { fraction, text } = describe(Math.max(0, Math.min(1, (event.clientX - rectangle.left) / rectangle.width)));
    marker.hidden = label.hidden = false;
    marker.style.left = `${fraction * 100}%`;
    label.textContent = text;
    // Keep the label inside the legend near either end.
    const width = label.offsetWidth;
    label.style.left = width
      ? `${width >= rectangle.width ? rectangle.width / 2 : Math.max(width / 2, Math.min(rectangle.width - width / 2, fraction * rectangle.width))}px`
      : `${Math.max(14, Math.min(86, fraction * 100))}%`;
  }
  function hide() { marker.hidden = label.hidden = true; }
  scale.addEventListener('pointermove', probe);
  scale.addEventListener('pointerdown', probe);
  scale.addEventListener('pointerleave', hide);
  if (histogram) {
    const outside = histogram.below + histogram.above;
    scale.title = `${histogram.integer ? 'Bars count atoms at each integer value'
      : `Bars count atoms in ${histogram.counts.length} equal value bands`} of the color range.`
      + (outside ? ` ${outside.toLocaleString('en-US')} finite value${outside === 1 ? ' lies' : 's lie'} outside it.` : '');
  } else scale.title = '';
  return scale;
}
