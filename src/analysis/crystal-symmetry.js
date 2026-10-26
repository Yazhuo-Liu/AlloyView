import initMoyo, { analyze_cell } from '../crystal/vendor/moyo/moyo_wasm.js';
import { createCell, determinant3, fractionalToCartesian, validateFrame } from '../data/model.js';

export const CRYSTAL_SYMMETRY_MAX_ATOMS = 20_000;
let initialization = null, memory = null;
const failure = message => new Error(`Crystal symmetry: ${message}`);

/** A single initialized module and growing native memory per retained Worker.
 * This is a global f64 crystallographic search, not local CNA classification. */
export function warmCrystalSymmetry({ wasmBinary } = {}) {
  if (!initialization) initialization = initMoyo({ module_or_path: wasmBinary ?? new URL('../crystal/vendor/moyo/moyo_wasm_bg.wasm', import.meta.url) })
    .then(exports => { memory = exports.memory; return { memoryBytes: memory.buffer.byteLength }; })
    .catch(error => { initialization = null; throw error; });
  return initialization;
}

export function validateCrystalSymmetryInput(frame, { symprec = 1e-4 } = {}) {
  const count = frame?.types?.length;
  if (!Number.isInteger(count) || count < 1 || count > CRYSTAL_SYMMETRY_MAX_ATOMS || frame.fractional?.length !== count * 3) {
    throw failure(`provide a periodic unit cell with 1–${CRYSTAL_SYMMETRY_MAX_ATOMS.toLocaleString('en-US')} sites.`);
  }
  if (!Number.isFinite(symprec) || symprec < 1e-8 || symprec > 1) throw failure('distance tolerance must be between 1e-8 and 1 Å.');
  if (frame.cell?.pbc?.length !== 3 || frame.cell.pbc.some(value => value !== true)) throw failure('all three axes must be periodic.');
  const basis = frame.cell.vectors;
  if (basis?.length !== 9 || Array.from(basis).some(value => !Number.isFinite(value)) || Math.abs(determinant3(basis)) < 1e-12) throw failure('the unit cell must be finite and nonsingular.');
  if (frame.crystal?.disordered) throw failure('disordered or partially occupied sites need an explicit ordered structure before symmetry recognition.');
  const occupancy = frame.properties?.find(property => property.name === 'occupancy');
  if (occupancy && (occupancy.data?.length !== count || Array.from(occupancy.data).some(value => value !== 1))) throw failure('symmetry recognition requires fully occupied sites; partial or unknown occupancy is not rounded.');
  if (!Array.isArray(frame.typeLabels) || !frame.typeLabels.length) throw failure('atom species are missing.');
  for (let i = 0; i < count; i++) {
    if (!Number.isInteger(frame.types[i]) || frame.types[i] < 0 || frame.types[i] >= frame.typeLabels.length) throw failure('atom species indices are invalid.');
    for (let axis = 0; axis < 3; axis++) if (!Number.isFinite(frame.fractional[3 * i + axis]) || Math.abs(frame.fractional[3 * i + axis]) > 1e9) throw failure('fractional coordinates must be finite and within the supported image range.');
  }
  return { symprec, count };
}

function standardizedFrame(nativeCell, labels, title, kind, result) {
  const basis = nativeCell.lattice.basis;
  const cell = createCell({ vectors: basis, pbc: [true, true, true],
    triclinic: [1, 2, 3, 5, 6, 7].some(index => Math.abs(basis[index]) > 1e-12) });
  const fractional = Float64Array.from(nativeCell.positions.flat(), value => ((value % 1) + 1) % 1);
  const types = Uint32Array.from(nativeCell.numbers, value => value - 1);
  if (types.some(value => value >= labels.length)) throw failure('the symmetry engine returned an invalid species index.');
  return validateFrame({ cell, fractional, types, typeLabels: [...labels], positions: fractionalToCartesian(fractional, cell, new Float64Array(fractional.length)),
    ids: Float64Array.from(types, (_, i) => i + 1), idSource: 'row-order', properties: [], timestep: null, sourceFormat: 'symmetry',
    title: `${title || 'Crystal'} — refined ${kind} cell`,
    crystal: { format: 'symmetry', spaceGroup: { name: result.hm_symbol, number: result.number },
      warnings: ['Cell and positions are symmetry-refined within the requested distance tolerance. Source atom IDs and per-atom properties are not mapped onto this new cell.'] } });
}

export async function analyzeCrystalSymmetry(frame, options = {}, execution = {}) {
  const { symprec, count } = validateCrystalSymmetryInput(frame, options);
  if (execution.signal?.aborted) throw new DOMException('Crystal symmetry cancelled.', 'AbortError');
  await warmCrystalSymmetry(execution);
  if (execution.signal?.aborted) throw new DOMException('Crystal symmetry cancelled.', 'AbortError');
  const positions = Array.from({ length: count }, (_, i) => Array.from(frame.fractional.subarray(3 * i, 3 * i + 3), value => ((value % 1) + 1) % 1));
  // Moyo matrices are column-major. Concatenated AlloyView lattice vectors
  // already have exactly that storage order: ax,ay,az,bx,by,bz,cx,cy,cz.
  const input = { lattice: { basis: Array.from(frame.cell.vectors) }, positions, numbers: Array.from(frame.types, value => value + 1) };
  const startedAt = performance.now();
  let result;
  try { result = analyze_cell(JSON.stringify(input), symprec, 'Standard'); }
  catch (error) { throw failure(`the ordered structure could not be resolved at this tolerance: ${error?.message ?? error}`); }
  const conventional = standardizedFrame(result.std_cell, frame.typeLabels, frame.title, 'conventional', result);
  const primitive = standardizedFrame(result.prim_std_cell, frame.typeLabels, frame.title, 'primitive', result);
  return { number: result.number, hallNumber: result.hall_number, symbol: result.hm_symbol, pearson: result.pearson_symbol,
    operationCount: result.operations.length, orbits: Uint32Array.from(result.orbits), wyckoffs: result.wyckoffs,
    siteSymmetry: result.site_symmetry_symbols, symprec: result.symprec, requestedSymprec: symprec,
    conventional, primitive, elapsedMs: performance.now() - startedAt, memoryBytes: memory.buffer.byteLength,
    backend: 'cpu', engine: 'moyo 0.21.0', transforms: { conventional: result.std_linear, origin: result.std_origin_shift,
      primitive: result.prim_std_linear, primitiveOrigin: result.prim_std_origin_shift, rotation: result.std_rotation_matrix } };
}
