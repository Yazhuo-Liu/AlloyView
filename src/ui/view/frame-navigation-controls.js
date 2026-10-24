/** The timeline previews pointer drags without decoding intermediate frames.
 * Keyboard changes are debounced; release, Enter and Go commit immediately.
 * The owner cancels obsolete work in onIntent and retains its shared caches. */
export function initializeFrameNavigationControls({ slider, input, go, label, getState,
  onIntent = () => {}, onNavigate, onPreview = () => {}, notify = () => {},
  documentRoot = globalThis.document, debounceMs = 70,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  let timer = null, dragging = false, desired = null, serial = 0, committed = null;
  const listeners = [];
  const state = () => {
    const value = getState();
    const count = Math.max(0, Number.isSafeInteger(value.count) ? value.count : 0);
    return { ...value, count, index: Math.max(0, Math.min(count - 1, value.index ?? 0)),
      enabled: Boolean(value.enabled) && count > 1 };
  };
  const listen = (element, type, callback) => {
    element?.addEventListener(type, callback);
    listeners.push(() => element?.removeEventListener(type, callback));
  };
  function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
  function preview(index) {
    const current = state();
    if (label) label.textContent = `${index + 1} / ${current.count}${current.indexComplete === false ? '+' : ''}`;
    slider.value = String(index);
    if (input && documentRoot?.activeElement !== input) input.value = String(index + 1);
    slider.setAttribute?.('aria-valuetext', `Frame ${index + 1} of ${current.count}`);
    onPreview(index);
  }
  function intent(index) {
    if (desired !== index) {
      desired = index;
      committed = null;
      serial++;
      onIntent(index);
    }
    preview(index);
  }
  function refresh({ force = false, keepInput = false } = {}) {
    const current = state();
    for (const element of [slider, input, go]) if (element) element.disabled = !current.enabled;
    if (input) {
      input.min = '1'; input.max = String(Math.max(1, current.count));
      input.title = current.indexComplete === false
        ? `Jump to an indexed frame (1–${current.count}); more frames are being indexed.`
        : `Jump to frame 1–${current.count}.`;
      if (!keepInput && (force || (documentRoot?.activeElement !== input && desired === null))) input.value = current.count ? String(current.index + 1) : '';
    }
    if (!current.enabled) {
      cancelTimer(); dragging = false; desired = null; committed = null; serial++;
    }
    if (force && desired === null) {
      if (current.count) preview(current.index);
      else {
        slider.value = '0';
        if (label) label.textContent = '0 / 0';
        slider.setAttribute?.('aria-valuetext', 'No frames');
      }
    }
  }
  function submit(index, { retry = false } = {}) {
    const current = state();
    if (!current.enabled) return;
    cancelTimer();
    if (!Number.isSafeInteger(index) || index < 0 || index >= current.count) {
      notify(`Enter a frame number from 1 to ${current.count}.${current.indexComplete === false ? ' More frames are still being indexed.' : ''}`);
      return;
    }
    if (!retry && committed === index && desired === null && current.index === index) return;
    intent(index);
    if (!retry && committed === index) return;
    committed = index;
    const request = serial;
    const inputAtSubmit = input?.value;
    const finish = () => {
      desired = null;
      refresh({ force: true, keepInput: documentRoot?.activeElement === input && input?.value !== inputAtSubmit });
    };
    Promise.resolve().then(() => {
      if (request !== serial) return false;
      return onNavigate(index);
    }).then(() => {
      if (request !== serial) return;
      finish();
    }, error => {
      if (request !== serial) return;
      finish();
      if (error?.name !== 'AbortError') notify(error?.message ?? String(error));
    });
  }
  function rangeInput() {
    if (!state().enabled) return;
    const index = Number(slider.value);
    intent(index);
    cancelTimer();
    if (!dragging) timer = setTimer(() => { timer = null; submit(index); }, debounceMs);
  }
  function finishDrag() {
    if (!dragging) return;
    dragging = false;
    if (desired !== null) submit(desired);
  }
  function numericSubmit() {
    const text = input?.value?.trim();
    submit(text ? Number(text) - 1 : NaN, { retry: true });
  }
  listen(slider, 'input', rangeInput);
  listen(slider, 'change', () => {
    // Native range controls emit change on each keyboard step. Keep the
    // debounce already scheduled by input; a pointer release commits below.
    if (!dragging && timer !== null) return;
    submit(Number(slider.value));
  });
  listen(slider, 'pointerdown', () => { if (state().enabled) { dragging = true; cancelTimer(); } });
  listen(slider, 'pointerup', finishDrag);
  listen(documentRoot, 'pointerup', finishDrag);
  listen(slider, 'pointercancel', () => { dragging = false; cancelTimer(); desired = null; committed = null; serial++; refresh({ force: true }); });
  listen(input, 'keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); numericSubmit(); }
    if (event.key === 'Escape') { event.preventDefault(); desired = null; refresh({ force: true }); input.blur?.(); }
  });
  listen(go, 'click', numericSubmit);
  refresh({ force: true });
  return {
    refresh,
    cancel() { cancelTimer(); dragging = false; desired = null; committed = null; serial++; },
    reset() { this.cancel(); refresh({ force: true }); },
    dispose() { this.cancel(); for (const remove of listeners) remove(); },
  };
}
