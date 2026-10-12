import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeService, HOT_DEFAULTS } from '../server/service.js';
import { OfficeStore } from '../server/store.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { readClaudeProcessesCached, type ClaudeLiveDeps } from '../server/adapters/claude-live.js';
import type { Session, Snapshot } from '../src/shared/types.js';
import type { SnapshotPatch } from '../src/shared/snapshot-patch.js';

const START = 'Tue Oct  6 13:05:12 2026';
const iso = (at: number) => new Date(at).toISOString();
const sid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const line = (r: object) => JSON.stringify(r) + '\n';
const user = (id: string, at: number, text: string) =>
  line({
    type: 'user',
    sessionId: id,
    uuid: `u-${at}`,
    timestamp: iso(at),
    cwd: '/tmp/hot-demo',
    message: { role: 'user', content: text },
  });
/** A progress message with a tool call: the colleague is at work. */
const progress = (id: string, at: number, text: string, tool = `toolu_${at}`) =>
  line({
    type: 'assistant',
    sessionId: id,
    uuid: `a-${at}`,
    timestamp: iso(at),
    message: {
      id: `m-${at}`,
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: tool, name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
const final = (id: string, at: number, text: string) =>
  line({
    type: 'assistant',
    sessionId: id,
    uuid: `f-${at}`,
    timestamp: iso(at),
    message: {
      id: `m-${at}`,
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake process table: every pid in `alive` started at START. */
const liveDeps = (sessionsDir: string, alive: number[]): ClaudeLiveDeps => ({
  sessionsDir,
  alive: (pid) => alive.includes(pid),
  run: async (file, args) => (file === '/bin/ps' && args.includes('lstart=') ? `${START}\n` : ''),
});
const processRecord = (pid: number, sessionId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid,
    sessionId,
    procStart: START,
    kind: 'interactive',
    status: 'busy',
    updatedAt: Date.now(),
    statusUpdatedAt: Date.now(),
    ...over,
  });

/** A Claude home under a temporary directory, with a service watching it. */
async function office(watch = false) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-hot-'));
  const project = path.join(temp, 'projects', '-tmp-hot-demo');
  const sessionsDir = path.join(temp, 'sessions');
  await mkdir(project, { recursive: true });
  await mkdir(sessionsDir);
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.claude = path.join(temp, 'projects');
  service.live = liveDeps(sessionsDir, []);
  service.store.preferences({ enabledProviders: ['claude'] });
  service.hot = { ...HOT_DEFAULTS, minMs: 0, watch };
  const reads: string[] = [];
  /** Slows every read down, so overlapping passes would both read. */
  const slow = { ms: 0 };
  const read = service.windows.read.bind(service.windows);
  service.windows.read = async (f) => {
    reads.push(f.path);
    if (slow.ms) await sleep(slow.ms);
    return read(f);
  };
  const sent: { snapshot: Snapshot; patch: SnapshotPatch | null }[] = [];
  service.on('snapshot', (snapshot, patch) => sent.push({ snapshot, patch }));
  const file = (id: string) => path.join(project, `${id}.jsonl`);
  const stored = (id: string) => service.store.list().find((s) => s.nativeId === id)!;
  const done = async () => {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  };
  return { temp, project, sessionsDir, service, reads, slow, sent, file, stored, done };
}

test('An append to a working colleague is stored and sent by the next hot tick, as the full pass makes it', async () => {
  const o = await office();
  const hot = sid(1);
  const cold = sid(2);
  const now = Date.now();
  try {
    await writeFile(
      o.file(hot),
      user(hot, now - 5000, '일해 줘') + progress(hot, now - 4000, '보는 중'),
    );
    await writeFile(
      o.file(cold),
      user(cold, now - 3600_000, '옛날') + final(cold, now - 3599_000, '끝'),
    );
    await o.service.refresh();
    assert.deepEqual(
      o.service.hotSessions().map((id) => o.service.store.get(id).nativeId),
      [hot],
      'only the working colleague is hot',
    );
    const collect = (o.service as any).collect;
    let full = 0;
    (o.service as any).collect = function () {
      full++;
      return collect.call(this);
    };
    o.reads.length = 0;
    o.sent.length = 0;

    await appendFile(o.file(hot), progress(hot, Date.now(), '새로 붙은 진행 상황'));
    await o.service.hotTick();
    assert.equal(full, 0, 'no full pass ran');
    assert.deepEqual(o.reads, [o.file(hot)], 'only the hot file was read');
    assert.ok(JSON.stringify(o.stored(hot)).includes('새로 붙은 진행 상황'));
    assert.equal(o.sent.length, 1);
    assert.ok(o.sent[0].patch, 'sent as a patch');
    assert.ok(JSON.stringify(o.sent[0].patch).includes('새로 붙은 진행 상황'));
    const hotRevision = o.stored(hot).revision;

    // Nothing moved: a tick stores and sends nothing.
    await o.service.hotTick();
    assert.equal(o.sent.length, 1);

    // The full pass finds the hot result in its parse cache and makes the same session.
    await o.service.refresh();
    assert.equal(full, 1);
    assert.deepEqual(o.reads, [o.file(hot)], 'no file was read twice');
    assert.equal(o.stored(hot).revision, hotRevision);
    // A fresh collector over the same files agrees.
    const fresh = new OfficeService(path.join(o.temp, 'fresh'), o.temp);
    fresh.roots.claude = o.service.roots.claude;
    fresh.live = o.service.live;
    fresh.store.preferences({ enabledProviders: ['claude'] });
    try {
      const again = (await fresh.refresh()).sessions.find((s) => s.nativeId === hot)!;
      assert.equal(again.revision, hotRevision);
    } finally {
      fresh.stop();
    }
  } finally {
    await o.done();
  }
});

test('Working, calling and just-answered colleagues are hot; quiet ones and the overflow are not', async () => {
  const o = await office();
  const now = Date.now();
  try {
    // Ten at work, a minute apart in their latest activity (newest first: 10, 9, ...).
    for (let n = 1; n <= 10; n++)
      await writeFile(
        o.file(sid(n)),
        user(sid(n), now - 60_000, '일') + progress(sid(n), now - 60_000 + n * 1000, `진행 ${n}`),
      );
    const quiet = sid(20);
    const answered = sid(21);
    await writeFile(
      o.file(quiet),
      user(quiet, now - 600_000, '일') + progress(quiet, now - 590_000, '오래된 진행'),
    );
    await writeFile(
      o.file(answered),
      user(answered, now - 2000, '질문') + final(answered, now - 1000, '답'),
    );
    o.service.hot.graceMs = 1500;
    await o.service.refresh();
    const hot = o.service.hotSessions().map((id) => o.service.store.get(id).nativeId);
    assert.equal(hot.length, HOT_DEFAULTS.max, 'capped');
    assert.deepEqual(hot, [answered, sid(10), sid(9), sid(8), sid(7), sid(6), sid(5), sid(4)]);
    assert.ok(!hot.includes(quiet), 'quiet for minutes: standing by, not hot');

    // The final reply's grace runs out.
    await sleep(600);
    await o.service.hotTick();
    assert.ok(!o.service.hotSessions().some((id) => o.service.store.get(id).nativeId === answered));
    assert.equal(o.service.hotSessions().length, HOT_DEFAULTS.max);

    // Turning the provider off empties the hot path.
    o.service.store.preferences({ enabledProviders: ['codex'] });
    await o.service.refresh();
    assert.deepEqual(o.service.hotSessions(), []);
  } finally {
    await o.done();
  }
});

test('A live busy process promotes its colleague, and a permission wait shows on the hot path', async () => {
  const o = await office();
  const id = sid(3);
  const now = Date.now();
  try {
    await writeFile(
      o.file(id),
      user(id, now - 3600_000, '옛날 일') + final(id, now - 3599_000, '끝'),
    );
    await o.service.refresh();
    assert.deepEqual(o.service.hotSessions(), [], 'answered an hour ago: not hot');

    // The person sends a new request: the process is busy before the transcript says much.
    const record = path.join(o.sessionsDir, '4242.json');
    await writeFile(record, processRecord(4242, id));
    o.service.live = liveDeps(o.sessionsDir, [4242]);
    await o.service.hotTick();
    assert.deepEqual(
      o.service.hotSessions().map((x) => o.service.store.get(x).nativeId),
      [id],
    );

    // The request and a tool call arrive; then the process waits for a permission.
    const t = Date.now();
    await appendFile(
      o.file(id),
      user(id, t, '테스트 돌려 줘') + progress(id, t + 10, '돌립니다', 'toolu_bash'),
    );
    await o.service.hotTick();
    assert.equal(o.stored(id).status, 'work');
    await writeFile(
      record,
      processRecord(4242, id, {
        status: 'waiting',
        waitingFor: 'permission prompt',
        statusUpdatedAt: t + 20,
      }),
    );
    await o.service.hotTick();
    assert.equal(o.stored(id).status, 'call', 'the wait shows without a full pass');
    const called = o.stored(id).revision;
    await o.service.refresh();
    assert.equal(o.stored(id).revision, called, 'the full pass agrees');

    // Answered and idle again: the wait disappears and the promotion ends.
    await writeFile(record, processRecord(4242, id, { status: 'idle' }));
    await o.service.hotTick();
    assert.notEqual(o.stored(id).status, 'call');
  } finally {
    await o.done();
  }
});

test('The hot path never runs alongside a full pass, nor reads a file twice', async () => {
  const o = await office();
  const id = sid(4);
  const now = Date.now();
  try {
    await writeFile(o.file(id), user(id, now - 5000, '일') + progress(id, now - 4000, '진행'));
    await o.service.refresh();
    o.reads.length = 0;
    o.slow.ms = 50;

    // A full pass in flight: a hot tick does nothing.
    await appendFile(o.file(id), progress(id, Date.now(), '하나'));
    const full = o.service.refresh();
    await o.service.hotTick();
    await full;
    assert.deepEqual(o.reads, [o.file(id)]);
    assert.ok(JSON.stringify(o.stored(id)).includes('하나'));

    // A hot pass in flight: the full pass waits for it, then finds its result cached.
    o.reads.length = 0;
    await appendFile(o.file(id), progress(id, Date.now() + 1, '둘'));
    const hot = o.service.hotTick();
    const after = o.service.refresh();
    await Promise.all([hot, after]);
    assert.deepEqual(o.reads, [o.file(id)]);
    assert.ok(JSON.stringify(o.stored(id)).includes('둘'));
  } finally {
    await o.done();
  }
});

test('A watch hint updates within a moment; a failed watch falls back to the stat tick', async () => {
  const o = await office(true);
  const id = sid(5);
  const now = Date.now();
  try {
    o.service.hot.debounceMs = 20;
    await writeFile(o.file(id), user(id, now - 5000, '일') + progress(id, now - 4000, '진행'));
    await o.service.refresh();
    assert.deepEqual(o.service.watchedFiles(), [o.file(id)]);

    // No tick, no full pass: the watch alone brings the change in.
    o.sent.length = 0;
    const started = Date.now();
    await appendFile(o.file(id), progress(id, Date.now(), '감시로 들어옴'));
    while (!o.sent.some((s) => JSON.stringify(s.patch).includes('감시로 들어옴'))) {
      assert.ok(Date.now() - started < 3000, 'the hint was processed');
      await sleep(10);
    }

    // The watch breaks: it is dropped, and the stat tick still sees the next change.
    (o.service as any).watchers.get(o.file(id)).emit('error', new Error('watch failed'));
    assert.deepEqual(o.service.watchedFiles(), []);
    await appendFile(o.file(id), progress(id, Date.now() + 1, '확인으로 들어옴'));
    await o.service.hotTick();
    assert.ok(JSON.stringify(o.stored(id)).includes('확인으로 들어옴'));
    assert.deepEqual(o.service.watchedFiles(), [], 'not retried while it stays hot');
  } finally {
    await o.done();
  }
});

test('stop() leaves no hot timer or file watch behind', async () => {
  const o = await office(true);
  const id = sid(6);
  const now = Date.now();
  await writeFile(o.file(id), user(id, now - 5000, '일') + progress(id, now - 4000, '진행'));
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  o.service.hot.tickMs = 50;
  o.service.start();
  await o.service.refresh();
  assert.equal(o.service.watchedFiles().length, 1);
  await appendFile(o.file(id), progress(id, Date.now(), '마지막'));
  await sleep(120);
  await o.done();
  assert.deepEqual(o.service.watchedFiles(), []);
  assert.deepEqual(o.service.hotSessions(), []);
  assert.equal((o.service as any).hotTimer, null);
  assert.equal((o.service as any).hintTimer, null);
  assert.equal((o.service as any).timer, null);
  assert.ok(timers() <= before, 'no timer left running');
  assert.ok(!process.getActiveResourcesInfo().includes('FSEventWrap'), 'no watch left open');
});

test('A partial upsert keeps the provider’s other stored sessions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-partial-'));
  const store = new OfficeStore(dir);
  const at = Date.now() - 60_000;
  const parse = (id: string, text: string): Session =>
    parseRecords([JSON.parse(user(id, at, text)), JSON.parse(final(id, at + 1000, text))], {
      provider: 'claude',
      sourcePath: `/tmp/${id}.jsonl`,
      mtime: at,
    });
  try {
    const a = parse(sid(7), '하나');
    const b = parse(sid(8), '둘');
    store.upsert([a, b], 'claude');
    store.upsert([{ ...a, title: '바뀜', revision: 'next' }], 'claude', true);
    assert.equal(store.list().length, 2, 'the partial pass deleted nothing');
    assert.equal(store.get(a.id).title, '바뀜');
    store.upsert([a], 'claude');
    assert.deepEqual(
      store.list().map((s) => s.id),
      [a.id],
      'a full pass still deletes what it no longer lists',
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Live process records read every second are parsed again only when they move', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-live-cache-'));
  const cache = new Map();
  try {
    const file = path.join(dir, '4242.json');
    await writeFile(file, processRecord(4242, sid(9), { status: 'busy' }));
    assert.equal((await readClaudeProcessesCached(dir, cache))[0].status, 'busy');
    const entry = cache.get('4242.json');
    assert.equal((await readClaudeProcessesCached(dir, cache))[0].status, 'busy');
    assert.equal(cache.get('4242.json'), entry, 'unchanged: not parsed again');
    // Same size, new content and mtime.
    await writeFile(file, processRecord(4242, sid(9), { status: 'idle' }));
    await utimes(file, new Date(), new Date(Date.now() + 2000));
    assert.equal((await readClaudeProcessesCached(dir, cache))[0].status, 'idle');
    await rm(file);
    assert.deepEqual(await readClaudeProcessesCached(dir, cache), []);
    assert.equal(cache.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
