import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crystalFrame } from '../tests/helpers/crystals.js';
import { runAtomToolsSmoke } from './browser-atom-tools.mjs';

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
  const relativePath = pathname.replace(/^\/AlloyView\//, '');
  const path = resolve(dist, relativePath.endsWith('/') ? `${relativePath}index.html` : relativePath || 'index.html');
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
  async function clickElement(selector) {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'nearest' });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async function dragElement(selector, deltaX, deltaY) {
    const point = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    if (selector === '.slice-normal-head' && process.argv.includes('--structure-screenshot')) {
      const capture = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile('/tmp/alloyview-slices.png', Buffer.from(capture.data, 'base64'));
    }
    for (let step = 1; step <= 6; step++) await call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x + deltaX * step / 6, y: point.y + deltaY * step / 6, button: 'left', buttons: 1,
    });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + deltaX, y: point.y + deltaY, button: 'left', clickCount: 1 });
  }
  async function exportConfiguration() {
    return evaluate(`(async () => {
      const originalUrl = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
      let saved;
      URL.createObjectURL = function(blob) { saved = blob; return originalUrl.call(this, blob); };
      HTMLAnchorElement.prototype.click = () => {};
      try {
        document.getElementById('export-configuration').click();
        if (!saved) throw new Error('Configuration export did not create a downloadable Blob: ' + document.getElementById('toast').textContent + ' / ' + document.getElementById('configuration-status').textContent);
        return JSON.parse(await saved.text());
      } finally { URL.createObjectURL = originalUrl; HTMLAnchorElement.prototype.click = originalClick; }
    })()`);
  }
  async function holdRecipePreflight() {
    await evaluate(`(async () => {
      const appUrl = document.querySelector('script[type="module"]').src;
      const { FrameCache } = await import(new URL('./data/frame-cache.js', appUrl));
      const { StructureWorkerClient } = await import(new URL('./worker-client.js', appUrl));
      const get = FrameCache.prototype.get, frame = StructureWorkerClient.prototype.frame;
      let miss = true, hold = true;
      window.preflightResultHeld = false;
      FrameCache.prototype.get = function(index) {
        if (index === 0 && miss) { miss = false; return undefined; }
        return get.call(this, index);
      };
      StructureWorkerClient.prototype.frame = function(index, ...rest) {
        const response = frame.call(this, index, ...rest);
        if (index !== 0 || !hold) return response;
        hold = false;
        return response.then(value => new Promise((resolve, reject) => {
          window.preflightResultHeld = true;
          window.releasePreflight = () => resolve(value);
          window.rejectPreflight = () => reject(new Error('Stale pending recipe failed'));
        }));
      };
      window.restorePreflightHooks = () => { FrameCache.prototype.get = get; StructureWorkerClient.prototype.frame = frame; };
    })()`);
  }
  function compareSettings(actual, expected, path = 'settings') {
    if (typeof expected === 'number') {
      assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), `${path}: ${actual} != ${expected}`);
    } else if (expected !== null && typeof expected === 'object') {
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path} keys`);
      for (const key of Object.keys(expected)) compareSettings(actual[key], expected[key], `${path}.${key}`);
    } else assert.equal(actual, expected, path);
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
  // A fresh headless tab can change :focus styles without delivering native
  // focus events until its window is activated. Match an active browser tab so
  // keyboard help positioning is exercised in focused and full runs alike.
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/AlloyView/` });
  await waitFor('document.readyState === "complete" && location.pathname === "/AlloyView/"', 'page load');
  await waitFor('document.getElementById("brand-logo").src.endsWith("AlloyView_logo_dark.svg")', 'app initialization');
  const atomToolsOnly = process.argv.includes('--atom-tools-only');
  let reportFullSmoke;
  if (!atomToolsOnly) {
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

  // Native trajectory data has deliberately different scalar bounds on each
  // frame, so Auto must track data while manual ranges remain comparable.
  const legendTrajectoryPath = resolve(profile, 'legend-ranges.dump');
  const legendTrajectory = [[0, 1, 2, 3], [-10, 0, 10, 20], [100, 120, 140, 160]].map((values, frame) => [
    'ITEM: TIMESTEP', frame * 100, 'ITEM: NUMBER OF ATOMS', 4,
    'ITEM: BOX BOUNDS pp pp pp', '0 10', '0 10', '0 10',
    'ITEM: ATOMS id type element xs ys zs pe temp constant',
    ...values.map((value, atom) => `${atom + 1} 1 Fe ${.15 + atom * .2} ${.2 + atom * .1} .5 ${value} ${(frame + 1) * (atom + 1) * 100} 7`),
  ].join('\n')).join('\n') + '\n';
  await writeFile(legendTrajectoryPath, legendTrajectory);
  await call('DOM.setFileInputFiles', { nodeId, files: [legendTrajectoryPath] });
  await waitFor('document.getElementById("file-name").textContent === "legend-ranges.dump" && document.getElementById("loading").hidden', 'legend trajectory');
  const legendRange = () => evaluate('[...document.querySelectorAll(".legend-range span")].map(span => Number(span.textContent))');
  const legendAuto = () => evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed") === "true"');
  const colorProperty = async (name, source = 'sidebar') => {
    await evaluate(`(() => { const color = document.getElementById(${JSON.stringify(source === 'legend' ? 'legend-color-mode' : 'color-mode')}); color.value = 'property:' + ${JSON.stringify(name)}; color.dispatchEvent(new Event('change')); })()`);
    assert.equal(await evaluate('document.getElementById("color-mode").value'), `property:${name}`);
    assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), `property:${name}`, 'legend and sidebar color quantities stay synchronized');
  };
  const legendFrame = async index => {
    await evaluate(`(() => { const frame = document.getElementById('frame-slider'); frame.value = ${index}; frame.dispatchEvent(new Event('input')); })()`);
    await waitFor(`document.getElementById('frame-label').textContent === '${index + 1} / 3' && document.getElementById('timestep-label').textContent === 'timestep ${index * 100}' && document.getElementById('loading').hidden`, 'legend trajectory frame');
  };
  const legendScheme = async scheme => {
    await evaluate(`(() => { const select = document.querySelector('.legend-scheme select'); select.value = ${JSON.stringify(scheme)}; select.dispatchEvent(new Event('change')); })()`);
    assert.equal(await evaluate('document.querySelector(".legend-scheme select").value'), scheme);
  };
  assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'type');
  assert.deepEqual(await evaluate('Array.from(document.getElementById("legend-color-mode").options, option => [option.value, option.text])'), await evaluate('Array.from(document.getElementById("color-mode").options, option => [option.value, option.text])'));
  await colorProperty('pe', 'legend');
  assert.equal(await legendAuto(), true, 'a new property starts with Auto on');
  assert.equal(await evaluate('document.getElementById("legend-auto").disabled'), false, 'Auto is an always-available toggle');
  assert.equal(await evaluate('document.querySelector(".legend-scheme select").value'), 'atomeye', 'existing AtomEye default is preserved');
  assert.deepEqual(await legendRange(), [0, 3]);
  await delay(150);
  const autoOnBackground = await evaluate('getComputedStyle(document.getElementById("legend-auto")).backgroundColor');
  await legendFrame(1);
  assert.deepEqual(await legendRange(), [-10, 20], 'Auto follows the new frame data');
  await evaluate('document.getElementById("legend-auto").click()');
  assert.equal(await legendAuto(), false);
  await delay(150);
  assert.notEqual(await evaluate('getComputedStyle(document.getElementById("legend-auto")).backgroundColor'), autoOnBackground, 'Auto on is visually highlighted');
  await legendFrame(2);
  assert.deepEqual(await legendRange(), [-10, 20], 'turning Auto off freezes the current range');
  await legendFrame(0);
  assert.deepEqual(await legendRange(), [-10, 20], 'a fixed range also survives cached-frame navigation');
  await evaluate('document.getElementById("legend-auto").click()');
  assert.equal(await legendAuto(), true);
  assert.deepEqual(await legendRange(), [0, 3], 'turning Auto on immediately fits the current frame');

  // Incomplete typing must switch Auto off without replacing the typed field
  // or discarding the last valid range. Exercise actual keyboard input too.
  await evaluate(`(() => { const minimum = document.querySelector('.legend-controls input[type=number]'); minimum.focus(); minimum.value = ''; minimum.dispatchEvent(new Event('input')); })()`);
  assert.equal(await legendAuto(), false, 'even clearing a field turns Auto off');
  assert.equal(await evaluate('document.querySelector(".legend-controls input[type=number]").value'), '');
  assert.deepEqual(await legendRange(), [0, 3]);
  await legendFrame(1);
  assert.deepEqual(await legendRange(), [0, 3]);
  await evaluate('document.getElementById("legend-auto").click(); document.querySelector(".legend-controls input[type=number]").focus(); document.querySelector(".legend-controls input[type=number]").select()');
  await call('Input.insertText', { text: '-' });
  assert.equal(await legendAuto(), false, 'a partial signed number turns Auto off');
  assert.equal(await evaluate('document.querySelector(".legend-controls input[type=number]").value'), '', 'partial typing is not rewritten');
  assert.deepEqual(await legendRange(), [-10, 20]);

  // Editing a bound far above the old data must still advance the opposite
  // bound; rerenders must preserve close limits instead of rounding them equal.
  await legendFrame(0);
  const highMagnitudeToast = await evaluate('document.getElementById("toast").textContent');
  const preciseLegendRange = () => evaluate('[...document.querySelectorAll(".legend-controls input[type=number]")].map(input => input.valueAsNumber)');
  await evaluate(`(() => { const minimum = document.querySelector('.legend-controls input[type=number]'); minimum.value = '100000000'; minimum.dispatchEvent(new Event('input')); })()`);
  const coupledLargeRange = await preciseLegendRange();
  assert.equal(await legendAuto(), false);
  assert.equal(coupledLargeRange[0], 1e8);
  assert.ok(Number.isFinite(coupledLargeRange[1]) && coupledLargeRange[1] > 1e8, 'a large edited minimum advances the maximum');
  await evaluate(`(() => { const maximum = document.querySelectorAll('.legend-controls input[type=number]')[1]; maximum.value = '100000000.01'; maximum.dispatchEvent(new Event('input')); })()`);
  assert.deepEqual(await preciseLegendRange(), [1e8, 1e8 + .01]);
  await legendScheme('plasma');
  assert.deepEqual(await preciseLegendRange(), [1e8, 1e8 + .01], 'palette rerenders preserve close large numeric bounds');
  await legendFrame(2);
  assert.deepEqual(await preciseLegendRange(), [1e8, 1e8 + .01], 'frame rerenders preserve close large numeric bounds');
  assert.equal(await legendAuto(), false);
  const largeRangeRecipe = await exportConfiguration();
  assert.deepEqual(largeRangeRecipe.settings.colors.ranges.find(range => range.property === 'pe'), { property: 'pe', minimum: 1e8, maximum: 1e8 + .01 });
  assert.equal(await evaluate('document.getElementById("toast").textContent'), highMagnitudeToast, 'valid large edits do not report an error');
  await evaluate(`(() => {
    const [minimum, maximum] = document.querySelectorAll('.legend-controls input[type=number]');
    minimum.value = '-5'; minimum.dispatchEvent(new Event('input'));
    maximum.value = '25'; maximum.dispatchEvent(new Event('change'));
  })()`);
  assert.deepEqual(await legendRange(), [-5, 25]);
  await legendFrame(2);
  assert.deepEqual(await legendRange(), [-5, 25], 'valid manual bounds persist across frames');
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.getElementById('theme-${theme}').click()`);
    await delay(150);
    await checkTextContrast(['#legend-auto'], 4.5);
    await evaluate('document.getElementById("legend-auto").click()');
    await delay(150);
    assert.equal(await legendAuto(), true);
    await checkTextContrast(['#legend-auto'], 4.5);
    await evaluate(`(() => { const [minimum, maximum] = document.querySelectorAll('.legend-controls input[type=number]'); minimum.value = '-5'; minimum.dispatchEvent(new Event('input')); maximum.value = '25'; maximum.dispatchEvent(new Event('input')); })()`);
    assert.equal(await legendAuto(), false);
  }
  await evaluate('document.getElementById("theme-light").click()');

  // Exercise all new maps through the real PNG exporter: the supplied scalar
  // bounds appear in the drawn labels and the decoded color bars differ.
  const paletteExports = await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', appUrl));
    const originalExport = WebGLRenderer.prototype.exportPng, originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const originalClick = HTMLAnchorElement.prototype.click, originalText = CanvasRenderingContext2D.prototype.fillText;
    let exportedLegend, texts = [];
    WebGLRenderer.prototype.exportPng = function(filename, options) { exportedLegend = options.legend; return originalExport.call(this, filename, options); };
    CanvasRenderingContext2D.prototype.fillText = function(text, ...rest) { texts.push(String(text)); return originalText.call(this, text, ...rest); };
    HTMLAnchorElement.prototype.click = () => {};
    document.getElementById('png-background').checked = false;
    document.getElementById('png-legend').checked = true;
    const results = [];
    try {
      for (const scheme of ['magma', 'inferno', 'cividis', 'turbo', 'spectral']) {
        const select = document.querySelector('.legend-scheme select'); select.value = scheme; select.dispatchEvent(new Event('change'));
        if (select.value !== scheme) throw new Error('Missing palette: ' + scheme);
        texts = [];
        const pixels = await new Promise((resolve, reject) => {
          HTMLCanvasElement.prototype.toBlob = function(callback, type) {
            originalToBlob.call(this, async blob => {
              try {
                const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
                canvas.width = bitmap.width; canvas.height = bitmap.height;
                const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
                const scale = Math.max(1, Math.min(3, bitmap.width / document.getElementById('viewport').clientWidth));
                const sample = [...context.getImageData(Math.round(138 * scale), Math.round(bitmap.height - 61 * scale), 1, 1).data];
                callback(blob); resolve(sample);
              } catch (error) { reject(error); }
            }, type);
          };
          document.getElementById('export-png').click();
        });
        results.push({ scheme: exportedLegend.scheme, minimum: exportedLegend.minimum, maximum: exportedLegend.maximum, pixels, texts: [...texts], auto: document.getElementById('legend-auto').getAttribute('aria-pressed') });
      }
    } finally {
      WebGLRenderer.prototype.exportPng = originalExport; HTMLCanvasElement.prototype.toBlob = originalToBlob;
      HTMLAnchorElement.prototype.click = originalClick; CanvasRenderingContext2D.prototype.fillText = originalText;
    }
    return results;
  })()`);
  assert.deepEqual(paletteExports.map(entry => entry.scheme), ['magma', 'inferno', 'cividis', 'turbo', 'spectral']);
  assert.equal(new Set(paletteExports.map(entry => entry.pixels.join(','))).size, 5, 'new maps produce different PNG color bars');
  for (const entry of paletteExports) {
    assert.deepEqual([entry.minimum, entry.maximum], [-5, 25]);
    assert.equal(entry.auto, 'false', 'changing palettes does not change range mode');
    assert.equal(entry.pixels[3], 255, 'the exported color bar is present');
    assert.ok(entry.texts.includes('-5') && entry.texts.includes('25'), 'PNG labels use the saved bounds');
  }
  await colorProperty('temp', 'legend');
  assert.equal(await legendAuto(), true, 'another property has independent Auto state');
  assert.deepEqual(await legendRange(), [300, 1200]);
  await legendScheme('magma');
  await evaluate(`(() => { const [minimum, maximum] = document.querySelectorAll('.legend-controls input[type=number]'); minimum.value = '0'; minimum.dispatchEvent(new Event('input')); maximum.value = '1500'; maximum.dispatchEvent(new Event('input')); })()`);
  await colorProperty('pe', 'legend');
  assert.equal(await legendAuto(), false);
  assert.deepEqual(await legendRange(), [-5, 25]);
  assert.equal(await evaluate('document.querySelector(".legend-scheme select").value'), 'spectral');
  await colorProperty('constant');
  assert.deepEqual(await legendRange(), [7, 7]);
  await evaluate('document.getElementById("legend-auto").click()');
  const constantLimits = await legendRange();
  assert.equal(await legendAuto(), false);
  assert.equal(constantLimits[0], 7);
  assert.ok(Number.isFinite(constantLimits[1]) && constantLimits[1] > 7, 'a constant scalar freezes to a valid ordered range');
  await legendFrame(0);
  assert.deepEqual(await legendRange(), constantLimits);
  await legendFrame(2);
  await colorProperty('pe');
  const fixedLegendRecipe = await exportConfiguration();
  assert.equal(fixedLegendRecipe.settings.display.colorMode, 'property:pe', 'the selected legend quantity is saved in configuration');
  assert.ok(fixedLegendRecipe.settings.colors.ranges.some(range => range.property === 'pe' && range.minimum === -5 && range.maximum === 25));
  assert.ok(fixedLegendRecipe.settings.colors.ranges.some(range => range.property === 'temp' && range.minimum === 0 && range.maximum === 1500));
  const legendRecipePath = resolve(profile, 'legend-recipe.json');
  await writeFile(legendRecipePath, JSON.stringify(fixedLegendRecipe));
  const { nodeId: legendConfigurationInput } = await call('DOM.querySelector', { nodeId: domRoot.nodeId, selector: '#configuration-file' });
  await legendFrame(0);
  await evaluate('document.getElementById("legend-auto").click()');
  await legendScheme('viridis');
  await call('DOM.setFileInputFiles', { nodeId: legendConfigurationInput, files: [legendRecipePath] });
  await waitFor('document.getElementById("frame-label").textContent === "3 / 3" && document.getElementById("configuration-status").textContent.includes("restored")', 'fixed legend recipe replay');
  assert.equal(await legendAuto(), false);
  compareSettings((await exportConfiguration()).settings, fixedLegendRecipe.settings);
  await legendFrame(0);
  assert.deepEqual(await legendRange(), [-5, 25]);
  await colorProperty('temp');
  assert.equal(await legendAuto(), false);
  assert.deepEqual(await legendRange(), [0, 1500]);
  assert.equal(await evaluate('document.querySelector(".legend-scheme select").value'), 'magma');
  await colorProperty('pe');
  await evaluate('document.getElementById("legend-auto").click()');
  const automaticLegendRecipe = await exportConfiguration();
  assert.equal(automaticLegendRecipe.settings.colors.ranges.some(range => range.property === 'pe'), false, 'Auto is exported as absence of fixed bounds');
  assert.ok(automaticLegendRecipe.settings.colors.ranges.some(range => range.property === 'temp'), 'other fixed properties remain saved');
  const automaticLegendPath = resolve(profile, 'legend-auto-recipe.json');
  await writeFile(automaticLegendPath, JSON.stringify(automaticLegendRecipe));
  await legendFrame(2);
  await evaluate('document.getElementById("legend-auto").click()');
  await call('DOM.setFileInputFiles', { nodeId: legendConfigurationInput, files: [automaticLegendPath] });
  await waitFor('document.getElementById("frame-label").textContent === "1 / 3" && document.getElementById("legend-auto").getAttribute("aria-pressed") === "true" && document.getElementById("configuration-status").textContent.includes("restored")', 'automatic legend recipe replay');
  assert.deepEqual(await legendRange(), [0, 3]);
  await legendFrame(1);
  assert.deepEqual(await legendRange(), [-10, 20], 'imported Auto continues to fit subsequent frames');
  if (process.argv.includes('--structure-screenshot')) {
    await showTool('display');
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/alloyview-legend-auto.png', Buffer.from(capture.data, 'base64'));
  }
  await call('DOM.setFileInputFiles', { nodeId, files: [resolve(root, 'examples/fcc-vacancy.cfg')] });
  await waitFor('document.getElementById("file-name").textContent === "fcc-vacancy.cfg" && document.getElementById("loading").hidden', 'return from legend trajectory');

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
    window.ptmStartup = []; window.ptmStatuses = []; window.ptmWorkersCreated = 0;
    let pool, originalFactory;
    AnalysisPool.prototype.analyze = function(frame, parameters, ...rest) {
      if (!pool) {
        pool = this; originalFactory = this.workerFactory;
        this.workerFactory = () => { window.ptmWorkersCreated++; return originalFactory(); };
      }
      window.analysisInputs.push({ kind: parameters.kind, reused: !!parameters.ptmInput });
      const options = rest[0] ?? {};
      return original.call(this, frame, parameters, { ...options, onProgress(progress) {
        if (parameters.kind === 'ptm') window.ptmStartup.push(progress);
        options.onProgress?.(progress);
        if (parameters.kind === 'ptm') window.ptmStatuses.push(document.getElementById('ptm-status').textContent);
      } });
    };
    window.restorePtmPool = () => { AnalysisPool.prototype.analyze = original; pool.workerFactory = originalFactory; };
    document.getElementById('toast').hidden = true;
    document.getElementById('run-ptm').click(); document.getElementById('run-strain').click();
  })()`);
  await waitFor('document.getElementById("ptm-state").textContent === "Calculated" && document.getElementById("strain-state").textContent === "Calculated"', 'PTM and atomic strain');
  const startupPhases = await evaluate('window.ptmStartup.map(progress => progress.phase)');
  for (const phase of ['preparing', 'initializing', 'indexing', 'analyzing', 'complete']) assert.ok(startupPhases.includes(phase), `PTM startup must report ${phase}`);
  assert.deepEqual(await evaluate('(() => { const last = window.ptmStartup.at(-1); return [last.completedAtoms, last.totalAtoms]; })()'), [31, 31], 'PTM progress must end with the actual processed atom count');
  assert.ok(await evaluate('window.ptmStatuses.some(status => status.includes("Preparing frame"))'), 'the UI must describe coordinate preparation');
  assert.ok(await evaluate('window.ptmStatuses.some(status => status.includes("Initializing"))'), 'the UI must describe Worker/Wasm initialization');
  assert.ok(await evaluate('window.ptmStatuses.some(status => status.includes("Analyzing frame"))'), 'the UI must distinguish analysis from initialization');
  const warmWorkerCount = await evaluate('window.ptmWorkersCreated');
  assert.equal(await evaluate('document.getElementById("toast").hidden'), true, 'unmatched defect atoms must not produce a warning');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "atomicShearStrain").data.filter(Number.isNaN).length'), 12);
  assert.equal(await evaluate('document.querySelector("[data-lattice-a]").valueAsNumber'), 4.05);
  assert.equal(await evaluate('document.querySelector("[data-reference-element]").value'), 'Al');
  assert.ok(await evaluate('window.analysisInputs.some(input => input.kind === "strain" && input.reused)'));
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "atomicHydrostaticStrain").data.filter(Number.isFinite).every(value => Math.abs(value) < 1e-5)'), true);
  assert.ok(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "atomicHydrostaticStrain").data.some(Number.isFinite)'));
  await evaluate(`(() => { const input = document.querySelector('[data-lattice-a]'); input.value = '3.9'; input.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("strain-state").textContent === "Calculated"', 'edited lattice strain');
  assert.equal(await evaluate('window.ptmWorkersCreated'), warmWorkerCount, 'subsequent strain must reuse an idle initialized Worker');
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
  assert.equal(await evaluate('window.structureTestRenderer.visibility.every(value => value === 255)'), true, 'CNA category filters do not leak into the independent PTM field');
  assert.equal(await evaluate('document.querySelector("[data-category-property=ptmStructureType][data-category-id=\\"0\\"]").checked'), true);
  await evaluate(`document.querySelector('[data-structure-type="0"]').click()`);
  assert.equal(await evaluate(`(() => {
    const r = window.structureTestRenderer, types = r.frame.properties.find(p => p.name === 'ptmStructureType').data;
    return types.every((type, i) => r.visibility[i] === (type === 0 ? 0 : 255));
  })()`), true, 'PTM retains its own category visibility choices');
  await evaluate(`document.querySelector('[data-structure-type="1"]').click()`);
  assert.equal(await evaluate('window.structureTestRenderer.visibility.every(value => value === 0)'), true);
  await evaluate(`document.querySelector('[data-structure-type="1"]').click(); window.restorePtmPool();`);
  await evaluate(`(() => { const crystal = document.querySelector('[data-reference-structure]'); crystal.value = '3'; crystal.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("strain-state").textContent === "Calculated"', 'entirely NaN strain');
  assert.equal(await evaluate('document.getElementById("toast").hidden'), true);
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "atomicShearStrain").data.every(Number.isNaN)'), true);
  await evaluate(`(() => { const mode = document.getElementById('color-mode'); mode.value = 'property:atomicShearStrain'; mode.dispatchEvent(new Event('change')); })()`);
  assert.equal(await evaluate('window.structureTestColors.every(value => value === 130)'), true);
  assert.equal(await evaluate('document.querySelector("[data-category-id=\\"NaN\\"]").getAttribute("aria-label")'), 'Show NaN atoms');
  assert.match(await evaluate('document.querySelector(".legend-count").textContent.trim()'), /^31\s*·\s*100\.0%$/, 'the all-NaN category reports its count and fraction');
  await evaluate(`(() => { const crystal = document.querySelector('[data-reference-structure]'); crystal.value = '1'; crystal.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("strain-state").textContent === "Calculated"', 'reference recovery');
  // A new source clears filters; enabled analysis follows trajectory frames.
  await evaluate(`document.getElementById('open-examples').click(); [...document.querySelectorAll('.source-option')].find(b => b.textContent.includes('bcc-trajectory.dump')).click();`);
  await waitFor('document.getElementById("file-name").textContent.includes("bcc-trajectory.dump") && document.getElementById("loading").hidden', 'BCC source');
  await evaluate(`document.getElementById('run-cna').click()`);
  await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'BCC classification');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "structureType").data.every(id => id === 3)'), true);
  assert.equal(await evaluate(`document.querySelector('[data-structure-type="0"]').checked`), true);
  await evaluate(`document.getElementById('run-csp').click(); document.getElementById('run-ptm').click(); document.getElementById('run-strain').click();`);
  await waitFor('["csp", "ptm", "strain"].every(prefix => document.getElementById(prefix + "-state").textContent === "Calculated")', 'BCC Auto central symmetry, PTM and strain');
  assert.equal(await evaluate('document.getElementById("csp-neighbors").value'), 'auto');
  assert.match(await evaluate('document.getElementById("csp-neighbors").selectedOptions[0].textContent'), /Auto.*BCC/);
  assert.equal(await evaluate('window.structureTestRenderer.frame.ptm.structures.every(type => type === 3)'), true);
  assert.equal(await evaluate('document.querySelector("[data-lattice-a]").valueAsNumber'), 2.87);
  await evaluate(`(() => { const select = document.getElementById('color-mode'); select.value = 'property:ptmStructureType'; select.dispatchEvent(new Event('change')); })()`);
  await evaluate(`document.querySelector('[data-structure-type="3"]').click(); document.getElementById('frame-last').click();`);
  await waitFor('document.getElementById("frame-label").textContent === "2 / 2" && ["cna", "csp", "ptm", "strain"].every(prefix => document.getElementById(prefix + "-state").textContent === "Calculated")', 'trajectory CNA/Auto central symmetry/PTM/strain');
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.find(p => p.name === "centralSymmetryNeighbors").data.every(value => value === 8)'), true);
  assert.equal(await evaluate(`document.querySelector('[data-structure-type="3"]').checked`), false);
  assert.equal(await evaluate('window.structureTestRenderer.visibility.every(value => value === 0)'), true);
  await evaluate(`document.querySelector('[data-structure-type="3"]').click(); document.getElementById('frame-first').click();`);
  await waitFor('document.getElementById("frame-label").textContent === "1 / 2" && ["cna", "csp", "strain"].every(prefix => document.getElementById(prefix + "-state").textContent === "Calculated")', 'cached trajectory analyses');
  assert.match(await evaluate('document.getElementById("csp-neighbors").selectedOptions[0].textContent'), /Auto.*BCC/);
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
    if (kind === 'centrosymmetry') {
      assert.equal(await evaluate('document.getElementById("csp-neighbors").selectedOptions[0].textContent.trim()'), 'Auto');
      assert.equal(await evaluate('document.getElementById("csp-auto-result").hidden'), true);
    }
  }
  assert.equal(await evaluate('document.querySelector("[data-lattice-a]").valueAsNumber'), 3.3, 'reset preserves the reference settings');
  assert.equal(await evaluate('window.structureTestRenderer.frame.ptm === undefined'), true);
  const callsBeforeFrames = await evaluate('window.cancelTestCalls.length');
  for (const [button, label] of [['frame-last', '2 / 2'], ['frame-first', '1 / 2']]) {
    await evaluate(`document.getElementById('${button}').click()`);
    await waitFor(`document.getElementById('frame-label').textContent === '${label}' && document.getElementById('loading').hidden`, 'frames after cancellation');
    for (const [, prefix] of cancelCases) assert.equal(await evaluate(`document.getElementById('${prefix}-state').textContent`), 'Not calculated');
    for (const [kind] of cancelCases) {
      assert.equal(await evaluate(`window.structureTestRenderer.frame.properties.some(property => property.analysisKind === ${JSON.stringify(kind)})`), false, `${kind} stays cleared after frame navigation`);
    }
    assert.equal(await evaluate('window.structureTestRenderer.frame.properties.some(property => property.analysisKind === "displacement")'), false, 'displacement remains uncomputed until its independent tool is enabled');
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

  // Multiple world-space half-planes intersect, including repeated images.
  // The controls normalize arbitrary XYZ normals and retain distinct names.
  await evaluate(`document.getElementById('replicate-a').value = '2'; document.getElementById('apply-replicate').click()`);
  await showTool('slice');
  await clickElement('#add-slice');
  await evaluate(`(() => {
    const name = document.getElementById('slice-name'); name.value = 'Oblique cap'; name.dispatchEvent(new Event('input')); name.dispatchEvent(new Event('change'));
    const entries = [['slice-normal-x', 1], ['slice-normal-y', 1], ['slice-normal-z', 0], ['slice-offset', 4]];
    for (const [id, value] of entries) document.getElementById(id).value = value;
    const normal = document.getElementById('slice-normal-x'); normal.dispatchEvent(new Event('input')); normal.dispatchEvent(new Event('change'));
  })()`);
  await clickElement('#add-slice');
  await evaluate(`(() => {
    const name = document.getElementById('slice-name'); name.value = 'Lower X bound'; name.dispatchEvent(new Event('input')); name.dispatchEvent(new Event('change'));
    const entries = [['slice-normal-x', 1], ['slice-normal-y', 0], ['slice-normal-z', 0], ['slice-offset', 2]];
    for (const [id, value] of entries) document.getElementById(id).value = value;
    const normal = document.getElementById('slice-normal-x'); normal.dispatchEvent(new Event('input')); normal.dispatchEvent(new Event('change'));
    const side = document.getElementById('slice-side'); side.value = 'positive'; side.dispatchEvent(new Event('change'));
  })()`);
  const worldSlices = await evaluate(`(() => {
    const renderer = window.structureTestRenderer;
    const values = renderer.replicas.map(replica => Array.from({ length: renderer.atomCount }, (_, atom) => renderer.isAtomVisible(atom, replica.indices)));
    return { planes: renderer.slices, values, positions: Array.from(renderer.displayPositions), offsets: renderer.replicas.map(replica => replica.offset),
      names: [...document.querySelectorAll('#slice-list [data-slice-id]')].map(button => button.textContent) };
  })()`);
  assert.equal(worldSlices.planes.length, 2);
  assert.ok(worldSlices.names[0].includes('Oblique cap'));
  assert.ok(worldSlices.names[1].includes('Lower X bound'));
  assert.ok(Math.abs(Math.hypot(...worldSlices.planes[0].normal) - 1) < 1e-6);
  assert.ok(Math.abs(worldSlices.planes[0].normal[0] - Math.SQRT1_2) < 1e-6);
  assert.ok(worldSlices.values[0].some(Boolean), 'the two half-planes must leave some source atoms');
  assert.ok(worldSlices.values[1].every(value => !value), 'world-space slicing must remove distant replicated images');
  for (let copy = 0; copy < worldSlices.values.length; copy++) for (let atom = 0; atom < worldSlices.values[copy].length; atom++) {
    const position = worldSlices.positions.slice(atom * 3, atom * 3 + 3).map((value, axis) => value + worldSlices.offsets[copy][axis]);
    const expected = worldSlices.planes.every(plane => {
      const distance = plane.normal.reduce((sum, component, axis) => sum + component * position[axis], 0) - plane.position;
      return !plane.enabled || (plane.side === 'positive' ? distance >= -1e-5 : distance <= 1e-5);
    });
    assert.equal(worldSlices.values[copy][atom], expected, 'CPU picking visibility must use the intersection in Cartesian space');
  }
  await clickElement('#slice-list [data-slice-id="slice-0"]');
  await clickElement('#slice-enabled');
  assert.equal(await evaluate('window.structureTestRenderer.replicas.every(replica => Array.from({length: window.structureTestRenderer.atomCount}, (_, atom) => window.structureTestRenderer.isAtomVisible(atom, replica.indices)).some(Boolean))'), true, 'disabling one plane must reveal clipped copies');
  await clickElement('#slice-enabled');

  // Changing the displayed coordinates changes clipping, even though wrapped
  // fractional analysis coordinates stay untouched (the unwrapped-view path).
  const displayedClipping = await evaluate(`(() => {
    const renderer = window.structureTestRenderer, original = renderer.displayPositions;
    const atom = Array.from({ length: renderer.atomCount }, (_, index) => index).find(index => renderer.isAtomVisible(index));
    const moved = new original.constructor(original); moved[atom * 3] += 100;
    renderer.setDisplayPositions(moved);
    const hidden = !renderer.isAtomVisible(atom);
    renderer.setDisplayPositions(original);
    return { hidden, restored: renderer.isAtomVisible(atom) };
  })()`);
  assert.deepEqual(displayedClipping, { hidden: true, restored: true });

  // Dragging a normal/position handle updates numerical settings while the
  // underlying camera retains its orientation and pan.
  await waitFor('!document.querySelector("svg.slice-gizmo").hidden && document.querySelector(".slice-normal-head").getBoundingClientRect().width > 0', 'slice gizmo');
  const gizmoBefore = await evaluate(`(() => {
    const renderer = window.structureTestRenderer;
    return { yaw: renderer.yaw, pitch: renderer.pitch, pan: [...renderer.pan], normal: [...renderer.slices[0].normal], position: renderer.slices[0].position };
  })()`);
  await dragElement('.slice-normal-head', 34, -28);
  const rotatedPlane = await evaluate(`(() => {
    const renderer = window.structureTestRenderer;
    return { yaw: renderer.yaw, pitch: renderer.pitch, pan: [...renderer.pan], normal: [...renderer.slices[0].normal],
      position: renderer.slices[0].position, fields: ['x', 'y', 'z'].map(axis => document.getElementById('slice-normal-' + axis).valueAsNumber) };
  })()`);
  assert.ok(rotatedPlane.normal.some((value, axis) => Math.abs(value - gizmoBefore.normal[axis]) > .01), 'the normal handle must rotate the plane');
  assert.ok(Math.abs(Math.hypot(...rotatedPlane.normal) - 1) < 1e-5);
  rotatedPlane.fields.forEach((value, axis) => assert.ok(Math.abs(value - rotatedPlane.normal[axis]) < 1e-4, 'rotation must update sidebar values'));
  assert.equal(rotatedPlane.yaw, gizmoBefore.yaw); assert.equal(rotatedPlane.pitch, gizmoBefore.pitch); assert.deepEqual(rotatedPlane.pan, gizmoBefore.pan);
  await dragElement('.slice-position-handle', 22, 25);
  const translatedPlane = await evaluate(`(() => {
    const renderer = window.structureTestRenderer;
    return { yaw: renderer.yaw, pitch: renderer.pitch, pan: [...renderer.pan], position: renderer.slices[0].position,
      field: document.getElementById('slice-offset').valueAsNumber };
  })()`);
  assert.ok(Math.abs(translatedPlane.position - rotatedPlane.position) > .01, 'the position handle must translate the plane');
  assert.ok(Math.abs(translatedPlane.field - translatedPlane.position) < 1e-4, 'translation must update the sidebar offset');
  assert.equal(translatedPlane.yaw, gizmoBefore.yaw); assert.equal(translatedPlane.pitch, gizmoBefore.pitch); assert.deepEqual(translatedPlane.pan, gizmoBefore.pan);
  await clickElement('#delete-slice');
  assert.equal(await evaluate('window.structureTestRenderer.slices.length'), 1);
  assert.equal(await evaluate('document.getElementById("slice-name").value'), 'Lower X bound');
  const clippedCopy = await evaluate(`(async () => {
    const renderer = window.structureTestRenderer, gl = renderer.gl;
    const appUrl = document.querySelector('script[type="module"]').src;
    const { transformPoint } = await import(new URL('./render/math.js', appUrl));
    const visibility = renderer.visibility, cellVisible = renderer.cellVisible, repetitions = [...renderer.repetitions];
    const mask = new Uint8Array(renderer.atomCount); mask[0] = 255;
    const coverage = async () => {
      const query = gl.createQuery();
      try {
        gl.beginQuery(gl.ANY_SAMPLES_PASSED, query); renderer.render(performance.now(), { trackStats: false }); gl.endQuery(gl.ANY_SAMPLES_PASSED); gl.finish();
        for (let attempt = 0; attempt < 200 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) throw new Error('Slice GPU query timed out');
        return Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT));
      } finally { gl.deleteQuery(query); }
    };
    try {
      renderer.setVisibility(mask); renderer.setCellVisible(false); renderer.updateMatrices();
      const offset = renderer.replicas[1].offset, position = renderer.displayPositions.subarray(0, 3);
      const clip = transformPoint(renderer.viewProjectionMatrix, ...position.map((value, axis) => value + offset[axis]));
      const rect = renderer.canvas.getBoundingClientRect();
      const picked = renderer.pick(rect.left + (clip[0] / clip[3] * .5 + .5) * rect.width, rect.top + (.5 - clip[1] / clip[3] * .5) * rect.height);
      const sourceVisible = renderer.isAtomVisible(0), replicaVisible = renderer.isAtomVisible(0, renderer.replicas[1].indices), withCopy = await coverage();
      renderer.setReplications([1, 1, 1]);
      return { picked, sourceVisible, replicaVisible, withCopy, sourceOnly: await coverage(), glError: gl.getError() };
    } finally { renderer.setReplications(repetitions); renderer.setVisibility(visibility); renderer.setCellVisible(cellVisible); }
  })()`);
  assert.deepEqual(clippedCopy, { picked: 0, sourceVisible: false, replicaVisible: true, withCopy: true, sourceOnly: false, glError: 0 }, 'a visible copy of a clipped source atom must render and pick its original ID');

  // A processing recipe restores settings on the current source and after
  // closing/reselecting local files, without embedding their coordinates.
  await evaluate('document.getElementById("frame-last").click()');
  await waitFor('document.getElementById("frame-label").textContent === "2 / 2" && document.getElementById("loading").hidden', 'recipe trajectory frame');
  await evaluate(`(() => {
    const element = document.querySelector('[data-reference-element]'); element.value = 'Fe'; element.dispatchEvent(new Event('change'));
    const lattice = document.querySelector('[data-lattice-a]'); lattice.value = '3.3'; lattice.dispatchEvent(new Event('change'));
    for (const prefix of ['cna', 'ptm', 'strain']) document.getElementById('run-' + prefix).click();
  })()`);
  await waitFor('["cna", "ptm", "strain"].every(prefix => document.getElementById(prefix + "-state").textContent === "Calculated")', 'recipe analyses');
  await showTool('slice');
  await clickElement('#add-slice');
  await evaluate(`(() => {
    const name = document.getElementById('slice-name'); name.value = 'Saved cap'; name.dispatchEvent(new Event('input'));
    const offset = document.getElementById('slice-offset'); offset.value = '100'; offset.dispatchEvent(new Event('change'));
    const radius = document.getElementById('radius-percent'); radius.value = '67'; radius.dispatchEvent(new Event('input'));
    document.querySelector('[data-background="#fff8e7"]').click();
    for (const [id, value] of [['show-cell', false], ['show-axes', false]]) {
      const field = document.getElementById(id); field.checked = value; field.dispatchEvent(new Event('change'));
    }
    document.getElementById('png-background').checked = false; document.getElementById('png-legend').checked = true; document.getElementById('png-axes').checked = true;
    const mode = document.getElementById('color-mode'); mode.value = 'property:ptmStructureType'; mode.dispatchEvent(new Event('change'));
    const other = document.querySelector('[data-structure-type="0"]'); if (other.checked) other.click();
    const renderer = window.structureTestRenderer;
    renderer.setProjection('orthographic'); renderer.yaw = .34; renderer.pitch = .27; renderer.pan = [.2, -.4, .1]; renderer.requestRender();
    const selected = Array.from({ length: renderer.atomCount }, (_, atom) => atom).find(atom => renderer.isAtomVisible(atom));
    renderer.onPick(selected);
  })()`);
  assert.equal(await evaluate('document.querySelector("[data-tool-button=configuration]")'), null, 'configuration is always available outside Tools');
  assert.equal(await evaluate('document.getElementById("configuration-section").hidden'), false);
  const recipe = await exportConfiguration();
  assert.equal(recipe.app, 'AlloyView'); assert.equal(recipe.version, 1);
  assert.equal(recipe.source.files[0].name, 'partial-pbc.dump'); assert.equal(recipe.source.frameIndex, 1);
  assert.equal(recipe.settings.display.radiusPercent, 67);
  assert.deepEqual(recipe.settings.replicate, [2, 1, 1]);
  assert.equal(recipe.settings.slices.items.length, 2);
  assert.equal(recipe.settings.analyses.strain.references[0].a, 3.3);
  for (const name of ['cna', 'ptm', 'strain']) assert.equal(recipe.settings.analyses[name].enabled, true);
  assert.ok(JSON.stringify(recipe).length < 20_000, 'recipes must not serialize atom arrays');
  const recipePath = resolve(profile, 'processing-recipe.json');
  await writeFile(recipePath, JSON.stringify(recipe));
  const { nodeId: configurationInput } = await call('DOM.querySelector', { nodeId: domRoot.nodeId, selector: '#configuration-file' });
  await evaluate(`(() => {
    for (const prefix of ['cna', 'ptm', 'strain']) document.getElementById('cancel-' + prefix).click();
    document.getElementById('reset-replicate').click();
    while (window.structureTestRenderer.slices.length) document.getElementById('delete-slice').click();
    const radius = document.getElementById('radius-percent'); radius.value = '120'; radius.dispatchEvent(new Event('input'));
    document.querySelector('[data-background="#000000"]').click(); document.getElementById('reset-camera').click();
  })()`);
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [recipePath] });
  await waitFor('document.getElementById("radius-percent").value === "67" && ["cna", "ptm", "strain"].every(prefix => document.getElementById(prefix + "-state").textContent === "Calculated")', 'same-source recipe replay');
  compareSettings((await exportConfiguration()).settings, recipe.settings);
  await evaluate('document.getElementById("close-file").click()');
  await checkHome();
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [recipePath] });
  await waitFor('document.getElementById("configuration-status").textContent.toLowerCase().includes("select")', 'recipe awaiting local files');
  assert.equal(await evaluate('window.structureTestRenderer.frame'), null, 'imported recipes cannot load missing local files automatically');
  await call('DOM.setFileInputFiles', { nodeId, files: [partialPbcPath] });
  await waitFor('document.getElementById("frame-label").textContent === "2 / 2" && document.getElementById("radius-percent").value === "67" && ["cna", "ptm", "strain"].every(prefix => document.getElementById(prefix + "-state").textContent === "Calculated")', 'reselected-source recipe replay');
  const replayed = await exportConfiguration();
  compareSettings(replayed.settings, recipe.settings);
  assert.equal(replayed.source.frameIndex, 1);

  // Importing an old recipe during source loading must wait for the new
  // source to commit. It cannot change the frame request and discard it.
  await evaluate('window.holdNextSource = true; window.sourceResultHeld = false');
  await call('DOM.setFileInputFiles', { nodeId, files: [resolve(root, 'examples/fcc-vacancy.cfg')] });
  await waitFor('window.sourceResultHeld === true', 'held replacement source');
  assert.equal(await evaluate('document.getElementById("export-configuration").disabled'), true, 'export must be disabled while source ownership is changing');
  assert.equal(await evaluate('document.getElementById("frame-slider").disabled'), true);
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [recipePath] });
  await waitFor('document.getElementById("configuration-status").textContent.includes("Waiting for source files")', 'recipe pending during source loading');
  await evaluate('window.releaseSource()');
  await waitFor('document.getElementById("file-name").textContent === "fcc-vacancy.cfg" && document.getElementById("loading").hidden', 'replacement source commits after recipe import');
  assert.equal(await evaluate('window.structureTestRenderer.frame.ids.length'), 31);
  assert.equal(await evaluate('document.getElementById("frame-label").textContent'), '1 / 1');
  assert.ok(await evaluate('document.getElementById("configuration-status").textContent.includes("partial-pbc.dump")'));
  await call('DOM.setFileInputFiles', { nodeId, files: [partialPbcPath] });
  await waitFor('document.getElementById("frame-label").textContent === "2 / 2" && ["cna", "ptm", "strain"].every(prefix => document.getElementById(prefix + "-state").textContent === "Calculated")', 'pending recipe resumes after the matching source');
  compareSettings((await exportConfiguration()).settings, recipe.settings);

  // A recipe's asynchronous frame preflight can also lose source ownership.
  // Hold a real parser response, then open a different source before delivery.
  const preflightRecipe = structuredClone(recipe);
  preflightRecipe.source.frameIndex = 0; preflightRecipe.settings.display.radiusPercent = 211;
  preflightRecipe.settings.camera.yaw = 1.11;
  const preflightPath = resolve(profile, 'preflight-recipe.json');
  await writeFile(preflightPath, JSON.stringify(preflightRecipe));
  await holdRecipePreflight();
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [preflightPath] });
  await waitFor('window.preflightResultHeld === true', 'held recipe frame preflight');
  await call('DOM.setFileInputFiles', { nodeId, files: [resolve(root, 'examples/fcc-vacancy.cfg')] });
  await waitFor('document.getElementById("file-name").textContent === "fcc-vacancy.cfg" && document.getElementById("loading").hidden', 'source replacing an in-flight recipe');
  const replacementRadius = await evaluate('document.getElementById("radius-percent").value');
  await evaluate('window.releasePreflight(); window.restorePreflightHooks()');
  await delay(100);
  assert.equal(await evaluate('window.structureTestRenderer.frame.ids.length'), 31);
  assert.equal(await evaluate('document.getElementById("frame-label").textContent'), '1 / 1');
  assert.equal(await evaluate('document.getElementById("radius-percent").value'), replacementRadius, 'a stale recipe must not write its radius after source replacement');
  assert.notEqual(replacementRadius, '211');
  assert.notEqual(await evaluate('window.structureTestRenderer.yaw'), 1.11, 'a stale recipe must not write its camera');
  assert.equal(await evaluate('document.getElementById("export-configuration").disabled'), false);
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [recipePath] });
  await waitFor('document.getElementById("configuration-status").textContent.includes("Waiting for source files")', 'original recipe pending again');
  await call('DOM.setFileInputFiles', { nodeId, files: [partialPbcPath] });
  await waitFor('document.getElementById("frame-label").textContent === "2 / 2" && ["cna", "ptm", "strain"].every(prefix => document.getElementById(prefix + "-state").textContent === "Calculated")', 'recipe recovery after preflight interruption');
  compareSettings((await exportConfiguration()).settings, recipe.settings);

  // A real user edit supersedes a held restore, even without changing source.
  // Its delayed response must leave the typed value and current frame intact.
  await holdRecipePreflight();
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [preflightPath] });
  await waitFor('window.preflightResultHeld === true', 'recipe preflight before a manual edit');
  await showTool('display');
  await clickElement('#radius-percent');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await call('Input.insertText', { text: '83' });
  assert.equal(await evaluate('document.getElementById("radius-percent").value'), '83');
  await evaluate('window.releasePreflight(); window.restorePreflightHooks()');
  await delay(100);
  assert.equal(await evaluate('document.getElementById("radius-percent").value'), '83', 'the delayed recipe must not overwrite a manual settings edit');
  assert.equal(await evaluate('document.getElementById("frame-label").textContent'), '2 / 2', 'the delayed recipe must not change frames after a manual settings edit');
  assert.ok(await evaluate('document.getElementById("configuration-status").textContent.toLowerCase().includes("interrupt")'));
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [recipePath] });
  await waitFor('document.getElementById("radius-percent").value === "67" && ["cna", "ptm", "strain"].every(prefix => document.getElementById(prefix + "-state").textContent === "Calculated")', 'recipe can be retried after a manual edit');
  compareSettings((await exportConfiguration()).settings, recipe.settings);

  // A failed automatically resumed recipe loses status ownership when a
  // newer recipe is imported, even while the same source remains active.
  await call('DOM.setFileInputFiles', { nodeId, files: [resolve(root, 'examples/fcc-vacancy.cfg')] });
  await waitFor('document.getElementById("file-name").textContent === "fcc-vacancy.cfg" && document.getElementById("loading").hidden', 'source before competing pending recipes');
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [preflightPath] });
  await waitFor('document.getElementById("configuration-status").textContent.includes("Waiting for source files")', 'pending recipe A');
  await holdRecipePreflight();
  await call('DOM.setFileInputFiles', { nodeId, files: [partialPbcPath] });
  await waitFor('window.preflightResultHeld === true', 'held automatically resumed recipe A');
  const newerRecipe = structuredClone(recipe);
  newerRecipe.source = { kind: 'file', label: 'fcc-vacancy.cfg', format: 'cfg', frameIndex: 0, frameCount: 1,
    files: [{ name: 'fcc-vacancy.cfg', relativePath: 'fcc-vacancy.cfg', size: (await readFile(resolve(root, 'examples/fcc-vacancy.cfg'))).byteLength }] };
  const newerPath = resolve(profile, 'newer-pending-recipe.json');
  await writeFile(newerPath, JSON.stringify(newerRecipe));
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [newerPath] });
  await waitFor('document.getElementById("configuration-status").textContent.includes("Waiting for source files") && document.getElementById("configuration-status").textContent.includes("fcc-vacancy.cfg")', 'newer pending recipe B');
  const newerStatus = await evaluate('document.getElementById("configuration-status").textContent');
  await evaluate('window.rejectPreflight(); window.restorePreflightHooks()');
  await delay(100);
  assert.equal(await evaluate('document.getElementById("configuration-status").textContent'), newerStatus, 'a stale pending restore failure must not replace the newer recipe status');
  assert.equal(await evaluate('document.getElementById("toast").textContent.includes("Stale pending recipe failed")'), false, 'a stale pending restore failure must not show an error for the newer recipe');
  assert.equal(await evaluate('window.structureTestRenderer.frame.ids.length'), 16);
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [recipePath] });
  await waitFor('document.getElementById("frame-label").textContent === "2 / 2" && ["cna", "ptm", "strain"].every(prefix => document.getElementById(prefix + "-state").textContent === "Calculated")', 'recipe recovery after competing imports');
  compareSettings((await exportConfiguration()).settings, recipe.settings);

  // Invalid schemas and unavailable saved frames reject before altering
  // camera, filters, references or the currently calculated analyses.
  const invalidRecipe = structuredClone(recipe); invalidRecipe.version = 999;
  const invalidPath = resolve(profile, 'invalid-recipe.json');
  await writeFile(invalidPath, JSON.stringify(invalidRecipe));
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [invalidPath] });
  await waitFor('document.getElementById("toast").textContent.includes("version")', 'invalid configuration version rejection');
  compareSettings((await exportConfiguration()).settings, recipe.settings);
  const unavailableRecipe = structuredClone(recipe);
  unavailableRecipe.source.frameIndex = 2; unavailableRecipe.source.frameCount = 3;
  unavailableRecipe.settings.display.radiusPercent = 211;
  const unavailablePath = resolve(profile, 'unavailable-frame-recipe.json');
  await writeFile(unavailablePath, JSON.stringify(unavailableRecipe));
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [unavailablePath] });
  await waitFor('document.getElementById("toast").textContent.includes("saved frame is not available")', 'unavailable saved frame rejection');
  compareSettings((await exportConfiguration()).settings, recipe.settings);

  // Auto central symmetry chooses a neighbor shell per atom. Real native
  // sources cover HCP's finite nonzero CSP and coexisting FCC/BCC regions.
  for (const [phase, type, neighbors] of [['fcc', 1, 12], ['hcp', 2, 12], ['bcc', 3, 8]]) {
    const frame = crystalFrame(phase), sourceName = `auto-csp-${phase}.cfg`, path = resolve(profile, sourceName);
    const lines = [`Number of particles = ${frame.ids.length}`, 'A = 1.0 Angstrom'];
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
      lines.push(`H0(${row + 1},${column + 1}) = ${frame.cell.vectors[row * 3 + column]} A`);
    }
    lines.push('.NO_VELOCITY.', 'entry_count = 3', '1', 'X');
    for (let atom = 0; atom < frame.ids.length; atom++) lines.push([...frame.fractional.subarray(atom * 3, atom * 3 + 3)].join(' '));
    await writeFile(path, lines.join('\n'));
    await call('DOM.setFileInputFiles', { nodeId, files: [path] });
    await waitFor(`document.getElementById('file-name').textContent === '${sourceName}' && document.getElementById('loading').hidden`, `${phase} Auto CSP source`);
    await showTool('centrosymmetry');
    await evaluate(`(() => {
      const select = document.getElementById('csp-neighbors'); select.value = 'auto'; select.dispatchEvent(new Event('change'));
      document.getElementById('run-csp').click();
    })()`);
    await waitFor('document.getElementById("csp-state").textContent === "Calculated"', `${phase} Auto CSP`);
    assert.match(await evaluate('document.getElementById("csp-neighbors").selectedOptions[0].textContent'), new RegExp(`Auto.*${phase.toUpperCase()}`));
    assert.ok(await evaluate(`document.getElementById('csp-auto-result').textContent.includes('${phase.toUpperCase()}')`));
    assert.equal(await evaluate(`(() => {
      const properties = window.structureTestRenderer.frame.properties;
      return properties.find(p => p.name === 'centralSymmetryStructureType').data.every(value => value === ${type})
        && properties.find(p => p.name === 'centralSymmetryNeighbors').data.every(value => value === ${neighbors});
    })()`), true);
    assert.equal(await evaluate('window.structureTestRenderer.frame.properties.some(p => p.analysisKind === "cna")'), false, 'Auto CSP must not enable a separate CNA analysis');
    assert.equal(await evaluate(`window.structureTestRenderer.frame.properties.find(p => p.name === 'centralSymmetry').data.every(value => Number.isFinite(value) && ${phase === 'hcp' ? 'value > 0.001' : 'value < 1e-9'})`), true);
    if (phase === 'hcp' && process.argv.includes('--structure-screenshot')) {
      const capture = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile('/tmp/alloyview-auto-csp-hcp.png', Buffer.from(capture.data, 'base64'));
    }
  }
  const mixedFcc = crystalFrame('fcc', 4, 4), mixedBcc = crystalFrame('bcc', 4, 7);
  const mixedPositions = [...mixedFcc.positions, ...Array.from(mixedBcc.positions, (value, index) => value + (index % 3 === 0 ? 40 : 0))];
  const mixedCount = mixedPositions.length / 3, mixedPath = resolve(profile, 'auto-csp-mixed.dump');
  const mixedLines = ['ITEM: TIMESTEP', '0', 'ITEM: NUMBER OF ATOMS', String(mixedCount),
    'ITEM: BOX BOUNDS ff ff ff', '0 80', '0 80', '0 80', 'ITEM: ATOMS id type element x y z'];
  for (let atom = 0; atom < mixedCount; atom++) mixedLines.push(`${atom + 1} 1 X ${mixedPositions.slice(atom * 3, atom * 3 + 3).join(' ')}`);
  await writeFile(mixedPath, mixedLines.join('\n'));
  await call('DOM.setFileInputFiles', { nodeId, files: [mixedPath] });
  await waitFor('document.getElementById("file-name").textContent === "auto-csp-mixed.dump" && document.getElementById("loading").hidden', 'mixed Auto CSP source');
  await showTool('centrosymmetry');
  await evaluate('document.getElementById("run-csp").click()');
  await waitFor('document.getElementById("csp-state").textContent === "Calculated"', 'mixed Auto CSP');
  assert.match(await evaluate('document.getElementById("csp-neighbors").selectedOptions[0].textContent'), /Auto.*Mixed/);
  assert.equal(await evaluate(`(() => {
    const properties = window.structureTestRenderer.frame.properties;
    const types = properties.find(p => p.name === 'centralSymmetryStructureType').data;
    const neighbors = properties.find(p => p.name === 'centralSymmetryNeighbors').data;
    return types[84] === 1 && neighbors[84] === 12 && types[${mixedFcc.ids.length + 42}] === 3 && neighbors[${mixedFcc.ids.length + 42}] === 8
      && types.every((type, atom) => type === 3 ? neighbors[atom] === 8 : type === 1 || type === 2 ? neighbors[atom] === 12 : true);
  })()`), true, 'coexisting phases must use their own local shells');
  if (process.argv.includes('--structure-screenshot')) {
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/alloyview-auto-csp-mixed.png', Buffer.from(capture.data, 'base64'));
  }
  // Auto reuses genuine adaptive-CNA classifications, while a fixed-cutoff
  // result cannot supply the local reference shells for an Auto calculation.
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', appUrl));
    const original = AnalysisPool.prototype.analyze;
    window.cspStructureInputReuse = [];
    AnalysisPool.prototype.analyze = function(frame, parameters, ...rest) {
      if (parameters.kind === 'centrosymmetry') window.cspStructureInputReuse.push(!!parameters.structureInput);
      return original.call(this, frame, parameters, ...rest);
    };
    window.restoreCspReuseHook = () => { AnalysisPool.prototype.analyze = original; };
    const mode = document.getElementById('cna-mode'); mode.value = 'fixed'; mode.dispatchEvent(new Event('change'));
    document.getElementById('run-cna').click();
  })()`);
  await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'fixed CNA before Auto CSP');
  await evaluate('document.getElementById("cancel-csp").click(); document.getElementById("run-csp").click()');
  await waitFor('document.getElementById("csp-state").textContent === "Calculated"', 'Auto CSP ignoring fixed CNA');
  assert.equal(await evaluate('window.cspStructureInputReuse.at(-1)'), false);
  await evaluate(`(() => { const mode = document.getElementById('cna-mode'); mode.value = 'adaptive'; mode.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("cna-state").textContent === "Calculated"', 'adaptive CNA before Auto CSP');
  await evaluate('document.getElementById("cancel-csp").click(); document.getElementById("run-csp").click()');
  await waitFor('document.getElementById("csp-state").textContent === "Calculated"', 'Auto CSP reusing adaptive CNA');
  assert.equal(await evaluate('window.cspStructureInputReuse.at(-1)'), true);
  await evaluate('window.restoreCspReuseHook()');
  const autoCspRecipe = await exportConfiguration();
  assert.equal(autoCspRecipe.settings.analyses.centrosymmetry.enabled, true);
  assert.equal(autoCspRecipe.settings.analyses.centrosymmetry.mode, 'auto');
  const autoCspPath = resolve(profile, 'auto-csp-recipe.json');
  await writeFile(autoCspPath, JSON.stringify(autoCspRecipe));
  await evaluate('document.getElementById("cancel-csp").click()');
  assert.equal(await evaluate('document.getElementById("csp-neighbors").selectedOptions[0].textContent.trim()'), 'Auto');
  assert.equal(await evaluate('document.getElementById("csp-auto-result").hidden'), true);
  assert.equal(await evaluate('window.structureTestRenderer.frame.properties.some(p => p.analysisKind === "centrosymmetry")'), false);
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [autoCspPath] });
  await waitFor('document.getElementById("csp-state").textContent === "Calculated" && document.getElementById("configuration-status").textContent.includes("restored")', 'Auto CSP recipe replay');
  assert.match(await evaluate('document.getElementById("csp-neighbors").selectedOptions[0].textContent'), /Auto.*Mixed/);
  await showTool('centrosymmetry');
  await evaluate(`(() => { const select = document.getElementById('csp-neighbors'); select.value = '12'; select.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("csp-state").textContent === "Calculated"', 'manual 12-neighbor CSP');
  assert.equal(await evaluate('document.getElementById("csp-auto-result").hidden'), true);
  const manualCspRecipe = await exportConfiguration();
  assert.equal(manualCspRecipe.settings.analyses.centrosymmetry.mode, 'manual');
  assert.equal(manualCspRecipe.settings.analyses.centrosymmetry.neighbors, 12);
  // A pre-Auto version-one recipe had only enabled and neighbors fields.
  delete manualCspRecipe.settings.analyses.centrosymmetry.mode;
  const manualCspPath = resolve(profile, 'legacy-manual-csp-recipe.json');
  await writeFile(manualCspPath, JSON.stringify(manualCspRecipe));
  await evaluate(`(() => { const select = document.getElementById('csp-neighbors'); select.value = '8'; select.dispatchEvent(new Event('change')); })()`);
  await waitFor('document.getElementById("csp-state").textContent === "Calculated"', 'manual 8-neighbor CSP');
  await call('DOM.setFileInputFiles', { nodeId: configurationInput, files: [manualCspPath] });
  await waitFor('document.getElementById("csp-neighbors").value === "12" && document.getElementById("csp-state").textContent === "Calculated" && document.getElementById("configuration-status").textContent.includes("restored")', 'legacy manual CSP recipe replay');

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
  const phoneQuantity = await evaluate(`(() => {
    const select = document.getElementById('legend-color-mode'); select.scrollIntoView({ block: 'nearest' });
    const rect = select.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      target: [...select.options].findIndex(option => option.value === 'property:site_energy') };
  })()`);
  assert.ok(phoneQuantity.x > 0 && phoneQuantity.x < 390 && phoneQuantity.y > 0 && phoneQuantity.y < 844, 'phone quantity selector is reachable');
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: phoneQuantity.x, y: phoneQuantity.y }] });
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await evaluate('document.getElementById("legend-color-mode").focus()');
  for (const key of ['Home', ...Array(phoneQuantity.target).fill('ArrowDown'), 'Enter']) {
    const code = { Home: 36, ArrowDown: 40, Enter: 13 }[key];
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
  }
  await waitFor('document.getElementById("legend-color-mode").value === "property:site_energy" && document.getElementById("color-mode").value === "property:site_energy"', 'phone touch and keyboard legend quantity selection');
  assert.equal(await evaluate('document.activeElement.id'), 'legend-color-mode', 'legend quantity redraw preserves keyboard focus');
  if (process.argv.includes('--structure-screenshot')) {
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/alloyview-legend-quantity-phone.png', Buffer.from(capture.data, 'base64'));
  }
  await colorProperty('site_energy');
  assert.equal(await legendAuto(), true);
  for (const expected of [false, true]) {
    const phoneAutoPoint = await evaluate(`(async () => {
      const button = document.getElementById('legend-auto'); button.scrollIntoView({ block: 'nearest' });
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const rect = button.getBoundingClientRect(), legend = document.getElementById('legend').getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hitButton: hit?.closest('button')?.id ?? null,
        hit: hit?.outerHTML.slice(0, 240), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        legend: { x: legend.x, y: legend.y, width: legend.width, height: legend.height } };
    })()`);
    assert.ok(phoneAutoPoint.x > 0 && phoneAutoPoint.x < 390 && phoneAutoPoint.y > 0 && phoneAutoPoint.y < 844, `phone Auto toggle is reachable: ${JSON.stringify(phoneAutoPoint)}`);
    assert.equal(phoneAutoPoint.hitButton, 'legend-auto', `phone Auto hit target: ${JSON.stringify(phoneAutoPoint)}`);
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: phoneAutoPoint.x, y: phoneAutoPoint.y }] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitFor(`document.getElementById('legend-auto').getAttribute('aria-pressed') === '${expected}'`, 'phone Auto tap');
  }
  await colorProperty('structureType');
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
  reportFullSmoke = () => {
    console.log('Browser smoke passed: continuous 3D BCC logo including reduced-motion settings; Pages Wasm loading; trajectories; automatic cutoff/legend edits; highlighted legend Auto toggle, manual/incomplete/constant scalar bounds, stable ranges across fresh/cached frames, independent property maps/ranges, five new PNG palettes and fixed/Auto recipe replay; latest-result queueing; concurrent analyses; Auto central symmetry for FCC/HCP/BCC and local mixed-phase neighbor shells, trajectory/cache reuse, cancellation reset and Auto/legacy-manual recipe replay; silent NaN strain; real Worker cancellation/reset, cached-frame cleanup, independent jobs and dependency recovery; startup preparation/Wasm/indexing/atom progress and warm Worker reuse; selectable tools; triclinic display replication and unchanged analysis inputs; intersecting arbitrary world-space slices, displayed/unwrapped coordinates, visible-copy GPU coverage/picking and real handle drags without camera motion; JSON configuration export/replay, local-source reselection, source-loading/preflight races and unchanged settings after rejected recipes; editable lattice references and PTM reuse; sidebar/themes; phone Auto tap, pinch zoom, two-finger pan, one-finger orbit, tap picking, fixed viewport, touch scrolling and collapsed overlays; transparent PNG and optional XYZ arrows.');
    console.log(JSON.stringify(exports));
    console.log(`Large-structure clipping passed: ${largeCount} local CFG atoms; depth range ${largeDepths.minimum.toFixed(4)}..${largeDepths.maximum.toFixed(4)}; first/last atoms rendered and picked.`);
  };
  }
  await runAtomToolsSmoke({ call, evaluate, waitFor, showTool, exportConfiguration, reloadPage, compareSettings, profile, screenshots: process.argv.includes('--structure-screenshot') });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(requests.some(path => path.endsWith('ptm-kernel.wasm')), 'browser must load the real PTM kernel');
  assert.ok(requests.filter((path) => /\.(js|mjs|wasm)$/.test(path)).every((path) => /^\/AlloyView\/assets\/[a-f0-9]+\//.test(path)));
  if (atomToolsOnly) console.log('Focused atom tools browser smoke passed, including shared page-error and versioned-module checks.');
  else reportFullSmoke();
} finally {
  websocket?.close();
  chrome.kill();
  await new Promise((done) => chrome.exitCode !== null ? done() : chrome.once('exit', done));
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
