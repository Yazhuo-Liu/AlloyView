import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** Source directories form layers. A module may import from its own layer or
 * from a lower one; the composition root (src/app.js) and Worker entrypoints
 * sit on top. docs/ARCHITECTURE.md describes the layers. */
const LAYER_RANK = {
  shared: 0,
  data: 1, crystal: 1,
  io: 2, properties: 2,
  analysis: 3,
  render: 4, video: 4, workers: 4,
  application: 5,
  ui: 6,
};
const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

/** Upward imports that the layout accepts on purpose. */
const ALLOWED_UPWARD = new Set([
  // Worker clients live beside the capability they serve; the inline parser
  // path reuses the Worker's parsing routine.
  'src/data/frame-parser-pool.js -> src/workers/frame-parser.js',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== 'vendor') walk(path, out); }
    else if (/\.(m?js)$/.test(name)) out.push(path);
  }
  return out;
}

function layerOf(file) {
  const parts = relative(SRC, file).split(/[\\/]/);
  return parts.length === 1 ? '(root)' : parts[0];
}

function readEdges(file) {
  const source = readFileSync(file, 'utf8');
  const edges = { static: [], dynamic: [] };
  const resolveSpec = spec => {
    if (!spec.startsWith('.')) return null;
    const target = resolve(dirname(file), spec);
    return /\.(m?js)$/.test(target) ? target : null;
  };
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    const target = resolveSpec(match[1]); if (target) edges.static.push(target);
  }
  for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = resolveSpec(match[1]); if (target) edges.dynamic.push(target);
  }
  return edges;
}

const files = walk(SRC);
const graph = new Map(files.map(file => [file, readEdges(file)]));
const label = file => relative(ROOT, file).replaceAll('\\', '/');

function stronglyConnectedComponents(edgesOf) {
  let index = 0; const stack = []; const indices = new Map(); const low = new Map(); const onStack = new Set(); const components = [];
  function connect(node) {
    indices.set(node, index); low.set(node, index); index += 1; stack.push(node); onStack.add(node);
    for (const next of edgesOf(node)) {
      if (!indices.has(next)) { connect(next); low.set(node, Math.min(low.get(node), low.get(next))); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)));
    }
    if (low.get(node) === indices.get(node)) {
      const component = []; let member;
      do { member = stack.pop(); onStack.delete(member); component.push(member); } while (member !== node);
      if (component.length > 1 || edgesOf(node).includes(node)) components.push(component);
    }
  }
  for (const node of graph.keys()) if (!indices.has(node)) connect(node);
  return components;
}

test('imports form no cycles, including lazy import()', () => {
  const cycles = stronglyConnectedComponents(node => {
    const edges = graph.get(node); return edges ? [...edges.static, ...edges.dynamic] : [];
  });
  assert.deepEqual(cycles.map(cycle => cycle.map(label).sort()), [], 'modules import each other in a cycle');
});

test('modules import only their own layer or lower ones', () => {
  const violations = [];
  for (const [file, edges] of graph) {
    const from = layerOf(file);
    if (from === '(root)') continue;
    for (const target of [...edges.static, ...edges.dynamic]) {
      const to = layerOf(target);
      if (to === '(root)') { violations.push(`${label(file)} -> ${label(target)} (imports the composition root)`); continue; }
      const edge = `${label(file)} -> ${label(target)}`;
      if (LAYER_RANK[from] < LAYER_RANK[to] && !ALLOWED_UPWARD.has(edge)) violations.push(edge);
      // Worker entrypoints may use only render's pure geometry builders, never GPU layers.
      if (from === 'workers' && to === 'render' && !/-geometry\.js$/.test(target)) violations.push(`${edge} (Workers may import only render/*-geometry.js)`);
    }
  }
  assert.deepEqual(violations, []);
});

test('every allowed upward import is still used', () => {
  const present = new Set();
  for (const [file, edges] of graph) for (const target of edges.static) present.add(`${label(file)} -> ${label(target)}`);
  for (const edge of ALLOWED_UPWARD) assert.ok(present.has(edge), `${edge} no longer exists; remove it from ALLOWED_UPWARD`);
});
