// Local observations, not audit-machine thresholds. Calibration returns one
// normal result per request; it never runs both backends for the same request.
const CONTESTED = new Set(['centrosymmetry', 'bondStatistics', 'bonds', 'rdf']);
const SUPPORTED = new Set(['coordination', 'cna', 'centrosymmetry', 'bondStatistics', 'bonds', 'rdf', 'localShear', 'displacement', 'referenceStrain']);
const MAX_PROFILES = 128;
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
export class MeasuredGpuRouting {
  constructor() { this.profiles = new Map(); this.batches = new Set(); this.generation = null; }
  clear() { this.profiles.clear(); }
  beginBatch() { const batch = new Map(); this.batches.add(batch); return () => this.batches.delete(batch); }
  key(frame, parameters, workers, generation) {
    if (generation !== this.generation) { this.clear(); this.generation = generation; }
    const count = frame?.fractional?.length / 3;
    if (!SUPPORTED.has(parameters.kind) || !Number.isInteger(count) || count < 16384) return null;
    const settings = {};
    for (const name of Object.keys(parameters).sort()) {
      const value = parameters[name];
      if (name === 'kind') continue;
      if (value === undefined || value === null || typeof value === 'boolean'
          || typeof value === 'number' && Number.isFinite(value)
          || typeof value === 'string' && value.length <= 1024) settings[name] = value;
      else if (name === 'pairCutoffs' && Array.isArray(value) && value.length <= 32) {
        // Only the three fields consumed by the scientific kernel are copied.
        // Imported metadata/toJSON functions must never enter a route key.
        if (value.some(pair => !pair || ![pair.first, pair.second, pair.cutoff].every(Number.isFinite))) return null;
        settings[name] = value.map(({ first, second, cutoff }) => [Math.min(first, second), Math.max(first, second), cutoff])
          .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      }
      else return null; // Raw correspondence/classification inputs are not profile keys.
    }
    const serialized = JSON.stringify(settings); if (serialized.length > 4096) return null;
    const h = frame.cell.vectors;
    const volume = Math.abs(h[0]*(h[4]*h[8]-h[5]*h[7])-h[1]*(h[3]*h[8]-h[5]*h[6])+h[2]*(h[3]*h[7]-h[4]*h[6]));
    const density = volume > 0 ? Math.floor(Math.log2(count / volume)) : 0;
    return JSON.stringify([parameters.kind, Math.floor(Math.log2(count)), workers, density, frame.cell.pbc,
      Boolean(frame.cell.triclinic), frame.typeLabels?.length ?? 0, serialized]);
  }
  choose(key, kind, { allowProbe = true } = {}) {
    if (!key) {
      const pinned = [...this.batches].find(batch => batch.has(kind));
      for (const batch of this.batches) if (!batch.has(kind)) batch.set(kind, pinned?.get(kind) ?? 'gpu');
      return { backend: pinned?.get(kind) ?? 'gpu', ...(pinned?.get(kind) === 'cpu' ? { reason: 'CPU retained for this analysis batch.' } : {}) };
    }
    let profile = this.profiles.get(key);
    if (!profile) {
      profile = { gpu: [], cpu: [], runs: 0, backend: 'gpu' }; this.profiles.set(key, profile);
      while (this.profiles.size > MAX_PROFILES) this.profiles.delete(this.profiles.keys().next().value);
    }
    let backend = profile.backend;
    // A probe cannot teach the model while other work shares its resources.
    // Defer it rather than repeatedly sending busy requests to an untrained
    // backend; existing learned choices and batch pins remain applicable.
    if (allowProbe && CONTESTED.has(kind) && profile.gpu.length >= 3 && profile.cpu.length < 3) backend = 'cpu';
    else if (profile.gpu.length >= 3 && profile.cpu.length >= 3) {
      const gpu = median(profile.gpu), cpu = median(profile.cpu);
      if (cpu < gpu * .8) backend = 'cpu';
      else if (gpu < cpu * .8) backend = 'gpu';
      profile.backend = backend;
      // Sparse rechecks let a changed workload or device performance recover.
      if (allowProbe && profile.runs > 0 && profile.runs % 32 === 0) backend = backend === 'cpu' ? 'gpu' : 'cpu';
    }
    const pinned = [...this.batches].find(batch => batch.has(kind));
    backend = pinned?.get(kind) ?? backend;
    // A nested batch inherits every used kernel before the outer one closes.
    for (const batch of this.batches) if (!batch.has(kind)) batch.set(kind, backend);
    return { backend, ...(backend === 'cpu' ? { reason: profile.cpu.length < 3
      ? 'CPU selected for bounded local backend calibration.' : 'CPU selected by measured local backend timings.' } : {}) };
  }
  observe(key, backend, milliseconds) {
    const profile = this.profiles.get(key);
    if (!profile || !Number.isFinite(milliseconds) || milliseconds <= 0) return;
    profile[backend].push(milliseconds); if (profile[backend].length > 7) profile[backend].shift(); profile.runs++;
  }
  canReuse(kind, backend, key, fallbackReason, options) {
    if (!this.batches.size || !CONTESTED.has(kind) || fallbackReason) return true;
    return this.choose(key, kind, options).backend === backend;
  }
  status() { return [...this.profiles.values()].map(profile => ({ backend: profile.backend,
    gpuSamples: profile.gpu.length, cpuSamples: profile.cpu.length,
    gpuMedianMs: profile.gpu.length ? median(profile.gpu) : null, cpuMedianMs: profile.cpu.length ? median(profile.cpu) : null })); }
}
