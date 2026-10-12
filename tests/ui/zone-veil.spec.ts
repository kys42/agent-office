import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

/** The web bridge, hiding like the service: one hiding time per session. Returns the calls. */
async function serve(page: Page) {
  let snapshot = demoSnapshot();
  const veils: [string[], boolean][] = [];
  await page.route('**/api/rpc', (route) => {
    const { method, args } = route.request().postDataJSON();
    if (method === 'veil') {
      veils.push([args[0], args[1]]);
      snapshot = {
        ...snapshot,
        sessions: snapshot.sessions.map((x) =>
          args[0].includes(x.id) ? { ...x, hiddenAt: args[1] ? Date.now() : null } : x,
        ),
      };
    }
    if (method === 'detail')
      return route.fulfill({ json: { result: snapshot.sessions.find((x) => x.id === args[0]) } });
    if (method === 'artifacts') return route.fulfill({ json: { result: [] } });
    return route.fulfill({ json: { result: snapshot } });
  });
  return veils;
}

test('A zone sign in the big office hides its whole project at once (#100)', async ({ page }) => {
  const veils = await serve(page);
  await page.goto('/');
  const area = page.locator('.project-area', { hasText: 'agent-office' });
  await expect(area.locator('.desk-station')).toHaveCount(2);
  const eye = area.getByRole('button', { name: 'agent-office 모두 가리기' });
  // Unseen, it lets clicks through to the floor.
  await expect(eye).toHaveCSS('pointer-events', 'none');
  await page.mouse.move(0, 0);
  const sign = (await area.locator('.zone-mark-focus').boundingBox())!;
  await page.mouse.move(sign.x + sign.width / 2, sign.y + sign.height / 2, { steps: 4 });
  await expect(eye).toHaveCSS('opacity', '1');
  // Across the small gap onto the eye, like a person.
  const at = (await eye.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2, { steps: 6 });
  await expect(eye.locator('.veil-tip')).toBeVisible();
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => veils.at(-1)).toEqual([['demo:0', 'demo:1'], true]);
  await expect(page.locator('.project-area', { hasText: 'agent-office' })).toHaveCount(0);
  // Hiding does not zoom the room or open a card.
  await expect(page.locator('.office-card')).not.toHaveClass(/is-zone-focus/);
  // A zone where everyone waits for the person has nothing to hide.
  await expect(
    page.locator('.project-area', { hasText: 'my-notes' }).locator('.zone-veil'),
  ).toHaveCount(0);
});

test('A zone sign zooms the big office onto that zone; again or Esc sees all', async ({ page }) => {
  await serve(page);
  await page.goto('/');
  const card = page.locator('.office-card');
  const holder = page.locator('.map-holder');
  await expect(holder).toHaveClass(/is-fit/);
  const fitScale = Number(await holder.getAttribute('data-scale'));
  const sign = page.getByRole('button', { name: 'api-server 확대해서 보기' });
  await sign.click();
  await expect(card).toHaveClass(/is-zone-focus/);
  await expect(sign).toHaveAttribute('aria-pressed', 'true');
  await expect(holder).not.toHaveClass(/is-fit/);
  expect(Number(await holder.getAttribute('data-scale'))).toBeGreaterThan(fitScale);
  // The zone is in view; the others step back.
  const zone = page.locator('.project-area.is-focus-zone');
  await expect(zone).toContainText('api-server');
  await expect(zone).toBeInViewport({ ratio: 0.9 });
  await expect(page.locator('.project-area', { hasText: 'daily-brief' })).toHaveCSS(
    'opacity',
    '0.32',
  );
  const back = page.locator('.zone-back');
  await expect(back).toContainText('api-server · 모두 보기');
  await page.keyboard.press('Escape');
  await expect(card).not.toHaveClass(/is-zone-focus/);
  await expect(holder).toHaveClass(/is-fit/);
  // The sign toggles, and the back chip returns too.
  await sign.click();
  await expect(card).toHaveClass(/is-zone-focus/);
  await sign.click();
  await expect(holder).toHaveClass(/is-fit/);
  await sign.click();
  await back.click();
  await expect(holder).toHaveClass(/is-fit/);
  await expect(back).toHaveCount(0);
});

test('The row sign and the floor flag hide their project too', async ({ page }) => {
  for (const hash of ['#mini=row', '#mini=floor']) {
    await page.unroute('**/api/rpc');
    const veils = await serve(page);
    await page.goto(`/${hash}`);
    await page.reload();
    const zone = page.locator('.desk-row .row-zone', { hasText: 'daily-brief' });
    await expect(zone.locator('[data-station-id="demo:2"]')).toBeVisible();
    const eye = zone.getByRole('button', { name: 'daily-brief 모두 가리기' });
    await expect(eye).toHaveCSS('pointer-events', 'none');
    await page.mouse.move(0, 0);
    const sign = zone.locator(hash === '#mini=floor' ? '.zone-flag-cloth' : '.row-zone-mark');
    const box = (await sign.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect(eye).toHaveCSS('opacity', '1');
    await expect(eye).toHaveAttribute('data-solid');
    const at = (await eye.boundingBox())!;
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2, { steps: 6 });
    // The explanation opens upward, inside the strip.
    const tip = eye.locator('.veil-tip');
    await expect(tip).toBeVisible();
    const t = (await tip.boundingBox())!;
    const strip = (await page.locator('.desk-row').boundingBox())!;
    expect(t.y).toBeGreaterThanOrEqual(strip.y);
    expect(t.y + t.height).toBeLessThanOrEqual(strip.y + strip.height);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => veils.at(-1)).toEqual([['demo:2'], true]);
    await expect(page.locator('.desk-row [data-station-id="demo:2"]')).toHaveCount(0);
    await page.locator('.desk-row-veiled').click();
    await expect(page.locator('.desk-row [data-station-id="demo:2"]')).toBeVisible();
  }
});

test('The zone explanation stays inside the office, even on the rightmost zone', async ({
  page,
}) => {
  await serve(page);
  await page.goto('/');
  const map = (await page.locator('.office-map').boundingBox())!;
  for (const name of ['agent-office', 'daily-brief', 'design-system']) {
    const area = page.locator('.project-area', { hasText: name });
    await page.mouse.move(0, 0);
    const sign = (await area.locator('.zone-mark-focus').boundingBox())!;
    await page.mouse.move(sign.x + sign.width / 2, sign.y + sign.height / 2, { steps: 3 });
    const eye = area.locator('.zone-veil');
    const at = (await eye.boundingBox())!;
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2, { steps: 5 });
    const tip = eye.locator('.veil-tip');
    await expect(tip).toBeVisible();
    const box = (await tip.boundingBox())!;
    expect(box.x, name).toBeGreaterThanOrEqual(map.x);
    expect(box.x + box.width, name).toBeLessThanOrEqual(map.x + map.width);
    // No browser tooltip from the sign on top of it.
    await expect(eye).toHaveAttribute('title', '');
  }
});

test('Choosing a colleague in another zone leaves the zone zoom but keeps the zoom', async ({
  page,
}) => {
  await serve(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'api-server 확대해서 보기' }).click();
  const card = page.locator('.office-card');
  await expect(card).toHaveClass(/is-zone-focus/);
  const scale = await page.locator('.map-holder').getAttribute('data-scale');
  // The roster picks someone in daily-brief.
  await page.locator('.session-row').filter({ hasText: '집사' }).click();
  await expect(card).not.toHaveClass(/is-zone-focus/);
  await expect(page.locator('.zone-back')).toHaveCount(0);
  await expect(page.locator('.map-holder')).toHaveAttribute('data-scale', scale!);
  await expect(page.locator('[data-station-id="demo:2"]')).toBeInViewport();
});
