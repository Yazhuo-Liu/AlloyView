/** Per-atom property names under which the built-in structure classifications
 * publish their results. Configuration, visibility filters and the analysis
 * panels agree on this vocabulary without importing each other. */
export const DXA_STRUCTURE_PROPERTY = 'dxaStructureType';

export const CRYSTAL_STRUCTURE_PROPERTIES = Object.freeze([
  'structureType', 'ptmStructureType', 'centralSymmetryStructureType',
  'idealStrainStructureType', DXA_STRUCTURE_PROPERTY,
]);

export function isCrystalStructureProperty(name) {
  return CRYSTAL_STRUCTURE_PROPERTIES.includes(name);
}
