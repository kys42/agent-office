import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { Snapshot } from '../../src/shared/types';

/** Three desks of one zone on their own branches (no shared bench), and one desk elsewhere. */
function fixture(): Snapshot {
  const snapshot = demoSnapshot();
  const template = snapshot.sessions[0];
  snapshot.sessions = ['a', 'b', 'c', 'd'].map((id, i) => ({
    ...template,
    id,
    nativeId: id,
    alias: `동료 ${id}`,
    title: `업무 ${id}`,
    project: i < 3 ? 'team-a' : 'team-b',
    cwd: i < 3 ? '/tmp/team-a' : '/tmp/team-b',
    workspace: undefined,
    area: undefined,
    branch: `feature-${id}`,
    officeSeat: i,
    events: [],
    activity: undefined,
    actor: undefined,
    origin: undefined,
    resident: undefined,
  }));
  snapshot.notices = [];
  snapshot.version = 1;
  return snapshot;
}
/** The service's reorder: the ids take their own tokens, sorted, in the given order. */
function reorder(snapshot: Snapshot, ids: string[]) {
  const desks = ids.flatMap((id) => snapshot.sessions.filter((s) => s.id === id));
  const tokens = desks.map((s) => s.officeSeat!).sort((x, y) => x - y);
  desks.forEach((s, i) => (s.officeSeat = tokens[i]));
  snapshot.version++;
}
/** Station ids of one zone, left to right on screen. */
async function order(page: Page, zone: string) {
  const ids = await page
    .locator(`:is(.office-map, .desk-row) [data-project-key="${zone}"] [data-station-id]`)
    .evaluateAll((els) =>
      els
        .map((el) => ({
          id: el.getAttribute('data-station-id')!,
          x: el.getBoundingClientRect().x,
        }))
        .sort((a, b) => a.x - b.x)
        .map((s) => s.id),
    );
  return ids;
}

test('Dragging a desk onto another in its zone reorders the big office and keeps the order', async ({
  page,
}) => {
  const snapshot = fixture();
  const calls: string[][] = [];
  await page.route('**/api/rpc', async (route) => {
    const { method, args } = route.request().postDataJSON();
    if (method === 'reorderSeats') {
      calls.push(args[0]);
      reorder(snapshot, args[0]);
    }
    await route.fulfill({ json: { result: snapshot } });
  });
  await page.goto('/');
  await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['a', 'b', 'c']);
  const pet = page.locator('.office-pet[data-session-id="c"]');
  // The left half of the first desk: the dragged desk goes in before it.
  await pet.dragTo(page.locator('[data-station-id="a"]'), {
    force: true,
    targetPosition: { x: 20, y: 120 },
  });
  await expect.poll(() => calls).toEqual([['c', 'a', 'b']]);
  await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['c', 'a', 'b']);
  await expect(page.getByRole('dialog', { name: '사무실 구역 옮기기' })).toHaveCount(0);
  // The right half of the last desk: after it.
  await page
    .locator('.office-pet[data-session-id="c"]')
    .dragTo(page.locator('[data-station-id="b"]'), {
      force: true,
      targetPosition: { x: 140, y: 120 },
    });
  await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['a', 'b', 'c']);
  // Dropping on itself changes nothing and sends nothing (given time to arrive, it does not).
  await page
    .locator('.office-pet[data-session-id="a"]')
    .dragTo(page.locator('[data-station-id="a"]'), {
      force: true,
      targetPosition: { x: 140, y: 120 },
    });
  await page.waitForTimeout(300);
  expect(calls).toHaveLength(2);
  // Kept by the service: a reload shows the same order.
  await page.reload();
  await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['a', 'b', 'c']);
  // Another zone's desk still asks where the desk should go.
  await page
    .locator('.office-pet[data-session-id="a"]')
    .dragTo(page.locator('[data-station-id="d"]'), {
      force: true,
      targetPosition: { x: 20, y: 120 },
    });
  await expect(page.getByRole('dialog', { name: '사무실 구역 옮기기' })).toBeVisible();
  expect(calls).toHaveLength(2);
});

/** A peer's desk (federated, read-only) sitting between a and b in team-a. */
function mixed(): Snapshot {
  const snapshot = fixture();
  const [a, b, c, d] = snapshot.sessions;
  const x = {
    ...a,
    id: 'remote-office:peer:x',
    nativeId: 'x',
    alias: '원격 동료',
    title: '원격 업무',
    branch: 'feature-x',
    officeSeat: 1,
    remote: {
      officeId: 'peer',
      sessionId: 'x',
      label: 'MacBook Pro',
      tags: [],
      receivedAt: Date.now(),
      stale: false,
      conversation: true,
      send: false,
    },
  } as Snapshot['sessions'][number];
  b.officeSeat = 2;
  c.officeSeat = 3;
  d.officeSeat = 4;
  snapshot.sessions = [a, x, b, c, d];
  return snapshot;
}
/** Holds a desk's character in the big office (a real HTML drag) until `drop`. */
async function carry(page: Page, id: string) {
  const b = (await page.locator(`.office-pet[data-session-id="${id}"]`).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 12, b.y + b.height / 2 + 4, { steps: 3 });
}
async function overDesk(page: Page, id: string, fraction: number) {
  const b = (await page.locator(`.office-map [data-station-id="${id}"]`).boundingBox())!;
  const x = b.x + b.width * fraction,
    y = b.y + b.height * 0.6;
  await page.mouse.move(x, y, { steps: 8 });
  // The browser paces drag events: settle, then a nudge so the last one lands here.
  await page.waitForTimeout(100);
  await page.mouse.move(x + 1, y);
}

test('A peer’s desk in the zone is no target, and only local desks are sent', async ({ page }) => {
  const snapshot = mixed();
  const calls: string[][] = [];
  await page.route('**/api/rpc', async (route) => {
    const { method, args } = route.request().postDataJSON();
    if (method === 'reorderSeats') {
      calls.push(args[0]);
      reorder(snapshot, args[0]);
    }
    await route.fulfill({ json: { result: snapshot } });
  });
  await page.goto('/');
  const remote = 'remote-office:peer:x';
  await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['a', remote, 'b', 'c']);
  await carry(page, 'c');
  await overDesk(page, remote, 0.25);
  await expect(page.locator('.office-map .drop-before, .office-map .drop-after')).toHaveCount(0);
  await overDesk(page, 'a', 0.25);
  await expect(page.locator('.office-map [data-station-id="a"]')).toHaveClass(/drop-before/);
  await expect(page.locator('.drag-hint')).toHaveText('여기에 놓으면 책상 순서가 바뀌어요');
  await page.mouse.up();
  await expect.poll(() => calls).toEqual([['c', 'a', 'b']]);
  await expect(page.getByText('원격 사무실 · 읽기 전용')).toHaveCount(0);
  await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['c', remote, 'a', 'b']);
});

test('No marker where a drop would leave the order as it is; off to the floor clears it', async ({
  page,
}) => {
  const snapshot = fixture();
  await page.route('**/api/rpc', (route) => route.fulfill({ json: { result: snapshot } }));
  await page.goto('/');
  await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['a', 'b', 'c']);
  await carry(page, 'a');
  // a already sits right before b.
  await overDesk(page, 'b', 0.25);
  await expect(page.locator('.office-map .drop-before, .office-map .drop-after')).toHaveCount(0);
  await expect(page.locator('.drag-hint')).not.toHaveText('여기에 놓으면 책상 순서가 바뀌어요');
  await overDesk(page, 'b', 0.75);
  await expect(page.locator('.office-map [data-station-id="b"]')).toHaveClass(/drop-after/);
  // Out onto the empty floor: the zone move takes over, the edge marker goes.
  const map = (await page.locator('.office-map').boundingBox())!;
  await page.mouse.move(map.x + map.width - 30, map.y + map.height - 30, { steps: 8 });
  await expect(page.locator('.office-map')).toHaveClass(/drop-new/);
  await expect(page.locator('.office-map .drop-before, .office-map .drop-after')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

async function dock(page: Page, mode: 'row' | 'floor', snapshot: Snapshot = fixture()) {
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
      subscribe: (fn: (s: unknown) => void) => {
        w.publish = () => fn(structuredClone(w.fixture));
        return () => {};
      },
      dock: async (action: string) => {
        w.calls.push(action);
      },
      onDock: () => () => {},
      card: async (action: string, target: any) => {
        if (action === 'open') w.opens.push(target.id);
      },
      reorderSeats: async (ids: string[]) => {
        w.calls.push(['reorderSeats', ...ids]);
        const desks = ids.flatMap((id) => w.fixture.sessions.filter((s: any) => s.id === id));
        const tokens = desks.map((s: any) => s.officeSeat).sort((x: number, y: number) => x - y);
        desks.forEach((s: any, i: number) => (s.officeSeat = tokens[i]));
        w.fixture.version++;
        return structuredClone(w.fixture);
      },
    };
  }, snapshot);
  await page.goto(`/#mini=${mode}`);
  await expect(page.locator('.row-zone')).toHaveCount(2);
}
/** Press on a desk's character and drag to `x` within a desk, `steps` moves at a time. */
async function press(page: Page, id: string) {
  const b = (await page.locator(`.office-pet[data-session-id="${id}"]`).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  return b.y + b.height / 2;
}
async function over(page: Page, id: string, fraction: number, y: number) {
  const b = (await page.locator(`[data-station-id="${id}"]`).boundingBox())!;
  await page.mouse.move(b.x + b.width * fraction, y, { steps: 10 });
}
const reorders = (page: Page) =>
  page.evaluate(() => (window as any).calls.filter((c: unknown) => Array.isArray(c)));

for (const mode of ['row', 'floor'] as const) {
  test(`Dragging a desk in the ${mode} reorders its zone; a click still opens the card`, async ({
    page,
  }) => {
    await dock(page, mode);
    await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['a', 'b', 'c']);
    const y = await press(page, 'c');
    await over(page, 'a', 0.25, y);
    await expect(page.locator('[data-station-id="a"]')).toHaveClass(/drop-before/);
    await expect(page.locator('[data-station-id="c"]')).toHaveClass(/is-desk-dragging/);
    // The window stays solid while the desk is carried across gaps.
    await expect.poll(() => page.evaluate(() => (window as any).calls)).toContain('solid');
    await page.mouse.up();
    await expect.poll(() => reorders(page)).toEqual([['reorderSeats', 'c', 'a', 'b']]);
    await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['c', 'a', 'b']);
    await expect(page.locator('.drop-before, .drop-after, .is-desk-dragging')).toHaveCount(0);
    // The release did not open the card; a plain click does.
    expect(await page.evaluate(() => (window as any).opens)).toEqual([]);
    await page.locator('.office-pet[data-session-id="b"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).opens)).toEqual(['b']);

    // Esc cancels a drag without folding the dock; another zone is no target.
    const y2 = await press(page, 'a');
    await over(page, 'd', 0.25, y2);
    await expect(page.locator('.drop-before, .drop-after')).toHaveCount(0);
    await over(page, 'b', 0.75, y2);
    await expect(page.locator('[data-station-id="b"]')).toHaveClass(/drop-after/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.drop-before, .drop-after')).toHaveCount(0);
    await page.mouse.up();
    expect(await reorders(page)).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).opens)).toEqual(['b']);
    await expect(page.locator('.desk-row')).toBeVisible();
    await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['c', 'a', 'b']);
  });
}

test('The row scrolling under a still pointer moves the drop target with it', async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 760 });
  await dock(page, 'row');
  await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['a', 'b', 'c']);
  const y = await press(page, 'a');
  await over(page, 'b', 0.75, y);
  await expect(page.locator('[data-station-id="b"]')).toHaveClass(/drop-after/);
  // The wheel scrolls the row by a desk; the pointer stays where it is, now over c.
  await page.locator('.desk-row-track').evaluate((el) => (el.scrollLeft += 164));
  await expect(page.locator('[data-station-id="c"]')).toHaveClass(/drop-after/);
  await page.mouse.up();
  await expect.poll(() => reorders(page)).toEqual([['reorderSeats', 'b', 'c', 'a']]);
});

test('In the row a peer’s desk is no target, and a drop that changes nothing shows nothing', async ({
  page,
}) => {
  await dock(page, 'row', mixed());
  const remote = 'remote-office:peer:x';
  await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['a', remote, 'b', 'c']);
  const y = await press(page, 'c');
  await over(page, remote, 0.25, y);
  await expect(page.locator('.drop-before, .drop-after')).toHaveCount(0);
  // b already sits right before c.
  await over(page, 'b', 0.75, y);
  await expect(page.locator('.drop-before, .drop-after')).toHaveCount(0);
  await over(page, 'a', 0.25, y);
  await expect(page.locator('[data-station-id="a"]')).toHaveClass(/drop-before/);
  await page.mouse.up();
  await expect.poll(() => reorders(page)).toEqual([['reorderSeats', 'c', 'a', 'b']]);
  await expect(page.getByText('원격 사무실 · 읽기 전용')).toHaveCount(0);
});

for (const mode of ['row', 'floor'] as const) {
  test(`A desk re-keyed mid-drag in the ${mode} ends the drag and lets the window go`, async ({
    page,
  }) => {
    await dock(page, mode);
    await expect.poll(() => order(page, '/tmp/team-a')).toEqual(['a', 'b', 'c']);
    const y = await press(page, 'c');
    await over(page, 'a', 0.25, y);
    await expect(page.locator('[data-station-id="a"]')).toHaveClass(/drop-before/);
    await expect.poll(() => page.evaluate(() => (window as any).calls)).toContain('solid');
    // Another run speaks for the desk: its station id (the element's key) changes.
    await page.evaluate(() => {
      const w = window as any;
      const c = w.fixture.sessions.find((s: any) => s.id === 'c');
      c.id = 'c2';
      c.nativeId = 'c2';
      w.fixture.version++;
      w.publish();
    });
    await expect(page.locator('[data-station-id="c2"]')).toHaveCount(1);
    await expect(page.locator('.drop-before, .drop-after, .is-desk-dragging')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).calls.filter((c: unknown) => typeof c === 'string').at(-1),
        ),
      )
      .toBe('through');
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await reorders(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).opens)).toEqual([]);
  });
}
