import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

// The desk pet's pill counts the office by colour (waiting, results, working, standing by), and
// clicking the pet opens its colleague's card as every desk does; the flag unfolds the desks.
test('the pet pill counts each group with a coloured dot, and a click pops up the card', async ({
  page,
}) => {
  const s = demoSnapshot();
  await page.addInitScript((s) => {
    const w = window as any;
    w.cards = [];
    w.docks = [];
    w.office = {
      snapshot: async () => structuredClone(s),
      subscribe: () => () => {},
      detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
      artifacts: async () => [],
      visit: async () => structuredClone(s),
      terminals: async () => ({}),
      card: async (action: string, target: any) => {
        w.cards.push({ action, id: target?.id, news: target?.news });
      },
      dock: async (action: string) => {
        w.docks.push(action);
      },
      window: async () => {},
    };
  }, s);
  await page.goto('/?lang=ko#mini');
  const pill = page.locator('.dock-pet-tally');
  await expect(pill).toBeVisible();
  // Every group shown has a number above zero, in triage order, and the tooltip names them.
  const groups = await pill
    .locator('> span')
    .evaluateAll((spans) => spans.map((el) => [el.className, Number(el.textContent)]));
  // The demo office: one calls, one result to read, four at work (as its roster counts them).
  expect(groups).toEqual([
    ['tally-attention', 1],
    ['tally-results', 1],
    ['tally-working', 4],
  ]);
  const order = ['attention', 'results', 'working', 'standby'];
  const seen = groups.map(([c]) => order.indexOf(String(c).replace('tally-', '')));
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  // Each number names its group on hover (and lists who, below).
  await expect(pill.locator('.tally-working')).toHaveAttribute('title', '일하는 중 4');
  // Screen readers hear the same numbers.
  await expect(page.locator('.desk-pet')).toHaveAttribute(
    'aria-label',
    /나를 기다려요 1 · 확인할 결과 1 · 일하는 중 4/,
  );
  await page.screenshot({ path: '.local/pet-tally.png' });

  await page.locator('.desk-pet').click();
  await expect.poll(() => page.evaluate(() => (window as any).cards.at(-1)?.action)).toBe('open');
  // The card is the colleague the pet stands for: the one calling the person.
  const opened = await page.evaluate(() => (window as any).cards.at(-1).id);
  expect(s.sessions.find((x) => x.id === opened)?.status).toBe('call');
  // On its conversation, as a desk's card opens — even while the pet speaks a notice.
  expect(await page.evaluate(() => (window as any).cards.at(-1).news)).toBe(false);
  // No unfolding: the pet stays a pet.
  expect(await page.evaluate(() => (window as any).docks)).not.toContain('row');
  await expect(page.locator('.desk-pet')).toBeVisible();
});

test('hovering a number lists who it counts; a name opens that card and the pet turns to them', async ({
  page,
}) => {
  const s = demoSnapshot();
  await page.addInitScript((s) => {
    const w = window as any;
    w.cards = [];
    w.office = {
      snapshot: async () => structuredClone(s),
      subscribe: () => () => {},
      detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
      artifacts: async () => [],
      visit: async () => structuredClone(s),
      terminals: async () => ({}),
      card: async (action: string, target: any) => {
        w.cards.push({ action, id: target?.id, news: target?.news });
      },
      dock: async () => {},
      window: async () => {},
    };
  }, s);
  await page.goto('/?lang=ko#mini');
  const working = page.locator('.dock-pet-tally .tally-working');
  await working.hover();
  const list = page.locator('.dock-pet-list');
  await expect(list).toBeVisible();
  await expect(list.getByRole('button')).toHaveCount(Number(await working.textContent()));
  await page.screenshot({ path: '.local/pet-list.png' });
  // Leaving the number for the list keeps it open; a name opens that colleague's card.
  const first = list.getByRole('button').first();
  await first.hover();
  await expect(list).toBeVisible();
  const name = (await first.locator('.pet-list-name').textContent())!;
  await first.click();
  await expect.poll(() => page.evaluate(() => (window as any).cards.at(-1)?.news)).toBe(false);
  await expect(list).toHaveCount(0);
  await page.locator('.dock-pet-anchor').hover();
  await expect(page.locator('.dock-pet-name')).toHaveText(name);
  // The arrows step only through the counted colleagues, sliding the pet in.
  await page.getByRole('button', { name: '다음 동료' }).click();
  await expect(page.locator('.dock-pet-body')).toHaveClass(/enter-next/);
  await expect(page.locator('.pet-swap-puff')).toHaveCount(1);
});
