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
    throw new Error(`Timed out waiting for ${label}: ${await evaluate('document.getElementById("toast")?.textContent')} ${JSON.stringify(pageErrors)}`);
  }
  async function showTool(name) {
    await evaluate(`(() => {
      const panel = document.querySelector('[data-tool-panel="${name}"]');
      if (panel.hidden) document.querySelector('[data-tool-button="${name}"]').click();
    })()`);
  }
  async function reloadPage() {
    let cleanup;
    const loaded = new Promise((done, reject) => {
      const onMessage = ({ data }) => {
        if (JSON.parse(data).method === 'Page.loadEventFired') done();
      };
      const timer = setTimeout(() => reject(new Error('Timed out reloading page')), 30_000);
      websocket.addEventListener('message', onMessage);
      cleanup = () => { clearTimeout(timer); websocket.removeEventListener('message', onMessage); };
    });
    try { await Promise.all([call('Page.reload'), loaded]); }
    finally { cleanup(); }
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
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/AlloyView/` });
  await waitFor('document.readyState === "complete" && location.pathname === "/AlloyView/"', 'page load');
  await waitFor('document.getElementById("brand-logo").src.endsWith("AlloyView_logo_dark.svg")', 'app initialization');
  assert.equal(await evaluate('crossOriginIsolated'), false);
  assert.equal(await evaluate('document.querySelector("[data-tool-panel=display]").hidden'), false);
  assert.equal(await evaluate('[...document.querySelectorAll("[data-tool-panel]")].filter(panel => !panel.hidden).length'), 1);

  // Real 3D animation changes the rendered pixels without a CSS image transform.
  await waitFor('!document.getElementById("bcc-logo").hidden', '3D BCC logo');
  await evaluate(`(() => {
    window.logoDraws = 0;
    const original = WebGL2RenderingContext.prototype.drawElements;
    WebGL2RenderingContext.prototype.drawElements = function(...args) {
      if (this.canvas.id === 'bcc-logo') window.logoDraws += 1;
      return original.apply(this, args);
    };
  })()`);
  await waitFor('window.logoDraws > 2', 'logo rendering');
  const logoClip = await evaluate(`(() => { const rect = document.querySelector('.empty-logo').getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }; })()`);
  const firstLogo = await call('Page.captureScreenshot', { format: 'png', clip: logoClip });
  await delay(600);
  const rotatedLogo = await call('Page.captureScreenshot', { format: 'png', clip: logoClip });
  assert.notEqual(firstLogo.data, rotatedLogo.data, 'rotating BCC geometry must change the rendered image');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("bcc-logo")).transform'), 'none');
  // The homepage model rotates even if the OS requests reduced animation.
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reducedDraws = await evaluate('window.logoDraws');
  const reducedFirst = await call('Page.captureScreenshot', { format: 'png', clip: logoClip });
  await delay(600);
  const reducedRotated = await call('Page.captureScreenshot', { format: 'png', clip: logoClip });
  assert.ok(await evaluate('window.logoDraws') > reducedDraws + 2);
  assert.notEqual(reducedFirst.data, reducedRotated.data, 'reduced-motion settings must not freeze the BCC model');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });

  // Check initial and loaded views in both themes, including disabled controls.
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.getElementById('theme-${theme}').click()`);
    await waitFor('!document.getElementById("bcc-logo").hidden && document.getElementById("brand-logo").complete', 'home logos');
    await delay(150); // Let the 120 ms button background transitions finish.
    assert.equal(await evaluate('document.querySelector(".empty-logo-fallback").hidden'), true);
    await checkTextContrast(['.empty-state h1', '.empty-copy', '.format-note', '.privacy-badge small', '.field > span:first-child', '.help', '.selection-empty']);
    await checkTextContrast(['.view-presets > button', '.projection-switch button', '.viewport-toggle', '#coordinate-mode', '#cutoff', '#run-analysis', '#cna-mode', '#cna-cutoff', '#csp-neighbors', '#run-cna', '#run-csp', '#ptm-rmsd', '#run-ptm', '#run-strain', '#lattice-reset', '.analysis-state-controls .text-button', '.display-options label', '#empty-open'], 4.5);
    await evaluate(`document.getElementById('open-examples').click()`);
    await checkTextContrast(['.source-dialog-summary', '.source-option small']);
    await checkTextContrast(['.source-option-kind'], 4.5);
    await evaluate(`document.getElementById('source-dialog-close').click()`);
    await screenshot(`home-${theme}`);
  }
  await evaluate('document.getElementById("theme-light").click()');

  // Dropping on the homepage overlay or header must open a file, and closing
  // must resume the homepage scene without retaining the old source.
  assert.equal(await evaluate('document.getElementById("close-file").hidden'), true);
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { StructureWorkerClient } = await import(new URL('./worker-client.js', appUrl));
    const load = StructureWorkerClient.prototype.load;
    StructureWorkerClient.prototype.load = function(...args) {
      window.closeTestClient = this;
      const result = load.apply(this, args);
      if (!window.holdNextSource) return result;
      window.holdNextSource = false;
      return result.then(value => new Promise(resolve => {
        window.sourceResultHeld = true;
        window.releaseSource = () => resolve(value);
      }));
    };
  })()`);
  const dropPoint = await evaluate(`(() => {
    const rect = document.querySelector('.empty-copy').getBoundingClientRect();
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    if (document.elementFromPoint(point.x, point.y).id === 'viewport') throw new Error('drop test must hit the homepage overlay');
    return point;
  })()`);
  async function dropFiles(paths, point = dropPoint) {
    const data = { items: [], files: paths, dragOperationsMask: 1 };
    await call('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data });
    await waitFor('!document.getElementById("file-drop-overlay").hidden', 'file drag feedback');
    await call('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
    await call('Input.dispatchDragEvent', { type: 'drop', ...point, data });
  }
  async function checkHome() {
    await waitFor('!document.getElementById("empty-state").hidden && document.getElementById("loading").hidden', 'closed source homepage');
    assert.equal(await evaluate('document.getElementById("file-name").textContent'), 'No structure loaded');
    assert.equal(await evaluate('document.getElementById("atom-count").textContent'), '—');
    assert.equal(await evaluate('document.getElementById("close-file").hidden'), true);
    assert.equal(await evaluate('document.getElementById("legend").hidden'), true);
    assert.equal(await evaluate('document.getElementById("trajectory-section").hidden'), true);
    assert.equal(await evaluate('document.getElementById("export-png").disabled'), true);
    assert.equal(await evaluate('window.closeTestClient.worker === null && window.closeTestClient.pending.size === 0'), true);
  }
  await dropFiles([resolve(root, 'examples/fcc-vacancy.cfg')]);
  await waitFor('document.getElementById("file-name").textContent === "fcc-vacancy.cfg" && document.getElementById("loading").hidden && document.getElementById("empty-state").hidden', 'homepage file drop');
  assert.equal(await evaluate('document.getElementById("frame-count").textContent'), '1');
  assert.equal(await evaluate('document.getElementById("close-file").hidden'), false);
  const closedDraws = await evaluate('window.logoDraws');
  await evaluate('document.getElementById("close-file").click()');
  await checkHome();
  await waitFor(`window.logoDraws > ${closedDraws} + 2`, 'logo resumes after closing');
  const headerPoint = await evaluate(`(() => { const rect = document.getElementById('brand-logo').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`);
  await dropFiles([resolve(root, 'examples/fixed_end_climb/replica.0.cfg'), resolve(root, 'examples/fixed_end_climb/replica.1.cfg')], headerPoint);
  await waitFor('document.getElementById("source-dialog").open', 'multiple dropped files');
  assert.equal(await evaluate('document.getElementById("source-dialog-title").textContent'), 'Choose a file to open');
  assert.equal(await evaluate('document.querySelectorAll(".source-option:not(:disabled)").length'), 2);
  await evaluate(`[...document.querySelectorAll('.source-option')].find(button => button.textContent.includes('replica.1.cfg')).click()`);
  await waitFor('document.getElementById("empty-state").hidden && document.getElementById("loading").hidden', 'single numbered CFG drop');
  assert.equal(await evaluate('document.getElementById("frame-count").textContent'), '1');
  await evaluate('document.getElementById("close-file").click()');
  await checkHome();

  // A completed parser response that reaches the UI after close stays closed.
  await evaluate('window.holdNextSource = true; window.sourceResultHeld = false');
  await dropFiles([resolve(root, 'examples/fcc-vacancy.cfg')]);
  await waitFor('window.sourceResultHeld', 'held source response');
  await evaluate('document.getElementById("close-file").click(); window.releaseSource()');
  await delay(100);
  await checkHome();

  // Closing also aborts fetched examples; guard against a fetch that ignores
  // its AbortSignal and completes later (e.g. an already cached response).
  await evaluate(`(() => {
    window.sourceOriginalFetch = window.fetch;
    window.fetch = (url, options) => {
      if (!String(url).endsWith('fcc-vacancy.cfg')) return window.sourceOriginalFetch(url, options);
      window.heldFetchSignal = options.signal;
      return new Promise(resolve => {
        window.releaseExampleFetch = async () => resolve(await window.sourceOriginalFetch(url));
      });
    };
    document.getElementById('open-examples').click();
    [...document.querySelectorAll('.source-option')].find(button => button.textContent.includes('fcc-vacancy.cfg')).click();
  })()`);
  await waitFor('Boolean(window.releaseExampleFetch)', 'held example request');
  await evaluate('document.getElementById("close-file").click()');
  assert.equal(await evaluate('window.heldFetchSignal.aborted'), true);
  await evaluate('window.releaseExampleFetch()');
  await delay(100);
  await checkHome();
  await evaluate('window.fetch = window.sourceOriginalFetch');

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

  const stoppedLogoDraws = await evaluate('window.logoDraws');
  await delay(100);
  assert.equal(await evaluate('window.logoDraws'), stoppedLogoDraws, 'loading a structure must stop the hidden homepage animation');

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
  await showTool('coordination');
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
  assert.equal(await evaluate('document.getElementById("png-axes").checked'), false);
  const axesExport = await evaluate(`(async () => {
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const originalClick = HTMLAnchorElement.prototype.click;
    const samples = [];
    HTMLAnchorElement.prototype.click = () => {};
    document.getElementById('show-axes').checked = false;
    document.getElementById('show-axes').dispatchEvent(new Event('change'));
    document.getElementById('png-background').checked = false;
    document.getElementById('png-legend').checked = false;
    try {
      for (const includeAxes of [false, true]) {
        document.getElementById('png-axes').checked = includeAxes;
        samples.push(await new Promise((resolve, reject) => {
          HTMLCanvasElement.prototype.toBlob = function(callback, type) {
            originalToBlob.call(this, async blob => {
              try {
                const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
                canvas.width = bitmap.width; canvas.height = bitmap.height;
                const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                callback(blob); resolve({ pixels, width: canvas.width, height: canvas.height });
              } catch (error) { reject(error); }
            }, type);
          };
          document.getElementById('export-png').click();
        }));
      }
      const [plain, arrows] = samples;
      let changed = 0, outside = 0;
      const scale = plain.width / document.getElementById('viewport').clientWidth;
      for (let y = 0; y < plain.height; y++) for (let x = 0; x < plain.width; x++) {
        const i = (y * plain.width + x) * 4;
        if (plain.pixels.subarray(i, i + 4).some((value, k) => value !== arrows.pixels[i + k])) {
          changed++;
          if (x < plain.width - 125 * scale || y < plain.height - 125 * scale) outside++;
        }
      }
      return { changed, outside, corner: arrows.pixels[3], screenAxesHidden: document.getElementById('axis-triad').hasAttribute('hidden') };
    } finally {
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
      HTMLAnchorElement.prototype.click = originalClick;
      document.getElementById('png-axes').checked = false;
    }
  })()`);
  assert.ok(axesExport.changed > 150, 'PNG must contain the selected arrows');
  assert.equal(axesExport.outside, 0);
  assert.equal(axesExport.corner, 0);
  assert.equal(axesExport.screenAxesHidden, true, 'PNG arrows are independent of the screen toggle');
  const colors = await evaluate('[...document.querySelectorAll("[data-background]")].map(button => button.dataset.background)');
  assert.deepEqual(colors, ['#000000', '#ffffff', '#fff8e7', '#fff4c2']);
  // Observe the actual renderer buffers while exercising the structure UI.
  await showTool('cna');
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', appUrl));
    const original = WebGLRenderer.prototype.setColors;
    WebGLRenderer.prototype.setColors = function(...args) {
      window.structureTestRenderer = this;
      window.structureTestColors = args[0];
      return original.apply(this, args);
    };
    document.getElementById('run-cna').click();
  })()`);
  await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'CNA classification');
  assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:structureType');
  assert.equal(await evaluate('document.querySelectorAll(".crystal-items input[type=checkbox]").length'), 5);
  const fccCounts = await evaluate(`(() => {
    const frame = window.structureTestRenderer.frame;
    return [...frame.properties.find(p => p.name === 'structureType').data].reduce((counts, id) => {
      counts[id] = (counts[id] || 0) + 1; return counts;
    }, {});
  })()`);
  assert.deepEqual(fccCounts, { 0: 12, 1: 19 });
  if (process.argv.includes('--structure-screenshot')) {
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/alloyview-cna.png', Buffer.from(capture.data, 'base64'));
    await evaluate(`document.getElementById('cna-state').closest('section').scrollIntoView({ block: 'center' })`);
    const analysisCapture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/alloyview-analysis.png', Buffer.from(analysisCapture.data, 'base64'));
  }
  await evaluate(`document.querySelector('[data-structure-type="0"]').click()`);
  assert.equal(await evaluate(`(() => {
    const renderer = window.structureTestRenderer;
    const types = renderer.frame.properties.find(p => p.name === 'structureType').data;
    return types.every((id, i) => renderer.visibility[i] === (id === 0 ? 0 : 255));
  })()`), true);
  // Hiding all classes removes rendered and pickable atoms, while the analysis
  // input and classification histogram retain every atom.
  await evaluate(`document.querySelector('[data-structure-type="1"]').click()`);
  assert.equal(await evaluate('window.structureTestRenderer.visibility.every(value => value === 0)'), true);
  assert.equal(await evaluate('window.structureTestRenderer.pick(400, 400)'), -1);
  await evaluate(`document.querySelector('[data-structure-type="1"]').click(); document.getElementById('run-csp').click(); document.getElementById('run-analysis').click();`);
  await waitFor('document.getElementById("csp-state").textContent === "Calculated" && document.getElementById("analysis-state").textContent === "Calculated"', 'concurrent analyses');
  assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:coordination');
  await evaluate(`(() => { const select = document.getElementById('color-mode'); select.value = 'property:structureType'; select.dispatchEvent(new Event('change')); })()`);
  assert.equal(await evaluate(`document.querySelector('[data-structure-type="0"]').checked`), false);
  // Changing the method replaces the result and invalidates only its own cache.
  await showTool('cna');
  await evaluate(`(() => { document.getElementById('cna-cutoff').value = '0.1'; const mode = document.getElementById('cna-mode'); mode.value = 'fixed'; mode.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'fixed CNA');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("cna-cutoff-field")).display !== "none"'), true);
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "structureType").data.every(id => id === 0)'), true);
  await evaluate(`(() => { const mode = document.getElementById('cna-mode'); mode.value = 'adaptive'; mode.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'adaptive CNA restored');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("cna-cutoff-field")).display'), 'none');
  // Real Wasm PTM runs on Pages without cross-origin isolation; strain reuses
  // its fits, and editable element presets change the physical reference scale.
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const original = AnalysisPool.prototype.analyze;
    window.analysisInputs = [];
    AnalysisPool.prototype.analyze = function(frame, parameters, ...rest) {
      window.analysisInputs.push({ kind: parameters.kind, reused: !!parameters.ptmInput });
      return original.call(this, frame, parameters, ...rest);
    };
    window.restorePtmPool = () => { AnalysisPool.prototype.analyze = original; };
    document.getElementById('toast').hidden = true;
    document.getElementById('run-ptm').click(); document.getElementById('run-strain').click();
  })()`);
  await waitFor('document.getElementById("ptm-state").textContent === "Calculated" && document.getElementById("strain-state").textContent === "Calculated"', 'PTM and atomic strain');
  assert.equal(await evaluate('document.getElementById("toast").hidden'), true, 'unmatched defect atoms must not produce a warning');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "atomicShearStrain").data.filter(Number.isNaN).length'), 12);
  assert.equal(await evaluate('document.querySelector("[data-lattice-a]").valueAsNumber'), 4.05);
  assert.equal(await evaluate('document.querySelector("[data-reference-element]").value'), 'Al');
  assert.ok(await evaluate('window.analysisInputs.some(input => input.kind === "strain" && input.reused)'));
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "atomicHydrostaticStrain").data.filter(Number.isFinite).every(value => Math.abs(value) < 1e-5)'), true);
  assert.ok(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "atomicHydrostaticStrain").data.some(Number.isFinite)'));
  await evaluate(`(() => { const input = document.querySelector('[data-lattice-a]'); input.value = '3.9'; input.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("strain-state").textContent === "Calculated"', 'edited lattice strain');
  assert.equal(await evaluate(`window.structureTestRenderer.frame.properties.find(p => p.name === 'atomicVolumeChange').data.filter(Number.isFinite).every(value => Math.abs(value - ((4.05 / 3.9) ** 3 - 1)) < 1e-5)`), true);
  assert.equal(await evaluate('window.analysisInputs.filter(input => input.kind === "ptm").length'), 1);
  if (process.argv.includes('--structure-screenshot')) {
    await showTool('strain');
    await evaluate(`document.getElementById('strain-state').closest('section').scrollIntoView({ block: 'center' })`);
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/alloyview-strain.png', Buffer.from(capture.data, 'base64'));
  }
  await evaluate(`(() => { const mode = document.getElementById('color-mode'); mode.value = 'property:ptmStructureType'; mode.dispatchEvent(new Event('change')); })()`);
  assert.equal(await evaluate('document.querySelectorAll(".crystal-items input[type=checkbox]").length'), 9);
  if (process.argv.includes('--structure-screenshot')) {
    await showTool('ptm');
    await evaluate(`document.getElementById('ptm-state').closest('section').scrollIntoView({ block: 'center' })`);
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/alloyview-ptm.png', Buffer.from(capture.data, 'base64'));
  }
  assert.equal(await evaluate(`(() => {
    const r = window.structureTestRenderer, types = r.frame.properties.find(p => p.name === 'ptmStructureType').data;
    return types.every((type, i) => r.visibility[i] === (type === 0 ? 0 : 255));
  })()`), true);
  await evaluate(`document.querySelector('[data-structure-type="1"]').click()`);
  assert.equal(await evaluate('window.structureTestRenderer.visibility.every(value => value === 0)'), true);
  await evaluate(`document.querySelector('[data-structure-type="1"]').click(); window.restorePtmPool();`);
  await evaluate(`(() => { const crystal = document.querySelector('[data-reference-structure]'); crystal.value = '3'; crystal.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("strain-state").textContent === "Calculated"', 'entirely NaN strain');
  assert.equal(await evaluate('document.getElementById("toast").hidden'), true);
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "atomicShearStrain").data.every(Number.isNaN)'), true);
  await evaluate(`(() => { const mode = document.getElementById('color-mode'); mode.value = 'property:atomicShearStrain'; mode.dispatchEvent(new Event('change')); })()`);
  assert.equal(await evaluate('window.structureTestColors.every(value => value === 130)'), true);
  assert.equal(await evaluate('document.querySelector(".legend-items").textContent'), 'NaN');
  await evaluate(`(() => { const crystal = document.querySelector('[data-reference-structure]'); crystal.value = '1'; crystal.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("strain-state").textContent === "Calculated"', 'reference recovery');
  // A new source clears filters; enabled analysis follows trajectory frames.
  await evaluate(`document.getElementById('open-examples').click(); [...document.querySelectorAll('.source-option')].find(b => b.textContent.includes('bcc-trajectory.dump')).click();`);
  await waitFor('document.getElementById("file-name").textContent.includes("bcc-trajectory.dump") && document.getElementById("loading").hidden', 'BCC source');
  await evaluate(`document.getElementById('run-cna').click()`);
  await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'BCC classification');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "structureType").data.every(id => id === 3)'), true);
  assert.equal(await evaluate(`document.querySelector('[data-structure-type="0"]').checked`), true);
  await evaluate(`document.getElementById('run-ptm').click(); document.getElementById('run-strain').click();`);
  await waitFor('document.getElementById("ptm-state").textContent === "Calculated" && document.getElementById("strain-state").textContent === "Calculated"', 'BCC PTM and strain');
  assert.equal(await evaluate('window.structureTestRenderer.frame.ptm.structures.every(type => type === 3)'), true);
  assert.equal(await evaluate('document.querySelector("[data-lattice-a]").valueAsNumber'), 2.87);
  await evaluate(`(() => { const select = document.getElementById('color-mode'); select.value = 'property:ptmStructureType'; select.dispatchEvent(new Event('change')); })()`);
  await evaluate(`document.querySelector('[data-structure-type="3"]').click(); document.getElementById('frame-last').click();`);
  await waitFor('document.getElementById("frame-label").textContent === "2 / 2" && document.getElementById("cna-state").textContent === "Calculated" && document.getElementById("ptm-state").textContent === "Calculated" && document.getElementById("strain-state").textContent === "Calculated"', 'trajectory CNA/PTM/strain');
  assert.equal(await evaluate(`document.querySelector('[data-structure-type="3"]').checked`), false);
  assert.equal(await evaluate('window.structureTestRenderer.visibility.every(value => value === 0)'), true);
  await evaluate(`document.querySelector('[data-structure-type="3"]').click(); document.getElementById('frame-first').click();`);
  await waitFor('document.getElementById("frame-label").textContent === "1 / 2" && document.getElementById("cna-state").textContent === "Calculated" && document.getElementById("strain-state").textContent === "Calculated"', 'cached trajectory analyses');
  // Retain all original assertions while simulating a late superseded result.
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const original = AnalysisPool.prototype.analyze;
    AnalysisPool.prototype.analyze = async function(...args) {
      const result = await original.apply(this, args);
      if (args[1].kind === 'cna') await new Promise(done => setTimeout(done, 200));
      return result;
    };
    window.restoreAnalysisPool = () => { AnalysisPool.prototype.analyze = original; };
    const mode = document.getElementById('cna-mode');
    document.getElementById('cna-cutoff').value = '0.1';
    mode.value = 'fixed'; mode.dispatchEvent(new Event('change'));
  })()`);
  await delay(80);
  await evaluate(`(() => { const mode = document.getElementById('cna-mode'); mode.value = 'adaptive'; mode.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'superseding cached CNA');
  await delay(300);
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "structureType").data.every(id => id === 3)'), true);
  assert.equal(await evaluate('document.getElementById("cna-mode").value'), 'adaptive');
  assert.equal(await evaluate('document.getElementById("run-cna").disabled'), false);
  await evaluate('window.restoreAnalysisPool()');
  // An anonymous numeric species needs an explicit reference, and selecting
  // an element populates both its crystal phase and editable lattice defaults.
  const numericPath = resolve(profile, 'numeric-bcc.dump');
  await writeFile(numericPath, (await readFile(resolve(root, 'examples/bcc-trajectory.dump'), 'utf8'))
    .replaceAll(' type element ', ' type ').replaceAll(' Fe ', ' '));
  await call('DOM.setFileInputFiles', { nodeId, files: [numericPath] });
  await waitFor('document.getElementById("file-name").textContent === "numeric-bcc.dump" && document.getElementById("loading").hidden', 'numeric species source');
  assert.equal(await evaluate('document.querySelector("[data-lattice-a]").value'), '');
  await evaluate(`document.getElementById('run-strain').click()`);
  await waitFor('document.getElementById("strain-state").textContent === "Failed"', 'missing lattice rejection');
  assert.ok((await evaluate('document.getElementById("strain-status").textContent')).includes('positive reference lattice'));
  await evaluate(`(() => { const element = document.querySelector('[data-reference-element]'); element.value = 'Fe'; element.dispatchEvent(new Event('change')); document.getElementById('run-ptm').click(); document.getElementById('run-strain').click(); })()`);
  await waitFor('document.getElementById("ptm-state").textContent === "Calculated" && document.getElementById("strain-state").textContent === "Calculated"', 'explicit numeric species reference');
  assert.equal(await evaluate('document.querySelector("[data-lattice-a]").valueAsNumber'), 2.87);
  assert.equal(await evaluate('document.querySelector("[data-reference-structure]").value'), '3');
  await evaluate(`(() => { const a = document.querySelector('[data-lattice-a]'); a.value = '3.3'; a.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("strain-state").textContent === "Calculated"', 'numeric species lattice edit');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "atomicVolumeChange").data.every(value => Math.abs(value) < 1e-5)'), true);
  // Changing only the PTM template selection affects its classification, while
  // strain still includes the user's required reference phase.
  await evaluate(`document.querySelector('[data-ptm-template="4"]').click()`);
  await waitFor('document.getElementById("ptm-state").textContent === "Calculated" && document.getElementById("strain-state").textContent === "Calculated"', 'restricted PTM templates');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "ptmStructureType").data.every(type => type !== 3)'), true);
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "atomicVolumeChange").data.every(Number.isFinite)'), true);
  await evaluate(`document.querySelector('[data-ptm-template="4"]').click()`);
  await waitFor('document.getElementById("ptm-state").textContent === "Calculated"', 'PTM template recovery');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "ptmStructureType").data.every(type => type === 3)'), true);

  // Tool buttons expose one configuration at a time. Opening settings does
  // not calculate; switching panels preserves concurrent analysis, whereas
  // explicitly closing an analysis returns it to the uncomputed state.
  await showTool('cna');
  assert.equal(await evaluate('document.getElementById("cna-state").textContent'), 'Not calculated');
  assert.equal(await evaluate('document.querySelector("[data-tool-panel=cna]").hidden'), false);
  assert.equal(await evaluate('[...document.querySelectorAll("[data-tool-panel]")].filter(panel => !panel.hidden).length'), 1);
  await evaluate('document.getElementById("run-cna").click()');
  await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'CNA tool calculation');
  await showTool('display');
  assert.equal(await evaluate('document.querySelector("[data-tool-panel=cna]").hidden'), true);
  assert.equal(await evaluate('document.getElementById("cna-state").textContent'), 'Calculated');
  assert.equal(await evaluate('document.getElementById("ptm-state").textContent'), 'Calculated');
  await showTool('cna');
  await evaluate('document.querySelector("[data-tool-button=cna]").click()');
  assert.equal(await evaluate('document.querySelector("[data-tool-panel=cna]").hidden'), true);
  assert.equal(await evaluate('document.getElementById("cna-state").textContent'), 'Not calculated');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.some(p => p.analysisKind === "cna")'), false);
  assert.equal(await evaluate('document.getElementById("ptm-state").textContent'), 'Calculated');

  // User cancellation stops real Workers, restores the uncomputed state and
  // removes results from cached frames without stopping independent analyses.
  const cancelCases = [['coordination', 'analysis'], ['cna', 'cna'], ['centrosymmetry', 'csp'], ['ptm', 'ptm'], ['strain', 'strain']];
  await evaluate(`(async () => {
    for (const prefix of ['analysis', 'cna', 'csp', 'ptm', 'strain']) document.getElementById('cancel-' + prefix).click();
    const appUrl = document.querySelector('script[type="module"]').src;
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const original = AnalysisPool.prototype.analyze;
    window.cancelTestCalls = [];
    window.cancelWorkers = { created: 0, terminated: 0 };
    let originalFactory;
    AnalysisPool.prototype.analyze = function(frame, parameters, ...rest) {
      if (!window.cancelTestPool) {
        window.cancelTestPool = this;
        originalFactory = this.workerFactory;
        this.workerFactory = () => {
          const worker = originalFactory();
          const terminate = worker.terminate.bind(worker);
          window.cancelWorkers.created++;
          worker.terminate = () => { window.cancelWorkers.terminated++; terminate(); };
          return worker;
        };
      }
      window.cancelTestCalls.push(parameters.kind);
      const task = original.call(this, frame, parameters, ...rest);
      if (window.cancelDelayKind === parameters.kind) return task.then(async result => {
        window.cancelHeldResultReady = true;
        await new Promise(done => { window.releaseCanceledResult = done; });
        return result;
      });
      return task;
    };
    window.restoreCancelTesting = () => {
      AnalysisPool.prototype.analyze = original;
      window.cancelTestPool.workerFactory = originalFactory;
    };
  })()`);
  for (const [kind, prefix] of cancelCases) {
    const cancelled = await evaluate(`(async () => {
      document.getElementById('run-${prefix}').click();
      await Promise.resolve(); await Promise.resolve();
      const before = document.getElementById('${prefix}-state').textContent;
      const activeBefore = window.cancelTestPool.active.size;
      document.getElementById('cancel-${prefix}').click();
      return { before, activeBefore,
        state: document.getElementById('${prefix}-state').textContent,
        startDisabled: document.getElementById('run-${prefix}').disabled,
        cancelDisabled: document.getElementById('cancel-${prefix}').disabled,
        metric: document.getElementById('metric-${prefix}').textContent,
        active: window.cancelTestPool.active.size, queued: window.cancelTestPool.queue.length,
        color: document.getElementById('color-mode').value,
        results: window.structureTestRenderer.frame.properties.some(property => property.analysisKind === '${kind}'),
        loading: !document.getElementById('loading').hidden,
        liveWorkers: window.cancelWorkers.created - window.cancelWorkers.terminated };
    })()`);
    assert.equal(cancelled.before, 'Calculating…', kind);
    assert.ok(cancelled.activeBefore >= 1, `${kind} must start a real Worker`);
    assert.equal(cancelled.state, 'Not calculated', kind);
    assert.equal(cancelled.startDisabled, false, kind);
    assert.equal(cancelled.cancelDisabled, true, kind);
    assert.equal(cancelled.metric, '—', kind);
    assert.equal(cancelled.active, 0, kind);
    assert.equal(cancelled.queued, 0, kind);
    assert.equal(cancelled.liveWorkers, 0, kind);
    assert.equal(cancelled.results, false, kind);
    assert.equal(cancelled.color, 'type', kind);
    assert.equal(cancelled.loading, false, kind);
  }
  assert.equal(await evaluate('document.querySelector("[data-lattice-a]").valueAsNumber'), 3.3, 'reset preserves the reference settings');
  assert.equal(await evaluate('window.structureTestRenderer.frame.ptm === undefined'), true);
  const callsBeforeFrames = await evaluate('window.cancelTestCalls.length');
  for (const [button, label] of [['frame-last', '2 / 2'], ['frame-first', '1 / 2']]) {
    await evaluate(`document.getElementById('${button}').click()`);
    await waitFor(`document.getElementById('frame-label').textContent === '${label}' && document.getElementById('loading').hidden`, 'frames after cancellation');
    for (const [, prefix] of cancelCases) assert.equal(await evaluate(`document.getElementById('${prefix}-state').textContent`), 'Not calculated');
    assert.equal(await evaluate('window.structureTestRenderer.frame.properties.some(property => property.analysisKind)'), false);
    assert.equal(await evaluate('window.structureTestRenderer.frame.ptm === undefined'), true);
  }
  await evaluate(`document.querySelector('[data-lattice-a]').dispatchEvent(new Event('change')); document.getElementById('ptm-rmsd').dispatchEvent(new Event('change')); document.getElementById('cna-mode').dispatchEvent(new Event('change'));`);
  assert.equal(await evaluate('window.cancelTestCalls.length'), callsBeforeFrames, 'cancelled analyses must not restart on frames or reference edits');

  // Cancellation must also ignore a completed result held before UI delivery.
  await evaluate(`window.cancelDelayKind = 'cna'; document.getElementById('run-cna').click()`);
  await waitFor('window.cancelHeldResultReady === true', 'held completed result');
  await evaluate(`document.getElementById('cancel-cna').click(); window.cancelDelayKind = null; window.releaseCanceledResult()`);
  await delay(100);
  assert.equal(await evaluate('document.getElementById("cna-state").textContent'), 'Not calculated');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.some(property => property.analysisKind === "cna")'), false);

  // Restart together, then reset a completed strain without removing PTM/CNA.
  await evaluate(`for (const prefix of ['analysis', 'cna', 'csp', 'ptm', 'strain']) document.getElementById('run-' + prefix).click()`);
  await waitFor(`[${cancelCases.map(([, prefix]) => `document.getElementById('${prefix}-state').textContent === 'Calculated'`).join(',')}].every(Boolean)`, 'restarted concurrent analyses');
  await evaluate(`document.getElementById('cancel-strain').click()`);
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.some(property => property.analysisKind === "strain")'), false);
  for (const [, prefix] of cancelCases.slice(0, 4)) assert.equal(await evaluate(`document.getElementById('${prefix}-state').textContent`), 'Calculated');
  assert.equal(await evaluate('window.structureTestRenderer.frame.ptm.structures.every(type => type === 3)'), true);

  // Strain waiting for PTM can continue with its own fit if PTM is cancelled.
  await evaluate(`(async () => {
    document.getElementById('cancel-ptm').click();
    document.getElementById('run-ptm').click(); document.getElementById('run-strain').click();
    await Promise.resolve(); document.getElementById('cancel-ptm').click();
  })()`);
  await waitFor('document.getElementById("strain-state").textContent === "Calculated"', 'strain after prerequisite cancellation');
  assert.equal(await evaluate('document.getElementById("ptm-state").textContent'), 'Not calculated');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.some(property => property.analysisKind === "ptm")'), false);
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(property => property.name === "atomicShearStrain").data.every(Number.isFinite)'), true);

  // Cancelling waiting strain preserves PTM and never schedules a strain job.
  const strainCalls = await evaluate('window.cancelTestCalls.filter(kind => kind === "strain").length');
  await evaluate(`(async () => {
    document.getElementById('cancel-strain').click();
    document.getElementById('run-ptm').click(); document.getElementById('run-strain').click();
    await Promise.resolve(); document.getElementById('cancel-strain').click();
  })()`);
  await waitFor('document.getElementById("ptm-state").textContent === "Calculated"', 'PTM after waiting strain cancellation');
  assert.equal(await evaluate('document.getElementById("strain-state").textContent'), 'Not calculated');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.some(property => property.analysisKind === "strain")'), false);
  assert.equal(await evaluate('window.cancelTestCalls.filter(kind => kind === "strain").length'), strainCalls);

  await evaluate('window.restoreCancelTesting()');

  // Replication changes only rendering. This source has all three triclinic
  // tilts, so copies must follow its basis vectors rather than Cartesian axes.
  await showTool('replicate');
  const replication = await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const { CoordinationPool } = await import(new URL('./analysis/coordination-pool.js', appUrl));
    const { transformPoint } = await import(new URL('./render/math.js', appUrl));
    const renderer = window.structureTestRenderer, frame = renderer.frame;
    const propertyData = frame.properties.map(property => property.data);
    const originalPositions = frame.positions, originalFractional = frame.fractional;
    const originalCell = Array.from(frame.cell.vectors), originalColors = Array.from(window.structureTestColors);
    const originalAnalysis = AnalysisPool.prototype.analyze, originalCoordination = CoordinationPool.prototype.analyze;
    let analyses = 0;
    AnalysisPool.prototype.analyze = function(...args) { analyses++; return originalAnalysis.apply(this, args); };
    CoordinationPool.prototype.analyze = function(...args) { analyses++; return originalCoordination.apply(this, args); };
    const originalDraw = renderer.gl.drawArraysInstanced;
    const draws = [];
    renderer.gl.drawArraysInstanced = function(...args) { draws.push(args[3]); return originalDraw.apply(this, args); };
    try {
      for (const [axis, count] of [['a', 2], ['b', 3], ['c', 2]]) document.getElementById('replicate-' + axis).value = count;
      document.getElementById('apply-replicate').click();
      renderer.render(performance.now(), { trackStats: false });
      const drawInstances = draws.reduce((total, count) => total + count, 0);
      const last = renderer.replicas.at(-1);
      const counts = Array.from(renderer.repetitions), displayCell = Array.from(renderer.displayCell.vectors);
      const cellCopies = renderer.replicas.map(replica => ({ offset: Array.from(replica.offset), indices: Array.from(replica.indices) }));
      const colorsStable = originalColors.every((value, i) => value === window.structureTestColors[i]);
      const sourceStable = frame === renderer.frame && frame.positions === originalPositions && frame.fractional === originalFractional
        && frame.properties.every((property, i) => property.data === propertyData[i])
        && originalCell.every((value, i) => value === frame.cell.vectors[i]);
      // Pick a copied image while retaining a single base atom in the mask.
      const previousVisibility = renderer.visibility, previousAxis = renderer.sliceAxis, previousMaximum = renderer.sliceMaximum;
      const visibility = new Uint8Array(renderer.atomCount); visibility[7] = 255;
      renderer.setVisibility(visibility); renderer.setSlice(2, 1); renderer.setView('front'); renderer.updateMatrices();
      const position = renderer.displayPositions.subarray(21, 24);
      const clip = transformPoint(renderer.viewProjectionMatrix, position[0] + last.offset[0], position[1] + last.offset[1], position[2] + last.offset[2]);
      const rect = renderer.canvas.getBoundingClientRect();
      const point = { x: rect.left + (clip[0] / clip[3] * .5 + .5) * rect.width, y: rect.top + (.5 - clip[1] / clip[3] * .5) * rect.height };
      const picked = renderer.pick(point.x, point.y);
      renderer.setVisibility(new Uint8Array(renderer.atomCount));
      const hiddenPick = renderer.pick(point.x, point.y);
      renderer.setVisibility(previousVisibility); renderer.setSlice(previousAxis, previousMaximum);
      await new Promise(resolve => setTimeout(resolve, 100));
      return { counts, displayCell, originalCell, cellCopies, atomCount: renderer.atomCount, displayAtomCount: renderer.displayAtomCount,
        drawInstances, sourceStable, colorsStable, analyses, picked, hiddenPick, glError: renderer.gl.getError() };
    } finally {
      AnalysisPool.prototype.analyze = originalAnalysis; CoordinationPool.prototype.analyze = originalCoordination;
      renderer.gl.drawArraysInstanced = originalDraw;
    }
  })()`);
  assert.deepEqual(replication.counts, [2, 3, 2]);
  assert.equal(replication.atomCount, 16);
  assert.equal(replication.displayAtomCount, 192);
  assert.equal(replication.drawInstances, 192, 'WebGL must draw all twelve copies');
  assert.equal(replication.sourceStable, true, 'replication must retain the original analysis arrays');
  assert.equal(replication.colorsStable, true);
  assert.equal(replication.analyses, 0, 'changing repetitions must not schedule any analysis');
  assert.equal(replication.picked, 7, 'a repeated image resolves to its original atom');
  assert.equal(replication.hiddenPick, -1, 'the shared visibility mask also hides copied images');
  assert.equal(replication.glError, 0);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(replication.displayCell[i] - replication.originalCell[i] * replication.counts[Math.floor(i / 3)]) < 1e-5);
  assert.equal(replication.cellCopies.length, 12);
  for (const { offset, indices } of replication.cellCopies) for (let component = 0; component < 3; component++) {
    const expected = indices.reduce((sum, index, axis) => sum + index * replication.originalCell[axis * 3 + component], 0);
    assert.ok(Math.abs(offset[component] - expected) < 1e-5, 'copy offsets must include triclinic tilt');
  }
  // Selection uses the same expanded fractional range as rendering/picking.
  // An atom beyond halfway in its source cell remains inside the first half
  // of a doubled cell, then becomes hidden when repetition is reset to one.
  const repeatedSelection = await evaluate(`(() => {
    const renderer = window.structureTestRenderer;
    const atom = renderer.frame.fractional.findIndex((value, component) => component % 3 === 0 && value > .5) / 3;
    if (atom < 0) throw new Error('Expected an atom beyond half of the source a vector');
    renderer.onPick(atom);
    const axis = document.getElementById('slice-axis'), position = document.getElementById('slice-position');
    axis.value = '0'; axis.dispatchEvent(new Event('change'));
    position.value = '50'; position.dispatchEvent(new Event('input'));
    const color = document.getElementById('color-mode'); color.value = 'type'; color.dispatchEvent(new Event('change'));
    const copied = { selected: renderer.selected, detailsHidden: document.getElementById('selection-data').hidden };
    document.getElementById('reset-replicate').click();
    const source = { selected: renderer.selected, detailsHidden: document.getElementById('selection-data').hidden };
    position.value = '100'; position.dispatchEvent(new Event('input'));
    document.getElementById('clear-selection').click();
    for (const [direction, count] of [['a', 2], ['b', 3], ['c', 2]]) document.getElementById('replicate-' + direction).value = count;
    document.getElementById('apply-replicate').click();
    return { atom, copied, source, restoredSlice: renderer.sliceMaximum };
  })()`);
  assert.equal(repeatedSelection.copied.selected, repeatedSelection.atom, 'expanded slicing must retain a visible selected atom');
  assert.equal(repeatedSelection.copied.detailsHidden, false);
  assert.equal(repeatedSelection.source.selected, -1, 'resetting replication hides an atom outside the source-cell slice');
  assert.equal(repeatedSelection.source.detailsHidden, true);
  assert.equal(repeatedSelection.restoredSlice, 1);
  assert.equal(await evaluate('Number(document.getElementById("atom-count").textContent)'), 16, 'structure summary retains the source atom count');
  await evaluate(`(() => { const mode = document.getElementById('color-mode'); mode.value = 'property:ptmStructureType'; mode.dispatchEvent(new Event('change')); document.querySelector('[data-structure-type="3"]').click(); })()`);
  assert.equal(await evaluate('window.structureTestRenderer.visibility.every(value => value === 0)'), true);
  await evaluate(`document.querySelector('[data-structure-type="3"]').click()`);
  const replicatedPng = await evaluate(`(async () => {
    const originalToBlob = HTMLCanvasElement.prototype.toBlob, originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {};
    document.getElementById('png-background').checked = false; document.getElementById('png-legend').checked = false;
    try {
      return await new Promise((resolve, reject) => {
        HTMLCanvasElement.prototype.toBlob = function(callback, type) {
          originalToBlob.call(this, async blob => {
            try {
              const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
              canvas.width = bitmap.width; canvas.height = bitmap.height;
              const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
              let content = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) content++;
              callback(blob); resolve({ corner: pixels[3], content, atomCount: window.structureTestRenderer.displayAtomCount });
            } catch (error) { reject(error); }
          }, type);
        };
        document.getElementById('export-png').click();
      });
    } finally { HTMLCanvasElement.prototype.toBlob = originalToBlob; HTMLAnchorElement.prototype.click = originalClick; }
  })()`);
  assert.equal(replicatedPng.atomCount, 192);
  assert.equal(replicatedPng.corner, 0);
  assert.ok(replicatedPng.content > 1000, 'PNG export must retain the replicated structure');
  await evaluate('document.getElementById("reset-replicate").click()');
  assert.deepEqual(await evaluate('Array.from(window.structureTestRenderer.repetitions)'), [1, 1, 1]);
  assert.equal(await evaluate('window.structureTestRenderer.displayAtomCount'), 16);

  // Close during real Worker analysis and trajectory playback, then ensure
  // old results and prefetched frames cannot restore the structure.
  const sourceClose = await evaluate(`(async () => {
    document.getElementById('cancel-cna').click();
    document.getElementById('run-cna').click();
    document.getElementById('frame-play').click();
    await Promise.resolve();
    const activeBefore = window.cancelTestPool.active.size;
    document.getElementById('close-file').click();
    return { activeBefore, active: window.cancelTestPool.active.size, queued: window.cancelTestPool.queue.length,
      frame: window.structureTestRenderer.frame, atoms: window.structureTestRenderer.atomCount,
      bufferBytes: (() => {
        const r = window.structureTestRenderer; r.gl.bindBuffer(r.gl.ARRAY_BUFFER, r.positionBuffer);
        return r.gl.getBufferParameter(r.gl.ARRAY_BUFFER, r.gl.BUFFER_SIZE);
      })() };
  })()`);
  assert.ok(sourceClose.activeBefore > 0);
  assert.equal(sourceClose.active, 0); assert.equal(sourceClose.queued, 0);
  assert.equal(sourceClose.frame, null); assert.equal(sourceClose.atoms, 0); assert.equal(sourceClose.bufferBytes, 0);
  await delay(1100);
  await checkHome();
  assert.equal(await evaluate('document.getElementById("frame-play").getAttribute("aria-pressed")'), 'false');

  const partialPbcPath = resolve(profile, 'partial-pbc.dump');
  await writeFile(partialPbcPath, (await readFile(numericPath, 'utf8')).replaceAll('yz pp pp pp', 'yz pp ff pp'));
  await call('DOM.setFileInputFiles', { nodeId, files: [partialPbcPath] });
  await waitFor('document.getElementById("file-name").textContent === "partial-pbc.dump" && document.getElementById("loading").hidden', 'partially periodic source');
  await showTool('replicate');
  assert.deepEqual(await evaluate('["a", "b", "c"].map(axis => document.getElementById("replicate-" + axis).disabled)'), [false, true, false]);
  assert.equal(await evaluate('document.getElementById("replicate-b").valueAsNumber'), 1);
  // Theme persists on reload. A manually selected viewport color stays intact.
  await evaluate(`document.querySelector('[data-background="#fff8e7"]').click(); document.getElementById('theme-light').click();`);
  assert.equal(await evaluate('document.getElementById("background").value'), '#fff8e7');
  await evaluate(`document.getElementById('sidebar-resizer').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }));`);
  const savedSidebarWidth = await evaluate('document.getElementById("sidebar").getBoundingClientRect().width');
  await reloadPage();
  await waitFor('document.readyState === "complete" && document.getElementById("sidebar-resizer").getAttribute("aria-valuenow") === localStorage.getItem("alloyview-sidebar-width")', 'sidebar initialization after reload');
  await waitFor('document.getElementById("theme-light").getAttribute("aria-pressed") === "true"', 'saved light theme');
  assert.equal(await evaluate('localStorage.getItem("alloyview-theme")'), 'light');
  assert.equal(await evaluate('document.getElementById("sidebar").getBoundingClientRect().width'), savedSidebarWidth);
  // On narrow screens controls stack below the viewport and the handle hides.
  await call('Emulation.setDeviceMetricsOverride', { width: 800, height: 1000, deviceScaleFactor: 1, mobile: false });
  await waitFor('getComputedStyle(document.getElementById("sidebar-resizer")).display === "none"', 'narrow layout');
  assert.ok(await evaluate('document.getElementById("sidebar").getBoundingClientRect().top >= document.getElementById("viewport").getBoundingClientRect().bottom'));

  // A phone keeps the viewer on screen while its lower tool area scrolls.
  // Compact overlay buttons start closed and expose the full controls on tap.
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await waitFor('document.getElementById("toggle-view-controls").getAttribute("aria-expanded") === "false"', 'collapsed phone view controls');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("view-controls")).display'), 'none');
  await evaluate('document.getElementById("toggle-view-controls").click()');
  assert.equal(await evaluate('document.getElementById("toggle-view-controls").getAttribute("aria-expanded")'), 'true');
  assert.notEqual(await evaluate('getComputedStyle(document.getElementById("view-controls")).display'), 'none');
  await evaluate('document.getElementById("toggle-view-controls").click()');
  await evaluate(`document.getElementById('open-examples').click(); [...document.querySelectorAll('.source-option')].find(button => button.textContent.includes('fcc-vacancy.cfg')).click();`);
  await waitFor('document.getElementById("file-name").textContent.includes("fcc-vacancy.cfg") && document.getElementById("loading").hidden', 'phone structure');
  await showTool('cna');
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', appUrl));
    const original = WebGLRenderer.prototype.setColors;
    WebGLRenderer.prototype.setColors = function(...args) {
      window.touchTestRenderer = this;
      return original.apply(this, args);
    };
    document.getElementById('run-cna').click();
  })()`);
  await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'phone CNA legend');
  assert.equal(await evaluate('document.getElementById("toggle-legend").getAttribute("aria-expanded")'), 'false');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("legend")).display'), 'none');
  await evaluate('document.getElementById("toggle-legend").click()');
  assert.equal(await evaluate('document.getElementById("toggle-legend").getAttribute("aria-expanded")'), 'true');
  assert.notEqual(await evaluate('getComputedStyle(document.getElementById("legend")).display'), 'none');
  assert.equal(await evaluate('document.querySelectorAll(".crystal-items input[type=checkbox]").length'), 5);
  await evaluate('document.getElementById("toggle-legend").click()');

  // Actual multi-touch input must zoom/pan the WebGL camera, not the webpage.
  const touchCenter = await evaluate(`(() => {
    const r = window.touchTestRenderer, rect = r.canvas.getBoundingClientRect();
    window.touchCameraStart = { projection: r.projectionMode, yaw: r.yaw, pitch: r.pitch,
      pan: [...r.pan], distance: r.distance, scale: r.orthographicScale };
    window.touchPicks = 0;
    const originalPick = r.onPick;
    r.onPick = function(...args) { window.touchPicks++; return originalPick.apply(this, args); };
    return { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2) };
  })()`);
  const cameraState = () => evaluate(`(() => {
    const r = window.touchTestRenderer;
    return { yaw: r.yaw, pitch: r.pitch, pan: [...r.pan], distance: r.distance,
      scale: r.orthographicScale, basis: r.cameraBasis(), height: r.canvas.clientHeight, fov: r.fov };
  })()`);
  const closeNumber = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} != ${b}`);
  const fingers = (span, dx = 0, dy = 0) => [
    { id: 1, x: touchCenter.x - span / 2 + dx, y: touchCenter.y + dy },
    { id: 2, x: touchCenter.x + span / 2 + dx, y: touchCenter.y + dy },
  ];
  const touchInput = (type, touchPoints) => call('Input.dispatchTouchEvent', { type, touchPoints });
  for (const projection of ['perspective', 'orthographic']) {
    await evaluate(`window.touchTestRenderer.setProjection('${projection}')`);
    const before = await cameraState(), sizeKey = projection === 'orthographic' ? 'scale' : 'distance';
    await touchInput('touchStart', fingers(100));
    await touchInput('touchMove', fingers(160));
    const zoomed = await cameraState();
    closeNumber(zoomed[sizeKey], before[sizeKey] / 1.6, `${projection} pinch opens`);
    assert.equal(zoomed.yaw, before.yaw); assert.equal(zoomed.pitch, before.pitch);
    await touchInput('touchMove', fingers(100));
    await touchInput('touchEnd', []);
    const restored = await cameraState();
    closeNumber(restored[sizeKey], before[sizeKey], `${projection} pinch closes`);
    restored.pan.forEach((value, axis) => closeNumber(value, before.pan[axis], 'pinch pan restoration'));

    await touchInput('touchStart', fingers(100));
    await touchInput('touchMove', fingers(100, 24, 18));
    await touchInput('touchEnd', []);
    const panned = await cameraState();
    const units = 2 * (projection === 'orthographic' ? before.scale : Math.tan(before.fov / 2) * before.distance) / before.height;
    closeNumber(panned[sizeKey], before[sizeKey], `${projection} pan retains zoom`);
    panned.pan.forEach((value, axis) => closeNumber(value, restored.pan[axis]
      - 24 * units * before.basis.right[axis] + 18 * units * before.basis.up[axis], `${projection} pan axis ${axis}`));
    assert.equal(panned.yaw, before.yaw); assert.equal(panned.pitch, before.pitch);
  }
  assert.equal(await evaluate('window.touchPicks'), 0, 'multi-touch gestures must not pick atoms');
  await touchInput('touchStart', [{ id: 1, x: touchCenter.x, y: touchCenter.y }]);
  const orbitBefore = await cameraState();
  await touchInput('touchMove', [{ id: 1, x: touchCenter.x + 20, y: touchCenter.y + 10 }]);
  await touchInput('touchEnd', []);
  const orbitAfter = await cameraState();
  closeNumber(orbitAfter.yaw, orbitBefore.yaw - .16, 'one-finger orbit yaw');
  closeNumber(orbitAfter.pitch, orbitBefore.pitch + .08, 'one-finger orbit pitch');
  assert.equal(await evaluate('window.touchPicks'), 0);
  await touchInput('touchStart', [{ id: 1, x: touchCenter.x, y: touchCenter.y }]);
  await touchInput('touchEnd', []);
  assert.equal(await evaluate('window.touchPicks'), 1, 'a single tap must still inspect atoms');
  assert.equal(await evaluate('window.scrollY'), 0, 'canvas gestures must not scroll the page');
  await evaluate(`(() => {
    const r = window.touchTestRenderer, start = window.touchCameraStart;
    r.yaw = start.yaw; r.pitch = start.pitch; r.pan = start.pan;
    r.distance = start.distance; r.orthographicScale = start.scale;
    r.setProjection(start.projection);
  })()`);

  await showTool('strain');
  await evaluate('document.getElementById("sidebar").scrollTop = 0');
  const phoneBefore = await evaluate(`(() => {
    const rect = document.getElementById('viewport').getBoundingClientRect();
    const sidebar = document.getElementById('sidebar').getBoundingClientRect();
    return { canvas: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      touch: { x: sidebar.x + sidebar.width - 14, y: sidebar.top + sidebar.height - 24 },
      sidebarTop: sidebar.top, canScroll: document.getElementById('sidebar').scrollHeight > document.getElementById('sidebar').clientHeight };
  })()`);
  assert.equal(phoneBefore.canScroll, true, 'phone settings must scroll independently');
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [phoneBefore.touch] });
  for (let step = 1; step <= 8; step++) {
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: phoneBefore.touch.x, y: phoneBefore.touch.y - step * 22 }] });
    await delay(20);
  }
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitFor('document.getElementById("sidebar").scrollTop > 0', 'phone touch scrolling');
  const phoneAfter = await evaluate(`(() => {
    const rect = document.getElementById('viewport').getBoundingClientRect();
    return { canvas: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      pageScroll: window.scrollY, overflow: document.documentElement.scrollHeight > innerHeight + 1 };
  })()`);
  assert.deepEqual(phoneAfter.canvas, phoneBefore.canvas, 'scrolling tools must leave the viewport fixed');
  assert.equal(phoneAfter.pageScroll, 0);
  assert.equal(phoneAfter.overflow, false, 'phone layout must fit within the visible screen');

  // Reproduce zooming into a large thin crystal, then switching to Ortho.
  // Use a real local CFG and verify GPU coverage at both ends of its buffers.
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setTouchEmulationEnabled', { enabled: false });
  const largeCount = 400 * 64 * 4 * 2, largePath = resolve(profile, 'large-bcc.cfg');
  const largeLines = [`Number of particles = ${largeCount}`, 'A = 1.0 Angstrom'];
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
    largeLines.push(`H0(${row + 1},${column + 1}) = ${row === column ? [1144, 183.04, 11.44][row] : 0} A`);
  }
  largeLines.push('.NO_VELOCITY.', 'entry_count = 3', '55.845', 'Fe');
  for (let x = 0; x < 400; x++) for (let y = 0; y < 64; y++) for (let z = 0; z < 4; z++) {
    for (const basis of [0, .5]) largeLines.push(`${(x + basis) / 400} ${(y + basis) / 64} ${(z + basis) / 4}`);
  }
  await writeFile(largePath, largeLines.join('\n'));
  const { root: largeDomRoot } = await call('DOM.getDocument');
  const { nodeId: largeInput } = await call('DOM.querySelector', { nodeId: largeDomRoot.nodeId, selector: '#file-input' });
  await call('DOM.setFileInputFiles', { nodeId: largeInput, files: [largePath] });
  await waitFor('document.getElementById("file-name").textContent === "large-bcc.cfg" && document.getElementById("loading").hidden', 'large local CFG');
  assert.equal(await evaluate('window.touchTestRenderer.atomCount'), largeCount);
  await evaluate(`(() => {
    const r = window.touchTestRenderer;
    document.getElementById('projection-perspective').click();
    r.distance = r.modelRadius * .25;
    r.orthographicScale = r.modelRadius * .8;
    r.setRadiusScale(.56);
    document.getElementById('projection-orthographic').click();
    document.getElementById('toast').hidden = true;
  })()`);
  const largeDepths = await evaluate(`(async () => {
    const r = window.touchTestRenderer;
    const appUrl = document.querySelector('script[type="module"]').src;
    const { cellVertices } = await import(new URL('./data/model.js', appUrl));
    const { transformPoint } = await import(new URL('./render/math.js', appUrl));
    r.updateMatrices();
    let minimum = Infinity, maximum = -Infinity;
    for (const values of [cellVertices(r.displayCell), r.displayPositions]) {
      for (let i = 0; i < values.length; i += 3) {
        const clip = transformPoint(r.viewProjectionMatrix, values[i], values[i + 1], values[i + 2]);
        const depth = clip[2] / clip[3];
        minimum = Math.min(minimum, depth); maximum = Math.max(maximum, depth);
      }
    }
    return { minimum, maximum, positions: r.displayPositions.length, glError: r.gl.getError() };
  })()`);
  assert.ok(largeDepths.minimum > -1 && largeDepths.maximum < 1, `large structure must fit within depth planes: ${JSON.stringify(largeDepths)}`);
  assert.equal(largeDepths.positions, largeCount * 3);
  assert.equal(largeDepths.glError, 0);
  if (process.argv.includes('--clipping-screenshot')) {
    await delay(100);
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/alloyview-large-structure.png', Buffer.from(capture.data, 'base64'));
  }
  const largeSamples = await evaluate(`(async () => {
    const r = window.touchTestRenderer, gl = r.gl;
    const appUrl = document.querySelector('script[type="module"]').src;
    const { transformPoint } = await import(new URL('./render/math.js', appUrl));
    const originalVisibility = r.visibility, originalScale = r.radiusScale, originalCell = r.cellVisible;
    const originalDraw = gl.drawArraysInstanced;
    const draws = [], samples = [];
    gl.drawArraysInstanced = function(...args) { draws.push(args[3]); return originalDraw.apply(this, args); };
    try {
      r.setCellVisible(false); r.setRadiusScale(5);
      for (const atom of [0, r.atomCount - 1]) {
        const mask = new Uint8Array(r.atomCount); mask[atom] = 255; r.setVisibility(mask);
        const query = gl.createQuery();
        gl.beginQuery(gl.ANY_SAMPLES_PASSED, query);
        r.render(performance.now(), { transparentBackground: true, trackStats: false });
        gl.endQuery(gl.ANY_SAMPLES_PASSED); gl.finish();
        try {
          for (let attempt = 0; attempt < 200 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) throw new Error('GPU coverage query timed out');
          const covered = Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT));
          const index = atom * 3;
          const clip = transformPoint(r.viewProjectionMatrix, ...r.displayPositions.subarray(index, index + 3));
          const rect = r.canvas.getBoundingClientRect();
          const picked = r.pick(rect.left + (clip[0] / clip[3] * .5 + .5) * rect.width,
            rect.top + (.5 - clip[1] / clip[3] * .5) * rect.height);
          samples.push({ atom, covered, picked });
        } finally { gl.deleteQuery(query); }
      }
      return { samples, draws, glError: gl.getError() };
    } finally {
      gl.drawArraysInstanced = originalDraw;
      r.setVisibility(originalVisibility); r.setRadiusScale(originalScale); r.setCellVisible(originalCell);
    }
  })()`);
  assert.deepEqual(largeSamples.samples, [
    { atom: 0, covered: true, picked: 0 },
    { atom: largeCount - 1, covered: true, picked: largeCount - 1 },
  ]);
  assert.ok(largeSamples.draws.length >= 2 && largeSamples.draws.every(count => count === largeCount));
  assert.equal(largeSamples.glError, 0);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(requests.some(path => path.endsWith('ptm-kernel.wasm')), 'browser must load the real PTM kernel');
  assert.ok(requests.filter((path) => /\.(js|mjs|wasm)$/.test(path)).every((path) => /^\/AlloyView\/assets\/[a-f0-9]+\//.test(path)));
  console.log('Browser smoke passed: continuous 3D BCC logo including reduced-motion settings; Pages Wasm loading; trajectories; automatic cutoff/legend edits; latest-result queueing; concurrent analyses; silent NaN strain; real Worker cancellation/reset, cached-frame cleanup, independent jobs and dependency recovery; selectable tools; triclinic display replication, unchanged analysis inputs, repeated picking/filtering and PNG export; editable lattice references and PTM reuse; sidebar/themes; phone pinch zoom, two-finger pan, one-finger orbit, tap picking, fixed viewport, touch scrolling and collapsed overlays; transparent PNG and optional XYZ arrows.');
  console.log(JSON.stringify(exports));
  console.log(`Large-structure clipping passed: ${largeCount} local CFG atoms; depth range ${largeDepths.minimum.toFixed(4)}..${largeDepths.maximum.toFixed(4)}; first/last atoms rendered and picked.`);
} finally {
  websocket?.close();
  chrome.kill();
  await new Promise((done) => chrome.exitCode !== null ? done() : chrome.once('exit', done));
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
