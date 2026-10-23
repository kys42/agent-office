import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { Snapshot } from '../../src/shared/types';

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
            if (action === 'unread') n.seenAt = null;
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

for (const mode of ['#mini=floor', '#mini=row']) {
  test(`a read reply leaves the dock; pointing peeks it and the pin keeps it up ${mode}`, async ({
    page,
  }) => {
    await fixture(page, mode);
    // Read elsewhere (its card stayed open): the bubble goes, as tiny's dot does.
    await page.evaluate(() => {
      const w = window as any;
      w.fixture.notices[0].seenAt = Date.now();
      w.publish();
    });
    await expect(page.locator('.speech-bubble')).toHaveCount(0);
    await page.locator('.row-station .office-pet').first().hover();
    const peek = page.locator('.speech-bubble.is-peek');
    await expect(peek).toBeVisible();
    await expect(peek.locator('.bubble-dismiss:not(.bubble-keep)')).toHaveCount(0);
    await peek.getByRole('button', { name: /말풍선 다시 띄워 두기/ }).click();
    const receipts = await page.evaluate(() => (window as any).receipts);
    expect(receipts.at(-1).action).toBe('unread');
    await page.mouse.move(0, 0);
    const kept = page.locator('.speech-bubble').first();
    await expect(kept).toBeVisible();
    await expect(kept).not.toHaveClass(/is-peek/);
    await expect(kept).toHaveClass(/unread/);
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

for (const mode of ['#mini', '']) {
  test(`Esc keeps the reply draft then closes on the second press ${mode || 'office'}`, async ({
    page,
  }) => {
    const bubble = await fixture(page, mode);
    await bubble.hover();
    await bubble.locator('.bubble-reply').click();
    const form = page.locator('.quick-reply');
    const input = form.getByRole('textbox', { name: '답장 내용' });
    await input.fill('마저 쓸 초안');
    await input.press('Escape');
    await expect(input).toHaveValue('마저 쓸 초안');
    await expect(form).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).sends)).toEqual([]);
  });
}

/** demo:0 answered a long request with a long final answer: both bubbles at their tallest. */
function tallest(): Snapshot {
  const snapshot = demoSnapshot();
  const now = Date.now();
  snapshot.sessions.find((x) => x.id === 'demo:0')!.events = [];
  const base = snapshot.notices![0];
  snapshot.notices = [
    {
      ...base,
      id: 'asked',
      sessionId: 'demo:0',
      eventId: 'asked',
      kind: 'request',
      phase: undefined,
      text: '로그인 화면 여백을 다듬어 줘. 버튼 색은 브랜드 컬러로 바꾸고, 바뀐 화면은 스크린샷으로 남겨 줘. '.repeat(
        6,
      ),
      at: now - 5 * 60_000,
      receivedAt: now - 5 * 60_000,
      version: 'v1',
      seenAt: null,
      viewedAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
    },
    {
      ...base,
      id: 'answer',
      sessionId: 'demo:0',
      eventId: 'answer',
      kind: 'reply',
      phase: 'final',
      text: '여백을 8px로 맞췄어요. 버튼 색도 브랜드 컬러로 바꾸고, 바뀐 화면은 스크린샷으로 남겼어요. '.repeat(
        8,
      ),
      at: now - 60_000,
      receivedAt: now - 60_000,
      version: 'v1',
      seenAt: null,
      viewedAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
    },
  ];
  return snapshot;
}

async function measureRequest(page: Page, mode: string) {
  const snapshot = tallest();
  await page.route('**/api/rpc', (route) => route.fulfill({ json: { result: snapshot } }));
  await page.goto(`/${mode}`);
  await page.reload();
  const desk = page.locator('.desk-row [data-station-id="demo:0"]');
  await expect(desk.locator('.speech-bubble')).toBeVisible();
  await desk.locator('.office-pet').hover();
  const request = desk.locator('.speech-request-bubble');
  await expect(request).toBeVisible();
  return request.evaluate((el) => {
    const r = el.getBoundingClientRect();
    // The dock window is exactly the row (the browser preview pins it to the bottom).
    const win = el.closest('.desk-row')!.getBoundingClientRect();
    const track = el.closest('.desk-row-track')!.getBoundingClientRect();
    const header = el.querySelector('small')!.getBoundingClientRect();
    // The header's middle shows the request (not cut away by the track's clip).
    const hit = document.elementFromPoint(header.x + 4, header.y + header.height / 2);
    return {
      top: Math.round(r.top - win.top),
      trackTop: Math.round(track.top - win.top),
      headerHit: !!hit && el.contains(hit),
    };
  });
}

for (const mode of ['#mini=row', '#mini=floor']) {
  test(`the stacked request bubble keeps its header inside the dock window ${mode}`, async ({
    page,
  }) => {
    const m = await measureRequest(page, mode);
    await page.locator('.desk-row').screenshot({ path: `.local/headroom-${mode.slice(6)}.png` });
    // Inside the window and not cut by the desks' track (it hides vertical overflow).
    expect(m.top).toBeGreaterThanOrEqual(0);
    expect(m.top).toBeGreaterThanOrEqual(m.trackTop);
    expect(m.headerHit).toBe(true);
  });
}
