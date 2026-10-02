const MEBIBYTE = 1024 ** 2;
const GIBIBYTE = 1024 ** 3;

export function estimateFrameBytes(frame) {
  const buffers = new Set();
  const include = (value) => {
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  };
  include(frame.ids);
  include(frame.types);
  include(frame.positions);
  include(frame.fractional);
  include(frame.unwrappedPositions);
  include(frame.imageFlags);
  include(frame.cell?.origin);
  include(frame.cell?.vectors);
  for (const property of frame.properties ?? []) include(property.data);
  for (const property of frame.analysisOriginalProperties?.values() ?? []) include(property.data);
  for (const value of Object.values(frame.ptm ?? {})) include(value);
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
}

export function chooseFrameCachePolicy(frame, frameCount, environment = {}) {
  const count = Math.max(1, Math.trunc(frameCount));
  const estimatedFrameBytes = Math.max(1, Math.ceil(estimateFrameBytes(frame) * 1.35));
  const heapLimit = finitePositive(environment.heapLimit);
  const heapUsed = finitePositive(environment.heapUsed);
  const deviceMemoryGiB = finitePositive(environment.deviceMemoryGiB);
  const budgets = [512 * MEBIBYTE];
  if (heapLimit) budgets.push(heapLimit * 0.22);
  if (heapLimit && heapUsed && heapUsed < heapLimit) budgets.push((heapLimit - heapUsed) * 0.40);
  if (deviceMemoryGiB) budgets.push(deviceMemoryGiB * GIBIBYTE * 0.12);
  const budgetBytes = Math.max(estimatedFrameBytes, Math.floor(Math.min(...budgets)));
  const minimum = Math.min(count, 3);
  const capacity = Math.max(minimum, Math.floor(budgetBytes / estimatedFrameBytes));
  const limit = Math.min(count, capacity);
  return {
    limit,
    fullTrajectory: limit === count,
    estimatedFrameBytes,
    budgetBytes,
  };
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
