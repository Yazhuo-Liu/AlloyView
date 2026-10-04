import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraViewPreset, VIEW_PRESETS } from '../src/render/camera-presets.js';

test('directions reflect the camera, including equivalent wrapped yaw angles', () => {
  for (const [view, orientation] of Object.entries(VIEW_PRESETS)) {
    assert.equal(cameraViewPreset(orientation), view);
    assert.equal(cameraViewPreset({ ...orientation, yaw: orientation.yaw + 2 * Math.PI }), view);
    assert.equal(cameraViewPreset({ ...orientation, pitch: orientation.pitch + .01 }), 'custom');
    assert.equal(cameraViewPreset({ ...orientation, yaw: orientation.yaw + .01 }), 'custom');
  }
});

test('pan, zoom and projection changes retain direction, while a free camera has none', () => {
  assert.equal(cameraViewPreset({ ...VIEW_PRESETS.left, pan: [1, 2, 3], distance: 1, orthographicScale: 20, projectionMode: 'perspective' }), 'left');
  assert.equal(cameraViewPreset({ yaw: -.62, pitch: .38 }), 'custom');
  assert.equal(cameraViewPreset({ yaw: NaN, pitch: 0 }), 'custom');
});
