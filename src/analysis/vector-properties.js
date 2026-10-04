import { replaceAnalysisProperty } from './results.js';

const VECTOR_FAMILIES = {
  displacement: { prefix: 'displacement', title: 'Displacement' },
  force: { prefix: 'force', title: 'Force' },
  velocity: { prefix: 'velocity', title: 'Velocity' },
  generic: { prefix: 'vector', title: 'Vector' },
};

/** Stable scalar-property names for each independently retained vector field. */
export function vectorPropertyNames(mode) {
  if (!Object.hasOwn(VECTOR_FAMILIES, mode)) throw new Error(`Unknown vector source: ${mode}`);
  const family = VECTOR_FAMILIES[mode];
  return {
    x: `${family.prefix}X`,
    y: `${family.prefix}Y`,
    z: `${family.prefix}Z`,
    magnitude: `${family.prefix}Magnitude`,
  };
}

/** Publish physical values independently of arrow visibility and display scales.
 * Modes retain their own fields; replacing one field never removes another.
 * Imported name collisions are saved by replaceAnalysisProperty for reset.
 */
export function registerVectorProperties(frame, { mode, vectors, magnitudes, unit = '' }) {
  const names = vectorPropertyNames(mode);
  const count = frame.ids?.length ?? vectors?.length / 3;
  if (!Number.isInteger(count) || count < 0 || vectors?.length !== count * 3) {
    throw new Error('Vector values must contain three components per atom.');
  }
  if (typeof unit !== 'string') throw new Error('Vector property units must be a string.');
  if (magnitudes !== undefined && magnitudes?.length !== count) {
    throw new Error('Vector magnitudes must contain one value per atom.');
  }
  unit = mode === 'displacement' ? 'Å' : unit.trim();

  // Double precision also keeps a finite magnitude when Math.hypot exceeds
  // a Float32 component's range. No display-scale multiplication occurs here.
  const values = Object.fromEntries(Object.keys(names).map(component => [component, new Float64Array(count)]));
  for (let atom = 0; atom < count; atom++) {
    for (const [axis, component] of ['x', 'y', 'z'].entries()) {
      const value = vectors[atom * 3 + axis];
      values[component][atom] = Number.isFinite(value) ? value : NaN;
    }
    // GPU displacement already computes an overflow-safe double magnitude.
    // Reuse it without repeating a CPU norm for every atom; invalid components
    // still hide arrows and produce NaN, just as the CPU path does.
    const finite = Number.isFinite(values.x[atom]) && Number.isFinite(values.y[atom]) && Number.isFinite(values.z[atom]);
    const magnitude = magnitudes === undefined ? Math.hypot(values.x[atom], values.y[atom], values.z[atom]) : magnitudes[atom];
    values.magnitude[atom] = finite && Number.isFinite(magnitude) && magnitude >= 0 ? magnitude : NaN;
  }
  const title = VECTOR_FAMILIES[mode].title;
  const properties = Object.entries(names).map(([component, name]) => ({
    name,
    displayName: `${title} ${component === 'magnitude' ? 'magnitude' : component.toUpperCase()}`,
    unit,
    data: values[component],
    analysisKind: mode === 'displacement' ? 'displacement' : 'vectors',
    vectorMode: mode,
    vectorComponent: component,
  }));

  frame.properties ??= [];
  for (const property of properties) replaceAnalysisProperty(frame, property);
  // Metadata contains no array references: clearing analysis results can release
  // their buffers even if a caller keeps this frame's mode history.
  frame.vectorPropertyResults ??= new Map();
  frame.vectorPropertyResults.set(mode, { mode, unit, names });
  return { mode, unit, names, properties };
}
