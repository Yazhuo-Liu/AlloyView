/** Tool categories in tab order, with their tab labels. Every category is a
 * top-level tab of the Tools section; `modification` holds the tools that
 * change the structure or its properties and future atom editors. */
export const TOOL_CATEGORIES = Object.freeze(['display', 'structure', 'defects', 'strain', 'statistics', 'automation', 'modification']);
export const TOOL_CATEGORY_LABELS = Object.freeze({
  display: 'Display', structure: 'Structure', defects: 'Order & defects', strain: 'Strain & motion',
  statistics: 'Statistics', automation: 'Automation', modification: 'Modify',
});

export const BUILTIN_TOOLS = Object.freeze([
  { id: 'display', label: 'Display', category: 'display'  },
  { id: 'slice', label: 'Slice', category: 'display'  },
  { id: 'vectors', label: 'Vectors', category: 'display'  },
  { id: 'textLabels', label: 'Labels', category: 'display'  },
  { id: 'selectionGroups', label: 'Selections', category: 'display'  },
  { id: 'crystal', label: 'Crystal', category: 'structure', analysis: true  },
  { id: 'volumetric', label: 'Volume', category: 'structure', analysis: true  },
  { id: 'surfaceMesh', label: 'Surface', category: 'structure', analysis: true  },
  { id: 'coordination', label: 'Coordination', category: 'structure', analysis: true  },
  { id: 'bonds', label: 'Bonds', category: 'structure', analysis: true  },
  { id: 'voronoi', label: 'Voronoi', category: 'structure', analysis: true  },
  { id: 'clusters', label: 'Clusters', category: 'structure', analysis: true  },
  { id: 'cna', label: 'CNA', category: 'defects', analysis: true  },
  { id: 'ptm', label: 'PTM', category: 'defects', analysis: true  },
  { id: 'centrosymmetry', label: 'Symmetry', category: 'defects', analysis: true  },
  { id: 'grains', label: 'Grains', category: 'defects', analysis: true  },
  { id: 'dxa', label: 'DXA', category: 'defects', analysis: true  },
  { id: 'wignerSeitz', label: 'Wigner–Seitz', category: 'defects', analysis: true  },
  { id: 'strain', label: 'Strain', category: 'strain', analysis: true  },
  { id: 'referenceStrain', label: 'Frame strain', category: 'strain', analysis: true  },
  { id: 'localShear', label: 'Local shear', category: 'strain', analysis: true  },
  { id: 'displacement', label: 'Displacement', category: 'strain', analysis: true  },
  { id: 'statistics', label: 'Statistics', category: 'statistics', analysis: true  },
  { id: 'binning', label: 'Binning', category: 'statistics', analysis: true  },
  { id: 'timeSeries', label: 'Time series', category: 'statistics'  },
  { id: 'scripts', label: 'Scripts', category: 'automation'  },
  { id: 'movie', label: 'Movie', category: 'automation'  },
  { id: 'performance', label: 'Performance', category: 'automation'  },
  { id: 'replicate', label: 'Replicate', category: 'modification', changesStructure: true  },
  { id: 'externalProperties', label: 'External properties', category: 'modification', changesProperties: true  },
  { id: 'expressions', label: 'Expressions', category: 'modification', changesProperties: true  },
  { id: 'trajectory', label: 'Trajectory', category: 'modification', changesStructure: true  },
].map(tool => Object.freeze({ analysis: false, ...tool })));

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
    const category = definition.category ?? 'display';
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
    categoryFor: id => entries.get(id)?.category ?? 'display',
    isAnalysis: id => !!entries.get(id)?.analysis,
  });
}
