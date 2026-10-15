import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { makeBookmark } from '../../src/shared/bookmarks';
import type { OfficeEvent } from '../../src/shared/types';

const richBookmark = `### 저장한 결정

**강조**와 \`inline code\`

- 첫 작업
- 둘째 작업

| 이름 | 상태 |
| --- | --- |
| ${'아주긴항목'.repeat(18)} | 완료 |

\`\`\`ts
const saved = "${'x'.repeat(90)}";
\`\`\`

[참고](https://example.com/bookmark)

<script>window.unsafe = true</script>
![외부 이미지](https://example.com/tracker.png)
[실행](javascript:alert(1))`;

async function memory(
  page: Page,
  opts: {
    popup?: boolean;
    privacy?: boolean;
    count?: number;
    grouped?: boolean;
    english?: boolean;
    markdown?: boolean;
  } = {},
) {
  const snapshot = demoSnapshot();
  const s = snapshot.sessions[0];
  s.notes = '직접 쓴 업무 메모';
  snapshot.preferences.privacy = !!opts.privacy;
  snapshot.notices = [];
  const events: OfficeEvent[] = Array.from({ length: opts.count ?? 2 }, (_, i) => ({
    id: `saved-${i}`,
    kind: 'assistant',
    phase: 'final',
    text: `저장한 결정 ${i}`,
    at: Date.now() - (100 - i) * 1000,
    sourceRef: 'fixture',
  }));
  s.events = events;
  if (opts.markdown) {
    events[0] = { ...events[0], kind: 'user', text: '**요청 내용**\n\n- 확인해 주세요' };
    events[1] = { ...events[1], phase: 'commentary', text: '### 진행 내용\n\n- 진행 확인' };
    events[2] = { ...events[2], text: richBookmark };
  }
  s.activity = undefined;
  const saved = events.map((e, i) =>
    makeBookmark(s, events, e.id, `b-${i}`, e.at, i === 0 ? '덧붙인 메모' : '')!,
  );
  const other = snapshot.sessions[1];
  if (opts.markdown) saved[2].note = '### 덧붙인 제목\n\n**덧붙인 강조**\n\n- 메모 목록';
  other.events = [{ ...events[0], id: 'other-event', text: '다른 동료의 북마크' }];
  saved.push(makeBookmark(other, other.events, 'other-event', 'unrelated', Date.now())!);
  if (opts.grouped) {
    s.actor = { id: 'same-person', name: '같은 동료', source: 'fixture' };
    const run = {
      ...s,
      id: 'prior-run',
      nativeId: 'prior-run',
      updatedAt: s.updatedAt - 1000,
      events: [{ ...events[0], id: 'prior-event', text: '이 동료의 지난 실행 메모' }],
    };
    snapshot.sessions.push(run);
    saved.push(makeBookmark(run, run.events, 'prior-event', 'prior-bookmark', Date.now() + 1000)!);
  }
  snapshot.bookmarked = Object.fromEntries(
    snapshot.sessions.map((x) => [
      x.id,
      saved.filter((b) => b.sessionId === x.id).map((b) => b.eventId),
    ]),
  );
  snapshot.bookmarkStamp = '1';
  if (opts.popup) await page.setViewportSize({ width: 380, height: 700 });
  await page.addInitScript(
    ({ snapshot, saved }) => {
      const w = window as any;
      w.fixture = snapshot;
      w.saved = saved;
      w.reads = [];
      w.details = [];
      w.copied = [];
      w.opened = [];
      w.cardCalls = [];
      const bump = () => {
        w.fixture.version++;
        w.fixture.bookmarkStamp = String(Number(w.fixture.bookmarkStamp) + 1);
        w.fixture.bookmarked = Object.fromEntries(
          w.fixture.sessions.map((s: any) => [
            s.id,
            w.saved.filter((b: any) => b.sessionId === s.id).map((b: any) => b.eventId),
          ]),
        );
        w.publish?.(structuredClone(w.fixture));
        return structuredClone(w.fixture);
      };
      w.bump = bump;
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string, p: any = {}) => {
          w.details.push({ id, ...p });
          const s = w.fixture.sessions.find((s: any) => s.id === id);
          return structuredClone({ ...s, events: p.reach ? s.events : s.events.slice(-1) });
        },
        visit: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        search: async () => [],
        subscribe: (cb: any) => {
          w.publish = cb;
          return () => {};
        },
        bookmarks: async (q: any = {}) => {
          w.reads.push(q);
          if (w.failRead) throw new Error('북마크를 읽지 못했어요');
          const all = w.saved
            .filter((b: any) => !q.sessionIds || q.sessionIds.includes(b.sessionId))
            .sort((a: any, b: any) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
          const start = q.before ? all.findIndex((b: any) => b.id === q.before.id) + 1 : 0;
          const end = start + (q.limit ?? 50);
          return structuredClone({
            bookmarks: all.slice(start, end),
            total: all.length,
            more: end < all.length,
          });
        },
        bookmarkNote: async (id: string, note: string) => {
          if (w.failSave) throw new Error('메모 저장 실패');
          const b = w.saved.find((b: any) => b.id === id);
          b.note = note;
          bump();
          return structuredClone(b);
        },
        unbookmark: async (id: string) => {
          w.saved = w.saved.filter((b: any) => b.id !== id);
          return bump();
        },
        patch: async (id: string, p: any) => {
          Object.assign(
            w.fixture.sessions.find((s: any) => s.id === id),
            p,
          );
          return bump();
        },
        copyText: async (s: string) => {
          w.copied.push(s);
        },
        openLink: async (url: string) => {
          w.opened.push(url);
        },
        card: async (what: string) => {
          w.cardCalls.push(what);
        },
        onCard: (cb: any) => {
          setTimeout(() => cb({ id: 'demo:0', news: false }), 20);
          return () => {};
        },
        terminals: async () => ({}),
      };
      localStorage.setItem('office:onboarding:v1:live', 'seen');
    },
    { snapshot, saved },
  );
  await page.goto(`/${opts.english ? '?lang=en' : '?lang=ko'}${opts.popup ? '#card' : ''}`);
  if (!opts.popup) await page.locator('.office-pet[data-session-id="demo:0"]').click();
  const card = page.locator('.inspector');
  await expect(card).toBeVisible();
  await card.getByRole('tab', { name: opts.english ? 'Notes' : '기억 메모', exact: true }).click();
  return card;
}

for (const popup of [false, true]) {
  test(`Saved markdown shares conversation styles without breaking a narrow ${popup ? 'popup' : 'panel'}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const card = await memory(page, { popup, count: 3, markdown: true });
    if (popup) await page.setViewportSize({ width: 380, height: 480 });
    const saved = card.locator('.bookmark-card').first();
    const text = saved.locator('.bookmark-text');
    await expect(text.locator('h3')).toHaveText('저장한 결정');
    await expect(text.locator('strong')).toHaveText('강조');
    await expect(text.locator('ul > li')).toHaveCount(2);
    await expect(text.locator('table td')).toHaveCount(2);
    await expect(text.locator('pre code')).toContainText('const saved');
    await expect(text).toHaveClass(/is-collapsed/);
    await expect(saved.locator('.bookmark-context')).toHaveCount(0);
    await card.locator('#notes').fill('Keep my draft while reading');
    await saved.getByRole('button', { name: '저장한 대화 읽기', exact: true }).click();
    const reader = page.getByRole('dialog', { name: '저장한 대화 읽기' });
    await expect(reader).toBeVisible();
    const lines = reader.locator('.bookmark-timeline > li');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toContainText('요청 내용');
    await expect(lines.nth(1)).toContainText('진행 내용');
    await expect(lines.nth(2)).toContainText('저장한 결정');
    await expect(reader.locator('.message-user .message-meta b')).toHaveText('나');
    await expect(reader.locator('[data-saved="true"] .bookmark-saved-label')).toHaveText(
      '저장한 메시지',
    );
    const full = reader.locator('[data-saved="true"] .message-text');
    await expect(full.locator('strong')).toHaveText('강조');
    await expect(full.locator('table td')).toHaveCount(2);
    await expect(full.locator('pre code')).toContainText('const saved');
    await expect(reader.locator('.bookmark-reader-note strong')).toHaveText('덧붙인 강조');
    await expect(reader.locator('.bookmark-reader-note .message-text h3')).toHaveText(
      '덧붙인 제목',
    );
    const headingStyle = (el: HTMLElement) => {
      const s = getComputedStyle(el);
      return [s.fontSize, s.color];
    };
    expect(
      await reader.locator('.bookmark-reader-note .message-text h3').evaluate(headingStyle),
    ).toEqual(await full.locator('h3').evaluate(headingStyle));
    await expect(reader.locator('.bookmark-reader-note li')).toHaveText('메모 목록');
    await expect(reader.locator('img, script, a[href^="javascript:"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).unsafe)).toBeUndefined();
    await reader.getByRole('link', { name: '참고', exact: true }).click();
    expect(await page.evaluate(() => (window as any).opened)).toEqual([
      'https://example.com/bookmark',
    ]);
    expect(await full.locator('pre').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await reader.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const style = await full.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.fontFamily, s.fontSize, s.lineHeight, s.color];
    });
    expect(
      await reader.locator('.bookmark-reader-note .message-text').evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.fontFamily, s.fontSize, s.lineHeight, s.color];
      }),
    ).toEqual(style);
    const footer = await reader.locator('.bookmark-reader-actions').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(footer!.x + footer!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await reader.press('Escape');
    await expect(reader).toHaveCount(0);
    await expect(saved.locator('.bookmark-expand')).toBeFocused();
    await expect(card.locator('#notes')).toHaveValue('Keep my draft while reading');
    expect(await page.evaluate(() => (window as any).cardCalls)).not.toContain('close');
    await saved.getByRole('button', { name: '메시지 복사' }).click();
    expect(await page.evaluate(() => (window as any).copied)).toEqual([richBookmark]);
    await saved.locator('.bookmark-expand').click();
    await reader.getByRole('button', { name: '원문 대화로 이동', exact: true }).click();
    await expect(reader).toHaveCount(0);
    const original = card.locator('.conversation-message.is-focused .message-text');
    await expect(original.locator('strong')).toHaveText('강조');
    expect(
      await original.evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.fontFamily, s.fontSize, s.lineHeight, s.color];
      }),
    ).toEqual(style);
    if (!popup) {
      await page.getByRole('button', { name: '기억 서랍', exact: true }).click();
      await page.getByRole('tab', { name: '북마크', exact: true }).click();
      const global = page.locator('.memory-page .bookmark-card').filter({ hasText: '저장한 결정' });
      await global.locator('.bookmark-expand').click();
      await expect(reader.locator('.bookmark-timeline > li')).toHaveCount(3);
      await reader.getByRole('button', { name: '목록으로 돌아가기' }).click();
      await expect(reader).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}

for (const popup of [false, true]) {
  test(`Memory combines manual notes and this colleague's bookmarks (${popup ? 'popup' : 'panel'})`, async ({
    page,
  }) => {
    const card = await memory(page, { popup });
    const cards = card.locator('.bookmark-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('저장한 결정 1');
    await expect(cards.last()).toContainText('덧붙인 메모');
    await expect(card.locator('#notes')).toHaveValue('직접 쓴 업무 메모');
    await expect(card.getByText('다른 동료의 북마크')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).reads[0].sessionIds)).toEqual(['demo:0']);
    await card.locator('#notes').fill('작성 중인 메모');
    await cards.first().getByRole('button', { name: '메모 추가', exact: true }).click();
    await cards.first().getByRole('textbox', { name: '메모 고치기' }).fill('다음에 확인할 내용');
    await cards.first().getByRole('button', { name: '저장', exact: true }).click();
    await expect(cards.first().locator('.bookmark-note .message-text')).toHaveText(
      '다음에 확인할 내용',
    );
    await expect(card.locator('#notes')).toHaveValue('작성 중인 메모');
    await cards.first().getByRole('button', { name: '메시지 복사' }).click();
    expect(await page.evaluate(() => (window as any).copied)).toEqual(['저장한 결정 1']);
    await cards.first().getByRole('button', { name: '북마크 해제' }).click();
    await expect(cards).toHaveCount(1);
    await expect(card.getByText('1개의 북마크', { exact: true })).toBeVisible();
    await expect(card.locator('#notes')).toHaveValue('작성 중인 메모');
    await card.getByRole('button', { name: '메모 저장', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).fixture.sessions[0].notes))
      .toBe('작성 중인 메모');
    await cards.first().getByRole('button', { name: '원문 대화로 이동', exact: true }).click();
    await expect(card.getByRole('tab', { name: '대화', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(card.locator('.conversation-message.is-focused')).toContainText('저장한 결정 0');
    expect(
      await page.evaluate(() => (window as any).details.some((p: any) => p.reach === 'saved-0')),
    ).toBe(true);
  });
}

test('The reader keeps a saved copy when its original run is missing and closes on privacy changes', async ({
  page,
}) => {
  await memory(page, { count: 3, markdown: true });
  await page.evaluate(() => {
    const w = window as any;
    w.saved.find((b: any) => b.eventId === 'saved-2').sessionId = 'missing-run';
    w.bump();
  });
  await page.getByRole('button', { name: '기억 서랍', exact: true }).click();
  await page.getByRole('tab', { name: '북마크', exact: true }).click();
  const saved = page.locator('.memory-page .bookmark-card').filter({ hasText: '저장한 결정' });
  await saved.locator('.bookmark-expand').click();
  const reader = page.getByRole('dialog', { name: '저장한 대화 읽기' });
  await expect(reader.locator('.bookmark-timeline > li')).toHaveCount(3);
  await expect(
    reader.getByText('원본 대화가 더 이상 보이지 않아요 · 저장해 둔 사본이에요'),
  ).toBeVisible();
  await expect(reader.getByRole('button', { name: '원문 대화로 이동' })).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.fixture.preferences.privacy = true;
    w.bump();
  });
  await expect(reader).toHaveCount(0);
  await expect(page.locator('.bookmark-timeline')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '저장한 대화 읽기' })).toHaveCount(0);
});

test('The reader shows a bookmarked user message once and restores the draft on backdrop close', async ({
  page,
}) => {
  const card = await memory(page, { popup: true, count: 3, markdown: true });
  await card.locator('#notes').fill('Unsent note');
  // A saved user request has no earlier context, so it must stay a user bubble, not an answer.
  const saved = card
    .locator('.bookmark-card')
    .filter({ has: page.locator('.bookmark-text strong', { hasText: '요청 내용' }) });
  await saved.locator('.bookmark-expand').click();
  const reader = page.getByRole('dialog', { name: '저장한 대화 읽기' });
  await expect(reader.locator('.bookmark-timeline > li')).toHaveCount(1);
  await expect(reader.locator('.message-user[data-saved="true"] .message-meta b')).toHaveText('나');
  await page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } });
  await expect(reader).toHaveCount(0);
  await expect(card.locator('#notes')).toHaveValue('Unsent note');
  expect(await page.evaluate(() => (window as any).cardCalls)).not.toContain('close');
});

test('Grouped colleague bookmarks include earlier runs and open that run', async ({ page }) => {
  const card = await memory(page, { popup: true, grouped: true });
  await expect(card.locator('.bookmark-card')).toHaveCount(3);
  await expect(card.locator('.bookmark-card').first()).toContainText('이 동료의 지난 실행 메모');
  expect((await page.evaluate(() => (window as any).reads[0].sessionIds)).sort()).toEqual([
    'demo:0',
    'prior-run',
  ]);
  await card
    .locator('.bookmark-card')
    .first()
    .getByRole('button', { name: '원문 대화로 이동', exact: true })
    .click();
  await expect(card.locator('.conversation-message.is-focused')).toContainText(
    '이 동료의 지난 실행 메모',
  );
});

test('Pages retain all loaded bookmarks after another window adds one, without losing a note draft', async ({
  page,
}) => {
  const card = await memory(page, { count: 51 });
  await expect(card.locator('.bookmark-card')).toHaveCount(50);
  await card
    .locator('.inspector-bookmarks')
    .getByRole('button', { name: '더 보기', exact: true })
    .click();
  await expect(card.locator('.bookmark-card')).toHaveCount(51);
  expect(await page.evaluate(() => (window as any).reads.at(-1).sessionIds)).toEqual(['demo:0']);
  await card.locator('#notes').fill('지금 쓰는 메모');
  await page.evaluate(() => {
    const w = window as any;
    w.saved.push({
      ...w.saved[0],
      id: 'new-save',
      eventId: 'new-event',
      text: '다른 창에서 저장',
      createdAt: Date.now() + 5000,
    });
    w.bump();
  });
  // The reread retains the old loaded depth; the new entry goes first, the last needs one more page.
  await expect(card.locator('.bookmark-card').first()).toContainText('다른 창에서 저장');
  await expect(card.locator('.bookmark-card')).toHaveCount(51);
  await card
    .locator('.inspector-bookmarks')
    .getByRole('button', { name: '더 보기', exact: true })
    .click();
  await expect(card.locator('.bookmark-card')).toHaveCount(52);
  await expect(card.locator('#notes')).toHaveValue('지금 쓰는 메모');
  await card.getByRole('tab', { name: '대화', exact: true }).click();
  await card.getByRole('tab', { name: '기억 메모', exact: true }).click();
  await expect(card.locator('#notes')).toHaveValue('지금 쓰는 메모');
});

test('Privacy hides saved messages, annotations and manual notes in the small popup', async ({
  page,
}) => {
  const card = await memory(page, { popup: true, privacy: true });
  await expect(card.locator('.privacy-placeholder')).toBeVisible();
  await expect(card.locator('.bookmark-card')).toHaveCount(0);
  await expect(card.locator('#notes')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).reads)).toEqual([]);
  for (const text of ['직접 쓴 업무 메모', '저장한 결정 0', '덧붙인 메모'])
    await expect(card.getByText(text, { exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '메시지 복사' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '메모 추가', exact: true })).toHaveCount(0);
});

test('Empty memory explains how to bookmark and English labels are localized', async ({ page }) => {
  const card = await memory(page, { popup: true, count: 0, english: true });
  await expect(card.getByRole('heading', { name: 'Your notes' })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Saved conversations' })).toBeAttached();
  await expect(card.getByText('No bookmarked messages yet')).toBeAttached();
  await expect(
    card.getByText(
      'Press the bookmark button next to a message in a conversation to collect it here.',
    ),
  ).toBeAttached();
});

test('Failed bookmark note save keeps the editor and draft, then can retry', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const card = await memory(page, { popup: true });
  const first = card.locator('.bookmark-card').first();
  await first.getByRole('button', { name: '메모 추가', exact: true }).click();
  await first.getByRole('textbox').fill('놓치면 안 되는 메모');
  await page.evaluate(() => ((window as any).failSave = true));
  await first.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('메모 저장 실패');
  await expect(first.getByRole('textbox')).toHaveValue('놓치면 안 되는 메모');
  await page.evaluate(() => ((window as any).failSave = false));
  await first.getByRole('button', { name: '저장', exact: true }).click();
  await expect(first.locator('.bookmark-note .message-text')).toHaveText('놓치면 안 되는 메모');
  expect(errors).toEqual([]);
});
