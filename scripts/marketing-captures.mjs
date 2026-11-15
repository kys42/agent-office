import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// Explicit demo-only capture. Run against an isolated dev server, never an installed profile.
const base = process.env.SCREENSHOT_URL ?? 'http://127.0.0.1:5339';
const output = 'docs/marketing/2026-11/assets';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 970 },
    deviceScaleFactor: 1.5,
    reducedMotion: 'reduce',
    locale: 'ko-KR',
  });
  await context.addInitScript(() => {
    localStorage.setItem('office:onboarding:v1:demo', 'seen');
  });
  const page = await context.newPage();
  await page.goto(`${base}/?demo&lang=ko`);
  await page.locator('.office-pet').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  // The screenshots remain source UI. No DOM copy, branding or data is swapped in.
  await page.screenshot({ path: `${output}/office-demo.png`, animations: 'disabled' });
  await page
    .locator('.office-map')
    .screenshot({ path: `${output}/team-demo.png`, animations: 'disabled' });
  await page.locator('.office-pet[data-session-id="demo:0"]').click();
  await page.locator('aside.inspector').waitFor();
  await page
    .locator('aside.inspector')
    .screenshot({ path: `${output}/conversation-demo.png`, animations: 'disabled' });
  await page.goto(`${base}/?demo&lang=ko#mini=row`);
  await page.locator('.office-pet').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${output}/desk-row-demo.png`, animations: 'disabled' });
  await writeFile(
    `${output}/capture.json`,
    JSON.stringify(
      {
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        capturedAt: new Date().toISOString(),
        data: 'built-in synthetic demo; no user sessions',
        viewport: { width: 1440, height: 970 },
        deviceScaleFactor: 1.5,
        files: ['office-demo.png', 'team-demo.png', 'conversation-demo.png', 'desk-row-demo.png'],
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
}
