import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../scripts/build.mjs';
import { createExampleCatalog, serializeExampleCatalog } from '../scripts/example-catalog.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const headers = {
  cfg: 'Number of particles = 1\nA = 1.0 Angstrom\n',
  dump: 'ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n1\n',
  xyz: '1\nframe\nFe 0 0 0\n',
  pdb: 'HEADER    TEST STRUCTURE\nATOM      1  FE  MOL A   1       0.000   0.000   0.000\n',
};

async function withRoot(action) {
  const root = await mkdtemp(join(tmpdir(), 'alloyview-examples-'));
  try { await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function example(root, path, contents = headers.cfg) {
  const target = join(root, 'examples', path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

test('the bundled catalog discovers the uploaded Fe dump and preserves the complete NEB sequence', async () => {
  const catalog = await createExampleCatalog(projectRoot);
  assert.equal(catalog.version, 1);
  const fe = catalog.examples.find((item) => item.path === 'Fe_disloc_loop.dump');
  assert.equal(fe?.kind, 'file');
  assert.equal(fe.format, 'lammps-dump');
  assert.equal(fe.files[0].url, '../examples/Fe_disloc_loop.dump');
  const neb = catalog.examples.find((item) => item.path === 'fixed_end_climb/');
  assert.equal(neb?.kind, 'sequence');
  assert.equal(neb.files.length, 40);
  assert.deepEqual(neb.files.map((file) => file.name), Array.from({ length: 40 }, (_, index) => `replica.${index}.cfg`));
  assert.equal(neb.detail, '40 numbered CFG files · NEB sequence');
  assert.match(catalog.examples.find((item) => item.path === 'NiGB_minimized.cfg').detail, /CPU\/GPU benchmark/);
});

test('recursive discovery separates formats, orders numeric sequences and excludes logs and unsafe assets', async () => {
  await withRoot(async (root) => {
    await example(root, 'nested/neb/replica.cfg.10');
    await example(root, 'nested/neb/replica.cfg.2');
    await example(root, 'metadata.json', JSON.stringify({ 'nested/neb/': '{count} frames · example sequence' }));
    await example(root, 'nested/mixed/frame.0.cfg');
    await example(root, 'nested/mixed/frame.1.cfg');
    await example(root, 'nested/mixed/frame.0.dump', headers.dump);
    await example(root, 'nested/mixed/frame.1.dump', headers.dump);
    await example(root, 'models/model.2.pdb', headers.pdb);
    await example(root, 'models/model.10.pdb', headers.pdb);
    await example(root, 'snapshot.extxyz', headers.xyz);
    await example(root, 'numbered.0.txt', headers.dump);
    await example(root, 'README.md', 'Instructions for this dataset.');
    await example(root, 'log.1.txt', 'LAMMPS run\nStep Temp\n1 300\n');
    await example(root, 'invalid.dump', 'LAMMPS log output');
    await example(root, '.hidden.cfg');
    await example(root, '.private/frame.0.cfg');
    await example(root, 'ambiguous\\name.cfg');
    await symlink(join(root, 'examples', 'snapshot.extxyz'), join(root, 'examples', 'linked.xyz'));

    const catalog = await createExampleCatalog(root);
    const neb = catalog.examples.find((item) => item.path === 'nested/neb/');
    assert.deepEqual(neb.files.map((file) => file.name), ['replica.cfg.2', 'replica.cfg.10']);
    assert.equal(neb.missingCount, 7);
    assert.equal(neb.detail, '2 frames · example sequence');
    assert.deepEqual(catalog.examples.filter((item) => item.path.startsWith('nested/mixed/')).map((item) => [item.path, item.format]), [
      ['nested/mixed/frame.{number}.cfg', 'cfg'],
      ['nested/mixed/frame.{number}.dump', 'lammps-dump'],
    ]);
    assert.equal(catalog.examples.length, 6);
    assert.equal(catalog.examples.find((item) => item.path === 'snapshot.extxyz').format, 'xyz');
    assert.equal(catalog.examples.find((item) => item.path === 'numbered.0.txt').format, 'lammps-dump');
    assert.equal(serializeExampleCatalog(await createExampleCatalog(root)), serializeExampleCatalog(catalog));
    await example(root, 'nested/neb/initial.cfg');
    const mixedCatalog = await createExampleCatalog(root);
    const mixedNeb = mixedCatalog.examples.find((item) => item.path === 'nested/neb/replica.cfg.{number}');
    assert.match(mixedNeb.detail, /7 missing index/);
  });
});

test('manifest URLs encode each path segment and metadata only supplies descriptions', async () => {
  await withRoot(async (root) => {
    const path = "odd #?%+/Fe's (α).dump";
    await example(root, path, headers.dump);
    await example(root, 'constructor', headers.xyz);
    await example(root, 'metadata.json', JSON.stringify({ [path]: 'Custom description', 'missing.cfg': 'Absent example' }));
    const catalog = await createExampleCatalog(root);
    assert.equal(catalog.examples.length, 2);
    assert.equal(catalog.examples[0].path, 'constructor');
    assert.match(catalog.examples[0].detail, /XYZ structure/);
    const item = catalog.examples[1];
    assert.equal(item.detail, 'Custom description');
    assert.equal(item.label, `examples/${path}`);
    assert.equal(item.files[0].url, '../examples/odd%20%23%3F%25%2B/Fe%27s%20%28%CE%B1%29.dump');
    const url = new URL(item.files[0].url, 'https://example.github.io/AlloyView/assets/abc/src/app.js');
    assert.equal(decodeURIComponent(url.pathname), `/AlloyView/assets/abc/examples/${path}`);
  });
});

test('missing examples and optional metadata produce an empty catalog without fixture source modules', async () => {
  await withRoot(async (root) => {
    assert.deepEqual(await createExampleCatalog(root), { version: 1, examples: [] });
    await example(root, 'metadata.json', JSON.stringify({ 'future.cfg': 'Not installed yet' }));
    assert.deepEqual(await createExampleCatalog(root), { version: 1, examples: [] });
    await example(root, 'metadata.json', JSON.stringify({ 'future.cfg': { detail: 'Invalid schema' } }));
    await assert.rejects(createExampleCatalog(root), /description strings/);
  });
});

test('build generates both manifests, versions catalog changes and permits a missing examples directory', async () => {
  await withRoot(async (root) => {
    const out = join(root, 'output');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'licenses'));
    await writeFile(join(root, 'src/app.js'), '// fixture');
    await writeFile(join(root, 'index.html'), '<head></head><script src="./src/app.js"></script>');
    await writeFile(join(root, 'styles.css'), 'body {}');
    await writeFile(join(root, 'LICENSE'), 'MIT');
    const empty = await buildSite(root, out);
    assert.deepEqual(JSON.parse(await readFile(join(out, 'examples/manifest.json'), 'utf8')).examples, []);
    await example(root, 'new # dump.dump', headers.dump);
    const first = await buildSite(root, out);
    assert.notEqual(first.buildId, empty.buildId);
    const manifest = await readFile(join(out, 'examples/manifest.json'), 'utf8');
    assert.equal(await readFile(join(out, 'assets', first.buildId, 'examples/manifest.json'), 'utf8'), manifest);
    const file = JSON.parse(manifest).examples[0].files[0];
    const app = new URL(`${first.assetPrefix}src/app.js`, 'https://example.github.io/AlloyView/');
    const url = new URL(file.url, app);
    assert.ok(url.pathname.startsWith(`/AlloyView/assets/${first.buildId}/examples/`));
    await access(join(out, decodeURIComponent(url.pathname.slice('/AlloyView/'.length))));
    assert.equal((await buildSite(root, out)).buildId, first.buildId);
    await example(root, 'metadata.json', JSON.stringify({ 'new # dump.dump': 'Changed description' }));
    const second = await buildSite(root, out);
    assert.notEqual(second.buildId, first.buildId);
    assert.equal(JSON.parse(await readFile(join(out, 'examples/manifest.json'), 'utf8')).examples[0].detail, 'Changed description');
  });
});

async function startServer(root) {
  const child = spawn(process.execPath, [join(projectRoot, 'scripts/serve.mjs'), root, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolveReady, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`Development server did not start: ${stderr}`)), 5000);
    child.stdout.on('data', (data) => {
      stdout += data;
      const match = /http:\/\/localhost:(\d+)/.exec(stdout);
      if (match) { clearTimeout(timeout); resolveReady(`http://127.0.0.1:${match[1]}`); }
    });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Development server exited ${code}: ${stderr}`)); });
  }).catch((error) => { child.kill(); throw error; });
  return { child, url };
}

test('development discovers files added while running and preview retains its generated manifest', async () => {
  await withRoot(async (root) => {
    const { child, url } = await startServer(root);
    try {
      const emptyResponse = await fetch(`${url}/examples/manifest.json`);
      assert.equal(emptyResponse.status, 200);
      assert.equal(emptyResponse.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await emptyResponse.json()).examples, []);
      await example(root, 'added # dump.dump', headers.dump);
      const catalog = await (await fetch(`${url}/examples/manifest.json`)).json();
      assert.equal(catalog.examples[0].path, 'added # dump.dump');
      const fileUrl = new URL(catalog.examples[0].files[0].url, `${url}/src/app.js`);
      assert.equal(await (await fetch(fileUrl)).text(), headers.dump);
      await example(root, 'manifest.json', '{"version":1,"examples":[],"built":true}\n');
      assert.equal((await (await fetch(`${url}/examples/manifest.json`)).json()).built, true);
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
});
