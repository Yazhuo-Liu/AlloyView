import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayRefresh } from '../src/display-refresh.js';

function harness(apply) {
  const scheduled = new Map(); let sequence = 0;
  const queue = createDisplayRefresh({ apply, schedule: callback => { const id = ++sequence; scheduled.set(id, callback); return id; }, cancel: id => scheduled.delete(id) });
  return { queue, scheduled, tick() { const entries = [...scheduled.values()]; scheduled.clear(); for (const callback of entries) callback(); } };
}

test('cached frame publications merge palette, legend, vectors and radii into one synchronous batch flush', () => {
  const calls = [], state = { published: 0 };
  const { queue, scheduled } = harness(flags => calls.push({ flags, published: state.published }));
  queue.begin();
  for (let index = 0; index < 4; index++) {
    state.published++;
    queue.request({ options: true, colors: true, appearance: true, vectors: true });
  }
  assert.equal(state.published, 4, 'scientific results do not wait for a display refresh');
  assert.equal(scheduled.size, 0);
  queue.end();
  assert.deepEqual(calls, [{ flags: { options: true, colors: true, appearance: true, vectors: true }, published: 4 }]);
});

test('asynchronous analysis completions render once per animation frame; export flush uses the latest completed result', () => {
  const calls = [];
  const { queue, scheduled, tick } = harness(flags => calls.push(flags));
  queue.request({ options: true }); queue.request({ colors: true }); queue.request({ vectors: true });
  assert.equal(scheduled.size, 1);
  tick();
  assert.deepEqual(calls, [{ options: true, colors: true, vectors: true }]);
  queue.request({ colors: true });
  queue.flush();
  assert.equal(scheduled.size, 0, 'capture does not leave an obsolete scheduled refresh');
  tick();
  assert.equal(calls.length, 2);
});

test('nested batches preserve all dirty flags and comparison dependencies settle in the same flush', () => {
  const calls = []; let queue;
  ({ queue } = harness(flags => { calls.push(flags); if (flags.vectors) queue.request({ comparison: true }); }));
  queue.begin(); queue.begin(); queue.request({ vectors: true }); queue.end();
  assert.equal(calls.length, 0);
  assert.equal(queue.flush(), false);
  queue.end();
  assert.deepEqual(calls, [{ vectors: true }, { comparison: true }]);
  assert.equal(queue.pending, false);
});

test('Calculated becomes observable only after merged colors, legends and dependent display work', () => {
  const events = []; let queue;
  const fixture = harness(flags => {
    events.push(flags.colors ? 'colors and legend' : 'comparison');
    if (flags.colors) queue.request({ comparison: true });
  });
  ({ queue } = fixture);
  for (const analysis of ['CSP', 'CNA']) {
    queue.request({ options: true, colors: true });
    queue.afterFlush(() => events.push(`${analysis} Calculated`));
  }
  assert.equal(fixture.scheduled.size, 1, 'fast results share one display pass');
  assert.deepEqual(events, []);
  fixture.tick();
  assert.deepEqual(events, ['colors and legend', 'comparison', 'CSP Calculated', 'CNA Calculated']);
  assert.equal(queue.pending, false);
});

test('explicit capture flush completes queued readiness and readiness callbacks can refresh their labels', () => {
  const events = []; let queue;
  const fixture = harness(flags => events.push(Object.keys(flags).join(',')));
  ({ queue } = fixture);
  queue.afterFlush(() => { events.push('Calculated'); queue.request({ vectors: true }); });
  assert.equal(queue.pending, true);
  assert.equal(fixture.scheduled.size, 1);
  queue.flush();
  assert.deepEqual(events, ['Calculated', 'vectors']);
  assert.equal(fixture.scheduled.size, 0);
  assert.equal(queue.pending, false);
});
