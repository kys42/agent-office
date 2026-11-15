import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Raster exports of editable campaign typography and unmodified source assets.
const dir = path.resolve('docs/marketing/2026-11');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1800 } });
  for (const id of ['cover', 'poster', 'team', 'conversation']) {
    await page.goto(pathToFileURL(path.join(dir, 'campaign.html')).href);
    await page.addStyleTag({
      content:
        '.preview .artboard { zoom:1; } .preview { width:auto; overflow:visible; } main { padding:0; }',
    });
    await page.evaluate(async (id) => {
      document.querySelector('header')?.remove();
      for (const preview of document.querySelectorAll('.preview')) {
        if (!preview.querySelector(`#${id}`)) preview.remove();
        else preview.querySelector(':scope > p')?.remove();
      }
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode()));
      window.scrollTo(0, 0);
    }, id);
    await page.locator(`#${id}`).screenshot({ path: path.join(dir, 'assets', `social-${id}.png`) });
  }
} finally {
  await browser.close();
}
