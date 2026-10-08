import assert from 'node:assert/strict';
import test from 'node:test';
import { drawLegendOverlay } from '../src/render/webgl-renderer.js';

function recordedLegend(legend, width, height, scale = 1) {
  const text = [];
  const context = { save() {}, restore() {}, fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, fill() {},
    fillText(label, x, y) { text.push({ label, x, y, font: this.font }); } };
  drawLegendOverlay(context, legend, width, height, scale, { includeBackground: false });
  return text;
}

test('32 discrete values and their NaN class all fit a short exported categorical legend', () => {
  const legend = { kind: 'types', title: 'Integer classes', items: Array.from({ length: 33 }, (_, id) => ({
    id: id === 32 ? 'NaN' : id, label: id === 32 ? 'NaN' : String(id), color: [100, 150, 200], count: 3,
  })) };
  for (const [width, height, scale] of [[280, 200, 1], [560, 400, 2], [280, 280, 1]]) {
    const text = recordedLegend(legend, width, height, scale);
    assert.equal(text.length, 34, 'The title and every class are rendered.');
    assert.ok(text.some(item => item.label === 'NaN: 3'));
    assert.ok(text.every(item => item.y >= 0 && item.y < height - 18 * scale), 'Labels stay within the exported image and legend panel.');
    assert.ok(text.slice(1).every(item => parseFloat(item.font) >= 6 * scale), 'Even a short key retains legible text.');
  }
});

test('ordinary categorical PNG keys preserve their original column positions and typography', () => {
  const items = Array.from({ length: 9 }, (_, id) => ({ label: `Class ${id}`, color: [20, 100, 200], count: id }));
  const text = recordedLegend({ kind: 'types', title: 'Ordinary', items }, 800, 600);
  assert.equal(text.length, 10);
  assert.ok(text.slice(1).every(item => item.font === '9px system-ui, sans-serif'));
  const positions = text.slice(1);
  for (let row = 1; row < 5; row++) assert.equal(positions[row].y - positions[row - 1].y, 19);
  assert.equal(positions[5].y, positions[0].y);
  assert.equal(positions[5].x - positions[0].x, 118);
});
