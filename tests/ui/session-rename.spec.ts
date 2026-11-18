import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

/**
 * The card menu's "세션 제목 바꾸기" (#384) over a fake desktop bridge: what the menu offers and
 * why, and the one call it makes. Nothing reaches a terminal; `renameSession` is recorded.
 */
async function card(
  page: Page,
  options: { id?: string; target?: unknown; sendOn?: boolean; failRename?: string } = {},
) {
  await page.setViewportSize({ width: 480, height: 760 });
  await page.addInitScript(
    ({ snapshot, id, target, sendOn, failRename }) => {
      const w = window as any;
      w.renames = [];
      w.office = {
        snapshot: async () => structuredClone(snapshot),
        detail: async (id: string) => structuredClone(snapshot.sessions.find((s) => s.id === id)),
        visit: async () => structuredClone(snapshot),
        artifacts: async () => [],
        terminalSend: async () => sendOn,
        terminals: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, target])),
        subscribe: () => () => {},
        onCard: (cb: any) => {
          setTimeout(() => cb({ id }), 20);
          return () => {};
        },
        card: async () => {},
        send: async () => ({ status: 'sent', message: '보냈어요' }),
        renameSession: async (id: string, title: string) => {
          w.renames.push([id, title]);
          if (failRename) throw new Error(failRename);
          return { status: 'sent', message: 'tmux work:1.0에 보냈어요' };
        },
      };
    },
    {
      snapshot: demoSnapshot(),
      id: options.id ?? 'demo:0',
      target:
        options.target === undefined
          ? { kind: 'tmux', label: 'work:1.0', status: 'idle', canSend: true, canFocus: true }
          : options.target,
      sendOn: options.sendOn ?? true,
      failRename: options.failRename ?? '',
    },
  );
  await page.goto('/#card');
  const aside = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(aside.locator('.card-composer')).toBeVisible();
  return aside;
}

const openMenu = async (page: Page) => {
  await page.getByRole('button', { name: '카드 메뉴' }).click();
  return page.getByRole('menu');
};
const renames = (page: Page) => page.evaluate(() => (window as any).renames);

test('The office nickname and the session title are two items; renaming sends one title', async ({
  page,
}) => {
  const aside = await card(page);
  const menu = await openMenu(page);
  await expect(menu.getByRole('menuitem', { name: '사무실 별명 바꾸기' })).toBeEnabled();
  const item = menu.getByRole('menuitem', { name: '세션 제목 바꾸기' });
  await expect(item).toBeEnabled();
  await item.click();
  const input = aside.getByLabel('새 세션 제목');
  // Starts from the session's own title, never the office nickname.
  await expect(input).not.toHaveValue('');
  await expect(input).not.toHaveValue('Coco');
  await input.fill('  결제 모듈 리팩터링  ');
  await input.press('Enter');
  await expect.poll(() => renames(page)).toEqual([['demo:0', '결제 모듈 리팩터링']]);
  // Coco has a nickname: the card keeps showing it, and the toast says so.
  await expect(page.locator('.dock-card-toast')).toContainText('잠시 걸릴 수 있고');
  await expect(page.locator('.dock-card-toast')).toContainText('사무실 별명이 계속 보여요');
  await expect(input).toHaveCount(0);
});

test('A title that would type keys or open a picker is refused before anything is sent', async ({
  page,
}) => {
  const aside = await card(page);
  await (await openMenu(page)).getByRole('menuitem', { name: '세션 제목 바꾸기' }).click();
  const input = aside.getByLabel('새 세션 제목');
  await input.fill('리뷰 @alice');
  await aside.getByRole('button', { name: '세션 제목 보내기' }).click();
  await expect(page.locator('.dock-card-toast')).toContainText('‘/’나 ‘@’로 시작하는 낱말');
  await input.fill('   ');
  await input.press('Enter');
  await expect(page.locator('.dock-card-toast')).toContainText('새 제목을 입력해 주세요');
  expect(await renames(page)).toEqual([]);
  // Esc closes the form without sending; the card stays.
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(aside).toBeVisible();
  expect(await renames(page)).toEqual([]);
});

test('A refusal from the terminal side is shown, and the form stays to try again', async ({
  page,
}) => {
  const aside = await card(page, {
    failRename: '입력창에 이미 글이 있어요. 터미널을 확인한 뒤 보내 주세요.',
  });
  await (await openMenu(page)).getByRole('menuitem', { name: '세션 제목 바꾸기' }).click();
  const input = aside.getByLabel('새 세션 제목');
  await input.fill('새 제목');
  await input.press('Enter');
  await expect(page.locator('.dock-card-toast')).toContainText('입력창에 이미 글이 있어요');
  await expect(input).toHaveValue('새 제목');
});

test('Claude mid-turn can be renamed: the command runs at once', async ({ page }) => {
  await card(page, {
    target: { kind: 'orca', label: 'Orca', status: 'busy', canSend: true, canFocus: true },
  });
  await expect(
    (await openMenu(page)).getByRole('menuitem', { name: '세션 제목 바꾸기' }),
  ).toBeEnabled();
});

for (const { name, options, reason } of [
  {
    name: 'no running terminal',
    options: { target: null },
    reason: '실행 중인 터미널을 찾지 못했어요',
  },
  {
    name: 'only its Orca tab',
    options: {
      target: {
        kind: 'orca',
        label: 'Orca',
        status: 'tab',
        canSend: false,
        canFocus: true,
        tabOnly: true,
      },
    },
    reason: '실행 중인 터미널을 찾지 못했어요',
  },
  {
    name: 'a permission prompt',
    options: {
      target: {
        kind: 'tmux',
        label: 'work:1.0',
        status: 'waiting',
        canSend: false,
        canFocus: true,
      },
    },
    reason: '지금은 입력을 받을 수 없어요',
  },
  {
    name: 'typing into terminals off',
    options: { sendOn: false },
    reason: '‘터미널로 보내기’를 먼저 켜 주세요',
  },
  {
    name: 'a Codex CLI queue',
    options: {
      id: 'demo:1',
      target: {
        kind: 'codex',
        label: '',
        status: 'queue',
        canSend: true,
        canFocus: true,
        queues: true,
      },
    },
    reason: '대기열로 보내는 대화라 명령이 실행되지 않아요',
  },
  {
    name: 'an agent with no rename command',
    options: { id: 'demo:2', target: null },
    reason: '이 에이전트는 여기서 바꿀 수 없어요',
  },
])
  test(`The item is off with its reason: ${name}`, async ({ page }) => {
    await card(page, options);
    const item = (await openMenu(page)).getByRole('menuitem', { name: '세션 제목 바꾸기' });
    await expect(item).toBeDisabled();
    await expect(item).toContainText(reason);
    // The office nickname never depends on a terminal.
    await expect(page.getByRole('menuitem', { name: '사무실 별명 바꾸기' })).toBeEnabled();
  });
