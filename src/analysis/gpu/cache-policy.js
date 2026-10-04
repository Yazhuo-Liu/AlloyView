const MiB = 1024 ** 2;

export const DEFAULT_GPU_BUDGET_BYTES = 2 * 1024 ** 3;
export const FALLBACK_GPU_BUDGET_BYTES = 128 * MiB;
export const MIN_GPU_WORKSPACE_BYTES = 32 * MiB;

/** WebGPU exposes buffer limits, not free VRAM. These are conservative app
 * budgets; successful allocation, not an adapter limit, determines residency. */
export function conservativeGpuBudget(_limits = {}, { isFallbackAdapter = false } = {}) {
  // A single-buffer limit is independent of the total residency budget.
  // Allocate lazily, then reduce this budget if a real allocation fails.
  return isFallbackAdapter ? FALLBACK_GPU_BUDGET_BYTES : DEFAULT_GPU_BUDGET_BYTES;
}

export function frameUploadBytes(frame) {
  // Two vec4f coordinates (high + residual) and a u32 element per atom.
  return frame.fractional.length / 3 * 36;
}

export function gpuWorkspaceBytes(frameBytes = 0) {
  // Leave room for linked-cell indexes, shear tensors, corrections and
  // readback. The largest uploaded frame controls the conservative reserve.
  return Math.max(MIN_GPU_WORKSPACE_BYTES, frameBytes * 4);
}

export function trajectoryCapacity({ frameCount = 0, frameBytes = 0, budgetBytes, workspaceBytes = gpuWorkspaceBytes(frameBytes) }) {
  if (!frameBytes) return Math.min(frameCount || 2, 2);
  return Math.max(0, Math.min(frameCount || 2, Math.floor(Math.max(0, budgetBytes - workspaceBytes) / frameBytes)));
}

/** Furthest frame first; equal-distance eviction keeps the more recent frame.
 * Frames without trajectory indexes retain insertion-order eviction. */
export function frameEvictionOrder(frames, currentIndex, protectedKeys = new Set()) {
  return [...frames].map(([key, frame], order) => ({ key, frame, order }))
    .filter(({ key, frame }) => !protectedKeys.has(key) && !(Number.isInteger(frame.frameIndex) && frame.frameIndex === currentIndex))
    .sort((first, second) => {
      const distance = frame => Number.isInteger(frame.frameIndex) ? Math.abs(frame.frameIndex - currentIndex) : Infinity;
      return distance(second.frame) - distance(first.frame) || first.order - second.order;
    }).map(({ key }) => key);
}
