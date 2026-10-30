import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { OfficeEvent } from '../../src/shared/types';

/** The dock's card window in the browser: the desktop bridge opens it on demo:0. */
async function card(
  page: Page,
  opts: {
    canSend?: boolean;
    terminal?: boolean;
    privacy?: boolean;
    id?: string;
    events?: OfficeEvent[];
    handshakeOnly?: boolean;
    artifactCount?: number;
    codex?: boolean;
  } = {},
) {
  const snapshot = demoSnapshot();
  if (opts.codex) snapshot.sessions[0].provider = 'codex';
  if (opts.events) snapshot.sessions[0].events = opts.events;
  snapshot.preferences.privacy = !!opts.privacy;
  // A helper of demo:0, to open as its own card.
  snapshot.sessions.push({
    ...snapshot.sessions[0],
    id: 'demo:helper',
    nativeId: 'demo-helper',
    alias: '',
    title: '보조 조사',
    officeSeat: undefined,
    relation: { kind: 'subagent', parentNativeId: 'demo-0', role: '조사', source: 'demo' },
    parentId: 'demo-0',
  });
  // An unread final answer from the opened colleague (its card shows the 'new' chip).
  const id = opts.id ?? 'demo:0';
  const at = Date.now() - 60_000;
  snapshot.notices = [
    ...(snapshot.notices ?? []),
    {
      id: `fresh-${id}`,
      sessionId: id,
      eventId: `fresh-${id}`,
      kind: 'reply',
      phase: 'final',
      text: '정리해 두었어요.',
      at,
      receivedAt: at,
      version: 'v1',
      seenAt: null,
      viewedAt: null,
      dismissedAt: null,
      resolvedAt: null,
      bootstrap: false,
    },
  ];
  await page.setViewportSize({ width: 480, height: 760 });
  await page.addInitScript(
    ({ s, canSend, terminal, handshakeOnly, artifactCount }) => {
      const w = window as any;
      w.fixture = s;
      w.sent = [];
      w.receipts = [];
      w.cardCalls = [];
      w.jumps = [];
      w.windowState = { pinned: false, positionRemembered: false };
      w.resumes = [];
      w.office = {
        snapshot: async () => structuredClone(w.fixture),
        detail: async (id: string) =>
          structuredClone(w.fixture.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(w.fixture),
        // The colleague's recent work, as the service reads it from GitHub.
        artifacts: async () =>
          artifactCount
            ? Array.from({ length: artifactCount }, (_, i) => ({
                url: `https://github.com/example/demo/pull/${i + 1}`,
                kind: 'pull',
                repo: 'example/demo',
                number: i + 1,
                title: `Saved change ${i + 1}`,
                state: 'open',
              }))
            : [
                {
                  url: 'https://github.com/kys42/agent-office/pull/95',
                  kind: 'pull',
                  repo: 'kys42/agent-office',
                  number: 95,
                  title: '팝업 업무 카드를 채팅형으로',
                  state: 'open',
                },
                {
                  url: 'https://github.com/kys42/agent-office/issues/86',
                  kind: 'issues',
                  repo: 'kys42/agent-office',
                  number: 86,
                  title: '크기 조절·아래 입력창·윗줄 정리',
                  state: 'open',
                },
                {
                  url: 'https://github.com/kys42/agent-office/pull/89',
                  kind: 'pull',
                  repo: 'kys42/agent-office',
                  number: 89,
                  title: '스크롤 깜박임 막기',
                  state: 'merged',
                },
              ],
        subscribe: (cb: any) => {
          w.publish = cb;
          return () => {};
        },
        notices: async (receipts: any[], action: string) => {
          w.receipts.push([action, receipts.map((r: any) => r.id)]);
          w.fixture.notices = w.fixture.notices.map((n: any) =>
            receipts.some((r: any) => r.id === n.id) && action === 'read'
              ? { ...n, seenAt: Date.now() }
              : n,
          );
          return structuredClone(w.fixture);
        },
        terminalSend: async () => true,
        resume: async (id: string) => {
          w.resumes.push(id);
          return 'Codex app opened';
        },
        send: async (id: string, text: string) => {
          w.sent.push([id, text]);
          return { status: 'sent', message: '보냈어요' };
        },
        terminals: async (ids: string[]) =>
          Object.fromEntries(
            ids.map((id) => [
              id,
              w.codexPhase
                ? w.codexPhase === 'none'
                  ? null
                  : {
                      kind: 'codex',
                      label: '',
                      status: 'queue',
                      canSend: w.codexPhase !== 'screen-only',
                      desktop: w.codexPhase === 'desktop',
                      queues: w.codexPhase !== 'desktop',
                      canFocus: !['queue', 'desktop'].includes(w.codexPhase),
                      ...(!['queue', 'desktop'].includes(w.codexPhase) && {
                        focus: { kind: 'orca', label: 'Session screen' },
                      }),
                    }
                : terminal
                  ? { kind: 'orca', label: 'Orca', status: 'idle', canSend, canFocus: true }
                  : null,
            ]),
          ),
        handoff: async () => ({ markdown: '# 인수인계', revision: 'r', createdAt: Date.now() }),
        card: async (what: string, target: any) => {
          w.cardCalls.push(what);
          if (what === 'select') w.cardListener?.(target);
          if (what === 'pin-on' || what === 'pin-off') w.windowState.pinned = what === 'pin-on';
          if (what === 'position-on' || what === 'position-off')
            w.windowState.positionRemembered = what === 'position-on';
          w.windowStateListener?.({ ...w.windowState });
        },
        jump: async (id: string) => {
          w.jumps.push(id);
          return { action: 'focused', text: '' };
        },
        cardState: async () => ({
          ...w.windowState,
          ...(handshakeOnly ? { target: { id: w.cardId } } : {}),
        }),
        onCardState: (cb: any) => {
          w.windowStateListener = cb;
          return () => {
            w.windowStateListener = null;
          };
        },
        onCard: (cb: any) => {
          w.cardListener = cb;
          if (!handshakeOnly) setTimeout(() => cb({ id: w.cardId }), 50);
          return () => {};
        },
      };
    },
    {
      s: snapshot,
      canSend: opts.canSend ?? true,
      terminal: opts.terminal ?? true,
      handshakeOnly: opts.handshakeOnly ?? false,
      artifactCount: opts.artifactCount,
    },
  );
  await page.addInitScript((id) => ((window as any).cardId = id), id);
  await page.goto('/#card');
  const aside = page.getByRole('complementary', { name: '동료의 업무 카드' });
  await expect(aside).toBeVisible();
  return aside;
}

test('A cold popup recovers its target when the opening event preceded subscription', async ({
  page,
}) => {
  const aside = await card(page, { handshakeOnly: true });
  await expect(aside.locator('.card-head h2')).toContainText('코코');
});

test('Codex app navigation stays available while Orca lookup and queue availability change', async ({
  page,
}) => {
  const aside = await card(page, { codex: true });
  const app = aside.getByRole('button', { name: 'Codex에서 열기', exact: true });
  await expect(app).toBeVisible();
  await page.evaluate(() => {
    (window as any).codexPhase = 'none';
  });
  await app.click();
  expect(await page.evaluate(() => (window as any).resumes)).toEqual(['demo:0']);
  expect(await page.evaluate(() => (window as any).jumps)).toEqual([]);
  for (const phase of ['queue', 'screen-only', 'both']) {
    await page.evaluate((phase) => {
      const w = window as any;
      w.codexPhase = phase;
      w.fixture.sessions[0].updatedAt += 1000;
      w.fixture.version++;
      w.publish(structuredClone(w.fixture));
    }, phase);
    await expect(app).toBeVisible();
    const orca = aside.getByRole('button', { name: 'Orca로 이동', exact: true });
    if (phase === 'queue') await expect(orca).toHaveCount(0);
    else {
      await expect(orca).toBeVisible();
      await orca.click();
      await expect(app).toBeVisible();
    }
    await expect(aside.getByRole('button', { name: '재개 명령 복사', exact: true })).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as any).jumps)).toEqual(['demo:0', 'demo:0']);
  expect(await page.evaluate(() => (window as any).resumes)).toEqual(['demo:0']);
});

test('The floating work-list arrow stays reachable while scrolling and collapsing a short popup', async ({
  page,
}) => {
  const aside = await card(page, { artifactCount: 40 });
  await page.setViewportSize({ width: 380, height: 480 });
  const shell = aside.locator('.artifact-list-shell');
  const list = shell.locator('.artifact-list');
  const toggle = shell.locator('.artifact-list-more');
  await expect(toggle).toHaveAttribute('aria-label', '38개 더 보기');
  await expect(list.locator('.artifact-row')).toHaveCount(2);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(list.locator('.artifact-row')).toHaveCount(40);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const close = shell.getByRole('button', { name: '접기', exact: true });
  await expect(close).toBeInViewport();
  expect(
    await close.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  await close.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(list.locator('.artifact-row')).toHaveCount(2);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(aside.locator('textarea')).toBeInViewport();
});

test('The card opens as a glass chat: header tools, recent work, tabs, actions and a chat box', async ({
  page,
}) => {
  const aside = await card(page);
  await expect(aside.locator('.card-head h2')).toContainText('코코');
  // No banners or chips above the conversation.
  await expect(aside.locator('.now-card')).toHaveCount(0);
  await expect(aside.locator('.card-chip')).toHaveCount(0);
  await expect(aside.locator('.inspector-actions')).toHaveCount(0);
  // A window of its own: nothing to go back to (the big office's column has '명단으로 돌아가기').
  await expect(aside.getByRole('button', { name: '명단으로 돌아가기' })).toHaveCount(0);
  // Popup location and independent card pin sit top right; the office pin is in the menu.
  const head = aside.locator('.card-head');
  for (const name of [
    '위치 기억',
    '이 카드 고정',
    '큰 사무실에서 보기',
    '카드 메뉴',
    '업무 카드 닫기',
  ])
    await expect(head.getByRole('button', { name })).toBeVisible();
  const actions = aside.locator('.card-actions');
  await expect(actions.getByRole('button')).toHaveText(['Orca로 이동']);
  // The header moves the card by the desktop following the cursor: no CSS drag region.
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('*')].some(
        (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'drag',
      ),
    ),
  ).toBe(false);
  // Recent issues and PRs above the tabs: two, the rest behind "n more".
  const recent = aside.locator('.artifact-list');
  await expect(recent.locator('.artifact-row')).toHaveCount(2);
  // Most recently mentioned first (the service keeps them in the order the chat met them).
  await expect(recent.locator('.artifact-row').first()).toContainText('#89');
  // Answers are signed with the colleague's name, not the tool's.
  await expect(aside.locator('.message-assistant .message-meta').first()).toContainText('코코');
  await expect(aside.locator('.message-assistant .message-meta').first()).not.toContainText(
    'Claude Code',
  );
  await aside
    .locator('.artifact-list-shell')
    .getByRole('button', { name: /더 보기|1/ })
    .click();
  await expect(recent.locator('.artifact-row')).toHaveCount(3);
  // Only once: the office panel's tray stays out of the card (one read of the work, not two).
  await expect(aside.locator('.artifact-tray')).toHaveCount(0);
  const box = (await recent.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(152);
  await expect(aside.getByRole('tab')).toHaveText(['대화', '작업 정보', '기억 메모']);
  await expect(aside.getByRole('tab', { name: '대화' })).toHaveAttribute('aria-selected', 'true');
  // The chat box sits at the bottom.
  const composer = (await aside.locator('.card-composer').boundingBox())!;
  expect(composer.y + composer.height).toBeGreaterThan(740);
  await page.screenshot({ path: '.local/card-chat.png' });
});

test('Progress notes can be hidden from the chat, and the choice is remembered', async ({
  page,
}) => {
  const aside = await card(page);
  const progress = aside.getByRole('switch', { name: '진행 소식 보이기' });
  await expect(progress).toBeChecked();
  const shown = await aside.locator('.conversation-message.category-progress').count();
  expect(shown).toBeGreaterThan(0);
  await progress.click();
  await expect(aside.locator('.conversation-message.category-progress')).toHaveCount(0);
  await expect(aside.locator('.conversation-hidden-note')).toContainText('진행 소식');
  await page.reload();
  await expect(
    page.getByRole('complementary', { name: '동료의 업무 카드' }).getByRole('switch'),
  ).not.toBeChecked();
  await page.screenshot({ path: '.local/card-chat-quiet.png' });
});

test('Enter sends from the chat box, Shift+Enter breaks the line', async ({ page }) => {
  const aside = await card(page);
  const box = aside.locator('.card-composer textarea');
  await box.fill('첫 줄');
  await box.press('Shift+Enter');
  await box.pressSequentially('둘째 줄');
  await expect(box).toHaveValue('첫 줄\n둘째 줄');
  await box.press('Enter');
  await expect
    .poll(() => page.evaluate(() => (window as any).sent))
    .toEqual([['demo:0', '첫 줄\n둘째 줄']]);
  await expect(box).toHaveValue('');
});

test('The card menu holds the rest, and works from the keyboard', async ({ page }) => {
  const aside = await card(page);
  const more = aside.getByRole('button', { name: '카드 메뉴' });
  await more.click();
  const menu = aside.getByRole('menu');
  for (const name of ['사무실에 고정', '이름 바꾸기', '이 동료 꾸미기', '원본 위치 열기'])
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  expect(await page.evaluate(() => (window as any).cardCalls)).toEqual([]);
  // A second Esc is for the card.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as any).cardCalls)).toEqual(['close']);
  await expect(aside.getByRole('button', { name: '인수인계 꾸리기' })).toHaveCount(0);
});

test('Without a terminal found the chat box still takes writing; the send says why', async ({
  page,
}) => {
  const aside = await card(page, { terminal: false });
  const box = aside.locator('.card-composer textarea');
  await expect(box).toBeEditable();
  await expect(aside.locator('.card-composer')).toContainText('보낼 때 다시 확인해요');
  // The desktop app looks again on send and refuses: the reason shows, the text stays.
  await page.evaluate(() => {
    (window as any).office.send = async () => {
      throw new Error('이 세션의 터미널을 찾지 못했어요');
    };
  });
  await box.fill('테스트 돌려 줘');
  await box.press('Enter');
  await expect(aside.getByRole('alert')).toContainText('터미널을 찾지 못했어요');
  await expect(box).toHaveValue('테스트 돌려 줘');
  await expect(aside.locator('.message-pending')).toHaveCount(0);
});

test('Not waiting for input as last seen, a send still goes: the desktop app checks again', async ({
  page,
}) => {
  const aside = await card(page, { canSend: false });
  const box = aside.locator('.card-composer textarea');
  await box.fill('계속해');
  await box.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).sent.length)).toBe(1);
});

test('Text in the prompt: send it as it is, or clear it and send mine', async ({ page }) => {
  const aside = await card(page);
  await page.evaluate(() => {
    const w = window as any;
    w.office.send = async (id: string, text: string, opts?: { replaceDraft?: string }) => {
      if (!opts?.replaceDraft)
        return {
          status: 'needs-confirm',
          draft: 'run the tests',
          agent: 'Claude',
          maybeSuggestion: true,
        };
      w.sent.push([id, text, opts.replaceDraft]);
      return { status: 'sent', message: '보냈어요' };
    };
  });
  const box = aside.locator('.card-composer textarea');
  await box.fill('내 글');
  await box.press('Enter');
  await aside.getByRole('button', { name: '이 글 그대로 보내기' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).sent.at(-1)))
    .toEqual(['demo:0', 'run the tests', 'run the tests']);
  // What I wrote stays for later.
  await expect(box).toHaveValue('내 글');
  await box.press('Enter');
  await aside.getByRole('button', { name: '지우고 내 글 보내기' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).sent.at(-1)))
    .toEqual(['demo:0', '내 글', 'run the tests']);
  await expect(box).toHaveValue('');
  // A draft of several lines is never offered "as is" (read off the screen, indents trimmed).
  await page.evaluate(() => {
    const w = window as any;
    w.office.send = async () => ({
      status: 'needs-confirm',
      draft: 'if True:\nprint(1)',
      agent: 'Claude',
    });
  });
  await box.fill('또');
  await box.press('Enter');
  await expect(aside.getByRole('button', { name: '지우고 내 글 보내기' })).toBeVisible();
  await expect(aside.getByRole('button', { name: '이 글 그대로 보내기' })).toHaveCount(0);
});

test('A colleague waiting for the person makes the terminal button the primary one', async ({
  page,
}) => {
  // demo:3 is calling.
  const aside = await card(page, { id: 'demo:3' });
  const go = aside.locator('.card-actions').getByRole('button', { name: 'Orca로 이동' });
  await expect(go).toHaveClass(/primary/);
  await go.click();
  await expect.poll(() => page.evaluate(() => (window as any).jumps)).toEqual(['demo:3']);
  // The independent window pin stays distinct from the office pin in the menu.
  await aside
    .locator('.card-head')
    .getByRole('button', { name: '이 카드 고정', exact: true })
    .click();
});

test('Sharing the screen hides recent work and names but keeps the chat card usable', async ({
  page,
}) => {
  const aside = await card(page, { privacy: true });
  await expect(aside.locator('.artifact-list')).toHaveCount(0);
  await expect(aside.locator('.card-head h2')).not.toContainText('코코');
  await expect(aside.locator('.card-composer textarea')).toBeVisible();
});

test('Filters fold behind a small button in the card', async ({ page }) => {
  const aside = await card(page);
  // Reachable at the newest message too (it sticks to the top of the chat).
  await expect(aside.locator('.conversation-sticky')).toHaveCSS('position', 'sticky');
  await expect(aside.locator('.conversation-toolbar')).toHaveCount(0);
  const toggle = aside.getByRole('button', { name: '필터' });
  await toggle.click();
  await expect(aside.locator('.conversation-toolbar')).toBeVisible();
  // Scrolled to the newest message, the opened filters never cover the button that folds them.
  await aside.locator('.inspector-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await toggle.click();
  await expect(aside.locator('.conversation-toolbar')).toHaveCount(0);
  await expect(aside.locator('.conversation-range')).toHaveCount(0);
});

test("A helper's card leads back to the colleague it works for", async ({ page }) => {
  const aside = await card(page, { id: 'demo:helper' });
  await aside.getByRole('tab', { name: '작업 정보' }).click();
  const parent = aside.getByRole('button', { name: /부모 작업/ });
  await expect(parent).toBeVisible();
  await parent.click();
  await expect(aside.locator('.card-head h2')).toContainText('코코');
});

test('Pressing the header moves the card; its buttons do not', async ({ page }) => {
  const aside = await card(page);
  const head = aside.locator('.card-head');
  const box = (await head.boundingBox())!;
  // The empty space between the name and the buttons.
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => (window as any).cardCalls))
    .toEqual(['drag-start', 'drag-end']);
  await head.getByRole('button', { name: '카드 메뉴', exact: true }).click();
  expect(await page.evaluate(() => (window as any).cardCalls)).toEqual(['drag-start', 'drag-end']);
});

test('Details read as grouped rows', async ({ page }) => {
  const aside = await card(page);
  await aside.getByRole('tab', { name: '작업 정보' }).click();
  // Status, where it works, its helper (the fixture's), its usage.
  await expect(aside.locator('.info-group')).toHaveCount(4);
  await expect(aside.locator('.info-group').first()).toContainText('상태');
  await expect(aside.getByRole('button', { name: /실행 경로/ })).toBeVisible();
  await page.screenshot({ path: '.local/card-info.png' });
});

test('At the smallest card width the tabs never run under the filter or the switch', async ({
  page,
}) => {
  const aside = await card(page);
  await page.setViewportSize({ width: 380, height: 480 });
  const tabs = (await aside.locator('.inspector-tabs').boundingBox())!;
  const filter = (await aside.getByRole('button', { name: '필터' }).boundingBox())!;
  expect(tabs.x + tabs.width).toBeLessThanOrEqual(filter.x);
  await aside.getByRole('tab', { name: '기억 메모' }).click();
  await expect(aside.getByRole('tab', { name: '기억 메모' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('What the person sends shows at once, marked as waiting, until the record has it', async ({
  page,
}) => {
  const aside = await card(page);
  const box = aside.locator('.card-composer textarea');
  await box.fill('작업 끝나면 테스트도 돌려 줘');
  await box.press('Enter');
  const waiting = aside.locator('.message-pending');
  await expect(waiting).toContainText('작업 끝나면 테스트도 돌려 줘');
  await expect(waiting).toContainText('대화 기록 확인 중');
});

test('The same words sent twice wait as two bubbles', async ({ page }) => {
  const aside = await card(page);
  const box = aside.locator('.card-composer textarea');
  for (let i = 0; i < 2; i++) {
    await box.fill('계속해 줘');
    await box.press('Enter');
  }
  await expect(aside.locator('.message-pending')).toHaveCount(2);
});

test('Pressing the text box asks for the keyboard (another app may still hold it)', async ({
  page,
}) => {
  const aside = await card(page);
  await aside.locator('.card-composer textarea').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).cardCalls.includes('focus')))
    .toBe(true);
});

test('Position memory and pinning this card are independent native actions', async ({ page }) => {
  const aside = await card(page);
  const position = aside.getByRole('button', { name: '위치 기억', exact: true });
  const pin = aside.getByRole('button', { name: '이 카드 고정', exact: true });
  await expect(position).toHaveAttribute('aria-pressed', 'false');
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await position.click();
  await expect(position).toHaveAttribute('aria-pressed', 'true');
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect(position).toHaveAttribute('aria-pressed', 'true');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect(position).toHaveAttribute('aria-pressed', 'true');
  await position.click();
  await expect(position).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => (window as any).cardCalls)).toEqual([
    'position-on',
    'pin-on',
    'pin-off',
    'position-off',
  ]);
  // An independent window is an explicit choice; an old keep-open preference never pins it.
  await page.evaluate(() => localStorage.setItem('office:card-keep', 'on'));
  await page.reload();
  await expect(page.getByRole('button', { name: '이 카드 고정', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('Failed native window actions leave the displayed state unchanged and show the error', async ({
  page,
}) => {
  const aside = await card(page);
  await page.evaluate(() => {
    (window as any).office.card = async () => {
      throw Error('위치를 저장하지 못했어요');
    };
  });
  await aside.getByRole('button', { name: '위치 기억', exact: true }).click();
  await expect(aside.getByRole('button', { name: '위치 기억', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByRole('status')).toContainText('위치를 저장하지 못했어요');
});

test('A run of progress notes reads as one: who and when only on the first, a pause gets a time line', async ({
  page,
}) => {
  // Late morning yesterday: the hour never crosses midnight, and the fixture's own notice (at
  // the real clock) always comes after it.
  const day = new Date();
  day.setDate(day.getDate() - 1);
  const now = day.setHours(11, 0, 0, 0);
  const ev = (id: string, at: number, kind: OfficeEvent['kind'], text: string, phase?: string) =>
    ({ id, at, kind, text, phase, sourceRef: 'demo' }) as OfficeEvent;
  const aside = await card(page, {
    events: [
      ev('u1', now - 60 * 60_000, 'user', '정리해 줘'),
      ev('p1', now - 59 * 60_000, 'assistant', '파일을 읽어요', 'commentary'),
      ev('p2', now - 58 * 60_000, 'assistant', '고칠 곳을 찾았어요', 'commentary'),
      ev('p3', now - 57 * 60_000, 'assistant', '테스트를 돌려요', 'commentary'),
      ev('f1', now - 56 * 60_000, 'assistant', '다 했어요', 'final'),
      ev('u2', now - 5 * 60_000, 'user', '고마워'),
    ],
  });
  const msg = (id: string) => aside.locator(`.conversation-message[data-event-id="${id}"]`);
  await expect(msg('p1')).not.toHaveClass(/is-continued/);
  await expect(msg('p2')).toHaveClass(/is-continued/);
  await expect(msg('p3')).toHaveClass(/is-continued/);
  // The answer after the notes says who again.
  await expect(msg('f1')).not.toHaveClass(/is-continued/);
  await expect(msg('p2').locator('.message-meta')).toHaveCSS('opacity', '0');
  // Focus (the keyboard's hover) shows them, buttons included.
  await msg('p2').locator('.message-meta button').first().focus();
  await expect(msg('p2').locator('.message-meta')).toHaveCSS('opacity', '1');
  await expect(msg('p2').locator('.message-meta button').first()).toHaveCSS('opacity', '1');
  await expect(msg('p2').locator('.message-meta time')).toBeVisible();
  // Fifty minutes later: a time line before the next message, and it starts a new run.
  // (The fixture's own notice lands at the real clock, so only this line is counted on.)
  await expect(
    aside.locator('.conversation-pause + .conversation-message[data-event-id="u2"]'),
  ).toHaveCount(1);
  await expect(
    aside.locator('.conversation-pause + .conversation-message[data-event-id="p2"]'),
  ).toHaveCount(0);
  await expect(msg('u2')).not.toHaveClass(/is-continued/);
  await page.screenshot({ path: '.local/card-runs.png' });
});

test('Codex Desktop identifies the destination and sends a card reply without queue claims', async ({
  page,
}) => {
  const aside = await card(page, { codex: true });
  await page.evaluate(() => {
    const w = window as any;
    w.codexPhase = 'desktop';
    w.fixture.sessions[0].updatedAt += 1000;
    w.fixture.version++;
    w.publish(structuredClone(w.fixture));
  });
  const input = aside.getByPlaceholder(/Codex Desktop의 이 대화로 보내요/);
  await expect(input).toBeVisible();
  await expect(aside.locator('.terminal-send-bar')).toContainText('Codex Desktop');
  await expect(aside.locator('.terminal-send-bar')).not.toContainText('세션 대기열');
  await input.fill('Desktop 연결 합성 검증');
  await aside.getByRole('button', { name: '보내기', exact: true }).click();
  expect(await page.evaluate(() => (window as any).sent)).toEqual([
    ['demo:0', 'Desktop 연결 합성 검증'],
  ]);
  await expect(input).toHaveValue('');
});
