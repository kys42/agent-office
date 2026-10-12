import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

/** The dock's card window in the browser: the desktop bridge opens it on demo:0. */
async function card(page: Page, opts: { canSend?: boolean; terminal?: boolean } = {}) {
  const snapshot = demoSnapshot();
  await page.setViewportSize({ width: 480, height: 760 });
  await page.addInitScript(
    ({ s, canSend, terminal }) => {
      const w = window as any;
      w.fixture = s;
      w.sent = [];
      w.receipts = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
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
        card: async () => {},
        onCard: (cb: any) => {
          setTimeout(() => cb({ id: 'demo:0', news: false }), 50);
          return () => {};
        },
      };
    },
    { s: snapshot, canSend: opts.canSend ?? true, terminal: opts.terminal ?? true },
  );
  await page.goto('/#card');
  const aside = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(aside).toBeVisible();
  return aside;
}

test('The card opens as a chat: one header line, folded details, the conversation and a chat box', async ({
  page,
}) => {
  const aside = await card(page);
  await expect(aside.locator('.card-head h2')).toBeVisible();
  // No big banners above the conversation any more.
  await expect(aside.locator('.now-card')).toHaveCount(0);
  await expect(aside.locator('.inspector-actions')).toHaveCount(0);
  // Details fold at the top; the tabs are chat, updates and notes.
  const info = aside.locator('details.card-workinfo');
  await expect(info).not.toHaveAttribute('open', '');
  await expect(aside.getByRole('tab')).toHaveText(['대화', '소식', '기억 메모']);
  await expect(aside.getByRole('tab', { name: '대화' })).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: '.local/card-chat-folded.png' });
  await info.locator(':scope > summary').click();
  await expect(info.locator('.card-workinfo-body')).toBeVisible();
  // The conversation fills the card; the chat box sits at its bottom.
  const composer = (await aside.locator('.card-composer').boundingBox())!;
  expect(composer.y + composer.height).toBeGreaterThan(740);
  await page.screenshot({ path: '.local/card-chat.png' });
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

test('The more menu holds the actions that used to take a row', async ({ page }) => {
  const aside = await card(page);
  const more = aside.getByRole('button', { name: '카드 메뉴' });
  await more.click();
  const menu = aside.getByRole('menu');
  for (const name of ['인수인계 꾸리기', 'Orca로 이동', '이 동료 꾸미기', '이름 바꾸기'])
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  // Esc closes the menu, not the card.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(aside).toBeVisible();
  await more.click();
  await menu.getByRole('menuitem', { name: '인수인계 꾸리기' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('Without a live terminal the chat box says why and offers the way there', async ({ page }) => {
  const aside = await card(page, { terminal: false });
  await expect(aside.locator('.card-composer')).toContainText('입력할 수 있는 터미널이 없어요');
  await expect(aside.locator('.card-composer textarea')).toHaveCount(0);
});
