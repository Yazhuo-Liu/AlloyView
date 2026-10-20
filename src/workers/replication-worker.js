import { replicateFrame } from '../data/replicate.js';
import { frameTransferables } from '../data/model.js';
import { yieldToEventLoop } from '../shared/task-yield.js';
import { ReplicationIdCache } from '../data/replication-ids.js';

const requests = new Map();
const idCache = new ReplicationIdCache();
let sourceGeneration;
self.addEventListener('message', async ({ data: { id, type, payload } }) => {
  if (type === 'cancel-frame') { requests.get(payload.id)?.abort(); return; }
  const controller = new AbortController();
  requests.set(id, controller);
  try {
    if (sourceGeneration !== payload.sourceGeneration) { idCache.clear(); sourceGeneration = payload.sourceGeneration; }
    const frame = await replicateFrame(payload.frame, payload.repetitions, {
      signal: controller.signal, yieldTask: yieldToEventLoop, idCache,
      onProgress: progress => self.postMessage({ id, event: 'replication-progress', ...progress }),
    });
    const identity = idCache.current;
    // Another cooperatively scheduled request may have replaced the cache.
    // Reuse is offered only for the exact IDs this result actually owns.
    const shared = identity?.ids === frame.ids ? identity : null;
    const idsToken = shared?.token, idsBytes = shared?.bytes;
    const transferable = frameTransferables(frame);
    if (shared && payload.knownIdsToken === idsToken) delete frame.ids;
    self.postMessage({ id, ok: true, result: { frame, idsToken, idsBytes } }, transferable);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message, name: error.name });
  } finally { requests.delete(id); }
});
