export const DEFAULT_PLAYBACK_INTERVAL_MS = 1000;

export function nextPlaybackFrame(currentIndex, frameCount) {
  if (!Number.isInteger(frameCount) || frameCount < 2) return 0;
  return (currentIndex + 1) % frameCount;
}
