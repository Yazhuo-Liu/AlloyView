import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coupleSliderPositions, createLegendRangeSlider, legendSliderDomain, legendSliderPosition, legendSliderValue,
} from '../src/render/legend-range-slider.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); this.style = {}; this.dataset = {}; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
}
const root = { createElement: tag => new Element(tag) };

test('slider ends reproduce the exact data limits and interior positions are rounded steps', () => {
  const domain = legendSliderDomain([3.24001, 20.007, 3.24001, 20.007], 0.1);
  assert.equal(legendSliderValue(domain, 0), 3.24001);
  assert.equal(legendSliderValue(domain, domain.positions), 20.007);
  assert.deepEqual([1, 2, 3].map(position => legendSliderValue(domain, position)), [3.3, 3.4, 3.5], 'no binary rounding noise');
  assert.equal(legendSliderValue(domain, domain.positions - 1), 20);
  for (let position = 1; position <= domain.positions; position++) {
    assert.ok(legendSliderValue(domain, position) > legendSliderValue(domain, position - 1), 'values increase strictly');
  }
  assert.equal(legendSliderPosition(domain, 3.24001), 0);
  assert.equal(legendSliderPosition(domain, 20.007), domain.positions);
  assert.equal(legendSliderValue(domain, legendSliderPosition(domain, 7.31)), 7.3, 'typed values snap to the nearest position');
  const exact = legendSliderDomain([0.3, 0.7], 0.1);
  assert.deepEqual(Array.from({ length: exact.positions + 1 }, (_, position) => legendSliderValue(exact, position)), [0.3, 0.4, 0.5, 0.6, 0.7],
    'limits on the step grid do not repeat an end value');
});

test('slider domains cover typed limits, integers and degenerate ranges', () => {
  const integers = legendSliderDomain([10, 12, 10, 12], 1);
  assert.deepEqual(Array.from({ length: integers.positions + 1 }, (_, position) => legendSliderValue(integers, position)), [10, 11, 12]);
  const typed = legendSliderDomain([3, 20, -5, 20], 0.1);
  assert.equal(legendSliderValue(typed, 0), -5, 'a limit below the data widens the track');
  const wide = legendSliderDomain([3, 20, 0, 1e9], 0.1);
  assert.equal(wide.positions, 2000, 'a far limit coarsens the step instead of adding millions of positions');
  assert.equal(legendSliderValue(wide, wide.positions), 1e9);
  const constant = legendSliderDomain([5.5, 5.5], 0.01);
  assert.equal(constant.positions, 1);
  assert.equal(legendSliderValue(constant, 1), 5.51);
  assert.equal(legendSliderDomain([null, null, NaN], 1), null);
});

test('a moved thumb pushes the other one and stops one position before a slider end', () => {
  assert.deepEqual(coupleSliderPositions(3, 8, 'minimum', 10), { minimum: 3, maximum: 8 });
  assert.deepEqual(coupleSliderPositions(8, 8, 'minimum', 10), { minimum: 8, maximum: 9 });
  assert.deepEqual(coupleSliderPositions(10, 10, 'minimum', 10), { minimum: 9, maximum: 10 });
  assert.deepEqual(coupleSliderPositions(5, 4, 'maximum', 10), { minimum: 3, maximum: 4 });
  assert.deepEqual(coupleSliderPositions(0, 0, 'maximum', 10), { minimum: 0, maximum: 1 });
});

test('the two-thumb slider reports pushed limits and follows typed limits', () => {
  const reports = [];
  const slider = createLegendRangeSlider(root, { minimum: 0, maximum: 10, dataMinimum: 0, dataMaximum: 10, step: 1,
    format: value => `${value} u`, onInput: (limits, changed) => reports.push([limits, changed]) });
  const { minimum, maximum } = slider.inputs;
  assert.equal(minimum.type, 'range'); assert.equal(minimum.max, '10'); assert.equal(maximum.value, '10');
  assert.equal(minimum.attributes['aria-label'], 'Minimum color limit');
  const fill = slider.element.children[0].children[0];
  maximum.value = '4'; maximum.dispatch('input');
  assert.deepEqual(reports.at(-1), [{ minimum: 0, maximum: 4 }, 'maximum']);
  assert.equal(fill.style.left, '0%'); assert.equal(fill.style.right, '60%');
  minimum.value = '7'; minimum.dispatch('input');
  assert.deepEqual(reports.at(-1), [{ minimum: 7, maximum: 8 }, 'minimum'], 'the minimum pushes the maximum');
  assert.equal(maximum.value, '8'); assert.equal(maximum.attributes['aria-valuetext'], '8 u');
  assert.equal(minimum.style.zIndex, '2', 'the lower thumb stays reachable near the right end');
  slider.set({ minimum: -10, maximum: 5 });
  assert.equal(minimum.max, '20', 'a typed limit outside the data widens the track');
  assert.equal(minimum.value, '0'); assert.equal(maximum.value, '15');
  assert.equal(reports.length, 2, 'typed limits are not reported back');
});

test('range edits commit their latest limits on release, cancellation, lost capture, blur and keyboard completion', () => {
  for (const event of ['change', 'pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'keyup']) {
    const commits = [];
    const slider = createLegendRangeSlider(root, { minimum: 0, maximum: 10, dataMinimum: 0, dataMaximum: 10, step: 1,
      onCommit: limits => commits.push(limits) });
    slider.inputs.minimum.value = '2'; slider.inputs.minimum.dispatch('input');
    slider.inputs.minimum.value = '3'; slider.inputs.minimum.dispatch('input');
    assert.equal(commits.length, 0, `${event} retains the preview during editing`);
    slider.inputs.minimum.dispatch(event); slider.inputs.minimum.dispatch('change');
    assert.deepEqual(commits, [{ minimum: 3, maximum: 10 }], `${event} commits once`);
  }
});
