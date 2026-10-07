import { test, expect } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

test('Public progress leads office, roster and inspector while tool names stay secondary', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  fixture.sessions[0].activity = {
    text: '로그인 오류를 재현하고 원인을 확인하고 있어요.',
    kind: 'progress',
    at: Date.now(),
    tool: { name: 'exec', at: Date.now() },
  };
  fixture.sessions[0].action = fixture.sessions[0].activity.text;
  fixture.notices = [];
  await page.addInitScript((s) => {
    (window as any).office = {
      snapshot: async () => structuredClone(s),
      detail: async (id: string) => structuredClone(s.sessions.find((x) => x.id === id)),
      visit: async () => structuredClone(s),
      preferences: async (patch: object) => {
        Object.assign(s.preferences, patch);
        return structuredClone(s);
      },
      artifacts: async () => [],
      subscribe: () => () => {},
    };
  }, fixture);
  await page.goto('/');
  const bubble = page.locator('.speech-bubble').filter({ hasText: '로그인 오류를 재현' });
  await expect(bubble.locator('b')).toHaveText('로그인 오류를 재현하고 원인을 확인하고 있어요.');
  await expect(bubble.locator('em')).toContainText('터미널');
  await expect(page.locator('.session-row').filter({ hasText: '코코' })).toContainText(
    '로그인 오류를 재현',
  );
  await bubble.click();
  await expect(page.locator('.progress-summary p')).toHaveText(
    '로그인 오류를 재현하고 원인을 확인하고 있어요.',
  );
  await expect(page.locator('.activity-tool')).toContainText('최근 도구 · 터미널');
  await page.getByRole('button', { name: '업무 카드 닫기' }).click();
  await page.getByRole('button', { name: '화면 내용 숨기기' }).click();
  await expect(page.locator('.speech-bubble')).not.toContainText(['로그인 오류를 재현']);
});

test('Live events arrive while expanded messages and unsaved notes survive snapshots', async ({
  page,
}) => {
  const snapshot = demoSnapshot();
  await page.addInitScript((fixture) => {
    const w = window as any;
    w.fixture = fixture;
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      detail: async (id: string) => {
        if (w.failDetail) throw new Error('일시적인 연결 오류');
        return structuredClone(w.fixture.sessions.find((s: any) => s.id === id));
      },
      visit: async () => structuredClone(w.fixture),
      artifacts: async () => [],
      subscribe: (cb: any) => {
        w.publish = cb;
        return () => {};
      },
    };
  }, snapshot);
  await page.goto('/');
  await page.getByRole('button', { name: '코코, 일하는 중', exact: true }).click();
  const more = page.locator('.message-assistant .message-expand');
  await more.click();
  await page.evaluate(() => {
    const w = window as any;
    w.failDetail = true;
    w.fixture.sessions[0].revision = 'update-2';
    w.fixture.sessions[0].events = [
      {
        id: 'live-2',
        at: Date.now(),
        kind: 'assistant',
        text: '실시간으로 도착한 새 응답',
        sourceRef: 'fixture',
      },
    ];
    w.publish(structuredClone(w.fixture));
  });
  await expect(
    page.locator('.conversation').getByText('실시간으로 도착한 새 응답', { exact: true }),
  ).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('tab', { name: '기억 메모' }).click();
  await page.getByLabel('업무 메모').fill('저장 전에도 유지되어야 하는 메모');
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.sessions[0].revision = 'update-3';
    w.fixture.sessions[0].notes = '서버에 저장된 메모';
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.getByLabel('업무 메모')).toHaveValue('저장 전에도 유지되어야 하는 메모');
});
test('Office, editable alias, notes, handoff and keyboard dismissal', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?demo');
  await expect(page.locator('.office-pet')).toHaveCount(6);
  await page.getByRole('button', { name: '코코, 일하는 중', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: '이름 바꾸기' }).click();
  await page.getByLabel('새 별명').fill('우리 코코');
  await page.getByRole('button', { name: '별명 저장' }).click();
  await expect(panel.getByRole('heading', { name: '우리 코코' })).toBeVisible();
  await page.getByRole('tab', { name: '기억 메모' }).click();
  await page.getByLabel('업무 메모').fill('다음 작업에서 캐시 만료 확인');
  await page.getByRole('button', { name: '메모 저장', exact: true }).click();
  await page.getByRole('button', { name: '인수인계 꾸리기' }).click();
  await expect(page.getByRole('dialog', { name: '다음 동료에게 건네는 기록' })).toBeVisible();
  await expect(page.getByLabel('인수인계 내용')).toContainText('다음 작업에서 캐시 만료 확인');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '다음 동료에게 건네는 기록' })).toBeHidden();
  expect(errors).toEqual([]);
});
test('Memory search, provider filters and privacy mask contents', async ({ page }) => {
  await page.goto('/?demo');
  await page.getByRole('button', { name: '기억 서랍', exact: true }).click();
  await page.getByLabel('기록 검색').fill('검색 결과');
  await expect(page.locator('.memory-card')).toHaveCount(1);
  await page.getByRole('button', { name: '화면 내용 숨기기' }).click();
  await expect(page.locator('.memory-card h3')).toHaveText('숨긴 작업 기록');
  await page.getByRole('button', { name: '내용 다시 보기' }).click();
  await expect(page.locator('.memory-card h3')).toHaveText('네모');
});
test('Settings can pause collection and reduce motion without mutating real settings', async ({
  page,
}) => {
  await page.goto('/?demo');
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page.getByRole('switch', { name: '수집 일시정지' }).click();
  await expect(page.getByRole('switch', { name: '수집 일시정지' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('switch', { name: '움직임 줄이기' }).click();
  await expect(page.locator('.app')).toHaveClass(/reduce-motion/);
  await expect(page.locator('.connector-card')).toHaveCount(3);
});
test('Desktop viewport fits the room and narrow viewport does not overflow', async ({ page }) => {
  await page.goto('/?demo');
  await expect(page.locator('.office-pet')).toHaveCount(6);
  const room = await page.locator('.office-card').boundingBox();
  expect(room!.y + room!.height).toBeLessThan(950);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.office-card')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.local/office-mobile.png', fullPage: true });
});
test('Desk pet unfolds into a one-line office with zones, benches and bubbles', async ({
  page,
}) => {
  await page.goto('/?demo');
  await page.getByRole('button', { name: '데스크 펫', exact: true }).click();
  const pet = page.getByRole('button', { name: /^데스크 펫 ·/ });
  await expect(pet).toBeVisible();
  await expect(pet).toContainText('기다려요');
  const desks = page.locator('.desk-row [data-station-id]');
  await expect(desks).toHaveCount(0);
  await page.locator('.desk-pet-stage').screenshot({ path: '.local/desk-pet.png' });
  await pet.click();
  await expect(desks).toHaveCount(6);
  const tops = await desks.evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size, 'every desk stands in the same single row').toBe(1);
  // The row slides in; measure where it settles.
  await expect
    .poll(async () => {
      const row = (await page.locator('.desk-row').boundingBox())!;
      return [row.x, row.width, Math.round(row.y + row.height)];
    })
    .toEqual([0, 1440, 970]);
  // Same office semantics as the big map: project zones, a shared bench, live bubbles.
  expect(await page.locator('.desk-row .row-zone').count()).toBeGreaterThan(1);
  // A zone sign takes the mouse (its tooltip) and keeps the click in the dock.
  await expect(page.locator('.desk-row .row-zone-mark').first()).toHaveAttribute('data-solid');
  await expect(page.locator('.desk-row .shared-bench').first()).toBeVisible();
  await expect(page.locator('.desk-row .speech-bubble').first()).toBeVisible();
  await expect(page.locator('.desk-row .desk-name em').first()).toContainText('소식');
  await page.locator('.desk-row').screenshot({ path: '.local/desk-row.png' });
  await page.keyboard.press('Escape');
  await expect(desks).toHaveCount(0);
  await pet.click();
  await page.getByRole('button', { name: '책상 줄 접기' }).click();
  await expect(pet).toBeVisible();
  await pet.click();
  await page.locator('.desk-row .office-pet').nth(1).click();
  await expect(page.locator('.office-map')).toBeVisible();
  await expect(page.locator('.inspector')).toBeVisible();
  // A hash-only goto stays in the same document; the dock window always loads fresh.
  await page.goto('/?demo#mini=row');
  await page.reload();
  await expect(desks).toHaveCount(6);
  await page.getByRole('button', { name: '사무실 펼치기' }).click();
  await expect(page.locator('.office-map')).toBeVisible();
});
test('A crowded desk row keeps the desk size and pages with side arrows', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/?demo#mini=row');
  const desks = page.locator('.desk-row [data-station-id]');
  await expect(desks).toHaveCount(6);
  // Same 164px station as the big office at 100%: more colleagues scroll, never shrink.
  expect(await desks.first().evaluate((e) => e.getBoundingClientRect().width)).toBe(164);
  const prev = page.getByRole('button', { name: /왼쪽 동료/ });
  const next = page.getByRole('button', { name: /오른쪽 동료/ });
  await expect(prev).toHaveCount(0);
  await expect(next).toBeVisible();
  await next.click();
  await expect(prev).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(prev).toHaveCount(0);
  // The tools band sits above the bubbles.
  const tools = (await page.locator('.desk-row-tools').boundingBox())!;
  const bubbleTop = Math.min(
    ...(await page
      .locator('.desk-row .speech-bubble')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))),
  );
  expect(tools.y + tools.height).toBeLessThanOrEqual(bubbleTop);
  // …also when a long bubble is unfolded.
  const long = page.locator('.desk-row .speech-bubble').first();
  await long.getByRole('button', { name: '말풍선 전체 보기' }).click();
  expect((await long.boundingBox())!.y).toBeGreaterThanOrEqual(tools.y + tools.height);
});
test('Floor desks stand on the bottom edge with flags for zones, switchable from the row', async ({
  page,
}) => {
  await page.goto('/?demo#mini=floor');
  await page.reload();
  const strip = page.locator('.desk-row.desk-floor');
  await expect(strip.locator('[data-station-id]')).toHaveCount(6);
  // No rugs or name cards: flags mark zones, plates name the desks.
  await expect(strip.locator('.row-zone-floor')).toHaveCount(0);
  await expect(strip.locator('.desk-name')).toHaveCount(0);
  const zones = await strip.locator('.row-zone').count();
  await expect(strip.locator('.zone-flag')).toHaveCount(zones);
  await expect(strip.locator('.zone-flag').first()).toContainText('agent-office');
  await expect(strip.locator('.floor-plate').first()).toContainText('코코');
  // Desk legs reach the window's bottom edge.
  await expect
    .poll(async () => {
      const bench = (await strip.locator('.team-bench').first().boundingBox())!;
      return Math.round(970 - (bench.y + bench.height));
    })
    .toBeLessThanOrEqual(8);
  const tools = (await strip.locator('.desk-row-tools').boundingBox())!;
  const tops = await strip
    .locator('.speech-bubble')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(tops.length).toBeGreaterThan(0);
  expect(tools.y + tools.height).toBeLessThanOrEqual(Math.min(...tops));
  // Only the flag itself takes the mouse: below its cloth, clicks reach the desktop.
  const below = await strip
    .locator('.zone-flag')
    .first()
    .evaluate((flag) => {
      const cloth = flag.querySelector('.zone-flag-cloth')!.getBoundingClientRect();
      const hit = document.elementFromPoint(cloth.left + cloth.width / 2, cloth.bottom + 30);
      return !!hit?.closest('[data-solid]');
    });
  expect(below).toBe(false);
  await strip.screenshot({ path: '.local/desk-floor.png' });
  // Hide and pin work the same on the floor.
  const desk = strip.locator('[data-station-id="demo:4"]');
  await desk.hover();
  await desk.getByRole('button', { name: /고정$/ }).click();
  await expect(desk.locator('.floor-plate svg')).toHaveCount(1);
  await desk.hover();
  await desk.getByRole('button', { name: /가리기$/ }).click();
  await expect(strip.locator('[data-station-id]')).toHaveCount(5);
  // Switch looks; the pet reopens the last one used.
  await page.getByRole('button', { name: '사무실 줄로 보기' }).click();
  await expect(page.locator('.desk-row:not(.desk-floor) .row-zone-floor').first()).toBeVisible();
  await page.getByRole('button', { name: '바닥 책상으로 보기' }).click();
  await expect(page.locator('.desk-row.desk-floor')).toBeVisible();
  await page.keyboard.press('Escape');
  const pet = page.getByRole('button', { name: /^데스크 펫 ·/ });
  await pet.click();
  await expect(page.locator('.desk-row.desk-floor')).toBeVisible();
  await page.getByRole('button', { name: '책상 줄 접기' }).click();
  await page.locator('.dock-pet-anchor').hover();
  await page.getByRole('button', { name: '바닥 책상 펼치기' }).click();
  await expect(page.locator('.desk-row.desk-floor')).toBeVisible();
});

test('Floor desks: helpers stand on the floor and screen sharing hides zone and desk names', async ({
  page,
}) => {
  const snapshot = demoSnapshot();
  const host = snapshot.sessions.find((s) => s.id === 'demo:0')!;
  snapshot.sessions.push({
    ...host,
    id: 'demo:helper',
    nativeId: 'demo-helper',
    alias: '',
    title: '보조 조사',
    status: 'work',
    updatedAt: Date.now(),
    officeSeat: undefined,
    relation: { kind: 'subagent', parentNativeId: host.nativeId, role: '조사', source: 'demo' },
    parentId: host.nativeId,
  });
  snapshot.preferences = { ...snapshot.preferences, privacy: true };
  await page.route('**/api/rpc', (route) => route.fulfill({ json: { result: snapshot } }));
  await page.goto('/#mini=floor');
  const strip = page.locator('.desk-row.desk-floor');
  const helper = strip.locator('.helper-desk');
  await expect(helper).toHaveCount(1);
  const table = (await helper.locator('.helper-table').boundingBox())!;
  const bench = (await strip.locator('.team-bench').first().boundingBox())!;
  expect(Math.abs(table.y + table.height - (bench.y + bench.height))).toBeLessThanOrEqual(3);
  // Privacy: flags and plates never show real names.
  await expect(strip.locator('.zone-flag-cloth span').first()).toHaveText('프로젝트');
  await expect(strip.locator('.floor-plate').first()).not.toContainText('코코');
  expect(await strip.locator('.zone-flag').first().getAttribute('title')).toBeNull();
});

test('Real local collector reports all three providers without modifying source data', async ({
  request,
  page,
}) => {
  test.skip(!!process.env.CI, 'Requires local Claude, Codex and OpenClaw records.');
  const response = await request.post('/api/rpc', {
    headers: { 'X-Agent-Office': '1' },
    data: { method: 'snapshot', args: [] },
  });
  expect(response.ok()).toBeTruthy();
  const { result } = await response.json();
  expect(result.connectors.map((c: any) => c.provider).sort()).toEqual([
    'claude',
    'codex',
    'openclaw',
  ]);
  expect(result.sessions.length).toBeGreaterThan(0);
  const denied = await request.post('/api/rpc', { data: { method: 'snapshot', args: [] } });
  expect(denied.status()).toBe(403);
  await page.goto('/');
  await expect(page.locator('.office-pet').first()).toBeVisible();
  expect(await page.locator('.app').innerText()).not.toContain('구경하는 사무실');
});

test('Desk assignment survives roster sorting, filtering and pinning', async ({ page }) => {
  await page.goto('/?demo');
  await expect(page.locator('.office-pet')).toHaveCount(6);
  const seats = () =>
    page
      .locator('.office-pet')
      .evaluateAll((xs) =>
        Object.fromEntries(
          xs.map((x) => [x.getAttribute('data-session-id'), x.getAttribute('data-seat')]),
        ),
      );
  const before = await seats();
  await page.getByLabel('동료 정렬').selectOption('frequent');
  await page.getByLabel('동료 이름 검색').fill('네모');
  await expect(page.locator('.session-row')).toHaveCount(1);
  expect(await seats()).toEqual(before);
  await page.getByRole('button', { name: '네모, 생각 중', exact: true }).click();
  await page.getByRole('button', { name: '사무실에 고정', exact: true }).click();
  await page.getByRole('button', { name: '업무 카드 닫기' }).click();
  expect(await seats()).toEqual(before);
});
test('Waiting and archive rooms restore sessions without moving occupied desks', async ({
  page,
}) => {
  await page.goto('/?demo');
  await page.getByRole('tab', { name: /대기 라운지/ }).click();
  await expect(page.locator('.room-session h3')).toHaveText('큐브');
  await page.getByRole('button', { name: /사무실로 데려오기/ }).click();
  await expect(page.locator('.office-pet[data-session-id="demo:6"]')).toBeVisible();
  await expect(page.locator('.office-pet[data-session-id="demo:6"]')).toHaveAttribute(
    'data-seat',
    '6',
  );
  await page.getByRole('tab', { name: /보관 공간/ }).click();
  await expect(page.locator('.room-session h3')).toHaveText('꽃게');
  await page.locator('.room-session-main').click();
  await expect(page.getByRole('complementary', { name: '동료의 업무 카드' })).toBeVisible();
  await expect(page.getByRole('button', { name: '사무실에 자리 마련하기' })).toBeVisible();
});
test('Conversation bubbles expand independently and artifacts are actionable links', async ({
  page,
}) => {
  await page.goto('/?demo');
  await page.getByRole('button', { name: '코코, 일하는 중', exact: true }).click();
  await expect(page.getByRole('tab', { name: '대화', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.message-user .message-meta b')).toHaveText('나');
  await expect(page.locator('.message-assistant .message-meta b')).toHaveText('Claude Code');
  await expect
    .poll(() =>
      page
        .locator('.inspector-scroll')
        .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThan(4);
  const more = page.locator('.message-assistant .message-expand');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.artifact-card').first()).toHaveAttribute(
    'href',
    'https://github.com/example/agent-office/pull/42',
  );
  await expect(page.locator('.artifact-card').first()).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Dock preserves room interaction and stays out of the office bounds', async ({ page }) => {
  await page.goto('/?demo');
  await page.getByRole('button', { name: '네모, 생각 중', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(panel).toBeVisible();
  await expect(page.locator('.inspector-backdrop')).toHaveCount(0);
  const office = await page.locator('.office-card').boundingBox();
  const dock = await panel.boundingBox();
  expect(office!.x + office!.width).toBeLessThanOrEqual(dock!.x);
  await page.getByRole('button', { name: '코코, 일하는 중', exact: true }).click();
  await expect(panel.getByRole('heading', { name: /^코코/ })).toBeVisible();
  await expect(page.locator('.app-header')).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowOffice = await page.locator('.office-card').boundingBox();
  const narrowDock = await panel.boundingBox();
  expect(narrowDock!.y).toBeGreaterThan(narrowOffice!.y + narrowOffice!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
test('Progress bubbles do not inflate the inbox; final read receipts preserve the bubble', async ({
  page,
}) => {
  await page.goto('/?demo');
  await expect(page.getByRole('button', { name: '소식함 열기' })).toContainText('1');
  await page.getByRole('button', { name: '코코 말풍선 접기', exact: true }).click();
  await expect(page.getByRole('button', { name: '소식함 열기' })).toContainText('1');
  await page.getByRole('button', { name: '소식함 열기' }).click();
  const inbox = page.getByRole('complementary', { name: '소식함' });
  await expect(inbox.locator('.news-item')).toHaveCount(1);
  await expect(inbox.locator('.news-item')).toContainText('모모');
  await inbox.getByRole('button', { name: '읽음으로 표시', exact: true }).click();
  await expect(inbox.locator('.news-item')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '모모 말풍선 접기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '소식함 열기' })).toContainText('0');
  await inbox.getByRole('checkbox', { name: '읽은 소식 포함' }).check();
  await expect(inbox.locator('.news-item')).toHaveCount(1);
  await inbox.getByRole('button', { name: /전체 기록/ }).click();
  await expect(inbox.locator('.news-item')).toHaveCount(6);
});
test('Same branch shares a table and true children use accessible small desks', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  fixture.sessions[2] = {
    ...fixture.sessions[2],
    provider: 'claude',
    parentId: 'demo-0',
    attachedTo: 'demo:0',
    officeSeat: 0,
    relation: { kind: 'subagent', parentNativeId: 'demo-0', source: 'fixture', role: '검증' },
  };
  await page.addInitScript((s) => {
    (window as any).office = {
      snapshot: async () => structuredClone(s),
      detail: async (id: string) => structuredClone(s.sessions.find((x) => x.id === id)),
      visit: async () => structuredClone(s),
      artifacts: async () => [],
      subscribe: () => () => {},
    };
  }, fixture);
  await page.goto('/');
  await expect(page.locator('.shared-bench')).toHaveCount(1);
  await expect(page.locator('.office-pet')).toHaveCount(5);
  await expect(page.locator('.helper-desk')).toHaveCount(1);
  await page.locator('.helper-desk').click();
  const panel = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(panel.getByRole('heading', { name: /^집사/ })).toBeVisible();
  await panel.getByRole('button', { name: '부모 작업 · 코코', exact: true }).click();
  await expect(panel.getByRole('heading', { name: /^코코/ })).toBeVisible();
});
test('New work effect is only triggered by a newly observed request, not bootstrap or polling', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      subscribe: (cb: any) => {
        w.publish = cb;
        return () => {};
      },
    };
  }, fixture);
  await page.goto('/');
  await expect(page.locator('.arrival-burst')).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    const n = {
      ...w.fixture.notices[0],
      id: 'arrival-request',
      eventId: 'new-request',
      kind: 'request',
      bootstrap: false,
      receivedAt: Date.now(),
      at: Date.now(),
    };
    w.fixture.notices = [n, ...w.fixture.notices];
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.locator('.arrival-burst')).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as any;
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.locator('.arrival-burst')).toHaveCount(1);
  await expect(page.locator('.arrival-burst')).toHaveCount(0, { timeout: 18_000 });
});

test('Sparse old seats become one fitted room with movable furniture, project zones and every helper', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  const base = fixture.sessions[0];
  fixture.notices = [];
  fixture.sessions = Array.from({ length: 18 }, (_, i) => ({
    ...base,
    id: `dense:${i}`,
    nativeId: `dense-${i}`,
    alias: `동료 ${i + 1}`,
    title: `동료 ${i + 1}`,
    officeSeat: i * 6,
    project: `project-${i % 3}`,
    cwd: `/tmp/project-${i % 3}`,
    branch: 'main',
    status: 'work',
  }));
  fixture.sessions[1].branch = null;
  fixture.sessions[1].workspace = {
    key: 'git:taskdeck',
    name: 'taskdeck',
    root: '/tmp/taskdeck',
    worktree: '/tmp/taskdeck',
    evidence: 'git-common-dir',
    git: { branch: null, commit: '7b880ba0123456789', state: 'detached', observedAt: Date.now() },
  };
  for (let i = 0; i < 4; i++)
    fixture.sessions.push({
      ...fixture.sessions[0],
      id: `helper:${i}`,
      nativeId: `helper-${i}`,
      alias: `보조 ${i + 1}`,
      attachedTo: 'dense:0',
      parentId: 'dense-0',
      relation: { kind: 'subagent', parentNativeId: 'dense-0', source: 'fixture' },
    });
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      detail: async (id: string) =>
        structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
      visit: async () => structuredClone(w.fixture),
      artifacts: async () => [],
      subscribe: (cb: any) => {
        w.publish = cb;
        return () => {};
      },
    };
  }, fixture);
  await page.goto('/');
  await expect(page.locator('.office-pet')).toHaveCount(18);
  await expect(page.locator('.helper-desk')).toHaveCount(4);
  await expect(page.locator('.office-chair')).toHaveCount(18);
  await expect(page.locator('.floor-navigation, .empty-desk, .map-bg')).toHaveCount(0);
  await expect(page.locator('.project-area')).toHaveCount(4);
  await expect(page.locator('.desk-station[data-station-id="dense:1"] .desk-branch')).toHaveText(
    'HEAD · 7b880ba',
  );
  const positions = () =>
    page
      .locator('.project-area, .desk-station, .helper-desk')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform));
  const before = await positions();
  const assertFit = async () => {
    const bounds = await page.locator('.scene-viewport').boundingBox();
    for (const el of await page.locator('.desk-name, .helper-desk, .project-floor-mark').all()) {
      const box = (await el.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(box.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
    }
    expect(bounds!.y + bounds!.height).toBeLessThan(page.viewportSize()!.height);
  };
  await assertFit();
  await page.screenshot({ path: '.local/dynamic-office-dense.png', fullPage: true });
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.sessions.reverse();
    w.fixture.sessions.forEach((s: any) => {
      s.updatedAt += 5000;
      s.status = 'think';
    });
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.locator('.office-pet[data-session-id="dense:0"]')).toHaveAttribute(
    'aria-label',
    '동료 1, 생각 중',
  );
  expect(await positions()).toEqual(before);
  await page.locator('.office-pet[data-session-id="dense:0"]').click();
  await expect(page.getByRole('complementary', { name: '동료의 업무 카드' })).toBeVisible();
  expect(await positions()).toEqual(before);
  await assertFit();
  await page.getByRole('button', { name: '업무 카드 닫기' }).click();
  const initialScale = Number(await page.locator('.scene-viewport').getAttribute('data-scale'));
  await page.getByRole('button', { name: '사무실 확대' }).click();
  expect(Number(await page.locator('.scene-viewport').getAttribute('data-scale'))).toBeGreaterThan(
    initialScale,
  );
  await page.getByRole('button', { name: '사무실 모두 보기' }).click();
  await assertFit();
});

test('Conversation filters public phases, hides tools by default and preserves expanded text across filters', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  const s = fixture.sessions[0];
  s.events.push(
    {
      id: 'tool-filter',
      kind: 'tool',
      tool: 'exec',
      text: 'exec 실행',
      at: Date.now(),
      sourceRef: 'fixture',
    },
    {
      id: 'final-filter',
      kind: 'assistant',
      phase: 'final',
      text: '최종 검증을 마쳤습니다. '.repeat(35),
      at: Date.now() + 1,
      sourceRef: 'fixture',
    },
    {
      id: 'unknown-filter',
      kind: 'assistant',
      text: '원본에 단계 표시가 없는 메시지',
      at: Date.now() + 2,
      sourceRef: 'fixture',
    },
  );
  await page.addInitScript((fixture) => {
    const w = window as any;
    w.fixture = fixture;
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      visit: async () => structuredClone(w.fixture),
      detail: async (id: string) =>
        structuredClone(w.fixture.sessions.find((s: any) => s.id === id)),
      artifacts: async () => [],
      subscribe: (cb: any) => {
        w.publish = cb;
        return () => {};
      },
    };
  }, fixture);
  await page.goto('/');
  await page.getByRole('button', { name: '코코, 일하는 중', exact: true }).click();
  const filters = page.getByRole('group', { name: '대화 종류' });
  await expect(page.locator('.work-group')).toHaveCount(0);
  await expect(page.locator('.message-category')).toHaveText([
    '내 요청',
    '진행 상황',
    '최종 응답',
    '기타 응답',
  ]);
  await filters.getByRole('button', { name: /최종 응답/ }).click();
  await expect(page.locator('.conversation-message')).toHaveCount(1);
  const more = page.locator('.message-expand');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await filters.getByRole('button', { name: /내 요청/ }).click();
  await expect(page.locator('.conversation-message')).toHaveCount(1);
  await expect(page.locator('.message-category')).toHaveText('내 요청');
  await filters.getByRole('button', { name: /진행 상황/ }).click();
  await expect(page.locator('.message-category')).toHaveText('진행 상황');
  await filters.getByRole('button', { name: /최종 응답/ }).click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.conversation-message.category-reply .message-meta')).toBeInViewport();
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.sessions[0].events.push({
      id: 'new-progress',
      kind: 'assistant',
      phase: 'commentary',
      text: '새 작업을 진행합니다',
      at: Date.now() + 3,
      sourceRef: 'fixture',
    });
    w.fixture.sessions[0].revision = 'filter-update';
    w.publish(structuredClone(w.fixture));
  });
  await expect(filters.getByRole('button', { name: /최종 응답/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.conversation-message')).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.notices.push({
      ...w.fixture.notices[0],
      id: 'retained-final',
      eventId: 'retained-final',
      sessionId: w.fixture.sessions[0].id,
      kind: 'reply',
      phase: 'final',
      text: '수집 구간 밖에서 보관한 직전 최종 응답입니다.',
      at: Date.now() + 5000,
    });
    w.publish(structuredClone(w.fixture));
  });
  await expect(page.locator('.conversation-message')).toHaveCount(2);
  await expect(page.locator('.retained-excerpt')).toHaveText('보관된 발췌 · 원문 일부');
  await expect(page.locator('.conversation')).toContainText(
    '수집 구간 밖에서 보관한 직전 최종 응답입니다.',
  );
  await filters.getByRole('button', { name: /전체/ }).click();
  await page.getByRole('checkbox', { name: /도구 기록 포함/ }).check();
  await expect(page.locator('.work-group')).toHaveCount(1);
  await page.locator('.work-group summary').click();
  await expect(page.locator('.message-tool')).toContainText('exec 실행');
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect
    .poll(async () => (await page.locator('.inspector-scroll').boundingBox())!.height)
    .toBeGreaterThan(240);
  await expect(filters).toBeInViewport();
  await page.screenshot({ path: '.local/conversation-categories.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('Inbox defaults to finals, retains attention, and batch read only affects the selected category', async ({
  page,
}) => {
  const fixture = demoSnapshot();
  const base = fixture.notices![0];
  fixture.notices = [
    ...Array.from({ length: 20 }, (_, i) => ({
      ...base,
      id: `progress-${i}`,
      kind: 'progress' as const,
      phase: 'commentary' as const,
    })),
    {
      ...base,
      id: 'important-final',
      kind: 'reply',
      phase: 'final',
      text: '기능 구현과 검증을 마쳤습니다.',
    },
    {
      ...base,
      id: 'important-attention',
      kind: 'attention',
      phase: undefined,
      text: '원래 앱에서 답변해 주세요.',
    },
    {
      ...base,
      id: 'resolved-attention',
      kind: 'attention',
      phase: undefined,
      resolvedAt: Date.now(),
    },
    {
      ...base,
      id: 'legacy-unknown',
      kind: 'reply',
      phase: undefined,
      text: '완료 여부를 구분할 수 없는 이전 응답',
    },
  ];
  await page.addInitScript((s) => {
    const w = window as any;
    w.fixture = s;
    w.office = {
      snapshot: async () => structuredClone(w.fixture),
      subscribe: () => () => {},
      notices: async (receipts: any[], action: string) => {
        for (const n of w.fixture.notices)
          if (receipts.some((r) => r.id === n.id && r.version === n.version)) {
            if (action === 'read') n.seenAt = Date.now();
            else if (action === 'unread') n.seenAt = null;
            else n.dismissedAt = Date.now();
          }
        return structuredClone(w.fixture);
      },
    };
  }, fixture);
  await page.goto('/');
  const badge = page.getByRole('button', { name: '소식함 열기' });
  await expect(badge).toContainText('2');
  await badge.click();
  const inbox = page.getByRole('complementary', { name: '소식함' });
  await expect(inbox.locator('.news-item')).toHaveCount(1);
  await expect(inbox.locator('.news-item')).toContainText('기능 구현과 검증을 마쳤습니다.');
  await expect(
    inbox.getByRole('button', { name: /답변이나 확인을 기다리는 소식 1건/ }),
  ).toBeVisible();
  await inbox.getByRole('button', { name: '미확인 1건 읽음', exact: true }).click();
  await expect(badge).toContainText('1');
  await expect(inbox.locator('.news-item')).toHaveCount(0);
  await inbox.getByRole('button', { name: /답변이나 확인을 기다리는 소식 1건/ }).click();
  await expect(inbox.locator('.news-item')).toHaveCount(1);
  await inbox.getByRole('button', { name: '미확인 1건 읽음', exact: true }).click();
  await expect(badge).toContainText('0');
  await inbox.getByRole('button', { name: /전체 기록/ }).click();
  await expect(inbox.locator('.news-item')).toHaveCount(22);
  await inbox.getByRole('checkbox', { name: '읽은 소식 포함' }).check();
  await expect(inbox.locator('.news-item')).toHaveCount(24);
  await inbox.getByRole('button', { name: /최종 응답/ }).click();
  await expect(inbox.locator('.news-item')).toHaveCount(1);
  await page.screenshot({ path: '.local/inbox-final-responses.png', fullPage: true });
});
