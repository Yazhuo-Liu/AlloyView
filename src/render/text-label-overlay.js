/** Layout and drawing of resolved text labels. Image exports draw them on the
 * 2D canvas after the legend and axes; the on-screen DOM overlay uses the
 * same layout at scale 1, so a label keeps its place in both. */

export const TEXT_LABEL_MARGIN = 12;
export const TEXT_LABEL_LINE_HEIGHT = 1.3;
export const TEXT_LABEL_FONT = 'system-ui, sans-serif';
const PADDING_X = 0.5, PADDING_Y = 0.3;
// Without a background, theme text is dark like the legend's: images are
// usually placed on light pages.
const TRANSPARENT_TEXT = '#142f3e';
const FALLBACK_THEME = { panel: 'rgba(9, 22, 31, 0.92)', border: 'rgba(178, 203, 218, 0.25)', title: '#e2e8f0' };

/** Top-left corner of a label box of the given size in a width × height
 * image. Offsets are pixels at screen scale: +x right, +y down. */
export function textLabelOrigin(position, boxWidth, boxHeight, width, height, scale = 1, offset = [0, 0]) {
  const margin = TEXT_LABEL_MARGIN * scale;
  const [vertical, horizontal] = position === 'center' ? ['center', 'center']
    : position.includes('-') ? position.split('-')
      : position === 'left' || position === 'right' ? ['center', position] : [position, 'center'];
  const x = horizontal === 'left' ? margin : horizontal === 'right' ? width - margin - boxWidth : (width - boxWidth) / 2;
  const y = vertical === 'top' ? margin : vertical === 'bottom' ? height - margin - boxHeight : (height - boxHeight) / 2;
  return { x: x + (offset?.[0] ?? 0) * scale, y: y + (offset?.[1] ?? 0) * scale, align: horizontal };
}

/** Colors for one label: theme defaults follow the legend panel, and an
 * export without background omits the theme panel. */
export function textLabelColors(label, { includeBackground = true, theme = FALLBACK_THEME } = {}) {
  const box = label.box === 'custom' ? { fill: label.boxColor, stroke: null }
    : label.box === 'theme' && includeBackground ? { fill: theme.panel, stroke: theme.border } : null;
  const text = label.color ?? (label.box === 'custom' ? contrastingText(label.boxColor) : includeBackground ? theme.title : TRANSPARENT_TEXT);
  return { box, text };
}

/** Near-black or white text, whichever contrasts more with a #rrggbb fill. */
export function contrastingText(hex) {
  const channels = [1, 3, 5].map(offset => Number.parseInt(String(hex).slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return Number.isFinite(luminance) && luminance > 0.179 ? '#0b0b0b' : '#ffffff';
}

export function drawTextLabelsOverlay(context, labels, width, height, scale = 1, options = {}) {
  if (!labels?.length) return;
  context.save();
  context.textBaseline = 'middle';
  for (const label of labels) {
    if (!label?.text) continue;
    const fontSize = label.fontSize * scale, lineHeight = fontSize * TEXT_LABEL_LINE_HEIGHT;
    const paddingX = fontSize * PADDING_X, paddingY = fontSize * PADDING_Y;
    context.font = `600 ${fontSize}px ${TEXT_LABEL_FONT}`;
    const lines = label.text.split('\n');
    const available = Math.max(1, width - 2 * TEXT_LABEL_MARGIN * scale - 2 * paddingX);
    const textWidth = Math.min(available, Math.max(...lines.map(line => context.measureText(line).width)));
    const boxWidth = textWidth + 2 * paddingX, boxHeight = lines.length * lineHeight + 2 * paddingY;
    const { x, y, align } = textLabelOrigin(label.position, boxWidth, boxHeight, width, height, scale, label.offset);
    const colors = textLabelColors(label, options);
    if (colors.box) {
      context.fillStyle = colors.box.fill;
      context.beginPath();
      if (typeof context.roundRect === 'function') context.roundRect(x, y, boxWidth, boxHeight, 6 * scale);
      else context.rect(x, y, boxWidth, boxHeight);
      context.fill();
      if (colors.box.stroke) {
        context.strokeStyle = colors.box.stroke; context.lineWidth = scale;
        context.beginPath();
        if (typeof context.roundRect === 'function') context.roundRect(x + scale / 2, y + scale / 2, boxWidth - scale, boxHeight - scale, 6 * scale);
        else context.rect(x + scale / 2, y + scale / 2, boxWidth - scale, boxHeight - scale);
        context.stroke();
      }
    }
    context.fillStyle = colors.text;
    context.textAlign = align === 'center' ? 'center' : align;
    const textX = align === 'left' ? x + paddingX : align === 'right' ? x + boxWidth - paddingX : x + boxWidth / 2;
    lines.forEach((line, index) => context.fillText(line, textX, y + paddingY + (index + 0.5) * lineHeight, textWidth));
  }
  context.restore();
}
