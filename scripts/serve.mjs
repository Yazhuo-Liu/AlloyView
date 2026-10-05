import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { createDocumentationPages } from './build-docs.mjs';
import { createExampleCatalog, serializeExampleCatalog } from './example-catalog.mjs';

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

const server = createServer(async (request, response) => {
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
    'Cache-Control': 'no-store',
  });
  createReadStream(target).pipe(response);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`AlloyView: http://localhost:${server.address().port}`);
});
