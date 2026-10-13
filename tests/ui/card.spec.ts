import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';
import type { OfficeEvent } from '../../src/shared/types';

/** The dock's card window in the browser: the desktop bridge opens it on demo:0. */
async function card(
  page: Page,
  opts: {
    canSend?: boolean;
    terminal?: boolean;
    privacy?: boolean;
    id?: string;
    events?: OfficeEvent[];
  } = {},
) {
  const snapshot = demoSnapshot();
  if (opts.events) snapshot.sessions[0].events = opts.events;
  snapshot.preferences.privacy = !!opts.privacy;
  // A helper of demo:0, to open as its own card.
  snapshot.sessions.push({
    ...snapshot.sessions[0],
    id: 'demo:helper',
    nativeId: 'demo-helper',
    alias: '',
    title: '보조 조사',
    officeSeat: undefined,
    relation: { kind: 'subagent', parentNativeId: 'demo-0', role: '조사', source: 'demo' },
    parentId: 'demo-0',
  });
  // An unread final answer from the opened colleague (its card shows the 'new' chip).
  const id = opts.id ?? 'demo:0';
  const at = Date.now() - 60_000;
  snapshot.notices = [
    ...(snapshot.notices ?? []),
    {
      id: `fresh-${id}`,
      sessionId: id,
      eventId: `fresh-${id}`,
      kind: 'reply',
      phase: 'final',
      text: '정리해 두었어요.',
      at,
      receivedAt: at,
      version: 'v1',
      seenAt: null,
      viewedAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
    },
  ];
  await page.setViewportSize({ width: 480, height: 760 });
  await page.addInitScript(
    ({ s, canSend, terminal }) => {
      const w = window as any;
      w.fixture = s;
      w.sent = [];
      w.receipts = [];
      w.cardCalls = [];
      w.jumps = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        // The colleague's recent work, as the service reads it from GitHub.
        artifacts: async () => [
          {
            url: 'https://github.com/kys42/agent-office/pull/95',
            kind: 'pull',
            repo: 'kys42/agent-office',
            number: 95,
            title: '팝업 업무 카드를 채팅형으로',
            state: 'open',
          },
          {
            url: 'https://github.com/kys42/agent-office/issues/86',
            kind: 'issues',
            repo: 'kys42/agent-office',
            number: 86,
            title: '크기 조절·아래 입력창·윗줄 정리',
            state: 'open',
          },
          {
            url: 'https://github.com/kys42/agent-office/pull/89',
            kind: 'pull',
            repo: 'kys42/agent-office',
            number: 89,
            title: '스크롤 깜박임 막기',
            state: 'merged',
          },
        ],
        subscribe: () => () => {},
        notices: async (receipts: any[], action: string) => {
          w.receipts.push([action, receipts.map((r: any) => r.id)]);
          w.fixture.notices = w.fixture.notices.map((n: any) =>
            receipts.some((r: any) => r.id === n.id) && action === 'read'
              ? { ...n, seenAt: Date.now() }
              : n,
          );
          return structuredClone(w.fixture);
        },
        terminalSend: async () => true,
        send: async (id: string, text: string) => {
          w.sent.push([id, text]);
          return { status: 'sent', message: '보냈어요' };
        },
        terminals: async (ids: string[]) =>
          Object.fromEntries(
            ids.map((id) => [
              id,
              terminal
                ? { kind: 'orca', label: 'Orca', status: 'idle', canSend, canFocus: true }
                : null,
            ]),
          ),
        handoff: async () => ({ markdown: '# 인수인계', revision: 'r', createdAt: Date.now() }),
        card: async (what: string) => {
          w.cardCalls.push(what);
        },
        jump: async (id: string) => {
          w.jumps.push(id);
          return { action: 'focused', text: '' };
        },
        onCard: (cb: any) => {
          setTimeout(() => cb({ id: w.cardId, news: false }), 50);
          return () => {};
        },
      };
    },
    { s: snapshot, canSend: opts.canSend ?? true, terminal: opts.terminal ?? true },
  );
  await page.addInitScript((id) => ((window as any).cardId = id), id);
  await page.goto('/#card');
  const aside = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(aside).toBeVisible();
  return aside;
}

test('The card opens as a glass chat: header tools, recent work, tabs, actions and a chat box', async ({
  page,
}) => {
  const aside = await card(page);
  await expect(aside.locator('.card-head h2')).toContainText('Coco');
  // No banners or chips above the conversation.
  await expect(aside.locator('.now-card')).toHaveCount(0);
  await expect(aside.locator('.card-chip')).toHaveCount(0);
  await expect(aside.locator('.inspector-actions')).toHaveCount(0);
  // Hand-off, pin and the big office sit top right; the terminal button above the box.
  const head = aside.locator('.card-head');
  for (const name of [
    '인수인계 꾸리기',
    '사무실에 고정',
    '큰 사무실에서 보기',
    '카드 메뉴',
    '업무 카드 닫기',
  ])
    await expect(head.getByRole('button', { name })).toBeVisible();
  const actions = aside.locator('.card-actions');
  await expect(actions.getByRole('button')).toHaveText(['Orca로 이동']);
  // The header moves the card by the desktop following the cursor: no CSS drag region.
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('*')].some(
        (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'drag',
      ),
    ),
  ).toBe(false);
  // Recent issues and PRs above the tabs: two, the rest behind "n more".
  const recent = aside.locator('.artifact-list');
  await expect(recent.locator('.artifact-row')).toHaveCount(2);
  // Most recently mentioned first (the service keeps them in the order the chat met them).
  await expect(recent.locator('.artifact-row').first()).toContainText('#89');
  // Answers are signed with the colleague's name, not the tool's.
  await expect(aside.locator('.message-assistant .message-meta').first()).toContainText('Coco');
  await expect(aside.locator('.message-assistant .message-meta').first()).not.toContainText(
    'Claude Code',
  );
  await recent.getByRole('button', { name: /더 보기|1/ }).click();
  await expect(recent.locator('.artifact-row')).toHaveCount(3);
  // Only once: the office panel's tray stays out of the card (one read of the work, not two).
  await expect(aside.locator('.artifact-tray')).toHaveCount(0);
  const box = (await recent.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(152);
  await expect(aside.getByRole('tab')).toHaveText(['대화', /^소식/, '작업 정보', '기억 메모']);
  await expect(aside.getByRole('tab', { name: '대화' })).toHaveAttribute('aria-selected', 'true');
  // The chat box sits at the bottom.
  const composer = (await aside.locator('.card-composer').boundingBox())!;
  expect(composer.y + composer.height).toBeGreaterThan(740);
  await page.screenshot({ path: '.local/card-chat.png' });
});

test('Progress notes can be hidden from the chat, and the choice is remembered', async ({
  page,
}) => {
  const aside = await card(page);
  const progress = aside.getByRole('switch', { name: '진행 소식 보이기' });
  await expect(progress).toBeChecked();
  const shown = await aside.locator('.conversation-message.category-progress').count();
  expect(shown).toBeGreaterThan(0);
  await progress.click();
  await expect(aside.locator('.conversation-message.category-progress')).toHaveCount(0);
  await expect(aside.locator('.conversation-hidden-note')).toContainText('진행 소식');
  await page.reload();
  await expect(
    page.getByRole('complementary', { name: '동료의 업무 카드' }).getByRole('switch'),
  ).not.toBeChecked();
  await page.screenshot({ path: '.local/card-chat-quiet.png' });
});

test('Enter sends from the chat box, Shift+Enter breaks the line', async ({ page }) => {
  const aside = await card(page);
  const box = aside.locator('.card-composer textarea');
  await box.fill('첫 줄');
  await box.press('Shift+Enter');
  await box.pressSequentially('둘째 줄');
  await expect(box).toHaveValue('첫 줄\n둘째 줄');
  await box.press('Enter');
  await expect
    .poll(() => page.evaluate(() => (window as any).sent))
    .toEqual([['demo:0', '첫 줄\n둘째 줄']]);
  await expect(box).toHaveValue('');
});

test('The card menu holds the rest, and works from the keyboard', async ({ page }) => {
  const aside = await card(page);
  const more = aside.getByRole('button', { name: '카드 메뉴' });
  await more.click();
  const menu = aside.getByRole('menu');
  for (const name of ['이름 바꾸기', '이 동료 꾸미기', '원본 위치 열기'])
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  expect(await page.evaluate(() => (window as any).cardCalls)).toEqual([]);
  // A second Esc is for the card.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as any).cardCalls)).toEqual(['close']);
  // Hand-off from the header.
  await aside.getByRole('button', { name: '인수인계 꾸리기' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('Without a live terminal the chat box says why', async ({ page }) => {
  const aside = await card(page, { terminal: false });
  await expect(aside.locator('.card-composer')).toContainText('입력할 수 있는 터미널이 없어요');
  await expect(aside.locator('.card-composer textarea')).toHaveCount(0);
});

test('A colleague waiting for the person makes the terminal button the primary one', async ({
  page,
}) => {
  // demo:3 is calling.
  const aside = await card(page, { id: 'demo:3' });
  const go = aside.locator('.card-actions').getByRole('button', { name: 'Orca로 이동' });
  await expect(go).toHaveClass(/primary/);
  await go.click();
  await expect.poll(() => page.evaluate(() => (window as any).jumps)).toEqual(['demo:3']);
  // Pin from the header.
  await aside.locator('.card-head').getByRole('button', { name: '사무실에 고정' }).click();
});

test('Sharing the screen hides recent work and names but keeps the chat card usable', async ({
  page,
}) => {
  const aside = await card(page, { privacy: true });
  await expect(aside.locator('.artifact-list')).toHaveCount(0);
  await expect(aside.locator('.card-head h2')).not.toContainText('Coco');
  await expect(aside.locator('.card-composer textarea')).toBeVisible();
});

test('Filters fold behind a small button in the card', async ({ page }) => {
  const aside = await card(page);
  // Reachable at the newest message too (it sticks to the top of the chat).
  await expect(aside.locator('.conversation-sticky')).toHaveCSS('position', 'sticky');
  await expect(aside.locator('.conversation-toolbar')).toHaveCount(0);
  const toggle = aside.getByRole('button', { name: '필터' });
  await toggle.click();
  await expect(aside.locator('.conversation-toolbar')).toBeVisible();
  // Scrolled to the newest message, the opened filters never cover the button that folds them.
  await aside.locator('.inspector-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await toggle.click();
  await expect(aside.locator('.conversation-toolbar')).toHaveCount(0);
  await expect(aside.locator('.conversation-range')).toHaveCount(0);
});

test("A helper's card leads back to the colleague it works for", async ({ page }) => {
  const aside = await card(page, { id: 'demo:helper' });
  await aside.getByRole('tab', { name: '작업 정보' }).click();
  const parent = aside.getByRole('button', { name: /부모 작업/ });
  await expect(parent).toBeVisible();
  await parent.click();
  await expect(aside.locator('.card-head h2')).toContainText('Coco');
});

test('Pressing the header moves the card; its buttons do not', async ({ page }) => {
  const aside = await card(page);
  const head = aside.locator('.card-head');
  const box = (await head.boundingBox())!;
  // The empty space between the name and the buttons.
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => (window as any).cardCalls))
    .toEqual(['drag-start', 'drag-end']);
  await head.getByRole('button', { name: '사무실에 고정' }).click();
  expect(await page.evaluate(() => (window as any).cardCalls)).toEqual(['drag-start', 'drag-end']);
});

test('Details read as grouped rows', async ({ page }) => {
  const aside = await card(page);
  await aside.getByRole('tab', { name: '작업 정보' }).click();
  // Status, where it works, its helper (the fixture's), its usage.
  await expect(aside.locator('.info-group')).toHaveCount(4);
  await expect(aside.locator('.info-group').first()).toContainText('상태');
  await expect(aside.getByRole('button', { name: /실행 경로/ })).toBeVisible();
  await page.screenshot({ path: '.local/card-info.png' });
});

test('At the smallest card width the tabs never run under the filter or the switch', async ({
  page,
}) => {
  const aside = await card(page);
  await page.setViewportSize({ width: 380, height: 480 });
  const tabs = (await aside.locator('.inspector-tabs').boundingBox())!;
  const filter = (await aside.getByRole('button', { name: '필터' }).boundingBox())!;
  expect(tabs.x + tabs.width).toBeLessThanOrEqual(filter.x);
  await aside.getByRole('tab', { name: '기억 메모' }).click();
  await expect(aside.getByRole('tab', { name: '기억 메모' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('What the person sends shows at once, marked as waiting, until the record has it', async ({
  page,
}) => {
  const aside = await card(page);
  const box = aside.locator('.card-composer textarea');
  await box.fill('작업 끝나면 테스트도 돌려 줘');
  await box.press('Enter');
  const waiting = aside.locator('.message-pending');
  await expect(waiting).toContainText('작업 끝나면 테스트도 돌려 줘');
  await expect(waiting).toContainText('차례를 기다리는 중');
});

test('The same words sent twice wait as two bubbles', async ({ page }) => {
  const aside = await card(page);
  const box = aside.locator('.card-composer textarea');
  for (let i = 0; i < 2; i++) {
    await box.fill('계속해 줘');
    await box.press('Enter');
  }
  await expect(aside.locator('.message-pending')).toHaveCount(2);
});

test('The card can be kept open when the person clicks elsewhere, and remembers it', async ({
  page,
}) => {
  const aside = await card(page);
  const keep = aside.getByRole('button', { name: '카드 열어 두기' });
  await expect(keep).toHaveAttribute('aria-pressed', 'false');
  await keep.click();
  await expect(keep).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => (window as any).cardCalls.at(-1))).toBe('keep-on');
  await page.reload();
  await expect(
    page.locator('.inspector-card').getByRole('button', { name: '카드 열어 두기' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => page.evaluate(() => (window as any).cardCalls.includes('keep-on')))
    .toBe(true);
  // Let go again: blur closes it once more.
  await page.locator('.inspector-card').getByRole('button', { name: '카드 열어 두기' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).cardCalls.at(-1))).toBe('keep-off');
});

test('A run of progress notes reads as one: who and when only on the first, a pause gets a time line', async ({
  page,
}) => {
  // Late morning today: the hour of messages never crosses midnight.
  const now = new Date().setHours(11, 0, 0, 0);
  const ev = (id: string, at: number, kind: OfficeEvent['kind'], text: string, phase?: string) =>
    ({ id, at, kind, text, phase, sourceRef: 'demo' }) as OfficeEvent;
  const aside = await card(page, {
    events: [
      ev('u1', now - 60 * 60_000, 'user', '정리해 줘'),
      ev('p1', now - 59 * 60_000, 'assistant', '파일을 읽어요', 'commentary'),
      ev('p2', now - 58 * 60_000, 'assistant', '고칠 곳을 찾았어요', 'commentary'),
      ev('p3', now - 57 * 60_000, 'assistant', '테스트를 돌려요', 'commentary'),
      ev('f1', now - 56 * 60_000, 'assistant', '다 했어요', 'final'),
      ev('u2', now - 5 * 60_000, 'user', '고마워'),
    ],
  });
  const msg = (id: string) => aside.locator(`.conversation-message[data-event-id="${id}"]`);
  await expect(msg('p1')).not.toHaveClass(/is-continued/);
  await expect(msg('p2')).toHaveClass(/is-continued/);
  await expect(msg('p3')).toHaveClass(/is-continued/);
  // The answer after the notes says who again.
  await expect(msg('f1')).not.toHaveClass(/is-continued/);
  await expect(msg('p2').locator('.message-meta')).toHaveCSS('opacity', '0');
  await msg('p2').hover();
  await expect(msg('p2').locator('.message-meta')).toHaveCSS('opacity', '1');
  await expect(msg('p2').locator('.message-meta time')).toBeVisible();
  // Fifty minutes later: a time line before the next message, and it starts a new run.
  await expect(aside.locator('.conversation-pause')).toHaveCount(1);
  await expect(msg('u2')).not.toHaveClass(/is-continued/);
  await page.screenshot({ path: '.local/card-runs.png' });
});
