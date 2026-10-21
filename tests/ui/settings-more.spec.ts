import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { PILL_MARGIN } from '../../src/shared/dock-geometry';
import type { OfficeNotice, Preferences, Snapshot } from '../../src/shared/types';

// #228: more settings — the dock (tiny names, tiny dots, pill visibility and reset), reading on
// open, helper desks, and resetting the big office's panel widths.

const WIDTH = 1440;

/**
 * Three colleagues: run-0 has an unread final reply, run-1 calls the person, run-2 is quiet;
 * `helpers` hang off run-0. The desktop bridge saves preferences like the service (and pushes
 * the new snapshot to every subscriber, as the service broadcasts it to every window), records
 * receipts, and plays the main process for the dock.
 */
function office(opts: { helpers?: number; prefs?: Partial<Preferences> } = {}): Snapshot {
  const snapshot = demoSnapshot();
  const template = snapshot.sessions[0];
  const base = snapshot.notices![0];
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
        at: now - 60_000,
      },
    ],
    activity: undefined,
    actor: undefined,
    origin: undefined,
    relation: undefined,
    parentId: null,
  }));
  for (let i = 0; i < (opts.helpers ?? 0); i++)
    snapshot.sessions.push({
      ...snapshot.sessions[0],
      id: `run-0:helper-${i}`,
      nativeId: `run-0-helper-${i}`,
      alias: '',
      title: `보조 조사 ${i + 1}`,
      status: 'work',
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
  const notice = (id: string, sessionId: string, patch: Partial<OfficeNotice> = {}) => ({
    ...base,
    id,
    sessionId,
    eventId: id,
    kind: 'reply' as const,
    phase: 'final' as const,
    text: `${id} 결과`,
    at: now - 60_000,
    receivedAt: now - 60_000,
    version: 'v1',
    seenAt: null,
    viewedAt: null,
    dismissedAt: null,
    resolvedAt: null,
    bootstrap: false,
    ...patch,
  });
  snapshot.notices = [
    notice('final-0', 'run-0'),
    notice('call-1', 'run-1', { kind: 'attention', phase: undefined, at: now - 30_000 }),
  ];
  snapshot.preferences = { ...snapshot.preferences, privacy: false, locale: 'ko', ...opts.prefs };
  return snapshot;
}

async function bridge(
  page: Page,
  snapshot: Snapshot,
  init: { pill?: unknown; widths?: unknown } = {},
) {
  await page.setViewportSize({ width: WIDTH, height: 720 });
  await page.addInitScript(
    ({ s, init }) => {
      const w = window as any;
      w.fixture = s;
      w.receipts = [];
      w.saved = [];
      w.opens = [];
      w.listeners = [];
      // Per-test leftovers from an earlier session of this origin (first load only).
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        if (init.pill) localStorage.setItem('office:dock-pill:v1', JSON.stringify(init.pill));
        if (init.widths) localStorage.setItem('office:panel-widths', JSON.stringify(init.widths));
      }
      w.publish = () => {
        w.fixture = { ...w.fixture, version: (w.fixture.version ?? 0) + 1 };
        for (const cb of w.listeners) cb(structuredClone(w.fixture));
      };
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        terminals: async () => ({}),
        subscribe: (cb: any) => {
          w.listeners.push(cb);
          return () => {};
        },
        preferences: async (p: any) => {
          w.saved.push(p);
          w.fixture.preferences = { ...w.fixture.preferences, ...p };
          w.publish();
          return structuredClone(w.fixture);
        },
        notices: async (receipts: any[], action: string) => {
          w.receipts.push([action, receipts.map((r: any) => r.id)]);
          for (const n of w.fixture.notices)
            if (receipts.some((r) => r.id === n.id) && action === 'read') n.seenAt = Date.now();
          return structuredClone(w.fixture);
        },
        card: async (action: string, target: any) => {
          if (action === 'open') w.opens.push(target.id);
        },
        window: async () => {},
        settings: { open: async () => {}, onOpen: () => () => {} },
      };
      const state = { mode: 'row', tiny: false };
      w.dockCalls = [];
      w.office.dock = async (action: string) => {
        w.dockCalls.push(action);
        if (['row', 'floor', 'pet'].includes(action)) state.mode = action;
        else if (action === 'tiny-on' || action === 'tiny-off') state.tiny = action === 'tiny-on';
        else return;
        w.mode?.(state.mode, state.tiny);
      };
      w.office.onDock = (cb: any) => {
        w.mode = cb;
        return () => {};
      };
    },
    { s: snapshot, init },
  );
}
/** Another window (the settings window) changed a preference: the service pushes it here. */
const setPref = (page: Page, patch: Partial<Preferences>) =>
  page.evaluate((patch) => {
    const w = window as any;
    w.fixture.preferences = { ...w.fixture.preferences, ...patch };
    w.publish();
  }, patch);
const saved = (page: Page) => page.evaluate(() => (window as any).saved as Partial<Preferences>[]);
const receipts = (page: Page) =>
  page.evaluate(() => (window as any).receipts as [string, string[]][]);
const pill = (page: Page) => page.locator('.dock-pill');
const opacity = (page: Page) => pill(page).evaluate((el) => Number(getComputedStyle(el).opacity));
const dot = (page: Page, i: number) => page.locator(`[data-station-id="run-${i}"] .tiny-dot`);

async function openSettings(page: Page, category: string) {
  await page.goto('/?lang=ko');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page
    .getByRole('tablist', { name: '설정 분류' })
    .getByRole('tab', { name: category, exact: true })
    .click();
}

test('the settings page shows the new sections and saves each choice', async ({ page }) => {
  await bridge(page, office());
  await openSettings(page, '모습');
  const panel = page.getByRole('tabpanel');
  const dock = panel.locator('[data-guide-section="dock"]');
  await expect(dock.getByRole('heading', { name: '독' })).toBeVisible();
  await expect(dock.getByRole('switch', { name: '쪼꼬미 이름표 보이기' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(dock.getByRole('switch', { name: '쪼꼬미 점에 최종 응답도 표시' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const pillSelect = dock.getByLabel('독 버튼 모음(pill)');
  await expect(pillSelect).toHaveValue('subdued');
  await dock.screenshot({ path: '.local/settings-more-dock.png' });
  await dock.getByRole('switch', { name: '쪼꼬미 이름표 보이기' }).click();
  await dock.getByRole('switch', { name: '쪼꼬미 점에 최종 응답도 표시' }).click();
  await pillSelect.selectOption('hover');
  await expect(dock.getByRole('switch', { name: '쪼꼬미 이름표 보이기' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(
    panel.locator('[data-guide-section="panels"]').getByRole('heading', { name: '패널 폭' }),
  ).toBeVisible();
  await panel.locator('[data-guide-section="panels"]').screenshot({
    path: '.local/settings-more-panels.png',
  });
  expect(await saved(page)).toEqual([
    { tinyNames: false },
    { tinyFinalDot: false },
    { dockPill: 'hover' },
  ]);

  // 일반 → 읽음 처리.
  await page.getByRole('tab', { name: '일반', exact: true }).click();
  const reading = panel.locator('[data-guide-section="reading"]');
  await expect(reading.getByRole('heading', { name: '읽음 처리' })).toBeVisible();
  const dwell = reading.getByLabel('카드를 열고 읽음 처리까지 기다릴 시간');
  await expect(dwell).toHaveValue('1.5');
  await expect(dwell.locator('option')).toHaveText(['바로', '1.5초', '3초', '5초']);
  await reading.screenshot({ path: '.local/settings-more-reading.png' });
  const nowHint = reading.getByText('J/K로 동료를 넘겨 볼 때도 카드가 열리는 즉시 읽음 처리돼요.');
  await expect(nowHint).toHaveCount(0);
  await dwell.selectOption('0');
  // Right away: browsing with J/K reads each card it passes.
  await expect(nowHint).toBeVisible();
  await reading.getByRole('switch', { name: '카드를 열면 최종 응답 읽음 처리' }).click();
  // Off: the wait has nothing to wait for.
  await expect(dwell).toBeDisabled();
  await expect(nowHint).toHaveCount(0);

  // 사무실 → 보조 책상.
  await page.getByRole('tab', { name: '사무실', exact: true }).click();
  const helpers = panel.locator('[data-guide-section="helpers"]');
  await expect(helpers.getByRole('heading', { name: '보조 책상' })).toBeVisible();
  const stack = helpers.getByLabel('보조 책상을 하나로 묶는 인원');
  const retain = helpers.getByLabel('조용하지만 끝나지 않은 보조가 자리를 지키는 시간');
  await expect(stack).toHaveValue('4');
  await expect(stack.locator('option')).toHaveCount(7);
  await expect(retain).toHaveValue('30');
  await expect(retain.locator('option')).toHaveText(['10분', '30분', '60분', '120분']);
  await helpers.screenshot({ path: '.local/settings-more-helpers.png' });
  await stack.selectOption('2');
  await retain.selectOption('60');
  await helpers.getByRole('switch', { name: '보조 책상 보이기' }).click();
  await expect(stack).toBeDisabled();
  expect((await saved(page)).slice(3)).toEqual([
    { readDwellSeconds: 0 },
    { readOnOpen: false },
    { helperStackAt: 2 },
    { helperRetainMinutes: 60 },
    { helperDesks: false },
  ]);

  // The resets stamp the time; the dock and the big office (other renderers) hear it.
  await page.getByRole('tab', { name: '모습', exact: true }).click();
  const before = Date.now();
  await dock.getByRole('button', { name: 'pill 위치 초기화' }).click();
  await expect(page.getByText('독 pill을 오른쪽 끝으로 되돌렸어요.')).toBeVisible();
  await panel.getByRole('button', { name: '패널 폭 초기화' }).click();
  await expect(page.getByText('패널 폭을 기본으로 되돌렸어요.')).toBeVisible();
  const resets = (await saved(page)).slice(8);
  expect(resets[0].dockPillResetAt).toBeGreaterThanOrEqual(before);
  expect(resets[1].panelWidthsResetAt).toBeGreaterThanOrEqual(before);
});

test('the settings window deep-links to the dock section and shows it in English too', async ({
  page,
}) => {
  await bridge(page, office({ prefs: { locale: 'en' } }));
  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto('/?lang=en#settings=dock');
  const tabs = page.getByRole('tablist', { name: 'Settings categories' });
  await expect(tabs.getByRole('tab', { name: 'Appearance' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const dock = page.locator('[data-guide-section="dock"]');
  await expect(dock.getByRole('heading', { name: 'Dock' })).toBeInViewport();
  await expect(dock.getByLabel('Dock controls')).toHaveValue('subdued');
  await expect(dock.getByLabel('Dock controls').locator('option')).toHaveText([
    'Always clear',
    'Faint until hovered',
    'Only when the mouse is near',
  ]);
  await expect(page.getByRole('button', { name: 'Reset panel widths' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
  await page.screenshot({ path: '.local/settings-more-window-en.png' });
});

test('the browser preview has no dock settings, but keeps reading, helpers and panels', async ({
  page,
}) => {
  await page.goto('/?demo&lang=ko');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: '설정 분류' });
  await tabs.getByRole('tab', { name: '모습', exact: true }).click();
  await expect(page.locator('[data-guide-section="dock"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '패널 폭 초기화' })).toBeVisible();
  await tabs.getByRole('tab', { name: '일반', exact: true }).click();
  await expect(page.getByRole('switch', { name: '카드를 열면 최종 응답 읽음 처리' })).toBeVisible();
  await tabs.getByRole('tab', { name: '사무실', exact: true }).click();
  await expect(page.getByRole('switch', { name: '보조 책상 보이기' })).toBeVisible();
});

test('tiny names and final-reply dots follow their switches; call dots stay', async ({ page }) => {
  await bridge(page, office());
  await page.goto('/?lang=ko#mini=row&tiny');
  await expect(page.locator('.desk-row')).toHaveClass(/is-tiny/);
  await expect(page.locator('.tiny-name')).toHaveCount(3);
  await expect(dot(page, 0)).toHaveClass(/tone-reply/);
  await expect(dot(page, 1)).toHaveClass(/tone-attention/);

  await setPref(page, { tinyNames: false });
  await expect(page.locator('.tiny-name')).toHaveCount(0);
  // The name still shows on hover (the desk's title) and in its accessible name.
  await expect(page.locator('.office-pet[data-session-id="run-0"]')).toHaveAttribute(
    'title',
    '동료 0',
  );
  await setPref(page, { tinyFinalDot: false });
  await expect(dot(page, 0)).toHaveCount(0);
  await expect(dot(page, 1)).toHaveClass(/tone-attention/);
  await page.locator('.desk-row').screenshot({ path: '.local/settings-more-tiny-off.png' });

  await setPref(page, { tinyNames: true, tinyFinalDot: true });
  await expect(page.locator('.tiny-name')).toHaveCount(3);
  await expect(dot(page, 0)).toHaveClass(/tone-reply/);
});

test('pill visibility: always solid, subdued faint until hovered', async ({ page }) => {
  await bridge(page, office({ prefs: { dockPill: 'always' } }));
  await page.goto('/?lang=ko#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await page.mouse.move(10, 10);
  await expect.poll(() => opacity(page)).toBeGreaterThan(0.9);
  await expect(pill(page)).toHaveAttribute('data-solid', '');

  await setPref(page, { dockPill: 'subdued' });
  await expect.poll(() => opacity(page)).toBeLessThan(0.5);
  await expect(pill(page)).toHaveAttribute('data-solid', '');
  const b = (await pill(page).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect.poll(() => opacity(page)).toBeGreaterThan(0.9);
});

test('pill visibility hover: hidden and click-through until the pointer comes near', async ({
  page,
}) => {
  await bridge(page, office({ prefs: { dockPill: 'hover' } }));
  await page.goto('/?lang=ko#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await page.mouse.move(200, 200);
  await expect.poll(() => opacity(page)).toBe(0);
  // Hidden means not solid: the click-through dock lets the pointer reach what is behind it.
  await expect(pill(page)).not.toHaveAttribute('data-solid', /.*/);
  await expect(pill(page)).toHaveCSS('pointer-events', 'none');
  const b = (await pill(page).boundingBox())!;
  await page.locator('.desk-row').screenshot({ path: '.local/settings-more-pill-hidden.png' });

  // Near the pill (within reach, not on it yet): it comes up and takes the mouse.
  await page.mouse.move(b.x - 12, b.y + b.height / 2, { steps: 4 });
  await expect(pill(page)).toHaveClass(/is-revealed/);
  await expect(pill(page)).toHaveAttribute('data-solid', '');
  await expect.poll(() => opacity(page)).toBeGreaterThan(0.9);
  await page.locator('.desk-row').screenshot({ path: '.local/settings-more-pill-revealed.png' });
  // A button on it works once it is up.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 2 });
  await expect(pill(page)).toHaveClass(/is-revealed/);

  // Away again: hidden.
  await page.mouse.move(200, 200, { steps: 4 });
  await expect(pill(page)).not.toHaveClass(/is-revealed/);
  await expect.poll(() => opacity(page)).toBe(0);

  // The window's bottom strip brings it up from anywhere along the edge.
  await page.mouse.move(100, 718, { steps: 4 });
  await expect(pill(page)).toHaveClass(/is-revealed/);
  await page.mouse.move(200, 200, { steps: 4 });
  await expect(pill(page)).not.toHaveClass(/is-revealed/);

  // Keyboard focus shows it too.
  await page.getByRole('button', { name: '도구 막대 옮기기' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => opacity(page)).toBeGreaterThan(0.9);
});

test('pill visibility hover: a click right as the pill comes up lands on it', async ({ page }) => {
  await bridge(page, office({ prefs: { dockPill: 'hover' } }));
  await page.goto('/?lang=ko#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await page.mouse.move(200, 200);
  await expect.poll(() => opacity(page)).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as any).dockCalls.at(-1))).toBe('through');
  const floor = page.getByRole('button', { name: '바닥 책상으로 보기' });
  const b = (await floor.boundingBox())!;
  // Straight onto the hidden button: that one move was judged see-through (the pill still let
  // clicks through), so once the pill is up the dock must take the mouse with no further move.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect(pill(page)).toHaveClass(/is-revealed/);
  await expect.poll(() => page.evaluate(() => (window as any).dockCalls.at(-1))).toBe('solid');
  // Clicked without moving again: in the app the window now holds the click for the pill.
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).dockCalls)).toContain('floor');
  const calls: string[] = await page.evaluate(() => (window as any).dockCalls);
  const last = calls.lastIndexOf('floor');
  expect(calls.slice(0, last).at(-1)).toBe('solid');
});

test('pill reset from settings sends the pill home in the dock', async ({ page }) => {
  // The person parked the pill on the left earlier.
  await bridge(page, office(), { pill: { v: 1, x: 0.1, at: Date.now() - 60_000 } });
  await page.goto('/?lang=ko#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  const right = async () => {
    const b = (await pill(page).boundingBox())!;
    return Math.round(WIDTH - (b.x + b.width));
  };
  expect(await right()).toBeGreaterThan(400);
  // The settings window (another renderer) stamps the reset; the service pushes it here.
  await setPref(page, { dockPillResetAt: Date.now() });
  await expect.poll(right).toBe(PILL_MARGIN);
  expect(await page.evaluate(() => localStorage.getItem('office:dock-pill:v1'))).toBeNull();
  // A reload keeps it home; a stamp older than a newer drag does nothing.
  await page.reload();
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await expect.poll(right).toBe(PILL_MARGIN);
});

test('a stale pill spot saved before the reset stamp is forgotten on open', async ({ page }) => {
  await bridge(page, office({ prefs: { dockPillResetAt: Date.now() - 1000 } }), {
    pill: { v: 1, x: 0.1, at: Date.now() - 60_000 },
  });
  await page.goto('/?lang=ko#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await expect
    .poll(async () => {
      const b = (await pill(page).boundingBox())!;
      return Math.round(WIDTH - (b.x + b.width));
    })
    .toBe(PILL_MARGIN);
});

test('panel width reset puts the big office columns back', async ({ page }) => {
  await bridge(page, office(), { widths: { side: 340, at: Date.now() - 60_000 } });
  await page.goto('/?lang=ko');
  const menu = page.getByRole('complementary', { name: '주 메뉴' });
  await expect.poll(async () => (await menu.boundingBox())!.width).toBeGreaterThan(330);
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page.getByRole('tab', { name: '모습', exact: true }).click();
  await page.getByRole('button', { name: '패널 폭 초기화' }).click();
  await expect(page.getByText('패널 폭을 기본으로 되돌렸어요.')).toBeVisible();
  await expect.poll(async () => (await menu.boundingBox())!.width).toBeLessThan(240);
  await page.reload();
  await expect.poll(async () => (await menu.boundingBox())!.width).toBeLessThan(240);
});

test('reading off leaves replies unread; dwell 0 reads at once', async ({ page }) => {
  await bridge(page, office({ prefs: { readOnOpen: false } }));
  await page.goto('/?lang=ko');
  await page.locator('.office-pet[data-session-id="run-0"]').click();
  await expect(page.getByRole('complementary', { name: '동료의 업무 카드' })).toBeVisible();
  await page.waitForTimeout(2200);
  expect(await receipts(page)).toEqual([]);

  // Back on, at once: the card already open reads now, well before the usual 1.5 s.
  await setPref(page, { readOnOpen: true, readDwellSeconds: 0 });
  await expect.poll(() => receipts(page), { timeout: 600 }).toEqual([['read', ['final-0']]]);
});

test('the usual dwell waits before reading', async ({ page }) => {
  await bridge(page, office({ prefs: { readDwellSeconds: 3 } }));
  await page.goto('/?lang=ko');
  await page.locator('.office-pet[data-session-id="run-0"]').click();
  await page.waitForTimeout(2000);
  expect(await receipts(page)).toEqual([]);
  await expect.poll(() => receipts(page)).toEqual([['read', ['final-0']]]);
});

test('helper desks off hides them in the office and the row; the card still lists them', async ({
  page,
}) => {
  await bridge(page, office({ helpers: 2, prefs: { helperDesks: false } }));
  await page.goto('/?lang=ko');
  await expect(page.locator('.office-pet[data-session-id="run-0"]')).toBeVisible();
  await expect(page.locator('.helper-desk')).toHaveCount(0);
  await setPref(page, { helperDesks: true });
  await expect(page.locator('.helper-desk')).toHaveCount(2);
  await setPref(page, { helperDesks: false });
  await expect(page.locator('.helper-desk')).toHaveCount(0);
  // Still reachable from the colleague's card.
  await page.locator('.office-pet[data-session-id="run-0"]').click();
  const card = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await card.getByRole('tab', { name: '작업 정보' }).click();
  await expect(card.getByRole('heading', { name: '연결된 보조·분기 작업 2개' })).toBeVisible();

  // The dock (a new document: only the hash would not reload the page).
  await page.goto('/?lang=ko&dock#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await expect(page.locator('.desk-row .helper-desk')).toHaveCount(0);
  await setPref(page, { helperDesks: true });
  await expect(page.locator('.desk-row .helper-desk')).toHaveCount(2);
});

test('helper desks off still seats a helper that calls the person', async ({ page }) => {
  await bridge(page, office({ helpers: 2, prefs: { helperDesks: false } }));
  await page.goto('/?lang=ko#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await expect(page.locator('.desk-row .helper-desk')).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.sessions.find((s: any) => s.id === 'run-0:helper-0').status = 'call';
    w.publish();
  });
  // Nobody waiting for the person is hidden: the calling helper keeps its desk, the other not.
  await expect(page.locator('.desk-row .helper-desk')).toHaveCount(1);
});

test('stack threshold 2 stacks two helpers in the row and the office', async ({ page }) => {
  await bridge(page, office({ helpers: 2 }));
  await page.goto('/?lang=ko#mini=row');
  await expect(page.locator('.row-zone')).toHaveCount(2);
  await expect(page.locator('.desk-row .helper-stack')).toHaveCount(0);
  await expect(page.locator('.desk-row .helper-desk')).toHaveCount(2);
  await setPref(page, { helperStackAt: 2 });
  await expect(page.locator('.desk-row .helper-stack')).toHaveCount(1);
  await expect(page.locator('.desk-row .helper-stack-desk')).toHaveText(/×2/);
  await page.locator('.desk-row').screenshot({ path: '.local/settings-more-stack2.png' });

  // The big office (a fresh load starts from the fixture again: two separate desks).
  await page.goto('/?lang=ko');
  await expect(page.locator('.helper-desk')).toHaveCount(2);
  await setPref(page, { helperStackAt: 2 });
  await expect(page.locator('.helper-stack')).toHaveCount(1);
  await expect(page.locator('.helper-stack-desk')).toHaveText(/×2/);
});
