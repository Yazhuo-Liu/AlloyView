import { determinant3 } from './data/model.js';

/** CSV values use JavaScript's shortest round-trip decimal representation.
 * Undefined/null are empty cells; NaN and infinities retain their identities.
 * No display rounding, locale separators, or atom visibility enter the tables.
 */
export function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function* csvChunks(table, { chunkSize = 256 * 1024 } = {}) {
  if (!table?.columns || !table.rows) throw new Error('The CSV table has no columns or rows.');
  let chunk = table.columns.map(csvCell).join(',') + '\r\n';
  for (const row of table.rows) {
    if (row.length !== table.columns.length) throw new Error('The CSV row does not match its column headings.');
    chunk += row.map(csvCell).join(',') + '\r\n';
    if (chunk.length >= chunkSize) { yield chunk; chunk = ''; }
  }
  if (chunk) yield chunk;
}

export function serializeCsv(table) { return [...csvChunks(table)].join(''); }

/** Welford accumulation avoids the cancellation of E[x²] - E[x]². Standard
 * deviation describes the complete population, not a sample estimate. */
export function scalarStatistics(values) {
  let count = 0, nanCount = 0, infiniteCount = 0, min = Infinity, max = -Infinity, mean = 0, m2 = 0;
  for (const value of values ?? []) {
    if (!Number.isFinite(value)) { if (Number.isNaN(value)) nanCount++; else infiniteCount++; continue; }
    count++; min = Math.min(min, value); max = Math.max(max, value);
    const delta = value - mean; mean += delta / count; m2 += delta * (value - mean);
  }
  return { count, nanCount, infiniteCount, min: count ? min : NaN, max: count ? max : NaN,
    mean: count ? mean : NaN, stddev: count ? Math.sqrt(Math.max(0, m2 / count)) : NaN };
}

const CONTEXT = ['source_file', 'frame_number', 'timestep'];
const WIGNER_SEITZ_SITE_LABELS = Object.freeze(['vacancy', 'regular', 'interstitial', 'antisite']);
const STAT_COLUMNS = ['analysis', 'property', 'unit', 'finite_count', 'nan_count', 'infinite_count', 'minimum', 'maximum', 'mean', 'population_stddev'];
export const STATISTICS_TABLES = Object.freeze([
  'summary', 'properties', 'categories', 'coordination', 'atoms', 'rdf', 'dxa-summary', 'dxa-lines',
  'bond-length', 'bond-angle', 'bond-order', 'bond-order-atoms', 'voronoi-distributions', 'voronoi-atoms', 'voronoi-faces',
  'clusters', 'binning', 'wigner-seitz',
]);

/** Select a table from already completed analyses. All atom scans and CSV
 * formatting can run in the persistent statistics Worker. No neighbor search
 * or physical analysis is launched when exporting a result. */
export function buildStatisticsTable(snapshot, kind = 'summary') {
  if (!STATISTICS_TABLES.includes(kind)) throw new Error(`Unknown statistics table: ${kind}`);
  if (!(snapshot?.frame?.ids?.length ?? snapshot?.frame?.atomCount)) throw new Error('Open a structure before exporting statistics.');
  const frame = snapshot.frame, prefix = [snapshot.fileName ?? '', (snapshot.frameIndex ?? frame.frameIndex ?? 0) + 1, frame.timestep ?? ''];
  const contextRows = rows => (function* () { for (const row of rows) yield [...prefix, ...row]; })();
  const table = (columns, rows) => ({ kind, columns: [...CONTEXT, ...columns], rows: contextRows(rows),
    filename: `${fileStem(snapshot.fileName)}-frame-${prefix[1]}-${kind}.csv` });
  const properties = (frame.properties ?? []).filter(property => property.data?.length === (frame.ids?.length ?? frame.atomCount));
  const result = name => completedResult(snapshot, name);
  if (kind === 'summary') return table(['analysis', 'metric', 'label', 'value', 'unit'], summaryRows(snapshot, properties));
  if (kind === 'properties') return table(STAT_COLUMNS, propertyRows(properties));
  if (kind === 'categories') return table(['analysis', 'property', 'category_id', 'category', 'count', 'fraction'], categoryRows(frame, properties));
  if (kind === 'coordination') return table(['analysis', 'property', 'coordination', 'count', 'fraction'], coordinationRows(properties));
  if (kind === 'atoms') return table(['atom_id', 'type_id', 'type', 'x [Å]', 'y [Å]', 'z [Å]',
    ...properties.map(property => columnWithUnit(property.name, property.unit))], atomRows(frame, properties));
  if (kind === 'rdf') {
    const rdf = required(result('rdf'), 'Calculate RDF before exporting its distribution.');
    const width = rdf.normalization?.cutoff / (rdf.normalization?.bins ?? rdf.radii.length);
    return table(['lower [Å]', 'upper [Å]', 'radius [Å]', 'g(r)', 'directed_pair_count'],
      Array.from(rdf.radii, (radius, index) => [Number.isFinite(width) ? index * width : '',
        Number.isFinite(width) ? (index + 1) * width : '', radius, rdf.values[index], rdf.counts[index]]));
  }
  if (kind === 'dxa-summary') return table(['metric', 'family', 'value', 'unit'], dxaSummaryRows(required(snapshot.dxaNetwork, 'Calculate DXA before exporting its statistics.')));
  if (kind === 'dxa-lines') return table(['line_id', 'family', 'length [Å]', 'burgers_x', 'burgers_y', 'burgers_z',
    'spatial_burgers_x [Å]', 'spatial_burgers_y [Å]', 'spatial_burgers_z [Å]', 'structure_type', 'cluster_id', 'closed_loop'],
  (function* () { for (const line of required(snapshot.dxaNetwork, 'Calculate DXA before exporting its lines.').segments ?? []) {
    yield [line.id, line.familyId ?? line.family, line.length, ...(line.burgersVector ?? ['', '', '']),
      ...(line.spatialBurgersVector ?? ['', '', '']), line.structureType, line.clusterId, line.isClosedLoop ?? line.closedLoop];
  } })());
  if (kind === 'bond-length' || kind === 'bond-angle') {
    const distribution = required(result('bondStatistics'), 'Calculate bond statistics before exporting distributions.')[kind === 'bond-length' ? 'lengthDistribution' : 'angleDistribution'];
    required(distribution, 'The bond distribution is unavailable.');
    return table([columnWithUnit('lower', distribution.unit), columnWithUnit('upper', distribution.unit),
      columnWithUnit('center', distribution.unit), 'count', 'probability', columnWithUnit('probability_density', inverseUnit(distribution.unit))],
    Array.from(distribution.counts, (count, bin) => [distribution.edges[bin], distribution.edges[bin + 1], distribution.centers[bin], count,
      distribution.probability[bin], distribution.density[bin]]));
  }
  if (kind === 'bond-order') {
    const bonds = required(result('bondStatistics'), 'Calculate bond statistics before exporting Q4/Q6 statistics.');
    return table(STAT_COLUMNS, ['q4', 'q6'].map(name => statisticsRow('bondStatistics', name, '', scalarStatistics(bonds[name]))));
  }
  if (kind === 'bond-order-atoms') {
    const bonds = required(result('bondStatistics'), 'Calculate bond statistics before exporting Q4/Q6 values.');
    return table(['atom_id', 'type', 'coordination', 'Q4', 'Q6'], (function* () {
      for (let atom = 0; atom < frame.ids.length; atom++) yield [frame.ids[atom], frame.typeLabels?.[frame.types[atom]], bonds.coordination[atom], bonds.q4[atom], bonds.q6[atom]];
    })());
  }
  if (kind === 'binning') return binningTable(snapshot, required(result('binning'), 'Calculate a spatial profile before exporting it.'), prefix);
  if (kind === 'clusters') {
    const clusters = required(result('clusters'), 'Calculate clusters before exporting the cluster table.');
    const weightUnit = clusters.weighting === 'mass' ? 'amu' : 'atoms';
    return table(['cluster_id', 'atom_count', `total_weight [${weightUnit}]`, 'center_x [Å]', 'center_y [Å]', 'center_z [Å]',
      'radius_of_gyration [Å]', 'gyration_xx [Å²]', 'gyration_yy [Å²]', 'gyration_zz [Å²]', 'gyration_xy [Å²]', 'gyration_xz [Å²]',
      'gyration_yz [Å²]', 'percolating', 'first_atom_id'], (function* () {
      for (let index = 0; index < clusters.clusterCount; index++) {
        const atom = clusters.firstAtoms[index];
        yield [index + 1, clusters.sizes[index], clusters.totalWeights[index], ...clusters.centers.subarray(index * 3, index * 3 + 3),
          clusters.radiiOfGyration[index], ...clusters.gyrationTensors.subarray(index * 6, index * 6 + 6), Boolean(clusters.percolating[index]),
          frame.ids?.[atom] ?? atom + 1];
      }
    })());
  }
  if (kind === 'wigner-seitz') {
    const sites = required(result('wignerSeitz')?.exportSites, 'Calculate Wigner–Seitz defects before exporting defect sites.');
    const typeCount = sites.typeLabels.length;
    return table(['site_index', 'site_id', 'site_type', 'site_class', 'occupancy', ...sites.typeLabels.map(label => `occupancy_${label}`),
      'reference_x [Å]', 'reference_y [Å]', 'reference_z [Å]', 'current_x [Å]', 'current_y [Å]', 'current_z [Å]'], (function* () {
      for (let index = 0; index < sites.sites.length; index++) {
        yield [sites.sites[index], sites.ids[index], sites.types[index], WIGNER_SEITZ_SITE_LABELS[sites.classes[index]], sites.occupancy[index],
          ...sites.typeOccupancy.subarray(index * typeCount, (index + 1) * typeCount),
          ...sites.referencePositions.subarray(index * 3, index * 3 + 3), ...sites.currentPositions.subarray(index * 3, index * 3 + 3)];
      }
    })());
  }
  const voronoi = required(result('voronoi'), 'Calculate Voronoi tessellation before exporting its results.');
  if (kind === 'voronoi-distributions') return table(['distribution', 'lower', 'upper', 'category', 'count', 'fraction', 'unit'], voronoiDistributionRows(voronoi));
  if (kind === 'voronoi-atoms') return table(['atom_id', 'type', 'volume [Å³]', 'surface_area [Å²]', 'coordination',
    'boundary_faces', 'maximum_face_order', 'voronoi_index'], (function* () {
    for (const atom of voronoiAtomIndices(voronoi, frame.ids.length)) yield [frame.ids[atom], frame.typeLabels?.[frame.types[atom]], voronoi.atomicVolume[atom],
      voronoi.voronoiSurfaceArea[atom], voronoi.voronoiCoordination[atom], voronoi.voronoiBoundaryFaces[atom], voronoi.voronoiMaxFaceOrder[atom], voronoi.voronoiIndices[atom]];
  })());
  required(voronoi.faceOffsets, 'Calculate Voronoi tessellation before exporting its faces.');
  return table(['atom_id', 'face_number', 'face_area [Å²]', 'face_order', 'neighbor_atom_id', 'boundary_face', 'accepted_face'], (function* () {
    for (const atom of voronoiAtomIndices(voronoi, frame.ids.length)) {
      for (let face = voronoi.faceOffsets[atom]; face < voronoi.faceOffsets[atom + 1]; face++) {
        const neighbor = voronoi.faceNeighbors[face];
        yield [frame.ids[atom], face - voronoi.faceOffsets[atom] + 1, voronoi.faceAreas[face], voronoi.faceOrders[face],
          neighbor < 0 ? '' : frame.ids[neighbor], voronoi.faceBoundary[face], voronoi.faceAccepted[face]];
      }
    }
  })());
}

/** One row per bin, in row-major order for maps (the first vector's bin is
 * the outer loop). Bounds are reduced coordinates and distances along each
 * cell vector from the cell origin. A trajectory average reports per-frame
 * mean counts, and its context columns name the frame range instead. */
function binningTable(snapshot, binning, prefix) {
  const axes = binning.axes.map(axis => 'abc'[axis]), averaged = binning.frames > 1;
  const context = averaged ? [prefix[0], `1-${binning.frames}`, ''] : prefix;
  const columns = [...CONTEXT, ...axes.flatMap(axis => [`${axis}_bin`, `${axis}_lower_fraction`, `${axis}_upper_fraction`,
    `${axis}_lower [Å]`, `${axis}_upper [Å]`, `${axis}_center [Å]`]),
  columnWithUnit(binning.valueName ?? 'value', binning.unit), 'atom_count', 'skipped_non_finite', ...(averaged ? ['frames_averaged'] : [])];
  const rows = (function* () {
    const [, second = 1] = binning.bins;
    for (let bin = 0; bin < binning.values.length; bin++) {
      const indices = binning.bins.length === 1 ? [bin] : [Math.floor(bin / second), bin % second];
      const bounds = indices.flatMap((index, dimension) => {
        const count = binning.bins[dimension], length = binning.axisLengths[dimension];
        return [index + 1, index / count, (index + 1) / count, index / count * length, (index + 1) / count * length, (index + 0.5) / count * length];
      });
      yield [...context, ...bounds, binning.values[bin], binning.counts[bin], binning.skipped?.[bin] ?? 0, ...(averaged ? [binning.frames] : [])];
    }
  })();
  const stem = fileStem(snapshot.fileName);
  return { kind: 'binning', columns, rows,
    filename: averaged ? `${stem}-all-frames-binning.csv` : `${stem}-frame-${prefix[1]}-binning.csv` };
}

/** Subset arrays stay aligned with the physical frame. Included central cells
 * and face-neighbor indices therefore both address original source atom IDs.
 * Legacy all-site results contain no explicit index map. */
function* voronoiAtomIndices(result, sourceAtomCount) {
  if (result.analyzedAtomIndices === undefined || result.analyzedAtomIndices === null) {
    for (let atom = 0; atom < sourceAtomCount; atom++) yield atom;
    return;
  }
  for (const atom of result.analyzedAtomIndices) {
    if (!Number.isInteger(atom) || atom < 0 || atom >= sourceAtomCount) throw new Error('Voronoi cell indices do not match the source atom population.');
    yield atom;
  }
}

function* propertyRows(properties) {
  for (const property of properties) {
    if (property.categories?.length) continue;
    yield statisticsRow(property.analysisKind ?? (property.externalImportId ? 'external' : 'input'), property.name, property.unit ?? '', scalarStatistics(property.data));
  }
}

function statisticsRow(analysis, name, unit, statistics) {
  return [analysis, name, unit, statistics.count, statistics.nanCount, statistics.infiniteCount,
    statistics.min, statistics.max, statistics.mean, statistics.stddev];
}

function* categoryRows(frame, properties) {
  const typeCounts = countsFor(frame.types);
  for (let type = 0; type < (frame.typeLabels?.length ?? 0); type++) yield ['input', 'atomType', type, frame.typeLabels[type], typeCounts.get(type) ?? 0, (typeCounts.get(type) ?? 0) / frame.ids.length];
  for (const property of properties) {
    if (!property.categories?.length) continue;
    const counts = countsFor(property.data), known = new Set();
    for (const category of property.categories) {
      known.add(category.id); const count = counts.get(category.id) ?? 0;
      yield [property.analysisKind ?? property.name, property.name, category.id, category.label, count, count / property.data.length];
    }
    // Invalid/missing classifications remain accounted for rather than silently
    // disappearing from exported populations.
    for (const [id, count] of counts) if (!known.has(id)) yield [property.analysisKind ?? property.name, property.name, id,
      Number.isNaN(id) ? 'NaN' : property.unlistedCategories && Number.isInteger(id) && id > 0 ? property.unlistedCategories.label : 'Unclassified',
      count, count / property.data.length];
  }
}

function* coordinationRows(properties) {
  for (const property of properties) {
    if (!['coordination', 'bondCoordination', 'voronoiCoordination', 'bondOrderCoordination', 'bondStatisticsCoordination'].includes(property.name)) continue;
    let histogram = property.histogram?.length ? property.histogram.map(entry => [entry.coordination ?? entry.value, entry.count])
      : [...countsFor(property.data)].sort(([first], [second]) => first - second);
    // Type-filtered Voronoi fields mark excluded input sites as NaN. Those
    // atoms are outside this tessellation's statistical population.
    if (property.name === 'voronoiCoordination') histogram = histogram.filter(([value]) => Number.isFinite(value));
    const population = property.name === 'voronoiCoordination' ? histogram.reduce((sum, [, count]) => sum + count, 0) : property.data.length;
    for (const [value, count] of histogram) yield [property.analysisKind ?? property.name, property.name, value, count, count / population];
  }
}

function* atomRows(frame, properties) {
  for (let atom = 0; atom < frame.ids.length; atom++) yield [frame.ids[atom], frame.types[atom], frame.typeLabels?.[frame.types[atom]],
    frame.positions?.[atom * 3], frame.positions?.[atom * 3 + 1], frame.positions?.[atom * 3 + 2], ...properties.map(property => property.data[atom])];
}

function* summaryRows(snapshot, properties) {
  const frame = snapshot.frame, volume = frame.cell?.vectors ? Math.abs(determinant3(frame.cell.vectors)) : NaN;
  yield ['input', 'atom_count', '', frame.ids.length, ''];
  yield ['input', 'cell_volume', '', volume, 'Å³'];
  yield ['input', 'number_density', '', frame.ids.length / volume, 'Å⁻³'];
  for (let axis = 0; axis < 3; axis++) yield ['input', 'periodic_boundary', 'abc'[axis], Boolean(frame.cell?.pbc?.[axis]), ''];
  for (const [analysis, property, id, label, count, fraction] of categoryRows(frame, properties)) {
    yield [analysis, `${property}.count`, `${label} (${id})`, count, ''];
    yield [analysis, `${property}.fraction`, `${label} (${id})`, fraction, ''];
  }
  for (const [analysis, name, unit, count, nan, infinite, min, max, mean, stddev] of propertyRows(properties)) {
    for (const [metric, value, outputUnit] of [['finite_count', count, ''], ['nan_count', nan, ''], ['infinite_count', infinite, ''],
      ['minimum', min, unit], ['maximum', max, unit], ['mean', mean, unit], ['population_stddev', stddev, unit]]) yield [analysis, `${name}.${metric}`, '', value, outputUnit];
  }
  for (const [analysis, property, coordination, count, fraction] of coordinationRows(properties)) {
    yield [analysis, `${property}.population`, coordination, count, ''];
    yield [analysis, `${property}.population_fraction`, coordination, fraction, ''];
  }
  const groups = snapshot.selectionGroups?.groups ?? snapshot.selectionGroups ?? [];
  if (groups.length) {
    const ids = new Set(Array.from(frame.ids, String));
    for (const group of groups) {
      const matched = group.atomIds.reduce((sum, id) => sum + Number(ids.has(String(id))), 0);
      yield ['selections', 'stored_atom_count', group.name ?? group.id, group.atomIds.length, ''];
      yield ['selections', 'matched_atom_count', group.name ?? group.id, matched, ''];
      yield ['selections', 'absent_atom_count', group.name ?? group.id, group.atomIds.length - matched, ''];
    }
  }
  for (const property of properties) if (property.cspSummary) for (const [name, value] of Object.entries(property.cspSummary)) yield ['centrosymmetry', 'auto_structure_population', name, value, ''];
  const reportedAnalyses = new Set();
  for (const property of properties) if (property.analysisKind && !reportedAnalyses.has(property.analysisKind)) {
    reportedAnalyses.add(property.analysisKind);
    for (const [field, value, unit] of [['cutoff', property.analysisCutoff, 'Å'], ['elapsed_time', property.analysisMs, 'ms'],
      ['engine', property.analysisEngine, ''], ['gpu_requested', property.analysisGpuRequested, '']]) {
      if (value !== undefined) yield [property.analysisKind, field, '', value, unit];
    }
  }
  for (const [name, entry] of Object.entries(snapshot.results ?? {})) {
    const result = entry?.result ?? entry;
    if (!result) continue;
    for (const field of ['elapsedMs', 'workerCount', 'engine', 'incomplete', 'matched', 'unmatched', 'coordinationMode', 'averageCoordination', 'averageShear', 'mappingMode', 'minimumImage']) {
      if (result[field] !== undefined) yield [name, field, '', result[field], field === 'elapsedMs' ? 'ms' : ''];
    }
    if (name === 'localShear') {
      if (result.normalization !== undefined) yield [name, 'normalization', '', result.normalization, 'Å²'];
      for (let component = 0; component < (result.meanMetric?.length ?? 0); component++) yield [name, 'mean_metric', ['xx', 'xy', 'xz', 'yy', 'yz', 'zz'][component], result.meanMetric[component], ''];
    }
  }
  if (snapshot.dxaNetwork) for (const [metric, label, value, unit] of dxaSummaryRows(snapshot.dxaNetwork)) yield ['dxa', metric, label, value, unit];
  const rdf = completedResult(snapshot, 'rdf');
  if (rdf) {
    for (const [name, value] of Object.entries(rdf.normalization ?? {})) if (typeof value !== 'object') yield ['rdf', name, '', value, name.toLowerCase().includes('cutoff') ? 'Å' : name === 'volume' ? 'Å³' : ''];
    yield ['rdf', 'total_directed_pair_count', '', (rdf.counts ?? []).reduce((sum, count) => sum + count, 0), ''];
  }
  const bonds = completedResult(snapshot, 'bonds');
  if (bonds) yield ['bonds', 'unique_edge_count', '', bonds.count ?? bonds.indices?.length / 2, ''];
  const bondStatistics = completedResult(snapshot, 'bondStatistics');
  if (bondStatistics) {
    for (const [name, stats] of Object.entries(bondStatistics.statistics ?? {})) {
      const unit = name === 'length' ? 'Å' : name === 'angle' ? '°' : '';
      for (const [metric, value] of Object.entries(stats)) yield ['bondStatistics', `${name}.${metric}`, '', value, metric === 'count' ? '' : unit];
    }
    for (const [name, value] of Object.entries(bondStatistics.normalization ?? {})) if (typeof value !== 'object') yield ['bondStatistics', name, '', value, name.toLowerCase().includes('cutoff') ? 'Å' : ''];
  }
  const clusters = completedResult(snapshot, 'clusters');
  if (clusters) {
    for (const name of ['clusterCount', 'largestSize', 'percolatingCount', 'includedAtoms', 'excludedAtoms', 'weighting']) {
      if (clusters[name] !== undefined) yield ['clusters', name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), '', clusters[name], ''];
    }
  }
  const wignerSeitz = completedResult(snapshot, 'wignerSeitz');
  if (wignerSeitz) {
    for (const [metric, name] of [['reference_frame', 'referenceFrame'], ['affine_mapping', 'affineMapping'], ['site_count', 'siteCount'],
      ['atom_count', 'atomCount'], ['vacancy_count', 'vacancyCount'], ['interstitial_count', 'interstitialCount'], ['antisite_count', 'antisiteCount'],
      ['multiply_occupied_sites', 'multiplyOccupiedSites'], ['atoms_on_shared_sites', 'sharedSiteAtoms']]) {
      if (wignerSeitz[name] !== undefined) yield ['wignerSeitz', metric, '', name === 'referenceFrame' ? wignerSeitz[name] + 1 : wignerSeitz[name], ''];
    }
    for (const row of wignerSeitz.typeSummary ?? []) {
      for (const [metric, name] of [['site_count', 'sites'], ['atom_count', 'atoms'], ['vacancy_count', 'vacancies'], ['antisite_count', 'antisites'],
        ['antisite_atoms', 'antisiteAtoms'], ['atoms_on_shared_sites', 'sharedSiteAtoms']]) yield ['wignerSeitz', metric, row.label, row[name], ''];
    }
  }
  const voronoi = completedResult(snapshot, 'voronoi');
  if (voronoi) {
    if (Array.isArray(voronoi.selectedTypes)) yield ['voronoi', 'selected_types', '', voronoi.selectedTypes.join('; '), ''];
    for (const [name, value] of Object.entries(voronoi.summary ?? voronoi.statistics?.summary ?? {})) yield ['voronoi', name, '', value,
      name === 'volumeError' ? '' : /volume/i.test(name) ? 'Å³' : /area/i.test(name) ? 'Å²' : /radius/i.test(name) ? 'Å' : ''];
    for (const [distribution, lower, upper, category, count, fraction, unit] of voronoiDistributionRows(voronoi)) {
      const label = category === '' ? `[${lower}, ${upper}] ${unit}` : category;
      yield ['voronoi', `${distribution}.population`, label, count, ''];
      yield ['voronoi', `${distribution}.fraction`, label, fraction, ''];
    }
  }
  if (snapshot.legend?.minimum !== undefined) {
    yield ['display', 'color_range_minimum', snapshot.legend.property ?? snapshot.legend.title ?? '', snapshot.legend.minimum, snapshot.legend.unit ?? ''];
    yield ['display', 'color_range_maximum', snapshot.legend.property ?? snapshot.legend.title ?? '', snapshot.legend.maximum, snapshot.legend.unit ?? ''];
  }
}

function* dxaSummaryRows(network) {
  yield ['segment_count', '', network.segmentCount ?? network.segments?.length ?? 0, ''];
  yield ['total_length', '', network.totalLength ?? 0, 'Å'];
  yield ['cell_volume', '', network.volume, 'Å³'];
  yield ['line_density', '', network.density, 'Å⁻²'];
  const families = new Set([...Object.keys(network.counts ?? {}), ...Object.keys(network.familyLengths ?? {})]);
  for (const family of families) {
    const entry = network.counts?.[family];
    const count = typeof entry === 'object' ? entry?.count ?? 0 : entry ?? 0;
    const length = network.familyLengths?.[family] ?? entry?.length ?? 0;
    yield ['segment_count', family, count, '']; yield ['total_length', family, length, 'Å'];
    yield ['line_density', family, length / network.volume, 'Å⁻²'];
  }
}

function* voronoiDistributionRows(result) {
  const stats = result.statistics ?? result;
  for (const [name, key, unit] of [['coordination', 'coordinationHistogram', ''], ['atomic_volume', 'volumeHistogram', 'Å³'],
    ['face_area', 'faceAreaHistogram', 'Å²'], ['voronoi_index', 'indexCounts', '']]) {
    for (const row of stats[key] ?? []) yield [name, row.lower ?? '', row.upper ?? '', row.index ?? row.value ?? '', row.count, row.fraction, unit];
  }
}

export function completedResult(snapshot, name) {
  const value = snapshot.results?.[name] ?? snapshot.frame?.atomeyeResults?.[name];
  return value?.result ?? value ?? null;
}

function countsFor(values) { const counts = new Map(); for (const value of values ?? []) counts.set(value, (counts.get(value) ?? 0) + 1); return counts; }
function columnWithUnit(name, unit) { return unit ? `${name} [${unit}]` : name; }
function inverseUnit(unit) { return unit ? `${unit}⁻¹` : ''; }
function required(value, message) { if (!value) throw new Error(message); return value; }
function fileStem(name = 'structure') { return (String(name || 'structure').split(/[\\/]/).at(-1).replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'structure').slice(0, 180); }
