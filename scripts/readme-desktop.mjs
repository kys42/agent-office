import { chromium } from 'playwright';
import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
// README desktop scene: the real dock (demo data) on a mock desktop. The GIF starts from the desk
// pet in the corner, unfolds the desk row and opens a bubble in place; the PNG is the open row.
// Writes docs/images/<lang>/desktop.png and desktop.gif.
// Usage: npm run dev, then `node scripts/readme-desktop.mjs [en|ko]`. Requires ffmpeg on PATH.
const base = process.env.SCREENSHOT_URL ?? 'http://127.0.0.1:5173';
const lang = process.argv[2] ?? 'en';
const dir = `docs/images/${lang}`;
const W = 1440;
const H = 900;
const DOCK = 420;
const ko = lang === 'ko';
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const code = [
  '<span class="k">export function</span> <span class="f">useOffice</span>(demo: <span class="k">boolean</span>) {',
  '  <span class="c">// Every window shares one snapshot and one model.</span>',
  `  <span class="k">const</span> [snapshot, setSnapshot] = <span class="f">useState</span>${esc('<Snapshot | null>')}(<span class="k">null</span>);`,
  '  <span class="k">const</span> model = <span class="f">useMemo</span>(() =&gt; <span class="f">buildOfficeModel</span>(snapshot), [snapshot]);',
  '  <span class="f">useLocalePreference</span>(snapshot?.preferences.locale, !!snapshot);',
  '',
  '  <span class="c">// Presentations (office, desk pet, desk row) only draw the model.</span>',
  '  <span class="k">return</span> { snapshot, model, refresh, pin, veil };',
  '}',
];
const lines = code.map((row, i) => `<div><i>${i + 24}</i>${row}</div>`).join('');
const scene = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
:root{color-scheme:dark}
body{width:${W}px;height:${H}px;overflow:hidden;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e8e6ef;
background:radial-gradient(1200px 700px at 12% 8%,#ff9a6b55,transparent 60%),radial-gradient(900px 700px at 92% 18%,#7c6cff66,transparent 60%),
radial-gradient(1100px 800px at 50% 110%,#2bd4a855,transparent 60%),linear-gradient(160deg,#241a3a,#141830 55%,#0d1a24)}
.bar{position:absolute;inset:0 0 auto 0;height:26px;display:flex;align-items:center;gap:18px;padding:0 14px;
background:#0b0b1499;backdrop-filter:blur(18px);font-size:12.5px;color:#e9e7f5}
.bar b{font-weight:650}.bar .r{margin-left:auto;display:flex;gap:14px;opacity:.85}
.win{position:absolute;border-radius:12px;overflow:hidden;box-shadow:0 30px 70px #0009,0 0 0 1px #ffffff14}
.win header{height:30px;display:flex;align-items:center;gap:7px;padding:0 12px;background:#20222c;color:#9aa0b4;font-size:12px}
.win header i{width:11px;height:11px;border-radius:50%;background:#ff5f57}.win header i+i{background:#febc2e}.win header i+i+i{background:#28c840}
.win header span{margin-left:10px}
.editor{left:90px;top:72px;width:720px;height:560px;background:#171922}
.editor pre{padding:14px 0;font:12.5px/1.75 'JetBrains Mono',ui-monospace,Menlo,monospace}
.editor pre div i{display:inline-block;width:44px;padding-right:14px;text-align:right;color:#4a4f63;font-style:normal}
.k{color:#c792ea}.f{color:#82aaff}.c{color:#5f6680;font-style:italic}.editor pre{color:#d8dbe6}
.term{left:700px;top:170px;width:620px;height:440px;background:#101117e8;backdrop-filter:blur(8px)}
.term pre{padding:14px 16px;font:12.5px/1.7 'JetBrains Mono',ui-monospace,Menlo,monospace;color:#cfd3e1}
.g{color:#5fd69b}.d{color:#7b8199}.y{color:#f6c35b}
iframe{position:absolute;left:0;bottom:0;width:${W}px;height:${DOCK}px;border:0;background:transparent}
</style></head><body>
<div class="bar"><b>Agent Office</b><span>File</span><span>Edit</span><span>View</span><span>Window</span>
<div class="r"><span>${ko ? '화 10월 7일' : 'Tue Oct 7'}</span><span>9:41</span></div></div>
<div class="win editor"><header><i></i><i></i><i></i><span>useOffice.ts — agent-office</span></header><pre>${lines}</pre></div>
<div class="win term"><header><i></i><i></i><i></i><span>~/projects/agent-office</span></header><pre><span class="d">$</span> npm test
<span class="g">✔</span> office model keeps desks stable across sorting
<span class="g">✔</span> notices keep their read state across languages
<span class="g">✔</span> desk row docks to the bottom of the work area
<span class="d">ℹ</span> tests 225  <span class="g">pass 225</span>  fail 0
<span class="d">$</span> git push <span class="y">feat/desk-pet</span>
</pre></div>
<iframe src="${base}/?demo&lang=${lang}#mini"></iframe>
</body></html>`;

const frames = await mkdtemp(path.join(os.tmpdir(), 'office-desktop-'));
const browser = await chromium.launch({ timeout: 30000 });
try {
  await mkdir(dir, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
    reducedMotion: 'no-preference',
    locale: ko ? 'ko-KR' : 'en-US',
  });
  await page.setContent(scene);
  const dock = page.frameLocator('iframe');
  await dock.locator('.desk-pet').waitFor({ timeout: 30000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(1200);

  // Screenshots don't include the OS pointer, so draw one that glides to each target.
  await page.evaluate(() => {
    const cursor = document.createElement('div');
    cursor.id = 'tour-cursor';
    cursor.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2l15 10.5-6.6 1.2 3.9 7.4-3 1.6-3.9-7.5L4 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '10',
      pointerEvents: 'none',
      filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.45))',
      transition: 'transform 700ms cubic-bezier(.45,0,.2,1)',
      transform: 'translate(760px, 360px)',
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
    await page.waitForTimeout(800);
  };
  const shots = [];
  let recording = true;
  const recorder = (async () => {
    while (recording) {
      const file = path.join(frames, `f${String(shots.length).padStart(4, '0')}.png`);
      await page.screenshot({ path: file, scale: 'css' });
      shots.push({ file, at: Date.now() });
    }
  })();
  await page.waitForTimeout(1400);
  const pet = dock.locator('.desk-pet');
  await glide(pet);
  await pet.click();
  await dock.locator('.desk-row [data-station-id]').first().waitFor();
  await page.waitForTimeout(2200);
  // Unfold the first bubble in place to read the whole update.
  const expand = dock.locator('.desk-row .speech-bubble .bubble-expand').nth(0);
  await glide(expand);
  await expand.click();
  await page.waitForTimeout(2600);
  await glide(dock.locator('.desk-row [data-station-id]').nth(3));
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    document.getElementById('tour-cursor').style.transform = 'translate(1080px, 300px)';
  });
  await page.waitForTimeout(1800);
  recording = false;
  await recorder;

  // The still: the open row with every bubble folded, cursor gone.
  await page.evaluate(() => document.getElementById('tour-cursor')?.remove());
  await dock.locator('body').press('Escape');
  await page.mouse.move(700, 120);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${dir}/desktop.png` });

  const list = shots
    .map((s, i) => {
      const next = shots[i + 1]?.at ?? s.at + 1500;
      return `file '${s.file}'\nduration ${((next - s.at) / 1000).toFixed(3)}`;
    })
    .join('\n');
  const listFile = path.join(frames, 'frames.txt');
  await writeFile(listFile, `${list}\nfile '${shots.at(-1).file}'\n`);
  const gif = `${dir}/desktop.gif`;
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
    'fps=10,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop',
    '0',
    gif,
  ]);
  const { size } = await stat(gif);
  console.log(
    `Saved ${dir}/desktop.png and ${gif} (${shots.length} frames, ${(size / 1e6).toFixed(1)} MB) from demo data.`,
  );
} finally {
  await browser.close();
  await rm(frames, { recursive: true, force: true });
}
