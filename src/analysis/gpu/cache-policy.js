import { GPU_TRAJECTORY_WINDOW } from '../../data/gpu-trajectory-window.js';

const MiB = 1024 ** 2;

export const DEFAULT_GPU_BUDGET_BYTES = 2 * 1024 ** 3;
export const FALLBACK_GPU_BUDGET_BYTES = 128 * MiB;
export const MIN_GPU_WORKSPACE_BYTES = 32 * MiB;

/** Limits are capability hints, never a measurement of free VRAM. Bound the
 * app allocation budget by both adapter capabilities and coarse host memory;
 * real allocation failures can still reduce it. Unknown hardware gets 512 MiB. */
export function conservativeGpuBudget(limits = {}, info = {}, deviceMemoryGiB) {
  const candidates = [DEFAULT_GPU_BUDGET_BYTES];
  for (const [value, factor] of [[limits.maxBufferSize, 4], [limits.maxStorageBufferBindingSize, 8],
    [deviceMemoryGiB, 1024 ** 3 / 8]]) {
    if (Number.isFinite(value) && value > 0) candidates.push(value * factor);
  }
  if (candidates.length === 1) candidates.push(512 * MiB);
  if (info.isFallbackAdapter || /swiftshader|software|llvmpipe/i.test(`${info.vendor ?? ''} ${info.architecture ?? ''} ${info.description ?? ''}`)) {
    candidates.push(FALLBACK_GPU_BUDGET_BYTES);
  }
  return Math.max(64 * MiB, Math.floor(Math.min(...candidates)));
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
  return Math.max(0, Math.min(frameCount || 2, GPU_TRAJECTORY_WINDOW, Math.floor(Math.max(0, budgetBytes - workspaceBytes) / frameBytes)));
}

/** Furthest frame first; equal-distance eviction keeps the more recent frame.
 * Derived inputs and frames without indexes retain insertion-order eviction.
 * A subset shares its source's index but not its permanent current-frame pin. */
export function frameEvictionOrder(frames, currentIndex, protectedKeys = new Set()) {
  return [...frames].map(([key, frame], order) => ({ key, frame, order }))
    .filter(({ key, frame }) => !protectedKeys.has(key) && !(!frame.derived && Number.isInteger(frame.frameIndex) && frame.frameIndex === currentIndex))
    .sort((first, second) => {
      const distance = frame => !frame.derived && Number.isInteger(frame.frameIndex) ? Math.abs(frame.frameIndex - currentIndex) : Infinity;
      return distance(second.frame) - distance(first.frame) || first.order - second.order;
    }).map(({ key }) => key);
}
