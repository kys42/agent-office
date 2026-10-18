import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../server/store.js';
import { OfficeService } from '../server/service.js';
import { managerSession } from '../server/manager/projection.js';
import { officeAction } from '../server/manager/actions.js';
import { MANAGER_ID, type ManagerState } from '../src/shared/manager.js';
import { parseRecords } from '../server/adapters/normalize.js';

const state = (): ManagerState => ({
  createdAt: Date.now() - 1000,
  settings: { provider: 'codex', schedule: { kind: 'off' }, notifications: true },
  running: true,
  ready: true,
  sessionId: 'manager-native',
  ownedSessionIds: ['codex:manager-native'],
  availability: { tmux: true, codex: true, claude: false },
  jobs: [],
});
test('Manager uses ordinary persisted sessions, receipts, bookmarks and personalization across collection and restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-manager-projection-'));
  let store = new OfficeStore(dir);
  try {
    const s = state();
    const native = parseRecords(
      [{ type: 'session_meta', payload: { id: 'manager-native', cwd: '/manager' } }],
      { provider: 'codex', sourcePath: '/manager.jsonl', mtime: Date.now() },
    );
    store.upsert([native], 'codex');
    store.setManager(managerSession(s), s.ownedSessionIds!);
    assert.deepEqual(
      store.list().map((x) => x.id),
      [MANAGER_ID],
    );
    store.patch(MANAGER_ID, { alias: '우리 매니저', notes: '개인 메모' });
    store.pin([MANAGER_ID], false);
    const at = Date.now();
    s.jobs.push({
      id: 'one',
      kind: 'chat',
      text: '상태 보여줘',
      status: 'running',
      createdAt: at,
      startedAt: at,
      actions: [],
      cards: [{ type: 'briefing', at, total: 2, working: 1, attention: 1, results: 0 }],
    });
    store.setManager(managerSession(s), s.ownedSessionIds!);
    assert.equal(store.get(MANAGER_ID).status, 'work');
    assert.ok(!store.detail(MANAGER_ID).events.some((e) => e.phase === 'final'));
    Object.assign(s.jobs[0], {
      status: 'completed',
      finishedAt: at + 1,
      answer: '상태 확인했어요',
    });
    store.setManager(managerSession(s), s.ownedSessionIds!);
    const detail = store.detail(MANAGER_ID);
    assert.equal(detail.events.at(-1)?.rich?.[0].type, 'briefing');
    const notice = detail.notices?.find((n) => n.eventId === 'one:answer');
    assert.ok(notice);
    store.noticeReceipt([{ id: notice.id, version: notice.version }], 'read');
    store.noticeReceipt([{ id: notice.id, version: notice.version }], 'dismiss');
    const bookmark = store.bookmark(MANAGER_ID, 'one:answer');
    assert.equal(bookmark.text, '상태 확인했어요');
    assert.equal(bookmark.rich?.[0].type, 'briefing');
    store.upsert([], 'codex'); // a full native collection must not erase the internal colleague
    store.setManager(managerSession(s), s.ownedSessionIds!);
    assert.equal(store.get(MANAGER_ID).alias, '우리 매니저');
    assert.equal(store.get(MANAGER_ID).pinned, false);
    assert.ok(store.detail(MANAGER_ID).notices?.find((n) => n.id === notice.id)?.seenAt);
    assert.ok(store.detail(MANAGER_ID).notices?.find((n) => n.id === notice.id)?.dismissedAt);
    store.upsert([native], 'codex');
    store.close();
    store = new OfficeStore(dir, true);
    assert.equal(store.get(MANAGER_ID).notes, '개인 메모');
    assert.equal(store.bookmarks().bookmarks[0].id, bookmark.id);
    assert.deepEqual(
      store.identities([MANAGER_ID, native.id]).map((x) => x.id),
      [MANAGER_ID],
    );
    assert.ok(!store.search('manager').some((h) => h.session.id === native.id));
    assert.throws(() => store.detail(native.id));
    store.close();
    store = new OfficeStore(dir);
    store.preferences({ excludedProjects: ['오피스 매니저'] });
    assert.throws(() => store.detail(MANAGER_ID));
    assert.equal(store.bookmarks().bookmarks.length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Display tools validate visible IDs, use service facts and remain available to read-only briefings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-manager-display-'));
  const service = new OfficeService(path.join(dir, 'data'), dir);
  try {
    const s = state();
    service.syncManager(s);
    const colleague = parseRecords(
      [{ type: 'session_meta', payload: { id: 'colleague', cwd: '/test/one' } }],
      { provider: 'codex', sourcePath: '/test/colleague.jsonl', mtime: Date.now() },
    );
    service.store.upsert([colleague], 'codex');
    service.syncManager(s);
    const office = {
      call: (method: string, args?: unknown[]) => service.call(method, args),
      focus: () => {},
    };
    const card = await officeAction(office, 'show_agents', { ids: [colleague.id] }, true);
    assert.equal(card.display.agents[0].id, colleague.id);
    assert.equal((await officeAction(office, 'show_briefing', {}, true)).display.total, 1);
    await assert.rejects(officeAction(office, 'show_agents', { ids: ['missing'] }, true));
    await assert.rejects(
      officeAction(office, 'show_agents', { ids: [colleague.id], html: 'arbitrary' }, true),
    );
    await service.call('preferences', [{ excludedProjects: [colleague.project] }]);
    await assert.rejects(officeAction(office, 'show_agents', { ids: [colleague.id] }, true));
    await assert.rejects(service.call('syncManager', [s]));
  } finally {
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
