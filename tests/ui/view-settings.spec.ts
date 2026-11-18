import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { OfficeNotice, Preferences, Snapshot, ViewSettings } from '../../src/shared/types';

// #324: Settings › 모습 › 화면별 표시 — one card per screen with a live preview, the main choices
// up front and the rest under '자세히'. Every choice defaults to the look from before.

/**
 * Three colleagues of one person: run-0 works on `feat/login` with an unread final reply, run-1
 * calls the person, run-2 works in another project. The desktop bridge saves preferences like
 * the service (views merge mode by mode) and pushes the new snapshot back.
 */
function office(prefs: Partial<Preferences> = {}): Snapshot {
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
    branch: 'feat/login',
    officeSeat: i,
    status: i === 1 ? 'call' : 'work',
    updatedAt: now,
    taskStartedAt: now - 40 * 60_000,
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
    actor: undefined,
    origin: undefined,
    relation: undefined,
    parentId: null,
  }));
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
  snapshot.preferences = { ...snapshot.preferences, privacy: false, locale: 'ko', ...prefs };
  return snapshot;
}

async function bridge(page: Page, snapshot: Snapshot, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.saved = [];
    w.opens = [];
    w.listeners = [];
    w.dockCalls = [];
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
        // A slow office: the answer comes back after the next click.
        if (w.slow) await new Promise((r) => setTimeout(r, 400));
        const prior = w.fixture.preferences.views ?? {};
        const views = p.views ? { ...prior } : undefined;
        for (const mode of Object.keys(p.views ?? {}))
          views[mode] = { ...prior[mode], ...p.views[mode] };
        w.fixture.preferences = { ...w.fixture.preferences, ...p, ...(views ? { views } : {}) };
        w.publish();
        return structuredClone(w.fixture);
      },
      notices: async () => structuredClone(w.fixture),
      card: async (action: string, target: any) => {
        if (action === 'open') w.opens.push(target.id);
      },
      window: async () => {},
      settings: { open: async () => {}, onOpen: () => () => {} },
      dock: async (action: string) => {
        w.dockCalls.push(action);
      },
      onDock: () => () => {},
    };
  }, snapshot);
}

const saved = (page: Page) => page.evaluate(() => (window as any).saved as Partial<Preferences>[]);
const card = (page: Page, name: string) => page.getByRole('article', { name, exact: true });
const preview = (page: Page, name: string) =>
  card(page, name).getByRole('img', { name: `${name} 미리보기` });

async function openLook(page: Page) {
  await page.goto('/?lang=ko');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page
    .getByRole('tablist', { name: '설정 분류' })
    .getByRole('tab', { name: '모습', exact: true })
    .click();
}

test('four cards, each with a preview and its main choices; 자세히 unfolds the rest', async ({
  page,
}) => {
  await bridge(page, office());
  await openLook(page);
  const section = page.locator('[data-guide-section="views"]');
  await expect(section.getByRole('heading', { name: '화면별 표시', exact: true })).toBeVisible();
  await expect(section.getByRole('article')).toHaveCount(4);
  for (const name of ['데스크 펫', '사무실 줄·바닥', '쪼꼬미', '큰 사무실'])
    await expect(preview(page, name)).toBeVisible();
  // The previews draw the real screens, from the person's own colleagues.
  await expect(preview(page, '데스크 펫').locator('.desk-pet')).toHaveCount(1);
  await expect(preview(page, '사무실 줄·바닥').locator('.desk-row:not(.is-tiny)')).toHaveCount(1);
  await expect(preview(page, '쪼꼬미').locator('.desk-row.is-tiny')).toHaveCount(1);
  await expect(preview(page, '큰 사무실').locator('.office-card')).toHaveCount(1);
  await expect(preview(page, '사무실 줄·바닥').getByText('동료 0')).toHaveCount(1);
  // Nothing in a preview takes focus or clicks.
  await expect(preview(page, '사무실 줄·바닥').locator('[inert]')).toHaveCount(1);

  // A clean first look: the main choices show, the finer ones wait under 자세히.
  const pet = card(page, '데스크 펫');
  await expect(pet.getByRole('switch', { name: '숫자 알약' })).toBeVisible();
  await expect(pet.getByRole('group', { name: '이름표' })).toBeVisible();
  await expect(pet.getByRole('switch', { name: '쓰다듬기' })).toBeHidden();
  await pet.getByText('자세히', { exact: true }).click();
  await expect(pet.getByRole('switch', { name: '쓰다듬기' })).toBeVisible();
  await expect(pet.getByRole('group', { name: '셀 항목' }).getByRole('button')).toHaveText([
    '나를 기다려요',
    '확인할 결과',
    '일하는 중',
    '대기 중',
  ]);
  const dock = card(page, '사무실 줄·바닥');
  await expect(dock.getByLabel('독 버튼 모음(pill)')).toBeVisible();
  await expect(dock.getByRole('switch', { name: '읽은 답변 말풍선 접기' })).toBeVisible();
  await expect(dock.getByRole('switch', { name: '브랜치 이름표' })).toBeHidden();
  const tiny = card(page, '쪼꼬미');
  await expect(tiny.getByRole('switch', { name: '쪼꼬미 이름표 보이기' })).toBeVisible();
  await expect(tiny.getByRole('switch', { name: '책상 효과' })).toBeHidden();
  const big = card(page, '큰 사무실');
  await expect(big.getByRole('switch', { name: '브랜치 이름표' })).toBeVisible();
  await expect(big.getByRole('switch', { name: '서류 더미' })).toBeHidden();
  // Every switch starts on: the look from before.
  for (const sw of await page.locator('[data-guide-section="views"] [role="switch"]').all())
    await expect(sw).toHaveAttribute('aria-checked', 'true');
  await page
    .locator('[data-guide-section="views"]')
    .screenshot({ path: '.local/view-settings.png' });
  expect(await saved(page)).toEqual([]);
});

test('a choice saves, and the preview follows it at once', async ({ page }) => {
  await bridge(page, office());
  await openLook(page);
  const big = card(page, '큰 사무실');
  await expect(preview(page, '큰 사무실').locator('.desk-branch')).toHaveCount(3);
  await big.getByRole('switch', { name: '브랜치 이름표' }).click();
  await expect(preview(page, '큰 사무실').locator('.desk-branch')).toHaveCount(0);
  await expect(big.getByRole('switch', { name: '브랜치 이름표' })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  const dock = card(page, '사무실 줄·바닥');
  await expect(preview(page, '사무실 줄·바닥').locator('.desk-branch')).toHaveCount(3);
  await dock.getByText('자세히', { exact: true }).click();
  await dock.getByRole('switch', { name: '브랜치 이름표' }).click();
  await expect(preview(page, '사무실 줄·바닥').locator('.desk-branch')).toHaveCount(0);
  // The big office keeps its own choice.
  await expect(preview(page, '큰 사무실').locator('.desk-branch')).toHaveCount(0);

  const pet = card(page, '데스크 펫');
  const petBox = preview(page, '데스크 펫');
  await expect(petBox.locator('.dock-pet-tally')).toHaveCount(1);
  await pet.getByRole('switch', { name: '숫자 알약' }).click();
  await expect(petBox.locator('.dock-pet-tally')).toHaveCount(0);
  await expect(petBox.locator('.dock-pet-pill')).toHaveCount(1);
  await pet.getByRole('switch', { name: '숫자 알약' }).click();
  await expect(petBox.locator('.dock-pet-tally .tally-working')).toHaveCount(1);
  await pet.getByText('자세히', { exact: true }).click();
  await pet
    .getByRole('group', { name: '셀 항목' })
    .getByRole('button', { name: '일하는 중' })
    .click();
  await expect(petBox.locator('.dock-pet-tally .tally-working')).toHaveCount(0);
  await expect(petBox.locator('.dock-pet-tally .tally-attention')).toHaveCount(1);
  await pet.getByRole('group', { name: '이름표' }).getByRole('button', { name: '항상' }).click();
  await expect(petBox.locator('.dock-pet-name')).toHaveCount(1);
  await pet.getByRole('switch', { name: '쓰다듬기' }).click();
  await expect(petBox.locator('.desk-pet.no-petting')).toHaveCount(1);

  const tiny = card(page, '쪼꼬미');
  await tiny.getByText('자세히', { exact: true }).click();
  await tiny.getByRole('switch', { name: '책상 효과' }).click();

  // The row's and tiny's pills count like the pet, the pet's groups included (one choice for
  // every pill: '일하는 중' was just left out); off, the old summary comes back.
  const dockBox = preview(page, '사무실 줄·바닥');
  await expect(dockBox.locator('.dock-pill .tally-attention')).toHaveCount(1);
  await expect(dockBox.locator('.dock-pill .tally-working')).toHaveCount(0);
  await dock.getByRole('switch', { name: '숫자 알약' }).click();
  await expect(dockBox.locator('.dock-pill .tally-pill')).toHaveCount(0);
  await expect(dockBox.locator('.desk-row-summary')).toContainText('3명');
  const tinyBox = preview(page, '쪼꼬미');
  await expect(tinyBox.locator('.dock-pill .tally-attention')).toHaveCount(1);
  await tiny.getByRole('switch', { name: '숫자 알약' }).click();
  await expect(tinyBox.locator('.dock-pill .tally-pill')).toHaveCount(0);
  await expect(tinyBox.locator('.desk-row-summary')).toContainText('3');

  // Each click saved its card's whole choice, so what is stored is everything just picked.
  expect(await saved(page)).toHaveLength(10);
  expect(await page.evaluate(() => (window as any).fixture.preferences.views)).toEqual({
    office: { branch: false },
    dock: { branch: false, tally: false },
    pet: {
      tally: true,
      tallyGroups: ['attention', 'results', 'standby'],
      name: 'always',
      petting: false,
    },
    tiny: { effects: false, tally: false },
  });
});

const chosen: ViewSettings = {
  pet: { tally: false, name: 'never', petting: false, turnEffect: false },
  dock: {
    branch: false,
    papers: false,
    beacon: false,
    focus: false,
    hideRead: false,
    tally: false,
  },
  tiny: { effects: false, tally: false },
  office: { branch: false, papers: false, beacon: false, focus: false },
};

test('the real dock and big office follow the saved choices; unset they look as before', async ({
  page,
}) => {
  // As before: branch tags, working lights and the numbers pill.
  await bridge(page, office());
  await page.goto('/?lang=ko#mini=row');
  await expect(page.locator('.desk-row .desk-branch')).toHaveCount(3);
  await expect(page.locator('.desk-row .working-beacon').first()).toBeAttached();
  await expect(page.locator('.dock-pill .tally-pill')).toHaveCount(1);
  await page.goto('/?lang=ko&pet#mini');
  await expect(page.locator('.dock-pet-tally')).toHaveCount(1);
  await expect(page.locator('.desk-pet.no-petting')).toHaveCount(0);
  await page.goto('/?lang=ko');
  await expect(page.locator('.office-card .desk-branch')).toHaveCount(3);
});

test('the real dock and big office drop what was turned off', async ({ page }) => {
  await bridge(page, office({ views: chosen }));
  await page.goto('/?lang=ko#mini=row');
  await expect(page.locator('.desk-row .desk-station')).toHaveCount(3);
  await expect(page.locator('.desk-row .desk-branch')).toHaveCount(0);
  await expect(page.locator('.desk-row .working-beacon')).toHaveCount(0);
  await expect(page.locator('.desk-row .paper-pile')).toHaveCount(0);
  await expect(page.locator('.desk-row .focus-fx')).toHaveCount(0);
  await expect(page.locator('.dock-pill .tally-pill')).toHaveCount(0);
  await expect(page.locator('.dock-pill .desk-row-summary')).toContainText('3명');
  await page.goto('/?lang=ko&pet#mini');
  await expect(page.locator('.desk-pet')).toBeVisible();
  await expect(page.locator('.dock-pet-tally')).toHaveCount(0);
  await expect(page.locator('.dock-pet-pill')).toHaveCount(1);
  await expect(page.locator('.desk-pet.no-petting')).toHaveCount(1);
  await page.locator('.desk-pet').hover();
  await expect(page.locator('.dock-pet-name')).toHaveCount(0);
  await page.goto('/?lang=ko');
  await expect(page.locator('.office-card .desk-station')).toHaveCount(3);
  await expect(page.locator('.office-card .desk-branch')).toHaveCount(0);
  await expect(page.locator('.office-card .working-beacon')).toHaveCount(0);
  await expect(page.locator('.office-card .paper-pile')).toHaveCount(0);
  await expect(page.locator('.office-card .focus-fx')).toHaveCount(0);
});

test('screen sharing masks the names in the previews too', async ({ page }) => {
  await bridge(page, office({ privacy: true }));
  await openLook(page);
  for (const name of ['사무실 줄·바닥', '큰 사무실']) {
    await expect(preview(page, name).locator('.desk-station')).not.toHaveCount(0);
    await expect(preview(page, name).getByText(/동료 \d/)).toHaveCount(0);
  }
});

test('an empty office previews the sample colleagues', async ({ page }) => {
  const empty = office();
  empty.sessions = [];
  empty.notices = [];
  await bridge(page, empty);
  await openLook(page);
  await expect(page.getByText('동료가 오기 전까지는 예시 동료로 보여 줘요.').first()).toBeVisible();
  await expect(preview(page, '큰 사무실').locator('.desk-station')).not.toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const)
  test(`the settings window at 390px keeps every card inside (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await bridge(page, office(), 390);
    await page.goto('/?lang=ko#settings=views');
    const section = page.locator('[data-guide-section="views"]');
    await expect(section).toBeInViewport();
    await expect(section.getByRole('article')).toHaveCount(4);
    for (const d of await section.locator('details').all()) await d.locator('summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    const wide = await section.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('.view-card *:not(.mode-preview-stage *)')]
        .filter((x) => x.getBoundingClientRect().right > el.getBoundingClientRect().right + 1)
        .map((x) => x.className),
    );
    expect(wide).toEqual([]);
    await page.screenshot({ path: `.local/view-settings-window-390-${theme}.png`, fullPage: true });
  });

for (const theme of ['light', 'dark'] as const)
  test(`the views section reads clean by default, on the page and in the window (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await bridge(page, office());
    await page.setViewportSize({ width: 1440, height: 2600 });
    await openLook(page);
    const section = page.locator('[data-guide-section="views"]');
    await expect(section.locator('.desk-station').first()).toBeVisible();
    // Nothing under 자세히 is open at first.
    for (const d of await section.locator('details').all())
      await expect(d).not.toHaveAttribute('open');
    await section.screenshot({ path: `.local/view-settings-page-${theme}.png` });
    await page.setViewportSize({ width: 720, height: 2600 });
    await page.goto('/?lang=ko&window#settings=views');
    await expect(section).toBeVisible();
    await expect(section.locator('.office-card .desk-station').first()).toBeVisible();
    await section.screenshot({ path: `.local/view-settings-window-${theme}.png` });
  });

test('quick clicks on the counted groups build on each other; the last group stays on', async ({
  page,
}) => {
  await bridge(page, office());
  await page.addInitScript(() => ((window as any).slow = true));
  await openLook(page);
  const pet = card(page, '데스크 펫');
  await pet.getByText('자세히', { exact: true }).click();
  const groups = pet.getByRole('group', { name: '셀 항목' });
  // Two clicks before the first answer is back: both stick.
  await groups.getByRole('button', { name: '확인할 결과' }).click();
  await groups.getByRole('button', { name: '대기' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.preferences.views?.pet?.tallyGroups))
    .toEqual(['attention', 'working']);
  await groups.getByRole('button', { name: '나를 기다려요' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.preferences.views?.pet?.tallyGroups))
    .toEqual(['working']);
  // The pill must count something: the last group cannot be turned off.
  await expect(groups.getByRole('button', { name: '일하는 중' })).toBeDisabled();
  // One choice for every numbers pill: with the pet's off, the row's still counts by it.
  await pet.getByRole('switch', { name: '숫자 알약' }).click();
  await expect(groups.getByRole('button', { name: '확인할 결과' })).toBeEnabled();
  await expect(pet.getByText('펫·줄·바닥·쪼꼬미 알약이 함께 쓰고')).toBeVisible();
  await pet.screenshot({ path: '.local/tally-settings-pet-groups.png' });
});

test('the row and tiny cards carry the numbers pill switch, on by default', async ({ page }) => {
  await bridge(page, office());
  await openLook(page);
  for (const name of ['사무실 줄·바닥', '쪼꼬미']) {
    const sw = card(page, name).getByRole('switch', { name: '숫자 알약' });
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(preview(page, name).locator('.dock-pill .tally-pill')).toHaveCount(1);
  }
  await card(page, '사무실 줄·바닥').screenshot({ path: '.local/tally-settings-dock.png' });
  await card(page, '쪼꼬미').screenshot({ path: '.local/tally-settings-tiny.png' });
});

test('counting only a group the pet is not showing still lets the arrows reach it', async ({
  page,
}) => {
  const snapshot = office({ views: { pet: { tallyGroups: ['working'] } } });
  // One at work, one calling (the pet shows the caller), one long resting; no news to read.
  Object.assign(snapshot.sessions[2], { status: 'idle', updatedAt: Date.now() - 5 * 3600_000 });
  snapshot.notices = [];
  await bridge(page, snapshot);
  await page.goto('/?lang=ko#mini');
  await page.locator('.dock-pet-anchor').hover();
  await page.getByRole('button', { name: '다음 동료' }).click();
  await expect(page.locator('.dock-pet-name')).toHaveText('동료 0');
});
