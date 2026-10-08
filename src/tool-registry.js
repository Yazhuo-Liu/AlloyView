/** Shared classification for tool navigation and future structure editors. */
export const TOOL_CATEGORIES = Object.freeze(['visualization', 'modification']);

export const BUILTIN_TOOLS = Object.freeze([
  { id: 'display', label: 'Display' },
  { id: 'slice', label: 'Slice' },
  { id: 'coordination', label: 'Coordination', analysis: true },
  { id: 'bonds', label: 'Bonds', analysis: true },
  { id: 'voronoi', label: 'Voronoi', analysis: true },
  { id: 'clusters', label: 'Clusters', analysis: true },
  { id: 'vectors', label: 'Vectors' },
  { id: 'displacement', label: 'Displacement', analysis: true },
  { id: 'statistics', label: 'Statistics', analysis: true },
  { id: 'binning', label: 'Binning', analysis: true },
  { id: 'cna', label: 'CNA', analysis: true },
  { id: 'dxa', label: 'DXA', analysis: true },
  { id: 'centrosymmetry', label: 'Symmetry', analysis: true },
  { id: 'ptm', label: 'PTM', analysis: true },
  { id: 'strain', label: 'Strain', analysis: true },
  { id: 'referenceStrain', label: 'Frame strain', analysis: true },
  { id: 'localShear', label: 'Local shear', analysis: true },
  { id: 'selectionGroups', label: 'Selections' },
  { id: 'performance', label: 'Performance' },
  { id: 'replicate', label: 'Replicate', category: 'modification', changesStructure: true },
  { id: 'externalProperties', label: 'External properties', category: 'modification', changesProperties: true },
  { id: 'expressions', label: 'Expressions', category: 'modification', changesProperties: true },
].map(tool => Object.freeze({ category: 'visualization', analysis: false, ...tool })));

/**
 * Register a future editor with category: 'modification', and mount its button
 * and settings panel through initializeToolPanels().registerTool(). Atom add,
 * delete and move controllers can supply their own selection and undo behavior;
 * navigation only manages category, visibility, and explicit deactivation.
 */
export function createToolRegistry(initialTools = BUILTIN_TOOLS) {
  const entries = new Map();
  function register(definition) {
    if (!definition || typeof definition.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(definition.id)) {
      throw new TypeError('A tool requires a stable alphanumeric id.');
    }
    const category = definition.category ?? 'visualization';
    if (!TOOL_CATEGORIES.includes(category)) throw new TypeError(`Unknown tool category: ${category}`);
    if (entries.has(definition.id)) throw new TypeError(`Tool already registered: ${definition.id}`);
    const entry = Object.freeze({ ...definition, category, label: definition.label || definition.id, analysis: !!definition.analysis });
    entries.set(entry.id, entry);
    return entry;
  }
  for (const definition of initialTools) register(definition);
  return Object.freeze({
    register,
    get: id => entries.get(id),
    has: id => entries.has(id),
    list: category => [...entries.values()].filter(tool => !category || tool.category === category),
    categoryFor: id => entries.get(id)?.category ?? 'visualization',
    isAnalysis: id => !!entries.get(id)?.analysis,
  });
}
