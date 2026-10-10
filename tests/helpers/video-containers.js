// Independent readers for the two video containers AlloyView writes. They
// follow the published layouts (ISO/IEC 14496-12, Matroska/WebM) and share no
// code with the muxers, so structure tests and the browser demuxer check a
// second implementation rather than the writer against itself.

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl', 'edts']);
const SAMPLE_ENTRIES = new Set(['avc1', 'vp09', 'av01']);

/** Parse boxes in [start, end) into { type, start, size, header, children?, payload }. */
export function parseMp4Boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), boxes = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) throw new Error(`Truncated box header at ${offset}.`);
    let size = view.getUint32(offset), header = 8;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (size === 1) { size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12); header = 16; }
    if (size < header || offset + size > end) throw new Error(`Box ${type} at ${offset} has an invalid size ${size}.`);
    const box = { type, start: offset, size, header, payload: bytes.subarray(offset + header, offset + size) };
    if (CONTAINER_BOXES.has(type)) box.children = parseMp4Boxes(bytes, offset + header, offset + size);
    else if (type === 'stsd' || type === 'dref') box.children = parseMp4Boxes(bytes, offset + header + 8, offset + size);
    else if (SAMPLE_ENTRIES.has(type)) box.children = parseMp4Boxes(bytes, offset + header + 78, offset + size);
    boxes.push(box);
    offset += size;
  }
  return boxes;
}

export function findBox(boxes, ...path) {
  let list = boxes, box = null;
  for (const type of path) {
    box = list?.find(item => item.type === type) ?? null;
    if (!box) return null;
    list = box.children;
  }
  return box;
}

const table = (payload, offset, count, width = 4) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return Array.from({ length: count }, (_, index) => width === 8
    ? view.getUint32(offset + index * 8) * 2 ** 32 + view.getUint32(offset + index * 8 + 4) : view.getUint32(offset + index * 4));
};

/** Read one video track: configuration, timing and a byte range per sample. */
export function readMp4(bytes) {
  const boxes = parseMp4Boxes(bytes);
  const fileType = findBox(boxes, 'ftyp'), movie = findBox(boxes, 'moov'), data = findBox(boxes, 'mdat');
  const view = box => new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
  const header = view(findBox(boxes, 'moov', 'mvhd')), track = view(findBox(boxes, 'moov', 'trak', 'tkhd'));
  const media = view(findBox(boxes, 'moov', 'trak', 'mdia', 'mdhd'));
  const samples = findBox(boxes, 'moov', 'trak', 'mdia', 'minf', 'stbl');
  const entry = findBox(samples.children, 'stsd').children[0], entryView = view(entry);
  const timeToSample = view(findBox(samples.children, 'stts')), sizes = findBox(samples.children, 'stsz');
  const sync = findBox(samples.children, 'stss'), composition = findBox(samples.children, 'ctts');
  const chunkMap = findBox(samples.children, 'stsc'), chunks = findBox(samples.children, 'stco') ?? findBox(samples.children, 'co64');
  const sampleCount = view(sizes).getUint32(8), sampleSizes = table(sizes.payload, 12, sampleCount);
  const durations = [];
  for (let run = 0; run < timeToSample.getUint32(4); run++) {
    for (let index = 0; index < timeToSample.getUint32(8 + run * 8); index++) durations.push(timeToSample.getUint32(12 + run * 8));
  }
  const offsets = [];
  if (composition) {
    const compositionView = view(composition);
    for (let run = 0; run < compositionView.getUint32(4); run++) {
      for (let index = 0; index < compositionView.getUint32(8 + run * 8); index++) offsets.push(compositionView.getInt32(12 + run * 8));
    }
  }
  const chunkOffsets = table(chunks.payload, 8, view(chunks).getUint32(4), chunks.type === 'co64' ? 8 : 4);
  const runs = Array.from({ length: view(chunkMap).getUint32(4) }, (_, index) => table(chunkMap.payload, 8 + index * 12, 3));
  const ranges = [];
  for (let chunk = 0, sample = 0; chunk < chunkOffsets.length; chunk++) {
    const run = runs.findLast(([first]) => first <= chunk + 1);
    let offset = chunkOffsets[chunk];
    for (let index = 0; index < run[1] && sample < sampleCount; index++, sample++) { ranges.push([offset, sampleSizes[sample]]); offset += sampleSizes[sample]; }
  }
  const keyframes = sync ? new Set(table(sync.payload, 8, view(sync).getUint32(4))) : null;
  let decodeTime = 0;
  const frames = ranges.map(([offset, size], index) => {
    const frame = { offset, size, key: keyframes ? keyframes.has(index + 1) : true, decodeTime, time: decodeTime + (offsets[index] ?? 0), duration: durations[index] };
    decodeTime += durations[index];
    return frame;
  });
  const configuration = entry.children.find(box => ['avcC', 'vpcC', 'av1C'].includes(box.type));
  const color = entry.children.find(box => box.type === 'colr');
  return {
    brands: [String.fromCharCode(...fileType.payload.subarray(0, 4)),
      ...Array.from({ length: (fileType.payload.length - 8) / 4 }, (_, index) => String.fromCharCode(...fileType.payload.subarray(8 + index * 4, 12 + index * 4)))],
    order: boxes.map(box => box.type), movieTimescale: header.getUint32(12), movieDuration: header.getUint32(16),
    trackDuration: track.getUint32(20), trackWidth: track.getUint32(76) / 65536, trackHeight: track.getUint32(80) / 65536,
    timescale: media.getUint32(12), mediaDuration: media.getUint32(16),
    handler: String.fromCharCode(...findBox(boxes, 'moov', 'trak', 'mdia', 'hdlr').payload.subarray(8, 12)),
    entry: entry.type, width: entryView.getUint16(24), height: entryView.getUint16(26), depth: entryView.getUint16(74),
    configuration: configuration ? { type: configuration.type, bytes: configuration.payload } : null,
    color: color ? { type: String.fromCharCode(...color.payload.subarray(0, 4)), primaries: view(color).getUint16(4), transfer: view(color).getUint16(6),
      matrix: view(color).getUint16(8), fullRange: Boolean(color.payload[10] & 0x80) } : null,
    frames, hasSync: Boolean(sync), hasComposition: Boolean(composition), chunkCount: chunkOffsets.length,
    data: { start: data.start + data.header, size: data.size - data.header }, movieEnd: movie.start + movie.size,
  };
}

const MASTER = new Set([0x1a45dfa3, 0x18538067, 0x114d9b74, 0x4dbb, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0x55b0, 0x1c53bb6b, 0xbb, 0xb7, 0x1f43b675]);

function readVint(bytes, offset, keepMarker) {
  const first = bytes[offset];
  if (!first) throw new Error(`Invalid EBML variable-length integer at ${offset}.`);
  const length = Math.clz32(first) - 23;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let index = 1; index < length; index++) value = value * 256 + bytes[offset + index];
  return { value, length };
}

/** Parse EBML elements in [start, end) into { id, start, dataStart, size, children? }. */
export function parseEbml(bytes, start = 0, end = bytes.length) {
  const elements = [];
  for (let offset = start; offset < end;) {
    const id = readVint(bytes, offset, true), size = readVint(bytes, offset + id.length, false);
    const dataStart = offset + id.length + size.length;
    if (dataStart + size.value > end) throw new Error(`EBML element ${id.value.toString(16)} at ${offset} overruns its parent.`);
    const element = { id: id.value, start: offset, dataStart, size: size.value, data: bytes.subarray(dataStart, dataStart + size.value) };
    if (MASTER.has(id.value)) element.children = parseEbml(bytes, dataStart, dataStart + size.value);
    elements.push(element);
    offset = dataStart + size.value;
  }
  return elements;
}

const unsigned = element => element.data.reduce((value, byte) => value * 256 + byte, 0);
const ascii = element => String.fromCharCode(...element.data);
const child = (element, id) => element.children.find(item => item.id === id) ?? null;

/** Read one WebM video track: configuration, cues and a byte range per frame. */
export function readWebm(bytes) {
  const [header, segment, ...rest] = parseEbml(bytes);
  if (header.id !== 0x1a45dfa3 || segment.id !== 0x18538067 || rest.length) throw new Error('Expected one EBML header and one Segment.');
  const info = child(segment, 0x1549a966), entry = child(child(segment, 0x1654ae6b), 0xae), video = child(entry, 0xe0);
  const scale = unsigned(child(info, 0x2ad7b1)), colour = child(video, 0x55b0), codecPrivate = child(entry, 0x63a2);
  const frames = [], clusters = [];
  for (const cluster of segment.children.filter(element => element.id === 0x1f43b675)) {
    const clusterTime = unsigned(child(cluster, 0xe7));
    clusters.push({ position: cluster.start - segment.dataStart, time: clusterTime });
    for (const block of cluster.children.filter(element => element.id === 0xa3)) {
      const view = new DataView(block.data.buffer, block.data.byteOffset, block.data.byteLength);
      if (block.data[0] !== 0x81) throw new Error('SimpleBlock is not on track 1.');
      frames.push({ offset: block.dataStart + 4, size: block.size - 4, key: Boolean(block.data[3] & 0x80), time: clusterTime + view.getInt16(1), cluster: clusters.length - 1 });
    }
  }
  return {
    docType: ascii(child(header, 0x4282)), docTypeVersion: unsigned(child(header, 0x4287)), order: segment.children.map(element => element.id),
    timestampScale: scale, duration: new DataView(child(info, 0x4489).data.buffer, child(info, 0x4489).data.byteOffset, 8).getFloat64(0),
    codecId: ascii(child(entry, 0x86)), trackType: unsigned(child(entry, 0x83)), defaultDuration: unsigned(child(entry, 0x23e383)),
    width: unsigned(child(video, 0xb0)), height: unsigned(child(video, 0xba)),
    codecPrivate: codecPrivate ? codecPrivate.data : null,
    color: colour ? { matrix: unsigned(child(colour, 0x55b1)), range: unsigned(child(colour, 0x55b9)), transfer: unsigned(child(colour, 0x55ba)), primaries: unsigned(child(colour, 0x55bb)) } : null,
    seeks: child(segment, 0x114d9b74).children.map(seek => ({ id: unsigned(child(seek, 0x53ab)), position: unsigned(child(seek, 0x53ac)) })),
    positions: Object.fromEntries(segment.children.filter(element => element.id !== 0x1f43b675).map(element => [element.id, element.start - segment.dataStart])),
    cues: child(segment, 0x1c53bb6b).children.map(point => ({ time: unsigned(child(point, 0xb3)), track: unsigned(child(child(point, 0xb7), 0xf7)), position: unsigned(child(child(point, 0xb7), 0xf1)) })),
    clusters, frames, segmentSize: segment.size, segmentEnd: segment.dataStart + segment.size,
  };
}
