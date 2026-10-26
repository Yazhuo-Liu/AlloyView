/** Independent from polyhedra and declared CIF metadata: live geometry gets a
 * genuine symmetry result, and refined cells are exported as separate files. */
export function initializeCrystalSymmetryControls({ client, getFrame, getSourceVersion = () => 0,
  onExportCell = null, notify = () => {} }) {
  const $ = id => globalThis.document?.getElementById(id) ?? null;
  let enabled = false, controller = null, result = null, source = null, version = null, revision = null, serial = 0, exporting = false, exportController = null;
  const frameRevision = frame => frame?.geometryRevision ?? 0;
  const fresh = () => result && source === getFrame() && version === getSourceVersion() && revision === frameRevision(getFrame());
  function controls() {
    const available = enabled && Boolean(getFrame());
    for (const id of ['crystal-symmetry-tolerance', 'crystal-symmetry-format']) if ($(id)) $(id).disabled = !available || Boolean(controller);
    if ($('run-crystal-symmetry')) $('run-crystal-symmetry').disabled = !available || Boolean(controller);
    if ($('cancel-crystal-symmetry')) $('cancel-crystal-symmetry').disabled = !controller;
    for (const kind of ['primitive', 'conventional']) if ($(`export-crystal-${kind}`)) $(`export-crystal-${kind}`).disabled = !available || !fresh() || exporting || !onExportCell;
  }
  function status(text) { if ($('crystal-symmetry-status')) $('crystal-symmetry-status').textContent = text; controls(); }
  function reset() {
    serial++; controller?.abort(); controller = null; exportController?.abort(); exportController = null;
    result = null; source = null; client.clear();
    if ($('crystal-symmetry-result')) { $('crystal-symmetry-result').hidden = true; $('crystal-symmetry-result').textContent = ''; }
    status('Analyze the current ordered, periodic structure with moyo. Source-file labels are kept separately.');
  }
  async function run() {
    const frame = getFrame(); if (!enabled || !frame || controller) return;
    const request = ++serial, currentVersion = getSourceVersion(), currentRevision = frameRevision(frame);
    const abortController = new AbortController(); controller = abortController;
    result = null; if ($('crystal-symmetry-result')) $('crystal-symmetry-result').hidden = true;
    status('Identifying the space group in a CPU Worker…');
    try {
      const output = await client.analyze(frame, { symprec: Number($('crystal-symmetry-tolerance')?.value ?? 1e-4) }, { signal: abortController.signal });
      if (request !== serial || frame !== getFrame() || currentVersion !== getSourceVersion() || currentRevision !== frameRevision(frame)) return;
      result = output; source = frame; version = currentVersion; revision = currentRevision;
      if ($('crystal-symmetry-result')) {
        const sites = [...new Set(output.wyckoffs)].sort().join(', ');
        $('crystal-symmetry-result').textContent = `${output.symbol} · No. ${output.number} · Hall ${output.hallNumber} · ${output.pearson}. ${output.operationCount} symmetry operations; Wyckoff letters: ${sites}. Primitive: ${output.primitive.ids.length} sites; conventional: ${output.conventional.ids.length} sites.`;
        $('crystal-symmetry-result').hidden = false;
      }
      status(`Identified using ${output.engine} in ${Math.round(output.elapsedMs)} ms. Effective tolerance: ${output.symprec} Å.`);
    } catch (error) {
      if (request === serial) status(error.name === 'AbortError' ? 'Symmetry identification cancelled.' : error.message);
    } finally { if (request === serial) controller = null; controls(); }
  }
  async function exportCell(kind) {
    if (!fresh() || exporting || !onExportCell) return;
    const request = serial, abortController = new AbortController(); exportController = abortController;
    exporting = true; controls();
    try { await onExportCell(result[kind], $('crystal-symmetry-format')?.value ?? 'cif', kind,
      { signal: abortController.signal, isCurrent: () => request === serial && fresh() && !abortController.signal.aborted }); }
    catch (error) { if (request === serial && error.name !== 'AbortError') notify(error.message); }
    finally { if (exportController === abortController) exportController = null; exporting = false; controls(); }
  }
  $('run-crystal-symmetry')?.addEventListener('click', run);
  $('cancel-crystal-symmetry')?.addEventListener('click', () => { controller?.abort(); });
  $('crystal-symmetry-tolerance')?.addEventListener('change', reset);
  for (const kind of ['primitive', 'conventional']) $(`export-crystal-${kind}`)?.addEventListener('click', () => exportCell(kind));
  $('crystal-symmetry-controls')?.addEventListener('toggle', () => {
    if ($('crystal-symmetry-controls').open && enabled) client.warm().catch(() => {});
  });
  controls();
  return { run, reset, abortJobs: reset, setEnabled(value) { enabled = Boolean(value); controls(); },
    onFrame() { if (source !== getFrame() || version !== getSourceVersion() || revision !== frameRevision(getFrame())) reset(); else controls(); },
    dispose() { reset(); client.dispose(); }, getResult: () => fresh() ? result : null };
}
