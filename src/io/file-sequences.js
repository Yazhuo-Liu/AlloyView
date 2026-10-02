const SUPPORTED_EXTENSION = /\.(?:cfg|dump|lmp|lammpstrj|lammpstraj|txt)$/i;
const NUMBER_RUN = /\d+/g;

const naturalCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function isSupportedStructurePath(path) {
  return SUPPORTED_EXTENSION.test(path);
}

export function isPotentialStructurePath(path) {
  const filename = String(path).replaceAll('\\', '/').split('/').at(-1);
  return isSupportedStructurePath(path) || /\d/.test(filename);
}

export function inferStructureFormatFromPath(path) {
  const filename = String(path).replaceAll('\\', '/').split('/').at(-1);
  if (/(?:^|\.)cfg(?:\.|$)/i.test(filename)) return 'cfg';
  if (/(?:^|\.)(?:dump|lmp|lammpstrj|lammpstraj)(?:\.|$)/i.test(filename)) return 'lammps-dump';
  return null;
}

export function detectStructureFormatHeader(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const firstDataLine = lines.find((line) => line.trim() && !line.trim().startsWith('#'))?.trim() ?? '';
  if (/^Number\s+of\s+particles\s*=\s*\d+/i.test(firstDataLine)) return 'cfg';
  if (/^ITEM:\s+TIMESTEP\b/i.test(firstDataLine)) return 'lammps-dump';
  return null;
}

export function catalogLocalSources(inputEntries, { allowManualCfgSequence = false } = {}) {
  const entries = inputEntries
    .map(normalizeEntry)
    .filter((entry) => entry.format)
    .sort((left, right) => naturalCollator.compare(left.relativePath, right.relativePath));
  const sequences = detectNumberedStructureSequences(entries);
  const claimedPaths = new Set(sequences.flatMap((sequence) => sequence.entries.map((entry) => entry.relativePath)));
  const singles = entries
    .filter((entry) => !claimedPaths.has(entry.relativePath))
    .map((entry) => ({
      kind: 'file',
      label: entry.relativePath,
      detail: formatFileDetail(entry.file),
      format: entry.format,
      files: [entry.file],
      entries: [entry],
    }));

  if (sequences.length === 0 && allowManualCfgSequence && entries.length > 1
      && entries.every((entry) => entry.format === 'cfg')) {
    return {
      sources: [{
        kind: 'sequence',
        detected: false,
        label: `${entries[0].relativePath} … ${entries.at(-1).relativePath}`,
        detail: `${entries.length} selected CFG frames`,
        files: entries.map((entry) => entry.file),
        entries,
        format: 'cfg',
      }],
      supportedCount: entries.length,
      sequenceCount: 0,
    };
  }

  return {
    sources: [
      ...sequences.map((sequence) => ({
        kind: 'sequence',
        detected: true,
        label: sequence.pattern,
        detail: sequenceDetail(sequence),
        files: sequence.entries.map((entry) => entry.file),
        entries: sequence.entries,
        firstIndex: sequence.firstIndex,
        lastIndex: sequence.lastIndex,
        missingCount: sequence.missingCount,
        format: sequence.format,
      })),
      ...singles,
    ],
    supportedCount: entries.length,
    sequenceCount: sequences.length,
  };
}

export function detectNumberedStructureSequences(inputEntries) {
  const groups = new Map();
  const entries = inputEntries.map(normalizeEntry);
  for (const entry of entries) {
    if (entry.format !== 'cfg' && entry.format !== 'lammps-dump') continue;
    const { directory, filename } = splitPath(entry.relativePath);
    for (const match of filename.matchAll(NUMBER_RUN)) {
      const index = Number(match[0]);
      if (!Number.isSafeInteger(index)) continue;
      const prefix = filename.slice(0, match.index);
      const suffix = filename.slice(match.index + match[0].length);
      const key = `${entry.format}\u0000${directory}\u0000${prefix}\u0000${suffix}`;
      if (!groups.has(key)) groups.set(key, {
        format: entry.format, directory, prefix, suffix, members: [],
      });
      groups.get(key).members.push({ entry, index });
    }
  }

  const candidates = [];
  for (const group of groups.values()) {
    const indices = new Set(group.members.map((member) => member.index));
    if (group.members.length < 2 || indices.size !== group.members.length) continue;
    group.members.sort((left, right) => left.index - right.index
      || naturalCollator.compare(left.entry.relativePath, right.entry.relativePath));
    const firstIndex = group.members[0].index;
    const lastIndex = group.members.at(-1).index;
    candidates.push({
      pattern: `${group.directory}${group.prefix}{number}${group.suffix}`,
      entries: group.members.map((member) => member.entry),
      firstIndex,
      lastIndex,
      missingCount: Math.max(0, lastIndex - firstIndex + 1 - group.members.length),
      format: group.format,
    });
  }

  candidates.sort((left, right) => right.entries.length - left.entries.length
    || naturalCollator.compare(left.pattern, right.pattern));
  const claimed = new Set();
  const selected = [];
  for (const candidate of candidates) {
    if (candidate.entries.some((entry) => claimed.has(entry.relativePath))) continue;
    selected.push(candidate);
    candidate.entries.forEach((entry) => claimed.add(entry.relativePath));
  }
  return selected.sort((left, right) => naturalCollator.compare(left.pattern, right.pattern));
}

export function detectNumberedCfgSequences(inputEntries) {
  return detectNumberedStructureSequences(inputEntries).filter((sequence) => sequence.format === 'cfg');
}

function normalizeEntry(input) {
  const file = input.file ?? input;
  const relativePath = normalizePath(input.relativePath ?? file.webkitRelativePath ?? file.name);
  const format = Object.hasOwn(input, 'format') && input.format !== undefined
    ? input.format
    : formatFromPath(relativePath);
  return { file, relativePath, format };
}

function normalizePath(path) {
  return String(path).replaceAll('\\', '/').replace(/^\.\//, '');
}

function splitPath(path) {
  const slash = path.lastIndexOf('/');
  return {
    directory: slash >= 0 ? path.slice(0, slash + 1) : '',
    filename: slash >= 0 ? path.slice(slash + 1) : path,
  };
}

function formatFromPath(path) {
  return inferStructureFormatFromPath(path)
    ?? (SUPPORTED_EXTENSION.test(path) ? 'lammps-dump' : null);
}

function sequenceDetail(sequence) {
  const gap = sequence.missingCount > 0 ? ` · ${sequence.missingCount} missing index${sequence.missingCount === 1 ? '' : 'es'}` : '';
  const contents = sequence.format === 'cfg' ? 'CFG frames' : 'LAMMPS dump files';
  return `${sequence.entries.length} ${contents} · indices ${sequence.firstIndex}–${sequence.lastIndex}${gap}`;
}

function formatFileDetail(file) {
  const bytes = Number(file.size);
  if (!Number.isFinite(bytes)) return 'Structure file';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
