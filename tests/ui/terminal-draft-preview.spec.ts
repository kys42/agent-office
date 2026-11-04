import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';

/**
 * The work card previews what sits in the colleague's terminal input box (#328): typed there and
 * not sent. The desktop bridge is a fake: `box` is what the input box holds, `submitDraft` sends
 * it only while it still holds exactly the text asked for, as main does.
 */
async function card(
  page: Page,
  opts: {
    box?: string;
    privacy?: boolean;
    canSend?: boolean;
    hash?: string;
    /** The box wrapped it over rows: the text as typed cannot be told. */
    wrapped?: boolean;
    /** Claude's own suggestion shown in the otherwise empty box (#338). */
    suggestion?: string;
    /** Orca: `box` may be the suggestion (it reads like typing); one line goes via the key. */
    maybe?: boolean;
  } = {},
) {
  const snapshot = demoSnapshot();
  snapshot.preferences.privacy = !!opts.privacy;
  if (!opts.hash) await page.setViewportSize({ width: 480, height: 760 });
  await page.addInitScript(
    ({ s, box, canSend, wrapped, suggestion, maybe }) => {
      const w = window as any;
      w.maybe = maybe;
      w.fixture = s;
      w.box = box;
      w.suggestion = suggestion;
      w.wrapped = wrapped;
      w.reads = 0;
      w.submits = [];
      w.sends = [];
      w.cardCalls = [];
      w.replies = [];
      const view = () =>
        !w.box && w.suggestion
          ? { kind: 'suggestion', text: w.suggestion, agent: 'Claude', submittable: true }
          : w.box
            ? {
                kind: 'draft',
                text: w.box,
                agent: 'Claude',
                submittable: !w.box.includes('[Pasted'),
                // As typed, unless the box wrapped it where that cannot be told (main's rule).
                ...(!w.wrapped && { logical: w.box }),
                ...(w.maybe && { maybeSuggestion: true, acceptsSuggestion: true }),
              }
            : { kind: 'empty' };
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        preferences: async () => structuredClone(w.fixture),
        artifacts: async () => [],
        subscribe: () => () => {},
        notices: async () => structuredClone(w.fixture),
        // A message reaching the colleague reads its results, like opening its card (#300).
        readReplies: async (id: string) => {
          w.replies.push(id);
          return structuredClone(w.fixture);
        },
        terminalSend: async () => true,
        terminals: async (ids: string[]) =>
          Object.fromEntries(
            ids.map((id) => [
              id,
              { kind: 'tmux', label: 'work:1.0', status: 'idle', canSend, canFocus: true },
            ]),
          ),
        composerDraft: async () => {
          w.reads++;
          return view();
        },
        submitDraft: async (id: string, text: string, options?: { suggestion?: boolean }) => {
          // [Send suggestion]: main presses the accept key only while the box holds just that
          // suggestion (or, Orca, exactly that one line), then Enter only once it holds exactly it.
          if (options?.suggestion && w.maybe && w.box === text) {
            w.submits.push([id, text, 'suggestion']);
            w.box = '';
            return { status: 'sent', message: 'Orca 터미널에 보냈어요', logical: text };
          }
          if (options?.suggestion) {
            if (w.box || w.suggestion !== text)
              return {
                status: 'changed',
                message:
                  '그사이 입력창 글이 바뀌어 보내지 않았어요. 지금 들어 있는 글을 보여 드려요.',
                draft: view(),
              };
            w.submits.push([id, text, 'suggestion']);
            w.suggestion = '';
            return { status: 'sent', message: 'tmux work:1.0에 보냈어요', logical: text };
          }
          if (w.box !== text)
            return {
              status: 'changed',
              message:
                '그사이 입력창 글이 바뀌어 보내지 않았어요. 지금 들어 있는 글을 보여 드려요.',
              draft: view(),
            };
          w.submits.push([id, text]);
          w.box = '';
          return { status: 'sent', message: 'tmux work:1.0에 보냈어요' };
        },
        send: async (
          id: string,
          text: string,
          options?: { replaceDraft?: string; exactDraft?: boolean },
        ) => {
          w.sends.push({
            id,
            text,
            replaceDraft: options?.replaceDraft ?? null,
            ...(options?.exactDraft && { exactDraft: true }),
          });
          // Main clears exactly the confirmed box text, then types the card's text; any other
          // box text (even only an indent) is asked about, nothing cleared.
          if (w.box && options?.replaceDraft !== w.box)
            return { status: 'needs-confirm', draft: w.box, agent: 'Claude', changed: true };
          w.box = '';
          return { status: 'sent', message: 'tmux work:1.0에 보냈어요', cleared: true };
        },
        jump: async () => ({ action: 'focused', text: '' }),
        card: async (what: string) => {
          w.cardCalls.push(what);
        },
        cardState: async () => ({ pinned: false, positionRemembered: false }),
        onCardState: () => () => {},
        onCard: (cb: any) => {
          setTimeout(() => cb({ id: 'demo:0' }), 50);
          return () => {};
        },
      };
    },
    {
      s: snapshot,
      box: opts.box ?? '',
      canSend: opts.canSend ?? true,
      wrapped: !!opts.wrapped,
      suggestion: opts.suggestion ?? '',
      maybe: !!opts.maybe,
    },
  );
  await page.goto(opts.hash ?? '/#card');
  // The big office: its right column opens on a desk click.
  if (opts.hash) await page.getByRole('button', { name: '코코, 일하는 중', exact: true }).click();
  const aside = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(aside).toBeVisible();
  return aside;
}
const w = (page: Page, key: string) => page.evaluate((k) => (window as any)[k], key);
/** What the person typed in the terminal meanwhile; the card looks again when it gets focus. */
const type = (page: Page, box: string) =>
  page.evaluate((text) => {
    (window as any).box = text;
    window.dispatchEvent(new Event('focus'));
  }, box);

test('Text sitting in the terminal input shows above the chat box, and goes when it is gone', async ({
  page,
}) => {
  const aside = await card(page, { box: '이 PR 리뷰 반영하고 테스트 돌려 줘' });
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  await expect(preview).toBeVisible();
  await expect(preview.locator('.draft-preview-text')).toHaveText(
    '이 PR 리뷰 반영하고 테스트 돌려 줘',
  );
  await expect(preview).toContainText('Claude 입력창');
  // Sent (or cleared) in the terminal itself: the preview goes.
  await type(page, '');
  await expect(preview).toHaveCount(0);
  await type(page, '다시 썼어요');
  await expect(preview.locator('.draft-preview-text')).toHaveText('다시 썼어요');
});

test('Send as is submits exactly the shown text and waits as a sent bubble', async ({ page }) => {
  const aside = await card(page, { box: '마이그레이션 먼저 하고\n그다음 배포해 줘' });
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  await preview.getByRole('button', { name: '그대로 보내기' }).click();
  await expect(preview).toHaveCount(0);
  expect(await w(page, 'submits')).toEqual([
    ['demo:0', '마이그레이션 먼저 하고\n그다음 배포해 줘'],
  ]);
  // Nothing was typed: no send of the card's own box.
  expect(await w(page, 'sends')).toEqual([]);
  // Sent from the card like any message: that colleague's results are read (#300).
  await expect.poll(() => w(page, 'replies')).toContain('demo:0');
  const waiting = aside.locator('.message-pending');
  await expect(waiting).toContainText('마이그레이션 먼저 하고');
  await expect(waiting).toContainText('대화 기록 확인 중');
});

test('Changed in the terminal meanwhile: nothing is sent, the reason and the new text show', async ({
  page,
}) => {
  const aside = await card(page, { box: '처음 쓴 글' });
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  await expect(preview.locator('.draft-preview-text')).toHaveText('처음 쓴 글');
  // Edited in the terminal after the last read; the card has not looked again yet.
  await page.evaluate(() => ((window as any).box = '처음 쓴 글, 고쳐 씀'));
  await preview.getByRole('button', { name: '그대로 보내기' }).click();
  await expect(preview.getByRole('alert')).toContainText('바뀌어 보내지 않았어요');
  await expect(preview.locator('.draft-preview-text')).toHaveText('처음 쓴 글, 고쳐 씀');
  expect(await w(page, 'submits')).toEqual([]);
  await expect(aside.locator('.message-pending')).toHaveCount(0);
});

test('Only an indent changed in the terminal: nothing is sent, the reason and new indent show', async ({
  page,
}) => {
  const aside = await card(page, { box: 'steps:\n    - build\n    - test' });
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  await expect(preview.locator('.draft-preview-text')).toHaveText(
    'steps:\n    - build\n    - test',
  );
  await page.evaluate(() => ((window as any).box = 'steps:\n  - build\n  - test'));
  await preview.getByRole('button', { name: '그대로 보내기' }).click();
  await expect(preview.getByRole('alert')).toContainText('바뀌어 보내지 않았어요');
  await expect(preview.locator('.draft-preview-text')).toHaveText('steps:\n  - build\n  - test');
  expect(await w(page, 'submits')).toEqual([]);
});

test('Edit in card takes the text into the chat box; sending then replaces it in the terminal', async ({
  page,
}) => {
  const aside = await card(page, { box: '로그인 버그 고쳐 줘' });
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  const field = aside.locator('.card-composer textarea');
  await field.fill('먼저 쓰던 글');
  await preview.getByRole('button', { name: '카드에서 고치기' }).click();
  // Added after what was already written there, never over it.
  await expect(field).toHaveValue('먼저 쓰던 글\n\n로그인 버그 고쳐 줘');
  await expect(field).toBeFocused();
  await expect(preview).toContainText('아래 입력칸으로 가져왔어요');
  await expect(preview.getByRole('button', { name: '카드에서 고치기' })).toHaveCount(0);
  await field.fill('로그인 버그 고쳐 줘. 세션 만료도 같이 봐 줘');
  await field.press('Enter');
  await expect(field).toHaveValue('');
  // The card's text replaces exactly what the terminal box held: never typed next to it.
  expect(await w(page, 'sends')).toEqual([
    {
      id: 'demo:0',
      text: '로그인 버그 고쳐 줘. 세션 만료도 같이 봐 줘',
      replaceDraft: '로그인 버그 고쳐 줘',
      exactDraft: true,
    },
  ]);
  await expect(preview).toHaveCount(0);
});

test('Text the box wrapped over rows is never taken into the card, only sent as is', async ({
  page,
}) => {
  const read = 'https://example.com/very/long/path/that/the/box/\nwrapped/over/two/rows';
  const aside = await card(page, { box: read, wrapped: true });
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  await expect(preview).toContainText('원래 줄바꿈을 알 수 없어서');
  await expect(preview.getByRole('button', { name: '카드에서 고치기' })).toBeDisabled();
  await expect(aside.locator('.card-composer textarea')).toHaveValue('');
  // Enter alone sends what was typed there, wrapping and all: still offered.
  await preview.getByRole('button', { name: '그대로 보내기' }).click();
  expect(await w(page, 'submits')).toEqual([['demo:0', read]]);
  // Its receipt waits too, matched with the box's wrapping ignored.
  await expect(aside.locator('.message-pending')).toContainText('https://example.com');
});

test('Taken into the card, then only an indent changed in the terminal: sending asks, clears nothing', async ({
  page,
}) => {
  const aside = await card(page, { box: 'steps:\n    - build' });
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  const field = aside.locator('.card-composer textarea');
  await preview.getByRole('button', { name: '카드에서 고치기' }).click();
  await expect(field).toHaveValue('steps:\n    - build');
  await page.evaluate(() => ((window as any).box = 'steps:\n  - build'));
  await field.fill('steps:\n    - build\n    - test');
  await field.press('Enter');
  // The terminal's edit is shown and asked about; the card keeps what was written.
  const confirm = aside.locator('.draft-confirm');
  await expect(confirm).toContainText('그사이 입력창 글이 바뀌었어요');
  await expect(field).toHaveValue('steps:\n    - build\n    - test');
  expect(await w(page, 'box')).toBe('steps:\n  - build');
  expect(await w(page, 'sends')).toEqual([
    {
      id: 'demo:0',
      text: 'steps:\n    - build\n    - test',
      replaceDraft: 'steps:\n    - build',
      exactDraft: true,
    },
  ]);
});

test('A partial box is shown but never sent from the card', async ({ page }) => {
  const aside = await card(page, { box: 'note: [Pasted text #1 +12 lines]' });
  await page.evaluate(() => {
    const office = (window as any).office;
    const read = office.composerDraft;
    office.composerDraft = async () => ({ ...(await read()), partial: true });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  await expect(preview).toContainText('글이 다 보이지 않아');
  await expect(preview.getByRole('button', { name: '그대로 보내기' })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: '카드에서 고치기' })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: '터미널로 이동' })).toBeVisible();
});

test('Hidden-screen mode never reads the box nor shows its text', async ({ page }) => {
  const aside = await card(page, { box: '비밀 프로젝트 이름이 들어간 글', privacy: true });
  await expect(aside.locator('.card-composer textarea')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByText('비밀 프로젝트 이름이 들어간 글')).toHaveCount(0);
  await expect(aside.locator('.draft-preview')).toHaveCount(0);
  expect(await w(page, 'reads')).toBe(0);
});

test('A terminal not taking input is not read', async ({ page }) => {
  const aside = await card(page, { box: '대기 중 글', canSend: false });
  await expect(aside.locator('.card-composer textarea')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(aside.locator('.draft-preview')).toHaveCount(0);
  expect(await w(page, 'reads')).toBe(0);
});

test('A long text is clamped with a toggle to show all', async ({ page }) => {
  const long = Array.from({ length: 8 }, (_, i) => `${i + 1}. 이 단계에서 확인할 내용`).join('\n');
  const aside = await card(page, { box: long });
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  const text = preview.locator('.draft-preview-text');
  await expect(text).toHaveClass(/is-clamped/);
  const short = (await text.boundingBox())!.height;
  await preview.getByRole('button', { name: '펼치기' }).click();
  await expect(text).not.toHaveClass(/is-clamped/);
  expect((await text.boundingBox())!.height).toBeGreaterThan(short);
  await expect(preview.getByRole('button', { name: '접기' })).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const)
  test(`The preview on the card (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    const aside = await card(page, {
      box: 'API 응답 스키마 바뀐 거 반영해 주고\n테스트 깨지는 거 있으면 같이 고쳐 줘',
    });
    const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
    await expect(preview).toBeVisible();
    await page.screenshot({ path: `.local/terminal-draft-preview-${colorScheme}.png` });
  });

test('The big office card shows the same preview from the same core', async ({ page }) => {
  const aside = await card(page, { box: '배포 전에 체인지로그도 정리해 줘', hash: '/' });
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  await expect(preview.locator('.draft-preview-text')).toHaveText(
    '배포 전에 체인지로그도 정리해 줘',
  );
  await page.screenshot({ path: '.local/terminal-draft-preview-office.png' });
  await preview.getByRole('button', { name: '그대로 보내기' }).click();
  await expect(aside.locator('.message-pending')).toContainText('배포 전에 체인지로그도');
});

test("Claude's suggestion shows as its own, not as a draft, and goes with [Send suggestion]", async ({
  page,
}) => {
  const aside = await card(page, { suggestion: '커밋해줘' });
  const preview = aside.getByRole('region', { name: 'Claude 추천 글' });
  await expect(preview).toBeVisible();
  await expect(preview.locator('.draft-preview-text')).toHaveText('커밋해줘');
  await expect(preview).toContainText('터미널에서는 Tab으로 받는 글이에요');
  // Never called the person's half-written text, never taken into the card.
  await expect(aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: '그대로 보내기' })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: '카드에서 고치기' })).toHaveCount(0);
  await page.screenshot({ path: '.local/terminal-draft-suggestion.png' });
  await preview.getByRole('button', { name: '추천 글 보내기' }).click();
  await expect(preview).toHaveCount(0);
  expect(await w(page, 'submits')).toEqual([['demo:0', '커밋해줘', 'suggestion']]);
  expect(await w(page, 'sends')).toEqual([]);
  // It waits as a sent bubble, like [Send as is].
  const waiting = aside.locator('.message-pending');
  await expect(waiting).toContainText('커밋해줘');
  await expect(waiting).toContainText('대화 기록 확인 중');
});

test('A suggestion replaced by typing meanwhile is not sent: the reason and the draft show', async ({
  page,
}) => {
  const aside = await card(page, { suggestion: '커밋해줘' });
  const preview = aside.getByRole('region', { name: 'Claude 추천 글' });
  await expect(preview).toBeVisible();
  await page.evaluate(() => ((window as any).box = '커밋하지 마'));
  await preview.getByRole('button', { name: '추천 글 보내기' }).click();
  const draft = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  await expect(draft.getByRole('alert')).toContainText('바뀌어 보내지 않았어요');
  await expect(draft.locator('.draft-preview-text')).toHaveText('커밋하지 마');
  expect(await w(page, 'submits')).toEqual([]);
});

test('A suggestion cut short on screen is shown, never sent from the card', async ({ page }) => {
  const aside = await card(page, { suggestion: '전체 테스트 돌리고 실패한 것만…' });
  await page.evaluate(() => {
    const office = (window as any).office;
    const read = office.composerDraft;
    office.composerDraft = async () => ({ ...(await read()), submittable: false });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const preview = aside.getByRole('region', { name: 'Claude 추천 글' });
  await expect(preview).toContainText('추천 글이 다 보이지 않아');
  await expect(preview.getByRole('button', { name: '추천 글 보내기' })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: '터미널로 이동' })).toBeVisible();
});

test('Orca text that may be a suggestion says Tab takes it in the terminal', async ({ page }) => {
  const aside = await card(page, { box: '커밋해줘' });
  await page.evaluate(() => {
    const office = (window as any).office;
    const read = office.composerDraft;
    office.composerDraft = async () => ({
      ...(await read()),
      partial: true,
      submittable: false,
      maybeSuggestion: true,
    });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  await expect(preview).toContainText('터미널에서 Tab으로 받는 Claude 추천 글일 수도 있어요');
  await expect(preview.getByRole('button', { name: '그대로 보내기' })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: '추천 글 보내기' })).toHaveCount(0);
  await expect(preview.getByRole('button', { name: '터미널로 이동' })).toBeVisible();
});

test('Orca: one line that may be the suggestion is sent either way through the accept key', async ({
  page,
}) => {
  const aside = await card(page, { box: '커밋해줘', maybe: true });
  const preview = aside.getByRole('region', { name: '터미널 입력창에 쓰다 만 글' });
  await expect(preview).toContainText('추천 글이면 받아서, 직접 친 글이면 그대로 보내요');
  await preview.getByRole('button', { name: '그대로 보내기' }).click();
  await expect(preview).toHaveCount(0);
  expect(await w(page, 'submits')).toEqual([['demo:0', '커밋해줘', 'suggestion']]);
  await expect(aside.locator('.message-pending')).toContainText('커밋해줘');
});
