import { readCfgHeader } from './cfg.js';
import { readDumpHeader } from './lammps-dump.js';
import { readXyzHeader, cellFromMetadata, parseXyzTimestep } from './xyz.js';
import { parseCrystalCell, readPdbModelTimestep } from './pdb.js';
import { isGzipFile } from './gzip.js';

const HEADER_CHUNK_BYTES = 4096;
export const MAX_FRAME_HEADER_BYTES = 1024 * 1024;
const cancelled = () => new DOMException('Frame header request cancelled.', 'AbortError');

/** Metadata for file-derived time series. This deliberately validates only
 * the header, not atom values. Atom count is the declared count, except PDB's
 * primary conformer count retained by its existing byte indexer. Inferred
 * free cells and unusually long headers request the ordinary full parser.
 * No atom-sized arrays are allocated or returned. */
export async function readFrameHeaderDescriptor(descriptor, { signal } = {}) {
  const { format, file, start = 0, end = file?.size, index = 0 } = descriptor;
  if (signal?.aborted) throw cancelled();
  const unavailable = () => ({ headerOnly: true, headerUnavailable: true, sourceFormat: format, frameIndex: index });
  if (!['cfg', 'lammps-dump', 'xyz', 'pdb'].includes(format)) return unavailable();
  if (format === 'pdb') {
    if (!Number.isSafeInteger(descriptor.atomCount) || descriptor.atomCount < 1 || typeof descriptor.metadataHeader !== 'string') {
      return unavailable();
    }
    let cell = null, timestep = null;
    if ((descriptor.header?.length ?? 0) + descriptor.metadataHeader.length > MAX_FRAME_HEADER_BYTES) return unavailable();
    const context = descriptor.header ? `${descriptor.header}\n${descriptor.metadataHeader}` : descriptor.metadataHeader;
    if (new TextEncoder().encode(context).byteLength > MAX_FRAME_HEADER_BYTES) return unavailable();
    for (const line of context.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const record = line.slice(0, 6).trim();
      if (record === 'CRYST1') cell = parseCrystalCell(line);
      else if (record === 'MODEL') timestep = readPdbModelTimestep(line);
    }
    return cell ? metadata(format, index, descriptor.atomCount, cell, timestep) : unavailable();
  }
  let header = null;
  const lines = await readPrefixLines(file, start, end, lines => {
    if (format === 'cfg') {
      // The sentinel marks an incomplete prefix, exactly as the byte parser's
      // shared CFG header reader expects, until it reaches the atom block.
      header = readCfgHeader([...lines, ''], lines.length);
      return Boolean(header);
    }
    if (format === 'lammps-dump') {
      if (!lines.some(line => line.trim().startsWith('ITEM: ATOMS '))) return false;
      header = readDumpHeader(lines);
      return true;
    }
    const first = lines.findIndex(line => line.trim());
    if (first < 0 || first + 1 >= lines.length) return false;
    // Schema validation remains shared with XYZ parsing, but numeric columns
    // are descriptors only, never atom-sized property allocations.
    header = readXyzHeader(lines, lines.length, 'coordinates');
    return true;
  }, signal);
  if (!lines) return unavailable();
  if (!header) {
    // At EOF let the normal header reader report missing or malformed fields.
    if (format === 'cfg') header = readCfgHeader(lines);
    else if (format === 'lammps-dump') header = readDumpHeader(lines);
    else header = readXyzHeader(lines, lines.length, 'coordinates');
  }
  if (format === 'xyz') {
    if (header.metadata.Lattice === undefined) return unavailable();
    const cell = cellFromMetadata(header.metadata, null);
    const timestep = parseXyzTimestep(header.metadata);
    return metadata(format, index, header.count, cell, timestep);
  }
  return metadata(format, index, header.count, header.cell, format === 'cfg' ? null : header.timestep,
    format === 'lammps-dump' ? { ...(header.units === null ? {} : { lammpsUnits: header.units }),
      ...(header.time === null ? {} : { simulationTime: header.time }) } : {});
}

function metadata(format, index, atomCount, cell, timestep, extra = {}) {
  return { headerOnly: true, sourceFormat: format, frameIndex: index, atomCount, cell, timestep, ...extra };
}

/** Read a bounded prefix of a frame, preserving UTF-8 split across chunks.
 * Compressed CFG sequence files stream only enough output for the header;
 * indexed dump/XYZ/PDB descriptors already refer to decompressed Blobs. */
async function readPrefixLines(file, start, end, complete, signal) {
  if (!file?.slice || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > file.size) {
    throw new Error('Invalid frame header byte range.');
  }
  const decoder = new TextDecoder(), lines = [];
  let trailing = '', bytes = 0, offset = start, reader = null;
  if (start === 0 && await isGzipFile(file)) {
    if (typeof DecompressionStream !== 'function') throw new Error(`“${file.name}” is gzip-compressed, but this browser cannot decompress gzip data. Decompress the file before opening it.`);
    reader = file.slice(start, end).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  }
  try {
    while (bytes < MAX_FRAME_HEADER_BYTES) {
      if (signal?.aborted) throw cancelled();
      let chunk, done;
      if (reader) {
        try { ({ value: chunk, done } = await reader.read()); }
        catch (error) {
          if (signal?.aborted) throw cancelled();
          throw new Error(`“${file.name}” could not be decompressed as a single gzip stream${error?.message ? `: ${error.message}` : '.'}`);
        }
      }
      else {
        done = offset >= end;
        if (!done) {
          const next = Math.min(end, offset + HEADER_CHUNK_BYTES);
          chunk = new Uint8Array(await file.slice(offset, next).arrayBuffer());
          offset = next;
        }
      }
      if (signal?.aborted) throw cancelled();
      if (done) {
        trailing += decoder.decode();
        // Keep the final line even when it is an empty XYZ comment.
        lines.push(trailing.replace(/\r$/, ''));
        complete(lines);
        return lines;
      }
      const allowed = Math.min(chunk.length, MAX_FRAME_HEADER_BYTES - bytes);
      bytes += allowed;
      trailing += decoder.decode(chunk.subarray(0, allowed), { stream: true });
      const parts = trailing.split('\n');
      trailing = parts.pop();
      for (const line of parts) lines.push(line.replace(/\r$/, ''));
      // Check once per bounded byte chunk, rather than rescanning a growing
      // CFG comment/auxiliary header for every single line. Large headers
      // continue yielding at each Blob read (or decompressor read).
      if (complete(lines)) return lines;
    }
    return null;
  } finally {
    if (reader) void reader.cancel().catch(() => {});
  }
}
