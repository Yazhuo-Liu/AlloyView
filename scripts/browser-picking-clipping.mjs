import assert from 'node:assert/strict';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Compare picks to actual pixels when the perspective camera enters a sphere.
// SwiftShader validates visibility, not physical-GPU performance.
const production = process.argv.includes('--production');
const modules = `/AlloyView/${production ? 'dist/' : ''}src`;
const report = await withWebGpuBrowser(async ({ evaluate }) => evaluate(`(async () => {
  const { WebGLRenderer } = await import('${modules}/render/webgl-renderer.js');
  const { createCell } = await import('${modules}/data/model.js');
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:400px;height:400px'; document.body.append(canvas);
  const renderer = new WebGLRenderer(canvas), gl = renderer.gl;
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const positions = Float64Array.of(0, 0, 0, 0, 0, -5);
  const frame = { positions, cell, ids: Uint32Array.of(1, 2), fractional: Float64Array.of(0, 0, 0, 0, 0, -.5) };
  renderer.setFrame(frame, Uint8Array.of(255, 0, 0, 0, 0, 255), positions, Float32Array.of(1, 1));
  renderer.cellVisible = false; renderer.radiusScale = 1;
  renderer.target = [0, 0, 0]; renderer.pan = [0, 0, 0]; renderer.yaw = 0; renderer.pitch = Math.PI / 2;
  const cases = [
    { name: 'hemisphere behind the eye', eye: .1, redZ: 0, expected: 1 },
    { name: 'center plane before near clip', eye: .02, redZ: .0199, expected: 1 },
    { name: 'visible red foreground', eye: 3, redZ: 0, expected: 0 },
  ];
  for (const sample of cases) {
    positions[2] = sample.redZ; renderer.setDisplayPositions(positions); renderer.distance = sample.eye;
    renderer.render(0, { trackStats: false });
    const pixel = new Uint8Array(4);
    gl.readPixels(canvas.width / 2, canvas.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const rect = canvas.getBoundingClientRect();
    sample.pixel = [...pixel]; sample.pick = renderer.pick(rect.left + rect.width / 2, rect.top + rect.height / 2);
    sample.glError = gl.getError();
  }
  renderer.clearFrame(); return cases;
})()`), { requireGpu: false });

for (const sample of report) {
  const visible = sample.pixel[0] > sample.pixel[2] * 4 ? 0 : sample.pixel[2] > sample.pixel[0] * 4 ? 1 : -1;
  assert.equal(visible, sample.expected, `${sample.name}: the expected sphere supplies the visible pixel`);
  assert.equal(sample.pick, visible, `${sample.name}: picking agrees with the rendered sphere`);
  assert.equal(sample.glError, 0, sample.name);
}
console.log(JSON.stringify({ tree: production ? 'production' : 'source', cases: report }, null, 2));
