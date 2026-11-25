import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  builtinListing,
  conversationProject,
  folderProject,
  managerPreviews,
  officeNickname,
  type OfficeConversation,
  type TermListDeps,
  type TermManagerDeps,
} from '../desktop/term-list.js';
import type { ListResult, SessionStats } from '../desktop/term-host/protocol.js';
import {
  groupedOrder,
  groupRows,
  promptCommand,
  termRowTitle,
  type BuiltinSessionRow,
} from '../src/shared/term-list.js';

/** The terminal list's row titles and project groups (Settings and the terminal manager). */

const row = (over: Partial<BuiltinSessionRow>): BuiltinSessionRow => ({
  id: 'ao-1',
  program: 'claude',
  cwd: '/Users/me/work/app',
  agents: [],
  startedAt: 1_000,
  pid: 100,
  windowOpen: false,
  attached: 0,
  ...over,
});
const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
const conv = (over: Partial<OfficeConversation>): OfficeConversation => ({
  id: 's',
  provider: 'claude',
  nativeId: 'n',
  cwd: '/work/app',
  title: 'T',
  updatedAt: 1,
  ...over,
});

test('a row is named by nickname, then session title, then terminal title, prompt, folder', () => {
  const agent = { id: 'a', name: 'x', provider: 'claude' };
  assert.deepEqual(
    termRowTitle(
      row({ agents: [{ ...agent, alias: '버터', title: '리팩터링' }] }),
      undefined,
      false,
    ),
    { text: '버터', source: 'alias' },
  );
  assert.deepEqual(
    termRowTitle(
      row({
        agents: [
          { ...agent, title: '리팩터링' },
          { ...agent, id: 'b', alias: '민트', title: 'Y' },
        ],
      }),
      undefined,
      false,
    ),
    { text: '리팩터링, 민트', source: 'alias' },
    'each conversation by its own best name',
  );
  assert.deepEqual(
    termRowTitle(row({ agents: [{ ...agent, title: '리팩터링' }] }), undefined, false),
    { text: '리팩터링', source: 'session' },
  );
  // No conversation linked: what the program set, else what was typed last.
  const preview = { lines: ['me@mac app % npm test', 'ok'], title: '✳ Fix login bug' };
  assert.deepEqual(termRowTitle(row({}), preview, false, short), {
    text: '✳ Fix login bug',
    source: 'terminal',
  });
  assert.deepEqual(termRowTitle(row({}), { ...preview, title: 'claude' }, false, short), {
    text: 'npm test',
    source: 'prompt',
  });
  assert.deepEqual(termRowTitle(row({}), { lines: ['hello'] }, false, short), {
    text: '~/work/app',
    source: 'path',
  });
  assert.deepEqual(termRowTitle(row({ cwd: '' }), undefined, false), {
    text: 'claude',
    source: 'program',
  });
  // Hidden: nothing but the id, whatever is known.
  assert.deepEqual(termRowTitle(row({ agents: [{ ...agent, alias: '버터' }] }), preview, true), {
    text: 'ao-1',
    source: 'id',
  });
});

test('the prompt command is read from the last prompt-looking row', () => {
  assert.equal(promptCommand(['me@mac app % git status', 'clean', '❯ make build']), 'make build');
  assert.equal(promptCommand(['$ ls -la']), 'ls -la');
  assert.equal(promptCommand(['plain output', '%']), '');
  assert.equal(promptCommand(undefined), '');
});

test('two Claude sessions in one folder get different names', () => {
  const a = row({ id: 'a', agents: [{ id: '1', name: 'x', provider: 'claude', alias: '버터' }] });
  const b = row({
    id: 'b',
    agents: [{ id: '2', name: 'y', provider: 'claude', title: '테스트 정리' }],
  });
  assert.notEqual(termRowTitle(a, undefined, false).text, termRowTitle(b, undefined, false).text);
});

test('rows group by project: running and most recent first, order kept inside', () => {
  const app = { key: '/repo/app', name: 'app' };
  const web = { key: '/repo/web', name: 'web' };
  const rows = [
    row({ id: 'a1', project: app, startedAt: 10 }),
    row({
      id: 'w1',
      project: web,
      startedAt: 5,
      agents: [{ id: 's', name: 'n', provider: 'codex', updatedAt: 50 }],
    }),
    row({ id: 'a2', project: app, startedAt: 8 }),
    row({
      id: 'old',
      project: { key: '/old', name: 'old' },
      startedAt: 99,
      exit: { code: 0, signal: null, at: 100 },
    }),
  ];
  const groups = groupRows(rows);
  assert.deepEqual(
    groups.map((g) => [g.name, g.rows.map((r) => r.id)]),
    [
      ['web', ['w1']],
      ['app', ['a1', 'a2']],
      ['old', ['old']],
    ],
  );
  assert.deepEqual(
    groupedOrder(groups).map((r) => r.id),
    ['w1', 'a1', 'a2', 'old'],
    '⌘1…9 follow the drawn order',
  );
  // Hidden rows carry no project: one unnamed group.
  assert.deepEqual(
    groupRows([row({ id: 'x' }), row({ id: 'y' })]).map((g) => [g.key, g.name, g.rows.length]),
    [['', '', 2]],
  );
});

test('a conversation is grouped like the office: area, repository, then folder', () => {
  assert.deepEqual(conversationProject(conv({ cwd: '/work/app' })), {
    key: '/work/app',
    name: 'app',
  });
  const workspace = {
    key: 'repo:agent-office',
    name: 'agent-office',
    zoneName: 'agent-office',
    root: '/src/agent-office',
    worktree: '/wt/feat-x',
    evidence: 'git-common-dir' as const,
  };
  assert.deepEqual(conversationProject(conv({ cwd: '/wt/feat-x', workspace, project: 'feat-x' })), {
    key: 'repo:agent-office',
    name: 'agent-office',
  });
  assert.deepEqual(
    conversationProject(
      conv({ workspace, area: { key: 'area:Front', name: 'Front', ruleId: 'r', match: 'path' } }),
    ),
    { key: 'area:Front', name: 'Front' },
  );
});

test('an unlinked folder takes the deepest office project holding it', () => {
  const workspace = {
    key: 'repo:mono',
    name: 'mono',
    root: '/src/mono',
    worktree: '/src/mono',
    evidence: 'git-common-dir' as const,
  };
  const list = [
    conv({ id: 'm', cwd: '/src/mono', workspace }),
    conv({ id: 'p', cwd: '/src/mono/packages/ui', project: 'ui', updatedAt: 5 }),
    conv({ id: 'r', cwd: '/src/mono', workspace, remote: { peer: 'x' } }),
  ];
  assert.deepEqual(folderProject('/src/mono/packages/ui/src', list), {
    key: '/src/mono/packages/ui',
    name: 'ui',
  });
  assert.deepEqual(folderProject('/src/mono/docs', list), { key: 'repo:mono', name: 'mono' });
  assert.equal(folderProject('/elsewhere', list), null);
});

test('the nickname: resident, office alias, team member, named agent', () => {
  assert.equal(officeNickname(conv({ resident: { name: '집사' }, alias: '버터' })), '집사');
  assert.equal(officeNickname(conv({ alias: '버터' })), '버터');
  assert.equal(
    officeNickname(conv({ title: 'researcher', relation: { team: 't' } })),
    'researcher',
  );
  assert.equal(officeNickname(conv({ agentName: 'main' })), 'main');
  assert.equal(officeNickname(conv({})), '');
});

const stats = (over: Partial<SessionStats>): SessionStats => ({
  id: 'ao-1',
  pid: 100,
  argv: ['/usr/local/bin/claude'],
  cwd: '/work/app',
  cols: 80,
  rows: 24,
  createdAt: 1_000,
  scrollbackLines: 0,
  approxBytes: 0,
  bytesIn: 0,
  bytesOut: 0,
  bytesWritten: 0,
  droppedBytes: 0,
  attached: 0,
  ...over,
});
const listResult = (sessions: SessionStats[]): ListResult => ({
  daemon: { pid: 9, protocol: 2, startedAt: 500 },
  sessions,
  total: {
    sessions: sessions.length,
    live: sessions.length,
    clients: 0,
    scrollbackLines: 0,
    approxBytes: 0,
    bytesIn: 0,
    bytesOut: 0,
    rss: 1,
    heapUsed: 0,
    arrayBuffers: 0,
  },
});

test('the listing gives each row its project, and none while hidden', async () => {
  let hidden = false;
  const deps: TermListDeps = {
    supported: true,
    listing: async () =>
      listResult([
        stats({ id: 'ao-1', cwd: '/work/app' }),
        stats({ id: 'ao-2', cwd: '/src/mono/docs' }),
        stats({ id: 'ao-3', cwd: '/tmp/x' }),
      ]),
    hidden: () => hidden,
    windowOpen: () => false,
    agents: async () =>
      new Map([
        [
          'ao-1',
          [{ id: 's', name: '버터', provider: 'claude', project: { key: 'repo:a', name: 'A' } }],
        ],
      ]),
    project: (cwd) => (cwd.startsWith('/src/mono') ? { key: 'repo:mono', name: 'mono' } : null),
  };
  const shown = await builtinListing(deps);
  assert.deepEqual(
    shown.sessions.map((s) => [s.id, s.project]),
    [
      ['ao-1', { key: 'repo:a', name: 'A' }],
      ['ao-2', { key: 'repo:mono', name: 'mono' }],
      ['ao-3', { key: '/tmp/x', name: 'x' }],
    ],
  );
  hidden = true;
  const masked = await builtinListing(deps);
  assert.ok(masked.sessions.every((s) => s.project === undefined && !s.cwd && !s.agents.length));
});

test('previews carry the program title, cleaned, and nothing while hidden', async () => {
  let hidden = false;
  const deps: TermManagerDeps = {
    hidden: () => hidden,
    listing: async () => listResult([stats({ id: 'ao-1' })]),
    screen: async () => ({ lines: ['$ ls'], cursor: { y: 0 }, title: ' ✳ Fix\u0007 bug ' }),
    messages: { hidden: 'H', gone: 'G' },
  };
  assert.deepEqual(await managerPreviews(deps, ['ao-1']), {
    'ao-1': { lines: ['$ ls'], title: '✳ Fix bug' },
  });
  hidden = true;
  assert.deepEqual(await managerPreviews(deps, ['ao-1']), {});
});
