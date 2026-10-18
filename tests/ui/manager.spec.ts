import { test, expect } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import { managerSession } from '../../server/manager/projection';
import type { ManagerState } from '../../src/shared/manager';
const initial: ManagerState = {
  createdAt: Date.now(),
  settings: { provider: 'codex', schedule: { kind: 'off' }, notifications: true },
  running: false,
  ready: false,
  jobs: [],
  availability: { tmux: true, codex: true, claude: false },
};
async function setup(page: import('@playwright/test').Page, popup = false, unavailable = false) {
  const snapshot = demoSnapshot();
  snapshot.sessions.unshift(managerSession(initial));
  snapshot.notices = [];
  await page.addInitScript(
    ({ snapshot, initial }) => {
      const w = window as any;
      w.calls = [];
      w.managerState = initial;
      let subscriber: any;
      const manager = snapshot.sessions[0];
      const emit = () => {
        snapshot.version = (snapshot.version ?? 0) + 1;
        subscriber?.(structuredClone(snapshot));
        return structuredClone(snapshot);
      };
      const result = (text: string) => {
        const at = Date.now(),
          id = String(at);
        manager.events.push(
          { id: id + ':request', kind: 'user', text, at, sourceRef: id },
          {
            id: id + ':answer',
            kind: 'assistant',
            phase: 'final',
            text: '코코가 로그인 작업을 하고 있어요.',
            at: at + 1,
            sourceRef: id,
            rich: [{ type: 'briefing', at, total: 3, working: 2, attention: 1, results: 0 }],
          },
        );
        manager.updatedAt = at + 1;
        manager.revision = id;
        emit();
      };
      w.office = {
        cardState: async () => ({
          pinned: false,
          positionRemembered: false,
          target: { id: manager.id, news: false },
        }),
        card: async () => {},
        snapshot: async () => structuredClone(snapshot),
        detail: async (id: string) => ({
          ...structuredClone(snapshot.sessions.find((s) => s.id === id)),
          olderEvents: false,
          notices: [],
        }),
        visit: async () => emit(),
        artifacts: async () => [],
        subscribe: (fn: any) => {
          subscriber = fn;
          return () => {};
        },
        preferences: async (patch: object) => {
          Object.assign(snapshot.preferences, patch);
          return emit();
        },
        terminalSend: async () => true,
        terminals: async () => ({
          [manager.id]: {
            kind: 'manager',
            label: 'Office Manager',
            status: 'idle',
            canSend: w.managerState.ready,
            canFocus: false,
            queues: true,
          },
        }),
        send: async (_id: string, text: string) => {
          if (w.failSend) throw new Error('전송 실패');
          if (!w.managerState.ready) throw new Error('매니저 출근이 필요해요');
          w.calls.push({ action: 'chat', text });
          result(text);
          return { status: 'sent', message: '전송했어요' };
        },
        manager: async (request: any) => {
          w.calls.push(request);
          if (request.action === 'configure') w.managerState.settings = request.settings;
          if (request.action === 'start') {
            w.managerState.running = true;
            w.managerState.ready = true;
            manager.status = 'ready';
            emit();
          }
          if (request.action === 'stop') {
            w.managerState.running = false;
            w.managerState.ready = false;
            manager.status = 'sleep';
            emit();
          }
          if (request.action === 'summary' || request.action === 'chat')
            result(request.text ?? '지금 요약');
          return structuredClone(w.managerState);
        },
      };
    },
    { snapshot, initial },
  );
  if (unavailable)
    await page.addInitScript(() => {
      delete (window as any).office.manager;
    });
  await page.goto(popup ? '/#card' : '/');
  if (!popup) await page.getByRole('button', { name: '오피스 매니저', exact: true }).click();
}
test('Manager shares the ordinary card and composer, preserves failed drafts and displays validated cards', async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator('[data-project-key="office:manager-project"]')).toBeVisible();
  await page.getByRole('button', { name: '매니저 출근', exact: true }).click();
  const input = page.locator('.terminal-send textarea');
  await input.fill('로그인 작업하던 동료 찾아줘');
  await page.evaluate(() => {
    (window as any).failSend = true;
  });
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('전송 실패');
  await expect(input).toHaveValue('로그인 작업하던 동료 찾아줘');
  await page.evaluate(() => {
    (window as any).failSend = false;
  });
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(
    page.locator('.conversation-message').filter({ hasText: '코코가 로그인 작업' }),
  ).toBeVisible();
  await expect(page.locator('.manager-rich-card')).toContainText('조회 당시 상태');
  await page.getByRole('button', { name: '매니저 설정', exact: true }).click();
  await page.getByLabel('작업 요약 주기').selectOption('daily');
  await page.getByLabel('요약 시각').fill('10:30');
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  expect(await page.evaluate(() => (window as any).managerState.settings.schedule)).toEqual({
    kind: 'daily',
    time: '10:30',
  });
});
test('Demo manager settings never call the live manager', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '데모 둘러보기' }).click();
  await page.getByRole('button', { name: '오피스 매니저', exact: true }).click();
  const before = await page.evaluate(() => (window as any).calls.length);
  await expect(
    page.getByText('샘플 사무실에서는 실제 에이전트를 시작하지 않아요. 데모를 종료해 주세요.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '매니저 출근', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).calls.length)).toBe(before);
});
test('Manager native card uses the same draft, Enter send and narrow layout as colleagues', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 650 });
  await setup(page, true);
  await expect(page.locator('[data-asset-id="office-manager-armband-v1"]')).toBeVisible();
  const input = page.locator('.terminal-send textarea');
  await input.fill('닫아도 남을 초안');
  await page.reload();
  await expect(input).toHaveValue('닫아도 남을 초안');
  await page.getByRole('button', { name: '매니저 출근', exact: true }).click();
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(page.locator('.manager-rich-card')).toBeVisible();
  await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeInViewport();
  await page.screenshot({ path: '.local/manager-common-card.png' });
});

test('a stored manager without the desktop controller offers a desktop hint instead of start controls', async ({
  page,
}) => {
  await setup(page, true, true);
  await expect(page.getByText('데스크톱 앱에서 전담 매니저를 시작할 수 있어요.')).toBeVisible();
  await expect(page.getByRole('button', { name: '매니저 출근', exact: true })).toHaveCount(0);
});
