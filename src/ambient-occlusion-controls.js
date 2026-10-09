import { AmbientOcclusionController, DEFAULT_AMBIENT_OCCLUSION, normalizeAmbientOcclusionSettings } from './render/ambient-occlusion.js';

const IDS = ['ambient-occlusion', 'ambient-occlusion-intensity', 'ambient-occlusion-intensity-value', 'ambient-occlusion-directions',
  'ambient-occlusion-resolution', 'ambient-occlusion-status', 'ambient-occlusion-progress', 'ambient-occlusion-recompute', 'ambient-occlusion-cancel'];

export function ambientOcclusionStatusText(status) {
  switch (status.state) {
    case 'off': return 'Off. Atom colors are unchanged.';
    case 'idle': return 'Load a structure to compute ambient occlusion.';
    case 'queued': return 'Update queued…';
    case 'computing': return `Computing… ${status.completed} / ${status.total} directions`;
    case 'cancelled': return 'Cancelled. Choose Recompute, or change the view, to update.';
    case 'error': return `Unavailable: ${status.message}`;
    case 'ready': {
      const seconds = status.elapsedMs < 1000 ? `${Math.round(status.elapsedMs)} ms` : `${(status.elapsedMs / 1000).toFixed(2)} s`;
      return `Current: ${status.total} directions at ${status.resolution} × ${status.resolution} px, ${status.instances.toLocaleString('en-US')} displayed atoms, ${seconds}.`;
    }
    default: return '';
  }
}

/** Display → Ambient occlusion. The controller owns the computation; this
 * module maps it to the form, configuration state and status line. */
export function initializeAmbientOcclusionControls({ renderer, onEdit = () => {}, onChange = () => {}, notify = () => {},
  createController = (target, options) => new AmbientOcclusionController(target, options) } = {}) {
  const nodes = Object.fromEntries(IDS.map(id => [id, document.getElementById(id)]));
  let enabled = false, status = { state: 'off' };
  const occlusion = createController(renderer, { onChange: () => onChange(), onStatus: value => { status = value; sync(); } });

  function read() {
    return normalizeAmbientOcclusionSettings({ enabled: nodes['ambient-occlusion'].checked, intensity: Number(nodes['ambient-occlusion-intensity'].value),
      directions: Number(nodes['ambient-occlusion-directions'].value), resolution: Number(nodes['ambient-occlusion-resolution'].value) });
  }
  function write(settings) {
    nodes['ambient-occlusion'].checked = settings.enabled;
    nodes['ambient-occlusion-intensity'].value = String(settings.intensity);
    nodes['ambient-occlusion-directions'].value = String(settings.directions);
    nodes['ambient-occlusion-resolution'].value = String(settings.resolution);
  }
  function sync() {
    const settings = occlusion.settings, busy = status.state === 'computing' || status.state === 'queued';
    nodes['ambient-occlusion'].disabled = !enabled;
    for (const id of ['ambient-occlusion-intensity', 'ambient-occlusion-directions', 'ambient-occlusion-resolution']) nodes[id].disabled = !enabled || !settings.enabled;
    nodes['ambient-occlusion-recompute'].disabled = !enabled || !settings.enabled || busy;
    nodes['ambient-occlusion-cancel'].disabled = !enabled || !busy;
    nodes['ambient-occlusion-intensity-value'].textContent = settings.intensity.toFixed(2);
    const range = nodes['ambient-occlusion-intensity'];
    range.style?.setProperty?.('--range-progress', `${settings.intensity * 100}%`);
    nodes['ambient-occlusion-status'].textContent = ambientOcclusionStatusText(status);
    nodes['ambient-occlusion-status'].classList?.toggle('error', status.state === 'error');
    const progress = nodes['ambient-occlusion-progress'];
    progress.hidden = !busy;
    progress.max = status.total || 1; progress.value = status.completed ?? 0;
  }
  function apply(patch) {
    try { occlusion.setSettings(patch); }
    catch (error) { write(occlusion.settings); notify(error.message); }
    sync();
  }
  function changed(event) {
    onEdit();
    let settings;
    try { settings = read(); } catch (error) { write(occlusion.settings); notify(error.message); sync(); return; }
    // Intensity is a shader uniform: dragging it never recomputes.
    apply(event?.type === 'input' ? { intensity: settings.intensity } : settings);
  }
  const listeners = [['ambient-occlusion', 'change'], ['ambient-occlusion-intensity', 'input'], ['ambient-occlusion-intensity', 'change'],
    ['ambient-occlusion-directions', 'change'], ['ambient-occlusion-resolution', 'change']];
  for (const [id, name] of listeners) nodes[id].addEventListener(name, changed);
  const recompute = () => { onEdit(); occlusion.recompute(); sync(); };
  const cancel = () => { occlusion.cancel(); sync(); };
  nodes['ambient-occlusion-recompute'].addEventListener('click', recompute);
  nodes['ambient-occlusion-cancel'].addEventListener('click', cancel);
  write(occlusion.settings); sync();

  return {
    controller: occlusion,
    getState: () => ({ ...occlusion.settings }),
    /** Older recipes have no entry and restore the default: off. */
    restore(value) { const settings = normalizeAmbientOcclusionSettings(value ?? {}, DEFAULT_AMBIENT_OCCLUSION); write(settings); apply(settings); },
    setEnabled(value) { enabled = Boolean(value); sync(); },
    update: () => occlusion.update(),
    ensureCurrent: () => occlusion.ensureCurrent(),
    getStatus: () => ({ ...status }),
    dispose() {
      for (const [id, name] of listeners) nodes[id].removeEventListener(name, changed);
      nodes['ambient-occlusion-recompute'].removeEventListener('click', recompute);
      nodes['ambient-occlusion-cancel'].removeEventListener('click', cancel);
      occlusion.dispose();
    },
  };
}
