import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
await mkdir('docs/images', { recursive: true });
const browser = await chromium.launch({ timeout: 30000 });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 970 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await page.goto('http://127.0.0.1:5173/?demo');
  await page.waitForSelector('.office-pet');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({ path: 'docs/images/office.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '코코, 일하는 중', exact: true }).click();
  await page.getByRole('complementary', { name: '동료의 업무 카드' }).waitFor();
  await page.waitForFunction(() => {
    const el = document.querySelector('.inspector-scroll');
    return el && el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  });
  await page.screenshot({ path: 'docs/images/detail.png', animations: 'disabled' });
  await page.screenshot({ path: 'docs/images/conversation-phases.png', animations: 'disabled' });
  await page.getByRole('button', { name: '업무 카드 닫기' }).click();
  await page.getByRole('button', { name: '소식함 열기' }).click();
  await page.getByRole('complementary', { name: '소식함' }).waitFor();
  // Wait for the dock resize observer to fit the room before capturing it.
  await page.waitForFunction(() => {
    const room = document.querySelector('.office-map')?.getBoundingClientRect();
    const viewport = document.querySelector('.scene-viewport')?.getBoundingClientRect();
    return room && viewport && room.right <= viewport.right && room.bottom <= viewport.bottom;
  });
  await page.screenshot({ path: 'docs/images/inbox-final-only.png', animations: 'disabled' });
  await page.getByRole('button', { name: '소식함 닫기' }).click();
  await page.getByRole('tab', { name: /대기 라운지/ }).click();
  await page.screenshot({ path: 'docs/images/waiting.png', animations: 'disabled' });
  const dock = await browser.newPage({
    viewport: { width: 1440, height: 460 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await dock.goto('http://127.0.0.1:5173/?demo#mini');
  await dock.waitForSelector('.desk-pet');
  await dock.evaluate(async () => {
    await document.fonts.ready;
  });
  await dock.locator('.desk-pet-stage').screenshot({
    path: 'docs/images/desk-pet.png',
    omitBackground: true,
    animations: 'disabled',
  });
  await dock.getByRole('button', { name: /^데스크 펫 ·/ }).click();
  await dock.waitForSelector('.desk-row [data-station-id]');
  await dock.locator('.desk-row').screenshot({
    path: 'docs/images/desk-row.png',
    omitBackground: true,
    animations: 'disabled',
  });
  console.log('Saved office, detail, desk pet and desk row screenshots using demo data only.');
} finally {
  await browser.close();
}
