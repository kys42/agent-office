import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { OfficeNotice, Snapshot } from '../../src/shared/types';

/**
 * Issue #221: opening a colleague's work card reads its unread final replies (not calls or
 * errors). Three colleagues: run-0 has an unread final reply, run-1 is calling the person and
 * also has an unread final reply, run-2 is quiet.
 */
function office(): Snapshot {
  const snapshot = demoSnapshot();
  const template = snapshot.sessions[0];
  const base = snapshot.notices![0];
  const now = Date.now();
  snapshot.sessions = [0, 1, 2].map((i) => ({
    ...template,
    id: `run-${i}`,
    nativeId: `run-${i}`,
    alias: `동료 ${i}`,
    title: `업무 ${i}`,
    project: 'team-a',
    cwd: '/tmp/team-a',
    workspace: undefined,
    area: undefined,
    branch: 'main',
    officeSeat: i,
    status: i === 1 ? 'call' : 'idle',
    updatedAt: now,
    events: [
      {
        ...template.events[0],
        id: `said-${i}`,
        kind: 'assistant' as const,
        text: `답변 ${i}`,
        phase: 'final' as const,
        at: now - 60_000,
      },
    ],
    activity: undefined,
    actor: undefined,
    origin: undefined,
    relation: undefined,
    parentId: null,
  }));
  const notice = (id: string, sessionId: string, patch: Partial<OfficeNotice> = {}) => ({
    ...base,
    id,
    sessionId,
    eventId: id,
    kind: 'reply' as const,
    phase: 'final' as const,
    text: `${id} 결과`,
    at: now - 60_000,
    receivedAt: now - 60_000,
    version: 'v1',
    seenAt: null,
    viewedAt: null,
    dismissedAt: null,
    resolvedAt: null,
    bootstrap: false,
    ...patch,
  });
  snapshot.notices = [
    notice('final-0', 'run-0'),
    notice('final-1', 'run-1'),
    notice('call-1', 'run-1', { kind: 'attention', phase: undefined, at: now - 30_000 }),
  ];
  snapshot.preferences.privacy = false;
  return snapshot;
}

/** The desktop bridge; `notices` records each receipt and applies it like the service. */
async function bridge(page: Page, snapshot: Snapshot, card?: string) {
  await page.addInitScript(
    ({ s, card }) => {
      const w = window as any;
      w.fixture = s;
      w.receipts = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        terminals: async () => ({}),
        subscribe: (cb: any) => {
          w.publish = () => {
            w.fixture = { ...w.fixture, version: (w.fixture.version ?? 0) + 1 };
            cb(structuredClone(w.fixture));
          };
          return () => {};
        },
        notices: async (receipts: any[], action: string) => {
          if (w.failNext > 0) {
            w.failNext--;
            w.receipts.push([`${action}-failed`, receipts.map((r: any) => r.id)]);
            throw new Error('저장하지 못했어요');
          }
          w.receipts.push([action, receipts.map((r: any) => r.id)]);
          for (const n of w.fixture.notices)
            if (receipts.some((r) => r.id === n.id && r.version === n.version)) {
              if (action === 'read') n.seenAt = Date.now();
              else if (action === 'unread') n.seenAt = null;
              else if (action === 'view') n.viewedAt = Date.now();
              else n.dismissedAt = Date.now();
            }
          return structuredClone(w.fixture);
        },
        ...(card
          ? {
              card: async () => {},
              cardState: async () => ({ pinned: false, positionRemembered: false }),
              onCardState: () => () => {},
              onCard: (cb: any) => {
                setTimeout(() => cb({ id: card }), 50);
                return () => {};
              },
            }
          : {}),
      };
    },
    { s: snapshot, card },
  );
}
const receipts = (page: Page) =>
  page.evaluate(() => (window as any).receipts as [string, string[]][]);

test('Big office: opening a colleague reads its final reply; calls stay', async ({ page }) => {
  await bridge(page, office());
  await page.goto('/');
  // Two finals and a call (the window title counts them; no list shows them).
  const unread = (n: number) => expect(page).toHaveTitle(`(${n}) Agent Office`);
  await unread(3);
  const plate = page.locator('[data-station-id="run-0"] small em').filter({ hasText: '새 결과' });
  await expect(plate).toBeVisible();
  expect(await receipts(page)).toEqual([]);

  await page.locator('.office-pet[data-session-id="run-0"]').click();
  await expect(page.getByRole('complementary', { name: '동료의 업무 카드' })).toBeVisible();
  await expect.poll(() => receipts(page)).toEqual([['read', ['final-0']]]);
  await unread(2);
  await expect(plate).toHaveCount(0);

  // The calling colleague: only its final reply is read, the call stays.
  await page.locator('.office-pet[data-session-id="run-1"]').click();
  await expect
    .poll(() => receipts(page))
    .toEqual([
      ['read', ['final-0']],
      ['read', ['final-1']],
    ]);
  await unread(1);
  const left = await page.evaluate(() =>
    (window as any).fixture.notices.filter((n: any) => !n.seenAt).map((n: any) => n.id),
  );
  expect(left).toEqual(['call-1']);

  // A new final reply while the card stays open is read at once, once.
  await page.evaluate(() => {
    const w = window as any;
    const at = Date.now();
    w.fixture.notices.push({
      ...w.fixture.notices[1],
      id: 'final-1b',
      eventId: 'final-1b',
      text: '추가 결과',
      at,
      receivedAt: at,
      seenAt: null,
    });
    w.publish();
  });
  await expect.poll(() => receipts(page)).toHaveLength(3);
  expect((await receipts(page))[2]).toEqual(['read', ['final-1b']]);
  await unread(1);
  await page.waitForTimeout(300);
  expect(await receipts(page)).toHaveLength(3);
});

test('Big office: a hidden window reads nothing until it is shown', async ({ page }) => {
  await bridge(page, office());
  await page.addInitScript(() => {
    const w = window as any;
    w.office.visible = async () => false;
    w.office.onVisibility = (cb: any) => {
      w.show = () => cb(true);
      return () => {};
    };
  });
  await page.goto('/');
  await page.locator('.office-pet[data-session-id="run-0"]').click();
  await expect(page.getByRole('complementary', { name: '동료의 업무 카드' })).toBeVisible();
  await page.waitForTimeout(2000);
  expect(await receipts(page)).toEqual([]);
  await page.evaluate(() => (window as any).show());
  await expect.poll(() => receipts(page)).toEqual([['read', ['final-0']]]);
});

test('Privacy mode: the card hides the conversation and reads nothing', async ({ page }) => {
  const snapshot = office();
  snapshot.preferences.privacy = true;
  await bridge(page, snapshot);
  await page.goto('/');
  await page.locator('.office-pet[data-session-id="run-0"]').click();
  await expect(page.getByRole('complementary', { name: '동료의 업무 카드' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await receipts(page)).toEqual([]);
});

test('Dock card: opening reads the final reply, and a new one while it is open', async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 760 });
  await bridge(page, office(), 'run-1');
  await page.goto('/#card');
  await expect(page.getByRole('complementary', { name: '동료의 업무 카드' })).toBeVisible();
  await expect.poll(() => receipts(page)).toEqual([['read', ['final-1']]]);
  await page.evaluate(() => {
    const w = window as any;
    const at = Date.now();
    w.fixture.notices.push({
      ...w.fixture.notices[1],
      id: 'final-1b',
      eventId: 'final-1b',
      at,
      receivedAt: at,
      seenAt: null,
    });
    w.publish();
  });
  await expect
    .poll(() => receipts(page))
    .toEqual([
      ['read', ['final-1']],
      ['read', ['final-1b']],
    ]);
  // The call is never read by opening.
  const call = await page.evaluate(() =>
    (window as any).fixture.notices.find((n: any) => n.id === 'call-1'),
  );
  expect(call.seenAt).toBeNull();
});

test('Tiny row: the blue dot goes once the card has read the reply', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 720 });
  await bridge(page, office());
  await page.goto('/?lang=ko#mini=row&tiny');
  const dot = (i: number) => page.locator(`[data-station-id="run-${i}"] .tiny-dot`);
  await expect(dot(0)).toHaveClass(/tone-reply/);
  await expect(dot(1)).toHaveClass(/tone-attention/);
  // The card window read it: every window hears it from the next snapshot.
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.notices.find((n: any) => n.id === 'final-0').seenAt = Date.now();
    w.publish();
  });
  await expect(dot(0)).toHaveCount(0);
  await expect(dot(1)).toHaveClass(/tone-attention/);
  // The row itself shows no card: it reads nothing.
  expect(await receipts(page)).toEqual([]);
});

const card = (page: Page) => page.getByRole('complementary', { name: '동료의 업무 카드' });
const pet = (page: Page, i: number) => page.locator(`.office-pet[data-session-id="run-${i}"]`);

test('Dwell: a card glanced at for less than 1.5 s reads nothing; one kept open reads', async ({
  page,
}) => {
  await bridge(page, office());
  await page.goto('/');
  await pet(page, 0).click();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(700);
  // Switched away (to the quiet colleague) before the dwell: the glance read nothing.
  await pet(page, 2).click();
  await page.waitForTimeout(1500);
  expect(await receipts(page)).toEqual([]);
  // Kept on the colleague, it reads once the dwell has passed.
  await pet(page, 0).click();
  const opened = Date.now();
  await expect.poll(() => receipts(page)).toEqual([['read', ['final-0']]]);
  expect(Date.now() - opened).toBeGreaterThanOrEqual(1300);
});

test('J/K: stepping quickly past results leaves them for later', async ({ page }) => {
  await bridge(page, office());
  await page.goto('/');
  await expect(page).toHaveTitle('(3) Agent Office');
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('j');
    await page.waitForTimeout(300);
  }
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await page.waitForTimeout(1800);
  expect(await receipts(page)).toEqual([]);
  await expect(page).toHaveTitle('(3) Agent Office');
});

test('Restored card: reads nothing until the person touches the office', async ({ page }) => {
  await bridge(page, office());
  await page.addInitScript(() => localStorage.setItem('office:last-session', 'run-0'));
  await page.goto('/');
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(2200);
  expect(await receipts(page)).toEqual([]);
  // Any key (or press) is the person being here: the card then reads after its dwell.
  await page.keyboard.press('Shift');
  await expect.poll(() => receipts(page)).toEqual([['read', ['final-0']]]);
});

test('Restored from #session=: a press in the app starts the read', async ({ page }) => {
  await bridge(page, office());
  await page.goto('/#session=run-0');
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(2000);
  expect(await receipts(page)).toEqual([]);
  await card(page).locator('.card-status').click();
  await expect.poll(() => receipts(page)).toEqual([['read', ['final-0']]]);
});

test('Marked unread on purpose, a reply stays unread while the card is open', async ({ page }) => {
  const snapshot = office();
  // run-0's reply was already read before the card opened; run-0 gets a second, unread one.
  snapshot.notices![0].seenAt = Date.now() - 1000;
  snapshot.notices!.push({
    ...snapshot.notices![0],
    id: 'final-0b',
    eventId: 'final-0b',
    text: 'final-0b 결과',
    seenAt: null,
  });
  await bridge(page, snapshot);
  await page.goto('/');
  await pet(page, 0).click();
  await expect.poll(() => receipts(page)).toEqual([['read', ['final-0b']]]);
  // Both made unread elsewhere (the desk row's "keep it up"): the one read before opening and
  // the one the card read.
  await page.evaluate(() => {
    const w = window as any;
    for (const n of w.fixture.notices) if (n.sessionId === 'run-0') n.seenAt = null;
    w.publish();
  });
  await expect(page).toHaveTitle('(4) Agent Office');
  await page.waitForTimeout(2200);
  expect(await receipts(page)).toHaveLength(1);
  // Opened anew, the colleague's replies are read again.
  await pet(page, 2).click();
  await pet(page, 0).click();
  await expect.poll(() => receipts(page)).toHaveLength(2);
  expect((await receipts(page))[1][0]).toBe('read');
  expect([...(await receipts(page))[1][1]].sort()).toEqual(['final-0', 'final-0b']);
});

test('A failed receipt is sent again on the next snapshot', async ({ page }) => {
  await bridge(page, office());
  await page.addInitScript(() => ((window as any).failNext = 1));
  await page.goto('/');
  await pet(page, 0).click();
  await expect.poll(() => receipts(page)).toEqual([['read-failed', ['final-0']]]);
  await page.waitForTimeout(300);
  expect(await receipts(page)).toHaveLength(1);
  await page.evaluate(() => (window as any).publish());
  await expect
    .poll(() => receipts(page))
    .toEqual([
      ['read-failed', ['final-0']],
      ['read', ['final-0']],
    ]);
});

test('Sending a message or jumping to its terminal reads that colleague’s results (#300)', async ({
  page,
}) => {
  const snapshot = office();
  // Opening a card reads nothing here, so only the send and the jump read.
  snapshot.preferences.readOnOpen = false;
  await bridge(page, snapshot);
  await page.addInitScript(() => {
    const w = window as any;
    Object.assign(w.office, {
      terminalSend: async () => true,
      terminals: async (ids: string[]) =>
        Object.fromEntries(
          ids.map((id) => [id, { kind: 'orca', status: 'idle', canSend: true, canFocus: true }]),
        ),
      jump: async () => ({ action: 'focused', text: '터미널로 이동했어요' }),
      send: async () => ({ status: 'sent', message: '보냈어요' }),
    });
  });
  await page.goto('/');
  await pet(page, 0).click();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(1800);
  expect(await receipts(page)).toEqual([]);
  const input = card(page).locator('.terminal-send-chat textarea');
  await input.fill('고마워요');
  await input.press('Enter');
  await expect.poll(() => receipts(page)).toEqual([['read', ['final-0']]]);
  // The calling colleague: the jump reads its result, the call stays until it is handled.
  await pet(page, 1).click();
  await expect(card(page).locator('.card-head h2')).toHaveAttribute('title', '동료 1');
  await card(page).locator('.card-actions').getByRole('button', { name: 'Orca로 이동' }).click();
  await expect
    .poll(() => receipts(page))
    .toEqual([
      ['read', ['final-0']],
      ['read', ['final-1']],
    ]);
  await expect(page).toHaveTitle('(1) Agent Office');
});
