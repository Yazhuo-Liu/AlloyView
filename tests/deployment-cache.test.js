import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSite } from '../scripts/build.mjs';

const immutable = 'public, max-age=31536000, immutable';
const serveScript = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url));

async function fixture(root) {
  const files = {
    'index.html': '<head><link href="./styles.css"></head><script src="./src/app.js"></script>',
    'styles.css': 'body { color: black; }',
    'LICENSE': 'MIT',
    'src/app.js': "new Worker(new URL('./workers/probe-worker.js', import.meta.url));",
    'src/workers/probe-worker.js': 'self.onmessage = () => {};',
    'src/analysis/probe-kernel.mjs': 'export default () => new URL("probe-kernel.wasm", import.meta.url);',
    'src/analysis/probe-kernel.wasm': new Uint8Array([0, 97, 115, 109]),
    'examples/sample.cfg': 'example data',
  };
  await mkdir(join(root, 'licenses'), { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  await cp(new URL('../_headers', import.meta.url), join(root, '_headers'));
}

async function server(root) {
  const child = spawn(process.execPath, [serveScript, root, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill(); reject(new Error(`Preview startup timed out: ${stderr}`));
    }, 10_000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/AlloyView: (http:\/\/(?:localhost|127\.0\.0\.1):\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1].replace('localhost', '127.0.0.1')); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}: ${stderr}`)); });
  });
  return { url, async close() {
    if (child.exitCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  } };
}

test('production emits immutable headers for only its content hash and preserves isolation at a project subpath', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'alloyview-cache-headers-'));
  const root = join(temporary, 'project'), out = join(temporary, 'dist');
  try {
    await fixture(root);
    const first = await buildSite(root, out);
    const headers = await readFile(join(out, '_headers'), 'utf8');
    assert.equal(headers.includes('__ALLOYVIEW_BUILD_ID__'), false);
    assert.ok(headers.includes(`/assets/${first.buildId}/*\n  Cache-Control: ${immutable}`));
    assert.ok(headers.includes(`/:site/assets/${first.buildId}/*\n  Cache-Control: ${immutable}`));
    assert.ok(headers.includes('/index.html\n  Cache-Control: no-cache'));
    assert.ok(headers.includes('/:site/index.html\n  Cache-Control: no-cache'));
    for (const name of ['Opener-Policy: same-origin', 'Embedder-Policy: require-corp', 'Resource-Policy: same-origin']) {
      assert.ok(headers.includes(`Cross-Origin-${name}`));
    }
    const immutableRoutes = headers.split('\n').flatMap((line, index, lines) =>
      line.includes(`Cache-Control: ${immutable}`) ? [lines[index - 1]] : []);
    assert.deepEqual(immutableRoutes, [`/assets/${first.buildId}/*`, `/:site/assets/${first.buildId}/*`]);
    assert.ok(immutableRoutes.every(route => (route.match(/\*/g) ?? []).length === 1));
    assert.equal((await buildSite(root, out)).buildId, first.buildId);
    await writeFile(join(root, '_headers'), (await readFile(join(root, '_headers'), 'utf8')).replace('max-age=31536000', 'max-age=31535999'));
    const second = await buildSite(root, out);
    assert.notEqual(second.buildId, first.buildId);
    assert.ok((await readFile(join(out, '_headers'), 'utf8')).includes(`/assets/${second.buildId}/*`));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('preview caches complete hashed runtime assets but revalidates source compatibility, HTML and errors under nested prefixes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'alloyview-preview-cache-'));
  const root = join(temporary, 'project'), out = join(temporary, 'site');
  let preview;
  try {
    await fixture(root);
    const { buildId } = await buildSite(root, out);
    await mkdir(join(out, 'assets/aaaaaaaaaaaaaaaa/src'), { recursive: true });
    await writeFile(join(out, 'assets/aaaaaaaaaaaaaaaa/src/not-a-build.js'), 'unversioned impostor');
    await writeFile(join(out, 'assets/aaaaaaaaaaaaaaaa/runtime-manifest.json'), '{}');
    await mkdir(join(out, 'assets/not-a-hash'), { recursive: true });
    await writeFile(join(out, 'assets/not-a-hash/probe.wasm'), new Uint8Array([0, 97, 115, 109]));
    const webRoot = join(temporary, 'web');
    for (const prefix of ['AlloyView', 'nested/viewer']) {
      await cp(out, join(webRoot, prefix), { recursive: true });
    }
    preview = await server(webRoot);
    const runtimeFiles = ['src/app.js', 'src/workers/probe-worker.js', 'src/analysis/probe-kernel.wasm',
      'src/analysis/probe-kernel.mjs', 'styles.css', 'examples/sample.cfg', 'runtime-manifest.json'];
    for (const prefix of ['AlloyView', 'nested/viewer']) {
      for (const path of runtimeFiles) {
        const response = await fetch(`${preview.url}/${prefix}/assets/${buildId}/${path}?visit=2`);
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get('cache-control'), immutable, path);
        assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
        assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
        assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
        assert.ok((await response.arrayBuffer()).byteLength > 0);
      }
      for (const path of ['', 'index.html', 'src/app.js', 'src/analysis/probe-kernel.wasm', 'styles.css',
        'assets/aaaaaaaaaaaaaaaa/src/not-a-build.js', 'assets/not-a-hash/probe.wasm']) {
        const response = await fetch(`${preview.url}/${prefix}/${path}`);
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get('cache-control'), 'no-store', path);
        await response.arrayBuffer();
      }
      const missing = await fetch(`${preview.url}/${prefix}/assets/${buildId}/missing-worker.js`);
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('cache-control'), 'no-store');
      await missing.arrayBuffer();
      const head = await fetch(`${preview.url}/${prefix}/assets/${buildId}/src/analysis/probe-kernel.wasm`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('cache-control'), immutable);
      assert.equal(head.headers.get('content-type'), 'application/wasm');
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
    await preview.close();
    preview = await server(root);
    const development = await fetch(`${preview.url}/src/app.js`);
    assert.equal(development.headers.get('cache-control'), 'no-store');
    await development.arrayBuffer();
  } finally {
    await preview?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
