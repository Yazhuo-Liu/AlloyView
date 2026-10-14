import { frameTransferables } from '../data/model.js';
import { parseFrameDescriptor } from './frame-parser.js';

const requests = new Map();
self.addEventListener('message', async ({ data: { id, type, descriptor } }) => {
  if (type === 'cancel-parser') {
    const active = requests.get(id);
    if (active) { active.cancelled = true; active.controller.abort(); }
    return;
  }
  const active = { cancelled: false, controller: new AbortController() };
  requests.set(id, active);
  try {
    const frame = await parseFrameDescriptor(descriptor, { signal: active.controller.signal });
    if (active.cancelled) throw new DOMException('Frame parsing cancelled.', 'AbortError');
    // Header results deliberately contain no atom arrays. Preserve the same
    // reusable parser slot/CPU lease and only transfer their tiny cell buffers.
    const transferables = descriptor.projection === 'header'
      ? frame.cell ? [frame.cell.origin.buffer, frame.cell.vectors.buffer] : []
      : frameTransferables(frame);
    self.postMessage({ id, ok: true, frame }, transferables);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message, name: error.name });
  } finally { requests.delete(id); }
});
