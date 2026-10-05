import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocumentation } from './build-docs.mjs';
import { createExampleCatalog, serializeExampleCatalog } from './example-catalog.mjs';

const projectRoot = resolve(import.meta.dirname, '..');

export async function buildSite(root = projectRoot, out = resolve(root, 'dist')) {
  const entries = ['src', 'styles.css', 'licenses'];
  try {
    await access(resolve(root, 'examples'));
    entries.push('examples');
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const exampleManifest = serializeExampleCatalog(await createExampleCatalog(root));
  let includeDocumentation = false;
  try {
    await access(resolve(root, 'docs/site.css'));
    entries.push('docs');
    includeDocumentation = true;
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const wasmEntries = ['wasm/coordination.mjs', 'wasm/coordination.wasm'];
  try {
    await Promise.all(wasmEntries.map((entry) => access(resolve(root, entry))));
    entries.push(...wasmEntries);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  // Every import, Worker and asset lives in the same content-versioned tree.
  // Versioning only app.js leaves its imports vulnerable to stale Pages caches.
  const hash = createHash('sha256');
  async function hashEntry(entry) {
    const path = resolve(root, entry);
    const children = await readdir(path, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (children) {
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
        await hashEntry(`${entry}/${child.name}`);
      }
    } else {
      hash.update(entry).update('\0').update(await readFile(path)).update('\0');
    }
  }
  for (const entry of [...entries, 'index.html']) await hashEntry(entry);
  hash.update('examples/manifest.json').update('\0').update(exampleManifest).update('\0');
  const buildId = hash.digest('hex').slice(0, 16);
  const assetPrefix = `./assets/${buildId}/`;
  const runtimeRoot = resolve(out, 'assets', buildId);

  await rm(out, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  for (const entry of entries) {
    // Keep the earlier unversioned entrypoints available while an old index.html
    // can still be cached. New HTML only uses the versioned tree above.
    for (const destination of [runtimeRoot, out]) {
      const target = resolve(destination, entry);
      await mkdir(resolve(target, '..'), { recursive: true });
      await cp(resolve(root, entry), target, { recursive: true });
    }
  }
  for (const destination of [runtimeRoot, out]) {
    await mkdir(resolve(destination, 'examples'), { recursive: true });
    await writeFile(resolve(destination, 'examples/manifest.json'), exampleManifest);
  }
  await cp(resolve(root, 'LICENSE'), resolve(out, 'LICENSE'));
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  await writeFile(resolve(out, 'index.html'), html
    .replaceAll('./src/', `${assetPrefix}src/`)
    .replace('./styles.css', `${assetPrefix}styles.css`)
    .replace('</head>', `  <meta name="alloyview-build" content="${buildId}">\n  </head>`));
  if (includeDocumentation) await buildDocumentation(root, resolve(out, 'docs'));
  return { out, buildId, assetPrefix };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, buildId } = await buildSite();
  console.log(`Built static site: ${out} (${buildId})`);
}
