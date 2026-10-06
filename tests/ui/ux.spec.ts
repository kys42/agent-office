import { test, expect } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

test('Roster is a to-do list: waiting, results, working — and tiles jump to rows', async ({
  page,
}) => {
  await page.goto('/?demo');
  const groups = page.locator('.roster-group');
  await expect(groups.first()).toHaveAttribute('data-group', 'attention');
  await expect(page.locator('.group-attention .session-row')).toHaveCount(1);
  await expect(page.locator('.group-attention .session-row')).toContainText('당근');
  await expect(page.locator('.group-results .session-row')).toContainText('모모');
  await expect(page.locator('.group-working .session-row')).toHaveCount(4);
  await expect(page.locator('.roster-head h2')).toHaveText('1명이 나를 기다려요');
  await page
    .getByRole('button', { name: /확인할 결과/ })
    .first()
    .click();
  await expect(page.locator('.session-row.is-hover')).toContainText('모모');
});

test('Now card routes calls to the original tool and lets results be read in place', async ({
  page,
}) => {
  await page.goto('/?demo');
  await page.locator('.group-attention .session-row').click();
  const now = page.getByRole('region', { name: '지금 상태' });
  await expect(now).toHaveClass(/tone-attention/);
  await expect(now).toContainText('답변을 기다리고 있어요');
  await expect(now).toContainText('원래 앱');
  // Demo cannot resume real sessions; the action exists but is honest about it.
  await expect(now.getByRole('button', { name: '재개 명령 복사' })).toBeDisabled();
  // The roster yields its column to the card; the room stays clickable.
  await page.getByRole('button', { name: '모모, 응답 완료', exact: true }).click();
  await expect(now).toHaveClass(/tone-result/);
  await expect(now).toContainText('새 결과가 도착했어요');
  await now.getByRole('button', { name: '읽음으로 표시' }).click();
  await expect(page.locator('.inbox-button b')).toHaveText('0');
  await expect(now).not.toHaveClass(/tone-result/);
  // Reading is a receipt only — the colleague's desk and bubble stay.
  await expect(page.locator('.office-pet[data-session-id="demo:5"]')).toBeVisible();
});

test('Command palette finds colleagues and actions without leaving the office', async ({
  page,
}) => {
  await page.goto('/?demo');
  await expect(page.locator('.office-pet')).toHaveCount(6);
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: '명령 팔레트' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('option').first()).toContainText('당근');
  await page.keyboard.type('네모');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.locator('.inspector-heading h2')).toHaveText('네모');
  await expect(page.locator('.office-map')).toBeVisible();
  await page.getByRole('button', { name: /동료, 기록, 명령 찾기/ }).click();
  await page.keyboard.type('라운지');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /대기 라운지/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('Keyboard triage walks the to-do order and marks results read', async ({ page }) => {
  await page.goto('/?demo');
  await expect(page.locator('.office-pet')).toHaveCount(6);
  await page.keyboard.press('j');
  await expect(page.locator('.inspector-heading h2')).toHaveText('당근');
  await page.keyboard.press('j');
  await expect(page.locator('.inspector-heading h2')).toHaveText('모모');
  await page.keyboard.press('r');
  await expect(page.locator('.inbox-button b')).toHaveText('0');
  // Reading does not reshuffle the cursor mid-triage: K returns, J continues.
  await page.keyboard.press('k');
  await expect(page.locator('.inspector-heading h2')).toHaveText('당근');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await expect(page.locator('.inspector-heading h2')).toHaveText('코코');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: '키보드 단축키' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Typing in a field never triggers single-key shortcuts.
  await page.keyboard.press('Escape');
  await page.getByLabel('동료 이름 검색').fill('jk');
  await expect(page.getByRole('complementary', { name: '동료의 업무 카드' })).toHaveCount(0);
});

test('Panel tabs switch colleagues and news in one click', async ({ page }) => {
  await page.goto('/?demo');
  await page.locator('.panel-tabs').getByRole('button', { name: /^소식/ }).click();
  await expect(page.getByRole('complementary', { name: '소식함' })).toBeVisible();
  await page.locator('.panel-tabs').getByRole('button', { name: '동료', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '동료 목록' })).toBeVisible();
});

test('List hover spotlights a desk without moving any furniture', async ({ page }) => {
  await page.goto('/?demo');
  const station = page.locator('.desk-station[data-station-id="demo:1"]');
  const before = await page
    .locator('.desk-station')
    .evaluateAll((xs) => xs.map((x) => (x as HTMLElement).style.transform));
  await page.locator('.session-row[data-session-id="demo:1"]').hover();
  await expect(station).toHaveClass(/is-spotlight/);
  await expect(page.locator('.desk-station[data-station-id="demo:0"]')).toHaveClass(/is-dimmed/);
  const after = await page
    .locator('.desk-station')
    .evaluateAll((xs) => xs.map((x) => (x as HTMLElement).style.transform));
  expect(after).toEqual(before);
});

test('Coming back summarises only what arrived while away', async ({ page }) => {
  const fixture = demoSnapshot();
  await page.clock.install();
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
  await expect(page.locator('.office-pet')).toHaveCount(6);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.clock.fastForward('05:00');
  await page.evaluate(() => {
    const w = window as any;
    const base = w.fixture.notices[0];
    w.fixture.notices.push({
      ...base,
      id: 'away-final',
      eventId: 'away-final',
      sessionId: 'demo:2',
      kind: 'reply',
      phase: 'final',
      text: '자리 비운 사이 끝난 결과',
      at: Date.now(),
      receivedAt: Date.now(),
      bootstrap: false,
      seenAt: null,
    });
    w.publish(structuredClone(w.fixture));
    window.dispatchEvent(new Event('focus'));
  });
  const banner = page.locator('.away-banner');
  await expect(banner).toContainText('자리 비운 5분 동안');
  await expect(banner).toContainText('새 결과 1건');
  await banner.getByRole('button', { name: '바로 보기' }).click();
  await expect(page.locator('.inspector-heading h2')).toHaveText('집사');
  await expect(banner).toBeHidden();
});

test('Single-key shortcuts use physical keys, so they work with the Korean input source', async ({
  page,
}) => {
  await page.goto('/?demo');
  await expect(page.locator('.office-pet')).toHaveCount(6);
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ㅓ', code: 'KeyJ', bubbles: true })),
  );
  await expect(page.locator('.inspector-heading h2')).toHaveText('당근');
  // Esc inside a field leaves the field first instead of closing the card.
  await page.getByLabel('업무 메모').count();
  await page.getByRole('tab', { name: '기억 메모' }).click();
  await page.getByLabel('업무 메모').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: '동료의 업무 카드' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: '동료의 업무 카드' })).toHaveCount(0);
});

test('A zone shortcut is applied once and not replayed after visiting other pages', async ({
  page,
}) => {
  await page.goto('/?demo');
  await expect(page.locator('.office-pet')).toHaveCount(6);
  await page.keyboard.press('2');
  await expect(page.getByRole('tab', { name: /대기 라운지/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: /사무실/ }).click();
  await page.getByRole('button', { name: '기억 서랍', exact: true }).click();
  await page.getByRole('button', { name: '우리 사무실', exact: true }).click();
  await expect(page.getByRole('tab', { name: /사무실/ }).first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('Hiding a colleague clears them from the office and the desk row until they talk again', async ({
  page,
}) => {
  await page.goto('/?demo');
  const nemo = page.locator('.office-map [data-station-id="demo:1"]');
  await nemo.hover();
  const eye = nemo.getByRole('button', { name: /가리기$/ });
  await expect(eye).toBeVisible();
  await eye.hover();
  await expect(nemo.locator('.veil-tip')).toContainText('다음 대화가 올 때까지');
  await eye.click();
  await expect(nemo).toHaveCount(0);
  await expect(page.locator('.office-map [data-station-id]')).toHaveCount(5);
  // Someone waiting for the person is never hidden.
  const caller = page.locator('.office-map [data-station-id="demo:3"]');
  await caller.hover();
  await caller.getByRole('button', { name: /가리기$/ }).click();
  await expect(caller).toBeVisible();
  const veiled = page.locator('.veiled-records');
  await expect(veiled).toContainText('가린 동료 1');
  await veiled.locator('summary').click();
  await page.getByRole('button', { name: '모두 다시 보기' }).click();
  await expect(page.locator('.office-map [data-station-id="demo:1"]')).toHaveCount(1);
  await expect(veiled).toHaveCount(0);

  await page.goto('/?demo#mini=row');
  await page.reload();
  const row = page.locator('.desk-row [data-station-id]');
  await expect(row).toHaveCount(6);
  const desk = page.locator('.desk-row [data-station-id="demo:4"]');
  await desk.hover();
  await desk.getByRole('button', { name: /가리기$/ }).click();
  await expect(row).toHaveCount(5);
  await page.getByRole('button', { name: /가림 1/ }).click();
  await expect(row).toHaveCount(6);
});

test('A just-arrived result turns the collapsed pet into that colleague with a bubble', async ({
  page,
}) => {
  const snapshot = demoSnapshot();
  const reply = snapshot.notices!.find((n) => n.kind === 'reply' && n.phase === 'final')!;
  Object.assign(reply, { bootstrap: false, receivedAt: Date.now() });
  await page.route('**/api/rpc', async (route) => {
    const { method, args } = route.request().postDataJSON();
    if (method === 'notices' && args[1] === 'dismiss')
      for (const r of args[0]) {
        const n = snapshot.notices!.find((x) => x.id === r.id);
        if (n) n.dismissedAt = Date.now();
      }
    await route.fulfill({ json: { result: snapshot } });
  });
  await page.goto('/#mini');
  const bubble = page.locator('.dock-pet-speech .speech-bubble');
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText(reply.text.slice(0, 12));
  await expect(page.locator('.desk-pet.is-speaking')).toBeVisible();
  await page.locator('.desk-pet-stage').screenshot({ path: '.local/desk-pet-speaking.png' });
  await page.getByRole('button', { name: /말풍선 접기/ }).click();
  await expect(bubble).toHaveCount(0);
  await expect(page.locator('.desk-pet.is-speaking')).toHaveCount(0);
});
