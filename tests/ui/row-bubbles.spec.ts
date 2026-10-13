import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

async function fixture(page: Page, mode = '#mini=row', call = false, motion = false) {
  const s = demoSnapshot();
  const colleague = s.sessions[0];
  const now = Date.now();
  Object.assign(colleague, {
    status: call ? 'call' : 'idle',
    updatedAt: now,
    events: [
      {
        id: 'answer',
        kind: 'assistant',
        text: '첫 번째 답변입니다. '.repeat(60),
        phase: 'final',
        at: now,
      },
    ],
  });
  s.sessions = [colleague];
  s.preferences.reducedMotion = motion;
  s.notices = [
    {
      ...s.notices![0],
      id: 'answer-notice',
      eventId: 'answer',
      sessionId: colleague.id,
      kind: call ? 'attention' : 'reply',
      phase: 'final',
      text: colleague.events[0].text,
      at: now,
      receivedAt: now,
      seenAt: null,
      viewedAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
      version: 'v1',
    },
  ];
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.receipts = [];
    w.sends = [];
    w.office = {
      snapshot: async () => structuredClone(s),
      subscribe: (fn: (s: unknown) => void) => {
        w.publish = () => fn(structuredClone(s));
        return () => {};
      },
      detail: async (id: string) => structuredClone(s.sessions.find((x) => x.id === id)),
      artifacts: async () => [],
      visit: async () => structuredClone(s),
      terminalSend: async () => true,
      terminals: async (ids: string[]) =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            { kind: 'tmux', label: 'work:1.0', status: 'idle', canSend: true, canFocus: true },
          ]),
        ),
      notices: async (receipts: { id: string; version: string }[], action: string) => {
        w.receipts.push({ receipts, action });
        for (const n of s.notices ?? [])
          if (receipts.some((r) => r.id === n.id && r.version === n.version)) {
            if (action === 'view') n.viewedAt ??= Date.now();
            if (action === 'read') n.seenAt = Date.now();
            if (action === 'dismiss') n.dismissedAt = Date.now();
          }
        return structuredClone(s);
      },
      send: async (id: string, text: string) => {
        w.sends.push({ id, text });
        return { status: 'sent', message: '보냈어요' };
      },
    };
  }, s);
  await page.goto(`/?lang=ko${mode}`);
  await expect(page.locator('.speech-bubble').first()).toBeVisible();
  return page.locator('.speech-bubble').first();
}
const dot = (page: Page) =>
  page
    .locator('.speech-bubble')
    .first()
    .evaluate((el) => {
      const css = getComputedStyle(el, '::before');
      return { content: css.content, animation: css.animationName };
    });

test('row reply has no blue fill, appears on hover/focus, and hidden tools do not receive clicks', async ({
  page,
}) => {
  const bubble = await fixture(page);
  await page.mouse.move(0, 0);
  const reply = bubble.locator('.bubble-reply');
  const close = bubble.locator('.bubble-dismiss');
  await expect(reply).toHaveCSS('opacity', '0');
  await expect(reply).toHaveCSS('pointer-events', 'none');
  await expect(close).toHaveCSS('pointer-events', 'none');
  const bg = await reply.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(await bubble.evaluate((el) => getComputedStyle(el).backgroundColor));
  for (const control of [reply, close]) {
    expect(
      await control.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          document
            .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
            ?.closest(`.${el.classList[0]}`) === el
        );
      }),
    ).toBe(false);
  }
  await bubble.hover();
  await expect(reply).toHaveCSS('opacity', '1');
  await expect(reply).toHaveCSS('pointer-events', 'auto');
  await page.mouse.move(0, 0);
  await reply.focus();
  await expect(reply).toHaveCSS('opacity', '1');
  await reply.press('Enter');
  const input = page.getByRole('textbox', { name: '답장 내용' });
  await input.fill('아직 쓰는 중인 초안');
  await page.mouse.move(0, 0);
  await expect(reply).toHaveCSS('opacity', '1');
  await input.press('Escape');
  await expect(input).toHaveValue('아직 쓰는 중인 초안');
  await expect(input).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.quick-reply')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).sends)).toEqual([]);
});

for (const mode of ['#mini=row', '#mini=floor', '']) {
  test(`unfold records a view and stops the red dot, with a fresh dot for the next message ${mode || 'office'}`, async ({
    page,
  }) => {
    const bubble = await fixture(page, mode);
    expect((await dot(page)).animation).toBe('soft-pulse');
    await bubble.getByRole('button', { name: '말풍선 전체 보기', exact: true }).click();
    await expect(bubble).toHaveClass(/bubble-opened/);
    expect((await dot(page)).content).toBe('none');
    await bubble.getByRole('button', { name: '말풍선 짧게 보기', exact: true }).click();
    expect((await dot(page)).content).toBe('none');
    expect(await page.evaluate(() => (window as any).fixture.notices[0].seenAt)).toBeNull();
    const receipts = await page.evaluate(() => (window as any).receipts);
    expect(receipts.map((r: any) => r.action)).toEqual(['view']);
    await page.evaluate(() => {
      const w = window as any;
      Object.assign(w.fixture.notices[0], {
        id: 'next-answer',
        version: 'v2',
        eventId: 'next',
        text: '새 답변이에요',
        at: Date.now() + 1,
        receivedAt: Date.now() + 1,
        viewedAt: null,
        seenAt: null,
      });
      w.fixture.sessions[0].events = [
        {
          id: 'next',
          kind: 'assistant',
          phase: 'final',
          text: '새 답변이에요',
          at: Date.now() + 1,
        },
      ];
      w.publish();
    });
    await expect(bubble).toHaveClass(/bubble-new/);
    expect((await dot(page)).animation).toBe('soft-pulse');
  });
}

test('a viewed question stays unresolved but stops pulsing', async ({ page }) => {
  const bubble = await fixture(page, '#mini=row', true);
  await bubble.locator('.speech-open').click();
  await expect(bubble).toHaveClass(/bubble-opened/);
  await expect(bubble.locator('.bubble-halo')).toHaveCSS('animation-name', 'none');
  expect(await page.evaluate(() => (window as any).fixture.notices[0].resolvedAt)).toBeNull();
});

test('reduced motion keeps a fresh unread cue still', async ({ page }) => {
  const bubble = await fixture(page, '#mini=row', true, true);
  expect((await dot(page)).animation).toBe('none');
  await expect(bubble.locator('.bubble-halo')).toHaveCSS('animation-name', 'none');
});
