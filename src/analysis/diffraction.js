import { determinant3, invert3 } from '../data/model.js';
import { getXrayScatteringCoefficients, XRAY_SCATTERING_MAX_S } from '../crystal/xray-scattering.js';
import { getElectronScatteringCoefficients, getNeutronScatteringLength, ELECTRON_SCATTERING_MAX_S,
  electronWavelengthFromEnergy } from '../crystal/diffraction-scattering.js';
import { runParserSteps, runParserStepsAsync } from '../io/cooperative-parser.js';

export const DIFFRACTION_DEFAULTS = Object.freeze({ radiation: 'xray', wavelength: 1.5406, minAngle: 5, maxAngle: 90,
  step: 0.02, fwhm: 0.15, lorentzPolarization: true, useThermal: true });
export const DIFFRACTION_RADIATION_DEFAULTS = Object.freeze({
  xray: DIFFRACTION_DEFAULTS,
  electron: Object.freeze({ ...DIFFRACTION_DEFAULTS, radiation: 'electron', wavelength: electronWavelengthFromEnergy(200),
    minAngle: 0.1, maxAngle: 4, step: 0.002, fwhm: 0.03 }),
  neutron: Object.freeze({ ...DIFFRACTION_DEFAULTS, radiation: 'neutron', wavelength: 1.8, maxAngle: 150 }),
});
export const DIFFRACTION_LIMITS = Object.freeze({ maxAtoms: 500_000, maxCandidates: 2_000_000,
  maxReflections: 250_000, maxAtomReflections: 200_000_000, maxProfilePoints: 200_001,
  maxProfileContributions: 50_000_000 });
const TAU = 2 * Math.PI, DEG = Math.PI / 180;
const THERMAL_NAMES = ['xx', 'yy', 'zz', 'xy', 'xz', 'yz'].map(axis => `displacementU${axis}`);
const fail = message => new Error(`Powder diffraction: ${message}`);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const SCATTERING_MODELS = Object.freeze({
  xray: Object.freeze({ coefficientStride: 9, scatteringUnits: 'electrons',
    scatteringModel: 'IT92 neutral atoms; non-resonant kinematic X-ray diffraction', warnings: [] }),
  electron: Object.freeze({ coefficientStride: 10, scatteringUnits: 'Å',
    scatteringModel: 'C4322 neutral atoms; kinematic electron powder diffraction',
    warnings: ['Electron intensities use neutral-atom single scattering (the kinematic approximation); dynamical and multiple scattering are not included.'] }),
  neutron: Object.freeze({ coefficientStride: 1, scatteringUnits: 'fm',
    scatteringModel: 'Neutron92 natural elements and explicit deuterium; real coherent nuclear scattering lengths',
    warnings: ['Neutron intensities use natural isotope compositions, with explicit D interpreted as deuterium; other isotope enrichment, magnetic scattering, incoherent background and absorption are not included.'] }),
});

function radiationModel(radiation) {
  if (!Object.hasOwn(SCATTERING_MODELS, radiation)) throw fail('radiation must be xray, electron or neutron.');
  return SCATTERING_MODELS[radiation];
}
function coefficientsFor(radiation, symbol) {
  try {
    if (radiation === 'neutron') return [getNeutronScatteringLength(symbol)];
    // Deuterium retains its explicit isotope label and nuclear amplitude. Its
    // neutral electronic density has the H form factor in these models.
    const electronicSymbol = symbol === 'D' ? 'H' : symbol;
    if (radiation === 'electron') return getElectronScatteringCoefficients(electronicSymbol);
    return getXrayScatteringCoefficients(electronicSymbol);
  } catch (error) { throw fail(error.message); }
}

export function normalizeDiffractionParameters(parameters = {}) {
  const radiation = parameters.radiation === undefined ? 'xray' : parameters.radiation; radiationModel(radiation);
  const result = { ...DIFFRACTION_RADIATION_DEFAULTS[radiation], ...parameters };
  for (const key of Object.keys(parameters)) if (!Object.hasOwn(DIFFRACTION_DEFAULTS, key)) throw fail(`unknown setting ${key}.`);
  for (const key of ['wavelength', 'minAngle', 'maxAngle', 'step', 'fwhm']) if (!finite(result[key])) throw fail(`${key} must be finite.`);
  if (result.wavelength < 0.01 || result.wavelength > 10) throw fail('wavelength must be between 0.01 and 10 Å.');
  if (result.minAngle < 0 || result.maxAngle >= 180 || result.maxAngle <= result.minAngle) throw fail('choose 0 ≤ minimum 2θ < maximum 2θ < 180 degrees.');
  if (result.step < 0.0001 || result.step > 5 || Math.ceil((result.maxAngle - result.minAngle) / result.step) + 1 > DIFFRACTION_LIMITS.maxProfilePoints) throw fail('the profile step exceeds the supported range or sample budget.');
  if (result.fwhm < 0.001 || result.fwhm > 20) throw fail('Gaussian FWHM must be between 0.001 and 20 degrees.');
  for (const key of ['lorentzPolarization', 'useThermal']) if (typeof result[key] !== 'boolean') throw fail(`${key} must be boolean.`);
  const sMax = Math.sin(result.maxAngle * DEG / 2) / result.wavelength;
  if (radiation === 'xray' && sMax >= XRAY_SCATTERING_MAX_S) throw fail(`the IT92 neutral-atom factors require sin(θ)/λ < ${XRAY_SCATTERING_MAX_S} Å⁻¹; reduce the angle or increase the wavelength.`);
  if (radiation === 'electron' && sMax > ELECTRON_SCATTERING_MAX_S) throw fail(`the C4322 neutral-atom electron factors require sin(θ)/λ ≤ ${ELECTRON_SCATTERING_MAX_S} Å⁻¹; reduce the angle or increase the wavelength.`);
  return result;
}

function property(frame, names, count) {
  const result = frame.properties?.find(value => names.includes(value.name));
  if (result && (!result.data || result.data.length !== count)) throw fail(`${result.name} must contain one value per site.`);
  return result?.data;
}

function validateCovariance(values) {
  const scale = Math.max(...values.map(Math.abs));
  if (!values.every(Number.isFinite)) throw fail('anisotropic displacement tensors must contain six finite values.');
  if (scale === 0) return;
  const [a, b, c, d, e, f] = values.map(value => value / scale), tolerance = 2e-12;
  if (Math.min(a, b, c, a * b - d * d, a * c - e * e, b * c - f * f,
    a * b * c + 2 * d * e * f - a * f * f - b * e * e - c * d * d) < -tolerance) {
    throw fail('anisotropic displacement tensors must be positive semidefinite.');
  }
}

// Propagate the arithmetic uncertainty of the explicit 3×3 inverse. A fixed
// angular tolerance cannot distinguish equal powder lines reliably after a
// highly skewed change of lattice basis. These bounds describe floating-point
// arithmetic only; they do not broaden physically distinct diffraction peaks.
function reciprocalUncertainty(cell, inverse) {
  const [a, b, c, d, e, f, g, h, i] = cell, eps = Number.EPSILON;
  const products = [Math.abs(e * i) + Math.abs(f * h), Math.abs(c * h) + Math.abs(b * i), Math.abs(b * f) + Math.abs(c * e),
    Math.abs(f * g) + Math.abs(d * i), Math.abs(a * i) + Math.abs(c * g), Math.abs(c * d) + Math.abs(a * f),
    Math.abs(d * h) + Math.abs(e * g), Math.abs(b * g) + Math.abs(a * h), Math.abs(a * e) + Math.abs(b * d)];
  const determinant = Math.abs(determinant3(cell));
  const determinantError = 8 * eps * (Math.abs(a) * products[0] + Math.abs(b) * products[3] + Math.abs(c) * products[6]);
  if (!Number.isFinite(determinantError) || determinantError >= determinant) throw fail('the cell basis is too ill-conditioned for reliable reciprocal geometry; use an equivalent reduced cell.');
  // Include four epsilons for the subsequent three-term inverse·h dot product.
  return Float64Array.from(products, (value, index) => (3 * eps * value + Math.abs(inverse[index]) * determinantError)
    / (determinant - determinantError) + 6 * eps * Math.abs(inverse[index]));
}

/** Immutable, compact source snapshot. A retained coordinator may reuse this
 * across wavelength/range/profile edits; useThermal changes require another
 * source snapshot, never a silently stale Debye–Waller factor. */
export function* prepareDiffractionSourceSteps(frame, { useThermal = true, radiation = 'xray' } = {}) {
  const model = radiationModel(radiation);
  if (typeof useThermal !== 'boolean') throw fail('useThermal must be boolean.');
  const count = frame?.types?.length;
  if (!Number.isSafeInteger(count) || count < 1 || count > DIFFRACTION_LIMITS.maxAtoms
      || frame.fractional?.length !== count * 3) throw fail(`provide 1–${DIFFRACTION_LIMITS.maxAtoms.toLocaleString('en-US')} sites with fractional coordinates.`);
  if (frame.cell?.pbc?.length !== 3 || frame.cell.pbc.some(value => value !== true)) throw fail('powder Bragg diffraction requires three periodic axes.');
  if (frame.cell.vectors?.length !== 9 || Array.from(frame.cell.vectors).some(value => !Number.isFinite(value))) throw fail('the cell must have nine finite components.');
  const cellVectors = new Float64Array(frame.cell.vectors), volume = Math.abs(determinant3(cellVectors));
  if (!Number.isFinite(volume) || volume < 1e-12) throw fail('the cell is singular or exceeds the numeric range.');
  invert3(cellVectors);
  if (!Array.isArray(frame.typeLabels) || !frame.typeLabels.length) throw fail('chemical element symbols are required.');
  const usedTypes = new Map(), typeLabels = [], coefficients = [];
  const fractional = new Float64Array(count * 3), types = new Uint32Array(count), occupancy = new Float64Array(count);
  const occupations = property(frame, ['occupancy'], count);
  const thermal = useThermal ? new Float64Array(count * 6) : null;
  const tensorFields = useThermal ? THERMAL_NAMES.map(name => property(frame, [name], count)) : [];
  const isoU = useThermal ? property(frame, ['Uiso', 'uiso', 'U_iso_or_equiv'], count) : null;
  const isoB = useThermal ? property(frame, ['Biso', 'biso', 'bfactor', 'B_iso_or_equiv'], count) : null;
  let missingThermal = 0, partialOccupancy = false;
  for (let atom = 0; atom < count; atom++) {
    if ((atom & 511) === 0) yield;
    const originalType = frame.types[atom];
    if (!Number.isInteger(originalType) || originalType < 0 || originalType >= frame.typeLabels.length) throw fail('an atom has an invalid element index.');
    if (!usedTypes.has(originalType)) {
      const label = frame.typeLabels[originalType];
      const entry = coefficientsFor(radiation, label);
      usedTypes.set(originalType, typeLabels.length); typeLabels.push(label); coefficients.push(...entry);
    }
    types[atom] = usedTypes.get(originalType);
    const weight = occupations ? occupations[atom] : 1;
    if (!finite(weight) || weight < 0 || weight > 1) throw fail('occupancy must be known and between zero and one; unknown occupancy is not assumed full.');
    occupancy[atom] = weight; partialOccupancy ||= weight !== 1;
    for (let axis = 0; axis < 3; axis++) {
      const value = frame.fractional[3 * atom + axis];
      if (!finite(value) || Math.abs(value) > 1e9) throw fail('fractional coordinates must be finite and within the supported image range.');
      fractional[3 * atom + axis] = value - Math.floor(value);
    }
    if (useThermal) {
      const values = tensorFields.map(field => field?.[atom] ?? NaN), known = values.filter(Number.isFinite).length;
      if (known) {
        validateCovariance(values); thermal.set(values, atom * 6);
      } else {
        if (values.some(value => value !== undefined && !Number.isNaN(value))) throw fail('anisotropic displacement values must be finite or missing.');
        const u = isoU?.[atom], b = isoB?.[atom];
        if (u !== undefined && !Number.isNaN(u) && (!finite(u) || u < 0)
            || b !== undefined && !Number.isNaN(b) && (!finite(b) || b < 0)) throw fail('isotropic displacement parameters must be finite and nonnegative, or missing.');
        const variance = finite(u) ? u : finite(b) ? b / (8 * Math.PI ** 2) : 0;
        if (!finite(u) && !finite(b)) missingThermal++;
        thermal[atom * 6] = thermal[atom * 6 + 1] = thermal[atom * 6 + 2] = variance;
      }
    }
  }
  if (!occupancy.some(value => value > 0)) throw fail('at least one site must have positive occupancy.');
  const warnings = [];
  if (partialOccupancy) warnings.push('Partial occupations describe coherent scattering from the average structure; disorder diffuse scattering is not included.');
  if (missingThermal) warnings.push(`${missingThermal.toLocaleString('en-US')} sites have no displacement parameters and use zero thermal displacement.`);
  return { atomCount: count, fractional, types, occupancy, thermal, thermalEnabled: useThermal, radiation,
    typeLabels, coefficients: Float64Array.from(coefficients), coefficientStride: model.coefficientStride,
    scatteringModel: model.scatteringModel, scatteringUnits: model.scatteringUnits,
    cellVectors, volume, baseWarnings: warnings, warnings: [...warnings, ...model.warnings] };
}

/** Change only the small species table of a trusted, immutable source snapshot.
 * Radiation switches retain the same atom/cell arrays and their GPU uploads. */
export function* retargetDiffractionSourceSteps(source, { radiation = 'xray' } = {}) {
  const model = radiationModel(radiation);
  if (source.radiation === radiation) return source;
  const coefficients = new Float64Array(source.typeLabels.length * model.coefficientStride);
  for (let type = 0; type < source.typeLabels.length; type++) {
    yield;
    coefficients.set(coefficientsFor(radiation, source.typeLabels[type]), type * model.coefficientStride);
  }
  const baseWarnings = source.baseWarnings ?? source.warnings;
  return { ...source, radiation, coefficients, coefficientStride: model.coefficientStride,
    scatteringModel: model.scatteringModel, scatteringUnits: model.scatteringUnits,
    baseWarnings, warnings: [...baseWarnings, ...model.warnings] };
}

/** Reciprocal vectors have units Å⁻¹ (no 2π). h_i = a_i·g proves
 * |h_i| ≤ |a_i| |g|max even for strongly skewed or left-handed cells. */
export function* enumerateDiffractionSteps(source, parameters = {}) {
  const settings = normalizeDiffractionParameters(parameters);
  if (source.thermalEnabled !== settings.useThermal) throw fail('the source snapshot does not match the thermal-displacement setting; prepare the source again.');
  if (source.radiation !== settings.radiation) throw fail('the source snapshot does not match the radiation setting; prepare or retarget the source again.');
  const inverse = invert3(source.cellVectors), inverseError = reciprocalUncertainty(source.cellVectors, inverse);
  const qMax = 2 * Math.sin(settings.maxAngle * DEG / 2) / settings.wavelength;
  const qMin = 2 * Math.sin(settings.minAngle * DEG / 2) / settings.wavelength;
  const bounds = [0, 1, 2].map(axis => Math.floor(Math.hypot(...source.cellVectors.subarray(axis * 3, axis * 3 + 3)) * qMax * (1 + 16 * Number.EPSILON)));
  const candidates = bounds.reduce((product, bound) => product * (2 * bound + 1), 1);
  if (!Number.isSafeInteger(candidates) || candidates > DIFFRACTION_LIMITS.maxCandidates) throw fail('the reciprocal-lattice search exceeds its candidate budget; use a smaller cell, narrower angle range or longer wavelength.');
  const rows = [], q2Min = qMin * qMin, q2Max = qMax * qMax;
  let visited = 0;
  for (let h = 0; h <= bounds[0]; h++) for (let k = -bounds[1]; k <= bounds[1]; k++) for (let l = -bounds[2]; l <= bounds[2]; l++) {
    if ((visited++ & 1023) === 0) yield;
    // Ordinary, non-resonant neutral factors obey Friedel's law. Compute one
    // member and add multiplicity two during powder integration.
    if (h === 0 && (k < 0 || k === 0 && l <= 0)) continue;
    const gx = inverse[0] * h + inverse[1] * k + inverse[2] * l;
    const gy = inverse[3] * h + inverse[4] * k + inverse[5] * l;
    const gz = inverse[6] * h + inverse[7] * k + inverse[8] * l;
    const q2 = gx * gx + gy * gy + gz * gz;
    if (!Number.isFinite(q2) || q2 <= 0) throw fail('reciprocal geometry exceeds its numeric range.');
    const ah = Math.abs(h), ak = Math.abs(k), al = Math.abs(l);
    const ex = inverseError[0] * ah + inverseError[1] * ak + inverseError[2] * al;
    const ey = inverseError[3] * ah + inverseError[4] * ak + inverseError[5] * al;
    const ez = inverseError[6] * ah + inverseError[7] * ak + inverseError[8] * al;
    const q2Error = 2 * (Math.abs(gx) * ex + Math.abs(gy) * ey + Math.abs(gz) * ez)
      + ex * ex + ey * ey + ez * ez + 4 * Number.EPSILON * q2;
    if (q2 + q2Error < q2Min || q2 - q2Error > q2Max) continue;
    if (!Number.isFinite(q2Error) || q2Error > 1e-9 * q2) throw fail('the cell basis is too ill-conditioned to resolve diffraction peaks; use an equivalent reduced cell.');
    const q = Math.sqrt(q2), sine = settings.wavelength * q / 2;
    if (sine >= 1) continue;
    const dError = (q2Error / (2 * (q2 - q2Error)) + 4 * Number.EPSILON) / q;
    rows.push([h, k, l, gx, gy, gz, q2 / 4, 2 * Math.asin(sine) / DEG, 1 / q, dError]);
    if (rows.length > DIFFRACTION_LIMITS.maxReflections || rows.length * source.atomCount > DIFFRACTION_LIMITS.maxAtomReflections) throw fail('the atom–reflection work exceeds its budget; reduce the structure or angular range.');
  }
  rows.sort((a, b) => a[7] - b[7] || a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const count = rows.length, hkls = new Int32Array(count * 3), reciprocal = new Float64Array(count * 3);
  const s2 = new Float64Array(count), twoTheta = new Float64Array(count), dSpacing = new Float64Array(count), dSpacingError = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    if ((i & 1023) === 0) yield;
    const row = rows[i]; hkls.set(row.slice(0, 3), 3 * i); reciprocal.set(row.slice(3, 6), 3 * i);
    s2[i] = row[6]; twoTheta[i] = row[7]; dSpacing[i] = row[8]; dSpacingError[i] = row[9];
  }
  const warnings = [...source.warnings];
  if (settings.step > settings.fwhm / 4) warnings.push('Profile sampling is coarse relative to its FWHM; use a smaller step to resolve peak heights.');
  return { ...source, source, parameters: settings, reflectionCount: count, hkls, reciprocal, s2, twoTheta, dSpacing, dSpacingError, warnings };
}

export function* prepareDiffractionSteps(frame, parameters = {}, { source } = {}) {
  const settings = normalizeDiffractionParameters(parameters);
  if (!source || source.thermalEnabled !== settings.useThermal) source = yield* prepareDiffractionSourceSteps(frame, settings);
  else if (source.radiation !== settings.radiation) source = yield* retargetDiffractionSourceSteps(source, settings);
  return yield* enumerateDiffractionSteps(source, settings);
}
export const prepareDiffraction = (frame, parameters) => runParserSteps(prepareDiffractionSteps(frame, parameters));
export const prepareDiffractionAsync = (frame, parameters, execution) => runParserStepsAsync(prepareDiffractionSteps(frame, parameters), execution);

export function evaluatePreparedScatteringFactor(prepared, type, s2) {
  const { coefficients, radiation = 'xray' } = prepared, stride = prepared.coefficientStride ?? 9, base = type * stride;
  if (radiation === 'neutron') return coefficients[base];
  const terms = radiation === 'electron' ? 5 : 4;
  let factor = radiation === 'electron' ? 0 : coefficients[base + 8];
  for (let i = 0; i < terms; i++) factor += coefficients[base + i] * Math.exp(-coefficients[base + terms + i] * s2);
  return factor;
}

/** A sparse exact-CPU oracle for GPU cancellation/weak-reflection recovery. */
export function* evaluateDiffractionReflectionSteps(prepared, index) {
  const { atomCount, fractional, types, occupancy, thermal, hkls, reciprocal } = prepared;
  if (!Number.isInteger(index) || index < 0 || index >= prepared.reflectionCount) throw fail('invalid reflection index.');
  const h = hkls[index * 3], k = hkls[index * 3 + 1], l = hkls[index * 3 + 2];
  const gx = reciprocal[index * 3], gy = reciprocal[index * 3 + 1], gz = reciprocal[index * 3 + 2];
  const factors = new Float64Array(prepared.typeLabels.length);
  for (let type = 0; type < factors.length; type++) factors[type] = evaluatePreparedScatteringFactor(prepared, type, prepared.s2[index]);
  let real = 0, imag = 0, realCorrection = 0, imagCorrection = 0, amplitudeBound = 0;
  for (let atom = 0; atom < atomCount; atom++) {
    if ((atom & 1023) === 0) yield;
    let weight = occupancy[atom] * factors[types[atom]];
    if (thermal && weight !== 0) {
      const base = atom * 6;
      const covariance = thermal[base] * gx * gx + thermal[base + 1] * gy * gy + thermal[base + 2] * gz * gz
        + 2 * (thermal[base + 3] * gx * gy + thermal[base + 4] * gx * gz + thermal[base + 5] * gy * gz);
      weight *= Math.exp(-2 * Math.PI ** 2 * Math.max(0, covariance));
    }
    // Reduce turns before trigonometry, retaining exact integer/half-integer
    // sites and keeping argument reduction bounded for large Miller indices.
    let turns = h * fractional[3 * atom] + k * fractional[3 * atom + 1] + l * fractional[3 * atom + 2];
    turns -= Math.round(turns);
    const phase = TAU * turns;
    const r = weight * Math.cos(phase) - realCorrection, nextReal = real + r;
    realCorrection = (nextReal - real) - r; real = nextReal;
    const im = weight * Math.sin(phase) - imagCorrection, nextImag = imag + im;
    imagCorrection = (nextImag - imag) - im; imag = nextImag;
    amplitudeBound += Math.abs(weight);
  }
  const intensity = real * real + imag * imag;
  if (![real, imag, intensity, amplitudeBound].every(Number.isFinite)) throw fail('structure-factor arithmetic exceeds the numeric range.');
  return { real, imag, intensity, amplitudeBound };
}
export const evaluateDiffractionReflection = (prepared, index) => runParserSteps(evaluateDiffractionReflectionSteps(prepared, index));

export function* calculateDiffractionRangeSteps(prepared, { start = 0, end = prepared.reflectionCount } = {}, { onProgress } = {}) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > prepared.reflectionCount) throw fail('invalid reflection range.');
  const size = end - start, real = new Float64Array(size), imag = new Float64Array(size), intensity = new Float64Array(size), amplitudeBound = new Float64Array(size);
  for (let index = start; index < end; index++) {
    yield;
    const result = yield* evaluateDiffractionReflectionSteps(prepared, index), local = index - start;
    real[local] = result.real; imag[local] = result.imag; intensity[local] = result.intensity; amplitudeBound[local] = result.amplitudeBound;
    if ((local & 31) === 31 || index + 1 === end) onProgress?.({ phase: 'structure-factors', completed: local + 1, total: size, completedReflections: local + 1, totalReflections: size });
  }
  return { start, end, real, imag, intensity, amplitudeBound };
}
export const computeDiffractionRangeSteps = calculateDiffractionRangeSteps;
export const calculateDiffractionRange = (prepared, range, execution) => runParserSteps(calculateDiffractionRangeSteps(prepared, range, execution));

function lorentzPolarization(twoTheta, radiation) {
  const theta = twoTheta * DEG / 2;
  return (radiation === 'xray' ? 1 + Math.cos(2 * theta) ** 2 : 1) / (Math.sin(theta) ** 2 * Math.cos(theta));
}

export function* finalizeDiffractionSteps(prepared, parts) {
  const count = prepared.reflectionCount, real = new Float64Array(count), imag = new Float64Array(count), intensity = new Float64Array(count), amplitudeBound = new Float64Array(count);
  const ordered = [...parts].sort((a, b) => a.start - b.start);
  let next = 0;
  for (const part of ordered) {
    const size = part.end - part.start;
    if (part.start !== next || !Number.isInteger(part.end) || size < 0 || part.end > count) throw fail('reflection ranges must cover the complete calculation exactly once.');
    for (const key of ['real', 'imag', 'intensity', 'amplitudeBound']) if (part[key]?.length !== size) throw fail(`incomplete ${key} structure-factor output.`);
    for (let j = 0; j < size; j++) {
      if ((j & 2047) === 0) yield;
      const r = part.real[j], im = part.imag[j], value = part.intensity[j], bound = part.amplitudeBound[j];
      if (![r, im, value, bound].every(Number.isFinite) || value < 0 || bound < 0) throw fail('invalid structure-factor output.');
      real[next + j] = r; imag[next + j] = im; intensity[next + j] = value; amplitudeBound[next + j] = bound;
    }
    next = part.end;
  }
  if (next !== count) throw fail('reflection ranges are incomplete.');
  const peaks = [], settings = prepared.parameters;
  let extinctCount = 0, peak = null, maxIntensity = 0, groupLower = 0, groupUpper = 0;
  for (let index = 0; index < count; index++) {
    if ((index & 1023) === 0) yield;
    const hkl = Array.from(prepared.hkls.subarray(index * 3, index * 3 + 3));
    const errorBound = amplitudeBound[index] * 128 * Number.EPSILON * (1 + hkl.reduce((sum, value) => sum + Math.abs(value), 0));
    if (intensity[index] <= errorBound ** 2) { extinctCount++; continue; }
    const twoTheta = prepared.twoTheta[index], dSpacing = prepared.dSpacing[index];
    // Intersect numerical uncertainty intervals rather than growing a chain
    // of pairwise matches. The tolerance never depends on the display step or
    // Gaussian width and remains small even for a skewed reciprocal basis.
    const dError = Math.max(prepared.dSpacingError?.[index] ?? 0, 64 * Number.EPSILON * dSpacing);
    const lower = dSpacing - dError, upper = dSpacing + dError;
    if (!peak || lower > groupUpper || upper < groupLower) {
      peak = { twoTheta, dSpacing, intensity: 0, relativeIntensity: 0, multiplicity: 0, hkls: [] }; peaks.push(peak);
      groupLower = lower; groupUpper = upper;
    } else {
      groupLower = Math.max(groupLower, lower); groupUpper = Math.min(groupUpper, upper);
    }
    peak.intensity += 2 * intensity[index] * (settings.lorentzPolarization ? lorentzPolarization(twoTheta, settings.radiation) : 1);
    peak.multiplicity += 2; peak.hkls.push(hkl, hkl.map(value => -value || 0));
    if (!Number.isFinite(peak.intensity)) throw fail('powder intensity exceeds the numeric range.');
    maxIntensity = Math.max(maxIntensity, peak.intensity);
  }
  for (const item of peaks) item.relativeIntensity = maxIntensity > 0 ? 100 * (item.intensity / maxIntensity) : 0;
  const sampleCount = Math.ceil((settings.maxAngle - settings.minAngle) / settings.step) + 1;
  const angles = Float64Array.from({ length: sampleCount }, (_, i) => Math.min(settings.maxAngle, settings.minAngle + i * settings.step));
  const profile = new Float64Array(sampleCount), relative = new Float64Array(sampleCount);
  const sigma = settings.fwhm / Math.sqrt(8 * Math.log(2)), gaussianScale = 1 / (sigma * Math.sqrt(2 * Math.PI));
  let profileContributions = 0;
  for (let peakIndex = 0; peakIndex < peaks.length; peakIndex++) {
    if ((peakIndex & 127) === 0) yield;
    const item = peaks[peakIndex];
    const start = Math.max(0, Math.floor((item.twoTheta - 8 * sigma - settings.minAngle) / settings.step));
    const end = Math.min(sampleCount, Math.ceil((item.twoTheta + 8 * sigma - settings.minAngle) / settings.step) + 1);
    profileContributions += Math.max(0, end - start);
    if (profileContributions > DIFFRACTION_LIMITS.maxProfileContributions) throw fail('the broadened profile exceeds its work budget; increase the sampling step or reduce FWHM/range.');
    for (let i = start; i < end; i++) {
      if ((i & 1023) === 0) yield;
      profile[i] += item.intensity * gaussianScale * Math.exp(-0.5 * ((angles[i] - item.twoTheta) / sigma) ** 2);
      if (!Number.isFinite(profile[i])) throw fail('the broadened profile exceeds the numeric range.');
    }
  }
  let profileMax = 0; for (const value of profile) profileMax = Math.max(profileMax, value);
  for (let i = 0; i < sampleCount; i++) relative[i] = profileMax > 0 ? 100 * (profile[i] / profileMax) : 0;
  return { kind: 'powder-xrd', radiation: settings.radiation, parameters: { ...settings }, atomCount: prepared.atomCount, reflectionCount: count,
    extinctCount, peakCount: peaks.length, peaks, profile: { twoTheta: angles, intensity: profile, relativeIntensity: relative },
    reflections: { hkls: prepared.hkls, twoTheta: prepared.twoTheta, dSpacing: prepared.dSpacing, real, imag, intensity, amplitudeBound },
    warnings: [...prepared.warnings], scatteringModel: prepared.scatteringModel, scatteringUnits: prepared.scatteringUnits,
    intensityUnits: `${prepared.scatteringUnits}²`,
    geometryCorrection: !settings.lorentzPolarization ? 'none' : settings.radiation === 'xray' ? 'Lorentz-polarization' : 'powder Lorentz',
    backend: 'cpu' };
}

export function* calculateDiffractionSteps(frame, parameters = {}, execution = {}) {
  const prepared = yield* prepareDiffractionSteps(frame, parameters);
  const part = yield* calculateDiffractionRangeSteps(prepared, {}, execution);
  return yield* finalizeDiffractionSteps(prepared, [part]);
}
export const calculateDiffraction = (frame, parameters, execution) => runParserSteps(calculateDiffractionSteps(frame, parameters, execution));
export const calculateDiffractionAsync = (frame, parameters, execution) => runParserStepsAsync(calculateDiffractionSteps(frame, parameters, execution), execution);

export function* diffractionCsvSteps(result, { kind = 'peaks', stem = 'crystal' } = {}) {
  if (result?.kind !== 'powder-xrd' || !['peaks', 'profile'].includes(kind)) throw fail('a completed diffraction result and valid export kind are required.');
  const rows = [], settings = result.parameters;
  if (kind === 'peaks') {
    rows.push('two_theta_deg,d_A,integrated_intensity,relative_intensity_percent,multiplicity,hkl,wavelength_A,fwhm_deg,lorentz_polarization,thermal_displacement,radiation,scattering_model,scattering_units,intensity_units,geometry_correction\r\n');
    for (let i = 0; i < result.peaks.length; i++) {
      if ((i & 255) === 0) yield;
      const item = result.peaks[i], hkl = item.hkls.map(indices => `(${indices.join(' ')})`).join('; ');
      rows.push([item.twoTheta, item.dSpacing, item.intensity, item.relativeIntensity, item.multiplicity,
        `"${hkl}"`, settings.wavelength, settings.fwhm, settings.radiation === 'xray' && settings.lorentzPolarization, settings.useThermal,
        settings.radiation, `"${result.scatteringModel}"`, result.scatteringUnits, result.intensityUnits, result.geometryCorrection].join(',') + '\r\n');
    }
  } else {
    rows.push('two_theta_deg,intensity_per_degree,relative_intensity_percent,wavelength_A,fwhm_deg,radiation,scattering_model,scattering_units,intensity_units,geometry_correction\r\n');
    for (let i = 0; i < result.profile.twoTheta.length; i++) {
      if ((i & 1023) === 0) yield;
      rows.push([result.profile.twoTheta[i], result.profile.intensity[i], result.profile.relativeIntensity[i], settings.wavelength, settings.fwhm,
        settings.radiation, `"${result.scatteringModel}"`, result.scatteringUnits, `${result.intensityUnits}/degree`, result.geometryCorrection].join(',') + '\r\n');
    }
  }
  const safe = String(stem).split(/[\\/]/).at(-1).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'crystal';
  const suffix = settings.radiation === 'xray' ? 'xrd' : `${settings.radiation}-diffraction`;
  return { blob: new Blob(rows, { type: 'text/csv;charset=utf-8' }), filename: `${safe}-${suffix}-${kind}.csv` };
}
