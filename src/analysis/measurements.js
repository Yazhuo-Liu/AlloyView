const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (vector) => Math.hypot(...vector);

/** Exact closest periodic image of a Cartesian displacement.
 * Fractional rounding is not sufficient for a skew cell. A small QR sphere
 * search solves the closest lattice vector using only the periodic axes.
 */
export function minimumImageVector(displacement, cell) {
  if (displacement.length !== 3 || !Array.from(displacement).every(Number.isFinite)) {
    throw new Error('A measurement displacement must contain three finite coordinates.');
  }
  const result = Array.from(displacement);
  const axes = [0, 1, 2].filter((axis) => cell?.pbc?.[axis]);
  if (!axes.length) return result;
  if (cell.vectors?.length !== 9 || !Array.from(cell.vectors).every(Number.isFinite)) {
    throw new Error('Periodic measurements require a finite cell matrix.');
  }
  const basis = axes.map((axis) => Array.from(cell.vectors.slice(axis * 3, axis * 3 + 3)));
  const count = basis.length;
  const q = [];
  const r = Array.from({ length: count }, () => new Float64Array(count));
  for (let column = 0; column < count; column += 1) {
    const vector = [...basis[column]];
    // Reorthogonalization preserves the search bounds for strongly tilted cells.
    for (let pass = 0; pass < 2; pass += 1) {
      for (let row = 0; row < column; row += 1) {
        const projection = dot(q[row], vector);
        r[row][column] += projection;
        for (let axis = 0; axis < 3; axis += 1) vector[axis] -= projection * q[row][axis];
      }
    }
    r[column][column] = length(vector);
    if (!(r[column][column] > 0)) throw new Error('Periodic measurements require independent cell vectors.');
    q.push(vector.map((value) => value / r[column][column]));
  }
  const projected = q.map((vector) => dot(vector, result));
  const candidate = new Array(count).fill(0);
  for (let row = count - 1; row >= 0; row -= 1) {
    let value = projected[row];
    for (let column = row + 1; column < count; column += 1) value -= r[row][column] * candidate[column];
    candidate[row] = Math.round(value / r[row][row]);
  }
  let best = [...candidate];
  let bestSquared = projected.reduce((sum, value, row) => {
    for (let column = row; column < count; column += 1) value -= r[row][column] * candidate[column];
    return sum + value * value;
  }, 0);
  const tolerance = 1e-12 * Math.max(1, bestSquared);
  function search(row, squared) {
    if (row < 0) {
      if (squared < bestSquared) {
        bestSquared = squared;
        best = [...candidate];
      }
      return;
    }
    let target = projected[row];
    for (let column = row + 1; column < count; column += 1) target -= r[row][column] * candidate[column];
    const center = target / r[row][row];
    const span = Math.sqrt(Math.max(0, bestSquared - squared + tolerance)) / r[row][row];
    const lower = Math.ceil(center - span);
    const upper = Math.floor(center + span);
    const nearest = Math.max(lower, Math.min(upper, Math.round(center)));
    // Visiting nearest integers first usually reduces this to a few branches.
    for (let step = 0; nearest - step >= lower || nearest + step <= upper; step += 1) {
      const options = step === 0 ? [nearest] : [nearest - step, nearest + step];
      for (const integer of options) {
        if (integer < lower || integer > upper) continue;
        const residual = target - r[row][row] * integer;
        const nextSquared = squared + residual * residual;
        if (nextSquared > bestSquared + tolerance) continue;
        candidate[row] = integer;
        search(row - 1, nextSquared);
      }
    }
  }
  // An exact lattice displacement already reaches the global minimum. Avoid
  // visiting numerically equivalent images in an extremely thin skew cell.
  if (bestSquared > 0) search(count - 1, 0);
  for (let column = 0; column < count; column += 1) {
    for (let axis = 0; axis < 3; axis += 1) result[axis] -= basis[column][axis] * best[column];
  }
  return result;
}

/** Measure 2–4 ordered atom picks. Lengths and displacement components are Å,
 * angles are degrees. Displacements point from each pick to the next pick;
 * displacement and distance refer to the first pair.
 * positions may override the full frame's flat coordinate array, supply a flat
 * array of selected XYZ values, or supply one XYZ tuple per pick. For explicit
 * replica positions, minimumImage: false measures exactly what is displayed.
 * Undefined angles (coincident/collinear picks) are NaN.
 */
export function measureAtoms(frame, indices, { minimumImage = true, positions } = {}) {
  const count = frame.ids?.length ?? frame.positions?.length / 3;
  const picks = Array.from(indices ?? []);
  if (picks.length < 2 || picks.length > 4) throw new Error('Select between two and four atoms to measure.');
  if (picks.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw new Error('A selected atom index is outside this frame.');
  }
  const source = positions ?? frame.positions;
  if (!source) throw new Error('Measurements require Cartesian atom positions.');
  const tuples = Array.isArray(source) && Array.isArray(source[0])
    || Array.isArray(source) && ArrayBuffer.isView(source[0]);
  let points;
  if (tuples) {
    if (source.length !== picks.length) throw new Error('Supply one coordinate tuple per selected atom.');
    points = source.map((point) => Array.from(point));
  } else if (source.length === count * 3) {
    points = picks.map((index) => Array.from(source.slice(index * 3, index * 3 + 3)));
  } else if (positions && source.length === picks.length * 3) {
    points = picks.map((_, index) => Array.from(source.slice(index * 3, index * 3 + 3)));
  } else throw new Error('The measurement coordinate array has an invalid length.');
  if (points.some((point) => point.length !== 3 || !point.every(Number.isFinite))) {
    throw new Error('Measurements require finite XYZ coordinates.');
  }
  const unwrapped = [[...points[0]]];
  const distances = [];
  const displacements = [];
  for (let index = 1; index < points.length; index += 1) {
    const direct = subtract(points[index], points[index - 1]);
    const vector = minimumImage ? minimumImageVector(direct, frame.cell) : direct;
    distances.push(length(vector));
    displacements.push(vector);
    unwrapped.push(unwrapped[index - 1].map((value, axis) => value + vector[axis]));
  }
  let angle = NaN;
  if (picks.length >= 3) {
    const first = subtract(unwrapped[0], unwrapped[1]);
    const second = subtract(unwrapped[2], unwrapped[1]);
    const denominator = length(first) * length(second);
    if (denominator > 0) angle = Math.acos(Math.max(-1, Math.min(1, dot(first, second) / denominator))) * 180 / Math.PI;
  }
  let dihedral = NaN;
  if (picks.length === 4) {
    const first = subtract(unwrapped[0], unwrapped[1]);
    const middle = subtract(unwrapped[2], unwrapped[1]);
    const last = subtract(unwrapped[3], unwrapped[2]);
    const middleLength = length(middle);
    if (middleLength > 0) {
      const direction = middle.map((value) => value / middleLength);
      const v = first.map((value, axis) => value - dot(first, direction) * direction[axis]);
      const w = last.map((value, axis) => value - dot(last, direction) * direction[axis]);
      if (length(v) > 1e-12 * length(first) && length(w) > 1e-12 * length(last)) {
        dihedral = Math.atan2(dot(cross(direction, v), w), dot(v, w)) * 180 / Math.PI;
      }
    }
  }
  return {
    indices: picks,
    atomIds: picks.map((index) => frame.ids?.[index] ?? index + 1),
    positions: unwrapped,
    distances,
    distance: distances[0],
    displacements,
    displacement: displacements[0],
    angle,
    dihedral,
  };
}
