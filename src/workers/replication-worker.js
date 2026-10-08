import { replicateFrame } from '../data/replicate.js';
import { frameTransferables } from '../data/model.js';
import { yieldToEventLoop } from '../task-yield.js';

const requests = new Map();
self.addEventListener('message', async ({ data: { id, type, payload } }) => {
  if (type === 'cancel-frame') { requests.get(payload.id)?.abort(); return; }
  const controller = new AbortController();
  requests.set(id, controller);
  try {
    const frame = await replicateFrame(payload.frame, payload.repetitions, {
      signal: controller.signal, yieldTask: yieldToEventLoop,
      onProgress: progress => self.postMessage({ id, event: 'replication-progress', ...progress }),
    });
    self.postMessage({ id, ok: true, result: { frame } }, frameTransferables(frame));
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message, name: error.name });
  } finally { requests.delete(id); }
});
