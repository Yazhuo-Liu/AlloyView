export const VIEW_PRESETS = Object.freeze({
  front: { yaw: 0, pitch: 0 },
  back: { yaw: Math.PI, pitch: 0 },
  left: { yaw: -Math.PI / 2, pitch: 0 },
  right: { yaw: Math.PI / 2, pitch: 0 },
  top: { yaw: 0, pitch: Math.PI / 2 },
  bottom: { yaw: 0, pitch: -Math.PI / 2 },
});

/** Direction follows camera orientation; framing and projection do not affect it. */
export function cameraViewPreset({ yaw, pitch }, tolerance = 1e-7) {
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return 'custom';
  for (const [name, preset] of Object.entries(VIEW_PRESETS)) {
    const yawDifference = Math.atan2(Math.sin(yaw - preset.yaw), Math.cos(yaw - preset.yaw));
    if (Math.abs(yawDifference) <= tolerance && Math.abs(pitch - preset.pitch) <= tolerance) return name;
  }
  return 'custom';
}
