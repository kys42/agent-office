import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

/**
 * The desktop app found text in Claude's prompt: the reply box shows it, keeps the reply as
 * written, and only [Clear & send] sends again with that exact text to clear.
 */
async function desktop(page: Page) {
  const fixture = demoSnapshot();
  fixture.notices = [];
  await page.addInitScript((s) => {
    const w = window as any;
    w.sends = [];
    w.office = {
      snapshot: async () => structuredClone(s),
      detail: async (id: string) => structuredClone(s.sessions.find((x) => x.id === id)),
      visit: async () => structuredClone(s),
      preferences: async () => structuredClone(s),
      artifacts: async () => [],
      subscribe: () => () => {},
      terminalSend: async () => true,
      terminals: async (ids: string[]) =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            { kind: 'tmux', label: 'work:1.0', status: 'idle', canSend: true, canFocus: true },
          ]),
        ),
      send: async (id: string, text: string, options?: { replaceDraft?: string }) => {
        w.sends.push({ id, text, options: options ?? null });
        if (options?.replaceDraft !== 'half-written idea\nsecond line')
          return {
            status: 'needs-confirm',
            draft: 'half-written idea\nsecond line',
            agent: 'Claude',
          };
        return { status: 'sent', message: 'tmux work:1.0에 보냈어요', cleared: true };
      },
    };
  }, fixture);
  await page.goto('/');
}
const sends = (page: Page) => page.evaluate(() => (window as any).sends);

test('A bubble reply shows the text already in the prompt and clears it only when asked', async ({
  page,
}) => {
  await desktop(page);
  await page.getByRole('button', { name: '코코에게 바로 답장' }).click();
  const reply = page.locator('.quick-reply');
  const field = reply.getByRole('textbox', { name: '답장 내용' });
  await field.fill('테스트를 먼저 돌려 주세요');
  await field.press('Enter');
  const confirm = reply.locator('.draft-confirm');
  await expect(confirm).toContainText('Claude 입력창에 이 글이 있어요');
  await expect(confirm.locator('.draft-confirm-text')).toHaveText('half-written idea\nsecond line');
  // Nothing was sent, and the reply is kept as written.
  await expect(field).toHaveValue('테스트를 먼저 돌려 주세요');
  await expect(page.locator('.toast')).toHaveCount(0);

  // Cancel drops only the question.
  await confirm.getByRole('button', { name: '취소' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(field).toHaveValue('테스트를 먼저 돌려 주세요');

  // Asked again; Esc also drops only the question, never the reply.
  await field.press('Enter');
  await expect(confirm).toBeVisible();
  await field.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(reply).toBeVisible();

  // Clear & send sends again with exactly the text that was shown.
  await field.press('Enter');
  await confirm.getByRole('button', { name: '지우고 보내기' }).click();
  await expect(reply).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText(
    'tmux work:1.0에 보냈어요 · 지운 글은 클립보드에 있어요',
  );
  const all = await sends(page);
  expect(all.map((s: any) => s.options?.replaceDraft ?? null)).toEqual([
    null,
    null,
    null,
    'half-written idea\nsecond line',
  ]);
  expect(new Set(all.map((s: any) => s.text))).toEqual(new Set(['테스트를 먼저 돌려 주세요']));
});

test('The work card asks the same way and empties its box after a confirmed send', async ({
  page,
}) => {
  await desktop(page);
  await page.getByRole('button', { name: '코코, 일하는 중', exact: true }).click();
  const box = page.locator('.terminal-send');
  const field = box.getByRole('textbox');
  await field.fill('리뷰 반영해 주세요');
  await box.getByRole('button', { name: '보내기' }).click();
  const confirm = box.locator('.draft-confirm');
  await expect(confirm).toContainText('Claude 입력창에 이 글이 있어요');
  await expect(field).toHaveValue('리뷰 반영해 주세요');
  await confirm.getByRole('button', { name: '지우고 보내기' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(field).toHaveValue('');
  await expect(page.locator('.toast')).toContainText('지운 글은 클립보드에 있어요');
});
