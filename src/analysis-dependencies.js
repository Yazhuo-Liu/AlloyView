import { EXPRESSION_ALIASES, EXPRESSION_BUILTIN_NAMES } from './expressions.js';
import { importedVectorComponents } from './vector-settings.js';
import { colorPropertyKey } from './render/color-quantities.js';

const builtins = new Set(EXPRESSION_BUILTIN_NAMES.map(name => name.toLowerCase()));
const ready = name => ({ name, state: 'ready' });
const unavailable = (name, message) => ({ name, state: 'unavailable', message: message ?? `${name} is unavailable in this frame. No active calculation will produce it.` });

/** Resolve only the inputs a consumer uses, without evaluating expressions or
 * allocating any per-atom arrays. Producer state belongs to the displayed
 * frame; background trajectory reads must never wait for its analyses. */
export function createAnalysisDependencies({ getFrame, getProducer = () => null,
  getExpressionStatus = () => null, getExpressionReferences = () => null,
  getFilters = () => ({}) } = {}) {
  function velocityReady(frame) {
    return importedVectorComponents(frame, 'velocity')?.every(property => property.data?.length === frame.ids.length) ?? false;
  }

  function property(frame, name, { folded = false } = {}) {
    const valid = item => item.data?.length === frame.ids.length;
    const exact = frame.properties?.find(item => item.name === name && valid(item));
    if (exact || !folded) return exact ?? null;
    const matches = (frame.properties ?? []).filter(item => item.name.toLowerCase() === name.toLowerCase() && valid(item));
    return matches.length > 1 ? { ambiguous: true } : matches[0] ?? null;
  }

  function reference(frame, ref, visited, waitForProducers, consumerKind) {
    const lower = ref.name.toLowerCase();
    if (!ref.quoted && builtins.has(lower)) {
      return lower.startsWith('velocity.') && !velocityReady(frame) ? unavailable(ref.name) : ready(ref.name);
    }
    const found = property(frame, ref.name, { folded: true });
    if (found?.ambiguous) return unavailable(ref.name, `${ref.name} matches multiple columns. Use their exact names.`);
    if (found) return resolve(frame, found.name, visited, false, waitForProducers, consumerKind);
    const target = !ref.quoted ? EXPRESSION_ALIASES.get(lower) ?? ref.name : ref.name;
    return resolve(frame, target, visited, true, waitForProducers, consumerKind);
  }

  function resolve(frame, name, visited = new Set(), folded = false, waitForProducers = false, consumerKind = null) {
    const found = property(frame, name, { folded });
    if (found?.ambiguous) return unavailable(name, `${name} matches multiple columns. Use their exact names.`);
    // A visible surface must use the mask produced by an in-flight analysis,
    // even if an imported column or an earlier result has the same name.
    // Binning may still consume those existing values explicitly.
    let producer = waitForProducers ? getProducer(found?.name ?? name, frame) : null;
    // A consumer cannot use its own computed output as an input. Match the
    // actual producer/column ownership, never just a reserved output name:
    // an imported column restored under that name remains a valid input.
    if (consumerKind && (found?.analysisKind === consumerKind || (!found && producer?.kind === consumerKind))) {
      return unavailable(name, `${name} creates a cyclic dependency on the ${consumerKind} analysis that requires it.`);
    }
    if (found && consumerKind && producer?.kind === consumerKind) producer = null;
    if (consumerKind && producer?.failed && found?.analysisKind) return unavailable(name, producer.message);
    if (producer?.state === 'pending') return { ...producer, name: producer.name ?? name };
    const status = getExpressionStatus(found?.name ?? name);
    if (found && (!waitForProducers || !status || ['error', 'conflict'].includes(status.state))) return ready(found.name);
    if (status) {
      if (visited.has(status.name)) return unavailable(name, `Computed property ${name} has a cyclic dependency.`);
      if (status.state === 'error' || status.state === 'conflict') return unavailable(name, status.message);
      const next = new Set(visited); next.add(status.name);
      const inputs = (getExpressionReferences(status.name) ?? []).map(ref => reference(frame, ref, next, waitForProducers, consumerKind));
      const missing = inputs.find(input => input.state === 'unavailable');
      if (missing) return unavailable(status.name, `${status.name} requires ${missing.name}. ${missing.message}`);
      const pending = inputs.filter(input => input.state === 'pending');
      if (pending.length) return { name: status.name, state: 'pending', producers: [...new Set(pending.flatMap(input => input.producers ?? [input.name]))] };
      if (found) return ready(found.name);
      return unavailable(status.name, status.message ?? `${status.name} has not produced values for this frame.`);
    }
    const missingProducer = producer ?? getProducer(name, frame);
    if (consumerKind && missingProducer?.kind === consumerKind) {
      return unavailable(name, `${name} creates a cyclic dependency on the ${consumerKind} analysis that requires it.`);
    }
    return missingProducer?.state === 'pending' ? { ...missingProducer, name: missingProducer.name ?? name }
      : unavailable(name, missingProducer?.message);
  }

  function getPropertyDependency(key, frame = getFrame(), { waitForProducers = false, consumerKind = null } = {}) {
    const name = key.startsWith('property:') ? key.slice(9) : key;
    if (!frame || frame !== getFrame()) return unavailable(name, `${name} has no producer for this background frame.`);
    if (/^builtin:position:[xyz]$/.test(key)) return frame.positions?.length === frame.ids.length * 3 ? ready(name) : unavailable(name);
    if (key === 'builtin:velocity:magnitude') return velocityReady(frame) ? ready(name) : unavailable(name);
    if (key.startsWith('builtin:')) return unavailable(name);
    return resolve(frame, name, new Set(), false, waitForProducers, consumerKind);
  }

  function getVisibilityDependencies(frame = getFrame()) {
    const { crystalSource, quantity = 'type', hiddenCategories = () => null, scalarRange = () => null, hideOutside = () => true } = getFilters();
    const keys = new Set();
    if (crystalSource && hiddenCategories(crystalSource)?.size) keys.add(`property:${crystalSource}`);
    if (quantity !== 'type') {
      const rangeKey = quantity.startsWith('property:') ? colorPropertyKey(quantity.slice(9)) : quantity;
      if (hiddenCategories(rangeKey)?.size || (scalarRange(rangeKey) && hideOutside(rangeKey))) keys.add(quantity);
    }
    return [...keys].map(key => getPropertyDependency(key, frame, { waitForProducers: true })).filter(dependency => dependency.state !== 'ready');
  }

  return Object.freeze({ getPropertyDependency, getVisibilityDependencies });
}
