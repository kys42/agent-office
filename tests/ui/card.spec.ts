import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

/** The dock's card window in the browser: the desktop bridge opens it on demo:0. */
async function card(
  page: Page,
  opts: { canSend?: boolean; terminal?: boolean; privacy?: boolean; id?: string } = {},
) {
  const snapshot = demoSnapshot();
  snapshot.preferences.privacy = !!opts.privacy;
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
          return 'sent';
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
  // Hand-off and the source folder sit in the header; pin, terminal and big office above the box.
  const head = aside.locator('.card-head');
  await expect(head.getByRole('button', { name: '인수인계 꾸리기' })).toBeVisible();
  await expect(head.getByRole('button', { name: '원본 위치 열기' })).toBeVisible();
  const actions = aside.locator('.card-actions');
  await expect(actions.getByRole('button', { name: 'Orca로 이동' })).toBeVisible();
  await expect(actions.getByRole('button', { name: '사무실에 고정' })).toBeVisible();
  await expect(actions.getByRole('button', { name: /큰 사무실/ })).toBeVisible();
  // Recent issues and PRs above the tabs: two, the rest behind "n more".
  const recent = aside.locator('.artifact-list');
  await expect(recent.locator('.artifact-row')).toHaveCount(2);
  await recent.getByRole('button', { name: /더 보기|1/ }).click();
  await expect(recent.locator('.artifact-row')).toHaveCount(3);
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
  for (const name of ['이름 바꾸기', '이 동료 꾸미기'])
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
  // Pin from the action row.
  await aside.getByRole('button', { name: '사무실에 고정' }).click();
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
  await expect(aside.locator('.conversation-toolbar')).toHaveCount(0);
  await aside.getByRole('button', { name: '필터' }).click();
  await expect(aside.locator('.conversation-toolbar')).toBeVisible();
  await expect(aside.locator('.conversation-range')).toHaveCount(0);
});
