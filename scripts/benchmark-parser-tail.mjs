import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { createCell, fractionalToCartesian } from '../src/data/model.js';
import * as sequence from '../src/data/trajectory.js';

// This compares complete parsers against the actual pre-T4 implementation;
// timing probes exist only in private benchmark modules, never in production.
const root = new URL('../', import.meta.url);
const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice(11) ?? '38aaabe';
assert.match(baseline, /^[0-9a-f]{7,40}$/i, 'Use a baseline commit hash.');
const rounds = Number(process.argv.find(value => value.startsWith('--rounds='))?.slice(9) ?? 11);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 51);
const atoms = Number(process.argv.find(value => value.startsWith('--atoms='))?.slice(8) ?? 1_000_000);
assert.ok(Number.isSafeInteger(atoms) && atoms >= 1 && atoms <= 2_000_000);

const original = name => execFileSync('git', ['show', `${baseline}:${name}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
function imports(source) {
  return source.replace("from '../data/model.js'", `from '${new URL('src/data/model.js', root).href}'`)
    .replace("from './ascii-rows.js'", `from '${new URL('src/io/ascii-rows.js', root).href}'`)
    .replace("from './model.js'", `from '${new URL('src/data/model.js', root).href}'`);
}
const moduleFrom = source => import(`data:text/javascript;base64,${Buffer.from(imports(source)).toString('base64')}`);
const tailProbe = (source, slot) => {
  assert.ok(source.includes('function finishDumpFrame(header, atoms, sourceName, startedAt) {'));
  return source.replace('function finishDumpFrame(header, atoms, sourceName, startedAt) {', 'function finishDumpFrameInner(header, atoms, sourceName, startedAt) {')
    + `\nfunction finishDumpFrame(...args) { const started=performance.now();const result=finishDumpFrameInner(...args);globalThis.${slot}=performance.now()-started;return result;}\n`;
};
const before = await moduleFrom(tailProbe(original('src/io/lammps-dump.js'), 'parserTailBeforeMs'));
const after = await moduleFrom(tailProbe(await readFile(new URL('src/io/lammps-dump.js', root), 'utf8'), 'parserTailAfterMs'));
const beforeSequence = await moduleFrom(original('src/data/trajectory.js'));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const measurements = [];
let checksum = 0;
function measure(name, calculateBefore, calculateAfter, tail = false) {
  // Both implementations receive the same warm-up and alternate order, so
  // JIT warm-up and competing cloud work do not favor one fixed first caller.
  for (let index = 0; index < 12; index++) { checksum += calculateBefore(); checksum += calculateAfter(); }
  const oldTimes = [], newTimes = [], oldTail = [], newTail = [];
  for (let index = 0; index < rounds; index++) {
    const calls = [[calculateBefore, oldTimes, oldTail, 'parserTailBeforeMs'], [calculateAfter, newTimes, newTail, 'parserTailAfterMs']];
    if (index % 2) calls.reverse();
    for (const [calculate, times, tails, slot] of calls) {
      const started = performance.now();
      checksum += calculate();
      times.push(performance.now() - started);
      if (tail) tails.push(globalThis[slot]);
    }
  }
  measurements.push({ name, beforeMedianMs: median(oldTimes), afterMedianMs: median(newTimes),
    ...(tail ? { beforeTailMedianMs: median(oldTail), afterTailMedianMs: median(newTail) } : {}), beforeMs: oldTimes, afterMs: newTimes });
}
function parseMeasurement(name, bytes) {
  const oldFrame = before.parseLammpsFrame(bytes), newFrame = after.parseLammpsFrame(bytes);
  assert.deepEqual({ ...newFrame, parseMs: 0 }, { ...oldFrame, parseMs: 0 });
  measure(name, () => before.parseLammpsFrame(bytes).ids.length, () => after.parseLammpsFrame(bytes).ids.length, true);
}
for (const name of ['hea-fcc-screw.dump', 'Fe_disloc_loop.dump']) {
  parseMeasurement(name, await readFile(new URL(`examples/${name}`, root)));
}
const rows = new Array(atoms);
for (let index = 0; index < atoms; index++) {
  rows[index] = `${index + 1} ${index % 5 + 1} ${(index % 173) * .9 - 90} ${(index % 211) * .8 - 85} ${(index % 149) * 1.1 - 75} ${index % 3 - 1} ${index % 5 - 2} ${index % 7 - 3} .123 -.456 .789 -7.89123\n`;
}
const header = `ITEM: TIMESTEP\n1\nITEM: NUMBER OF ATOMS\n${atoms}\nITEM: BOX BOUNDS xy xz yz pp pp pp\n-100 110 5\n-100 110 -2\n-100 110 3\nITEM: ATOMS id type x y z ix iy iz vx vy vz energy\n`;
const bytes = new TextEncoder().encode(header + rows.join(''));
rows.length = 0;
parseMeasurement(`${atoms}-atom synthetic triclinic dump`, bytes);

for (const count of [...new Set([129_904, atoms])]) {
  const cell = createCell({ vectors: [123.4, 0, 0, 2.567, 125.6, 0, -3.123, 1.345, 124.5] });
  const ids = Float64Array.from({ length: count }, (_, index) => index + 1);
  const fractional = Float32Array.from({ length: count * 3 }, (_, index) => ((index % 997) + .5) / 997);
  const frame = values => ({ ids, idSource: 'explicit', cell, fractional: values, positions: fractionalToCartesian(values, cell) });
  const state = sequence.prepareSequenceBaseline(frame(fractional));
  const current = Float32Array.from(fractional, value => (value + .01) % 1);
  const oldFrame = frame(current), newFrame = frame(current);
  assert.deepEqual(sequence.unwrapSequenceFrame(newFrame, state, 1), beforeSequence.unwrapSequenceFrame(oldFrame, state, 1));
  const unwrap = (implementation, value) => {
    value.unwrappedPositions = null;
    value.imageFlags = null;
    return implementation.unwrapSequenceFrame(value, state, 1).ids.length;
  };
  measure(`${count}-atom same-order CFG continuity`, () => unwrap(beforeSequence, oldFrame), () => unwrap(sequence, newFrame));
}
delete globalThis.parserTailBeforeMs;
delete globalThis.parserTailAfterMs;
console.log(JSON.stringify({ baseline, runtime: process.version, platform: process.platform, rounds, checksum,
  note: 'Node CPU timings; parser probes and fixture construction are excluded. Cloud load, GC and JIT affect full-parse timings. No coordinate-only projection or new Workers are used.', measurements }, null, 2));
