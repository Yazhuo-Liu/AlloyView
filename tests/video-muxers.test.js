import assert from 'node:assert/strict';
import test from 'node:test';
import { ByteSink, concatBytes } from '../src/video/byte-sink.js';
import { av1ConfigurationRecord, av1Level, avcLevel, codecCandidates, colorCodePoints, encoderConfig, MOVIE_FORMATS, movieFormat,
  parseAv1SequenceHeader, probeMovieFormats, vp9ConfigurationRecord, vp9Level } from '../src/video/codecs.js';
import { Mp4Muxer, MP4_TICKS_PER_FRAME } from '../src/video/mp4-muxer.js';
import { ebmlSize, WebmMuxer } from '../src/video/webm-muxer.js';
import { findBox, parseEbml, parseMp4Boxes, readMp4, readWebm } from './helpers/video-containers.js';

const AVCC = Uint8Array.of(1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28, 0x01, 0x00, 0x02, 0x68, 0xee);
const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
/** Frame i is `size(i)` bytes of the value i + 1, so every byte range is checkable. */
const sample = (index, size = 20 + index) => new Uint8Array(size).fill((index % 250) + 1);
async function bytesOf(file) { return new Uint8Array(await new Blob(file.parts).arrayBuffer()); }
function addFrames(muxer, count, { keyEvery = 10, config = null, size } = {}) {
  for (let index = 0; index < count; index++) muxer.addSample({ data: sample(index, size?.(index)), frame: index, key: index % keyEvery === 0 }, index === 0 ? config : null);
}

/** Minimal bit writer for building an AV1 sequence header in tests. */
function bitWriter() {
  const bits = [];
  return { write(value, count) { for (let index = count - 1; index >= 0; index--) bits.push(Math.floor(value / 2 ** index) % 2); return this; },
    bytes() { while (bits.length % 8) bits.push(0); return Uint8Array.from({ length: bits.length / 8 }, (_, index) => bits.slice(index * 8, index * 8 + 8).reduce((byte, bit) => byte * 2 + bit, 0)); } };
}
function av1SequenceHeader({ profile = 0, level = 8, tier = 0, width = 1920, height = 1080, timing = false, highBitDepth = 0, colorDescription = null } = {}) {
  const writer = bitWriter().write(profile, 3).write(0, 1).write(0, 1); // seq_profile, still_picture, reduced_still_picture_header
  writer.write(timing ? 1 : 0, 1);
  if (timing) writer.write(1, 32).write(30, 32).write(1, 1).write(1, 1) /* equal interval, uvlc(0) = "1" */ .write(0, 1); // no decoder model
  writer.write(0, 1).write(0, 5).write(0, 12).write(level, 5); // display delay flag, one operating point, idc, level
  if (level > 7) writer.write(tier, 1);
  writer.write(15, 4).write(15, 4).write(width - 1, 16).write(height - 1, 16);
  writer.write(0, 1) // frame ids
    .write(0, 1).write(1, 1).write(1, 1) // 128 superblock, filter intra, intra edge
    .write(1, 1).write(1, 1).write(1, 1).write(1, 1).write(1, 1).write(1, 1).write(1, 1) // compound tools, order hint, jnt comp, ref mvs
    .write(1, 1) // seq_choose_screen_content_tools
    .write(1, 1) // seq_choose_integer_mv
    .write(6, 3) // order_hint_bits_minus_1
    .write(0, 1).write(1, 1).write(1, 1) // superres, cdef, restoration
    .write(highBitDepth, 1).write(0, 1); // high_bitdepth, mono_chrome
  if (colorDescription) writer.write(1, 1).write(colorDescription[0], 8).write(colorDescription[1], 8).write(colorDescription[2], 8);
  else writer.write(0, 1);
  writer.write(0, 1).write(0, 2).write(0, 1).write(0, 1); // color_range, chroma_sample_position, separate_uv_delta_q, film grain
  const payload = writer.bytes();
  return concatBytes([Uint8Array.of(0x0a, payload.length), payload]); // OBU_SEQUENCE_HEADER with a size field
}
const temporalUnit = header => concatBytes([Uint8Array.of(0x12, 0x00), header, Uint8Array.of(0x32, 0x03, 1, 2, 3)]); // delimiter, header, frame

test('the byte sink keeps write order and folds chunks into Blobs past its threshold', async () => {
  const sink = new ByteSink({ threshold: 100 });
  const written = [];
  for (let index = 0; index < 30; index++) { const bytes = sample(index, 17); written.push(bytes); sink.write(bytes); }
  sink.write(new Uint8Array(0));
  assert.equal(sink.size, 30 * 17);
  assert.ok(sink.flushes >= 4 && sink.pendingBytes < 100, 'chunks leave the pending list');
  const parts = sink.finish();
  assert.ok(parts.every(part => part instanceof Blob));
  assert.deepEqual(new Uint8Array(await new Blob(parts).arrayBuffer()), concatBytes(written));
  assert.throws(() => sink.write([1, 2, 3]), TypeError);
  const plain = new ByteSink({ BlobClass: null }); plain.write(Uint8Array.of(1)); plain.write(Uint8Array.of(2));
  assert.deepEqual(concatBytes(plain.finish()), Uint8Array.of(1, 2));
});

test('MP4: box tree, timing, sample table and byte ranges of an H.264 movie', async () => {
  const muxer = new Mp4Muxer({ width: 1920, height: 1080, frameRate: 30, codec: 'avc', codecString: 'avc1.640028' });
  addFrames(muxer, 61, { keyEvery: 30, config: { codec: 'avc1.640028', description: AVCC.buffer, colorSpace: BT709 } });
  assert.equal(muxer.sampleCount, 61);
  const file = muxer.finalize(), bytes = await bytesOf(file);
  assert.deepEqual([file.size, file.mimeType, file.frames, file.durationSeconds], [bytes.length, 'video/mp4', 61, 61 / 30]);
  const movie = readMp4(bytes);
  assert.deepEqual(movie.order, ['ftyp', 'moov', 'mdat'], 'index before the data');
  assert.deepEqual(movie.brands, ['isom', 'isom', 'iso2', 'avc1', 'mp41']);
  assert.deepEqual([movie.movieTimescale, movie.movieDuration, movie.trackDuration], [1000, 2033, 2033]);
  assert.deepEqual([movie.timescale, movie.mediaDuration], [30 * MP4_TICKS_PER_FRAME, 61 * MP4_TICKS_PER_FRAME]);
  assert.deepEqual([movie.handler, movie.entry, movie.width, movie.height, movie.trackWidth, movie.trackHeight, movie.depth], ['vide', 'avc1', 1920, 1080, 1920, 1080, 24]);
  assert.deepEqual([movie.configuration.type, [...movie.configuration.bytes]], ['avcC', [...AVCC]]);
  assert.deepEqual(movie.color, { type: 'nclx', primaries: 1, transfer: 1, matrix: 1, fullRange: false });
  assert.equal(movie.frames.length, 61);
  assert.deepEqual(movie.frames.filter(frame => frame.key).map(frame => frame.time / MP4_TICKS_PER_FRAME), [0, 30, 60]);
  assert.equal(movie.hasComposition, false);
  assert.equal(movie.chunkCount, Math.ceil(61 / 15), 'half-second chunks');
  // Every sample's byte range holds exactly that frame's bytes, inside mdat.
  for (const [index, frame] of movie.frames.entries()) {
    assert.deepEqual([frame.time, frame.duration, frame.size], [index * MP4_TICKS_PER_FRAME, MP4_TICKS_PER_FRAME, 20 + index]);
    assert.ok(frame.offset >= movie.data.start && frame.offset + frame.size <= movie.data.start + movie.data.size);
    assert.ok(bytes.subarray(frame.offset, frame.offset + frame.size).every(value => value === index + 1), `frame ${index} bytes`);
  }
  assert.equal(movie.data.start, movie.movieEnd + 8); assert.equal(movie.data.start + movie.data.size, bytes.length);
  // Required boxes of a self-contained video track are all present.
  const boxes = parseMp4Boxes(bytes);
  for (const route of [['moov', 'mvhd'], ['moov', 'trak', 'tkhd'], ['moov', 'trak', 'mdia', 'mdhd'], ['moov', 'trak', 'mdia', 'hdlr'],
    ['moov', 'trak', 'mdia', 'minf', 'vmhd'], ['moov', 'trak', 'mdia', 'minf', 'dinf', 'dref', 'url '],
    ...['stsd', 'stts', 'stss', 'stsc', 'stsz', 'stco'].map(name => ['moov', 'trak', 'mdia', 'minf', 'stbl', name])]) assert.ok(findBox(boxes, ...route), route.join('/'));
  assert.ok(findBox(boxes, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd').children[0].children.some(box => box.type === 'pasp'));
});

test('MP4: all-keyframe, single-chunk, reordered, VP9 and AV1 variants', async () => {
  // Every frame a keyframe: no sync table. Fewer frames than one chunk.
  const intra = new Mp4Muxer({ width: 64, height: 48, frameRate: 24, codec: 'avc' });
  addFrames(intra, 5, { keyEvery: 1, config: { description: AVCC } });
  const intraMovie = readMp4(await bytesOf(intra.finalize()));
  assert.deepEqual([intraMovie.hasSync, intraMovie.chunkCount, intraMovie.frames.length, intraMovie.color], [false, 1, 5, null]);
  assert.ok(intraMovie.frames.every(frame => frame.key));
  // An encoder that reorders frames: decode order 0 3 1 2 keeps display times.
  const reordered = new Mp4Muxer({ width: 64, height: 48, frameRate: 25, codec: 'avc' });
  [0, 3, 1, 2, 4].forEach((frame, index) => reordered.addSample({ data: sample(frame), frame, key: index === 0 }, { description: AVCC }));
  const reorderedBytes = await bytesOf(reordered.finalize()), reorderedMovie = readMp4(reorderedBytes);
  assert.equal(reorderedMovie.hasComposition, true);
  assert.deepEqual(reorderedMovie.frames.map(frame => frame.time / MP4_TICKS_PER_FRAME), [0, 3, 1, 2, 4]);
  assert.deepEqual(reorderedMovie.frames.map(frame => frame.decodeTime / MP4_TICKS_PER_FRAME), [0, 1, 2, 3, 4]);
  assert.deepEqual(reorderedMovie.frames.map(frame => reorderedBytes[frame.offset]), [1, 4, 2, 3, 5]);
  // VP9 carries a vpcC record built from the codec string and color space.
  const vp9 = new Mp4Muxer({ width: 640, height: 360, frameRate: 60, codec: 'vp9' });
  addFrames(vp9, 3, { config: { codec: 'vp09.00.31.08', colorSpace: { ...BT709, fullRange: true } } });
  const vp9Movie = readMp4(await bytesOf(vp9.finalize()));
  assert.deepEqual([vp9Movie.entry, vp9Movie.configuration.type, [...vp9Movie.configuration.bytes], vp9Movie.brands.includes('avc1')],
    ['vp09', 'vpcC', [1, 0, 0, 0, 0, 31, 0x83, 1, 1, 1, 0, 0], false]);
  // AV1 builds av1C from the sequence header of the first keyframe.
  const header = av1SequenceHeader({ level: 8, width: 1920, height: 1080 }), av1 = new Mp4Muxer({ width: 1920, height: 1080, frameRate: 30, codec: 'av1', codecString: 'av01.0.04M.08' });
  av1.addSample({ data: temporalUnit(header), frame: 0, key: true });
  av1.addSample({ data: sample(1), frame: 1, key: false });
  const av1Movie = readMp4(await bytesOf(av1.finalize()));
  assert.deepEqual([av1Movie.entry, av1Movie.configuration.type, av1Movie.brands.includes('av01')], ['av01', 'av1C', true]);
  assert.deepEqual([...av1Movie.configuration.bytes], [0x81, 8, 0x0c, 0, ...header], 'level and header come from the bitstream, not the codec string');
});

test('MP4: invalid use is refused', () => {
  assert.throws(() => new Mp4Muxer({ width: 64, height: 48, frameRate: 30, codec: 'vp8' }), /cannot hold the vp8 codec/);
  assert.throws(() => new Mp4Muxer({ width: 0, height: 48, frameRate: 30, codec: 'avc' }), RangeError);
  assert.throws(() => new Mp4Muxer({ width: 64, height: 48, frameRate: 29.97, codec: 'avc' }), RangeError);
  const muxer = new Mp4Muxer({ width: 64, height: 48, frameRate: 30, codec: 'avc' });
  assert.throws(() => muxer.finalize(), /no frames/);
  assert.throws(() => muxer.addSample({ data: sample(0), frame: 0, key: false }), /first video frame must be a keyframe/);
  assert.throws(() => muxer.addSample({ data: [1], frame: 0, key: true }), TypeError);
  assert.throws(() => muxer.addSample({ data: sample(0), frame: -1, key: true }), RangeError);
  muxer.addSample({ data: sample(0), frame: 0, key: true });
  assert.throws(() => muxer.finalize(), /did not provide its configuration record/);
  const done = new Mp4Muxer({ width: 64, height: 48, frameRate: 30, codec: 'vp9' });
  done.addSample({ data: sample(0), frame: 0, key: true }); done.finalize();
  assert.throws(() => done.addSample({ data: sample(1), frame: 1 }), /already finished/); assert.throws(() => done.finalize(), /already finished/);
});

test('WebM: EBML tree, cues, clusters and byte ranges of a VP9 movie', async () => {
  const muxer = new WebmMuxer({ width: 1280, height: 720, frameRate: 30, codec: 'vp9' });
  addFrames(muxer, 75, { keyEvery: 30, config: { codec: 'vp09.00.31.08', colorSpace: BT709 } });
  const file = muxer.finalize(), bytes = await bytesOf(file), movie = readWebm(bytes);
  assert.deepEqual([file.size, file.mimeType, file.frames, file.durationSeconds], [bytes.length, 'video/webm', 75, 2.5]);
  assert.deepEqual([movie.docType, movie.docTypeVersion, movie.timestampScale, movie.duration], ['webm', 4, 1_000_000, 2500]);
  assert.deepEqual([movie.codecId, movie.trackType, movie.width, movie.height, movie.defaultDuration, movie.codecPrivate], ['V_VP9', 1, 1280, 720, 33333333, null]);
  assert.deepEqual(movie.color, { matrix: 1, range: 1, transfer: 1, primaries: 1 });
  // SeekHead, Info, Tracks and Cues precede the Clusters; the SeekHead finds them.
  assert.deepEqual(movie.order.slice(0, 4), [0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1c53bb6b]);
  assert.ok(movie.order.slice(4).every(id => id === 0x1f43b675));
  for (const seek of movie.seeks) assert.equal(movie.positions[seek.id], seek.position, `seek ${seek.id.toString(16)}`);
  assert.deepEqual(movie.seeks.map(seek => seek.id), [0x1549a966, 0x1654ae6b, 0x1c53bb6b]);
  // One Cluster per keyframe, each found by its cue.
  assert.deepEqual(movie.clusters.map(cluster => cluster.time), [0, 1000, 2000]);
  assert.deepEqual(movie.cues, movie.clusters.map(cluster => ({ time: cluster.time, track: 1, position: cluster.position })));
  assert.equal(movie.segmentEnd, bytes.length, 'the Segment size is exact');
  assert.equal(movie.frames.length, 75);
  for (const [index, frame] of movie.frames.entries()) {
    assert.deepEqual([frame.time, frame.key, frame.size, frame.cluster], [Math.round(index * 1000 / 30), index % 30 === 0, 20 + index, Math.floor(index / 30)]);
    assert.ok(bytes.subarray(frame.offset, frame.offset + frame.size).every(value => value === index + 1), `frame ${index} bytes`);
  }
});

test('WebM: cluster limits, AV1 private data, VP8 and reordered frames', async () => {
  // Without further keyframes a Cluster is closed before its 16-bit time offset or size overflows.
  const long = new WebmMuxer({ width: 64, height: 48, frameRate: 1, codec: 'vp8' });
  addFrames(long, 70, { keyEvery: 1000 });
  const longMovie = readWebm(await bytesOf(long.finalize()));
  assert.deepEqual([longMovie.codecId, longMovie.color, longMovie.clusters.map(cluster => cluster.time)], ['V_VP8', null, [0, 33000, 66000]]);
  assert.deepEqual(longMovie.cues.map(cue => cue.time), [0], 'only Clusters that start with a keyframe are cued');
  assert.deepEqual(longMovie.frames.map(frame => frame.time), Array.from({ length: 70 }, (_, index) => index * 1000));
  const sized = new WebmMuxer({ width: 64, height: 48, frameRate: 30, codec: 'vp8', maxClusterBytes: 1000 });
  addFrames(sized, 20, { keyEvery: 1000, size: () => 300 });
  const sizedMovie = readWebm(await bytesOf(sized.finalize()));
  assert.ok(sizedMovie.clusters.length >= 6 && sizedMovie.frames.length === 20 && sizedMovie.frames.every((frame, index) => frame.time === Math.round(index * 1000 / 30)));
  // AV1 stores the configuration record as CodecPrivate.
  const header = av1SequenceHeader({ level: 13, tier: 1, width: 3840, height: 2160 }), av1 = new WebmMuxer({ width: 3840, height: 2160, frameRate: 60, codec: 'av1', codecString: 'av01.0.00M.08' });
  av1.addSample({ data: temporalUnit(header), frame: 0, key: true });
  const av1Movie = readWebm(await bytesOf(av1.finalize()));
  assert.deepEqual([av1Movie.codecId, [...av1Movie.codecPrivate]], ['V_AV1', [0x81, 13, 0x8c, 0, ...header]]);
  // Reordered frames keep their display times; offsets inside a Cluster may be negative.
  const reordered = new WebmMuxer({ width: 64, height: 48, frameRate: 25, codec: 'vp9' });
  [0, 3, 1, 2].forEach((frame, index) => reordered.addSample({ data: sample(frame), frame, key: index === 0 }));
  const reorderedFile = reordered.finalize(), reorderedMovie = readWebm(await bytesOf(reorderedFile));
  assert.deepEqual(reorderedMovie.frames.map(frame => frame.time), [0, 120, 40, 80]); assert.equal(reorderedMovie.duration, 160);
  assert.throws(() => new WebmMuxer({ width: 64, height: 48, frameRate: 30, codec: 'avc' }), /cannot hold the avc codec/);
  const empty = new WebmMuxer({ width: 64, height: 48, frameRate: 30, codec: 'vp9' });
  assert.throws(() => empty.finalize(), /no frames/);
  assert.throws(() => empty.addSample({ data: sample(0), frame: 0, key: false }), /first video frame must be a keyframe/);
  assert.throws(() => reordered.addSample({ data: sample(9), frame: 9, key: true }), /already finished/);
});

test('EBML sizes use the shortest form and reserve the all-ones value', () => {
  assert.deepEqual([...ebmlSize(0)], [0x80]); assert.deepEqual([...ebmlSize(126)], [0xfe]);
  assert.deepEqual([...ebmlSize(127)], [0x40, 0x7f], '0xFF would mean an unknown size');
  assert.deepEqual([...ebmlSize(16382)], [0x7f, 0xfe]); assert.deepEqual([...ebmlSize(16383)], [0x20, 0x3f, 0xff]);
  assert.deepEqual([...ebmlSize(5, 8)], [1, 0, 0, 0, 0, 0, 0, 5]);
  const [element] = parseEbml(Uint8Array.of(0xa3, ...ebmlSize(300), ...new Uint8Array(300)));
  assert.deepEqual([element.id, element.size], [0xa3, 300]);
});

test('AV1 sequence headers are read for the configuration record', () => {
  const plain = parseAv1SequenceHeader(temporalUnit(av1SequenceHeader({ level: 5, width: 641, height: 481 })));
  assert.deepEqual({ ...plain, obu: undefined }, { profile: 0, level: 5, tier: 0, width: 641, height: 481, bitDepth: 8, highBitDepth: 0, twelveBit: 0,
    monochrome: 0, subsamplingX: 1, subsamplingY: 1, samplePosition: 0, obu: undefined });
  assert.equal(plain.obu[0], 0x0a);
  // Timing information and a color description shift every later field.
  const detailed = parseAv1SequenceHeader(av1SequenceHeader({ level: 12, tier: 1, width: 3840, height: 2160, timing: true, highBitDepth: 1, colorDescription: [9, 16, 9] }));
  assert.deepEqual([detailed.level, detailed.tier, detailed.width, detailed.height, detailed.bitDepth, detailed.highBitDepth], [12, 1, 3840, 2160, 10, 1]);
  assert.deepEqual([...av1ConfigurationRecord('av01.0.00M.08', av1SequenceHeader({ level: 12, tier: 1, highBitDepth: 1 })).subarray(0, 4)], [0x81, 12, 0xcc, 0]);
  // No header, garbage or truncated data: fall back to the codec string.
  for (const bytes of [new Uint8Array(0), Uint8Array.of(0x12, 0x00), Uint8Array.of(0x0a, 0x05, 0x00), Uint8Array.of(0x0a, 0x0b, 0, 0), Uint8Array.of(0x0a, 0xff, 0xff, 0xff)]) {
    assert.equal(parseAv1SequenceHeader(bytes), null);
    assert.deepEqual([...av1ConfigurationRecord('av01.0.09H.10', bytes)], [0x81, 9, 0xcc, 0]);
  }
  assert.deepEqual([...av1ConfigurationRecord('av01.0.04M.08')], [0x81, 4, 0x0c, 0]);
  assert.deepEqual([...av1ConfigurationRecord('')], [0x81, 0, 0x0c, 0]);
});

test('codec strings follow the level tables and color spaces map to code points', () => {
  assert.deepEqual([avcLevel(640, 480, 30), avcLevel(1280, 720, 30), avcLevel(1920, 1080, 30), avcLevel(1920, 1080, 60), avcLevel(3840, 2160, 30), avcLevel(3840, 2160, 60), avcLevel(7680, 4320, 30), avcLevel(16384, 8704, 30)],
    [30, 31, 40, 42, 51, 52, 60, null]);
  assert.equal(avcLevel(1920, 1080, 30, 30e6), 41, 'a high bitrate needs a higher level');
  assert.deepEqual([vp9Level(640, 480, 30), vp9Level(1920, 1080, 30), vp9Level(3840, 2160, 60), vp9Level(16384, 16384, 30)], [30, 40, 51, null]);
  assert.deepEqual([av1Level(640, 360, 30), av1Level(1920, 1080, 30), av1Level(1920, 1080, 60), av1Level(3840, 2160, 60), av1Level(7680, 4320, 30), av1Level(20000, 100, 30)], [1, 8, 9, 13, 16, null]);
  assert.deepEqual(codecCandidates('avc', { width: 1920, height: 1080, fps: 30, bitrate: 12e6 }), ['avc1.640028', 'avc1.4d0028', 'avc1.42e028']);
  assert.deepEqual(codecCandidates('avc', { width: 3840, height: 2160, fps: 30, bitrate: 40e6 }), ['avc1.640033', 'avc1.4d0033', 'avc1.42e033']);
  assert.deepEqual(codecCandidates('avc', { width: 640, height: 480, fps: 30, bitrate: 11e6 }), ['avc1.64001e', 'avc1.4d001f', 'avc1.42e01f']);
  assert.deepEqual(codecCandidates('vp9', { width: 1920, height: 1080, fps: 30 }), ['vp09.00.40.08']);
  assert.deepEqual(codecCandidates('av1', { width: 1920, height: 1080, fps: 30 }), ['av01.0.08M.08']);
  assert.deepEqual(codecCandidates('av1', { width: 640, height: 360, fps: 30 }), ['av01.0.01M.08']);
  assert.deepEqual(codecCandidates('vp8', { width: 99, height: 99, fps: 30 }), ['vp8']);
  assert.deepEqual([codecCandidates('avc', { width: 16384, height: 16384, fps: 30 }), codecCandidates('hevc', { width: 64, height: 64, fps: 30 })], [[], []]);
  assert.deepEqual(colorCodePoints({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'smpte170m', fullRange: true }), { primaries: 1, transfer: 13, matrix: 6, fullRange: true });
  for (const value of [null, undefined, {}, { primaries: 'bt709', transfer: 'bt709', matrix: null, fullRange: false }, { ...BT709, fullRange: null }, { ...BT709, primaries: 'constructor' }]) assert.equal(colorCodePoints(value), null);
  assert.deepEqual([...vp9ConfigurationRecord('vp09.02.51.10')], [2, 51, 0xa2, 2, 2, 2, 0, 0]);
  assert.deepEqual(MOVIE_FORMATS.map(format => format.id), ['mp4-h264', 'webm-vp9', 'webm-vp8', 'mp4-av1', 'webm-av1', 'mp4-vp9']);
  assert.ok(MOVIE_FORMATS.every(format => format.evenDimensions)); assert.equal(movieFormat('toString'), null);
  assert.deepEqual(encoderConfig(movieFormat('mp4-h264'), 'avc1.640028', { width: 1920, height: 1080, fps: 30, bitrate: 12e6 + 0.4 }),
    { codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 12e6, framerate: 30, latencyMode: 'quality', avc: { format: 'avc' } });
});

test('format probing offers only what the encoder reports as supported', async () => {
  const asked = [];
  const encoder = { async isConfigSupported(config) {
    asked.push(config);
    if (config.codec.startsWith('av01')) throw new TypeError('unknown codec');
    return { supported: (config.codec === 'avc1.42e028' && !config.bitrateMode) || (config.codec.startsWith('vp09') && config.bitrateMode === 'variable') };
  } };
  const results = await probeMovieFormats({ width: 1921, height: 1081, fps: 30, bitrate: 8e6, VideoEncoderClass: encoder });
  assert.deepEqual(results.map(result => [result.format.id, result.supported]), [['mp4-h264', true], ['webm-vp9', true], ['webm-vp8', false], ['mp4-av1', false], ['webm-av1', false], ['mp4-vp9', true]]);
  assert.deepEqual(results[0].config, { codec: 'avc1.42e028', width: 1920, height: 1080, bitrate: 8e6, framerate: 30, latencyMode: 'quality', avc: { format: 'avc' } },
    'H.264 gets even dimensions and the first profile the encoder accepts');
  assert.deepEqual([results[1].config.width, results[1].config.height, results[1].config.bitrateMode], [1920, 1080, 'variable'], 'every video format is 4:2:0 with even dimensions');
  assert.match(results[2].reason, /cannot encode it at this size and rate/);
  assert.ok(asked.every(config => config.width > 0 && Number.isInteger(config.bitrate)));
  const none = await probeMovieFormats({ width: 640, height: 480, fps: 30, bitrate: 1e6, VideoEncoderClass: undefined });
  assert.ok(none.every(result => !result.supported && /no video encoder/.test(result.reason)));
  const huge = await probeMovieFormats({ width: 16384, height: 16384, fps: 30, bitrate: 1e6, VideoEncoderClass: encoder, formats: [movieFormat('mp4-h264')] });
  assert.match(huge[0].reason, /beyond what this codec allows/);
});
