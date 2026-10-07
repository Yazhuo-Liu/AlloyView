import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildSite } from '../scripts/build.mjs';

test('production versions the whole module graph and works at a Pages subpath', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'alloyview-build-'));
  const root = join(temporary, 'project');
  const out = join(temporary, 'dist');
  try {
    for (const entry of ['src/workers', 'src/analysis', 'src/asserts/logo', 'examples', 'wasm', 'licenses']) {
      await mkdir(join(root, entry), { recursive: true });
    }
    await writeFile(join(root, 'index.html'), '<head><link href="./styles.css"><img src="./src/asserts/logo/light.svg"></head><script src="./src/app.js"></script>');
    await writeFile(join(root, 'styles.css'), 'body { color: black; }');
    await writeFile(join(root, 'LICENSE'), 'MIT');
    await writeFile(join(root, 'src/app.js'), "import './worker-client.js';");
    await writeFile(join(root, 'src/worker-client.js'), "new Worker(new URL('./workers/structure-worker.js', import.meta.url));");
    await writeFile(join(root, 'src/workers/structure-worker.js'), 'self.onmessage = () => {};');
    await writeFile(join(root, 'src/asserts/logo/light.svg'), '<svg/>');
    await writeFile(join(root, 'examples/test.cfg'), 'example');
    await writeFile(join(root, 'licenses/PTM-MIT.txt'), 'PTM notice');
    await writeFile(join(root, 'src/analysis/ptm-kernel.mjs'), "new URL('ptm-kernel.wasm', import.meta.url);");
    await writeFile(join(root, 'src/analysis/ptm-kernel.wasm'), new Uint8Array([0, 97, 115, 109]));

    const first = await buildSite(root, out);
    assert.equal((await buildSite(root, out)).buildId, first.buildId);
    const html = await readFile(join(out, 'index.html'), 'utf8');
    assert.ok(html.includes(`${first.assetPrefix}src/app.js`));
    const base = new URL('https://example.github.io/AlloyView/');
    const appUrl = new URL(`${first.assetPrefix}src/app.js`, base);
    const workerUrl = new URL('./workers/structure-worker.js', new URL('./worker-client.js', appUrl));
    const exampleUrl = new URL('../examples/test.cfg', appUrl);
    const ptmUrl = new URL('./analysis/ptm-kernel.wasm', appUrl);
    for (const url of [appUrl, workerUrl, exampleUrl, ptmUrl, new URL(`${first.assetPrefix}src/asserts/logo/light.svg`, base)]) {
      assert.ok(url.pathname.startsWith(`/AlloyView/assets/${first.buildId}/`));
      await access(resolve(out, url.pathname.replace('/AlloyView/', '')));
    }
    assert.equal(html.includes('src="./src/'), false);
    assert.equal(await readFile(join(out, 'licenses/PTM-MIT.txt'), 'utf8'), 'PTM notice');
    // Cached pre-versioning HTML must also keep loading during the transition.
    for (const entry of ['src/app.js', 'src/worker-client.js', 'src/workers/structure-worker.js', 'examples/test.cfg', 'styles.css']) {
      await access(join(out, entry));
    }

    // A change only to the Worker must invalidate app and client URLs too.
    await writeFile(join(root, 'src/workers/structure-worker.js'), 'self.onmessage = () => { /* v2 */ };');
    const second = await buildSite(root, out);
    assert.notEqual(first.buildId, second.buildId);

    // Changing just the compiled PTM binary must also invalidate the module graph.
    await writeFile(join(root, 'src/analysis/ptm-kernel.wasm'), new Uint8Array([0, 97, 115, 109, 1]));
    assert.notEqual((await buildSite(root, out)).buildId, second.buildId);

    await writeFile(join(root, 'wasm/coordination.mjs'), 'export default {};');
    await writeFile(join(root, 'wasm/coordination.wasm'), new Uint8Array([0, 97, 115, 109]));
    const withWasm = await buildSite(root, out);
    await access(join(out, 'assets', withWasm.buildId, 'wasm/coordination.mjs'));
    await access(join(out, 'assets', withWasm.buildId, 'wasm/coordination.wasm'));

    // Cloudflare reads policy from the output root, including for Workers and
    // Wasm. Changing that policy must invalidate cached runtime responses too.
    const headers = '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n';
    await writeFile(join(root, '_headers'), headers);
    const isolated = await buildSite(root, out);
    assert.notEqual(isolated.buildId, withWasm.buildId);
    assert.equal(await readFile(join(out, '_headers'), 'utf8'), headers);
    assert.equal((await buildSite(root, out)).buildId, isolated.buildId);
    await assert.rejects(access(join(out, 'assets', isolated.buildId, '_headers')), { code: 'ENOENT' });
    await writeFile(join(root, '_headers'), headers.replace('require-corp', 'credentialless'));
    assert.notEqual((await buildSite(root, out)).buildId, isolated.buildId);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
