import test from 'node:test';
import assert from 'node:assert/strict';
import { OPENABLE_FILE, fileLink, webLink } from '../src/shared/links.js';
import { clipMarkdown } from '../src/shared/activity.js';

test('Links to files on this computer are recognized; web and app links are not files', () => {
  assert.equal(fileLink('/Users/me/report.md'), '/Users/me/report.md');
  assert.equal(fileLink('~/notes/x.md'), '~/notes/x.md');
  assert.equal(fileLink('file:///Users/me/%EA%B2%80%EC%88%98.md'), '/Users/me/검수.md');
  assert.equal(fileLink('file:///C:/work/a.md'), 'C:/work/a.md');
  assert.equal(fileLink('C:\\work\\a.md'), 'C:\\work\\a.md');
  for (const no of [
    'https://example.com/a.md',
    '//evil.example/x',
    'file://server/share/x.md',
    'vscode://file/x',
    'report.md',
    './report.md',
    '',
    '/x\0y',
    undefined,
  ])
    assert.equal(fileLink(no), null, String(no));
  assert.equal(webLink('/Users/me/report.md'), null);
  assert.ok(OPENABLE_FILE.test('/a/b/report.MD'));
  for (const run of ['/Applications/X.app', '/a/run.sh', '/a/x.command', '/a/tool'])
    assert.ok(!OPENABLE_FILE.test(run), run);
});

test('A folded message never cuts a markdown link in half', () => {
  const link = '[검수 보고서](/Users/pepper/orca/workspaces/aix-monorepo-plan/reports/review.md)';
  const text = `${'가'.repeat(280)} ${link} 끝`;
  const folded = clipMarkdown(text, 300);
  assert.ok(folded.includes(link), 'the link stays whole');
  assert.ok(folded.endsWith('…'));
  // Short text is left as it is; lines are capped.
  assert.equal(clipMarkdown('짧아요', 300), '짧아요');
  assert.equal(clipMarkdown('a\nb\nc', 300, 2), 'a\nb…');
  // A link far too long for a fold is left for the expanded view rather than cut.
  const huge = `${'가'.repeat(290)} [x](/${'p'.repeat(700)})`;
  assert.ok(!clipMarkdown(huge, 300).includes('[x]('));
});
