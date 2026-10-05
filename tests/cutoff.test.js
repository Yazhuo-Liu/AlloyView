import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COORDINATION_CUTOFF_PRESETS,
  coordinationCutoffPresetForElement,
  inferCoordinationCutoffPreset,
  recommendCoordinationCutoff,
} from '../src/analysis/cutoff.js';

test('coordination cutoff recommendation uses known metallic element labels', () => {
  const result = recommendCoordinationCutoff({ typeLabels: ['Ni'] });
  assert.equal(result.value, 2.85);
  assert.equal(result.method, 'metallic-radii');
});

test('coordination cutoff recommendation covers the largest type in an alloy', () => {
  assert.equal(recommendCoordinationCutoff({ typeLabels: ['Ni', 'Al'] }).value, 3.3);
});

test('coordination cutoff recommendation is explicit about numeric type fallback', () => {
  const result = recommendCoordinationCutoff({ typeLabels: ['Type 1'] });
  assert.equal(result.value, 3);
  assert.equal(result.method, 'fallback');
});

test('coordination presets preserve existing metal recommendations and are immutable', () => {
  const previous = {
    Ag: 3.3, Al: 3.3, Au: 3.3, Co: 2.9, Cr: 2.95, Cu: 2.95,
    Fe: 2.85, Mg: 3.7, Mn: 2.9, Mo: 3.2, Nb: 3.35, Ni: 2.85,
    Pb: 4, Pd: 3.15, Pt: 3.2, Sn: 3.65, Ti: 3.4, V: 3.1,
    W: 3.2, Zn: 3.1, Zr: 3.7,
  };
  assert.ok(Object.isFrozen(COORDINATION_CUTOFF_PRESETS));
  for (const [symbol, cutoff] of Object.entries(previous)) {
    const preset = coordinationCutoffPresetForElement(symbol);
    assert.equal(preset.cutoff, cutoff, symbol);
    assert.ok(Object.isFrozen(preset), symbol);
    assert.equal(recommendCoordinationCutoff({ typeLabels: [symbol] }).value, cutoff, symbol);
  }
  assert.equal(new Set(COORDINATION_CUTOFF_PRESETS.map(preset => preset.symbol)).size, COORDINATION_CUTOFF_PRESETS.length);
});

test('new transition and light-metal presets use the existing referenced crystal geometry', () => {
  const expected = { Be: 2.65, Ca: 4.55, Cd: 3.8, Hf: 3.7, Ir: 3.1, Li: 3.45,
    Na: 4.2, Os: 3.15, Re: 3.15, Rh: 3.1, Ru: 3.1, Sc: 3.8, Ta: 3.3, Y: 4.2 };
  for (const [symbol, cutoff] of Object.entries(expected)) {
    const preset = coordinationCutoffPresetForElement(symbol);
    assert.equal(preset.cutoff, cutoff, symbol);
    assert.equal(preset.method, 'lattice-reference', symbol);
    assert.match(preset.source, /ASE 3\.26\.0/, symbol);
    assert.ok(preset.name.length > 2, symbol);
  }
});

test('new BCC preset rounding keeps the next shell outside the first-shell cutoff', () => {
  for (const [symbol, nearestDistance, secondShellDistance] of [
    ['Li', 3.0224286619, 3.49], ['Na', 3.663287458, 4.23], ['Ta', 2.8665440865, 3.31],
  ]) {
    const { cutoff } = coordinationCutoffPresetForElement(symbol);
    assert.ok(cutoff > nearestDistance, symbol);
    assert.ok(cutoff < secondShellDistance, symbol);
  }
});

test('a genuine element label selects its preset and distinguishes a supported alloy', () => {
  const nickel = inferCoordinationCutoffPreset({ typeLabels: ['Ni'], types: new Uint16Array([0, 0]) });
  assert.equal(nickel.symbol, 'Ni');
  assert.equal(nickel.value, 2.85);
  assert.equal(nickel.mixed, false);
  assert.deepEqual(nickel.elements, ['Ni']);

  const alloy = inferCoordinationCutoffPreset({ typeLabels: ['Ni', 'Al'], types: new Uint16Array([0, 1, 0]) });
  assert.equal(alloy.symbol, 'Al');
  assert.equal(alloy.value, 3.3);
  assert.equal(alloy.mixed, true);
  assert.deepEqual(alloy.elements, ['Ni', 'Al']);
  assert.match(alloy.message, /largest constituent preset \(Al\)/);
});

test('only types actually present in a frame participate in automatic element choice', () => {
  const frame = { typeLabels: ['Ni', 'Al', 'Type 99'], types: new Uint16Array([0, 0]) };
  assert.equal(inferCoordinationCutoffPreset(frame).symbol, 'Ni');
  assert.equal(recommendCoordinationCutoff(frame).value, 2.85);

  const duplicateLabels = { typeLabels: ['Ni', 'Ni'], types: new Uint16Array([0, 1]) };
  assert.equal(inferCoordinationCutoffPreset(duplicateLabels).mixed, false);
  assert.equal(inferCoordinationCutoffPreset({ typeLabels: ['Ni'], types: [] }).symbol, null);
});

test('unknown or merely element-like labels and filenames do not identify an element', () => {
  for (const label of ['Type 1', '1', 'ni', 'Ni1', 'Ni alloy', 'Si', 'unknown']) {
    assert.equal(coordinationCutoffPresetForElement(label), null, label);
    const result = inferCoordinationCutoffPreset({ typeLabels: [label], title: 'Ni.cfg' });
    assert.equal(result.symbol, null, label);
    assert.equal(result.method, 'fallback', label);
  }
  const partial = inferCoordinationCutoffPreset({ typeLabels: ['Ni', 'Type 2'] });
  assert.equal(partial.symbol, null);
  assert.equal(partial.value, 3);
  assert.equal(partial.mixed, true);
  assert.equal(inferCoordinationCutoffPreset(null).symbol, null);
});
