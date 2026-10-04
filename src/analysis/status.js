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
    if (phase === 'indexing') return kind === 'displacement'
      ? `Preparing GPU displacement data for ${frame}…` : `Building GPU neighbor search for ${frame}…`;
    return `Analyzing ${frame} with WebGPU…${atoms}`;
  }
  if (phase === 'queued') return `Waiting for available analysis Workers for ${frame}…`;
  if (phase === 'preparing') return `Preparing ${frame} data… ${prepared} / ${total} Worker inputs`;
  if (phase === 'initializing') return `Initializing ${kind === 'ptm' || kind === 'strain' ? 'PTM and ' : ''}Workers… ${initialized} / ${total}`;
  if (phase === 'indexing') return `Building neighbor search for ${frame}…`;
  return `Analyzing ${frame} with ${workerCount} Worker${workerCount > 1 ? 's' : ''}…${atoms ? `${atoms} ·` : ''} ${completed} / ${total} completed`;
}

export function analysisBackendLabel(result) {
  return `${result.engine}${result.fallbackReason ? ' · CPU fallback' : ''}`;
}

export function analysisBackendDetails(result) {
  return result.fallbackReason ? `CPU fallback: ${result.fallbackReason}` : result.engine;
}
