import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { noticeOrder } from '../../src/shared/notice-pages';
import type { OfficeEvent, OfficeNotice } from '../../src/shared/types';

const seen = () => {
  localStorage.setItem('office:onboarding:v1:live', 'seen');
  localStorage.setItem('office:onboarding:v1:demo', 'seen');
};
const label = (i: number) => `대화 #${String(i).padStart(3, '0')}`;

test('A colleague card reads older messages by page, keeps the reading position and drops them on close', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  const id = 'demo:5';
  const now = Date.now();
  const full: OfficeEvent[] = Array.from({ length: 120 }, (_, i) => ({
    id: `e${i}`,
    kind: i % 2 ? 'assistant' : 'user',
    phase: i % 2 ? 'final' : undefined,
    at: now - (120 - i) * 60_000,
    text: `${label(i)} 내용입니다.`,
    sourceRef: 'fixture',
  }));
  const s = fixture.sessions.find((x) => x.id === id)!;
  s.events = full.slice(-4);
  s.activity = undefined;
  fixture.notices = [];
  await page.addInitScript(seen);
  await page.addInitScript(
    ({ s, full, id }) => {
      const w = window as any;
      w.fixture = s;
      w.full = full;
      w.pages = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (sid: string, p: { before?: string; limit?: number } = {}) => {
          w.pages.push(p.before ?? null);
          const base = w.fixture.sessions.find((x: any) => x.id === sid);
          if (sid !== id) return structuredClone(base);
          const end = p.before ? w.full.findIndex((e: any) => e.id === p.before) : w.full.length;
          const start = Math.max(0, end - (p.limit ?? 40));
          return structuredClone({
            ...base,
            events: w.full.slice(start, end),
            olderEvents: start > 0,
            notices: [],
          });
        },
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        subscribe: (cb: any) => {
          w.publish = cb;
          return () => {};
        },
      };
    },
    { s: fixture, full, id },
  );
  await page.goto('/');
  await page.locator(`.office-pet[data-session-id="${id}"]`).click();
  const card = page.getByRole('complementary', { name: '동료의 업무 카드' });
  const conversation = card.locator('.conversation');
  // The newest page only: 40 messages read, 24 shown.
  await expect(conversation.getByText(label(119))).toBeVisible();
  await expect(conversation.locator('.conversation-message')).toHaveCount(24);
  await expect(conversation.getByText(label(79))).toHaveCount(0);
  const older = conversation.locator('.older-messages');
  await expect(older).toHaveText('이전 대화 16개 더 보기');
  // The person scrolls up to the oldest shown message and the button above it.
  await older.scrollIntoViewIfNeeded();
  const reading = conversation.getByText(label(96));
  const top = async () => (await reading.boundingBox())!.y;
  const before = await top();
  // The last shown ones and the page before them; the message read stays put.
  await older.click();
  await expect(conversation.getByText(label(72))).toBeVisible();
  await expect.poll(top).toBeCloseTo(before, 0);
  expect(await page.evaluate(() => (window as any).pages)).toEqual([null, 'e80']);
  for (let i = 0; i < 6 && (await older.count()); i++) await older.click();
  await expect(conversation.getByText(label(0))).toBeAttached();
  await expect(older).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pages)).toEqual([null, 'e80', 'e40']);
  // A live message joins at the newest end without dropping what was read.
  await page.evaluate(() => {
    const w = window as any;
    const next = {
      id: 'e120',
      kind: 'assistant',
      phase: 'final',
      at: Date.now(),
      text: '대화 #120 새로 왔어요.',
      sourceRef: 'fixture',
    };
    w.full.push(next);
    const s = w.fixture.sessions.find((x: any) => x.id === 'demo:5');
    s.events = w.full.slice(-4);
    s.updatedAt = Date.now();
    w.fixture.version += 1;
    w.publish(structuredClone(w.fixture));
  });
  await expect(conversation.getByText('대화 #120 새로 왔어요.')).toBeAttached();
  // Still loaded: showing the first one again reads no page.
  await expect(older).toHaveText('이전 대화 1개 더 보기');
  await older.click();
  await expect(conversation.getByText(label(0))).toBeAttached();
  expect((await page.evaluate(() => (window as any).pages)).filter(Boolean)).toEqual([
    'e80',
    'e40',
  ]);
  // Closing the card lets the pages go; opening again starts from the newest page.
  await card.getByRole('button', { name: '업무 카드 닫기' }).click();
  await page.locator(`.office-pet[data-session-id="${id}"]`).click();
  await expect(conversation.getByText('대화 #120 새로 왔어요.')).toBeVisible();
  await expect(conversation.getByText(label(0))).toHaveCount(0);
  await expect(older).toHaveText('이전 대화 16개 더 보기');
});

test('The inbox reads older notices by page, and receipts and read-all reach notices the snapshot does not carry', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  const now = Date.now();
  const ids = fixture.sessions.map((s) => s.id);
  const all: OfficeNotice[] = Array.from({ length: 260 }, (_, i) => ({
    id: `n${String(i).padStart(3, '0')}`,
    sessionId: ids[i % 6],
    eventId: `n${i}`,
    kind: i % 50 === 7 ? 'reply' : 'progress',
    phase: i % 50 === 7 ? 'final' : 'commentary',
    text: `소식 #${String(i).padStart(3, '0')}`,
    at: now - (i + 1) * 60_000,
    receivedAt: now - (i + 1) * 60_000,
    version: 'v1',
    // The newest half was read; older progress is unread.
    seenAt: i < 130 ? now - 1000 : null,
    viewedAt: null,
    dismissedAt: null,
    resolvedAt: null,
    bootstrap: false,
  }));
  all.sort(noticeOrder);
  await page.addInitScript(seen);
  await page.addInitScript(
    ({ s, all }) => {
      const w = window as any;
      w.all = all;
      w.calls = [];
      const kind = (n: any, filter: string, bg = false) =>
        filter === 'final'
          ? n.kind === 'reply' && n.phase === 'final' && (bg || !n.background)
          : filter === 'attention'
            ? !n.resolvedAt && (n.kind === 'attention' || n.kind === 'error')
            : true;
      const scope = (n: any, q: any) => !q.sessionIds || q.sessionIds.includes(n.sessionId);
      const matches = (n: any, q: any) =>
        scope(n, q) && kind(n, q.filter, q.includeBackground) && (q.includeRead || !n.seenAt);
      const inbox = (n: any) => kind(n, 'attention') || kind(n, 'final');
      // The test's own carried set: the newest 100 plus every unread final (as the collector's).
      const view = () => {
        const carried = w.all.filter(
          (n: any, i: number) => i < 100 || (!n.seenAt && kind(n, 'final')),
        );
        return structuredClone({
          ...s,
          notices: carried,
          noticeStats: {
            unread: w.all.filter((n: any) => !n.seenAt && inbox(n)).length,
            total: w.all.length,
          },
        });
      };
      w.office = {
        snapshot: async () => view(),
        detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
        visit: async () => view(),
        artifacts: async () => [],
        subscribe: () => () => {},
        notices: async (receipts: any[], action: string) => {
          for (const n of w.all)
            if (receipts.some((r) => r.id === n.id && r.version === n.version)) {
              if (action === 'read') n.seenAt = Date.now();
              else if (action === 'unread') n.seenAt = null;
              else if (action === 'dismiss') n.dismissedAt = Date.now();
            }
          return view();
        },
        noticePage: async (q: any) => {
          w.calls.push(['page', q.filter, q.before?.id ?? null]);
          const after = (n: any) =>
            !q.before || n.at < q.before.at || (n.at === q.before.at && n.id < q.before.id);
          const list = w.all.filter((n: any) => after(n) && matches(n, q));
          const limit = q.limit ?? 50;
          const unread = { final: 0, attention: 0, all: 0 } as any;
          for (const n of w.all)
            if (!n.seenAt && scope(n, q))
              for (const k of ['final', 'attention', 'all'])
                if (kind(n, k, q.includeBackground)) unread[k]++;
          return structuredClone({
            notices: list.slice(0, limit),
            more: list.length > limit,
            unread,
            at: Date.now(),
          });
        },
        noticeReadAll: async (q: any, asOf: number) => {
          w.calls.push(['readAll', q.filter, q.includeRead]);
          for (const n of w.all)
            if (matches(n, { ...q, includeRead: false }) && n.receivedAt <= asOf)
              n.seenAt = Date.now();
          return view();
        },
      };
    },
    { s: fixture, all },
  );
  await page.goto('/');
  await page.getByRole('button', { name: '소식함 열기' }).click();
  const inbox = page.getByRole('complementary', { name: '소식함' });
  // Every unread final is carried: the list and its count are whole.
  await expect(inbox.locator('.news-item')).toHaveCount(3);
  await expect(inbox.getByRole('button', { name: /최종 응답/ })).toContainText('3');
  // The whole record comes by page: 30 shown of the first 50, then further pages.
  await inbox.getByRole('button', { name: /전체 기록/ }).click();
  await inbox.getByRole('checkbox', { name: '읽은 소식 포함' }).check();
  await expect(inbox.locator('.news-item')).toHaveCount(30);
  const more = inbox.locator('.news-load');
  await expect(more).toHaveText('소식 더 보기 · 20건');
  await more.click();
  await expect(inbox.locator('.news-item')).toHaveCount(60);
  for (let i = 0; i < 12 && (await more.count()); i++) await more.click();
  await expect(inbox.locator('.news-item')).toHaveCount(260);
  await expect(inbox.getByText('소식 #259')).toBeAttached();
  await expect(more).toHaveCount(0);
  // A paged-in notice (never carried) takes a receipt.
  const oldest = inbox.locator('.news-item[data-notice-id="n259"]');
  await oldest.getByRole('button', { name: '읽음으로 표시' }).click();
  await expect(oldest.getByRole('button', { name: '다시 미확인' })).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).all.find((n: any) => n.id === 'n259').seenAt),
  ).toBeTruthy();
  // Read all unread of the whole record, carried or not.
  await inbox.getByRole('checkbox', { name: '읽은 소식 포함' }).uncheck();
  const unreadAll = inbox.getByRole('button', { name: /전체 기록/ });
  await expect(unreadAll).toContainText('129');
  await inbox.getByRole('button', { name: '미확인 129건 읽음', exact: true }).click();
  await expect(unreadAll).toContainText('0');
  await expect(inbox.locator('.news-item')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).all.filter((n: any) => !n.seenAt).length)).toBe(
    0,
  );
  expect(await page.evaluate(() => (window as any).calls)).toContainEqual([
    'readAll',
    'all',
    false,
  ]);
  await expect(page.getByRole('button', { name: '소식함 열기' })).toContainText('0');
});
