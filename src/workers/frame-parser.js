import { parseCfg } from '../io/cfg.js';
import { parseLammpsFrame } from '../io/lammps-dump.js';
import { parseXyzFrame } from '../io/xyz.js';
import { parsePdbFrame } from '../io/pdb.js';
import { parseLammpsData } from '../io/lammps-data.js';
import { parsePoscar } from '../io/poscar.js';
import { readFileBytes, readFileText } from '../io/gzip.js';

/** Descriptors contain a Blob and bounded byte range, never a whole decoded
 * trajectory. Blob clones retain immutable storage across Worker realms. */
export async function parseFrameDescriptor({ format, file, start = 0, end = file.size, header = '', index = 0 }) {
  let frame;
  if (format === 'cfg') frame = parseCfg(await readFileBytes(file), file.name);
  else if (format === 'lammps-dump') frame = parseLammpsFrame(new Uint8Array(await file.slice(start, end).arrayBuffer()), file.name);
  else if (format === 'xyz') frame = parseXyzFrame(new Uint8Array(await file.slice(start, end).arrayBuffer()), file.name);
  else if (format === 'pdb') {
    const text = await file.slice(start, end).text();
    frame = parsePdbFrame(header ? `${header}\n${text}` : text, file.name);
  } else if (format === 'lammps-data') frame = parseLammpsData(await readFileText(file), file.name);
  else if (format === 'poscar') frame = parsePoscar(await readFileText(file), file.name);
  else throw new Error(`Unsupported frame parser: ${format}`);
  frame.frameIndex = index;
  return frame;
}
