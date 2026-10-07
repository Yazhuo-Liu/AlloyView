/** Yields that let other work run inside long loops.
 *
 * Browsers clamp chained `setTimeout(0)` to at least 4 ms after five nested
 * calls, so a loop that yields every few hundred items mostly waits. */

let channel = null;
const waiting = [];

/** For Workers: yield to queued tasks, including incoming cancellation
 * messages, in about 0.02 ms. `scheduler.yield()` is unsuitable here: its
 * continuation outranks queued messages, so a loop that keeps yielding never
 * receives its cancel request. A MessagePort task queues behind them. */
export function yieldToEventLoop() {
  if (typeof MessageChannel !== 'function') return new Promise(resolve => setTimeout(resolve, 0));
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => waiting.shift()();
    // Node keeps a listening port alive; tests and scripts must still exit.
    channel.port1.unref?.(); channel.port2.unref?.();
  }
  return new Promise(resolve => { waiting.push(resolve); channel.port2.postMessage(0); });
}

/** For the main thread: let input and rendering run between chunks of work. */
export function yieldToMain() {
  return typeof globalThis.scheduler?.yield === 'function' ? globalThis.scheduler.yield()
    : new Promise(resolve => setTimeout(resolve, 0));
}
