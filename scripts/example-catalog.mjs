import { open, readFile, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { catalogLocalSources, detectStructureFormatHeader } from '../src/io/file-sequences.js';

const naturalCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const formatLabels = { cfg: 'CFG structure', 'lammps-dump': 'LAMMPS dump', xyz: 'XYZ structure', pdb: 'PDB structure' };
const generatedFiles = new Set(['manifest.json', 'metadata.json']);

function comparePaths(left, right) {
  return naturalCollator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}

function assetUrl(path) {
  const encoded = path.split('/').map((segment) => encodeURIComponent(segment)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  return `../examples/${encoded}`;
}

async function structureHeader(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { format: detectStructureFormatHeader(buffer.subarray(0, bytesRead).toString('utf8')), size: (await handle.stat()).size };
  } finally {
    await handle.close();
  }
}

async function readMetadata(examplesRoot) {
  let text;
  try { text = await readFile(resolve(examplesRoot, 'metadata.json'), 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  const metadata = JSON.parse(text);
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object'
      || Object.values(metadata).some((detail) => typeof detail !== 'string')) {
    throw new Error('examples/metadata.json must map example paths to description strings.');
  }
  return metadata;
}

/** Discover supported data by its header, without loading complete trajectories. */
export async function createExampleCatalog(root) {
  const examplesRoot = resolve(root, 'examples');
  const entries = [];
  async function visit(directory = '') {
    let children;
    try { children = await readdir(resolve(examplesRoot, directory), { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT' && directory === '') return;
      throw error;
    }
    children.sort((left, right) => comparePaths(left.name, right.name));
    for (const child of children) {
      // Hidden files, symlinks and names with ambiguous separators are not data assets.
      if (child.name.startsWith('.') || /[\\\x00-\x1f\x7f]/.test(child.name)) continue;
      const path = directory ? `${directory}/${child.name}` : child.name;
      if (child.isDirectory()) await visit(path);
      else if (child.isFile() && !(directory === '' && generatedFiles.has(child.name))) {
        const { format, size } = await structureHeader(resolve(examplesRoot, path));
        if (format) entries.push({ relativePath: path, format, file: { name: child.name, size } });
      }
    }
  }
  await visit();
  const metadata = await readMetadata(examplesRoot);
  const catalog = catalogLocalSources(entries);
  const directoryCounts = new Map();
  for (const source of catalog.sources) {
    const directory = source.entries[0].relativePath.slice(0, source.entries[0].relativePath.lastIndexOf('/') + 1);
    directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
  }
  const examples = catalog.sources.map((source) => {
    const directory = source.entries[0].relativePath.slice(0, source.entries[0].relativePath.lastIndexOf('/') + 1);
    const path = source.kind === 'sequence' && directory && directoryCounts.get(directory) === 1
      ? directory : source.label;
    const description = Object.hasOwn(metadata, path) ? metadata[path]
      : Object.hasOwn(metadata, source.label) ? metadata[source.label] : undefined;
    const example = {
      id: source.label,
      kind: source.kind,
      path,
      label: `examples/${path}`,
      format: source.format,
      detail: description?.replaceAll('{count}', String(source.entries.length))
        ?? (source.kind === 'sequence' ? source.detail : `${formatLabels[source.format]} · ${source.detail}`),
      files: source.entries.map((entry) => ({
        path: entry.relativePath,
        url: assetUrl(entry.relativePath),
        name: basename(entry.relativePath),
        size: entry.file.size,
      })),
    };
    if (source.kind === 'sequence') {
      example.firstIndex = source.firstIndex;
      example.lastIndex = source.lastIndex;
      example.missingCount = source.missingCount;
    }
    return example;
  }).sort((left, right) => comparePaths(left.path, right.path));
  return { version: 1, examples };
}

export function serializeExampleCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
