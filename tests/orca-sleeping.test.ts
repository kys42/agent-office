import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchSleeping,
  parseWorktreePs,
  sameText,
  type ClueSession,
} from '../desktop/orca-sleeping.js';
import {
  checkDuplicate,
  decideDuplicate,
  duplicateNote,
  sleepingWorkspace,
} from '../desktop/launch-guard.js';
import { OrcaLaunch, type OrcaLaunchDeps } from '../desktop/orca-launch.js';
import { LaunchCore, type LaunchDestination, type LaunchTarget } from '../desktop/launch/core.js';
import { LaunchQueue } from '../desktop/launch/pipeline.js';
import { PendingLaunches } from '../desktop/pending-launch.js';
import { m, setLocale } from '../src/shared/i18n/index.js';
import {
  duplicateActions,
  duplicateView,
  resultView,
  sleepingRevealed,
  sleepingRevealedToast,
} from '../src/shared/launch-sheet.js';
import type { DuplicateCheck, OfficeEvent } from '../src/shared/types.js';

/**
 * A conversation whose tab rests in a sleeping Orca workspace (#342). Every `worktree ps` answer
 * here is synthetic: nothing runs Orca, sends keys or reads a real conversation.
 */

setLocale('ko');

const ROOT = '/work/app';
const REQUEST = '로그인 화면의 오류 메시지를 더 친절하게 바꿔줘. 테스트도 같이 고쳐줘.';
const ANSWER =
  '로그인 오류 메시지를 세 군데에서 바꿨어요. 비밀번호가 틀렸을 때와 계정이 잠겼을 때를 구분했고, 테스트 두 개를 고쳤어요.';

const event = (kind: OfficeEvent['kind'], text: string, at: number): OfficeEvent => ({
  id: `${kind}-${at}`,
  at,
  kind,
  text,
  sourceRef: 'x',
});
const session = (over: Partial<ClueSession> = {}): ClueSession => ({
  id: 'claude:one',
  provider: 'claude',
  cwd: ROOT,
  title: '로그인 오류 문구 정리',
  alias: '',
  events: [event('user', REQUEST, 1), event('assistant', ANSWER, 2)],
  ...over,
});

const agent = (over: Record<string, unknown> = {}) => ({
  paneKey: `tab-${Math.random().toString(36).slice(2)}:leaf`,
  parentPaneKey: null,
  agentType: 'claude',
  state: 'done',
  prompt: '다른 일: README 오타를 고쳐줘',
  lastAssistantMessage: '오타 두 개를 고쳤어요.',
  displayName: null,
  taskTitle: null,
  ...over,
});
const worktree = (over: Record<string, unknown> = {}) => ({
  workspaceKind: 'git',
  worktreeId: 'w1',
  hostId: 'local',
  path: ROOT,
  branch: 'main',
  displayName: 'app',
  isActive: false,
  hasAttachedPty: false,
  liveTerminalCount: 0,
  status: 'inactive',
  agents: [] as unknown[],
  ...over,
});
const ps = (...worktrees: unknown[]) => ({
  ok: true,
  result: { worktrees, totalCount: worktrees.length },
});
const rows = (...worktrees: unknown[]) => parseWorktreePs(ps(...worktrees))!;

test('a workspace sleeps only with no terminal attached; sub-agents and other hosts are left out', () => {
  const parsed = rows(
    worktree({ agents: [agent({ paneKey: 'a:1' }), agent({ paneKey: 'a:1' })] }),
    // In the background but mounted: `terminal list` sees its tabs.
    worktree({ path: '/work/bg', hasAttachedPty: true, liveTerminalCount: 4, isActive: false }),
    worktree({ path: '/work/shown', isActive: true, hasAttachedPty: true, liveTerminalCount: 1 }),
    worktree({ path: '/work/sub', agents: [agent({ paneKey: 'b:2', parentPaneKey: 'b:1' })] }),
    worktree({ path: '/remote/x', hostId: 'ssh-1' }),
    worktree({ path: 'relative' }),
  );
  assert.deepEqual(
    parsed.map((w) => [w.path, w.sleeping, w.agents.length]),
    [
      [ROOT, true, 1],
      ['/work/bg', false, 0],
      ['/work/shown', false, 0],
      ['/work/sub', true, 0],
    ],
  );
  assert.equal(parsed[0].name, 'app');
  assert.equal(parseWorktreePs({ ok: false }), null);
  assert.equal(parseWorktreePs(null), null);
});

test('matched by the last request, the last answer cut short, or the title', () => {
  const other = agent();
  // The last request, equal.
  assert.deepEqual(
    matchSleeping(rows(worktree({ agents: [other, agent({ prompt: REQUEST })] })), session()),
    { kind: 'found', workspace: 'app' },
  );
  // Orca's last answer cut short (a prefix of it), with its own truncation mark.
  const cut = ANSWER.slice(0, 40) + '…';
  assert.deepEqual(
    matchSleeping(
      rows(worktree({ agents: [other, agent({ prompt: '', lastAssistantMessage: cut })] })),
      session(),
    ),
    { kind: 'found', workspace: 'app' },
  );
  // Its title, as the task title Orca shows.
  assert.deepEqual(
    matchSleeping(
      rows(
        worktree({
          agents: [
            other,
            agent({ prompt: '', lastAssistantMessage: '', taskTitle: '로그인 오류 문구 정리' }),
          ],
        }),
      ),
      session({ events: [] }),
    ),
    { kind: 'found', workspace: 'app' },
  );
  // A conversation in a folder inside the workspace is matched there too.
  assert.equal(
    matchSleeping(
      rows(worktree({ agents: [agent({ prompt: REQUEST })] })),
      session({ cwd: ROOT + '/packages/web' }),
    ).kind,
    'found',
  );
});

test('weak text never matches: short requests, short prefixes, generic titles', () => {
  assert.equal(sameText('계속해줘', '계속해줘'), false);
  assert.equal(
    sameText('이 파일을 고쳐줘', '이 파일을 고쳐줘 그리고 테스트도 실행해서 결과를 알려줘'),
    false,
  );
  assert.equal(sameText(REQUEST, REQUEST.slice(0, 30)), true);
  const generic = rows(worktree({ agents: [agent({ prompt: '', displayName: 'Claude Code' })] }));
  assert.equal(
    matchSleeping(generic, session({ title: 'Claude Code', events: [] })).kind,
    'unknown',
  );
});

test('none or several matching agents is unknown, with how many of its kind rest there', () => {
  const two = rows(
    worktree({
      agents: [
        agent({ prompt: REQUEST }),
        agent({ prompt: REQUEST }),
        agent({ agentType: 'codex' }),
      ],
    }),
  );
  assert.deepEqual(matchSleeping(two, session()), {
    kind: 'unknown',
    workspace: 'app',
    count: 2,
  });
  const unmatched = rows(
    worktree({ agents: [agent(), agent(), agent(), agent({ agentType: 'codex' })] }),
  );
  assert.deepEqual(matchSleeping(unmatched, session()), {
    kind: 'unknown',
    workspace: 'app',
    count: 3,
  });
  // Another known conversation of the workspace fits the same agent: it may be that one's.
  const one = rows(worktree({ agents: [agent({ prompt: REQUEST })] }));
  const fork = session({ id: 'claude:fork', title: '갈래' });
  assert.equal(matchSleeping(one, session(), [session(), fork]).kind, 'unknown');
  // The conversation itself in the list, or another agent's conversation: still found.
  assert.equal(
    matchSleeping(one, session(), [session(), { ...fork, provider: 'codex' }]).kind,
    'found',
  );
});

test('a sleeping workspace that lists no tab of it, or tabs without text, is still a caution', () => {
  // Orca lists no agent at all, though it starts the tabs it holds once the workspace opens.
  assert.deepEqual(matchSleeping(rows(worktree({ agents: [] })), session()), {
    kind: 'unknown',
    workspace: 'app',
  });
  // Only another agent's tabs are listed: its own may still come back there.
  assert.deepEqual(
    matchSleeping(
      rows(worktree({ agents: [agent({ agentType: 'codex', prompt: REQUEST })] })),
      session(),
    ),
    { kind: 'unknown', workspace: 'app' },
  );
  // Tabs of its agent with no request, answer or title to compare.
  const blank = () => agent({ prompt: undefined, lastAssistantMessage: undefined });
  assert.deepEqual(matchSleeping(rows(worktree({ agents: [blank(), blank()] })), session()), {
    kind: 'unknown',
    workspace: 'app',
    count: 2,
  });
  // A conversation with no text of its own either, in a folder inside that workspace.
  assert.deepEqual(
    matchSleeping(
      rows(worktree({ agents: [] })),
      session({ cwd: ROOT + '/packages/web', events: [], title: '' }),
    ),
    { kind: 'unknown', workspace: 'app' },
  );
  // A Codex conversation the same way.
  assert.deepEqual(matchSleeping(rows(worktree({ agents: [] })), session({ provider: 'codex' })), {
    kind: 'unknown',
    workspace: 'app',
  });
});

test('another workspace, an active one, or an agent Orca does not know gives no evidence', () => {
  const sleepingAgents = { agents: [agent({ prompt: REQUEST })] };
  // Another workspace, and one whose name only starts like the folder.
  assert.deepEqual(
    matchSleeping(
      rows(
        worktree({ path: '/work/other', ...sleepingAgents }),
        worktree({ path: ROOT + '-b', ...sleepingAgents }),
      ),
      session(),
    ),
    { kind: 'none' },
  );
  // Its workspace has terminals: left to `terminal list` (the Orca tab check), agents or not.
  for (const live of [
    { hasAttachedPty: true, liveTerminalCount: 3 },
    { isActive: true, hasAttachedPty: true, liveTerminalCount: 1 },
    { hasAttachedPty: false, liveTerminalCount: 2 },
  ])
    for (const agents of [sleepingAgents, { agents: [] }])
      assert.deepEqual(matchSleeping(rows(worktree({ ...live, ...agents })), session()), {
        kind: 'none',
      });
  // A nested workspace with terminals holds the folder, its sleeping parent does not count.
  assert.deepEqual(
    matchSleeping(
      rows(
        worktree(sleepingAgents),
        worktree({ path: ROOT + '/packages/web', hasAttachedPty: true, liveTerminalCount: 1 }),
      ),
      session({ cwd: ROOT + '/packages/web' }),
    ),
    { kind: 'none' },
  );
  // An agent Orca does not know; no folder.
  assert.deepEqual(
    matchSleeping(rows(worktree(sleepingAgents)), session({ provider: 'openclaw' })),
    {
      kind: 'none',
    },
  );
  assert.deepEqual(matchSleeping(rows(worktree(sleepingAgents)), session({ cwd: null })), {
    kind: 'none',
  });
});

const none = { kind: 'none' } as const;
const evidence = { agent: none, orcaTab: none, ownTmux: none };

test('the decision: a sleeping tab is open in Orca; several are unknown; running still wins', () => {
  assert.deepEqual(
    decideDuplicate({ ...evidence, orcaSleeping: { kind: 'found', workspace: 'app' } }),
    { state: 'open', where: 'orca', sleeping: { workspace: 'app' } },
  );
  const several = { kind: 'unknown', workspace: 'app', count: 2 } as const;
  assert.deepEqual(decideDuplicate({ ...evidence, orcaSleeping: several }), {
    state: 'unknown',
    sleeping: { workspace: 'app', count: 2 },
  });
  // No tab listed there: the same caution, without a count.
  const unlisted = { kind: 'unknown', workspace: 'app' } as const;
  assert.deepEqual(decideDuplicate({ ...evidence, orcaSleeping: unlisted }), {
    state: 'unknown',
    sleeping: { workspace: 'app' },
  });
  // It beats a part that could not be verified: the sleeping workspace is the way to check.
  assert.deepEqual(
    decideDuplicate({ ...evidence, agent: { kind: 'unknown' }, orcaSleeping: unlisted }),
    { state: 'unknown', sleeping: { workspace: 'app' } },
  );
  // Last seen in its own tmux session: the normal rules win (running, or open there).
  assert.deepEqual(
    decideDuplicate({
      ...evidence,
      ownTmux: { kind: 'found', terminal: null },
      orcaSleeping: unlisted,
    }),
    { state: 'open', where: 'tmux' },
  );
  assert.deepEqual(
    decideDuplicate({
      ...evidence,
      agent: { kind: 'found', terminal: { where: 'other' } },
      orcaSleeping: unlisted,
    }),
    { state: 'running', where: 'other' },
  );
  // A held launch keeps its own answer too.
  assert.deepEqual(decideDuplicate({ ...evidence, pending: 'tmux', orcaSleeping: unlisted }), {
    state: 'open',
    where: 'tmux',
    pending: true,
  });
  assert.deepEqual(
    decideDuplicate({
      ...evidence,
      agent: { kind: 'found', terminal: { where: 'tmux' } },
      orcaSleeping: { kind: 'found', workspace: 'app' },
    }),
    { state: 'running', where: 'tmux' },
  );
  // A live Orca tab and a held launch keep their own answers.
  assert.deepEqual(
    decideDuplicate({
      ...evidence,
      orcaTab: { kind: 'found', terminal: {} },
      orcaSleeping: several,
    }),
    { state: 'open', where: 'orca' },
  );
  assert.deepEqual(decideDuplicate({ ...evidence, orcaSleeping: none }), { state: 'none' });
});

test('Orca failing to answer is no evidence: nothing is blocked or cautioned', async () => {
  const deps = {
    agent: async () => none,
    orcaTab: async () => none,
    ownTmux: async () => none,
  };
  assert.deepEqual(
    await checkDuplicate({ ...deps, orcaSleeping: async () => Promise.reject(new Error('down')) }),
    { state: 'none' },
  );
  assert.deepEqual(
    await checkDuplicate({
      ...deps,
      orcaSleeping: async () => ({ kind: 'found', workspace: 'app' }),
    }),
    { state: 'open', where: 'orca', sleeping: { workspace: 'app' } },
  );
  // The whole lookup from `worktree ps` failing (main gives `none`): nothing either.
  assert.deepEqual(await checkDuplicate({ ...deps, orcaSleeping: async () => none }), {
    state: 'none',
  });
});

test('the native confirmation names the sleeping workspace it is, or may be, in', () => {
  assert.match(
    duplicateNote({ state: 'open', where: 'orca', sleeping: { workspace: 'app' } }),
    /잠든 Orca 작업 공간\(app\)에 열려 있어요/,
  );
  for (const sleeping of [{ workspace: 'app', count: 3 }, { workspace: 'app' }])
    assert.match(
      duplicateNote({ state: 'unknown', sleeping }),
      /잠든 Orca 작업 공간\(app\)에 남아 있을 수 있어요.*먼저 그 작업 공간을 열어 확인하세요/s,
    );
});

test("the card's main action leads to the sleeping workspace it is, or may be, in", () => {
  assert.deepEqual(
    sleepingWorkspace({ state: 'open', where: 'orca', sleeping: { workspace: 'app' } }),
    { workspace: 'app', sure: true },
  );
  assert.deepEqual(sleepingWorkspace({ state: 'unknown', sleeping: { workspace: 'app' } }), {
    workspace: 'app',
  });
  for (const check of [
    { state: 'none' },
    { state: 'unknown' },
    { state: 'open', where: 'tmux' },
    { state: 'open', where: 'orca' },
    { state: 'running', where: 'orca' },
  ] as DuplicateCheck[])
    assert.equal(sleepingWorkspace(check), null);
  assert.equal(
    sleepingRevealedToast({ state: 'unknown', sleeping: { workspace: 'app', count: 2 } }),
    "Orca를 열었어요. 'app' 작업 공간을 열어 이 대화가 있는지 확인하세요.",
  );
  assert.equal(
    sleepingRevealedToast({ state: 'open', where: 'orca', sleeping: { workspace: 'app' } }),
    "Orca를 열었어요. 'app' 작업 공간을 열면 이 대화 탭이 다시 살아나요.",
  );
  assert.equal(sleepingRevealedToast({ state: 'unknown' }), '');
  assert.equal(sleepingRevealedToast(undefined), '');
  // Privacy mode: the workspace's name is left out.
  assert.equal(
    sleepingRevealed(false),
    'Orca를 열었어요. 작업 공간을 열어 이 대화가 있는지 확인하세요.',
  );
});

function orca(answer: () => string) {
  const calls: string[][] = [];
  const deps: OrcaLaunchDeps = {
    platform: 'darwin',
    orca: () => '/bin/orca',
    directory: async () => true,
    run: async (_file, args) => {
      calls.push(args);
      return answer();
    },
  };
  return { launch: new OrcaLaunch(deps), calls };
}

test('worktree ps is read-only, remembered for a moment, and null when Orca fails', async () => {
  const ok = orca(() => JSON.stringify(ps(worktree({ agents: [agent()] }))));
  const first = await ok.launch.workspaces();
  assert.equal(first?.[0].agents.length, 1);
  await ok.launch.workspaces();
  assert.deepEqual(ok.calls, [['worktree', 'ps', '--json']]);
  await ok.launch.workspaces(true);
  assert.equal(ok.calls.length, 2);
  const down = orca(() => {
    throw new Error('Orca is not running');
  });
  assert.equal(await down.launch.workspaces(), null);
  assert.equal(await orca(() => 'not json').launch.workspaces(), null);
  const missing = new OrcaLaunch({
    platform: 'darwin',
    orca: () => 'orca',
    directory: async () => true,
    run: async () => assert.fail('no Orca CLI: nothing runs'),
  });
  assert.equal(await missing.workspaces(), null);
});

const SLEEPING_CHECKS: [string, DuplicateCheck][] = [
  ['its tab there', { state: 'open', where: 'orca', sleeping: { workspace: 'app' } }],
  ['no tab listed', { state: 'unknown', sleeping: { workspace: 'app' } }],
  ['tabs, none surely it', { state: 'unknown', sleeping: { workspace: 'app', count: 2 } }],
];

for (const [label, sleeping] of SLEEPING_CHECKS)
  test(`a sleeping workspace (${label}) holds back only a resume, behind the confirmation`, async () => {
    const destination = (id: 'orca' | 'tmux' | 'terminalApp'): LaunchDestination => ({
      id,
      launches: true,
      place: id === 'terminalApp' ? 'other' : id,
      probe: async () => ({ available: true, command: id }),
      start: async () => ({ state: 'launched' }),
    });
    const c = new LaunchCore({
      destinations: {
        orca: destination('orca'),
        tmux: destination('tmux'),
        terminalApp: destination('terminalApp'),
      },
      pending: new PendingLaunches(),
      queue: new LaunchQueue(),
      conversationCheck: () => async () => sleeping,
      remembered: () => 'tmux',
    });
    const base = { provider: 'claude', cwd: ROOT, nativeId: 'abc' } as const;
    const fork: LaunchTarget = { ...base, kind: 'fork', name: '갈래', from: {} as never };
    const options = await c.options(fork);
    assert.deepEqual(options.duplicate, { state: 'none' });
    assert.equal(options.origin, undefined);
    assert.equal(options.default, 'tmux');
    const fresh: LaunchTarget = { ...base, kind: 'new', name: '새 동료' };
    assert.deepEqual((await c.options(fresh)).duplicate, { state: 'none' });
    // A fork starts with the plain confirmation (no duplicate warning).
    const forkSeen: DuplicateCheck[] = [];
    await c.start(fork, 'tmux', {
      confirm: async (_probe, check) => (forkSeen.push(check), false),
    });
    assert.deepEqual(forkSeen, [{ state: 'none' }]);
    // A resume sees it, and starting anyway anywhere still goes through the confirmation.
    const resume: LaunchTarget = { ...base, kind: 'resume', from: {} as never };
    assert.deepEqual((await c.options(resume)).duplicate, sleeping);
    for (const where of ['tmux', 'terminalApp', 'orca'] as const) {
      const seen: DuplicateCheck[] = [];
      const outcome = await c.start(resume, where, {
        confirm: async (_probe, check) => (seen.push(check), false),
      });
      assert.equal(outcome.state, 'cancelled');
      assert.deepEqual(seen, [sleeping]);
    }
    // Confirmed: it starts (the person checked that workspace).
    const started = await c.start(resume, 'tmux', { confirm: async () => true });
    assert.equal(started.state, 'launched');
  });

test('the sheet: open Orca first, starting only anyway; maybe there too', () => {
  const view = duplicateView({ state: 'open', where: 'orca', sleeping: { workspace: 'app' } });
  assert.deepEqual(view, {
    notice:
      '이 대화가 잠든 Orca 작업 공간(app)에 열려 있어요. Orca에서 그 작업 공간을 열면 탭이 다시 살아나요.',
    tone: 'caution',
    reveal: true,
    blocks: false,
  });
  assert.deepEqual(duplicateActions(view), [{ kind: 'reveal' }]);
  // No tab surely it (several, none listed, no text): the same way first, as a caution.
  for (const sleeping of [{ workspace: 'app', count: 2 }, { workspace: 'app' }]) {
    const maybe = duplicateView({ state: 'unknown', sleeping });
    assert.deepEqual(maybe, {
      notice:
        '이 대화가 잠든 Orca 작업 공간(app)에 남아 있을 수 있어요. 먼저 그 작업 공간을 열어 확인하세요.',
      tone: 'caution',
      reveal: true,
      blocks: false,
    });
    assert.deepEqual(duplicateActions(maybe), [{ kind: 'reveal' }]);
  }
  // An unverified check without a sleeping workspace stays the plain caution.
  assert.deepEqual(duplicateActions(duplicateView({ state: 'unknown' })), []);
  const changed = resultView({
    state: 'refused',
    destination: 'tmux',
    reason: m().tmux.changedRefused,
    duplicate: { state: 'unknown', sleeping: { workspace: 'app' } },
  });
  assert.deepEqual(changed && !changed.close && changed.actions, [{ kind: 'reveal' }]);
  // Refused because it changed meanwhile: opening Orca is the way.
  const refused = resultView({
    state: 'refused',
    destination: 'tmux',
    reason: m().tmux.changedRefused,
    duplicate: { state: 'open', where: 'orca', sleeping: { workspace: 'app' } },
  });
  assert.deepEqual(refused && !refused.close && refused.actions, [{ kind: 'reveal' }]);
});
