import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  const origin = await evaluate('location.origin');
  await call('Page.navigate', { url: `${origin}/AlloyView/${production ? 'dist/' : ''}index.html` });
  const deadline = Date.now() + 30_000;
  while (!(await evaluate('document.readyState === "complete" && document.getElementById("file-input")'))) {
    if (Date.now() > deadline) throw new Error('Viewer startup timed out.');
    await delay(25);
  }
  await evaluate(`(${setup.toString()})()`);
  const picks = [];
  for (const projection of ['orthographic', 'perspective']) {
    const screen = await evaluate(`(() => {
      document.getElementById('projection-${projection}').click();
      const r = pickingCameraRenderer, c = r.canvas, rect = c.getBoundingClientRect(), gl = r.gl;
      const pixel = new Uint8Array(4); r.render(0, { trackStats: false });
      gl.readPixels(c.width / 2, c.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, pixel: [...pixel] };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await call('Input.dispatchMouseEvent', { type, x: screen.x, y: screen.y, button: 'left', clickCount: 1 });
    }
    const selectedId = await evaluate('pickingCameraRenderer.frame.ids[pickingCameraRenderer.selected]');
    picks.push({ projection, pixel: screen.pixel, selectedId });
  }
  const before = await evaluate(`(() => {
    document.querySelector('[data-view="bottom"]').click();
    const r = pickingCameraRenderer, rect = r.canvas.getBoundingClientRect();
    return { basis: r.cameraBasis(), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x + 4, y: before.y, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x + 4, y: before.y, button: 'left', clickCount: 1 });
  const after = await evaluate('pickingCameraRenderer.cameraBasis()');
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  return { picks, bottom: { initialUp: before.basis.up, rightDot: dot(before.basis.right, after.right), upDot: dot(before.basis.up, after.up) } };
}, { requireGpu: false });

for (const pick of report.picks) {
  assert.ok(pick.pixel[0] > pick.pixel[2] * 4, `${pick.projection}: the red Fe sphere covers the blue Ni sphere`);
  assert.equal(pick.selectedId, 1, `${pick.projection}: select the visible Fe sphere`);
}
assert.ok(report.bottom.initialUp[1] > .999, 'Bottom retains its +Y screen-up preset');
assert.ok(report.bottom.rightDot > .999 && report.bottom.upDot > .999, 'a four-pixel orbit preserves screen orientation');
console.log(JSON.stringify(report, null, 2));

async function setup() {
  const base = new URL('./', document.querySelector('script[type=module][src]').src);
  const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', base));
  const original = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') window.pickingCameraRenderer = this;
    return original.apply(this, args);
  };
  const text = '2\nLattice="10 0 0 0 10 0 0 0 10" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1\nFe 5 5 5 1\nNi 5 5 6 2\n';
  const input = document.getElementById('file-input'), transfer = new DataTransfer();
  transfer.items.add(new File([text], 'surface-depth-picking.xyz'));
  input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  const deadline = performance.now() + 20_000;
  while (window.pickingCameraRenderer?.atomCount !== 2 || !document.getElementById('loading').hidden) {
    if (performance.now() > deadline) throw new Error('Structure load timed out.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  for (const [type, color, radius] of [['Fe', '#ff0000', 3], ['Ni', '#0000ff', .5]]) {
    document.querySelector(`[aria-label="${type} atom color"]`).value = color;
    const field = document.querySelector(`[aria-label="${type} radius in angstroms"]`);
    field.value = radius; field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  document.querySelector('[data-view="top"]').click();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
