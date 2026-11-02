import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { Preferences, Snapshot } from '../../src/shared/types';

// #305: desks are dressed office-wide, per project zone and per colleague, and the office draws
// each desk from those layers (a colleague never changes the shared bench top).

/** run-0 and run-1 share team-a, run-2 sits alone in team-b. */
function office(): Snapshot {
  const snapshot = demoSnapshot();
  const template = snapshot.sessions[0];
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
    status: 'idle',
    updatedAt: now,
    activity: undefined,
    actor: undefined,
    origin: undefined,
    relation: undefined,
    parentId: null,
  }));
  snapshot.notices = [];
  snapshot.preferences = { ...snapshot.preferences, privacy: false, locale: 'ko' };
  return snapshot;
}

/** The desktop bridge: saves preferences like the service (merging the desk layers) and pushes. */
async function bridge(page: Page, snapshot: Snapshot) {
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.saved = [];
    w.listeners = [];
    w.publish = () => {
      w.fixture = { ...w.fixture, version: (w.fixture.version ?? 0) + 1 };
      for (const cb of w.listeners) cb(structuredClone(w.fixture));
    };
    const layers = (old: any = {}, patch: any = {}) => {
      const next = { ...old, ...patch };
      for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
      return next;
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
        w.saved.push(structuredClone(p));
        const prefs = w.fixture.preferences;
        const desks = prefs.deskAppearance ?? { version: 1, projects: {}, colleagues: {} };
        const deskAppearance = p.deskAppearance
          ? {
              version: 1,
              office:
                p.deskAppearance.office === undefined
                  ? desks.office
                  : (p.deskAppearance.office ?? undefined),
              projects: layers(desks.projects, p.deskAppearance.projects),
              colleagues: layers(desks.colleagues, p.deskAppearance.colleagues),
            }
          : prefs.deskAppearance;
        w.fixture.preferences = { ...prefs, ...p, deskAppearance };
        w.publish();
        return structuredClone(w.fixture);
      },
      notices: async () => structuredClone(w.fixture),
      card: async () => {},
      window: async () => {},
      settings: { open: async () => {}, onOpen: () => () => {} },
    };
  }, snapshot);
}
const saved = (page: Page) => page.evaluate(() => (window as any).saved as Partial<Preferences>[]);
const station = (page: Page, i: number) => page.locator(`[data-station-id="run-${i}"]`);
const equipment = (page: Page, i: number) => station(page, i).locator('.desk-equipment');
const chair = (page: Page, i: number) => station(page, i).locator('.office-chair');
const bench = (page: Page, project: string) =>
  page.locator(`[data-project-key*="${project}"] .team-bench`).first();

async function openDesks(page: Page) {
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page
    .getByRole('tablist', { name: '설정 분류' })
    .getByRole('tab', { name: '모습', exact: true })
    .click();
  await page.getByRole('button', { name: '책상 꾸미기' }).click();
  return page.getByRole('dialog', { name: '책상 꾸미기' });
}
async function backToOffice(page: Page) {
  await page.getByRole('button', { name: '우리 사무실', exact: true }).click();
}

test('desks start as today’s and follow office, project and colleague looks', async ({ page }) => {
  await bridge(page, office());
  await page.goto('/?lang=ko');
  // Nothing saved: today's desk — oak, the basic screen, the green chair and a cup.
  await expect(equipment(page, 0)).toHaveAttribute('data-desk-monitor', 'basic');
  await expect(equipment(page, 0)).toHaveAttribute('data-desk-items', 'none,cup');
  await expect(chair(page, 0)).toHaveAttribute('data-desk-chair', 'green');
  await expect(bench(page, 'team-a')).toHaveAttribute('data-desk-top', 'oak');
  await expect(equipment(page, 0).locator('.desk-screen')).toHaveCount(1);

  // The whole office.
  let dialog = await openDesks(page);
  await dialog.getByRole('button', { name: '상판 차콜' }).click();
  await dialog.getByRole('button', { name: '모니터 레트로 CRT' }).click();
  await dialog.getByRole('button', { name: '왼쪽 소품 화분' }).click();
  await dialog.getByRole('button', { name: '이 책상으로 저장' }).click();
  await expect(dialog).toBeHidden();
  expect((await saved(page)).at(-1)).toEqual({
    deskAppearance: {
      version: 1,
      office: { top: 'charcoal', monitor: 'crt', itemLeft: 'plant' },
      projects: {},
      colleagues: {},
    },
  });
  await expect(page.locator('.desk-settings-card')).toContainText('차콜 · 레트로 CRT');

  // One project: only what differs from the office is stored.
  dialog = page.getByRole('dialog', { name: '책상 꾸미기' });
  await page.getByRole('button', { name: '책상 꾸미기' }).click();
  await dialog
    .getByRole('group', { name: '적용 범위' })
    .getByRole('button', { name: '프로젝트' })
    .click();
  await dialog.getByRole('combobox', { name: '프로젝트' }).selectOption({ label: 'team-b' });
  await expect(dialog.getByRole('button', { name: '모니터 레트로 CRT' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: '의자 게이밍' }).click();
  await dialog.getByRole('button', { name: '상판 민트' }).click();
  await dialog.getByRole('button', { name: '이 책상으로 저장' }).click();
  await expect(dialog).toBeHidden();
  const project = (await saved(page)).at(-1)!.deskAppearance!;
  expect(Object.values(project.projects)).toEqual([{ top: 'mint', chair: 'gaming' }]);
  expect(project.office).toBeUndefined();

  await backToOffice(page);
  for (const i of [0, 1, 2])
    await expect(equipment(page, i)).toHaveAttribute('data-desk-monitor', 'crt');
  await expect(equipment(page, 0)).toHaveAttribute('data-desk-items', 'plant,cup');
  await expect(chair(page, 0)).toHaveAttribute('data-desk-chair', 'green');
  await expect(chair(page, 2)).toHaveAttribute('data-desk-chair', 'gaming');
  await expect(chair(page, 2)).toHaveCSS('background-image', /chair-gaming\.png/);
  await expect(equipment(page, 0).locator('.desk-monitor')).toHaveCSS(
    'background-image',
    /monitor-crt\.png/,
  );
  await expect(bench(page, 'team-a')).toHaveAttribute('data-desk-top', 'charcoal');
  await expect(bench(page, 'team-b')).toHaveAttribute('data-desk-top', 'mint');

  // One colleague, from the work card: the top stays the bench's.
  await station(page, 0).locator('.office-pet').click();
  await page.getByRole('button', { name: '카드 메뉴' }).click();
  await page.getByRole('menuitem', { name: '책상 꾸미기' }).click();
  await expect(
    dialog.getByRole('group', { name: '적용 범위' }).getByRole('button', { name: '이 동료' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: '상판 민트' })).toBeDisabled();
  await dialog.getByRole('button', { name: '모니터 듀얼' }).click();
  await dialog.getByRole('button', { name: '오른쪽 소품 러버덕' }).click();
  await dialog.getByRole('button', { name: '이 책상으로 저장' }).click();
  await expect(dialog).toBeHidden();
  expect((await saved(page)).at(-1)!.deskAppearance!.colleagues).toEqual({
    'run-0': { monitor: 'dual', itemRight: 'duck' },
  });
  await expect(equipment(page, 0)).toHaveAttribute('data-desk-monitor', 'dual');
  await expect(equipment(page, 0)).toHaveAttribute('data-desk-items', 'plant,duck');
  await expect(equipment(page, 0).locator('.desk-screen')).toHaveCount(2);
  await expect(equipment(page, 0).locator('.desk-item').last()).toHaveCSS(
    'background-image',
    /item-duck\.png/,
  );
  await expect(equipment(page, 1)).toHaveAttribute('data-desk-monitor', 'crt');
  await expect(bench(page, 'team-a')).toHaveAttribute('data-desk-top', 'charcoal');

  // Following the project again drops the colleague's own layer.
  await page.getByRole('button', { name: '카드 메뉴' }).click();
  await page.getByRole('menuitem', { name: '책상 꾸미기' }).click();
  await dialog.getByRole('button', { name: '프로젝트 모습 따르기' }).click();
  await expect(dialog).toBeHidden();
  expect((await saved(page)).at(-1)!.deskAppearance!.colleagues).toEqual({ 'run-0': null });
  await expect(equipment(page, 0)).toHaveAttribute('data-desk-monitor', 'crt');
});

test('the floor desk row draws the same customized desk', async ({ page }) => {
  const snapshot = office();
  snapshot.preferences.deskAppearance = {
    version: 1,
    office: { monitor: 'laptop', chair: 'navy', top: 'walnut' },
    projects: {},
    colleagues: { 'run-1': { itemLeft: 'lamp', itemRight: 'cat' } },
  };
  await bridge(page, snapshot);
  await page.goto('/?lang=ko#mini=floor');
  await expect(equipment(page, 0)).toHaveAttribute('data-desk-monitor', 'laptop');
  await expect(chair(page, 0)).toHaveCSS('background-image', /chair-navy\.png/);
  await expect(equipment(page, 1)).toHaveAttribute('data-desk-items', 'lamp,cat');
  await expect(page.locator('.desk-row .team-bench').first()).toHaveAttribute(
    'data-desk-top',
    'walnut',
  );
});
