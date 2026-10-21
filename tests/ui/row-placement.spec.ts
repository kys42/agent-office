import { test, expect, type Page, type Locator } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

async function setup(
  page: Page,
  mode: 'row' | 'floor',
  opts: { single?: boolean; crowded?: boolean; privacy?: boolean; english?: boolean } = {},
) {
  const snapshot = demoSnapshot();
  const template = snapshot.sessions[0];
  snapshot.sessions = Array.from({ length: opts.single ? 1 : opts.crowded ? 7 : 3 }, (_, i) => ({
    ...template,
    id: `run-${i}`,
    nativeId: `run-${i}`,
    alias: `동료 ${i}`,
    title: `업무 ${i}`,
    project: i < 2 ? 'team-a' : `team-${i}`,
    cwd: i < 2 ? '/tmp/team-a' : `/tmp/team-${i}`,
    workspace: undefined,
    area: undefined,
    branch: 'main',
    officeSeat: i,
    events: [],
    activity: undefined,
    actor: undefined,
    origin: undefined,
  }));
  if (!opts.single && !opts.crowded)
    snapshot.sessions.push({
      ...snapshot.sessions[0],
      id: 'helper',
      nativeId: 'helper',
      alias: '보조 동료',
      officeSeat: undefined,
      parentId: 'run-0',
      attachedTo: 'run-0',
      relation: { kind: 'subagent', parentNativeId: 'run-0', source: 'fixture', role: 'explorer' },
    });
  snapshot.notices = [];
  snapshot.preferences.privacy = !!opts.privacy;
  await page.setViewportSize({ width: opts.crowded ? 680 : 1440, height: 720 });
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.calls = [];
    w.opens = [];
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      detail: async (id: string) =>
        structuredClone(w.fixture.sessions.find((s: any) => s.id === id)),
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
      dock: async (action: string) => {
        w.calls.push(action);
        if (['row', 'floor', 'pet'].includes(action)) w.mode?.(action);
      },
      onDock: (cb: any) => {
        w.mode = cb;
        return () => {};
      },
      card: async (action: string, target: any) => {
        if (action === 'open') w.opens.push(target.id);
      },
      veil: async (ids: string[], on: boolean) => {
        for (const s of w.fixture.sessions)
          if (ids.includes(s.id)) s.hiddenAt = on ? Date.now() : null;
        w.publish();
        return structuredClone(w.fixture);
      },
    };
  }, snapshot);
  await page.goto(`/?lang=${opts.english ? 'en' : 'ko'}#mini=${mode}`);
  await expect(page.locator('.row-zone')).toHaveCount(opts.single ? 1 : opts.crowded ? 6 : 2);
  await expect
    .poll(() => page.locator('.desk-row-lane').evaluate((el) => el.getBoundingClientRect().width))
    .toBeGreaterThan(1000 * (opts.crowded ? 0.5 : 1));
}
function handle(page: Page, mode: 'row' | 'floor', zone = 0) {
  return page.locator(mode === 'floor' ? '.zone-flag-cloth' : '.row-zone-handle').nth(zone);
}
async function left(zone: Locator) {
  return zone.evaluate((el) => parseFloat((el as HTMLElement).style.left));
}
async function drag(page: Page, h: Locator, delta: number, keep = true) {
  const b = (await h.boundingBox())!;
  const x = b.x + b.width / 2,
    y = b.y + Math.min(b.height / 2, 12);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
  if (keep) await page.mouse.up();
}

for (const mode of ['row', 'floor'] as const) {
  test(`Dragging the ${mode} sign moves the group and remembers it after reload`, async ({
    page,
  }) => {
    await setup(page, mode, { single: true });
    const zone = page.locator('.row-zone');
    const before = await left(zone);
    await drag(page, handle(page, mode), -300);
    await expect.poll(() => left(zone)).toBeLessThan(before - 250);
    const moved = await left(zone);
    expect(await page.evaluate(() => (window as any).opens)).toEqual([]);
    const saved = await page.evaluate(() => localStorage.getItem('office:row-zones:v1:live'));
    expect(saved).not.toBeNull();
    await page.reload();
    await expect.poll(() => left(zone)).toBeCloseTo(moved, 0);
    await page.setViewportSize({ width: 1000, height: 720 });
    await expect
      .poll(() => zone.evaluate((el) => el.getBoundingClientRect().right))
      .toBeLessThan(1000);
    await page.getByRole('button', { name: '기본 배치로 되돌리기' }).click();
    await expect.poll(() => left(zone)).toBeCloseTo((1000 - 96 - 188) / 2, 0);
    expect(await page.evaluate(() => localStorage.getItem('office:row-zones:v1:live'))).toBeNull();
  });
  test(`Escape and pointer cancel restore ${mode} position without folding the row`, async ({
    page,
  }) => {
    await setup(page, mode, { single: true });
    const zone = page.locator('.row-zone'),
      before = await left(zone);
    await drag(page, handle(page, mode), 180, false);
    await expect.poll(() => left(zone)).toBeGreaterThan(before + 150);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect.poll(() => left(zone)).toBeCloseTo(before, 0);
    await expect(page.locator('.desk-row')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('office:row-zones:v1:live'))).toBeNull();
    await drag(page, handle(page, mode), -160, false);
    await handle(page, mode).dispatchEvent('pointercancel', { pointerId: 1 });
    await page.mouse.up();
    await expect.poll(() => left(zone)).toBeCloseTo(before, 0);
  });
  test(`After a ${mode} sign drag the next desk and helper clicks still open their cards`, async ({
    page,
  }) => {
    await setup(page, mode);
    const zone = page.locator('.row-zone').first();
    const before = await left(zone);
    await drag(page, handle(page, mode), 160);
    await expect.poll(() => left(zone)).toBeGreaterThan(before + 100);
    await expect(zone).not.toHaveClass(/is-arranging/);
    const opens = () => page.evaluate(() => (window as any).opens as string[]);
    expect(await opens()).toEqual([]);
    // Only a tiny desk grab swallows its own release click; a sign drag leaves the next alone.
    await page.locator('.office-pet[data-session-id="run-0"]').click();
    await expect.poll(opens).toEqual(['run-0']);
    await drag(page, handle(page, mode), -60);
    await page.locator('.helper-desk[data-session-id="helper"]').click();
    await expect.poll(opens).toEqual(['run-0', 'helper']);
  });
}

test('A group retains its shared bench and helper when dragged past another group', async ({
  page,
}) => {
  await setup(page, 'row');
  const original = page.locator('.row-zone[data-project-key="/tmp/team-a"]');
  await expect(original.locator('.row-station')).toHaveCount(2);
  await expect(original.locator('.helper-desk')).toHaveCount(1);
  const before = await original.boundingBox();
  await drag(page, original.locator('.row-zone-handle'), 650);
  const zones = await page.locator('.row-zone').evaluateAll((els) =>
    els
      .map((el) => ({
        key: el.getAttribute('data-project-key'),
        x: parseFloat((el as HTMLElement).style.left),
        width: el.getBoundingClientRect().width,
      }))
      .sort((a, b) => a.x - b.x),
  );
  expect(zones[1].key).toBe('/tmp/team-a');
  expect(zones[1].x).toBeGreaterThanOrEqual(zones[0].x + zones[0].width + 18);
  await expect(original.locator('.row-station')).toHaveCount(2);
  await expect(original.locator('.helper-desk')).toHaveCount(1);
  expect((await original.boundingBox())!.width).toBe(before!.width);
});

test('Keyboard placement shares positions between row and floor and does not page the track', async ({
  page,
}) => {
  await setup(page, 'row', { single: true });
  const zone = page.locator('.row-zone'),
    h = handle(page, 'row');
  await h.focus();
  await h.press('Home');
  await expect.poll(() => left(zone)).toBe(0);
  await h.press('Shift+ArrowRight');
  await expect.poll(() => left(zone)).toBe(64);
  expect(await page.locator('.desk-row-track').evaluate((el) => el.scrollLeft)).toBe(0);
  await h.press('End');
  await expect
    .poll(() => zone.evaluate((el) => el.getBoundingClientRect().right))
    .toBeCloseTo(1440 - 48, 0);
  await page.getByRole('button', { name: '바닥 책상으로 보기', exact: true }).click();
  await expect(page.locator('.zone-flag-cloth')).toBeVisible();
  await expect
    .poll(() => zone.evaluate((el) => el.getBoundingClientRect().right))
    .toBeCloseTo(1440 - 48, 0);
});

test('Native click-through stays solid across gaps during drag, then returns to through on cancel', async ({
  page,
}) => {
  await setup(page, 'floor', { single: true });
  await drag(page, handle(page, 'floor'), 70, false);
  await page.evaluate(() => {
    (window as any).calls = [];
    document.documentElement.dispatchEvent(new MouseEvent('mouseleave'));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
  });
  expect(await page.evaluate(() => (window as any).calls)).not.toContain('through');
  await page.mouse.move(10, 10);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.includes('through')))
    .toBe(true);
  await expect(page.locator('.desk-row')).toBeVisible();
});

test('Hold near an edge scrolls a crowded row while dragging', async ({ page }) => {
  await setup(page, 'row', { crowded: true });
  await drag(page, handle(page, 'row'), 100, false);
  await page.mouse.move(670, 690);
  await expect
    .poll(() => page.locator('.desk-row-track').evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(80);
  await page.mouse.up();
  const zones = await page.locator('.row-zone').evaluateAll((els) =>
    els
      .map((el) => ({
        x: parseFloat((el as HTMLElement).style.left),
        width: el.getBoundingClientRect().width,
      }))
      .sort((a, b) => a.x - b.x),
  );
  for (let i = 1; i < zones.length; i++)
    expect(zones[i].x).toBeGreaterThanOrEqual(zones[i - 1].x + zones[i - 1].width + 18 - 0.1);
});

test('A topology update during drag cancels; the hide control keeps its own click', async ({
  page,
}) => {
  await setup(page, 'row');
  const zone = page.locator('.row-zone[data-project-key="/tmp/team-a"]');
  await drag(page, zone.locator('.row-zone-handle'), -120, false);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.sessions = w.fixture.sessions.filter((s: any) => s.id !== 'helper');
    w.publish();
  });
  await expect(page.locator('.row-zone.is-arranging')).toHaveCount(0);
  await page.mouse.up();
  expect(await page.evaluate(() => localStorage.getItem('office:row-zones:v1:live'))).toBeNull();
  await zone.locator('.row-zone-handle').hover();
  await zone.locator('.zone-veil').click();
  await expect(zone).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('office:row-zones:v1:live'))).toBeNull();
});

test('Privacy and English labels expose no project names in drag controls', async ({ page }) => {
  await setup(page, 'floor', { single: true, privacy: true, english: true });
  const h = page.getByRole('button', { name: 'Move zone · Project', exact: true });
  await expect(h).toBeVisible();
  await expect(h).not.toContainText('team-a');
  await h.focus();
  await h.press('Home');
  await expect.poll(() => left(page.locator('.row-zone'))).toBe(0);
  await expect(page.getByRole('button', { name: 'Reset zone positions' })).toBeVisible();
});

test('Wheel scroll during a drag updates the preview and release keeps those coordinates', async ({
  page,
}) => {
  await setup(page, 'row', { crowded: true });
  const zone = page.locator('.row-zone[data-project-key="/tmp/team-a"]');
  await drag(page, zone.locator('.row-zone-handle'), 80, false);
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() => page.locator('.desk-row-track').evaluate((el) => el.scrollLeft))
    .toBeGreaterThanOrEqual(400);
  await expect.poll(() => left(zone)).toBeGreaterThan(100);
  const preview = await left(zone);
  await page.mouse.up();
  await expect.poll(() => left(zone)).toBeCloseTo(preview, 0);
  await page.reload();
  await expect.poll(() => left(zone)).toBeCloseTo(preview, 0);
});
