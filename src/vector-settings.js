import { normalizeVectorOptions } from './render/atom-primitives.js';

const normalizedNames = new WeakMap();
function normalizedPropertyName(property) {
  const cached = normalizedNames.get(property);
  if (cached?.name === property.name) return cached.normalized;
  const normalized = property.name.toLowerCase().replace(/[._\[\]\s]/g, '');
  normalizedNames.set(property, { name: property.name, normalized });
  return normalized;
}
const componentDescriptors = new WeakMap();

/** Match a complete imported vector family; never mix force and velocity axes. */
export function findVectorComponents(properties, mode) {
  const families = mode === 'force' ? ['force', 'forces', 'f'] : mode === 'velocity' ? ['velocity', 'velocities', 'vel', 'v'] : [];
  const numeric = properties.filter(property => !property.categories && property.analysisKind !== 'vectors');
  for (const family of families) {
    for (const axes of [['x', 'y', 'z'], ['0', '1', '2'], ['1', '2', '3']]) {
      const matches = axes.map(axis => numeric.find(property => {
        const normalized = normalizedPropertyName(property);
        return normalized === family + axis;
      }));
      if (matches.every(Boolean)) return matches;
    }
  }
  return null;
}

/** Restore imported fields in their original order before resolving aliases. */
export function importedVectorComponents(frame, mode) {
  const properties = (frame?.properties ?? []).map(property => frame.analysisOriginalProperties?.get(property.name) ?? property);
  const names = new Set(properties.map(property => property.name));
  for (const property of frame?.analysisOriginalProperties?.values() ?? []) {
    if (!names.has(property.name)) properties.push(property);
  }
  return findVectorComponents(properties.filter(property => !property.analysisKind), mode);
}

const PRESET_FAMILIES = new Set(['force', 'forces', 'f', 'velocity', 'velocities', 'vel', 'v', 'displacement', 'displacements']);
const RESERVED_FAMILIES = new Set(['__proto__', 'proto', 'prototype', 'constructor']);

/** Discover existing vector fields without computing or changing properties.
 * Component references point directly at the current frame's numeric fields.
 */
export function availableVectorSources(frame, { displacementEnabled = false } = {}) {
  const sources = [{ value: 'generic', label: 'Custom XYZ properties', components: null }];
  const properties = frame?.properties ?? [];
  const valid = property => numericProperty(property, frame?.ids?.length);
  const complete = components => components?.length === 3 && components.every(valid);
  const displacement = ['X', 'Y', 'Z'].map(axis => properties.find(property =>
    property.name === `displacement${axis}` && property.analysisKind === 'displacement'));
  if (displacementEnabled && complete(displacement)) {
    sources.push({ value: 'displacement', label: 'Displacement', components: displacement });
  }
  for (const [value, label] of [['force', 'Force'], ['velocity', 'Velocity']]) {
    const components = importedVectorComponents(frame, value);
    if (complete(components)) sources.push({ value, label, components });
  }

  const families = new Map();
  for (const property of properties) {
    if (!valid(property)) continue;
    const descriptor = vectorComponentDescriptor(property);
    if (!descriptor) continue;
    const { family, label, component } = descriptor;
    if (!family || PRESET_FAMILIES.has(family) || RESERVED_FAMILIES.has(family) || family.length > 247) continue;
    if (!families.has(family)) families.set(family, { label, components: new Map() });
    const group = families.get(family);
    if (!group.components.has(component)) group.components.set(component, property);
  }
  for (const [family, group] of families) {
    // A complete XYZ family takes precedence over numeric aliases. Never mix
    // XYZ labels with partial zero/one-based indexed component families.
    const components = [['x', 'y', 'z'], ['0', '1', '2'], ['1', '2', '3']]
      .map(axes => axes.map(axis => group.components.get(axis))).find(complete);
    if (components) sources.push({ value: `property:${family}`, label: group.label, components });
  }
  return sources;
}

function numericProperty(property, atomCount) {
  const data = property?.data;
  return property && !property.categories && (Array.isArray(data) || ArrayBuffer.isView(data))
    && Number.isSafeInteger(data.length) && (atomCount === undefined || data.length === atomCount)
    && !(typeof BigInt64Array === 'function' && data instanceof BigInt64Array)
    && !(typeof BigUint64Array === 'function' && data instanceof BigUint64Array);
}

function vectorComponentDescriptor(property) {
  const { name, displayName, component } = property, fieldName = property.field?.name, fieldWidth = property.field?.width;
  const cached = componentDescriptors.get(property);
  if (cached && cached.name === name && cached.displayName === displayName && cached.component === component
    && cached.fieldName === fieldName && cached.fieldWidth === fieldWidth) return cached.result;
  const result = calculateComponentDescriptor(property);
  componentDescriptors.set(property, { name, displayName, component, fieldName, fieldWidth, result });
  return result;
}
function calculateComponentDescriptor(property) {
  // Extended XYZ stores the original field name and a zero-based component.
  if (property.field?.width === 3 && typeof property.field.name === 'string' && Number.isInteger(property.component)
    && property.component >= 0 && property.component < 3) {
    return descriptor(property.field.name, String(property.component));
  }
  const xyz = String(property.name).match(/^(.+?)[._\s-]?([xyz])$/i);
  if (xyz) return descriptor(xyz[1], xyz[2].toLowerCase(), property.displayName);
  const indexed = String(property.name).match(/^(.+?)(?:\[(\d+)\]|[._\s-]+(\d+)|([0-3]))$/);
  if (indexed) return descriptor(indexed[1], indexed[2] ?? indexed[3] ?? indexed[4], property.displayName);
  return null;
}

function descriptor(prefix, component, displayName) {
  const label = String(prefix).replace(/[._\s-]+$/, '');
  const family = label.toLowerCase().replace(/[._\[\]\s-]/g, '');
  const display = typeof displayName === 'string'
    ? displayName.replace(/(?:[._\s-]?[xyz]|\[\d+\]|[._\s-]+\d+)$/i, '').trim() : '';
  return { family, label: display || label, component };
}

/** Preserve the current ratios, including manually adjusted ratios after relinking. */
export function linkedArrowDimensions(previous, changed, value) {
  if (!['radius', 'headRadius', 'headLength'].includes(changed) || !Number.isFinite(value) || value <= 0) {
    throw new Error('Arrow dimensions must be positive finite lengths.');
  }
  const factor = value / previous[changed];
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('Arrow dimensions must be positive finite lengths.');
  return Object.fromEntries(['radius', 'headRadius', 'headLength'].map(name => [name, previous[name] * factor]));
}

/** A serializable independent arrow layer; also accepts legacy single fields. */
export function createVectorField(settings = {}, id = 'vector-1') {
  return {
    id: settings.id ?? id, name: settings.name ?? 'Vector 1', enabled: Boolean(settings.enabled),
    mode: settings.mode ?? 'generic', components: [...(settings.components ?? [null, null, null])],
    componentScales: [...(settings.componentScales ?? [1, 1, 1])],
    scale: settings.scale ?? 1, color: settings.color ?? '#f7a633', radius: settings.radius ?? .06,
    headRadius: settings.headRadius ?? .15, headLength: settings.headLength ?? .3,
    linkDimensions: settings.linkDimensions ?? true, anchor: settings.anchor ?? 'tail', dimension: settings.dimension ?? '3d',
    upMode: settings.upMode ?? 'camera', up: [...(settings.up ?? [0, 1, 0])],
  };
}

/** Keep custom arrows attached to a renamed column. A preset whose family is
 * broken by a component rename becomes the same XYZ field with unit factors. */
export function renameVectorFieldProperty(field, oldName, name, resolvedComponents = []) {
  let changed = false;
  if (field.mode !== 'generic' && resolvedComponents.includes(oldName)) {
    field.mode = 'generic'; field.components = resolvedComponents.map(component => component === oldName ? name : component);
    field.componentScales = [1, 1, 1]; changed = true;
  } else {
    field.components = field.components.map(component => {
      if (component !== oldName) return component;
      changed = true; return name;
    });
    if (field.mode === `property:${oldName}`) { field.mode = `property:${name}`; changed = true; }
  }
  return changed;
}

/** Build arrows from existing properties only. Missing sources wait for data. */
export function vectorFieldData(frame, field, { displacementEnabled = false, sources = availableVectorSources(frame, { displacementEnabled }), cache } = {}) {
  if (!frame || !field.enabled) { cache?.delete(field.id); return null; }
  const source = sources.find(source => source.value === field.mode);
  if (!source) { cache?.delete(field.id); return null; }
  const properties = source.value === 'generic'
    ? field.components.map(name => frame.properties.find(property => property.name === name)) : source.components;
  if (!properties || properties.length !== 3 || !properties.every(property => numericProperty(property, frame.ids.length))) { cache?.delete(field.id); return null; }
  const scales = source.value === 'generic' ? field.componentScales : [1, 1, 1];
  if (scales?.length !== 3 || !scales.every(Number.isFinite)) throw new Error('Component scale factors must be finite numbers.');
  const options = normalizeVectorOptions({ ...field, visible: true });
  const data = properties.map(property => property.data), previous = cache?.get(field.id);
  if (previous?.frame === frame && previous.vectors.length === frame.ids.length * 3
    && data.every((values, axis) => values === previous.data[axis] && scales[axis] === previous.scales[axis])) {
    return { id: field.id, vectors: previous.vectors, options };
  }
  const vectors = new Float32Array(frame.ids.length * 3);
  for (let atom = 0; atom < frame.ids.length; atom++) for (let axis = 0; axis < 3; axis++) vectors[atom * 3 + axis] = properties[axis].data[atom] * scales[axis];
  cache?.set(field.id, { frame, vectors, data, scales: [...scales] });
  return { id: field.id, vectors, options };
}
