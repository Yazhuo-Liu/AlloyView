import test from 'node:test';
import assert from 'node:assert/strict';
import { crystalFrame } from './helpers/crystals.js';
import { createCell } from '../src/data/model.js';
import { replicateFrame } from '../src/data/replicate.js';
import { runParserSteps } from '../src/io/cooperative-parser.js';
import { calculateDiffraction, calculateDiffractionAsync, prepareDiffraction, prepareDiffractionSourceSteps,
  enumerateDiffractionSteps, calculateDiffractionRange, finalizeDiffractionSteps, evaluateDiffractionReflection,
  normalizeDiffractionParameters, diffractionCsvSteps, retargetDiffractionSourceSteps,
  evaluatePreparedScatteringFactor, DIFFRACTION_DEFAULTS, DIFFRACTION_RADIATION_DEFAULTS } from '../src/analysis/diffraction.js';
import { electronWavelengthFromEnergy, getElectronScatteringCoefficients,
  getNeutronScatteringLength } from '../src/crystal/diffraction-scattering.js';

const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
function fixture(kind = 'fcc', repeat = 1, a = 3.615, symbol = 'Cu') {
  const frame = crystalFrame(kind, repeat, a); frame.typeLabels = [symbol]; return frame;
}
const noProfileThermal = { useThermal: false };
const reflection = (prepared, target) => Array.from({ length: prepared.reflectionCount }, (_, i) => i)
  .find(i => target.every((value, axis) => value === prepared.hkls[i * 3 + axis]));

test('Cu powder peaks obey Bragg positions and FCC systematic absences with true multiplicities', () => {
  const result = calculateDiffraction(fixture(), { maxAngle: 120, ...noProfileThermal });
  const expected = [43.3167, 50.4480, 74.1258, 89.937, 95.143];
  result.peaks.slice(0, expected.length).forEach((peak, i) => close(peak.twoTheta, expected[i], 1e-4));
  assert.deepEqual(result.peaks.slice(0, 5).map(peak => peak.multiplicity), [8, 6, 12, 24, 8]);
  for (const peak of result.peaks) for (const hkl of peak.hkls) assert.ok(hkl.every(v => Math.abs(v % 2) === Math.abs(hkl[0] % 2)));
  assert.equal(result.peaks[0].relativeIntensity, 100); assert.ok(result.extinctCount > 0);
  assert.equal(Math.max(...result.profile.relativeIntensity), 100);
});

test('BCC and diamond selection rules arise from structure factors, including extinct diamond 222', () => {
  const bcc = calculateDiffraction(fixture('bcc', 1, 2.8665, 'Fe'), noProfileThermal);
  for (const peak of bcc.peaks) for (const hkl of peak.hkls) assert.equal(Math.abs(hkl.reduce((a, b) => a + b, 0) % 2), 0);
  close(bcc.peaks[0].twoTheta, 44.6716, 1e-5);
  const frame = fixture('diamond', 1, 5.431, 'Si'), result = calculateDiffraction(frame, noProfileThermal), prepared = prepareDiffraction(frame, noProfileThermal);
  close(result.peaks[0].twoTheta, 28.442101638040693); close(result.peaks[1].twoTheta, 47.30229418789582);
  close(result.peaks[2].twoTheta, 56.12181246454283);
  for (const peak of result.peaks) for (const hkl of peak.hkls) {
    assert.ok(hkl.every(v => Math.abs(v % 2) === 1) || hkl.every(v => v % 2 === 0) && hkl.reduce((a, b) => a + b, 0) % 4 === 0);
  }
  assert.ok(evaluateDiffractionReflection(prepared, reflection(prepared, [2, 2, 2])).intensity < 1e-23);
});

test('triclinic reciprocal vectors satisfy dual-basis identities; rigid rotation and left-handed cells preserve peaks', () => {
  const frame = fixture('sc', 1, 1, 'Si'); frame.cell = createCell({ vectors: [3, .2, 0, 1, 4, .1, .3, .6, 5], pbc: [true, true, true] });
  const prepared = prepareDiffraction(frame, noProfileThermal), result = calculateDiffraction(frame, noProfileThermal);
  for (let i = 0; i < prepared.reflectionCount; i++) for (let axis = 0; axis < 3; axis++) {
    const dot = [0, 1, 2].reduce((sum, j) => sum + frame.cell.vectors[axis * 3 + j] * prepared.reciprocal[i * 3 + j], 0);
    close(dot, prepared.hkls[i * 3 + axis]);
  }
  for (const transform of [([x, y, z]) => [-y, x, z], ([x, y, z]) => [-x, y, z]]) {
    const rotated = structuredClone(frame);
    rotated.cell = createCell({ vectors: [0, 1, 2].flatMap(axis => transform(Array.from(frame.cell.vectors.slice(axis * 3, axis * 3 + 3)))) });
    const actual = calculateDiffraction(rotated, noProfileThermal);
    assert.equal(actual.peaks.length, result.peaks.length);
    actual.peaks.forEach((peak, i) => { close(peak.twoTheta, result.peaks[i].twoTheta); close(peak.relativeIntensity, result.peaks[i].relativeIntensity); });
  }
});

test('translation and physical replication retain normalized powder patterns without changing source arrays', async () => {
  const frame = fixture('fcc'), saved = frame.fractional.slice(), base = calculateDiffraction(frame, noProfileThermal);
  const translated = structuredClone(frame); translated.fractional = Float64Array.from(frame.fractional, (value, index) => value + [.127, .483, -.221][index % 3]);
  const shifted = calculateDiffraction(translated, noProfileThermal), repeated = calculateDiffraction(await replicateFrame(frame, [2, 3, 1]), noProfileThermal);
  for (const result of [shifted, repeated]) {
    assert.equal(result.peaks.length, base.peaks.length);
    result.peaks.forEach((peak, i) => { close(peak.twoTheta, base.peaks[i].twoTheta); close(peak.relativeIntensity, base.peaks[i].relativeIntensity); });
  }
  assert.deepEqual(frame.fractional, saved);
});

test('numerical reflection intervals preserve multiplicities after a strongly skewed equivalent basis change', () => {
  const frame = fixture('sc'), base = calculateDiffraction(frame, noProfileThermal), a = frame.cell.vectors[0];
  for (const shear of [500, 1000]) {
    frame.cell = createCell({ vectors: [a, 0, 0, shear * a, a, 0, 0, 0, a] });
    const result = calculateDiffraction(frame, noProfileThermal);
    assert.equal(result.peaks.length, base.peaks.length);
    result.peaks.forEach((peak, i) => {
      assert.equal(peak.multiplicity, base.peaks[i].multiplicity);
      close(peak.twoTheta, base.peaks[i].twoTheta, 1e-12);
      close(peak.relativeIntensity, base.peaks[i].relativeIntensity, 1e-12);
    });
  }
});

test('coherent fractional occupation and isotropic/anisotropic Debye–Waller factors have their physical amplitude scaling', () => {
  const frame = fixture('sc', 1, 4, 'Si'), parameters = { lorentzPolarization: false };
  const base = prepareDiffraction(frame, parameters), index = reflection(base, [1, 0, 0]), original = evaluateDiffractionReflection(base, index);
  frame.properties.push({ name: 'occupancy', data: Float64Array.of(.5) });
  close(evaluateDiffractionReflection(prepareDiffraction(frame, parameters), index).intensity, original.intensity / 4);
  frame.properties.push({ name: 'Uiso', data: Float64Array.of(.03) });
  const iso = prepareDiffraction(frame, parameters), actual = evaluateDiffractionReflection(iso, index);
  close(actual.intensity, original.intensity / 4 * Math.exp(-4 * Math.PI ** 2 * .03 / 16));
  frame.properties = [{ name: 'Biso', data: Float64Array.of(.03 * 8 * Math.PI ** 2) }];
  close(evaluateDiffractionReflection(prepareDiffraction(frame, parameters), index).intensity, 4 * actual.intensity);
  frame.properties = ['xx', 'yy', 'zz', 'xy', 'xz', 'yz'].map((axis, i) => ({ name: `displacementU${axis}`, data: Float64Array.of([.03, .01, .02, .003, 0, 0][i]) }));
  const aniso = prepareDiffraction(frame, parameters);
  close(evaluateDiffractionReflection(aniso, reflection(aniso, [1, 0, 0])).intensity, original.intensity * Math.exp(-4 * Math.PI ** 2 * .03 / 16));
  close(evaluateDiffractionReflection(aniso, reflection(aniso, [0, 1, 0])).intensity, original.intensity * Math.exp(-4 * Math.PI ** 2 * .01 / 16));
});

test('nearby triclinic peaks are kept distinct, and Gaussian profile area equals integrated sticks', () => {
  const frame = fixture('sc', 1, 4, 'Si'); frame.cell = createCell({ vectors: [4, 0, 0, 0, 4 + 1e-9, 0, 0, 0, 5] });
  const result = calculateDiffraction(frame, { step: .002, fwhm: .1, maxAngle: 80, useThermal: false });
  assert.ok(result.peaks.some((peak, i) => i > 0 && Math.abs(peak.twoTheta - result.peaks[i - 1].twoTheta) < 1e-5));
  let area = 0;
  for (let i = 1; i < result.profile.twoTheta.length; i++) area += (result.profile.twoTheta[i] - result.profile.twoTheta[i - 1]) * (result.profile.intensity[i] + result.profile.intensity[i - 1]) / 2;
  close(area, result.peaks.reduce((sum, peak) => sum + peak.intensity, 0), 1e-10);
});

test('disjoint CPU ranges reproduce every result and source preparation reuses immutable inputs across settings', () => {
  const frame = fixture('diamond', 1, 5.431, 'Si'), prepared = prepareDiffraction(frame), count = prepared.reflectionCount;
  const result = runParserSteps(finalizeDiffractionSteps(prepared, [calculateDiffractionRange(prepared, { start: 7, end: count }), calculateDiffractionRange(prepared, { start: 0, end: 7 })]));
  assert.deepEqual(result, calculateDiffraction(frame));
  const source = runParserSteps(prepareDiffractionSourceSteps(frame));
  const a = runParserSteps(enumerateDiffractionSteps(source, { wavelength: 1.5406 }));
  const b = runParserSteps(enumerateDiffractionSteps(source, { wavelength: .71073 }));
  assert.equal(a.fractional, b.fractional); assert.equal(a.coefficients, b.coefficients); assert.notEqual(a.hkls, b.hkls);
  assert.throws(() => runParserSteps(enumerateDiffractionSteps(source, { useThermal: false })), /thermal-displacement setting/);
  assert.throws(() => runParserSteps(finalizeDiffractionSteps(prepared, [calculateDiffractionRange(prepared, { end: 7 })])), /incomplete/);
});

test('scientific and work-limit validation rejects malformed inputs rather than inventing chemistry or infinite work', () => {
  for (const parameters of [{ wavelength: 0 }, { wavelength: .1 }, { minAngle: 90, maxAngle: 90 }, { maxAngle: 180 }, { step: 1e-8 }, { fwhm: 0 }, { useThermal: 1 }, { surprise: true }]) assert.throws(() => normalizeDiffractionParameters(parameters));
  const frame = fixture('sc', 1, 4, 'Type 1'); assert.throws(() => prepareDiffraction(frame), /element|symbol|neutral/i);
  frame.typeLabels = ['Si']; frame.cell.pbc[0] = false; assert.throws(() => prepareDiffraction(frame), /periodic/); frame.cell.pbc[0] = true;
  frame.properties = [{ name: 'occupancy', data: Float64Array.of(NaN) }]; assert.throws(() => prepareDiffraction(frame), /occupancy/);
  frame.properties = [{ name: 'Uiso', data: Float64Array.of(-.1) }]; assert.throws(() => prepareDiffraction(frame), /nonnegative/);
  assert.doesNotThrow(() => prepareDiffraction(frame, { useThermal: false }));
  frame.properties = []; frame.cell.vectors = Float64Array.from([1e5, 0, 0, 0, 1e5, 0, 0, 0, 1e5]); assert.throws(() => prepareDiffraction(frame), /candidate budget/);
});

test('async preparation and structure-factor work cancel without mutating source coordinates', async () => {
  const frame = fixture('fcc', 3), original = frame.fractional.slice(), controller = new AbortController();
  await assert.rejects(calculateDiffractionAsync(frame, {}, { signal: controller.signal, budgetMs: 0, yieldControl: async () => controller.abort() }), { name: 'AbortError' });
  assert.deepEqual(frame.fractional, original);
});

test('peak and curve CSV exports retain scientific values, hkl multiplicities and explicit settings', async () => {
  const result = calculateDiffraction(fixture('diamond', 1, 5.431, 'Si'));
  for (const kind of ['peaks', 'profile']) {
    const output = runParserSteps(diffractionCsvSteps(result, { kind, stem: 'Si' })), text = await output.blob.text();
    assert.match(text, /wavelength_A/); assert.match(text, /1\.5406/); assert.equal(text.trim().split(/\r?\n/).length, 1 + (kind === 'peaks' ? result.peaks.length : result.profile.twoTheta.length));
    assert.match(output.filename, new RegExp(`Si-xrd-${kind}\\.csv`));
  }
});

test('radiation defaults preserve legacy X-ray settings and validate each scattering model domain', () => {
  assert.deepEqual(normalizeDiffractionParameters(), DIFFRACTION_DEFAULTS);
  assert.deepEqual(normalizeDiffractionParameters({ radiation: 'electron' }), DIFFRACTION_RADIATION_DEFAULTS.electron);
  assert.equal(normalizeDiffractionParameters({ radiation: 'neutron' }).wavelength, 1.8);
  for (const energy of [80, 100, 200, 300]) assert.doesNotThrow(() => normalizeDiffractionParameters({ radiation: 'electron', wavelength: electronWavelengthFromEnergy(energy) }));
  assert.throws(() => normalizeDiffractionParameters({ radiation: 'electron', maxAngle: 10 }), /C4322/);
  assert.doesNotThrow(() => normalizeDiffractionParameters({ radiation: 'neutron', wavelength: .1 }));
  for (const radiation of ['gamma', '', null, 1]) assert.throws(() => normalizeDiffractionParameters({ radiation }), /radiation/);
  const frame = fixture(), old = calculateDiffraction(frame, { useThermal: false });
  assert.deepEqual(calculateDiffraction(frame, { radiation: 'xray', useThermal: false }), old);
});

test('kinematic electron diffraction uses five-Gaussian amplitudes and electron Bragg angles with FCC absences', () => {
  const frame = fixture(), settings = { radiation: 'electron', useThermal: false }, prepared = prepareDiffraction(frame, settings);
  assert.equal(prepared.coefficientStride, 10);
  const index = reflection(prepared, [1, 1, 1]), s2 = 3 / (4 * 3.615 ** 2), coefficients = getElectronScatteringCoefficients('Cu');
  let factor = 0; for (let i = 0; i < 5; i++) factor += coefficients[i] * Math.exp(-coefficients[i + 5] * s2);
  close(evaluatePreparedScatteringFactor(prepared, 0, s2), factor);
  close(evaluateDiffractionReflection(prepared, index).intensity, 16 * factor ** 2);
  const result = calculateDiffraction(frame, settings), first = result.peaks[0];
  close(first.twoTheta, 2 * Math.asin(electronWavelengthFromEnergy(200) * Math.sqrt(3) / (2 * 3.615)) * 180 / Math.PI);
  assert.equal(first.multiplicity, 8); assert.equal(result.scatteringUnits, 'Å'); assert.equal(result.intensityUnits, 'Å²');
  for (const peak of result.peaks) for (const hkl of peak.hkls) assert.ok(hkl.every(v => Math.abs(v % 2) === Math.abs(hkl[0] % 2)));
  assert.match(result.warnings.join(' '), /dynamical/);
});

test('neutron structure factors retain signed coherent lengths, interference, deuterium and genuine weak reflections', () => {
  const frame = fixture('bcc', 1, 4, 'H'); frame.typeLabels = ['H', 'Cu']; frame.types = Uint8Array.of(0, 1);
  const parameters = { radiation: 'neutron', useThermal: false, lorentzPolarization: false };
  const prepared = prepareDiffraction(frame, parameters), bH = getNeutronScatteringLength('H'), bCu = getNeutronScatteringLength('Cu');
  assert.ok(bH < 0); assert.equal(prepared.coefficientStride, 1);
  const odd = evaluateDiffractionReflection(prepared, reflection(prepared, [1, 0, 0]));
  const even = evaluateDiffractionReflection(prepared, reflection(prepared, [2, 0, 0]));
  close(odd.real, bH - bCu); close(even.real, bH + bCu); close(odd.intensity, (bH - bCu) ** 2);
  assert.ok(odd.intensity > even.intensity);
  frame.properties.push({ name: 'occupancy', data: Float64Array.of(1, -bH / bCu + 1e-5) });
  const weak = calculateDiffraction(frame, parameters);
  assert.ok(weak.peaks.some(peak => peak.hkls.some(hkl => hkl[0] === 2 && hkl[1] === 0 && hkl[2] === 0)));
  frame.typeLabels[0] = 'D';
  const deuterated = prepareDiffraction(frame, parameters); close(evaluatePreparedScatteringFactor(deuterated, 0, 0), 6.671);
  assert.equal(weak.scatteringUnits, 'fm'); assert.match(weak.warnings.join(' '), /magnetic/);
});

test('electron and neutron powder corrections omit X-ray polarization and retain thermal attenuation', () => {
  for (const radiation of ['electron', 'neutron']) {
    const frame = fixture('sc', 1, 4, 'Si'), plain = calculateDiffraction(frame, { radiation, useThermal: false, lorentzPolarization: false });
    const corrected = calculateDiffraction(frame, { radiation, useThermal: false });
    plain.peaks.forEach((peak, i) => {
      const theta = peak.twoTheta * Math.PI / 360;
      close(corrected.peaks[i].intensity / peak.intensity, 1 / (Math.sin(theta) ** 2 * Math.cos(theta)));
    });
    assert.equal(corrected.geometryCorrection, 'powder Lorentz');
    frame.properties.push({ name: 'Uiso', data: Float64Array.of(.03) });
    const prepared = prepareDiffraction(frame, { radiation }), plainPrepared = prepareDiffraction(frame, { radiation, useThermal: false });
    const index = reflection(prepared, [1, 0, 0]);
    close(evaluateDiffractionReflection(prepared, index).intensity / evaluateDiffractionReflection(plainPrepared, index).intensity, Math.exp(-4 * Math.PI ** 2 * .03 / 16));
  }
});

test('explicit deuterium shares hydrogen electronic factors while preserving its nuclear amplitude and source label', () => {
  const hydrogen = fixture('sc', 1, 4, 'H'), deuterium = fixture('sc', 1, 4, 'D');
  const source = runParserSteps(prepareDiffractionSourceSteps(deuterium, { radiation: 'neutron', useThermal: false }));
  for (const radiation of ['xray', 'electron']) {
    const settings = { radiation, useThermal: false };
    const h = calculateDiffraction(hydrogen, settings), d = calculateDiffraction(deuterium, settings);
    assert.deepEqual(d.peaks, h.peaks); assert.deepEqual(d.profile, h.profile);
    const target = runParserSteps(retargetDiffractionSourceSteps(source, settings));
    assert.deepEqual(target.typeLabels, ['D']); assert.equal(target.fractional, source.fractional);
    const prepared = runParserSteps(enumerateDiffractionSteps(target, settings));
    assert.deepEqual(runParserSteps(finalizeDiffractionSteps(prepared, [calculateDiffractionRange(prepared)])), d);
  }
  assert.equal(source.coefficients[0], 6.671); assert.deepEqual(source.typeLabels, ['D']);
  const h = prepareDiffraction(hydrogen, { radiation: 'neutron', useThermal: false });
  assert.ok(evaluatePreparedScatteringFactor(h, 0, 0) < 0);
  assert.notEqual(source.coefficients[0], h.coefficients[0]);
});

test('radiation retargeting reuses geometry and refreshes only scattering tables without mutating other models', () => {
  const source = runParserSteps(prepareDiffractionSourceSteps(fixture())), xray = source.coefficients.slice();
  for (const radiation of ['electron', 'neutron']) {
    const target = runParserSteps(retargetDiffractionSourceSteps(source, { radiation }));
    for (const key of ['fractional', 'types', 'occupancy', 'thermal', 'cellVectors']) assert.equal(target[key], source[key]);
    assert.equal(target.radiation, radiation); assert.notEqual(target.coefficients, source.coefficients);
    assert.equal(runParserSteps(retargetDiffractionSourceSteps(target, { radiation })), target);
    assert.throws(() => runParserSteps(enumerateDiffractionSteps(source, { radiation })), /radiation setting/);
    const prepared = runParserSteps(enumerateDiffractionSteps(target, { radiation }));
    const split = Math.floor(prepared.reflectionCount / 2);
    assert.deepEqual(runParserSteps(finalizeDiffractionSteps(prepared, [calculateDiffractionRange(prepared, { end: split }), calculateDiffractionRange(prepared, { start: split })])), calculateDiffraction(fixture(), { radiation }));
  }
  assert.deepEqual(source.coefficients, xray); assert.equal(source.radiation, 'xray');
  const unknown = runParserSteps(prepareDiffractionSourceSteps(fixture('sc', 1, 4, 'Tc')));
  assert.throws(() => runParserSteps(retargetDiffractionSourceSteps(unknown, { radiation: 'neutron' })), /natural|isotope|unsupported/i);
  assert.equal(unknown.radiation, 'xray');
});

test('electron and neutron CSVs identify radiation, scattering model, amplitude units and geometry correction', async () => {
  for (const radiation of ['electron', 'neutron']) for (const kind of ['peaks', 'profile']) {
    const result = calculateDiffraction(fixture(), { radiation }), output = runParserSteps(diffractionCsvSteps(result, { kind }));
    const text = await output.blob.text();
    assert.match(text, /radiation,scattering_model,scattering_units,intensity_units,geometry_correction/);
    assert.match(text, new RegExp(radiation)); assert.ok(text.includes(result.scatteringModel)); assert.ok(text.includes(result.scatteringUnits));
    assert.match(output.filename, new RegExp(`${radiation}-diffraction-${kind}\\.csv`));
  }
});

test('peak CSV distinguishes X-ray polarization from optional electron and neutron powder Lorentz correction', async () => {
  for (const radiation of ['xray', 'electron', 'neutron']) for (const enabled of [true, false]) {
    const result = calculateDiffraction(fixture(), { radiation, lorentzPolarization: enabled });
    const output = runParserSteps(diffractionCsvSteps(result));
    const [header, row] = (await output.blob.text()).trim().split('\r\n');
    const fields = row.match(/"[^"]*"|[^,]+/g), names = header.split(',');
    assert.equal(fields[names.indexOf('lorentz_polarization')], String(radiation === 'xray' && enabled));
    assert.equal(fields[names.indexOf('geometry_correction')], !enabled ? 'none' : radiation === 'xray' ? 'Lorentz-polarization' : 'powder Lorentz');
  }
});
