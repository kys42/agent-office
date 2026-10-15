import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OfficeStore } from '../server/store.js';
import { OfficeService } from '../server/service.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { setLocale } from '../src/shared/i18n/index.js';
import {
  BOOKMARK_TEXT,
  PROGRESS_HEAD,
  PROGRESS_TAIL,
  bookmarkContext,
  makeBookmark,
  savedConversation,
} from '../src/shared/bookmarks.js';
import { detailPage, LOADED_EVENTS } from '../src/shared/conversation-pages.js';
import type { OfficeEvent, Session } from '../src/shared/types.js';
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');

async function fixture(fn: (s: OfficeStore, dir: string) => void | Promise<void>) {
  const d = await mkdtemp(path.join(os.tmpdir(), 'office-bookmarks-'));
  const s = new OfficeStore(d);
  try {
    await fn(s, d);
  } finally {
    s.close();
    await rm(d, { recursive: true });
  }
}
const T = Date.now() - 60 * 60_000;
function ev(
  id: string,
  kind: OfficeEvent['kind'],
  text: string,
  minute: number,
  phase?: OfficeEvent['phase'],
): OfficeEvent {
  return {
    id,
    kind,
    text,
    at: T + minute * 60_000,
    ...(phase ? { phase } : {}),
    sourceRef: `/test/one.jsonl#${id}`,
  };
}
/** A stored-shape session with exactly these events. */
function session(events: OfficeEvent[], id = 'one', project = 'project'): Session {
  const base = parseRecords(
    [
      { type: 'session_meta', payload: { id, cwd: '/test/' + project } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'seed' }],
        },
      },
    ],
    { provider: 'codex', sourcePath: '/test/' + id + '.jsonl', mtime: Date.now() },
  );
  return {
    ...base,
    events,
    updatedAt: Math.max(base.updatedAt, ...events.map((e) => e.at)),
    revision: base.revision + ':' + events.map((e) => e.id).join(','),
  };
}
const turn = [
  ev('r1', 'user', '이전 요청', 0),
  ev('a1', 'assistant', '이전 답', 1, 'final'),
  ev('r2', 'user', '로그인 캐시 정책을 정해 줘', 2),
  ev('p1', 'assistant', '설정 파일을 볼게요', 3, 'commentary'),
  ev('t1', 'tool', 'read config.ts', 4),
  ev('t1r', 'result', '...', 5),
  ev('p2', 'assistant', '5분이 적당해 보여요', 6, 'commentary'),
  ev('f1', 'assistant', '결정: 캐시를 5분으로 둡니다.', 7, 'final'),
  ev('l1', 'lifecycle', '완료', 8),
];

test('Saved reading order keeps roles, sorts context and de-duplicates the saved message without changing its copy', () => {
  const events = [
    ev('u', 'user', 'My request', 0),
    ev('p', 'assistant', 'Progress', 1, 'commentary'),
    ev('f', 'assistant', 'Saved reply', 2, 'final'),
  ];
  const b = makeBookmark(session(events), events, 'f', 'saved', 100)!;
  b.context.progress = [{ ...b, text: 'Old duplicate' }, ...b.context.progress];
  const original = structuredClone(b);
  const lines = savedConversation(b);
  assert.deepEqual(
    lines.map((x) => [x.eventId, x.kind, x.text]),
    [
      ['u', 'user', 'My request'],
      ['p', 'assistant', 'Progress'],
      ['f', 'assistant', 'Saved reply'],
    ],
  );
  assert.deepEqual(b, original);
  const request = makeBookmark(session(events), events, 'u', 'saved-user', 100)!;
  assert.deepEqual(
    savedConversation(request).map((x) => x.kind),
    ['user'],
  );
  b.context.progress = [{ ...b, eventId: 'same-time', text: 'Earlier update' }];
  assert.deepEqual(
    savedConversation(b).map((x) => x.eventId),
    ['u', 'same-time', 'f'],
  );
});

test('Context: the last request, what was said since, tool calls only counted', () => {
  const c = bookmarkContext(turn, 7, turn[7]);
  assert.equal(c.request?.eventId, 'r2');
  assert.deepEqual(
    c.progress.map((l) => l.eventId),
    ['p1', 'p2'],
  );
  assert.equal(c.progress[0].phase, 'commentary');
  assert.equal(c.tools, 2);
  assert.equal(c.omitted, 0);
  // A request has no context of its own.
  assert.deepEqual(bookmarkContext(turn, 2, turn[2]), { progress: [], omitted: 0, tools: 0 });
  // The request out of the record: what was said is still kept.
  const tail = turn.slice(3);
  const at = tail.findIndex((e) => e.id === 'f1');
  const cut = bookmarkContext(tail, at, tail[at]);
  assert.equal(cut.request, undefined);
  assert.equal(cut.progress.length, 2);
});

test('Context: a long stretch keeps its first and last messages, the middle counted', () => {
  const many = [
    ev('q', 'user', '긴 작업', 0),
    ...Array.from({ length: 20 }, (_, i) => ev(`m${i}`, 'assistant', `진행 ${i}`, i + 1)),
    ev('end', 'assistant', '끝', 30, 'final'),
  ];
  const c = bookmarkContext(many, many.length - 1, many.at(-1)!);
  assert.equal(c.progress.length, PROGRESS_HEAD + PROGRESS_TAIL);
  assert.equal(c.omitted, 20 - PROGRESS_HEAD - PROGRESS_TAIL);
  assert.equal(c.progress[0].eventId, 'm0');
  assert.equal(c.progress.at(-1)!.eventId, 'm19');
});

test('A form of a message the conversation folds away keeps the context of the shown one', () => {
  // Codex may write a message twice (message and event forms); the conversation shows one.
  const twin = { ...turn[7], id: 'f1-event', at: turn[7].at + 1000 };
  const events = [...turn.slice(0, 8), twin, ...turn.slice(8)];
  const later = [...turn.slice(0, 8), ev('r3', 'user', '다음 요청', 9)];
  const b = makeBookmark(session(events), later, 'f1-event', 'x', 0)!;
  assert.equal(b.eventId, 'f1-event');
  assert.equal(b.context.request?.eventId, 'r2');
  assert.deepEqual(
    b.context.progress.map((l) => l.eventId),
    ['p1', 'p2'],
  );
  assert.equal(b.context.tools, 2);
  // The same words said again minutes apart are two messages: both stay context.
  const again = [
    ev('q', 'user', '확인해 줘', 0),
    ev('s1', 'assistant', '파일을 확인할게요', 1, 'commentary'),
    ev('s2', 'assistant', '파일을 확인할게요', 5, 'commentary'),
  ];
  const repeated = makeBookmark(session(again), again, 's2', 'y', 0)!;
  assert.deepEqual(
    repeated.context.progress.map((l) => l.eventId),
    ['s1'],
  );
});

test('A bookmark copies the message with where it was; lifecycle and unknown ids are none', () => {
  const s = session(turn);
  const b = makeBookmark(s, turn, 'f1', 'id-1', 1000, '메모')!;
  assert.equal(b.text, '결정: 캐시를 5분으로 둡니다.');
  assert.equal(b.phase, 'final');
  assert.equal(b.note, '메모');
  assert.equal(b.anchor.nativeId, s.nativeId);
  assert.equal(b.anchor.sourceRef, '/test/one.jsonl#f1');
  assert.equal(b.anchor.sourcePath, s.sourcePath);
  assert.equal(b.anchor.index, 7);
  assert.equal(b.source.provider, 'codex');
  assert.equal(b.context.request?.text, '로그인 캐시 정책을 정해 줘');
  assert.equal(makeBookmark(s, turn, 'l1', 'x', 0), null);
  assert.equal(makeBookmark(s, turn, 'nope', 'x', 0), null);
  const long = [ev('big', 'assistant', 'ê'.repeat(BOOKMARK_TEXT + 10), 0, 'final')];
  const cut = makeBookmark(session(long), long, 'big', 'x', 0)!;
  assert.equal(cut.text.length, BOOKMARK_TEXT);
  assert.equal(cut.truncated, true);
});

test('Store: bookmark once per message, note kept, copy outlives the session record', () =>
  fixture((store) => {
    const s = session(turn);
    store.upsert([s], 'codex');
    const b = store.bookmark(s.id, 'f1');
    assert.equal(b.text, '결정: 캐시를 5분으로 둡니다.');
    assert.equal(b.context.progress.length, 2);
    // Again: the same bookmark; a note replaces only the note.
    assert.equal(store.bookmark(s.id, 'f1').id, b.id);
    assert.equal(store.bookmark(s.id, 'f1', '중요').note, '중요');
    assert.equal(store.bookmarks().total, 1);
    assert.equal(store.bookmarks().bookmarks[0].note, '중요');
    assert.equal(store.bookmarkNote(b.id, '다시').note, '다시');
    assert.throws(() => store.bookmark(s.id, 'l1'));
    assert.throws(() => store.bookmark(s.id, 'missing'));
    assert.throws(() => store.bookmark('codex:nobody', 'f1'));
    assert.deepEqual(store.bookmarkMarks([s.id]), { [s.id]: ['f1'] });
    // The record leaves the store: the copy stays.
    store.upsert([], 'codex');
    assert.throws(() => store.get(s.id));
    assert.equal(store.bookmarks().bookmarks[0].text, '결정: 캐시를 5분으로 둡니다.');
    assert.deepEqual(store.bookmarkMarks([s.id]), { [s.id]: ['f1'] });
    store.unbookmark(b.id);
    assert.equal(store.bookmarks().total, 0);
    assert.throws(() => store.bookmarkNote(b.id, 'x'));
  }));

test('Store: hidden projects and tools keep their bookmarks out of the list only', () =>
  fixture((store) => {
    const s = session(turn, 'one', 'secret');
    store.upsert([s], 'codex');
    store.bookmark(s.id, 'f1');
    store.preferences({ excludedProjects: ['secret'] });
    assert.equal(store.bookmarks().total, 0);
    assert.throws(() => store.bookmark(s.id, 'p2'));
    // Hidden: not read, changed or removed through its message or id either.
    const id = store.bookmarks({}).bookmarks[0]?.id;
    assert.equal(id, undefined);
    assert.throws(() => store.bookmark(s.id, 'f1'), /제외/);
    assert.throws(() => store.unbookmarkMessage(s.id, 'f1'), /제외/);
    store.preferences({ excludedProjects: [] });
    assert.equal(store.bookmarks().total, 1);
    const held = store.bookmarks().bookmarks[0];
    store.preferences({ excludedProjects: ['secret'] });
    assert.throws(() => store.bookmarkNote(held.id, 'x'), /제외/);
    assert.throws(() => store.unbookmark(held.id), /제외/);
    store.preferences({ excludedProjects: [] });
    assert.equal(store.bookmarks().total, 1);
    store.preferences({ enabledProviders: ['claude'] });
    assert.equal(store.bookmarks().total, 0);
  }));

test('Store: a bookmark follows where its colleague is now, its copy only once that is gone', () =>
  fixture((store) => {
    const s = session(turn, 'one', 'first');
    store.upsert([s], 'codex');
    store.bookmark(s.id, 'f1');
    // The colleague is now recorded under another project: that one decides.
    store.upsert([{ ...session(turn, 'one', 'moved'), revision: 'moved' }], 'codex');
    store.preferences({ excludedProjects: ['moved'] });
    assert.equal(store.bookmarks().total, 0);
    store.preferences({ excludedProjects: ['first'] });
    assert.equal(store.bookmarks().total, 1);
    // Gone: the project it was bookmarked in.
    store.upsert([], 'codex');
    assert.equal(store.bookmarks().total, 0);
  }));

test('Store: the stamp moves on every add, note and removal', () =>
  fixture((store) => {
    const s = session(turn);
    store.upsert([s], 'codex');
    const stamps = [store.bookmarkStamp()];
    const b = store.bookmark(s.id, 'f1', undefined, 1000);
    stamps.push(store.bookmarkStamp());
    store.bookmarkNote(b.id, '메모', 2000);
    stamps.push(store.bookmarkStamp());
    store.unbookmark(b.id);
    stamps.push(store.bookmarkStamp());
    assert.equal(new Set(stamps).size, 4);
  }));

test('Store: newest saved first, pages by cursor, words and sessions narrow', () =>
  fixture((store) => {
    const a = session(turn, 'a');
    const b = session(turn, 'b', 'other');
    store.upsert([a, b], 'codex');
    store.bookmark(a.id, 'f1', undefined, 1000);
    store.bookmark(a.id, 'p1', undefined, 2000);
    store.bookmark(b.id, 'a1', '배포 확인', 3000);
    const all = store.bookmarks();
    assert.deepEqual(
      all.bookmarks.map((x) => x.eventId),
      ['a1', 'p1', 'f1'],
    );
    const first = store.bookmarks({ limit: 2 });
    assert.equal(first.more, true);
    assert.equal(first.total, 3);
    const last = first.bookmarks.at(-1)!;
    const next = store.bookmarks({ limit: 2, before: { createdAt: last.createdAt, id: last.id } });
    assert.deepEqual(
      next.bookmarks.map((x) => x.eventId),
      ['f1'],
    );
    assert.equal(next.more, false);
    // Words: the message, its note, its request, whose it was; every word must appear.
    assert.equal(store.bookmarks({ text: '배포' }).total, 1);
    assert.equal(store.bookmarks({ text: '캐시 정책' }).total, 2);
    assert.equal(store.bookmarks({ text: 'other' }).total, 1);
    assert.equal(store.bookmarks({ text: '캐시 없는말' }).total, 0);
    assert.equal(store.bookmarks({ sessionIds: [b.id] }).total, 1);
  }));

test('Store: a message left only as a retained notice excerpt is bookmarked from it', () =>
  fixture((store) => {
    const s = session(turn);
    store.upsert([s], 'codex');
    const notice = store.detail(s.id).notices?.find((n) => n.eventId === 'f1');
    assert.ok(notice, 'the final reply is a notice');
    // The record moves on: the reply left its bounded window.
    const later = session([ev('r3', 'user', '다음 일', 20)]);
    store.upsert([later], 'codex');
    const b = store.bookmark(s.id, 'f1');
    assert.equal(b.excerpt, true);
    assert.equal(b.text, notice!.text);
  }));

test('A bookmarks table from before change times were kept gets them on open', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'office-bookmarks-early-'));
  try {
    new OfficeStore(d).close();
    const db = new DatabaseSync(path.join(d, 'office.sqlite'));
    db.exec(
      'DROP TABLE bookmarks; CREATE TABLE bookmarks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, event_id TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id,event_id))',
    );
    db.close();
    const store = new OfficeStore(d);
    try {
      const s = session(turn);
      store.upsert([s], 'codex');
      const b = store.bookmark(s.id, 'f1');
      assert.equal(store.bookmarkNote(b.id, '메모').note, '메모');
      assert.equal(store.bookmarks().total, 1);
    } finally {
      store.close();
    }
  } finally {
    await rm(d, { recursive: true });
  }
});

test('Read-only store on a database from before bookmarks lists none', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'office-bookmarks-old-'));
  try {
    new OfficeStore(d).close();
    const db = new DatabaseSync(path.join(d, 'office.sqlite'));
    db.exec('DROP TABLE bookmarks');
    db.close();
    const ro = new OfficeStore(d, true);
    try {
      assert.deepEqual(ro.bookmarks(), { bookmarks: [], more: false, total: 0 });
      assert.deepEqual(ro.bookmarkMarks(['codex:one']), {});
    } finally {
      ro.close();
    }
  } finally {
    await rm(d, { recursive: true });
  }
});

test('The office carries bookmark marks; bookmarking and removing publish them', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'office-bookmarks-svc-'));
  const service = new OfficeService(path.join(d, 'data'), d);
  try {
    const s = session(turn);
    service.store.upsert([s], 'codex');
    const before = service.emitSnapshot();
    assert.deepEqual(before.bookmarked, {});
    const patches: unknown[] = [];
    service.on('snapshot', (_: unknown, patch: unknown) => patches.push(patch));
    const { bookmark, snapshot } = (await service.call('bookmark', [s.id, 'f1'])) as {
      bookmark: { id: string };
      snapshot: { bookmarked: Record<string, string[]>; version: number };
    };
    assert.deepEqual(snapshot.bookmarked, { [s.id]: ['f1'] });
    assert.ok(snapshot.version > before.version);
    const fields = (patches.at(-1) as { fields: Record<string, unknown> }).fields;
    assert.deepEqual(fields.bookmarked, { [s.id]: ['f1'] });
    assert.notEqual(fields.bookmarkStamp, before.bookmarkStamp);
    // A note goes out too (other windows' lists read again), without changing the marks.
    await service.call('bookmarkNote', [bookmark.id, '중요']);
    const noted = (patches.at(-1) as { fields: Record<string, unknown> }).fields;
    assert.deepEqual(Object.keys(noted), ['bookmarkStamp']);
    // Off by its message, as the conversation tab does.
    const off = (await service.call('unbookmarkMessage', [s.id, 'f1'])) as {
      bookmarked: Record<string, string[]>;
    };
    assert.deepEqual(off.bookmarked, {});
    await service.call('bookmark', [s.id, 'f1']);
    const again = (await service.call('bookmarks', [{}])) as { bookmarks: { id: string }[] };
    bookmark.id = again.bookmarks[0].id;
    const page = (await service.call('bookmarks', [{ text: '캐시' }])) as { total: number };
    assert.equal(page.total, 1);
    const after = (await service.call('unbookmark', [bookmark.id])) as {
      bookmarked: Record<string, string[]>;
    };
    assert.deepEqual(after.bookmarked, {});
    await assert.rejects(service.call('bookmark', [s.id, 'f1', 'x'.repeat(1001)]));
    await assert.rejects(service.call('bookmarks', [{ limit: 1000 }]));
  } finally {
    await service.stop?.();
    await rm(d, { recursive: true });
  }
});

test('A reached page holds the bookmarked message, within the loaded bound', () => {
  const events = Array.from({ length: 600 }, (_, i) =>
    ev(`e${i}`, i % 2 ? 'assistant' : 'user', `m${i}`, i),
  );
  const s = session(events);
  const plain = detailPage(s);
  assert.equal(plain.events.length, 40);
  const reached = detailPage(s, { reach: 'e400' });
  assert.ok(reached.events.some((e) => e.id === 'e400'));
  assert.equal(reached.events.at(-1)!.id, 'e599');
  assert.equal(reached.olderEvents, true);
  // By time when the id is gone.
  const byTime = detailPage(s, { reach: 'gone', reachAt: events[500].at });
  assert.ok(byTime.events.some((e) => e.id === 'e500'));
  // Further back than the bound: the bound wins.
  const far = detailPage(s, { reach: 'e10' });
  assert.equal(far.events.length, LOADED_EVENTS);
  // Reaching something already on the newest page changes nothing.
  assert.deepEqual(detailPage(s, { reach: 'e590' }).events, plain.events);
});
