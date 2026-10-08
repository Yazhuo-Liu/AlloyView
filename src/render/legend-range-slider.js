// Interior slider positions sit on multiples of the step; very wide domains
// (for example a typed limit far outside the data) use a coarser multiple.
const MAXIMUM_SLIDER_POSITIONS = 2000;

/** Slider positions spanning the given values. Position 0 and `positions`
 * are exactly the lowest and highest value, so the ends reproduce the data
 * limits; positions in between are rounded multiples of the step. */
export function legendSliderDomain(values, step) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  const lower = Math.min(...finite);
  let upper = Math.max(...finite);
  const base = step > 0 ? step : Math.max(Math.abs(lower) * Number.EPSILON * 2, Number.MIN_VALUE);
  if (!(upper > lower)) upper = lower + base;
  const increment = base * Math.max(1, Math.ceil((upper - lower) / base / MAXIMUM_SLIDER_POSITIONS));
  // The tolerance keeps 0.3 / 0.1 = 2.9999999999999996 from adding a
  // position that repeats an exact end value.
  const origin = Math.floor(lower / increment + 1e-9) * increment;
  return { lower, upper, origin, increment, positions: Math.max(1, Math.ceil((upper - origin) / increment - 1e-9)) };
}

export function legendSliderValue(domain, position) {
  if (position <= 0) return domain.lower;
  if (position >= domain.positions) return domain.upper;
  const value = domain.origin + position * domain.increment;
  // Drop binary rounding noise (0.30000000000000004) without merging steps.
  const rounded = Number(value.toPrecision(12));
  return Math.abs(rounded - value) <= domain.increment * 1e-6 ? rounded : value;
}

export function legendSliderPosition(domain, value) {
  if (value <= domain.lower) return 0;
  if (value >= domain.upper) return domain.positions;
  return Math.max(0, Math.min(domain.positions, Math.round((value - domain.origin) / domain.increment)));
}

/** Keep the thumbs strictly ordered. The moved thumb pushes the other one,
 * as the Min/Max fields do; at a slider end it stops one position short. */
export function coupleSliderPositions(minimum, maximum, changed, positions) {
  if (minimum < maximum) return { minimum, maximum };
  if (changed === 'minimum') {
    maximum = Math.min(positions, minimum + 1);
    return { minimum: maximum - 1, maximum };
  }
  minimum = Math.max(0, maximum - 1);
  return { minimum, maximum: minimum + 1 };
}

/** Two thumbs on one track for the scalar color limits. The track spans the
 * data range and any typed limit outside it. `onInput` receives the dragged
 * limits; `set` follows limits typed into the number fields. */
export function createLegendRangeSlider(root, { minimum, maximum, dataMinimum, dataMaximum, step, format = String, onInput, onCommit }) {
  const element = root.createElement('div');
  element.className = 'legend-slider';
  const track = root.createElement('span'), fill = root.createElement('span');
  track.className = 'legend-slider-track'; fill.className = 'legend-slider-fill';
  track.append(fill);
  const inputs = {};
  for (const [name, text] of [['minimum', 'Minimum'], ['maximum', 'Maximum']]) {
    const input = root.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.step = '1';
    input.dataset.limit = name;
    input.setAttribute('aria-label', `${text} color limit`);
    input.addEventListener('input', () => move(name));
    // Native change covers mouse, touch and keyboard range editing. Capture
    // release/cancellation too: a lost pointer or focus must never leave the
    // temporary shader palette active. Commit is idempotent between inputs.
    for (const event of ['change', 'pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'keyup']) {
      input.addEventListener(event, () => commit(name));
    }
    inputs[name] = input;
  }
  element.append(track, inputs.minimum, inputs.maximum);
  let domain = null;
  let dirty = false, currentLimits = { minimum, maximum };

  function show(lowerPosition, upperPosition, limits) {
    inputs.minimum.value = String(lowerPosition);
    inputs.maximum.value = String(upperPosition);
    inputs.minimum.setAttribute('aria-valuetext', format(limits.minimum));
    inputs.maximum.setAttribute('aria-valuetext', format(limits.maximum));
    const from = lowerPosition / domain.positions, to = upperPosition / domain.positions;
    fill.style.left = `${from * 100}%`;
    fill.style.right = `${(1 - to) * 100}%`;
    // Thumbs pushed together at the right end stay reachable: the lower one
    // goes on top once it is past the middle.
    inputs.minimum.style.zIndex = from > 0.5 ? '2' : '1';
    inputs.maximum.style.zIndex = from > 0.5 ? '1' : '2';
  }

  function set(limits) {
    domain = legendSliderDomain([dataMinimum, dataMaximum, limits.minimum, limits.maximum], step);
    element.hidden = !domain;
    if (!domain) return;
    for (const input of Object.values(inputs)) input.max = String(domain.positions);
    show(legendSliderPosition(domain, limits.minimum), legendSliderPosition(domain, limits.maximum), limits);
  }

  function move(changed) {
    if (!domain) return;
    const { minimum: lowerPosition, maximum: upperPosition } = coupleSliderPositions(
      Number(inputs.minimum.value), Number(inputs.maximum.value), changed, domain.positions);
    const limits = { minimum: legendSliderValue(domain, lowerPosition), maximum: legendSliderValue(domain, upperPosition) };
    // The track keeps its scale while dragging, so a thumb stays under the pointer.
    show(lowerPosition, upperPosition, limits);
    currentLimits = limits;
    dirty = true;
    onInput?.(limits, changed);
  }

  function commit(changed) {
    if (!dirty) return;
    dirty = false;
    onCommit?.(currentLimits, changed);
  }

  set({ minimum, maximum });
  return { element, inputs, set };
}
