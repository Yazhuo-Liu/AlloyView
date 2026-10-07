import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createExampleCatalog, serializeExampleCatalog } from './example-catalog.mjs';

const root = resolve(import.meta.dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.cfg': 'text/plain', '.dump': 'text/plain', '.wgsl': 'text/plain', '.wasm': 'application/wasm' };

/** Launch a secure localhost page and exercise the real browser WebGPU API.
 * Software mode is explicit: its timings never represent physical GPU speed.
 */
export async function withWebGpuBrowser(run, { software = true, isolated = false } = {}) {
  const chromePath = process.env.CHROME_PATH ?? [
    '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
  assert.ok(chromePath, 'Install Chrome/Chromium or set CHROME_PATH.');
  assert.equal(typeof WebSocket, 'function', 'Browser GPU scripts require Node 22 or newer with built-in WebSocket.');
  const additionalArguments = process.env.ALLOYVIEW_CHROME_ARGS ? JSON.parse(process.env.ALLOYVIEW_CHROME_ARGS) : [];
  assert.ok(Array.isArray(additionalArguments) && additionalArguments.every((argument) => typeof argument === 'string'),
    'ALLOYVIEW_CHROME_ARGS must be a JSON array of Chromium flags.');
  const server = createServer(async (request, response) => {
    // Most browser checks deliberately reproduce GitHub Pages, which does not
    // provide isolation headers. Opt in only for shared-memory Wasm checks.
    if (isolated) {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/AlloyView/__gpu_test__.html') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>AlloyView WebGPU validation</title>');
      return;
    }
    if (pathname === '/AlloyView/examples/manifest.json') {
      try {
        const manifest = serializeExampleCatalog(await createExampleCatalog(root));
        response.writeHead(200, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store' });
        response.end(manifest);
      } catch (error) {
        console.error('Example catalog failed:', error.message);
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end('Example catalog failed');
      }
      return;
    }
    const relative = pathname.replace(/^\/AlloyView\//, '');
    const path = resolve(root, relative);
    try {
      if (!pathname.startsWith('/AlloyView/') || !path.startsWith(`${root}${sep}`)) throw new Error('Invalid path');
      const bytes = await readFile(path);
      response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const profile = await mkdtemp(resolve(tmpdir(), 'alloyview-webgpu-'));
  // ANGLE can otherwise try to connect to an inherited SSH/X11 DISPLAY even
  // with Ozone headless, preventing the Vulkan GPU process from initializing.
  const { DISPLAY: ignoredDisplay, ...environment } = process.env;
  const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu',
    '--remote-debugging-port=0', '--remote-allow-origins=*', '--ozone-platform=headless',
    ...(software ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader']
      : process.platform === 'linux' ? ['--enable-gpu', '--use-angle=vulkan',
        '--enable-features=Vulkan', '--disable-vulkan-surface'] : ['--enable-gpu']),
    ...additionalArguments, `--user-data-dir=${profile}`, 'about:blank',
  ], { env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErrors = '';
  chrome.stderr.on('data', (chunk) => { chromeErrors = (chromeErrors + chunk).slice(-8000); });
  let websocket;
  const pending = new Map();
  try {
    const portFile = resolve(profile, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 300 && !existsSync(portFile); attempt += 1) await delay(50);
    assert.ok(existsSync(portFile), `Chrome did not start: ${chromeErrors}`);
    const port = (await readFile(portFile, 'utf8')).split('\n')[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const tab = tabs.find((entry) => entry.type === 'page' && entry.url === 'about:blank');
    websocket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((done, reject) => {
      websocket.addEventListener('open', done, { once: true });
      websocket.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const pageErrors = [];
    websocket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    function call(method, parameters = {}, timeoutMs = 180_000) {
      const id = ++nextId;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, timeoutMs);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        websocket.send(JSON.stringify({ id, method, params: parameters }));
      });
    }
    async function evaluate(expression, { timeoutMs = 180_000 } = {}) {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    }
    await call('Runtime.enable');
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/AlloyView/__gpu_test__.html` });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate('document.readyState === "complete" && location.pathname.endsWith("__gpu_test__.html")')) break;
      await delay(25);
    }
    const adapter = await evaluate(`(async () => {
      if (!navigator.gpu) return { available: false, reason: 'This browser does not expose WebGPU.' };
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return { available: false, reason: 'WebGPU found no usable adapter.' };
      const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
      return { available: true, vendor: info.vendor, architecture: info.architecture, device: info.device,
        description: info.description, isFallbackAdapter: Boolean(info.isFallbackAdapter ?? adapter.isFallbackAdapter),
        limits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension } };
    })()`);
    const diagnostics = `Chrome: ${chromePath}\nGPU initialization log:\n${chromeErrors || '(no stderr output)'}`;
    assert.ok(adapter.available, `${adapter.reason} Check the GPU driver and Vulkan support, or use --software to validate using SwiftShader.\n${diagnostics}`);
    const softwareAdapter = adapter.isFallbackAdapter
      || /swiftshader|software|llvmpipe/i.test(`${adapter.vendor} ${adapter.architecture} ${adapter.description}`);
    assert.ok(software || !softwareAdapter,
      `Hardware WebGPU requested, but Chrome selected a software adapter (${adapter.vendor} ${adapter.architecture}). Use --software for software validation.\n${diagnostics}`);
    const result = await run({ evaluate, call, adapter });
    assert.deepEqual(pageErrors, [], `Unhandled browser exceptions: ${JSON.stringify(pageErrors)}`);
    return result;
  } finally {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Browser closed.'));
    }
    websocket?.close();
    chrome.kill('SIGTERM');
    for (let attempt = 0; attempt < 100 && chrome.exitCode === null && chrome.signalCode === null; attempt += 1) await delay(25);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    // Chrome's helper processes can still be writing the profile briefly
    // after the browser exits; retry instead of failing a finished run.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export function useSoftwareAdapter(defaultValue = true) {
  if (process.argv.includes('--hardware')) return false;
  if (process.argv.includes('--software')) return true;
  return process.env.ALLOYVIEW_GPU_ADAPTER === 'software' ? true
    : process.env.ALLOYVIEW_GPU_ADAPTER === 'hardware' ? false : defaultValue;
}
