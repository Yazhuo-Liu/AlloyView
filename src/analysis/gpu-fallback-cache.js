// Cache only explicit, coordinate-independent neighbor-index refusals. A
// public frame can mutate typed arrays in place, so input identity is not a
// license to retain content-dependent precision or classification failures.
const FIXED_RADIUS_KINDS = new Set(['coordination', 'rdf', 'bonds', 'bondStatistics', 'localShear', 'cna']);
export const GPU_CELL_CUTOFF_FAILURE_CODES = new Set([
  'cell-neighbor-geometry', 'periodic-image-budget', 'periodic-image-precision',
  'cell-cutoff-numeric-range', 'padded-radius-numeric-range',
  'padded-periodic-image-budget', 'padded-periodic-image-precision',
]);
const MAX_ENTRIES = 128, MAX_KEY_CHARS = 4096;

/** Bounded scalar metadata; it never owns source coordinate/type buffers. */
export class GpuFallbackCache {
  constructor() { this.clear(); }
  clear() { this.frames = new WeakMap(); this.entries = new Map(); this.generation = (this.generation ?? 0) + 1; }
  get size() { return this.entries.size; }

  request(frame, parameters, backendGeneration = 0) {
    if (typeof WeakRef !== 'function' || !frame || !FIXED_RADIUS_KINDS.has(parameters?.kind)
      || (parameters.kind === 'cna' && parameters.mode !== 'fixed')
      || !Number.isFinite(parameters.cutoff) || parameters.cutoff <= 0) return null;
    // Origin/PBC, revisions and small parameter values are compared exactly.
    // A coordinate edit that preserves the cell cannot remove these limits;
    // actual current coordinates are still checked by the CPU calculation.
    const cell = frame.cell;
    if (cell?.vectors?.length !== 9 || cell.origin?.length !== 3 || cell.pbc?.length !== 3) return null;
    const key = smallKey({ parameters, vectors: Array.from(cell.vectors), origin: Array.from(cell.origin),
      pbc: Array.from(cell.pbc), triclinic: cell.triclinic,
      revisions: [frame.revision, frame.analysisRevision, frame.geometryRevision],
      coordinateLength: frame.fractional?.length, typeLength: frame.types?.length });
    if (key === null || !frame.fractional || typeof frame.fractional !== 'object') return null;
    return { frame, parameters, key, backendGeneration, generation: this.generation,
      coordinates: frame.fractional, types: frame.types };
  }

  lookup(request) {
    if (!request || request.generation !== this.generation) return null;
    const entry = this.frames.get(request.frame)?.get(request.key);
    if (!entry || !this.entries.has(entry) || entry.backendGeneration !== request.backendGeneration
      || entry.coordinates.deref() !== request.coordinates || entry.types?.deref() !== request.types) return null;
    this.entries.delete(entry); this.entries.set(entry, true);
    return { fallbackReason: entry.reason, fallbackCode: entry.code, fallbackCached: true };
  }

  remember(request, error, backendGeneration = request?.backendGeneration) {
    if (!request || request.generation !== this.generation || request.backendGeneration !== backendGeneration
      || error?.name !== 'GpuUnavailableError' || error.gpuUnsupportedScope !== 'cell-cutoff'
      || !GPU_CELL_CUTOFF_FAILURE_CODES.has(error.gpuUnsupportedCode)
      || error.gpuOutOfMemory || error.gpuDeviceLost || error.gpuDeviceUnavailable) return false;
    const current = this.request(request.frame, request.parameters, backendGeneration);
    // Detect in-flight changes of all inputs this refusal actually depends on.
    if (!current || current.key !== request.key || current.coordinates !== request.coordinates || current.types !== request.types) return false;
    let entries = this.frames.get(request.frame);
    if (!entries) { entries = new Map(); this.frames.set(request.frame, entries); }
    const previous = entries.get(request.key);
    if (previous) this.entries.delete(previous);
    const entry = { key: request.key, frame: new WeakRef(request.frame), coordinates: new WeakRef(request.coordinates),
      ...(request.types && typeof request.types === 'object' ? { types: new WeakRef(request.types) } : {}),
      backendGeneration, reason: String(error.message || 'The GPU cell/cutoff is unsupported.').slice(0, 1024), code: error.gpuUnsupportedCode };
    entries.set(request.key, entry); this.entries.set(entry, true);
    while (this.entries.size > MAX_ENTRIES) {
      const evicted = this.entries.keys().next().value; this.entries.delete(evicted);
      const frame = evicted.frame.deref(), frameEntries = frame && this.frames.get(frame);
      if (frameEntries?.get(evicted.key) === evicted) frameEntries.delete(evicted.key);
    }
    return true;
  }
}

// No typed arrays, frame payloads or unbounded expressions enter a route key.
// The limits are admission checks, rather than truncating unequal parameters.
function smallKey(value) {
  let count = 0; const seen = new Set();
  function normalize(input) {
    if (++count > 256) throw new Error();
    if (input === undefined) return ['undefined'];
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error();
      return ['number', Object.is(input, -0) ? '-0' : input];
    }
    if (input === null || typeof input === 'boolean') return [input === null ? 'null' : 'boolean', input];
    if (typeof input === 'string') { if (input.length > 1024) throw new Error(); return ['string', input]; }
    if (typeof input !== 'object' || ArrayBuffer.isView(input) || seen.has(input)) throw new Error();
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    seen.add(input);
    let output;
    if (Array.isArray(input)) {
      if (input.length > 64) throw new Error(); output = ['array', input.map(normalize)];
    } else {
      const keys = Object.keys(input).sort(); if (keys.length > 64) throw new Error();
      output = ['object', keys.map(key => [key, normalize(input[key])])];
    }
    seen.delete(input); return output;
  }
  try { const key = JSON.stringify(normalize(value)); return key.length <= MAX_KEY_CHARS ? key : null; }
  catch { return null; }
}
