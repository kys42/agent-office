import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { OfficeEvent } from '../../src/shared/types';

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
  // The person scrolls up toward the top: the earlier conversation comes in by itself (the last
  // shown ones and the page before them), and the message being read stays put.
  // (Scrolls within a moment of the card's own scroll to the newest count as the card's.)
  await page.waitForTimeout(400);
  await card
    .locator('.inspector-scroll')
    .evaluate((el) => el.scrollTo({ top: 300, behavior: 'instant' }));
  await expect(conversation.getByText(label(72))).toBeAttached();
  await expect.poll(() => page.evaluate(() => (window as any).pages)).toEqual([null, 'e80']);
  // What was in view stays in view: the inserted earlier part goes above it, not under the eye.
  await expect
    .poll(() => card.locator('.inspector-scroll').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1000);

  // Scrolling to the button also starts automatic paging. A count-then-click races that
  // observer and can wait forever for a button it legitimately removed. Drive the same
  // user scroll, waiting for each earlier chunk before asking for the next one.
  for (const first of [48, 24, 0]) {
    await card
      .locator('.inspector-scroll')
      .evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(conversation.getByText(label(first))).toBeAttached();
  }
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
  // Still loaded: reading back to the first one fetches no page. The automatic
  // reader may reveal it before a click can reach the one-message button.
  await card
    .locator('.inspector-scroll')
    .evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }));
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
