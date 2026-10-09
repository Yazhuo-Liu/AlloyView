import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  formatAttributeValue, MAX_LABEL_PLACEHOLDERS, MAX_LABEL_TEMPLATE_LENGTH, MAX_TEXT_LABELS, normalizeTextLabelState, parseFormatSpec,
  parseLabelTemplate, placeholderNames, renderLabelTemplate,
} from '../src/text-labels.js';
import { contrastingText, drawTextLabelsOverlay, textLabelOrigin } from '../src/render/text-label-overlay.js';

const values = new Map([['Timestep', 1200], ['CNA.FCC.fraction', 0.93125], ['Mean.c_stress[1]', -1.23456], ['Strain.a', 0.0125], ['AtomCount', 1234567]]);
const lookup = name => values.has(name) ? { value: values.get(name) } : null;
const render = text => renderLabelTemplate(parseLabelTemplate(text), lookup);

test('templates fill placeholders with default and explicit number formats', () => {
  assert.equal(render('Timestep [Timestep] · FCC [CNA.FCC.fraction:.1%]').text, 'Timestep 1200 · FCC 93.1%');
  assert.equal(render('[CNA.FCC.fraction:%.3f] [Strain.a:+.2e] [AtomCount:,d] [Mean.c_stress[1]:.3f]').text, '0.931 +1.25e-02 1,234,567 -1.235');
  // Integers print in full; other numbers use six significant digits.
  assert.equal(render('[AtomCount] [CNA.FCC.fraction] [Strain.a]').text, '1234567 0.93125 0.0125');
  // Names are matched literally; surrounding spaces in the placeholder are ignored.
  assert.equal(render('[ Timestep : d ]').text, '1200');
  assert.deepEqual(placeholderNames('[Timestep] [Timestep:d] [[x]] [Strain.a]'), ['Timestep', 'Strain.a']);
});

test('number formats follow printf and Python conventions', () => {
  const format = (value, spec) => formatAttributeValue(value, parseFormatSpec(spec));
  assert.equal(format(3.14159, '.2f'), '3.14');
  assert.equal(format(3.14159, '%.2f'), '3.14');
  assert.equal(format(3.14159, '8.3f'), '   3.142');
  assert.equal(format(5, '05d'), '00005');
  assert.equal(format(-5, '05d'), '-0005');
  assert.equal(format(5, '+.1f'), '+5.0');
  assert.equal(format(5, ' .1f'), ' 5.0');
  assert.equal(format(12345.678, '.3e'), '1.235e+04');
  assert.equal(format(-2.5, 'E'), '-2.500000E+00');
  assert.equal(format(0.000012345, 'g'), '1.2345e-05');
  assert.equal(format(123456789, 'g'), '1.23457e+08');
  assert.equal(format(100, '.3g'), '100');
  assert.equal(format(0.5, '.0%'), '50%');
  assert.equal(format(1234567.891, ',.2f'), '1,234,567.89');
  assert.equal(format(-0.3, 'd'), '0');
  assert.equal(format(-0.0001, '.2f'), '-0.00');
  assert.equal(format(2.5, 'i'), '3');
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(format(value, '.2f'), String(value));
  assert.equal(formatAttributeValue(1e-7), '1e-07');
  assert.equal(formatAttributeValue(0.1 + 0.2), '0.3');
  for (const spec of ['', 'x', '.f', '++f', '100f', '.50f', '%%%', 'd.2', `${'0'.repeat(20)}f`]) {
    if (spec === '') assert.deepEqual(parseFormatSpec(spec), { sign: '', zero: false, group: false, width: 0, precision: null, type: 'g' });
    else assert.equal(parseFormatSpec(spec), null, spec);
  }
});

test('brackets escape, unknown names are marked and problems are reported', () => {
  assert.equal(render('[[literal]] a]]b').text, '[literal] a]b');
  const unknown = render('A [Missing.value:.2f] B [Timestep:zz] [] [unclosed');
  assert.equal(unknown.text, 'A [?Missing.value:.2f] B [?Timestep:zz] [?] [unclosed');
  assert.deepEqual(unknown.missing, ['Missing.value']);
  assert.deepEqual(unknown.invalid, ['[Timestep:zz]']);
  assert.deepEqual(unknown.problems.map(problem => problem.column), [25, 39, 42]);
  assert.match(unknown.problems[0].message, /Invalid number format “zz”/);
  assert.match(unknown.problems[2].message, /Unclosed/);
  // A bracket cannot span lines.
  assert.equal(render('[Timestep\n]').text, '[Timestep\n]');
});

test('templates are data: no member access, evaluation or unbounded output', async () => {
  const seen = [];
  const spy = name => { seen.push(name); return null; };
  const text = '[constructor] [__proto__] [prototype] [toString] [${globalThis.leak = 1}] [`x`] [alert(1)] [Timestep]';
  const result = renderLabelTemplate(parseLabelTemplate(text), spy);
  assert.equal(globalThis.leak, undefined);
  assert.equal(result.text, '[?constructor] [?__proto__] [?prototype] [?toString] [?${globalThis.leak = 1}] [?`x`] [?alert(1)] [?Timestep]');
  // Reserved object keys never reach the lookup; other names are plain strings.
  assert.deepEqual(seen, ['toString', '${globalThis.leak = 1}', '`x`', 'alert(1)', 'Timestep']);
  assert.ok(seen.every(name => typeof name === 'string'));
  const source = await readFile(new URL('../src/text-labels.js', import.meta.url), 'utf8');
  assert.equal(/\beval\s*\(|new Function|Function\s*\(/.test(source), false, 'no dynamic code');

  const long = parseLabelTemplate('x'.repeat(MAX_LABEL_TEMPLATE_LENGTH + 50));
  assert.equal(long.parts[0].value.length, MAX_LABEL_TEMPLATE_LENGTH);
  assert.match(long.problems[0].message, /limited to 1,000 characters/);
  const many = parseLabelTemplate('[Timestep]'.repeat(MAX_LABEL_PLACEHOLDERS + 3));
  assert.equal(many.parts.filter(part => part.type === 'field').length, MAX_LABEL_PLACEHOLDERS);
  assert.equal(many.problems.length, 1);
  const huge = renderLabelTemplate(parseLabelTemplate('[Big:30.20f]'.repeat(MAX_LABEL_PLACEHOLDERS)), () => ({ value: 1e20 }));
  assert.ok(huge.text.length <= 4000);
  // Overly long placeholders stay text.
  assert.equal(render(`[${'a'.repeat(400)}]`).text.startsWith('[aaa'), true);
});

test('label state validates shared configurations before copying them', () => {
  const state = normalizeTextLabelState({ labels: [{ id: 'label-1', text: 'Step [Timestep]\nFCC [CNA.FCC.fraction:.1%]', position: 'bottom-left',
    offset: [4, -8], fontSize: 22, color: '#ABCDEF', box: 'custom', boxColor: '#FF00FF', enabled: false }], selectedId: 'label-1' });
  assert.deepEqual(state, { labels: [{ id: 'label-1', enabled: false, text: 'Step [Timestep]\nFCC [CNA.FCC.fraction:.1%]', position: 'bottom-left',
    offset: [4, -8], fontSize: 22, color: '#abcdef', box: 'custom', boxColor: '#ff00ff' }], selectedId: 'label-1' });
  assert.deepEqual(normalizeTextLabelState({ labels: [{ text: 'A' }] }).labels[0], { id: 'label-1', enabled: true, text: 'A', position: 'top-right',
    offset: [0, 0], fontSize: 16, color: null, box: 'theme', boxColor: '#ffffff' });
  const invalid = [
    { labels: Array.from({ length: MAX_TEXT_LABELS + 1 }, (_, index) => ({ id: `label-${index}` })) },
    { labels: [{ text: 'x'.repeat(MAX_LABEL_TEMPLATE_LENGTH + 1) }] },
    { labels: [{ text: 'tab\there' }] },
    { labels: [{ position: 'middle' }] },
    { labels: [{ offset: [0] }] },
    { labels: [{ offset: [0, 1e9] }] },
    { labels: [{ fontSize: 1000 }] },
    { labels: [{ color: 'red' }] },
    { labels: [{ box: 'glow' }] },
    { labels: [{ id: '__proto__' }] },
    { labels: [{ id: 'a' }, { id: 'a' }] },
    { labels: [{ script: 'x' }] },
    { labels: [], selectedId: 'missing' },
    JSON.parse('{"labels":[],"__proto__":{"polluted":true}}'),
    { labels: { length: 1, 0: {} } },
  ];
  for (const value of invalid) assert.throws(() => normalizeTextLabelState(value), /Invalid AlloyView configuration: settings\.extensions\.textLabels/, JSON.stringify(value));
  assert.equal({}.polluted, undefined);
});

class RecordingContext {
  constructor() { this.calls = []; this.state = {}; }
  save() {} restore() {}
  measureText(text) { return { width: text.length * Number.parseFloat(this.font.split(' ')[1]) * 0.5 }; }
  beginPath() {} fill() { this.calls.push(['fill', this.fillStyle]); } stroke() { this.calls.push(['stroke', this.strokeStyle]); }
  roundRect(...args) { this.calls.push(['roundRect', ...args]); }
  fillText(text, x, y) { this.calls.push(['fillText', text, x, y, this.fillStyle, this.textAlign]); }
}

test('labels are placed at corners and edges with scaled margins, offsets and fonts', () => {
  assert.deepEqual(textLabelOrigin('top-left', 100, 20, 800, 600), { x: 12, y: 12, align: 'left' });
  assert.deepEqual(textLabelOrigin('bottom-right', 100, 20, 800, 600, 2, [5, -5]), { x: 800 - 24 - 100 + 10, y: 600 - 24 - 20 - 10, align: 'right' });
  assert.deepEqual(textLabelOrigin('center', 100, 20, 800, 600), { x: 350, y: 290, align: 'center' });
  assert.deepEqual(textLabelOrigin('top', 100, 20, 800, 600), { x: 350, y: 12, align: 'center' });
  assert.deepEqual(textLabelOrigin('right', 100, 20, 800, 600), { x: 688, y: 290, align: 'right' });
  const context = new RecordingContext();
  const theme = { panel: 'panel', border: 'border', title: 'title' };
  drawTextLabelsOverlay(context, [{ text: 'ab\ncd', position: 'top-right', offset: [0, 0], fontSize: 10, color: null, box: 'theme', boxColor: '#ffffff' }],
    400, 300, 2, { includeBackground: true, theme });
  // Font 20 px at scale 2: text width 20, padding 10 × 6, line height 26.
  const box = context.calls.find(call => call[0] === 'roundRect');
  assert.deepEqual(box.slice(1, 5), [400 - 24 - 40, 24, 40, 2 * 26 + 12]);
  assert.deepEqual(context.calls.filter(call => call[0] === 'fillText').map(call => call.slice(1)),
    [['ab', 400 - 24 - 10, 24 + 6 + 13, 'title', 'right'], ['cd', 400 - 24 - 10, 24 + 6 + 39, 'title', 'right']]);
  // Without a background the theme panel is omitted and text turns dark.
  const transparent = new RecordingContext();
  drawTextLabelsOverlay(transparent, [{ text: 'x', position: 'top-left', offset: [0, 0], fontSize: 10, color: null, box: 'theme', boxColor: '#ffffff' }],
    400, 300, 1, { includeBackground: false, theme });
  assert.equal(transparent.calls.some(call => call[0] === 'roundRect'), false);
  assert.equal(transparent.calls.find(call => call[0] === 'fillText')[4], '#142f3e');
  const custom = new RecordingContext();
  drawTextLabelsOverlay(custom, [{ text: 'x', position: 'top-left', offset: [0, 0], fontSize: 10, color: null, box: 'custom', boxColor: '#ff00ff' }], 400, 300, 1, { theme });
  assert.deepEqual(custom.calls.filter(call => call[0] === 'fill').map(call => call[1]), ['#ff00ff']);
  assert.equal(custom.calls.find(call => call[0] === 'fillText')[4], '#0b0b0b');
  assert.equal(contrastingText('#000080'), '#ffffff');
  assert.equal(contrastingText('#ffff00'), '#0b0b0b');
  const none = new RecordingContext();
  drawTextLabelsOverlay(none, null, 400, 300);
  drawTextLabelsOverlay(none, [{ text: '', position: 'top-left', offset: [0, 0], fontSize: 10, box: 'none' }], 400, 300);
  assert.deepEqual(none.calls, []);
});
