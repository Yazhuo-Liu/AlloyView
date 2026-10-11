/** Only controlled analysis replies may reuse a Worker. Native traps and
 * broken transport are not scientific input errors and retire its resources. */
export function fatalAnalysisError(error) {
  if (error?.fatal === true) return true;
  if (error?.analysisErrorKind === 'validation') return false;
  return error?.name === 'RuntimeError'
    || error?.name === 'DataCloneError' || error instanceof TypeError
    || error instanceof ReferenceError || error instanceof SyntaxError;
}

export function analysisValidationError(error) {
  if (!(error instanceof Error)) error = new Error(String(error));
  error.analysisErrorKind = 'validation';
  return error;
}

export function isAnalysisValidationError(error) {
  return error?.analysisErrorKind === 'validation';
}

/** Tag a known input validator without confusing a backend numeric/memory
 * limitation or cancellation with invalid scientific input. */
export function validateAnalysisInput(validate) {
  try { return validate(); }
  catch (error) {
    if (error?.name === 'GpuUnavailableError' || error?.name === 'AbortError' || error instanceof RangeError) throw error;
    throw analysisValidationError(error);
  }
}

export function analysisReplyError(data) {
  const error = new Error(data.error || 'Analysis failed.');
  error.name = data.name || 'Error';
  error.analysisErrorKind = data.errorKind;
  // Missing classification from an older or damaged Worker is not a positive
  // acknowledgement that its Wasm and input caches are safe to reuse.
  error.fatal = data.fatal !== false;
  return error;
}
