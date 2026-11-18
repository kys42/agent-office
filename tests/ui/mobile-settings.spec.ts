import { test, expect, type Page } from '@playwright/test';
import { demoSnapshot } from '../../src/lib/demo';

async function setup(page: Page, fail = false) {
  const snapshot = demoSnapshot();
  snapshot.preferences.locale = 'ko';
  await page.addInitScript(
    ({ snapshot, fail }) => {
      const w = window as any;
      w.failMobile = fail;
      w.mobileState = {
        enabled: true,
        running: true,
        address: '127.0.0.1',
        port: 4321,
        addresses: ['127.0.0.1'],
        url: 'http://127.0.0.1:4321',
        accessCode: 'synthetic-demo-code',
        error: null,
      };
      w.office = {
        snapshot: async () => structuredClone(snapshot),
        subscribe: () => () => {},
        mobile: async () => {
          if (w.failMobile) throw new Error('synthetic outage');
          return structuredClone(w.mobileState);
        },
        copyText: async (text: string) => {
          w.copied = text;
        },
      };
    },
    { snapshot, fail },
  );
  await page.goto('/?lang=ko#settings=mobile');
}

test('mobile settings stay discoverable after a failed load and can recover', async ({ page }) => {
  await setup(page, true);
  const section = page.locator('.mobile-settings');
  await expect(section.getByRole('alert')).toContainText('설정을 불러오지 못했어요');
  await page.evaluate(() => {
    (window as any).failMobile = false;
  });
  await section.getByRole('button', { name: '서버 상태 새로고침' }).click();
  await expect(section.getByText('이 컴퓨터에서 웹 서버 실행 중')).toBeVisible();
  await section.getByText('다른 기기에서 접속이 안 되나요?').click();
  await expect(section).toContainText('127.0.0.1은 이 컴퓨터에서만 열려요');
  await section.getByRole('button', { name: '주소 복사' }).click();
  await expect(section.getByText('복사했어요.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).copied)).toBe('http://127.0.0.1:4321');
});

test('refresh discovers a new tailnet interface and distinguishes enabled from running', async ({
  page,
}) => {
  await setup(page);
  const section = page.locator('.mobile-settings');
  await expect(section.getByText('이 컴퓨터에서 웹 서버 실행 중')).toBeVisible();
  await page.evaluate(() => {
    Object.assign((window as any).mobileState, {
      running: false,
      url: null,
      addresses: ['127.0.0.1', '100.64.0.10'],
      error: '합성 연결 중단',
    });
  });
  await section.getByRole('button', { name: '서버 상태 새로고침' }).click();
  await expect(section.getByText('켜짐으로 설정됐지만 웹 서버가 멈춰 있어요')).toBeVisible();
  await expect(section.getByLabel('모바일 접속 주소')).toBeEnabled();
  await section.getByLabel('모바일 접속 주소').selectOption('100.64.0.10');
  await section.getByText('다른 기기에서 접속이 안 되나요?').focus();
  await page.keyboard.press('Enter');
  await expect(section).toContainText('http://와 포트를 포함한 주소 전체');
  await page.setViewportSize({ width: 480, height: 900 });
  await section.screenshot({ path: '.local/mobile-settings-recovery.png' });
  expect(await section.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
});
