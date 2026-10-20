import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// CPU-only parse -> transferable frame -> actual display/metadata preparation.
// Excludes GPU uploads, DOM updates and Worker startup; reports each phase so
// moving work from the page to parsing cannot be mistaken for removing it.
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const [name, ...parts] = value.replace(/^--/, '').split('='); return [name, parts.join('=') || true];
}));
const atoms = Number(options.atoms ?? 1_000_000), repeats = Number(options.repeats ?? 5), warmup = Number(options.warmup ?? 2);
for (const [name, value] of Object.entries({ atoms, repeats, warmup })) {
  if (!Number.isSafeInteger(value) || value < (name === 'warmup' ? 0 : 1)) throw new Error(`${name} must be a valid integer.`);
}
const roots = options.baseline ? [['baseline', resolve(options.baseline)], ['current', resolve('.')]] : [['current', resolve('.')]];
const variants = [];
for (const [name, root] of roots) {
  const module = async file => import(pathToFileURL(resolve(root, `src/${file}`)).href);
  const [{ parseLammpsFrame }, { parseXyzFrame }, { colorsByType }, { radiiByType }, { createAttributeRegistry }, { WebGLRenderer }, { frameTransferables }] =
    await Promise.all(['io/lammps-dump.js', 'io/xyz.js', 'render/palette.js', 'render/atomic-radii.js', 'properties/global-attributes.js',
      'render/webgl-renderer.js', 'data/model.js'].map(module));
  let frameTypeOrder;
  try { ({ frameTypeOrder } = await module('data/frame-summary.js')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  variants.push({ name, parseLammpsFrame, parseXyzFrame, colorsByType, radiiByType, createAttributeRegistry, WebGLRenderer, frameTransferables, frameTypeOrder });
}

function renderer(Type) {
  return Object.assign(Object.create(Type.prototype), {
    frame: null, contextLost: true, periodicOrigin: [0, 0, 0], coordinateMode: 'wrapped',
    selectedAtoms: new Int32Array(16).fill(-1), sliceSelectedAtoms: new Int32Array(3).fill(-1),
    repetitions: [1, 1, 1], clearScalarColorPreview() {}, cancelSelectionGesture() {}, requestRender() {},
    bondOptions: { radius: .08, visible: true }, onProjectionChange() {}, slicePlaneValues: new Float32Array(64),
  });
}
function display(variant, frame, view) {
  const start = performance.now(), { colors, legend } = variant.colorsByType(frame), afterColors = performance.now();
  const radii = variant.radiiByType(frame), afterRadii = performance.now();
  const registry = variant.createAttributeRegistry({ frame }), counts = registry.list()
    .filter(entry => entry.name.startsWith('Type.') && entry.name.endsWith('.count')).map(entry => registry.get(entry.name).value);
  const typeOrder = variant.frameTypeOrder ? variant.frameTypeOrder(frame) : [...new Set(frame.types)];
  const afterAttributes = performance.now();
  view.setFrame(frame, colors, frame.positions, radii, [1, 1, 1], { useFrameSummary: true });
  const end = performance.now();
  return { colors, legend, radii, counts, typeOrder, bounds: view.sceneBounds,
    times: { colors: afterColors - start, radii: afterRadii - afterColors, attributes: afterAttributes - afterRadii,
      renderer: end - afterAttributes, total: end - start } };
}
function source(format) {
  const rows = new Array(atoms);
  for (let atom = 0; atom < atoms; atom++) {
    const x = (atom % 997) + .123456789, y = (Math.floor(atom / 997) % 991) + .333333333, z = (atom % 983) + .789012345;
    rows[atom] = format === 'dump' ? `${atom + 1} ${atom % 2 + 1} ${x} ${y} ${z}` : `${atom % 2 ? 'Ni' : 'Fe'} ${x} ${y} ${z}`;
  }
  const header = format === 'dump' ? `ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n${atoms}\nITEM: BOX BOUNDS pp pp pp\n0 1000\n0 1000\n0 1000\nITEM: ATOMS id type x y z\n` : `${atoms}\nplain nonperiodic molecule\n`;
  return new TextEncoder().encode(header + rows.join('\n') + '\n');
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summarize = values => ({ median: +median(values).toFixed(3), min: +Math.min(...values).toFixed(3), max: +Math.max(...values).toFixed(3) });
const result = { atoms, repeats, warmup, timingUnit: 'ms', environment: { node: process.version, platform: process.platform }, formats: {} };
for (const format of String(options.formats ?? 'dump,xyz').split(',')) {
  if (!['dump', 'xyz'].includes(format)) throw new Error(`Unsupported benchmark format: ${format}`);
  const bytes = source(format), measures = new Map(variants.map(variant => [variant.name, []]));
  // Exact scientific arrays and display outputs are compared outside timing.
  const referenceFrames = variants.map(variant => variant[format === 'dump' ? 'parseLammpsFrame' : 'parseXyzFrame'](bytes));
  if (referenceFrames.length === 2) {
    const [before, after] = referenceFrames;
    for (const name of ['ids', 'types', 'typeLabels', 'positions', 'fractional', 'unwrappedPositions', 'imageFlags', 'cell', 'properties']) {
      assert.deepEqual(after[name], before[name], `${format} ${name}`);
    }
    const expected = display(variants[0], before, renderer(variants[0].WebGLRenderer));
    const actual = display(variants[1], after, renderer(variants[1].WebGLRenderer));
    for (const name of ['colors', 'legend', 'radii', 'counts', 'typeOrder', 'bounds']) assert.deepEqual(actual[name], expected[name], `${format} display ${name}`);
  }
  referenceFrames.length = 0;
  for (let iteration = -warmup; iteration < repeats; iteration++) {
    // Alternate the order to limit clock/GC ordering bias.
    for (const variant of iteration % 2 ? [...variants].reverse() : variants) {
      globalThis.gc?.();
      const start = performance.now(), parsed = variant[format === 'dump' ? 'parseLammpsFrame' : 'parseXyzFrame'](bytes), afterParse = performance.now();
      const frame = structuredClone(parsed, { transfer: variant.frameTransferables(parsed) }), afterTransfer = performance.now();
      const view = renderer(variant.WebGLRenderer), cold = display(variant, frame, view);
      const cached = display(variant, frame, view);
      if (iteration >= 0) measures.get(variant.name).push({ parse: afterParse - start, transfer: afterTransfer - afterParse,
        coldTotal: afterTransfer - start + cold.times.total, coldDisplay: cold.times, cachedDisplay: cached.times });
    }
  }
  result.formats[format] = { bytes: bytes.length, exactEquality: variants.length === 2 ? 'passed' : 'no baseline provided' };
  for (const [name, runs] of measures) {
    result.formats[format][name] = Object.fromEntries(['parse', 'transfer', 'coldTotal'].map(key => [key, summarize(runs.map(run => run[key]))]));
    for (const phase of ['coldDisplay', 'cachedDisplay']) result.formats[format][name][phase] = Object.fromEntries(
      Object.keys(runs[0][phase]).map(key => [key, summarize(runs.map(run => run[phase][key]))]));
  }
}
console.log(JSON.stringify(result, null, 2));
