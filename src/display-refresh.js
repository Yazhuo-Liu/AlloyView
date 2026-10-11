/** Merge display work within a frame transition and between asynchronous
 * analysis completions. Scientific publication remains synchronous; captures
 * and automation explicitly flush this queue before observing the display. */
export function createDisplayRefresh({ apply, schedule = callback => requestAnimationFrame(callback), cancel = id => cancelAnimationFrame(id) }) {
  let pending = new Set(), completions = [], handle = null, depth = 0, applying = false;
  function request(flags = { colors: true }) {
    for (const [name, dirty] of Object.entries(flags)) if (dirty) pending.add(name);
    if (!depth && !applying && handle === null && (pending.size || completions.length)) handle = schedule(() => { handle = null; flush(); });
  }
  function afterFlush(callback) {
    completions.push(callback);
    request({});
  }
  function flush() {
    if (depth || applying) return false;
    if (handle !== null) { cancel(handle); handle = null; }
    applying = true;
    try {
      while (pending.size || completions.length) {
        if (pending.size) {
          const flags = Object.fromEntries([...pending].map(name => [name, true]));
          pending = new Set(); apply(flags);
        } else completions.shift()();
      }
    } finally { applying = false; }
    return true;
  }
  function begin() { depth++; }
  function end({ flush: immediate = true } = {}) {
    if (!depth) throw new Error('No display refresh batch is open.');
    depth--;
    if (!depth) { if (immediate) flush(); else request({}); }
  }
  return { request, afterFlush, flush, begin, end, get pending() { return pending.size > 0 || completions.length > 0; } };
}
