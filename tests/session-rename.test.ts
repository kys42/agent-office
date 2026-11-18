import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  checkSessionTitle,
  renameBlock,
  renameWhen,
  SESSION_RENAME,
  SESSION_TITLE_MAX,
  sessionRenameFor,
  titleProblemMessage,
} from '../src/shared/session-rename.js';
import { messagesFor, setLocale } from '../src/shared/i18n/index.js';
import { PROVIDERS, type SendResult, type TerminalTarget } from '../src/shared/types.js';
import { renameSession, type SessionRenameDeps } from '../desktop/session-rename.js';
import {
  claudeCodeComposer,
  codexQueueComposer,
  unsupportedComposer,
  type ComposerAdapter,
} from '../desktop/composer/index.js';
import {
  hostName,
  sendToTerminal,
  TerminalInputError,
  type LiveTerminal,
  type TerminalDeps,
  type TerminalSendOptions,
} from '../desktop/terminals.js';

// Messages are asserted in Korean: pin the language so results never depend on the machine.
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');
const ko = messagesFor('ko').inspector.sessionTitle;

const SESSION = '6dfc48fb-f723-4025-aab6-eaa73f743e5b';
const START = 'Tue Oct  6 13:05:12 2026';
const SOCKET = '/private/tmp/tmux-501/default';

const live = (status = 'idle'): LiveTerminal => ({
  process: { pid: 4242, sessionId: SESSION, procStart: START, status, updatedAt: 0 },
  host: { kind: 'tmux', socket: SOCKET, pane: '%3', label: 'work:1.0' },
});

test('A title is one trimmed line; Korean is welcome up to the limit', () => {
  assert.deepEqual(checkSessionTitle('  결제 모듈 리팩터링  '), {
    ok: true,
    title: '결제 모듈 리팩터링',
  });
  assert.deepEqual(checkSessionTitle('Fix CI · 회귀 테스트 정리 (2/3)'), {
    ok: true,
    title: 'Fix CI · 회귀 테스트 정리 (2/3)',
  });
  const longest = '가'.repeat(SESSION_TITLE_MAX);
  assert.deepEqual(checkSessionTitle(longest), { ok: true, title: longest });
  assert.deepEqual(checkSessionTitle(`${longest}나`), { ok: false, problem: 'tooLong' });
  // Trimmed before measuring: surrounding spaces never count against the limit.
  assert.deepEqual(checkSessionTitle(`  ${longest}  `), { ok: true, title: longest });
  for (const empty of ['', '   ', '\u3000', 42, null, undefined, { title: 'x' }])
    assert.deepEqual(checkSessionTitle(empty), { ok: false, problem: 'empty' });
});

test('Control characters and line breaks are refused, never stripped into another title', () => {
  for (const raw of [
    'first\nsecond',
    'trailing break\n',
    'carriage\rreturn',
    'tab\there',
    'escape \u001b[31m red',
    'bell\u0007',
    'delete\u007f',
    'c1 next line\u0085',
    'line\u2028separator',
    'paragraph\u2029separator',
    'bidi \u202eoverride',
    'isolate \u2066x\u2069',
    'mark\u200f',
  ])
    assert.deepEqual(
      checkSessionTitle(raw),
      { ok: false, problem: 'control' },
      JSON.stringify(raw),
    );
});

test('Words that open a picker, and a trailing backslash, are refused; the same characters inside words are fine', () => {
  for (const raw of ['/model', '  /clear', 'see /tmp/out', 'ask @alice', '@src/app.ts'])
    assert.deepEqual(checkSessionTitle(raw), { ok: false, problem: 'picker' }, raw);
  assert.deepEqual(checkSessionTitle('C:\\work\\'), { ok: false, problem: 'backslash' });
  for (const raw of ['feat/rename-slash', 'mail a@b.com', 'a\\b', '50% done', '#384 이름', '!중요'])
    assert.equal(checkSessionTitle(raw).ok, true, raw);
});

test('Every refusal has its own message in both languages', () => {
  for (const problem of ['empty', 'tooLong', 'control', 'picker', 'backslash'] as const) {
    for (const locale of ['ko', 'en'] as const) {
      setLocale(locale);
      assert.ok(titleProblemMessage(problem).length > 5, `${locale} ${problem}`);
    }
  }
  setLocale('en');
  assert.match(titleProblemMessage('tooLong'), new RegExp(String(SESSION_TITLE_MAX)));
  setLocale('ko');
  assert.match(titleProblemMessage('tooLong'), /100자/);
});

test('Each agent says its rename command and whether it takes it mid-turn', () => {
  // Every provider is listed, so a new agent is a decision here, not a silent default.
  assert.deepEqual(Object.keys(SESSION_RENAME).sort(), Object.keys(PROVIDERS).sort());
  const claude = sessionRenameFor('claude')!;
  assert.equal(claude.line('결제 모듈 정리'), '/rename 결제 모듈 정리');
  assert.equal(claude.whileBusy, true);
  const codex = sessionRenameFor('codex')!;
  assert.equal(codex.line('Fix CI'), '/rename Fix CI');
  assert.equal(codex.whileBusy, false);
  assert.equal(sessionRenameFor('openclaw'), null);
});

test('Busy gating: Claude takes the command mid-turn, an agent at rest only takes it waiting', () => {
  const claude = sessionRenameFor('claude')!;
  const codex = sessionRenameFor('codex')!;
  assert.equal(renameWhen(claude, 'idle', true), null);
  assert.equal(renameWhen(claude, 'busy', true), null);
  assert.equal(renameWhen(claude, 'shell', true), null);
  assert.equal(renameWhen(claude, 'waiting', false), 'notReady');
  assert.equal(renameWhen(codex, 'idle', true), null);
  assert.equal(renameWhen(codex, 'shell', true), null);
  assert.equal(renameWhen(codex, 'busy', true), 'busy');
  assert.equal(renameWhen(codex, 'waiting', false), 'notReady');
});

test('The card menu says why the rename is off, in the order the person can act on', () => {
  const claude = sessionRenameFor('claude');
  const codex = sessionRenameFor('codex');
  const tmux = (status: string, canSend = true): TerminalTarget => ({
    kind: 'tmux',
    label: 'work:1.0',
    status,
    canSend,
    canFocus: true,
  });
  const base = { sendOn: true, privacy: false };
  assert.equal(renameBlock({ ...base, command: claude, target: tmux('idle') }), null);
  assert.equal(renameBlock({ ...base, command: claude, target: tmux('busy') }), null);
  assert.equal(
    renameBlock({ ...base, command: claude, target: tmux('waiting', false) }),
    'notReady',
  );
  assert.equal(renameBlock({ ...base, command: null, target: tmux('idle') }), 'unsupported');
  assert.equal(
    renameBlock({ ...base, sendOn: false, command: claude, target: tmux('idle') }),
    'off',
  );
  assert.equal(
    renameBlock({ ...base, privacy: true, command: claude, target: tmux('idle') }),
    'privacy',
  );
  assert.equal(renameBlock({ ...base, command: claude, target: null }), 'noTerminal');
  assert.equal(
    renameBlock({ ...base, command: claude, target: { ...tmux('idle'), tabOnly: true } }),
    'noTerminal',
  );
  // A Codex CLI queue or Codex Desktop: nothing is typed, so the command would reach the model.
  const queue: TerminalTarget = {
    kind: 'codex',
    label: '',
    status: 'queue',
    canSend: true,
    canFocus: true,
    queues: true,
  };
  assert.equal(renameBlock({ ...base, command: codex, target: queue }), 'notTyped');
  assert.equal(
    renameBlock({
      ...base,
      command: codex,
      target: { ...queue, status: 'desktop', queues: false, desktop: true },
    }),
    'notTyped',
  );
  // An agent at rest only, with a typed terminal (none exists for Codex yet).
  assert.equal(renameBlock({ ...base, command: codex, target: tmux('busy') }), 'busy');
  assert.equal(renameBlock({ ...base, command: codex, target: tmux('idle') }), null);
  for (const block of [
    'unsupported',
    'off',
    'privacy',
    'noTerminal',
    'notTyped',
    'notReady',
    'busy',
  ] as const) {
    assert.ok(messagesFor('ko').inspector.sessionTitle.blocks[block]);
    assert.ok(messagesFor('en').inspector.sessionTitle.blocks[block]);
  }
});

/** Fake main wiring: records every lookup and send, never reaches a terminal. */
function fakeRename(
  over: Partial<SessionRenameDeps> & { status?: string; result?: SendResult } = {},
) {
  const sends: { live: LiveTerminal; line: string; options: TerminalSendOptions }[] = [];
  let lookups = 0;
  const deps: SessionRenameDeps = {
    composer: claudeCodeComposer,
    command: sessionRenameFor('claude'),
    live: async () => {
      lookups++;
      return live(over.status ?? 'idle');
    },
    noTerminal: async () => '터미널 없음',
    send: async (terminal, line, options) => {
      sends.push({ live: terminal, line, options });
      return over.result ?? { status: 'sent', message: 'tmux work:1.0에 보냈어요' };
    },
    ...over,
  };
  return { deps, sends, lookups: () => lookups };
}

test('Claude: one send of exactly `/rename <title>`, with no draft clearing, also mid-turn', async () => {
  for (const status of ['idle', 'busy', 'shell']) {
    const { deps, sends } = fakeRename({ status });
    const result = await renameSession('  결제 모듈 정리  ', deps);
    assert.equal(result.status, 'sent');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].line, '/rename 결제 모듈 정리');
    assert.equal(sends[0].live.process.status, status);
    // The composer is Claude's; no backup, replaceDraft or images: a draft is never cleared.
    assert.deepEqual(sends[0].options, { composer: claudeCodeComposer });
  }
});

test('Refusals come before anything is looked up or typed', async () => {
  const bad = fakeRename();
  await assert.rejects(renameSession('two\nlines', bad.deps), (e: Error) => {
    assert.ok(e instanceof TerminalInputError);
    assert.equal(e.message, ko.problems.control);
    return true;
  });
  await assert.rejects(renameSession('/clear', bad.deps), new RegExp(ko.problems.picker));
  await assert.rejects(renameSession(42, bad.deps), new RegExp(ko.problems.empty));
  assert.equal(bad.lookups(), 0);
  assert.equal(bad.sends.length, 0);

  // OpenClaw: no command at all.
  const none = fakeRename({ command: null, composer: unsupportedComposer('OpenClaw') });
  await assert.rejects(renameSession('제목', none.deps), new RegExp(ko.blocks.unsupported));
  assert.equal(none.lookups(), 0);

  // Codex CLI: its follow-ups go through the queue, which would hand `/rename` to the model.
  const codex = fakeRename({ command: sessionRenameFor('codex'), composer: codexQueueComposer });
  await assert.rejects(renameSession('제목', codex.deps), (e: Error) => {
    assert.ok(e instanceof TerminalInputError);
    assert.equal(e.message, ko.notTyped('Codex'));
    return true;
  });
  assert.equal(codex.lookups(), 0);
  assert.equal(codex.sends.length, 0);
});

test('An agent taken only at rest is refused while busy; dialogs and missing terminals refuse too', async () => {
  // A typed composer for an at-rest agent: the gating is the adapter's, not the provider's.
  const typedAtRest: ComposerAdapter = { ...claudeCodeComposer, agent: 'Codex' };
  const busy = fakeRename({
    command: sessionRenameFor('codex'),
    composer: typedAtRest,
    status: 'busy',
  });
  await assert.rejects(renameSession('제목', busy.deps), new RegExp(ko.blocks.busy));
  assert.equal(busy.sends.length, 0);
  const idle = fakeRename({ command: sessionRenameFor('codex'), composer: typedAtRest });
  await renameSession('제목', idle.deps);
  assert.deepEqual(
    idle.sends.map((s) => s.line),
    ['/rename 제목'],
  );

  const waiting = fakeRename({ status: 'waiting' });
  await assert.rejects(renameSession('제목', waiting.deps), (e: Error) => {
    assert.ok(e instanceof TerminalInputError);
    assert.equal(e.message, messagesFor('ko').desktop.terminal.notReady);
    return true;
  });
  assert.equal(waiting.sends.length, 0);

  const gone = fakeRename({ live: async () => null });
  await assert.rejects(renameSession('제목', gone.deps), /터미널 없음/);
  assert.equal(gone.sends.length, 0);
});

test('A send failure is the send’s own message, or never an invitation to resend', async () => {
  const refused = fakeRename({
    send: async () => {
      throw new TerminalInputError(messagesFor('ko').desktop.terminal.draft);
    },
  });
  await assert.rejects(
    renameSession('제목', refused.deps),
    new RegExp(messagesFor('ko').desktop.terminal.draft),
  );
  const crashed = fakeRename({
    send: async () => {
      throw new Error('spawn tmux ENOENT');
    },
  });
  await assert.rejects(renameSession('제목', crashed.deps), (e: Error) => {
    assert.ok(e instanceof TerminalInputError);
    assert.equal(e.message, messagesFor('ko').desktop.terminal.unconfirmed(hostName(live().host)));
    return true;
  });
});

// The real follow-up send under fake process and tmux calls: what reaches the pane.
const RULE = '─'.repeat(40);
const screen = (typed: string) =>
  [
    '⏺ Done.',
    '',
    `${RULE} ao-rename-test ─`,
    `❯ ${typed}`.trimEnd(),
    RULE,
    '  ⏸ manual mode on',
  ].join('\n');

function fakeTerminal(sessionsDir: string, box: { typed: string }) {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const submitted: string[] = [];
  let loaded = '';
  const deps: TerminalDeps = {
    sessionsDir,
    codexHome: '/nonexistent/codex-home',
    alive: (pid) => pid === 4242,
    bin: (name) => `/bin/${name}`,
    wait: async () => {},
    run: async (file, args, options) => {
      calls.push({ file, args, input: options?.input });
      if (file === '/bin/ps') {
        if (args.includes('lstart=')) return `${START}\n`;
        if (args.includes('stat=,pgid=,tpgid=')) return 'S+ 4242 4242\n';
        return '';
      }
      if (file !== '/bin/tmux') throw new Error(`unexpected ${file}`);
      if (args.some((a) => a.startsWith('#{pane_in_mode}'))) return '0 40\n';
      if (args.includes('capture-pane')) return screen(box.typed);
      if (args.includes('load-buffer')) loaded = options?.input ?? '';
      if (args.includes('paste-buffer')) box.typed += loaded;
      if (args.includes('send-keys')) {
        if (!args.includes('Enter')) throw new Error(`unexpected keys ${args.join(' ')}`);
        submitted.push(box.typed);
        box.typed = '';
      }
      return '';
    },
  };
  return { deps, calls, submitted };
}

async function withRecord(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-rename-'));
  try {
    await writeFile(
      path.join(dir, '4242.json'),
      JSON.stringify({
        pid: 4242,
        sessionId: SESSION,
        procStart: START,
        status: 'idle',
        kind: 'interactive',
        updatedAt: 1000,
      }),
    );
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Through the real send: one paste of the line, checked on screen, then a single Enter', async () => {
  await withRecord(async (dir) => {
    const box = { typed: '' };
    const { deps, calls, submitted } = fakeTerminal(dir, box);
    const result = await renameSession('결제 모듈 정리', {
      ...fakeRename().deps,
      send: (terminal, line, options) => sendToTerminal(terminal, line, deps, options),
    });
    assert.equal(result.status, 'sent');
    const tmux = calls.filter((c) => c.file === '/bin/tmux');
    const loads = tmux.filter((c) => c.args.includes('load-buffer'));
    assert.equal(loads.length, 1);
    assert.equal(loads[0].input, '/rename 결제 모듈 정리');
    assert.equal(tmux.filter((c) => c.args.includes('paste-buffer')).length, 1);
    const keys = tmux.filter((c) => c.args.includes('send-keys'));
    assert.deepEqual(
      keys.map((c) => c.args),
      [['-S', SOCKET, 'send-keys', '-t', '%3', 'Enter']],
    );
    assert.deepEqual(submitted, ['/rename 결제 모듈 정리']);
  });
});

test('Through the real send: a draft in the box is left alone and nothing is typed', async () => {
  await withRecord(async (dir) => {
    const box = { typed: '쓰던 답장' };
    const { deps, calls, submitted } = fakeTerminal(dir, box);
    await assert.rejects(
      renameSession('결제 모듈 정리', {
        ...fakeRename().deps,
        send: (terminal, line, options) => sendToTerminal(terminal, line, deps, options),
      }),
      new RegExp(messagesFor('ko').desktop.terminal.draft),
    );
    assert.equal(box.typed, '쓰던 답장');
    assert.deepEqual(submitted, []);
    assert.ok(!calls.some((c) => c.args.includes('load-buffer') || c.args.includes('send-keys')));
  });
});
