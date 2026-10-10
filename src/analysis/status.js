/** Describe the backend actually executing a job, including automatic fallback. */
export function analysisProgressText(progress, { frameIndex = 0, kind = '' } = {}) {
  const { backend, phase, completed = 0, total = 1, workerCount = total,
    prepared = 0, initialized = 0, completedAtoms, totalAtoms } = progress;
  const frame = `frame ${frameIndex + 1}`;
  const atoms = Number.isFinite(completedAtoms) && totalAtoms > 0
    ? ` ${completedAtoms.toLocaleString('en-US')} / ${totalAtoms.toLocaleString('en-US')} atoms` : '';
  if (backend === 'gpu') {
    if (phase === 'queued') return `Waiting for the GPU for ${frame}…`;
    if (phase === 'initializing') return 'Initializing WebGPU…';
    if (phase === 'preparing') return `Uploading ${frame} to the GPU…`;
    if (phase === 'indexing') return progress.stage === 'ptm-neighbors'
      ? `Preparing PTM neighbors with WebGPU for ${frame}…` : kind === 'displacement'
        ? `Preparing GPU displacement data for ${frame}…` : `Building GPU neighbor search for ${frame}…`;
    if (progress.stage === 'strain-tensor') return `Calculating lattice-reference strain with WebGPU for ${frame}…${atoms}`;
    return `Analyzing ${frame} with WebGPU…${atoms}`;
  }
  if (phase === 'queued') return `Waiting for available analysis Workers for ${frame}…`;
  if (phase === 'preparing') return `Preparing ${frame} data… ${prepared} / ${total} Worker inputs`;
  if (phase === 'initializing') return `Initializing ${kind === 'ptm' || kind === 'strain' ? 'PTM and ' : ''}Workers… ${initialized} / ${total}`;
  if (phase === 'indexing') return progress.stage === 'ptm-fit'
    ? `Preparing crystal template fitting for ${frame}…` : `Building neighbor search for ${frame}…`;
  if (progress.stage === 'ptm-fit') return `Fitting crystal templates for ${frame} with ${workerCount} CPU Worker${workerCount > 1 ? 's' : ''}…${atoms}`;
  return `Analyzing ${frame} with ${workerCount} Worker${workerCount > 1 ? 's' : ''}…${atoms ? `${atoms} ·` : ''} ${completed} / ${total} completed`;
}

export function analysisBackendLabel(result) {
  return `${result.engine}${result.fallbackReason ? ' · CPU fallback' : ''}`;
}

/** A fallback names the failed GPU attempt. A route reason explains a backend
 * that was chosen without one. */
export function analysisBackendDetails(result) {
  return result.fallbackReason ? `CPU fallback: ${result.fallbackReason}`
    : result.routeReason ? `${result.engine} · ${result.routeReason}` : result.engine;
}
