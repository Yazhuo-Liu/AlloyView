import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Node's in-process parser fallback isolates required file/atom parsing work.
// This is not browser/GPU latency: no app prefetch, renderer or native analysis
// runs, and the header checks/first frame are outside the measured seek.
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = resolve(option('--repository', resolve(import.meta.dirname, '../..')));
const atoms = Number(option('--atoms', 5000)), count = Number(option('--frames', 165)), runs = Number(option('--runs', 3));
for (const value of [atoms, count, runs]) assert.ok(Number.isInteger(value) && value > 1);
assert.equal(typeof globalThis.Worker, 'undefined', 'This benchmark deliberately uses the same in-process parser for both versions.');
const listeners = [], replies = [], reads = [];
globalThis.self = {
  addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
  postMessage(message) { replies.push(message); },
};
await import(pathToFileURL(resolve(root, 'src/workers/structure-worker.js')));
let nextId = 1;
async function request(type, payload) {
  const id = nextId++;
  await listeners[0]({ data:{ id, type, payload } });
  const reply = replies.find(message => message.id === id && 'ok' in message);
  assert.ok(reply?.ok, reply?.error);
  return reply.result;
}
class CountedFile extends File {
  async arrayBuffer() { reads.push(this.name); return super.arrayBuffer(); }
}
const header = `Number of particles = ${atoms}\n${Array.from({length:9},(_,axis)=>
  `H0(${Math.floor(axis/3)+1},${axis%3+1}) = ${axis%4===0?100:0}`).join('\n')}\n.NO_VELOCITY.\nentry_count = 4\nauxiliary[0] = id\n55.845\nFe\n`;
const files = Array.from({ length:count }, (_, index) => new CountedFile([header,
  Array.from({ length:atoms }, (_, atom) => `${((atom / atoms + .23 * index) % 1).toFixed(8)} .2 .3 ${atom + 1}\n`).join(''),
], `frame.${index}.cfg`));
const samples = [];
for (let run = 0; run < runs; run++) {
  await request('load', { files });
  reads.length = 0; replies.length = 0;
  const started = performance.now();
  const { frame } = await request('frame', { index:count - 1 });
  const elapsedMs = performance.now() - started;
  assert.equal(frame.ids.length, atoms);
  assert.equal(frame.frameIndex, count - 1);
  samples.push({ elapsedMs, fullFileReads:reads.length,
    sequenceSteps:replies.filter(message=>message.stage==='sequence-unwrap').length });
}
const times = samples.map(sample=>sample.elapsedMs).sort((a,b)=>a-b);
console.log(JSON.stringify({ runtime:process.version, mode:'Node in-process parser fallback', atomsPerFrame:atoms,
  frames:count, targetIndex:count-1, runs, medianMs:times[Math.floor(times.length/2)], samples }, null, 2));
