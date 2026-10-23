import {
  findHost,
  inspectProcess,
  focusHost,
  focusTarget,
  hostName,
  TerminalFocusError,
} from './terminal-host.js';
import type { TerminalHost, TerminalLookup } from './terminal-host.js';
export { findHost, inspectProcess, hostName, parseProcessEnv, ptyOwner } from './terminal-host.js';
export type { TerminalHost, ProcessEnv, ProcessView, TerminalLookup } from './terminal-host.js';
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { SendResult, TerminalTarget } from '../src/shared/types.js';
import { intlLocale, m } from '../src/shared/i18n/index.js';
import {
  claudeCodeComposer,
  drawn,
  holdsText,
  parseStyledScreen,
  promptHolds,
  readyToType,
  mergeBackup,
  type ComposerAdapter,
  type ComposerHost,
  type ComposerKey,
  type Screen,
} from './composer/index.js';
import {
  findClaudeProcess,
  forget,
  processAlive,
  remember,
  runCommand,
  type ClaudeLiveDeps,
  type ClaudeProcess,
} from '../server/adapters/claude-live.js';
import type { PromptHost, PromptKey } from './prompts/types.js';
export { promptHolds, readPrompt } from './composer/index.js';

// Desktop-only: these helpers can focus and type into a live terminal, so they are
// never reachable through OfficeService.call (shared with the web preview). Reading the
// process records themselves is shared with the collector (server/adapters/claude-live.ts).
export {
  findClaudeProcess,
  parseClaudeProcess,
  remember,
  spaces,
  type ClaudeProcess,
  type RunOptions,
} from '../server/adapters/claude-live.js';

export interface TerminalDeps extends ClaudeLiveDeps {
  /** `${CODEX_HOME:-~/.codex}`: shared daemon state for Codex CLI sessions. */
  codexHome: string;
  bin: (name: 'orca' | 'tmux' | 'codex') => string;
  wait: (ms: number) => Promise<void>;
}

export interface LiveTerminal {
  process: ClaudeProcess;
  host: TerminalHost;
}

const BINARIES = {
  orca: ['/usr/local/bin/orca', '/opt/homebrew/bin/orca'],
  tmux: ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'],
  // Native binaries only: the npm launcher is a node script, and Finder-launched apps lack node.
  codex: [
    '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex',
  ],
};

/** The binary the shared daemon itself runs speaks its protocol best; then installed CLIs. */
function codexBinary(codexHome: string) {
  const releases = path.join(codexHome, 'packages', 'app-server-daemon', 'releases');
  try {
    const newest = readdirSync(releases)
      .filter((name) => existsSync(path.join(releases, name, 'bin', 'codex')))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1);
    if (newest) return path.join(releases, newest, 'bin', 'codex');
  } catch {
    /* no managed daemon installed */
  }
  return BINARIES.codex.find(existsSync) ?? 'codex';
}

let shared: TerminalDeps | undefined;
/** One shared instance, so the per-deps caches below persist between calls. */
export const defaultTerminalDeps = (): TerminalDeps =>
  (shared ??= {
    sessionsDir: path.join(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
      'sessions',
    ),
    codexHome: process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
    run: runCommand,
    alive: processAlive,
    bin(name) {
      return name === 'codex'
        ? codexBinary(this.codexHome)
        : (BINARIES[name].find(existsSync) ?? name);
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

export function locateTerminal(
  sessionId: string,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<LiveTerminal | null> {
  const deps = options.deps ?? defaultTerminalDeps();
  const fresh = !!options.fresh;
  // A short window only merges concurrent lookups; the process record itself is cheap to read.
  return remember(deps, `locate:${sessionId}`, 1500, fresh, async () => {
    const proc = await findClaudeProcess(sessionId, deps, fresh);
    if (!proc) return null;
    const key = `${proc.pid}:${proc.procStart}`;
    // Environment and pty owner are fixed for the process's life; a failed read is retried.
    const view = remember(deps, `view:${key}`, Infinity, false, () =>
      inspectProcess(proc.pid, deps),
    );
    if (!(await view).owner) forget(deps, `view:${key}`);
    // Host verification rarely changes; cheap polls reuse it, actions always re-check.
    const host = await remember(deps, `host:${key}`, 15_000, fresh, () =>
      findHost(proc.pid, deps, view, fresh),
    );
    return host ? { process: proc, host } : null;
  });
}

/**
 * `locateTerminal` with its null split: `none` only when no live Claude process holds the
 * session. A live one whose terminal could not be verified (another terminal app, an unverified
 * tmux pane) is `unknown`, so no other tab is ever offered in its place.
 */
export async function lookupTerminal(
  sessionId: string,
  options: { fresh?: boolean; deps?: TerminalDeps } = {},
): Promise<TerminalLookup<LiveTerminal>> {
  const deps = options.deps ?? defaultTerminalDeps();
  const terminal = await locateTerminal(sessionId, { ...options, deps });
  if (terminal) return { kind: 'found', terminal };
  const proc = await findClaudeProcess(sessionId, deps).catch(() => undefined);
  return proc === null ? { kind: 'none' } : { kind: 'unknown' };
}

/** Drop a cached lookup once its state is known to have changed, e.g. right after sending. */
export const forgetTerminal = (sessionId: string) =>
  forget(defaultTerminalDeps(), `locate:${sessionId}`);

/**
 * Statuses whose screen may show the prompt: at rest (`shell` is at rest while a background
 * shell runs), or mid-turn, where Claude Code queues what is typed. `waiting` (a permission
 * prompt or plan approval) and anything unknown are refused outright. The record is written
 * after the screen changes, so the screen itself is read right before typing and before Enter.
 */
const OPEN = new Set(['idle', 'busy', 'shell']);
export const acceptsInput = (status: string) => OPEN.has(status);

/** What the renderer may know: never the handle or socket, which main re-resolves per action. */
export function terminalTarget(live: LiveTerminal): TerminalTarget {
  return {
    kind: live.host.kind,
    label: live.host.kind === 'orca' ? live.host.title : live.host.label,
    status: live.process.status,
    canSend: acceptsInput(live.process.status),
    canFocus: true,
    focus: focusTarget(live.host),
  };
}

/** Focus only needs a verified host; Claude input state stays in LiveTerminal. */
export async function focusTerminal(
  live: { host: TerminalHost },
  deps = defaultTerminalDeps(),
): Promise<string> {
  try {
    return await focusHost(live.host, deps);
  } catch (error) {
    if (error instanceof TerminalFocusError) throw new TerminalInputError(error.message);
    throw error;
  }
}

/**
 * The process must own its terminal right now. A suspended Claude (ctrl+z) keeps an idle
 * record while its shell takes the foreground, and typed text would run as a shell command.
 */
export async function ownsTerminal(pid: number, deps: TerminalDeps): Promise<boolean> {
  const out = await deps
    .run('/bin/ps', ['-o', 'stat=,pgid=,tpgid=', '-p', String(pid)])
    .catch(() => '');
  const [stat, pgid, tpgid] = out.trim().split(/\s+/);
  return !!stat && !stat.includes('T') && /^\d+$/.test(pgid ?? '') && pgid === tpgid;
}

export const MAX_SEND_LENGTH = 4000;
/** A refusal the person can act on, shown as is. Other failures are reported generically. */
export class TerminalInputError extends Error {}

/** Read-only recovery after a send error: no key, paste, clipboard write or Enter. */
export async function inspectTerminalDraft(
  live: LiveTerminal,
  composer: ComposerAdapter = claudeCodeComposer,
  deps = defaultTerminalDeps(),
): Promise<Extract<SendResult, { status: 'needs-confirm' }> | null> {
  if (!acceptsInput(live.process.status) || !(await ownsTerminal(live.process.pid, deps)))
    return null;
  const io = composerHost(live.host, deps);
  const can = composer.capabilities(io);
  if (can.delivery !== 'terminal' || !can.canInspect) return null;
  const state = await composer.inspect(io);
  if (!holdsText(state)) return null;
  return {
    status: 'needs-confirm',
    agent: composer.agent,
    draft: state.text,
    ...(!can.canDetectSuggestion && { maybeSuggestion: true }),
    ...(!can.canClear && { clearable: false }),
    ...(!state.whole && { partial: true }),
  };
}

/** Plain typed text only: escape sequences and other control characters never reach the pty. */
export function cleanInput(text: unknown): string {
  if (typeof text !== 'string') throw new TerminalInputError(m().desktop.terminal.empty);
  const value = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim();
  if (!value) throw new TerminalInputError(m().desktop.terminal.empty);
  if (value.length > MAX_SEND_LENGTH)
    throw new TerminalInputError(
      m().desktop.terminal.tooLong(MAX_SEND_LENGTH.toLocaleString(intlLocale())),
    );
  return value;
}

/**
 * The rendered screen, or `null` when it cannot be read. tmux reports how each character is
 * drawn (`capture-pane -e`); Orca's screen read is plain text. A tmux pane scrolled back (copy
 * mode) would take Enter itself, so it reads as no prompt at all.
 */
async function readScreen(host: TerminalHost, deps: TerminalDeps): Promise<Screen | null> {
  try {
    if (host.kind === 'tmux') {
      const tmux = deps.bin('tmux');
      const state = await deps.run(tmux, [
        '-S',
        host.socket,
        'display-message',
        '-p',
        '-t',
        host.pane,
        '#{pane_in_mode} #{pane_height}',
      ]);
      const [mode, height] = state.trim().split(' ');
      if (mode !== '0') return { text: '' };
      const screen = parseStyledScreen(
        await deps.run(tmux, ['-S', host.socket, 'capture-pane', '-p', '-e', '-t', host.pane]),
      );
      // The pane height tells whether the prompt box may be scrolled (see maxBoxRows).
      return /^\d+$/.test(height ?? '') ? { ...screen, height: Number(height) } : screen;
    }
    const out = await deps.run(deps.bin('orca'), [
      'terminal',
      'read',
      `--terminal=${host.handle}`,
      '--screen',
      '--limit=200',
      '--json',
    ]);
    const terminal = JSON.parse(out)?.result?.terminal;
    // Without a rendered screen Orca falls back to past output, which is not what is shown now.
    if (terminal?.source !== 'screen' || !Array.isArray(terminal.tail)) return null;
    const text = terminal.tail.filter((line: unknown) => typeof line === 'string').join('\n');
    // Orca 1.4.216 reports the composer's text apart (`draft`) and leaves only the marker on
    // screen; an older Orca draws it in the screen as tmux does.
    return typeof terminal.draft === 'string' ? { text, composer: terminal.draft } : { text };
  } catch {
    return null;
  }
}

/** The bytes a key sends: what tmux `send-keys` writes for the same names. */
const KEY_BYTES: Record<ComposerKey, string> = {
  'C-k': '\x0b',
  'C-u': '\x15',
  l: 'l',
  BSpace: '\x7f',
};

/** The terminal host as a composer adapter sees it: read the screen, press keys, wait. */
export function composerHost(host: TerminalHost, deps: TerminalDeps): ComposerHost {
  return {
    styled: host.kind === 'tmux',
    read: () => readScreen(host, deps),
    wait: deps.wait,
    async press(keys) {
      if (!keys.length) return;
      if (host.kind === 'orca')
        return orcaSend(host, [`--text=${keys.map((key) => KEY_BYTES[key]).join('')}`], deps);
      await deps.run(deps.bin('tmux'), ['-S', host.socket, 'send-keys', '-t', host.pane, ...keys]);
    },
  };
}

/** Dialog keys: tmux key names, and the bytes the same keys send for Orca. */
const PROMPT_BYTES: Record<PromptKey, string> = {
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Enter: '\r',
  Space: ' ',
};

/** The terminal host as a prompt adapter sees it: read the screen, press dialog keys, type. */
export function promptHost(host: TerminalHost, deps: TerminalDeps): PromptHost {
  return {
    kind: host.kind,
    read: () => readScreen(host, deps),
    wait: deps.wait,
    type: (text) => typeText(host, text, deps),
    async press(keys) {
      if (!keys.length) return;
      if (host.kind === 'orca') {
        // Enter goes as Orca's own submit key, as for a follow-up.
        const text = keys.filter((key) => key !== 'Enter');
        if (text.length)
          await orcaSend(host, [`--text=${text.map((key) => PROMPT_BYTES[key]).join('')}`], deps);
        if (keys.includes('Enter')) await orcaSend(host, ['--enter'], deps);
        return;
      }
      await deps.run(deps.bin('tmux'), ['-S', host.socket, 'send-keys', '-t', host.pane, ...keys]);
    },
  };
}

async function orcaSend(host: { handle: string }, input: string[], deps: TerminalDeps) {
  let out: string;
  try {
    // `--flag=value` is the only form Orca reads for a value that starts with `--`.
    out = await deps.run(
      deps.bin('orca'),
      ['terminal', 'send', `--terminal=${host.handle}`, ...input, '--json'],
      { timeout: 20000 },
    );
  } catch (error) {
    out = (error as { stdout?: string }).stdout ?? '';
    if (!/"accepted"\s*:\s*false/.test(out)) throw error;
  }
  const send = JSON.parse(out)?.result?.send;
  if (send?.accepted !== true) {
    const reason = typeof send?.refusedReason === 'string' ? ` (${send.refusedReason})` : '';
    throw new TerminalInputError(m().desktop.terminal.orcaRefused(reason));
  }
}

/** Puts the text in the prompt without submitting it. Line breaks stay inside the prompt. */
async function typeText(host: TerminalHost, text: string, deps: TerminalDeps) {
  // Orca writes the bytes as they are: bracketed paste keeps tabs and line breaks as text.
  // cleanInput removed every ESC, so the text itself can never close the paste early.
  if (host.kind === 'orca') return orcaSend(host, [`--text=\x1b[200~${text}\x1b[201~`], deps);
  const tmux = deps.bin('tmux');
  const buffer = `agent-office-${randomUUID()}`;
  // stdin, not argv: tmux treats a trailing `;` in an argument as a command separator.
  await deps.run(tmux, ['-S', host.socket, 'load-buffer', '-b', buffer, '-'], { input: text });
  try {
    // Bracketed paste keeps line breaks inside the prompt instead of submitting early.
    await deps.run(tmux, [
      '-S',
      host.socket,
      'paste-buffer',
      '-p',
      '-d',
      '-b',
      buffer,
      '-t',
      host.pane,
    ]);
  } catch (error) {
    await deps.run(tmux, ['-S', host.socket, 'delete-buffer', '-b', buffer]).catch(() => '');
    throw error;
  }
}

const pressEnter = (host: TerminalHost, deps: TerminalDeps) =>
  host.kind === 'orca'
    ? orcaSend(host, ['--enter'], deps)
    : deps.run(deps.bin('tmux'), ['-S', host.socket, 'send-keys', '-t', host.pane, 'Enter']);

export interface TerminalSendOptions {
  /** Recheck optional network authority immediately before typing and submitting. */
  beforeSend?: () => void | Promise<void>;
  /**
   * The composer text the person agreed to clear (exactly what `needs-confirm` showed). It is
   * cleared only while the composer still holds that text; otherwise they are asked again.
   */
  replaceDraft?: string;
  /** Explicit confirmation that hidden content may be lost. */
  allowPartialDraft?: boolean;
  /** Puts the composer's text on the clipboard before it is cleared. Without it nothing is. */
  backup?: (text: string) => void | Promise<void>;
  /** What the clipboard holds now: an earlier backup counts only while it is still there. */
  clipboardText?: () => string | Promise<string>;
  /** The agent whose composer this is. */
  composer?: ComposerAdapter;
}

/**
 * Types the text, then submits it only while Claude's own prompt holds exactly that. Enter is
 * the risk: on a permission prompt it picks the default choice (pasted text alone is ignored
 * there, measured on 2.1.296), and mid-turn such prompts come and go. So the record and then
 * the screen are checked as late as possible; one CLI call (~0.1s) and Claude's next frame are
 * left between the last look and Enter, and a prompt that opens right after is reported.
 *
 * Text already in the composer is never added to: a draft (or, on a plain screen, text that may
 * be a draft) comes back as `needs-confirm`. Sent again with `replaceDraft`, that text goes to
 * the clipboard, the adapter clears the composer and verifies it is empty, and only then is the
 * new text typed and checked as above.
 */
export function sendToTerminal(
  live: LiveTerminal,
  input: unknown,
  deps = defaultTerminalDeps(),
  options: TerminalSendOptions = {},
): Promise<SendResult> {
  // One send per session at a time: two surfaces sending at once would type into each other.
  const key = live.process.sessionId;
  const before = sending.get(key);
  const turn = (before ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => deliver(live, input, deps, !!before, options));
  sending.set(key, turn);
  const done = () => {
    if (sending.get(key) === turn) sending.delete(key);
  };
  turn.then(done, done);
  return turn;
}

const sending = new Map<string, Promise<SendResult>>();

/**
 * What clearing put on the clipboard, per session, until a send goes through: a clearing that
 * was interrupted (someone typing, the prompt closing) and is confirmed again only ever adds to
 * it. Short-lived, in memory only, kept with the deps (one shared instance in the app).
 */
const BACKUP_TTL = 10 * 60_000;
const backupsOf = new WeakMap<TerminalDeps, Map<string, { text: string; at: number }>>();
function backupMemory(deps: TerminalDeps) {
  let memory = backupsOf.get(deps);
  if (!memory) backupsOf.set(deps, (memory = new Map()));
  return {
    held(key: string): string | undefined {
      const held = memory.get(key);
      if (held && Date.now() - held.at < BACKUP_TTL) return held.text;
      memory.delete(key);
      return undefined;
    },
    keep: (key: string, text: string) => memory.set(key, { text, at: Date.now() }),
    drop: (key: string) => memory.delete(key),
  };
}

async function deliver(
  live: LiveTerminal,
  input: unknown,
  deps: TerminalDeps,
  waited: boolean,
  options: TerminalSendOptions,
): Promise<SendResult> {
  const text = cleanInput(input);
  const t = m().desktop.terminal;
  /** The same process, still on this session, open to input and in front of its terminal. */
  const current = async () => {
    const now = await findClaudeProcess(live.process.sessionId, deps, true);
    return now?.pid === live.process.pid &&
      acceptsInput(now.status) &&
      (await ownsTerminal(now.pid, deps))
      ? now
      : null;
  };
  // A leading `!` turns Claude's prompt into shell mode: the text would run as a command.
  if (text.startsWith('!')) throw new TerminalInputError(t.shellPrefix);
  // A send that waited its turn looks again: the one before may have ended or replaced the
  // session (`/clear`).
  if (waited && !(await current())) throw new TerminalInputError(t.stateChanged);
  if (!acceptsInput(live.process.status)) throw new TerminalInputError(t.notReady);
  if (!(await ownsTerminal(live.process.pid, deps))) throw new TerminalInputError(t.notOwner);
  const { host } = live;
  const key = live.process.sessionId;
  const memory = backupMemory(deps);
  const where = host.kind === 'orca' ? 'Orca' : `tmux ${host.label}`;
  const composer = options.composer ?? claudeCodeComposer;
  const io = composerHost(host, deps);
  const can = composer.capabilities(io);
  // Typing into a terminal is only for agents whose composer can be read first.
  if (can.delivery !== 'terminal' || !can.canInspect)
    throw new TerminalInputError(t.unsupportedAgent(composer.agent));
  const state = await composer.inspect(io);
  if (state.kind === 'unreadable') throw new TerminalInputError(t.unreadable(hostName(host)));
  if (!holdsText(state)) {
    if (!readyToType(state)) throw new TerminalInputError(t.notReady);
    return submit(false);
  }
  // Never mixed into a draft, or into text a failed send left behind.
  if (!can.canClear || !options.backup) throw new TerminalInputError(t.draft);
  // What an earlier, interrupted clearing of this session put on the clipboard — only while the
  // clipboard still holds it (the person may have copied something else since).
  let base = memory.held(key);
  if (base !== undefined && options.clipboardText) {
    const now = await Promise.resolve(options.clipboardText()).catch(() => undefined);
    if (now !== base) {
      memory.drop(key);
      base = undefined;
    }
  }
  let saved = false;
  const ask = (draft: string, whole: boolean, changed = false): SendResult => ({
    status: 'needs-confirm',
    draft,
    agent: composer.agent,
    ...(!can.canDetectSuggestion && { maybeSuggestion: true }),
    ...(changed && { changed: true }),
    ...((saved || base !== undefined) && { clipboard: true }),
    // A partial preview needs explicit acceptance of hidden-content loss.
    ...(!whole && { partial: true }),
  });
  const confirmed = options.replaceDraft;
  if (confirmed === undefined) return ask(state.text, state.whole);
  if (drawn(confirmed) !== drawn(state.text)) return ask(state.text, state.whole, true);
  if (!state.whole && !options.allowPartialDraft) return ask(state.text, false);
  const backup = options.backup;
  try {
    const result = await composer.clear(
      io,
      state,
      async (text) => {
        // Never less than the earlier clearing saved; never more than that and this draft.
        const merged = mergeBackup(base, text);
        try {
          await backup(merged);
        } catch {
          // A later copy (of text that showed up once the draft was gone) says what happened.
          throw new TerminalInputError(saved ? t.backupFailedLater : t.backupFailed);
        }
        memory.keep(key, merged);
        saved = true;
      },
      // Before every key: the same Claude, open to input and in front of its terminal.
      async () => !!(await current()),
      { allowPartial: options.allowPartialDraft === true },
    );
    if (result.status === 'changed') return ask(result.text, result.whole, true);
    if (result.status === 'failed')
      throw new TerminalInputError(
        result.partial
          ? t.notWhole
          : result.lost
            ? t.clearStopped
            : result.state.kind === 'unknown'
              ? t.clearFailedSuggestion(composer.agent)
              : t.clearFailed(composer.agent),
      );
    // Typing replaces a suggestion. One only inferred (a plain screen) proves less: then the
    // prompt must hold exactly the text, never a collapsed or shortened view of it.
    const inferred = result.state.kind === 'suggestion' && !!result.state.inferred;
    return await submit(true, inferred || !state.whole);
  } catch (error) {
    // A partial clearing can back up only readable fragments.
    const backupNotice = state.whole ? t.clipboardKept : t.partialClipboardKept;
    // Once something went to the clipboard, every failure says so (a failed copy says its own).
    if (!saved) throw error;
    const reason =
      error instanceof TerminalInputError ? error.message : t.unconfirmed(hostName(host));
    throw new TerminalInputError(
      reason === t.backupFailed || reason === t.backupFailedLater || reason.includes(backupNotice)
        ? reason
        : `${reason} ${backupNotice}`,
    );
  }

  /**
   * Types the text and presses Enter once the prompt holds it: exactly, or (the prompt being
   * verified empty) as the placeholder of a long paste or the end of a long text. `strict`
   * after a clearing that could only infer the box was empty: the exact text only.
   */
  async function submit(cleared: boolean, strict = false): Promise<SendResult> {
    await options.beforeSend?.();
    await typeText(host, text, deps);
    const holds = async () => promptHolds((await readScreen(host, deps)) ?? '', text, strict);
    // The prompt may take a moment to draw the text.
    let shown = false;
    for (let tries = 0; !shown && tries < 3; tries++) {
      await deps.wait(150);
      shown = await holds();
    }
    if (!shown) throw new TerminalInputError(cleared ? t.notVerified : t.stateChanged);
    // The record and the foreground last, right before Enter: a pause (ctrl+z) during the
    // retries leaves Claude's last frame on screen over a shell.
    const again = await current();
    if (!again) throw new TerminalInputError(t.stateChanged);
    // And the screen once more: a dialog may have opened during those checks.
    if (!(await holds())) throw new TerminalInputError(t.stateChanged);
    try {
      await options.beforeSend?.();
      await pressEnter(host, deps);
    } catch (error) {
      // The text is in the prompt: a blind resend would type it twice.
      if (error instanceof TerminalInputError) throw new TerminalInputError(t.notSubmitted(where));
      throw error;
    }
    memory.drop(key);
    const sent = (message: string): SendResult => ({
      status: 'sent',
      message,
      // The cleared text is on the clipboard (blank lines are not copied).
      ...(cleared &&
        saved && {
          cleared: true,
          ...(holdsText(state) && !state.whole && { partialBackup: true }),
        }),
    });
    const after = await findClaudeProcess(live.process.sessionId, deps, true).catch(() => null);
    if (after?.status === 'waiting') return sent(t.sentThenPrompt(where));
    if (again.status === 'busy') return sent(t.queued(where));
    return sent(host.kind === 'orca' ? t.orcaSent : t.tmuxSent(host.label));
  }
}
