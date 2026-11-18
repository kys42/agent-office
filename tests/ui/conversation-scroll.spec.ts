import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { OfficeEvent } from '../../src/shared/types';

async function card(page: Page, count = 120, hidden = false) {
  await page.setViewportSize({ width: 480, height: 760 });
  const snapshot = demoSnapshot();
  const full: OfficeEvent[] = Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    kind: hidden && i >= 40 && i < count - 1 ? 'tool' : i % 2 ? 'assistant' : 'user',
    phase: i % 2 ? 'final' : undefined,
    at: Date.now() - (count - i) * 60_000,
    text: `대화 ${i} · ${'내용입니다. '.repeat(12)}`,
    sourceRef: 'fixture',
  }));
  snapshot.notices = [];
  snapshot.sessions[0].events = full.slice(-4);
  snapshot.sessions[0].activity = undefined;
  await page.addInitScript(
    ({ snapshot, full }) => {
      const w = window as any;
      w.full = full;
      w.pages = [];
      w.delay = 0;
      w.office = {
        snapshot: async () => structuredClone(snapshot),
        detail: async (id: string, p: { before?: string } = {}) => {
          w.pages.push(p.before ?? null);
          const s = snapshot.sessions.find((s) => s.id === id)!;
          const end = p.before ? w.full.findIndex((e: any) => e.id === p.before) : w.full.length;
          if (p.before) await new Promise((r) => setTimeout(r, w.delay));
          return structuredClone({
            ...s,
            events: w.full.slice(Math.max(0, end - 40), end),
            olderEvents: end > 40,
            notices: [],
          });
        },
        visit: async () => structuredClone(snapshot),
        artifacts: async () => [],
        subscribe: (cb: any) => {
          w.publish = () => cb(structuredClone(snapshot));
          w.push = () => {
            const i = w.full.length;
            w.full.push({ ...w.full.at(-1), id: `e${i}`, text: `새 대화 ${i}`, at: Date.now() });
            snapshot.sessions[0].events = w.full.slice(-4);
            snapshot.sessions[0].updatedAt = Date.now();
            snapshot.version++;
            w.publish();
          };
          return () => {};
        },
        onCard: (cb: any) => {
          setTimeout(() => cb({ id: snapshot.sessions[0].id }), 20);
          return () => {};
        },
      };
    },
    { snapshot, full },
  );
  await page.goto('/#card');
  await expect(page.locator('.conversation-message').last()).toContainText(`대화 ${count - 1}`);
  return page.locator('.inspector-scroll');
}

test('upward wheel input immediately after following a message keeps the reader above the bottom', async ({
  page,
}) => {
  const scroll = await card(page);
  await scroll.hover();
  // A live message makes the app follow again. Wheel within its former 250 ms grace period.
  await page.evaluate(() => (window as any).push());
  await expect(page.locator('.conversation-message').last()).toContainText('새 대화');
  await page.mouse.wheel(0, -260);
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeGreaterThan(200);
  await page.evaluate(() => (window as any).push());
  await page.waitForTimeout(350);
  expect(
    await scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
  ).toBeGreaterThan(200);
});

test('scrolling near earlier messages during the paging cooldown still loads without clicking', async ({
  page,
}) => {
  const scroll = await card(page, 160);
  await page.waitForTimeout(300);
  await page.evaluate(() => ((window as any).delay = 50));
  await scroll.evaluate((el) => el.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => (window as any).pages.includes('e120'))).toBe(true);
  await expect(page.locator('[data-event-id="e112"]')).toBeAttached();
  // Reach the newly moved top before the cooldown expires; no more input is necessary.
  await scroll.evaluate((el) => el.scrollTo(0, 0));
  await expect(page.locator('[data-event-id="e88"]')).toBeAttached();
  // Real input is distinct from the anchor restoration scroll emitted by layout.
  await scroll.hover();
  await page.mouse.wheel(0, -4000);
  await expect.poll(() => page.evaluate(() => (window as any).pages.includes('e80'))).toBe(true);
});

test('PageUp immediately after following works and returning to the bottom resumes following', async ({
  page,
}) => {
  const scroll = await card(page);
  await scroll.evaluate((el) => {
    el.setAttribute('tabindex', '0');
    (el as HTMLElement).focus();
  });
  await page.evaluate(() => (window as any).push());
  await expect(page.locator('.conversation-message').last()).toContainText('새 대화');
  await scroll.press('PageUp');
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeGreaterThan(200);
  await scroll.hover();
  await page.mouse.wheel(0, 10000);
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2);
  await page.evaluate(() => (window as any).push());
  await expect(page.locator('.conversation-message').last()).toContainText('새 대화 121');
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2);
});

test('moving away from the top cancels a queued older load', async ({ page }) => {
  const scroll = await card(page, 160);
  await page.waitForTimeout(300);
  await scroll.evaluate((el) => el.scrollTo(0, 0));
  await expect(page.locator('[data-event-id="e112"]')).toBeAttached();
  await scroll.evaluate((el) => el.scrollTo(0, 0));
  await scroll.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as any).pages)).toEqual([null, 'e120']);
});

test('a slow older page preserves the position reached while it was loading', async ({ page }) => {
  const scroll = await card(page);
  await page.waitForTimeout(300);
  await page.evaluate(() => ((window as any).delay = 600));
  await scroll.evaluate((el) => el.scrollTo(0, 300));
  await expect.poll(() => page.evaluate(() => (window as any).pages.includes('e80'))).toBe(true);
  await scroll.evaluate((el) => el.scrollBy(0, 200));
  const anchor = await scroll.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const node = [...el.querySelectorAll<HTMLElement>('[data-group-id]')].find(
      (n) => n.getBoundingClientRect().bottom > top,
    )!;
    return { id: node.dataset.groupId!, top: node.getBoundingClientRect().top };
  });
  await expect(page.locator('[data-event-id="e72"]')).toBeAttached();
  await expect
    .poll(() =>
      page
        .locator(`[data-group-id="${anchor.id}"]`)
        .evaluate((el) => el.getBoundingClientRect().top),
    )
    .toBeCloseTo(anchor.top, 0);
});

test('upward wheel at a non-scrolling filtered page finds older visible messages and removes the end marker', async ({
  page,
}) => {
  const scroll = await card(page, 160, true);
  await expect(page.locator('.conversation-message')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).pages)).toEqual([null]);
  await scroll.hover();
  await page.mouse.wheel(0, -400);
  await expect(page.locator('[data-event-id="e39"]')).toBeAttached();
  for (let i = 0; i < 5 && (await page.locator('.older-messages').count()); i++) {
    await scroll.evaluate((el) => el.scrollTo(0, 0));
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(850);
  }
  await expect(page.locator('[data-event-id="e0"]')).toBeAttached();
  await expect(page.locator('.older-messages')).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).pages)).filter(Boolean)).toEqual([
    'e120',
    'e80',
    'e40',
  ]);
});

test('Reading a thousand messages keeps a bounded window, holds it through new work and jumps back', async ({
  page,
}) => {
  test.setTimeout(120000);
  const scroll = await card(page, 1000);
  const older = page.locator('.older-messages');
  await expect(older).toBeVisible();
  for (let i = 0; i < 90 && (await older.count()); i++) {
    try {
      await older.click({ timeout: 2000 });
    } catch (error) {
      // Scrolling the button into view may auto-load the final page before the click lands.
      // That is successful navigation, not a button that should reappear for 120 seconds.
      if (!(await page.locator('[data-event-id="e0"]').count())) throw error;
      break;
    }
    await expect.poll(() => page.locator('.conversation-message').count()).toBeLessThanOrEqual(400);
  }
  await expect(page.locator('[data-event-id="e0"]')).toBeAttached();
  await expect(older).toHaveCount(0);
  await page.evaluate(() => (window as any).push());
  await expect(page.locator('[data-event-id="e0"]')).toBeAttached();
  await expect(page.locator('[data-event-id="e1000"]')).toHaveCount(0);
  await page.screenshot({ path: '.local/memory-history-window.png' });
  await page.locator('.new-messages').click();
  await expect(page.locator('[data-event-id="e1000"]')).toBeAttached();
  await expect(page.locator('[data-event-id="e0"]')).toHaveCount(0);
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(100);
});
