import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRecords } from '../server/adapters/normalize.js';
import {
  applyLiveWait,
  parseClaudeProcess,
  waitingClaudeProcesses,
  type ClaudeLiveDeps,
} from '../server/adapters/claude-live.js';
import { OfficeStore } from '../server/store.js';
import { OfficeService } from '../server/service.js';
import { noticeCandidates, unreadNoticeCount } from '../src/shared/notices.js';
import { toolLabel } from '../src/shared/activity.js';
import { localizeReason } from '../src/shared/canonical.js';
import { messagesFor, setLocale } from '../src/shared/i18n/index.js';
import type { Session } from '../src/shared/types.js';
// These tests assert the original Korean copy: pin the language so results never depend on the
// machine (services resolve `auto` through AGENT_OFFICE_LOCALE first).
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');
const ko = messagesFor('ko');
const en = messagesFor('en');

const SID = '6dfc48fb-f723-4025-aab6-eaa73f743e5b';
const START = 'Tue Oct  6 13:05:12 2026';
const now = Date.now();
const iso = (at: number) => new Date(at).toISOString();
const base = { sessionId: SID, cwd: '/tmp/plan-project' };
const user = (uuid: string, at: number, text: string) => ({
  ...base,
  type: 'user',
  uuid,
  timestamp: iso(at),
  message: { role: 'user', content: text },
});
const toolUse = (uuid: string, at: number, id: string, name: string) => ({
  ...base,
  type: 'assistant',
  uuid,
  timestamp: iso(at),
  message: {
    id: `msg-${uuid}`,
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input: {} }],
  },
});
const toolResult = (uuid: string, at: number, id: string, text: string) => ({
  ...base,
  type: 'user',
  uuid,
  timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const reply = (uuid: string, at: number, text: string, final = false) => ({
  ...base,
  type: 'assistant',
  uuid,
  timestamp: iso(at),
  message: {
    id: `msg-${uuid}`,
    role: 'assistant',
    ...(final ? { stop_reason: 'end_turn' } : {}),
    content: [{ type: 'text', text }],
  },
});
const parse = (records: Record<string, unknown>[], at = now) =>
  parseRecords(records, {
    provider: 'claude',
    sourcePath: `/tmp/plan-project/${SID}.jsonl`,
    mtime: at,
    now: at,
  });

/** A plan proposed in plan mode, then approved, worked on and answered. */
const answeredPlan = (t: number, p = '') => [
  user(`${p}u1`, t, 'plan the login fix'),
  toolUse(`${p}a1`, t + 1000, `${p}toolu_plan`, 'ExitPlanMode'),
  toolResult(`${p}r1`, t + 5000, `${p}toolu_plan`, 'User has approved your plan.'),
  reply(`${p}a2`, t + 6000, 'Starting with the session cache.'),
  toolUse(`${p}a3`, t + 7000, `${p}toolu_edit`, 'Edit'),
  toolResult(`${p}r2`, t + 8000, `${p}toolu_edit`, 'ok'),
  reply(`${p}a4`, t + 9000, 'Done.', true),
];

test('A pending plan approval calls the person; an answered one is history', () => {
  const t = now - 60_000;
  const pending = parse([
    user('u1', t, 'plan it'),
    toolUse('a1', t + 1000, 'toolu_plan', 'ExitPlanMode'),
  ]);
  assert.equal(pending.status, 'call');
  assert.equal(pending.statusReason, ko.server.reason.planApproval);
  const plan = pending.events.find((e) => e.tool === 'ExitPlanMode')!;
  assert.equal(plan.intent, 'request-input');
  const notices = noticeCandidates(pending, now);
  assert.equal(notices.filter((n) => n.kind === 'attention').length, 1);
  assert.equal(unreadNoticeCount(notices), 1);

  const answered = parse(answeredPlan(t));
  assert.notEqual(answered.status, 'call');
  assert.equal(
    answered.events.find((e) => e.tool === 'ExitPlanMode')?.intent,
    'request-input',
    'the call itself is still what it was',
  );
  assert.deepEqual(
    noticeCandidates(answered, now).filter((n) => n.kind === 'attention'),
    [],
    'an answered request never becomes a call',
  );
  // The result alone closes it: no later message is needed.
  const justAnswered = parse(answeredPlan(t).slice(0, 3));
  assert.notEqual(justAnswered.status, 'call');
  assert.equal(noticeCandidates(justAnswered, now).filter((n) => n.kind === 'attention').length, 0);
});

test('Plan approval has its own tool label and localized reasons', () => {
  assert.equal(toolLabel('ExitPlanMode'), '플랜 승인');
  setLocale('en');
  try {
    assert.equal(toolLabel('ExitPlanMode'), 'Plan approval');
  } finally {
    setLocale('ko');
  }
  for (const key of ['planApproval', 'permissionPrompt', 'liveWaiting'] as const) {
    assert.equal(localizeReason(ko.server.reason[key], 'en'), en.server.reason[key]);
    assert.equal(localizeReason(ko.server.reason[key], 'ko'), ko.server.reason[key]);
  }
});

const processRecord = (pid: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid,
    sessionId: SID,
    procStart: START,
    kind: 'interactive',
    status: 'waiting',
    waitingFor: 'permission prompt',
    updatedAt: now,
    statusUpdatedAt: now,
    ...over,
  });

test('Live process records keep what a wait is for, and stay strict', () => {
  const parsed = parseClaudeProcess('4242.json', processRecord(4242, { statusUpdatedAt: 1234 }));
  assert.equal(parsed?.waitingFor, 'permission prompt');
  assert.equal(parsed?.statusUpdatedAt, 1234);
  const plain = parseClaudeProcess('4242.json', processRecord(4242, { waitingFor: undefined }));
  assert.ok(plain && !('waitingFor' in plain), 'absent fields stay absent');
  assert.equal(
    parseClaudeProcess('4242.json', processRecord(4242, { waitingFor: 'x'.repeat(200) }))
      ?.waitingFor,
    undefined,
  );
  assert.equal(
    parseClaudeProcess('4242.json', processRecord(4242, { statusUpdatedAt: 'soon' }))
      ?.statusUpdatedAt,
    undefined,
  );
  assert.equal(parseClaudeProcess('4242.json', processRecord(4242, { kind: 'sdk' })), null);
  assert.equal(parseClaudeProcess('4242.json', processRecord(4243)), null);
  assert.equal(parseClaudeProcess('4242.json', 'null'), null);
  assert.equal(parseClaudeProcess('4242.json', '{broken'), null);
  assert.equal(parseClaudeProcess('4242.json', ' '.repeat(70_000)), null);
});

/** A fake process table: `alive` pids, each started at `lstart` (default: as recorded). */
function liveDeps(sessionsDir: string, alive: number[], lstart: Record<number, string> = {}) {
  const calls: string[][] = [];
  const deps: ClaudeLiveDeps = {
    sessionsDir,
    alive: (pid) => alive.includes(pid),
    run: async (file, args) => {
      calls.push([file, ...args]);
      const pid = Number(args.at(-1));
      return file === '/bin/ps' && args.includes('lstart=') ? `${lstart[pid] ?? START}\n` : '';
    },
  };
  return { deps, calls };
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-live-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Only a live, verified, interactive and current wait is read', () =>
  withDir(async (dir) => {
    const wanted = new Set([SID]);
    const write = (name: string, text: string) => writeFile(path.join(dir, name), text);
    await write('4242.json', processRecord(4242));
    assert.equal((await waitingClaudeProcesses(liveDeps(dir, [4242]).deps, wanted)).size, 1);
    // Dead PID.
    assert.equal((await waitingClaudeProcesses(liveDeps(dir, []).deps, wanted)).size, 0);
    // Recycled PID: alive, but started at another time than the record says.
    const recycled = liveDeps(dir, [4242], { 4242: 'Wed Oct  7 09:00:00 2026' });
    assert.equal((await waitingClaudeProcesses(recycled.deps, wanted)).size, 0);
    // A failed ps check is retried, not remembered.
    let failing = true;
    const flaky: ClaudeLiveDeps = {
      ...liveDeps(dir, [4242]).deps,
      run: async () => (failing ? Promise.reject(new Error('ps')) : `${START}\n`),
    };
    assert.equal((await waitingClaudeProcesses(flaky, wanted)).size, 0);
    failing = false;
    assert.equal((await waitingClaudeProcesses(flaky, wanted)).size, 1);
    // Sessions nobody collected are never checked.
    const other = liveDeps(dir, [4242]);
    assert.equal((await waitingClaudeProcesses(other.deps, new Set(['other-session']))).size, 0);
    assert.equal(other.calls.length, 0);
    // Not waiting, non-interactive, malformed, misnamed: ignored.
    for (const text of [
      processRecord(4242, { status: 'busy' }),
      processRecord(4242, { kind: 'headless' }),
      '{"pid":4242,',
      processRecord(5151),
    ]) {
      await write('4242.json', text);
      assert.equal((await waitingClaudeProcesses(liveDeps(dir, [4242]).deps, wanted)).size, 0);
    }
    // A missing directory is simply no record.
    const missing = liveDeps(path.join(dir, 'missing'), [4242]).deps;
    assert.equal((await waitingClaudeProcesses(missing, wanted)).size, 0);
  }));

test('A live wait marks the pending call; stale or foreign records change nothing', () => {
  const t = now - 9 * 60_000;
  const s = parse([
    user('u1', t, 'run the tests'),
    toolUse('a1', t + 1000, 'toolu_read', 'Read'),
    toolResult('r1', t + 2000, 'toolu_read', 'contents'),
    toolUse('a2', t + 3000, 'toolu_bash', 'Bash'),
  ]);
  assert.notEqual(s.observedStatus, 'call');
  const live = parseClaudeProcess('4242.json', processRecord(4242, { statusUpdatedAt: t + 3100 }))!;
  const called = applyLiveWait(s, live, now)!;
  assert.equal(called.status, 'call');
  assert.equal(called.observedStatus, 'call');
  assert.equal(called.statusReason, ko.server.reason.permissionPrompt);
  assert.equal(called.runtime?.phase, 'needs-input');
  assert.notEqual(called.revision, s.revision);
  const marked = called.events.filter((e) => e.intent === 'request-input');
  assert.deepEqual(
    marked.map((e) => e.tool),
    ['Bash'],
    'only the call still waiting for its result',
  );
  assert.equal(s.events.find((e) => e.tool === 'Bash')?.intent, 'tool-use', 'input untouched');
  assert.equal(noticeCandidates(called, now).filter((n) => n.kind === 'attention').length, 1);
  // Calls pair with results by their native id: a later call that already ran is not the wait.
  const parallel = parse([
    user('u1', t, 'run the tests'),
    toolUse('a1', t + 1000, 'toolu_bash', 'Bash'),
    toolUse('a2', t + 1100, 'toolu_grep', 'Grep'),
    toolResult('r1', t + 1200, 'toolu_grep', 'found'),
  ]);
  assert.deepEqual(
    applyLiveWait(parallel, { ...live, statusUpdatedAt: t + 1300 }, now)!
      .events.filter((e) => e.intent === 'request-input')
      .map((e) => e.tool),
    ['Bash'],
  );
  // Unknown wait kinds still call, with a generic reason.
  assert.equal(
    applyLiveWait(s, { ...live, waitingFor: 'something new' }, now)?.statusReason,
    ko.server.reason.liveWaiting,
  );
  // A plan approval keeps its own reason.
  const plan = parse([
    user('u1', t, 'plan it'),
    toolUse('a1', t + 1000, 'toolu_plan', 'ExitPlanMode'),
  ]);
  assert.equal(applyLiveWait(plan, live, now)?.statusReason, ko.server.reason.planApproval);
  // Stale: the transcript recorded progress after the status was written.
  assert.equal(applyLiveWait(s, { ...live, statusUpdatedAt: t + 1500 }, now), null);
  assert.equal(applyLiveWait(s, { ...live, statusUpdatedAt: undefined, updatedAt: 0 }, now), null);
  // Not waiting, or another session's record.
  assert.equal(applyLiveWait(s, { ...live, status: 'busy' }, now), null);
  assert.equal(applyLiveWait(s, { ...live, sessionId: 'other-session-0000' }, now), null);
});

test('The collector shows a live permission prompt as a call, and drops it once answered', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-live-service-'));
  const projects = path.join(temp, 'projects');
  const sessionsDir = path.join(temp, 'sessions');
  await mkdir(path.join(projects, '-tmp-plan-project'), { recursive: true });
  await mkdir(sessionsDir);
  const t = now - 9 * 60_000;
  await writeFile(
    path.join(projects, '-tmp-plan-project', `${SID}.jsonl`),
    [user('u1', t, 'run the tests'), toolUse('a1', t + 1000, 'toolu_bash', 'Bash')]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  const status = (over: Record<string, unknown>) =>
    writeFile(path.join(sessionsDir, '4242.json'), processRecord(4242, over));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.claude = projects;
  service.live = liveDeps(sessionsDir, [4242]).deps;
  service.store.preferences({ enabledProviders: ['claude'] });
  const mine = (snapshot: Awaited<ReturnType<typeof service.refresh>>) =>
    snapshot.sessions.find((s) => s.nativeId === SID)!;
  try {
    await status({ status: 'busy', waitingFor: undefined, statusUpdatedAt: t + 1100 });
    let snapshot = await service.refresh();
    assert.notEqual(mine(snapshot).status, 'call');
    assert.equal(snapshot.noticeStats!.unread, 0);

    await status({ statusUpdatedAt: t + 1200 });
    snapshot = await service.refresh();
    assert.equal(mine(snapshot).status, 'call', 'the transcript did not change, the process did');
    assert.equal(mine(snapshot).statusReason, ko.server.reason.permissionPrompt);
    const calls = snapshot.notices!.filter((n) => n.kind === 'attention');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].resolvedAt, null);
    assert.equal(snapshot.noticeStats!.unread, 1);
    // Polling the same wait creates nothing new.
    snapshot = await service.refresh();
    assert.equal(snapshot.notices!.filter((n) => n.kind === 'attention').length, 1);
    assert.equal(snapshot.noticeStats!.unread, 1);

    await status({ status: 'busy', waitingFor: undefined, statusUpdatedAt: t + 30_000 });
    snapshot = await service.refresh();
    assert.notEqual(mine(snapshot).status, 'call', 'the overlay disappears with the wait');
    assert.ok(snapshot.notices!.find((n) => n.kind === 'attention')?.resolvedAt);
    assert.equal(snapshot.noticeStats!.unread, 0);

    // A process that died while waiting never calls.
    await status({ statusUpdatedAt: t + 1200 });
    service.live = liveDeps(sessionsDir, []).deps;
    snapshot = await service.refresh();
    assert.notEqual(mine(snapshot).status, 'call');
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

/** What the store kept from the parser before plan approvals were requests for input. */
const legacy = (s: Session): Session => ({
  ...s,
  events: s.events.map((e) => (e.tool === 'ExitPlanMode' ? { ...e, intent: 'tool-use' } : e)),
  status: s.status === 'call' ? 'work' : s.status,
  observedStatus: s.observedStatus === 'call' ? 'work' : s.observedStatus,
  revision: `legacy:${s.revision}`,
});

test('Upgrading never turns past plan approvals into new calls', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-plan-upgrade-'));
  const store = new OfficeStore(dir);
  try {
    // Answered plan approvals across a long history, already ingested and read.
    const history = parse([
      ...answeredPlan(now - 3 * 3600_000, 'a-'),
      ...answeredPlan(now - 2 * 3600_000, 'b-'),
    ]);
    assert.equal(history.events.filter((e) => e.tool === 'ExitPlanMode').length, 2);
    store.upsert([legacy(history)], 'claude');
    store.upsert([legacy(history)], 'claude');
    store.noticeReceipt(store.noticeList(), 'read');
    const before = store.noticeList();
    assert.equal(unreadNoticeCount(before), 0);

    store.upsert([history], 'claude');
    const after = store.noticeList();
    assert.equal(unreadNoticeCount(after), 0, 'unread count unchanged');
    assert.equal(after.filter((n) => n.kind === 'attention').length, 0, 'no new attention notice');
    assert.deepEqual(after.map((n) => n.id).sort(), before.map((n) => n.id).sort());
    assert.notEqual(store.get(history.id).status, 'call');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('An abandoned plan approval older than the off-duty time is not news after an upgrade', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-plan-abandoned-'));
  const store = new OfficeStore(dir);
  try {
    const t = now - 2 * 86400_000;
    const abandoned = parse([
      user('u1', t, 'plan it'),
      toolUse('a1', t + 1000, 'toolu_plan', 'ExitPlanMode'),
    ]);
    store.upsert([legacy(abandoned)], 'claude');
    store.upsert([abandoned], 'claude');
    assert.equal(store.noticeList().filter((n) => n.kind === 'attention').length, 0);
    assert.equal(unreadNoticeCount(store.noticeList()), 0);
    assert.equal(store.get(abandoned.id).status, 'sleep', 'gone home like any old call');

    // One that is pending right now is a real call, also right after the upgrade.
    const current = parse([
      user('u1', now - 60_000, 'plan it'),
      toolUse('a1', now - 30_000, 'toolu_plan', 'ExitPlanMode'),
    ]);
    const id = { ...current, id: 'claude:current', nativeId: 'current' };
    store.upsert([legacy(id)], 'claude');
    store.upsert([id], 'claude');
    const calls = store.noticeList().filter((n) => n.kind === 'attention');
    assert.equal(calls.length, 1);
    assert.equal(unreadNoticeCount(store.noticeList()), 1);

    // Answering it resolves the call through its own result.
    const answered = parse([
      user('u1', now - 60_000, 'plan it'),
      toolUse('a1', now - 30_000, 'toolu_plan', 'ExitPlanMode'),
      toolResult('r1', now - 20_000, 'toolu_plan', 'User has approved your plan.'),
    ]);
    store.upsert([{ ...answered, id: 'claude:current', nativeId: 'current' }], 'claude');
    assert.equal(store.noticeList().find((n) => n.kind === 'attention')?.resolvedAt, now - 20_000);
    assert.equal(unreadNoticeCount(store.noticeList()), 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
