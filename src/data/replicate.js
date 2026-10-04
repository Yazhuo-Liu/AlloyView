import { createCell, invert3, validateFrame } from './model.js';
import { normalizeRepetitions } from '../render/replication.js';

export const MAX_PHYSICAL_REPLICATION_ATOMS = 4_000_000;
export const MAX_PHYSICAL_REPLICATION_BYTES = 512 * 1024 ** 2;
const ID_PREFIX = '@AlloyView:';
const ANALYSIS_FIELDS = ['ptm', 'atomeyeResults', 'vectorPropertyResults', 'analysisOriginalProperties', 'gpuFrameId', 'gpuKey'];

/** Validate the expansion before allocating or altering any source arrays. */
export function physicalReplicationPlan(frame, values, {
  maxAtoms = MAX_PHYSICAL_REPLICATION_ATOMS, maxBytes = MAX_PHYSICAL_REPLICATION_BYTES,
} = {}) {
  const count = frame?.ids?.length;
  if (!Number.isSafeInteger(count) || count < 1 || frame.fractional?.length !== count * 3
      || frame.positions?.length !== count * 3 || frame.types?.length !== count) {
    throw new Error('Physical replication requires coordinates, IDs and an element type for every atom.');
  }
  if (frame.unwrappedPositions && frame.unwrappedPositions.length !== count * 3
      || frame.imageFlags && frame.imageFlags.length !== count * 3) throw new Error('Physical replication found incomplete image or unwrapped coordinates.');
  if (!frame.cell || frame.cell.pbc?.length !== 3 || frame.cell.vectors?.length !== 9 || frame.cell.origin?.length !== 3
      || [...frame.cell.vectors, ...frame.cell.origin].some((value) => !Number.isFinite(value))) {
    throw new Error('Physical replication requires a finite simulation cell.');
  }
  const repetitions = normalizeRepetitions(values, frame.cell.pbc);
  for (let axis = 0; axis < 3; axis += 1) {
    if (!frame.cell.pbc[axis] && Number(values[axis]) !== 1) throw new Error('Physical replication is only available along periodic cell directions.');
  }
  const copies = repetitions.reduce((product, repeat) => product * repeat, 1);
  const atomCount = count * copies;
  if (atomCount > maxAtoms) throw new Error(`Physical replication would create ${atomCount.toLocaleString('en-US')} atoms; the limit is ${maxAtoms.toLocaleString('en-US')}.`);
  const properties = importedProperties(frame);
  let sourcePropertyBytes = 0;
  for (const property of properties) {
    if (!property.data || property.data.length !== count || (!(ArrayBuffer.isView(property.data)) && !Array.isArray(property.data))
        || property.data instanceof DataView) throw new Error(`Physical replication found an invalid property: ${property.name ?? 'unnamed'}.`);
    if (ArrayBuffer.isView(property.data)) sourcePropertyBytes += property.data.byteLength;
    else for (const value of property.data) sourcePropertyBytes += typeof value === 'string' ? 40 + value.length * 2 : 8;
  }
  let encodedCharacters = 0;
  for (const id of frame.ids) encodedCharacters += encodeURIComponent(String(id)).length;
  const positionBytes = frame.positions instanceof Float64Array ? 24 : 12;
  const unwrappedBytes = frame.unwrappedPositions instanceof Float64Array
    || !frame.unwrappedPositions && frame.positions instanceof Float64Array ? 24 : 12;
  const coordinatesBytes = 24 + positionBytes + (frame.imageFlags || frame.unwrappedPositions ? unwrappedBytes + 12 : 0);
  const originalIdsBytes = count * 8;
  const copyIdsBytes = (copies - 1) * (count * 96 + encodedCharacters * 2);
  const estimatedBytes = atomCount * (coordinatesBytes + (frame.types.BYTES_PER_ELEMENT ?? 2) + 8) + sourcePropertyBytes * copies
    + originalIdsBytes + copyIdsBytes + count * 64;
  if (estimatedBytes > maxBytes) throw new Error(`Physical replication exceeds the ${Math.round(maxBytes / 1024 ** 2)} MiB memory limit; reduce the repeat counts.`);
  return { repetitions, copies, sourceAtomCount: count, atomCount, estimatedBytes };
}

/** Build an independent frame for every downstream CPU/GPU analysis.
 * Cell vectors are rows, so tilted repeats follow a,b,c rather than Cartesian
 * axes. Continuous source images are rewrapped in the enlarged cell; otherwise
 * crossing an old internal cell boundary would look like a displacement jump.
 */
export async function replicateFrame(frame, values, { signal, onProgress = () => {}, ...limits } = {}) {
  checkSignal(signal);
  const plan = physicalReplicationPlan(frame, values, limits);
  const { repetitions, sourceAtomCount: count, atomCount } = plan;
  const h = frame.cell.vectors;
  const vectors = Float64Array.from(h, (value, index) => value * repetitions[Math.floor(index / 3)]);
  const cell = createCell({ origin: frame.cell.origin, vectors, pbc: frame.cell.pbc, triclinic: frame.cell.triclinic });
  const sourceKeys = new Array(count), seen = new Set();
  const inverse = frame.unwrappedPositions && !frame.imageFlags ? invert3(h) : null;
  for (let atom = 0; atom < count; atom += 1) {
    const id = frame.ids[atom];
    if (!(typeof id === 'number' && Number.isSafeInteger(id) || typeof id === 'string' && id.length && !/[\x00-\x1f\x7f]/.test(id))) {
      throw new Error('Physical replication requires finite, unique atom IDs.');
    }
    const key = String(id);
    if (seen.has(key)) throw new Error('Physical replication requires unique source atom IDs.');
    seen.add(key);
    sourceKeys[atom] = encodeURIComponent(key);
    for (let axis = 0; axis < 3; axis += 1) {
      const index = atom * 3 + axis;
      if (!Number.isFinite(frame.fractional[index]) || !Number.isFinite(frame.positions[index])
          || frame.unwrappedPositions && !Number.isFinite(frame.unwrappedPositions[index])
          || frame.imageFlags && !Number.isSafeInteger(frame.imageFlags[index])) throw new Error('Physical replication requires finite coordinates and integer image flags.');
    }
    if ((atom + 1) % 16_384 === 0) { await yieldToMain(); checkSignal(signal); }
  }
  const PositionArray = frame.positions instanceof Float64Array ? Float64Array : Float32Array;
  const UnwrappedArray = frame.unwrappedPositions instanceof Float64Array
    || !frame.unwrappedPositions && frame.positions instanceof Float64Array ? Float64Array : Float32Array;
  const fractional = new Float64Array(atomCount * 3), positions = new PositionArray(atomCount * 3);
  const unwrappedPositions = frame.unwrappedPositions || frame.imageFlags ? new UnwrappedArray(atomCount * 3) : undefined;
  const imageFlags = frame.imageFlags || unwrappedPositions ? new Int32Array(atomCount * 3) : undefined;
  const ids = new Array(atomCount);
  const types = ArrayBuffer.isView(frame.types) ? new frame.types.constructor(atomCount) : new Uint16Array(atomCount);
  const properties = importedProperties(frame).map((property) => {
    const { data, ...metadata } = property;
    return { ...structuredClone(metadata), data: Array.isArray(data) ? new Array(atomCount) : new data.constructor(atomCount) };
  });
  const sourceProperties = importedProperties(frame);
  let copy = 0, completedAtoms = 0;
  for (let c = 0; c < repetitions[2]; c += 1) for (let b = 0; b < repetitions[1]; b += 1) for (let a = 0; a < repetitions[0]; a += 1) {
    const offset = [0, 1, 2].map((axis) => a * h[axis] + b * h[3 + axis] + c * h[6 + axis]);
    const copyIndices = [a, b, c];
    for (let atom = 0; atom < count; atom += 1) {
      const target = copy * count + atom;
      const sourceBase = atom * 3, targetBase = target * 3;
      const originalId = frame.ids[atom];
      ids[target] = copy ? `${ID_PREFIX}copy:${a}:${b}:${c}:${sourceKeys[atom]}`
        : typeof originalId === 'string' && originalId.startsWith(ID_PREFIX) ? `${ID_PREFIX}base:${sourceKeys[atom]}` : originalId;
      types[target] = frame.types[atom];
      for (let axis = 0; axis < 3; axis += 1) {
        let image = frame.imageFlags?.[sourceBase + axis] ?? 0;
        if (inverse && frame.cell.pbc[axis]) {
          let value = 0;
          for (let component = 0; component < 3; component += 1) value += (frame.unwrappedPositions[sourceBase + component] - frame.cell.origin[component]) * inverse[component * 3 + axis];
          image = Math.round(value - frame.fractional[sourceBase + axis]);
        }
        const expanded = (frame.fractional[sourceBase + axis] + (frame.cell.pbc[axis] ? image : 0) + copyIndices[axis]) / repetitions[axis];
        const expandedImage = frame.cell.pbc[axis] ? Math.floor(expanded) : 0;
        if (expandedImage < -2_147_483_648 || expandedImage > 2_147_483_647) throw new Error('Physical replication exceeds the image flag range.');
        fractional[targetBase + axis] = expanded - expandedImage;
        if (imageFlags) imageFlags[targetBase + axis] = expandedImage;
        if (frame.unwrappedPositions) unwrappedPositions[targetBase + axis] = frame.unwrappedPositions[sourceBase + axis] + offset[axis];
      }
      for (let axis = 0; axis < 3; axis += 1) {
        positions[targetBase + axis] = cell.origin[axis] + fractional[targetBase] * vectors[axis]
          + fractional[targetBase + 1] * vectors[3 + axis] + fractional[targetBase + 2] * vectors[6 + axis];
        if (unwrappedPositions && !frame.unwrappedPositions) {
          let value = cell.origin[axis] + offset[axis];
          for (let direction = 0; direction < 3; direction += 1) value += (frame.fractional[sourceBase + direction]
            + (frame.cell.pbc[direction] ? frame.imageFlags[sourceBase + direction] : 0)) * h[direction * 3 + axis];
          unwrappedPositions[targetBase + axis] = value;
        }
        if (!Number.isFinite(positions[targetBase + axis]) || !Number.isFinite(fractional[targetBase + axis])
            || unwrappedPositions && !Number.isFinite(unwrappedPositions[targetBase + axis])) throw new Error('The enlarged coordinates exceed the supported numeric range.');
      }
      for (let property = 0; property < properties.length; property += 1) properties[property].data[target] = sourceProperties[property].data[atom];
      completedAtoms += 1;
      if (completedAtoms % 16_384 === 0) {
        onProgress({ phase: 'replicating', completedAtoms, totalAtoms: atomCount });
        await yieldToMain();
        checkSignal(signal);
      }
    }
    copy += 1;
  }
  checkSignal(signal);
  const result = { ...frame, ids, types, typeLabels: structuredClone(frame.typeLabels), fractional, positions,
    unwrappedPositions, imageFlags, cell, properties,
    physicalReplication: { repetitions: repetitions.slice(), sourceAtomCount: count } };
  for (const name of ANALYSIS_FIELDS) delete result[name];
  onProgress({ phase: 'replicating', completedAtoms: atomCount, totalAtoms: atomCount });
  return validateFrame(result);
}

function importedProperties(frame) {
  return (frame.properties ?? []).flatMap((property) => property.analysisKind
    ? frame.analysisOriginalProperties?.has(property.name) ? [frame.analysisOriginalProperties.get(property.name)] : []
    : [property]);
}

function checkSignal(signal) { if (signal?.aborted) throw new DOMException('Replication cancelled.', 'AbortError'); }
function yieldToMain() { return typeof globalThis.scheduler?.yield === 'function' ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)); }
