import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

async function desktop(page: Page) {
  const snapshot = demoSnapshot();
  snapshot.preferences.locale = 'ko';
  await page.addInitScript((s) => {
    localStorage.setItem('office:onboarding:v1:live', 'seen');
    const w = window as any;
    w.healthCalls = 0;
    w.snapshotCalls = 0;
    w.office = {
      snapshot: async () => {
        w.snapshotCalls++;
        if (w.failSnapshot) {
          w.failSnapshot--;
          throw new Error('연결 복구 중');
        }
        return structuredClone(s);
      },
      subscribe: (cb: any, _since: any, health: any) => {
        w.publish = cb;
        w.health = health;
        return () => {};
      },
      refresh: async () => structuredClone(s),
      appHealth: async () => {
        w.healthCalls++;
        if (w.failHealth) throw new Error('unavailable');
        return {
          version: '0.1.0',
          platform: 'darwin',
          arch: 'arm64',
          commit: 'a'.repeat(40),
          builtAt: null,
          signature: w.signature || 'developer-id',
          teamId: 'ABCDEFGHIJ',
        };
      },
      openPrivacy: async (pane: string) => (w.opened ??= []).push(pane),
      copyText: async (text: string) => {
        w.copied = text;
      },
    };
    w.gap = () =>
      w.publish({ kind: 'patch', epoch: s.epoch, base: s.version + 10, version: s.version + 11 });
  }, snapshot);
  await page.goto('/?lang=ko');
}

test('installation identity is on demand, permissions are explicit, support copy contains no sessions', async ({
  page,
}) => {
  await desktop(page);
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  expect(await page.evaluate(() => (window as any).healthCalls)).toBe(0);
  await page.getByRole('tab', { name: '연결', exact: true }).click();
  await expect(page.getByText('개발자 서명 확인됨', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).opened)).toBeUndefined();
  await page.getByText('쓰는 기능에 필요한 권한만', { exact: true }).click();
  await page.getByRole('button', { name: '파일 및 폴더 설정 열기' }).click();
  expect(await page.evaluate(() => (window as any).opened)).toEqual(['files']);
  await page.getByRole('button', { name: '앱 정보 복사' }).click();
  const report = JSON.parse(await page.evaluate(() => (window as any).copied));
  expect(Object.keys(report).sort()).toEqual(
    ['arch', 'builtAt', 'commit', 'platform', 'signature', 'teamId', 'version'].sort(),
  );
  await page.screenshot({ path: '.local/production-health-light.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1050, height: 780 });
  await page.screenshot({ path: '.local/production-health-dark.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('a failed patch resync retries by itself and the last office stays visible', async ({
  page,
}) => {
  await desktop(page);
  await expect(page.locator('.office-pet').first()).toBeVisible();
  await page.evaluate(() => {
    (window as any).failSnapshot = 1;
    (window as any).gap();
  });
  await expect(page.locator('.error-banner')).toContainText('연결 복구 중');
  await expect(page.locator('.office-pet').first()).toBeVisible();
  await expect(page.locator('.error-banner')).toHaveCount(0, { timeout: 5000 });
});

test('web polling reports an outage and clears it on an unchanged successful response', async ({
  page,
}) => {
  const snapshot = demoSnapshot();
  snapshot.preferences.locale = 'ko';
  let offline = false,
    initial = true;
  await page.addInitScript(() => localStorage.setItem('office:onboarding:v1:live', 'seen'));
  await page.route('**/api/rpc', async (route) => {
    const { method } = route.request().postDataJSON();
    if (method !== 'snapshot') return route.fulfill({ json: { result: [] } });
    if (offline) return route.fulfill({ status: 503, json: { error: 'offline' } });
    const result = initial ? snapshot : { unchanged: true };
    initial = false;
    await route.fulfill({ json: { result } });
  });
  await page.goto('/?lang=ko');
  await expect(page.locator('.office-pet').first()).toBeVisible();
  offline = true;
  await expect(page.locator('.error-banner')).toContainText('실시간 연결이 끊겼어요', {
    timeout: 8000,
  });
  await expect(page.locator('.office-pet').first()).toBeVisible();
  offline = false;
  await expect(page.locator('.error-banner')).toHaveCount(0, { timeout: 8000 });
});

test('installation failures can be retried and temporary builds stay distinct at narrow widths', async ({
  page,
}) => {
  await desktop(page);
  await page.evaluate(() => {
    (window as any).failHealth = true;
  });
  await page.getByRole('button', { name: '연결과 설정', exact: true }).click();
  await page.getByRole('tab', { name: '연결', exact: true }).click();
  await expect(page.getByText('설치 정보를 읽지 못했어요.')).toBeVisible();
  await page.evaluate(() => {
    (window as any).failHealth = false;
    (window as any).signature = 'ad-hoc';
  });
  await page.getByRole('button', { name: '다시 확인', exact: true }).click();
  await expect(page.getByText('임시 미리보기 빌드', { exact: true })).toBeVisible();
  const summary = page.locator('.app-health-permissions summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '파일 및 폴더 설정 열기' })).toBeVisible();
  await page.setViewportSize({ width: 480, height: 850 });
  await page.screenshot({ path: '.local/production-health-narrow.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('entering the demo cancels a queued live resync and ignores stale connection updates', async ({
  page,
}) => {
  await desktop(page);
  await expect(page.locator('.office-pet').first()).toBeVisible();
  await page.evaluate(() => {
    (window as any).failSnapshot = 10;
    (window as any).gap();
  });
  await expect(page.locator('.error-banner')).toBeVisible();
  await page.locator('.foot-demo').click();
  await expect(page.locator('.demo-banner')).toBeVisible();
  const calls = await page.evaluate(() => (window as any).snapshotCalls);
  await page.waitForTimeout(1300);
  expect(await page.evaluate(() => (window as any).snapshotCalls)).toBe(calls);
  await page.evaluate(() => (window as any).health('stale error'));
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test('desktop roster status, project names and conversation times remain readable in both themes', async ({
  page,
}) => {
  const readable = async (selector: string) => {
    const ratio = await page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        const rgba = (css: string) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data);
        };
        const layers: number[][] = [];
        for (let node: Element | null = el; node; node = node.parentElement)
          layers.unshift(rgba(getComputedStyle(node).backgroundColor));
        let bg = [255, 255, 255];
        for (const layer of layers)
          bg = bg.map((v, i) => (layer[i] * layer[3]) / 255 + v * (1 - layer[3] / 255));
        const lum = (c: number[]) =>
          c
            .slice(0, 3)
            .map((v) => {
              const n = v / 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            })
            .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
        const fg = lum(rgba(getComputedStyle(el).color)),
          back = lum(bg);
        return (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
      });
    expect(ratio, selector).toBeGreaterThanOrEqual(4.5);
  };
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/?demo&lang=ko');
    await expect(page.locator('.session-copy').first()).toBeVisible();
    await readable('.session-meta');
    await readable('.session-copy small');
    await page.screenshot({ path: `.local/roster-readable-${colorScheme}.png` });
    await page.getByRole('button', { name: '코코, 일하는 중', exact: true }).click();
    await expect(page.locator('.message-meta time').first()).toBeVisible();
    await page
      .locator('.inspector')
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await readable('.message-meta time');
    await page.screenshot({ path: `.local/desktop-readable-${colorScheme}.png` });
  }
});
