import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRecords } from '../server/adapters/normalize.js';
import { mergeSessions } from '../server/adapters/merge.js';
import { mentionedFiles, outputFile } from '../server/adapters/outputs.js';
import { OfficeStore } from '../server/store.js';
import { OutputLog, readPreview } from '../server/outputs.js';
import { OfficeService } from '../server/service.js';
import { claudeArtifactLink, groupOutputs, refreshed } from '../src/shared/outputs.js';
import type { OutputCandidate, Session, SessionOutput } from '../src/shared/types.js';

const now = Date.parse('2026-11-09T00:00:00Z');
const at = (offset: number) => new Date(now + offset).toISOString();
const cwd = '/work/app';
let uuid = 0;
/** One Claude record line. */
function claude(role: 'assistant' | 'user', content: unknown[], offset: number, extra = {}) {
  return {
    type: role,
    uuid: `u${++uuid}`,
    timestamp: at(offset),
    sessionId: 'claude-one',
    cwd,
    message: { role, content },
    ...extra,
  };
}
const write = (id: string, file: string, offset: number) =>
  claude(
    'assistant',
    [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content: '# x' } }],
    offset,
  );
const result = (id: string, text: string, offset: number, extra = {}, error = false) =>
  claude(
    'user',
    [{ type: 'tool_result', tool_use_id: id, content: text, ...(error ? { is_error: true } : {}) }],
    offset,
    extra,
  );
const say = (text: string, offset: number) =>
  claude('assistant', [{ type: 'text', text }], offset, {});
const claudeOpts = {
  provider: 'claude' as const,
  sourcePath: '/claude/projects/app/claude-one.jsonl',
  mtime: now,
  now: now + 60_000,
};
const keys = (s: Session) => (s.outputs ?? []).map((o) => [o.key, o.via]);

test('Claude Write counts only files it created: an update, a failure or no result is not one', () => {
  const s = parseRecords(
    [
      write('a', '/work/app/docs/report.md', 0),
      result('a', 'File created successfully at: /work/app/docs/report.md', 1, {
        toolUseResult: { type: 'create', filePath: '/work/app/docs/report.md' },
      }),
      write('b', '/work/app/README.md', 2),
      result('b', 'The file /work/app/README.md has been updated successfully.', 3, {
        toolUseResult: { type: 'update', filePath: '/work/app/README.md' },
      }),
      write('c', '/work/app/denied.md', 4),
      result('c', "The user doesn't want to proceed with this tool use.", 5, {}, true),
      write('d', '/work/app/pending.md', 6),
      // Recorded as created by the structured result alone (text in another shape).
      write('e', '/work/app/summary.html', 7),
      result('e', 'ok', 8, {
        toolUseResult: { type: 'create', filePath: '/work/app/summary.html' },
      }),
      // A later update of a file it created keeps it an output.
      write('f', '/work/app/docs/report.md', 9),
      result('f', 'The file /work/app/docs/report.md has been updated successfully.', 10),
    ],
    claudeOpts,
  );
  assert.deepEqual(keys(s), [
    ['/work/app/docs/report.md', 'write'],
    ['/work/app/summary.html', 'write'],
  ]);
  assert.equal(s.outputs![0].at, now + 1);
});

test('Code, config, hidden and build folders never count; a hidden worktree folder itself does', () => {
  assert.equal(outputFile('/work/app/src/index.ts', cwd), null);
  assert.equal(outputFile('/work/app/package.json', cwd), null);
  assert.equal(outputFile('/work/app/tsconfig.base.json', cwd), null);
  assert.equal(outputFile('/work/app/reports/metrics.json', cwd), '/work/app/reports/metrics.json');
  for (const dir of [
    'node_modules/x',
    '.git',
    'test-results',
    'playwright-report',
    'coverage',
    'dist',
    'build',
    '.local/shots',
    '.cache',
  ])
    assert.equal(outputFile(`/work/app/${dir}/page.png`, cwd), null, dir);
  assert.equal(outputFile('/work/app/.notes.md', cwd), null);
  assert.equal(outputFile('/home/me/.claude/plans/plan.md', cwd, '/home/me'), null);
  assert.equal(outputFile('~/Desktop/a.pdf', cwd, '/home/me'), '/home/me/Desktop/a.pdf');
  assert.equal(outputFile('docs/a.md', cwd), '/work/app/docs/a.md');
  assert.equal(outputFile('docs/a.md', null), null);
  assert.equal(outputFile('//server/share/a.md', cwd), null);
  // A session working in a hidden worktree folder still makes outputs inside it.
  const tree = '/repo/.claude/worktrees/agent-1';
  assert.equal(outputFile(`${tree}/docs/a.md`, tree), `${tree}/docs/a.md`);
  assert.equal(outputFile(`${tree}/.local/a.md`, tree), null);
  for (const ext of [
    'md',
    'markdown',
    'html',
    'htm',
    'pdf',
    'csv',
    'tsv',
    'xlsx',
    'docx',
    'pptx',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'svg',
    'webp',
    'json',
  ])
    assert.ok(outputFile(`/work/app/out/file.${ext.toUpperCase()}`, cwd), ext);
  for (const ext of ['ts', 'tsx', 'js', 'py', 'sh', 'css', 'txt', 'yaml', 'sql'])
    assert.equal(outputFile(`/work/app/out/file.${ext}`, cwd), null, ext);
});

test('Claude Write outside the allow-list or into excluded folders is left out', () => {
  const s = parseRecords(
    [
      write('a', '/work/app/src/new.ts', 0),
      result('a', 'File created successfully at: /work/app/src/new.ts', 1),
      write('b', '/work/app/test-results/shot.png', 2),
      result('b', 'File created successfully at: /work/app/test-results/shot.png', 3),
      write('c', '/work/app/node_modules/pkg/README.md', 4),
      result('c', 'File created successfully at: /work/app/node_modules/pkg/README.md', 5),
    ],
    claudeOpts,
  );
  assert.equal(s.outputs, undefined);
});

const codex = (type: string, payload: any, offset: number) => ({
  type,
  payload,
  timestamp: at(offset),
});
const codexOpts = {
  provider: 'codex' as const,
  sourcePath: '/codex/rollout.jsonl',
  mtime: now,
  now: now + 60_000,
};
const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

test('Codex apply_patch counts added files of patches that went in, not updates or failures', () => {
  const s = parseRecords(
    [
      codex('session_meta', { id: 'codex-one', cwd }, 0),
      codex('turn_context', { cwd }, 1),
      codex(
        'response_item',
        {
          type: 'function_call',
          name: 'apply_patch',
          call_id: 'p1',
          arguments: JSON.stringify({
            input: patch(
              '*** Add File: docs/plan.md',
              '+# Plan',
              '*** Update File: src/a.ts',
              '@@',
              '-x',
              '+y',
            ),
          }),
        },
        2,
      ),
      codex(
        'response_item',
        {
          type: 'function_call_output',
          call_id: 'p1',
          output: JSON.stringify({
            output: 'Success. Updated the following files:\nA docs/plan.md\nM src/a.ts\n',
            metadata: { exit_code: 0 },
          }),
        },
        3,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'p2',
          input: patch('*** Add File: /work/app/out/chart.svg', '+<svg/>'),
        },
        4,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call_output',
          call_id: 'p2',
          output: 'Success. Updated the following files:\nA /work/app/out/chart.svg',
        },
        5,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'p3',
          input: patch('*** Add File: docs/failed.md', '+x'),
        },
        6,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call_output',
          call_id: 'p3',
          output: 'apply_patch verification failed: docs/failed.md already exists',
        },
        7,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'p4',
          input: patch('*** Update File: docs/edited.md', '@@', '-a', '+b'),
        },
        8,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call_output',
          call_id: 'p4',
          output: 'Success. Updated the following files:\nM docs/edited.md',
        },
        9,
      ),
      // Codex's own report of an applied patch, when the rollout keeps it.
      codex(
        'event_msg',
        {
          type: 'patch_apply_end',
          call_id: 'p5',
          success: true,
          changes: {
            '/work/app/out/table.csv': { type: 'add', content: 'a,b' },
            '/work/app/out/old.csv': { type: 'update', unified_diff: '' },
          },
        },
        10,
      ),
      codex(
        'event_msg',
        {
          type: 'patch_apply_end',
          call_id: 'p6',
          success: false,
          changes: { '/work/app/out/nope.csv': { type: 'add', content: '' } },
        },
        11,
      ),
    ],
    codexOpts,
  );
  assert.deepEqual(keys(s), [
    ['/work/app/docs/plan.md', 'patch'],
    ['/work/app/out/chart.svg', 'patch'],
    ['/work/app/out/table.csv', 'patch'],
  ]);
});

test('Code-mode literal patches count their added files only on a clear success report', () => {
  const code = (body: string) =>
    `const r = await tools.apply_patch(${JSON.stringify(body)});\ntext(r);`;
  const s = parseRecords(
    [
      codex('session_meta', { id: 'codex-exec', cwd }, 0),
      codex('turn_context', { cwd }, 1),
      // Added and reported: counts (relative path as written, resolved from cwd).
      codex(
        'response_item',
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'e1',
          input: code(
            patch(
              '*** Add File: docs/brief.md',
              '+# Brief',
              '*** Update File: src/a.ts',
              '@@',
              '-a',
              '+b',
            ),
          ),
        },
        2,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call_output',
          call_id: 'e1',
          output: 'Success. Updated the following files:\nA docs/brief.md\nM src/a.ts\n',
        },
        3,
      ),
      // functions.exec with JSON arguments, the result naming the absolute path.
      codex(
        'response_item',
        {
          type: 'function_call',
          name: 'functions.exec',
          call_id: 'e2',
          arguments: JSON.stringify({
            code: code(patch('*** Add File: /work/app/out/data.csv', '+a,b')),
          }),
        },
        4,
      ),
      codex(
        'response_item',
        {
          type: 'function_call_output',
          call_id: 'e2',
          output: JSON.stringify({
            output: 'Success. Updated the following files:\nA /work/app/out/data.csv',
            metadata: { exit_code: 0 },
          }),
        },
        5,
      ),
      // The script ran (exit 0) but says nothing of the patch: not counted.
      codex(
        'response_item',
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'e3',
          input: code(patch('*** Add File: docs/quiet.md', '+x')),
        },
        6,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call_output',
          call_id: 'e3',
          output: JSON.stringify({ output: 'done', metadata: { exit_code: 0 } }),
        },
        7,
      ),
      // A failed patch: not counted.
      codex(
        'response_item',
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'e4',
          input: code(patch('*** Add File: docs/failed.md', '+x')),
        },
        8,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call_output',
          call_id: 'e4',
          output: 'Error: apply_patch verification failed',
        },
        9,
      ),
      // Success for another file only: this one is not listed as added.
      codex(
        'response_item',
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'e5',
          input: code(patch('*** Add File: docs/other.md', '+x')),
        },
        10,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call_output',
          call_id: 'e5',
          output: 'Success. Updated the following files:\nM docs/other.md',
        },
        11,
      ),
      // A patch built at run time, or under a condition: never read.
      codex(
        'response_item',
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'e6',
          input:
            'const p = "*** Add File: docs/dyn.md"; if (ok) await tools.apply_patch(`*** Begin Patch\\n*** Add File: docs/cond.md\\n+x\\n*** End Patch`); await tools.apply_patch(p);',
        },
        12,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call_output',
          call_id: 'e6',
          output: 'Success. Updated the following files:\nA docs/cond.md\nA docs/dyn.md',
        },
        13,
      ),
    ],
    codexOpts,
  );
  assert.deepEqual(keys(s), [
    ['/work/app/docs/brief.md', 'patch'],
    ['/work/app/out/data.csv', 'patch'],
  ]);
});

test('Markdown links to Windows drive paths are mentions; relative ones and shares are not', () => {
  assert.deepEqual(
    mentionedFiles(
      '[report](C:/work/reports/report.md) [b](C:\\work\\b.md) [rel](reports/x.md) [share](\\\\srv\\s\\y.md)',
    ),
    ['C:/work/reports/report.md', 'C:\\work\\b.md'],
  );
});

test('Replies point to files with open and markdown links; Artifact links come with their title', () => {
  assert.deepEqual(
    mentionedFiles(
      [
        '결과: `open /work/app/out/report.html` 로 확인하세요.',
        'open -a "Google Chrome" "/work/app/out/my page.html" /work/app/out/b.md.',
        '$ open ~/Desktop/summary.pdf',
        '[보고서](/work/app/out/%EB%B3%B4%EA%B3%A0.md) 그리고 [x](file:///work/app/out/c.png)',
        'reopen /work/app/not-this.md · open relative/a.md',
        '/work/app/out/d.md를 open /work/app/out/e.md를 보세요',
      ].join('\n'),
    ),
    [
      '/work/app/out/report.html',
      '/work/app/out/my page.html',
      '/work/app/out/b.md',
      '~/Desktop/summary.pdf',
      '/work/app/out/e.md',
      '/work/app/out/보고.md',
      '/work/app/out/c.png',
    ],
  );
  const s = parseRecords(
    [
      say(
        '완료했어요. `open /work/app/out/report.html`\n[분기 보고서](https://claude.ai/code/artifact/0f6c1e2a-1111-4222-8333-944455556666) · https://claude.ai/artifact/abc123def',
        0,
      ),
      write('w', '/work/app/out/report.html', 1),
      result('w', 'File created successfully at: /work/app/out/report.html', 2),
    ],
    claudeOpts,
  );
  assert.deepEqual(
    (s.outputs ?? []).map((o) => [o.key, o.via, o.title]),
    [
      [
        'https://claude.ai/code/artifact/0f6c1e2a-1111-4222-8333-944455556666',
        'artifact',
        '분기 보고서',
      ],
      ['https://claude.ai/artifact/abc123def', 'artifact', undefined],
      // Made with its tool after being named: the tool's word wins.
      ['/work/app/out/report.html', 'write', undefined],
    ],
  );
  assert.equal(
    claudeArtifactLink('https://claude.ai/code/artifact/abc123def'),
    'https://claude.ai/code/artifact/abc123def',
  );
  assert.equal(claudeArtifactLink('https://claude.ai.evil.com/artifact/abc123def'), null);
  assert.equal(claudeArtifactLink('https://claude.ai/chat/abc123def'), null);
  assert.equal(claudeArtifactLink('javascript:alert(1)'), null);
});

test('Transport fragments of one conversation keep every output once', () => {
  const first = parseRecords(
    [
      write('a', '/work/app/a.md', 0),
      result('a', 'File created successfully at: /work/app/a.md', 1),
    ],
    claudeOpts,
  );
  const second = parseRecords(
    [
      say('see open /work/app/a.md', 5),
      write('b', '/work/app/b.md', 6),
      result('b', 'File created successfully at: /work/app/b.md', 7),
    ],
    { ...claudeOpts, sourcePath: '/claude/projects/app/claude-one-2.jsonl' },
  );
  const [merged] = mergeSessions([first, second]);
  assert.deepEqual(keys(merged), [
    ['/work/app/a.md', 'write'],
    ['/work/app/b.md', 'write'],
  ]);
});

async function withStore(fn: (s: OfficeStore, dir: string) => Promise<void> | void) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-outputs-'));
  const store = new OfficeStore(path.join(dir, 'data'));
  try {
    await fn(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function made(id: string, project: string, outputs: OutputCandidate[], startedAt = now): Session {
  const s = parseRecords(
    [
      { type: 'session_meta', timestamp: at(0), payload: { id, cwd: `/work/${project}` } },
      codex(
        'response_item',
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make a report' }] },
        1,
      ),
    ],
    { ...codexOpts, sourcePath: `/codex/${id}.jsonl` },
  );
  return { ...s, startedAt, outputs, revision: `${s.revision}:${outputs.length}` };
}
const file = (
  key: string,
  offset: number,
  via: OutputCandidate['via'] = 'write',
): OutputCandidate => ({ key, kind: 'file', at: now + offset, via });

test('The store keeps outputs across windows, pages them newest first and hides what settings hide', () =>
  withStore((s) => {
    s.upsert(
      [made('one', 'app', [file('/work/app/a.md', 1), file('/work/app/b.pdf', 2)])],
      'codex',
    );
    // A later window no longer names a.md: it is kept.
    s.upsert([made('one', 'app', [file('/work/app/c.csv', 3)])], 'codex');
    s.upsert([made('two', 'site', [file('/work/site/index.html', 4)])], 'codex');
    const stamp = s.outputStamp();
    const page = s.outputs({ limit: 2 });
    assert.deepEqual(
      page.outputs.map((o) => o.name),
      ['index.html', 'c.csv'],
    );
    assert.equal(page.total, 4);
    assert.equal(page.more, true);
    const last = page.outputs.at(-1)!;
    const next = s.outputs({ before: { createdAt: last.createdAt, id: last.id } });
    assert.deepEqual(
      next.outputs.map((o) => o.name),
      ['b.pdf', 'a.md'],
    );
    assert.equal(next.more, false);
    assert.deepEqual(
      s.outputs({ sessionIds: ['codex:one'] }).outputs.map((o) => o.name),
      ['c.csv', 'b.pdf', 'a.md'],
    );
    assert.deepEqual(
      s.outputs({ text: 'SITE' }).outputs.map((o) => o.name),
      ['index.html'],
    );
    const shown = s.outputs().outputs[0];
    assert.equal(shown.dir, '/work/site');
    assert.equal(shown.ext, 'html');
    assert.equal(shown.exists, false);
    assert.equal(shown.source.project, 'site');
    assert.equal(shown.source.provider, 'codex');
    // The same outputs again: nothing new, the stamp stays.
    s.upsert([made('two', 'site', [file('/work/site/index.html', 4)])], 'codex');
    assert.equal(s.outputStamp(), stamp);
    s.preferences({ excludedProjects: ['site'] });
    assert.deepEqual(
      s.outputs().outputs.map((o) => o.name),
      ['c.csv', 'b.pdf', 'a.md'],
    );
    assert.equal(s.outputTarget(shown.id), null);
    s.preferences({ excludedProjects: [], enabledProviders: ['claude'] });
    assert.equal(s.outputs().total, 0);
  }));

test('Shown paths are redacted; the real one stays for the desktop only', () =>
  withStore((s) => {
    const token = 'ghp_' + 'a'.repeat(30);
    s.upsert([made('one', 'app', [file(`/work/app/${token}/notes.md`, 1)])], 'codex');
    const [o] = s.outputs().outputs;
    assert.ok(!o.path.includes(token));
    assert.ok(!o.dir.includes(token));
    assert.equal(s.outputTarget(o.id)!.key, `/work/app/${token}/notes.md`);
    assert.equal(s.outputTarget('not-recorded'), null);
  }));

test('A mentioned file counts only when it was born during the conversation', () =>
  withStore((s) => {
    const births = new Map<string, number | null>([
      ['/work/app/new.md', now + 30_000],
      ['/work/app/old.md', now - 86_400_000],
      ['/work/app/later.md', null],
    ]);
    let stats = 0;
    s.outputLog = new OutputLog(s.db, (f) => {
      stats++;
      return births.get(f) ?? null;
    });
    const mentions = [
      file('/work/app/new.md', 60_000, 'mention'),
      file('/work/app/old.md', 60_000, 'mention'),
      file('/work/app/later.md', 60_000, 'mention'),
    ];
    s.upsert([made('one', 'app', mentions)], 'codex');
    assert.deepEqual(
      s.outputs().outputs.map((o) => [o.name, o.via, o.createdAt]),
      [['new.md', 'mention', now + 30_000]],
    );
    // Asked again: the old one is remembered as no output, the missing one is checked again.
    stats = 0;
    births.set('/work/app/later.md', now + 50_000);
    s.upsert(
      [made('one', 'app', [...mentions, file('/work/app/x.md', 70_000, 'mention')])],
      'codex',
    );
    assert.equal(stats, 2);
    assert.deepEqual(
      s.outputs().outputs.map((o) => o.name),
      ['later.md', 'new.md'],
    );
  }));

test('A mentioned file that appears later is found without its session changing', () =>
  withStore((s) => {
    const births = new Map<string, number | null>([['/work/app/soon.md', null]]);
    let stats = 0;
    s.outputLog = new OutputLog(s.db, (f) => {
      stats++;
      return births.get(f) ?? null;
    });
    const session = made('one', 'app', [file('/work/app/soon.md', 60_000, 'mention')]);
    s.upsert([session], 'codex');
    assert.equal(s.outputs().total, 0);
    assert.equal(s.outputLog.unresolvedCount(), 1);
    // The same session again (unchanged: no parse, no record) — the waiting mention is retried.
    births.set('/work/app/soon.md', now + 90_000);
    const stamp = s.outputStamp();
    s.upsert([session], 'codex');
    assert.deepEqual(
      s.outputs().outputs.map((o) => [o.name, o.createdAt]),
      [['soon.md', now + 90_000]],
    );
    assert.notEqual(s.outputStamp(), stamp);
    assert.equal(s.outputLog.unresolvedCount(), 0);
    // Retries are rate-limited and end: at most every 15 s, for 30 minutes after first named.
    const log = new OutputLog(s.db, (f) => {
      stats++;
      return births.get(f) ?? null;
    });
    births.set('/work/app/never.md', null);
    log.record(made('two', 'app', [file('/work/app/never.md', 60_000, 'mention')]), now);
    stats = 0;
    assert.equal(log.retry(now), false);
    assert.equal(log.retry(now + 1000), false);
    assert.equal(stats, 1);
    assert.equal(log.unresolvedCount(), 1);
    log.retry(now + 31 * 60_000);
    assert.equal(log.unresolvedCount(), 0);
    assert.equal(stats, 1);
  }));

test('Outputs the hot path saw are recorded even when the record window moved on', () =>
  withStore((s) => {
    const first = made('one', 'app', []);
    s.upsert([first], 'codex');
    // The hot path parses a window that names a new file; stored rows never carry candidates.
    s.stage([{ ...made('one', 'app', [file('/work/app/hot.md', 5)]), revision: 'hot-1' }], 'codex');
    s.stage(
      [{ ...made('one', 'app', [file('/work/app/hot2.md', 6)]), revision: 'hot-2' }],
      'codex',
    );
    assert.equal(s.outputs().total, 0);
    // By the full pass the window no longer has them: the staged candidates are recorded.
    s.upsert([{ ...made('one', 'app', []), revision: 'full-3' }], 'codex');
    assert.deepEqual(
      s.outputs().outputs.map((o) => o.name),
      ['hot2.md', 'hot.md'],
    );
    // Written on close too (persistStaged).
    s.stage(
      [{ ...made('one', 'app', [file('/work/app/closing.md', 7)]), revision: 'hot-4' }],
      'codex',
    );
    s.persistStaged();
    assert.ok(s.outputs().outputs.some((o) => o.name === 'closing.md'));
  }));

test('The office RPC validates queries, never hands out unrecorded paths and reads previews on demand', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-outputs-rpc-'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  const missing = path.join(temp, 'missing');
  service.roots = { claude: missing, codex: missing, openclaw: missing };
  try {
    const out = path.join(temp, 'out');
    await mkdir(out);
    await writeFile(path.join(out, 'report.md'), '# 보고서\n\napi_key=supersecret123\n');
    await writeFile(path.join(out, 'page.html'), '<h1>hi</h1><script>alert(1)</script>');
    await writeFile(path.join(out, 'shot.png'), 'png');
    service.store.upsert(
      [
        made('one', 'app', [
          file(path.join(out, 'report.md'), 1),
          file(path.join(out, 'page.html'), 2),
          file(path.join(out, 'shot.png'), 3),
          file(path.join(out, 'gone.md'), 4),
        ]),
      ],
      'codex',
    );
    const page = (await service.call('outputs', [{ limit: 10 }])) as any;
    assert.equal(page.total, 4);
    const byName = Object.fromEntries(page.outputs.map((o: any) => [o.name, o]));
    assert.equal(byName['report.md'].exists, true);
    assert.equal(byName['gone.md'].exists, false);
    for (const bad of [
      { limit: 0 },
      { limit: 999 },
      { extra: 1 },
      { sessionIds: 'x' },
      { text: 'x'.repeat(201) },
    ])
      await assert.rejects(service.call('outputs', [bad]));
    await assert.rejects(service.call('outputTarget', ['']));
    await assert.rejects(service.call('outputPreview', [{ path: '/etc/passwd' }]));
    assert.equal(await service.call('outputTarget', ['unrecorded']), null);
    assert.equal(await service.call('outputPreview', ['unrecorded']), null);
    const md = (await service.call('outputPreview', [byName['report.md'].id])) as any;
    assert.equal(md.format, 'markdown');
    assert.match(md.text, /# 보고서/);
    assert.ok(!md.text.includes('supersecret123'));
    const html = (await service.call('outputPreview', [byName['page.html'].id])) as any;
    assert.equal(html.format, 'html');
    assert.equal(await service.call('outputPreview', [byName['shot.png'].id]), null);
    assert.equal(await service.call('outputPreview', [byName['gone.md'].id]), null);
    const snapshot = (await service.call('snapshot')) as any;
    assert.ok(Number(snapshot.outputStamp) >= 1);
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

test('A preview never reads past its bound and judges the real file, not its name', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-outputs-preview-'));
  try {
    const big = path.join(temp, 'big.md');
    await writeFile(big, 'a'.repeat(1024 * 1024 + 10));
    const preview = await readPreview({
      id: 'x',
      sessionId: 's',
      key: big,
      kind: 'file',
      via: 'write',
      createdAt: now,
      source: { provider: 'claude', project: 'p', title: 't', alias: '' },
    });
    assert.equal(preview!.truncated, true);
    assert.equal(preview!.text.length, 1024 * 1024);
    const { symlink } = await import('node:fs/promises');
    const secret = path.join(temp, 'secret.txt');
    await writeFile(secret, 'secret');
    await symlink(secret, path.join(temp, 'looks.md'));
    assert.equal(
      await readPreview({
        id: 'y',
        sessionId: 's',
        key: path.join(temp, 'looks.md'),
        kind: 'file',
        via: 'write',
        createdAt: now,
        source: { provider: 'claude', project: 'p', title: 't', alias: '' },
      }),
      null,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('Lists group by project, then teammate, newest first', () => {
  const o = (id: string, sessionId: string, project: string, createdAt: number) => ({
    id,
    sessionId,
    kind: 'file' as const,
    via: 'write' as const,
    name: `${id}.md`,
    dir: '/x',
    path: `/x/${id}.md`,
    ext: 'md',
    createdAt,
    source: { provider: 'claude' as const, project, title: `T-${sessionId}`, alias: '' },
  });
  const groups = groupOutputs(
    [
      o('a', 's1', 'app', 1),
      o('b', 's2', 'site', 5),
      o('c', 's1', 'app', 3),
      o('d', 's3', 'app', 4),
    ],
    [{ id: 's3', alias: '네모', title: 'x', project: 'app' } as Session],
  );
  assert.deepEqual(
    groups.map((g) => [g.project, g.colleagues.map((c) => [c.name, c.outputs.map((x) => x.id)])]),
    [
      ['site', [['T-s2', ['b']]]],
      [
        'app',
        [
          ['네모', ['d']],
          ['T-s1', ['c', 'a']],
        ],
      ],
    ],
  );
});

test('A list read again keeps its loaded tail past the refreshed first page', () => {
  const row = (n: number) =>
    ({ id: `o${String(n + 1).padStart(3, '0')}`, createdAt: 1000 - n }) as SessionOutput;
  const loaded = Array.from({ length: 250 }, (_, i) => row(i));
  // The first 200 read again: a new row on top, one inside the range gone.
  const gone = loaded[5].id;
  const head = [row(-1), ...loaded.slice(0, 200).filter((o) => o.id !== gone)];
  const next = refreshed(loaded, head, true)!;
  assert.equal(next.length, 250);
  assert.equal(next[0].id, row(-1).id);
  assert.ok(!next.some((o) => o.id === gone));
  assert.deepEqual(
    next.slice(200).map((o) => o.id),
    loaded.slice(200).map((o) => o.id),
  );
  assert.equal(new Set(next.map((o) => o.id)).size, next.length);
  // The page covers everything, or nothing was loaded past it: the page as it is.
  assert.equal(refreshed(loaded, head, false), null);
  assert.equal(refreshed(loaded.slice(0, 50), head.slice(0, 50), true), null);
});
