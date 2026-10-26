import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexScreenPids,
  codexScreens,
  codexTitleThread,
  findCodexTerminal,
  lookupCodexTerminal,
  resolveCodexTitleThread,
} from '../desktop/codex-focus.js';
import { codexTarget } from '../desktop/codex-queue.js';
import { codexLiveness } from '../desktop/launch-guard.js';
import { focusTerminal, type TerminalDeps } from '../desktop/terminals.js';
import { focusLine, focusName } from '../src/shared/terminal-target.js';

const THREAD = '01a111a3-931f-7c31-9b3c-b73c30079654';
const OTHER = '01a111a3-931f-7c31-9b3c-b73c30079655';
const HANDLE = 'term_205af179-74b5-4973-9cd8-0fb07bf63fa9';
const TAB = '75d9bc44-0187-4bcf-bec0-d3f8e1ce6a7f';
const START = 'Tue Oct  6 13:05:12 2026';
const SOCKET = '/private/tmp/tmux-501/named-socket';

function fixture(
  options: {
    host?: 'orca' | 'tmux';
    title?: string;
    owner?: string;
    stat?: string;
    duplicate?: boolean;
    reused?: boolean;
    closed?: boolean;
    failed?: boolean;
    secondTitle?: string;
    secondFailed?: boolean;
    onSecondShow?: () => Promise<void>;
    loaded?: string[];
    nextLoaded?: string[];
    locksFailed?: boolean;
    partialLocks?: boolean;
    foreignLocks?: string[];
  } = {},
) {
  let title = options.title ?? `${THREAD} | My task | project`;
  let starts = 0;
  let lockReads = 0;
  const calls: { file: string; args: string[] }[] = [];
  const deps: TerminalDeps = {
    sessionsDir: '/no-claude-records',
    codexHome: '/home/codex',
    alive: () => true,
    bin: (name) => `/bin/${name}`,
    wait: async () => {},
    run: async (file, args) => {
      calls.push({ file, args });
      if (options.failed) throw new Error('unavailable');
      const pid = args[args.indexOf('-p') + 1];
      if (file === '/usr/sbin/lsof') {
        if (options.locksFailed || options.partialLocks)
          throw Object.assign(new Error('lock inventory unavailable'), {
            stdout: options.partialLocks
              ? `p5000\nccodex\nn/home/codex/thread-writer-locks/${THREAD}.lock\n`
              : '',
          });
        const ids = ++lockReads > 1 ? (options.nextLoaded ?? options.loaded) : options.loaded;
        return (
          `p5000\nccodex\n` +
          (ids ?? [THREAD]).map((id) => `n/home/codex/thread-writer-locks/${id}.lock`).join('\n') +
          (options.foreignLocks ?? [])
            .map((id) => `\nn/other/home/thread-writer-locks/${id}.lock`)
            .join('')
        );
      }
      if (file === '/bin/ps') {
        if (args.includes('pid=,tty=,comm='))
          return `4242 ttys012 /bin/codex\n5000 ?? /bin/codex\n${options.duplicate ? '4243 ttys013 /bin/codex' : ''}`;
        if (args.includes('pid=,ppid=,tty=,comm='))
          return `4242 4000 ttys012 /bin/codex\n4000 3146 ttys012 /bin/zsh\n4243 4001 ttys013 /bin/codex\n4001 3146 ttys013 /bin/zsh\n3146 1 ?? ${options.owner ?? (options.host === 'tmux' ? '/bin/tmux' : '/Applications/Orca.app/Contents/MacOS/Orca')}`;
        if (args.includes('pid=,ppid=,comm='))
          return '7000 6999 /bin/tmux\n6999 1 /Applications/Ghostty.app/Contents/MacOS/ghostty';
        if (args.includes('lstart='))
          return options.reused && ++starts > 1 ? 'Wed Oct 7 10:00:00 2026' : START;
        if (args.includes('stat=,pgid=,tpgid=')) return options.stat ?? `S+ ${pid} ${pid}`;
        if (args.includes('-wwE'))
          return (
            `codex resume ${OTHER} ORCA_TERMINAL_HANDLE=${pid === '4243' ? HANDLE + '-second' : HANDLE} ORCA_TAB_ID=${TAB}` +
            (options.host === 'tmux' ? ` TMUX=${SOCKET},3146,0 TMUX_PANE=%3` : '')
          );
        if (args.includes('-ww')) return `codex resume ${OTHER}`;
      }
      if (file === '/bin/orca') {
        const terminal = {
          handle: HANDLE,
          tabId: TAB,
          title,
          connected: !options.closed,
          writable: true,
          orphaned: false,
        };
        if (args.includes('list'))
          return JSON.stringify({
            ok: true,
            result: {
              terminals: [
                terminal,
                {
                  ...terminal,
                  handle: HANDLE + '-second',
                  title: options.secondTitle ?? title,
                },
              ],
            },
          });
        if (args.includes('show')) {
          if (args.includes(`--terminal=${HANDLE}-second`)) {
            await options.onSecondShow?.();
            if (options.secondFailed) throw new Error('second screen timeout');
            return JSON.stringify({
              ok: true,
              result: {
                terminal: {
                  ...terminal,
                  handle: HANDLE + '-second',
                  title: options.secondTitle ?? title,
                },
              },
            });
          }
          return JSON.stringify({ ok: true, result: { terminal } });
        }
        if (args.includes('switch'))
          return JSON.stringify({ ok: true, result: { focus: { navigated: true } } });
      }
      if (file === '/bin/tmux' && args.includes('list-clients')) return '/dev/ttys020\t7000\t1\n';
      if (file === '/bin/tmux' && args.includes('display-message'))
        return args.at(-1) === '#{pane_title}' ? title : '/dev/ttys012\twork:0.3';
      if (
        file === '/bin/tmux' &&
        ['select-window', 'select-pane', 'switch-client'].some((a) => args.includes(a))
      )
        return '';
      if (file === '/usr/bin/open') return '';
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
    },
  };
  return {
    deps,
    calls,
    setTitle: (next: string) => {
      title = next;
    },
  };
}

test('Only a leading current UUID or the exact Codex abbreviation is a title identity', () => {
  assert.equal(codexTitleThread(`${THREAD.toUpperCase()} | task`), THREAD);
  assert.equal(codexTitleThread(THREAD), THREAD);
  const abbreviated = `${THREAD.slice(0, 29)}...`;
  assert.equal(codexTitleThread(`${abbreviated} | project ⠏ task`), abbreviated);
  assert.equal(codexTitleThread(abbreviated.toUpperCase()), abbreviated);
  for (const title of [
    `task | ${THREAD}`,
    `codex resume ${THREAD}`,
    `${THREAD}extra`,
    `${THREAD.slice(0, 12)} | task`,
    ` ${THREAD} | task`,
    `task mentioning ${THREAD}`,
    `${THREAD.slice(0, 12)}... | task`,
    `${THREAD.slice(0, 28)}... | task`,
    `${THREAD.slice(0, 29)}… | task`,
    `${abbreviated}extra | task`,
    `${abbreviated} ⠏ | task`,
  ])
    assert.equal(codexTitleThread(title), null, title);
});

test('Resolve only unique full live IDs, rejecting collisions, invalid locks and missing evidence', () => {
  const reference = `${THREAD.slice(0, 29)}...`;
  assert.equal(resolveCodexTitleThread(reference, new Set([THREAD, 'not-a-thread'])), THREAD);
  assert.equal(
    resolveCodexTitleThread(reference.toUpperCase(), new Set([THREAD.toUpperCase()])),
    THREAD,
  );
  assert.equal(resolveCodexTitleThread(reference, new Set([THREAD, OTHER])), null);
  assert.equal(resolveCodexTitleThread(reference, new Set()), null);
  assert.equal(resolveCodexTitleThread(`${THREAD.slice(0, 12)}...`, new Set([THREAD])), null);
});

test('Action Required title decoration preserves the leading thread identity', async () => {
  for (const marker of ['.', '!']) {
    for (const reference of [THREAD, `${THREAD.slice(0, 29)}...`]) {
      const title = `[ ${marker} ] Action Required | ${reference} | project | task`;
      assert.equal(codexTitleThread(title), reference);
      const f = fixture({ title });
      assert.equal(
        (await findCodexTerminal(THREAD, { deps: f.deps, fresh: true }))?.threadId,
        THREAD,
      );
    }
  }
  for (const title of [
    `Action Required | ${THREAD}`,
    `[ x ] Action Required | ${THREAD}`,
    `[ ! ] Action Required | task | ${THREAD}`,
    `[ ! ] Action Required | [ . ] Action Required | ${THREAD}`,
  ])
    assert.equal(codexTitleThread(title), null, title);
});

test('Real 0.162.1 abbreviated title resolves to its live thread and focuses Orca or tmux', async () => {
  for (const host of ['orca', 'tmux'] as const) {
    const f = fixture({ host, title: `${THREAD.slice(0, 29)}... | project ⠏ task` });
    const screen = await findCodexTerminal(THREAD, { deps: f.deps, fresh: true });
    assert.ok(screen);
    assert.equal(screen.threadId, THREAD);
    assert.equal(screen.host.kind, host);
    await focusTerminal(screen, f.deps);
    assert.equal(f.calls.filter((c) => c.file === '/usr/sbin/lsof').length, 2);
    assert.ok(
      f.calls
        .filter((c) => c.file === '/usr/sbin/lsof')
        .every((c) => c.args.join(' ') === '-Fcn -c /^codex$/'),
    );
    assert.ok(!f.calls.some((c) => c.args.includes('send') || c.args.includes('queue')));
  }
});

test('Unresolvable abbreviations do not hide possible duplicates of full-ID screens', async () => {
  for (const options of [
    { loaded: [] },
    { loaded: [THREAD, OTHER] },
    { locksFailed: true },
    { partialLocks: true },
  ]) {
    const f = fixture({
      ...options,
      duplicate: true,
      secondTitle: `${THREAD.slice(0, 29)}... | project`,
    });
    assert.equal(await findCodexTerminal(THREAD, { deps: f.deps, fresh: true }), null);
  }
});

test('A click rechecks abbreviated ID uniqueness after inventory completes', async () => {
  const f = fixture({
    title: `${THREAD.slice(0, 29)}... | project`,
    loaded: [THREAD],
    nextLoaded: [THREAD, OTHER],
  });
  assert.equal(await findCodexTerminal(THREAD, { deps: f.deps, fresh: true }), null);
});

test('The complete Codex file scan only resolves locks from the configured home', async () => {
  const title = `${THREAD.slice(0, 29)}... | project`;
  const f = fixture({ title, foreignLocks: [OTHER] });
  assert.ok(await findCodexTerminal(THREAD, { deps: f.deps, fresh: true }));
  const foreignOnly = fixture({ title, loaded: [], foreignLocks: [THREAD] });
  assert.equal(await findCodexTerminal(THREAD, { deps: foreignOnly.deps, fresh: true }), null);
});

test('Inventory excludes daemons, tools, wrappers, malformed PIDs and unexpected large inventories', () => {
  assert.deepEqual(
    codexScreenPids(
      `42 ttys012 /bin/codex\n43 tty003 codex\n44 ?? /bin/codex\n45 ttys012 codex-code-mode-host\n46 ttys012 /bin/node\n1 ttys001 codex`,
    ),
    [42, 43],
  );
  assert.deepEqual(
    codexScreenPids(Array.from({ length: 65 }, (_, i) => `${i + 2} ttys012 codex`).join('\n')),
    [],
  );
});

test('Codex uses the same verified Orca host and focus path as Claude, with no Claude process data', async () => {
  const { deps, calls } = fixture();
  const screen = await findCodexTerminal(THREAD, { deps, fresh: true });
  assert.ok(screen);
  assert.equal(screen.host.kind, 'orca');
  assert.equal(screen.pid, 4242);
  await focusTerminal(screen, deps);
  assert.ok(
    calls.some((c) => c.args.includes('switch') && c.args.includes(`--terminal=${HANDLE}`)),
  );
  assert.ok(!calls.some((c) => c.args.includes('send') || c.args.includes('queue')));
});

test('Named tmux sockets take precedence over an inherited outer Orca handle', async () => {
  const { deps, calls } = fixture({ host: 'tmux' });
  const screen = await findCodexTerminal(THREAD, { deps, fresh: true });
  assert.ok(screen);
  assert.deepEqual(screen.host, { kind: 'tmux', socket: SOCKET, pane: '%3', label: 'work:0.3' });
  await focusTerminal(screen, deps);
  assert.ok(calls.some((c) => c.args.includes('select-pane') && c.args.includes('%3')));
  assert.ok(!calls.some((c) => c.file === '/bin/orca'));
});

test('Current title wins over a different startup resume ID; stale argv and text are never evidence', async () => {
  const { deps } = fixture();
  assert.ok(await findCodexTerminal(THREAD, { deps, fresh: true }));
  assert.equal(await findCodexTerminal(OTHER, { deps, fresh: true }), null);
  for (const title of ['Named task', `codex resume ${OTHER}`, `Task | ${OTHER}`]) {
    const f = fixture({ title });
    assert.equal(await findCodexTerminal(OTHER, { deps: f.deps, fresh: true }), null);
  }
});

test('Fresh lookup detects a screen switching threads rather than returning a cached target', async () => {
  const f = fixture();
  assert.ok(await findCodexTerminal(THREAD, { deps: f.deps }));
  f.setTitle(`${OTHER} | changed`);
  assert.equal(await findCodexTerminal(THREAD, { deps: f.deps, fresh: true }), null);
  assert.ok(await findCodexTerminal(OTHER, { deps: f.deps, fresh: true }));
});

test('After waiting for another screen, a click rechecks the selected screen instead of its old title', async () => {
  const f = fixture({
    duplicate: true,
    secondTitle: OTHER,
    onSecondShow: async () => {
      f.setTitle(`${OTHER} | now showing another thread`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  assert.equal(await findCodexTerminal(THREAD, { deps: f.deps, fresh: true }), null);
  assert.equal(
    f.calls.filter((c) => c.args.includes('show') && c.args.includes(`--terminal=${HANDLE}`))
      .length,
    2,
  );
});

test('A failed supported screen lookup cannot erase a possible duplicate to make one target', async () => {
  const f = fixture({ duplicate: true, secondFailed: true });
  assert.equal(await findCodexTerminal(THREAD, { deps: f.deps }), null);
  assert.equal(await findCodexTerminal(THREAD, { deps: f.deps, fresh: true }), null);
});

test('Ambiguous screens, closed hosts, PID reuse and unverified owners never yield a target', async () => {
  for (const options of [
    { duplicate: true },
    { closed: true },
    { reused: true },
    { owner: '/bin/screen' },
    { stat: 'T 4242 4242' },
    { stat: 'S 4242 9999' },
    { failed: true },
  ]) {
    const { deps } = fixture(options);
    assert.equal(
      await findCodexTerminal(THREAD, { deps, fresh: true }),
      null,
      JSON.stringify(options),
    );
  }
  const f = fixture();
  assert.equal(await findCodexTerminal('not-an-id', { deps: f.deps }), null);
  assert.equal(f.calls.length, 0);
});

test('Polls for many threads share a screen inventory; actions force fresh host validation', async () => {
  const f = fixture();
  await Promise.all([
    findCodexTerminal(THREAD, { deps: f.deps }),
    findCodexTerminal(OTHER, { deps: f.deps }),
  ]);
  assert.equal(f.calls.filter((c) => c.args.includes('pid=,tty=,comm=')).length, 1);
  await findCodexTerminal(THREAD, { deps: f.deps, fresh: true });
  assert.equal(f.calls.filter((c) => c.args.includes('pid=,tty=,comm=')).length, 2);
});

test('A focusable Codex target still sends through its queue; screen labels do not leak addresses', () => {
  const target = codexTarget({ kind: 'orca', handle: HANDLE, title: 'Codex task' });
  assert.equal(target.kind, 'codex');
  assert.equal(target.queues, true);
  assert.equal(target.canSend, true);
  assert.equal(target.canFocus, true);
  assert.equal(focusName(target), 'Orca');
  assert.equal(focusLine(target, false), 'Orca · Codex task');
  assert.equal(focusLine(target, true), 'Orca');
  assert.ok(!JSON.stringify(target).includes(HANDLE));
  const tmux = codexTarget({ kind: 'tmux', socket: SOCKET, pane: '%3', label: 'work:0.3' });
  assert.equal(focusName(tmux), 'tmux');
  assert.ok(!JSON.stringify(tmux).includes(SOCKET));
  assert.equal(codexTarget().canFocus, false);
  const screenOnly = codexTarget({ kind: 'orca', handle: HANDLE, title: 'Codex task' }, false);
  assert.equal(screenOnly.canSend, false);
  assert.equal(screenOnly.canFocus, true);
  assert.equal(focusName(screenOnly), 'Orca');
  const unavailable = codexTarget(null, false);
  assert.equal(unavailable.canSend, false);
  assert.equal(unavailable.canFocus, false);
});

test('lookupCodexTerminal tells no screen from an ambiguous or unreadable one', async () => {
  const kind = async (options: Parameters<typeof fixture>[0], fresh = true) =>
    (await lookupCodexTerminal(THREAD, { deps: fixture(options).deps, fresh })).kind;
  assert.equal(await kind({}), 'found');
  assert.equal(await kind({}, false), 'found');
  // Every Codex screen was read and shows another thread: nothing there.
  assert.equal(await kind({ title: `${OTHER} | task`, loaded: [OTHER] }), 'none');
  // Could be this thread somewhere: never "none".
  for (const options of [
    { duplicate: true },
    { duplicate: true, secondFailed: true },
    { closed: true },
    { reused: true },
    { owner: '/bin/screen' },
    { stat: 'T 4242 4242' },
    { title: 'zsh' },
    { failed: true },
  ])
    assert.equal(await kind(options), 'unknown', JSON.stringify(options));
});

test('Codex liveness for a launch: any verified screen of the thread means running', async () => {
  const kind = async (options: Parameters<typeof fixture>[0], fresh = true) =>
    (await codexLiveness.lookup(THREAD, fresh, fixture(options).deps)).kind;
  assert.equal(await kind({}), 'found');
  // Two screens of the thread, or one plus an unreadable one: no single place to go to, but
  // it certainly runs, so a launch must not start it again.
  assert.equal(await kind({ duplicate: true }), 'found');
  assert.equal(await kind({ duplicate: true }, false), 'found');
  assert.equal(await kind({ duplicate: true, secondFailed: true }), 'found');
  assert.equal(await kind({ title: `${OTHER} | task`, loaded: [OTHER] }), 'none');
  // Nothing verified shows it, but something could: unknown, never none.
  for (const options of [{ closed: true }, { reused: true }, { title: 'zsh' }, { failed: true }])
    assert.equal(await kind(options), 'unknown', JSON.stringify(options));
});

test('Too many Codex screens to read is unknown, never "no screen"', async () => {
  const table = Array.from({ length: 65 }, (_, i) => `${5000 + i} ttys${100 + i} /bin/codex`).join(
    '\n',
  );
  assert.deepEqual(codexScreens(table), { pids: [], oversized: true });
  assert.deepEqual(codexScreenPids(table), []);
  const f = fixture();
  const run = f.deps.run;
  f.deps.run = async (file, args, options) =>
    file === '/bin/ps' && args.includes('pid=,tty=,comm=') ? table : run(file, args, options);
  assert.equal((await lookupCodexTerminal(THREAD, { deps: f.deps, fresh: true })).kind, 'unknown');
});
