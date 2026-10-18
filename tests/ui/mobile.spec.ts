import { test, expect } from '@playwright/test';
import type { MobileAgent } from '../../src/shared/mobile';
const local: MobileAgent = {
  id: 'codex:local',
  name: '모바일 연결 점검',
  provider: 'codex',
  project: 'Agent Office',
  officeId: 'local',
  office: 'MacBook Air',
  tags: [],
  status: 'work',
  updatedAt: Date.now(),
  preview: '모바일에서 진행 상황과 대화를 확인하고 있습니다.',
  stale: false,
  archived: false,
};
const remote: MobileAgent = {
  ...local,
  id: 'remote-office:synthetic',
  name: '안드로이드 화면 개선',
  provider: 'claude',
  project: 'TaskDeck',
  officeId: 'mini',
  office: 'Mac mini',
  tags: ['개발'],
  status: 'call',
  preview: '다음 작업 방향을 기다리고 있어요.',
};
async function mock(
  page: import('@playwright/test').Page,
  options: { failSend?: boolean; privacy?: boolean } = {},
) {
  let auth = false;
  const sends: any[] = [];
  let receipts = 0;
  await page.route('**/mobile/api/*', async (route) => {
    const name = route.request().url().split('/').at(-1),
      input = route.request().postDataJSON();
    const reply = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (name === 'login') {
      auth = true;
      return reply({ ok: true });
    }
    if (!auth) return reply({}, 401);
    if (name === 'state')
      return reply({
        agents: options.privacy ? [] : [local, remote],
        privacy: !!options.privacy,
        sendEnabled: true,
        at: Date.now(),
        lastSync: Date.now(),
      });
    if (name === 'targets')
      return reply({ [input.ids[0]]: { canSend: true, desktop: true, queues: false } });
    if (name === 'detail')
      return reply({
        id: input.id,
        older: !input.before,
        events: input.before
          ? [{ id: 'older', kind: 'user', at: Date.now() - 20000, text: '이전 메시지' }]
          : [
              { id: 'a', kind: 'user', at: Date.now() - 10000, text: '작업을 확인해줘' },
              {
                id: 'b',
                kind: 'assistant',
                phase: 'commentary',
                at: Date.now(),
                text: '진행 중입니다.\n\n- API 확인\n- 화면 검증\n\n<script>alert(1)</script>\n![remote](https://example.com/private.png)',
              },
              ...(input.tools
                ? [{ id: 'tool', kind: 'tool', at: Date.now(), text: '합성 도구 기록' }]
                : []),
            ],
      });
    if (name === 'send') {
      sends.push(input);
      if (options.failSend) return route.abort();
      return reply({ requestId: input.requestId, status: 'sent' });
    }
    if (name === 'receipt') {
      receipts++;
      return reply({ requestId: input.requestId, status: 'sent' });
    }
    if (name === 'logout') {
      auth = false;
      return reply({ ok: true });
    }
    return reply({}, 404);
  });
  return {
    sends,
    get receipts() {
      return receipts;
    },
  };
}
async function login(page: import('@playwright/test').Page) {
  await page.goto('/mobile.html');
  await page.getByLabel('접속 코드').fill('synthetic-code');
  await page.getByRole('button', { name: '오피스 연결' }).click();
  await expect(page.getByRole('heading', { name: '우리 오피스', exact: true })).toBeVisible();
}
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test('shared popup message expands, copies full text on HTTP and validates links', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = () => {
      (window as any).copied = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    };
  });
  await mock(page);
  const text =
    '**공통 메시지**\n\n[웹 링크](https://example.com/page) [불가](https://user:secret@example.com/)\n\n' +
    '긴 대화 내용 '.repeat(80);
  await page.route('**/mobile/api/detail', (route) =>
    route.fulfill({
      json: {
        id: local.id,
        older: false,
        events: [{ id: 'shared', kind: 'assistant', phase: 'final', at: 1, text }],
      },
    }),
  );
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await expect(page.locator('.conversation-message.category-reply')).toHaveCount(1);
  await expect(page.getByRole('link', { name: '웹 링크' })).toHaveAttribute(
    'href',
    'https://example.com/page',
  );
  await expect(page.getByRole('link', { name: '불가' })).toHaveCount(0);
  await page.getByRole('button', { name: /더 보기/ }).click();
  await expect(page.locator('.message-text')).toContainText('긴 대화 내용 '.repeat(80).trim());
  await page.getByRole('button', { name: '메시지 복사', exact: true }).click();
  expect(await page.evaluate(() => (window as any).copied)).toBe(text);
  await expect(page.getByRole('status')).toContainText('복사');
  await expect(page.locator('textarea')).toHaveCount(1);
});
test('shared mobile composer keeps Enter and IME as text, modifier Enter submits once', async ({
  page,
}) => {
  const f = await mock(page);
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  const input = page.getByLabel('메시지', { exact: true });
  await input.fill('한글');
  await input.press('Enter');
  await expect(input).toHaveValue('한글\n');
  await input.dispatchEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    isComposing: true,
    bubbles: true,
  });
  await input.dispatchEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    keyCode: 229,
    bubbles: true,
  });
  expect(f.sends).toHaveLength(0);
  await input.press('Control+Enter');
  await expect.poll(() => f.sends.length).toBe(1);
});
test('a late older page cannot bridge a gap after the latest page resets', async ({ page }) => {
  await mock(page);
  let advanced = false;
  let olderRequest: import('@playwright/test').Route | undefined;
  await page.route('**/mobile/api/detail', async (route) => {
    if (route.request().postDataJSON().before) {
      olderRequest = route;
      return;
    }
    return route.fulfill({
      json: {
        id: local.id,
        older: true,
        events: [
          {
            id: advanced ? 'new' : 'old',
            kind: 'user',
            at: advanced ? 200 : 40,
            text: advanced ? '연속성이 바뀐 최신 페이지' : '기존 페이지',
          },
        ],
      },
    });
  });
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await page.getByRole('button', { name: '이전 대화 보기', exact: true }).click();
  await expect.poll(() => !!olderRequest).toBe(true);
  advanced = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('연속성이 바뀐 최신 페이지', { exact: true })).toBeVisible();
  await olderRequest!.fulfill({
    json: {
      id: local.id,
      older: false,
      events: [{ id: 'ancient', kind: 'user', at: 1, text: '늦게 도착한 이전 페이지' }],
    },
  });
  await expect(page.getByRole('button', { name: '이전 대화 보기', exact: true })).toBeEnabled();
  await expect(page.getByText('늦게 도착한 이전 페이지', { exact: true })).toHaveCount(0);
});
test('a gap after backgrounding resets the latest page and preserves older-page access', async ({
  page,
}) => {
  await mock(page);
  let advanced = false;
  await page.route('**/mobile/api/detail', async (route) =>
    route.fulfill({
      json: {
        id: local.id,
        older: advanced,
        events: [
          {
            id: advanced ? 'new' : 'old',
            kind: 'user',
            at: advanced ? 100 : 1,
            text: advanced ? '한 페이지 이상 진행된 대화' : '처음 열었던 대화',
          },
        ],
      },
    }),
  );
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await expect(page.getByText('처음 열었던 대화', { exact: true })).toBeVisible();
  advanced = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('한 페이지 이상 진행된 대화', { exact: true })).toBeVisible();
  await expect(page.getByText('처음 열었던 대화', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '이전 대화 보기', exact: true })).toBeVisible();
});
test('remote sharing reduction replaces full history and failed refresh clears it', async ({
  page,
}) => {
  await mock(page);
  let reduced = false;
  let unavailable = false;
  await page.route('**/mobile/api/detail', async (route) => {
    if (unavailable) return route.fulfill({ status: 403, json: {} });
    return route.fulfill({
      json: {
        id: remote.id,
        older: false,
        events: [
          {
            id: reduced ? 'summary' : 'full',
            kind: 'user',
            at: 1,
            text: reduced ? '공유된 짧은 발췌' : '이전 공유 전문',
            excerpt: reduced,
          },
        ],
      },
    });
  });
  await login(page);
  await page.locator('.agent').filter({ hasText: remote.name }).click();
  await expect(page.getByText('이전 공유 전문', { exact: true })).toBeVisible();
  reduced = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('공유된 짧은 발췌', { exact: true })).toBeVisible();
  await expect(page.getByText('이전 공유 전문', { exact: true })).toHaveCount(0);
  unavailable = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('공유된 짧은 발췌', { exact: true })).toHaveCount(0);
});
test('mobile filters offices/projects, reads older conversation, hides tools and sends once', async ({
  page,
}) => {
  const f = await mock(page);
  await login(page);
  await page.getByLabel('사무실', { exact: true }).selectOption('mini');
  await expect(page.locator('.agent')).toHaveCount(1);
  await expect(page.locator('.agent')).toContainText('안드로이드');
  await page.getByLabel('사무실', { exact: true }).selectOption('');
  await page.getByLabel('프로젝트', { exact: true }).selectOption('Agent Office');
  await expect(page.locator('.agent')).toHaveCount(1);
  await page.locator('.agent').click();
  await expect(page.locator('.chat')).toBeVisible();
  await expect(page.locator('.roster')).toBeHidden();
  await expect(page.getByText('합성 도구 기록')).toHaveCount(0);
  await expect(page.locator('.message-text img')).toHaveCount(0);
  await expect(page.locator('.message-text script')).toHaveCount(0);
  await page.getByLabel('도구 기록', { exact: true }).check();
  await expect(page.getByText('합성 도구 기록')).toBeVisible();
  await page.getByRole('button', { name: '이전 대화 보기' }).click();
  await expect(page.getByText('이전 메시지')).toBeVisible();
  await page.getByLabel('메시지', { exact: true }).fill('모바일 합성 요청');
  await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('전송이 접수');
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0].id).toBe(local.id);
  await expect(page.getByLabel('메시지', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('an uncertain send survives reload and receipt lookup never dispatches again', async ({
  page,
}) => {
  const f = await mock(page, { failSend: true });
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await page.getByLabel('메시지', { exact: true }).fill('keep this draft');
  await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
  await expect(page.getByRole('button', { name: '접수 확인', exact: true })).toBeVisible();
  await page.reload();
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await expect(page.getByLabel('메시지', { exact: true })).toHaveValue('keep this draft');
  await expect(page.getByRole('button', { name: '메시지 보내기', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '접수 확인', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('전송이 접수');
  expect(f.sends).toHaveLength(1);
  expect(f.receipts).toBe(1);
});
test('privacy returns an empty mobile office and logout clears the session view', async ({
  page,
}) => {
  await mock(page, { privacy: true });
  await login(page);
  await expect(page.getByRole('heading', { name: '화면 내용 숨기기' })).toBeVisible();
  await expect(page.locator('.agent')).toHaveCount(0);
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('button', { name: '오피스 연결' })).toBeVisible();
});

test('late state responses cannot restore private content after logout', async ({ page }) => {
  await mock(page);
  await login(page);
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  await page.route('**/mobile/api/state', async (route) => {
    started();
    await wait;
    await route.fulfill({
      json: {
        agents: [local, remote],
        privacy: false,
        sendEnabled: true,
        at: Date.now(),
        lastSync: Date.now(),
      },
    });
  });
  await page.getByRole('button', { name: '새로고침' }).click();
  await ready;
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('button', { name: '오피스 연결' })).toBeVisible();
  release();
  await page.waitForTimeout(200);
  await expect(page.getByRole('button', { name: '오피스 연결' })).toBeVisible();
  await expect(page.locator('.agent')).toHaveCount(0);
});
test('late response from an old chat cannot erase the next pending send', async ({ page }) => {
  await mock(page);
  await login(page);
  const requests: import('@playwright/test').Route[] = [];
  await page.route('**/mobile/api/send', async (route) => {
    requests.push(route);
  });
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await page.getByLabel('메시지', { exact: true }).fill('first');
  await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole('button', { name: '목록으로' }).click();
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await page.getByRole('button', { name: '접수 확인', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('전송이 접수');
  await page.getByLabel('메시지', { exact: true }).fill('second');
  await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await requests[0].fulfill({
    json: { requestId: requests[0].request().postDataJSON().requestId, status: 'sent' },
  });
  await requests[1].abort();
  await expect(page.getByRole('button', { name: '접수 확인', exact: true })).toBeVisible();
  await page.reload();
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await expect(page.getByLabel('메시지', { exact: true })).toHaveValue('second');
  await expect(page.getByRole('button', { name: '메시지 보내기', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '접수 확인', exact: true })).toBeVisible();
});

test('turning tools off discards a late tools response and sends a fresh filtered request', async ({
  page,
}) => {
  await mock(page);
  let pending: import('@playwright/test').Route | undefined;
  const views: boolean[] = [];
  await page.route('**/mobile/api/detail', async (route) => {
    const { tools } = route.request().postDataJSON();
    views.push(tools);
    if (tools) {
      pending = route;
      return;
    }
    await route.fulfill({
      json: {
        id: local.id,
        older: false,
        events: [{ id: 'human', kind: 'user', at: 1, text: '요청만 표시' }],
      },
    });
  });
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await expect(page.getByText('요청만 표시')).toBeVisible();
  await page.getByLabel('도구 기록', { exact: true }).check();
  await expect.poll(() => !!pending).toBe(true);
  await page.getByLabel('도구 기록', { exact: true }).uncheck();
  await expect(page.getByText('요청만 표시')).toBeVisible();
  await pending!.fulfill({
    json: {
      id: local.id,
      older: false,
      events: [{ id: 'stale', kind: 'assistant', at: 1, text: '오래된 도구 보기 응답' }],
    },
  });
  await page.waitForTimeout(100);
  await expect(page.getByText('오래된 도구 보기 응답')).toHaveCount(0);
  expect(views).toEqual([false, true, false]);
});
test('long conversations stop paging at the text budget before the event count limit', async ({
  page,
}) => {
  await mock(page);
  await page.route('**/mobile/api/detail', (route) =>
    route.fulfill({
      json: {
        id: local.id,
        older: true,
        events: Array.from({ length: 40 }, (_, i) => ({
          id: String(i),
          kind: 'assistant',
          at: i,
          text: String(i).padStart(5, '0') + 'x'.repeat(63995),
        })),
      },
    }),
  );
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await expect(page.locator('.conversation-message')).toHaveCount(8);
  await expect(page.getByRole('button', { name: '대화 표시 한도에 도달했습니다' })).toBeDisabled();
});

test('a send finishing after switching tools refreshes the current view', async ({ page }) => {
  await mock(page);
  let send: import('@playwright/test').Route | undefined;
  const views: boolean[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/mobile/api/detail')) views.push(request.postDataJSON().tools);
  });
  await page.route('**/mobile/api/send', (route) => {
    send = route;
  });
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await page.getByLabel('메시지', { exact: true }).fill('합성 요청');
  await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
  await expect.poll(() => !!send).toBe(true);
  await page.getByLabel('도구 기록', { exact: true }).check();
  await expect(page.getByText('합성 도구 기록')).toBeVisible();
  await send!.fulfill({
    json: { requestId: send!.request().postDataJSON().requestId, status: 'sent' },
  });
  await expect.poll(() => views.length).toBe(3);
  expect(views).toEqual([false, true, true]);
  await expect(page.getByText('합성 도구 기록')).toBeVisible();
});
