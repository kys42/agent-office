import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { OfficeEvent, SessionOutput } from '../../src/shared/types';

// #358: the card's chat shows the outputs a teammate made as chips under the message that made
// them, even with the work log and progress notes folded away.

const SHOTS = process.env.OUTPUT_SHOTS;

function fixture() {
  const snapshot = demoSnapshot();
  snapshot.notices = [];
  snapshot.outputStamp = '1';
  const [a, b] = snapshot.sessions;
  const t0 = Date.now() - 20 * 60_000;
  const e = (
    id: string,
    kind: OfficeEvent['kind'],
    minute: number,
    text: string,
    extra: Partial<OfficeEvent> = {},
  ): OfficeEvent => ({
    id,
    kind,
    at: t0 + minute * 60_000,
    text,
    sourceRef: `fixture#${id}`,
    ...extra,
  });
  // One finished turn that wrote two files (their tool calls folded away) and named an Artifact,
  // then a turn still running that just made a chart.
  a.events = [
    e('u1', 'user', 0, '분기 보고서랑 랜딩 페이지 만들어 줘'),
    e('p1', 'assistant', 1, '자료를 모으고 있어요.', { phase: 'commentary' }),
    e('t1', 'tool', 2, 'Write', { tool: 'Write', intent: 'tool-use' }),
    e('r1', 'result', 2.1, 'File created successfully at: /Users/me/work/app/docs/분기 보고서.md'),
    e('t2', 'tool', 3, 'Write', { tool: 'Write', intent: 'tool-use' }),
    e('r2', 'result', 3.1, 'File created successfully at: /Users/me/work/app/docs/landing.html'),
    e('f1', 'assistant', 4, '다 만들었어요. 보고서와 랜딩 페이지를 확인해 주세요.', {
      phase: 'final',
    }),
    e('u2', 'user', 10, '매출 차트도 그려 줘'),
    e('t3', 'tool', 11, 'Write', { tool: 'Write', intent: 'tool-use' }),
    e('r3', 'result', 11.1, 'File created successfully at: /Users/me/work/app/docs/chart.png'),
  ];
  a.status = 'work';
  a.updatedAt = t0 + 11.1 * 60_000;
  const out = (
    id: string,
    name: string,
    eventId: string | undefined,
    minute: number,
    extra: Partial<SessionOutput> = {},
  ): SessionOutput => ({
    id,
    sessionId: a.id,
    kind: 'file',
    via: 'write',
    name,
    dir: `/Users/me/work/${a.project}/docs`,
    path: `/Users/me/work/${a.project}/docs/${name}`,
    ext: name.split('.').pop()!,
    createdAt: t0 + minute * 60_000,
    eventAt: t0 + minute * 60_000,
    ...(eventId ? { eventId } : {}),
    source: { provider: a.provider, project: a.project, title: a.title, alias: a.alias },
    exists: true,
    ...extra,
  });
  const outputs: SessionOutput[] = [
    out('o-report', '분기 보고서.md', 'r1', 2.1),
    out('o-page', 'landing.html', 'r2', 3.1, { via: 'patch' }),
    // Recorded before outputs knew their event: placed by its time.
    {
      ...out('o-artifact', '디자인 시안', undefined, 3.5, { kind: 'link', via: 'artifact' }),
      ext: '',
      dir: '',
      path: 'https://claude.ai/code/artifact/0f6c1e2a-1111-4222-8333-944455556666',
      exists: undefined,
      eventAt: undefined,
    },
    out('o-chart', 'chart.png', 'r3', 11.1),
    // Another teammate's: never in this chat.
    { ...out('o-other', 'other.md', 'r1', 2.1), sessionId: b.id },
  ];
  return { snapshot, outputs };
}

async function open(
  page: Page,
  opts: { privacy?: boolean; web?: boolean; card?: boolean; chatOutputs?: boolean } = {},
) {
  const { snapshot, outputs } = fixture();
  snapshot.preferences.privacy = !!opts.privacy;
  if (opts.chatOutputs === false) snapshot.preferences.chatOutputs = false;
  const cardId = opts.card ? snapshot.sessions[0].id : null;
  if (cardId) await page.setViewportSize({ width: 380, height: 640 });
  await page.addInitScript(
    ({ snapshot, outputs, web, cardId }) => {
      const w = window as any;
      w.fixture = snapshot;
      w.outputs = outputs;
      w.queries = [];
      w.actions = [];
      // The card's chat shows progress notes unless switched off; these specs fold them.
      localStorage.setItem('office:card-progress', 'off');
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((s: any) => s.id === id)),
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        search: async () => [],
        bookmarks: async () => ({ bookmarks: [], more: false, total: 0 }),
        subscribe: (cb: any) => {
          w.publish = cb;
          return () => {};
        },
        outputs: async (q: any = {}) => {
          w.queries.push(q);
          const all = w.outputs
            .filter((o: any) => !q.sessionIds || q.sessionIds.includes(o.sessionId))
            .sort((x: any, y: any) => y.createdAt - x.createdAt);
          const end = q.limit ?? 50;
          return structuredClone({
            outputs: all.slice(0, end),
            total: all.length,
            more: end < all.length,
          });
        },
        ...(web
          ? {}
          : {
              outputAction: async (what: string, id: string) => {
                w.actions.push([what, id]);
                return what === 'copy' ? 'copied' : what === 'preview' ? 'previewed' : 'opened';
              },
            }),
        copyText: async () => {},
        terminals: async () => ({}),
        ...(cardId
          ? {
              card: async () => {},
              cardState: async () => ({ pinned: false, positionRemembered: false }),
              onCardState: () => () => {},
              onCard: (cb: any) => {
                setTimeout(() => cb({ id: cardId }), 50);
                return () => {};
              },
            }
          : {}),
      };
      localStorage.setItem('office:onboarding:v1:live', 'seen');
    },
    { snapshot, outputs, web: !!opts.web, cardId },
  );
  await page.goto(`/?lang=ko${cardId ? '#card' : ''}`);
  const card = cardId
    ? page.getByRole('complementary', { name: '동료의 업무 카드' })
    : page.locator('.inspector');
  if (!cardId)
    await page.locator(`.office-pet[data-session-id="${snapshot.sessions[0].id}"]`).click();
  await expect(card).toBeVisible();
  return { snapshot, card };
}

const rowAfter = (card: ReturnType<Page['locator']>, eventId: string) =>
  card.locator(`[data-event-id="${eventId}"] + .output-chips`);

test('Chips sit under the reply that made them, the running turn at the end', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { snapshot, card } = await open(page);
  // The work log and progress notes are folded away; the chips are not.
  await expect(card.locator('[data-event-id="r1"]')).toHaveCount(0);
  await expect(card.locator('[data-event-id="p1"]')).toHaveCount(0);
  const done = rowAfter(card, 'f1');
  await expect(done.locator('.output-chip-name')).toHaveText([
    '분기 보고서.md',
    'landing.html',
    '디자인 시안',
  ]);
  // The turn still running has no reply yet: its chip waits at the end.
  const end = card.locator('.conversation > .output-chips').last();
  await expect(end.locator('.output-chip-name')).toHaveText(['chart.png']);
  await expect(card.getByText('other.md')).toHaveCount(0);
  // Read once for this run, as many as a read gives.
  const query = (await page.evaluate(() => (window as any).queries)).find(
    (q: any) => q.sessionIds?.length === 1 && q.limit === 200,
  );
  expect(query.sessionIds).toEqual([snapshot.sessions[0].id]);
  if (SHOTS) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await card.locator(`[data-output-id="o-report"]`).hover();
      await card.screenshot({ path: `${SHOTS}/output-chips-card-${colorScheme}.png` });
    }
  }
  expect(errors).toEqual([]);
});

test('A click previews markdown and HTML, opens the rest; folder and path beside it', async ({
  page,
}) => {
  const { card } = await open(page);
  const done = rowAfter(card, 'f1');
  await done.getByRole('button', { name: '미리보기 · 분기 보고서.md' }).click();
  await done.getByRole('button', { name: '미리보기 · landing.html' }).click();
  await done.getByRole('button', { name: '브라우저로 열기 · 디자인 시안' }).click();
  const chart = card.locator('[data-output-id="o-chart"]');
  // Hover and focus never reflow the row: its folder and copy float above it.
  const height = (await done.boundingBox())!.height;
  await card.locator('[data-output-id="o-artifact"]').hover();
  await expect(
    card.locator('[data-output-id="o-artifact"]').getByRole('button', { name: /^링크 복사/ }),
  ).toBeVisible();
  expect((await done.boundingBox())!.height).toBe(height);
  await chart.getByRole('button', { name: '열기 · chart.png' }).click();
  // Folder and copy come with hover or focus.
  await chart.hover();
  await chart
    .getByRole('button', { name: /^(Finder에서 보기|폴더에서 보기) · chart\.png$/ })
    .click();
  await chart.getByRole('button', { name: '경로 복사 · chart.png' }).click();
  await expect(page.getByText('경로를 복사했어요')).toBeVisible();
  // An Artifact has no folder.
  await expect(
    card.locator('[data-output-id="o-artifact"]').getByRole('button', { name: /^(Finder|폴더)/ }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).actions)).toEqual([
    ['preview', 'o-report'],
    ['preview', 'o-page'],
    ['open', 'o-artifact'],
    ['open', 'o-chart'],
    ['reveal', 'o-chart'],
    ['copy', 'o-chart'],
  ]);
});

test('With the work log shown, a chip sits under its own tool steps', async ({ page }) => {
  const { card } = await open(page);
  await card.getByRole('button', { name: '필터', exact: true }).click();
  await card.getByRole('checkbox', { name: /도구 기록 포함/ }).check();
  // One work group holds both writes of the first turn: its chips follow it, not the reply.
  const group = card.locator('details.work-group', { has: page.locator('[data-event-id="r1"]') });
  await expect(group).toHaveCount(1);
  await expect(
    card.locator('details.work-group + .output-chips').first().locator('.output-chip-name'),
  ).toHaveText(['분기 보고서.md', 'landing.html', '디자인 시안']);
  // Placed by time, the Artifact goes with the step just before it.
  await expect(rowAfter(card, 'f1')).toHaveCount(0);
});

test('The pop-up card window shows the chips too', async ({ page }) => {
  const { card } = await open(page, { card: true });
  const done = rowAfter(card, 'f1');
  await expect(done.locator('.output-chip')).toHaveCount(3);
  // Nothing wider than the narrow card.
  const scroller = card.locator('.inspector-scroll');
  expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await done.getByRole('button', { name: '미리보기 · 분기 보고서.md' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).actions))
    .toEqual([['preview', 'o-report']]);
  if (SHOTS)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${SHOTS}/output-chips-popup-${colorScheme}.png` });
    }
});

test('The web preview shows names only: nothing to open', async ({ page }) => {
  const { card } = await open(page, { web: true });
  const done = rowAfter(card, 'f1');
  await expect(done.locator('.output-chip-name')).toHaveText([
    '분기 보고서.md',
    'landing.html',
    '디자인 시안',
  ]);
  await expect(card.locator('.output-chips button')).toHaveCount(0);
});

test('Hidden screen content shows no chip names', async ({ page }) => {
  const { card } = await open(page, { privacy: true });
  await expect(card.locator('.privacy-placeholder')).toBeVisible();
  await expect(card.getByText('분기 보고서.md')).toHaveCount(0);
  await expect(card.locator('.output-chip-main button, button.output-chip-main')).toHaveCount(0);
});

test('Settings can leave the chips out of the chat', async ({ page }) => {
  const { card } = await open(page);
  await expect(rowAfter(card, 'f1')).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.version++;
    w.fixture.preferences.chatOutputs = false;
    w.publish(structuredClone(w.fixture));
  });
  await expect(card.locator('.output-chips')).toHaveCount(0);
  // The card's Outputs tab is its own setting.
  await expect(card.getByRole('tab', { name: /^산출물/ })).toBeVisible();
  await page.getByRole('button', { name: '연결과 설정' }).click();
  await page.getByRole('tablist', { name: '설정 분류' }).getByRole('tab', { name: '모습' }).click();
  const views = page.locator('[data-guide-section="views"]');
  await views.getByText('자세히').last().click();
  const toggle = views.getByRole('switch', { name: '대화 속 산출물' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('Off from the start, the chat reads no outputs for chips', async ({ page }) => {
  const { card } = await open(page, { chatOutputs: false });
  await expect(card.locator('[data-event-id="f1"]')).toBeVisible();
  await expect(card.locator('.output-chips')).toHaveCount(0);
  const queries = await page.evaluate(() => (window as any).queries);
  expect(queries.filter((q: any) => q.limit === 200)).toEqual([]);
});
