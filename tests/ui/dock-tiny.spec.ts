import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { TINY_FLOOR_HEIGHT, TINY_ROW_HEIGHT } from '../../src/shared/dock-geometry';

/**
 * Three colleagues: run-0 has an unread final reply, run-1 is calling the person, run-2 is
 * quiet. `bridge` mocks the desktop main process (it owns tiny and answers through onDock);
 * without it the dock is a browser preview and switches locally.
 */
async function setup(
  page: Page,
  hash: string,
  opts: { bridge?: boolean; privacy?: boolean } = { bridge: true },
) {
  const snapshot = demoSnapshot();
  const template = snapshot.sessions[0];
  const notice = snapshot.notices![0];
  const now = Date.now();
  snapshot.sessions = [0, 1, 2].map((i) => ({
    ...template,
    id: `run-${i}`,
    nativeId: `run-${i}`,
    alias: `동료 ${i}`,
    title: `업무 ${i}`,
    project: i < 2 ? 'team-a' : 'team-b',
    cwd: i < 2 ? '/tmp/team-a' : '/tmp/team-b',
    workspace: undefined,
    area: undefined,
    branch: 'main',
    officeSeat: i,
    status: i === 1 ? 'call' : 'idle',
    updatedAt: now,
    events: [
      {
        ...template.events[0],
        id: `said-${i}`,
        kind: 'assistant' as const,
        text: `답변 ${i}`,
        phase: 'final' as const,
        at: now,
      },
    ],
    activity: undefined,
    actor: undefined,
    origin: undefined,
  }));
  snapshot.notices = [0, 1].map((i) => ({
    ...notice,
    id: `notice-${i}`,
    eventId: `said-${i}`,
    sessionId: `run-${i}`,
    kind: i === 1 ? 'attention' : 'reply',
    phase: 'final',
    text: `답변 ${i}`,
    at: now,
    receivedAt: now,
    seenAt: null,
    viewedAt: null,
    dismissedAt: null,
    resolvedAt: null,
    bootstrap: false,
    version: 'v1',
  }));
  snapshot.preferences.privacy = !!opts.privacy;
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.addInitScript(
    ({ s, bridge }) => {
      const w = window as any;
      w.fixture = s;
      w.calls = [];
      w.opens = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        terminals: async () => ({}),
        subscribe: (cb: any) => {
          w.publish = () => {
            w.fixture.version++;
            cb(structuredClone(w.fixture));
          };
          return () => {};
        },
        card: async (action: string, target: any) => {
          if (action === 'open') w.opens.push(target.id);
        },
      };
      if (bridge) {
        // Like the main process: it keeps the mode and tiny, and tells the dock both.
        const state = { mode: 'row', tiny: false };
        w.office.dock = async (action: string) => {
          w.calls.push(action);
          if (['row', 'floor', 'pet'].includes(action)) state.mode = action;
          else if (action === 'tiny-on' || action === 'tiny-off') state.tiny = action === 'tiny-on';
          else return;
          w.mode?.(state.mode, state.tiny);
        };
        w.office.onDock = (cb: any) => {
          w.mode = cb;
          return () => {};
        };
      }
    },
    { s: snapshot, bridge: !!opts.bridge },
  );
  await page.goto(`/?lang=ko${hash}`);
  await expect(page.locator('.row-zone')).toHaveCount(2);
}
const calls = (page: Page) => page.evaluate(() => (window as any).calls as string[]);
const pet = (page: Page, i: number) => page.locator(`.office-pet[data-session-id="run-${i}"]`);

for (const mode of ['row', 'floor'] as const) {
  test(`Tiny ${mode}: desks only with status dots, and back to full size`, async ({ page }) => {
    await setup(page, `#mini=${mode}`);
    await expect(page.locator('.speech-bubble').first()).toBeVisible();
    const full = (await pet(page, 0).boundingBox())!.height;

    await page.getByRole('button', { name: '작게 보기' }).click();
    expect(await calls(page)).toContain('tiny-on');
    const row = page.locator('.desk-row');
    await expect(row).toHaveClass(/is-tiny/);
    await expect(row).toHaveCSS(
      'height',
      `${mode === 'floor' ? TINY_FLOOR_HEIGHT : TINY_ROW_HEIGHT}px`,
    );
    await expect(page.locator('.speech-bubble')).toHaveCount(0);
    await expect(
      page.locator('.zone-flag, .row-zone-mark, .row-zone-floor, .desk-name, .floor-plate'),
    ).toHaveCount(0);
    await expect(page.locator('.veil-button, .pin-button, .card-button')).toHaveCount(0);
    // About helper-desk size: the 80px colleague is drawn at about 33px.
    const small = (await pet(page, 0).boundingBox())!.height;
    expect(small).toBeLessThan(full * 0.5);
    expect(small).toBeGreaterThan(full * 0.3);

    // Final reply → blue, call → red, nothing new → no dot.
    const dot = (i: number) => page.locator(`[data-station-id="run-${i}"] .tiny-dot`);
    await expect(dot(0)).toHaveClass(/tone-reply/);
    await expect(dot(1)).toHaveClass(/tone-attention/);
    await expect(dot(2)).toHaveCount(0);
    await expect(pet(page, 0)).toHaveAttribute('title', '동료 0');

    // Tiny desks never move: a drag across the neighbour leaves the order as it was.
    const x = (i: number) =>
      page
        .locator(`[data-station-id="run-${i}"]`)
        .evaluate((el) => (el as HTMLElement).style.transform);
    const before = [await x(0), await x(1)];
    const from = (await pet(page, 0).boundingBox())!;
    const to = (await pet(page, 1).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    expect([await x(0), await x(1)]).toEqual(before);
    await page.evaluate(() => ((window as any).opens.length = 0));

    await pet(page, 0).click();
    await expect.poll(() => page.evaluate(() => (window as any).opens)).toEqual(['run-0']);

    await page.getByRole('button', { name: '크게 보기' }).click();
    expect(await calls(page)).toContain('tiny-off');
    await expect(row).not.toHaveClass(/is-tiny/);
    await expect(page.locator('.speech-bubble').first()).toBeVisible();
    await expect(page.locator('.tiny-dot')).toHaveCount(0);
  });
}

test('A read reply loses its dot; a call keeps it until answered', async ({ page }) => {
  await setup(page, '#mini=row&tiny');
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  await expect(page.locator('[data-station-id="run-0"] .tiny-dot')).toHaveClass(/tone-reply/);
  // The collector's next push carries the read marks.
  await page.evaluate(() => {
    const w = window as any;
    for (const n of w.fixture.notices) n.seenAt = Date.now();
    w.publish();
  });
  await expect(page.locator('[data-station-id="run-0"] .tiny-dot')).toHaveCount(0);
  await expect(page.locator('[data-station-id="run-1"] .tiny-dot')).toHaveClass(/tone-attention/);
});

test('Tiny in privacy shows no names on hover', async ({ page }) => {
  await setup(page, '#mini=floor&tiny', { bridge: true, privacy: true });
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  await expect(pet(page, 0)).not.toHaveAttribute('title', /.+/);
});

test('Browser preview: tiny switches locally and stays after reload', async ({ page }) => {
  await setup(page, '#mini=row', { bridge: false });
  await page.getByRole('button', { name: '작게 보기' }).click();
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  await page.reload();
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  await page.getByRole('button', { name: '크게 보기' }).click();
  await expect(page.locator('.desk-row')).not.toHaveClass(/is-tiny/);
  await page.reload();
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await expect(page.locator('.desk-row')).not.toHaveClass(/is-tiny/);
});

test('The window hash opens the floor tiny', async ({ page }) => {
  await setup(page, '#mini=floor&tiny', { bridge: false });
  await expect(page.locator('.desk-row.desk-floor')).toHaveClass(/is-tiny/);
  await expect(page.locator('.zone-flag')).toHaveCount(0);
});
