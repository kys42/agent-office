import { test, expect, type Locator, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { Preferences, Snapshot, TextSize } from '../../src/shared/types';
import { TEXT_SCALE } from '../../src/shared/text-prefs';
import { PET_SIZE } from '../../src/shared/dock-geometry';

// #246: text size and font for reading text, in every window. The pixel scene (name plates,
// bubble labels) keeps its size and its pixel lettering.

const ANSWER =
  '여백을 8px로 맞췄어요. 버튼 색도 브랜드 컬러로 바꾸고, 바뀐 화면은 스크린샷으로 남겼어요. ';

/** Two colleagues; run-0 left a final reply (a bubble at its desk and a card conversation). */
function office(prefs: Partial<Preferences> = {}): Snapshot {
  const snapshot = demoSnapshot();
  const template = snapshot.sessions[0];
  const base = snapshot.notices![0];
  const now = Date.now();
  snapshot.sessions = [0, 1].map((i) => ({
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
    status: 'idle',
    updatedAt: now,
    events: [
      {
        ...template.events[0],
        id: `asked-${i}`,
        kind: 'user' as const,
        text: '로그인 화면 여백을 다듬어 줘.',
        at: now - 120_000,
      },
      {
        ...template.events[0],
        id: `said-${i}`,
        kind: 'assistant' as const,
        text: ANSWER.repeat(3),
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
  snapshot.notices = [
    {
      ...base,
      id: 'final-0',
      sessionId: 'run-0',
      eventId: 'said-0',
      kind: 'reply',
      phase: 'final',
      text: ANSWER.repeat(3),
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
  snapshot.preferences = {
    ...snapshot.preferences,
    privacy: false,
    readOnOpen: false,
    locale: 'ko',
    ...prefs,
  };
  return snapshot;
}

/** The desktop bridge: saves preferences like the service and pushes them to this window. */
async function bridge(page: Page, snapshot: Snapshot, card?: string) {
  await page.addInitScript(
    ({ s, card }) => {
      const w = window as any;
      w.fixture = s;
      w.saved = [];
      w.listeners = [];
      w.publish = () => {
        w.fixture = { ...w.fixture, version: (w.fixture.version ?? 0) + 1 };
        for (const cb of w.listeners) cb(structuredClone(w.fixture));
      };
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        terminals: async () => ({}),
        subscribe: (cb: any) => {
          w.listeners.push(cb);
          return () => {};
        },
        preferences: async (p: any) => {
          w.saved.push(p);
          w.fixture.preferences = { ...w.fixture.preferences, ...p };
          w.publish();
          return structuredClone(w.fixture);
        },
        notices: async () => structuredClone(w.fixture),
        window: async () => {},
        settings: { open: async () => {}, onOpen: () => () => {} },
        dock: async () => {},
        onDock: () => () => {},
        ...(card
          ? {
              card: async () => {},
              cardState: async () => ({ pinned: false, positionRemembered: false }),
              onCardState: () => () => {},
              onCard: (cb: any) => {
                setTimeout(() => cb({ id: card, news: false }), 50);
                return () => {};
              },
            }
          : { card: async () => {} }),
      };
    },
    { s: snapshot, card },
  );
}
/** Another window (the settings window) changed a preference: the service pushes it here. */
const setPref = (page: Page, patch: Partial<Preferences>) =>
  page.evaluate((patch) => {
    const w = window as any;
    w.fixture.preferences = { ...w.fixture.preferences, ...patch };
    w.publish();
  }, patch);
const saved = (page: Page) => page.evaluate(() => (window as any).saved as Partial<Preferences>[]);
const size = (el: Locator) => el.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
const family = (el: Locator) => el.evaluate((e) => getComputedStyle(e).fontFamily);
/** The desk with its bubble above it (the bubble overflows the desk's box). */
async function shootDesk(page: Page, desk: Locator, path: string) {
  const d = (await desk.boundingBox())!;
  const b = (await desk.locator('.speech-bubble').boundingBox())!;
  const x = Math.max(0, Math.min(d.x, b.x) - 8);
  const y = Math.max(0, Math.min(d.y, b.y) - 8);
  const right = Math.max(d.x + d.width, b.x + b.width) + 8;
  await page.screenshot({
    path,
    clip: { x, y, width: right - x, height: d.y + d.height - y + 8 },
  });
}
const expectSize = async (el: Locator, px: number) =>
  expect.poll(() => size(el)).toBeCloseTo(px, 2);

test('the big office: card conversation and bubbles scale; name plates and labels do not', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bridge(page, office());
  await page.goto('/?lang=ko');
  const desk = page.locator('[data-station-id="run-0"]');
  const bubbleText = desk.locator('.speech-text');
  const label = desk.locator('.bubble-label');
  const plate = desk.locator('.desk-name strong');
  await expect(bubbleText).toBeVisible();
  await expectSize(bubbleText, 11);
  await expectSize(label, 9);
  await expectSize(plate, 11);
  await page.locator('.office-pet[data-session-id="run-0"]').click();
  const card = page.getByRole('complementary', { name: '동료의 업무 카드' });
  const message = card.locator('.message-text').last();
  const title = card.locator('.card-title h2');
  await expect(message).toBeVisible();
  await expectSize(message, 12.5);
  await expectSize(title, 14.5);
  const plateFont = await family(plate);
  expect(plateFont).toContain('Galmuri11');
  expect(await family(message)).toContain('-apple-system');

  for (const [choice, scale] of [
    ['large', 1.12],
    ['larger', 1.25],
    ['small', 0.92],
  ] as const) {
    await setPref(page, { textSize: choice });
    await expectSize(message, 12.5 * scale);
    await expectSize(title, 14.5 * scale);
    await expectSize(bubbleText, 11 * scale);
    // The scene keeps its pixel lettering at its own size.
    await expectSize(label, 9);
    await expectSize(plate, 11);
    if (choice !== 'small') {
      await card.screenshot({ path: `.local/text-card-${choice}.png` });
      await shootDesk(page, desk, `.local/text-bubble-${choice}.png`);
    }
  }
  // The card header still fits its width at the largest size.
  await setPref(page, { textSize: 'larger' });
  await expectSize(title, 14.5 * 1.25);
  const head = await card
    .locator('.card-head')
    .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(head.scroll).toBeLessThanOrEqual(head.client + 1);

  await setPref(page, { readingFont: 'mono' });
  await expect.poll(() => family(message)).toContain('ui-monospace');
  expect(await family(bubbleText)).toContain('ui-monospace');
  expect(await family(title)).toContain('ui-monospace');
  // Name plates and bubble labels keep the pixel font.
  expect(await family(plate)).toBe(plateFont);
  expect(await family(label)).toContain('Galmuri11');
  await card.screenshot({ path: '.local/text-card-mono.png' });
  await shootDesk(page, desk, '.local/text-bubble-mono.png');
  await setPref(page, { readingFont: 'pretendard' });
  await expect.poll(() => family(message)).toMatch(/^"?Pretendard Variable/);
  // The bundled Pretendard (main.tsx, font-display: swap) actually loads for the Hangul shown.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        await document.fonts.load('16px "Pretendard Variable"', '여백');
        return document.fonts.check('16px "Pretendard Variable"', '여백');
      }),
    )
    .toBe(true);
});

test('the roster rows scale and still fit their column at the largest size', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bridge(page, office({ textSize: 'larger' }));
  await page.goto('/?lang=ko');
  const roster = page.locator('aside.roster');
  const name = roster.locator('.session-copy strong').first();
  await expect(name).toBeVisible();
  await expectSize(name, 13 * 1.25);
  for (const row of await roster.locator('.session-copy').all()) {
    const fit = await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fit).toBe(true);
  }
  await roster.screenshot({ path: '.local/text-roster-larger.png' });
});

test('the command palette and the memory drawer follow the size and font', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bridge(page, office({ textSize: 'larger', readingFont: 'mono' }));
  await page.goto('/?lang=ko');
  await expect(page.locator('.office-pet').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: '명령 팔레트' });
  const item = palette.locator('.palette-item b').first();
  await expect(item).toBeVisible();
  await expectSize(item, 13 * 1.25);
  expect(await family(item)).toContain('ui-monospace');
  await palette.screenshot({ path: '.local/text-palette-larger-mono.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '기억 서랍', exact: true }).click();
  const search = page.locator('.memory-search input');
  await expect(search).toBeVisible();
  await expectSize(search, 16 * 1.25);
  expect(await family(search)).toContain('ui-monospace');
});

test('the demo applies its own choice without touching the boot cache', async ({ page }) => {
  await page.goto('/?demo&lang=ko');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page
    .getByRole('tablist', { name: '설정 분류' })
    .getByRole('tab', { name: '모습', exact: true })
    .click();
  await page
    .getByRole('group', { name: '글자 크기' })
    .getByRole('button', { name: '크게', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.textSize))
    .toBe('large');
  expect(await page.evaluate(() => localStorage.getItem('office:reading-text:v1'))).toBeNull();
});

test('the settings page picks size and font with a live preview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bridge(page, office());
  await page.goto('/?lang=ko');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page
    .getByRole('tablist', { name: '설정 분류' })
    .getByRole('tab', { name: '모습', exact: true })
    .click();
  const section = page.locator('[data-guide-section="text"]');
  await expect(section.getByRole('heading', { name: '글자' })).toBeVisible();
  const sizes = section.getByRole('group', { name: '글자 크기' });
  const fonts = section.getByRole('group', { name: '글꼴' });
  await expect(sizes.getByRole('button')).toHaveText(['작게', '보통', '크게', '더 크게']);
  await expect(fonts.getByRole('button')).toHaveText(['시스템 기본', 'Pretendard', '고정폭']);
  await expect(sizes.getByRole('button', { name: '보통' })).toHaveAttribute('aria-pressed', 'true');
  await expect(fonts.getByRole('button', { name: '시스템 기본' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const preview = section.locator('.text-preview p');
  const rowTitle = section.locator('.setting-row b').first();
  await expectSize(preview, 12.5);
  await expectSize(rowTitle, 12.5);

  await sizes.getByRole('button', { name: '더 크게' }).click();
  await expect(sizes.getByRole('button', { name: '더 크게' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expectSize(preview, 12.5 * 1.25);
  await expectSize(rowTitle, 12.5 * 1.25);
  await fonts.getByRole('button', { name: '고정폭' }).click();
  await expect.poll(() => family(preview)).toContain('ui-monospace');
  await section.screenshot({ path: '.local/text-settings-section.png' });
  expect(await saved(page)).toEqual([{ textSize: 'larger' }, { readingFont: 'mono' }]);
});

test('the dock row follows the setting live, capped at 크게; the name plates stay', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 720 });
  await bridge(page, office({ textSize: 'large' }));
  await page.goto('/?lang=ko#mini=row');
  const desk = page.locator('.desk-row [data-station-id="run-0"]');
  const bubbleText = desk.locator('.speech-text');
  await expect(bubbleText).toBeVisible();
  await expectSize(bubbleText, 11 * 1.12);
  // 더 크게 keeps the dock's bubbles at 크게: its headroom is fixed.
  await setPref(page, { textSize: 'larger' });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.textSize))
    .toBe('larger');
  await expectSize(bubbleText, 11 * 1.12);
  await expectSize(desk.locator('.bubble-label'), 9);
  await setPref(page, { textSize: 'small', readingFont: 'mono' });
  await expectSize(bubbleText, 11 * 0.92);
  await expect.poll(() => family(bubbleText)).toContain('ui-monospace');
  expect(await family(desk.locator('.bubble-label'))).toContain('Galmuri11');
});

test('a bubble that just fits gets its unfold control once a wider font makes it overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bridge(page, office());
  await page.goto('/?lang=ko');
  const bubble = page.locator('[data-station-id="run-0"] .speech-bubble');
  const unfold = bubble.locator('.bubble-expand');
  await expect(bubble.locator('.speech-text')).toBeVisible();
  const say = async (words: number) => {
    const text = Array.from({ length: words }, (_, i) => `step${i}`).join(' ');
    await page.evaluate((text) => {
      const w = window as any;
      w.fixture.notices[0].text = text;
      w.fixture.sessions[0].events[1].text = text;
      w.publish();
    }, text);
    await expect(bubble.locator('.speech-text')).toContainText(text.slice(-6));
    return (await unfold.count()) > 0;
  };
  // The most words that still fit its two lines without an unfold control.
  let fits = 1;
  let overflows = 40;
  expect(await say(overflows)).toBe(true);
  while (overflows - fits > 1) {
    const mid = Math.floor((fits + overflows) / 2);
    if (await say(mid)) overflows = mid;
    else fits = mid;
  }
  expect(await say(fits)).toBe(false);
  // The box keeps its two-line height; only the text inside reflows. It must measure again.
  await setPref(page, { readingFont: 'mono' });
  await expect.poll(() => family(bubble.locator('.speech-text'))).toContain('ui-monospace');
  await expect(unfold).toBeVisible();
});

test('the popup card window applies the saved size', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 760 });
  await bridge(page, office({ textSize: 'larger', readingFont: 'mono' }), 'run-0');
  await page.goto('/?lang=ko#card');
  const card = page.getByRole('complementary', { name: '동료의 업무 카드' });
  const message = card.locator('.message-text').last();
  await expect(message).toBeVisible();
  await expectSize(message, 12.5 * 1.25);
  expect(await family(message)).toContain('ui-monospace');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(480);
  await card.screenshot({ path: '.local/text-popup-card-larger.png' });
});

test('the settings window deep-links to the text section and applies the size at phone width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await bridge(page, office({ textSize: 'larger', locale: 'en' }));
  await page.goto('/?lang=en#settings=text');
  const tabs = page.getByRole('tablist', { name: 'Settings categories' });
  await expect(tabs.getByRole('tab', { name: 'Appearance' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const section = page.locator('[data-guide-section="text"]');
  await expect(section.getByRole('heading', { name: 'Text' })).toBeInViewport();
  await expect(section.getByRole('group', { name: 'Text size' }).getByRole('button')).toHaveText([
    'Small',
    'Normal',
    'Large',
    'Larger',
  ]);
  await expect(
    section.getByRole('group', { name: 'Text size' }).getByRole('button', { name: 'Larger' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expectSize(section.locator('.setting-row b').first(), 12.5 * 1.25);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const group of await section.locator('.segmented').all()) {
    const box = (await group.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await section.screenshot({ path: '.local/text-settings-window-larger.png' });
});

/** demo:0 answered a long request with a long final answer: both bubbles at their tallest. */
function tallest(textSize: TextSize): Snapshot {
  const snapshot = demoSnapshot();
  const now = Date.now();
  snapshot.sessions.find((x) => x.id === 'demo:0')!.events = [];
  const base = snapshot.notices![0];
  const notice = (id: string, kind: 'request' | 'reply', text: string, at: number) => ({
    ...base,
    id,
    sessionId: 'demo:0',
    eventId: id,
    kind,
    phase: kind === 'reply' ? ('final' as const) : undefined,
    text,
    at,
    receivedAt: at,
    version: 'v1',
    seenAt: null,
    viewedAt: null,
    dismissedAt: null,
    resolvedAt: null,
    bootstrap: false,
  });
  snapshot.notices = [
    notice(
      'asked',
      'request',
      '로그인 화면 여백을 다듬어 줘. 버튼 색은 브랜드 컬러로 바꾸고, 바뀐 화면은 스크린샷으로 남겨 줘. '.repeat(
        6,
      ),
      now - 5 * 60_000,
    ),
    notice('answer', 'reply', ANSWER.repeat(8), now - 60_000),
  ];
  snapshot.preferences = { ...snapshot.preferences, textSize };
  return snapshot;
}

/** Where a bubble's box sits in its window, and whether its scroller cuts a line in half. */
const box = (el: Locator, win: string) =>
  el.evaluate((e, win) => {
    const frame = (e.closest(win) ?? document.documentElement).getBoundingClientRect();
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top - frame.top), bottom: Math.round(r.bottom - frame.top) };
  }, win);
/** The dock's bubbles grow at most to 크게: its headroom is fixed (dock.css). */
const dockScale = (size: TextSize) => Math.min(TEXT_SCALE[size], TEXT_SCALE.large);
const wholeLines = (el: Locator) =>
  el.evaluate((e) => {
    const lines = e.clientHeight / parseFloat(getComputedStyle(e).lineHeight);
    return Math.abs(lines - Math.round(lines)) < 0.1 ? Math.round(lines) : lines;
  });

for (const mode of ['#mini=row', '#mini=floor']) {
  for (const textSize of ['normal', 'large', 'larger'] as const) {
    test(`the stacked answer and request bubbles fit the dock headroom ${mode} ${textSize}`, async ({
      page,
    }) => {
      const snapshot = tallest(textSize);
      await page.route('**/api/rpc', (route) => route.fulfill({ json: { result: snapshot } }));
      await page.goto(`/?lang=ko${mode}`);
      const desk = page.locator('.desk-row [data-station-id="demo:0"]');
      const bubble = desk.locator('.speech-bubble');
      const said = bubble.locator('.speech-text');
      await expect(bubble).toBeVisible();
      await expectSize(said, 11 * dockScale(textSize));
      expect((await box(bubble, '.desk-row')).top).toBeGreaterThanOrEqual(0);
      expect(await wholeLines(said)).toBe(5);
      // Worst case: the request stacked over the answer on hover, both at their tallest.
      await desk.locator('.office-pet').hover();
      const request = desk.locator('.speech-request-bubble');
      const asked = request.locator('.speech-request-text');
      await expect(request).toBeVisible();
      await expectSize(asked, 11 * dockScale(textSize));
      const m = await request.evaluate((el) => {
        const win = el.closest('.desk-row')!.getBoundingClientRect();
        const track = el.closest('.desk-row-track')!.getBoundingClientRect();
        const header = el.querySelector('small')!.getBoundingClientRect();
        const hit = document.elementFromPoint(header.x + 4, header.y + header.height / 2);
        return {
          top: Math.round(el.getBoundingClientRect().top - win.top),
          trackTop: Math.round(track.top - win.top),
          headerHit: !!hit && el.contains(hit),
        };
      });
      expect(m.top).toBeGreaterThanOrEqual(0);
      expect(m.top).toBeGreaterThanOrEqual(m.trackTop);
      expect(m.headerHit).toBe(true);
      // Both scrollers show whole lines only: the answer 3 under a request, the request 4.
      expect(await wholeLines(said)).toBe(3);
      expect(await wholeLines(asked)).toBe(4);
      if (textSize !== 'normal')
        await page
          .locator('.desk-row')
          .screenshot({ path: `.local/text-headroom-${mode.slice(6)}-${textSize}.png` });
      // Unfolded, the reply scrolls inside its headroom too.
      await page.mouse.move(0, 0);
      await bubble.getByRole('button', { name: '말풍선 전체 보기', exact: true }).click();
      await expect(bubble).toHaveClass(/is-expanded/);
      expect((await box(bubble, '.desk-row')).top).toBeGreaterThanOrEqual(0);
    });
  }
}

for (const textSize of ['normal', 'large', 'larger'] as const) {
  test(`the desk pet: the hovered answer and request fit its window ${textSize}`, async ({
    page,
  }) => {
    await page.setViewportSize(PET_SIZE);
    const snapshot = tallest(textSize);
    await page.route('**/api/rpc', (route) => route.fulfill({ json: { result: snapshot } }));
    await page.goto('/?lang=ko#mini');
    const speech = page.locator('.dock-pet-speech');
    await page.locator('.dock-pet-anchor').hover();
    const request = speech.locator('.speech-request-bubble');
    await expect(request).toBeVisible();
    const asked = request.locator('.speech-request-text');
    await expectSize(asked, 11 * dockScale(textSize));
    expect((await box(request, 'body')).top).toBeGreaterThanOrEqual(0);
    // Whole lines only: the request 2, the answer under it 2.
    expect(await wholeLines(asked)).toBe(2);
    expect(await wholeLines(speech.locator('.speech-text'))).toBe(2);
    if (textSize !== 'normal')
      await page.screenshot({ path: `.local/text-headroom-pet-${textSize}.png` });
  });
}
