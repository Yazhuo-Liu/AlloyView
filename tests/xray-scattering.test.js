import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ELEMENT_SYMBOLS } from '../src/data/chemical-elements.js';
import { getXrayScatteringCoefficients, xrayScatteringFactor, XRAY_SCATTERING_SYMBOLS,
  XRAY_SCATTERING_MAX_S } from '../src/crystal/xray-scattering.js';

const near = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} != ${expected} within ${tolerance}`);

test('neutral IT92 data covers every identified element H through Cf without pseudo-element or ionic fallbacks', () => {
  assert.deepEqual(XRAY_SCATTERING_SYMBOLS, ELEMENT_SYMBOLS.slice(0, 98));
  assert.equal(XRAY_SCATTERING_SYMBOLS.at(-1), 'Cf');
  for (const symbol of ['Type 1', '1', 'X', 'Fe2+', 'Fe3+', 'Fe1', 'Si_pv', 'fe', 'FE', 'Fe ', 'Es', 'Og', '', 'constructor', '__proto__']) {
    assert.throws(() => getXrayScatteringCoefficients(symbol), /unsupported neutral element/);
  }
  for (const value of [undefined, null, 26]) assert.throws(() => getXrayScatteringCoefficients(value), /unsupported neutral element/);
});

test('the published nine-coefficient convention is preserved without forcing f(0) to atomic number', () => {
  assert.deepEqual(getXrayScatteringCoefficients('Fe'),
    [11.7695, 7.3573, 3.5222, 2.3045, 4.7611, .3072, 15.3535, 76.8805, 1.0369]);
  near(xrayScatteringFactor('H', 0), .999953);
  near(xrayScatteringFactor('Fe', 0), 25.9904);
  near(xrayScatteringFactor('Si', 0), 13.9976);
  near(xrayScatteringFactor('Na', 0), 10.9924);
  near(xrayScatteringFactor('Cl', 0), 17.0005);
  for (let z = 1; z <= 98; z++) near(xrayScatteringFactor(XRAY_SCATTERING_SYMBOLS[z - 1], 0), z, .061);
});

test('finite-angle atomic amplitudes use s squared and decay with scattering vector rather than remaining equal to Z', () => {
  near(xrayScatteringFactor('Fe', .5), 11.505687515802267);
  near(xrayScatteringFactor('Si', .5), 6.240088511990151);
  near(xrayScatteringFactor('Na', .5), 4.290765074565711);
  near(xrayScatteringFactor('Cl', .5), 7.310747330601885);
  for (const symbol of XRAY_SCATTERING_SYMBOLS) {
    let previous = Infinity;
    for (const s of [0, .05, .1, .25, .5, 1, 1.5, 1.99]) {
      const value = xrayScatteringFactor(symbol, s);
      assert.ok(Number.isFinite(value) && value > 0 && value < previous, `${symbol} amplitude at s=${s}`);
      previous = value;
    }
  }
});

test('the scientific fit range rejects nonfinite values and unsupported high-angle extrapolation', () => {
  assert.equal(XRAY_SCATTERING_MAX_S, 2);
  assert.ok(Number.isFinite(xrayScatteringFactor('Si', 2 - Number.EPSILON)));
  for (const s of [-.1, NaN, Infinity, -Infinity, 2, 2.0001, '0.5', null, undefined]) {
    assert.throws(() => xrayScatteringFactor('Si', s), /0 ≤ s < 2/);
  }
});

test('coefficient storage is immutable and repeated lookups do not allocate or let one analysis modify another', () => {
  const coefficients = getXrayScatteringCoefficients('Fe');
  assert.equal(getXrayScatteringCoefficients('Fe'), coefficients);
  assert.ok(Object.isFrozen(coefficients)); assert.ok(Object.isFrozen(XRAY_SCATTERING_SYMBOLS));
  assert.throws(() => { coefficients[0] = 0; }, TypeError);
  assert.throws(() => { XRAY_SCATTERING_SYMBOLS[0] = 'Fe'; }, TypeError);
  near(xrayScatteringFactor('Fe', .5), 11.505687515802267);
});

test('vendored source, MPL license and adapted table match their recorded checksums', async () => {
  const root = new URL('../', import.meta.url);
  const checksums = await readFile(new URL('third_party/gemmi-it92/SHA256SUMS', root), 'utf8');
  for (const line of checksums.trim().split('\n')) {
    const [expected, path] = line.split(/\s+/);
    const content = await readFile(new URL(path, root));
    assert.equal(createHash('sha256').update(content).digest('hex'), expected, path);
  }
  const data = await readFile(new URL('src/crystal/xray-scattering-data.js', root), 'utf8');
  assert.match(data, /SPDX-License-Identifier: MPL-2\.0/);
  assert.match(data, /Copyright 2019 Global Phasing Ltd/);
});
