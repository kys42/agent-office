import { expect, test, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { sessionName } from '../../src/shared/office';
import type { OfficeEvent, Snapshot } from '../../src/shared/types';
import type { CardPin } from '../../src/shared/card-windows';

// Picking a run of chat bubbles to copy at once or hand to another colleague (#377), in the
// dock card window and in the big office's column (the same card).

const at = Date.now() - 200_000;
const ev = (id: string, kind: OfficeEvent['kind'], text: string, extra = {}): OfficeEvent => ({
  id,
  kind,
  text,
  at: at + Number(id.replace(/\D/g, '')) * 1000,
  sourceRef: 'test',
  ...extra,
});

function office(long = false): Snapshot {
  const snapshot = demoSnapshot();
  snapshot.sessions[0].events = [
    ev('m1', 'user', '리뷰 부탁해요'),
    ev('m2', 'assistant', '확인하고 있어요', { phase: 'commentary' }),
    ev('m3', 'tool', 'npm test', { tool: 'Bash' }),
    ev('m4', 'result', 'ok · 12 passed'),
    ev('m5', 'assistant', '끝났어요. **표**도 정리했어요.\n\n| a | b |\n| - | - |', {
      phase: 'final',
    }),
    ev('m6', 'user', long ? 'x'.repeat(4100) : '고마워요'),
  ];
  return snapshot;
}

async function mock(
  page: Page,
  snapshot: Snapshot,
  drafts: Record<string, string> = {},
  pin: CardPin = 'off',
) {
  await page.addInitScript(
    ({ snapshot, drafts, pin }) => {
      const w = window as any;
      w.sends = [];
      w.copies = [];
      w.cardCalls = [];
      for (const [key, value] of Object.entries(drafts)) localStorage.setItem(key, value);
      w.office = {
        snapshot: async () => structuredClone(snapshot),
        detail: async (id: string) => structuredClone(snapshot.sessions.find((s) => s.id === id)),
        visit: async () => structuredClone(snapshot),
        preferences: async () => structuredClone(snapshot),
        artifacts: async () => [],
        subscribe: () => () => {},
        terminalSend: async () => true,
        terminals: async (ids: string[]) =>
          Object.fromEntries(
            ids.map((id) => [id, { kind: 'tmux', status: 'idle', canSend: true }]),
          ),
        copyText: async (text: string) => {
          w.copies.push(text);
        },
        onCard: (cb: any) => {
          w.showCard = (id: string | null) => cb(id ? { id } : null);
          setTimeout(() => w.showCard('demo:0'), 20);
          return () => {};
        },
        // How this card window is kept (the preview unless a test pins it).
        cardState: async () => ({ pinned: pin !== 'off', pin, positionRemembered: false }),
        // Main switches the card window to the chosen colleague.
        card: async (action: string, target?: { id: string }) => {
          w.cardCalls.push([action, target?.id ?? null]);
          if (action === 'close') w.showCard(null);
          if (action === 'select' && target) w.showCard(target.id);
        },
        send: async (id: string, text: string) => {
          w.sends.push({ id, text });
          return { status: 'sent', message: 'Sent' };
        },
      };
    },
    { snapshot, drafts, pin },
  );
}

const draftKey = (id: string) => `office:reply-draft:v1:live:${id}`;
const field = (page: Page) => page.locator('.terminal-send-chat textarea');
const bubble = (page: Page, id: string) => page.locator(`[data-event-id="${id}"]`);
const bar = (page: Page) => page.getByRole('toolbar', { name: '고른 말풍선' });

async function openCard(
  page: Page,
  snapshot: Snapshot,
  drafts?: Record<string, string>,
  pin?: CardPin,
) {
  await page.setViewportSize({ width: 480, height: 820 });
  await mock(page, snapshot, drafts, pin);
  await page.goto('/#card');
  await expect(field(page)).toBeVisible();
  await expect(bubble(page, 'm5')).toBeVisible();
}

/** "Select from here" from the bubble's right-click menu. */
async function startAt(page: Page, id: string) {
  await bubble(page, id).locator('.message-bubble').click({ button: 'right' });
  await page
    .getByRole('menu', { name: '말풍선 메뉴' })
    .getByRole('menuitem', { name: '여기부터 선택' })
    .click();
  await expect(bar(page)).toBeVisible();
}

test('picking a run from the right-click menu copies what is shown, then the chat box returns', async ({
  page,
}) => {
  const snapshot = office();
  const name = sessionName(snapshot.sessions[0]);
  await openCard(page, snapshot);
  await startAt(page, 'm1');
  // The bar stands where the chat box was; only the start is picked so far.
  await expect(field(page)).toBeHidden();
  await expect(bar(page)).toContainText('1개 선택');
  await expect(bar(page)).toContainText('끝낼 말풍선을 누르세요');
  await expect(bubble(page, 'm1')).toHaveClass(/is-picked/);
  await expect(bubble(page, 'm1')).toHaveClass(/is-pick-start/);
  // Clicking another bubble picks everything between; links and buttons in it do nothing.
  await bubble(page, 'm5').click();
  await expect(bar(page)).toContainText('3개 선택');
  for (const id of ['m1', 'm2', 'm5']) await expect(bubble(page, id)).toHaveClass(/is-picked/);
  await expect(bubble(page, 'm6')).not.toHaveClass(/is-picked/);
  // The tool log is switched off in the chat: it is not in the copy either.
  await bar(page).getByRole('button', { name: '3개 복사' }).click();
  await expect(page.locator('.dock-card-toast')).toHaveText('말풍선 3개를 복사했어요');
  expect(await page.evaluate(() => (window as any).copies)).toEqual([
    [
      '나:\n리뷰 부탁해요',
      `${name}:\n확인하고 있어요`,
      `${name}:\n끝났어요. **표**도 정리했어요.\n\n| a | b |\n| - | - |`,
    ].join('\n\n'),
  ]);
  await expect(bar(page)).toHaveCount(0);
  await expect(field(page)).toBeVisible();
  await expect(page.locator('.conversation-message.is-picked')).toHaveCount(0);
});

test('clicking again or Shift+clicking moves the end; tools shown join the run; Esc stops only picking', async ({
  page,
}) => {
  await openCard(page, office());
  // The hover button starts it too.
  await bubble(page, 'm5').hover();
  await bubble(page, 'm5').getByRole('button', { name: '여기부터 선택' }).click();
  await expect(bar(page)).toContainText('1개 선택');
  // Above the start: from there down to it.
  await bubble(page, 'm1').click();
  await expect(bar(page)).toContainText('3개 선택');
  await bubble(page, 'm2').click({ modifiers: ['Shift'] });
  await expect(bar(page)).toContainText('2개 선택');
  await expect(bubble(page, 'm1')).not.toHaveClass(/is-picked/);
  // The tool log shown: its entries between the start and the end are in the run.
  await page.getByRole('button', { name: '필터' }).click();
  await page.getByRole('checkbox', { name: /도구 기록 포함/ }).check();
  await expect(bar(page)).toContainText('4개 선택');
  await expect(page.locator('.work-group')).toHaveClass(/has-picked/);
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect(field(page)).toBeVisible();
  // Esc ended picking, not the card (the switch only asked for the keyboard).
  const calls: [string, string | null][] = await page.evaluate(() => (window as any).cardCalls);
  expect(calls.filter(([action]) => action !== 'focus')).toEqual([]);
  await expect(bubble(page, 'm5')).toBeVisible();
  // With nothing picked, Esc is the card's again: it leaves the switch, then closes the card.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as any).cardCalls.at(-1)[0])).toBe('close');
});

test('handing the run to a colleague opens its card with a draft after what it already wrote', async ({
  page,
}) => {
  const snapshot = office();
  const from = sessionName(snapshot.sessions[0]);
  const to = snapshot.sessions[1];
  await openCard(page, snapshot, { [draftKey(to.id)]: '먼저 쓰던 글' });
  // What the card was writing to its own colleague stays its own.
  await field(page).fill('원래 동료에게 쓰던 글');
  await startAt(page, 'm1');
  await bubble(page, 'm2').click();
  await bar(page).getByRole('button', { name: '동료에게 보내기' }).click();
  const list = page.getByRole('menu', { name: '보낼 동료 고르기' });
  // Other colleagues with a chat box: not this one, nor OpenClaw.
  await expect(list.getByRole('menuitem')).toHaveCount(5);
  await expect(list.getByRole('menuitem', { name: new RegExp(from) })).toHaveCount(0);
  await list.getByRole('menuitem', { name: new RegExp(sessionName(to)) }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).cardCalls))
    .toEqual([['select', to.id]]);
  // That colleague's card, its draft extended, nothing sent.
  await expect(page.locator('.card-head h2')).toContainText(sessionName(to));
  await expect(field(page)).toHaveValue(
    [
      '먼저 쓰던 글',
      `${from} 대화에서 가져옴`,
      '나:\n리뷰 부탁해요',
      `${from}:\n확인하고 있어요`,
    ].join('\n\n'),
  );
  await expect(page.locator('.dock-card-toast')).toContainText(
    `${sessionName(to)} 입력창에 초안으로 넣었어요`,
  );
  expect(await page.evaluate(() => (window as any).sends)).toEqual([]);
  // Back on the first colleague, its own draft is as it was.
  await page.evaluate(() => (window as any).showCard('demo:0'));
  await expect(field(page)).toHaveValue('원래 동료에게 쓰던 글');
});

for (const pin of ['pinned', 'window'] as const)
  test(`a ${pin} card hands on without turning to the other colleague`, async ({ page }) => {
    const snapshot = office();
    const from = sessionName(snapshot.sessions[0]);
    const to = snapshot.sessions[1];
    await openCard(page, snapshot, {}, pin);
    await field(page).fill('고정 카드에서 쓰던 글');
    await startAt(page, 'm5');
    await bar(page).getByRole('button', { name: '동료에게 보내기' }).click();
    await page
      .getByRole('menu', { name: '보낼 동료 고르기' })
      .getByRole('menuitem', { name: new RegExp(sessionName(to)) })
      .click();
    // Main is asked to show that colleague beside this card (its own kept card, else the
    // preview); this window is never switched.
    await expect
      .poll(() => page.evaluate(() => (window as any).cardCalls))
      .toEqual([['reveal', to.id]]);
    await expect(page.locator('.card-head h2')).toContainText(from);
    await expect(bar(page)).toHaveCount(0);
    await expect(field(page)).toHaveValue('고정 카드에서 쓰던 글');
    // The draft waits in that colleague's chat box, wherever its card opens.
    expect(await page.evaluate((key) => localStorage.getItem(key), draftKey(to.id))).toBe(
      [
        `${from} 대화에서 가져옴`,
        `${from}:\n끝났어요. **표**도 정리했어요.\n\n| a | b |\n| - | - |`,
      ].join('\n\n'),
    );
    expect(await page.evaluate(() => (window as any).sends)).toEqual([]);
  });

test('a run too long for the chat box can still be copied, not handed on', async ({ page }) => {
  await openCard(page, office(true));
  await startAt(page, 'm5');
  await bubble(page, 'm6').click();
  await expect(bar(page)).toContainText('2개 선택');
  await expect(bar(page).getByRole('button', { name: '동료에게 보내기' })).toBeDisabled();
  await expect(bar(page)).toContainText('입력창에 다 들어가지 않아요(최대 4,000자)');
  await expect(bar(page).getByRole('button', { name: '2개 복사' })).toBeEnabled();
});

test('the big office column picks and hands on the same way, marked in both themes', async ({
  page,
}) => {
  const snapshot = office();
  const from = sessionName(snapshot.sessions[0]);
  const to = snapshot.sessions[3];
  await mock(page, snapshot);
  await page.goto('/');
  // Open demo:0's card from the list.
  await page.locator('.session-row').filter({ hasText: from }).first().click();
  const aside = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(aside.locator('[data-event-id="m1"]')).toBeVisible();
  const start = async () => {
    await aside.locator('[data-event-id="m6"] .message-bubble').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '여기부터 선택' }).click();
    await expect(bar(page)).toBeVisible();
  };
  // Esc stops picking and leaves the column open.
  await start();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect(aside).toBeVisible();
  await start();
  await aside.locator('[data-event-id="m5"]').click();
  await expect(bar(page)).toContainText('2개 선택');
  // The picked rows stand out, the person's blue bubble included, in light and dark.
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const look = await aside.locator('[data-event-id="m6"]').evaluate((el) => {
      const row = getComputedStyle(el).backgroundColor;
      const card = getComputedStyle(el.closest('.inspector-scroll')!).backgroundColor;
      const check = getComputedStyle(el.querySelector('.bubble-pick')!).backgroundColor;
      const bubble = getComputedStyle(el.querySelector('.message-bubble')!).backgroundColor;
      return { row, card, check, bubble };
    });
    expect(look.row).not.toBe('rgba(0, 0, 0, 0)');
    expect(look.row).not.toBe(look.card);
    // The filled check is the accent, like the blue bubble it sits beside.
    expect(look.check).toBe(look.bubble);
    await page.screenshot({ path: `.local/bubble-share-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await bar(page).getByRole('button', { name: '동료에게 보내기' }).click();
  await page
    .getByRole('menu', { name: '보낼 동료 고르기' })
    .getByRole('menuitem', { name: new RegExp(sessionName(to)) })
    .click();
  await expect(aside.locator('.card-head h2')).toContainText(sessionName(to));
  await expect(aside.locator('.terminal-send-chat textarea')).toHaveValue(
    [
      `${from} 대화에서 가져옴`,
      `${from}:\n끝났어요. **표**도 정리했어요.\n\n| a | b |\n| - | - |`,
      '나:\n고마워요',
    ].join('\n\n'),
  );
  await expect(page.locator('.toast')).toContainText(
    `${sessionName(to)} 입력창에 초안으로 넣었어요`,
  );
  expect(await page.evaluate(() => (window as any).sends)).toEqual([]);
  // The big office never drives the card window.
  expect(await page.evaluate(() => (window as any).cardCalls)).toEqual([]);
});
