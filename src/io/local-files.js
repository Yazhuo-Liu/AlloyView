// File/Blob constructors belong to a browser realm. Check the read APIs rather
// than constructor identity so files also work across windows and Workers.
export function isReadableLocalFile(file) {
  return file != null
    && Number.isFinite(file.size) && file.size >= 0
    && typeof file.slice === 'function'
    && typeof file.text === 'function'
    && typeof file.arrayBuffer === 'function';
}

export function normalizeLocalFiles(input) {
  if (isReadableLocalFile(input)) return [input];
  return Array.from(input ?? []);
}
