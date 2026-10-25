import { parseCfgAsync } from '../io/cfg.js';
import { parseLammpsFrameAsync } from '../io/lammps-dump.js';
import { parseXyzFrameAsync } from '../io/xyz.js';
import { parsePdbFrameAsync } from '../io/pdb.js';
import { parseLammpsDataAsync } from '../io/lammps-data.js';
import { parsePoscarAsync } from '../io/poscar.js';
import { parseCifAsync } from '../io/cif.js';
import { readFileBytes, readFileText } from '../io/gzip.js';
import { readFrameHeaderDescriptor } from '../io/frame-header.js';

/** Descriptors contain a Blob and bounded byte range, never a whole decoded
 * trajectory. Blob clones retain immutable storage across Worker realms. */
export async function parseFrameDescriptor(descriptor, { signal } = {}) {
  if (signal?.aborted) throw new DOMException('Frame parsing cancelled.', 'AbortError');
  const { format, file, start = 0, end = file.size, header = '', index = 0, projection = 'full' } = descriptor;
  if (!['full', 'coordinates', 'header'].includes(projection)) throw new Error(`Unsupported frame projection: ${projection}`);
  if (projection === 'header') return readFrameHeaderDescriptor(descriptor, { signal });
  const options = { projection, signal };
  let frame;
  if (format === 'cfg') frame = await parseCfgAsync(await readFileBytes(file, { signal }), file.name, { ...options, deferUnwrap: Boolean(descriptor.deferUnwrap) });
  else if (format === 'lammps-dump') frame = await parseLammpsFrameAsync(new Uint8Array(await file.slice(start, end).arrayBuffer()), file.name, options);
  else if (format === 'xyz') frame = await parseXyzFrameAsync(new Uint8Array(await file.slice(start, end).arrayBuffer()), file.name, options);
  else if (format === 'pdb') {
    const text = await file.slice(start, end).text();
    frame = await parsePdbFrameAsync(header ? `${header}\n${text}` : text, file.name, options);
  } else if (format === 'lammps-data') frame = await parseLammpsDataAsync(await readFileText(file, { signal }), file.name, options);
  else if (format === 'poscar') frame = await parsePoscarAsync(await readFileText(file, { signal }), file.name, options);
  else if (format === 'cif') frame = await parseCifAsync(await readFileText(file, { signal }), file.name, options);
  else throw new Error(`Unsupported frame parser: ${format}`);
  // Single-frame LAMMPS data/POSCAR retain their complete validation path.
  // They have no trajectory coordinate consumer; retain an explicit fallback
  // rather than silently dropping validation of their sections.
  if (projection === 'coordinates') frame.properties = [];
  if (signal?.aborted) throw new DOMException('Frame parsing cancelled.', 'AbortError');
  frame.frameIndex = index;
  return frame;
}
