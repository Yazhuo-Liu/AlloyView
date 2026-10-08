import { frameTransferables } from '../data/model.js';
import { parseFrameDescriptor } from './frame-parser.js';

const requests = new Map();
self.addEventListener('message', async ({ data: { id, type, descriptor } }) => {
  if (type === 'cancel-parser') {
    const active = requests.get(id);
    if (active) active.cancelled = true;
    return;
  }
  const active = { cancelled: false };
  requests.set(id, active);
  try {
    const frame = await parseFrameDescriptor(descriptor);
    if (active.cancelled) throw new DOMException('Frame parsing cancelled.', 'AbortError');
    self.postMessage({ id, ok: true, frame }, frameTransferables(frame));
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message, name: error.name });
  } finally { requests.delete(id); }
});
