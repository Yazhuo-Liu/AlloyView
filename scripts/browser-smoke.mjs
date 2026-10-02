import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// No browser automation dependency: Node 24's WebSocket talks directly to CDP.
const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const chromePath = process.env.CHROME_PATH ?? [
  '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
assert.ok(chromePath, 'Install Chrome/Chromium or set CHROME_PATH.');
assert.ok(existsSync(resolve(dist, 'index.html')), 'Run npm run build first.');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.cfg': 'text/plain', '.dump': 'text/plain', '.wasm': 'application/wasm', '.mjs': 'text/javascript' };
const requests = [];
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  requests.push(pathname);
  const path = resolve(dist, pathname.replace(/^\/AlloyView\//, '') || 'index.html');
  try {
    if (!pathname.startsWith('/AlloyView/') || !path.startsWith(`${dist}${sep}`)) throw new Error('Invalid path');
    const bytes = await readFile(path);
    // Deliberately omit COOP/COEP, as on GitHub Pages.
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const profile = await mkdtemp(resolve(tmpdir(), 'alloyview-chrome-'));
const { DISPLAY: ignoredDisplay, ...environment } = process.env;
const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--remote-debugging-port=0', '--remote-allow-origins=*',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader-webgl',
  '--ozone-platform=headless', '--disable-features=Vulkan',
  `--user-data-dir=${profile}`, 'about:blank',
], { env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErrors = '';
chrome.stderr.on('data', (chunk) => { chromeErrors = (chromeErrors + chunk).slice(-8000); });
let websocket;
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
  const pending = new Map();
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
  function call(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 30_000);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      websocket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
  async function waitFor(expression, label) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${label}: ${await evaluate('document.getElementById("toast")?.textContent')}`);
  }
  async function screenshot(name) {
    if (!process.argv.includes('--screenshots')) return;
    const result = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(root, `docs/images/alloyview-${name}.png`), Buffer.from(result.data, 'base64'));
  }
  async function checkTextContrast(selectors, minimum = 7) {
    const samples = await evaluate(`(() => {
      const rgb = value => {
        const channels = value.match(/[\\d.]+/g).map(Number);
        return [...channels.slice(0, 3), channels[3] ?? 1];
      };
      const blend = (front, back) => front.slice(0, 3).map((channel, i) => channel * front[3] + back[i] * (1 - front[3]));
      const luminance = color => color.map(channel => {
        const value = channel / 255;
        return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      }).reduce((total, channel, i) => total + channel * [.2126, .7152, .0722][i], 0);
      return ${JSON.stringify(selectors)}.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.textContent.trim() || element.value).map(element => {
        let background = [255, 255, 255], opacity = 1;
        const ancestors = [];
        for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
        for (const node of ancestors) {
          const style = getComputedStyle(node);
          background = blend(rgb(style.backgroundColor), background);
          opacity *= Number(style.opacity);
        }
        const foreground = rgb(getComputedStyle(element).color);
        foreground[3] *= opacity;
        const light = [luminance(blend(foreground, background)), luminance(background)].sort((a, b) => a - b);
        return { selector, text: (element.textContent.trim() || element.value).slice(0, 60), ratio: (light[1] + .05) / (light[0] + .05) };
      }));
    })()`);
    assert.ok(samples.length > 0, 'Text contrast checks must find visible UI text');
    for (const sample of samples) assert.ok(sample.ratio >= minimum, `${sample.selector} (${sample.text}) contrast ${sample.ratio.toFixed(2)} < ${minimum}`);
  }
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/AlloyView/` });
  await waitFor('document.readyState === "complete" && location.pathname === "/AlloyView/"', 'page load');
  await waitFor('document.getElementById("brand-logo").src.endsWith("AlloyView_logo_dark.svg")', 'app initialization');
  assert.equal(await evaluate('crossOriginIsolated'), false);

  // Check the initial page as well as the loaded viewer: disabled controls must
  // remain readable, and the central mark must be the supplied project logo.
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.getElementById('theme-${theme}').click()`);
    await waitFor('document.querySelector(".empty-logo").complete && document.querySelector(".empty-logo").naturalWidth > 0 && document.getElementById("brand-logo").complete', 'home logos');
    await delay(150); // Let the 120 ms button background transitions finish.
    assert.ok((await evaluate('document.querySelector(".empty-logo").src')).endsWith('AlloyView_logo_only.png'));
    await checkTextContrast(['.empty-state h1', '.empty-copy', '.format-note', '.privacy-badge small', '.field > span:first-child', '.help', '.selection-empty']);
    await checkTextContrast(['.view-presets > button', '.projection-switch button', '.viewport-toggle', '#coordinate-mode', '#cutoff', '#run-analysis', '.display-options label', '#empty-open'], 4.5);
    await evaluate(`document.getElementById('open-examples').click()`);
    await checkTextContrast(['.source-dialog-summary', '.source-option small']);
    await checkTextContrast(['.source-option-kind'], 4.5);
    await evaluate(`document.getElementById('source-dialog-close').click()`);
    await screenshot(`home-${theme}`);
  }
  await evaluate('document.getElementById("theme-light").click()');

  // Load all bundled sources through the actual Examples UI.
  for (const [name, frames] of [['fcc-vacancy.cfg', 1], ['bcc-trajectory.dump', 2], ['fixed_end_climb/', 40]]) {
    await evaluate(`document.getElementById('open-examples').click(); [...document.querySelectorAll('.source-option')].find(button => button.textContent.includes(${JSON.stringify(name)})).click();`);
    await waitFor(`document.getElementById('empty-state').hidden && document.getElementById('loading').hidden && document.getElementById('file-name').textContent.includes(${JSON.stringify(name)})`, name);
    assert.equal(await evaluate('Number(document.getElementById("frame-count").textContent)'), frames);
    if (frames > 1) {
      await evaluate('document.getElementById("frame-last").click()');
      await waitFor(`document.getElementById('frame-label').textContent === '${frames} / ${frames}' && document.getElementById('loading').hidden`, 'last trajectory frame');
    }
  }

  // Use Chrome's native file input, rather than constructing a fetched example.
  const { root: domRoot } = await call('DOM.getDocument');
  const { nodeId } = await call('DOM.querySelector', { nodeId: domRoot.nodeId, selector: '#file-input' });
  for (const [name, atoms, frames] of [['bcc-trajectory.dump', 16, 2], ['fcc-vacancy.cfg', 31, 1]]) {
    await call('DOM.setFileInputFiles', { nodeId, files: [resolve(root, `examples/${name}`)] });
    await waitFor(`document.getElementById('file-name').textContent === '${name}' && document.getElementById('loading').hidden`, 'local file');
    assert.equal(await evaluate('Number(document.getElementById("atom-count").textContent)'), atoms);
    assert.equal(await evaluate('Number(document.getElementById("frame-count").textContent)'), frames);
  }

  // A cutoff edit starts analysis without a separate Apply/Calculate click.
  await evaluate(`(() => { const cutoff = document.getElementById('cutoff'); cutoff.value = '2'; cutoff.dispatchEvent(new Event('input')); })()`);
  await waitFor('document.getElementById("analysis-state").classList.contains("ready")', 'coordination analysis');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".legend-range span")].map(span => Number(span.textContent))'), [0, 0]);
  await evaluate(`(() => { const cutoff = document.getElementById('cutoff'); cutoff.value = '3.3'; cutoff.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.querySelector(".legend-range")?.textContent === "1112" && document.getElementById("loading").hidden', 'changed cutoff');

  // Delay real analyses so rapid edits exercise queueing and stale-result handling.
  const queued = await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { CoordinationPool } = await import(new URL('./analysis/coordination-pool.js', appUrl));
    const original = CoordinationPool.prototype.analyze;
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    let active = 0, maximumActive = 0;
    const cutoffs = [];
    CoordinationPool.prototype.analyze = async function(frame, cutoff, options) {
      active += 1; maximumActive = Math.max(maximumActive, active); cutoffs.push(cutoff);
      try { await pause(500); return await original.call(this, frame, cutoff, options); }
      finally { active -= 1; }
    };
    const edit = value => {
      const field = document.getElementById('cutoff'); field.value = String(value);
      field.dispatchEvent(new Event('change'));
    };
    const range = () => [...document.querySelectorAll('.legend-range span')].map(span => Number(span.textContent));
    try {
      edit(2); await pause(80);
      edit(3.5); await pause(80);
      edit(2.5);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await pause(30);
        if (active === 0 && document.getElementById('loading').hidden && range().join(',') === '0,0') break;
      }
      const latestRange = range();
      const firstCutoffs = [...cutoffs];
      edit(3.3);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await pause(30);
        if (active === 0 && document.getElementById('loading').hidden && range().join(',') === '11,12') break;
      }
      // Switching back to the currently cached cutoff cancels an older result.
      edit(2); await pause(80); edit(3.3); await pause(600);
      return { maximumActive, firstCutoffs, latestRange, cachedRange: range(), loading: !document.getElementById('loading').hidden, disabled: document.getElementById('run-analysis').disabled };
    } finally { CoordinationPool.prototype.analyze = original; }
  })()`);
  assert.equal(queued.maximumActive, 1);
  assert.deepEqual(queued.firstCutoffs, [2, 2.5]);
  assert.deepEqual(queued.latestRange, [0, 0]);
  assert.deepEqual(queued.cachedRange, [11, 12]);
  assert.equal(queued.loading, false);
  assert.equal(queued.disabled, false);

  // Type a decimal one character at a time: live application must not rewrite
  // the active input or interpret an empty field as zero.
  await evaluate('document.querySelector(".legend-controls input[type=number]").focus(); document.querySelector(".legend-controls input[type=number]").select();');
  for (const text of ['1', '1', '.', '5']) await call('Input.insertText', { text });
  assert.equal(await evaluate('document.querySelector(".legend-controls input[type=number]").valueAsNumber'), 11.5);
  assert.equal(await evaluate('document.querySelector(".legend-range span").textContent'), '11.5');
  await evaluate(`(() => { const minimum = document.querySelector('.legend-controls input[type=number]'); minimum.value = ''; minimum.dispatchEvent(new Event('input')); })()`);
  assert.equal(await evaluate('document.querySelector(".legend-range span").textContent'), '11.5');
  await evaluate(`document.querySelector('.legend-actions button').click()`);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".legend-range span")].map(span => Number(span.textContent))'), [11, 12]);

  // Drag the real separator in both directions; the WebGL canvas must follow.
  const initialWidth = await evaluate('document.getElementById("sidebar").getBoundingClientRect().width');
  const separator = await evaluate(`(() => { const rect = document.getElementById('sidebar-resizer').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + 200 }; })()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...separator, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: separator.x - 120, y: separator.y, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: separator.x - 120, y: separator.y, button: 'left', clickCount: 1 });
  assert.equal(await evaluate('document.getElementById("sidebar").getBoundingClientRect().width'), initialWidth + 120);
  assert.equal(await evaluate('document.body.classList.contains("is-resizing-sidebar")'), false);
  await waitFor('Math.abs(document.getElementById("viewport").width - document.getElementById("viewport").clientWidth * devicePixelRatio) < 2', 'canvas resize');
  const widenedSeparator = { x: separator.x - 120, y: separator.y };
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...widenedSeparator, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: widenedSeparator.x + 60, y: widenedSeparator.y, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: widenedSeparator.x + 60, y: widenedSeparator.y, button: 'left', clickCount: 1 });
  assert.equal(await evaluate('document.getElementById("sidebar").getBoundingClientRect().width'), initialWidth + 60);
  await evaluate(`document.getElementById('sidebar-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  assert.equal(await evaluate('document.getElementById("sidebar").getBoundingClientRect().width'), initialWidth);

  // Save documentation views with scalar colors and a smaller atom radius.
  await evaluate(`const radius = document.getElementById('radius-percent'); radius.value = '65'; radius.dispatchEvent(new Event('input')); document.getElementById('toast').hidden = true;`);
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.getElementById('theme-${theme}').click()`);
    await waitFor('document.getElementById("brand-logo").complete', 'theme logo');
    await delay(150);
    assert.equal(await evaluate('document.documentElement.dataset.theme'), theme);
    assert.ok((await evaluate('document.getElementById("brand-logo").src')).endsWith(theme === 'light' ? 'AlloyView_logo_dark.svg' : 'AlloyView_logo_light.svg'));
    await checkTextContrast(['.field > span:first-child', '.help', '.display-options label', '.legend-title', '.legend-range', '.legend-controls label', '.privacy-badge small']);
    await checkTextContrast(['.legend-actions button', '.view-presets button', '#run-analysis'], 4.5);
    await screenshot(theme);
  }

  // Decode real PNG blobs and examine alpha, including empty legend padding.
  const exports = await evaluate(`(async () => {
    const result = [];
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {};
    try {
      for (const mode of ['type', 'property:coordination']) {
        const color = document.getElementById('color-mode');
        color.value = mode; color.dispatchEvent(new Event('change'));
        if (color.value !== mode) throw new Error('Missing color mode: ' + mode);
        for (const includeBackground of [false, true]) {
          document.getElementById('png-background').checked = includeBackground;
          document.getElementById('png-legend').checked = true;
          const exported = await new Promise((resolve, reject) => {
            HTMLCanvasElement.prototype.toBlob = function(callback, type) {
              originalToBlob.call(this, async blob => {
                try {
                  const bitmap = await createImageBitmap(blob);
                  const canvas = document.createElement('canvas');
                  canvas.width = bitmap.width; canvas.height = bitmap.height;
                  const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
                  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                  const alpha = (x, y) => pixels[(y * canvas.width + x) * 4 + 3];
                  let content = 0;
                  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) content += 1;
                  const paddingY = canvas.height - 18 - (mode === 'type' ? 66 : 82) + 4;
                  callback(blob);
                  resolve({ mode, includeBackground, corner: alpha(0, 0), legendPadding: alpha(22, paddingY), content });
                } catch (error) { reject(error); }
              }, type);
            };
            document.getElementById('export-png').click();
          });
          result.push(exported);
        }
      }
    } finally {
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
      HTMLAnchorElement.prototype.click = originalClick;
    }
    return result;
  })()`);
  for (const exported of exports) {
    assert.equal(exported.corner, exported.includeBackground ? 255 : 0);
    if (!exported.includeBackground) assert.equal(exported.legendPadding, 0, `${exported.mode} legend has a background`);
    assert.ok(exported.content > 1000, 'Export must still contain atoms and legend');
  }
  const colors = await evaluate('[...document.querySelectorAll("[data-background]")].map(button => button.dataset.background)');
  assert.deepEqual(colors, ['#000000', '#ffffff', '#fff8e7', '#fff4c2']);
  // Theme persists on reload. A manually selected viewport color stays intact.
  await evaluate(`document.querySelector('[data-background="#fff8e7"]').click(); document.getElementById('theme-light').click();`);
  assert.equal(await evaluate('document.getElementById("background").value'), '#fff8e7');
  await evaluate(`document.getElementById('sidebar-resizer').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }));`);
  const savedSidebarWidth = await evaluate('document.getElementById("sidebar").getBoundingClientRect().width');
  await call('Page.reload');
  await waitFor('document.getElementById("theme-light").getAttribute("aria-pressed") === "true"', 'saved light theme');
  assert.equal(await evaluate('localStorage.getItem("alloyview-theme")'), 'light');
  assert.equal(await evaluate('document.getElementById("sidebar").getBoundingClientRect().width'), savedSidebarWidth);
  // On narrow screens controls stack below the viewport and the handle hides.
  await call('Emulation.setDeviceMetricsOverride', { width: 800, height: 1000, deviceScaleFactor: 1, mobile: false });
  await waitFor('getComputedStyle(document.getElementById("sidebar-resizer")).display === "none"', 'narrow layout');
  assert.ok(await evaluate('document.getElementById("sidebar").getBoundingClientRect().top >= document.getElementById("viewport").getBoundingClientRect().bottom'));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(requests.filter((path) => path.endsWith('.js')).every((path) => /^\/AlloyView\/assets\/[a-f0-9]+\//.test(path)));
  console.log('Browser smoke passed: Pages loading; trajectories; automatic cutoff/legend edits; latest-result queueing; draggable/persistent sidebar and narrow layout; home/viewer logos and text contrast in both themes; PNG transparency.');
  console.log(JSON.stringify(exports));
} finally {
  websocket?.close();
  chrome.kill();
  await new Promise((done) => chrome.exitCode !== null ? done() : chrome.once('exit', done));
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
