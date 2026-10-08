import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export const MAX_SUMMARY_CHARACTERS = 16_000;
export const MAX_SUMMARY_LINES = 180;

/** Keep assertion diagnostics readable in the public job summary, even when
 * access to the full Actions log requires signing in. Do not read environment
 * variables or include authentication/debug configuration in the summary. */
export function summarizeTestLog(log, { outcome = 'unknown', nodeVersion = process.version } = {}) {
  const clean = stripVTControlCharacters(String(log)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const status = ['success', 'failure', 'cancelled', 'skipped'].includes(outcome) ? outcome : 'unknown';
  const lines = clean.split(/\r?\n/);
  let start = lines.findLastIndex(line => /(?:✖|×) failing tests:/.test(line));
  if (start < 0) start = lines.findIndex(line => /^not ok\b/.test(line));
  if (start < 0) start = Math.max(0, lines.length - 30);
  const relevant = lines.slice(start);
  let truncated = relevant.length > MAX_SUMMARY_LINES;
  let excerpt = relevant.slice(0, MAX_SUMMARY_LINES).join('\n').trim();
  if (excerpt.length > MAX_SUMMARY_CHARACTERS) {
    excerpt = excerpt.slice(0, MAX_SUMMARY_CHARACTERS);
    truncated = true;
  }
  // A test name or assertion may contain backticks. Make the fence longer
  // than every run in the excerpt so it cannot terminate the code block.
  const longestFence = Math.max(0, ...Array.from(excerpt.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestFence + 1));
  const version = String(nodeVersion).replace(/[^0-9A-Za-z.\-]/g, '').slice(0, 40);
  return [
    '## Node tests', '', `Outcome: **${status}** · Node ${version}`, '',
    excerpt ? `${fence}text\n${excerpt}\n${fence}` : 'No test output was captured.',
    ...(truncated ? ['', 'Diagnostics were truncated.'] : []),
    ...(status === 'failure' ? ['', 'The complete output is saved in the **node-test-log** artifact.'] : []), '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let log = '';
  try { log = await readFile(process.argv[2], 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  process.stdout.write(summarizeTestLog(log, { outcome: process.argv[3] }));
}
