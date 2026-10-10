/** Minimal WebM (Matroska/EBML) writer for one constant frame rate video
 * track: VP8, VP9 or AV1.
 *
 * Frames are grouped into Clusters that start at keyframes. A finished
 * Cluster streams into a ByteSink; the header (SeekHead, Info, Tracks, Cues)
 * is written when the movie is finished and placed before the Clusters, with
 * every size known. Timestamps are in milliseconds. */
import { ByteSink, asciiBytes, concatBytes } from './byte-sink.js';
import { av1ConfigurationRecord, colorCodePoints } from './codecs.js';

const CODEC_ID = { vp8: 'V_VP8', vp9: 'V_VP9', av1: 'V_AV1' };
export const WEBM_MAX_CLUSTER_BYTES = 8 * 1024 * 1024;
const MAX_BLOCK_OFFSET = 32767;
export const EBML_IDS = Object.freeze({ EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3, DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, MuxingApp: 0x4d80, WritingApp: 0x5741,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, FlagLacing: 0x9c,
  Language: 0x22b59c, CodecID: 0x86, CodecPrivate: 0x63a2, DefaultDuration: 0x23e383,
  Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Colour: 0x55b0, MatrixCoefficients: 0x55b1, Range: 0x55b9,
  TransferCharacteristics: 0x55ba, Primaries: 0x55bb,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3 });
const ID = EBML_IDS;

function idBytes(id) {
  const bytes = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
  return Uint8Array.from(bytes);
}

/** An EBML data size: the shortest form, or exactly `width` bytes. */
export function ebmlSize(value, width = null) {
  let length = width ?? 1;
  if (width === null) while (length < 8 && value >= 2 ** (7 * length) - 1) length++;
  const bytes = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index--) { bytes[index] = rest % 256; rest = Math.floor(rest / 256); }
  bytes[0] |= 1 << (8 - length);
  return bytes;
}

function uintBytes(value, width = null) {
  let length = width ?? 1;
  if (width === null) while (length < 8 && value >= 2 ** (8 * length)) length++;
  const bytes = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index--) { bytes[index] = rest % 256; rest = Math.floor(rest / 256); }
  return bytes;
}

const element = (id, ...children) => {
  const size = children.reduce((sum, child) => sum + child.length, 0);
  return concatBytes([idBytes(id), ebmlSize(size), ...children]);
};
const uint = (id, value, width = null) => element(id, uintBytes(value, width));
const text = (id, value) => element(id, asciiBytes(value));
const float64 = (id, value) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value); return element(id, bytes); };

export class WebmMuxer {
  constructor({ width, height, frameRate, codec, codecString = '', sink = new ByteSink(), maxClusterBytes = WEBM_MAX_CLUSTER_BYTES } = {}) {
    if (!CODEC_ID[codec]) throw new Error(`WebM cannot hold the ${codec} codec.`);
    for (const [name, value] of [['width', width], ['height', height]]) {
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new RangeError(`WebM ${name} must be a whole number from 1 to 65535.`);
    }
    if (!Number.isInteger(frameRate) || frameRate < 1 || frameRate > 1000) throw new RangeError('WebM frame rate must be a whole number from 1 to 1000.');
    Object.assign(this, { width, height, frameRate, codec, codecString, sink, maxClusterBytes });
    this.cluster = null; this.clusters = []; this.frames = 0; this.lastFrame = -1;
    this.description = null; this.colorSpace = null; this.firstKeyframe = null; this.finished = false;
  }

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

  time(frame) { return Math.round(frame * 1000 / this.frameRate); }

  /** Add one encoded frame in decode order. `frame` is its display number. */
  addSample({ data, frame, key = false }, decoderConfig = null) {
    if (this.finished) throw new Error('The WebM file is already finished.');
    if (!(data instanceof Uint8Array) || !data.length) throw new TypeError('WebM samples need encoded bytes.');
    if (!Number.isInteger(frame) || frame < 0) throw new RangeError('WebM samples need a display frame number.');
    this.setDecoderConfig(decoderConfig);
    if (!this.frames && !key) throw new Error('The first video frame must be a keyframe.');
    if (key) this.firstKeyframe ??= data;
    const time = this.time(frame);
    if (this.cluster && (key || Math.abs(time - this.cluster.time) > MAX_BLOCK_OFFSET || this.cluster.bytes + data.length > this.maxClusterBytes)) this.closeCluster();
    this.cluster ??= { time, key, blocks: [], bytes: 0 };
    const offset = time - this.cluster.time;
    const header = concatBytes([idBytes(ID.SimpleBlock), ebmlSize(4 + data.length), Uint8Array.of(0x81, (offset >> 8) & 255, offset & 255, key ? 0x80 : 0)]);
    this.cluster.blocks.push(header, data); this.cluster.bytes += header.length + data.length;
    this.frames++; this.lastFrame = Math.max(this.lastFrame, frame);
  }

  closeCluster() {
    const cluster = this.cluster;
    if (!cluster) return;
    this.cluster = null;
    const timestamp = uint(ID.Timestamp, cluster.time);
    this.clusters.push({ time: cluster.time, key: cluster.key, offset: this.sink.size });
    this.sink.write(concatBytes([idBytes(ID.Cluster), ebmlSize(timestamp.length + cluster.bytes), timestamp]));
    for (const block of cluster.blocks) this.sink.write(block);
  }

  get sampleCount() { return this.frames; }
  get dataSize() { return this.sink.size + (this.cluster?.bytes ?? 0); }

  /** Build the file. Returns its parts (Blobs or Uint8Arrays) and size. */
  finalize() {
    if (this.finished) throw new Error('The WebM file is already finished.');
    if (!this.frames) throw new Error('The movie has no frames.');
    this.closeCluster();
    this.finished = true;
    const color = this.colorSpace;
    const codecPrivate = this.codec === 'av1' ? (this.description?.length ? this.description : av1ConfigurationRecord(this.codecString, this.firstKeyframe)) : null;
    const durationFrames = this.lastFrame + 1;
    const info = element(ID.Info, uint(ID.TimestampScale, 1_000_000), text(ID.MuxingApp, 'AlloyView'), text(ID.WritingApp, 'AlloyView'),
      float64(ID.Duration, durationFrames * 1000 / this.frameRate));
    const tracks = element(ID.Tracks, element(ID.TrackEntry,
      uint(ID.TrackNumber, 1), uint(ID.TrackUID, 1), uint(ID.TrackType, 1), uint(ID.FlagLacing, 0), text(ID.Language, 'und'),
      text(ID.CodecID, CODEC_ID[this.codec]), uint(ID.DefaultDuration, Math.round(1e9 / this.frameRate)),
      ...(codecPrivate ? [element(ID.CodecPrivate, codecPrivate)] : []),
      element(ID.Video, uint(ID.PixelWidth, this.width), uint(ID.PixelHeight, this.height),
        ...(color ? [element(ID.Colour, uint(ID.MatrixCoefficients, color.matrix), uint(ID.Range, color.fullRange ? 2 : 1),
          uint(ID.TransferCharacteristics, color.transfer), uint(ID.Primaries, color.primaries))] : []))));
    // Positions are relative to the start of the Segment data and use a fixed
    // width, so the header size is known before the positions are.
    const cued = this.clusters.filter(cluster => cluster.key);
    const cues = base => element(ID.Cues, ...cued.map(cluster => element(ID.CuePoint, uint(ID.CueTime, cluster.time),
      element(ID.CueTrackPositions, uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, base + cluster.offset, 8)))));
    const seekHead = positions => element(ID.SeekHead, ...[[ID.Info, positions.info], [ID.Tracks, positions.tracks], [ID.Cues, positions.cues]]
      .map(([id, position]) => element(ID.Seek, element(ID.SeekID, idBytes(id)), uint(ID.SeekPosition, position, 8))));
    const seekLength = seekHead({ info: 0, tracks: 0, cues: 0 }).length, cuesLength = cues(0).length;
    const positions = { info: seekLength, tracks: seekLength + info.length, cues: seekLength + info.length + tracks.length };
    const headerLength = positions.cues + cuesLength;
    const fileHeader = element(ID.EBML, uint(ID.EBMLVersion, 1), uint(ID.EBMLReadVersion, 1), uint(ID.EBMLMaxIDLength, 4), uint(ID.EBMLMaxSizeLength, 8),
      text(ID.DocType, 'webm'), uint(ID.DocTypeVersion, 4), uint(ID.DocTypeReadVersion, 2));
    const header = concatBytes([fileHeader, idBytes(ID.Segment), ebmlSize(headerLength + this.sink.size, 8),
      seekHead(positions), info, tracks, cues(headerLength)]);
    return { parts: [header, ...this.sink.finish()], size: header.length + this.sink.size, mimeType: 'video/webm',
      frames: this.frames, durationSeconds: durationFrames / this.frameRate };
  }
}
