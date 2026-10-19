import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

const PATH = '/Users/pepper/orca/workspaces/aix-monorepo-plan/reports/검수 보고서.md';
const TEXT = `실제 평가 연결 확인 2건 모두 100점, 실행 오류 0건\n\n${'정리한 내용이에요. '.repeat(24)}\n[검수 보고서](<${PATH}>)\n[원본](file:///Users/pepper/notes.md)`;

/** Coco's latest answer names a report file; `desktop` adds the app's file opener. */
async function open(page: Page, desktop: boolean, remote = false) {
  const snapshot = demoSnapshot();
  const coco = snapshot.sessions[0];
  coco.events = [
    ...coco.events,
    {
      id: remote ? 'remote-office:peer:e-file' : 'e-file',
      kind: 'assistant',
      phase: 'final',
      text: TEXT,
      at: Date.now(),
    } as any,
  ];
  await page.addInitScript(
    ({ s, desktop }) => {
      const w = window as any;
      w.opened = [];
      w.office = {
        snapshot: async () => structuredClone(s),
        detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(s),
        artifacts: async () => [],
        subscribe: () => () => {},
        ...(desktop
          ? {
              openFile: async (path: string) => {
                w.opened.push(path);
                return 'opened';
              },
            }
          : {}),
      };
    },
    { s: snapshot, desktop },
  );
  await page.goto('/');
  await page.locator('.session-row').filter({ hasText: '코코' }).first().click();
  const message = page.locator(
    `[data-event-id="${remote ? 'remote-office:peer:e-file' : 'e-file'}"]`,
  );
  await expect(message).toBeVisible();
  return message;
}

test('A file named in a message keeps its link: folded it reads as its name, opened it opens the file', async ({
  page,
}) => {
  const message = await open(page, true);
  // Folded: the link is never cut into raw markup.
  await expect(message).not.toContainText('](');
  await expect(message).toContainText('검수 보고서');
  await message.getByRole('button', { name: /더 보기/ }).click();
  const link = message.getByRole('link', { name: '검수 보고서' });
  await expect(link).toHaveAttribute('title', PATH);
  await link.click();
  // file:// links reach the opener too.
  await message.getByRole('link', { name: '원본' }).click();
  expect(await page.evaluate(() => (window as any).opened)).toEqual([
    PATH,
    '/Users/pepper/notes.md',
  ]);
});

test('In a browser the file cannot open: its path stays beside the name', async ({ page }) => {
  const message = await open(page, false);
  await message.getByRole('button', { name: /더 보기/ }).click();
  await expect(message.locator('.file-link.is-text code').first()).toHaveText(PATH);
});

test("A connected office's message names files on its own computer: shown, never opened here", async ({
  page,
}) => {
  const message = await open(page, true, true);
  await message.getByRole('button', { name: /더 보기/ }).click();
  await expect(message.getByRole('link', { name: '검수 보고서' })).toHaveCount(0);
  await expect(message.locator('.file-link.is-text code').first()).toHaveText(PATH);
});
