/** Compact topology labels for the internal Worker protocol. The public
 * result still exposes one string per atom; only unique strings cross Worker
 * boundaries, alongside transferable 32-bit label IDs. */
export class VoronoiIndexBuilder {
  constructor(count) {
    this.ids = new Uint32Array(count);
    this.labels = [];
    this.tree = new Map();
    this.counts = new Uint32Array(8);
    this.maximum = 6;
  }

  begin() { this.counts.fill(0, 3, this.maximum + 1); this.maximum = 6; }

  add(order) {
    if (order < 3) return;
    if (order >= this.counts.length) {
      const counts = new Uint32Array(Math.max(order + 1, this.counts.length * 2));
      counts.set(this.counts); this.counts = counts;
    }
    this.counts[order]++;
    this.maximum = Math.max(this.maximum, order);
  }

  finish(atom) {
    // A trie avoids constructing and hashing a string for every atom. Its
    // path includes every order through max(6, max accepted face order), so
    // trailing zeros retain the original exact label semantics.
    let node = this.tree;
    for (let order = 3; order <= this.maximum; order++) {
      const count = this.counts[order];
      let next = node.get(count);
      if (!next) { next = new Map(); node.set(count, next); }
      node = next;
    }
    let id = node.get(-1);
    if (id === undefined) {
      id = this.labels.length;
      node.set(-1, id);
      this.labels.push(`<${this.counts.subarray(3, this.maximum + 1).join(',')}>`);
    }
    this.ids[atom] = id;
  }
}

export function voronoiIndexAt(result, atom) {
  return result.voronoiIndices ? result.voronoiIndices[atom]
    : result.voronoiIndexLabels[result.voronoiIndexIds[atom]];
}

/** Decode once at the public-result boundary, never between Worker hops. */
export function materializeVoronoiIndices(result) {
  if (!result.voronoiIndices) {
    const ids = result.voronoiIndexIds, labels = result.voronoiIndexLabels;
    const indices = new Array(ids.length);
    for (let atom = 0; atom < ids.length; atom++) indices[atom] = labels[ids[atom]];
    result.voronoiIndices = indices;
  }
  delete result.voronoiIndexIds; delete result.voronoiIndexLabels;
  return result;
}
