import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeFileDrop } from '../src/file-drop.js';

function fixture() {
  const handlers = new Map(), overlay = { hidden: true }, drops = [];
  const target = { addEventListener(name, handler) { handlers.set(name, handler); },
    removeEventListener(name) { handlers.delete(name); } };
  const controller = initializeFileDrop({ target, overlay, onFiles: files => drops.push(files) });
  const dispatch = (type, dataTransfer = { types: ['Files'], files: [] }) => {
    const event = { dataTransfer, prevented: false, preventDefault() { this.prevented = true; } };
    handlers.get(type)?.(event);
    return event;
  };
  return { overlay, drops, dispatch, controller };
}

test('nested drag targets keep the file overlay visible until the page is left', () => {
  const { overlay, dispatch } = fixture();
  assert.equal(dispatch('dragenter').prevented, true);
  dispatch('dragenter'); dispatch('dragleave');
  assert.equal(overlay.hidden, false);
  dispatch('dragleave'); assert.equal(overlay.hidden, true);
});

test('dropping files prevents navigation, removes the overlay and hands over all choices', () => {
  const { overlay, dispatch, drops } = fixture();
  const files = [new File(['a'], 'a.cfg'), new File(['b'], 'b.cfg')];
  dispatch('dragenter');
  assert.equal(dispatch('drop', { types: ['Files'], files }).prevented, true);
  assert.equal(overlay.hidden, true); assert.deepEqual(drops, [files]);
});

test('text drags retain their normal behavior and disposal removes the file listeners', () => {
  const { overlay, dispatch, controller, drops } = fixture();
  for (const type of ['dragenter', 'dragover', 'drop']) {
    assert.equal(dispatch(type, { types: ['text/plain'], files: [] }).prevented, false);
  }
  assert.equal(overlay.hidden, true); assert.deepEqual(drops, []);
  controller.dispose(); dispatch('dragenter'); assert.equal(overlay.hidden, true);
});
