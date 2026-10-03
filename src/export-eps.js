/** A raster EPS screenshot, matching the native viewer's image export role.
 * Yield between scanline groups so large screenshots keep Cancel/UI responsive. */
export async function imageToEps({ width, height, data }, { signal } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width * height > 16_000_000 || data?.length !== width * height * 4) throw new Error('Invalid or oversized EPS image.');
  const header = `%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 ${width} ${height}\n%%Creator: AlloyView\n%%LanguageLevel: 2\n%%EndComments\n/picstr ${width * 3} string def\n${width} ${height} scale\n${width} ${height} 8\n[${width} 0 0 -${height} 0 ${height}]\n{currentfile picstr readhexstring pop} false 3 colorimage\n`;
  const lookup = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));
  const parts = [header];
  for (let row = 0; row < height; row++) {
    if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
    let line = '';
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * 4, alpha = data[offset + 3] / 255;
      for (let axis = 0; axis < 3; axis++) line += lookup[Math.round(data[offset + axis] * alpha + 255 * (1 - alpha))];
      if (line.length >= 120) { parts.push(`${line}\n`); line = ''; }
    }
    if (line) parts.push(`${line}\n`);
    if (row % 32 === 31) await new Promise(resolve => setTimeout(resolve, 0));
  }
  parts.push('showpage\n%%EOF\n');
  return new Blob(parts, { type: 'application/postscript' });
}
