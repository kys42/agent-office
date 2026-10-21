import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { TINY_HEIGHT, TINY_SCALE } from '../../src/shared/dock-geometry';

/**
 * Three colleagues: run-0 has an unread final reply, run-1 is calling the person, run-2 is
 * quiet. `bridge` mocks the desktop main process (it owns tiny and answers through onDock);
 * without it the dock is a browser preview and switches locally.
 */
async function setup(
  page: Page,
  hash: string,
  opts: {
    bridge?: boolean;
    privacy?: boolean;
    helpers?: number;
    reply?: boolean;
    /** run-0 has been on one task for 35 minutes (full heat) and a request just reached it. */
    heat?: boolean;
    reducedMotion?: boolean;
  } = {
    bridge: true,
  },
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
  // run-0's helpers (from four they share one stacked desk); helper-2 calls the person.
  for (let i = 0; i < (opts.helpers ?? 0); i++)
    snapshot.sessions.push({
      ...snapshot.sessions[0],
      id: `run-0:helper-${i}`,
      nativeId: `run-0-helper-${i}`,
      alias: '',
      title: `보조 조사 ${i + 1}`,
      status: i === 2 ? 'call' : 'work',
      updatedAt: now - i * 1000,
      officeSeat: undefined,
      events: [],
      relation: {
        kind: 'subagent',
        parentNativeId: 'run-0',
        role: `조사 ${i + 1}`,
        source: 'demo',
      },
      parentId: 'run-0',
    });
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
  if (opts.heat) {
    Object.assign(snapshot.sessions[0], {
      status: 'work',
      observedStatus: 'work',
      runtime: { phase: 'working', at: now, evidence: 'observed', reason: 'fixture' },
      taskStartedAt: now - 35 * 60_000,
    });
    snapshot.notices.push(request('request-0', now));
  }
  snapshot.preferences.privacy = !!opts.privacy;
  snapshot.preferences.reducedMotion = !!opts.reducedMotion;
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.addInitScript(
    ({ s, bridge, reply }) => {
      const w = window as any;
      w.fixture = s;
      w.calls = [];
      w.opens = [];
      w.settingsOpened = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        // `reply`: every desk sits in a tmux pane that takes a reply.
        terminals: async (ids: string[]) =>
          reply
            ? Object.fromEntries(
                ids.map((id) => [
                  id,
                  { kind: 'tmux', label: 'work:1.0', status: 'idle', canSend: true },
                ]),
              )
            : {},
        ...(reply
          ? {
              terminalSend: async () => true,
              send: async () => ({ status: 'sent', message: '보냈어요' }),
            }
          : {}),
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
        window: async (action: string) => {
          w.calls.push(`window:${action}`);
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
        w.office.settings = {
          open: async (section?: string) => w.settingsOpened.push(section ?? null),
          onOpen: () => () => {},
        };
      }
    },
    { s: snapshot, bridge: !!opts.bridge, reply: !!opts.reply },
  );
  await page.goto(`/?lang=ko${hash}`);
  await expect(page.locator('.row-zone')).toHaveCount(2);
}
/** A request the person just sent to run-0 (it lands on the desk for 15 seconds). */
function request(id: string, at: number) {
  return {
    id,
    sessionId: 'run-0',
    eventId: `req-${id}`,
    kind: 'request' as const,
    text: '서류 더미 위로 날아온 요청이에요.',
    at,
    receivedAt: at,
    version: 'v1',
    seenAt: null,
    viewedAt: null,
    dismissedAt: null,
    resolvedAt: null,
    bootstrap: false,
  };
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
    await expect(row).toHaveCSS('height', `${TINY_HEIGHT}px`);
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

test('Tiny helper stack opens the front helper directly, no unreadable list', async ({ page }) => {
  await setup(page, '#mini=row&tiny', { bridge: true, helpers: 5 });
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  const stack = page.locator('.desk-row .helper-stack');
  await expect(stack).toHaveCount(1);
  const desk = stack.locator('.helper-stack-desk');
  await expect(desk).toHaveText(/×5/);
  // The front helper is the one calling; the name says the click opens its card.
  await expect(desk).toHaveAttribute('data-session-id', 'run-0:helper-2');
  await expect(desk).toHaveAttribute(
    'aria-label',
    /보조 동료 5명, 부르는 보조 있음 · .+ 업무 카드 열기/,
  );
  await expect(desk).not.toHaveAttribute('aria-expanded', /.*/);
  await desk.click();
  await expect.poll(() => page.evaluate(() => (window as any).opens)).toEqual(['run-0:helper-2']);
  await expect(page.locator('.helper-stack-list')).toHaveCount(0);

  // Full size keeps the roster list.
  await page.getByRole('button', { name: '크게 보기' }).click();
  await expect(page.locator('.desk-row')).not.toHaveClass(/is-tiny/);
  await desk.click();
  await expect(stack.getByRole('list', { name: '보조 동료 명단' })).toBeVisible();
  // A list left open folds away in tiny and does not come back with the full size.
  await page.getByRole('button', { name: '작게 보기' }).click();
  await expect(page.locator('.helper-stack-list')).toHaveCount(0);
  await page.getByRole('button', { name: '크게 보기' }).click();
  await expect(page.locator('.desk-row')).not.toHaveClass(/is-tiny/);
  await expect(page.locator('.helper-stack-list')).toHaveCount(0);
});

test('Focus follows the size toggle, and tiny desks say their dot', async ({ page }) => {
  await setup(page, '#mini=row');
  await page.getByRole('button', { name: '작게 보기' }).click();
  await expect(page.getByRole('button', { name: '크게 보기' })).toBeFocused();
  await expect(pet(page, 0)).toHaveAttribute('aria-label', /동료 0.*, 새 답장$/);
  await expect(pet(page, 1)).toHaveAttribute('aria-label', /동료 1.*, 호출$/);
  await expect(pet(page, 2)).toHaveAttribute('aria-label', /동료 2[^,]*$/);
  await expect(page.locator('.dock-pill .desk-row-summary em')).toContainText('기다리는 동료 1명');
  await page.getByRole('button', { name: '크게 보기' }).click();
  await expect(page.getByRole('button', { name: '작게 보기' })).toBeFocused();
});

test('An open reply or unfolded bubble closes in tiny; Esc there folds to the pet', async ({
  page,
}) => {
  await setup(page, '#mini=row', { bridge: true, reply: true });
  const bubble = page.locator('[data-station-id="run-0"] .speech-bubble');
  await bubble.hover();
  await bubble.locator('.bubble-reply').click();
  const input = page.getByRole('textbox', { name: '답장 내용' });
  await input.fill('쓰다 만 답장');
  await page.getByRole('button', { name: '작게 보기' }).click();
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  await expect(page.locator('.quick-reply')).toHaveCount(0);
  // Nothing hidden is left to fold: the first Esc folds the dock, as in the full size.
  await page.keyboard.press('Escape');
  await expect.poll(() => calls(page)).toContain('pet');
});

test('Back from tiny, a bubble unfolded before does not reopen', async ({ page }) => {
  await setup(page, '#mini=row');
  const bubble = page.locator('[data-station-id="run-0"] .speech-bubble');
  await bubble.click();
  await expect(bubble).toHaveClass(/is-expanded/);
  await page.getByRole('button', { name: '작게 보기' }).click();
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  await page.getByRole('button', { name: '크게 보기' }).click();
  await expect(page.locator('.desk-row')).not.toHaveClass(/is-tiny/);
  await expect(page.locator('.speech-bubble.is-expanded')).toHaveCount(0);
  // Esc folds the dock straight away (nothing open to fold first).
  await page.keyboard.press('Escape');
  await expect.poll(() => calls(page)).toContain('pet');
});

test('Tiny desks carry a small readable name that opens the card', async ({ page }) => {
  await setup(page, '#mini=row&tiny');
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  // run-2 gets a name far wider than its tiny desk.
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.sessions[2].alias = '아주아주 긴 이름을 가진 동료의 끝나지 않는 이름표';
    w.publish();
  });
  const name = (i: number) => page.locator(`[data-station-id="run-${i}"] .tiny-name`);
  await expect(name(0)).toHaveText('동료 0');
  await expect(name(1)).toHaveText('동료 1');
  await expect(name(0)).toHaveAttribute('title', '동료 0');
  // Drawn at real size inside the ×0.41 scene: at least 9px on screen, within the window.
  const chip = name(0).locator('span');
  const px = await chip.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(px * TINY_SCALE).toBeGreaterThanOrEqual(8.9);
  // Once the dock has slid in, the chip sits whole inside the tiny window.
  await expect
    .poll(async () => {
      const r = (await page.locator('.desk-row').boundingBox())!;
      return r.y + r.height;
    })
    .toBe(720);
  const row = (await page.locator('.desk-row').boundingBox())!;
  const box = (await chip.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(11);
  // The desks still stand on the window's bottom edge (the name does not lift them).
  const benches = page.locator('.desk-row .team-bench');
  expect(await benches.count()).toBeGreaterThan(0);
  const bench = (await benches.first().boundingBox())!;
  const legs = bench.y + bench.height;
  // Only the legs' 4-unit contact shadow lies under them, as before the names.
  expect(Math.abs(row.y + row.height - 4 * TINY_SCALE - legs)).toBeLessThanOrEqual(1);
  // The name rides on the desk's lower front: inside the desk's box, over its lower half.
  expect(box.y).toBeGreaterThanOrEqual(bench.y);
  expect(box.y + box.height).toBeLessThanOrEqual(legs + 0.5);
  expect(box.y + box.height / 2).toBeGreaterThan(bench.y + bench.height / 2);
  expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height);
  // Clear of the head's dot.
  const dot = (await page.locator('[data-station-id="run-0"] .tiny-dot').boundingBox())!;
  expect(box.y).toBeGreaterThan(dot.y + dot.height);
  // See-through at rest, solid while the desk is pointed at.
  const alpha = () =>
    chip.evaluate((el) => {
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/)!;
      const parts = m[1].split(',').map(Number);
      return parts.length > 3 ? parts[3] : 1;
    });
  const rest = await alpha();
  expect(rest).toBeLessThan(0.7);
  await page.screenshot({
    path: '.local/tiny-names-overlay.png',
    clip: { x: 0, y: row.y, width: 1440, height: row.height },
  });
  await page.locator('[data-station-id="run-0"] .office-pet').hover();
  await expect.poll(alpha).toBeGreaterThan(0.85);
  await page.screenshot({
    path: '.local/tiny-names-overlay-hover.png',
    clip: { x: 0, y: row.y, width: 1440, height: row.height },
  });
  await page.mouse.move(1, 1);
  await expect.poll(alpha).toBeLessThan(0.7);
  // The default pill (right end) leaves a small row's names uncovered.
  const pill = (await page.locator('.dock-pill').boundingBox())!;
  for (const i of [0, 1, 2]) {
    const b = (await name(i).locator('span').boundingBox())!;
    expect(b.x + b.width < pill.x || b.x > pill.x + pill.width).toBe(true);
  }

  // A long name stays on one line, as wide as its desk, and ends in an ellipsis.
  const long = name(2).locator('span');
  await expect(long).toHaveText(/아주아주 긴 이름/);
  await expect(long).toHaveCSS('text-overflow', 'ellipsis');
  await expect(long).toHaveCSS('white-space', 'nowrap');
  expect(await long.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const desk = (await page.locator('[data-station-id="run-2"] .office-pet').boundingBox())!;
  const lb = (await long.boundingBox())!;
  expect(lb.width).toBeLessThanOrEqual(164 * TINY_SCALE + 1);
  expect(Math.abs(lb.x + lb.width / 2 - (desk.x + desk.width / 2))).toBeLessThan(3);

  // Clicking the name opens the card, like the desk.
  await name(1).click();
  await expect.poll(() => page.evaluate(() => (window as any).opens)).toEqual(['run-1']);
});

test('Tiny names in privacy are the provider, with no hover name', async ({ page }) => {
  await setup(page, '#mini=floor&tiny', { bridge: true, privacy: true });
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  const name = page.locator('[data-station-id="run-0"] .tiny-name');
  await expect(name).toHaveText('Claude');
  await expect(name).not.toHaveAttribute('title', /.+/);
  await expect(page.locator('.tiny-name', { hasText: '동료' })).toHaveCount(0);
});

/** Waits for the tiny strip to finish sliding in and returns its box. */
async function settled(page: Page) {
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  await expect
    .poll(async () => {
      const r = (await page.locator('.desk-row').boundingBox())!;
      return Math.round(r.y + r.height);
    })
    .toBe(720);
  return (await page.locator('.desk-row').boundingBox())!;
}

test('Tiny keeps the desk effects, shrunk with the scene and whole inside the window', async ({
  page,
}) => {
  await setup(page, '#mini=row&tiny', { bridge: true, heat: true });
  const row = await settled(page);
  const desk = page.locator('[data-station-id="run-0"]');
  // The very same components as the full size: flames, sweat, embers, papers and the tag.
  await expect(desk).toHaveClass(/focus-level-3/);
  await expect(desk.locator('.fx-flames i')).toHaveCount(7);
  await expect(desk.locator('.fx-embers i')).toHaveCount(6);
  await expect(desk.locator('.fx-flames i').first()).toBeVisible();
  await expect(desk.locator('.paper-pile')).toBeVisible();
  await expect(desk.locator('.working-beacon')).toBeVisible();
  await expect(desk.locator('.working-beacon')).toContainText('불타는 중');
  // Drawn at the scene's scale (the 18px tag is about 7px here), not a tiny copy.
  const beacon = (await desk.locator('.working-beacon').boundingBox())!;
  expect(beacon.height).toBeLessThan(10);
  // A new request lands on the tiny desk too; keyed by the notice, so it plays again.
  await page.evaluate(() => {
    const w = window as any;
    const now = Date.now();
    const old = w.fixture.notices.find((n: any) => n.kind === 'request');
    w.fixture.notices.push({ ...old, id: 'request-1', eventId: 'req-1', at: now, receivedAt: now });
    w.publish();
  });
  await expect(desk.locator('.arrival-burst')).toBeVisible();
  await expect(desk.locator('.arrival-sheets i')).toHaveCount(4);
  // Nothing is clipped by the window's top while the papers fly in and the flames flicker.
  const top = row.y;
  for (let i = 0; i < 8; i++) {
    const tops = await desk.evaluate((el) =>
      [...el.querySelectorAll('.arrival-sheets i, .arrival-tag, .fx-flames i, .fx-steam i')]
        .filter((e) => parseFloat(getComputedStyle(e).opacity) > 0.05)
        .map((e) => e.getBoundingClientRect().top),
    );
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(top - 0.5);
    await page.waitForTimeout(120);
  }
  await expect(desk.locator('.arrival-tag')).toBeVisible();
  const tag = (await desk.locator('.arrival-tag').boundingBox())!;
  expect(tag.y).toBeGreaterThanOrEqual(top);
  // The dot and the name stay on top of every effect (painted over them).
  await page.addStyleTag({
    content: '.desk-row .desk-station * { pointer-events: auto !important; }',
  });
  const topmost = async (selector: string) => {
    const b = (await desk.locator(selector).boundingBox())!;
    return page.evaluate(
      ([x, y, sel]) =>
        !!document.elementFromPoint(x as number, y as number)?.closest(sel as string),
      [b.x + b.width / 2, b.y + b.height / 2, selector],
    );
  };
  expect(await topmost('.tiny-dot')).toBe(true);
  expect(await topmost('.tiny-name > span')).toBe(true);
  // The desks still stand on the window's bottom edge (the extra room is above them).
  const bench = (await page.locator('.desk-row .team-bench').first().boundingBox())!;
  expect(
    Math.abs(row.y + row.height - 4 * TINY_SCALE - (bench.y + bench.height)),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: '.local/tiny-effects.png',
    clip: { x: 0, y: row.y, width: 1440, height: row.height },
  });
});

test('Reduced motion holds the tiny effects still, like the full size', async ({ page }) => {
  await setup(page, '#mini=row&tiny', { bridge: true, heat: true, reducedMotion: true });
  await settled(page);
  const desk = page.locator('[data-station-id="run-0"]');
  await expect(desk.locator('.fx-flames i').first()).toBeVisible();
  await expect(desk.locator('.arrival-tag')).toBeVisible();
  await expect(desk.locator('.working-beacon')).toBeVisible();
  const running = await desk.evaluate((el) =>
    [
      ...el.querySelectorAll(
        '.focus-fx *, .paper-pile *, .arrival-burst *, .office-pet, .working-beacon',
      ),
    ]
      .map((e) => getComputedStyle(e).animationName)
      .filter((name) => name !== 'none'),
  );
  expect(running).toEqual([]);
  const glows = await desk.evaluate((el) =>
    [
      getComputedStyle(el.querySelector('.working-beacon')!, '::after').animationName,
      getComputedStyle(el.querySelector('.fx-flames')!, '::before').animationName,
    ].filter((name) => name !== 'none'),
  );
  expect(glows).toEqual([]);
});

test('The tiny pill carries settings, the office and folding to the pet', async ({ page }) => {
  await setup(page, '#mini=row');
  const pill = page.locator('.dock-pill');
  await pill.getByRole('button', { name: '작게 보기' }).click();
  const row = await settled(page);
  // The same buttons as the full pill, as small icons.
  for (const name of ['크게 보기', '사무실 펼치기', '책상 줄 접기', '설정', '데스크 펫 숨기기']) {
    const b = (await pill.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(b.width).toBeLessThanOrEqual(22.5);
    expect(b.height).toBeLessThanOrEqual(22.5);
  }
  await expect(pill.getByRole('button', { name: '설정', exact: true })).toHaveAttribute(
    'title',
    '설정 창 열기',
  );
  const p = (await pill.boundingBox())!;
  expect(p.height).toBeLessThan(30);
  expect(p.width).toBeLessThan(200);
  // At home (the right end) it covers none of the desks or their names.
  for (const i of [0, 1, 2])
    for (const sel of [
      `.office-pet[data-session-id="run-${i}"]`,
      `[data-station-id="run-${i}"] .tiny-name > span`,
    ]) {
      const b = (await page.locator(sel).boundingBox())!;
      expect(b.x + b.width < p.x || b.x > p.x + p.width).toBe(true);
    }
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.screenshot({
    path: '.local/tiny-pill-buttons.png',
    clip: { x: 1440 - 420, y: row.y, width: 420, height: row.height },
  });

  // Each calls what the full pill's button does.
  await pill.getByRole('button', { name: '설정', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).settingsOpened)).toEqual([null]);
  await pill.getByRole('button', { name: '사무실 펼치기', exact: true }).click();
  await expect.poll(() => calls(page)).toContain('window:main');
  await pill.getByRole('button', { name: '책상 줄 접기', exact: true }).click();
  await expect.poll(() => calls(page)).toContain('pet');
});

test('A browser preview has no settings in the tiny pill either', async ({ page }) => {
  await setup(page, '#mini=row&tiny', { bridge: false });
  await settled(page);
  const pill = page.locator('.dock-pill');
  await expect(pill.getByRole('button', { name: '사무실 펼치기', exact: true })).toBeVisible();
  await expect(pill.getByRole('button', { name: '설정', exact: true })).toHaveCount(0);
});

const zoneBar = (page: Page, i: number) => page.locator('.tiny-zone-bar').nth(i);
const zoneLeft = (page: Page, i: number) =>
  page
    .locator('.row-zone')
    .nth(i)
    .evaluate((el) => parseFloat((el as HTMLElement).style.left));
async function dragBar(page: Page, i: number, delta: number, keep = true) {
  const b = (await zoneBar(page, i).boundingBox())!;
  const x = b.x + b.width / 2,
    y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
  if (keep) await page.mouse.up();
}
/** A zone's saved spot: its left edge as a fraction of the room it can move through. */
const zoneSpot = (page: Page, i: number) =>
  page
    .locator('.row-zone')
    .nth(i)
    .evaluate((el) => {
      const zone = el as HTMLElement;
      const scene = zone.parentElement!;
      const room = parseFloat(scene.style.width) - parseFloat(zone.style.width);
      return parseFloat(zone.style.left) / room;
    });
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('Tiny zone bars move a zone, remember it and share it with the full size', async ({
  page,
}) => {
  await setup(page, '#mini=row&tiny');
  const row = await settled(page);
  // No tab or line over the heads any more: one thin bar per zone along the bottom.
  await expect(page.locator('.tiny-zone-handle, .tiny-zone-line')).toHaveCount(0);
  await expect(page.locator('.tiny-zone-bar')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '구역 옮기기 · team-a' })).toBeVisible();
  await page.screenshot({
    path: '.local/tiny-zone-bar.png',
    clip: { x: 0, y: row.y, width: 1440, height: row.height },
  });
  const before = await zoneLeft(page, 0);
  await dragBar(page, 0, 160, false);
  // Mid-drag the zone follows the pointer (in station units: 160px / 0.41).
  await expect.poll(() => zoneLeft(page, 0)).toBeGreaterThan(before + 300);
  await expect(page.locator('.row-zone').first()).toHaveClass(/is-arranging/);
  await page.mouse.up();
  await expect(page.locator('.row-zone').first()).not.toHaveClass(/is-arranging/);
  const moved = await zoneLeft(page, 0);
  expect(moved).toBeGreaterThan(before + 300);
  expect(await page.evaluate(() => (window as any).opens)).toEqual([]);
  const saved = await page.evaluate(() => localStorage.getItem('office:row-zones:v1:live'));
  expect(saved).not.toBeNull();

  await page.reload();
  await settled(page);
  await expect.poll(() => zoneLeft(page, 0)).toBeCloseTo(moved, 0);
  // The full size reads the same saved spots (shares of its narrower room, so a crowded
  // neighbour may nudge it), and leaves them as they were.
  await page.getByRole('button', { name: '크게 보기' }).click();
  await expect(page.locator('.desk-row')).not.toHaveClass(/is-tiny/);
  await expect(page.locator('.row-zone-handle')).toHaveCount(2);
  const shared = await zoneSpot(page, 0);
  expect(await page.evaluate(() => localStorage.getItem('office:row-zones:v1:live'))).toBe(saved);
  // It passed its neighbour in tiny, and stays past it here.
  expect(await zoneLeft(page, 0)).toBeGreaterThan(await zoneLeft(page, 1));
  // An untouched full-size row puts it well to the left of that.
  await page.evaluate(() => localStorage.removeItem('office:row-zones:v1:live'));
  await page.goto('/?lang=ko#mini=row');
  await page.reload();
  await expect(page.locator('.row-zone-handle')).toHaveCount(2);
  expect(await zoneSpot(page, 0)).toBeLessThan(shared - 0.1);
});

test('Tiny zone bars move with the keys, and Esc cancels a drag', async ({ page }) => {
  await setup(page, '#mini=row&tiny');
  await settled(page);
  const bar = zoneBar(page, 0);
  const start = await zoneLeft(page, 0);
  await bar.focus();
  // A clear focus ring around the thin bar.
  await expect(bar).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => zoneLeft(page, 0)).toBeCloseTo(start + 16, 0);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => zoneLeft(page, 0)).toBeCloseTo(start + 80, 0);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => zoneLeft(page, 0)).toBeCloseTo(start + 64, 0);
  await page.keyboard.press('Home');
  await expect.poll(() => zoneLeft(page, 0)).toBe(0);
  // The keys move the zone, not the row's pages; the bar keeps focus.
  await expect(bar).toBeFocused();
  const saved = await page.evaluate(() => localStorage.getItem('office:row-zones:v1:live'));
  expect(saved).not.toBeNull();

  const second = await zoneLeft(page, 1);
  await dragBar(page, 1, -120, false);
  await expect(page.locator('.row-zone').nth(1)).toHaveClass(/is-arranging/);
  await expect.poll(() => zoneLeft(page, 1)).not.toBe(second);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.row-zone').nth(1)).not.toHaveClass(/is-arranging/);
  expect(await zoneLeft(page, 1)).toBe(second);
  expect(await page.evaluate(() => localStorage.getItem('office:row-zones:v1:live'))).toBe(saved);
  // Esc ended the drag only: the dock stays tiny and unfolded.
  expect(await calls(page)).not.toContain('pet');
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
});

for (const mode of ['row', 'floor'] as const) {
  test(`Tiny ${mode} zone bars sit thin on the bottom edge, clear of names, dots and the pill`, async ({
    page,
  }) => {
    await setup(page, `#mini=${mode}&tiny`);
    const row = await settled(page);
    const bottom = row.y + row.height;
    const pill = (await page.locator('.dock-pill').boundingBox())!;
    const names = await page.locator('.tiny-name > span').all();
    const others = [...names, ...(await page.locator('.tiny-dot').all())];
    expect(names.length).toBe(3);
    expect(others.length).toBeGreaterThan(3);
    const hit = (x: number, y: number, selector: string) =>
      page.evaluate(([x, y, selector]) => !!document.elementFromPoint(x, y)?.closest(selector), [
        x,
        y,
        selector,
      ] as const);
    for (const i of [0, 1]) {
      const bar = (await zoneBar(page, i).boundingBox())!;
      const zone = (await page.locator('.row-zone').nth(i).boundingBox())!;
      // Real pixels inside the ×0.41 scene: a few px tall, on the window's bottom edge,
      // nearly as wide as the zone.
      expect(Math.abs(bar.y + bar.height - bottom)).toBeLessThanOrEqual(1);
      expect(bar.height).toBeLessThanOrEqual(5);
      expect(bar.height).toBeGreaterThanOrEqual(2);
      expect(bar.width).toBeGreaterThan(zone.width - 10);
      expect(overlaps(bar, pill)).toBe(false);
      for (const o of others) expect(overlaps(bar, (await o.boundingBox())!)).toBe(false);
      // The bar takes the pointer along its length (the desks' legs do not cover it)…
      for (const f of [0.1, 0.5, 0.9])
        expect(await hit(bar.x + bar.width * f, bottom - 1.5, '.tiny-zone-bar')).toBe(true);
    }
    // …but never over a name, which still opens its card.
    for (const n of names) {
      const b = (await n.boundingBox())!;
      for (const y of [b.y + 1, b.y + b.height / 2, b.y + b.height - 1])
        expect(await hit(b.x + b.width / 2, y, '.tiny-name')).toBe(true);
    }
    // The pill floats above the bars and desks.
    expect(await hit(pill.x + pill.width / 2, pill.y + pill.height / 2, '.dock-pill')).toBe(true);
    // A desk is still what a click on it reaches.
    const desk = (await pet(page, 0).boundingBox())!;
    expect(await hit(desk.x + desk.width / 2, desk.y + desk.height / 2, '.office-pet')).toBe(true);
    await pet(page, 0).click();
    await expect.poll(() => page.evaluate(() => (window as any).opens)).toEqual(['run-0']);
    await names[1].click();
    await expect.poll(() => page.evaluate(() => (window as any).opens)).toEqual(['run-0', 'run-1']);

    // Pointing at a bar thickens and brightens it, still clear of the names.
    const rest = (await zoneBar(page, 0).boundingBox())!;
    await page.mouse.move(rest.x + rest.width / 2, bottom - 1.5);
    await expect(zoneBar(page, 0)).toHaveCSS('opacity', '1');
    await expect
      .poll(async () => (await zoneBar(page, 0).boundingBox())!.height)
      .toBeGreaterThan(rest.height + 0.5);
    const hover = (await zoneBar(page, 0).boundingBox())!;
    expect(hover.height).toBeLessThanOrEqual(5);
    for (const o of others) expect(overlaps(hover, (await o.boundingBox())!)).toBe(false);
    if (mode === 'row')
      await page.screenshot({
        path: '.local/tiny-zone-bar-hover.png',
        clip: { x: 0, y: row.y, width: 1440, height: row.height },
      });
  });
}

test('Tiny zone bars in privacy name only the project', async ({ page }) => {
  await setup(page, '#mini=floor&tiny', { bridge: true, privacy: true });
  await settled(page);
  await expect(page.getByRole('button', { name: '구역 옮기기 · 프로젝트' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /team-a/ })).toHaveCount(0);
  await expect(zoneBar(page, 0)).not.toHaveAttribute('title', /team-a/);
});
