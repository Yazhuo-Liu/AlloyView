/** Number and option formatting shared by the page's status chrome, panels
 * and legend. Pure helpers: no application state. */

export function option(value, label) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  return milliseconds < 1000 ? `${milliseconds.toFixed(1)} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function formatInteger(value) { return new Intl.NumberFormat('en-US').format(value); }

export function formatValue(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 1e4 || (Math.abs(value) > 0 && Math.abs(value) < 1e-4)) return value.toExponential(5);
  return Number(value.toPrecision(7)).toString();
}

export function formatVector(array, index, suffix = '') {
  return `(${formatValue(array[index])}, ${formatValue(array[index + 1])}, ${formatValue(array[index + 2])})${suffix}`;
}
