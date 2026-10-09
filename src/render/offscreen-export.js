import { exportTileLimit, planExportTiles } from './export-resolution.js';

function multisampleCount(gl) {
  const colors = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES) ?? []);
  const depth = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES) ?? []);
  return Math.max(0, ...colors.filter(value => value <= 4 && depth.includes(value)));
}

function allocateTarget(gl, width, height, samples) {
  const buffers = [], frames = [];
  const dispose = () => { for (const value of frames) gl.deleteFramebuffer(value); for (const value of buffers) gl.deleteRenderbuffer(value); };
  function frame() {
    const value = gl.createFramebuffer(); if (!value) throw new Error('Unable to allocate an image framebuffer.');
    frames.push(value); gl.bindFramebuffer(gl.FRAMEBUFFER, value); return value;
  }
  function attachment(format, point, count) {
    const value = gl.createRenderbuffer(); if (!value) throw new Error('Unable to allocate an image renderbuffer.');
    buffers.push(value); gl.bindRenderbuffer(gl.RENDERBUFFER, value);
    if (count) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, count, format, width, height);
    else gl.renderbufferStorage(gl.RENDERBUFFER, format, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, point, gl.RENDERBUFFER, value);
  }
  function complete() {
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE || gl.getError() !== gl.NO_ERROR) {
      throw new Error('This GPU could not allocate the image export target.');
    }
  }
  try {
    const resolved = frame(); attachment(gl.RGBA8, gl.COLOR_ATTACHMENT0, 0);
    let draw = resolved;
    if (samples) { complete(); draw = frame(); attachment(gl.RGBA8, gl.COLOR_ATTACHMENT0, samples); }
    attachment(gl.DEPTH_COMPONENT24, gl.DEPTH_ATTACHMENT, samples); complete();
    return { draw, resolved, samples, dispose };
  } catch (error) { dispose(); throw error; }
}

/** Render tiles directly into the final 2D canvas: no full-size JS pixel copy,
 * texture, or multisample framebuffer is retained alongside that image. The
 * caller supplies the scene drawing and owns the interactive camera state. */
const MATTE_BLACK = Object.freeze([0, 0, 0]), MATTE_WHITE = Object.freeze([1, 1, 1]);

/** Recover straight color and alpha from the same view rendered on black (k)
 * and white (w) backgrounds: the view equals k + (1 − α)·B for any background
 * B, so α = 1 − mean(w − k) and color = k / α. The transparent image then
 * composites over any background exactly like the view rendered on it. */
export function solveMatte(black, white, output, count) {
  for (let pixel = 0; pixel < count * 4; pixel += 4) {
    const transmission = (white[pixel] - black[pixel] + white[pixel + 1] - black[pixel + 1] + white[pixel + 2] - black[pixel + 2]) / 765;
    const alpha = Math.round(255 * Math.min(1, Math.max(0, 1 - transmission)));
    for (let channel = 0; channel < 3; channel++) {
      output[pixel + channel] = alpha ? Math.min(255, Math.round(black[pixel + channel] * 255 / alpha)) : 0;
    }
    output[pixel + 3] = alpha;
  }
  return output;
}

export function captureOffscreen(gl, context, width, height, renderTile, { tileSize = null, matte = false } = {}) {
  if (gl.isContextLost()) throw new Error('The graphics context was lost. Reload the structure before exporting.');
  const saved = { draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    renderbuffer: gl.getParameter(gl.RENDERBUFFER_BINDING), viewport: gl.getParameter(gl.VIEWPORT),
    scissor: gl.isEnabled(gl.SCISSOR_TEST), scissorBox: gl.getParameter(gl.SCISSOR_BOX) };
  let target;
  try {
    const samples = multisampleCount(gl), limit = exportTileLimit(gl, samples, tileSize);
    let maximumWidth = Math.min(width, limit.width), maximumHeight = Math.min(height, limit.height);
    // Small images do not need overlap; the overlap is only between tiles.
    let tiles;
    for (;;) {
      tiles = planExportTiles(width, height, Math.max(5, maximumWidth), Math.max(5, maximumHeight));
      const allocationWidth = Math.max(...tiles.map(tile => tile.renderWidth));
      const allocationHeight = Math.max(...tiles.map(tile => tile.renderHeight));
      try { target = allocateTarget(gl, allocationWidth, allocationHeight, samples); break; }
      catch (error) {
        if (gl.isContextLost() || maximumWidth < 64 || maximumHeight < 64) throw error;
        // Browser/GPU allocation budgets can be smaller than their advertised
        // dimensional limit. Retry smaller tiles without shrinking the image.
        maximumWidth = Math.floor(maximumWidth / 2); maximumHeight = Math.floor(maximumHeight / 2);
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    const bufferWidth = Math.max(...tiles.map(tile => tile.width)), bufferHeight = Math.max(...tiles.map(tile => tile.height));
    const pixels = new Uint8Array(bufferWidth * bufferHeight * 4);
    const black = matte ? new Uint8Array(pixels.length) : null;
    let image;
    const renderInto = (tile, buffer, background) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.draw);
      gl.viewport(0, 0, tile.renderWidth, tile.renderHeight);
      renderTile(tile, background);
      if (target.samples) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.draw); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolved);
        gl.blitFramebuffer(0, 0, tile.renderWidth, tile.renderHeight, 0, 0, tile.renderWidth, tile.renderHeight,
          gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.resolved);
      gl.readPixels(tile.readX, tile.readY, tile.width, tile.height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
      if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error('The GPU could not finish this image export. Try a smaller size.');
    };
    for (const tile of tiles) {
      if (matte) {
        renderInto(tile, black, MATTE_BLACK); renderInto(tile, pixels, MATTE_WHITE);
        solveMatte(black, pixels, pixels, tile.width * tile.height);
      } else renderInto(tile, pixels);
      // Reuse both CPU buffers across every tile instead of depending on GC
      // to release one allocation per tile during a large synchronous export.
      image ??= context.createImageData(bufferWidth, bufferHeight);
      const stride = tile.width * 4, imageStride = bufferWidth * 4;
      for (let row = 0; row < tile.height; row++) image.data.set(pixels.subarray((tile.height - row - 1) * stride,
        (tile.height - row) * stride), row * imageStride);
      context.putImageData(image, tile.x, height - tile.y - tile.height, 0, 0, tile.width, tile.height);
    }
    return { tiles: tiles.length, samples };
  } finally {
    target?.dispose();
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
    gl.bindRenderbuffer(gl.RENDERBUFFER, saved.renderbuffer);
    gl.viewport(...saved.viewport); gl.scissor(...saved.scissorBox);
    if (saved.scissor) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
  }
}
