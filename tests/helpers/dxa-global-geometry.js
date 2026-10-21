import assert from 'node:assert/strict';

// Every binary64 coordinate is an exact dyadic rational. Use one shared power
// of two so determinant signs can be checked with integer arithmetic, including
// the nearly coplanar/co-spherical tetrahedra of perturbed perfect lattices.
// This independent test oracle is intentionally not in the timed native path.
export function integerCoordinates(vertices) {
  assert.ok(vertices.length % 3 === 0);
  const view = new DataView(new ArrayBuffer(8)), values = [];
  let commonExponent = Infinity;
  for (const value of vertices) {
    assert.ok(Number.isFinite(value), 'Geometry contains a non-finite coordinate.');
    view.setFloat64(0, value, false);
    const bits = view.getBigUint64(0, false), encodedExponent = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & ((1n << 52n) - 1n);
    const mantissa = (bits >> 63n ? -1n : 1n) * (encodedExponent ? (1n << 52n) | fraction : fraction);
    const exponent = encodedExponent ? encodedExponent - 1075 : -1074;
    if (mantissa) commonExponent = Math.min(commonExponent, exponent);
    values.push([mantissa, exponent]);
  }
  if (!Number.isFinite(commonExponent)) commonExponent = 0;
  return values.map(([mantissa, exponent]) => mantissa ? mantissa << BigInt(exponent - commonExponent) : 0n);
}

const sign = value => value > 0n ? 1 : value < 0n ? -1 : 0;
function determinant3(a, b, c) {
  return a[0] * (b[1] * c[2] - b[2] * c[1])
    - a[1] * (b[0] * c[2] - b[2] * c[0])
    + a[2] * (b[0] * c[1] - b[1] * c[0]);
}
const delta = (points, first, second) => [0, 1, 2].map(axis => points[first * 3 + axis] - points[second * 3 + axis]);

export function exactOrientation(points, [a, b, c, d]) {
  return sign(determinant3(delta(points, a, d), delta(points, b, d), delta(points, c, d)));
}

function determinant(matrix) {
  const rows = matrix.map(row => row.slice());
  let previous = 1n, parity = 1n;
  for (let column = 0; column < rows.length - 1; column++) {
    if (!rows[column][column]) {
      const pivot = rows.findIndex((row, index) => index > column && row[column]);
      if (pivot < 0) return 0n;
      [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
      parity = -parity;
    }
    const pivot = rows[column][column];
    for (let row = column + 1; row < rows.length; row++) {
      for (let next = column + 1; next < rows.length; next++)
        rows[row][next] = (rows[row][next] * pivot - rows[row][column] * rows[column][next]) / previous;
      rows[row][column] = 0n;
    }
    previous = pivot;
  }
  return parity * rows.at(-1).at(-1);
}

/** Positive means inside for a positively oriented (a-d,b-d,c-d) tetrahedron;
 * zero is an exact co-spherical tie, which is legal before symbolic tie-breaks. */
export function exactInSphere(points, tetrahedron, query) {
  const rows = Array.from(tetrahedron, vertex => {
    const row = delta(points, vertex, query);
    return [...row, row.reduce((sum, value) => sum + value * value, 0n)];
  });
  return sign(determinant(rows));
}

/** Check the complete exported adjacency graph and finite-cell geometry. Native snapshot rows
 * contain vertices[0..3], opposite-face neighbors[4..7], and finite flag[14].
 * Infinite vertices are replaced by zero by the existing snapshot exporter;
 * their shared-face geometry is therefore explicitly outside this oracle.
 * For large diagnostics callers may bound exact sphere checks; the returned
 * count then explicitly records the limited coverage. */
export function validateDxaGeometry({ vertices, tetrahedra }, { maxEmptySpherePairs = Infinity } = {}) {
  assert.ok(vertices instanceof Float64Array && vertices.length % 3 === 0);
  assert.ok(tetrahedra instanceof Uint32Array && tetrahedra.length % 16 === 0);
  assert.ok(maxEmptySpherePairs === Infinity || (Number.isSafeInteger(maxEmptySpherePairs) && maxEmptySpherePairs >= 0));
  const vertexCount = vertices.length / 3, cellCount = tetrahedra.length / 16;
  const points = integerCoordinates(vertices);
  const uniqueCells = new Set();
  let orientationSign = 0, finiteTetrahedra = 0, infiniteTetrahedra = 0, finiteNeighborPairs = 0, exactEmptySpherePairs = 0, cosphericalPairs = 0;
  for (let cell = 0; cell < cellCount; cell++) {
    const row = tetrahedra.subarray(cell * 16, cell * 16 + 16), finite = row[14] === 1;
    assert.ok(row[14] === 0 || finite, `Cell ${cell} has an invalid finite flag.`);
    let orientation = 0;
    if (finite) {
      finiteTetrahedra++;
      assert.equal(new Set(row.subarray(0, 4)).size, 4, `Cell ${cell} repeats a vertex.`);
      assert.ok(row.subarray(0, 4).every(vertex => vertex < vertexCount), `Cell ${cell} has an invalid vertex.`);
      const key = Array.from(row.subarray(0, 4)).sort((a, b) => a - b).join(',');
      assert.ok(!uniqueCells.has(key), `Cell ${cell} duplicates an existing finite tetrahedron.`);
      uniqueCells.add(key);
      orientation = exactOrientation(points, row);
      assert.notEqual(orientation, 0, `Cell ${cell} has exactly zero volume.`);
      orientationSign ||= orientation;
      assert.equal(orientation, orientationSign, `Cell ${cell} reverses the tetrahedron orientation convention.`);
    } else {
      infiniteTetrahedra++;
      assert.ok(row.subarray(0, 4).every(vertex => vertex === 0), `Infinite cell ${cell} violates the snapshot zero-vertex contract.`);
    }
    assert.equal(new Set(row.subarray(4, 8)).size, 4, `Cell ${cell} repeats a neighbor.`);
    for (let face = 0; face < 4; face++) {
      const neighbor = row[4 + face];
      assert.ok(neighbor < cellCount && neighbor !== cell, `Cell ${cell} has an invalid neighbor.`);
      const other = tetrahedra.subarray(neighbor * 16, neighbor * 16 + 16);
      const reciprocal = Array.from(other.subarray(4, 8)).flatMap((value, face) => value === cell ? [face] : []);
      assert.equal(reciprocal.length, 1, `Cell ${cell} neighbor ${neighbor} is not uniquely reciprocal.`);
      const opposite = reciprocal[0];
      if (!finite || other[14] !== 1 || neighbor < cell) continue;
      finiteNeighborPairs++;
      const shared = Array.from(row.subarray(0, 4)).filter((_, index) => index !== face).sort((a, b) => a - b);
      const otherShared = Array.from(other.subarray(0, 4)).filter((_, index) => index !== opposite).sort((a, b) => a - b);
      assert.deepEqual(otherShared, shared, `Cells ${cell}/${neighbor} disagree on their shared face.`);
      assert.equal(exactOrientation(points, [...shared, row[face]]) * exactOrientation(points, [...shared, other[opposite]]), -1,
        `Cells ${cell}/${neighbor} overlap on the same side of their shared face.`);
      if (exactEmptySpherePairs < maxEmptySpherePairs) {
        const sphere = exactInSphere(points, row.subarray(0, 4), other[opposite]);
        assert.ok(sphere * orientation <= 0, `Cells ${cell}/${neighbor} violate the exact local empty-sphere condition.`);
        exactEmptySpherePairs++;
        if (!sphere) cosphericalPairs++;
      }
    }
  }
  assert.ok(finiteTetrahedra > 0, 'The snapshot must contain finite tetrahedra.');
  const visited = new Uint8Array(cellCount), queue = [0]; visited[0] = 1;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (let face = 0; face < 4; face++) {
      const neighbor = tetrahedra[queue[cursor] * 16 + 4 + face];
      if (!visited[neighbor]) { visited[neighbor] = 1; queue.push(neighbor); }
    }
  }
  assert.equal(queue.length, cellCount, 'The complete tetrahedron adjacency graph must be connected.');
  return { vertexCount, cellCount, finiteTetrahedra, infiniteTetrahedra, finiteNeighborPairs,
    exactEmptySpherePairs, cosphericalPairs, orientationSign, infiniteFaceGeometry: 'not-exported' };
}
