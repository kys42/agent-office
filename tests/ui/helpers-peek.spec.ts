import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';
import type { Snapshot } from '../../src/shared/types';

/** demo:0 with `count` helpers; it stands by with one closed reply (no bubble of its own). */
function fixture(count: number): Snapshot {
  const snapshot = demoSnapshot();
  const host = snapshot.sessions.find((s) => s.id === 'demo:0')!;
  Object.assign(host, { status: 'ready', updatedAt: Date.now() - 10 * 60_000 });
  for (let i = 0; i < count; i++)
    snapshot.sessions.push({
      ...host,
      id: `demo:helper-${i}`,
      nativeId: `demo-helper-${i}`,
      alias: '',
      title: `보조 조사 ${i + 1}`,
      status: i === 2 ? 'call' : 'work',
      updatedAt: Date.now() - i * 1000,
      officeSeat: undefined,
      relation: {
        kind: 'subagent',
        parentNativeId: host.nativeId,
        role: `조사 ${i + 1}`,
        source: 'demo',
      },
      parentId: host.nativeId,
    });
  const at = Date.now() - 20 * 60_000;
  snapshot.notices = [
    {
      id: 'closed-reply',
      sessionId: 'demo:0',
      eventId: 'closed',
      kind: 'reply',
      phase: 'final',
      text: '어제 맡긴 정리를 끝내 두었어요.',
      at,
      receivedAt: at,
      version: 'v1',
      seenAt: null,
      viewedAt: null,
      dismissedAt: at + 60_000,
      resolvedAt: null,
      bootstrap: false,
    },
  ];
  return snapshot;
}
/** The desktop bridge, so selecting a helper opens it in the inspector. */
async function bridge(page: Page, snapshot: Snapshot) {
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      detail: async (id: string) =>
        structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
      visit: async () => structuredClone(w.fixture),
      artifacts: async () => [],
      subscribe: () => () => {},
      // Receipts apply like the service: closing a bubble records dismissedAt.
      notices: async (receipts: any[], action: string) => {
        w.fixture.notices = w.fixture.notices.map((n: any) =>
          action === 'dismiss' && receipts.some((r) => r.id === n.id && r.version === n.version)
            ? { ...n, dismissedAt: Date.now() }
            : n,
        );
        return structuredClone(w.fixture);
      },
    };
  }, snapshot);
}

test('Four or more helpers share one stacked desk whose list opens each of them', async ({
  page,
}) => {
  await bridge(page, fixture(5));
  await page.goto('/');
  const stack = page.locator('.helper-stack');
  await expect(stack).toHaveCount(1);
  await expect(page.locator('.helper-desk')).toHaveCount(1);
  await expect(stack.locator('.helper-stack-count')).toHaveText('×5');
  // The one calling sits in front and raises the flag.
  await expect(stack.locator('.helper-stack-desk')).toHaveAttribute(
    'data-session-id',
    'demo:helper-2',
  );
  await expect(stack.locator('.helper-stack-bang')).toBeVisible();
  // Every member resolves to this desk (e.g. bringing a selected helper into view).
  await expect(stack.locator('.helper-stack-desk')).toHaveAttribute(
    'data-members',
    'demo:helper-0 demo:helper-1 demo:helper-2 demo:helper-3 demo:helper-4',
  );
  await stack.locator('.helper-stack-desk').click();
  const list = stack.getByRole('list', { name: '보조 동료 명단' });
  await expect(list.getByRole('button')).toHaveCount(5);
  await list.getByRole('button', { name: /조사 4/ }).click();
  await expect(list).toHaveCount(0);
  await expect(page.locator('.inspector-heading h2')).toHaveText(/보조 조사 4/);
  await expect(stack.locator('.helper-stack-desk')).toHaveClass(/chosen/);
  // Escape closes only the list: the chosen helper stays open in the inspector.
  await stack.locator('.helper-stack-desk').click();
  await expect(list).toBeVisible();
  await expect(list.locator('[aria-current]')).toContainText('조사 4');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(page.locator('.inspector-heading h2')).toHaveText(/보조 조사 4/);
  await page.locator('.office-card').screenshot({ path: '.local/helper-stack-office.png' });
});

test('A stacked desk draws each helper in its own look', async ({ page }) => {
  const snapshot = fixture(5);
  snapshot.preferences.petAppearance = {
    version: 1,
    providers: {},
    colleagues: {
      'demo:helper-2': { character: 'slime', color: 'mint', accessory: 'crown' },
      'demo:helper-4': { character: 'devcat', color: 'peach', accessory: 'beret' },
    },
  };
  await bridge(page, snapshot);
  await page.goto('/');
  const stack = page.locator('.helper-stack');
  // The calling helper sits in front, in its own look.
  const lead = stack.locator('.helper-stack-desk .sprite-window');
  await expect(lead).toHaveAttribute('data-asset-id', 'pet.slime.v1');
  await expect(lead).toHaveAttribute('data-pet-color', 'mint');
  await stack.locator('.helper-stack-desk').click();
  const item = stack.locator('.helper-stack-list [data-session-id="demo:helper-4"] .sprite-window');
  await expect(item).toHaveAttribute('data-asset-id', 'pet.devcat.v1');
  await expect(item).toHaveAttribute('data-pet-accessory', 'beret');
});

test('Three helpers keep their own desks', async ({ page }) => {
  await bridge(page, fixture(3));
  await page.goto('/');
  await expect(page.locator('.helper-desk')).toHaveCount(3);
  await expect(page.locator('.helper-stack')).toHaveCount(0);
});

test('The row and floor stack helpers too, and the list opens the helper in the office', async ({
  page,
}) => {
  const snapshot = fixture(5);
  await page.route('**/api/rpc', (route) => route.fulfill({ json: { result: snapshot } }));
  for (const hash of ['#mini=row', '#mini=floor']) {
    await page.goto(`/${hash}`);
    await page.reload();
    const stack = page.locator('.desk-row .helper-stack');
    await expect(stack).toHaveCount(1);
    await expect(stack.locator('.helper-stack-count')).toHaveText('×5');
    await stack.locator('.helper-stack-desk').click();
    await expect(stack.getByRole('list', { name: '보조 동료 명단' })).toBeVisible();
    await expect(stack.locator('.helper-stack-list')).toHaveAttribute('data-solid');
    // Escape closes the list without folding the dock back into the pet.
    await page.keyboard.press('Escape');
    await expect(stack.locator('.helper-stack-list')).toHaveCount(0);
    await expect(page.locator('.desk-row')).toBeVisible();
    await stack.locator('.helper-stack-desk').click();
    await page.locator('.desk-row').screenshot({ path: `.local/helper-stack${hash.slice(5)}.png` });
  }
  await page
    .locator('.helper-stack-list')
    .getByRole('button', { name: /조사 1/ })
    .click();
  await expect(page).toHaveURL(/#session=demo%3Ahelper-0$/);
});

test('A closed bubble comes back while the desk is pointed at, and leaves with the cursor', async ({
  page,
}) => {
  await bridge(page, fixture(0));
  await page.goto('/');
  const desk = page.locator('.desk-station[data-station-id="demo:0"]');
  await expect(desk).toBeVisible();
  await expect(desk.locator('.speech-bubble')).toHaveCount(0);
  await desk.locator('.office-pet').hover();
  const peek = desk.locator('.speech-bubble.is-peek');
  await expect(peek).toContainText('어제 맡긴 정리를 끝내 두었어요.');
  await expect(peek).toContainText('지난 말풍선');
  await expect(peek.locator('.bubble-dismiss')).toHaveCount(0);
  // Moving onto the bubble keeps it (the whole desk is what is pointed at).
  await peek.hover();
  await expect(peek).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(desk.locator('.speech-bubble')).toHaveCount(0);
});

test('The row peeks the closed bubble on hover too', async ({ page }) => {
  const snapshot = fixture(0);
  await page.route('**/api/rpc', (route) => route.fulfill({ json: { result: snapshot } }));
  await page.goto('/#mini=row');
  await page.reload();
  const desk = page.locator('.desk-station[data-station-id="demo:0"]');
  await expect(desk).toBeVisible();
  await expect(desk.locator('.speech-bubble')).toHaveCount(0);
  // Crossing the desk's see-through top (where the bubble would grow) peeks nothing…
  const box = (await desk.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.waitForTimeout(150);
  await expect(desk.locator('.speech-bubble')).toHaveCount(0);
  // …only something drawn does.
  await desk.locator('.office-pet').hover();
  await expect(desk.locator('.speech-bubble.is-peek')).toContainText('어제 맡긴 정리');
  await page.mouse.move(5, 5);
  await expect(desk.locator('.speech-bubble')).toHaveCount(0);
});

test('Closing a bubble does not bring it straight back; it peeks again once the cursor returns', async ({
  page,
}) => {
  const snapshot = fixture(0);
  Object.assign(snapshot.notices![0], {
    dismissedAt: null,
    at: Date.now(),
    receivedAt: Date.now(),
  });
  await bridge(page, snapshot);
  await page.goto('/');
  const desk = page.locator('.desk-station[data-station-id="demo:0"]');
  const bubble = desk.locator('.speech-bubble');
  await expect(bubble).toContainText('어제 맡긴 정리');
  await expect(bubble).not.toHaveClass(/is-peek/);
  await bubble.locator('.bubble-dismiss').click();
  // The cursor is still on the desk: the closed bubble stays closed.
  await expect(bubble).toHaveCount(0);
  await page.mouse.move(5, 5);
  await desk.locator('.office-pet').hover();
  await expect(desk.locator('.speech-bubble.is-peek')).toContainText('어제 맡긴 정리');
});

/** demo:0 answered a request the person sent five minutes ago (the reply bubble is up). */
function answered(prefs: Record<string, unknown> = {}): Snapshot {
  const snapshot = fixture(0);
  const now = Date.now();
  snapshot.preferences = { ...snapshot.preferences, ...prefs };
  snapshot.notices = [
    {
      id: 'asked',
      sessionId: 'demo:0',
      eventId: 'asked',
      kind: 'request',
      text: '로그인 화면 여백을 다듬어 줘',
      at: now - 5 * 60_000,
      receivedAt: now - 5 * 60_000,
      version: 'v1',
      seenAt: null,
      viewedAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
    },
    {
      ...snapshot.notices![0],
      id: 'answer',
      eventId: 'answer',
      text: '여백을 8px로 맞췄어요. 버튼 색도 브랜드 컬러로 바꾸고, 바뀐 화면은 스크린샷으로 남겼어요. 다음으로 어두운 모드도 확인해 둘게요.',
      at: now - 60_000,
      receivedAt: now - 60_000,
      dismissedAt: null,
    },
  ];
  return snapshot;
}

test('Pointing at a desk quotes what the person asked, only while pointed at', async ({ page }) => {
  await bridge(page, answered());
  await page.goto('/');
  const desk = page.locator('.desk-station[data-station-id="demo:0"]');
  const bubble = desk.locator('.speech-bubble');
  await expect(bubble).toContainText('여백을 8px로 맞췄어요.');
  await expect(bubble.locator('.speech-request')).toHaveCount(0);
  await desk.locator('.office-pet').hover();
  await expect(bubble.locator('.speech-request')).toContainText('내 요청');
  await expect(bubble.locator('.speech-request')).toContainText('로그인 화면 여백을 다듬어 줘');
  // Unfolded on a first-row desk, the quote and the answer stay inside the office map.
  await bubble.getByRole('button', { name: '말풍선 전체 보기' }).click();
  const map = (await page.locator('.office-map').boundingBox())!;
  expect((await bubble.boundingBox())!.y).toBeGreaterThanOrEqual(map.y);
  await page.mouse.move(5, 5);
  await expect(bubble).toBeVisible();
  await expect(bubble.locator('.speech-request')).toHaveCount(0);
});

test('The pet quotes the request only while hovered', async ({ page }) => {
  const snapshot = answered();
  await page.route('**/api/rpc', (route) => route.fulfill({ json: { result: snapshot } }));
  await page.goto('/#mini');
  await page.reload();
  const speech = page.locator('.dock-pet-speech');
  await expect(speech).toContainText('여백을 8px로 맞췄어요.');
  await expect(speech.locator('.speech-request')).toBeHidden();
  await page.locator('.dock-pet-anchor').hover();
  await expect(speech.locator('.speech-request')).toBeVisible();
  await expect(speech.locator('.speech-request')).toContainText('로그인 화면 여백을 다듬어 줘');
  // The hovered bubble, quote included, stays inside the pet window.
  const stage = (await page.locator('.desk-pet-stage').boundingBox())!;
  expect((await speech.locator('.speech-bubble').boundingBox())!.y).toBeGreaterThanOrEqual(stage.y);
});

test('The row quotes the request when its desk is pointed at, and screen sharing hides it', async ({
  page,
}) => {
  for (const privacy of [false, true]) {
    const snapshot = answered({ privacy });
    await page.unroute('**/api/rpc');
    await page.route('**/api/rpc', (route) => route.fulfill({ json: { result: snapshot } }));
    await page.goto('/#mini=row');
    await page.reload();
    const desk = page.locator('.desk-station[data-station-id="demo:0"]');
    await expect(desk.locator('.speech-bubble')).toBeVisible();
    await expect(desk.locator('.speech-request')).toHaveCount(0);
    await desk.locator('.office-pet').hover();
    const quote = desk.locator('.speech-request');
    await expect(quote).toBeVisible();
    if (privacy) await expect(quote).not.toContainText('로그인 화면');
    else await expect(quote).toContainText('로그인 화면 여백을 다듬어 줘');
    await page.mouse.move(5, 5);
  }
});
