/** Text label templates. A template is literal text with placeholders:
 *
 *   [Name]          the attribute's value with default formatting
 *   [Name:spec]     a numeric format, printf or Python style: %.1f, .3e, +.2%, ,d
 *   [[ and ]]       literal [ and ]
 *
 * Names may contain balanced [digits] suffixes (Mean.c_stress[1]). Templates
 * are tokenized into text and field parts; values come from a lookup
 * function, so no user text is ever evaluated as code. Unknown or
 * unavailable names render as [?Name] and are reported, as are invalid
 * formats and unclosed placeholders. */

export const MAX_TEXT_LABELS = 16;
export const MAX_LABEL_TEMPLATE_LENGTH = 1000;
export const MAX_LABEL_PLACEHOLDERS = 64;
export const MAX_LABEL_OUTPUT_LENGTH = 4000;
const MAX_PLACEHOLDER_LENGTH = 300;
const MAX_FORMAT_WIDTH = 40;
const MAX_FORMAT_PRECISION = 20;
export const LABEL_POSITIONS = Object.freeze(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']);
export const LABEL_BOXES = Object.freeze(['theme', 'custom', 'none']);
export const LABEL_FONT_SIZE_RANGE = Object.freeze([6, 144]);
export const LABEL_OFFSET_LIMIT = 4096;
export const DEFAULT_LABEL_TEMPLATE = 'Frame [Frame] / [FrameCount]';
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const FORMAT = /^%?([+ 0,]*)(\d{1,2})?(?:\.(\d{1,2}))?([fFeEgGdi%])?$/;

/** { sign, zero, group, width, precision, type } or null for an invalid spec. */
export function parseFormatSpec(spec) {
  if (typeof spec !== 'string' || spec.length > 16) return null;
  const match = FORMAT.exec(spec);
  if (!match) return null;
  const [, flags, width, precision, type = 'g'] = match;
  if (new Set(flags).size !== flags.length) return null;
  const format = { sign: flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '', zero: flags.includes('0'), group: flags.includes(','),
    width: width === undefined ? 0 : Number(width), precision: precision === undefined ? null : Number(precision), type: type === 'i' ? 'd' : type };
  if (format.width > MAX_FORMAT_WIDTH || (format.precision ?? 0) > MAX_FORMAT_PRECISION) return null;
  return format;
}

/** Split a template into text and field parts. Problems carry 1-based columns. */
export function parseLabelTemplate(text) {
  const parts = [], problems = [];
  if (typeof text !== 'string') return { parts, problems: [{ message: 'The label text is not a string.', column: 1 }] };
  const source = text.length > MAX_LABEL_TEMPLATE_LENGTH ? text.slice(0, MAX_LABEL_TEMPLATE_LENGTH) : text;
  if (source !== text) problems.push({ message: `Labels are limited to ${MAX_LABEL_TEMPLATE_LENGTH.toLocaleString('en-US')} characters; the rest is ignored.`, column: MAX_LABEL_TEMPLATE_LENGTH + 1 });
  let literal = '', fields = 0;
  const flush = () => { if (literal) parts.push({ type: 'text', value: literal }); literal = ''; };
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if ((character === '[' || character === ']') && source[index + 1] === character) { literal += character; index += 2; continue; }
    if (character !== '[') { literal += character; index++; continue; }
    // Find the matching bracket; nested [digits] belong to the name.
    let depth = 0, end = -1;
    for (let cursor = index; cursor < source.length && cursor - index <= MAX_PLACEHOLDER_LENGTH; cursor++) {
      const next = source[cursor];
      if (next === '\n') break;
      if (next === '[') depth++;
      else if (next === ']' && --depth === 0) { end = cursor; break; }
    }
    if (end < 0) {
      problems.push({ message: 'Unclosed “[” is shown as text. Write [[ for a literal bracket.', column: index + 1 });
      literal += character; index++; continue;
    }
    const content = source.slice(index + 1, end), raw = source.slice(index, end + 1);
    index = end + 1;
    if (++fields > MAX_LABEL_PLACEHOLDERS) {
      if (fields === MAX_LABEL_PLACEHOLDERS + 1) problems.push({ message: `Labels support up to ${MAX_LABEL_PLACEHOLDERS} placeholders; later ones are shown as text.`, column: index - raw.length + 1 });
      literal += raw; continue;
    }
    const colon = topLevelColon(content);
    const name = (colon < 0 ? content : content.slice(0, colon)).trim();
    const spec = colon < 0 ? null : content.slice(colon + 1).trim();
    flush();
    const field = { type: 'field', name, spec, format: null, raw, column: index - raw.length + 1 };
    if (!name) problems.push({ message: 'Empty placeholder [] has no attribute name.', column: field.column });
    if (spec !== null) {
      field.format = parseFormatSpec(spec);
      if (!field.format) problems.push({ message: `Invalid number format “${spec}” for ${name || 'a placeholder'}. Use for example %.3f, .2e, .1% or d.`, column: field.column });
    }
    parts.push(field);
  }
  flush();
  return { parts, problems };
}

function topLevelColon(content) {
  let depth = 0;
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '[') depth++;
    else if (content[index] === ']') depth--;
    else if (content[index] === ':' && depth === 0) return index;
  }
  return -1;
}

function group(digits) { return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function exponential(value, digits, upper) {
  const [mantissa, exponent] = value.toExponential(digits).split('e');
  const sign = exponent.startsWith('-') ? '-' : '+', magnitude = exponent.replace(/^[+-]/, '').padStart(2, '0');
  return `${mantissa}${upper ? 'E' : 'e'}${sign}${magnitude}`;
}

/** printf %g: P significant digits, fixed notation for −4 ≤ exponent < P,
 * trailing zeros removed. */
function general(value, precision, upper) {
  const digits = precision === 0 ? 1 : precision;
  if (value === 0) return '0';
  const exponent = Number(value.toExponential(digits - 1).split('e')[1]);
  const text = exponent < -4 || exponent >= digits ? exponential(value, digits - 1, upper) : value.toFixed(Math.max(0, digits - 1 - exponent));
  return text.includes('e') || text.includes('E') ? text.replace(/\.?0+(?=[eE])/, '') : text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** Default formatting: integers in full, other numbers to six significant
 * digits; non-finite values keep the CSV spellings NaN, Infinity, -Infinity. */
export function formatAttributeValue(value, format = null) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value.slice(0, 256);
  if (typeof value !== 'number') return String(value ?? '');
  if (!Number.isFinite(value)) return String(value);
  if (!format) return Number.isInteger(value) ? String(value) : general(value, 6, false);
  const { type, precision } = format, magnitude = Math.abs(value);
  let body;
  if (type === 'd') body = String(Math.round(magnitude));
  else if (type === 'f' || type === 'F') body = magnitude.toFixed(precision ?? 6);
  else if (type === 'e' || type === 'E') body = exponential(magnitude, precision ?? 6, type === 'E');
  else if (type === '%') body = (magnitude * 100).toFixed(precision ?? 6);
  else body = general(magnitude, precision ?? 6, type === 'G');
  if (format.group) body = body.replace(/^\d+/, group);
  // As in printf, -0.0001 with %.2f is -0.00; an integer rounded to 0 has no sign.
  const sign = value < 0 && !(type === 'd' && body === '0') ? '-' : format.sign;
  const suffix = type === '%' ? '%' : '';
  let text = `${sign}${body}${suffix}`;
  if (text.length < format.width) {
    text = format.zero ? `${sign}${body.padStart(format.width - sign.length - suffix.length, '0')}${suffix}` : text.padStart(format.width, ' ');
  }
  return text;
}

/** Resolve a parsed template. lookup(name) returns { value } or null. */
export function renderLabelTemplate(parsed, lookup) {
  let text = '';
  const missing = [], invalid = [];
  for (const part of parsed.parts) {
    if (part.type === 'text') { text += part.value; continue; }
    const entry = part.name && !FORBIDDEN_KEYS.has(part.name) ? lookup(part.name) : null;
    if (!entry || (part.spec !== null && !part.format)) {
      if (!entry && part.name && !missing.includes(part.name)) missing.push(part.name);
      if (entry && !invalid.includes(part.raw)) invalid.push(part.raw);
      text += `[?${part.raw.slice(1)}`;
    } else text += formatAttributeValue(entry.value, part.format);
    if (text.length > MAX_LABEL_OUTPUT_LENGTH) { text = text.slice(0, MAX_LABEL_OUTPUT_LENGTH); break; }
  }
  return { text, missing, invalid, problems: parsed.problems };
}

export function placeholderNames(text) {
  return [...new Set(parseLabelTemplate(text).parts.filter(part => part.type === 'field' && part.name).map(part => part.name))];
}

export function createTextLabel({ id = 'label-1', enabled = true, text = DEFAULT_LABEL_TEMPLATE, position = 'top-right', offset = [0, 0],
  fontSize = 16, color = null, box = 'theme', boxColor = '#ffffff' } = {}) {
  return { id, enabled, text, position, offset: [...offset], fontSize, color, box, boxColor };
}

/** Validate shared label settings before they are copied into the UI. */
export function normalizeTextLabelState(value, { path = 'settings.extensions.textLabels' } = {}) {
  const input = plainRecord(value ?? {}, path, ['labels', 'selectedId']);
  const labels = input.labels ?? [];
  if (!Array.isArray(labels) || labels.length > MAX_TEXT_LABELS) fail(`${path}.labels`, `must contain 0–${MAX_TEXT_LABELS} entries`);
  const normalized = [];
  for (let index = 0; index < labels.length; index++) {
    const entryPath = `${path}.labels[${index}]`;
    const entry = plainRecord(labels[index], entryPath, ['id', 'enabled', 'text', 'position', 'offset', 'fontSize', 'color', 'box', 'boxColor']);
    const id = entry.id ?? `label-${index + 1}`;
    if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || FORBIDDEN_KEYS.has(id)) fail(`${entryPath}.id`, 'must be a short identifier');
    const text = entry.text ?? '';
    if (typeof text !== 'string' || text.length > MAX_LABEL_TEMPLATE_LENGTH || /[\x00-\x09\x0b-\x1f\x7f]/.test(text)) {
      fail(`${entryPath}.text`, `must be text of at most ${MAX_LABEL_TEMPLATE_LENGTH} characters; only line breaks are allowed as control characters`);
    }
    const offset = entry.offset ?? [0, 0];
    if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(item => Number.isFinite(item) && Math.abs(item) <= LABEL_OFFSET_LIMIT)) {
      fail(`${entryPath}.offset`, `must be two numbers from −${LABEL_OFFSET_LIMIT} to ${LABEL_OFFSET_LIMIT} pixels`);
    }
    const fontSize = entry.fontSize ?? 16;
    if (!Number.isFinite(fontSize) || fontSize < LABEL_FONT_SIZE_RANGE[0] || fontSize > LABEL_FONT_SIZE_RANGE[1]) {
      fail(`${entryPath}.fontSize`, `must be from ${LABEL_FONT_SIZE_RANGE[0]} to ${LABEL_FONT_SIZE_RANGE[1]} pixels`);
    }
    const enabled = entry.enabled ?? true;
    if (typeof enabled !== 'boolean') fail(`${entryPath}.enabled`, 'must be true or false');
    const position = entry.position ?? 'top-right';
    if (!LABEL_POSITIONS.includes(position)) fail(`${entryPath}.position`, 'is unsupported');
    const box = entry.box ?? 'theme';
    if (!LABEL_BOXES.includes(box)) fail(`${entryPath}.box`, 'is unsupported');
    normalized.push(createTextLabel({ id, enabled, text, position, offset: [Number(offset[0]), Number(offset[1])], fontSize,
      color: entry.color === undefined || entry.color === null ? null : hexColor(entry.color, `${entryPath}.color`),
      box, boxColor: hexColor(entry.boxColor ?? '#ffffff', `${entryPath}.boxColor`) }));
  }
  if (new Set(normalized.map(label => label.id)).size !== normalized.length) fail(`${path}.labels`, 'contains duplicate IDs');
  const selectedId = input.selectedId ?? normalized[0]?.id ?? null;
  if (selectedId !== null && !normalized.some(label => label.id === selectedId)) fail(`${path}.selectedId`, 'must identify a saved label');
  return { labels: normalized, selectedId };
}

function hexColor(value, path) {
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) fail(path, 'must be a six-digit hex color');
  return value.toLowerCase();
}

function plainRecord(value, path, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be an object');
  for (const key of Object.keys(value)) if (FORBIDDEN_KEYS.has(key) || !keys.includes(key)) fail(`${path}.${key}`, 'is not a supported setting');
  return value;
}

function fail(path, message) { throw new Error(`Invalid AlloyView configuration: ${path} ${message}.`); }
