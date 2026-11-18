import { test, expect, type Page } from '@playwright/test';
import './korean';
import { demoSnapshot } from '../../src/lib/demo';
import type { InputRequest, PromptView } from '../../src/shared/types';

const QUESTION: InputRequest = {
  kind: 'question',
  questions: [
    {
      header: 'Color',
      question: 'Pick a color',
      multiSelect: false,
      options: [
        { label: 'Red', description: '따뜻하고 강렬한 색' },
        { label: 'Green', description: '자연스럽고 차분한 색' },
        { label: 'Blue', description: '시원하고 안정적인 색' },
      ],
    },
  ],
};
const TWO: InputRequest = {
  kind: 'question',
  questions: [
    {
      header: 'Fruit',
      question: 'Pick fruits',
      multiSelect: true,
      options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
    },
    {
      header: 'Size',
      question: 'Pick a size',
      multiSelect: false,
      options: [{ label: 'Small' }, { label: 'Large' }],
    },
  ],
};
const PLAN: InputRequest = {
  kind: 'plan',
  plan: '## 계획\n\n1. hello.txt를 만든다\n2. 내용을 확인한다',
  planFile: '~/.claude/plans/hello.md',
};
/** A permission prompt is never stored with its input: only the tool name is known. */
const BASH: InputRequest = { kind: 'permission', tool: 'Bash' };
/** The one-shot choices the desktop app reads from the screen (never auto mode, never always). */
const CHOICES = {
  plan: [{ number: 2, label: 'Yes, manually approve edits', role: 'allow' }],
  permission: [
    { number: 1, label: 'Yes', role: 'allow' },
    { number: 3, label: 'No', role: 'deny' },
  ],
};

/** Coco (Claude) is calling with `request`; the desktop app reads the dialog as `view`. */
async function desktop(
  page: Page,
  request: InputRequest,
  options: {
    view?: 'ready' | PromptView;
    /** The screen in turn: the next one after every answer (a batch of prompts). */
    views?: PromptView[];
    /** The tool the record marks as waiting (a batch: its last call). */
    eventTool?: string;
    privacy?: boolean;
    cancel?: boolean;
    /** How long an answer takes (ms). */
    slow?: number;
    /** No Orca or tmux terminal has the session. */
    noTerminal?: boolean;
  } = {},
) {
  const s = demoSnapshot();
  const now = Date.now();
  const coco = s.sessions[0];
  Object.assign(coco, {
    status: 'call',
    observedStatus: 'call',
    updatedAt: now,
    events: [
      { id: 'u1', kind: 'user', text: '해 줘', at: now - 5000, sourceRef: 'x' },
      {
        id: 'toolu_q:tool0',
        kind: 'tool',
        text: '도구 실행',
        tool: options.eventTool ?? (request.kind === 'permission' ? 'Bash' : 'AskUserQuestion'),
        intent: 'request-input',
        callId: 'toolu_q',
        at: now - 1000,
        sourceRef: 'x',
        // A live permission prompt carries no request: the card derives it from the tool.
        ...(request.kind === 'permission' ? {} : { request }),
      },
    ],
  });
  s.preferences.privacy = !!options.privacy;
  s.notices = [];
  const view =
    options.view === undefined || options.view === 'ready'
      ? {
          status: 'ready',
          agent: 'Claude',
          kind: request.kind,
          eventId: 'toolu_q:tool0',
          callId: 'toolu_q',
          choices: request.kind === 'question' ? [] : CHOICES[request.kind],
          ...(request.kind === 'question'
            ? { other: request.questions.map((q) => !q.multiSelect) }
            : { more: true }),
          ...(request.kind === 'permission'
            ? { subject: { title: 'Bash command', command: 'echo hi > hello.txt' } }
            : {}),
        }
      : options.view;
  await page.addInitScript(
    ({ s, views, cancel, slow, noTerminal }) => {
      const w = window as any;
      w.step = 0;
      w.answers = [];
      w.prompts = 0;
      w.settings = { questions: 'unset', permissions: 'unset' };
      w.office = {
        snapshot: async () => structuredClone(s),
        detail: async (id: string) => structuredClone(s.sessions.find((x: any) => x.id === id)),
        visit: async () => structuredClone(s),
        preferences: async () => structuredClone(s),
        artifacts: async () => [],
        subscribe: () => () => {},
        terminalSend: async () => true,
        jump: async () => ({ action: 'focused', text: 'tmux work:1.0 패널을 선택했어요' }),
        terminals: async (ids: string[]) =>
          Object.fromEntries(
            (noTerminal ? [] : ids).map((id) => [
              id,
              {
                kind: 'tmux',
                label: 'work:1.0',
                status: 'waiting',
                canSend: false,
                canFocus: true,
              },
            ]),
          ),
        prompt: async () => {
          w.prompts++;
          return structuredClone(views[Math.min(w.step, views.length - 1)]);
        },
        answer: async (id: string, choice: unknown) => {
          w.answers.push({ id, choice });
          if (slow) await new Promise((r) => setTimeout(r, slow));
          if (cancel) return { status: 'cancelled', message: '' };
          w.step++;
          return { status: 'answered', message: 'tmux work:1.0에서 답했어요' };
        },
        answerSettings: async (patch?: Record<string, boolean>) => {
          for (const [key, on] of Object.entries(patch ?? {})) w.settings[key] = on ? 'on' : 'off';
          return structuredClone(w.settings);
        },
      };
    },
    {
      s,
      views: options.views ?? [view],
      cancel: !!options.cancel,
      slow: options.slow ?? 0,
      noTerminal: !!options.noTerminal,
    },
  );
  await page.goto('/');
}
const openCoco = (page: Page) =>
  page.locator('[data-station-id="demo:0"] .office-pet').first().click();
const answers = (page: Page) => page.evaluate(() => (window as any).answers);

test('A question shows its options; one click answers it through the desktop app', async ({
  page,
}) => {
  await desktop(page, QUESTION);
  // The bubble says what it asks.
  await expect(page.locator('[data-station-id="demo:0"] .speech-bubble')).toContainText(
    'Pick a color',
  );
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('Color');
  await expect(card).toContainText('Pick a color');
  await expect(card).toContainText('시원하고 안정적인 색');
  await card.getByRole('button', { name: /Blue/ }).click();
  await expect(page.locator('.toast')).toContainText('tmux work:1.0에서 답했어요');
  expect(await answers(page)).toEqual([
    {
      id: 'demo:0',
      choice: {
        kind: 'question',
        eventId: 'toolu_q:tool0',
        callId: 'toolu_q',
        answers: [{ options: [2] }],
      },
    },
  ]);
  // Sent: the buttons go until the record says what happened.
  await expect(card).toContainText('보냈어요');
  await expect(card.getByRole('button', { name: /Red/ })).toHaveCount(0);
  await page.screenshot({ path: '.local/request-question.png' });
});

test('Typed words and several questions are collected, then sent together', async ({ page }) => {
  await desktop(page, TWO);
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('여러 개 고르기');
  const send = card.getByRole('button', { name: '답 보내기' });
  await expect(send).toBeDisabled();
  await card.getByRole('checkbox', { name: /Apple/ }).click();
  await card.getByRole('checkbox', { name: /Cherry/ }).click();
  await expect(card.getByRole('checkbox', { name: /Cherry/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(send).toBeDisabled();
  // The second question (single choice) takes typed words instead.
  await card.getByRole('button', { name: '직접 입력' }).last().click();
  await card.getByRole('textbox', { name: '질문 2에 직접 쓴 답' }).fill('중간 크기');
  await send.click();
  expect((await answers(page))[0].choice).toEqual({
    kind: 'question',
    eventId: 'toolu_q:tool0',
    callId: 'toolu_q',
    answers: [{ options: [0, 2] }, { other: '중간 크기' }],
  });
});

test('A plan folds open; its approval buttons are the dialog’s own choices', async ({ page }) => {
  await desktop(page, PLAN);
  await expect(page.locator('[data-station-id="demo:0"] .speech-bubble')).toContainText(
    '플랜 승인',
  );
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('승인할 플랜');
  await card.getByRole('button', { name: '플랜 펼치기' }).click();
  await expect(card.locator('.request-plan-body')).toHaveClass(/open/);
  await expect(card.locator('.request-plan-body')).toContainText('hello.txt를 만든다');
  // Auto mode and the text row are the terminal's: never buttons here, and the card says so.
  await expect(card.getByRole('button', { name: /Tell Claude/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /auto mode/ })).toHaveCount(0);
  await expect(card).toContainText('터미널에서 골라 주세요');
  await card.getByRole('button', { name: /manually approve/ }).click();
  expect((await answers(page))[0].choice).toEqual({
    kind: 'plan',
    eventId: 'toolu_q:tool0',
    callId: 'toolu_q',
    number: 2,
    label: 'Yes, manually approve edits',
  });
});

test('A permission prompt shows the command its screen shows; only Yes and No are offered', async ({
  page,
}) => {
  await desktop(page, BASH);
  await expect(page.locator('[data-station-id="demo:0"] .speech-bubble')).toContainText(
    'Bash 허락할까요?',
  );
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('권한 확인 · Bash');
  await expect(card).toContainText('터미널 화면에 보이는 그대로');
  await expect(card.locator('.request-command')).toHaveText('echo hi > hello.txt');
  await expect(card.locator('.request-choice')).toHaveCount(2);
  await expect(card.getByRole('button', { name: /ask again|always/ })).toHaveCount(0);
  await expect(card).toContainText('터미널에서 골라 주세요');
  await expect(card.locator('.request-choice.role-allow')).toHaveClass(/primary/);
  await page.screenshot({ path: '.local/request-permission.png' });
  await card.getByRole('button', { name: /^3\s*No$/ }).click();
  expect((await answers(page))[0].choice).toEqual({
    kind: 'permission',
    eventId: 'toolu_q:tool0',
    callId: 'toolu_q',
    number: 3,
    label: 'No',
  });
});

test('Declining the first-use confirmation sends nothing and keeps the buttons', async ({
  page,
}) => {
  await desktop(page, BASH, { cancel: true });
  await openCoco(page);
  const card = page.locator('.request-card');
  await card.getByRole('button', { name: /^1\s*Yes$/ }).click();
  await expect(card.getByRole('button', { name: /^1\s*Yes$/ })).toBeEnabled();
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(await answers(page)).toHaveLength(1);
});

test('When the screen differs (or it is hidden), it says why and offers no buttons', async ({
  page,
}) => {
  await desktop(page, BASH, {
    view: {
      status: 'unavailable',
      agent: 'Claude',
      reason: 'mismatch',
      message: '화면의 질문이 이 요청인지 확실하지 않아요. 터미널에서 답해 주세요.',
    },
  });
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('권한 확인 · Bash');
  // Nothing of the call is known without the screen: no command is shown.
  await expect(card.locator('.request-command')).toHaveCount(0);
  await expect(card).toContainText('이 요청인지 확실하지 않아요');
  await expect(card.locator('.request-choice')).toHaveCount(0);
  // The card's own jump stays there, under it.
  await expect(
    page.locator('.card-actions').getByRole('button', { name: 'tmux로 이동' }),
  ).toBeVisible();
});

const planView = (extra: Partial<Extract<PromptView, { status: 'ready' }>> = {}) =>
  ({
    status: 'ready',
    agent: 'Claude',
    kind: 'plan',
    eventId: 'toolu_q:tool0',
    callId: 'toolu_q',
    choices: CHOICES.plan,
    more: true,
    ...extra,
  }) as PromptView;

test('Turned off in Settings: the plan’s approval is still offered, and the press asks first', async ({
  page,
}) => {
  // The desktop app shows the choices with the setting off; main asks natively on the press.
  await desktop(page, PLAN, { view: planView({ consent: 'off' }), cancel: true });
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('승인할 플랜');
  await expect(card).toContainText('선택지를 누르면 다시 켤지 한 번 물어봐요');
  const approve = card.getByRole('button', { name: /manually approve/ });
  await approve.click();
  // Declined in the native confirmation: nothing sent, the button stays.
  expect(await answers(page)).toHaveLength(1);
  await expect(approve).toBeEnabled();
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('Never asked yet: the card says the first answer asks once, then answers', async ({
  page,
}) => {
  await desktop(page, PLAN, { view: planView({ consent: 'unset' }) });
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('여기서 처음 답할 때 한 번 확인해요');
  await card.getByRole('button', { name: /manually approve/ }).click();
  await expect(page.locator('.toast')).toContainText('tmux work:1.0에서 답했어요');
  expect((await answers(page))[0].choice).toMatchObject({ kind: 'plan', number: 2 });
});

test('A plan the card cannot answer always says why', async ({ page }) => {
  // The screen is this plan, but no one-time choice is on it (every Yes withheld).
  await desktop(page, PLAN, { view: planView({ choices: [], more: true }) });
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('승인할 플랜');
  await expect(card.locator('.request-choice')).toHaveCount(0);
  await expect(card).toContainText('한 번짜리 선택지가 없어요');
});

test('A plan with no Orca or tmux terminal found says so', async ({ page }) => {
  await desktop(page, PLAN, { noTerminal: true });
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('승인할 플랜');
  await expect(card).toContainText('Orca·tmux 터미널을 찾지 못했어요');
  await expect(card.locator('.request-choice')).toHaveCount(0);
});

test('A plan whose screen cannot be checked says why, with the jump', async ({ page }) => {
  await desktop(page, PLAN, {
    view: {
      status: 'unavailable',
      agent: 'Claude',
      reason: 'mismatch',
      message: '화면의 질문이 이 요청인지 확실하지 않아요. 터미널에서 답해 주세요.',
    },
  });
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('승인할 플랜');
  await expect(card).toContainText('이 요청인지 확실하지 않아요');
  await expect(card.locator('.request-choice')).toHaveCount(0);
  await expect(
    page.locator('.card-actions').getByRole('button', { name: 'tmux로 이동' }),
  ).toBeVisible();
});

test('Hidden-screen mode never shows what is asked', async ({ page }) => {
  await desktop(page, BASH, { privacy: true });
  await openCoco(page);
  // The card opens with the colleague hidden, and nothing of the request.
  await expect(page.locator('.card-head h2')).toContainText('숨긴 동료');
  await expect(page.locator('.request-card')).toHaveCount(0);
  await expect(page.getByText('echo hi > hello.txt')).toHaveCount(0);
});

test('Settings: both answering switches start off and turn on through the app', async ({
  page,
}) => {
  await desktop(page, BASH);
  await page.getByRole('button', { name: /설정/ }).first().click();
  const questions = page.getByRole('switch', { name: '질문·플랜에 답하기' });
  const permissions = page.getByRole('switch', { name: '권한 확인에 답하기' });
  await expect(questions).toHaveAttribute('aria-checked', 'false');
  await expect(permissions).toHaveAttribute('aria-checked', 'false');
  await permissions.click();
  await expect(permissions).toHaveAttribute('aria-checked', 'true');
  await expect(questions).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => (window as any).settings)).toEqual({
    questions: 'unset',
    permissions: 'on',
  });
  // Turning it off is remembered as an explicit off.
  await permissions.click();
  await expect(permissions).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => (window as any).settings)).toEqual({
    questions: 'unset',
    permissions: 'off',
  });
});

const permissionView = (
  callId: string,
  tool: string,
  title: string,
  what: Record<string, string>,
) =>
  ({
    status: 'ready',
    agent: 'Claude',
    kind: 'permission',
    eventId: 'toolu_q:tool0',
    callId,
    choices: CHOICES.permission,
    more: true,
    tool,
    subject: { title, ...what },
  }) as PromptView;

test('A batch: each call is named by the screen, answered once, and the next one follows', async ({
  page,
}) => {
  // Bash first, then Write: the record marks Write; the screen asks about Bash, then Write.
  await desktop(page, BASH, {
    eventTool: 'Write',
    slow: 300,
    views: [
      permissionView('toolu_bash', 'Bash', 'Bash command', { command: 'ls' }),
      permissionView('toolu_write', 'Write', 'Create file', { path: 'a.txt' }),
    ],
  });
  await openCoco(page);
  const card = page.locator('.request-card');
  // The heading is the call the buttons answer (Bash), never the record's (Write).
  await expect(card).toContainText('권한 확인 · Bash');
  await expect(card).not.toContainText('권한 확인 · Write');
  await expect(card.locator('.request-command')).toHaveText('ls');
  // A double click sends once.
  await card.getByRole('button', { name: /^1\s*Yes$/ }).dblclick();
  await expect(page.locator('.toast')).toContainText('tmux work:1.0에서 답했어요');
  // The next call of the batch comes back with its own heading and buttons.
  await expect(card).toContainText('권한 확인 · Write', { timeout: 10_000 });
  await expect(card.locator('.request-command')).toHaveText('a.txt');
  await card.getByRole('button', { name: /^3\s*No$/ }).click();
  await expect.poll(async () => (await answers(page)).length).toBe(2);
  expect((await answers(page)).map((a: any) => [a.choice.callId, a.choice.label])).toEqual([
    ['toolu_bash', 'Yes'],
    ['toolu_write', 'No'],
  ]);
});

/** Claude Code 2.1.322: a form of three, the first with previews (#191). */
const FORM: InputRequest = {
  kind: 'question',
  questions: [
    {
      header: '구역',
      question: '예시 화면을 어디에 둘까요?',
      multiSelect: false,
      options: [
        { label: '샘플 목록에 화면 추가 (추천)', preview: '┌ 목록 ┐\n│ 항목 │\n└──────┘' },
        { label: '별도 폴더에 단독 예시', preview: '단독 화면' },
      ],
    },
    {
      header: '작업 순서',
      question: '어떤 순서로 진행할까요?',
      multiSelect: true,
      options: [{ label: '먼저 뼈대' }, { label: '다음 연결' }],
    },
    {
      header: '저장소',
      question: '어느 저장소에 둘까요?',
      multiSelect: false,
      options: [{ label: '지금 저장소' }, { label: '새 저장소' }],
    },
  ],
};
const formView = {
  status: 'ready',
  agent: 'Claude',
  kind: 'question',
  eventId: 'toolu_q:tool0',
  callId: 'toolu_q',
  choices: [],
  other: [false, false, true],
  noText: ['preview', 'multi', null],
  chat: true,
} as PromptView;

test('A form with previews: one choice per question, previews fold open, then sent together', async ({
  page,
}) => {
  await desktop(page, FORM, { view: formView });
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('1/3');
  // The preview is folded under its option until asked for, drawn as written.
  const toggles = card.getByRole('button', { name: '미리보기 펼치기' });
  await expect(toggles).toHaveCount(2);
  await expect(card.locator('.request-preview-body')).toHaveCount(0);
  await toggles.first().click();
  await expect(card.locator('.request-preview-body')).toHaveText('┌ 목록 ┐\n│ 항목 │\n└──────┘');
  await card.getByRole('button', { name: '미리보기 접기' }).click();
  await expect(card.locator('.request-preview-body')).toHaveCount(0);
  // What stays in the terminal is said where it applies.
  await expect(card).toContainText('노트(n)는 터미널에서 입력해 주세요');
  await expect(card).toContainText('여러 개 고르는 질문의 직접 입력은 터미널에서 해 주세요');
  await expect(card.getByRole('button', { name: '직접 입력' })).toHaveCount(1);
  const send = card.getByRole('button', { name: '답 보내기' });
  await card.getByRole('radio', { name: /별도 폴더에 단독 예시/ }).click();
  await card.getByRole('checkbox', { name: /먼저 뼈대/ }).click();
  await card.getByRole('checkbox', { name: /다음 연결/ }).click();
  await expect(send).toBeDisabled();
  await card.getByRole('radio', { name: /지금 저장소/ }).click();
  await page.screenshot({ path: '.local/request-preview-form.png' });
  await send.click();
  expect((await answers(page))[0].choice).toEqual({
    kind: 'question',
    eventId: 'toolu_q:tool0',
    callId: 'toolu_q',
    answers: [{ options: [1] }, { options: [0, 1] }, { options: [0] }],
  });
});

test('Answering by chatting instead leaves the questions through the dialog’s own row', async ({
  page,
}) => {
  await desktop(page, FORM, { view: formView });
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('Claude가 무엇을 이야기할지 물으면 아래 채팅으로 답해 주세요');
  await card.getByRole('button', { name: '질문 대신 채팅으로 답하기' }).click();
  await expect(page.locator('.toast')).toContainText('tmux work:1.0에서 답했어요');
  expect((await answers(page))[0].choice).toEqual({
    kind: 'question',
    eventId: 'toolu_q:tool0',
    callId: 'toolu_q',
    chat: true,
  });
});

test('A new layout it cannot read says so, with no chat button; previews stay readable', async ({
  page,
}) => {
  await desktop(page, FORM, {
    view: {
      status: 'unavailable',
      agent: 'Claude',
      reason: 'unknown',
      message:
        '터미널에 열린 창을 여기서 읽지 못했어요(처음 보는 모양이에요). 터미널에서 답해 주세요.',
    },
  });
  await openCoco(page);
  const card = page.locator('.request-card');
  await expect(card).toContainText('처음 보는 모양이에요');
  await expect(card.getByRole('button', { name: '질문 대신 채팅으로 답하기' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '미리보기 펼치기' })).toHaveCount(2);
});
