import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-keyboard-'));
const fixture = resolve(temporary, 'keyboard-trajectory.xyz');
await writeFile(fixture, Array.from({ length: 3 }, (_, frame) => `4\nLattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T"\nCu ${1 + frame * .1} 1 1 1\nCu 4 1 1 2\nCu 1 4 1 3\nCu 1 1 4 4\n`).join(''));

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(navigator,"hardwareConcurrency",{get:()=>4});' });
    const url = `${origin}/AlloyView/dist/index.html`;
    const waitFor = async (expression, label, timeout = 45_000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) { if (await evaluate(expression)) return; await delay(35); }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({toast:document.getElementById("toast")?.textContent,loading:document.getElementById("loading-text")?.textContent})')}`);
    };
    const loadPage = async () => {
      await call('Page.navigate', { url });
      await waitFor('document.readyState === "complete" && document.getElementById("show-keyboard-shortcuts")', 'page ready');
      await evaluate(`(${installChecks.toString()})()`);
      const { root } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [fixture] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor('document.getElementById("file-name").textContent === "keyboard-trajectory.xyz" && document.getElementById("loading").hidden && keyboardChecks.renderer?.frame && document.getElementById("frame-label").textContent.includes("/ 3")', 'trajectory ready');
      await evaluate('document.activeElement?.blur()');
    };
    async function key(name, { shift = false, ctrl = false, repeat = false } = {}) {
      const code = { ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ' ': 'Space', '?': 'Slash', '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', '.': 'Period', '+': 'Equal', '=': 'Equal', '-': 'Minus', _: 'Minus', '{': 'BracketLeft', '}': 'BracketRight' }[name]
        ?? (/^[0-9]$/.test(name) ? `Digit${name}` : name.length === 1 ? `Key${name.toUpperCase()}` : name);
      const keyCode = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Escape: 27, Tab: 9, ' ': 32 }[name] ?? (name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0);
      await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: (shift ? 8 : 0) | (ctrl ? 2 : 0), autoRepeat: repeat });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: (shift ? 8 : 0) | (ctrl ? 2 : 0) });
      await delay(50);
    }
    async function click(selector) {
      const point = await evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest'});const box=element.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2};})()`);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
      await delay(40);
    }
    const camera = () => evaluate('keyboardChecks.renderer.getCameraState()');
    const blur = () => evaluate('document.activeElement?.blur()');
    await loadPage();
    const before = await camera();
    await key('ArrowLeft'); const gear5 = await camera();
    assert.ok(Math.abs(gear5.yaw - before.yaw - 5 * Math.PI / 180) < 1e-10, 'gear 5 orbits 5 degrees');
    // The indicator hides after 1.6 s; check it before the next key so a busy machine cannot miss it.
    await key('7'); assert.equal(await evaluate('document.getElementById("keyboard-gear-indicator").hidden'), false, 'gear indicator appears');
    await key('ArrowLeft'); const gear7 = await camera();
    assert.ok(Math.abs(gear7.yaw - gear5.yaw - 20 * Math.PI / 180) < 1e-10, 'gear 7 multiplies camera step by four');
    await delay(1700);
    assert.equal(await evaluate('document.getElementById("keyboard-gear-indicator").hidden'), true, 'gear indicator clears');
    await key('5'); await key('ArrowLeft', { shift: true }); const panned = await camera();
    assert.ok(Math.hypot(...panned.center.map((value, axis) => value - gear7.center[axis])) > .01, 'Shift arrow pans in screen space');
    assert.equal(panned.yaw, gear7.yaw, 'pan keeps yaw');
    await key('+', { shift: true }); assert.ok((await camera()).distance < panned.distance, 'plus zooms in');
    await key('q'); assert.equal((await camera()).constrainUp, false, 'roll releases upright constraint');
    await key('T', { shift: true }); const bottom = await camera(); await key('e'); const bottomRolled = await camera();
    assert.ok(Math.abs(bottom.up.reduce((sum, value, axis) => sum + value * bottomRolled.up[axis], 0) - Math.cos(5 * Math.PI / 180)) < 1e-10,
      'rolling from bottom view preserves screen-up and changes it by exactly five degrees');
    await key('t'); assert.equal((await camera()).projectionMode, 'orthographic', 'top preset selects parallel projection');
    const parallel = await camera(); await key('-'); assert.ok((await camera()).fieldWidth > parallel.fieldWidth, 'minus zooms out in parallel projection');

    await evaluate('document.getElementById("radius-percent").focus()');
    const focused = await camera(); await key('ArrowLeft'); await key('9');
    assert.equal((await camera()).yaw, focused.yaw, 'focused numeric input blocks camera movement');
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("alloyview-shortcuts")).gear'), 5, 'focused input blocks gear change');
    await blur(); await key('ArrowLeft', { ctrl: true }); assert.equal((await camera()).yaw, focused.yaw, 'Ctrl combinations remain browser shortcuts');
    // Scrolling keys stay with a focused sidebar control; the scrollable sidebar moves instead of the camera.
    await evaluate(`(() => { const sidebar = document.getElementById('sidebar'); sidebar.scrollTop = 0;
      const button = [...sidebar.querySelectorAll('button')].find(item => item.getClientRects().length && !item.disabled); button.focus(); })()`);
    const beforeScroll = await camera(); await key('ArrowDown'); await key('PageDown');
    await waitFor('document.getElementById("sidebar").scrollTop > 0', 'arrow and page keys scroll the focused sidebar', 5_000);
    assert.equal((await camera()).pitch, beforeScroll.pitch, 'sidebar focus keeps arrows away from the camera');
    await click('#viewport'); await key('ArrowLeft'); assert.notEqual((await camera()).yaw, beforeScroll.yaw, 'clicking the view returns arrows to the camera');
    await evaluate('document.getElementById("sidebar").scrollTop = 0'); await blur();

    await key(']'); await waitFor('document.getElementById("frame-label").textContent.startsWith("2 / 3") && document.getElementById("loading").hidden', 'next frame key');
    await key('}', { shift: true }); await waitFor('document.getElementById("frame-label").textContent.startsWith("3 / 3") && document.getElementById("loading").hidden', 'last frame key');
    await key('{', { shift: true }); await waitFor('document.getElementById("frame-label").textContent.startsWith("1 / 3") && document.getElementById("loading").hidden', 'first frame key');
    await key(' '); assert.equal(await evaluate('document.getElementById("frame-play").getAttribute("aria-pressed")'), 'true', 'Space starts trajectory');
    await key(' '); assert.equal(await evaluate('document.getElementById("frame-play").getAttribute("aria-pressed")'), 'false', 'Space pauses trajectory');
    await evaluate('document.querySelector("[data-tool-button=slice]").click();document.getElementById("add-slice").click()');
    await blur(); const offset = await evaluate('Number(document.getElementById("slice-offset").value)');
    await key('.'); assert.equal(await evaluate('Number(document.getElementById("slice-offset").value)'), offset + 1, 'period steps selected slice');
    await key(','); assert.equal(await evaluate('Number(document.getElementById("slice-offset").value)'), offset, 'comma reverses slice step');
    const side = await evaluate('document.getElementById("slice-side").value');
    await key('F', { shift: true }); assert.notEqual(await evaluate('document.getElementById("slice-side").value'), side, 'Shift F flips retained side');

    await key('?', { shift: true });
    assert.equal(await evaluate('document.getElementById("keyboard-shortcuts").open'), true, 'question mark opens native modal');
    const inDialog = await camera(); await key('ArrowLeft'); assert.equal((await camera()).yaw, inDialog.yaw, 'modal blocks navigation');
    await key('Tab', { shift: true }); assert.equal(await evaluate('document.getElementById("keyboard-shortcuts").contains(document.activeElement)'), true, 'modal traps focus');
    await click('[data-command="camera.yaw-left"] button'); await key('ArrowRight');
    assert.match(await evaluate('document.getElementById("keyboard-shortcuts-status").textContent'), /already assigned to Orbit right/, 'rebinding refuses conflicts explicitly');
    await evaluate('window.addEventListener("keydown", event => {keyboardChecks.browserModifierPrevented=event.defaultPrevented;},{once:true})');
    await key('ArrowRight', { ctrl: true });
    assert.equal(await evaluate('keyboardChecks.browserModifierPrevented'), false, 'capture preserves browser modifier combinations');
    await key('h'); assert.equal(await evaluate(`document.querySelector('[data-command="camera.yaw-left"] kbd').textContent`), 'h', 'capture changes shortcut');
    await key('Escape'); assert.equal(await evaluate('document.getElementById("keyboard-shortcuts").open'), false, 'Escape closes shortcut dialog');
    await blur(); const rebound = await camera(); await key('h'); assert.ok((await camera()).yaw > rebound.yaw, 'new binding runs camera command');
    const afterRebound = await camera(); await key('ArrowLeft'); assert.equal((await camera()).yaw, afterRebound.yaw, 'old binding is removed');
    await loadPage(); const reloaded = await camera(); await key('h'); assert.ok((await camera()).yaw > reloaded.yaw, 'binding survives reload');
    await key('?', { shift: true }); await click('#reset-keyboard-shortcuts'); await key('Escape'); await blur();
    const reset = await camera(); await key('ArrowLeft'); assert.ok((await camera()).yaw > reset.yaw, 'reset restores default bindings');

    const originalTheme = await evaluate('document.documentElement.dataset.theme'); await key('d');
    assert.notEqual(await evaluate('document.documentElement.dataset.theme'), originalTheme, 'theme shortcut reuses theme control');
    await evaluate('keyboardChecks.blockDownloads()'); await key('p'); await waitFor('keyboardChecks.pngDownloads === 1', 'PNG shortcut');
    await key('p', { repeat: true }); await delay(100); assert.equal(await evaluate('keyboardChecks.pngDownloads'), 1, 'held export key produces one image');
    for (const width of [390, 320]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await evaluate(`(() => {
        const boxes=['.view-toolbar','#toggle-atom-details','#toggle-view-controls'].map(selector=>document.querySelector(selector).getBoundingClientRect());
        return boxes.every((box,index)=>box.left>=0&&box.right<=innerWidth&&boxes.slice(index+1).every(other=>box.right<=other.left||other.right<=box.left||box.bottom<=other.top||other.bottom<=box.top));
      })()`), true, `toolbar and Details/View toggles do not overlap at ${width}px`);
    }
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await click('#show-keyboard-shortcuts');
    assert.equal(await evaluate('(() => {const box=document.getElementById("keyboard-shortcuts").getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight;})()'), true, 'shortcut dialog fits mobile viewport');
    await key('Escape');
    return { cameraGearbox: true, screenPan: true, projectionZoom: true, inputProtection: true, trajectoryAndSliceCommands: true,
      conflictRefusal: true, persistedRebinding: true, modalFocus: true, png: true, mobile: true };
  }, { requireGpu: false });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function installChecks() {
  window.keyboardChecks = { pngDownloads: 0 };
  if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click();
  const app = [...document.querySelectorAll('script[type=module]')].find(script => script.src.endsWith('/src/app.js'));
  const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app.src).href);
  const request = WebGLRenderer.prototype.requestRender;
  WebGLRenderer.prototype.requestRender = function(...args) { if (this.canvas.id === 'viewport') keyboardChecks.renderer = this; return request.apply(this, args); };
  keyboardChecks.blockDownloads = () => {
    const create = URL.createObjectURL;
    URL.createObjectURL = function(blob) { if (blob.type === 'image/png') keyboardChecks.pngDownloads++; return create.call(this, blob); };
    HTMLAnchorElement.prototype.click = () => {};
  };
}
