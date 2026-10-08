import { importedVectorComponents } from '../vector-settings.js';
import { ORIENTATION_COLOR_MODES, ptmOrientationSource } from './orientation-colors.js';

export const BUILTIN_SCALAR_COLOR_MODES = Object.freeze([
  ...['x', 'y', 'z'].map(axis => `builtin:position:${axis}`),
  'builtin:velocity:magnitude',
]);

export const BUILTIN_COLOR_MODES = Object.freeze([
  ...BUILTIN_SCALAR_COLOR_MODES,
  ...ORIENTATION_COLOR_MODES,
]);

/** Keep builtin range keys separate from even identically named file columns. */
export function colorPropertyKey(name) {
  return /^(?:builtin:|property:)/.test(name) ? `property:${name}` : name;
}

function velocityComponents(frame) {
  const components = importedVectorComponents(frame, 'velocity');
  return components?.every(property => property.data?.length === frame.ids.length)
    ? components : null;
}

/** Keep original property keys for old recipes; only their labels change. */
export function initialColorQuantities(frame) {
  if (!frame) return [];
  const velocity = velocityComponents(frame);
  const velocityLabels = new Map(velocity?.map((property, axis) =>
    [property.name, `Velocity ${'XYZ'[axis]} (${property.name})`]) ?? []);
  return [
    ...['x', 'y', 'z'].map(axis => ({ value: `builtin:position:${axis}`, label: `Position ${axis.toUpperCase()} [Å]` })),
    ...(velocity ? [{ value: 'builtin:velocity:magnitude', label: `Speed magnitude${velocity[0].unit && velocity.every(property => property.unit === velocity[0].unit) ? ` [${velocity[0].unit}]` : ''}` }] : []),
    ...(ptmOrientationSource(frame) ? [{ value: 'builtin:ptm:ipf', label: 'PTM orientation · inverse pole figure' },
      { value: 'builtin:ptm:quaternion', label: 'PTM orientation · quaternion RGB' }] : []),
    ...frame.properties.map(property => ({ value: `property:${property.name}`,
      label: `${velocityLabels.get(property.name) ?? property.displayName ?? property.name}${property.unit ? ` [${property.unit}]` : ''}` })),
  ];
}

/** Virtual color fields leave parser/analysis properties untouched. Only the
 * currently chosen derived array is retained, rather than one per cached frame.
 * Immutable frame inputs and repeated palette/export calls reuse that array. */
export class ColorQuantityResolver {
  clear() { this.current = null; }

  resolve(frame, mode, { coordinateMode = 'wrapped' } = {}) {
    if (!frame) { this.clear(); return null; }
    if (mode.startsWith('property:')) {
      this.clear();
      const property = frame.properties.find(property => property.name === mode.slice(9));
      if (!property) return null;
      const key = colorPropertyKey(property.name);
      return key === property.name ? property
        : { ...property, name: key, displayName: property.displayName ?? property.name };
    }
    const axis = ['x', 'y', 'z'].indexOf(mode.slice('builtin:position:'.length));
    let sources, displayName, unit;
    if (mode.startsWith('builtin:position:') && axis >= 0) {
      const unwrapped = coordinateMode === 'unwrapped' && frame.unwrappedPositions;
      sources = [unwrapped || frame.positions];
      if (sources[0]?.length !== frame.ids.length * 3) return null;
      displayName = `Position ${'XYZ'[axis]} (${unwrapped ? 'unwrapped' : 'wrapped'})`;
      unit = 'Å';
    } else if (mode === 'builtin:velocity:magnitude') {
      const velocity = velocityComponents(frame);
      if (!velocity) { this.clear(); return null; }
      sources = velocity.map(property => property.data);
      displayName = 'Speed magnitude';
      unit = velocity.every(property => property.unit === velocity[0].unit) ? velocity[0].unit ?? '' : '';
    } else { this.clear(); return null; }

    const previous = this.current;
    if (previous?.frame === frame && previous.mode === mode && previous.property.displayName === displayName
        && previous.property.unit === unit && sources.every((data, index) => data === previous.sources[index])) return previous.property;
    const data = new Float64Array(frame.ids.length);
    for (let atom = 0; atom < data.length; atom++) {
      const value = axis >= 0 ? sources[0][atom * 3 + axis]
        : Math.hypot(sources[0][atom], sources[1][atom], sources[2][atom]);
      data[atom] = Number.isFinite(value) ? value : NaN;
    }
    const property = { name: mode, displayName, unit, data };
    this.current = { frame, mode, sources, property };
    return property;
  }
}
