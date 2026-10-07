import { renderInteractiveHistogram, renderPopulationTable } from './distribution-chart.js';

// Voronoi histograms use the shared interactive histogram.
export { renderInteractiveHistogram as renderVoronoiHistogram };

const number = value => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('en-US', { maximumSignificantDigits: 5 }) : '—';
const percent = value => `${number(value * 100)}%`;
const population = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '—';
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
      renderInteractiveHistogram($('voronoi-volume-chart'), result.volumeHistogram, { label: 'Voronoi atomic volumes', xLabel: 'Volume', unit: 'Å³' });
      renderInteractiveHistogram($('voronoi-coordination-chart'), result.coordinationHistogram, { label: 'Voronoi coordination', xLabel: 'Neighbors', discrete: true });
      renderInteractiveHistogram($('voronoi-face-chart'), result.faceAreaHistogram, { label: 'Voronoi neighbor face areas', xLabel: 'Face area', unit: 'Å²' });
      $('voronoi-index-frequency')?.replaceChildren(); renderCompleteTopology(); updateControls();
    },
  };
}
