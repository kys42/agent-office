import { expect, test, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

/** A 1×1 PNG. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function desktop(
  page: Page,
  options: { images?: 'attach' | 'path' | null; privacy?: boolean } = {},
) {
  await page.setViewportSize({ width: 480, height: 760 });
  const snapshot = demoSnapshot();
  snapshot.preferences.privacy = !!options.privacy;
  await page.addInitScript(
    ({ snapshot, images }) => {
      const w = window as any;
      w.sends = [];
      w.attached = [];
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
            ids.map((id) => [
              id,
              { kind: 'tmux', status: 'idle', canSend: true, ...(images && { images }) },
            ]),
          ),
        onCard: (cb: any) => {
          w.showCard = (id: string | null) => cb(id ? { id, news: false } : null);
          setTimeout(() => w.showCard('demo:0'), 20);
          return () => {};
        },
        card: async () => {},
        attachImage: async (bytes: Uint8Array) => {
          if (!(bytes instanceof Uint8Array)) throw new Error('not bytes');
          // Numbered across reloads, as main's files outlive a window.
          const n = Number(localStorage.getItem('test:attached') ?? 0);
          localStorage.setItem('test:attached', String(n + 1));
          const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
          w.attached.push({ id, size: bytes.length });
          if (w.deferAttach) await new Promise<void>((resolve) => (w.finishAttach = resolve));
          return { id };
        },
        // Main's copy of a saved image, by id; a removed one is gone.
        attachmentPreview: async (id: string) => {
          w.previewed = [...(w.previewed ?? []), id];
          if (localStorage.getItem('test:deferPreview'))
            await new Promise<void>((resolve) => (w.finishPreview = resolve));
          if ((localStorage.getItem('test:gone') ?? '').includes(id)) return null;
          return {
            type: 'image/png',
            bytes: Uint8Array.from(atob(w.png), (c) => c.charCodeAt(0)),
          };
        },
        send: async (id: string, text: string, options?: { images?: string[] }) => {
          w.sends.push({ id, text, images: options?.images ?? null });
          // Like Codex Desktop: images alone leave no request in its record.
          const unrecorded = w.imagesUnrecorded && !text.trim() && !!options?.images?.length;
          return { status: 'sent', message: 'Sent', ...(unrecorded && { unrecorded: true }) };
        },
      };
      // A picked, pasted or dropped file in the page.
      w.imageFile = (name: string, type = 'image/png') => {
        const bytes = Uint8Array.from(atob(w.png), (c) => c.charCodeAt(0));
        return new File([bytes], name, { type });
      };
    },
    { snapshot, images: options.images === undefined ? 'attach' : options.images },
  );
  await page.addInitScript((png) => ((window as any).png = png), PNG);
  await page.goto('/#card');
  await expect(field(page)).toBeVisible();
}

const field = (page: Page) => page.locator('.terminal-send-chat textarea');
const thumbs = (page: Page) => page.locator('.terminal-send-chat .composer-image img');

async function paste(page: Page, name: string, type = 'image/png') {
  await field(page).evaluate(
    (el, { name, type }) => {
      const data = new DataTransfer();
      data.items.add((window as any).imageFile(name, type));
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { name, type },
  );
}

async function drop(page: Page, name: string) {
  await field(page).evaluate((el, name) => {
    const data = new DataTransfer();
    data.items.add((window as any).imageFile(name));
    for (const type of ['dragenter', 'dragover', 'drop'])
      el.dispatchEvent(
        new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
      );
  }, name);
}

test('Pasted, dropped and picked images show as thumbnails, can be removed, and go with the send', async ({
  page,
}) => {
  await desktop(page);
  await paste(page, 'shot.png');
  await expect(thumbs(page)).toHaveCount(1);
  await drop(page, 'dropped.png');
  await expect(thumbs(page)).toHaveCount(2);
  await page.locator('.terminal-send-chat input[type=file]').setInputFiles({
    name: 'picked.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG, 'base64'),
  });
  await expect(thumbs(page)).toHaveCount(3);
  // The bytes went to the desktop app; ids came back.
  expect(await page.evaluate(() => (window as any).attached.length)).toBe(3);

  await page.getByRole('button', { name: '2번째 이미지 빼기' }).click();
  await expect(thumbs(page)).toHaveCount(2);
  await expect(thumbs(page).nth(0)).toHaveAttribute('alt', 'shot.png');
  await expect(thumbs(page).nth(1)).toHaveAttribute('alt', 'picked.png');

  await field(page).fill('이 화면 봐줘');
  await field(page).press('Enter');
  await expect(field(page)).toHaveValue('');
  await expect(thumbs(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).sends)).toEqual([
    {
      id: 'demo:0',
      text: '이 화면 봐줘',
      images: ['00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000002'],
    },
  ]);
});

test('Images alone can be sent; a text-only send carries no images', async ({ page }) => {
  await desktop(page);
  const send = page.locator('.terminal-send-chat button[type=submit]');
  await expect(send).toBeDisabled();
  await paste(page, 'only.png');
  await expect(thumbs(page)).toHaveCount(1);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(thumbs(page)).toHaveCount(0);
  await field(page).fill('글만');
  await field(page).press('Enter');
  expect(await page.evaluate(() => (window as any).sends)).toEqual([
    { id: 'demo:0', text: '', images: ['00000000-0000-4000-8000-000000000000'] },
    { id: 'demo:0', text: '글만', images: null },
  ]);
});

test('Other file types are refused with a reason; text pastes stay text', async ({ page }) => {
  await desktop(page);
  await paste(page, 'vector.svg', 'image/svg+xml');
  await expect(page.getByRole('alert')).toContainText('PNG, JPEG, GIF, WebP');
  await expect(thumbs(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).attached.length)).toBe(0);
  await field(page).focus();
  await page.keyboard.insertText('그냥 글');
  await expect(field(page)).toHaveValue('그냥 글');
});

test('Where the target takes no images, there is no attach button and a paste says why', async ({
  page,
}) => {
  await desktop(page, { images: null });
  await expect(page.getByRole('button', { name: '이미지 첨부' })).toHaveCount(0);
  await paste(page, 'shot.png');
  await expect(page.getByRole('alert')).toContainText('이 대화에는 여기서 이미지를 보낼 수 없어요');
  await expect(thumbs(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).attached.length)).toBe(0);
});

test('Codex CLI targets say images go as paths; images stay with the draft when the card closes', async ({
  page,
}) => {
  await desktop(page, { images: 'path' });
  await expect(page.getByRole('button', { name: '이미지 첨부' })).toBeVisible();
  await paste(page, 'shot.png');
  await paste(page, 'second.png');
  await expect(page.locator('.composer-images-note')).toContainText('파일 경로로 전달돼요');
  await field(page).fill('초안');
  await page.evaluate(() => (window as any).showCard(null));
  await expect(field(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).showCard('demo:0'));
  await expect(field(page)).toHaveValue('초안');
  await expect(thumbs(page)).toHaveCount(2);
  // A closed card's window is destroyed (a reload here): ids come back with the text draft and
  // their thumbnails from main; one main no longer has is dropped without a word.
  await page.evaluate(() =>
    localStorage.setItem('test:gone', '00000000-0000-4000-8000-000000000001'),
  );
  await page.reload();
  await expect(field(page)).toHaveValue('초안');
  await expect(thumbs(page)).toHaveCount(1);
  await expect(thumbs(page).first()).toHaveAttribute('alt', 'shot.png');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await field(page).press('Enter');
  await expect(thumbs(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).sends)).toEqual([
    { id: 'demo:0', text: '초안', images: ['00000000-0000-4000-8000-000000000000'] },
  ]);
  // Sent: nothing comes back after the next reopen.
  await page.reload();
  await expect(field(page)).toHaveValue('');
  await expect(page.locator('.terminal-send-chat .composer-image')).toHaveCount(0);
});

test('An image still uploading keeps Send off, even after the card is closed and reopened', async ({
  page,
}) => {
  await desktop(page);
  const send = page.locator('.terminal-send-chat button[type=submit]');
  await field(page).fill('봐줘');
  await page.evaluate(() => ((window as any).deferAttach = true));
  await paste(page, 'slow.png');
  await expect(page.locator('.composer-image-busy')).toBeVisible();
  await expect(send).toBeDisabled();
  await page.evaluate(() => (window as any).showCard(null));
  await expect(field(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).showCard('demo:0'));
  await expect(field(page)).toHaveValue('봐줘');
  await expect(page.locator('.composer-image-busy')).toBeVisible();
  await expect(send).toBeDisabled();
  await page.evaluate(() => (window as any).finishAttach());
  await expect(thumbs(page)).toHaveCount(1);
  await expect(send).toBeEnabled();
  await send.click();
  expect(await page.evaluate(() => (window as any).sends)).toEqual([
    { id: 'demo:0', text: '봐줘', images: ['00000000-0000-4000-8000-000000000000'] },
  ]);
});

test('With screen content hidden, attached images show as plain tiles', async ({ page }) => {
  await desktop(page, { privacy: true });
  await paste(page, 'secret.png');
  await expect(page.locator('.terminal-send-chat .composer-image')).toHaveCount(1);
  await expect(thumbs(page)).toHaveCount(0);
  await expect(page.getByLabel('이미지 1 (가림)')).toBeVisible();
});

test('A thumbnail fetched again shows up even when the list changes while it is on its way', async ({
  page,
}) => {
  await desktop(page);
  await paste(page, 'first.png');
  await expect(thumbs(page)).toHaveCount(1);
  // The card's window is recreated; main is slow to hand the first thumbnail back.
  await page.evaluate(() => localStorage.setItem('test:deferPreview', '1'));
  await page.reload();
  await expect(page.locator('.terminal-send-chat .composer-image')).toHaveCount(1);
  await expect(thumbs(page)).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem('test:deferPreview'));
  await paste(page, 'second.png');
  await expect(thumbs(page)).toHaveCount(1);
  await page.evaluate(() => (window as any).finishPreview());
  await expect(thumbs(page)).toHaveCount(2);
  await expect(thumbs(page).first()).toHaveAttribute('alt', 'first.png');
});

test('The sent receipt counts its images, and none waits for a record that will not show it', async ({
  page,
}) => {
  await desktop(page);
  await page.evaluate(() => ((window as any).imagesUnrecorded = true));
  const pending = page.locator('.message-pending');
  await paste(page, 'only.png');
  await expect(thumbs(page)).toHaveCount(1);
  await page.locator('.terminal-send-chat button[type=submit]').click();
  await expect(thumbs(page)).toHaveCount(0);
  await expect(pending).toHaveCount(0);
  await paste(page, 'with-text.png');
  await field(page).fill('이 화면 봐줘');
  await field(page).press('Enter');
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText('이 화면 봐줘');
  await expect(pending).toContainText('이미지 1장 첨부');
});
