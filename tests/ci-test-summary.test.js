import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SUMMARY_CHARACTERS, MAX_SUMMARY_LINES, summarizeTestLog } from '../scripts/ci-test-summary.mjs';

test('CI summaries retain the failed assertion instead of successful-test noise', () => {
  const log = `${'✔ passes\n'.repeat(500)}ℹ tests 501\nℹ fail 1\n\n✖ failing tests:\n\ntest at tests/example.test.js:1:1\n✖ cancellation\nAssertionError: 0 !== 1\nactual: 0\nexpected: 1\n`;
  const summary = summarizeTestLog(log, { outcome: 'failure', nodeVersion: 'v24.19.0' });
  assert.match(summary, /Outcome: \*\*failure\*\* · Node v24\.19\.0/);
  assert.match(summary, /AssertionError: 0 !== 1/);
  assert.match(summary, /actual: 0\nexpected: 1/);
  assert.match(summary, /node-test-log/);
  assert.doesNotMatch(summary, /✔ passes/);
});

test('TAP failures and successful summaries preserve useful diagnostics', () => {
  const failed = summarizeTestLog('ok 1 first\nnot ok 2 second\n  ---\n  error: expected 1\n  ---', { outcome: 'failure' });
  assert.match(failed, /not ok 2 second/);
  assert.match(failed, /error: expected 1/);
  const passed = summarizeTestLog('✔ test\nℹ tests 1\nℹ pass 1\nℹ fail 0', { outcome: 'success' });
  assert.match(passed, /ℹ pass 1/);
  assert.doesNotMatch(passed, /node-test-log|truncated/);
});

test('test text cannot close the Markdown fence or insert terminal controls', () => {
  const summary = summarizeTestLog('\u001b[31m✖ failing tests:\u001b[0m\n```\n<script>unsafe</script>\n````\n\u0007',
    { outcome: 'not **trusted**', nodeVersion: 'v24\n<script>' });
  assert.match(summary, /Outcome: \*\*unknown\*\*/);
  assert.match(summary, /`````text\n/);
  assert.match(summary, /\n`````\n/);
  assert.doesNotMatch(summary, /\u001b|\u0007|Node v24\n/);
});

test('CI summaries bound both line count and long assertion text', () => {
  const manyLines = summarizeTestLog(`✖ failing tests:\n${'diagnostic\n'.repeat(MAX_SUMMARY_LINES + 50)}`, { outcome: 'failure' });
  assert.equal((manyLines.match(/diagnostic/g) ?? []).length, MAX_SUMMARY_LINES - 1);
  assert.match(manyLines, /Diagnostics were truncated/);
  const long = summarizeTestLog(`✖ failing tests:\n${'x'.repeat(MAX_SUMMARY_CHARACTERS * 2)}`);
  assert.ok(long.length < MAX_SUMMARY_CHARACTERS + 400);
  assert.match(long, /Diagnostics were truncated/);
});

test('missing logs produce a readable summary without fabricating results', () => {
  assert.match(summarizeTestLog('', { outcome: 'cancelled' }), /cancelled/);
  assert.match(summarizeTestLog(''), /No test output was captured/);
});
