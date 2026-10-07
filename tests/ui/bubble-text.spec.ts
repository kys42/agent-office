import { test, expect } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

test('Bubble words can be selected without opening it, and web links open in the browser', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  const text =
    '리포트를 올렸어요. 자세한 내용은 https://example.com/report?id=7 에서 볼 수 있어요.';
  fixture.sessions[0].activity = { text, kind: 'progress', at: Date.now() };
  fixture.sessions[0].action = text;
  fixture.notices = [];
  await page.addInitScript((s) => {
    (window as any).opened = [];
    (window as any).office = {
      snapshot: async () => structuredClone(s),
      detail: async (id: string) => structuredClone(s.sessions.find((x) => x.id === id)),
      visit: async () => structuredClone(s),
      preferences: async () => structuredClone(s),
      artifacts: async () => [],
      subscribe: () => () => {},
      openLink: async (url: string) => {
        (window as any).opened.push(url);
      },
    };
  }, fixture);
  await page.goto('/');
  const bubble = page.locator('.speech-bubble').filter({ hasText: '리포트를 올렸어요' });
  const link = bubble.locator('.web-link');
  await expect(link).toHaveText('https://example.com/report?id=7');
  await expect(link).toHaveAttribute('title', 'https://example.com/report?id=7');
  // Let the bubble finish sliding in (bubble-in): a drag across words that are still moving
  // can leave Chromium with a collapsed selection, and a reader selects once it has settled.
  await bubble.evaluate((el) =>
    Promise.all(
      el
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );

  // Dragging across the words selects them; that is reading, not opening.
  const [from, to] = await bubble.locator('.speech-copy b').evaluate((b) => {
    const node = [...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!;
    const at = (i: number) => {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    return [at(0), at(6)];
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  expect(
    (await page.evaluate(() => window.getSelection()?.toString() ?? '')).length,
  ).toBeGreaterThan(3);
  await expect(page.locator('.inspector')).toHaveCount(0);

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  // A link opens in the browser and does not open the colleague card.
  await link.click();
  expect(await page.evaluate(() => (window as any).opened)).toEqual([
    'https://example.com/report?id=7',
  ]);
  await expect(page.locator('.inspector')).toHaveCount(0);

  // A plain click still opens it.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await bubble.locator('.speech-copy small').click();
  await expect(page.locator('.inspector')).toHaveCount(1);
});
