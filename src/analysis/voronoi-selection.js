// Shared CPU/GPU subset preparation. No Wasm/native dependencies: compact
// frames can enter either backend's resident input cache directly.
const cache = new WeakMap();
const fields = ['atomicVolume', 'voronoiSurfaceArea', 'voronoiCoordination', 'voronoiBoundaryFaces', 'voronoiMaxFaceOrder'];

function unchanged(source, snapshot) {
  if (source.length !== snapshot.length) return false;
  for (let index = 0; index < source.length; index++) if (!Object.is(source[index], snapshot[index])) return false;
  return true;
}

export function prepareVoronoiSelection(frame, selectedTypes = null) {
  const originalAtomCount = frame.fractional.length / 3;
  if (!Number.isInteger(originalAtomCount) || originalAtomCount < 1) throw new Error('Voronoi requires at least one atom.');
  if (selectedTypes == null) return { frame, atomIndices: null, originalAtomCount, selectedTypes: null, isAll: true };
  if (!Array.isArray(selectedTypes) || !selectedTypes.length || selectedTypes.some(label => typeof label !== 'string')) {
    throw new Error('Select at least one Voronoi element or atom type.');
  }
  if (!Array.isArray(frame.typeLabels) || !ArrayBuffer.isView(frame.types) || frame.types.length !== originalAtomCount) {
    throw new Error('Voronoi element selection requires one labeled type per atom.');
  }
  const requested = new Set(selectedTypes), available = new Set(frame.typeLabels);
  for (const label of requested) if (!available.has(label)) throw new Error(`Unknown Voronoi atom type: ${label}.`);
  const labels = [...new Set(frame.typeLabels)].filter(label => requested.has(label)).sort();
  const cellKey = JSON.stringify([Array.from(frame.cell.vectors), Array.from(frame.cell.pbc), Array.from(frame.cell.origin ?? [0, 0, 0])]),
    labelKey = JSON.stringify(frame.typeLabels), selectionKey = JSON.stringify(labels), previous = cache.get(frame.fractional);
  if (previous?.cellKey === cellKey && previous.cell === frame.cell && previous.labelKey === labelKey
    && previous.selectionKey === selectionKey && unchanged(frame.fractional, previous.coordinates)
    && unchanged(frame.types, previous.types)) return previous.selection;
  const indices = [];
  for (let atom = 0; atom < originalAtomCount; atom++) {
    const type = frame.types[atom];
    if (!Number.isInteger(type) || type < 0 || type >= frame.typeLabels.length) throw new Error(`Atom ${atom + 1} has an invalid labeled type.`);
    if (requested.has(frame.typeLabels[type])) indices.push(atom);
  }
  if (!indices.length) throw new Error('The selected Voronoi types contain no atoms in this frame.');
  const atomIndices = Uint32Array.from(indices), fractional = new frame.fractional.constructor(indices.length * 3),
    types = new frame.types.constructor(indices.length);
  for (let compact = 0; compact < indices.length; compact++) {
    const original = indices[compact];
    fractional.set(frame.fractional.subarray(original * 3, original * 3 + 3), compact * 3);
    types[compact] = frame.types[original];
  }
  const compactFrame = { fractional, types, typeLabels: [...frame.typeLabels], cell: frame.cell };
  if (ArrayBuffer.isView(frame.ids) && frame.ids.length === originalAtomCount) {
    compactFrame.ids = new frame.ids.constructor(indices.length);
    for (let index = 0; index < indices.length; index++) compactFrame.ids[index] = frame.ids[indices[index]];
  }
  const selection = { frame: compactFrame, atomIndices, originalAtomCount, selectedTypes: labels, isAll: false };
  cache.set(frame.fractional, { cell: frame.cell, cellKey, labelKey, selectionKey, coordinates: frame.fractional.slice(),
    types: frame.types.slice(), selection });
  return selection;
}

function lowerBound(values, target) {
  let lower = 0, upper = values.length;
  while (lower < upper) { const middle = (lower + upper) >>> 1; if (values[middle] < target) lower = middle + 1; else upper = middle; }
  return lower;
}

/** Source ranges select central atoms; all included sites remain neighbors. */
export function voronoiSelectionRange(selection, { startAtom = 0, endAtom = selection.originalAtomCount } = {}) {
  if (!Number.isInteger(startAtom) || !Number.isInteger(endAtom) || startAtom < 0
    || endAtom > selection.originalAtomCount || startAtom >= endAtom) throw new Error('Invalid Voronoi source atom range.');
  const start = selection.isAll ? startAtom : lowerBound(selection.atomIndices, startAtom),
    end = selection.isAll ? endAtom : lowerBound(selection.atomIndices, endAtom);
  if (start === end) throw new Error('The requested Voronoi range contains no selected atoms.');
  return { startAtom: start, endAtom: end };
}

/** Radical radii follow the compact tessellation sites; null stays unweighted. */
export function compactVoronoiRadii(radii, selection) {
  if (radii == null) return null;
  if (radii.length !== selection.originalAtomCount) throw new Error('Radical Voronoi needs one radius per source atom.');
  if (selection.isAll) return radii;
  const compact = new Float64Array(selection.atomIndices.length);
  for (let index = 0; index < compact.length; index++) compact[index] = radii[selection.atomIndices[index]];
  return compact;
}

/** Keep compact statistics; excluded source rows have NaN and an empty CSR. */
export function expandVoronoiResult(result, selection) {
  const count = result.atomicVolume.length, start = result.startAtom ?? 0,
    analyzedAtomIndices = selection.isAll
      ? Uint32Array.from({ length: count }, (_, index) => start + index)
      : selection.atomIndices.slice(start, start + count);
  if (analyzedAtomIndices.length !== count) throw new Error('Voronoi subset output does not match its source mapping.');
  if (selection.isAll) return { ...result, selectedTypes: null, analyzedAtomIndices };
  const n = selection.originalAtomCount, expanded = { ...result };
  if (count === n && start === 0) {
    // An explicit all-label choice is scientifically identical to null/all;
    // retain integer field types and every original array byte in this case.
    return { ...result, analyzedAtomIndices, selectedTypes: [...selection.selectedTypes],
      sourceAtomCount: n, tessellationAtomCount: n };
  }
  for (const name of fields) {
    if (!result[name] || result[name].length !== count) throw new Error(`Voronoi subset output is missing ${name}.`);
    const values = new Float64Array(n).fill(NaN);
    for (let index = 0; index < count; index++) values[analyzedAtomIndices[index]] = result[name][index];
    expanded[name] = values;
  }
  const faceOffsets = new Uint32Array(n + 1), voronoiIndices = new Array(n).fill('');
  let compact = 0, offset = 0;
  for (let original = 0; original < n; original++) {
    faceOffsets[original] = offset;
    if (compact < count && analyzedAtomIndices[compact] === original) {
      offset = result.faceOffsets[compact + 1]; voronoiIndices[original] = result.voronoiIndices[compact]; compact++;
    }
  }
  faceOffsets[n] = offset;
  const faceNeighbors = result.faceNeighbors.slice();
  for (let face = 0; face < faceNeighbors.length; face++) if (faceNeighbors[face] >= 0) {
    faceNeighbors[face] = selection.atomIndices[faceNeighbors[face]];
  }
  return { ...expanded, faceOffsets, faceNeighbors, voronoiIndices, analyzedAtomIndices,
    selectedTypes: [...selection.selectedTypes], sourceAtomCount: n, tessellationAtomCount: selection.atomIndices.length,
    startAtom: 0, endAtom: n };
}

export function mapVoronoiGeometry(cell, selection) {
  if (selection.isAll) return cell;
  const faceNeighbors = cell.faceNeighbors.slice();
  for (let face = 0; face < faceNeighbors.length; face++) if (faceNeighbors[face] >= 0) faceNeighbors[face] = selection.atomIndices[faceNeighbors[face]];
  return { ...cell, atomIndex: selection.atomIndices[cell.atomIndex], faceNeighbors };
}

export function compactVoronoiAtomIndices(selection, requested = null) {
  if (requested == null) return Uint32Array.from({ length: selection.frame.fractional.length / 3 }, (_, index) => index);
  if ((!Array.isArray(requested) && !ArrayBuffer.isView(requested)) || !requested.length) throw new Error('Voronoi cell geometry requires at least one atom index.');
  const output = new Uint32Array(requested.length), seen = new Set();
  for (let index = 0; index < requested.length; index++) {
    const original = requested[index];
    if (!Number.isInteger(original) || original < 0 || original >= selection.originalAtomCount || seen.has(original)) {
      throw new Error('Voronoi cell geometry requires distinct valid source atom indices.');
    }
    seen.add(original);
    const compact = selection.isAll ? original : lowerBound(selection.atomIndices, original);
    if (!selection.isAll && selection.atomIndices[compact] !== original) throw new Error(`Atom ${original + 1} is excluded from this Voronoi tessellation.`);
    output[index] = compact;
  }
  return output;
}
