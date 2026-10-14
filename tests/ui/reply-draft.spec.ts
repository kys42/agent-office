import { expect, test, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

async function desktop(page: Page, initial = 'demo:0', blockedStorage = false) {
  await page.setViewportSize({ width: 480, height: 760 });
  await page.addInitScript(
    ({ snapshot, initial, blockedStorage }) => {
      const w = window as any;
      w.sends = [];
      w.failSend = false;
      w.deferSend = false;
      w.confirmSend = false;
      if (blockedStorage) {
        const set = Storage.prototype.setItem;
        const remove = Storage.prototype.removeItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith('office:reply-draft:')) throw new Error('Storage unavailable');
          return set.call(this, key, value);
        };
        Storage.prototype.removeItem = function (key) {
          if (key.startsWith('office:reply-draft:')) throw new Error('Storage unavailable');
          return remove.call(this, key);
        };
      }
      w.office = {
        snapshot: async () => structuredClone(snapshot),
        detail: async (id: string) => structuredClone(snapshot.sessions.find((s) => s.id === id)),
        visit: async () => structuredClone(snapshot),
        preferences: async () => structuredClone(snapshot),
        artifacts: async () => [],
        subscribe: () => () => {},
        terminalSend: async () => true,
        terminals: async (ids: string[]) =>
          Object.fromEntries(
            ids.map((id) => [id, { kind: 'tmux', status: 'idle', canSend: true }]),
          ),
        onCard: (cb: any) => {
          w.showCard = (id: string | null) => cb(id ? { id, news: false } : null);
          setTimeout(() => w.showCard(initial), 20);
          return () => {};
        },
        card: async (action: string) => {
          if (action === 'close') w.showCard(null);
        },
        send: async (id: string, text: string, options?: { replaceDraft?: string }) => {
          w.sends.push({ id, text });
          if (w.failSend) throw new Error('Terminal unavailable');
          if (w.confirmSend && options?.replaceDraft !== 'existing terminal text')
            return { status: 'needs-confirm', agent: 'Claude', draft: 'existing terminal text' };
          if (w.deferSend) await new Promise<void>((resolve) => (w.finishSend = resolve));
          return { status: 'sent', message: 'Sent' };
        },
      };
    },
    { snapshot: demoSnapshot(), initial, blockedStorage },
  );
  await page.goto('/#card');
  await expect(field(page)).toBeVisible();
}

const field = (page: Page) => page.locator('.terminal-send-chat textarea');
const key = (id = 'demo:0') => `office:reply-draft:v1:live:${id}`;
async function show(page: Page, id: string | null) {
  await page.evaluate((id) => (window as any).showCard(id), id);
  await expect(field(page)).toHaveCount(id ? 1 : 0);
}

test('closing and reopening the popup restores exact multiline drafts for each colleague', async ({
  page,
}) => {
  await desktop(page);
  const text = '  리뷰 반영 중\n- 표도 확인해 주세요\n';
  await field(page).fill(text);
  await show(page, null);
  await show(page, 'demo:0');
  await expect(field(page)).toHaveValue(text);
  await show(page, 'demo:1');
  await expect(field(page)).toHaveValue('');
  await field(page).fill('다른 동료에게 보낼 글');
  await show(page, 'demo:0');
  await expect(field(page)).toHaveValue(text);
  await page.reload();
  await expect(field(page)).toHaveValue(text);
  expect(await page.evaluate(() => (window as any).sends)).toEqual([]);
});

test('failed sends keep the draft; successful sends and manual erasing remove it', async ({
  page,
}) => {
  await desktop(page);
  await field(page).fill('테스트 실패부터 확인해 주세요');
  await page.evaluate(() => ((window as any).failSend = true));
  await field(page).press('Enter');
  await expect(page.getByRole('alert')).toContainText('Terminal unavailable');
  await show(page, null);
  await show(page, 'demo:0');
  await expect(field(page)).toHaveValue('테스트 실패부터 확인해 주세요');
  await page.evaluate(() => ((window as any).failSend = false));
  await field(page).press('Enter');
  await expect(field(page)).toHaveValue('');
  expect(await page.evaluate((key) => localStorage.getItem(key), key())).toBeNull();
  await field(page).fill('삭제할 초안');
  await field(page).fill('');
  await page.reload();
  await expect(field(page)).toHaveValue('');
});

test('confirmation and sending the terminal draft keep my own text until it is sent', async ({
  page,
}) => {
  await desktop(page);
  await field(page).fill('내가 작성하던 채팅');
  await page.evaluate(() => ((window as any).confirmSend = true));
  await field(page).press('Enter');
  const confirm = page.locator('.draft-confirm');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '취소', exact: true }).click();
  await show(page, null);
  await show(page, 'demo:0');
  await expect(field(page)).toHaveValue('내가 작성하던 채팅');
  await field(page).press('Enter');
  await confirm.getByRole('button', { name: /이 글 그대로 보내기/ }).click();
  await expect(confirm).toHaveCount(0);
  await expect(field(page)).toHaveValue('내가 작성하던 채팅');
  await field(page).press('Enter');
  await confirm.getByRole('button', { name: '지우고 내 글 보내기' }).click();
  await expect(field(page)).toHaveValue('');
});

test('two actual windows share edits and clearing for the same colleague', async ({ page }) => {
  await desktop(page);
  await field(page).fill('팝업에서 작성 중');
  const other = await page.context().newPage();
  await desktop(other);
  await expect(field(other)).toHaveValue('팝업에서 작성 중');
  await field(other).fill('다른 창에서 이어서 작성');
  await expect(field(page)).toHaveValue('다른 창에서 이어서 작성');
  await field(other).press('Enter');
  await expect(field(other)).toHaveValue('');
  await expect(field(page)).toHaveValue('');
  await other.close();
});

test('a send finishing after closing the popup preserves newer edits and another colleague', async ({
  page,
}) => {
  await desktop(page);
  await field(page).fill('지금 보낼 글');
  await page.evaluate(() => ((window as any).deferSend = true));
  await field(page).press('Enter');
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishSend)).toBe('function');
  await show(page, null);
  await show(page, 'demo:0');
  await field(page).fill('새로 작성하는 다음 채팅');
  await show(page, 'demo:1');
  await field(page).fill('다른 동료의 채팅');
  await page.evaluate(() => (window as any).finishSend());
  await expect(field(page)).toHaveValue('다른 동료의 채팅');
  await show(page, 'demo:0');
  await expect(field(page)).toHaveValue('새로 작성하는 다음 채팅');
  await page.reload();
  await expect(field(page)).toHaveValue('새로 작성하는 다음 채팅');
});

test('closing a popup during a successful send still clears that colleague’s sent draft', async ({
  page,
}) => {
  await desktop(page);
  await field(page).fill('창을 닫아도 전송은 완료');
  await page.evaluate(() => ((window as any).deferSend = true));
  await field(page).press('Enter');
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishSend)).toBe('function');
  await show(page, null);
  await page.evaluate(() => (window as any).finishSend());
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), key())).toBeNull();
  await show(page, 'demo:0');
  await expect(field(page)).toHaveValue('');
});

test('unavailable storage keeps typing usable and preserves drafts within this window', async ({
  page,
}) => {
  await desktop(page, 'demo:0', true);
  await field(page).fill('저장소가 없어도 유지');
  await show(page, null);
  await show(page, 'demo:0');
  await expect(field(page)).toHaveValue('저장소가 없어도 유지');
  await field(page).press('Enter');
  await expect(field(page)).toHaveValue('');
});

test('the focused chat input has a neutral indicator and IME Enter does not send', async ({
  page,
}) => {
  await desktop(page);
  await field(page).focus();
  await field(page).fill('한글을 작성 중');
  await field(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  expect(await page.evaluate(() => (window as any).sends)).toEqual([]);
  await expect(field(page)).toHaveValue('한글을 작성 중');
  const styles = await field(page).evaluate((el) => {
    const style = getComputedStyle(el);
    const probe = document.createElement('i');
    probe.style.color = 'var(--line-2)';
    el.parentElement!.append(probe);
    const neutral = getComputedStyle(probe).color;
    probe.remove();
    return { outline: style.outlineStyle, shadow: style.boxShadow, neutral };
  });
  expect(styles.outline).toBe('none');
  expect(styles.shadow).toContain(styles.neutral);
  await page.screenshot({ path: '.local/reply-draft-focused.png' });
});
