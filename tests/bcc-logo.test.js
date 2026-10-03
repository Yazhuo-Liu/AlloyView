import assert from 'node:assert/strict';
import test from 'node:test';
import { createBccLogoModel } from '../src/render/bcc-logo.js';

test('BCC logo has eight unique cubic corners and one body center', () => {
  const { atoms, bonds } = createBccLogoModel();
  assert.equal(atoms.length, 9);
  const center = atoms.findIndex(atom => atom.position.every(coordinate => coordinate === 0));
  assert.notEqual(center, -1);
  const corners = atoms.filter((_, index) => index !== center);
  assert.equal(new Set(corners.map(atom => atom.position.join(','))).size, 8);
  const halfSide = Math.abs(corners[0].position[0]);
  assert.ok(halfSide > 0);
  for (const atom of corners) {
    assert.ok(atom.position.every(coordinate => Math.abs(coordinate) === halfSide));
    assert.ok(atom.radius > 0 && atom.color.every(channel => channel >= 0 && channel <= 1));
  }
  assert.equal(bonds.length, 8);
  const neighbors = new Set();
  for (const bond of bonds) {
    assert.ok(bond.includes(center), 'every BCC bond starts at the body center');
    const corner = bond.find(index => index !== center);
    neighbors.add(corner);
    assert.ok(Math.abs(Math.hypot(...atoms[corner].position) - Math.sqrt(3) * halfSide) < 1e-12);
  }
  assert.equal(neighbors.size, 8, 'all eight nearest neighbors must be connected');
});

test('the cell wireframe has twelve edges and three edges at each corner', () => {
  const { atoms, edges } = createBccLogoModel();
  assert.equal(edges.length, 12);
  assert.equal(new Set(edges.map(edge => [...edge].sort().join(','))).size, 12);
  const degree = Array(atoms.length).fill(0);
  for (const [first, second] of edges) {
    const vector = atoms[first].position.map((value, axis) => value - atoms[second].position[axis]);
    assert.equal(vector.filter(value => value !== 0).length, 1, 'cell edges must not be face or body diagonals');
    degree[first] += 1;
    degree[second] += 1;
  }
  assert.deepEqual(degree.filter(value => value > 0), Array(8).fill(3));
});
