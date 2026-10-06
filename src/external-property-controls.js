import { normalizeExternalPropertyState, validateExternalPropertyName } from './io/external-properties.js';
import { ExternalPropertyWorkerClient } from './external-property-worker-client.js';

/** Metadata stays in recipes; local attribute values stay in one Worker. */
export function initializeExternalPropertyControls({
  getFrame = () => null, getSourceVersion = () => 0, getFrameAtIndex,
  onImported = () => {}, onRemoved = () => {}, notify = () => {},
  workerClient = new ExternalPropertyWorkerClient(),
} = {}) {
  const element = id => globalThis.document?.getElementById(id) ?? null;
  const controls = {
    file: element('external-property-file'), import: element('import-external-property'),
    mapping: element('external-property-mapping'), status: element('external-property-status'), list: element('external-property-list'),
  };
  let state = { files: [] }, revision = 0, serial = 0, busy = false, enabled = false, activeImport = null;
  let applied = new WeakMap();
  // Retain Files for this source. Moving among cached frames never reparses them.
  const localFiles = new Map();
  let statusMessage = '';
  const snapshot = () => normalizeExternalPropertyState(state);
  const pendingFiles = () => state.files.filter(file => !localFiles.has(file.id));
  const baseProperties = frame => (frame?.properties ?? []).filter(property => !property.externalImportId);
  const baseNames = frame => baseProperties(frame).map(property => property.name);
  const frameDescriptor = frame => ({ ids: frame.ids, idSource: frame.idSource, frameIndex: frame.frameIndex ?? 0 });
  const cancelled = () => new DOMException('The structure or external attributes changed.', 'AbortError');

  function render() {
    if (controls.import) controls.import.disabled = !enabled || busy;
    if (controls.file) controls.file.disabled = !enabled || busy;
    if (controls.mapping) controls.mapping.disabled = !enabled || busy;
    const pending = pendingFiles();
    if (controls.status) controls.status.textContent = busy ? 'Importing external attributes…'
      : pending.length ? `Reselect external files to restore attributes: ${pending.map(entry => entry.file.name).join(', ')}. Attribute values have not been restored.`
        : statusMessage || (!enabled ? 'Open a structure before importing attributes.' : 'Import .aux numeric columns or CSV attributes.');
    if (!controls.list) return;
    controls.list.replaceChildren();
    for (const entry of state.files) {
      const container = document.createElement('div'); container.className = 'external-property-file-group';
      const heading = document.createElement('strong'); heading.textContent = entry.file.name;
      const summary = document.createElement('p'); summary.className = 'hint';
      const active = entry.columns.filter(column => column.enabled);
      summary.textContent = `${active.length} properties · ${entry.mapping === 'id' ? 'Atom ID mapping' : 'Row order anchored to atom IDs'} · ${entry.scope === 'all-frames' ? 'Stable IDs across frames' : `Frame ${entry.frameIndex + 1} only (no stable IDs)`}${localFiles.has(entry.id) ? '' : ' · Waiting for local file'}`;
      const removeFile = document.createElement('button'); removeFile.type = 'button'; removeFile.textContent = 'Remove file';
      removeFile.dataset.externalRemoveFile = entry.id; removeFile.disabled = !enabled || busy;
      removeFile.addEventListener('click', () => handle(() => remove(entry.id)));
      container.append(heading, summary, removeFile);
      for (const column of active) {
        const row = document.createElement('div'); row.className = 'external-property-row';
        const name = document.createElement('input'); name.type = 'text'; name.value = column.name; name.maxLength = 256;
        name.setAttribute('aria-label', `Name for ${column.sourceName} in ${entry.file.name}`);
        name.dataset.externalPropertyName = column.sourceName; name.dataset.externalImportId = entry.id;
        name.disabled = !enabled || busy;
        const renameButton = document.createElement('button'); renameButton.type = 'button'; renameButton.textContent = 'Rename';
        renameButton.dataset.externalRename = column.sourceName; renameButton.dataset.externalImportId = entry.id;
        renameButton.disabled = !enabled || busy;
        const renameAction = () => handle(() => rename(entry.id, column.sourceName, name.value));
        renameButton.addEventListener('click', renameAction);
        name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); renameAction(); } });
        const removeButton = document.createElement('button'); removeButton.type = 'button'; removeButton.textContent = 'Remove';
        removeButton.dataset.externalRemove = column.sourceName; removeButton.dataset.externalImportId = entry.id;
        removeButton.disabled = !enabled || busy;
        removeButton.addEventListener('click', () => handle(() => remove(entry.id, column.sourceName)));
        row.append(name, renameButton, removeButton); container.append(row);
      }
      controls.list.append(container);
    }
  }

  function report(error) {
    if (error.name === 'AbortError') return;
    statusMessage = error.message || String(error); render(); notify(statusMessage);
  }
  function handle(operation) { void Promise.resolve().then(operation).catch(report); }

  async function applyToFrame(frame, { sourceFrame = frame } = {}) {
    if (!frame || !sourceFrame) return frame;
    if (applied.get(frame)?.revision === revision && applied.get(frame)?.sourceFrame === sourceFrame) return frame;
    const requestRevision = revision, sourceVersion = getSourceVersion();
    const manifests = state.files.filter(entry => localFiles.has(entry.id));
    let properties = [];
    if (manifests.length) {
      if (frame.ids.length !== sourceFrame.ids.length && frame.physicalReplication?.sourceAtomCount !== sourceFrame.ids.length) {
        throw new Error('External attributes need the original source frame to map physical replicas.');
      }
      const result = await workerClient.request('attach', {
        manifests, frame: frameDescriptor(sourceFrame), targetCount: frame.ids.length,
        existingNames: baseNames(frame),
      });
      if (requestRevision !== revision || sourceVersion !== getSourceVersion()) throw cancelled();
      properties = result.properties;
    }
    // Commit atomically after all mappings succeed. Analyses and input fields
    // retain their original objects; only controller-owned fields are replaced.
    frame.properties = [...baseProperties(frame), ...properties];
    applied.set(frame, { revision, sourceFrame });
    return frame;
  }

  async function applyToFrames(frames) {
    return Promise.all(Array.from(frames ?? [], entry => entry?.frame && entry?.sourceFrame
      ? applyToFrame(entry.frame, { sourceFrame: entry.sourceFrame }) : applyToFrame(entry)));
  }

  async function importFile(file, options = {}) {
    if (busy) throw new Error('Wait for the current external file to finish importing.');
    const sourceVersion = getSourceVersion(), requestRevision = revision;
    let frame = getFrame();
    if (!frame) throw new Error('Open a structure before importing external attributes.');
    const matches = pendingFiles().filter(entry => entry.file.name === file?.name && entry.file.size === file?.size);
    if (matches.length > 1) throw new Error('Multiple saved external files have the same name and size. Remove an ambiguous entry before reselecting.');
    const restore = matches[0] ?? null;
    if (!restore && state.files.some(entry => localFiles.has(entry.id) && entry.file.name === file?.name && entry.file.size === file?.size)) {
      throw new Error('This external file is already attached. Rename or remove its properties in the list.');
    }
    if (restore?.mapping === 'row-order' && (frame.frameIndex ?? 0) !== restore.frameIndex) {
      if (getFrameAtIndex) frame = await getFrameAtIndex(restore.frameIndex);
      else throw new Error(`Switch to frame ${restore.frameIndex + 1} before reselecting “${restore.file.name}” so its original row-to-ID mapping can be restored.`);
      if (!frame || (frame.frameIndex ?? 0) !== restore.frameIndex) throw new Error('The original attribute mapping frame is unavailable.');
    }
    if (restore?.scope === 'single-frame' && (frame.frameIndex ?? 0) !== restore.frameIndex) {
      if (getFrameAtIndex) frame = await getFrameAtIndex(restore.frameIndex);
      else throw new Error(`Switch to frame ${restore.frameIndex + 1} before restoring this file's attributes.`);
      if (!frame || (frame.frameIndex ?? 0) !== restore.frameIndex) throw new Error('The original attribute mapping frame is unavailable.');
    }
    if (sourceVersion !== getSourceVersion() || requestRevision !== revision) throw cancelled();
    const importId = restore?.id ?? `external-${Date.now().toString(36)}-${++serial}`;
    const token = {}; activeImport = token; busy = true; statusMessage = ''; render();
    try {
      const existingNames = [...baseNames(frame), ...state.files.filter(entry => entry.id !== importId).flatMap(entry => entry.columns.filter(column => column.enabled).map(column => column.name))];
      const result = await workerClient.request('import', {
        file, importId, frame: frameDescriptor(frame), restore,
        options: { ...options, existingNames, mapping: options.mapping ?? controls.mapping?.value ?? 'auto' },
      });
      if (sourceVersion !== getSourceVersion() || requestRevision !== revision) {
        void workerClient.request('remove', { importId }).catch(() => {}); throw cancelled();
      }
      state = normalizeExternalPropertyState({ files: [...state.files.filter(entry => entry.id !== importId), result.manifest] });
      localFiles.set(importId, file); revision++;
      await applyToFrame(getFrame());
      await onImported({ reason: restore ? 'restore' : 'import', importId, frame, state: snapshot(), file });
      statusMessage = `${restore ? 'Restored' : 'Imported'} ${result.manifest.columns.filter(column => column.enabled).length} properties from ${file.name}. ${result.manifest.scope === 'single-frame' ? `Values apply to frame ${result.manifest.frameIndex + 1} only because this structure has no stable atom IDs.` : 'Values follow stable atom IDs across frames.'}`;
      return result.manifest;
    } finally { if (activeImport === token) { activeImport = null; busy = false; render(); } }
  }

  async function rename(importId, sourceName, value) {
    if (busy) throw new Error('Wait for the current external file to finish importing.');
    const entry = state.files.find(file => file.id === importId), column = entry?.columns.find(item => item.sourceName === sourceName && item.enabled);
    if (!column) throw new Error('The external property is no longer available.');
    const name = validateExternalPropertyName(value, baseNames(getFrame()));
    if (name === column.name) return snapshot();
    state = normalizeExternalPropertyState({ files: state.files.map(file => file.id === importId
      ? { ...file, columns: file.columns.map(item => item === column ? { ...item, name } : item) } : file) });
    revision++; await applyToFrame(getFrame());
    await onImported({ reason: 'rename', importId, oldName: column.name, name, state: snapshot() });
    statusMessage = `Renamed “${column.name}” to “${name}”.`; render(); return snapshot();
  }

  async function remove(importId, sourceName) {
    if (busy) throw new Error('Wait for the current external file to finish importing.');
    const entry = state.files.find(file => file.id === importId);
    if (!entry) return snapshot();
    if (sourceName !== undefined && !entry.columns.some(column => column.sourceName === sourceName && column.enabled)) return snapshot();
    const removedNames = entry.columns.filter(column => column.enabled && (sourceName === undefined || column.sourceName === sourceName)).map(column => column.name);
    state = normalizeExternalPropertyState({ files: sourceName === undefined ? state.files.filter(file => file.id !== importId)
      : state.files.map(file => file.id === importId ? { ...file, columns: file.columns.map(column => column.sourceName === sourceName ? { ...column, enabled: false } : column) } : file) });
    if (sourceName === undefined && localFiles.delete(importId)) await workerClient.request('remove', { importId });
    revision++; await applyToFrame(getFrame());
    await onRemoved({ importId, sourceName, removedNames, state: snapshot() });
    statusMessage = sourceName === undefined ? `Removed attributes from ${entry.file.name}.` : `Removed “${removedNames[0]}”.`; render(); return snapshot();
  }

  function reset() {
    revision++; state = { files: [] }; localFiles.clear(); applied = new WeakMap();
    workerClient.reset(); activeImport = null; busy = false; statusMessage = ''; render();
  }

  controls.import?.addEventListener('click', () => controls.file?.click());
  controls.file?.addEventListener('change', () => {
    const files = Array.from(controls.file.files ?? []); controls.file.value = '';
    handle(async () => { for (const file of files) await importFile(file); });
  });
  render();
  return Object.freeze({
    importFile, applyToFrame, applyToFrames, rename, remove, reset,
    getState: snapshot,
    getPendingFiles: () => pendingFiles().map(entry => ({ ...entry.file })),
    setState(value, { silent = true } = {}) {
      const next = normalizeExternalPropertyState(value);
      const keep = new Set(next.files.filter(entry => {
        const old = state.files.find(file => file.id === entry.id);
        return localFiles.has(entry.id) && old?.file.name === entry.file.name && old?.file.size === entry.file.size
          && old.mapping === entry.mapping && old.frameIndex === entry.frameIndex && old.scope === entry.scope
          && JSON.stringify(old.columns.map(column => column.sourceName)) === JSON.stringify(entry.columns.map(column => column.sourceName));
      }).map(entry => entry.id));
      for (const id of localFiles.keys()) if (!keep.has(id)) { localFiles.delete(id); void workerClient.request('remove', { importId: id }).catch(() => {}); }
      state = next; revision++; statusMessage = ''; render();
      if (!silent) notify(pendingFiles().length ? `Reselect external files: ${pendingFiles().map(entry => entry.file.name).join(', ')}.` : 'External attribute settings restored.');
      return snapshot();
    },
    refresh: render,
    setEnabled(value) { enabled = Boolean(value); render(); },
  });
}
