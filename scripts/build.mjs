import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Keep the Pages artifact limited to files used by the browser application.
// Repository documentation, tests, benchmarks, and native sources stay out of
// the public web root.
for (const entry of ['src', 'examples']) {
  await cp(resolve(root, entry), resolve(out, entry), { recursive: true });
}
for (const entry of ['index.html', 'styles.css', 'LICENSE']) {
  await cp(resolve(root, entry), resolve(out, entry));
}

// Include the optional Emscripten module only when it has actually been built.
try {
  await Promise.all([
    access(resolve(root, 'wasm/coordination.mjs')),
    access(resolve(root, 'wasm/coordination.wasm')),
  ]);
  await mkdir(resolve(out, 'wasm'));
  await Promise.all([
    cp(resolve(root, 'wasm/coordination.mjs'), resolve(out, 'wasm/coordination.mjs')),
    cp(resolve(root, 'wasm/coordination.wasm'), resolve(out, 'wasm/coordination.wasm')),
  ]);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const htmlPath = resolve(out, 'index.html');
const html = await readFile(htmlPath, 'utf8');
await writeFile(
  htmlPath,
  html.replace('</head>', '  <meta name="alloyview-build" content="production">\n</head>'),
);

console.log(`Built static site: ${out}`);
