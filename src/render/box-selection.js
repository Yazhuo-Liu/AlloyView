import { transformPoint } from './math.js';

const DEFAULT_WORK_BUDGET_MS = 8;

export function normalizeSelectionRectangle({ left, top, right, bottom }) {
  if (![left, top, right, bottom].every(Number.isFinite)) throw new Error('Selection bounds must be finite screen coordinates.');
  return { left: Math.min(left, right), top: Math.min(top, bottom),
    right: Math.max(left, right), bottom: Math.max(top, bottom) };
}

/** Select atom centers in screen space. Depth occlusion does not hide group
 * members; viewport clipping, slices, masks, and displayed replicas do apply.
 * Work yields in bounded chunks, so a large selection remains cancellable.
 */
export async function selectAtomsInRectangle(renderer, rectangle, { signal, onProgress = () => {},
  workBudgetMs = DEFAULT_WORK_BUDGET_MS, yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  signal?.throwIfAborted();
  if (!renderer.frame || !renderer.displayPositions) return new Uint32Array();
  renderer.updateMatrices();
  const frame = renderer.frame, positions = renderer.displayPositions, visibility = renderer.visibility;
  const revision = renderer.selectionRevision ?? 0;
  const camera = cameraKey(renderer);
  const viewport = renderer.canvas.getBoundingClientRect();
  const input = normalizeSelectionRectangle(rectangle);
  const bounds = { left: Math.max(input.left, viewport.left), top: Math.max(input.top, viewport.top),
    right: Math.min(input.right, viewport.left + viewport.width), bottom: Math.min(input.bottom, viewport.top + viewport.height) };
  if (viewport.width <= 0 || viewport.height <= 0 || bounds.left > bounds.right || bounds.top > bounds.bottom) return new Uint32Array();
  const matrix = Float64Array.from(renderer.viewProjectionMatrix);
  const ndc = { left: 2 * (bounds.left - viewport.left) / viewport.width - 1,
    right: 2 * (bounds.right - viewport.left) / viewport.width - 1,
    bottom: 1 - 2 * (bounds.bottom - viewport.top) / viewport.height,
    top: 1 - 2 * (bounds.top - viewport.top) / viewport.height };
  const replicas = (renderer.replicas ?? [{ indices: [0, 0, 0], offset: [0, 0, 0] }])
    .filter(replica => !renderer.selectionSourceBounds || replicaIntersectsRectangle(renderer.selectionSourceBounds, replica.offset, matrix, ndc));
  const output = new Uint32Array(renderer.atomCount);
  let length = 0, work = 0, deadline = performance.now() + Math.max(1, workBudgetMs);
  const check = () => {
    signal?.throwIfAborted();
    if (renderer.frame !== frame || renderer.displayPositions !== positions || renderer.visibility !== visibility
        || (renderer.selectionRevision ?? 0) !== revision || cameraKey(renderer) !== camera) throw new DOMException('The selection view changed.', 'AbortError');
    const currentViewport = renderer.canvas.getBoundingClientRect();
    if (['left', 'top', 'width', 'height'].some(key => currentViewport[key] !== viewport[key])) throw new DOMException('The viewport changed.', 'AbortError');
  };
  for (let atom = 0; atom < renderer.atomCount; atom += 1) {
    if (visibility?.[atom] !== 0) {
      const offset = atom * 3;
      for (const replica of replicas) {
        if (renderer.isAtomVisible(atom, replica.indices)) {
          const x = positions[offset] + replica.offset[0], y = positions[offset + 1] + replica.offset[1], z = positions[offset + 2] + replica.offset[2];
          const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
          if (w > 0) {
            const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
            const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
            const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
            if (clipX >= ndc.left * w && clipX <= ndc.right * w && clipY >= ndc.bottom * w && clipY <= ndc.top * w
                && clipZ >= -w && clipZ <= w) { output[length++] = atom; break; }
          }
        }
        if (++work % 512 === 0 && performance.now() >= deadline) {
          check(); onProgress({ completedAtoms: atom, totalAtoms: renderer.atomCount });
          await yieldControl(); check(); deadline = performance.now() + Math.max(1, workBudgetMs);
        }
      }
    }
    // Also yield when most atoms are hidden or found in their first replica.
    if (atom % 512 === 511 && performance.now() >= deadline) {
      check(); onProgress({ completedAtoms: atom + 1, totalAtoms: renderer.atomCount });
      await yieldControl(); check(); deadline = performance.now() + Math.max(1, workBudgetMs);
    }
  }
  check(); onProgress({ completedAtoms: renderer.atomCount, totalAtoms: renderer.atomCount }); check();
  return length === output.length ? output : output.slice(0, length);
}

function cameraKey(renderer) {
  return JSON.stringify([renderer.yaw, renderer.pitch, renderer.target, renderer.pan, renderer.distance,
    renderer.orthographicScale, renderer.fov, renderer.projectionMode]);
}

/** Conservative AABB rejection using homogeneous clip planes, including
 * boxes crossing the perspective near plane. No atom-level work is lost.
 */
export function replicaIntersectsRectangle({ minimum, maximum }, offset, matrix, ndc) {
  const outside = new Array(7).fill(true);
  for (let mask = 0; mask < 8; mask += 1) {
    const point = [0, 1, 2].map(axis => (mask & (1 << axis) ? maximum[axis] : minimum[axis]) + offset[axis]);
    const [x, y, z, w] = transformPoint(matrix, ...point);
    const planes = [x - ndc.left * w, ndc.right * w - x, y - ndc.bottom * w, ndc.top * w - y, z + w, w - z, w];
    for (let plane = 0; plane < planes.length; plane++) if (planes[plane] >= 0) outside[plane] = false;
  }
  return !outside.some(Boolean);
}
