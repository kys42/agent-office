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
              { id: 'tool', kind: 'tool', at: Date.now(), text: '합성 도구 기록' },
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
test('conversation renders before slow destination discovery and remains readable on lookup failure', async ({
  page,
}) => {
  await mock(page);
  let destination: import('@playwright/test').Route | undefined;
  await page.route('**/mobile/api/targets', (route) => {
    destination = route;
  });
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await expect(page.getByText('작업을 확인해줘', { exact: true })).toBeVisible();
  await expect.poll(() => !!destination).toBe(true);
  await destination!.fulfill({ status: 503, json: {} });
  await expect(page.getByText('전송 대상을 확인하지 못했어요.', { exact: false })).toBeVisible();
  await expect(page.getByText('작업을 확인해줘', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '메시지 보내기', exact: true })).toBeDisabled();
});

test('denied visibility cannot be undone by a late successful conversation response', async ({
  page,
}) => {
  await mock(page);
  let conversation: import('@playwright/test').Route | undefined;
  await page.route('**/mobile/api/detail', (route) => {
    conversation = route;
  });
  await page.route('**/mobile/api/targets', (route) => route.fulfill({ status: 403, json: {} }));
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await expect(page.locator('.chat [role="alert"]')).toBeVisible();
  await expect.poll(() => !!conversation).toBe(true);
  await conversation!.fulfill({
    json: {
      id: local.id,
      older: false,
      events: [{ id: 'private', kind: 'user', at: 1, text: '이미 가린 대화의 늦은 응답' }],
    },
  });
  await expect(page.getByText('이미 가린 대화의 늦은 응답')).toHaveCount(0);
});

test('mobile can read beyond 1,000 records in a bounded window and jump back to live', async ({
  page,
}) => {
  test.setTimeout(60000);
  await mock(page);
  let latestReads = 0;
  await page.route('**/mobile/api/detail', async (route) => {
    const { before } = route.request().postDataJSON();
    if (!before) latestReads++;
    const end = before ? Number(before.id) : 1200;
    const start = Math.max(0, end - 40);
    return route.fulfill({
      json: {
        id: local.id,
        older: start > 0,
        events: Array.from({ length: end - start }, (_, i) => ({
          id: String(start + i),
          at: start + i,
          kind: 'user',
          text: `합성 기록 ${start + i}`,
        })),
      },
    });
  });
  await login(page);
  await page.locator('.agent').filter({ hasText: local.name }).click();
  await expect(page.locator('.message').first()).toHaveAttribute('data-event-id', '1160');
  for (let start = 1120; start >= 0; start -= 40) {
    await page.getByRole('button', { name: '이전 대화 보기', exact: true }).click();
    await expect(page.locator('.message').first()).toHaveAttribute('data-event-id', String(start));
    expect(await page.locator('.message').count()).toBeLessThanOrEqual(400);
  }
  await expect(page.getByRole('button', { name: '이전 대화 보기', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '최신 대화로 돌아가기' })).toBeVisible();
  const before = latestReads;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // Historical pages stay put across a scheduled refresh; destination checks remain active.
  await expect(page.locator('.message').first()).toHaveAttribute('data-event-id', '0');
  await page.getByRole('button', { name: '최신 대화로 돌아가기' }).click();
  await expect(page.locator('.message').first()).toHaveAttribute('data-event-id', '1160');
  await expect(page.locator('.message')).toHaveCount(40);
  expect(latestReads).toBe(before + 1);
  await expect(page.getByRole('button', { name: '최신 대화로 돌아가기' })).toHaveCount(0);
  await page.screenshot({ path: '.local/mobile-history-latest.png' });
});

test('a late roster refresh cannot restore colleagues after a newer privacy response', async ({
  page,
}) => {
  await mock(page);
  await login(page);
  let first: import('@playwright/test').Route | undefined;
  let calls = 0;
  await page.route('**/mobile/api/state', async (route) => {
    if (++calls === 1) {
      first = route;
      return;
    }
    return route.fulfill({
      json: {
        agents: [],
        privacy: true,
        sendEnabled: false,
        at: Date.now(),
        lastSync: Date.now(),
      },
    });
  });
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect.poll(() => !!first).toBe(true);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByText('컴퓨터에서 개인정보 가림을 해제하면')).toBeVisible();
  // Aborted network delivery must also be ignored if a transport races with abort.
  await first!
    .fulfill({
      json: {
        agents: [local],
        privacy: false,
        sendEnabled: true,
        at: Date.now() - 1000,
        lastSync: Date.now(),
      },
    })
    .catch(() => {});
  await expect(page.locator('.agent')).toHaveCount(0);
  await expect(page.getByText('컴퓨터에서 개인정보 가림을 해제하면')).toBeVisible();
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
  await expect(page.locator('.message-body img')).toHaveCount(0);
  await expect(page.locator('.message-body script')).toHaveCount(0);
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

test('mobile reading labels and controls remain legible in light and dark English layouts', async ({
  browser,
}) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      locale: 'en-US',
      colorScheme,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      await mock(page);
      const readable = async (selector: string, pseudo?: string) => {
        const values = await page
          .locator(selector)
          .first()
          .evaluate((el, pseudo) => {
            const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
            const style = getComputedStyle(el, pseudo);
            const foreground = rgb(style.color);
            const layers: number[][] = [];
            for (let node: Element | null = el; node; node = node.parentElement)
              layers.unshift(rgb(getComputedStyle(node).backgroundColor));
            let background = [255, 255, 255];
            for (const layer of layers) {
              const alpha = layer[3] ?? 1;
              background = background.map((v, i) => layer[i] * alpha + v * (1 - alpha));
            }
            const luminance = (color: number[]) =>
              color
                .slice(0, 3)
                .map((v) => {
                  const n = v / 255;
                  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
            const a = luminance(foreground),
              b = luminance(background);
            return {
              ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
              size: parseFloat(style.fontSize),
            };
          }, pseudo);
        expect(values.ratio, `${colorScheme} ${selector} contrast`).toBeGreaterThanOrEqual(4.5);
        expect(values.size, `${selector} text size`).toBeGreaterThanOrEqual(12);
      };
      await page.goto('/mobile.html');
      await page.locator('#code').fill('synthetic-code');
      await readable('.login small');
      await readable('.primary');
      await page.locator('.primary').click();
      await expect(page.locator('.agent')).toHaveCount(2);
      await readable('.agent-project');
      await readable('.state');
      await page.locator('.agent').filter({ hasText: local.name }).click();
      await expect(page.locator('.message')).not.toHaveCount(0);
      await readable('.message-meta');
      await readable('.send-reason');
      await readable('textarea', '::placeholder');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      await page.screenshot({ path: `.local/mobile-readable-${colorScheme}.png` });
    } finally {
      await context.close();
    }
  }
});
