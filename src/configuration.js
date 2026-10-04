// Portable processing recipes deliberately contain no coordinates or atom data.
// Local files must be selected again; source metadata is only used to match them.
import { SCALAR_COLOR_SCHEMES } from './render/palette.js';

export const CONFIGURATION_VERSION = 1;
export const MAX_CONFIGURATION_BYTES = 8 * 1024 * 1024;
export const MAX_CONFIGURATION_SLICES = 16;
export const MAX_CONFIGURATION_PAIR_CUTOFFS = 1024;
export const MAX_CONFIGURATION_ATOM_OVERRIDES = 100_000;
export const MAX_CONFIGURATION_RDF_BINS = 4096;

const FORMATS = new Set(['cfg', 'cfg-sequence', 'lammps-dump', 'lammps-dump-sequence', 'xyz', 'xyz-sequence', 'pdb', 'pdb-sequence']);
const TOOLS = new Set(['display', 'replicate', 'slice', 'coordination', 'cna', 'centrosymmetry', 'ptm', 'strain', 'selection', 'performance', 'bonds', 'vectors', 'displacement', 'statistics', 'referenceStrain', 'localShear']);
const COLOR_SCHEMES = new Set(SCALAR_COLOR_SCHEMES.map(({ value }) => value));
const STRAIN_STRUCTURES = new Set([1, 2, 3, 5, 6, 7]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_FILES = 20_000;
const MAX_PROPERTIES = 4096;
const MAX_COORDINATE = 1e15;

/** Build and validate a detached recipe from a UI snapshot. */
export function createConfiguration(snapshot = {}) {
  const input = record(snapshot, 'configuration', ['app', 'version', 'exportedAt', 'source', 'settings']);
  if (input.app !== undefined && input.app !== 'AlloyView') fail('app', 'must be AlloyView');
  if (input.version !== undefined && input.version !== CONFIGURATION_VERSION) fail('version', 'is unsupported');
  const configuration = normalizeConfiguration({
    app: 'AlloyView',
    version: CONFIGURATION_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    source: input.source ?? null,
    settings: input.settings ?? {},
  }, true);
  enforceTextSize(JSON.stringify(configuration));
  return configuration;
}

/** Validate the complete recipe before the caller changes any application state. */
export function parseConfiguration(text) {
  if (typeof text !== 'string') fail('file', 'must contain JSON text');
  enforceTextSize(text);
  let value;
  try { value = JSON.parse(text); } catch { fail('file', 'contains invalid JSON'); }
  return normalizeConfiguration(value, false);
}

/**
 * Match an unordered selection of File objects or { file, relativePath } entries.
 * Modification times are informational: a re-downloaded example can still match.
 */
export function matchesSource(configuration, files, format) {
  const source = configuration?.source;
  if (source === null) return true;
  if (!source || !Array.isArray(source.files)) return false;
  if (format !== undefined && format !== null && canonicalFormat(format) !== canonicalFormat(source.format)) return false;
  const selected = Array.from(files ?? [], (entry) => {
    const file = entry?.file ?? entry;
    return {
      name: file?.name,
      size: file?.size,
      relativePath: normalizePath(entry?.relativePath || file?.webkitRelativePath || file?.name || ''),
    };
  });
  if (selected.length !== source.files.length) return false;
  const groups = new Map();
  for (const file of selected) {
    if (typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0) return false;
    const key = fileKey(file);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  // Match exact relative paths first so a basename-only selection cannot consume
  // a directory-qualified entry needed by a second file with the same name.
  const pending = [];
  for (const file of source.files) {
    const group = groups.get(fileKey(file));
    if (!group?.length) return false;
    const path = normalizePath(file.relativePath || file.name);
    const index = group.findIndex(candidate => candidate.relativePath === path);
    if (index >= 0) group.splice(index, 1);
    else pending.push(file);
  }
  for (const file of pending) {
    const group = groups.get(fileKey(file));
    if (!group?.length) return false;
    const path = normalizePath(file.relativePath || file.name);
    const candidates = group.map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => !hasDirectory(path) || !hasDirectory(candidate.relativePath));
    // Identically named and sized files in different directories need their
    // paths to disambiguate them rather than silently restoring the wrong data.
    if (candidates.length !== 1) return false;
    group.splice(candidates[0].index, 1);
  }
  return true;
}

export const matchConfigurationSource = matchesSource;

/** Download only a validated JSON recipe; no source contents are embedded. */
export function downloadConfiguration(configuration, filename = 'alloyview-configuration.json') {
  const validated = normalizeConfiguration(configuration, false);
  const text = `${JSON.stringify(validated, null, 2)}\n`;
  enforceTextSize(text);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = String(filename).replace(/[\\/\x00-\x1f]/g, '_') || 'alloyview-configuration.json';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return validated;
}

function normalizeConfiguration(value, fromSnapshot) {
  const input = record(value, 'configuration', ['app', 'version', 'exportedAt', 'source', 'settings']);
  if (input.app !== 'AlloyView') fail('app', 'must be AlloyView');
  if (input.version !== CONFIGURATION_VERSION) fail('version', 'is unsupported');
  const exportedAt = string(input.exportedAt, 'exportedAt', 64);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(exportedAt)
    || !Number.isFinite(Date.parse(exportedAt))) fail('exportedAt', 'must be an ISO timestamp');
  if (!Object.hasOwn(input, 'source')) fail('source', 'is missing');
  if (!Object.hasOwn(input, 'settings')) fail('settings', 'is missing');
  const configuration = {
    app: 'AlloyView',
    version: CONFIGURATION_VERSION,
    exportedAt,
    source: normalizeSource(input.source),
    settings: normalizeSettings(input.settings, fromSnapshot),
  };
  const reference = configuration.settings.extensions.referenceStrain;
  if (reference.enabled && configuration.source?.frameCount !== undefined
    && reference.frameIndex >= configuration.source.frameCount) {
    fail('settings.extensions.referenceStrain.frameIndex', 'must be smaller than the source frame count');
  }
  const displacement = configuration.settings.extensions.displacement;
  if (displacement.enabled && configuration.source?.frameCount !== undefined
    && displacement.referenceFrame >= configuration.source.frameCount) {
    fail('settings.extensions.displacement.referenceFrame', 'must be smaller than the source frame count');
  }
  return configuration;
}

function normalizeSource(value) {
  if (value === null) return null;
  const input = record(value, 'source', ['kind', 'label', 'format', 'files', 'frameIndex', 'frameCount']);
  const files = list(input.files, 'source.files', MAX_FILES, 1).map((entry, index) => {
    const path = `source.files[${index}]`;
    const file = record(entry, path, ['name', 'relativePath', 'size', 'lastModified']);
    const name = string(file.name, `${path}.name`, 1024);
    if (/[\\/]/.test(name)) fail(`${path}.name`, 'must be a filename without directories');
    const relativePath = normalizePath(string(file.relativePath ?? name, `${path}.relativePath`, 4096));
    if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)
      || relativePath.split('/').some(component => component === '..' || component === '.')) {
      fail(`${path}.relativePath`, 'must be a relative file path');
    }
    if (relativePath.split('/').at(-1) !== name) fail(`${path}.relativePath`, 'must end with the filename');
    const output = { name, relativePath, size: number(file.size, `${path}.size`, 0, Number.MAX_SAFE_INTEGER, true) };
    if (file.lastModified !== undefined) output.lastModified = number(file.lastModified, `${path}.lastModified`, 0, Number.MAX_SAFE_INTEGER, true);
    return output;
  });
  const kind = choice(input.kind ?? (files.length > 1 ? 'sequence' : 'file'), 'source.kind', new Set(['file', 'sequence']));
  if (kind === 'file' && files.length !== 1) fail('source.kind', 'file sources must contain one file');
  const frameIndex = number(input.frameIndex ?? 0, 'source.frameIndex', 0, Number.MAX_SAFE_INTEGER, true);
  const output = { kind, format: choice(input.format, 'source.format', FORMATS), files, frameIndex };
  if (input.label !== undefined) output.label = string(input.label, 'source.label', 2048);
  if (input.frameCount !== undefined) {
    output.frameCount = number(input.frameCount, 'source.frameCount', 1, Number.MAX_SAFE_INTEGER, true);
    if (frameIndex >= output.frameCount) fail('source.frameIndex', 'must be smaller than the frame count');
  }
  const paths = files.map(file => file.relativePath);
  if (new Set(paths).size !== paths.length) fail('source.files', 'contains duplicate relative paths');
  return output;
}

function normalizeSettings(value, fromSnapshot) {
  const input = record(value, 'settings', ['display', 'analyses', 'extensions', 'replicate', 'slices', 'colors', 'camera', 'activeTool', 'selectedAtomId', 'theme', 'compute']);
  const compute = record(input.compute ?? {}, 'settings.compute', ['gpuEnabled']);
  const repetitions = vector(input.replicate ?? [1, 1, 1], 'settings.replicate', 1, 4096, true);
  if (repetitions.reduce((product, count) => product * count, 1) > 4096) fail('settings.replicate', 'exceeds 4096 displayed cells');
  return {
    compute: { gpuEnabled: boolean(compute.gpuEnabled, 'settings.compute.gpuEnabled', false) },
    display: normalizeDisplay(input.display ?? {}),
    analyses: normalizeAnalyses(input.analyses ?? {}, fromSnapshot),
    extensions: normalizeExtensions(input.extensions ?? {}, fromSnapshot),
    replicate: repetitions,
    slices: normalizeSlices(input.slices ?? {}),
    colors: normalizeColors(input.colors ?? {}),
    camera: normalizeCamera(input.camera ?? null),
    activeTool: input.activeTool === 'configuration' ? null : nullableChoice(input.activeTool === undefined ? 'display' : input.activeTool, 'settings.activeTool', TOOLS),
    selectedAtomId: identifier(input.selectedAtomId ?? null, 'settings.selectedAtomId', true),
    theme: choice(input.theme ?? 'dark', 'settings.theme', new Set(['light', 'dark'])),
  };
}

/** Optional version 1 additions keep older recipes disabled and data-free. */
function normalizeExtensions(value, fromSnapshot) {
  const path = 'settings.extensions';
  const input = record(value, path, ['bonds', 'vectors', 'displacement', 'referenceStrain', 'localShear', 'rdf', 'measurements', 'appearance', 'comparison']);
  const bonds = record(input.bonds ?? {}, `${path}.bonds`, ['enabled', 'cutoff', 'pairCutoffs', 'radius', 'visible']);
  const vectors = record(input.vectors ?? {}, `${path}.vectors`, ['enabled', 'components', 'scale', 'color', 'mode', 'componentScales', 'referenceFrame', 'minimumImage', 'radius', 'headRadius', 'headLength', 'linkDimensions', 'anchor', 'dimension']);
  const displacement = record(input.displacement ?? {}, `${path}.displacement`, ['enabled', 'referenceFrame', 'minimumImage']);
  const referenceStrain = record(input.referenceStrain ?? {}, `${path}.referenceStrain`, ['enabled', 'frameIndex', 'cutoff']);
  const localShear = record(input.localShear ?? {}, `${path}.localShear`, ['enabled', 'cutoff', 'subtractMean']);
  const rdf = record(input.rdf ?? {}, `${path}.rdf`, ['enabled', 'cutoff', 'bins', 'firstType', 'secondType']);
  const measurements = record(input.measurements ?? {}, `${path}.measurements`, ['enabled', 'minimumImage', 'atomIds']);
  const appearance = record(input.appearance ?? {}, `${path}.appearance`, ['elements', 'atoms']);
  const comparison = record(input.comparison ?? {}, `${path}.comparison`, ['enabled', 'preset', 'projectionMode', 'camera']);
  const pairCutoffs = list(bonds.pairCutoffs ?? [], `${path}.bonds.pairCutoffs`, MAX_CONFIGURATION_PAIR_CUTOFFS).map((value, index) => {
    const entryPath = `${path}.bonds.pairCutoffs[${index}]`;
    const entry = record(value, entryPath, ['first', 'second', 'cutoff']);
    return {
      first: typeLabel(entry.first, `${entryPath}.first`),
      second: typeLabel(entry.second, `${entryPath}.second`),
      cutoff: number(entry.cutoff, `${entryPath}.cutoff`, 0, MAX_COORDINATE),
    };
  });
  ensureUnique(pairCutoffs.map(({ first, second }) => JSON.stringify([first, second].sort())), `${path}.bonds.pairCutoffs`);
  const components = list(vectors.components ?? [null, null, null], `${path}.vectors.components`, 3, 3).map((value, index) => {
    if (value === null) return null;
    const property = string(value, `${path}.vectors.components[${index}]`, 256);
    if (FORBIDDEN_KEYS.has(property)) fail(`${path}.vectors.components[${index}]`, 'is reserved');
    return property;
  });
  const vectorsEnabled = boolean(vectors.enabled, `${path}.vectors.enabled`, false);
  const vectorMode = normalizeVectorMode(vectors.mode ?? 'generic', `${path}.vectors.mode`);
  if (vectorsEnabled && vectorMode === 'generic' && components.includes(null)) fail(`${path}.vectors.components`, 'needs three properties for enabled vectors');
  // Legacy vector controls also computed displacements when arrow display was
  // disabled. Preserve that computation once, without coupling the new tools.
  const legacyDisplacement = input.displacement === undefined && vectorMode === 'displacement';
  const legacyReferenceFrame = number(vectors.referenceFrame ?? 0, `${path}.vectors.referenceFrame`, 0, Number.MAX_SAFE_INTEGER, true);
  const legacyMinimumImage = boolean(vectors.minimumImage, `${path}.vectors.minimumImage`, true);
  const atomIds = list(measurements.atomIds ?? [], `${path}.measurements.atomIds`, 4).map((value, index) => identifier(value, `${path}.measurements.atomIds[${index}]`));
  ensureUnique(atomIds.map(String), `${path}.measurements.atomIds`);
  const elements = list(appearance.elements ?? [], `${path}.appearance.elements`, MAX_PROPERTIES).map((value, index) => {
    const entryPath = `${path}.appearance.elements[${index}]`;
    const entry = record(value, entryPath, ['label', 'color', 'radius', 'visible']);
    return { label: typeLabel(entry.label, `${entryPath}.label`), ...normalizeAppearance(entry, entryPath, fromSnapshot) };
  });
  ensureUnique(elements.map(({ label }) => label), `${path}.appearance.elements`);
  const atoms = list(appearance.atoms ?? [], `${path}.appearance.atoms`, MAX_CONFIGURATION_ATOM_OVERRIDES).map((value, index) => {
    const entryPath = `${path}.appearance.atoms[${index}]`;
    const entry = record(value, entryPath, ['id', 'color', 'radius', 'visible']);
    return { id: identifier(entry.id, `${entryPath}.id`), ...normalizeAppearance(entry, entryPath, fromSnapshot) };
  });
  ensureUnique(atoms.map(({ id }) => String(id)), `${path}.appearance.atoms`);
  return {
    bonds: {
      ...normalizeCutoffAnalysis(bonds, `${path}.bonds`, fromSnapshot),
      pairCutoffs,
      radius: number(bonds.radius ?? 0.12, `${path}.bonds.radius`, 1e-12, MAX_COORDINATE),
      visible: boolean(bonds.visible, `${path}.bonds.visible`, true),
    },
    vectors: {
      enabled: vectorsEnabled,
      components,
      mode: vectorMode,
      componentScales: vector(vectors.componentScales ?? [1, 1, 1], `${path}.vectors.componentScales`, -1e12, 1e12),
      scale: number(vectors.scale ?? 1, `${path}.vectors.scale`, 1e-12, 1e12),
      color: hexColor(vectors.color ?? '#f9ca57', `${path}.vectors.color`),
      radius: number(vectors.radius ?? 0.06, `${path}.vectors.radius`, 1e-12, MAX_COORDINATE),
      headRadius: number(vectors.headRadius ?? 0.15, `${path}.vectors.headRadius`, 1e-12, MAX_COORDINATE),
      headLength: number(vectors.headLength ?? 0.3, `${path}.vectors.headLength`, 1e-12, MAX_COORDINATE),
      linkDimensions: boolean(vectors.linkDimensions, `${path}.vectors.linkDimensions`, true),
      anchor: choice(vectors.anchor ?? 'tail', `${path}.vectors.anchor`, new Set(['tail', 'head', 'center'])),
      dimension: choice(vectors.dimension ?? '3d', `${path}.vectors.dimension`, new Set(['3d', '2d'])),
    },
    displacement: {
      enabled: boolean(displacement.enabled, `${path}.displacement.enabled`, legacyDisplacement),
      referenceFrame: number(displacement.referenceFrame ?? (legacyDisplacement ? legacyReferenceFrame : 0), `${path}.displacement.referenceFrame`, 0, Number.MAX_SAFE_INTEGER, true),
      minimumImage: boolean(displacement.minimumImage, `${path}.displacement.minimumImage`, legacyDisplacement ? legacyMinimumImage : true),
    },
    referenceStrain: {
      ...normalizeCutoffAnalysis(referenceStrain, `${path}.referenceStrain`, fromSnapshot),
      frameIndex: number(referenceStrain.frameIndex ?? 0, `${path}.referenceStrain.frameIndex`, 0, Number.MAX_SAFE_INTEGER, true),
    },
    localShear: {
      ...normalizeCutoffAnalysis(localShear, `${path}.localShear`, fromSnapshot),
      subtractMean: boolean(localShear.subtractMean, `${path}.localShear.subtractMean`, false),
    },
    rdf: {
      ...normalizeCutoffAnalysis(rdf, `${path}.rdf`, fromSnapshot),
      bins: number(rdf.bins ?? 100, `${path}.rdf.bins`, 1, MAX_CONFIGURATION_RDF_BINS, true),
      firstType: rdf.firstType === undefined || rdf.firstType === null ? null : typeLabel(rdf.firstType, `${path}.rdf.firstType`),
      secondType: rdf.secondType === undefined || rdf.secondType === null ? null : typeLabel(rdf.secondType, `${path}.rdf.secondType`),
    },
    measurements: {
      enabled: boolean(measurements.enabled, `${path}.measurements.enabled`, false),
      minimumImage: boolean(measurements.minimumImage, `${path}.measurements.minimumImage`, true),
      atomIds,
    },
    appearance: { elements, atoms },
    comparison: {
      enabled: boolean(comparison.enabled, `${path}.comparison.enabled`, false),
      preset: choice(comparison.preset ?? 'top', `${path}.comparison.preset`, new Set(['front', 'back', 'left', 'right', 'top', 'bottom', 'custom'])),
      projectionMode: choice(comparison.projectionMode ?? 'orthographic', `${path}.comparison.projectionMode`, new Set(['orthographic', 'perspective'])),
      camera: normalizeCamera(comparison.camera ?? null),
    },
  };
}

function normalizeVectorMode(value, path) {
  const mode = string(value, path, 256);
  if (['generic', 'displacement', 'force', 'velocity'].includes(mode)) return mode;
  if (mode.startsWith('property:')) {
    const family = mode.slice('property:'.length);
    if (!family.trim()) fail(path, 'must identify a non-empty vector property family');
    if (FORBIDDEN_KEYS.has(family)) fail(path, 'is reserved');
    return mode;
  }
  fail(path, 'is unsupported');
}

function normalizeCutoffAnalysis(input, path, fromSnapshot) {
  const enabled = boolean(input.enabled, `${path}.enabled`, false);
  const cutoff = nullablePositive(input.cutoff, `${path}.cutoff`, fromSnapshot);
  if (enabled && cutoff === null) fail(`${path}.cutoff`, 'is required for enabled analysis');
  return { enabled, cutoff };
}

function normalizeAppearance(input, path, fromSnapshot) {
  return {
    color: input.color === undefined || input.color === null ? null : hexColor(input.color, `${path}.color`),
    radius: nullablePositive(input.radius, `${path}.radius`, fromSnapshot),
    visible: boolean(input.visible, `${path}.visible`, true),
  };
}

function typeLabel(value, path) {
  const label = string(value, path, 256);
  if (!label.trim()) fail(path, 'must contain a non-whitespace label');
  if (FORBIDDEN_KEYS.has(label)) fail(path, 'is reserved');
  return label;
}

function hexColor(value, path) {
  const color = string(value, path, 7);
  if (!/^#[\da-f]{6}$/i.test(color)) fail(path, 'must be a six-digit hex color');
  return color.toLowerCase();
}

function ensureUnique(values, path) {
  if (new Set(values).size !== values.length) fail(path, 'contains duplicates');
}

function normalizeDisplay(value) {
  const input = record(value, 'settings.display', ['coordinateMode', 'colorMode', 'radiusPercent', 'background', 'showCell', 'showAxes', 'png', 'projectionMode']);
  const png = record(input.png ?? {}, 'settings.display.png', ['background', 'legend', 'axes']);
  const colorMode = string(input.colorMode ?? 'type', 'settings.display.colorMode', 512);
  if (colorMode !== 'type' && (!colorMode.startsWith('property:') || colorMode.length === 9)) fail('settings.display.colorMode', 'must select atom type or a property');
  const background = string(input.background ?? '#000000', 'settings.display.background', 7);
  if (!/^#[\da-f]{6}$/i.test(background)) fail('settings.display.background', 'must be a six-digit hex color');
  return {
    coordinateMode: choice(input.coordinateMode ?? 'wrapped', 'settings.display.coordinateMode', new Set(['wrapped', 'unwrapped'])),
    colorMode,
    radiusPercent: number(input.radiusPercent ?? 100, 'settings.display.radiusPercent', 5, 500, true),
    background: background.toLowerCase(),
    showCell: boolean(input.showCell, 'settings.display.showCell', true),
    showAxes: boolean(input.showAxes, 'settings.display.showAxes', true),
    png: {
      background: boolean(png.background, 'settings.display.png.background', true),
      legend: boolean(png.legend, 'settings.display.png.legend', true),
      axes: boolean(png.axes, 'settings.display.png.axes', false),
    },
    projectionMode: choice(input.projectionMode ?? 'perspective', 'settings.display.projectionMode', new Set(['perspective', 'orthographic'])),
  };
}

function normalizeAnalyses(value, fromSnapshot) {
  const input = record(value, 'settings.analyses', ['coordination', 'cna', 'centrosymmetry', 'ptm', 'strain']);
  const coordination = record(input.coordination ?? {}, 'settings.analyses.coordination', ['enabled', 'cutoff']);
  const cna = record(input.cna ?? {}, 'settings.analyses.cna', ['enabled', 'mode', 'cutoff']);
  const centrosymmetry = record(input.centrosymmetry ?? {}, 'settings.analyses.centrosymmetry', ['enabled', 'mode', 'neighbors']);
  const ptm = record(input.ptm ?? {}, 'settings.analyses.ptm', ['enabled', 'flags', 'rmsdCutoff']);
  const strain = record(input.strain ?? {}, 'settings.analyses.strain', ['enabled', 'references']);
  const coordinationEnabled = boolean(coordination.enabled, 'settings.analyses.coordination.enabled', false);
  const cnaEnabled = boolean(cna.enabled, 'settings.analyses.cna.enabled', false);
  const cnaMode = choice(cna.mode ?? 'adaptive', 'settings.analyses.cna.mode', new Set(['adaptive', 'fixed']));
  const strainEnabled = boolean(strain.enabled, 'settings.analyses.strain.enabled', false);
  const references = list(strain.references ?? [], 'settings.analyses.strain.references', MAX_PROPERTIES).map((value, index) => {
    const path = `settings.analyses.strain.references[${index}]`;
    const reference = record(value, path, ['label', 'element', 'structure', 'a', 'c']);
    const structure = choice(reference.structure ?? 1, `${path}.structure`, STRAIN_STRUCTURES);
    const output = {
      element: string(reference.element ?? '', `${path}.element`, 8, true),
      structure,
      a: nullablePositive(reference.a, `${path}.a`, fromSnapshot),
    };
    if (!/^(?:[A-Z][a-z]?)?$/.test(output.element)) fail(`${path}.element`, 'must be an element symbol or empty');
    if (reference.label !== undefined) output.label = string(reference.label, `${path}.label`, 256);
    if (reference.c !== undefined || [2, 7].includes(structure)) output.c = nullablePositive(reference.c, `${path}.c`, fromSnapshot);
    if (strainEnabled && (output.a === null || ([2, 7].includes(structure) && output.c === null))) {
      fail(path, 'needs positive lattice constants for enabled strain');
    }
    return output;
  });
  if (strainEnabled && references.length === 0) fail('settings.analyses.strain.references', 'is required for enabled strain');
  const cutoff = nullablePositive(coordination.cutoff, 'settings.analyses.coordination.cutoff', fromSnapshot);
  if (coordinationEnabled && cutoff === null) fail('settings.analyses.coordination.cutoff', 'is required for enabled coordination');
  const cnaCutoff = nullablePositive(cna.cutoff, 'settings.analyses.cna.cutoff', fromSnapshot);
  if (cnaEnabled && cnaMode === 'fixed' && cnaCutoff === null) fail('settings.analyses.cna.cutoff', 'is required for fixed CNA');
  const ptmEnabled = boolean(ptm.enabled, 'settings.analyses.ptm.enabled', false);
  return {
    coordination: { enabled: coordinationEnabled, cutoff },
    cna: { enabled: cnaEnabled, mode: cnaMode, cutoff: cnaCutoff },
    centrosymmetry: {
      enabled: boolean(centrosymmetry.enabled, 'settings.analyses.centrosymmetry.enabled', false),
      // Version 1 recipes exported before Auto stored only a global neighbor
      // count; retain their manual behavior when restoring them.
      mode: choice(centrosymmetry.mode === undefined ? (centrosymmetry.neighbors === undefined ? 'auto' : 'manual') : centrosymmetry.mode, 'settings.analyses.centrosymmetry.mode', new Set(['auto', 'manual'])),
      neighbors: choice(centrosymmetry.neighbors ?? 12, 'settings.analyses.centrosymmetry.neighbors', new Set([8, 12])),
    },
    ptm: {
      enabled: ptmEnabled,
      flags: number(ptm.flags ?? 31, 'settings.analyses.ptm.flags', ptmEnabled ? 1 : 0, 255, true),
      rmsdCutoff: number(ptm.rmsdCutoff ?? 0.1, 'settings.analyses.ptm.rmsdCutoff', 0, 1e12),
    },
    strain: { enabled: strainEnabled, references },
  };
}

function normalizeSlices(value) {
  const input = record(value, 'settings.slices', ['items', 'selectedId', 'showGizmo']);
  const items = list(input.items ?? [], 'settings.slices.items', MAX_CONFIGURATION_SLICES).map((value, index) => {
    const path = `settings.slices.items[${index}]`;
    const slice = record(value, path, ['id', 'name', 'normal', 'position', 'enabled', 'side', 'showGizmo']);
    const normal = vector(slice.normal, `${path}.normal`, -1, 1);
    const length = Math.hypot(...normal);
    if (Math.abs(length - 1) > 1e-4) fail(`${path}.normal`, 'must be a unit vector');
    const name = string(slice.name ?? `Slice ${index}`, `${path}.name`, 128);
    if (!name.trim()) fail(`${path}.name`, 'must contain a non-whitespace name');
    return {
      id: sliceIdentifier(slice.id, `${path}.id`),
      name,
      normal: normal.map(component => component / length),
      position: number(slice.position, `${path}.position`, -MAX_COORDINATE, MAX_COORDINATE),
      enabled: boolean(slice.enabled, `${path}.enabled`, true),
      side: choice(slice.side ?? 'negative', `${path}.side`, new Set(['negative', 'positive'])),
      showGizmo: boolean(slice.showGizmo, `${path}.showGizmo`, true),
    };
  });
  const ids = new Set(items.map(slice => slice.id));
  if (ids.size !== items.length) fail('settings.slices.items', 'contains duplicate IDs');
  const selectedId = input.selectedId === null ? null
    : sliceIdentifier(input.selectedId ?? (items[0]?.id ?? null), 'settings.slices.selectedId', true);
  if (selectedId !== null && !ids.has(selectedId)) fail('settings.slices.selectedId', 'must identify an existing slice');
  return { items, selectedId, showGizmo: boolean(input.showGizmo, 'settings.slices.showGizmo', true) };
}

function normalizeColors(value) {
  const input = record(value, 'settings.colors', ['ranges', 'schemes', 'hideOutside', 'hiddenStructureTypes', 'hiddenAtomTypes', 'hiddenCategories']);
  const ranges = propertyEntries(input.ranges ?? [], 'settings.colors.ranges', ['property', 'minimum', 'maximum'], (entry, path) => {
    const minimum = number(entry.minimum, `${path}.minimum`, -MAX_COORDINATE, MAX_COORDINATE);
    const maximum = number(entry.maximum, `${path}.maximum`, -MAX_COORDINATE, MAX_COORDINATE);
    if (!(maximum > minimum)) fail(path, 'must have maximum greater than minimum');
    return { minimum, maximum };
  });
  const schemes = propertyEntries(input.schemes ?? [], 'settings.colors.schemes', ['property', 'scheme'], (entry, path) => ({
    scheme: choice(entry.scheme, `${path}.scheme`, COLOR_SCHEMES),
  }));
  const hideOutside = propertyEntries(input.hideOutside ?? [], 'settings.colors.hideOutside', ['property', 'hide'], (entry, path) => ({
    hide: boolean(entry.hide, `${path}.hide`),
  }));
  const hiddenStructureTypes = list(input.hiddenStructureTypes ?? [], 'settings.colors.hiddenStructureTypes', 9)
    .map((value, index) => number(value, `settings.colors.hiddenStructureTypes[${index}]`, 0, 8, true));
  if (new Set(hiddenStructureTypes).size !== hiddenStructureTypes.length) fail('settings.colors.hiddenStructureTypes', 'contains duplicates');
  const hiddenAtomTypes = list(input.hiddenAtomTypes ?? [], 'settings.colors.hiddenAtomTypes', 65_536)
    .map((value, index) => string(value, `settings.colors.hiddenAtomTypes[${index}]`, 256));
  if (new Set(hiddenAtomTypes).size !== hiddenAtomTypes.length) fail('settings.colors.hiddenAtomTypes', 'contains duplicates');
  const hiddenCategories = propertyEntries(input.hiddenCategories ?? [], 'settings.colors.hiddenCategories', ['property', 'ids'], (entry, path) => {
    const ids = list(entry.ids, `${path}.ids`, 65_536).map((value, index) => typeof value === 'number'
      ? number(value, `${path}.ids[${index}]`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true)
      : string(value, `${path}.ids[${index}]`, 256));
    if (new Set(ids).size !== ids.length) fail(`${path}.ids`, 'contains duplicates');
    return { ids };
  });
  return { ranges, schemes, hideOutside, hiddenStructureTypes, hiddenAtomTypes, hiddenCategories };
}

function propertyEntries(value, path, keys, normalize) {
  const entries = list(value, path, MAX_PROPERTIES).map((value, index) => {
    const entryPath = `${path}[${index}]`;
    const entry = record(value, entryPath, keys);
    const property = string(entry.property, `${entryPath}.property`, 256);
    if (FORBIDDEN_KEYS.has(property)) fail(`${entryPath}.property`, 'is reserved');
    return { property, ...normalize(entry, entryPath) };
  });
  if (new Set(entries.map(entry => entry.property)).size !== entries.length) fail(path, 'contains duplicate properties');
  return entries;
}

function normalizeCamera(value) {
  if (value === null) return null;
  const input = record(value, 'settings.camera', ['yaw', 'pitch', 'target', 'pan', 'distance', 'orthographicScale', 'projectionMode']);
  return {
    yaw: number(input.yaw, 'settings.camera.yaw', -1e12, 1e12),
    pitch: number(input.pitch, 'settings.camera.pitch', -Math.PI / 2 - 1e-7, Math.PI / 2 + 1e-7),
    target: vector(input.target, 'settings.camera.target', -MAX_COORDINATE, MAX_COORDINATE),
    pan: vector(input.pan, 'settings.camera.pan', -MAX_COORDINATE, MAX_COORDINATE),
    distance: number(input.distance, 'settings.camera.distance', 1e-12, MAX_COORDINATE),
    orthographicScale: number(input.orthographicScale, 'settings.camera.orthographicScale', 1e-12, MAX_COORDINATE),
    projectionMode: choice(input.projectionMode, 'settings.camera.projectionMode', new Set(['perspective', 'orthographic'])),
  };
}

function record(value, path, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be an object');
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.has(key)) fail(`${path}.${key}`, 'is not a supported setting');
  }
  return value;
}

function list(value, path, maximum, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(path, `must contain ${minimum}–${maximum} entries`);
  return value;
}

function vector(value, path, minimum, maximum, integer = false) {
  return list(value, path, 3, 3).map((component, index) => number(component, `${path}[${index}]`, minimum, maximum, integer));
}

function number(value, path, minimum, maximum, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum
    || (integer && !Number.isSafeInteger(value))) fail(path, `must be a finite ${integer ? 'integer' : 'number'} from ${minimum} to ${maximum}`);
  return value;
}

function nullablePositive(value, path, fromSnapshot) {
  if (value === undefined || value === null || (fromSnapshot && typeof value === 'number' && Number.isNaN(value))) return null;
  return number(value, path, 1e-12, MAX_COORDINATE);
}

function boolean(value, path, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') fail(path, 'must be true or false');
  return value;
}

function string(value, path, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.length) || /[\x00-\x1f\x7f]/.test(value)) {
    fail(path, `must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${maximum} characters without control characters`);
  }
  return value;
}

function choice(value, path, choices) {
  if (!choices.has(value)) fail(path, 'is unsupported');
  return value;
}

function nullableChoice(value, path, choices) {
  return value === null ? null : choice(value, path, choices);
}

function identifier(value, path, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value === 'number') return number(value, path, 0, Number.MAX_SAFE_INTEGER, true);
  const id = string(value, path, 128);
  if (FORBIDDEN_KEYS.has(id)) fail(path, 'is reserved');
  return id;
}

function sliceIdentifier(value, path, nullable = false) {
  if (nullable && value === null) return null;
  const id = string(value, path, 128);
  if (!id.trim()) fail(path, 'must contain a non-whitespace identifier');
  if (FORBIDDEN_KEYS.has(id)) fail(path, 'is reserved');
  return id;
}

function canonicalFormat(format) {
  if (format === 'cfg' || format === 'cfg-sequence') return 'cfg';
  if (format === 'lammps-dump' || format === 'lammps-dump-sequence') return 'lammps-dump';
  if (format === 'xyz' || format === 'xyz-sequence') return 'xyz';
  if (format === 'pdb' || format === 'pdb-sequence') return 'pdb';
  return null;
}

function normalizePath(path) { return String(path).replace(/\\/g, '/'); }
function hasDirectory(path) { return path.includes('/'); }
function fileKey(file) { return JSON.stringify([file.name, file.size]); }
function enforceTextSize(text) {
  if (text.length > MAX_CONFIGURATION_BYTES || new TextEncoder().encode(text).byteLength > MAX_CONFIGURATION_BYTES) {
    fail('file', 'is too large (maximum 8 MiB)');
  }
}
function fail(path, message) { throw new Error(`Invalid AlloyView configuration: ${path} ${message}.`); }
