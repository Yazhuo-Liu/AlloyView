import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ELEMENT_SYMBOLS } from '../src/data/chemical-elements.js';
import { ELECTRON_SCATTERING_SYMBOLS, ELECTRON_SCATTERING_MAX_S,
  NEUTRON_SCATTERING_SYMBOLS, getElectronScatteringCoefficients,
  electronScatteringFactor, getNeutronScatteringLength, neutronScatteringFactor,
  electronWavelengthFromEnergy } from '../src/crystal/diffraction-scattering.js';
import { xrayScatteringFactor } from '../src/crystal/xray-scattering.js';

const near = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} != ${expected} within ${tolerance}`);

test('C4322 retains neutral H–Cf five-Gaussian coefficients, including negative fitted terms', () => {
  assert.deepEqual(ELECTRON_SCATTERING_SYMBOLS, ELEMENT_SYMBOLS.slice(0, 98));
  assert.deepEqual(getElectronScatteringCoefficients('Si'),
    [.2519, .6372, 1.3795, 2.5082, 1.05, .3075, 2.0174, 9.6746, 29.3744, 80.4732]);
  assert.equal(getElectronScatteringCoefficients('Rb')[3], -7.7804);
  for (const symbol of ['Type 1', '1', 'X', 'Si4+', 'Fe2+', 'Si_pv', 'fe', 'Si ', 'D', 'T', 'Es', 'Og', '', 'constructor', '__proto__', null, undefined, 14]) {
    assert.throws(() => getElectronScatteringCoefficients(symbol), /unsupported neutral element/);
  }
});

test('electron factors are finite direct fits at zero and retain their independent finite-angle amplitudes', () => {
  const expected = [
    ['H', .5288, .08902690936685932, .004111154964262735],
    ['Fe', 7.1637, 1.3879712213302462, .13345381243585833],
    ['Si', 5.8268, .742519788186964, .07382788556265282],
    ['Na', 4.7758, .6402686533699584, .056505380967254264],
    ['Cl', 4.8577, .9285564540980679, .09224507057455125],
  ];
  for (const [symbol, zero, middle, endpoint] of expected) {
    near(electronScatteringFactor(symbol, 0), zero);
    near(electronScatteringFactor(symbol, 1e-20), zero);
    near(electronScatteringFactor(symbol, .5), middle);
    near(electronScatteringFactor(symbol, 2), endpoint);
  }
  for (const symbol of ELECTRON_SCATTERING_SYMBOLS) {
    let previous = Infinity;
    for (const s of [0, .05, .1, .25, .5, 1, 1.5, 2]) {
      const value = electronScatteringFactor(symbol, s);
      assert.ok(Number.isFinite(value) && value > 0 && value < previous, `${symbol} amplitude at s=${s}`);
      previous = value;
    }
  }
  // An uncorrected Mott–Bethe conversion of the IT92 forward residual would
  // diverge as s approaches zero. The independent electron table never does.
  assert.notEqual(xrayScatteringFactor('Si', 0), 14);
  near(electronScatteringFactor('Si', Number.MIN_VALUE), 5.8268);
});

test('electron fits include their documented endpoint and reject extrapolation or malformed s', () => {
  assert.equal(ELECTRON_SCATTERING_MAX_S, 2);
  assert.ok(Number.isFinite(electronScatteringFactor('Si', 2)));
  for (const s of [-.1, NaN, Infinity, -Infinity, 2.00001, '0.5', null, undefined]) {
    assert.throws(() => electronScatteringFactor('Si', s), /0 ≤ s ≤ 2/);
  }
});

test('neutron coherent amplitudes preserve signed interference and explicit deuterium independently of natural H', () => {
  assert.equal(NEUTRON_SCATTERING_SYMBOLS.length, 84);
  assert.ok(NEUTRON_SCATTERING_SYMBOLS.includes('D'));
  for (const [symbol, expected] of [['H', -3.739], ['D', 6.671], ['Li', -1.9],
    ['Ti', -3.438], ['V', -.3824], ['Mn', -3.73], ['Fe', 9.45], ['Si', 4.1491],
    ['O', 5.803], ['Na', 3.63], ['Cl', 9.577], ['Th', 10.31], ['U', 8.417]]) {
    assert.equal(getNeutronScatteringLength(symbol), expected);
    for (const s of [0, .5, 2, 100]) assert.equal(neutronScatteringFactor(symbol, s), expected);
  }
  const hydrogen = getNeutronScatteringLength('H');
  const oxygen = getNeutronScatteringLength('O');
  const deuterium = getNeutronScatteringLength('D');
  near((2 * hydrogen + oxygen) ** 2, 2.805625);
  near((2 * deuterium + oxygen) ** 2, 366.531025);
  assert.ok((2 * hydrogen + oxygen) ** 2 < (2 * Math.abs(hydrogen) + oxygen) ** 2);
});

test('neutron missing and isotope-specific values reject explicitly rather than guessing zero or a default isotope', () => {
  for (const symbol of ['Tc', 'Pm', 'Ra', 'Pa', 'Np', 'Am', 'Cm']) {
    assert.ok(!NEUTRON_SCATTERING_SYMBOLS.includes(symbol));
    assert.throws(() => getNeutronScatteringLength(symbol), /requires an explicit isotope choice/);
  }
  for (const symbol of ['X', 'Po', 'At', 'Rn', 'Fr', 'Ac', 'Pu', 'Bk', 'Cf', 'Og',
    'Type 1', '1', 'Fe2+', '57Fe', 'Fe57', '2H', 'H2', 'D ', 'T', 'h', '', 'constructor', '__proto__', null, undefined, 1]) {
    assert.ok(!NEUTRON_SCATTERING_SYMBOLS.includes(symbol));
    assert.throws(() => getNeutronScatteringLength(symbol), /no tabulated coherent length/);
  }
  for (const s of [-.1, NaN, Infinity, -Infinity, '0.5', null, undefined]) {
    assert.throws(() => neutronScatteringFactor('Fe', s), /finite and nonnegative/);
  }
});

test('relativistic electron energies yield known 80–300 keV wavelengths and reject invalid inputs', () => {
  for (const [energy, wavelength] of [[80, .04175716074647679], [100, .03701436611487084],
    [200, .025079340436272274], [300, .01968748899648993]]) {
    near(electronWavelengthFromEnergy(energy), wavelength, 1e-14);
  }
  // Relativistic correction shortens the 200 keV wavelength compared with
  // the nonrelativistic h/sqrt(2mE) approximation (~0.02742 Å).
  assert.ok(electronWavelengthFromEnergy(200) < .027);
  for (const value of [0, -1, NaN, Infinity, -Infinity, '200', null, undefined, Number.MIN_VALUE, Number.MAX_VALUE]) {
    assert.throws(() => electronWavelengthFromEnergy(value), /energy/i);
  }
});

test('shared electron arrays and supported species remain immutable across analyses', () => {
  const coefficients = getElectronScatteringCoefficients('Si');
  assert.equal(getElectronScatteringCoefficients('Si'), coefficients);
  assert.ok(Object.isFrozen(coefficients));
  assert.ok(Object.isFrozen(ELECTRON_SCATTERING_SYMBOLS));
  assert.ok(Object.isFrozen(NEUTRON_SCATTERING_SYMBOLS));
  assert.throws(() => { coefficients[0] = 0; }, TypeError);
  assert.throws(() => { NEUTRON_SCATTERING_SYMBOLS[0] = 'D'; }, TypeError);
  near(electronScatteringFactor('Si', .5), .742519788186964);
});

test('electron/neutron source and adaptation remain checksum-pinned with the distributed MPL license', async () => {
  const root = new URL('../', import.meta.url);
  const sums = await readFile(new URL('third_party/gemmi-diffraction/SHA256SUMS', root), 'utf8');
  for (const line of sums.trim().split('\n')) {
    const [expected, path] = line.split(/\s+/);
    const content = await readFile(new URL(path, root));
    assert.equal(createHash('sha256').update(content).digest('hex'), expected, path);
  }
  const data = await readFile(new URL('src/crystal/diffraction-scattering-data.js', root), 'utf8');
  assert.match(data, /SPDX-License-Identifier: MPL-2\.0/);
  assert.match(data, /Copyright 2020, 2022 Global Phasing Ltd/);
});
