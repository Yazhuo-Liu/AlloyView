import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildDocumentation, createDocumentationPages, DOC_GUIDES, renderMarkdown } from '../scripts/build-docs.mjs';
import { FEATURE_HELP } from '../src/feature-help.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('documentation links resolve from the viewer and every page at a Pages subpath', async () => {
  const pages = await createDocumentationPages(root);
  const base = new URL('https://example.github.io/AlloyView/docs/');
  for (const feature of Object.values(FEATURE_HELP)) {
    const page = `features/${feature.page}.html`;
    assert.ok(pages.has(page), `${feature.title} documentation exists`);
    const html = pages.get(page);
    assert.ok(html.includes('<h1'), `${feature.title} has a document heading`);
    assert.ok(html.includes('Implementation'), `${feature.title} explains its implementation`);
  }
  for (const [page, html] of pages) {
    if (!page.endsWith('.html')) continue;
    const source = new URL(page, base);
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const target = new URL(href.replaceAll('&amp;', '&'), source);
      if (target.origin !== base.origin) continue;
      assert.ok(target.pathname.startsWith('/AlloyView/'), `${page}: ${href} retains repository prefix`);
      const relative = target.pathname.slice('/AlloyView/docs/'.length);
      if (target.pathname === '/AlloyView/') continue;
      if (pages.has(relative)) continue;
      await access(join(root, 'docs', relative));
    }
  }
});

test('Markdown renders readable code, tables, links and escaped raw HTML', () => {
  const html = renderMarkdown('# Heading\n\n| Mode | Result |\n| --- | --- |\n| **Fit** | `F` |\n\n```js\nconst x = a < b;\n```\n\n<script>bad()</script> [unsafe](javascript:alert)\n\n[Guide](../USER_GUIDE.md#run-locally)');
  assert.ok(html.includes('<h1 id="heading">Heading</h1>'));
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<strong>Fit</strong>'));
  assert.ok(html.includes('a &lt; b;'));
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('href="#"'));
  assert.ok(html.includes('href="../user-guide.html#run-locally"'));
});

test('build writes standalone documentation pages, stylesheet and relative viewer navigation', async () => {
  const out = await mkdtemp(join(tmpdir(), 'alloyview-docs-'));
  try {
    const result = await buildDocumentation(root, out);
    assert.equal(result.pages, Object.keys(FEATURE_HELP).length + DOC_GUIDES.length + 1);
    assert.ok((await readFile(join(out, 'dxa-review.html'), 'utf8')).includes('features/dislocations.html'));
    assert.ok((await readFile(join(out, 'features/dislocations.html'), 'utf8')).includes('WebAssembly Worker'));
    assert.ok((await readFile(join(out, 'index.html'), 'utf8')).includes('href="../"'));
    assert.ok((await readFile(join(out, 'features/vectors.html'), 'utf8')).includes('href="../../"'));
    assert.ok((await readFile(join(out, 'features/vectors.html'), 'utf8')).includes('display tool'));
    const displacement = await readFile(join(out, 'features/displacement.html'), 'utf8');
    assert.ok(displacement.includes('row order'));
    assert.ok(displacement.includes('extensions.displacement'));
    await access(join(out, 'styles.css'));
  } finally { await rm(out, { recursive: true, force: true }); }
});
