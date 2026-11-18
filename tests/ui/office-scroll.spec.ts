import { test, expect } from '@playwright/test';

// Headless Chromium hides scrollbars; real windows (Windows, Linux, macOS "always") show them,
// and a scrollbar that takes space is what made the fitted office flicker.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('Fitted, the room never scrolls or flickers; zoomed, it overflows only where it must', async ({
  page,
}) => {
  for (const width of [1442, 1901]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?demo');
    const viewport = page.locator('.scene-viewport');
    await expect(viewport).toHaveCSS('overflow-y', 'hidden');
    const seen = await viewport.evaluate(async (el) => {
      const out = new Set<string>();
      for (let i = 0; i < 30; i++) {
        out.add(`${(el as HTMLElement).dataset.scale}|${el.clientWidth}|${el.clientHeight}`);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      return out.size;
    });
    expect(seen).toBe(1);
    await page.getByRole('button', { name: '사무실 확대' }).click();
    await page.getByRole('button', { name: '사무실 확대' }).click();
    // Each axis scrolls only as far as the room needs: never by a scrollbar's width past the
    // view (sizing from the card's outer box overflowed both axes by ~11px).
    const fits = await viewport.evaluate((el) => {
      const map = (el.querySelector('.office-map') as HTMLElement).getBoundingClientRect();
      return {
        x: el.scrollWidth <= Math.max(el.clientWidth, Math.ceil(map.width + 48)),
        y: el.scrollHeight <= Math.max(el.clientHeight, Math.ceil(map.height + 92)),
      };
    });
    expect(fits).toEqual({ x: true, y: true });
  }
});
