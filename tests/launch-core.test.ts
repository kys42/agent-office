import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeService } from '../server/service.js';
import {
  LaunchCore,
  defaultDestination,
  launchResult,
  pendingKey,
  type LaunchDestination,
  type LaunchTarget,
} from '../desktop/launch/core.js';
import { LaunchQueue, type DestinationProbe } from '../desktop/launch/pipeline.js';
import { agentRefusal, agentWords, chooseSessionId } from '../desktop/launch/agents.js';
import {
  copyDestination,
  folderCommand,
  orcaDestination,
  orcaSession,
  terminalAppDestination,
  tmuxDestination,
  tmuxSession,
} from '../desktop/launch/destinations.js';
import { PendingLaunches } from '../desktop/pending-launch.js';
import { OrcaLaunch } from '../desktop/orca-launch.js';
import { TmuxResume, type ResumeDeps } from '../desktop/tmux-resume.js';
import { holdsFolder, matchOrcaTab } from '../desktop/orca-tabs.js';
import { orcaSwitchFailure } from '../desktop/terminal-host.js';
import { launchIntentSchema, launchRequestSchema } from '../src/shared/launch.js';
import { m } from '../src/shared/i18n/index.js';
import type { DuplicateCheck, Session } from '../src/shared/types.js';

/**
 * The launch core (#318): one pipeline, one queue and one pending record for every destination,
 * agent arguments from one adapter. Every destination here is a fake or runs fake commands:
 * nothing starts a real agent, opens a terminal or touches a real tmux server or Orca.
 */

delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

const CWD = '/projects/office';
const ID = '4f1c2a3b-0000-4000-8000-000000000001';
const resume: LaunchTarget = { kind: 'resume', provider: 'claude', cwd: CWD, nativeId: ID };
const fresh: LaunchTarget = { kind: 'new', provider: 'claude', cwd: CWD, name: '리뷰 봇' };
const fork: LaunchTarget = {
  kind: 'fork',
  provider: 'claude',
  cwd: CWD,
  nativeId: ID,
  name: '갈래',
};

/** A destination that records what the pipeline asked of it. */
function fake(
  id: LaunchDestination['id'],
  options: {
    probes?: DestinationProbe[];
    start?: 'launched' | 'uncertain' | 'copied' | Error;
    launches?: boolean;
    onStart?: (hold: () => void) => void | Promise<void>;
  } = {},
) {
  const log: string[] = [];
  const probes = [...(options.probes ?? [{ available: true, command: `${id} cmd` }])];
  const destination: LaunchDestination = {
    id,
    launches: options.launches ?? true,
    place: id === 'orca' || id === 'tmux' ? id : 'other',
    async probe(target) {
      log.push(`probe ${target.sessionId ?? ''}`.trim());
      return probes.length > 1 ? probes.shift()! : probes[0];
    },
    async start(target, context) {
      log.push(`start ${target.sessionId ?? ''}`.trim());
      context.authorized?.();
      await options.onStart?.(context.hold);
      if (options.start instanceof Error) throw options.start;
      return { state: options.start ?? 'launched', message: `${id} done` };
    },
  };
  return { destination, log };
}

function core(
  destinations: Partial<Record<LaunchDestination['id'], LaunchDestination>>,
  over: Partial<ConstructorParameters<typeof LaunchCore>[0]> = {},
) {
  return new LaunchCore({
    destinations,
    pending: new PendingLaunches(),
    queue: new LaunchQueue(),
    ...over,
  });
}
const yes = async () => true;

test('a probe that says no refuses with its reason and never asks or starts', async () => {
  const tmux = fake('tmux', { probes: [{ available: false, reason: 'tmux 없음' }] });
  let asked = false;
  const outcome = await core({ tmux: tmux.destination }).start(fresh, 'tmux', {
    confirm: async () => (asked = true),
  });
  assert.equal(outcome.state, 'refused');
  assert.equal(outcome.state === 'refused' && outcome.reason, 'tmux 없음');
  assert.equal(asked, false);
  assert.deepEqual(
    tmux.log.filter((x) => x.startsWith('start')),
    [],
  );
});

test('confirm, then look again: cancelled starts nothing, a change meanwhile refuses', async () => {
  const cancelled = fake('orca');
  const one = await core({ orca: cancelled.destination }).start(fresh, 'orca', {
    confirm: async () => false,
  });
  assert.equal(one.state, 'cancelled');
  assert.equal(cancelled.log.length, 1);
  // The folder stopped being a workspace while the dialog was open.
  const changed = fake('orca', {
    probes: [{ available: true }, { available: false, reason: '작업 공간 아님' }],
  });
  const two = await core({ orca: changed.destination }).start(fresh, 'orca', { confirm: yes });
  assert.equal(two.state === 'refused' && two.reason, '작업 공간 아님');
  assert.equal(changed.log.filter((x) => x.startsWith('start')).length, 0);
});

test('its own session already running: nothing asked, nothing started', async () => {
  const tmux = fake('tmux', { probes: [{ available: true, running: true, message: '실행 중' }] });
  const outcome = await core({ tmux: tmux.destination }).start(fresh, 'tmux', {
    confirm: async () => assert.fail('must not ask'),
  });
  assert.equal(outcome.state, 'running');
  assert.deepEqual(launchResult('tmux', outcome), {
    state: 'running',
    destination: 'tmux',
    message: '실행 중',
  });
});

test('an unconfirmed start stays pending (held while looked for); a confirmed one clears it', async () => {
  const pending = new PendingLaunches();
  let heldWhileStarting = false;
  const orca = fake('orca', {
    start: 'uncertain',
    onStart: (hold) => {
      hold();
      heldWhileStarting = pending.has(pendingKey(fresh));
    },
  });
  const c = core({ orca: orca.destination }, { pending });
  assert.equal((await c.start(fresh, 'orca', { confirm: yes })).state, 'uncertain');
  assert.equal(heldWhileStarting, true);
  assert.equal(pending.has(pendingKey(fresh)), true);
  // The same new agent again: the pending record is its duplicate check ("open in Orca").
  const seen: DuplicateCheck[] = [];
  await c.start(fresh, 'orca', { confirm: async (_p, check) => (seen.push(check), false) });
  assert.deepEqual(seen, [{ state: 'open', where: 'orca', pending: true }]);
  // Another name is another agent.
  await c.start({ ...fresh, name: '다른 봇' }, 'orca', {
    confirm: async (_p, check) => (seen.push(check), false),
  });
  assert.deepEqual(seen[1], { state: 'none' });
  const confirmed = fake('orca');
  const d = core({ orca: confirmed.destination }, { pending });
  assert.equal((await d.start(fresh, 'orca', { confirm: yes })).state, 'launched');
  assert.equal(pending.has(pendingKey(fresh)), false);
});

test('a resume uses the conversation’s whole check: running is refused before asking', async () => {
  const tmux = fake('tmux');
  const running: DuplicateCheck = { state: 'running', where: 'orca' };
  const c = core(
    { tmux: tmux.destination },
    { conversationCheck: (t) => (t.from ? async () => running : undefined) },
  );
  const outcome = await c.start({ ...resume, from: {} as Session }, 'tmux', {
    confirm: async () => assert.fail('must not ask'),
  });
  assert.equal(outcome.state, 'refused');
  assert.deepEqual(outcome.state === 'refused' && outcome.duplicate, running);
  assert.equal(
    outcome.state === 'refused' && outcome.reason,
    m().tmux.runningRefused(m().tmux.place.orca),
  );
  // Opened elsewhere while the dialog was open: refused after confirming.
  let state: DuplicateCheck = { state: 'none' };
  const later = core(
    { tmux: fake('tmux').destination },
    { conversationCheck: () => async () => state },
  );
  const changed = await later.start(resume, 'tmux', {
    confirm: async () => {
      state = { state: 'open', where: 'orca' };
      return true;
    },
  });
  assert.equal(changed.state === 'refused' && changed.reason, m().tmux.changedRefused);
});

test('a fork is never blocked by its original running, only by the same fork still starting', async () => {
  const pending = new PendingLaunches();
  const running: DuplicateCheck = { state: 'running', where: 'tmux' };
  const c = core(
    { tmux: fake('tmux').destination, orca: fake('orca', { start: 'uncertain' }).destination },
    { pending, conversationCheck: () => async () => running },
  );
  const from = {} as Session;
  assert.equal((await c.start({ ...fork, from }, 'orca', { confirm: yes })).state, 'uncertain');
  // The same fork (original, folder, name) is now pending; another name is not.
  const seen: DuplicateCheck['state'][] = [];
  const ask = async (_p: DestinationProbe, check: DuplicateCheck) => (
    seen.push(check.state),
    false
  );
  await c.start({ ...fork, from }, 'tmux', { confirm: ask });
  await c.start({ ...fork, from, name: '또 다른 갈래' }, 'tmux', { confirm: ask });
  assert.deepEqual(seen, ['open', 'none']);
  // A pending fork is not its original's record, nor a summon of the same name.
  assert.equal(pending.has(pendingKey(resume)), false);
  assert.equal(pending.has(pendingKey({ ...fresh, name: '갈래' })), false);
});

test('a copied command asks nothing and keeps nothing pending, but is refused while it runs', async () => {
  const copied: string[] = [];
  const copy = copyDestination({
    platform: 'linux',
    run: async () => assert.fail('nothing runs'),
    directory: async () => true,
    copy: (text) => copied.push(text),
  });
  const pending = new PendingLaunches();
  const c = core({ copy }, { pending });
  const outcome = await c.start(resume, 'copy', {
    confirm: async () => assert.fail('must not ask'),
  });
  assert.equal(outcome.state, 'copied');
  assert.deepEqual(copied, [
    `cd '${CWD}' && '/usr/bin/env' '-u' 'CLAUDE_CONFIG_DIR' 'claude' '--resume' '${ID}'`,
  ]);
  assert.equal(pending.has(pendingKey(resume)), false);
  const busy = core(
    { copy },
    { conversationCheck: () => async () => ({ state: 'running', where: 'other' }) },
  );
  assert.equal((await busy.start(resume, 'copy', { confirm: yes })).state, 'refused');
  assert.equal(copied.length, 1);
});

test('one queue across destinations: a second launch waits for the first to finish', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const orca = fake('orca', {
    onStart: async () => {
      order.push('orca starting');
      await gate;
      order.push('orca done');
    },
  });
  const tmux = fake('tmux', { onStart: () => void order.push('tmux starting') });
  const c = core({ orca: orca.destination, tmux: tmux.destination });
  const first = c.start(fresh, 'orca', { confirm: yes });
  const second = c.start(fresh, 'tmux', {
    confirm: async () => (order.push('tmux asked'), true),
  });
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(order, ['orca starting']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['orca starting', 'orca done', 'tmux asked', 'tmux starting']);
});

test('a new conversation’s id is chosen once per start: probed, confirmed and started alike', async () => {
  const tmux = fake('tmux');
  const outcome = await core({ tmux: tmux.destination }).start(fresh, 'tmux', { confirm: yes });
  const ids = tmux.log.map((x) => x.split(' ')[1]);
  assert.match(ids[0], /^[0-9a-f-]{36}$/);
  assert.deepEqual(ids, [ids[0], ids[0], ids[0]]);
  assert.equal(outcome.sessionId, ids[0]);
  // Codex picks its own; a resume has none.
  assert.equal(chooseSessionId({ kind: 'new', provider: 'codex' }), undefined);
  assert.equal(chooseSessionId({ kind: 'resume', provider: 'claude' }), undefined);
});

test('the target is checked before any destination: agent, folder, name and message', async () => {
  const tmux = fake('tmux');
  const c = core({ tmux: tmux.destination });
  const reason = async (t: LaunchTarget) => (await c.probe(t, 'tmux')).reason;
  assert.equal(await reason({ ...resume, provider: 'openclaw' }), m().launch.agentUnsupported);
  assert.equal(await reason({ ...fork, provider: 'openclaw' }), m().launch.forkUnsupported);
  assert.equal(await reason({ ...resume, nativeId: '--last' }), m().launch.noConversation);
  assert.equal(await reason({ ...resume, cwd: 'relative' }), m().tmux.folderMissing);
  assert.equal(await reason({ ...fresh, name: 'x;y' }), m().tmux.invalidName);
  assert.equal(await reason({ ...fork, name: undefined }), m().tmux.invalidName);
  assert.equal(await reason({ ...fresh, initialMessage: 'a\x1bb' }), m().tmux.invalidMessage);
  assert.equal(tmux.log.length, 0);
  assert.equal((await c.probe(fresh, 'orca')).available, false);
});

test('the default: a fork where its original runs, else the last choice, else Orca, else tmux', async () => {
  const p = (id: 'orca' | 'tmux' | 'terminalApp' | 'copy', available = true) => ({
    id,
    probe: { available },
  });
  const all = [p('orca'), p('tmux'), p('terminalApp'), p('copy')];
  assert.equal(defaultDestination(all), 'orca');
  assert.equal(defaultDestination(all, 'copy'), 'copy');
  assert.equal(defaultDestination(all, 'copy', 'tmux'), 'tmux');
  // Where it runs is not a destination ("another terminal"): the usual default.
  assert.equal(defaultDestination(all, undefined, 'other'), 'orca');
  const noOrca = [p('orca', false), p('tmux'), p('terminalApp'), p('copy')];
  assert.equal(defaultDestination(noOrca, 'orca'), 'tmux');
  assert.equal(defaultDestination(noOrca, undefined, 'orca'), 'tmux');
  assert.equal(
    defaultDestination([p('orca', false), p('tmux', false), p('terminalApp'), p('copy')]),
    'terminalApp',
  );
  assert.equal(defaultDestination([p('orca', false)]), null);
});

test('options probe every destination; the choice is remembered only for a launch that went ahead', async () => {
  let remembered: 'orca' | 'tmux' | 'terminalApp' | 'copy' | undefined = 'tmux';
  const calls: string[] = [];
  const c = core(
    {
      orca: fake('orca').destination,
      tmux: fake('tmux', { probes: [{ available: false, reason: 'no tmux' }] }).destination,
      copy: fake('copy', { launches: false, start: 'copied' }).destination,
    },
    {
      remembered: () => remembered,
      remember: (id) => {
        calls.push(id);
        remembered = id;
      },
      conversationCheck: () => async () => ({ state: 'open', where: 'tmux' }),
    },
  );
  const options = await c.options({ ...fork, from: {} as Session });
  assert.deepEqual(
    options.destinations.map((d) => [d.id, d.probe.available, d.probe.reason]),
    [
      ['orca', true, undefined],
      ['tmux', false, 'no tmux'],
      ['copy', true, undefined],
    ],
  );
  // Its original is open in tmux, but tmux cannot take it now: the last choice is not either.
  assert.equal(options.origin, 'tmux');
  assert.equal(options.remembered, 'tmux');
  assert.equal(options.default, 'orca');
  assert.deepEqual(options.duplicate, { state: 'none' });
  await c.start(fresh, 'orca', { confirm: async () => false });
  assert.deepEqual(calls, []);
  await c.start(fresh, 'copy', { confirm: yes });
  assert.deepEqual(calls, ['copy']);
  await c.start({ ...fresh, background: true }, 'orca', { confirm: yes });
  assert.deepEqual(calls, ['copy']);
});

test('agent words: each agent × new, resume and fork', () => {
  const words = (l: Parameters<typeof agentWords>[0]) => agentWords(l);
  const sid = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(words({ kind: 'new', provider: 'claude', sessionId: sid }), {
    args: ['--session-id', sid],
  });
  assert.deepEqual(
    words({ kind: 'resume', provider: 'claude', nativeId: ID, initialMessage: 'x' }),
    {
      args: ['--resume', ID],
    },
  );
  // Claude takes `--session-id` with `--resume` only together with `--fork-session`.
  assert.deepEqual(
    words({
      kind: 'fork',
      provider: 'claude',
      nativeId: ID,
      sessionId: sid,
      initialMessage: '-이어서',
      skipPermissions: true,
    }),
    {
      args: [
        '--dangerously-skip-permissions',
        '--session-id',
        sid,
        '--fork-session',
        '--resume',
        ID,
      ],
      message: '-이어서',
    },
  );
  assert.deepEqual(words({ kind: 'new', provider: 'codex', initialMessage: 'hi' }), {
    args: [],
    message: 'hi',
  });
  assert.deepEqual(
    words({ kind: 'resume', provider: 'codex', nativeId: ID, skipPermissions: true }),
    {
      args: ['resume', '--dangerously-bypass-approvals-and-sandbox', ID],
    },
  );
  assert.deepEqual(words({ kind: 'fork', provider: 'codex', nativeId: ID }), {
    args: ['fork', ID],
  });
  // A blank first message is none.
  assert.deepEqual(words({ kind: 'new', provider: 'codex', initialMessage: ' \n' }), { args: [] });
  for (const kind of ['new', 'resume', 'fork'] as const)
    assert.throws(() => words({ kind, provider: 'openclaw', nativeId: ID }));
  assert.equal(agentRefusal({ kind: 'fork', provider: 'openclaw' }), m().launch.forkUnsupported);
  assert.equal(agentRefusal({ kind: 'resume', provider: 'claude' }), m().launch.noConversation);
  assert.throws(() => words({ kind: 'new', provider: 'claude', sessionId: '$(id)' }));
  assert.throws(() => words({ kind: 'new', provider: 'claude', initialMessage: 'a\x07' }));
});

test('every destination types the same agent words: tmux argv, Orca tab, Terminal, copy', async () => {
  const sid = '11111111-2222-4333-8444-555555555555';
  const target: LaunchTarget = { ...fork, sessionId: sid, initialMessage: "it's; ok\n둘째 줄" };
  assert.deepEqual(tmuxSession(target), {
    provider: 'claude',
    cwd: CWD,
    skipPermissions: undefined,
    nativeId: ID,
    fork: true,
    agentName: '갈래',
    initialMessage: target.initialMessage,
    sessionId: sid,
  });
  const tab = orcaSession(target);
  assert.equal(tab.fork, true);
  assert.equal(tab.alias, '갈래');
  const typed = `'/usr/bin/env' '-u' 'CLAUDE_CONFIG_DIR' 'claude' '--session-id' '${sid}' '--fork-session' '--resume' '${ID}' '--' 'it'\\''s; ok\n둘째 줄'`;
  assert.equal(folderCommand(target, {}), `cd '${CWD}' && ${typed}`);
  // A folder with a quote stays one shell word.
  assert.equal(
    folderCommand({ ...resume, cwd: "/a b/it's" }, {}, '/opt/bin/claude'),
    `cd '/a b/it'\\''s' && '/usr/bin/env' '-u' 'CLAUDE_CONFIG_DIR' '/opt/bin/claude' '--resume' '${ID}'`,
  );
  const ran: string[][] = [];
  const terminal = terminalAppDestination({
    platform: 'darwin',
    run: async (_file, args) => (ran.push(args), ''),
    directory: async () => true,
    binary: async () => {
      throw new Error('missing');
    },
    env: {},
  });
  const c = core({ terminalApp: terminal });
  const outcome = await c.start(target, 'terminalApp', { confirm: yes });
  assert.equal(outcome.state, 'launched');
  assert.equal(ran[0].at(-1), `cd '${CWD}' && ${typed}`);
  const linux = terminalAppDestination({
    platform: 'linux',
    run: async () => assert.fail('nothing runs'),
    directory: async () => true,
  });
  assert.deepEqual(await core({ terminalApp: linux }).probe(target, 'terminalApp'), {
    available: false,
    reason: m().launch.terminalAppUnsupported,
  });
});

/** A fake dedicated tmux server: one session list, launches recorded (no real tmux runs). */
function fakeTmux() {
  const launches: string[][] = [];
  let rows = '';
  const deps: ResumeDeps = {
    platform: 'darwin',
    server: 'aotest-launch-core',
    binary: async (name) => '/bin/' + name,
    directory: async () => true,
    run: async (_file, args) => {
      if (args.includes('list-sessions')) return rows;
      if (args.includes('list-panes')) return '%1\t0';
      if (args.includes('new-session')) {
        launches.push(args);
        const name = args[args.indexOf('-s') + 1];
        rows = `${name}\t${args.at(-1)}\t\t\t`;
      }
      return '';
    },
  };
  return { launches, tmux: new TmuxResume(deps) };
}

test('a tmux fork takes the named slot, starts with its own id and is tagged with it', async () => {
  const f = fakeTmux();
  const c = core({ tmux: tmuxDestination(f.tmux) });
  const outcome = await c.start(fork, 'tmux', { confirm: yes });
  assert.equal(outcome.state, 'launched');
  const args = f.launches[0];
  const at = args.indexOf('/bin/claude');
  assert.deepEqual(args.slice(at + 1, at + 6), [
    '--session-id',
    outcome.sessionId,
    '--fork-session',
    '--resume',
    ID,
  ]);
  assert.equal(args[args.indexOf('@agent_office_native') + 1], `claude:${outcome.sessionId}`);
  // The slot is the summon slot of that name, not the original conversation's resume session.
  assert.equal(
    args[args.indexOf('-s') + 1],
    (await f.tmux.status({ ...tmuxSession(fresh), agentName: '갈래' })).name,
  );
  assert.notEqual(args[args.indexOf('-s') + 1], (await f.tmux.status(tmuxSession(resume))).name);
  // While it runs, the same fork is that session: nothing new starts.
  assert.equal((await c.start(fork, 'tmux', { confirm: yes })).state, 'running');
  assert.equal(f.launches.length, 1);
});

test('an Orca summon of Claude carries its chosen id, so the office knows its tab', async () => {
  const created: string[][] = [];
  const orca = new OrcaLaunch({
    platform: 'darwin',
    orca: () => '/bin/orca',
    directory: async () => true,
    wait: async () => {},
    run: async (file, args) => {
      if (args[0] === 'status')
        return JSON.stringify({ ok: true, result: { runtime: { reachable: true } } });
      if (args[0] === 'worktree')
        return JSON.stringify({ ok: true, result: { worktree: { path: CWD, hostId: 'local' } } });
      if (args[1] === 'list') return JSON.stringify({ ok: true, result: { terminals: [] } });
      if (args[1] === 'create') return (created.push(args), JSON.stringify({ ok: true }));
      throw new Error('unexpected ' + file);
    },
  });
  const c = core({ orca: orcaDestination(orca) }, { pending: orca.pending });
  let shown = '';
  const outcome = await c.start(fresh, 'orca', {
    confirm: async (probe) => ((shown = probe.command ?? ''), true),
  });
  assert.equal(outcome.state, 'launched');
  assert.equal(outcome.state === 'launched' && outcome.message, m().tmux.summonOrcaLaunched);
  const command = created[0].find((a) => a.startsWith('--command='))!.slice(10);
  assert.equal(command, shown);
  assert.ok(command.endsWith(`'claude' '--session-id' '${outcome.sessionId}'`));
  assert.ok(created[0].includes('--title=리뷰 봇'));
});

test('IPC: one strict request shape; paths, commands and unknown fields never pass', () => {
  const ok = (value: unknown) => launchRequestSchema.safeParse(value).success;
  const intent = { kind: 'fork', session: 's1', name: '갈래', initialMessage: '줄\n바꿈' };
  assert.ok(ok({ intent, destination: 'orca', action: 'start' }));
  assert.ok(
    ok({ intent: { kind: 'resume', session: 's1' }, destination: 'copy', action: 'probe' }),
  );
  assert.ok(
    ok({
      intent: { kind: 'new', at: 's1', provider: 'codex', name: 'bot' },
      destination: 'tmux',
      action: 'start',
    }),
  );
  // The launch sheet (#319) opens a launch's own place (tmux session, Orca tab) the same way.
  assert.ok(ok({ intent: { kind: 'resume', session: 's1' }, destination: 'orca', action: 'open' }));
  for (const bad of [
    { intent, destination: 'iterm', action: 'start' },
    { intent, destination: 'orca', action: 'focus' },
    { intent, destination: 'orca', action: 'start', cwd: '/etc' },
    { intent: { ...intent, cwd: '/etc' }, destination: 'orca', action: 'start' },
    {
      intent: { kind: 'resume', session: 's1', command: 'rm -rf ~' },
      destination: 'copy',
      action: 'start',
    },
    { intent: { ...intent, name: '$(id)' }, destination: 'orca', action: 'start' },
    { intent: { ...intent, name: '' }, destination: 'orca', action: 'start' },
    { intent: { ...intent, name: undefined }, destination: 'orca', action: 'start' },
    { intent: { ...intent, initialMessage: 'a\x1b[31m' }, destination: 'orca', action: 'start' },
    {
      intent: { ...intent, initialMessage: 'x'.repeat(4001) },
      destination: 'orca',
      action: 'start',
    },
    {
      intent: { kind: 'new', at: 's1', provider: 'gemini', name: 'x' },
      destination: 'tmux',
      action: 'start',
    },
    { intent: { kind: 'resume', session: 'x'.repeat(401) }, destination: 'tmux', action: 'start' },
    { intent: { kind: 'clone', session: 's1' }, destination: 'tmux', action: 'start' },
    null,
    'office:launch',
  ])
    assert.equal(ok(bad), false, JSON.stringify(bad));
  const trimmed = launchIntentSchema.parse({
    kind: 'new',
    at: 's',
    provider: 'claude',
    name: ' a ',
  });
  assert.equal(trimmed.kind === 'new' && trimmed.name, 'a');
});

test('a session in a subfolder matches its worktree’s tab, by title as before', () => {
  assert.equal(holdsFolder('/projects/office', '/projects/office'), true);
  assert.equal(holdsFolder('/projects/office', '/projects/office/packages/web'), true);
  assert.equal(holdsFolder('/projects/office/', '/projects/office/web/../web'), true);
  assert.equal(holdsFolder('/projects/office', '/projects/office2'), false);
  assert.equal(holdsFolder('/projects/office/web', '/projects/office'), false);
  const tab = (over: Record<string, unknown> = {}) => ({
    handle: 'term_11111111-1111-4111-8111-111111111111',
    tabId: 'tab-1',
    worktreePath: '/projects/office',
    executionHostId: 'local',
    title: '✳ 기능 담당',
    ...over,
  });
  const inPackage = {
    provider: 'claude' as const,
    nativeId: ID,
    cwd: '/projects/office/packages/web',
    title: '기능 담당',
    nativeTitle: true,
  };
  assert.ok(matchOrcaTab([tab()], inPackage));
  // The title still has to name it.
  assert.equal(matchOrcaTab([tab({ title: '✳ 다른 일' })], inPackage), null);
  // Its worktree's tab and a nested worktree's tab both fit: no guess.
  assert.equal(
    matchOrcaTab(
      [
        tab(),
        tab({ handle: 'term_two', tabId: 'tab-2', worktreePath: '/projects/office/packages' }),
      ],
      inPackage,
    ),
    null,
  );
  // Another conversation of the same title anywhere in that worktree makes the tab ambiguous.
  const sibling = { ...inPackage, nativeId: `${ID.slice(0, -1)}2`, cwd: '/projects/office/docs' };
  assert.equal(matchOrcaTab([tab()], inPackage, [sibling]), null);
  assert.ok(matchOrcaTab([tab()], inPackage, [{ ...sibling, cwd: '/projects/other' }]));
});

test('an Orca switch that timed out or was refused says so instead of a generic failure', () => {
  const t = m().desktop.terminal;
  assert.equal(orcaSwitchFailure(Object.assign(new Error('t'), { killed: true })), t.orcaSlow);
  assert.equal(orcaSwitchFailure({ code: 'ETIMEDOUT' }), t.orcaSlow);
  assert.equal(
    orcaSwitchFailure({
      stdout: JSON.stringify({ ok: false, error: { message: 'no\nsuch tab' } }),
    }),
    t.orcaRefusedSwitch('no such tab'),
  );
  assert.equal(orcaSwitchFailure(new Error('spawn ENOENT')), null);
});

test('the last destination is kept in preferences; anything else is refused', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-launch-pref-'));
  const service = new OfficeService(dir, dir);
  try {
    await service.call('preferences', [{ launchDestination: 'tmux' }]);
    assert.equal(service.store.preferences().launchDestination, 'tmux');
    for (const bad of ['iterm', '/bin/sh', 1, null])
      await assert.rejects(service.call('preferences', [{ launchDestination: bad }]));
    assert.equal(service.store.preferences().launchDestination, 'tmux');
  } finally {
    service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('platform support: the sheet hides where no destination can ever work (Windows)', () => {
  const shell = { platform: 'darwin', run: async () => '', directory: async () => true };
  const all = core({
    orca: orcaDestination(new OrcaLaunch(() => '/bin/false')),
    tmux: tmuxDestination(new TmuxResume()),
    terminalApp: terminalAppDestination(shell),
    copy: copyDestination(shell),
  });
  assert.deepEqual(all.support('darwin'), { supported: true, opens: ['orca', 'tmux'] });
  // Linux: tmux and a copied command, and nothing whose own place can be opened.
  assert.deepEqual(all.support('linux'), { supported: true, opens: [] });
  assert.deepEqual(all.support('win32'), { supported: false, opens: [] });
  // A destination that says nothing about platforms counts as working everywhere.
  const plain = { id: 'copy', launches: false } as unknown as LaunchDestination;
  assert.deepEqual(core({ copy: plain }).support('win32'), { supported: true, opens: [] });
  assert.deepEqual(core({}).support('darwin'), { supported: false, opens: [] });
});
