import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

// #306: a pleased pet — rubbing it pets it (hops, cheeks, hearts); still without motion.
async function office(page: Page, route: string, reducedMotion = false) {
  const s = demoSnapshot();
  s.preferences.reducedMotion = reducedMotion;
  await page.addInitScript((s) => {
    const w = window as any;
    w.office = {
      snapshot: async () => structuredClone(s),
      subscribe: () => () => {},
      detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
      artifacts: async () => [],
      visit: async () => structuredClone(s),
      terminals: async () => ({}),
    };
  }, s);
  await page.goto(`/?lang=ko${route}`);
}
/** Rubs the mouse side to side over the first pet, no button held. */
async function rubPet(page: Page) {
  const pet = page.locator('.office-pet').first();
  await expect(pet).toBeVisible();
  const box = (await pet.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  for (const dx of [-12, 12, -12, 12, -12])
    await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 3 });
  return pet;
}

for (const route of ['', '#mini=row'])
  test(`rubbing a pet pets it: hops, cheeks and hearts, then it settles ${route || 'office'}`, async ({
    page,
  }) => {
    await office(page, route);
    const pet = await rubPet(page);
    await expect(pet).toHaveClass(/reacting-pat/);
    await expect(pet.locator('.pet-joy.joy-pat b')).toHaveCount(3);
    await expect(pet.locator('.sprite-window')).toHaveCSS('animation-name', /joy-bounce-/);
    // A rub is no click: no card opened, no desk selected.
    await expect(page.locator('.selected-station')).toHaveCount(0);
    await expect(pet).not.toHaveClass(/reacting/, { timeout: 3000 });
    await expect(pet.locator('.pet-joy')).toHaveCount(0);
  });

test('without motion a petted pet stays still and just shows its hearts', async ({ page }) => {
  await office(page, '', true);
  const pet = await rubPet(page);
  await expect(pet).toHaveClass(/reacting-pat/);
  await expect(pet.locator('.sprite-window')).toHaveCSS('animation-name', 'none');
  await expect(pet.locator('.pet-joy b').first()).toHaveCSS('animation-name', 'none');
  await expect(pet.locator('.pet-joy b').first()).toHaveCSS('opacity', '1');
});

test('a pet walking in keeps walking while petted: only its sprite bounces', async ({ page }) => {
  const s = demoSnapshot();
  const now = Date.now();
  // Brought back just now: it walks in (commute-in) for its first seconds.
  Object.assign(s.sessions[0], { returnedAt: now - 200 });
  await page.addInitScript((s) => {
    (window as any).office = {
      snapshot: async () => structuredClone(s),
      subscribe: () => () => {},
      detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
      artifacts: async () => [],
      visit: async () => structuredClone(s),
      terminals: async () => ({}),
    };
  }, s);
  // Slow the walk down so it is surely still on while the rub lands (a slow machine may take
  // longer than the 2.2s walk to hover and rub); only the timing changes, not the rules.
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = '.office-pet.commuting{animation-duration:30s!important}';
    document.addEventListener('DOMContentLoaded', () => document.head.append(style));
  });
  await page.goto('/?lang=ko');
  const walker = page.locator(`.office-pet[data-session-id="${s.sessions[0].id}"]`);
  await expect(walker).toHaveClass(/commuting/);
  const box = (await walker.boundingBox())!;
  const y = box.y + box.height / 2;
  for (const dx of [0, -12, 12, -12, 12, -12])
    await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 3 });
  await expect(walker).toHaveClass(/reacting-pat/);
  // The pet's own walk is not replaced by the reaction: only its sprite bounces.
  await expect(walker).not.toHaveCSS('animation-name', /joy-bounce/);
  await expect(walker.locator('.sprite-window')).toHaveCSS('animation-name', /joy-bounce-/);
});

test('over a pet the pointer is a petting hand', async ({ page }) => {
  await office(page, '');
  const pet = page.locator('.office-pet').first();
  await pet.hover();
  await expect(pet).toHaveCSS('cursor', /url\("data:image\/svg\+xml.*16 16, grab/);
});
