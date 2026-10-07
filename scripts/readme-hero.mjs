import { chromium } from 'playwright';
import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
// Animated README hero: a short guided tour of the synthetic demo office (never real sessions).
// Usage: npm run dev, then `node scripts/readme-hero.mjs [en|ko]`. Requires ffmpeg on PATH.
const base = process.env.SCREENSHOT_URL ?? 'http://127.0.0.1:5173';
const lang = process.argv[2] ?? 'en';
const out = `docs/images/${lang}/hero.gif`;
const frames = await mkdtemp(path.join(os.tmpdir(), 'office-hero-'));
const browser = await chromium.launch({ timeout: 30000 });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
    locale: lang === 'ko' ? 'ko-KR' : 'en-US',
  });
  await page.goto(`${base}/?demo&lang=${lang}`);
  await page.waitForSelector('.office-pet');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForFunction(() => {
    const room = document.querySelector('.office-map')?.getBoundingClientRect();
    const viewport = document.querySelector('.scene-viewport')?.getBoundingClientRect();
    return room && viewport && room.right <= viewport.right && room.bottom <= viewport.bottom;
  });
  // Screenshots don't include the OS pointer, so draw one that glides to each target.
  await page.evaluate(() => {
    const cursor = document.createElement('div');
    cursor.id = 'tour-cursor';
    cursor.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 10.5-6.6 1.2 3.9 7.4-3 1.6-3.9-7.5L4 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.45))',
      transition: 'transform 600ms cubic-bezier(.45,0,.2,1)',
      transform: 'translate(760px, 560px)',
    });
    document.body.append(cursor);
  });
  const glide = async (locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('Tour target is not visible');
    await page.evaluate(
      ([x, y]) => {
        document.getElementById('tour-cursor').style.transform = `translate(${x}px, ${y}px)`;
      },
      [box.x + box.width / 2 - 4, box.y + box.height / 2 - 2],
    );
    await page.waitForTimeout(700);
  };
  const click = async (locator) => {
    await glide(locator);
    await locator.click();
  };

  const shots = [];
  let recording = true;
  const recorder = (async () => {
    while (recording) {
      const file = path.join(frames, `f${String(shots.length).padStart(4, '0')}.png`);
      await page.screenshot({ path: file });
      shots.push({ file, at: Date.now() });
    }
  })();

  await page.waitForTimeout(1800);
  await click(page.locator('.office-pet[data-session-id="demo:0"]'));
  await page.waitForTimeout(2600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('.palette').waitFor();
  await page.waitForTimeout(400);
  await page.keyboard.type(lang === 'ko' ? '회고' : 'retro', { delay: 160 });
  await page.waitForTimeout(900);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await click(page.locator('.inbox-button'));
  await page.waitForTimeout(2600);
  await click(page.locator('.inbox-button'));
  await page.waitForTimeout(1400);
  recording = false;
  await recorder;

  // Keep each frame on screen for as long as it really took, then hold the last one.
  const list = shots
    .map((s, i) => {
      const next = shots[i + 1]?.at ?? s.at + 1500;
      return `file '${s.file}'\nduration ${((next - s.at) / 1000).toFixed(3)}`;
    })
    .join('\n');
  const listFile = path.join(frames, 'frames.txt');
  await writeFile(listFile, `${list}\nfile '${shots.at(-1).file}'\n`);
  await mkdir(path.dirname(out), { recursive: true });
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-vf',
    'fps=10,scale=1080:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop',
    '0',
    out,
  ]);
  const { size } = await stat(out);
  console.log(
    `Saved ${out} (${shots.length} frames, ${(size / 1e6).toFixed(1)} MB) from demo data.`,
  );
} finally {
  await browser.close();
  await rm(frames, { recursive: true, force: true });
}
