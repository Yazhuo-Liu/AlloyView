import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, relative as relativePath, resolve, sep } from 'node:path';
import { createDocumentationPages } from './build-docs.mjs';
import { createExampleCatalog, serializeExampleCatalog } from './lib/example-catalog.mjs';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 5173);
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.dump': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

function cacheControl(target) {
  // Preview can serve dist directly or through an arbitrary repository subpath.
  // A hash-shaped development directory alone is not proof of built assets:
  // check the site's generated entrypoint and runtime manifest as well.
  const relative = relativePath(root, target).split(sep).join('/');
  const match = relative.match(/^(.*\/)?assets\/([a-f0-9]{16})\/.+$/);
  if (!match) return 'no-store';
  const siteRoot = resolve(root, match[1] ?? '.');
  const manifest = resolve(siteRoot, 'assets', match[2], 'runtime-manifest.json');
  if (!existsSync(manifest) || !statSync(manifest).isFile()) return 'no-store';
  try {
    const html = readFileSync(resolve(siteRoot, 'index.html'), 'utf8');
    if (!html.includes(`<meta name="alloyview-build" content="${match[2]}">`)) return 'no-store';
  } catch { return 'no-store'; }
  return 'public, max-age=31536000, immutable';
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Invalid URL');
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const requested = resolve(root, relative);
  const target = existsSync(requested) && statSync(requested).isDirectory()
    ? resolve(requested, 'index.html')
    : requested;

  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');

  // Development discovers new examples on every request; preview uses the
  // manifest generated alongside its immutable production assets.
  if (pathname === '/examples/manifest.json' && !existsSync(requested)) {
    try {
      const manifest = serializeExampleCatalog(await createExampleCatalog(root));
      response.writeHead(200, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store' });
      response.end(manifest);
    } catch (error) {
      console.error('Example catalog failed:', error.message);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Example catalog failed');
    }
    return;
  }

  // The development tree keeps Markdown sources; render exactly the pages the
  // production build writes instead of committing duplicated generated HTML.
  if (pathname === '/docs') {
    response.writeHead(302, { Location: '/docs/' });
    response.end();
    return;
  }
  if (target.startsWith(`${root}${sep}`) && !existsSync(target)
      && pathname.startsWith('/docs/') && existsSync(resolve(root, 'docs/site.css'))) {
    try {
      const pages = await createDocumentationPages(root);
      const page = pathname === '/docs/' ? 'index.html' : pathname.slice('/docs/'.length);
      const content = pages.get(page);
      if (content !== undefined) {
        response.writeHead(200, { 'Content-Type': mime[extname(page)] ?? 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(content);
        return;
      }
    } catch (error) {
      console.error('Documentation rendering failed:', error.message);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Documentation rendering failed');
      return;
    }
  }

  if (!target.startsWith(`${root}${sep}`) || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': mime[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': cacheControl(target),
  });
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(target).pipe(response);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`AlloyView: http://localhost:${server.address().port}`);
});
