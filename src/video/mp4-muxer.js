/** Minimal MP4 (ISO base media file format) writer for one constant frame
 * rate video track: H.264 (avc1), VP9 (vp09) or AV1 (av01).
 *
 * The file is ftyp, moov, mdat. Encoded samples stream into a ByteSink; the
 * index (moov) is written when the movie is finished and placed before the
 * sample data, so players can start without reading to the end. Samples are
 * added in decode order with their presentation frame number; a composition
 * offset table (ctts) is written only if an encoder reorders frames. */
import { ByteSink, asciiBytes, concatBytes } from './byte-sink.js';
import { av1ConfigurationRecord, colorCodePoints, vp9ConfigurationRecord } from './codecs.js';

export const MP4_TICKS_PER_FRAME = 512;
const MOVIE_TIMESCALE = 1000;
const SAMPLE_ENTRY = { avc: 'avc1', vp9: 'vp09', av1: 'av01' };
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

const u8 = (...values) => Uint8Array.from(values);
const u16 = value => u8(value >>> 8, value & 255);
const u32 = value => u8((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
const i32 = value => u32(value >>> 0);
const u64 = value => concatBytes([u32(Math.floor(value / 2 ** 32)), u32(value % 2 ** 32)]);
const zeros = count => new Uint8Array(count);

export function mp4Box(type, ...children) {
  const size = 8 + children.reduce((sum, child) => sum + child.length, 0);
  return concatBytes([u32(size), asciiBytes(type), ...children]);
}
const fullBox = (type, version, flags, ...children) => mp4Box(type, u8(version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255), ...children);

function u32Table(values) {
  const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0));
  return bytes;
}

export class Mp4Muxer {
  constructor({ width, height, frameRate, codec, codecString = '', sink = new ByteSink() } = {}) {
    if (!SAMPLE_ENTRY[codec]) throw new Error(`MP4 cannot hold the ${codec} codec.`);
    for (const [name, value] of [['width', width], ['height', height]]) {
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new RangeError(`MP4 ${name} must be a whole number from 1 to 65535.`);
    }
    if (!Number.isInteger(frameRate) || frameRate < 1 || frameRate > 1000) throw new RangeError('MP4 frame rate must be a whole number from 1 to 1000.');
    Object.assign(this, { width, height, frameRate, codec, codecString, sink });
    this.timescale = frameRate * MP4_TICKS_PER_FRAME;
    this.sizes = []; this.presentation = []; this.keyframes = [];
    this.description = null; this.colorSpace = null; this.firstKeyframe = null; this.finished = false;
  }

  /** Remember the decoder configuration that arrives with the first chunk. */
  setDecoderConfig(config) {
    if (!config) return;
    if (config.description && !this.description) {
      const source = config.description;
      this.description = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength))
        : new Uint8Array(source.slice(0));
    }
    if (config.codec && !this.codecString) this.codecString = config.codec;
    if (config.colorSpace && !this.colorSpace) this.colorSpace = colorCodePoints(config.colorSpace);
  }

  /** Add one encoded frame in decode order. `frame` is its display number. */
  addSample({ data, frame, key = false }, decoderConfig = null) {
    if (this.finished) throw new Error('The MP4 file is already finished.');
    if (!(data instanceof Uint8Array) || !data.length) throw new TypeError('MP4 samples need encoded bytes.');
    if (!Number.isInteger(frame) || frame < 0) throw new RangeError('MP4 samples need a display frame number.');
    this.setDecoderConfig(decoderConfig);
    if (!this.sizes.length && !key) throw new Error('The first video frame must be a keyframe.');
    if (key) { this.keyframes.push(this.sizes.length + 1); this.firstKeyframe ??= data; }
    this.sizes.push(data.length); this.presentation.push(frame);
    this.sink.write(data);
  }

  get sampleCount() { return this.sizes.length; }
  get dataSize() { return this.sink.size; }

  codecConfigurationBox() {
    if (this.codec === 'avc') {
      if (!this.description?.length) throw new Error('The H.264 encoder did not provide its configuration record.');
      return mp4Box('avcC', this.description);
    }
    if (this.codec === 'vp9') return fullBox('vpcC', 1, 0, vp9ConfigurationRecord(this.codecString, this.colorSpace));
    return mp4Box('av1C', this.description?.length ? this.description : av1ConfigurationRecord(this.codecString, this.firstKeyframe));
  }

  sampleEntry() {
    const color = this.colorSpace;
    const name = asciiBytes('AlloyView'), compressor = zeros(32);
    compressor[0] = name.length; compressor.set(name, 1);
    return mp4Box(SAMPLE_ENTRY[this.codec],
      zeros(6), u16(1), // reserved, data reference index
      zeros(16), // pre_defined, reserved, pre_defined[3]
      u16(this.width), u16(this.height), u32(0x00480000), u32(0x00480000), // 72 dpi
      u32(0), u16(1), compressor, u16(0x0018), u16(0xffff),
      this.codecConfigurationBox(),
      ...(color ? [mp4Box('colr', asciiBytes('nclx'), u16(color.primaries), u16(color.transfer), u16(color.matrix), u8(color.fullRange ? 0x80 : 0))] : []),
      mp4Box('pasp', u32(1), u32(1)));
  }

  /** Build the file. Returns its parts (Blobs or Uint8Arrays) and size. */
  finalize() {
    if (this.finished) throw new Error('The MP4 file is already finished.');
    const count = this.sizes.length;
    if (!count) throw new Error('The movie has no frames.');
    this.finished = true;
    const ticks = MP4_TICKS_PER_FRAME, mediaDuration = count * ticks;
    const movieDuration = Math.round(count * MOVIE_TIMESCALE / this.frameRate);
    // Decode times are evenly spaced in arrival order; a frame shown later or
    // earlier than its decode slot gets a signed composition offset.
    const offsets = this.presentation.map((frame, index) => (frame - index) * ticks);
    const reordered = offsets.some(offset => offset !== 0);
    const compositionRuns = [];
    for (const offset of offsets) {
      const last = compositionRuns.at(-1);
      if (last && last[1] === offset) last[0]++; else compositionRuns.push([1, offset]);
    }
    // About half a second of samples per chunk.
    const perChunk = Math.max(1, Math.round(this.frameRate / 2)), chunkCount = Math.ceil(count / perChunk);
    const lastChunkSamples = count - (chunkCount - 1) * perChunk;
    const sampleToChunk = chunkCount > 1 && lastChunkSamples !== perChunk
      ? [[1, perChunk, 1], [chunkCount, lastChunkSamples, 1]] : [[1, chunkCount === 1 ? count : perChunk, 1]];
    const chunkOffsets = [];
    for (let sample = 0, offset = 0; sample < count; sample++) {
      if (sample % perChunk === 0) chunkOffsets.push(offset);
      offset += this.sizes[sample];
    }
    let large = false; // 64-bit chunk offsets and data size, only past 4 GiB
    const sampleTable = dataStart => mp4Box('stbl',
      fullBox('stsd', 0, 0, u32(1), this.sampleEntry()),
      fullBox('stts', 0, 0, u32(1), u32(count), u32(ticks)),
      ...(this.keyframes.length === count ? [] : [fullBox('stss', 0, 0, u32(this.keyframes.length), u32Table(this.keyframes))]),
      ...(reordered ? [fullBox('ctts', 1, 0, u32(compositionRuns.length), concatBytes(compositionRuns.map(([run, offset]) => concatBytes([u32(run), i32(offset)]))))] : []),
      fullBox('stsc', 0, 0, u32(sampleToChunk.length), u32Table(sampleToChunk.flat())),
      fullBox('stsz', 0, 0, u32(0), u32(count), u32Table(this.sizes)),
      large ? fullBox('co64', 0, 0, u32(chunkCount), concatBytes(chunkOffsets.map(offset => u64(dataStart + offset))))
        : fullBox('stco', 0, 0, u32(chunkCount), u32Table(chunkOffsets.map(offset => dataStart + offset))));
    const movie = dataStart => mp4Box('moov',
      fullBox('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(movieDuration), u32(0x00010000), u16(0x0100), zeros(10),
        u32Table(MATRIX), zeros(24), u32(2)),
      mp4Box('trak',
        fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDuration), zeros(8), u16(0), u16(0), u16(0), u16(0),
          u32Table(MATRIX), u32(this.width * 0x10000), u32(this.height * 0x10000)),
        mp4Box('mdia',
          fullBox('mdhd', 0, 0, u32(0), u32(0), u32(this.timescale), u32(mediaDuration), u16(0x55c4), u16(0)), // language "und"
          fullBox('hdlr', 0, 0, u32(0), asciiBytes('vide'), zeros(12), asciiBytes('AlloyView video\0')),
          mp4Box('minf',
            fullBox('vmhd', 0, 1, zeros(8)),
            mp4Box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            sampleTable(dataStart)))));
    const brands = this.codec === 'avc' ? ['isom', 'iso2', 'avc1', 'mp41'] : this.codec === 'av1' ? ['isom', 'iso2', 'av01', 'mp41'] : ['isom', 'iso2', 'mp41'];
    const fileType = mp4Box('ftyp', asciiBytes('isom'), u32(0x200), ...brands.map(asciiBytes));
    const dataHeader = () => large ? concatBytes([u32(1), asciiBytes('mdat'), u64(this.sink.size + 16)]) : concatBytes([u32(this.sink.size + 8), asciiBytes('mdat')]);
    // The index size does not depend on the offsets it stores, so measure it first.
    const measure = () => fileType.length + movie(0).length + dataHeader().length;
    let dataStart = measure();
    if (dataStart + this.sink.size > 0xffffffff) { large = true; dataStart = measure(); }
    const header = concatBytes([fileType, movie(dataStart), dataHeader()]);
    return { parts: [header, ...this.sink.finish()], size: header.length + this.sink.size, mimeType: 'video/mp4',
      frames: count, durationSeconds: count / this.frameRate };
  }
}
