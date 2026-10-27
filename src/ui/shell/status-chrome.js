import { formatBytes } from './format.js';

/** Transient page chrome: the toast, the loading indicator, the first-use
 * interaction hint, range-input progress styling and the memory metric.
 * Whoever shows the loading indicator hides it; a caller that others can
 * interrupt passes an `owner` and hides it only while `loadingOwner` is still
 * that owner. */
export function createStatusChrome({ elements }) {
  let toastTimer = null;
  let interactionHintTimer = null;
  let interactionHintFadeTimer = null;
  let loadingOwner = null, loadingReadProgress = false, loadingTimer = null;

  function showInteractionHint() {
    clearTimeout(interactionHintTimer);
    clearTimeout(interactionHintFadeTimer);
    elements['interaction-hint'].classList.remove('is-hiding');
    elements['interaction-hint'].hidden = false;
    interactionHintTimer = setTimeout(dismissInteractionHint, 5000);
  }

  function dismissInteractionHint() {
    clearTimeout(interactionHintTimer);
    clearTimeout(interactionHintFadeTimer);
    if (elements['interaction-hint'].hidden) return;
    elements['interaction-hint'].classList.add('is-hiding');
    interactionHintFadeTimer = setTimeout(() => {
      elements['interaction-hint'].hidden = true;
      elements['interaction-hint'].classList.remove('is-hiding');
    }, 300);
  }

  /** Show or hide the loading indicator. Whoever shows it hides it; a caller
   * that others can interrupt passes an `owner`, and hides it only while
   * `loadingOwner` is still that owner. `readProgress` lets structure Worker
   * progress replace the text. */
  function setLoading(visible, text = '', owner = null, readProgress = owner === null, { delay = 0 } = {}) {
    clearTimeout(loadingTimer);
    loadingTimer = null;
    loadingOwner = visible ? owner : null;
    loadingReadProgress = visible && readProgress;
    if (text) elements['loading-text'].textContent = text;
    if (visible && delay > 0) {
      elements.loading.hidden = true;
      loadingTimer = setTimeout(() => {
        loadingTimer = null;
        if (loadingOwner === owner) elements.loading.hidden = false;
      }, delay);
    } else elements.loading.hidden = !visible;
  }

  /** Progress of a structure Worker read describes a wait that some caller
   * announced and will end. A read nobody announced stays silent, rather than
   * showing an indicator that nothing hides. */
  function reportReadProgress(text) {
    if (loadingReadProgress) elements['loading-text'].textContent = text;
  }

  function showToast(message, success = false) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle('success', success);
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, success ? 2600 : 6500);
  }

  function setRangeProgress(range) {
    const minimum = Number(range.min || 0);
    const maximum = Number(range.max || 100);
    const value = Number(range.value);
    const percentage = maximum > minimum ? (value - minimum) / (maximum - minimum) * 100 : 0;
    range.style.setProperty('--range-progress', `${percentage}%`);
  }

  function updateMemoryMetric() {
    if (performance.memory?.usedJSHeapSize) {
      elements['metric-memory'].textContent = formatBytes(performance.memory.usedJSHeapSize);
    }
  }

  /** Hide every transient element and drop pending timers, e.g. when a source closes. */
  function reset() {
    clearTimeout(toastTimer);
    clearTimeout(interactionHintTimer);
    clearTimeout(interactionHintFadeTimer);
    setLoading(false);
    elements.toast.hidden = elements['interaction-hint'].hidden = true;
    elements['interaction-hint'].classList.remove('is-hiding');
  }

  return {
    showToast, setLoading, reportReadProgress, showInteractionHint, dismissInteractionHint,
    setRangeProgress, updateMemoryMetric, reset,
    get loadingOwner() { return loadingOwner; },
  };
}
