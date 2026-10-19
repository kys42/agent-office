import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

async function office(page: Page) {
  await page.setViewportSize({ width: 480, height: 760 });
  await page.addInitScript((snapshot) => {
    const w = window as any;
    w.snapshot = snapshot;
    w.calls = [];
    w.earlyRecord = false;
    w.failSend = false;
    w.partial = false;
    w.draft = '터미널에서 작성하던 글';
    w.office = {
      snapshot: async () => structuredClone(snapshot),
      detail: async (id: string) => structuredClone(snapshot.sessions.find((s) => s.id === id)),
      visit: async () => structuredClone(snapshot),
      artifacts: async () => [],
      terminalSend: async () => true,
      terminals: async (ids: string[]) =>
        Object.fromEntries(
          ids.map((id) => [id, { kind: 'orca', status: 'idle', canSend: true, canFocus: true }]),
        ),
      subscribe: (cb: any) => {
        w.publish = () => cb(structuredClone(snapshot));
        return () => {};
      },
      onCard: (cb: any) => {
        w.show = (id: string | null) => cb(id ? { id, news: false } : null);
        setTimeout(() => w.show(snapshot.sessions[0].id), 20);
        return () => {};
      },
      card: async (action: string) => {
        if (action === 'close') w.show(null);
      },
      jump: async (id: string) => {
        w.calls.push(['jump', id]);
        return { action: 'focused', text: '터미널로 이동' };
      },
      inspectDraft: async (id: string) => {
        w.calls.push(['inspect', id]);
        if (!w.draft) return null;
        return {
          status: 'needs-confirm',
          agent: 'Claude',
          draft: w.draft,
          ...(w.partial && { partial: true }),
        };
      },
      send: async (id: string, text: string, options?: { replaceDraft?: string }) => {
        w.calls.push(['send', id, text, options?.replaceDraft ?? null]);
        if (w.failSend && !options?.replaceDraft)
          throw new Error('입력창에 이미 글이 있어요. 터미널을 확인한 뒤 보내 주세요.');
        if (options?.replaceDraft && options.replaceDraft !== w.draft)
          return { status: 'needs-confirm', agent: 'Claude', draft: w.draft, changed: true };
        if (w.earlyRecord) {
          const s = snapshot.sessions.find((s) => s.id === id)!;
          s.events.push({ id: 'early', kind: 'user', text, at: Date.now(), sourceRef: 'fixture' });
          s.updatedAt = Date.now();
          snapshot.version++;
          w.publish();
          await new Promise<void>((resolve) => (w.finish = resolve));
        }
        return {
          status: 'sent',
          message: '보냈어요',
          ...(options?.replaceDraft && { cleared: true }),
        };
      },
    };
  }, demoSnapshot());
  await page.goto('/#card');
  await expect(page.locator('.terminal-send-chat textarea')).toBeVisible();
}

const input = (page: Page) => page.locator('.terminal-send-chat textarea');

test('a transcript arriving before a slow send reply never leaves a duplicate temporary message', async ({
  page,
}) => {
  await page.clock.setFixedTime(Date.now());
  await office(page);
  await page.evaluate(() => ((window as any).earlyRecord = true));
  await input(page).fill('이미 터미널에 도착한 말');
  await input(page).press('Enter');
  await expect(page.locator('.conversation-message').last()).toContainText(
    '이미 터미널에 도착한 말',
  );
  // The reply arrives well after the old matcher’s 10-second allowance.
  await page.clock.setFixedTime(Date.now() + 30_000);
  await page.evaluate(() => (window as any).finish());
  await expect(input(page)).toHaveValue('');
  await expect(page.locator('.message-pending')).toHaveCount(0);
  await expect(
    page.locator('.conversation-message').filter({ hasText: '이미 터미널에 도착한 말' }),
  ).toHaveCount(1);
});

test('a retained request settles a temporary message even after leaving the raw source window', async ({
  page,
}) => {
  await office(page);
  await input(page).fill('발췌 기록에서 확인할 말');
  await input(page).press('Enter');
  await expect(page.locator('.message-pending')).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as any;
    const s = w.snapshot.sessions[0];
    w.snapshot.notices.push({
      ...w.snapshot.notices[0],
      id: 'retained',
      sessionId: s.id,
      eventId: 'retained-user',
      kind: 'request',
      phase: undefined,
      text: '발췌 기록에서 확인할 말',
      at: Date.now(),
      receivedAt: Date.now(),
      version: 'v1',
      seenAt: null,
      viewedAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
    });
    w.snapshot.version++;
    w.publish();
  });
  await expect(page.locator('.message-pending')).toHaveCount(0);
  await expect(
    page.locator('.conversation-message').filter({ hasText: '발췌 기록에서 확인할 말' }),
  ).toHaveCount(1);
});

test('temporary sent receipts look normal and can be hidden individually without withdrawing or sending again', async ({
  page,
}) => {
  await office(page);
  for (const text of ['첫 보낸 말', '둘째 보낸 말']) {
    await input(page).fill(text);
    await input(page).press('Enter');
    await expect(input(page)).toHaveValue('');
  }
  const pending = page.locator('.message-pending');
  await expect(pending).toHaveCount(2);
  await expect(pending.first()).toContainText('보냄 · 대화 기록 확인 중');
  expect(
    await pending
      .first()
      .locator('.message-bubble')
      .evaluate((el) => getComputedStyle(el).opacity),
  ).toBe('1');
  await pending.first().getByRole('button', { name: '보낸 메시지 임시 표시 숨기기' }).click();
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText('둘째 보낸 말');
  expect(
    (await page.evaluate(() => (window as any).calls)).filter((c: any[]) => c[0] === 'send'),
  ).toHaveLength(2);
  await page.evaluate(() => (window as any).show(null));
  await page.evaluate(() => (window as any).show((window as any).snapshot.sessions[0].id));
  await expect(pending).toHaveCount(1);
});

test('an occupied-input error offers the freshly read draft; replacement requires an explicit click', async ({
  page,
}) => {
  await office(page);
  await page.setViewportSize({ width: 380, height: 480 });
  await page.evaluate(() => ((window as any).failSend = true));
  await input(page).fill('새로 보낼 말');
  await input(page).press('Enter');
  const confirm = page.locator('.draft-confirm');
  await expect(confirm).toContainText('입력창에 이미 글이 있어요');
  await expect(confirm.locator('pre')).toHaveText('터미널에서 작성하던 글');
  await expect(input(page)).toHaveValue('새로 보낼 말');
  await expect(page.locator('.message-pending')).toHaveCount(0);
  const action = confirm.getByRole('button', { name: '지우고 내 글 보내기' });
  const bounds = (await action.boundingBox())!;
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(480);
  expect(
    (await page.evaluate(() => (window as any).calls)).filter((c: any[]) => c[0] === 'send'),
  ).toHaveLength(1);
  await confirm.getByRole('button', { name: '지우고 내 글 보내기' }).click();
  await expect(input(page)).toHaveValue('');
  expect(
    (await page.evaluate(() => (window as any).calls)).filter((c: any[]) => c[0] === 'send').at(-1),
  ).toEqual(['send', 'demo:0', '새로 보낼 말', '터미널에서 작성하던 글']);
});

test('a changed terminal draft is shown again and a partial draft only offers the terminal', async ({
  page,
}) => {
  await office(page);
  await page.evaluate(() => ((window as any).failSend = true));
  await input(page).fill('내가 보낼 말');
  await input(page).press('Enter');
  const confirm = page.locator('.draft-confirm');
  await expect(confirm).toBeVisible();
  await page.evaluate(() => ((window as any).draft = '터미널에서 바뀐 글'));
  await confirm.getByRole('button', { name: '지우고 내 글 보내기' }).click();
  await expect(confirm.locator('pre')).toHaveText('터미널에서 바뀐 글');
  await expect(input(page)).toHaveValue('내가 보낼 말');
  await confirm.getByRole('button', { name: '취소', exact: true }).click();
  await page.evaluate(() => ((window as any).partial = true));
  await input(page).press('Enter');
  await expect(confirm.getByRole('button', { name: '지우고 내 글 보내기' })).toHaveCount(0);
  await confirm.getByRole('button', { name: '터미널로 이동' }).click();
  expect(
    (await page.evaluate(() => (window as any).calls)).some((c: any[]) => c[0] === 'jump'),
  ).toBe(true);
});

test('a failed inspection preserves the original send error and the draft', async ({ page }) => {
  await office(page);
  await page.evaluate(() => {
    (window as any).failSend = true;
    (window as any).draft = '';
  });
  await input(page).fill('남겨 둘 글');
  await input(page).press('Enter');
  await expect(page.getByRole('alert')).toContainText('입력창에 이미 글이 있어요');
  await expect(input(page)).toHaveValue('남겨 둘 글');
  await expect(page.locator('.draft-confirm')).toHaveCount(0);
});
