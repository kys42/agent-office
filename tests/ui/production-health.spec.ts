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

/**
 * WCAG contrast of an element's text against every background drawn under it. The canvas
 * resolves whatever the browser computes, including `color-mix()` results, to sRGB first.
 */
async function contrast(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const ctx = Object.assign(document.createElement('canvas'), {
        width: 1,
        height: 1,
      }).getContext('2d', { willReadFrequently: true })!;
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
      const fg = rgba(getComputedStyle(el).color);
      const alpha = fg[3] / 255;
      const ink = bg.map((v, i) => fg[i] * alpha + v * (1 - alpha));
      const lum = (c: number[]) =>
        c
          .slice(0, 3)
          .map((v) => {
            const n = v / 255;
            return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
          })
          .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
      const [hi, lo] = [lum(ink), lum(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`roster project names, status, conversation times and hints read at 4.5:1 in ${colorScheme}`, async ({
    page,
  }) => {
    const readable = async (selector: string) =>
      expect(await contrast(page, selector), `${colorScheme} ${selector}`).toBeGreaterThanOrEqual(
        4.5,
      );
    await page.emulateMedia({ colorScheme });
    await page.goto('/?demo&lang=ko');
    await expect(page.locator('.session-copy').first()).toBeVisible();
    await readable('.session-row:not(.selected) .session-meta');
    await readable('.session-row:not(.selected) .session-copy small');
    // Hints in empty fields are read too: --text-3 at full opacity, not the decorative --text-4.
    // The search field is tinted, so the hint is pinned to the token whose ratios
    // tests/text-contrast.test.ts checks, rather than to a ratio of its own.
    const hint = await page.locator('.roster-finder input').evaluate((el) => {
      const probe = el.parentElement!.appendChild(document.createElement('i'));
      probe.style.color = 'var(--text-3)';
      const token = getComputedStyle(probe).color;
      probe.remove();
      const style = getComputedStyle(el, '::placeholder');
      return { color: style.color, opacity: style.opacity, token };
    });
    expect(hint.color, `${colorScheme} search hint`).toBe(hint.token);
    expect(hint.opacity).toBe('1');
    await page.screenshot({ path: `.local/roster-readable-${colorScheme}.png` });
    await page.locator('.session-row').filter({ hasText: '코코' }).first().click();
    await expect(page.locator('.message-meta time').first()).toBeVisible();
    await page
      .locator('.inspector')
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await readable('.message-meta time');
    await page.screenshot({ path: `.local/desktop-readable-${colorScheme}.png` });
  });
}
