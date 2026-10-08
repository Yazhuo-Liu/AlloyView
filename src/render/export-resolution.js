/** Image exports keep the interactive canvas and camera unchanged. These
 * bounds include the final image; GPU render targets use a separate, smaller
 * working budget and are released after capture. */
export const MAX_EXPORT_SIDE = 16_384;
export const MAX_EXPORT_PIXELS = 32_000_000;
export const EXPORT_TILE_BYTES = 128 * 1024 ** 2;
export const EXPORT_RESOLUTION_MODES = ['current', '1080p', '4k', '2x', '4x', 'custom'];
export const DEFAULT_EXPORT_RESOLUTION = Object.freeze({ mode: 'current', width: 1920, height: 1080, lockAspect: true });

export function validateExportSize(width, height) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_EXPORT_SIDE)) {
    throw new Error(`Image width and height must be whole numbers between 1 and ${MAX_EXPORT_SIDE}.`);
  }
  if (width * height > MAX_EXPORT_PIXELS) throw new Error('Image export is limited to 32 megapixels. Choose a smaller size.');
  return { width, height };
}

export function normalizeExportResolution(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Image resolution settings must be an object.');
  const unknown = Object.keys(value).find(key => !['mode', 'width', 'height', 'lockAspect'].includes(key));
  if (unknown) throw new Error(`Unknown image resolution setting “${unknown}”.`);
  const mode = value.mode ?? DEFAULT_EXPORT_RESOLUTION.mode;
  if (!EXPORT_RESOLUTION_MODES.includes(mode)) throw new Error('Choose a supported image export resolution.');
  const width = value.width ?? DEFAULT_EXPORT_RESOLUTION.width, height = value.height ?? DEFAULT_EXPORT_RESOLUTION.height;
  validateExportSize(width, height);
  const lockAspect = value.lockAspect ?? DEFAULT_EXPORT_RESOLUTION.lockAspect;
  if (typeof lockAspect !== 'boolean') throw new Error('Image aspect lock must be true or false.');
  return { mode, width, height, lockAspect };
}

export function resolveExportSize(resolution, currentWidth, currentHeight) {
  const value = normalizeExportResolution(resolution);
  let width = currentWidth, height = currentHeight;
  if (value.mode === '1080p') { width = 1920; height = 1080; }
  else if (value.mode === '4k') { width = 3840; height = 2160; }
  else if (value.mode === 'custom') { width = value.width; height = value.height; }
  else if (value.mode === '2x' || value.mode === '4x') { const factor = value.mode === '2x' ? 2 : 4; width *= factor; height *= factor; }
  return validateExportSize(width, height);
}

/** Tiles are expressed in OpenGL's bottom-left pixel coordinates. A small
 * overlap retains edges and multisample coverage on either side of a seam. */
export function planExportTiles(width, height, maximumWidth, maximumHeight, gutter = 2) {
  validateExportSize(width, height);
  if (![maximumWidth, maximumHeight].every(value => Number.isSafeInteger(value) && value >= 2 * gutter + 1)) {
    throw new Error('This GPU cannot allocate an image export render target.');
  }
  if (width <= maximumWidth && height <= maximumHeight) return [{ x: 0, y: 0, width, height,
    renderX: 0, renderY: 0, renderWidth: width, renderHeight: height, readX: 0, readY: 0 }];
  const coreWidth = maximumWidth - 2 * gutter, coreHeight = maximumHeight - 2 * gutter;
  const tiles = [];
  for (let y = 0; y < height; y += coreHeight) for (let x = 0; x < width; x += coreWidth) {
    const w = Math.min(coreWidth, width - x), h = Math.min(coreHeight, height - y);
    const left = Math.max(0, x - gutter), bottom = Math.max(0, y - gutter);
    const right = Math.min(width, x + w + gutter), top = Math.min(height, y + h + gutter);
    tiles.push({ x, y, width: w, height: h, renderX: left, renderY: bottom,
      renderWidth: right - left, renderHeight: top - bottom, readX: x - left, readY: y - bottom });
  }
  return tiles;
}

/** Crop clip-space x/y rather than altering the camera: this works for both
 * perspective and parallel projections, preserves depth and vertical framing,
 * and maps each full-image pixel to the same multisample positions in a tile. */
export function tileProjection(projection, width, height, tile) {
  const result = new Float32Array(projection);
  const sx = tile.renderWidth / width, sy = tile.renderHeight / height;
  const cx = (2 * tile.renderX + tile.renderWidth) / width - 1;
  const cy = (2 * tile.renderY + tile.renderHeight) / height - 1;
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    result[offset] = (projection[offset] - cx * projection[offset + 3]) / sx;
    result[offset + 1] = (projection[offset + 1] - cy * projection[offset + 3]) / sy;
  }
  return result;
}

export function exportTileLimit(gl, samples = 4, requestedLimit = null) {
  const maximum = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  // Multisample color + depth, resolved RGBA, readback and flipped ImageData.
  const budgetSide = Math.floor(Math.sqrt(EXPORT_TILE_BYTES / (8 * Math.max(1, samples) + 12)));
  const userLimit = requestedLimit ?? 2048;
  if (!Number.isSafeInteger(userLimit) || userLimit < 8) throw new Error('Export tile size must be a whole number of at least 8 pixels.');
  return { width: Math.min(maximum, viewport[0], budgetSide, userLimit),
    height: Math.min(maximum, viewport[1], budgetSide, userLimit) };
}
