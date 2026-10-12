import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

/**
 * The desktop app found text in Claude's prompt: the reply box shows it, keeps the reply as
 * written, and only [Clear & send] sends again with that exact text to clear.
 */
async function desktop(page: Page, hash = '', maybeSuggestion = false, clearable = true) {
  const fixture = demoSnapshot();
  // The big office and the row reply to the desk's own session; the pet speaks for the news.
  const now = Date.now();
  if (hash === '#mini') {
    // The pet speaks for the colleague who just answered (as in helpers-peek.spec.ts).
    const host = fixture.sessions.find((x) => x.id === 'demo:0')!;
    Object.assign(host, { status: 'ready', updatedAt: now - 10 * 60_000, events: [] });
  }
  fixture.notices =
    hash === '#mini'
      ? [
          {
            ...fixture.notices![0],
            id: 'answer',
            eventId: 'answer',
            kind: 'reply',
            phase: 'final',
            text: '여백을 8px로 맞췄어요.',
            at: now - 60_000,
            receivedAt: now - 60_000,
            dismissedAt: null,
            bootstrap: false,
          },
        ]
      : [];
  await page.addInitScript(
    (s) => {
      const w = window as any;
      w.sends = [];
      w.maybeSuggestion = s.maybeSuggestion;
      w.clearable = s.clearable;
      w.jumped = [];
      w.office = {
        snapshot: async () => structuredClone(s),
        detail: async (id: string) => structuredClone(s.sessions.find((x) => x.id === id)),
        visit: async () => structuredClone(s),
        preferences: async () => structuredClone(s),
        artifacts: async () => [],
        subscribe: () => () => {},
        terminalSend: async () => true,
        jump: async (id: string) => {
          w.jumped.push(id);
          return { action: 'focused', text: 'tmux work:1.0 패널을 선택했어요' };
        },
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
              ...(w.maybeSuggestion && { maybeSuggestion: true }),
              ...(!w.clearable && { clearable: false }),
            };
          return { status: 'sent', message: 'tmux work:1.0에 보냈어요', cleared: true };
        },
      };
    },
    Object.assign(fixture, { maybeSuggestion, clearable }),
  );
  await page.goto(`/${hash}`);
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
  // Esc drops only the question here too; the card stays open with the message.
  await field.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(field).toHaveValue('리뷰 반영해 주세요');
  await box.getByRole('button', { name: '보내기' }).click();
  await confirm.getByRole('button', { name: '지우고 보내기' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(field).toHaveValue('');
  await expect(page.locator('.toast')).toContainText('지운 글은 클립보드에 있어요');
});

/** The dock windows are exactly the stage: anything outside it is off the window. */
const inside = async (page: Page, stage: string, target: ReturnType<Page['locator']>) => {
  const s = (await page.locator(stage).boundingBox())!;
  const b = (await target.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(s.x - 0.5);
  expect(b.y).toBeGreaterThanOrEqual(s.y - 0.5);
  expect(b.x + b.width).toBeLessThanOrEqual(s.x + s.width + 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(s.y + s.height + 0.5);
};

for (const [hash, stage] of [
  ['#mini=row', '.desk-row'],
  ['#mini=floor', '.desk-row'],
  ['#mini', '.desk-pet-stage'],
] as const)
  test(`In the dock (${hash}), the question about the prompt stays inside the window`, async ({
    page,
  }) => {
    await desktop(page, hash);
    const pet = hash === '#mini';
    const desk = pet
      ? page.locator('.dock-pet-speech')
      : page.locator('.desk-row [data-station-id="demo:0"]');
    await (pet ? page.locator('.dock-pet-anchor') : desk.locator('.office-pet')).hover();
    await desk.locator('.bubble-reply').click();
    const reply = page.locator('.quick-reply');
    const field = reply.getByRole('textbox', { name: '답장 내용' });
    await field.fill('테스트를 먼저 돌려 주세요');
    await field.press('Enter');
    const confirm = reply.locator('.draft-confirm');
    await expect(confirm).toContainText('Claude 입력창에 이 글이 있어요');
    await page.screenshot({
      path: `.local/composer-draft${hash.replace('#mini', '-pet').replace('-pet=', '-')}.png`,
    });
    const clear = confirm.getByRole('button', { name: '지우고 보내기' });
    await inside(page, stage, clear);
    await inside(page, stage, confirm);
    await clear.click();
    await expect(page.locator('.toast, .dock-toast').first()).toContainText(
      '지운 글은 클립보드에 있어요',
    );
  });

/** The element a click at the middle of `target` lands on is `target` (or inside it). */
const clickable = (target: ReturnType<Page['locator']>) =>
  target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && el.contains(hit);
  });

test('In the big office the question is never covered by the next project area', async ({
  page,
}) => {
  await desktop(page, '', true);
  // Every desk with a reply button, so the open one has neighbours on each side.
  const buttons = page.locator('.bubble-reply');
  await expect(buttons.nth(1)).toBeVisible();
  const count = await buttons.count();
  expect(count).toBeGreaterThan(1);
  for (let i = 0; i < count; i++) {
    await page.locator('.bubble-reply').nth(i).click();
    const reply = page.locator('.quick-reply');
    const field = reply.getByRole('textbox', { name: '답장 내용' });
    await field.fill('테스트를 먼저 돌려 주세요');
    await field.press('Enter');
    const confirm = reply.locator('.draft-confirm');
    await expect(confirm).toContainText('추천 글일 수도 있어요');
    await expect(confirm).toContainText('원래 클립보드 내용을 대신해요');
    const clear = confirm.getByRole('button', { name: '지우고 보내기' });
    await clear.scrollIntoViewIfNeeded();
    expect(await clickable(clear), `desk ${i}`).toBe(true);
    expect(await clickable(confirm.getByRole('button', { name: '취소' })), `desk ${i}`).toBe(true);
    await reply.getByRole('button', { name: '답장 닫기' }).click();
    await expect(reply).toHaveCount(0);
  }
});

test('Text not all on screen is never cleared from here: the terminal is offered instead', async ({
  page,
}) => {
  await desktop(page, '', false, false);
  await page.getByRole('button', { name: '코코에게 바로 답장' }).click();
  const reply = page.locator('.quick-reply');
  const field = reply.getByRole('textbox', { name: '답장 내용' });
  await field.fill('테스트를 먼저 돌려 주세요');
  await field.press('Enter');
  const confirm = reply.locator('.draft-confirm');
  await expect(confirm).toContainText('입력창 글이 다 보이지 않아 여기서 지울 수 없어요');
  await expect(confirm.getByRole('button', { name: '지우고 보내기' })).toHaveCount(0);
  await confirm.getByRole('button', { name: '터미널로 이동' }).click();
  expect(await page.evaluate(() => (window as any).jumped)).toEqual(['demo:0']);
  // Nothing was cleared or sent again; the reply stays.
  expect((await sends(page)).length).toBe(1);
  await expect(field).toHaveValue('테스트를 먼저 돌려 주세요');
});
