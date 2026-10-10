/** Codec strings, level tables and container configuration records for the
 * codecs WebCodecs encoders produce: H.264 (AVC), VP8, VP9 and AV1. */

// Every format stores 4:2:0 color, so frames have even dimensions. H.264
// requires that; for VP8, VP9 and AV1 the browser's converter otherwise
// resamples each odd-sized frame, which blurs it visibly.
export const MOVIE_FORMATS = Object.freeze([
  { id: 'mp4-h264', container: 'mp4', codec: 'avc', label: 'MP4 · H.264', extension: 'mp4', mimeType: 'video/mp4', evenDimensions: true,
    note: 'Plays almost everywhere, including presentation software.' },
  { id: 'webm-vp9', container: 'webm', codec: 'vp9', label: 'WebM · VP9', extension: 'webm', mimeType: 'video/webm', evenDimensions: true,
    note: 'Smaller files; plays in browsers and VLC.' },
  { id: 'webm-vp8', container: 'webm', codec: 'vp8', label: 'WebM · VP8', extension: 'webm', mimeType: 'video/webm', evenDimensions: true,
    note: 'Widely supported WebM; larger files than VP9.' },
  { id: 'mp4-av1', container: 'mp4', codec: 'av1', label: 'MP4 · AV1', extension: 'mp4', mimeType: 'video/mp4', evenDimensions: true,
    note: 'Smallest files; needs a recent player and encodes slowly.' },
  { id: 'webm-av1', container: 'webm', codec: 'av1', label: 'WebM · AV1', extension: 'webm', mimeType: 'video/webm', evenDimensions: true,
    note: 'Smallest files; needs a recent player and encodes slowly.' },
  { id: 'mp4-vp9', container: 'mp4', codec: 'vp9', label: 'MP4 · VP9', extension: 'mp4', mimeType: 'video/mp4', evenDimensions: true,
    note: 'VP9 in an MP4 file; plays in browsers.' },
].map(Object.freeze));

export function movieFormat(id) { return MOVIE_FORMATS.find(format => format.id === id) ?? null; }

const hex2 = value => value.toString(16).padStart(2, '0');

// H.264 Table A-1: level, MaxMBPS (macroblocks/s), MaxFS (macroblocks), MaxBR (kbit/s, Baseline/Main).
const AVC_LEVELS = [[30, 40500, 1620, 10000], [31, 108000, 3600, 14000], [32, 216000, 5120, 20000], [40, 245760, 8192, 20000],
  [41, 245760, 8192, 50000], [42, 522240, 8704, 50000], [50, 589824, 22080, 135000], [51, 983040, 36864, 240000],
  [52, 2073600, 36864, 240000], [60, 4177920, 139264, 240000], [61, 8355840, 139264, 480000], [62, 16711680, 139264, 800000]];

/** The lowest H.264 level that holds this picture size, rate and bitrate. */
export function avcLevel(width, height, fps, bitrate = 0) {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = AVC_LEVELS.find(([, rate, size, kilobits]) => macroblocks <= size && macroblocks * fps <= rate && bitrate <= kilobits * 1000);
  return level ? level[0] : null;
}

// VP9 levels: level × 10, maximum luma picture size, maximum luma sample rate.
const VP9_LEVELS = [[10, 36864, 829440], [11, 73728, 2764800], [20, 122880, 4608000], [21, 245760, 9216000], [30, 552960, 20736000],
  [31, 983040, 36864000], [40, 2228224, 83558400], [41, 2228224, 160432128], [50, 8912896, 311951360], [51, 8912896, 588251136],
  [52, 8912896, 1176502272], [60, 35651584, 1176502272], [61, 35651584, 2353004544], [62, 35651584, 4706009088]];

export function vp9Level(width, height, fps) {
  const level = VP9_LEVELS.find(([, size, rate]) => width * height <= size && width * height * fps <= rate);
  return level ? level[0] : null;
}

// AV1 Annex A: seq_level_idx, MaxPicSize, MaxHSize, MaxVSize, MaxDisplayRate.
const AV1_LEVELS = [[0, 147456, 2048, 1152, 4423680], [1, 278784, 2816, 1584, 8363520], [4, 665856, 4352, 2448, 19975680],
  [5, 1065024, 5504, 3096, 31950720], [8, 2359296, 6144, 3456, 70778880], [9, 2359296, 6144, 3456, 141557760],
  [12, 8912896, 8192, 4352, 267386880], [13, 8912896, 8192, 4352, 534773760], [14, 8912896, 8192, 4352, 1069547520],
  [16, 35651584, 16384, 8704, 1069547520], [17, 35651584, 16384, 8704, 2139095040], [18, 35651584, 16384, 8704, 4278190080]];

export function av1Level(width, height, fps) {
  const level = AV1_LEVELS.find(([, size, maxWidth, maxHeight, rate]) => width * height <= size && width <= maxWidth && height <= maxHeight && width * height * fps <= rate);
  return level ? level[0] : null;
}

/** WebCodecs codec strings to try, most capable first. */
export function codecCandidates(codec, { width, height, fps, bitrate = 0 }) {
  if (codec === 'vp8') return ['vp8'];
  if (codec === 'vp9') { const level = vp9Level(width, height, fps); return level === null ? [] : [`vp09.00.${level}.08`]; }
  if (codec === 'av1') { const level = av1Level(width, height, fps); return level === null ? [] : [`av01.0.${String(level).padStart(2, '0')}M.08`]; }
  if (codec === 'avc') {
    // High (bitrate limit × 1.25), Main, then Constrained Baseline.
    const high = avcLevel(width, height, fps, bitrate / 1.25), main = avcLevel(width, height, fps, bitrate);
    return [...(high === null ? [] : [`avc1.6400${hex2(high)}`]), ...(main === null ? [] : [`avc1.4d00${hex2(main)}`, `avc1.42e0${hex2(main)}`])];
  }
  return [];
}

const PRIMARIES = new Map([['bt709', 1], ['bt470bg', 5], ['smpte170m', 6], ['bt2020', 9], ['smpte432', 12]]);
const TRANSFER = new Map([['bt709', 1], ['smpte170m', 6], ['linear', 8], ['iec61966-2-1', 13], ['pq', 16], ['hlg', 18]]);
const MATRIX = new Map([['rgb', 0], ['bt709', 1], ['bt470bg', 5], ['smpte170m', 6], ['bt2020-ncl', 9]]);

/** ISO/IEC 23091-2 code points of a WebCodecs VideoColorSpace, or null when
 * the encoder did not describe its output completely. */
export function colorCodePoints(colorSpace) {
  if (!colorSpace) return null;
  const primaries = PRIMARIES.get(colorSpace.primaries), transfer = TRANSFER.get(colorSpace.transfer), matrix = MATRIX.get(colorSpace.matrix);
  if (primaries === undefined || transfer === undefined || matrix === undefined || typeof colorSpace.fullRange !== 'boolean') return null;
  return { primaries, transfer, matrix, fullRange: colorSpace.fullRange };
}

/** vpcC payload (after the FullBox header) for 8-bit 4:2:0 VP9. */
export function vp9ConfigurationRecord(codecString, color = null) {
  const match = /^vp09\.(\d\d)\.(\d\d)\.(\d\d)/.exec(codecString ?? '');
  const profile = match ? Number(match[1]) : 0, level = match ? Number(match[2]) : 10, bitDepth = match ? Number(match[3]) : 8;
  // chromaSubsampling 1: 4:2:0 colocated with luma (0, 0).
  return Uint8Array.of(profile, level, (bitDepth << 4) | (1 << 1) | (color?.fullRange ? 1 : 0),
    color?.primaries ?? 2, color?.transfer ?? 2, color?.matrix ?? 2, 0, 0);
}

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.position = 0; }
  bit() {
    const byte = this.bytes[this.position >> 3];
    if (byte === undefined) throw new RangeError('AV1 header is truncated.');
    return (byte >> (7 - (this.position++ & 7))) & 1;
  }
  bits(count) { let value = 0; for (let index = 0; index < count; index++) value = value * 2 + this.bit(); return value; }
  uvlc() {
    let zeros = 0;
    while (!this.bit()) { if (++zeros > 32) throw new RangeError('Invalid AV1 uvlc value.'); }
    return zeros >= 32 ? 0xffffffff : this.bits(zeros) + 2 ** zeros - 1;
  }
}

/** Find the first sequence header OBU of an AV1 temporal unit and read the
 * fields its configuration record repeats. Returns null if there is none. */
export function parseAv1SequenceHeader(bytes) {
  try {
    for (let offset = 0; offset < bytes.length;) {
      const header = bytes[offset], type = (header >> 3) & 15, extension = (header >> 2) & 1, hasSize = (header >> 1) & 1;
      let cursor = offset + 1 + extension, size = bytes.length - cursor;
      if (hasSize) {
        size = 0;
        for (let index = 0; index < 8; index++) {
          const byte = bytes[cursor++];
          if (byte === undefined) return null;
          size += (byte & 0x7f) * 2 ** (7 * index);
          if (!(byte & 0x80)) break;
        }
      }
      if (cursor + size > bytes.length) return null;
      if (type === 1) return { ...readSequenceHeader(bytes.subarray(cursor, cursor + size)), obu: hasSize ? bytes.slice(offset, cursor + size) : null };
      offset = cursor + size;
    }
  } catch { /* A header this parser cannot read falls back to the codec string. */ }
  return null;
}

function readSequenceHeader(payload) {
  const reader = new BitReader(payload);
  const profile = reader.bits(3);
  reader.bit(); // still_picture
  const reduced = reader.bit();
  let level, tier = 0;
  if (reduced) level = reader.bits(5);
  else {
    let decoderModel = 0, delayLength = 0;
    if (reader.bit()) { // timing_info_present_flag
      reader.bits(32); reader.bits(32);
      if (reader.bit()) reader.uvlc(); // equal_picture_interval, num_ticks_per_picture_minus_1
      decoderModel = reader.bit();
      if (decoderModel) { delayLength = reader.bits(5) + 1; reader.bits(32); reader.bits(5); reader.bits(5); }
    }
    const displayDelay = reader.bit(), points = reader.bits(5) + 1;
    for (let index = 0; index < points; index++) {
      reader.bits(12); // operating_point_idc
      const pointLevel = reader.bits(5), pointTier = pointLevel > 7 ? reader.bit() : 0;
      if (decoderModel && reader.bit()) { reader.bits(delayLength); reader.bits(delayLength); reader.bit(); }
      if (displayDelay && reader.bit()) reader.bits(4);
      if (index === 0) { level = pointLevel; tier = pointTier; }
    }
  }
  const widthBits = reader.bits(4) + 1, heightBits = reader.bits(4) + 1;
  const width = reader.bits(widthBits) + 1, height = reader.bits(heightBits) + 1;
  if (!reduced && reader.bit()) { reader.bits(4); reader.bits(3); } // frame ids
  reader.bits(3); // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
  if (!reduced) {
    reader.bits(4); // interintra, masked compound, warped motion, dual filter
    const orderHint = reader.bit();
    if (orderHint) reader.bits(2);
    const screenContent = reader.bit() ? 2 : reader.bit();
    if (screenContent > 0 && !reader.bit()) reader.bit(); // seq_choose_integer_mv, seq_force_integer_mv
    if (orderHint) reader.bits(3);
  }
  reader.bits(3); // superres, cdef, restoration
  const highBitDepth = reader.bit(), twelveBit = profile === 2 && highBitDepth ? reader.bit() : 0;
  const bitDepth = twelveBit ? 12 : highBitDepth ? 10 : 8;
  const monochrome = profile === 1 ? 0 : reader.bit();
  let primaries = 2, transfer = 2, matrix = 2;
  if (reader.bit()) { primaries = reader.bits(8); transfer = reader.bits(8); matrix = reader.bits(8); }
  let subsamplingX = 1, subsamplingY = 1, samplePosition = 0;
  if (monochrome) reader.bit();
  else if (primaries === 1 && transfer === 13 && matrix === 0) { subsamplingX = 0; subsamplingY = 0; }
  else {
    reader.bit(); // color_range
    if (profile === 1) { subsamplingX = 0; subsamplingY = 0; }
    else if (profile === 2) {
      if (bitDepth === 12) { subsamplingX = reader.bit(); subsamplingY = subsamplingX ? reader.bit() : 0; }
      else subsamplingY = 0;
    }
    if (subsamplingX && subsamplingY) samplePosition = reader.bits(2);
  }
  return { profile, level, tier, width, height, bitDepth, highBitDepth, twelveBit, monochrome, subsamplingX, subsamplingY, samplePosition };
}

/** av1C payload: four fixed bytes, then the sequence header OBU when the
 * first keyframe carries one. Falls back to the codec string. */
export function av1ConfigurationRecord(codecString, firstKeyframe = null) {
  const parsed = firstKeyframe ? parseAv1SequenceHeader(firstKeyframe) : null;
  const match = /^av01\.(\d)\.(\d\d)([MH])\.(\d\d)/.exec(codecString ?? '');
  const fields = parsed ?? { profile: match ? Number(match[1]) : 0, level: match ? Number(match[2]) : 0, tier: match?.[3] === 'H' ? 1 : 0,
    highBitDepth: match && Number(match[4]) > 8 ? 1 : 0, twelveBit: match && Number(match[4]) === 12 ? 1 : 0,
    monochrome: 0, subsamplingX: 1, subsamplingY: 1, samplePosition: 0 };
  const head = Uint8Array.of(0x81, (fields.profile << 5) | (fields.level & 31),
    (fields.tier << 7) | (fields.highBitDepth << 6) | (fields.twelveBit << 5) | (fields.monochrome << 4)
      | (fields.subsamplingX << 3) | (fields.subsamplingY << 2) | (fields.samplePosition & 3), 0);
  if (!parsed?.obu) return head;
  const record = new Uint8Array(4 + parsed.obu.length);
  record.set(head); record.set(parsed.obu, 4);
  return record;
}

/** A complete VideoEncoder configuration for one codec string. */
export function encoderConfig(format, codecString, { width, height, fps, bitrate }) {
  return { codec: codecString, width, height, bitrate: Math.round(bitrate), framerate: fps, latencyMode: 'quality',
    ...(format.codec === 'avc' ? { avc: { format: 'avc' } } : {}) };
}

/**
 * Ask the browser which formats it can encode at this size, rate and
 * bitrate. Returns one entry per format in MOVIE_FORMATS order with the
 * first supported configuration, or supported: false and a reason.
 */
export async function probeMovieFormats({ width, height, fps, bitrate, formats = MOVIE_FORMATS, VideoEncoderClass = globalThis.VideoEncoder } = {}) {
  const results = [];
  for (const format of formats) {
    let entry = { format, supported: false, config: null, reason: 'This browser has no video encoder.' };
    if (typeof VideoEncoderClass?.isConfigSupported === 'function') {
      const evenWidth = format.evenDimensions ? width - width % 2 : width, evenHeight = format.evenDimensions ? height - height % 2 : height;
      const candidates = evenWidth >= 2 && evenHeight >= 2 ? codecCandidates(format.codec, { width: evenWidth, height: evenHeight, fps, bitrate }) : [];
      entry.reason = candidates.length ? 'This browser cannot encode it at this size and rate.' : 'The size or rate is beyond what this codec allows.';
      for (const codecString of candidates) {
        // Variable bitrate suits rendered frames; fall back to the encoder's default mode.
        for (const extra of [{ bitrateMode: 'variable' }, {}]) {
          const config = { ...encoderConfig(format, codecString, { width: evenWidth, height: evenHeight, fps, bitrate }), ...extra };
          let support = null;
          try { support = await VideoEncoderClass.isConfigSupported(config); } catch { support = null; }
          if (support?.supported) { entry = { format, supported: true, config, reason: '' }; break; }
        }
        if (entry.supported) break;
      }
    }
    results.push(entry);
  }
  return results;
}
