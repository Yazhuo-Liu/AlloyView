// Independent arrow dimensions. The shaft defaults preserve the original
// arrows' width while no longer following the dislocation tube radius.
export const DISLOCATION_VECTOR_DEFAULTS = Object.freeze({
  burgersVectorRadius: 0.84,
  burgersVectorScale: 2,
  lineDirectionRadius: 0.84,
  lineDirectionScale: 1,
});
export const DISLOCATION_VECTOR_MAXIMUM = 1e6;
export const DISLOCATION_VECTOR_MINIMUM = 1e-12;
