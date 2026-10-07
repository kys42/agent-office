import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

const min = 60_000;
/**
 * The first demo desk has been on one task for 35 minutes (full heat); optionally a request
 * reached the office `requestAge` ms ago. The request keeps that arrival time across polls;
 * `resend()` sends it again (now − requestAge).
 */
async function serve(page: Page, requestAge?: number, prefs: Record<string, unknown> = {}) {
  let sentAt = requestAge === undefined ? undefined : Date.now() - requestAge;
  await page.route('**/api/rpc', (route) => {
    const now = Date.now();
    const snapshot = demoSnapshot();
    const s = snapshot.sessions[0];
    Object.assign(s, {
      status: 'work',
      observedStatus: 'work',
      runtime: { phase: 'working', at: now, evidence: 'observed', reason: 'fixture' },
      updatedAt: now,
      taskStartedAt: now - 35 * min,
      events: [],
      hiddenAt: undefined,
    });
    snapshot.preferences = { ...snapshot.preferences, ...prefs };
    if (sentAt !== undefined)
      snapshot.notices = [
        {
          id: 'just-sent',
          sessionId: s.id,
          eventId: 'req',
          kind: 'request',
          text: '서류 더미 위로 날아온 요청이에요.',
          at: sentAt,
          receivedAt: sentAt,
          version: 'v1',
          seenAt: null,
          viewedAt: null,
          dismissedAt: null,
          resolvedAt: null,
          bootstrap: false,
        },
        ...(snapshot.notices ?? []),
      ];
    return route.fulfill({ json: { result: snapshot } });
  });
  return { resend: () => (sentAt = Date.now() - (requestAge ?? 0)) };
}

test('A long task heats the desk in every view: flames, sweat, embers, a paper pile and 불타는 중', async ({
  page,
}) => {
  await serve(page);
  for (const hash of ['', '#mini=row', '#mini=floor']) {
    await page.goto(`/${hash}`);
    if (hash) await page.reload();
    const desk = page.locator('.desk-station[data-station-id="demo:0"]');
    await expect(desk).toHaveClass(/focus-level-3/);
    await expect(desk.locator('.fx-flames i')).toHaveCount(7);
    await expect(desk.locator('.fx-sweat i')).toHaveCount(3);
    await expect(desk.locator('.fx-steam i')).toHaveCount(3);
    await expect(desk.locator('.fx-embers i')).toHaveCount(6);
    await expect(desk.locator('.paper-pile')).toHaveAttribute('data-papers', '7');
    await expect(desk.locator('.pile-flutter')).toHaveCount(1);
    await expect(desk.locator('.working-beacon')).toContainText('불타는 중');
    await expect(desk.locator('.arrival-burst')).toHaveCount(0);
    await desk.screenshot({
      path: `.local/effects-heat${hash.replace('#mini=', '-') || '-office'}.png`,
    });
  }
});

test('A just-sent request lands on the desk in the office, row and floor, and the pet catches it', async ({
  page,
}) => {
  const request = await serve(page, 2000);
  for (const hash of ['', '#mini=row', '#mini=floor']) {
    request.resend();
    await page.goto(`/${hash}`);
    if (hash) await page.reload();
    const desk = page.locator('.desk-station[data-station-id="demo:0"]');
    await expect(desk.locator('.arrival-burst')).toBeVisible();
    await expect(desk.locator('.arrival-sheets i')).toHaveCount(4);
    await expect(desk.locator('.arrival-tag')).toContainText('일이 도착했어요!');
    await expect(desk.locator('.office-pet')).toHaveClass(/work-arrival/);
    // The person's own words speak first.
    await expect(desk.locator('.speech-bubble')).toContainText('서류 더미 위로 날아온 요청');
    await page.waitForTimeout(1300);
    await desk.screenshot({
      path: `.local/effects-arrival${hash.replace('#mini=', '-') || '-office'}.png`,
    });
  }
  request.resend();
  await page.goto('/#mini');
  await page.reload();
  await expect(page.locator('.pet-arrival-chip')).toContainText('새 요청');
  await expect(page.locator('.pet-arrival .arrival-sheets i')).toHaveCount(3);
  // The pet stays who it is (no request bubble takes over the pet).
  await expect(page.locator('.dock-pet-speech', { hasText: '서류 더미 위로' })).toHaveCount(0);
  await page.waitForTimeout(1300);
  await page.locator('.desk-pet-stage').screenshot({ path: '.local/effects-pet.png' });
});

test('A request older than 15 seconds plays nothing, even on a fresh window', async ({ page }) => {
  await serve(page, 16_000);
  await page.goto('/');
  await expect(page.locator('.desk-station[data-station-id="demo:0"]')).toBeVisible();
  await expect(page.locator('.arrival-burst')).toHaveCount(0);
  await page.goto('/#mini');
  await page.reload();
  await expect(page.locator('.desk-pet')).toBeVisible();
  await expect(page.locator('.pet-arrival')).toHaveCount(0);
});

test('Reduced motion keeps the picture but stops every effect animation', async ({ page }) => {
  const request = await serve(page, 2000, { reducedMotion: true });
  for (const hash of ['', '#mini=row']) {
    request.resend();
    await page.goto(`/${hash}`);
    if (hash) await page.reload();
    const desk = page.locator('.desk-station[data-station-id="demo:0"]');
    await expect(desk.locator('.fx-flames i').first()).toBeVisible();
    await expect(desk.locator('.arrival-tag')).toBeVisible();
    const running = await desk.evaluate((el) =>
      [...el.querySelectorAll('.focus-fx *, .paper-pile *, .arrival-burst *, .office-pet')]
        .map((e) => getComputedStyle(e).animationName)
        .filter((name) => name !== 'none'),
    );
    expect(running).toEqual([]);
  }
});

test('The row drops the arrival on time, and screen sharing hides the request words', async ({
  page,
}) => {
  await serve(page, 1000, { privacy: true });
  await page.goto('/#mini=row');
  await page.reload();
  const desk = page.locator('.desk-station[data-station-id="demo:0"]');
  await expect(desk.locator('.arrival-burst')).toBeVisible();
  await expect(desk.locator('.speech-bubble')).toBeVisible();
  await expect(desk.locator('.speech-bubble')).not.toContainText('서류 더미 위로');
  // The dock's model clock is coarse; the arrival still ends at 15 seconds.
  await expect(desk.locator('.arrival-burst')).toHaveCount(0, { timeout: 16_000 });
  await expect(desk.locator('.office-pet')).not.toHaveClass(/work-arrival/, { timeout: 2_000 });
});

test('The pet arrival also holds still under reduced motion', async ({ page }) => {
  await serve(page, 2000, { reducedMotion: true });
  await page.goto('/#mini');
  await page.reload();
  await expect(page.locator('.pet-arrival-chip')).toBeVisible();
  const running = await page
    .locator('.pet-arrival')
    .evaluate((el) =>
      [el, ...el.querySelectorAll('*')]
        .map((e) => getComputedStyle(e).animationName)
        .filter((name) => name !== 'none'),
    );
  expect(running).toEqual([]);
});
