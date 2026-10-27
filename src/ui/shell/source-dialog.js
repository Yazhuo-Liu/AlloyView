export function sourceFormatLabel(format) {
  const sequence = format.endsWith('-sequence');
  const base = sequence ? format.slice(0, -9) : format;
  return `${({ cfg: 'CFG', 'lammps-dump': 'LAMMPS', 'lammps-data': 'LAMMPS data', xyz: 'XYZ', pdb: 'PDB', poscar: 'POSCAR', cif: 'CIF', cube: 'Cube', 'vasp-volume': 'VASP volume' })[base] ?? base.toUpperCase()}${sequence ? ' · sequence' : ''}`;
}

/** The modal listing local files, detected numbered sequences and the bundled
 * examples. It renders choices only: opening a chosen source or example is
 * delegated to `openSource(source)` and `openExample(entry)`, and the local
 * file and folder pickers are the page's hidden inputs. */
export function createSourceDialog({ elements, manifestUrl, getEntries, openSource, openExample }) {
  let exampleCatalog = null;
  let exampleCatalogPromise = null;

  function showLocalPicker() {
    elements['source-dialog-kicker'].textContent = 'LOCAL SOURCES';
    elements['source-dialog-title'].textContent = 'Open local structures';
    elements['source-dialog-summary'].textContent = 'Choose individual files or a folder. All structure data is processed on this device.';
    elements['source-options'].replaceChildren(
      exampleOption('Choose files…', 'Files', 'Open CFG or LAMMPS files, or select multiple trajectory frames.', () => elements['file-input'].click()),
      exampleOption('Choose folder…', 'Folder', 'Browse all files and automatically detect numbered sequences.', () => elements['folder-input'].click()),
    );
    elements['source-dialog'].showModal();
  }

  function showSourceChooser(catalog, originLabel, entries = getEntries(), { singleFiles = false } = {}) {
    elements['source-dialog-kicker'].textContent = 'LOCAL SOURCES';
    elements['source-dialog-title'].textContent = singleFiles ? 'Choose a file to open' : 'Choose a structure or sequence';
    elements['source-dialog-summary'].textContent = singleFiles
      ? `Choose one of the ${catalog.supportedCount} recognized structure files. Each file opens individually.`
      : `The browser supplied ${entries.length} files from the ${originLabel}. ${catalog.supportedCount} structure files and ${catalog.sequenceCount} numbered structure sequence${catalog.sequenceCount === 1 ? '' : 's'} were recognized.`;
    const fragment = document.createDocumentFragment();
    const sequences = catalog.sources.filter((source) => source.kind === 'sequence');
    if (sequences.length > 0) {
      fragment.append(sourceListHeading('Detected sequences', `${sequences.length}`));
      for (const source of sequences) {
        fragment.append(sourceOption(
          source,
          `${sourceFormatLabel(source.format)} sequence`,
          source.detail,
        ));
      }
    }
    fragment.append(sourceListHeading('All files', `${entries.length}`));
    const sequenceByPath = new Map();
    for (const sequence of sequences) {
      for (const entry of sequence.entries) sequenceByPath.set(entry.relativePath, sequence);
    }
    const singleByPath = new Map(catalog.sources
      .filter((source) => source.kind === 'file')
      .map((source) => [source.entries[0].relativePath, source]));
    for (const entry of entries) {
      const sequence = sequenceByPath.get(entry.relativePath);
      const single = singleByPath.get(entry.relativePath);
      if (sequence) {
        fragment.append(sourceOption(
          sequence,
          'Sequence member',
          `Opens detected sequence · ${sequence.detail}`,
          entry.relativePath,
        ));
      } else if (single) {
        fragment.append(sourceOption(single, sourceFormatLabel(entry.format), single.detail));
      } else {
        fragment.append(sourceOption(null, 'Other', 'Not recognized as CFG or LAMMPS structure data', entry.relativePath));
      }
    }
    elements['source-options'].replaceChildren(fragment);
    elements['source-dialog'].showModal();
  }

  function sourceListHeading(title, count) {
    const heading = document.createElement('div');
    heading.className = 'source-list-heading';
    const label = document.createElement('strong');
    label.textContent = title;
    const total = document.createElement('small');
    total.textContent = count;
    heading.append(label, total);
    return heading;
  }

  function sourceOption(source, kindLabel, detailText, labelOverride = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source-option';
    button.disabled = !source;
    const title = document.createElement('strong');
    title.textContent = labelOverride ?? source?.label ?? 'Unknown file';
    const kind = document.createElement('span');
    kind.className = 'source-option-kind';
    kind.textContent = kindLabel;
    const detail = document.createElement('small');
    detail.textContent = detailText;
    button.append(title, kind, detail);
    if (source) {
      button.addEventListener('click', () => {
        elements['source-dialog'].close();
        openSource(source);
      });
    }
    return button;
  }

  function showExampleChooser() {
    elements['source-dialog-kicker'].textContent = 'EXAMPLES';
    elements['source-dialog-title'].textContent = 'Choose an example';
    elements['source-dialog-summary'].textContent = 'Files and folders bundled under examples/.';
    if (exampleCatalog) renderExampleCatalog(exampleCatalog);
    else {
      elements['source-options'].replaceChildren();
      elements['source-dialog-summary'].textContent = 'Loading bundled examples…';
    }
    void loadExampleCatalog({ refresh: true }).then(catalog => {
      if (elements['source-dialog'].open && elements['source-dialog-kicker'].textContent === 'EXAMPLES') renderExampleCatalog(catalog);
    }).catch(error => {
      if (!elements['source-dialog'].open || elements['source-dialog-kicker'].textContent !== 'EXAMPLES') return;
      elements['source-dialog-summary'].textContent = error.message;
      if (!exampleCatalog) elements['source-options'].replaceChildren(exampleOption('Retry loading examples', 'Retry', '', showExampleChooser));
    });
    elements['source-dialog'].showModal();
  }

  function loadExampleCatalog({ refresh = false } = {}) {
    if (exampleCatalog && !refresh) return Promise.resolve(exampleCatalog);
    if (exampleCatalogPromise) return exampleCatalogPromise;
    exampleCatalogPromise = fetch(manifestUrl, { cache: 'no-cache' }).then(async response => {
      if (!response.ok) throw new Error(`Example list request failed: HTTP ${response.status}`);
      const catalog = await response.json();
      if (catalog.version !== 1 || !Array.isArray(catalog.examples)) throw new Error('Invalid example list.');
      exampleCatalog = catalog;
      return catalog;
    }).finally(() => { exampleCatalogPromise = null; });
    return exampleCatalogPromise;
  }

  function renderExampleCatalog(catalog) {
    elements['source-dialog-summary'].textContent = catalog.examples.length
      ? 'Files and folders bundled under examples/.' : 'No supported structure files are bundled under examples/.';
    const fragment = document.createDocumentFragment();
    fragment.append(sourceListHeading('examples/', `${catalog.examples.length} items`));
    for (const entry of catalog.examples) fragment.append(exampleOption(
      entry.label, entry.kind === 'sequence' ? 'Folder' : sourceFormatLabel(entry.format),
      entry.detail, () => openExample(entry),
    ));
    elements['source-options'].replaceChildren(fragment);
  }

  function exampleOption(labelText, kindLabel, detailText, action) {
    const button = sourceOption(null, kindLabel, detailText, labelText);
    button.disabled = false;
    button.addEventListener('click', () => {
      elements['source-dialog'].close();
      action();
    });
    return button;
  }

  function close() { if (elements['source-dialog'].open) elements['source-dialog'].close(); }

  /** Close the dialog and drop its rendered options, e.g. when a source closes. */
  function reset() {
    close();
    elements['source-options'].replaceChildren();
  }

  elements['source-dialog-close'].addEventListener('click', close);

  return { showLocalPicker, showSourceChooser, showExampleChooser, loadExampleCatalog, close, reset };
}
