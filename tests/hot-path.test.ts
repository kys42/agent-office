import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeService, HOT_DEFAULTS } from '../server/service.js';
import { OfficeStore } from '../server/store.js';
import { ServiceBridge } from '../server/bridge.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { readClaudeProcessesCached, type ClaudeLiveDeps } from '../server/adapters/claude-live.js';
import type { Session, Snapshot } from '../src/shared/types.js';
import { applyPatch, type SnapshotPatch } from '../src/shared/snapshot-patch.js';

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

/** A snapshot as a client holds it (JSON), version aside. */
const plain = (s: Snapshot) => JSON.parse(JSON.stringify({ ...s, version: 0 }));

test('A hot pass sends only what changed, and the patched office equals a full rebuild', async () => {
  const o = await office();
  const now = Date.now();
  const parent = sid(11);
  const other = sid(12);
  const child = path.join(o.project, parent, 'subagents', 'agent-a17.jsonl');
  const helper = (at: number, text: string) =>
    line({
      type: 'assistant',
      sessionId: parent,
      agentId: 'a17',
      isSidechain: true,
      uuid: `h-${at}`,
      timestamp: iso(at),
      cwd: '/tmp/hot-demo',
      message: {
        id: `hm-${at}`,
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text },
          { type: 'tool_use', id: `toolu_h${at}`, name: 'Read', input: {} },
        ],
      },
    });
  try {
    await mkdir(path.dirname(child), { recursive: true });
    await writeFile(
      o.file(parent),
      user(parent, now - 9000, '같이 일해 줘') + progress(parent, now - 8000, '나눠 맡김'),
    );
    await writeFile(child, helper(now - 7000, '도우미 시작'));
    await writeFile(
      o.file(other),
      user(other, now - 6000, '다른 일') + progress(other, now - 5000, '진행'),
    );
    for (let n = 20; n < 40; n++)
      await writeFile(
        o.file(sid(n)),
        user(sid(n), now - 7200_000 + n, '옛일') + final(sid(n), now - 7100_000 + n, `끝 ${n}`),
      );
    await o.service.refresh();
    assert.equal(o.service.hotSessions().length, 3, 'parent, helper and the other at work');
    const view = o.service.store.officeView;
    let rebuilt = 0;
    o.service.store.officeView = function (...args) {
      rebuilt++;
      return view.apply(this, args);
    };
    const check = async (step: string) => {
      const before = (await o.service.call('snapshot')) as Snapshot;
      o.sent.length = 0;
      await o.service.hotTick();
      assert.equal(rebuilt, 0, `${step}: the office was not rebuilt`);
      assert.equal(o.sent.length, 1, `${step}: one patch`);
      const { patch, snapshot } = o.sent[0];
      assert.ok(patch && patch.base === before.version && patch.version === snapshot.version);
      // What a client holding the previous version ends up with…
      assert.deepEqual(plain(applyPatch(before, patch)), plain(snapshot));
      assert.deepEqual(plain((await o.service.call('snapshot')) as Snapshot), plain(snapshot));
      // …is exactly the office rebuilt from scratch right after.
      assert.deepEqual(plain(snapshot), plain(o.service.snapshot()), step);
      rebuilt = 0;
      return patch;
    };

    await appendFile(o.file(parent), progress(parent, Date.now(), '부모가 더 진행'));
    const one = await check('parent');
    assert.deepEqual(
      one.sessions?.map((s) => s.nativeId),
      [parent],
      'only the parent row',
    );

    await appendFile(child, helper(Date.now(), '도우미가 더 진행'));
    const two = await check('helper');
    assert.equal(
      two.sessions?.[0].attachedTo,
      o.service.store.list().find((s) => s.nativeId === parent)!.id,
    );

    // A final reply: a new notice, counts move, the colleague moves to the top.
    await appendFile(o.file(other), final(other, Date.now(), '다 끝났어요'));
    const three = await check('final reply');
    assert.ok(three.notices?.some((n) => n.text.includes('다 끝났어요')));
    assert.ok(three.fields?.noticeStats);

    // Two at once, then the full pass agrees and has nothing to add.
    await appendFile(o.file(parent), progress(parent, Date.now() + 1, '부모 하나 더'));
    await appendFile(child, helper(Date.now() + 2, '도우미 하나 더'));
    await check('both');
    o.service.store.officeView = view;
    o.sent.length = 0;
    await o.service.refresh();
    assert.equal(o.sent.length, 0, 'the full pass found nothing new to send');
  } finally {
    await o.done();
  }
});

test('A hot change that could move someone else falls back to the full rebuild', async () => {
  const o = await office();
  const id = sid(13);
  const now = Date.now();
  try {
    await writeFile(o.file(id), user(id, now - 5000, '일') + progress(id, now - 4000, '진행'));
    await o.service.refresh();
    // Pinned meanwhile (a zone/standing change the published office does not know yet).
    const stored = o.service.store.list().find((s) => s.nativeId === id)!;
    o.service.store.pin([stored.id], true);
    const view = o.service.store.officeView;
    let rebuilt = 0;
    o.service.store.officeView = function (...args) {
      rebuilt++;
      return view.apply(this, args);
    };
    o.sent.length = 0;
    await appendFile(o.file(id), progress(id, Date.now(), '핀 꽂힌 뒤 진행'));
    await o.service.hotTick();
    assert.equal(rebuilt, 1, 'rebuilt in full');
    assert.equal(o.sent.length, 1);
    assert.equal(o.sent[0].snapshot.sessions.find((s) => s.nativeId === id)!.pinned, true);
    assert.deepEqual(plain(o.sent[0].snapshot), plain(o.service.snapshot()));
  } finally {
    await o.done();
  }
});

test('A hot notice that pushes an old one out of the carried set removes it in the patch', async () => {
  const o = await office();
  const id = sid(14);
  const now = Date.now();
  try {
    // A burst of requests from under two minutes ago: all of them are news, each a notice.
    let body = '';
    for (let n = 0; n < 105; n++) body += user(id, now - 118_000 + n * 350, `요청 ${n}번`);
    await writeFile(o.file(id), body);
    await o.service.refresh();
    const before = (await o.service.call('snapshot')) as Snapshot;
    assert.ok((before.noticeStats?.total ?? 0) > 100, 'more notices than the office carries');
    o.sent.length = 0;
    await appendFile(o.file(id), user(id, Date.now(), '새 요청'));
    await o.service.hotTick();
    const { patch, snapshot } = o.sent[0];
    assert.ok(patch?.removedNotices?.length, 'an old notice left the carried set');
    assert.deepEqual(plain(applyPatch(before, patch!)), plain(snapshot));
    assert.deepEqual(plain(snapshot), plain(o.service.snapshot()));
  } finally {
    await o.done();
  }
});

/** What is on disk for a session, bypassing everything staged in memory. */
const onDisk = (store: OfficeStore, id: string) => {
  const row = store.db.prepare('SELECT data FROM sessions WHERE id=?').get(id) as
    { data: string } | undefined;
  const notices = (
    store.db.prepare('SELECT data FROM notices WHERE session_id=? ORDER BY id').all(id) as {
      data: string;
    }[]
  ).map((r) => JSON.parse(r.data));
  return { revision: row ? (JSON.parse(row.data) as Session).revision : null, notices };
};

test('A hot pass writes nothing; the next full pass writes exactly what was shown', async () => {
  const o = await office();
  const id = sid(15);
  const now = Date.now();
  try {
    await writeFile(o.file(id), user(id, now - 5000, '일') + progress(id, now - 4000, '진행'));
    await o.service.refresh();
    const key = o.stored(id).id;
    const before = onDisk(o.service.store, key);

    await appendFile(o.file(id), final(id, Date.now(), '디스크에는 아직 없음'));
    await o.service.hotTick();
    const shown = (await o.service.call('snapshot')) as Snapshot;
    assert.ok(JSON.stringify(shown).includes('디스크에는 아직 없음'), 'shown at once');
    assert.deepEqual(onDisk(o.service.store, key), before, 'nothing written');
    assert.deepEqual(o.service.store.stagedIds(), [key]);
    // Every reader of the store sees it: the work card's newest page, search.
    const page = o.service.store.detail(key);
    assert.ok(JSON.stringify(page).includes('디스크에는 아직 없음'));
    assert.ok(page.notices?.some((n) => n.text.includes('디스크에는 아직 없음')));
    assert.ok(o.service.store.search('디스크에는').length);

    o.sent.length = 0;
    await o.service.refresh();
    assert.deepEqual(o.service.store.stagedIds(), []);
    const after = onDisk(o.service.store, key);
    assert.equal(after.revision, o.stored(id).revision, 'the shown row is on disk');
    assert.ok(after.notices.some((n) => n.text.includes('디스크에는 아직 없음')));
    assert.equal(o.sent.length, 0, 'writing it changed nothing that is shown');
  } finally {
    await o.done();
  }
});

test('A notice read before the full pass writes it stays read, once', async () => {
  const o = await office();
  const id = sid(16);
  const now = Date.now();
  try {
    await writeFile(o.file(id), user(id, now - 5000, '질문') + progress(id, now - 4000, '보는 중'));
    await o.service.refresh();
    await appendFile(o.file(id), final(id, Date.now(), '답을 찾았어요'));
    await o.service.hotTick();
    const shown = (await o.service.call('snapshot')) as Snapshot;
    const reply = shown.notices!.find((n) => n.text.includes('답을 찾았어요'))!;
    assert.ok(reply && !reply.seenAt, 'arrives unread');
    const unread = shown.noticeStats!.unread;

    // The person reads it while it is only in memory.
    const read = (await o.service.call('notices', [
      [{ id: reply.id, version: reply.version }],
      'read',
    ])) as Snapshot;
    assert.ok(read.notices!.find((n) => n.id === reply.id)!.seenAt);
    assert.equal(read.noticeStats!.unread, unread - 1);

    o.sent.length = 0;
    await o.service.refresh();
    const after = (await o.service.call('snapshot')) as Snapshot;
    const kept = after.notices!.filter((n) => n.text.includes('답을 찾았어요'));
    assert.equal(kept.length, 1, 'no duplicate');
    assert.ok(kept[0].seenAt, 'still read');
    assert.equal(kept[0].receivedAt, reply.receivedAt, 'the same notice, not a new arrival');
    assert.equal(after.noticeStats!.unread, unread - 1, 'no unread flicker');
    assert.equal(o.sent.length, 0);
    assert.ok(
      onDisk(o.service.store, reply.sessionId).notices.find((n) => n.id === reply.id).seenAt,
    );
  } finally {
    await o.done();
  }
});

test('Staged and written right away make the same notices', async () => {
  const hot = await office();
  const cold = await office();
  const id = sid(17);
  const now = Date.now();
  const strip = (notices: Record<string, unknown>[]) =>
    notices.map(({ receivedAt: _r, ...n }) => n);
  try {
    const start = user(id, now - 9000, '요청') + progress(id, now - 8000, '진행', 'toolu_a');
    const more = [
      progress(id, now - 3000, '더 진행', 'toolu_b'),
      user(id, now - 2000, '추가 요청'),
      final(id, now - 1000, '모두 끝'),
    ];
    for (const o of [hot, cold]) await writeFile(o.file(id), start);
    await Promise.all([hot.service.refresh(), cold.service.refresh()]);
    for (const line of more) {
      await appendFile(hot.file(id), line);
      await hot.service.hotTick();
    }
    await appendFile(cold.file(id), more.join(''));
    await Promise.all([hot.service.refresh(), cold.service.refresh()]);
    const key = hot.stored(id).id;
    const a = onDisk(hot.service.store, key);
    const b = onDisk(cold.service.store, key);
    // Revisions differ (they hash each file's own size and mtime); the notices may not.
    assert.ok(a.notices.length >= 3);
    assert.deepEqual(strip(a.notices), strip(b.notices));
  } finally {
    await hot.done();
    await cold.done();
  }
});

test('Closing the collector writes what the hot path staged', async () => {
  const o = await office();
  const id = sid(18);
  const now = Date.now();
  try {
    await writeFile(o.file(id), user(id, now - 5000, '일') + progress(id, now - 4000, '진행'));
    await o.service.refresh();
    await appendFile(o.file(id), final(id, Date.now(), '닫기 전에 끝남'));
    await o.service.hotTick();
    const key = o.stored(id).id;
    const revision = o.stored(id).revision;
    o.service.stop();
    const store = new OfficeStore(path.join(o.temp, 'data'));
    try {
      const disk = onDisk(store, key);
      assert.equal(disk.revision, revision);
      assert.ok(disk.notices.some((n) => n.text.includes('닫기 전에 끝남')));
    } finally {
      store.close();
    }
  } finally {
    await rm(o.temp, { recursive: true, force: true });
  }
});

test('A live wait shown only by the hot path is resolved when it ends before the full pass', async () => {
  const o = await office();
  const id = sid(19);
  const now = Date.now();
  try {
    await writeFile(
      o.file(id),
      user(id, now - 5000, '테스트 돌려 줘') + progress(id, now - 4000, '돌립니다', 'toolu_bash'),
    );
    o.service.live = liveDeps(o.sessionsDir, [4242]);
    const record = path.join(o.sessionsDir, '4242.json');
    await o.service.refresh();
    await writeFile(
      record,
      processRecord(4242, id, {
        status: 'waiting',
        waitingFor: 'permission prompt',
        statusUpdatedAt: now - 3000,
      }),
    );
    await o.service.hotTick();
    assert.equal(o.stored(id).status, 'call');
    const call = ((await o.service.call('snapshot')) as Snapshot).notices!.find(
      (n) => n.kind === 'attention',
    )!;
    assert.ok(call && !call.resolvedAt);

    // Approved; the transcript has not moved yet. The full pass comes before any hot pass.
    await writeFile(
      record,
      processRecord(4242, id, { status: 'busy', statusUpdatedAt: now - 1000 }),
    );
    await o.service.refresh();
    assert.notEqual(o.stored(id).status, 'call');
    const after = (await o.service.call('snapshot')) as Snapshot;
    assert.ok(after.notices!.find((n) => n.id === call.id)?.resolvedAt, 'the call is resolved');
    assert.ok(
      onDisk(o.service.store, call.sessionId).notices.find((n) => n.id === call.id).resolvedAt,
    );
  } finally {
    await o.done();
  }
});

test('A promotion is checked again every pass: a dead process frees its slot', async () => {
  const o = await office();
  const id = sid(20);
  const now = Date.now();
  try {
    await writeFile(o.file(id), user(id, now - 3600_000, '옛일') + final(id, now - 3599_000, '끝'));
    await o.service.refresh();
    await writeFile(path.join(o.sessionsDir, '4242.json'), processRecord(4242, id));
    o.service.live = liveDeps(o.sessionsDir, [4242]);
    await o.service.hotTick();
    assert.equal(o.service.hotSessions().length, 1, 'promoted');
    // The process died; its record still says busy.
    o.service.live = liveDeps(o.sessionsDir, []);
    await o.service.hotTick();
    assert.deepEqual(o.service.hotSessions(), [], 'demoted');
  } finally {
    await o.done();
  }
});

test('A receipt on a hot-shown notice is on disk at once', async () => {
  const o = await office();
  const id = sid(21);
  const now = Date.now();
  try {
    await writeFile(o.file(id), user(id, now - 5000, '질문') + progress(id, now - 4000, '보는 중'));
    await o.service.refresh();
    await appendFile(o.file(id), final(id, Date.now(), '바로 저장될 읽음'));
    await o.service.hotTick();
    const reply = ((await o.service.call('snapshot')) as Snapshot).notices!.find((n) =>
      n.text.includes('바로 저장될 읽음'),
    )!;
    await o.service.call('notices', [[{ id: reply.id, version: reply.version }], 'read']);
    const disk = onDisk(o.service.store, reply.sessionId).notices.find((n) => n.id === reply.id);
    assert.ok(disk?.seenAt, 'written before any full pass');
    const shown = ((await o.service.call('snapshot')) as Snapshot).notices!.find(
      (n) => n.id === reply.id,
    )!;
    o.sent.length = 0;
    await o.service.refresh();
    assert.deepEqual(
      onDisk(o.service.store, reply.sessionId).notices.find((n) => n.id === reply.id),
      (({ background: _shownOnly, ...stored }) => stored)(JSON.parse(JSON.stringify(shown))),
      'the full pass wrote the same notice',
    );
    assert.equal(o.sent.length, 0);
  } finally {
    await o.done();
  }
});

test('shutdown() waits for passes in flight, then writes what was staged', async () => {
  const o = await office();
  const id = sid(22);
  const now = Date.now();
  try {
    await writeFile(o.file(id), user(id, now - 5000, '일') + progress(id, now - 4000, '진행'));
    await o.service.refresh();
    const key = o.stored(id).id;
    // A hot pass in flight (slow read) when the app quits.
    o.slow.ms = 150;
    await appendFile(o.file(id), final(id, Date.now(), '끝나기 직전'));
    const hot = o.service.hotTick();
    await sleep(20);
    await o.service.shutdown();
    await hot;
    const store = new OfficeStore(path.join(o.temp, 'data'));
    try {
      assert.ok(
        onDisk(store, key).notices.some((n) => n.text.includes('끝나기 직전')),
        'the pass finished and its staged notice was written on close',
      );
    } finally {
      store.close();
    }
    // A full pass in flight is waited for as well.
    const again = new OfficeService(path.join(o.temp, 'data2'), o.temp);
    again.roots.claude = o.service.roots.claude;
    again.store.preferences({ enabledProviders: ['claude'] });
    const read = again.windows.read.bind(again.windows);
    again.windows.read = async (f) => (await sleep(100), read(f));
    const full = again.refresh().catch(() => null);
    await sleep(20);
    await again.shutdown();
    await full;
    const second = new OfficeStore(path.join(o.temp, 'data2'));
    try {
      assert.ok(onDisk(second, key).revision, 'the full pass wrote before the store closed');
    } finally {
      second.close();
    }
  } finally {
    await rm(o.temp, { recursive: true, force: true });
  }
});

test('The bridge asks the collector to stop and waits, but not forever', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-bridge-'));
  try {
    const polite = path.join(dir, 'polite.mjs');
    const stuck = path.join(dir, 'stuck.mjs');
    await writeFile(
      polite,
      "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', (m) => m.stop && setTimeout(() => parentPort.postMessage({ stopped: true }), 150));\nsetInterval(() => {}, 1000);\n",
    );
    await writeFile(stuck, 'setInterval(() => {}, 1000);\n');
    let t = Date.now();
    await new ServiceBridge(polite).close(3000);
    const waited = Date.now() - t;
    assert.ok(waited >= 140 && waited < 2000, `waited for the stop reply (${waited}ms)`);
    t = Date.now();
    await new ServiceBridge(stuck).close(300);
    const gaveUp = Date.now() - t;
    assert.ok(gaveUp >= 290 && gaveUp < 2000, `gave up after the timeout (${gaveUp}ms)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Hot patches do not hold back the once-a-minute check time', async () => {
  const o = await office();
  const id = sid(23);
  const now = Date.now();
  try {
    await writeFile(o.file(id), user(id, now - 5000, '일') + progress(id, now - 4000, '진행'));
    await o.service.refresh();
    await appendFile(o.file(id), progress(id, Date.now(), '계속'));
    await o.service.hotTick();
    // A minute since the last whole office went out, but a hot patch just now.
    (o.service as any).healthAt = Date.now() - 61_000;
    o.sent.length = 0;
    await o.service.refresh();
    assert.equal(o.sent.length, 1, 'the check time went out');
    assert.ok(o.sent[0].patch?.fields?.lastSync);
  } finally {
    await o.done();
  }
});

test('A hot change of an unattached helper is sent from a full rebuild', async () => {
  const o = await office();
  const parent = sid(24);
  const child = path.join(o.project, parent, 'subagents', 'agent-b2.jsonl');
  const helper = (at: number, text: string) =>
    line({
      type: 'assistant',
      sessionId: parent,
      agentId: 'b2',
      isSidechain: true,
      uuid: `h-${at}`,
      timestamp: iso(at),
      cwd: '/tmp/hot-demo',
      message: {
        id: `hm-${at}`,
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text },
          { type: 'tool_use', id: `toolu_h${at}`, name: 'Read', input: {} },
        ],
      },
    });
  try {
    // Only the helper's transcript is here: it has no parent desk to sit at.
    await mkdir(path.dirname(child), { recursive: true });
    await writeFile(child, helper(Date.now() - 4000, '혼자 시작'));
    await o.service.refresh();
    assert.equal(o.service.hotSessions().length, 1);
    const view = o.service.store.officeView;
    let rebuilt = 0;
    o.service.store.officeView = function (...args) {
      rebuilt++;
      return view.apply(this, args);
    };
    o.sent.length = 0;
    await appendFile(child, helper(Date.now(), '혼자 더 진행'));
    await o.service.hotTick();
    assert.equal(rebuilt, 1);
    assert.equal(o.sent.length, 1);
    assert.deepEqual(plain(o.sent[0].snapshot), plain(o.service.snapshot()));
  } finally {
    await o.done();
  }
});

test('A watched file that is replaced gets a new watch', async () => {
  const o = await office(true);
  const id = sid(25);
  const now = Date.now();
  try {
    o.service.hot.debounceMs = 10;
    await writeFile(o.file(id), user(id, now - 5000, '일') + progress(id, now - 4000, '진행'));
    await o.service.refresh();
    const first = (o.service as any).watchers.get(o.file(id));
    assert.ok(first);
    // Atomic replace: a new file renamed over the old path.
    const tmp = `${o.file(id)}.tmp`;
    await writeFile(
      tmp,
      user(id, now - 5000, '일') +
        progress(id, now - 4000, '진행') +
        progress(id, Date.now(), '교체됨'),
    );
    await rename(tmp, o.file(id));
    const started = Date.now();
    while ((o.service as any).watchers.get(o.file(id)) === first) {
      assert.ok(Date.now() - started < 3000, 'the old watch was dropped');
      await sleep(10);
    }
    await o.service.hotTick();
    const second = (o.service as any).watchers.get(o.file(id));
    assert.ok(second && second !== first, 'watched again');
  } finally {
    await o.done();
  }
});
