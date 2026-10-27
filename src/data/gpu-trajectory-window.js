/** How many frames around the displayed one GPU residency keeps at most. */
export const GPU_TRAJECTORY_WINDOW = 5;

/** A small nearest-first window, including the displayed frame. Near either
 * end, unused slots look farther in the available direction. */
export function gpuTrajectoryWindow(currentIndex, frameCount, capacity = GPU_TRAJECTORY_WINDOW) {
  const count = Math.max(0, Math.trunc(frameCount));
  if (!count || !Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= count) return [];
  const limit = Math.min(count, GPU_TRAJECTORY_WINDOW, Math.max(1, Math.trunc(capacity) || 1));
  const indices = [currentIndex];
  for (let distance = 1; indices.length < limit; distance += 1) {
    if (currentIndex + distance < count) indices.push(currentIndex + distance);
    if (indices.length >= limit) break;
    if (currentIndex - distance >= 0) indices.push(currentIndex - distance);
  }
  return indices;
}
