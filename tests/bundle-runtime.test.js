import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildSite } from '../scripts/build.mjs';
import { preserveModuleUrls } from '../scripts/lib/bundle-runtime.mjs';

test('bundling preserves original module URLs without rewriting source text', async () => {
  const source = [
    '// import.meta.url is intentionally literal here',
    'export const literal = "import.meta.url";',
    'export const template = `literal import.meta.url ${import.meta.url}`;',
    'export function asset(path) { return new URL(path, import.meta.url).href; }',
  ].join('\n');
  const changed = preserveModuleUrls(source, '/project/src/nested/module.js', '/project/src/app.js');
  assert.ok(changed.includes('// import.meta.url is intentionally literal here'));
  assert.ok(changed.includes('literal = "import.meta.url"'));
  assert.ok(changed.includes('`literal import.meta.url ${new URL('));
  assert.equal(preserveModuleUrls(source, '/project/src/app.js', '/project/src/app.js'), source);
  const temporary = await mkdtemp(join(tmpdir(), 'alloyview-module-url-'));
  try {
    await writeFile(join(temporary, 'app.mjs'), changed);
    const module = await import(pathToFileURL(join(temporary, 'app.mjs')));
    assert.equal(module.literal, 'import.meta.url');
    assert.equal(module.asset('../../examples/sample.cfg'), pathToFileURL(join(temporary, '../examples/sample.cfg')).href);
    assert.equal(module.template, `literal import.meta.url ${pathToFileURL(join(temporary, 'nested/module.js')).href}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('production bundles independent Worker entries, native assets and page module identities', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'alloyview-bundle-'));
  const root = join(temporary, 'project'), out = join(temporary, 'dist');
  const sources = {
    'index.html': '<head></head><script type="module" src="./src/app.js"></script>',
    'styles.css': 'body { color: black; }',
    'LICENSE': 'MIT',
    'src/app.js': "import { Feature, asset } from './nested/feature.js'; globalThis.__alloyviewBundledPage = { Feature, url: asset('../workers/probe-worker.js') };",
    'src/nested/feature.js': "export { counter } from './leaf.js'; export * from './leaf.js'; export default class DefaultFeature {} export class Feature {} export function asset(path) { return new URL(path, import.meta.url).href; }",
    'src/nested/leaf.js': 'export const counter = 7;',
    'src/analysis/kernel.mjs': 'export default () => new URL("kernel.wasm", import.meta.url).href;',
    'src/workers/probe-worker.js': "import { Feature, asset } from '../nested/feature.js'; import native from '../analysis/kernel.mjs'; export const probe = { Feature, url: asset('../../examples/sample.cfg'), native: native() };",
  };
  try {
    await mkdir(join(root, 'licenses'), { recursive: true });
    for (const [path, contents] of Object.entries(sources)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    const first = await buildSite(root, out);
    const versioned = join(out, 'assets', first.buildId);
    const appText = await readFile(join(versioned, 'src/app.js'), 'utf8');
    const workerText = await readFile(join(versioned, 'src/workers/probe-worker.js'), 'utf8');
    assert.equal(appText.includes("from \"./nested/feature.js\""), false);
    assert.equal(workerText.includes('from "../app.js"'), false);
    assert.ok(workerText.includes('from "../analysis/kernel.mjs"'));
    await import(pathToFileURL(join(versioned, 'src/app.js')));
    const page = globalThis.__alloyviewBundledPage;
    const facade = await import(pathToFileURL(join(versioned, 'src/nested/feature.js')));
    const leaf = await import(pathToFileURL(join(versioned, 'src/nested/leaf.js')));
    const worker = await import(pathToFileURL(join(versioned, 'src/workers/probe-worker.js')));
    assert.equal(page.Feature, facade.Feature);
    assert.equal(facade.Feature.name, 'Feature');
    assert.equal(facade.default.name, 'DefaultFeature');
    assert.equal(facade.counter, leaf.counter);
    assert.notEqual(worker.probe.Feature, facade.Feature);
    assert.equal(page.url, pathToFileURL(join(versioned, 'src/workers/probe-worker.js')).href);
    assert.equal(worker.probe.url, pathToFileURL(join(versioned, 'examples/sample.cfg')).href);
    assert.equal(worker.probe.native, pathToFileURL(join(versioned, 'src/analysis/kernel.wasm')).href);
    assert.equal(await readFile(join(out, 'src/app.js'), 'utf8'), sources['src/app.js']);
    const manifest = JSON.parse(await readFile(join(versioned, 'runtime-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.entries.map(entry => entry.entry), ['src/app.js', 'src/workers/probe-worker.js']);
    assert.ok(manifest.entries.every(entry => entry.bytes > 0 && entry.modules >= 2));
    assert.equal((await buildSite(root, out)).buildId, first.buildId);
    await writeFile(join(root, 'src/nested/leaf.js'), 'export const counter = 8;');
    assert.notEqual((await buildSite(root, out)).buildId, first.buildId);
  } finally {
    delete globalThis.__alloyviewBundledPage;
    await rm(temporary, { recursive: true, force: true });
  }
});
