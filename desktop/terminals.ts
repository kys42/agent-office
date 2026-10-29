import {
  findHost,
  inspectProcess,
  focusHost,
  focusTarget,
  hostName,
  TerminalFocusError,
  localOrcaEnv,
  screenTitle,
} from './terminal-host.js';
import type { TerminalHost, TerminalLookup } from './terminal-host.js';
export { findHost, inspectProcess, hostName, parseProcessEnv, ptyOwner } from './terminal-host.js';
export type { TerminalHost, ProcessEnv, ProcessView, TerminalLookup } from './terminal-host.js';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
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
  promptHoldsImages,
  readImages,
  readPrompt,
  readyToType,
  mergeBackup,
  sameWrapped,
  type ComposerAdapter,
  type ComposerHost,
  type ComposerKey,
  type ComposerState,
  type Screen,
} from './composer/index.js';
import {
  findClaudeJob,
  findClaudeProcess,
  forget,
  isParked,
  namesakeJobs,
  parkedWindows,
  titleKey,
  parseClaudeProcess,
  processAlive,
  remember,
  runCommand,
  spaces,
  type ClaudeLiveDeps,
  type ClaudeProcess,
} from '../server/adapters/claude-live.js';
import type { PromptHost, PromptKey } from './prompts/types.js';
export { promptHolds, promptHoldsImages, readPrompt } from './composer/index.js';

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
  /** Claude's process-record folder, read by the absence check (tests count the reads). */
  records?: {
    list: (dir: string) => Promise<string[]>;
    read: (file: string) => Promise<string>;
  };
}

export interface LiveTerminal {
  /** The session's own process: an interactive window, or a background session. */
  process: ClaudeProcess;
  host: TerminalHost;
  /**
   * A background session only: the window that parked it and shows it now. Its terminal is the
   * host, and it is the process that must own that terminal.
   */
  window?: ClaudeProcess;
}

/** The process in front of the terminal: the window showing a background session, or itself. */
const screenPid = (live: Pick<LiveTerminal, 'process' | 'window'>) =>
  (live.window ?? live.process).pid;

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
    // A background session has no terminal of its own: only a window that shows it has one.
    const screen = proc.kind === 'bg' ? await jobWindow(proc, deps, fresh) : proc;
    if (!screen) return null;
    const key = `${screen.pid}:${screen.procStart}`;
    // Environment and pty owner are fixed for the process's life; a failed read is retried.
    const view = remember(deps, `view:${key}`, Infinity, false, () =>
      inspectProcess(screen.pid, deps),
    );
    if (!(await view).owner) forget(deps, `view:${key}`);
    // Host verification rarely changes; cheap polls reuse it, actions always re-check.
    const host = await remember(deps, `host:${key}`, 15_000, fresh, () =>
      findHost(screen.pid, deps, view, fresh),
    );
    if (!host) return null;
    if (screen === proc) return { process: proc, host };
    return (await showsJob(proc, host, deps, fresh))
      ? { process: proc, host, window: screen }
      : null;
  });
}

/**
 * The one window that parked this background job (`parkedJobId`, see claude-live.ts). Claude
 * routes a message for the window's session to that job the same way. Two windows, a job without
 * a name, or another live job of the same name: no window can be proven to show it.
 */
async function jobWindow(
  job: ClaudeProcess,
  deps: TerminalDeps,
  fresh: boolean,
): Promise<ClaudeProcess | null> {
  if (!job.name) return null;
  // Fail closed: a window or namesake whose process cannot be verified may be the one in front.
  const windows = await parkedWindows(job, deps, fresh);
  if (windows?.length !== 1) return null;
  const namesakes = await namesakeJobs(job, deps, fresh);
  if (namesakes === null || namesakes.length) return null;
  return windows[0];
}

/**
 * The parked window's terminal shows the job now: its title is the job's name, as Claude draws
 * it (`✳ name`, a spinner while working). The agents view can switch jobs, so the link alone
 * does not prove which one is in front. `fresh` reads the title again, right before typing.
 */
async function showsJob(
  job: ClaudeProcess,
  host: TerminalHost,
  deps: TerminalDeps,
  fresh: boolean,
): Promise<boolean> {
  let title: string | null;
  try {
    // Orca's title came with the host check (as fresh as it); tmux's is read here.
    // The whole title, never the one clipped for display.
    title =
      host.kind === 'orca' && !fresh
        ? (host.fullTitle ?? host.title)
        : await screenTitle(host, deps);
  } catch {
    return false;
  }
  return !!job.name && title !== null && titleNames(title, job.name);
}

/**
 * Claude Code titles its terminal `<glyph> <name>` (✳ at rest, a spinner while working); Orca
 * may put an attention marker in front. Both reduce alike (`titleKey`), the same reduction that
 * tells namesake jobs apart, so a title can only ever match one job that passed that check.
 */
export function titleNames(title: string, name: string): boolean {
  const key = titleKey(name);
  return !!key && titleKey(title) === key;
}

/**
 * The same session, process and screen as when it was located, its status accepted by `open`:
 * the check before each key and before Enter. For a background session the window must still
 * be the only one parking it, no other live job may share its name, and its terminal must still
 * show it (title read afresh).
 */
export async function stillLive(
  live: LiveTerminal,
  deps: TerminalDeps,
  open: (status: string) => boolean = acceptsInput,
): Promise<ClaudeProcess | null> {
  const now = await findClaudeProcess(live.process.sessionId, deps, true);
  if (now?.pid !== live.process.pid || !open(now.status)) return null;
  if (live.window) {
    // Every rule of the lookup again, namesakes included: a job of the same name started since
    // could be the one the agents view switched to, under the same title.
    if ((await jobWindow(now, deps, true))?.pid !== live.window.pid) return null;
    if (!(await showsJob(now, live.host, deps, true))) return null;
  }
  return (await ownsTerminal(screenPid(live), deps)) ? now : null;
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
  return (await claudeAbsent(sessionId, deps, !!options.fresh).catch(() => false))
    ? { kind: 'none' }
    : { kind: 'unknown' };
}

/**
 * Claude's process records as one shared read per burst (1 s, like the other process caches):
 * sessions checked together read the folder once. `complete` only when every record file was
 * read (a missing folder is an empty, complete one); unparsable files are kept as text so a
 * session they mention is never called absent.
 */
export function claudeRecordInventory(deps: TerminalDeps, fresh = false) {
  return remember(deps, `record-inventory:${deps.sessionsDir}`, 1000, fresh, async () => {
    const io = deps.records ?? { list: (dir) => readdir(dir), read: (f) => readFile(f, 'utf8') };
    const records: ClaudeProcess[] = [];
    const unparsed: string[] = [];
    let files: string[];
    try {
      files = (await io.list(deps.sessionsDir)).filter((name) => /^\d+\.json$/.test(name));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return { complete: missing, records, unparsed };
    }
    if (files.length > 1000) return { complete: false, records, unparsed };
    let complete = true;
    await Promise.all(
      files.map(async (name) => {
        const file = path.join(deps.sessionsDir, name);
        let text: string;
        try {
          text = await io.read(file);
        } catch (error) {
          // A record removed meanwhile belonged to a process that ended; any other failure
          // (permissions, I/O) leaves this process unknown.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
          return;
        }
        const record = parseClaudeProcess(name, text);
        if (record) records.push(record);
        else unparsed.push(text);
      }),
    );
    return { complete, records, unparsed };
  });
}

/**
 * True only after a successful absence check: Claude's records were all read, and every record
 * of the session names a process that is gone (or a reused PID). An unreadable folder or record,
 * an unparsable record that mentions the session, too many records, or a `ps` failure while the
 * PID is alive: not known to be absent.
 */
export async function claudeAbsent(
  sessionId: string,
  deps: TerminalDeps,
  fresh = false,
): Promise<boolean> {
  const inventory = await claudeRecordInventory(deps, fresh);
  if (!inventory.complete || inventory.unparsed.some((text) => text.includes(sessionId)))
    return false;
  for (const record of inventory.records) {
    if (record.sessionId !== sessionId || !deps.alive(record.pid)) continue;
    let started: string;
    try {
      started = await deps.run('/bin/ps', ['-o', 'lstart=', '-p', String(record.pid)], {
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      });
    } catch {
      // `ps` fails for a PID that just ended; while it is alive, nothing is known.
      if (deps.alive(record.pid)) return false;
      continue;
    }
    if (!started.trim() || spaces(started) === spaces(record.procStart)) return false;
  }
  return true;
}

/**
 * Why a live Claude session has no terminal to type into, when its process records can say:
 * a background session no window shows (or none provably), or a window that parked its own
 * conversation in the background and now shows a job. Null otherwise.
 */
export async function claudeNoTerminalReason(
  sessionId: string,
  deps = defaultTerminalDeps(),
): Promise<string | null> {
  const t = m().desktop.terminal;
  const proc = await findClaudeProcess(sessionId, deps, true, { parked: true });
  if (!proc) return null;
  if (proc.kind === 'bg' && proc.jobId) return t.background(attachCommand(proc.jobId));
  if (!isParked(proc)) return null;
  const job = proc.parkedJobId ? await findClaudeJob(proc.parkedJobId, deps, true) : null;
  return t.parked(job?.name ?? proc.parkedJobId ?? '');
}

/** `claude attach <job>` for a live background session: what opens it in a terminal. */
export async function claudeAttachCommand(
  sessionId: string,
  deps = defaultTerminalDeps(),
): Promise<string | null> {
  const proc = await findClaudeProcess(sessionId, deps, true);
  return proc?.kind === 'bg' && proc.jobId ? attachCommand(proc.jobId) : null;
}

// Job ids are validated as 8 hex characters: nothing to quote.
const attachCommand = (jobId: string) => `claude attach ${jobId}`;

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
  const { images } = claudeCodeComposer.capabilities({ styled: live.host.kind === 'tmux' });
  return {
    kind: live.host.kind,
    label: live.host.kind === 'orca' ? live.host.title : live.host.label,
    status: live.process.status,
    canSend: acceptsInput(live.process.status),
    canFocus: true,
    focus: focusTarget(live.host),
    ...(images && { images }),
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
  if (!acceptsInput(live.process.status) || !(await ownsTerminal(screenPid(live), deps)))
    return null;
  // A background session's window may have switched to another job meanwhile.
  if (live.window && !(await stillLive(live, deps))) return null;
  const io = composerHost(live.host, deps);
  const can = composer.capabilities(io);
  if (can.delivery !== 'terminal' || !can.canInspect) return null;
  const state = await composer.inspect(io);
  // Only the reply a failed send typed: nothing to decide, the next send takes it back.
  if (claimOwn(typedMemory(deps), live.process.sessionId, state) !== undefined) return null;
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

/**
 * The composer holds exactly, and all of, what this app typed there and left unsubmitted. Spaces
 * count (only the box's own wrapping is ignored): an edit as small as one space removed makes it
 * the person's draft again.
 */
const ownText = (state: ComposerState, typed: string | undefined) =>
  typed !== undefined &&
  holdsText(state) &&
  state.whole &&
  // Composer text reported apart (Orca's `draft`, no width) is the text itself: compared as is.
  (state.width === undefined ? state.text === typed : sameWrapped(state.text, typed, state.width));

/**
 * The remembered reply, while this fresh look at the composer shows exactly it. Anything else
 * (empty, other or edited text, a partial or unreadable view) ends the claim for good: the
 * person submitted, cleared or changed it, and the same words typed later are theirs.
 */
function claimOwn(
  typed: ReturnType<typeof typedMemory>,
  key: string,
  state: ComposerState,
): string | undefined {
  const reply = typed.held(key);
  if (ownText(state, reply)) return reply;
  typed.drop(key);
  return undefined;
}

/**
 * Plain typed text only: escape sequences and other control characters never reach the pty.
 * `allowEmpty`: a message of images alone has no text.
 */
export function cleanInput(text: unknown, options: { allowEmpty?: boolean } = {}): string {
  if (typeof text !== 'string') throw new TerminalInputError(m().desktop.terminal.empty);
  const value = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim();
  if (!value && !options.allowEmpty) throw new TerminalInputError(m().desktop.terminal.empty);
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
        '#{pane_in_mode} #{pane_height} #{alternate_on} #{alternate-screen}',
      ]);
      const [mode, height, alternate, allowed] = state.trim().split(' ');
      if (mode !== '0') return { text: '' };
      const screen = parseStyledScreen(
        await deps.run(tmux, ['-S', host.socket, 'capture-pane', '-p', '-e', '-t', host.pane]),
      );
      // The pane height tells whether the prompt box may be scrolled (see maxBoxRows); only
      // Claude Code's fullscreen renderer (the alternate screen) scrolls it. With the pane's
      // `alternate-screen` option off, tmux draws that renderer on the main screen and
      // `#{alternate_on}` stays 0: the flag tells the renderer only while the option is on.
      return {
        ...screen,
        ...(/^\d+$/.test(height ?? '') && { height: Number(height) }),
        ...(allowed === '1' &&
          (alternate === '0' || alternate === '1') && { alternate: alternate === '1' }),
      };
    }
    const out = await deps.run(
      deps.bin('orca'),
      ['terminal', 'read', `--terminal=${host.handle}`, '--screen', '--limit=200', '--json'],
      { env: localOrcaEnv() },
    );
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
      { timeout: 20000, env: localOrcaEnv() },
    );
  } catch (error) {
    out = (error as { stdout?: string }).stdout ?? '';
    if (!/"accepted"\s*:\s*false/.test(out)) throw error;
  }
  const send = JSON.parse(out)?.result?.send;
  if (send?.accepted !== true) {
    const reason = typeof send?.refusedReason === 'string' ? ` (${send.refusedReason})` : '';
    const message = m().desktop.terminal.orcaRefused(reason);
    // Only an explicit refusal says the bytes never reached the terminal.
    throw send?.accepted === false ? new OrcaRefusal(message) : new TerminalInputError(message);
  }
}

/** Orca answered `accepted: false`: nothing it was given reached the terminal. */
class OrcaRefusal extends TerminalInputError {}

/** Puts the text in the prompt without submitting it. Line breaks stay inside the prompt. */
/** `delivering` runs right before the text may reach the pane (nothing before it can). */
async function typeText(
  host: TerminalHost,
  text: string,
  deps: TerminalDeps,
  delivering: () => void = () => {},
) {
  // Orca writes the bytes as they are: bracketed paste keeps tabs and line breaks as text.
  // cleanInput removed every ESC, so the text itself can never close the paste early.
  if (host.kind === 'orca') {
    delivering();
    return orcaSend(host, [`--text=\x1b[200~${text}\x1b[201~`], deps);
  }
  const tmux = deps.bin('tmux');
  const buffer = `agent-office-${randomUUID()}`;
  // stdin, not argv: tmux treats a trailing `;` in an argument as a command separator.
  await deps.run(tmux, ['-S', host.socket, 'load-buffer', '-b', buffer, '-'], { input: text });
  delivering();
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
  /**
   * Absolute paths of images to attach (files main saved itself, never paths from a renderer).
   * Pasted first, as one paste, and checked as attached before the text goes in.
   */
  images?: readonly string[];
}

/** An image path is pasted as is: absolute, one line, no control characters. */
const pastablePath = (file: string) =>
  path.isAbsolute(file) && !/[\u0000-\u001f\u007f-\u009f]/.test(file) && !/ \//.test(file);
/** Claude Code reads and resizes a pasted image before showing it: up to ~3 s here. */
const IMAGE_TRIES = 20;

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
type Memory = WeakMap<TerminalDeps, Map<string, { text: string; at: number }>>;
const backupsOf: Memory = new WeakMap();
/**
 * What this app typed into the composer and did not submit (its check failed, the state
 * changed), per session. That text is the person's own reply, not a draft of theirs: found again
 * exactly as typed by the very next look, it is not shown as a draft, and a retry of the same
 * text takes it back without asking or touching the clipboard. Any look that does not find it
 * exactly ends the claim (`claimOwn`).
 */
const typedOf: Memory = new WeakMap();
const backupMemory = (deps: TerminalDeps) => shortMemory(backupsOf, deps);
const typedMemory = (deps: TerminalDeps) => shortMemory(typedOf, deps);
function shortMemory(store: Memory, deps: TerminalDeps) {
  let memory = store.get(deps);
  if (!memory) store.set(deps, (memory = new Map()));
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
  const images = options.images ?? [];
  const text = cleanInput(input, { allowEmpty: images.length > 0 });
  const t = m().desktop.terminal;
  /** The same process, still on this session, open to input and in front of its terminal. */
  const current = () => stillLive(live, deps);
  // A leading `!` turns Claude's prompt into shell mode: the text would run as a command.
  if (text.startsWith('!')) throw new TerminalInputError(t.shellPrefix);
  // A send that waited its turn looks again: the one before may have ended or replaced the
  // session (`/clear`).
  if (waited && !(await current())) throw new TerminalInputError(t.stateChanged);
  if (!acceptsInput(live.process.status)) throw new TerminalInputError(t.notReady);
  if (!(await ownsTerminal(screenPid(live), deps))) throw new TerminalInputError(t.notOwner);
  // A background session's window may have switched to another job meanwhile.
  if (live.window && !(await current())) throw new TerminalInputError(t.stateChanged);
  const { host } = live;
  const key = live.process.sessionId;
  const memory = backupMemory(deps);
  const typed = typedMemory(deps);
  const where = host.kind === 'orca' ? 'Orca' : `tmux ${host.label}`;
  const composer = options.composer ?? claudeCodeComposer;
  const io = composerHost(host, deps);
  const can = composer.capabilities(io);
  // Typing into a terminal is only for agents whose composer can be read first.
  if (can.delivery !== 'terminal' || !can.canInspect)
    throw new TerminalInputError(t.unsupportedAgent(composer.agent));
  // Images only where the agent attaches a pasted path itself, and only paths it splits right.
  if (images.length && (can.images !== 'attach' || !images.every(pastablePath)))
    throw new TerminalInputError(t.imagesUnsupported);
  const state = await composer.inspect(io);
  // The reply an earlier send typed and could not submit, still shown exactly as typed.
  const reply = claimOwn(typed, key, state);
  if (state.kind === 'unreadable') throw new TerminalInputError(t.unreadable(hostName(host)));
  if (!holdsText(state)) {
    if (!readyToType(state)) throw new TerminalInputError(t.notReady);
    return submit(false);
  }
  // Taken back without asking or saving only for a retry of the very same text: what goes in
  // is exactly what is deleted, so nothing is lost even if the person typed those words.
  const own = can.canClear && reply !== undefined && reply === text;
  // Never mixed into a draft, or into text a failed send left behind.
  if (!can.canClear || (!options.backup && !own)) throw new TerminalInputError(t.draft);
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
  if (!own) {
    if (confirmed === undefined) return ask(state.text, state.whole);
    if (drawn(confirmed) !== drawn(state.text)) return ask(state.text, state.whole, true);
    if (!state.whole && !options.allowPartialDraft) return ask(state.text, false);
  }
  const backup = options.backup;
  try {
    const result = await composer.clear(
      io,
      state,
      async (text) => {
        // The app's own reply is not the person's draft: the clipboard keeps what it holds. Only
        // the reply itself: text seen beside it while clearing (someone typing, on Orca maybe
        // the suggestion) is saved like any draft, without the reply ahead of it — and with no
        // backup to save it to, the clearing stops there.
        let kept = text;
        if (own && reply !== undefined) {
          if (sameWrapped(text, reply, state.width)) return;
          if (!backup) throw new TerminalInputError(t.draft);
          if (text.startsWith(`${state.text}\n`)) kept = text.slice(state.text.length + 1);
        }
        if (!backup) return;
        // Never less than the earlier clearing saved; never more than that and this draft.
        const merged = mergeBackup(base, kept);
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
    if (own && result.status !== 'failed') typed.drop(key);
    // Text that was out of sight was never shown, so it is asked about as a partial draft.
    if (result.status === 'changed')
      return result.hidden ? ask(result.text, false) : ask(result.text, result.whole, true);
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
    if (images.length) await attachImages();
    else
      // Remembered once it may reach the pane: whatever happens next, the text may be in the
      // composer. A failure before that (tmux `load-buffer`) typed nothing, so nothing is the
      // app's: the same words typed by the person later are their draft.
      try {
        await typeText(host, text, deps, () => typed.keep(key, text));
      } catch (error) {
        // Orca refused the paste outright: none of it is in the composer. Any other failure
        // (a timeout, no answer) may have delivered it, so it stays the app's.
        if (error instanceof OrcaRefusal) typed.drop(key);
        throw error;
      }
    const holds = async () => {
      const screen = (await readScreen(host, deps)) ?? '';
      return images.length
        ? promptHoldsImages(screen, text, images, strict)
        : promptHolds(screen, text, strict);
    };
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
    typed.drop(key);
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

  /**
   * The images first: their paths as one paste, which Claude Code turns into `[Image #N]` (it
   * splits a paste at spaces before `/`). Only once the prompt holds exactly those, and nothing
   * else, does the text go in, as its own paste. What a send with images leaves behind is never
   * claimed as the app's own reply: the prompt shows placeholders, not the typed text, so a
   * retry asks about it like any draft.
   */
  async function attachImages() {
    typed.drop(key);
    await typeText(host, images.join(' '), deps);
    let attached: ReturnType<typeof readImages> = null;
    for (let tries = 0; attached?.rest !== '' && tries < IMAGE_TRIES; tries++) {
      await deps.wait(150);
      const screen = await readScreen(host, deps);
      const shown = screen ? readPrompt(screen) : null;
      attached = shown === null ? null : readImages(shown, images);
    }
    if (attached?.rest !== '') throw new TerminalInputError(t.imagesNotShown);
    // A path Claude left as text would run into the text: a space between (checked on Enter).
    if (text) await typeText(host, attached.lastPath ? ` ${text}` : text, deps);
  }
}
