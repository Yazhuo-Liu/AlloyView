import { isReadableLocalFile } from '../io/local-files.js';
import { parseExternalProperties, mapExternalProperties, normalizeExternalPropertyState, validateExternalPropertyName, validateExternalPropertyAllocation } from '../io/external-properties.js';

const imports = new Map();

self.addEventListener('message', async event => {
  const { id, type, payload } = event.data;
  try {
    let result, transfer = [];
    if (type === 'import') {
      if (!isReadableLocalFile(payload.file)) throw new Error('Select a readable external attribute file.');
      const restore = payload.restore ? normalizeExternalPropertyState({ files: [payload.restore] }).files[0] : null;
      const restoredNames = restore?.columns.map(column => column.name);
      if (restore) {
        const usedNames = new Set([...restoredNames, ...(payload.options?.existingNames ?? [])].map(name => name.toLowerCase()));
        restore.columns.forEach((column, index) => {
          if (column.enabled) return;
          let placeholder = `unused_restored_attribute_${index + 1}`;
          while (usedNames.has(placeholder.toLowerCase())) placeholder += '_';
          restoredNames[index] = placeholder; usedNames.add(placeholder.toLowerCase());
        });
      }
      const bundle = parseExternalProperties(await payload.file.text(), {
        ...payload.options,
        frameIds: payload.frame.ids, idSource: payload.frame.idSource, frameIndex: payload.frame.frameIndex ?? 0,
        importId: payload.importId,
        sourceName: payload.file.name,
        fileMetadata: { name: payload.file.name, size: payload.file.size, ...(Number.isSafeInteger(payload.file.lastModified) ? { lastModified: payload.file.lastModified } : {}) },
        ...(restore ? { mapping: restore.mapping, names: restoredNames } : {}),
      });
      if (restore) {
        if (bundle.columns.length !== restore.columns.length || bundle.columns.some((column, index) => column.sourceName !== restore.columns[index].sourceName)) {
          throw new Error('The reselected external file has different columns from the saved configuration.');
        }
        bundle.manifest = restore;
      }
      imports.set(payload.importId, bundle);
      result = { manifest: bundle.manifest };
    } else if (type === 'attach') {
      const manifests = normalizeExternalPropertyState({ files: payload.manifests }).files;
      validateExternalPropertyAllocation(payload.targetCount ?? payload.frame.ids.length,
        manifests.reduce((count, manifest) => count + manifest.columns.filter(column => column.enabled).length, 0));
      const names = [...payload.existingNames];
      const properties = [];
      for (const manifest of manifests) {
        const bundle = imports.get(manifest.id);
        if (!bundle) throw new Error(`Reselect “${manifest.file.name}” to restore its external attributes.`);
        const mapped = mapExternalProperties(bundle, payload.frame, manifest);
        for (const property of mapped) { validateExternalPropertyName(property.name, names); names.push(property.name); }
        properties.push(...mapped);
      }
      const sourceCount = payload.frame.ids.length;
      const targetCount = payload.targetCount ?? sourceCount;
      if (!Number.isSafeInteger(targetCount) || targetCount < sourceCount || targetCount % sourceCount) throw new Error('External attributes cannot be mapped to this replicated frame.');
      if (targetCount !== sourceCount) {
        for (const property of properties) {
          const data = new Float64Array(targetCount);
          for (let offset = 0; offset < targetCount; offset += sourceCount) data.set(property.data, offset);
          property.data = data;
        }
      }
      result = { properties };
      transfer = properties.map(property => property.data.buffer);
    } else if (type === 'remove') { imports.delete(payload.importId); result = {}; }
    else if (type === 'reset') { imports.clear(); result = {}; }
    else throw new Error(`Unknown external property request: ${type}`);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) { self.postMessage({ id, ok: false, error: error.message || String(error) }); }
});
