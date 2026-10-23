import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Exercise the real app callback chain, including a displayed replica picked
// in the second view. The primary renderer must not supply that hit's position.
const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  const origin = await evaluate('location.origin');
  await call('Page.navigate', { url: `${origin}/AlloyView/${production ? 'dist/' : ''}index.html` });
  async function waitFor(expression, label) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(20);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  await waitFor('document.readyState === "complete"', 'application');
  await evaluate(`(async () => {
    const base = new URL('./', document.querySelector('script[type=module][src]').src);
    const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', base));
    const setFrame = WebGLRenderer.prototype.setFrame;
    window.sliceReview = {};
    WebGLRenderer.prototype.setFrame = function (...args) {
      if (this.canvas.id === 'viewport') sliceReview.main = this;
      else if (this.canvas.closest?.('#comparison-view')) sliceReview.second = this;
      return setFrame.apply(this, args);
    };
    const content = ['2', 'Lattice="10 0 0 0 10 0 0 0 10" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1',
      'Fe 2 3 5 1', 'Ni 7 7 5 2', ''].join('\\n');
    const input = document.getElementById('file-input'), files = new DataTransfer();
    files.items.add(new File([content], 'second-view-slice.xyz'));
    input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('sliceReview.main?.atomCount === 2 && document.getElementById("loading").hidden', 'structure');
  await evaluate(`(() => {
    document.getElementById('replicate-a').value = '2';
    document.getElementById('apply-replicate').click();
    const compare = document.getElementById('compare-view');
    compare.checked = true; compare.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('sliceReview.main.repetitions[0] === 2 && sliceReview.second?.frame', 'second view');
  await evaluate(`(async () => {
    document.querySelector('[data-compare-view="top"]').click();
    document.getElementById('slice-pick-atoms').click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);

  const picks = [];
  for (const position of [[12, 3, 5], [7, 7, 5]]) {
    const point = await evaluate(`(() => {
      const renderer = sliceReview.second, world = ${JSON.stringify(position)};
      renderer.updateMatrices();
      const v = renderer.viewMatrix, p = renderer.projectionMatrix;
      const view = [0, 1, 2, 3].map(i => v[i]*world[0] + v[4+i]*world[1] + v[8+i]*world[2] + v[12+i]);
      const clip = [0, 1, 2, 3].map(i => p[i]*view[0] + p[4+i]*view[1] + p[8+i]*view[2] + p[12+i]*view[3]);
      const rect = renderer.canvas.getBoundingClientRect();
      const x = rect.left + (clip[0]/clip[3] + 1)*rect.width/2;
      const y = rect.top + (1 - clip[1]/clip[3])*rect.height/2;
      return { x, y, reachable: document.elementFromPoint(x, y) === renderer.canvas };
    })()`);
    assert.ok(point.reachable, 'the second-view canvas receives the click');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await call('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
    picks.push(await evaluate('sliceReview.second.lastPick'));
  }
  const slices = await evaluate(`(() => {
    document.getElementById('slice-from-two').click();
    return sliceReview.main.slices;
  })()`);
  return { picks, slices };
}, { requireGpu: false });

assert.deepEqual(report.picks[0].replica, [1, 0, 0]);
assert.deepEqual(report.picks[0].position, [12, 3, 5]);
assert.deepEqual(report.picks[1].replica, [0, 0, 0]);
assert.equal(report.slices.length, 1);
const expectedNormal = [-5 / Math.sqrt(41), 4 / Math.sqrt(41), 0];
report.slices[0].normal.forEach((value, axis) => assert.ok(Math.abs(value - expectedNormal[axis]) < 1e-10));
assert.ok(Math.abs(report.slices[0].position - (-5 * 9.5 + 4 * 5) / Math.sqrt(41)) < 1e-10);
console.log(JSON.stringify(report, null, 2));
