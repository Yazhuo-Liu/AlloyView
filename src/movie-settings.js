/** Movie output settings: formats, limits, quality presets and their
 * validation for configurations. Pure data and arithmetic. */
import { normalizeCameraPathState } from './camera-path.js';
import { MOVIE_FORMATS, movieFormat } from './video/codecs.js';
import { resolveExportSize } from './render/export-resolution.js';

export { MOVIE_FORMATS };
export const PNG_SEQUENCE_FORMAT = Object.freeze({ id: 'png-zip', container: 'zip', codec: 'png', label: 'PNG frames · ZIP', extension: 'zip',
  mimeType: 'application/zip', evenDimensions: false, note: 'Lossless images to assemble in another program; at most 500 frames and 256 MiB.' });
export const MOVIE_LIMITS = Object.freeze({
  maxFrames: 20_000,
  maxArchiveFrames: 500,
  fps: Object.freeze([1, 120]),
  keyframeSeconds: Object.freeze([0.1, 10]),
  bitrateMbps: Object.freeze([0.1, 400]),
  maxEncodeQueue: 2,
  warnBytes: 1024 ** 3,
  maxBytes: 2 * 1024 ** 3,
});
export const MOVIE_QUALITIES = Object.freeze([
  { id: 'low', label: 'Low', bitsPerPixel: 0.05 },
  { id: 'medium', label: 'Medium', bitsPerPixel: 0.1 },
  { id: 'high', label: 'High', bitsPerPixel: 0.2 },
  { id: 'best', label: 'Very high', bitsPerPixel: 0.4 },
  { id: 'custom', label: 'Custom bitrate', bitsPerPixel: null },
].map(Object.freeze));
export const DEFAULT_MOVIE_OUTPUT = Object.freeze({ format: 'auto', fps: 30, quality: 'high', bitrateMbps: 12, keyframeSeconds: 2 });
// VP9 and AV1 need fewer bits than H.264 and VP8 for the same picture.
const CODEC_EFFICIENCY = { avc: 1, vp8: 1, vp9: 0.7, av1: 0.6 };
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Target bitrate in bits per second for a quality preset or a custom value. */
export function movieBitrate(output, width, height, codec = 'avc') {
  const [minimum, maximum] = MOVIE_LIMITS.bitrateMbps;
  const quality = MOVIE_QUALITIES.find(item => item.id === output.quality) ?? MOVIE_QUALITIES[2];
  const megabits = quality.bitsPerPixel === null ? output.bitrateMbps
    : width * height * output.fps * quality.bitsPerPixel * (CODEC_EFFICIENCY[codec] ?? 1) / 1e6;
  return Math.round(Math.min(maximum, Math.max(minimum, megabits)) * 1e6);
}

/**
 * The image size of a movie and the resolution option that renders it.
 * Video formats need even dimensions; an odd size is rendered one pixel
 * narrower or shorter instead of cropping or scaling a finished image.
 */
export function movieRenderSize(resolution, canvasWidth, canvasHeight, format) {
  const size = resolveExportSize(resolution ?? { mode: 'current' }, canvasWidth, canvasHeight);
  const mode = resolution?.mode ?? 'current';
  if (!format?.evenDimensions || (size.width % 2 === 0 && size.height % 2 === 0)) return { width: size.width, height: size.height, resolution: resolution ?? { mode }, adjusted: false };
  const width = size.width - size.width % 2, height = size.height - size.height % 2;
  if (width < 2 || height < 2) throw new Error('This format needs an image of at least 2 × 2 pixels.');
  return { width, height, resolution: { mode: 'custom', width, height, lockAspect: false }, adjusted: true };
}

export function estimateMovieBytes(bitrate, seconds) { return Math.round(bitrate * seconds / 8); }

function fail(path, message) { throw new Error(`Invalid AlloyView configuration: ${path} ${message}.`); }

/** Validate shared movie output settings. */
export function normalizeMovieOutput(value, { path = 'settings.extensions.movie.output' } = {}) {
  const input = value ?? {};
  if (typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(path, 'must be an object');
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(DEFAULT_MOVIE_OUTPUT, key)) fail(`${path}.${key}`, 'is not a supported setting');
  }
  const number = (key, [minimum, maximum], integer = false) => {
    const item = input[key] ?? DEFAULT_MOVIE_OUTPUT[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < minimum || item > maximum || (integer && !Number.isInteger(item))) {
      fail(`${path}.${key}`, `must be a finite ${integer ? 'integer' : 'number'} from ${minimum} to ${maximum}`);
    }
    return item;
  };
  const format = input.format ?? DEFAULT_MOVIE_OUTPUT.format;
  if (format !== 'auto' && format !== PNG_SEQUENCE_FORMAT.id && !movieFormat(format)) fail(`${path}.format`, 'is unsupported');
  const quality = input.quality ?? DEFAULT_MOVIE_OUTPUT.quality;
  if (!MOVIE_QUALITIES.some(item => item.id === quality)) fail(`${path}.quality`, 'is unsupported');
  return { format, fps: number('fps', MOVIE_LIMITS.fps, true), quality, bitrateMbps: number('bitrateMbps', MOVIE_LIMITS.bitrateMbps),
    keyframeSeconds: number('keyframeSeconds', MOVIE_LIMITS.keyframeSeconds) };
}

/** Validate the movie extension of a configuration: camera path and output. */
export function normalizeMovieState(value, { path = 'settings.extensions.movie' } = {}) {
  const input = value ?? {};
  if (typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(path, 'must be an object');
  for (const key of Object.keys(input)) if (FORBIDDEN_KEYS.has(key) || !['path', 'output'].includes(key)) fail(`${path}.${key}`, 'is not a supported setting');
  return { path: normalizeCameraPathState(input.path, { path: `${path}.path` }), output: normalizeMovieOutput(input.output, { path: `${path}.output` }) };
}
