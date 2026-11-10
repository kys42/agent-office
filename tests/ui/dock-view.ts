import { expect, type Locator, type Page } from '@playwright/test';

/** The dock's 보기 (view) menu: the pill's and the desk pet's one button for looks and more. */
export type DockView = '데스크 펫' | '책상 줄' | '바닥' | '쪼꼬미' | '큰 사무실 열기' | '설정';
const ROLE: Record<DockView, 'menuitemradio' | 'menuitemcheckbox' | 'menuitem'> = {
  '데스크 펫': 'menuitemradio',
  '책상 줄': 'menuitemradio',
  바닥: 'menuitemradio',
  쪼꼬미: 'menuitemcheckbox',
  '큰 사무실 열기': 'menuitem',
  설정: 'menuitem',
};
export const viewButton = (scope: Page | Locator) =>
  scope.getByRole('button', { name: '보기 바꾸기', exact: true });
export const viewMenu = (page: Page) => page.getByRole('menu', { name: '데스크 보기' });
export const viewItem = (page: Page, name: DockView) =>
  viewMenu(page).getByRole(ROLE[name], { name, exact: true });

/** Open the 보기 menu (from `scope`, the page by default) and pick an entry. */
export async function chooseView(page: Page, name: DockView, scope: Page | Locator = page) {
  await viewButton(scope).click();
  await expect(viewMenu(page)).toBeVisible();
  await viewItem(page, name).click();
  await expect(viewMenu(page)).toHaveCount(0);
}
