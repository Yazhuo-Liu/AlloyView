import { createAttributeRegistry } from './global-attributes.js';

export const GLOBAL_ATTRIBUTE_DEFAULTS = Object.freeze({ strainReferenceFrame: 0 });

/** Validated shared settings: the zero-based strain reference frame. */
export function normalizeGlobalAttributeState(value, { path = 'settings.extensions.globalAttributes' } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be an object');
  for (const key of Object.keys(value)) if (key !== 'strainReferenceFrame') fail(`${path}.${key}`, 'is not a supported setting');
  const frame = value.strainReferenceFrame ?? 0;
  if (!Number.isSafeInteger(frame) || frame < 0) fail(`${path}.strainReferenceFrame`, 'must be a nonnegative integer');
  return { strainReferenceFrame: frame };
}

function fail(path, message) { throw new Error(`Invalid AlloyView configuration: ${path} ${message}.`); }

/** The displayed frame's attribute registry, rebuilt only when the frame,
 * one of its properties or results, the DXA network or the strain
 * reference changes. Listeners are notified once per burst of refresh()
 * calls, after analyses have attached their results. The strain reference
 * cell is read in the background, without changing the displayed frame, only
 * once a label or time series asks for Strain.* (requestReference). */
export function createGlobalAttributeSource({ getFrame, getFrameIndex = () => 0, getFrameCount = () => 1,
  getFrameAt = async () => null, getSourceVersion = () => 0, getDxaNetwork = () => null,
  schedule = callback => setTimeout(callback, 0) } = {}) {
  let strainReferenceFrame = 0, reference = null, referenceRequest = null, registry = null, signature = [];
  let scheduled = false, notified = null;
  const listeners = new Set();

  function referenceKey(index = strainReferenceFrame) { return `${getSourceVersion()}\0${index}`; }

  /** The reference cell if known or displayed, otherwise null. */
  function referenceCell() {
    const key = referenceKey();
    if (reference?.key === key) return reference.cell;
    const frame = getFrame();
    if (frame?.cell && getFrameIndex() === strainReferenceFrame) {
      reference = { key, cell: copyCell(frame.cell) };
      return reference.cell;
    }
    return null;
  }

  /** Start reading the reference cell; listeners are notified when it arrives. */
  function requestReference() {
    if (!getFrame() || referenceCell() || strainReferenceFrame >= getFrameCount()) return;
    void ensureReference().catch(() => {});
  }

  async function ensureReference({ signal } = {}) {
    const key = referenceKey();
    if (reference?.key === key) return reference.cell;
    if (strainReferenceFrame >= getFrameCount()) return null;
    if (referenceRequest?.key !== key) {
      const index = strainReferenceFrame;
      const promise = Promise.resolve(getFrameAt(index, { signal })).then(frame => {
        if (referenceKey(index) !== key || !frame?.cell) return null;
        reference = { key, cell: copyCell(frame.cell) };
        refresh();
        return reference.cell;
      }).finally(() => { if (referenceRequest?.promise === promise) referenceRequest = null; });
      referenceRequest = { key, promise };
    }
    return referenceRequest.promise;
  }

  function contextFor(frame, frameIndex, { fileOnly = false } = {}) {
    const key = referenceKey();
    return { frame, frameIndex, frameCount: getFrameCount(), fileOnly,
      referenceCell: reference?.key === key ? reference.cell : null, referenceFrameIndex: strainReferenceFrame,
      dxaNetwork: fileOnly ? null : getDxaNetwork() };
  }

  function current() {
    const frame = getFrame();
    if (!frame) { registry = null; signature = []; return null; }
    const cell = referenceCell(), network = getDxaNetwork(), results = frame.atomeyeResults ?? {};
    const next = [frame, getFrameIndex(), getFrameCount(), cell, strainReferenceFrame, network, frame.timestep, frame.properties,
      results.clusters, results.wignerSeitz, results.grains, results.surfaceMesh, ...(frame.properties ?? []).flatMap(property => [property, property.data, property.analysisKey])];
    if (!registry || next.length !== signature.length || next.some((entry, index) => !Object.is(entry, signature[index]))) {
      signature = next;
      registry = createAttributeRegistry({ ...contextFor(frame, getFrameIndex()), referenceCell: cell, dxaNetwork: network });
    }
    return registry;
  }

  /** Coalesce calls; listeners receive (registry) only when it changed. */
  function refresh({ force = false } = {}) {
    if (force) notified = null;
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      const value = current();
      if (value === notified) return;
      notified = value;
      for (const listener of listeners) {
        try { listener(value); } catch (error) { console.error(error); }
      }
    });
  }

  return Object.freeze({
    current, refresh, ensureReference, requestReference,
    /** A registry for a frame read in the background (no analysis values). */
    forFrame: (frame, frameIndex, options = {}) => createAttributeRegistry(contextFor(frame, frameIndex, { fileOnly: true, ...options })),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getStrainReferenceFrame: () => strainReferenceFrame,
    setStrainReferenceFrame(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index === strainReferenceFrame) return false;
      strainReferenceFrame = index; refresh();
      return true;
    },
    serialize: () => ({ strainReferenceFrame }),
    restore(saved) { strainReferenceFrame = normalizeGlobalAttributeState(saved ?? {}).strainReferenceFrame; refresh({ force: true }); },
    /** Forget the reference cell, for example when the source closes. */
    reset() { reference = null; referenceRequest = null; registry = null; signature = []; refresh({ force: true }); },
  });
}

function copyCell(cell) {
  return { origin: Float64Array.from(cell.origin), vectors: Float64Array.from(cell.vectors), pbc: [...cell.pbc] };
}
