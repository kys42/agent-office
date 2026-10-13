import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

test("The big office's right column is the same card as the pop-up, without the window's tools", async ({
  page,
}) => {
  await page.addInitScript((s) => {
    const w = window as any;
    w.cardCalls = [];
    w.office = {
      snapshot: async () => structuredClone(s),
      detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
      visit: async () => structuredClone(s),
      artifacts: async () => [],
      subscribe: () => () => {},
      // The desktop bridge has the card window's calls too: the office must not use them.
      card: async (what: string) => {
        w.cardCalls.push(what);
      },
    };
  }, demoSnapshot());
  await page.goto('/');
  await page.locator('.speech-bubble').first().click();
  const aside = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(aside).toBeVisible();
  // The card's header, tabs and chat box — the pop-up card's layout.
  await expect(aside).toHaveClass(/inspector-card/);
  const head = aside.locator('.card-head');
  await expect(head.locator('h2')).not.toBeEmpty();
  for (const name of ['인수인계 꾸리기', '사무실에 고정', '카드 메뉴', '업무 카드 닫기'])
    await expect(head.getByRole('button', { name })).toBeVisible();
  await expect(aside.getByRole('tab')).toHaveCount(4);
  await expect(aside.locator('.card-composer')).toBeVisible();
  // Already in the big office, and it is not a window of its own: no 'full view' or 'keep open'.
  await expect(head.getByRole('button', { name: '큰 사무실에서 보기' })).toHaveCount(0);
  await expect(head.getByRole('button', { name: '카드 열어 두기' })).toHaveCount(0);
  // Pressing the header does not move the card window (the office window drags by CSS).
  const box = (await head.locator('.card-title').boundingBox())!;
  await page.mouse.move(box.x + box.width + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2);
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).cardCalls)).toEqual([]);
  // Instead the header's empty space is the window's drag region; the name and the controls
  // still take the mouse (the full name shows on hover, the menu opens).
  const regionOf = (el: Element) => getComputedStyle(el).getPropertyValue('-webkit-app-region');
  const region = (selector: string) => head.locator(selector).first().evaluate(regionOf);
  expect(await head.evaluate(regionOf)).toBe('drag');
  for (const selector of ['.card-title', '.card-avatar', 'button'])
    expect(await region(selector)).toBe('no-drag');
  // Details live in the card's tab: where it works, branch, original name.
  await aside.getByRole('tab', { name: '작업 정보' }).click();
  await expect(aside.locator('.card-info')).toBeVisible();
  // A nicknamed colleague keeps its original session name there.
  await expect(
    aside.locator('.card-info .info-row').filter({ hasText: '원래 이름' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '업무 카드 닫기' }).click();
  await expect(aside).toHaveCount(0);
});

test('Opening a bookmarked progress note shows progress again when the switch had hidden it', async ({
  page,
}) => {
  const snapshot = demoSnapshot();
  const session = snapshot.sessions[0];
  const note = session.events.find((e) => e.phase === 'commentary')!;
  const bookmark = {
    id: 'bm-1',
    sessionId: session.id,
    eventId: note.id,
    kind: note.kind,
    phase: note.phase,
    at: note.at,
    text: note.text,
    createdAt: Date.now(),
    note: '',
    source: {
      provider: session.provider,
      title: session.title,
      alias: session.alias,
      project: session.project,
      branch: null,
      cwd: null,
    },
    context: { progress: [], omitted: 0, tools: 0 },
    anchor: { nativeId: session.nativeId, sourcePath: '', sourceRef: '', index: 1 },
  };
  await page.addInitScript(
    ({ s, b }) => {
      localStorage.setItem('office:card-progress', 'off');
      (window as any).office = {
        snapshot: async () => structuredClone(s),
        detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(s),
        artifacts: async () => [],
        subscribe: () => () => {},
        bookmarks: async () => ({ bookmarks: [b], more: false, total: 1 }),
      };
    },
    { s: snapshot, b: bookmark },
  );
  await page.goto('/');
  await page.getByRole('button', { name: '기억 서랍' }).click();
  await page.getByRole('tab', { name: '북마크' }).click();
  await page.getByRole('button', { name: '대화로 이동' }).click();
  const aside = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(aside.locator(`[data-event-id="${note.id}"]`)).toBeInViewport();
  await expect(aside.getByRole('switch', { name: /진행/ })).toBeChecked();
});
