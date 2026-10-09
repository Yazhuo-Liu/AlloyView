import { determinant3 } from './data/model.js';
import { isComputedProperty } from './computed-properties.js';
import { scalarStatistics } from './statistics-export.js';

/** Per-frame scalar attributes for text labels and time series. Names are
 * stable, dot-separated and looked up only through Maps, never as object
 * keys, so a shared template cannot reach JavaScript members. Values follow
 * the Statistics summary CSV: each attribute records the summary row
 * (analysis, metric, label) it equals, or null for values that are not in
 * that table. Expensive values (property means, category counts) are
 * computed lazily when a label or series first asks for them.
 *
 * kind 'file' marks values derived from the frame as read (frame number,
 * timestep, cell, strain, file and imported columns). They can be computed
 * from frames read in the background. kind 'analysis' marks values that
 * exist only once an analysis or expression has run on the displayed frame. */

export const MAX_ATTRIBUTE_NAME_LENGTH = 256;
export const ATTRIBUTE_KINDS = Object.freeze(['file', 'analysis']);

// Categorical outputs of crystal analyses, named after their tool.
const CATEGORY_PREFIXES = new Map([['structureType', 'CNA'], ['ptmStructureType', 'PTM'], ['dxaStructureType', 'DXA.structure'],
  ['centralSymmetryStructureType', 'Symmetry'], ['idealStrainStructureType', 'IdealStrain']]);
const DXA_STRUCTURE = 'dxaStructureType';

/** Category labels and family IDs as name segments: subscripts and accents
 * fold to ASCII (L1₀ → L10), other runs become one underscore. */
export function attributeSegment(text) {
  const segment = String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return segment || '_';
}

export function cellLengths(cell) {
  const h = cell.vectors;
  return [Math.hypot(h[0], h[1], h[2]), Math.hypot(h[3], h[4], h[5]), Math.hypot(h[6], h[7], h[8])];
}

/** α = ∠(b, c), β = ∠(a, c), γ = ∠(a, b), in degrees. */
export function cellAngles(cell) {
  const h = cell.vectors, [a, b, c] = cellLengths(cell);
  const angle = (i, j, li, lj) => Math.acos(Math.max(-1, Math.min(1,
    (h[i] * h[j] + h[i + 1] * h[j + 1] + h[i + 2] * h[j + 2]) / (li * lj)))) * 180 / Math.PI;
  return [angle(3, 6, b, c), angle(0, 6, a, c), angle(0, 3, a, b)];
}

/** Engineering strain of each cell vector length and the volumetric strain,
 * (L − L₀)/L₀ and (V − V₀)/V₀, relative to a reference cell. */
export function cellStrain(cell, reference) {
  const lengths = cellLengths(cell), referenceLengths = cellLengths(reference);
  const volume = Math.abs(determinant3(cell.vectors)), referenceVolume = Math.abs(determinant3(reference.vectors));
  return { a: (lengths[0] - referenceLengths[0]) / referenceLengths[0], b: (lengths[1] - referenceLengths[1]) / referenceLengths[1],
    c: (lengths[2] - referenceLengths[2]) / referenceLengths[2], volumetric: (volume - referenceVolume) / referenceVolume };
}

function completed(frame, name) {
  const value = frame?.atomeyeResults?.[name];
  return value?.result ?? value ?? null;
}

function analysisKey(frame, kind) {
  const property = frame.properties?.find(item => item.analysisKind === kind);
  return property ? `${kind}:${property.analysisKey ?? ''}` : null;
}

function propertyKind(property) {
  return !property.analysisKind || property.externalImportId ? 'file' : 'analysis';
}

function propertySignature(property) {
  // A new import of the same column name replaces the earlier values.
  if (property.externalImportId) return `external:${property.externalImportId}`;
  if (propertyKind(property) === 'file') return '';
  return isComputedProperty(property) ? `expression:${property.expression ?? ''}` : `${property.analysisKind}:${property.analysisKey ?? ''}`;
}

function counts(values) {
  const result = new Map();
  for (const value of values ?? []) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

/**
 * context: { frame, frameIndex, frameCount, referenceCell, referenceFrameIndex, dxaNetwork, fileOnly }.
 * dxaNetwork must describe this frame; it is ignored unless the frame also
 * carries DXA's per-atom structure output, which is replaced with each result.
 */
export function createAttributeRegistry(context = {}) {
  const frame = context.frame;
  const descriptors = new Map(), folded = new Map(), cache = new Map();
  const add = (name, { unit = '', description = '', kind = 'file', csv = null, signature = '', group = name.split('.')[0], compute }) => {
    if (descriptors.has(name) || name.length > MAX_ATTRIBUTE_NAME_LENGTH) return;
    descriptors.set(name, Object.freeze({ name, unit, description, kind, csv: csv && Object.freeze(csv), signature, group, compute }));
    const key = name.toLowerCase();
    folded.set(key, folded.has(key) ? null : name);
  };
  if (frame?.cell) addFrameAttributes(frame, context, add);

  function descriptor(name) {
    if (typeof name !== 'string') return null;
    if (descriptors.has(name)) return descriptors.get(name);
    const match = folded.get(name.toLowerCase());
    return match ? descriptors.get(match) : null;
  }
  return Object.freeze({
    frame,
    /** Metadata of every available attribute, in a stable display order. */
    list: () => [...descriptors.values()],
    has: name => Boolean(descriptor(name)),
    describe: name => descriptor(name),
    /** { name, value, unit, kind, signature, … } or null when unavailable. */
    get(name) {
      const entry = descriptor(name);
      if (!entry) return null;
      if (!cache.has(entry.name)) cache.set(entry.name, entry.compute());
      const value = cache.get(entry.name);
      return value === undefined ? null : { ...entry, value };
    },
  });
}

function addFrameAttributes(frame, context, add) {
  const atomCount = frame.ids?.length ?? frame.atomCount ?? 0;
  const frameIndex = Number.isInteger(context.frameIndex) ? context.frameIndex : frame.frameIndex ?? 0;
  const volume = Math.abs(determinant3(frame.cell.vectors));
  add('Frame', { description: 'One-based frame number', csv: ['context', 'frame_number', ''], compute: () => frameIndex + 1 });
  if (Number.isInteger(context.frameCount) && context.frameCount > 0) {
    add('FrameCount', { description: 'Number of frames in the source (known so far while indexing)', compute: () => context.frameCount });
  }
  if (frame.timestep !== null && frame.timestep !== undefined && Number.isFinite(Number(frame.timestep))) {
    add('Timestep', { description: 'Simulation timestep stored in the file', csv: ['context', 'timestep', ''], compute: () => Number(frame.timestep) });
  }
  add('AtomCount', { description: 'Atoms in the analyzed frame', csv: ['input', 'atom_count', ''], compute: () => atomCount });
  add('Cell.volume', { unit: 'Å³', description: 'Cell volume |det h|', csv: ['input', 'cell_volume', ''], compute: () => volume });
  add('NumberDensity', { unit: 'Å⁻³', description: 'Atoms per cell volume', csv: ['input', 'number_density', ''], compute: () => atomCount / volume });
  const lengths = cellLengths(frame.cell), angles = cellAngles(frame.cell);
  ['a', 'b', 'c'].forEach((axis, index) => add(`Cell.${axis}`, { unit: 'Å', description: `Length of cell vector ${axis}`, compute: () => lengths[index] }));
  ['alpha', 'beta', 'gamma'].forEach((angle, index) => add(`Cell.${angle}`, { unit: '°',
    description: ['Angle between b and c', 'Angle between a and c', 'Angle between a and b'][index], compute: () => angles[index] }));
  if (context.referenceCell?.vectors?.length === 9) {
    const reference = Number.isInteger(context.referenceFrameIndex) ? context.referenceFrameIndex : 0;
    const strain = cellStrain(frame.cell, context.referenceCell), signature = `reference:${reference}`;
    add('Strain.reference', { description: 'One-based frame number of the strain reference', signature, compute: () => reference + 1 });
    for (const axis of ['a', 'b', 'c']) add(`Strain.${axis}`, { group: 'Strain', signature,
      description: `Engineering strain of cell vector ${axis}, (|${axis}| − |${axis}₀|)/|${axis}₀|`, compute: () => strain[axis] });
    add('Strain.volumetric', { group: 'Strain', signature, description: 'Volumetric strain (V − V₀)/V₀', compute: () => strain.volumetric });
  }
  addCategoryAttributes(frame, 'Type', 'atomType', frame.types, (frame.typeLabels ?? []).map((label, id) => ({ id, label })),
    { kind: 'file', analysis: 'input', signature: '' }, add);
  const properties = (frame.properties ?? []).filter(property => property.data?.length === atomCount
    && (!context.fileOnly || propertyKind(property) === 'file'));
  for (const property of properties) {
    const prefix = CATEGORY_PREFIXES.get(property.name);
    if (property.categories?.length) {
      addCategoryAttributes(frame, prefix ?? property.name, property.name, property.data, property.categories,
        { kind: propertyKind(property), analysis: property.analysisKind ?? property.name, signature: propertySignature(property) }, add);
    }
  }
  for (const property of properties) {
    if (property.categories?.length) continue;
    const label = property.displayName && property.displayName !== property.name ? ` (${property.displayName})` : '';
    add(`Mean.${property.name}`, { group: 'Mean', unit: property.unit ?? '', kind: propertyKind(property), signature: propertySignature(property),
      description: `Mean of finite ${property.name}${label} values`,
      csv: [property.analysisKind ?? (property.externalImportId ? 'external' : 'input'), `${property.name}.mean`, ''],
      compute: () => scalarStatistics(property.data).mean });
  }
  if (context.fileOnly) return;
  addDxaAttributes(frame, context.dxaNetwork, add);
  const clusters = completed(frame, 'clusters');
  if (clusters) {
    const signature = analysisKey(frame, 'clusters') ?? 'clusters';
    for (const [name, field, description] of [['cluster_count', 'clusterCount', 'Number of clusters'],
      ['largest_size', 'largestSize', 'Atoms in the largest cluster'], ['percolating_count', 'percolatingCount', 'Clusters connected to their own periodic images']]) {
      if (Number.isFinite(clusters[field])) add(`Clusters.${name}`, { kind: 'analysis', signature, description,
        csv: ['clusters', name, ''], compute: () => clusters[field] });
    }
  }
  const wignerSeitz = completed(frame, 'wignerSeitz');
  if (wignerSeitz) {
    const signature = analysisKey(frame, 'wignerSeitz') ?? `wignerSeitz:${wignerSeitz.referenceFrame}:${wignerSeitz.affineMapping}`;
    for (const [name, field, description] of [['vacancy_count', 'vacancyCount', 'Empty reference sites'],
      ['interstitial_count', 'interstitialCount', 'Atoms beyond one per reference site'], ['antisite_count', 'antisiteCount', 'Sites occupied by one atom of another type'],
      ['site_count', 'siteCount', 'Reference sites']]) {
      if (Number.isFinite(wignerSeitz[field])) add(`WignerSeitz.${name}`, { kind: 'analysis', signature, description,
        csv: ['wignerSeitz', name, ''], compute: () => wignerSeitz[field] });
    }
  }
}

function addCategoryAttributes(frame, prefix, propertyName, values, categories, { kind, analysis, signature }, add) {
  if (!values?.length || !categories?.length) return;
  let tally = null;
  const count = id => { tally ??= counts(values); return tally.get(id) ?? 0; };
  const used = new Set();
  for (const category of categories) {
    let segment = attributeSegment(category.label);
    if (used.has(segment)) segment = `${segment}_${attributeSegment(category.id)}`;
    used.add(segment);
    const label = `${category.label} (${category.id})`, group = prefix.split('.')[0];
    add(`${prefix}.${segment}.count`, { group, kind, signature, description: `Atoms classified as ${category.label}`,
      csv: [analysis, `${propertyName}.count`, label], compute: () => count(category.id) });
    add(`${prefix}.${segment}.fraction`, { group, kind, signature, description: `Fraction of all atoms classified as ${category.label} (0–1)`,
      csv: [analysis, `${propertyName}.fraction`, label], compute: () => count(category.id) / values.length });
  }
}

function addDxaAttributes(frame, network, add) {
  const structure = frame.properties?.find(property => property.name === DXA_STRUCTURE && property.analysisKind === 'dxa');
  if (!network || !structure) return;
  const signature = `dxa:${structure.analysisKey ?? ''}`, common = { kind: 'analysis', signature, group: 'DXA' };
  add('DXA.total_length', { ...common, unit: 'Å', description: 'Total dislocation line length', csv: ['dxa', 'total_length', ''],
    compute: () => network.totalLength ?? 0 });
  add('DXA.line_density', { ...common, unit: 'Å⁻²', description: 'Dislocation line length per cell volume', csv: ['dxa', 'line_density', ''],
    compute: () => network.density });
  add('DXA.segment_count', { ...common, description: 'Number of dislocation segments', csv: ['dxa', 'segment_count', ''],
    compute: () => network.segmentCount ?? network.segments?.length ?? 0 });
  const families = new Set([...Object.keys(network.counts ?? {}), ...Object.keys(network.familyLengths ?? {})]);
  for (const family of families) {
    const entry = network.counts?.[family], segment = attributeSegment(family);
    add(`DXA.${segment}.length`, { ...common, unit: 'Å', description: `Line length of the ${family} family`, csv: ['dxa', 'total_length', family],
      compute: () => network.familyLengths?.[family] ?? entry?.length ?? 0 });
    add(`DXA.${segment}.count`, { ...common, description: `Segments of the ${family} family`, csv: ['dxa', 'segment_count', family],
      compute: () => typeof entry === 'object' ? entry?.count ?? 0 : entry ?? 0 });
  }
}
