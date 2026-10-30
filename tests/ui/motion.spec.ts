import { test, expect } from '@playwright/test';

// Pulses moved to compositor-only halos and pseudo-elements (#52); they must still rest when
// the person asks for less motion, like the sprites always did.
test('Reduced motion stills sprites, call halos and live pulses', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('office:onboarding:v1:demo', 'seen'));
  await page.goto('/?demo');
  await expect(page.locator('.office-pet').first()).toBeVisible();
  const still = await page.evaluate(() => {
    const name = (el: Element | null, pseudo?: string) =>
      el ? getComputedStyle(el, pseudo).animationName : 'missing';
    return {
      sprite: name(document.querySelector('.office-pet .sprite')),
      halo: name(document.querySelector('.speech-bubble .bubble-halo')),
      ring: name(document.querySelector('.status-call .pet-shadow:not(.selected)'), '::after'),
      // Still and invisible: a resting ping must not sit over the roster dot.
      dot: (() => {
        const dot = document.querySelector('.session-row.is-live .face > i');
        return dot ? getComputedStyle(dot, '::after').opacity : '0';
      })(),
    };
  });
  expect(still).toEqual({ sprite: 'none', halo: 'none', ring: 'none', dot: '0' });
});

test('Without a preference the same pulses run, on transform and opacity only', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('office:onboarding:v1:demo', 'seen'));
  await page.goto('/?demo');
  await expect(page.locator('.office-pet').first()).toBeVisible();
  const running = await page.evaluate(() => ({
    sprite: getComputedStyle(document.querySelector('.office-pet .sprite')!).animationName,
    halo: getComputedStyle(document.querySelector('.speech-bubble .bubble-halo')!).animationName,
  }));
  expect(running).toEqual({ sprite: 'sprite-frames', halo: 'glow-pulse' });
  // The demo office is not live: its badge dot does not pulse.
  const badge = page.locator('.live-badge.demo i');
  if (await badge.count())
    expect(await badge.evaluate((el) => getComputedStyle(el, '::after').animationName)).toBe(
      'none',
    );
});

// #302: no loop runs on its own (a running one keeps the compositor at display rate); the office
// tick holds them paused and steps them, and each desk keeps only the loops worth showing.
test('Loops step on the office tick: paused between frames, one meter bar per desk', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('office:onboarding:v1:demo', 'seen'));
  await page.goto('/?demo');
  await expect(page.locator('.office-pet').first()).toBeVisible();
  const loops = () =>
    page.evaluate(() =>
      document
        .getAnimations()
        .filter(
          (a) =>
            a.effect?.getComputedTiming().iterations === Infinity &&
            (a as CSSAnimation).animationName !== 'spin',
        )
        .map((a) => ({
          name: (a as CSSAnimation).animationName,
          state: a.playState,
          time: Number(a.currentTime),
        })),
    );
  await expect.poll(async () => (await loops()).filter((l) => l.state === 'running')).toEqual([]);
  const before = await loops();
  expect(before.length).toBeGreaterThan(10);
  // They still move: the tick steps them forward.
  await expect
    .poll(async () => (await loops()).filter((l, i) => l.time > (before[i]?.time ?? 0)).length)
    .toBeGreaterThan(10);
  const meters = await page.locator('.working-beacon').count();
  expect(meters).toBeGreaterThan(0);
  expect(before.filter((l) => l.name === 'work-meter')).toHaveLength(meters);
  // Typing dots: still until that bubble is looked at.
  const bubble = page.locator('.speech-bubble:has(.bubble-typing)').first();
  if (await bubble.count()) {
    const dot = bubble.locator('.bubble-typing i').first();
    expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await bubble.hover();
    await expect
      .poll(() => dot.evaluate((el) => getComputedStyle(el).animationName))
      .toBe('bubble-typing');
  }
});
