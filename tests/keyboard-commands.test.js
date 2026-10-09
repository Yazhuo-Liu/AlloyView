import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_KEYBOARD_GEAR, KeyboardCommandRegistry, SHORTCUT_STORAGE_KEY, keyboardGearScale,
  normalizeShortcutKey, validateShortcutBinding, isShortcutEditingTarget, scrollKeyBelongsToFocus, shouldIgnoreShortcut } from '../src/keyboard-commands.js';

function commands(calls = []) {
  return [
    { id: 'camera.left', label: 'Orbit left', group: 'Camera', bindings: ['ArrowLeft'], handler: event => calls.push(event) },
    { id: 'camera.zoom', label: 'Zoom', group: 'Camera', bindings: ['+', '='], handler: () => calls.push('zoom') },
    { id: 'frames.next', label: 'Next frame', group: 'Trajectory', bindings: [']'], enabled: () => false, handler: () => calls.push('next') },
  ];
}
function storage(value = null) { return { value, getItem(key) { assert.equal(key, SHORTCUT_STORAGE_KEY); return this.value; },
  setItem(key, value) { assert.equal(key, SHORTCUT_STORAGE_KEY); this.value = value; } }; }

test('shortcut keys use characters, distinguish Shift letters and arrows, and preserve symbols', () => {
  assert.equal(normalizeShortcutKey({ key: 'Q' }), 'q');
  assert.equal(normalizeShortcutKey({ key: 'Q', shiftKey: true }), 'Shift+q');
  assert.equal(normalizeShortcutKey({ key: '?', code: 'Slash', shiftKey: true }), '?');
  assert.equal(normalizeShortcutKey({ key: 'é', code: 'Digit2' }), 'é');
  assert.equal(normalizeShortcutKey({ key: '+', shiftKey: true }), '+');
  assert.equal(normalizeShortcutKey({ key: 'ArrowLeft', shiftKey: true }), 'Shift+ArrowLeft');
  assert.equal(normalizeShortcutKey({ key: ' ' }), 'Space');
  assert.equal(validateShortcutBinding('Shift+Space'), 'Shift+Space');
  assert.equal(validateShortcutBinding('Shift+?'), null);
  for (const key of ['0', '9', 'Escape', 'Tab', 'Enter', 'Shift', 'Dead', 'Unidentified']) assert.equal(normalizeShortcutKey({ key }), null);
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) assert.equal(normalizeShortcutKey({ key: 'p', [modifier]: true }), null);
});

test('editing fields, editable ancestors, dialogs and handled events suppress global commands', () => {
  assert.equal(isShortcutEditingTarget({ isContentEditable: true }), true);
  assert.equal(isShortcutEditingTarget({ closest: selector => selector.includes('textarea') ? {} : null }), true);
  assert.equal(isShortcutEditingTarget(null), false);
  for (const property of ['defaultPrevented', 'ctrlKey', 'metaKey', 'altKey', 'isComposing']) assert.equal(shouldIgnoreShortcut({ key: 'p', [property]: true }), true);
  assert.equal(shouldIgnoreShortcut({ key: 'p' }, { modalOpen: true }), true);
  assert.equal(shouldIgnoreShortcut({ key: ' ', target: { closest: selector => selector.startsWith('button') ? {} : null } }), true);
  assert.equal(shouldIgnoreShortcut({ key: 'ArrowLeft', target: { closest: () => null } }), false);
});

test('gearbox doubles each step and validates all inputs', () => {
  assert.equal(DEFAULT_KEYBOARD_GEAR, 5);
  assert.equal(keyboardGearScale(0), 1 / 32); assert.equal(keyboardGearScale(5), 1); assert.equal(keyboardGearScale(9), 16);
  for (let gear = 1; gear <= 9; gear++) assert.equal(keyboardGearScale(gear), keyboardGearScale(gear - 1) * 2);
  for (const gear of [-1, 10, 5.5, NaN, '5']) assert.throws(() => keyboardGearScale(gear), RangeError);
});

test('registry dispatches enabled commands with current gear and ignores disabled or unknown commands', () => {
  const calls = [], registry = new KeyboardCommandRegistry(commands(calls));
  registry.setGear(7);
  const event = { key: 'ArrowLeft' };
  assert.equal(registry.execute('ArrowLeft', event), true);
  assert.deepEqual(calls, [{ event, gear: 7, scale: 4 }]);
  assert.equal(registry.execute('+'), true); assert.equal(registry.execute(']'), false); assert.equal(registry.execute('x'), false);
  assert.deepEqual(calls.slice(1), ['zoom']);
});

test('rebind refuses conflicts atomically and reset restores aliases and gearbox', () => {
  const saved = storage(), registry = new KeyboardCommandRegistry(commands(), { storage: saved });
  assert.throws(() => registry.rebind('camera.left', '+'), /already assigned to Zoom/);
  assert.deepEqual(registry.byId.get('camera.left').bindings, ['ArrowLeft']);
  assert.throws(() => registry.rebind('camera.left', '8'), /reserved/);
  assert.throws(() => registry.rebind('missing', 'h'), /Unknown/);
  assert.equal(registry.rebind('camera.zoom', 'z'), true);
  assert.deepEqual(registry.byId.get('camera.zoom').bindings, ['z']);
  registry.setGear(2); registry.reset();
  assert.deepEqual(registry.byId.get('camera.zoom').bindings, ['+', '=']); assert.equal(registry.gear, 5);
});

test('valid saved rebinding and gear survive reload, including keys freed by later commands', () => {
  const saved = storage(), original = new KeyboardCommandRegistry(commands(), { storage: saved });
  original.rebind('camera.zoom', 'z'); original.rebind('camera.left', '+'); original.setGear(8);
  const restored = new KeyboardCommandRegistry(commands(), { storage: saved });
  assert.deepEqual(restored.byId.get('camera.left').bindings, ['+']);
  assert.deepEqual(restored.byId.get('camera.zoom').bindings, ['z']); assert.equal(restored.gear, 8);
  const data = JSON.parse(saved.value); assert.equal(data.version, 1);
});

test('malformed, older, conflicting or reserved saved bindings preserve defaults', () => {
  for (const value of ['{', '{}', JSON.stringify({ version: 0, bindings: { 'camera.left': ['h'] } }),
    JSON.stringify({ version: 1, bindings: { 'camera.left': ['+'] }, gear: 9 }),
    JSON.stringify({ version: 1, bindings: { 'camera.left': ['0'] } }),
    JSON.stringify({ version: 1, bindings: { 'camera.left': ['h', 'h'] } }),
    JSON.stringify({ version: 1, bindings: { 'camera.left': ['Ctrl+h'] } }),
    JSON.stringify({ version: 1, bindings: { 'camera.left': [] } }),
    JSON.stringify({ version: 1, bindings: [] })]) {
    const registry = new KeyboardCommandRegistry(commands(), { storage: storage(value) });
    assert.deepEqual(registry.byId.get('camera.left').bindings, ['ArrowLeft']); assert.equal(registry.gear, 5);
  }
});

test('unavailable and quota-limited localStorage never disables commands or rebinding', () => {
  const denied = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  const registry = new KeyboardCommandRegistry(commands(), { storage: denied });
  assert.equal(registry.rebind('camera.left', 'h'), false); assert.equal(registry.setGear(1), false);
  assert.deepEqual(registry.byId.get('camera.left').bindings, ['h']); assert.equal(registry.gear, 1);
  assert.equal(new KeyboardCommandRegistry(commands()).persist(), false);
});

test('duplicate command IDs or bindings are rejected during registration', () => {
  const duplicateIds = commands(); duplicateIds[1].id = duplicateIds[0].id;
  assert.throws(() => new KeyboardCommandRegistry(duplicateIds), /IDs must be unique/);
  const duplicateKeys = commands(); duplicateKeys[1].bindings = ['ArrowLeft'];
  assert.throws(() => new KeyboardCommandRegistry(duplicateKeys), /already assigned/);
});

test('scrolling keys stay with focused panels and scrollable regions, as on ordinary pages', () => {
  const styles = new Map();
  const document = { defaultView: { getComputedStyle: element => styles.get(element) ?? { overflowX: 'visible', overflowY: 'visible' } } };
  const element = (parentElement, size = {}) => ({ ownerDocument: document, parentElement, closest: () => null,
    scrollHeight: 100, clientHeight: 100, scrollWidth: 100, clientWidth: 100, ...size });
  document.body = element(null); document.documentElement = element(null);
  const viewport = element(document.body), canvas = element(viewport), sidebar = element(document.body), button = element(sidebar);
  const legend = element(viewport, { scrollHeight: 400 }), legendButton = element(legend);
  styles.set(legend, { overflowX: 'hidden', overflowY: 'auto' });
  viewport.contains = target => { for (let node = target; node; node = node.parentElement) if (node === viewport) return true; return false; };
  const ignored = (key, target) => shouldIgnoreShortcut({ key, target }, { viewport });
  for (const key of ['ArrowLeft', 'ArrowUp', 'PageDown', 'Home', 'End']) {
    assert.equal(ignored(key, document.body), false, `${key} on the page drives the view`);
    assert.equal(ignored(key, canvas), false, `${key} with the canvas focused drives the view`);
    assert.equal(ignored(key, button), true, `${key} with sidebar focus scrolls the sidebar`);
  }
  assert.equal(ignored(' ', sidebar), true, 'Space scrolls a focused panel');
  assert.equal(ignored('ArrowDown', legendButton), true, 'vertical keys scroll a scrollable overlay in the view');
  assert.equal(ignored('ArrowLeft', legendButton), false, 'a region that only scrolls vertically keeps horizontal keys');
  assert.equal(ignored('q', button), false, 'letter shortcuts remain global');
  assert.equal(scrollKeyBelongsToFocus({ key: 'ArrowLeft', target: null }, viewport), false);
});
