import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';
import type { Snapshot } from '../../src/shared/types';

/** The desktop bridge with a snapshot, terminal sending on and every terminal reachable. */
async function bridge(page: Page, snapshot: Snapshot) {
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.jumps = [];
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      detail: async (id: string) =>
        structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
      visit: async () => structuredClone(w.fixture),
      artifacts: async () => [],
      // Pushes reach the app as the service's would (a newer version of the same run).
      subscribe: (fn: (s: unknown) => void) => {
        w.push = () => {
          w.fixture = { ...w.fixture, version: (w.fixture.version ?? 0) + 1 };
          fn(structuredClone(w.fixture));
        };
        return () => {};
      },
      notices: async () => structuredClone(w.fixture),
      terminalSend: async () => true,
      send: async () => ({ status: 'sent', message: 'sent' }),
      jump: async (id: string) => {
        w.jumps.push(id);
        return { status: 'focused', message: 'ok' };
      },
      terminals: async (ids: string[]) =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            { kind: 'tmux', label: 'tmux', status: 'idle', canSend: true, canFocus: true },
          ]),
        ),
    };
  }, snapshot);
}

/** Nothing just arrived: the pet stands for the lead and says nothing until pointed at. */
function quiet(): Snapshot {
  const snapshot = demoSnapshot();
  snapshot.notices = snapshot.notices!.map((n) => ({ ...n, bootstrap: true }));
  return snapshot;
}

const shownName = (page: Page) => page.locator('.dock-pet-name');

test('Pointing at the pet shows what its colleague said, with the card and terminal beside it', async ({
  page,
}) => {
  await bridge(page, quiet());
  await page.goto('/#mini');
  await expect(page.locator('.desk-pet')).toBeVisible();
  await page.locator('.dock-pet-anchor').hover();
  // As a desk of the row: the colleague's bubble (its last words at least), and the tools.
  await expect(page.locator('.dock-pet-speech .speech-bubble')).toBeVisible();
  await expect(shownName(page)).toBeVisible();
  const tools = page.locator('.dock-pet-actions');
  await expect(tools.getByRole('button', { name: '업무 카드 열기' })).toBeVisible();
  const jump = tools.getByRole('button', { name: /터미널로 이동/ });
  await expect(jump).toBeVisible();
  await page.locator('.desk-pet-stage').screenshot({ path: '.local/pet-hover-row-like.png' });
  const name = (await shownName(page).textContent())!;
  await jump.click();
  const jumped = await page.evaluate(() => (window as any).jumps as string[]);
  expect(jumped).toHaveLength(1);
  // Pointer gone: nothing just arrived, so nothing is said.
  await page.mouse.move(5, 5);
  await expect(page.locator('.dock-pet-speech')).toHaveCount(0);
  expect(name.length).toBeGreaterThan(0);
});

test('The arrows and ←/→ switch the colleague the pet stands for, going round', async ({
  page,
}) => {
  const snapshot = quiet();
  await bridge(page, snapshot);
  await page.goto('/#mini');
  const anchor = page.locator('.dock-pet-anchor');
  await anchor.hover();
  const first = (await shownName(page).textContent())!;
  const place = page.locator('.dock-pet-place');
  const [start, total] = (await place.textContent())!.split('/').map(Number);
  expect(total).toBeGreaterThan(1);
  const next = page.getByRole('button', { name: '다음 동료' });
  await next.click();
  await expect(shownName(page)).not.toHaveText(first);
  const second = (await shownName(page).textContent())!;
  // The pick stays after the pointer leaves: the name tag keeps saying who it is.
  await page.mouse.move(5, 5);
  await expect(shownName(page)).toHaveText(second);
  await page.keyboard.press('ArrowLeft');
  await expect(shownName(page)).toHaveText(first);
  // All the way round comes back to the first.
  await anchor.hover();
  for (let i = 0; i < total; i++) await next.click();
  await expect(shownName(page)).toHaveText(first);
  await page.getByRole('button', { name: '이전 동료' }).click();
  await expect(place).toHaveText(`${start === 1 ? total : start - 1}/${total}`);
});

test('One colleague only: no arrows', async ({ page }) => {
  const snapshot = quiet();
  snapshot.sessions = snapshot.sessions.slice(0, 1);
  snapshot.notices = snapshot.notices!.filter((n) => n.sessionId === snapshot.sessions[0].id);
  await bridge(page, snapshot);
  await page.goto('/#mini');
  await page.locator('.dock-pet-anchor').hover();
  await expect(page.locator('.dock-pet-nav')).toHaveCount(0);
});

test('Someone who just spoke takes the pet back from a pick', async ({ page }) => {
  const snapshot = quiet();
  await bridge(page, snapshot);
  await page.goto('/#mini');
  await page.locator('.dock-pet-anchor').hover();
  await page.getByRole('button', { name: '다음 동료' }).click();
  await page.mouse.move(5, 5);
  // A result arrives from another colleague: the pet turns into that one, speaking it.
  const reply = snapshot.notices!.find((n) => n.kind === 'reply' && n.phase === 'final')!;
  const speaker = snapshot.sessions.find((s) => s.id === reply.sessionId)!;
  await page.evaluate(
    ({ id }) => {
      const w = window as any;
      w.fixture.notices = w.fixture.notices.map((n: any) =>
        n.id === id ? { ...n, bootstrap: false, receivedAt: Date.now() } : n,
      );
    },
    { id: reply.id },
  );
  await page.evaluate(() => (window as any).push());
  await expect(page.locator('.desk-pet.is-speaking')).toBeVisible({ timeout: 15_000 });
  await expect(shownName(page)).toHaveText(speaker.alias!);
});
