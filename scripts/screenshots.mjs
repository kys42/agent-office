import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
// README/doc captures from the synthetic demo office only — never from real sessions.
// Usage: npm run dev, then `node scripts/screenshots.mjs [en|ko|all]`. Writes docs/images/{en,ko}/.
const base = process.env.SCREENSHOT_URL ?? 'http://127.0.0.1:5173';
const arg = process.argv[2] ?? 'all';
const langs = arg === 'all' ? ['en', 'ko'] : [arg];
const browser = await chromium.launch({ timeout: 30000 });
const ready = async (page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  // Wait for the dock resize observer to fit the room before capturing it.
  await page.waitForFunction(() => {
    const room = document.querySelector('.office-map')?.getBoundingClientRect();
    const viewport = document.querySelector('.scene-viewport')?.getBoundingClientRect();
    return room && viewport && room.right <= viewport.right && room.bottom <= viewport.bottom;
  });
};
try {
  for (const lang of langs) {
    const dir = `docs/images/${lang}`;
    await mkdir(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 970 },
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
      locale: lang === 'ko' ? 'ko-KR' : 'en-US',
    });
    const page = await context.newPage();
    const shot = (name, options = {}) =>
      page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled', ...options });
    // Feature shots zoom into one region so they stay readable side by side in the README.
    const region = (x, y) => ({ clip: { x, y, width: 760, height: 700 } });
    const panel = async (selector) => {
      const box = await page.locator(selector).boundingBox();
      return { clip: { ...box, height: Math.min(box.height, 720) } };
    };
    await page.goto(`${base}/?demo&lang=${lang}`);
    await page.waitForSelector('.office-pet');
    await ready(page);
    await shot('office');
    await page.locator('.office-map').screenshot({
      path: `${dir}/office-map.png`,
      animations: 'disabled',
    });

    // The first demo teammate is busy, so the work card shows live progress.
    await page.locator('.office-pet[data-session-id="demo:0"]').click();
    await page.locator('aside.inspector:not(.news-inbox)').waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('.inspector-scroll');
      return el && el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    });
    await ready(page);
    await shot('detail', await panel('aside.inspector'));
    await page.keyboard.press('Escape');

    await page.locator('.inbox-button').click();
    await page.locator('aside.news-inbox').waitFor();
    await ready(page);
    await shot('inbox', await panel('aside.news-inbox'));
    await page.locator('.inbox-button').click();

    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('.palette').waitFor();
    await shot('palette', region(340, 48));
    await page.keyboard.press('Escape');

    await page.locator('.zone-tabs [role="tab"]').nth(1).click();
    await shot('lounge', region(110, 150));
    await context.close();

    // The dock window (#mini): collapsed desk pet, the one-row office, and floor desks.
    const dock = await browser.newPage({
      viewport: { width: 1440, height: 460 },
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
      locale: lang === 'ko' ? 'ko-KR' : 'en-US',
    });
    await dock.goto(`${base}/?demo&lang=${lang}#mini`);
    await dock.waitForSelector('.desk-pet');
    await dock.evaluate(async () => {
      await document.fonts.ready;
    });
    const still = { omitBackground: true, animations: 'disabled' };
    // The stage is mostly empty room for bubbles; crop to what is drawn: pet, badge, name pill.
    const pet = await dock.evaluate(() => {
      const parts = [...document.querySelectorAll('.desk-pet > *')].map((el) =>
        el.getBoundingClientRect(),
      );
      const x = Math.min(...parts.map((r) => r.left));
      const y = Math.min(...parts.map((r) => r.top));
      const right = Math.max(...parts.map((r) => r.right));
      const bottom = Math.max(...parts.map((r) => r.bottom));
      return { x: x - 24, y: y - 24, width: right - x + 48, height: bottom - y + 36 };
    });
    await dock.screenshot({ path: `${dir}/desk-pet.png`, ...still, clip: pet });
    await dock.locator('.desk-pet').click();
    await dock.waitForSelector('.desk-row [data-station-id]');
    await dock.locator('.desk-row').screenshot({ path: `${dir}/desk-row.png`, ...still });
    await dock.goto(`${base}/?demo&lang=${lang}#mini=floor`);
    await dock.reload();
    await dock.waitForSelector('.desk-floor [data-station-id]');
    await dock.locator('.desk-row').screenshot({ path: `${dir}/desk-floor.png`, ...still });
    await dock.close();
    console.log(`Saved ${lang} captures to ${dir} using demo data only.`);
  }
} finally {
  await browser.close();
}
