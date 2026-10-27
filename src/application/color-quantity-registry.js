import { initialColorQuantities } from '../render/color-quantities.js';

const DEFAULT_NOTE = 'calculating…';

/** One place where analyses and property sources announce the color
 * quantities they publish, so the Color by menu, the vector-source waiting
 * logic and the configuration summary never need to know the tools by name.
 *
 * Published results are frame properties (`replaceAnalysisProperty`); their
 * shape decides the legend: `categories` gives a checkbox legend with
 * per-class visibility, a numeric array gives the scalar range legend with
 * "Hide values outside range". Nothing registers them. A provider only
 * describes what is still on its way, through these optional methods:
 *
 * - `pendingColorProperties()` → `[{ name, label, note? }]`: properties the
 *   provider is computing or waiting for. They appear as `property:<name>`
 *   with `(note)` after the label; the default note is "calculating…".
 * - `pendingColorModes()` → `[{ value, label, note? }]`: builtin color modes,
 *   such as orientation keys, offered the same way.
 * - `pendingKinds()` → `[kind]`: analysis kinds still queued or running.
 * - `getPropertyKind(name)` → the enabled analysis kind producing `name`.
 * - `failed()` → `[kind]`: analysis kinds that could not complete.
 *
 * Providers are consulted in registration order, which is also the order
 * of their pending entries in the menu. */
export function createColorQuantityRegistry() {
  const providers = [];

  const entries = (provider, method) => provider[method]?.() ?? [];

  /** Menu entries: atom type, the frame's published quantities, then pending
   * ones that are not published yet. `selected` stays listed as unavailable so
   * a later frame can recover without another manual choice. */
  function options(frame, { selected = null } = {}) {
    const seen = new Set();
    const items = [];
    const add = (value, label) => {
      if (seen.has(value)) return;
      seen.add(value);
      items.push({ value, label });
    };
    add('type', 'Atom type');
    for (const { value, label } of initialColorQuantities(frame)) add(value, label);
    for (const provider of providers) {
      for (const { name, label, note = DEFAULT_NOTE } of entries(provider, 'pendingColorProperties')) add(`property:${name}`, `${label} (${note})`);
      for (const { value, label, note = DEFAULT_NOTE } of entries(provider, 'pendingColorModes')) add(value, `${label} (${note})`);
    }
    if (selected && !seen.has(selected)) {
      add(selected, `${selected.startsWith('property:') ? selected.slice(9) : selected} (unavailable in this frame)`);
    }
    return items;
  }

  /** Every pending property with the provider announcing it, in menu order. */
  function pendingProperties() {
    return providers.flatMap(provider => entries(provider, 'pendingColorProperties')
      .map(({ name, label }) => ({ provider, name, label })));
  }

  return Object.freeze({
    register(provider) {
      if (!provider || providers.includes(provider)) return;
      providers.push(provider);
    },
    options,
    pendingProperties,
    pendingKinds: () => providers.flatMap(provider => entries(provider, 'pendingKinds')),
    propertyKind(name) {
      for (const provider of providers) {
        const kind = provider.getPropertyKind?.(name);
        if (kind) return kind;
      }
      return null;
    },
    failedKinds: () => providers.flatMap(provider => entries(provider, 'failed')),
  });
}
