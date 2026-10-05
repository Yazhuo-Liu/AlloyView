import { cartesianToFractional, determinant3, fractionalToCartesian } from '../data/model.js';

export const DXA_LATTICES = Object.freeze([
  { id: 'fcc', label: 'FCC', kernelId: 1 },
  { id: 'bcc', label: 'BCC', kernelId: 3 },
  { id: 'hcp', label: 'HCP', kernelId: 2 },
  { id: 'cubicDiamond', label: 'Cubic diamond', kernelId: 4 },
  { id: 'hexDiamond', label: 'Hexagonal diamond', kernelId: 5 },
].map(Object.freeze));

export const DXA_DEFAULTS = Object.freeze({ lattice: 'fcc', trialCircuitLength: 14,
  circuitStretchability: 9, onlyPerfectDislocations: false, lineSmoothingIterations: 1,
  linePointInterval: 2.5 });

// Reference prototypes use OVITO's ideal crystal coordinates. Hexagonal
// prototypes are Cartesian coordinates, rather than Miller-Bravais indices.
// Source: OVITO v3.9.4 DislocationAnalysisModifier and BurgersVectorFamily.
const other = { id: 'other', label: 'Other', color: [230, 76, 76], vector: [0, 0, 0] };
const cubic = [
  { id: 'perfect', label: '1/2 ⟨110⟩ (Perfect)', color: [51, 51, 255], vector: [.5, .5, 0] },
  { id: 'shockley', label: '1/6 ⟨112⟩ (Shockley)', color: [0, 220, 90], vector: [1 / 6, 1 / 6, 1 / 3] },
  { id: 'stairRod', label: '1/6 ⟨110⟩ (Stair-rod)', color: [230, 30, 220], vector: [1 / 6, 1 / 6, 0] },
  { id: 'hirth', label: '1/3 ⟨100⟩ (Hirth)', color: [230, 205, 0], vector: [1 / 3, 0, 0] },
  { id: 'frank', label: '1/3 ⟨111⟩ (Frank)', color: [0, 200, 220], vector: [1 / 3, 1 / 3, 1 / 3] },
];
const hexagonal = [
  { id: 'a', label: '1/3 ⟨1−210⟩ (a)', color: [0, 220, 90], vector: [Math.sqrt(.5), 0, 0] },
  { id: 'c', label: '⟨0001⟩ (c)', color: [51, 51, 255], vector: [0, 0, Math.sqrt(4 / 3)] },
  { id: 'basal', label: '⟨1−100⟩', color: [230, 30, 220], vector: [0, Math.sqrt(1.5), 0] },
  { id: 'basalPartial', label: '1/3 ⟨1−100⟩', color: [255, 128, 0], vector: [0, Math.sqrt(1.5) / 3, 0] },
  { id: 'ca', label: '1/3 ⟨1−213⟩ (c+a)', color: [230, 205, 0], vector: [Math.sqrt(.5), 0, Math.sqrt(4 / 3)] },
];
const freezeFamilies = families => Object.freeze([...families, other].map(family => Object.freeze({ ...family,
  color: Object.freeze([...family.color]), vector: Object.freeze([...family.vector]) })));
export const DXA_FAMILIES = Object.freeze({
  fcc: freezeFamilies(cubic),
  bcc: freezeFamilies([
    { id: 'half111', label: '1/2 ⟨111⟩', color: [0, 220, 90], vector: [.5, .5, .5] },
    { id: '100', label: '⟨100⟩', color: [255, 76, 204], vector: [1, 0, 0] },
    { id: '110', label: '⟨110⟩', color: [51, 128, 255], vector: [1, 1, 0] },
  ]),
  hcp: freezeFamilies(hexagonal),
  cubicDiamond: freezeFamilies(cubic.filter(family => family.id !== 'hirth')),
  hexDiamond: freezeFamilies(hexagonal.filter(family => family.id !== 'ca')),
});

export function validateDxaParameters(parameters = {}) {
  const settings = { ...DXA_DEFAULTS, ...parameters };
  if (!DXA_LATTICES.some(lattice => lattice.id === settings.lattice)) throw new Error('Choose a supported DXA input crystal lattice.');
  for (const [name, minimum, maximum] of [['trialCircuitLength', 3, 100], ['circuitStretchability', 0, 100],
    ['lineSmoothingIterations', 0, 100]]) {
    if (!Number.isInteger(settings[name]) || settings[name] < minimum || settings[name] > maximum) {
      throw new Error(`DXA ${name} must be an integer between ${minimum} and ${maximum}.`);
    }
  }
  if (typeof settings.onlyPerfectDislocations !== 'boolean') throw new Error('DXA perfect-dislocation selection must be a checkbox value.');
  if (!Number.isFinite(settings.linePointInterval) || settings.linePointInterval < 0 || settings.linePointInterval > 1e6) throw new Error('DXA line coarsening distance must be finite and between 0 and 1000000.');
  return settings;
}

export function classifyBurgersVector(vector, lattice, tolerance = 1e-3) {
  if (!DXA_FAMILIES[lattice]) throw new Error('Unknown DXA crystal lattice.');
  if (vector?.length !== 3 || !Array.from(vector).every(Number.isFinite)) throw new Error('A Burgers vector requires three finite crystal coordinates.');
  const candidate = Array.from(vector, Math.abs);
  const matches = reference => reference.every((value, index) => Math.abs(candidate[index] - value) <= tolerance);
  for (const family of DXA_FAMILIES[lattice]) {
    if (family.id === 'other') continue;
    if (lattice === 'hcp' || lattice === 'hexDiamond') {
      // D6h equivalence: reflections/sign reversals plus 60 degree rotations.
      // Comparing only lengths incorrectly merges differently oriented basal
      // families, while sorting xyz incorrectly exchanges the c axis.
      for (let rotation = 0; rotation < 6; rotation++) {
        const angle = rotation * Math.PI / 3, [x, y, z] = family.vector;
        const reference = [Math.abs(x * Math.cos(angle) - y * Math.sin(angle)),
          Math.abs(x * Math.sin(angle) + y * Math.cos(angle)), Math.abs(z)];
        if (matches(reference)) return family.id;
      }
    } else {
      const reference = family.vector.map(Math.abs).sort((a, b) => a - b);
      if (candidate.toSorted((a, b) => a - b).every((value, index) => Math.abs(value - reference[index]) <= tolerance)) return family.id;
    }
  }
  return 'other';
}

export function validateDxaFrame(frame, { validateCoordinates = true } = {}) {
  const coordinates = frame?.fractional ?? frame?.positions;
  const count = coordinates?.length / 3;
  if (!Number.isInteger(count) || count < 4) throw new Error('DXA requires a three-dimensional structure with at least four atoms.');
  const cell = frame.cell;
  if (cell?.vectors?.length !== 9 || cell?.origin?.length !== 3 || cell?.pbc?.length !== 3
      || !Array.from(cell.vectors).every(Number.isFinite) || !Array.from(cell.origin).every(Number.isFinite)
      || !Number.isFinite(determinant3(cell.vectors)) || Math.abs(determinant3(cell.vectors)) < 1e-12) {
    throw new Error('DXA requires a finite, non-singular three-dimensional cell.');
  }
  if (validateCoordinates) for (const coordinate of coordinates) {
    if (!Number.isFinite(coordinate)) throw new Error('DXA requires finite atom coordinates.');
  }
  return count;
}

/** A conservative preflight, not an exact allocation promise. DXA owns a
 * global tetrahedral/half-edge workspace in addition to input and JSON copies.
 * Do not split or truncate a frame to meet a budget: topology would change.
 */
export function estimateDxaMemory(count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('DXA requires a valid atom count.');
  return 32 * 1024 ** 2 + count * 3_072;
}

export function preflightDxaMemory(count, budgetBytes = 1.5 * 1024 ** 3) {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) throw new Error('DXA memory budget must be positive and finite.');
  const estimateBytes = estimateDxaMemory(count);
  if (estimateBytes > budgetBytes) {
    throw new Error(`DXA estimates ${(estimateBytes / 1024 ** 2).toFixed(0)} MiB of working memory, exceeding the ${(budgetBytes / 1024 ** 2).toFixed(0)} MiB budget. Reduce the analyzed structure or real replication.`);
  }
  return estimateBytes;
}

/** Wrapped source positions preserve full triclinic vectors and cell origin.
 * Explicit atom images in the input must not create extra periodic atoms.
 */
export function dxaCartesianCoordinates(frame) {
  const count = validateDxaFrame(frame);
  const fractional = frame.fractional ? Float64Array.from(frame.fractional)
    : cartesianToFractional(frame.positions, frame.cell, new Float64Array(count * 3));
  for (let index = 0; index < fractional.length; index++) {
    if (frame.cell.pbc[index % 3]) fractional[index] -= Math.floor(fractional[index]);
  }
  return fractionalToCartesian(fractional, frame.cell, new Float64Array(count * 3));
}

const DXA_STAGES = 11;
let kernelPromise, kernelProgress;
async function getKernel() {
  if (!kernelPromise) kernelPromise = (async () => {
    const { default: createDxa } = await import('./dxa-kernel.mjs');
    let options = {};
    if (typeof process === 'object' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      options.wasmBinary = await readFile(new URL('./dxa-kernel.wasm', import.meta.url));
    }
    return createDxa({ ...options, onDxaProgress: (...update) => kernelProgress?.(...update) });
  })().catch(error => { kernelPromise = undefined; throw error; });
  return kernelPromise;
}

/** Executes the complete native DXA algorithm. Browser callers should use
 * DxaClient so synchronous Wasm work and cancellation stay off the UI thread.
 */
export async function calculateDxa(frame, parameters = {}, { onProgress = () => {}, memoryBudgetBytes } = {}) {
  const settings = validateDxaParameters(parameters), count = validateDxaFrame(frame);
  const memoryEstimateBytes = preflightDxaMemory(count, memoryBudgetBytes);
  const startedAt = performance.now();
  onProgress({ phase: 'initializing', completedStages: 0, totalStages: DXA_STAGES, totalAtoms: count });
  const module = await getKernel();
  onProgress({ phase: 'indexing', completedStages: 0, totalStages: DXA_STAGES, totalAtoms: count });
  const positions = dxaCartesianCoordinates(frame);
  const coordinates = module._malloc(positions.byteLength), cellPointer = module._malloc(12 * 8);
  if (!coordinates || !cellPointer) {
    if (coordinates) module._free(coordinates);
    if (cellPointer) module._free(cellPointer);
    throw new Error('DXA could not allocate its input; reduce the analyzed structure or real replication.');
  }
  kernelProgress = (phase, completedStages, totalStages = DXA_STAGES) => onProgress({ phase, completedStages, totalStages, totalAtoms: count });
  try {
    module.HEAPF64.set(positions, coordinates / 8);
    module.HEAPF64.set(frame.cell.vectors, cellPointer / 8);
    module.HEAPF64.set(frame.cell.origin, cellPointer / 8 + 9);
    const pbc = frame.cell.pbc.reduce((bits, enabled, axis) => bits | (enabled ? 1 << axis : 0), 0);
    onProgress({ phase: 'analyzing', completedStages: 0, totalStages: DXA_STAGES, totalAtoms: count });
    const output = module._alloy_dxa_analyze(coordinates, count, cellPointer, pbc,
      DXA_LATTICES.find(lattice => lattice.id === settings.lattice).kernelId,
      settings.trialCircuitLength, settings.circuitStretchability, settings.onlyPerfectDislocations ? 1 : 0,
      settings.lineSmoothingIterations, settings.linePointInterval);
    if (!output) {
      const errorPointer = module._alloy_dxa_last_error();
      throw new Error(errorPointer ? module.UTF8ToString(errorPointer) : 'DXA analysis failed.');
    }
    onProgress({ phase: 'collecting', completedStages: DXA_STAGES, totalStages: DXA_STAGES, totalAtoms: count });
    const result = normalizeDxaResult(JSON.parse(module.UTF8ToString(output)), frame.cell, settings, count);
    return { ...result, elapsedMs: performance.now() - startedAt, memoryEstimateBytes,
      engine: 'Wasm CPU', backend: 'cpu', gpuFallback: Boolean(parameters.gpuEnabled) };
  } finally {
    kernelProgress = null;
    module._free(coordinates);
    module._free(cellPointer);
  }
}

export function normalizeDxaResult(raw, cell, parameters = {}, atomCount) {
  const settings = validateDxaParameters(parameters);
  if (!Array.isArray(raw?.segments)) throw new Error('DXA returned an invalid dislocation network.');
  const counts = Object.fromEntries(DXA_FAMILIES[settings.lattice].map(family => [family.id, 0]));
  const familyLengths = Object.fromEntries(Object.keys(counts).map(id => [id, 0]));
  const segmentIds = new Set();
  const segments = raw.segments.map((segment, index) => {
    const points = Float64Array.from(Array.isArray(segment.points?.[0]) ? segment.points.flat() : segment.points ?? []);
    if (points.length < 6 || points.length % 3 || !Array.from(points).every(Number.isFinite)) throw new Error('DXA returned invalid dislocation line coordinates.');
    const burgersVector = Array.from(segment.burgersVector ?? []), spatialBurgersVector = Array.from(segment.spatialBurgersVector ?? []);
    if (spatialBurgersVector.length !== 3 || !spatialBurgersVector.every(Number.isFinite)) throw new Error('DXA returned an invalid spatial Burgers vector.');
    const inputStructure = DXA_LATTICES.find(lattice => lattice.id === settings.lattice).kernelId;
    const classifiedFamily = classifyBurgersVector(burgersVector, settings.lattice);
    // A related phase may have no valid orientation transition into the input
    // crystal. Never interpret its local vector as belonging to another frame.
    const familyId = segment.structureType !== undefined && segment.structureType !== inputStructure ? 'other' : classifiedFamily;
    const id = segment.id ?? index;
    if (!Number.isSafeInteger(id) || id < 0 || segmentIds.has(id)) throw new Error('DXA returned duplicate or invalid segment identifiers.');
    segmentIds.add(id);
    let polylineLength = 0;
    for (let point = 3; point < points.length; point += 3) polylineLength += Math.hypot(points[point] - points[point - 3], points[point + 1] - points[point - 2], points[point + 2] - points[point - 1]);
    const length = segment.length ?? polylineLength;
    if (!Number.isFinite(length) || length < 0) throw new Error('DXA returned an invalid dislocation length.');
    counts[familyId]++; familyLengths[familyId] += length;
    return { ...segment, id, points, burgersVector, spatialBurgersVector, familyId, family: familyId, length };
  });
  const totalLength = segments.reduce((total, segment) => total + segment.length, 0);
  const volume = Math.abs(determinant3(cell.vectors));
  if (!Number.isFinite(volume) || volume <= 0) throw new Error('DXA requires a positive analyzed volume.');
  let atomStructureTypes, structureCounts = {};
  if (raw.atomStructureTypes !== undefined) {
    if (!Array.isArray(raw.atomStructureTypes) || (atomCount !== undefined && raw.atomStructureTypes.length !== atomCount)
        || raw.atomStructureTypes.some(value => !Number.isInteger(value) || value < 0 || value > 5)) throw new Error('DXA returned invalid atom structure identifiers.');
    atomStructureTypes = Uint8Array.from(raw.atomStructureTypes);
    for (const id of atomStructureTypes) structureCounts[id] = (structureCounts[id] ?? 0) + 1;
  }
  return { ...raw, segments, totalLength, volume, density: totalLength / volume, counts, familyLengths, atomStructureTypes, structureCounts,
    parameters: settings, cell: { vectors: Float64Array.from(cell.vectors), origin: Float64Array.from(cell.origin), pbc: Array.from(cell.pbc, Boolean) } };
}

/** Split unwrapped Cartesian polylines at periodic cell faces. Each output
 * piece lies in the primary triclinic cell; open axes retain their coordinates.
 * The source length/network topology are never altered by this display helper.
 */
export function splitPeriodicPolyline(points, cell) {
  if (points?.length < 6 || points.length % 3 || !Array.from(points).every(Number.isFinite)) return [];
  if (!cell.pbc.some(Boolean)) return [Float64Array.from(points)];
  const fractional = cartesianToFractional(points, cell, new Float64Array(points.length));
  const pieces = [], tolerance = 1e-10;
  let current = [];
  const append = (from, to) => {
    const start = fractionalToCartesian(from, cell, new Float64Array(3));
    const end = fractionalToCartesian(to, cell, new Float64Array(3));
    if (Math.hypot(...end.map((value, axis) => value - start[axis])) < tolerance) return;
    const last = current.slice(-3);
    if (last.length && Math.hypot(...last.map((value, axis) => value - start[axis])) > tolerance) {
      pieces.push(Float64Array.from(current)); current = [];
    }
    if (!current.length) current.push(...start);
    current.push(...end);
  };
  for (let point = 3; point < fractional.length; point += 3) {
    const from = Array.from(fractional.subarray(point - 3, point)), to = Array.from(fractional.subarray(point, point + 3));
    const times = [0, 1];
    for (let axis = 0; axis < 3; axis++) {
      if (!cell.pbc[axis] || Math.abs(to[axis] - from[axis]) < 1e-15) continue;
      const minimum = Math.min(from[axis], to[axis]), maximum = Math.max(from[axis], to[axis]);
      if (maximum - minimum > 100_000) throw new Error('Dislocation line crosses too many periodic images to display.');
      for (let face = Math.floor(minimum) + 1; face < maximum; face++) {
        const time = (face - from[axis]) / (to[axis] - from[axis]);
        if (time > 1e-12 && time < 1 - 1e-12) times.push(time);
      }
    }
    times.sort((a, b) => a - b);
    const unique = times.filter((value, index) => !index || value - times[index - 1] > 1e-12);
    for (let interval = 1; interval < unique.length; interval++) {
      const lo = unique[interval - 1], hi = unique[interval], middle = (lo + hi) / 2;
      const image = from.map((value, axis) => cell.pbc[axis] ? Math.floor(value + (to[axis] - value) * middle) : 0);
      append(from.map((value, axis) => value + (to[axis] - value) * lo - image[axis]),
        from.map((value, axis) => value + (to[axis] - value) * hi - image[axis]));
    }
  }
  if (current.length >= 6) pieces.push(Float64Array.from(current));
  return pieces;
}
