export const SHORTCUT_STORAGE_KEY = 'alloyview-shortcuts';
export const SHORTCUT_STORAGE_VERSION = 1;
export const DEFAULT_KEYBOARD_GEAR = 5;

const NAMED_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Delete', 'Backspace']);
const RESERVED_KEYS = new Set(['Escape', 'Tab', 'Enter']);

/** Printable symbols use event.key: Shift+/ is '?' on a US keyboard. */
export function normalizeShortcutKey(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;
  const original = event.key === ' ' ? 'Space' : event.key;
  if (typeof original !== 'string' || RESERVED_KEYS.has(original) || /^[0-9]$/.test(original)) return null;
  if (!NAMED_KEYS.has(original) && (Array.from(original).length !== 1 || /\s/.test(original))) return null;
  const letter = /^[a-z]$/i.test(original);
  const key = letter ? original.toLowerCase() : original;
  return `${event.shiftKey && (letter || NAMED_KEYS.has(original)) ? 'Shift+' : ''}${key}`;
}

export function validateShortcutBinding(binding) {
  if (typeof binding !== 'string') return null;
  const shifted = binding.startsWith('Shift+');
  const key = shifted ? binding.slice(6) : binding;
  const normalized = normalizeShortcutKey({ key: key === 'Space' ? ' ' : key, shiftKey: shifted });
  return normalized === binding ? normalized : null;
}

export function isShortcutEditingTarget(target) {
  return Boolean(target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}

const VERTICAL_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const HORIZONTAL_SCROLL_KEYS = new Set(['ArrowLeft', 'ArrowRight']);

function scrollsAlong(element, vertical) {
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  if (!style || !/(auto|scroll)/.test(vertical ? style.overflowY : style.overflowX)) return false;
  return vertical ? element.scrollHeight > element.clientHeight : element.scrollWidth > element.clientWidth;
}

/** Scrolling keys follow the usual page convention: they drive the camera
 * only while focus rests on the page itself or inside the 3D view. Focus in
 * the sidebar, a panel or any scrollable region keeps browser scrolling. */
export function scrollKeyBelongsToFocus(event, viewport) {
  const vertical = VERTICAL_SCROLL_KEYS.has(event?.key);
  if (!vertical && !HORIZONTAL_SCROLL_KEYS.has(event?.key)) return false;
  const target = event.target, document = target?.ownerDocument;
  if (!target || !document || target === document.body || target === document.documentElement) return false;
  if (!viewport?.contains?.(target)) return true;
  for (let element = target; element && element !== viewport; element = element.parentElement) {
    if (scrollsAlong(element, vertical)) return true;
  }
  return false;
}

export function shouldIgnoreShortcut(event, { modalOpen = false, viewport = null } = {}) {
  if (!event || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || modalOpen) return true;
  if (isShortcutEditingTarget(event.target)) return true;
  // Native button activation must not also start trajectory playback.
  if ([' ', 'Enter'].includes(event.key) && event.target?.closest?.('button, a, summary, [role="button"]')) return true;
  if (viewport && scrollKeyBelongsToFocus(event, viewport)) return true;
  return false;
}

export function keyboardGearScale(gear) {
  if (!Number.isInteger(gear) || gear < 0 || gear > 9) throw new RangeError('Keyboard gear must be an integer from 0 to 9.');
  return 2 ** (gear - DEFAULT_KEYBOARD_GEAR);
}

/** Commands retain handlers and enabled predicates; bindings remain independently editable. */
export class KeyboardCommandRegistry {
  constructor(commands, { storage = null, storageKey = SHORTCUT_STORAGE_KEY } = {}) {
    this.storage = storage; this.storageKey = storageKey;
    this.commands = commands.map(command => ({ ...command, bindings: [...command.bindings], defaults: [...command.bindings] }));
    this.gear = DEFAULT_KEYBOARD_GEAR;
    this.byId = new Map(this.commands.map(command => [command.id, command]));
    if (this.byId.size !== this.commands.length) throw new TypeError('Keyboard command IDs must be unique.');
    this.validateBindings(this.commands.map(command => command.bindings));
    this.restore();
  }

  validateBindings(bindings) {
    const owners = new Map();
    for (let index = 0; index < this.commands.length; index++) {
      // A command may be unassigned when a newer default was already taken by a saved choice.
      if (!Array.isArray(bindings[index]) || bindings[index].length > 8) throw new TypeError('Each command takes at most 8 shortcuts.');
      for (const binding of bindings[index]) {
        if (!validateShortcutBinding(binding)) throw new TypeError('Use one key, optionally with Shift; 0–9 are reserved for step sizes.');
        if (owners.has(binding)) throw new TypeError(`${binding} is already assigned to ${this.commands[owners.get(binding)].label}.`);
        owners.set(binding, index);
      }
    }
    return owners;
  }

  restore() {
    try {
      const saved = JSON.parse(this.storage?.getItem(this.storageKey) ?? 'null');
      if (!saved || saved.version !== SHORTCUT_STORAGE_VERSION || !saved.bindings || typeof saved.bindings !== 'object' || Array.isArray(saved.bindings)) return;
      // Saved choices win. A command added after the bindings were saved keeps
      // only the defaults nobody has taken, so a new default never discards them.
      const savedFor = command => Object.hasOwn(saved.bindings, command.id) ? saved.bindings[command.id] : null;
      const claimed = new Set(this.commands.flatMap(command => Array.isArray(savedFor(command)) ? savedFor(command) : []));
      const candidate = this.commands.map(command => savedFor(command) ?? command.defaults.filter(binding => !claimed.has(binding)));
      this.validateBindings(candidate); // Apply one valid map atomically, including keys freed by another command.
      this.commands.forEach((command, index) => { command.bindings = [...candidate[index]]; });
      if (Number.isInteger(saved.gear) && saved.gear >= 0 && saved.gear <= 9) this.gear = saved.gear;
    } catch { /* Disabled storage and old or malformed settings preserve defaults. */ }
  }

  persist() {
    if (!this.storage) return false;
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify({ version: SHORTCUT_STORAGE_VERSION, gear: this.gear,
        bindings: Object.fromEntries(this.commands.map(command => [command.id, command.bindings])) }));
      return true;
    } catch { return false; }
  }

  setGear(gear) { keyboardGearScale(gear); this.gear = gear; return this.persist(); }

  rebind(id, binding) {
    const command = this.byId.get(id);
    if (!command) throw new TypeError('Unknown keyboard command.');
    const owner = this.commands.find(entry => entry !== command && entry.bindings.includes(binding));
    if (owner) throw new TypeError(`${binding} is already assigned to ${owner.label}.`);
    const candidate = this.commands.map(entry => entry === command ? [binding] : entry.bindings);
    this.validateBindings(candidate); // Conflicts refuse the edit; no other command is silently changed.
    command.bindings = [binding];
    return this.persist();
  }

  reset() {
    this.commands.forEach(command => { command.bindings = [...command.defaults]; });
    this.gear = DEFAULT_KEYBOARD_GEAR;
    return this.persist();
  }

  execute(binding, event) {
    const command = this.commands.find(entry => entry.bindings.includes(binding));
    if (!command || command.enabled?.() === false) return false;
    command.handler?.({ event, gear: this.gear, scale: keyboardGearScale(this.gear) });
    return true;
  }
}
