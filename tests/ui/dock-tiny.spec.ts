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
  opts: { bridge?: boolean; privacy?: boolean; helpers?: number; reply?: boolean } = {
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
  snapshot.preferences.privacy = !!opts.privacy;
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.addInitScript(
    ({ s, bridge, reply }) => {
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
    { s: snapshot, bridge: !!opts.bridge, reply: !!opts.reply },
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
  // Once the dock has slid in, the chip sits whole inside the 93px window.
  await expect
    .poll(async () => {
      const r = (await page.locator('.desk-row').boundingBox())!;
      return r.y + r.height;
    })
    .toBe(720);
  const row = (await page.locator('.desk-row').boundingBox())!;
  const box = (await chip.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(11);
  expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height);
  expect(box.y).toBeGreaterThan(row.y);
  // Under the desk, clear of the head's dot.
  const dot = (await page.locator('[data-station-id="run-0"] .tiny-dot').boundingBox())!;
  expect(box.y).toBeGreaterThan(dot.y + dot.height);
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
  await page.screenshot({
    path: '/private/tmp/claude-501/-Users-pepper-salt-orca-workspaces-agent-office-polyp/277772b0-7e3f-496f-8adf-6706f0d3a32f/scratchpad/shots/tiny-names.png',
    clip: { x: 0, y: row.y, width: 1440, height: row.height },
  });

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
