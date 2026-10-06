import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVoronoi, calculateVoronoiGeometry, VORONOI_FIELDS } from '../src/analysis/voronoi.js';
import { createCell } from '../src/data/model.js';

function binaryCrystal() {
  const fractional = [], types = [];
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
    fractional.push(a / 2, b / 2, c / 2); types.push((a + b + c) % 2);
  }
  return { fractional: Float64Array.from(fractional), types: Uint16Array.from(types), typeLabels: ['Ni', 'Cu'],
    cell: createCell({ vectors: [4, 0, 0, 0, 4, 0, 0, 0, 4] }) };
}

function near(actual, expected, message) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 2e-10 * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} ≈ ${expected}`);
}

test('element subsets retessellate both centers and neighbors instead of masking full-crystal results', async () => {
  const input = binaryCrystal(), savedCoordinates = input.fractional.slice(), savedTypes = input.types.slice();
  const full = await calculateVoronoi(input);
  for (let atom = 0; atom < 8; atom++) {
    near(full.atomicVolume[atom], 8, 'full simple-cubic atomic volume');
    assert.equal(full.voronoiCoordination[atom], 6);
  }
  for (const [type, label] of input.typeLabels.entries()) {
    const included = Array.from(input.types, (value, atom) => value === type ? atom : -1).filter(atom => atom >= 0);
    const selected = await calculateVoronoi(input, { selectedTypes: [label] });
    assert.deepEqual([...selected.analyzedAtomIndices], included);
    assert.deepEqual(selected.selectedTypes, [label]);
    assert.equal(selected.summary.atomCount, 4);
    near(selected.summary.totalVolume, 64, 'subset still partitions the complete periodic domain');
    near(selected.summary.volumeError, 0, 'subset domain-volume conservation');
    assert.equal(selected.volumeHistogram.reduce((sum, bin) => sum + bin.count, 0), 4);
    for (let atom = 0; atom < 8; atom++) {
      if (input.types[atom] === type) {
        near(selected.atomicVolume[atom], 16, 'one element is a four-site FCC lattice');
        near(selected.voronoiSurfaceArea[atom], 24 * Math.SQRT2, 'FCC surface area');
        assert.equal(selected.voronoiCoordination[atom], 12);
        assert.equal(selected.voronoiIndices[atom], '<0,12,0,0>');
        assert.equal(selected.faceOffsets[atom + 1] - selected.faceOffsets[atom], 12);
        for (let face = selected.faceOffsets[atom]; face < selected.faceOffsets[atom + 1]; face++) {
          assert.ok(included.includes(selected.faceNeighbors[face]), 'face neighbors refer only to original indices of selected sites');
          assert.equal(selected.faceOrders[face], 4);
          near(selected.faceAreas[face], 2 * Math.SQRT2, 'FCC rhombus area');
        }
      } else {
        for (const field of Object.keys(VORONOI_FIELDS)) assert.ok(Number.isNaN(selected[field][atom]), `${field} excludes ${atom} with NaN`);
        assert.equal(selected.voronoiIndices[atom], '');
        assert.equal(selected.faceOffsets[atom + 1], selected.faceOffsets[atom], 'excluded centers have no face row');
      }
    }
    const geometry = await calculateVoronoiGeometry(input, { atomIndex: included[0], selectedTypes: [label] });
    assert.equal(geometry.atomIndex, included[0]);
    assert.equal(geometry.faceOffsets.length - 1, 12);
    assert.ok([...geometry.faceNeighbors].every(neighbor => included.includes(neighbor)), 'inspected-cell geometry uses the same selected tessellation');
  }
  assert.deepEqual(input.fractional, savedCoordinates);
  assert.deepEqual(input.types, savedTypes);
  assert.deepEqual(input.typeLabels, ['Ni', 'Cu']);
});

test('selected element labels survive numerical type-index reordering', async () => {
  const input = binaryCrystal(), reordered = { ...input, typeLabels: ['Cu', 'Ni'],
    types: Uint16Array.from(input.types, value => 1 - value) };
  const first = await calculateVoronoi(input, { selectedTypes: ['Ni'] });
  const second = await calculateVoronoi(reordered, { selectedTypes: ['Ni'] });
  for (const field of [...Object.keys(VORONOI_FIELDS), 'faceOffsets', 'faceAreas', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted']) {
    assert.deepEqual(second[field], first[field], `${field} follows labels rather than their numeric encoding`);
  }
  assert.deepEqual(second.voronoiIndices, first.voronoiIndices);
  assert.deepEqual(second.analyzedAtomIndices, first.analyzedAtomIndices);
});

test('explicitly selecting all element types preserves the unfiltered complete tessellation', async () => {
  const input = binaryCrystal();
  const all = await calculateVoronoi(input), explicit = await calculateVoronoi(input, { selectedTypes: ['Cu', 'Ni'] });
  for (const field of [...Object.keys(VORONOI_FIELDS), 'faceOffsets', 'faceAreas', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted']) {
    assert.deepEqual([...explicit[field]], [...all[field]], `${field} is unchanged when every element is included`);
  }
  assert.deepEqual(explicit.voronoiIndices, all.voronoiIndices);
  near(explicit.summary.totalVolume, 64, 'all-element volume');
});
