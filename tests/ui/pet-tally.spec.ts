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
        w.cards.push({ action, id: target?.id });
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
  expect(groups.length).toBeGreaterThan(1);
  for (const [, n] of groups) expect(n).toBeGreaterThan(0);
  const order = ['attention', 'results', 'working', 'standby'];
  const seen = groups.map(([c]) => order.indexOf(String(c).replace('tally-', '')));
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  await expect(pill).toHaveAttribute('title', /일하는 중 \d+/);
  await page.screenshot({ path: '.local/pet-tally.png' });

  await page.locator('.desk-pet').click();
  await expect.poll(() => page.evaluate(() => (window as any).cards.at(-1)?.action)).toBe('open');
  // No unfolding: the pet stays a pet.
  expect(await page.evaluate(() => (window as any).docks)).not.toContain('row');
  await expect(page.locator('.desk-pet')).toBeVisible();
});
