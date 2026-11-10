import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { viewButton, viewItem } from './dock-view';

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
        w.cards.push({ action, id: target?.id, ...target });
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
    .locator('> button')
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
  // On its conversation, as a desk's card opens (there is no news tab to open on).
  expect(await page.evaluate(() => 'news' in (window as any).cards.at(-1))).toBe(false);
  // No unfolding: the pet stays a pet.
  expect(await page.evaluate(() => (window as any).docks)).not.toContain('row');
  await expect(page.locator('.desk-pet')).toBeVisible();
});

test('a number lists who it counts (mouse or keys); a name opens that card and turns the pet', async ({
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
        w.cards.push({ action, id: target?.id, ...target });
      },
      dock: async (action: string) => {
        w.docks.push(action);
      },
      window: async () => {},
    };
  }, s);
  await page.goto('/?lang=ko#mini');
  // No puff on arrival: it marks a turn, not the pet appearing.
  await expect(page.locator('.pet-swap-puff')).toHaveCount(0);
  const working = page.getByRole('button', { name: /^일하는 중 4명/ });
  const list = page.locator('.dock-pet-list');
  // A real click on the number (hover first, as a hand does): the list opens and stays open,
  // nothing is dragged and no card opens.
  await working.hover();
  await working.click();
  await expect(list).toBeVisible();
  await expect(list.getByRole('button')).toHaveCount(4);
  expect(await page.evaluate(() => (window as any).cards)).toEqual([]);
  expect(await page.evaluate(() => (window as any).docks)).not.toContain('drag-start');
  // Up into the list without it closing; a name opens that colleague's card.
  const first = list.getByRole('button').first();
  await first.hover();
  await expect(list).toBeVisible();
  const name = (await first.locator('.pet-list-name').textContent())!;
  await first.click();
  await expect.poll(() => page.evaluate(() => (window as any).cards.at(-1)?.id)).toBeTruthy();
  expect(await page.evaluate(() => 'news' in (window as any).cards.at(-1))).toBe(false);
  await expect(list).toHaveCount(0);
  await page.locator('.dock-pet-anchor').hover();
  await expect(page.locator('.dock-pet-name')).toHaveText(name);

  // Keys: focus a number, Enter opens, Tab reaches the names, Esc closes back to the number.
  await page.mouse.move(0, 0);
  await working.focus();
  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await expect(working).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(working).toBeFocused();
  // The dock itself stayed: that Esc only closed the list.
  await expect(page.locator('.desk-pet')).toBeVisible();

  // The arrows slide the pet in, with a puff, only for that turn.
  await page.locator('.dock-pet-anchor').hover();
  await page.getByRole('button', { name: '다음 동료' }).click();
  await expect(page.locator('.dock-pet-body')).toHaveClass(/enter-next/);
  await expect(page.locator('.pet-swap-puff')).toHaveCount(1);
});

test('an open list never covers the pet tools: the desks still unfold from there', async ({
  page,
}) => {
  await page.goto('/?demo&lang=ko#mini');
  const working = page.getByRole('button', { name: /^일하는 중 \d+명/ });
  await working.click();
  await expect(page.locator('.dock-pet-list')).toBeVisible();
  await page.locator('.dock-pet-anchor').hover();
  await viewButton(page.locator('.dock-pet-tools')).click({ timeout: 3000 });
  await viewItem(page, '책상 줄').click();
  await expect(page.locator('.desk-row [data-station-id]').first()).toBeVisible();
});
