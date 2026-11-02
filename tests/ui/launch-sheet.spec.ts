import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

// The launch sheet (#319): one sheet for a new session, continuing and forking a conversation,
// opened by a project "+" and a work card. Desktop APIs are stubbed: nothing launches, no
// terminal, Orca or tmux is touched, no real records are read.
const ORCA_OFF = 'Orca가 실행 중이 아니에요. Orca를 연 뒤 다시 확인해주세요.';

async function setup(page: Page, route = '/', size?: { width: number; height: number }) {
  const s = demoSnapshot();
  for (const x of s.sessions) x.cwd = '/projects/' + x.project;
  const project = { cwd: '/projects/example', project: 'example', workspace: undefined };
  Object.assign(s.sessions[0], project, { alias: '개발 동료' });
  Object.assign(s.sessions[6], project, { alias: '라운지 리뷰어', provider: 'claude' });
  Object.assign(s.sessions[7], project, {
    alias: '보관된 기획자',
    provider: 'codex',
    archived: true,
    updatedAt: Date.now() - 2 * 86400_000,
  });
  s.sessions.push({
    ...structuredClone(s.sessions[7]),
    id: 'demo:claw',
    nativeId: 'demo-claw',
    alias: '오픈클로 동료',
    provider: 'openclaw',
    updatedAt: Date.now() - 3 * 86400_000,
  });
  if (size) await page.setViewportSize(size);
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.launches = [];
    w.optionCalls = [];
    w.returned = [];
    w.revealed = 0;
    w.jumps = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          w.copied = text;
        },
      },
    });
    localStorage.setItem('office:onboarding:v1:live', 'seen');
    const ids = ['orca', 'tmux', 'terminalApp', 'copy'];
    /** What the core would answer: probes, the remembered default, a fork's origin. */
    const options = (intent: any) => {
      const probes: Record<string, any> = {
        orca: { available: true, command: 'claude --resume x' },
        tmux: { available: true, command: 'tmux -L agent-office attach -t =office-claude' },
        terminalApp: { available: true, command: "cd '/projects/example' && claude" },
        copy: { available: true, command: "cd '/projects/example' && claude" },
        ...w.probes,
      };
      const destinations = ids.map((id) => ({ id, probe: probes[id] }));
      const ok = (id?: string) => destinations.find((d) => d.id === id && d.probe.available)?.id;
      const origin = intent.kind === 'fork' ? w.origin : undefined;
      return {
        destinations,
        default: ok(origin) ?? ok(w.remembered) ?? ok('orca') ?? ok('tmux') ?? null,
        ...(w.remembered && { remembered: w.remembered }),
        duplicate: w.duplicate?.[intent.kind] ?? { state: 'none' },
        ...(origin && { origin }),
      };
    };
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      detail: async (id: string) =>
        structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
      visit: async () => structuredClone(w.fixture),
      artifacts: async () => [],
      terminals: async () => w.terminals ?? {},
      subscribe: (cb: any) => {
        w.publish = cb;
        return () => {};
      },
      card: async () => ({ id: s.sessions[0].id, news: false }),
      onCard: () => () => {},
      cardState: async () => ({
        pinned: false,
        positionRemembered: false,
        target: { id: s.sessions[0].id, news: false },
      }),
      returnToOffice: async (id: string) => {
        w.returned.push(id);
        if (w.returnFails) {
          w.returnFails--;
          throw new Error('저장하지 못했어요');
        }
        const x = w.fixture.sessions.find((y: any) => y.id === id);
        Object.assign(x, { archived: false, returnedAt: Date.now(), zone: 'office' });
        return structuredClone(w.fixture);
      },
      launchOptions: async (intent: any) => {
        w.optionCalls.push(intent);
        if (w.holdOptions) await new Promise((resolve) => (w.releaseOptions = resolve));
        return options(intent);
      },
      launch: async (request: any) => {
        w.launches.push(request);
        if (request.action === 'open') {
          if (w.openError) throw new Error(w.openError);
          return {
            state: 'opened',
            destination: request.destination,
            message: '터미널에서 tmux 세션을 열었어요.',
          };
        }
        if (w.holdStart) await new Promise((resolve) => (w.releaseStart = resolve));
        const next = w.results?.shift() ?? {
          state: 'launched',
          message: '열었어요: ' + request.destination,
        };
        if (['launched', 'uncertain', 'running', 'copied'].includes(next.state))
          w.remembered = request.destination;
        if (next.after) Object.assign(w, next.after);
        return { destination: request.destination, ...next, after: undefined };
      },
      orcaReveal: async () => {
        w.revealed++;
      },
      dock: async (action: string) => {
        (w.dockActions ??= []).push(action);
      },
      jump: async (id: string) => {
        w.jumps.push(id);
        return w.jumpAction === 'copy'
          ? { action: 'copy', text: 'claude --resume x' }
          : { action: 'focused', text: 'Orca로 이동했어요' };
      },
      copyText: async (text: string) => {
        w.copied = text;
      },
    };
  }, s);
  await page.goto(route);
}

const set = (page: Page, values: Record<string, unknown>) =>
  page.evaluate((v) => Object.assign(window as any, v), values);
const read = (page: Page, key: string) => page.evaluate((k) => (window as any)[k], key);

async function openProject(page: Page) {
  if (await page.locator('.zone-flag-cloth').count())
    await page.locator('.zone-flag-cloth').first().hover();
  await page.getByRole('button', { name: '세션 시작', exact: true }).first().click();
  return page.getByRole('dialog', { name: '세션 시작' });
}
async function openCard(page: Page) {
  await page.getByRole('button', { name: '터미널에서 이어가기', exact: true }).click();
  return page.getByRole('dialog', { name: '세션 시작' });
}
const kind = (modal: ReturnType<Page['getByRole']>, name: string) =>
  modal.getByRole('group', { name: '무엇을' }).getByRole('button', { name, exact: true });
const destination = (modal: ReturnType<Page['getByRole']>, name: string) =>
  modal.getByRole('radio', { name: new RegExp('^' + name) });

test('a new session: agent, name and first message, started where it was chosen', async ({
  page,
}) => {
  await setup(page);
  const modal = await openProject(page);
  await expect(kind(modal, '새 세션')).toHaveAttribute('aria-pressed', 'true');
  await expect(destination(modal, 'Orca')).toBeChecked();
  await modal.getByRole('button', { name: 'Codex', exact: true }).click();
  await modal.getByLabel('에이전트 이름', { exact: true }).fill('리뷰 봇!');
  // The core's name rule, before anything is asked.
  await expect(
    modal.getByText('이름은 글자·숫자·공백·하이픈·밑줄로', { exact: false }),
  ).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Orca에서 시작' })).toBeDisabled();
  await modal.getByLabel('에이전트 이름', { exact: true }).fill('리뷰 봇');
  await modal.getByLabel('첫 메시지 (선택)', { exact: true }).fill('프로젝트를 살펴봐줘\n개선점도');
  await destination(modal, 'tmux').check();
  await set(page, { holdStart: true });
  await modal.getByRole('button', { name: 'tmux에서 시작' }).click();
  // ③ progress: opening, while main's confirmation is up.
  await expect(modal.getByText('여는 중', { exact: false })).toBeVisible();
  await page.screenshot({ path: '.local/launch-sheet-starting-light.png', animations: 'disabled' });
  await page.evaluate(() => (window as any).releaseStart());
  await expect(modal).toHaveCount(0);
  const launches = await read(page, 'launches');
  expect(launches[0]).toEqual({
    intent: {
      kind: 'new',
      at: 'demo:0',
      provider: 'codex',
      name: '리뷰 봇',
      initialMessage: '프로젝트를 살펴봐줘\n개선점도',
    },
    destination: 'tmux',
    action: 'start',
  });
  // tmux opens in a terminal right after it started (macOS), then says so.
  expect(launches[1]).toMatchObject({ destination: 'tmux', action: 'open' });
  await expect(page.getByText('터미널에서 tmux 세션을 열었어요.')).toBeVisible();
});

test('destinations say whether they can take it and why not; the last choice is the default', async ({
  page,
}) => {
  await setup(page);
  await set(page, {
    remembered: 'terminalApp',
    probes: { orca: { available: false, reason: ORCA_OFF } },
  });
  const modal = await openProject(page);
  await expect(destination(modal, 'Orca')).toBeDisabled();
  await expect(modal.locator('[data-destination="orca"]')).toContainText(ORCA_OFF);
  await expect(modal.locator('[data-destination="tmux"]')).toContainText('사용 가능');
  await expect(destination(modal, '터미널 앱')).toBeChecked();
  await expect(modal.locator('[data-destination="terminalApp"]')).toContainText('지난번 선택');
  await modal.getByRole('button', { name: '터미널 앱에서 시작' }).click();
  await expect(modal).toHaveCount(0);
  // Opened again: the core remembered it.
  await openProject(page);
  await expect(destination(modal, '터미널 앱')).toBeChecked();
  // Nowhere available: said so, nothing to start.
  await page.keyboard.press('Escape');
  await set(page, {
    probes: Object.fromEntries(
      ['orca', 'tmux', 'terminalApp', 'copy'].map((id) => [
        id,
        { available: false, reason: '사용할 수 없어요: ' + id },
      ]),
    ),
  });
  await openProject(page);
  await expect(modal.getByText('지금 이 컴퓨터에서 시작할 수 있는 곳이 없어요.')).toBeVisible();
  await expect(modal.locator('.launch-actions .primary')).toBeDisabled();
});

test('"+" lists the project\'s conversations with lounge and archive colleagues, and brings one back', async ({
  page,
}) => {
  await setup(page);
  const modal = await openProject(page);
  await kind(modal, '이어가기').click();
  const list = modal.getByRole('list', { name: '대화' });
  const rows = list.getByRole('button');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('개발 동료');
  await expect(rows.nth(0)).toContainText('사무실');
  await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.nth(1)).toContainText('라운지 리뷰어');
  await expect(rows.nth(1)).toContainText('대기');
  await expect(rows.nth(2)).toContainText('보관된 기획자');
  await expect(rows.nth(2)).toContainText('보관');
  await expect(rows.nth(3)).toBeDisabled();
  await expect(rows.nth(3)).toContainText('Claude·Codex 대화만 이어갈 수 있어요');
  await rows.nth(2).click();
  await expect(
    modal.getByText('터미널이 열리면 사무실로 데려와요', { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: '.local/launch-sheet-resume-list-light.png',
    animations: 'disabled',
  });
  // A cancelled confirmation leaves the colleague where it was.
  await set(page, { results: [{ state: 'cancelled' }] });
  await modal.getByRole('button', { name: 'Orca에서 시작' }).click();
  await expect(modal.getByRole('button', { name: 'Orca에서 시작' })).toBeEnabled();
  expect(await read(page, 'returned')).toEqual([]);
  await modal.getByRole('button', { name: 'Orca에서 시작' }).click();
  await expect(modal).toHaveCount(0);
  expect(await read(page, 'returned')).toEqual(['demo:7']);
  const launches = await read(page, 'launches');
  expect(launches.at(-1)).toEqual({
    intent: { kind: 'resume', session: 'demo:7' },
    destination: 'orca',
    action: 'start',
  });
});

test('a failed bring-back keeps the sheet and offers it again, never a relaunch', async ({
  page,
}) => {
  await setup(page, '/#mini=floor');
  await set(page, { returnFails: 1 });
  const modal = await openProject(page);
  await kind(modal, '이어가기').click();
  await modal.getByRole('button', { name: /라운지 리뷰어/ }).click();
  await modal.getByRole('button', { name: 'Orca에서 시작' }).click();
  const again = modal.getByRole('button', { name: '사무실로 다시 데려오기' });
  await again.click();
  await expect(modal).toHaveCount(0);
  expect(await read(page, 'returned')).toEqual(['demo:6', 'demo:6']);
  expect((await read(page, 'launches')).filter((l: any) => l.action === 'start')).toHaveLength(1);
});

test('a fork is prefilled with a valid name and starts where the original runs', async ({
  page,
}) => {
  await setup(page, '/#card', { width: 760, height: 900 });
  await set(page, {
    remembered: 'tmux',
    origin: 'orca',
    duplicate: { resume: { state: 'running', where: 'orca' } },
  });
  const modal = await openCard(page);
  // Continuing a running conversation: only going there.
  await expect(
    modal.getByText('이 대화는 이미 Orca에서 실행 중이에요', { exact: false }),
  ).toBeVisible();
  await expect(modal.getByRole('radio')).toHaveCount(0);
  await expect(modal.locator('.launch-actions button.primary')).toHaveText('그곳으로 이동');
  // Forking it is never blocked: another conversation in the same folder.
  await kind(modal, '복제해서 새로').click();
  await expect(modal.getByLabel('에이전트 이름', { exact: true })).toHaveValue('개발 동료 복제');
  await expect(destination(modal, 'Orca')).toBeChecked();
  await expect(modal.getByText('원래 대화가 지금 Orca에 있어', { exact: false })).toBeVisible();
  await modal.getByLabel('첫 메시지 (선택)', { exact: true }).fill('다른 방법으로 해보자');
  await page.screenshot({ path: '.local/launch-sheet-fork-light.png', animations: 'disabled' });
  await modal.getByRole('button', { name: 'Orca에서 시작' }).click();
  await expect(modal).toHaveCount(0);
  expect((await read(page, 'launches')).at(-1)).toEqual({
    intent: {
      kind: 'fork',
      session: 'demo:0',
      name: '개발 동료 복제',
      initialMessage: '다른 방법으로 해보자',
    },
    destination: 'orca',
    action: 'start',
  });
});

test('the card opens the sheet on its conversation; going there jumps to its terminal', async ({
  page,
}) => {
  await setup(page, '/#card', { width: 380, height: 480 });
  await set(page, { duplicate: { resume: { state: 'running', where: 'tmux' } } });
  const modal = await openCard(page);
  await expect(kind(modal, '이어가기')).toHaveAttribute('aria-pressed', 'true');
  await expect(modal.getByRole('group', { name: '대화' })).toContainText('개발 동료');
  await modal.getByRole('button', { name: '그곳으로 이동' }).click();
  await expect(modal).toHaveCount(0);
  expect(await read(page, 'jumps')).toEqual(['demo:0']);
});

test("the card's main action jumps when there is a terminal, and opens the sheet when not", async ({
  page,
}) => {
  await setup(page, '/#card', { width: 380, height: 480 });
  // No terminal: the main action is the sheet (copying stays one of its destinations).
  const actions = page.locator('.card-actions');
  await expect(actions.getByRole('button', { name: '터미널에서 이어가기' })).toHaveCount(1);
  await expect(actions.getByRole('button', { name: '재개 명령 복사' })).toHaveCount(0);
  const modal = await openCard(page);
  await destination(modal, '명령 복사').check();
  await set(page, {
    results: [{ state: 'copied', message: '명령을 복사했어요. 터미널에서 실행하세요.' }],
  });
  await modal.getByRole('button', { name: '명령 복사하기' }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByText('명령을 복사했어요. 터미널에서 실행하세요.')).toBeVisible();
});

test('remote colleagues never offer a local launch', async ({ page }) => {
  await setup(page, '/#card');
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.sessions[0].remote = {
      officeId: 'remote',
      sessionId: 'original',
      label: 'Remote',
      tags: [],
      receivedAt: Date.now(),
      stale: false,
      conversation: true,
      send: false,
    };
    w.fixture.version++;
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.locator('.card-actions')).toBeVisible();
  await expect(page.getByRole('button', { name: '터미널에서 이어가기' })).toHaveCount(0);
});

for (const where of ['orca', 'tmux'] as const)
  test(`an unconfirmed start in ${where} offers ${where === 'orca' ? 'only Open Orca' : 'nothing else'}, never another place`, async ({
    page,
  }) => {
    await setup(page, '/#card', { width: 760, height: 900 });
    await set(page, {
      results: [
        {
          state: 'uncertain',
          message:
            where === 'orca'
              ? 'Orca에 탭을 만들었지만 시작을 아직 확인하지 못했어요. Orca를 열면 시작돼요.'
              : '',
          after: { duplicate: { resume: { state: 'open', where, pending: true } } },
        },
      ],
    });
    const modal = await openCard(page);
    await destination(modal, where === 'orca' ? 'Orca' : 'tmux').check();
    await modal.locator('.launch-actions .primary').click();
    const text = where === 'orca' ? 'Orca를 열면 시작돼요' : 'tmux가 제때 답하지 않아';
    await expect(modal.getByText(text, { exact: false }).first()).toBeVisible();
    const buttons = modal.locator('.launch-actions-main button');
    if (where === 'orca') {
      await expect(buttons).toHaveCount(1);
      await expect(buttons).toHaveText('Orca 열기');
      await buttons.click();
      await expect.poll(() => read(page, 'revealed')).toBe(1);
    } else await expect(buttons).toHaveCount(0);
    await expect(modal.getByRole('alert')).toHaveCount(0);
    await page.screenshot({
      path: `.local/launch-sheet-uncertain-${where}-light.png`,
      animations: 'disabled',
    });
    // Reopened: main still holds it pending; no start is offered anywhere.
    await page.keyboard.press('Escape');
    await openCard(page);
    await expect(modal.getByRole('radio')).toHaveCount(0);
    await expect(modal.locator('.launch-actions-main button')).toHaveCount(
      where === 'orca' ? 1 : 0,
    );
  });

test('a refusal because it runs meanwhile offers going there', async ({ page }) => {
  await setup(page, '/#card', { width: 760, height: 900 });
  await set(page, {
    results: [
      {
        state: 'refused',
        reason: '이 대화가 이미 Orca에서 실행 중이라 새로 띄우지 않았어요. 터미널로 이동해주세요.',
        duplicate: { state: 'running', where: 'orca' },
        after: { duplicate: { resume: { state: 'running', where: 'orca' } } },
      },
    ],
  });
  const modal = await openCard(page);
  await modal.getByRole('button', { name: 'Orca에서 시작' }).click();
  await expect(modal.getByText('새로 띄우지 않았어요', { exact: false }).first()).toBeVisible();
  await expect(modal.locator('.launch-actions-main button')).toHaveText(['그곳으로 이동']);
  await modal.getByRole('button', { name: '그곳으로 이동' }).click();
  await expect(modal).toHaveCount(0);
  expect(await read(page, 'jumps')).toEqual(['demo:0']);
});

test('a refusal because the place failed its re-check suggests the other places', async ({
  page,
}) => {
  await setup(page, '/#card', { width: 760, height: 900 });
  await set(page, {
    results: [
      {
        state: 'refused',
        reason: ORCA_OFF,
        after: { probes: { orca: { available: false, reason: ORCA_OFF } } },
      },
    ],
  });
  const modal = await openCard(page);
  await modal.getByRole('button', { name: 'Orca에서 시작' }).click();
  await expect(modal.getByText('다른 곳에서 시작할 수 있어요', { exact: false })).toBeVisible();
  const buttons = modal.locator('.launch-actions-main button');
  await expect(buttons).toHaveText(['tmux에서 시작', '터미널 앱에서 시작', '명령 복사하기']);
  await expect(destination(modal, 'Orca')).toBeDisabled();
  await page.screenshot({ path: '.local/launch-sheet-refused-light.png', animations: 'disabled' });
  await modal.getByRole('button', { name: '터미널 앱에서 시작' }).click();
  await expect(modal).toHaveCount(0);
  expect((await read(page, 'launches')).at(-1)).toMatchObject({
    destination: 'terminalApp',
    action: 'start',
  });
});

test('its tmux session already running opens in a terminal, or its command is copied', async ({
  page,
}) => {
  await setup(page, '/#card', { width: 760, height: 900 });
  await set(page, {
    results: [
      {
        state: 'running',
        message: '이 tmux 세션이 이미 실행 중이에요. 터미널에서 열어주세요.',
        command: 'tmux -L agent-office attach -t =office-claude',
      },
    ],
    openError: '터미널을 열지 못했어요',
  });
  const modal = await openCard(page);
  await destination(modal, 'tmux').check();
  await modal.getByRole('button', { name: 'tmux에서 시작' }).click();
  await expect(modal.getByText('이미 실행 중이에요', { exact: false }).first()).toBeVisible();
  await modal.getByRole('button', { name: '터미널에서 열기' }).click();
  await expect(modal.getByRole('alert')).toHaveText('터미널을 열지 못했어요');
  await modal.getByRole('button', { name: '재접속 명령 복사' }).click();
  expect(await read(page, 'copied')).toBe('tmux -L agent-office attach -t =office-claude');
  await set(page, { openError: '' });
  await modal.getByRole('button', { name: '터미널에서 열기' }).click();
  await expect(modal).toHaveCount(0);
});

test('the tmux "open once started" choice can be turned off and is remembered', async ({
  page,
}) => {
  await setup(page, '/#card', { width: 760, height: 900 });
  const modal = await openCard(page);
  await destination(modal, 'tmux').check();
  const openAfter = modal.getByRole('checkbox', { name: '시작하면 터미널에서 열기' });
  await expect(openAfter).toBeChecked();
  await openAfter.uncheck();
  await modal.getByRole('button', { name: 'tmux에서 시작' }).click();
  await expect(modal).toHaveCount(0);
  expect((await read(page, 'launches')).map((l: any) => l.action)).toEqual(['start']);
  await openCard(page);
  await expect(openAfter).not.toBeChecked();
});

test('privacy closes the sheet and disables its entry points', async ({ page }) => {
  await setup(page, '/#card', { width: 760, height: 900 });
  const modal = await openCard(page);
  await expect(modal).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.preferences.privacy = true;
    w.fixture.version++;
    w.publish(structuredClone(w.fixture));
  });
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('button', { name: '터미널에서 이어가기' })).toBeDisabled();
});

test('the "+" is hidden while names and paths are hidden', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.preferences.privacy = true;
    w.fixture.version++;
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.getByRole('button', { name: '세션 시작', exact: true })).toHaveCount(0);
});

test('keyboard: the kinds, the conversation list and the destinations are reachable', async ({
  page,
}) => {
  await setup(page);
  const modal = await openProject(page);
  await kind(modal, '이어가기').focus();
  await page.keyboard.press('Enter');
  await expect(kind(modal, '이어가기')).toHaveAttribute('aria-pressed', 'true');
  await expect(destination(modal, 'Orca')).toBeChecked();
  await expect(destination(modal, 'Orca')).toBeEnabled();
  await destination(modal, 'Orca').focus();
  await page.keyboard.press('ArrowDown');
  await expect(destination(modal, 'tmux')).toBeChecked();
  await expect(destination(modal, 'tmux')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});

test('a project whose sessions changed never launches in a stale folder', async ({ page }) => {
  await setup(page, '/#mini=floor');
  const modal = await openProject(page);
  await page.evaluate(() => {
    const w = window as any;
    for (const s of w.fixture.sessions) s.id += '-replacement';
    w.fixture.version++;
    w.publish(structuredClone(w.fixture));
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).optionCalls.at(-1)?.at))
    .toBe('demo:0-replacement');
  await modal.getByRole('button', { name: 'Orca에서 시작' }).click();
  expect((await read(page, 'launches')).at(-1).intent.at).toBe('demo:0-replacement');
});

test('the dock makes room for the sheet', async ({ page }) => {
  await setup(page, '/#mini=floor');
  const modal = await openProject(page);
  await expect(modal).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).dockActions?.at(-1))).toBe('room-on');
  await page.keyboard.press('Escape');
  await expect
    .poll(() => page.evaluate(() => (window as any).dockActions?.at(-1)))
    .toBe('room-off');
});

for (const colorScheme of ['light', 'dark'] as const)
  test(`floor flag controls reveal on hover in ${colorScheme} and the pole is draggable`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await setup(page, '/#mini=floor');
    await page.setViewportSize({ width: 2400, height: 720 });
    await expect
      .poll(() => page.locator('.desk-row-lane').evaluate((el) => el.getBoundingClientRect().width))
      .toBeGreaterThan(2000);
    const zone = page.locator('.row-zone').first();
    const plus = zone.getByRole('button', { name: '세션 시작', exact: true });
    await expect(plus).toHaveCSS('opacity', '0');
    await expect(plus).toHaveCSS('pointer-events', 'none');
    await zone.locator('.zone-flag-cloth').hover();
    await expect(plus).toHaveCSS('opacity', '1');
    await expect(plus).toHaveCSS('background-color', 'rgb(34, 34, 34)');
    await expect(plus).toHaveCSS('color', 'rgb(255, 255, 255)');
    const hide = zone.locator('.zone-veil');
    await expect(hide).toBeVisible();
    await expect(hide).toHaveCSS('opacity', '1');
    await plus.hover();
    await hide.hover();
    await expect(plus).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0);
    await expect(plus).toHaveCSS('opacity', '0');
    await expect(hide).toHaveCSS('opacity', '0');
    await plus.focus();
    await expect(plus).toHaveCSS('opacity', '1');
    await plus.evaluate((el) => (el as HTMLElement).blur());
    const a = (await plus.boundingBox())!,
      b = (await hide.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
    const pole = zone.locator('.zone-flag-pole');
    const box = (await pole.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(15);
    const before = await zone.evaluate((el) => parseFloat((el as HTMLElement).style.left));
    await page.mouse.move(box.x + 2, box.y + box.height - 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 82, box.y + box.height - 30, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() => zone.evaluate((el) => parseFloat((el as HTMLElement).style.left)))
      .toBeGreaterThan(before);
  });

for (const colorScheme of ['light', 'dark'] as const)
  test(`each step draws with native controls in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await setup(page, '/', { width: 760, height: 900 });
    await set(page, {
      remembered: 'tmux',
      probes: {
        orca: {
          available: false,
          reason:
            '이 폴더는 Orca 작업 공간(/projects) 안의 하위 폴더예요. Orca는 작업 공간 폴더에서만 새 탭을 열 수 있어요. tmux로 띄워주세요.',
        },
      },
    });
    const modal = await openProject(page);
    await expect(destination(modal, 'tmux')).toBeChecked();
    await modal.getByLabel('첫 메시지 (선택)', { exact: true }).fill('프로젝트를 살펴봐줘');
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({
      path: `.local/launch-sheet-new-${colorScheme}.png`,
      animations: 'disabled',
    });
    await kind(modal, '이어가기').click();
    await expect(modal.getByText('tmux에서 시작할 준비가 됐어요')).toBeVisible();
    await page.screenshot({
      path: `.local/launch-sheet-resume-${colorScheme}.png`,
      animations: 'disabled',
    });
    await set(page, { holdOptions: true });
    await kind(modal, '복제해서 새로').click();
    await expect(
      modal.getByText('어디서 시작할 수 있는지 확인하는 중', { exact: false }),
    ).toBeVisible();
    await page.screenshot({
      path: `.local/launch-sheet-checking-${colorScheme}.png`,
      animations: 'disabled',
    });
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).releaseOptions))
      .toBe('function');
    await set(page, { holdOptions: false });
    await page.evaluate(() => (window as any).releaseOptions());
    await expect(modal.getByText('tmux에서 시작할 준비가 됐어요')).toBeVisible();
    // ③ opening, then a result that stays (its tmux session already runs).
    await set(page, {
      holdStart: true,
      results: [
        {
          state: 'running',
          message: '이 tmux 세션이 이미 실행 중이에요. 터미널에서 열어주세요.',
          command: 'tmux -L agent-office attach -t =office-claude',
        },
      ],
    });
    await modal.getByRole('button', { name: 'tmux에서 시작' }).click();
    await expect(modal.getByText('여는 중', { exact: false })).toBeVisible();
    await page.screenshot({
      path: `.local/launch-sheet-starting-${colorScheme}.png`,
      animations: 'disabled',
    });
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).releaseStart))
      .toBe('function');
    await page.evaluate(() => (window as any).releaseStart());
    await expect(modal.getByRole('button', { name: '터미널에서 열기' })).toBeVisible();
    await expect(modal.getByRole('radio')).toHaveCount(0);
    await page.screenshot({
      path: `.local/launch-sheet-result-${colorScheme}.png`,
      animations: 'disabled',
    });
  });

for (const colorScheme of ['light', 'dark'] as const)
  test(`the sheet fits a narrow card window in ${colorScheme}`, async ({ page }) => {
    // The footer stays on screen and nothing scrolls sideways.
    await page.emulateMedia({ colorScheme });
    await setup(page, '/#card', { width: 380, height: 480 });
    const modal = await openCard(page);
    await expect(modal.locator('[data-destination="orca"]')).toContainText('사용 가능');
    const box = (await modal.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(380);
    const footer = (await modal.locator('.launch-actions').boundingBox())!;
    expect(footer.y + footer.height).toBeLessThanOrEqual(480);
    expect(
      await modal.locator('.launch-sheet').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `.local/launch-sheet-card-narrow-${colorScheme}.png`,
      animations: 'disabled',
    });
  });
