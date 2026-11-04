import path from 'node:path';
import { stat } from 'node:fs/promises';
import { remember, runCommand } from '../server/adapters/claude-live.js';
import { m } from '../src/shared/i18n/index.js';
import type { DuplicateCheck, OrcaLaunchInfo, Session } from '../src/shared/types.js';
import { PendingLaunches, type PendingLaunchTarget } from './pending-launch.js';
import { defaultResumeDeps } from './tmux-resume.js';
import { localOrcaEnv, ORCA_LIST_LIMIT, ORCA_LIST_BUFFER } from './terminal-host.js';
import { agentLauncher, agentWords, chooseSessionId } from './launch/agents.js';
import { parseWorktreePs, type OrcaPsWorkspace } from './orca-sleeping.js';
import {
  launchQueue,
  runLaunch,
  startOrThrow,
  type Destination,
  type DestinationProbe,
  type DestinationStart,
  type LaunchQueue,
  type StartContext,
} from './launch/pipeline.js';
export { localOrcaEnv };

/**
 * Starts a conversation in a new Orca terminal tab (`orca terminal create`): a saved one resumed,
 * a new one summoned, or a fork. Orca types `--command` into the tab's login shell, so every
 * word of it is checked against a plain character set and single-quoted (the first prompt is
 * quoted whole); nothing else from the session reaches that shell. The folder and title go to
 * Orca as separate arguments, never through a shell. The agent's words come from the shared
 * agent adapter (desktop/launch/agents.ts), the same as a tmux launch.
 */
export type OrcaLaunchSession = Pick<Session, 'provider' | 'nativeId' | 'cwd'> &
  Partial<Pick<Session, 'title' | 'alias' | 'remote'>> & {
    /** The person's `tmuxSkipPermissions`: the same agent flags as a tmux launch. */
    skipPermissions?: boolean;
    fresh?: boolean;
    /** A fork of `nativeId` (a new conversation branched off it). */
    fork?: boolean;
    /** new / fork: the conversation id chosen up front (Claude `--session-id`). */
    sessionId?: string;
    initialMessage?: string;
    background?: boolean;
    /** Locally resolved CLI; never supplied by a remote request. */
    executable?: string;
  };

export interface OrcaLaunchDeps {
  run: typeof runCommand;
  /** The Orca CLI's absolute path, or a bare name when it is not installed. */
  orca: () => string;
  directory: (cwd: string) => Promise<boolean>;
  platform: string;
  /** Agent Office's own environment: the agent home it reads conversations from. */
  env?: NodeJS.ProcessEnv;
  /**
   * The agent CLI's absolute path, resolved the same way as a tmux launch; it throws when not
   * found, and the tab's login shell then looks the bare name up on its own PATH.
   */
  binary?: (name: string) => Promise<string>;
  /** Waits between looks for a tab whose start Orca did not confirm (tests skip the wait). */
  wait?: (ms: number) => Promise<void>;
  /** Launches that may still start: shared with the duplicate-launch check. */
  pending?: PendingLaunches;
  /** The launch queue (desktop/launch/pipeline.ts); the app's own one when left out. */
  queue?: LaunchQueue;
}

/** Orca's worst case is 10 s for the tab plus 10 s for its terminal, after its own CLI start. */
const CREATE_TIMEOUT = 35_000;
/** After an unconfirmed start, look for its terminal every 2 s for about 30 s. */
const ADOPT_EVERY = 2000;
export const ADOPT_LOOKS = 15;

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
/** Words the shell reads literally even unquoted; anything else is refused, not escaped. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One single-quoted shell word. */
export function shellWord(word: string): string {
  if (!word || CONTROL.test(word) || !PLAIN.test(word)) throw new Error(m().tmux.unsupported);
  return `'${word}'`;
}

/**
 * Single quotes around any text: an embedded `'` closes the quote, is written as `"'"` and
 * reopens it. The shell reads `'\''` the same, but Orca reads the command's leading words with a
 * tokenizer that knows quotes and not `\` (to find the agent behind `env`): with `"'"` it splits
 * the words exactly as the shell does.
 */
const quoted = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;

/**
 * A single-quoted shell word for a value that may hold spaces or quotes (a folder path); control
 * characters are refused.
 */
export function shellQuote(value: string): string {
  if (!value || CONTROL.test(value)) throw new Error(m().tmux.unsupported);
  return quoted(value);
}

/**
 * `env`'s own option that starts the agent in `folder` (`-C<folder>`, attached) as ONE word, so
 * Orca skips it as an `env` option and still finds the agent after it.
 */
export function chdirWord(folder: string): string {
  if (!folder || !path.isAbsolute(folder) || CONTROL.test(folder))
    throw new Error(m().tmux.folderMissing);
  return quoted(`-C${folder}`);
}

/**
 * The agent's home as Agent Office sees it, so the new tab resumes from the same place: set to
 * Agent Office's value, or unset (the default home) when Agent Office has none, whatever the
 * login shell exports. The same rule as a tmux launch. `chdir`: the folder the agent starts in
 * when it is not the tab's own (`env -C`, an option, so before any `NAME=value`).
 */
function homeWords(
  provider: Session['provider'],
  env: NodeJS.ProcessEnv,
  chdir?: string,
): string[] {
  const name = agentLauncher(provider).home;
  if (!name) throw new Error(m().tmux.orcaUnsupported);
  const into = chdir ? [chdirWord(chdir)] : [];
  const value = env[name];
  if (!value) return [...['/usr/bin/env', '-u', name].map(shellWord), ...into];
  if (!path.isAbsolute(value)) throw new Error(m().tmux.unsupported);
  return [shellWord('/usr/bin/env'), ...into, shellQuote(`${name}=${value}`)];
}

const kindOf = (s: Pick<OrcaLaunchSession, 'fresh' | 'fork'>) =>
  s.fork ? ('fork' as const) : s.fresh ? ('new' as const) : ('resume' as const);

/**
 * The command a login shell runs for this launch, as single-quoted words: the agent's home, the
 * agent (`executable` when given), its words from the shared adapter and the first prompt.
 * Shared by an Orca tab, a Terminal.app window and a copied command. `chdir`: start the agent in
 * that folder rather than the shell's own (an Orca tab opens at its worktree's root; the
 * conversation may live in a folder inside it).
 */
export function shellCommand(
  s: Pick<
    OrcaLaunchSession,
    | 'provider'
    | 'nativeId'
    | 'fresh'
    | 'fork'
    | 'sessionId'
    | 'initialMessage'
    | 'skipPermissions'
    | 'executable'
  >,
  env: NodeJS.ProcessEnv = process.env,
  chdir?: string,
): string {
  // The resolved CLI, as a tmux launch runs it; without one the login shell looks the agent up
  // on its own PATH, as if the person typed it there.
  if (s.executable && !path.isAbsolute(s.executable)) throw Error(m().tmux.unsupported);
  const agent = s.executable ? shellQuote(s.executable) : shellWord(s.provider);
  const words = agentWords({ ...s, kind: kindOf(s) });
  return [
    ...homeWords(s.provider, env, chdir),
    agent,
    ...words.args.map(shellWord),
    // The prompt keeps its line breaks: only `'` is closed, quoted and reopened.
    ...(words.message !== undefined ? [shellWord('--'), quoted(words.message)] : []),
  ].join(' ');
}

/** Folder boundaries only: `/a/bc` is not inside `/a/b`. */
const inside = (root: string, folder: string) =>
  folder.startsWith(root === path.sep ? root : root + path.sep);

/**
 * The launch in Orca's terms. `cwd`: the conversation's folder; `root`: the Orca worktree the tab
 * opens in (`root` given: the worktree holding `cwd`, else `cwd` itself). Orca cannot open a tab
 * anywhere but at a worktree's root, so a conversation in a folder inside it starts its agent
 * there through `env -C` (`chdirWord`), every other word unchanged.
 */
function describe(
  s: OrcaLaunchSession,
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
  root?: string,
) {
  if (
    platform !== 'darwin' ||
    s.remote ||
    (s.provider !== 'claude' && s.provider !== 'codex') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(s.nativeId)
  )
    throw new Error(m().tmux.orcaUnsupported);
  if (!s.cwd || !path.isAbsolute(s.cwd) || CONTROL.test(s.cwd))
    throw new Error(m().tmux.folderMissing);
  const cwd = path.resolve(s.cwd);
  const worktree = root === undefined ? cwd : path.resolve(root);
  if (
    root !== undefined &&
    (!path.isAbsolute(root) || CONTROL.test(root) || (worktree !== cwd && !inside(worktree, cwd)))
  )
    throw new Error(m().tmux.orcaNotWorkspace);
  const command = shellCommand(s, env, worktree === cwd ? undefined : cwd);
  const shown = (s.alias || s.title || '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = shown.slice(0, 60) || `${s.provider} ${s.nativeId.slice(0, 8)}`;
  return { cwd, root: worktree, command, name };
}

/**
 * The `orca` arguments for the launch; `--flag=value` so no value can pose as an option. `root`:
 * the Orca worktree holding the conversation's folder when that folder is inside it, not its own.
 */
export function orcaCreateArgs(
  s: OrcaLaunchSession,
  platform = 'darwin',
  env: NodeJS.ProcessEnv = process.env,
  root?: string,
): string[] {
  return createArgs(describe(s, platform, env, root), s.background);
}

function createArgs(
  { root, command, name }: { root: string; command: string; name: string },
  background?: boolean,
): string[] {
  return [
    'terminal',
    'create',
    `--worktree=path:${root}`,
    `--title=${name}`,
    `--command=${command}`,
    ...(background ? [] : ['--focus']),
    '--json',
  ];
}

/** Orca's own explanation of a refusal, as plain one-line text. */
export function orcaRefusal(stdout: string | undefined): string {
  try {
    const error = JSON.parse(stdout ?? '')?.error;
    const step = Array.isArray(error?.data?.nextSteps) ? error.data.nextSteps[0] : undefined;
    const reason = [step, error?.message, error?.code].find(
      (x): x is string => typeof x === 'string' && !!x.trim(),
    );
    return reason ? reason.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').slice(0, 300) : '';
  } catch {
    return '';
  }
}

/**
 * What a `terminal create` answer says about the tab:
 * - `launched`: Orca confirmed the terminal.
 * - `uncertain`: Orca made the tab and queued the command but did not see its terminal in time
 *   (a window behind others or on another Space mounts the tab late), or the call was cut off
 *   before Orca answered. Orca does not cancel that tab: it starts once Orca shows it.
 * - `refused`: Orca said why it made nothing; `workspace` when the reason is the folder itself.
 */
export type OrcaCreateResult =
  | { kind: 'launched' }
  | { kind: 'uncertain' }
  | { kind: 'refused'; reason: string; workspace: boolean };

/** Orca's own "made the tab, its terminal did not appear in time" answers. */
const NOT_YET_STARTED =
  /Timed out waiting for terminal handle|Terminal creation timed out|^runtime_timeout$/i;
/** Refusals that name the folder: no Orca workspace matched it. */
const NOT_A_WORKSPACE = /^(selector_not_found|worktree_not_found|worktree_host_unresolved)$/;

/** Our own time limit ended a call before it answered (`execFile` killed it). */
export const cutOff = (error: unknown) => {
  const cut = error as { killed?: unknown; signal?: unknown; code?: unknown } | undefined;
  return cut?.killed === true || !!cut?.signal || cut?.code === 'ETIMEDOUT';
};

export function classifyOrcaCreate(stdout: string | undefined, error?: unknown): OrcaCreateResult {
  let answer: { ok?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
  try {
    answer = JSON.parse(stdout ?? '') ?? {};
  } catch {
    answer = {};
  }
  if (!error && answer.ok === true) return { kind: 'launched' };
  const e = answer.error;
  const steps = (e?.data as { nextSteps?: unknown } | undefined)?.nextSteps;
  const texts = [e?.code, e?.message, ...(Array.isArray(steps) ? steps : [])].filter(
    (x): x is string => typeof x === 'string',
  );
  if (texts.some((x) => NOT_YET_STARTED.test(x))) return { kind: 'uncertain' };
  // Our own time limit ended the call before Orca answered: whether it made the tab is unknown.
  if (!e && cutOff(error)) return { kind: 'uncertain' };
  return {
    kind: 'refused',
    reason: orcaRefusal(stdout),
    workspace: typeof e?.code === 'string' && NOT_A_WORKSPACE.test(e.code),
  };
}

/**
 * Whether the folder is a registered workspace on this Orca host: `local` yes; `subfolder` when
 * it lies inside one (`root`, the deepest: the tab opens there and the agent starts in the
 * folder); `none` when no local workspace holds it; `unknown` when Orca did not answer.
 */
export type WorkspaceCheck =
  { kind: 'local' } | { kind: 'subfolder'; root: string } | { kind: 'none' } | { kind: 'unknown' };

/**
 * Orca itself: `ready` (installed, its runtime answering), `missing` (no Orca CLI here),
 * `stopped` (Orca answered that its runtime is not running, or failed), `slow` (no answer in
 * time). Only `ready` takes a launch; the others are the reason shown for it.
 */
export type OrcaRuntime = 'ready' | 'missing' | 'stopped' | 'slow';

type OrcaWorktree = { path?: unknown; hostId?: unknown; identity?: { executionHostId?: unknown } };
const isLocal = (w: OrcaWorktree) =>
  (w.identity?.executionHostId ?? w.hostId) === 'local' && (!w.hostId || w.hostId === 'local');

/** One Orca terminal as `terminal list` reports it. */
interface OrcaTerminalRow {
  handle: string;
  title?: unknown;
  worktreePath?: unknown;
}

/**
 * What an Orca probe carries to its start: `info.cwd` the conversation's folder, `info.root` the
 * worktree the tab opens in (that folder, or the worktree holding it), `info.command` what the
 * tab types (the confirmation shows it as is).
 */
export interface OrcaPlan {
  session: OrcaLaunchSession;
  info: { cwd: string; root: string; command: string; name: string };
}

const defaults = (orca: () => string): OrcaLaunchDeps => ({
  run: runCommand,
  orca,
  directory: async (cwd) => (await stat(cwd).catch(() => null))?.isDirectory() ?? false,
  platform: process.platform,
  binary: defaultResumeDeps.binary,
});

export class OrcaLaunch {
  private deps: OrcaLaunchDeps;
  /** Launches Orca did not confirm, read by the duplicate-launch check for a while. */
  readonly pending: PendingLaunches;
  constructor(deps: OrcaLaunchDeps | (() => string)) {
    this.deps = typeof deps === 'function' ? defaults(deps) : deps;
    this.pending = this.deps.pending ?? new PendingLaunches();
  }
  private async json(args: string[], timeout = 5000): Promise<Record<string, unknown>> {
    return JSON.parse(
      await this.deps.run(this.deps.orca(), args, {
        timeout,
        env: localOrcaEnv(this.deps.env ?? process.env),
      }),
    );
  }
  /** The registered workspace for the folder: checked for resumes and fresh summons alike. */
  async workspace(s: Pick<OrcaLaunchSession, 'cwd'>): Promise<WorkspaceCheck> {
    const cwd = path.resolve(s.cwd!);
    try {
      const result = await this.json(['worktree', 'show', `--worktree=path:${cwd}`, '--json']);
      const w = (result?.result as { worktree?: OrcaWorktree } | undefined)?.worktree;
      // Its own folder, here or on another host. Another worktree's answer (one holding the
      // folder) leaves it to the list below, which names the deepest local one.
      if (result?.ok === true && w && w.path === cwd)
        return isLocal(w) ? { kind: 'local' } : { kind: 'none' };
    } catch {
      /* Not a workspace of its own, or Orca did not answer: the list below tells which. */
    }
    try {
      const result = await this.json(['worktree', 'list', '--limit=10000', '--json']);
      const rows = (result?.result as { worktrees?: unknown } | undefined)?.worktrees;
      if (result?.ok !== true || !Array.isArray(rows)) return { kind: 'unknown' };
      let root = '';
      for (const w of rows as OrcaWorktree[]) {
        if (typeof w?.path !== 'string' || !path.isAbsolute(w.path) || !isLocal(w)) continue;
        const folder = path.resolve(w.path);
        // Its own folder that `worktree show` did not confirm: Orca could not tell, nor can we.
        if (folder === cwd) return { kind: 'unknown' };
        if (inside(folder, cwd) && folder.length > root.length) root = folder;
      }
      return root ? { kind: 'subfolder', root } : { kind: 'none' };
    } catch {
      return { kind: 'unknown' };
    }
  }
  /** Orca installed and its runtime answering (`orca status`), checked at most every 5 s. */
  runtime(fresh = false): Promise<OrcaRuntime> {
    return remember(this, 'orca-status', 5000, fresh, async () => {
      if (!path.isAbsolute(this.deps.orca())) return 'missing';
      try {
        const status = await this.json(['status', '--json']);
        return status?.ok === true &&
          (status.result as { runtime?: { reachable?: unknown } } | undefined)?.runtime
            ?.reachable === true
          ? 'ready'
          : 'stopped';
      } catch (error) {
        return cutOff(error) ? 'slow' : 'stopped';
      }
    });
  }
  async reachable(fresh = false): Promise<boolean> {
    return (await this.runtime(fresh)) === 'ready';
  }
  /**
   * Every local workspace with its agents (`orca worktree ps`), sleeping ones included, for the
   * duplicate check of a resume (desktop/orca-sleeping.ts). Read-only, asked at most every 3 s;
   * null when Orca is missing, stopped or did not answer in time (never a reason to block).
   */
  workspaces(fresh = false): Promise<OrcaPsWorkspace[] | null> {
    return remember(this, 'orca-ps', 3000, fresh, async () => {
      if (!path.isAbsolute(this.deps.orca())) return null;
      try {
        const answer = await this.deps.run(this.deps.orca(), ['worktree', 'ps', '--json'], {
          timeout: 4000,
          maxBuffer: ORCA_LIST_BUFFER,
          env: localOrcaEnv(this.deps.env ?? process.env),
        });
        return parseWorktreePs(JSON.parse(answer));
      } catch {
        return null;
      }
    });
  }
  /** Brings Orca to the front, where it mounts the tab it shows (and so starts its command). */
  async reveal(): Promise<void> {
    if (this.deps.platform !== 'darwin') return;
    await this.deps.run('/usr/bin/open', ['-a', 'Orca'], { timeout: 5000 }).catch(() => '');
  }
  /**
   * The agent CLI resolved as for tmux. Orca still recognizes an interactive agent by the file
   * name of the command's program (`claude`, `codex`), so only such a path is used; otherwise
   * the tab's login shell finds the agent on its own PATH, as before.
   */
  async resolved(s: OrcaLaunchSession): Promise<OrcaLaunchSession> {
    if (s.executable || !this.deps.binary) return s;
    try {
      const executable = await this.deps.binary(s.provider);
      return path.isAbsolute(executable) && path.basename(executable) === s.provider
        ? { ...s, executable }
        : s;
    } catch {
      return s;
    }
  }
  /** The worktree's terminals now; `complete` only when Orca listed every one of them. */
  private async terminals(cwd: string) {
    try {
      const result = JSON.parse(
        await this.deps.run(
          this.deps.orca(),
          ['terminal', 'list', `--worktree=path:${cwd}`, `--limit=${ORCA_LIST_LIMIT}`, '--json'],
          {
            timeout: 5000,
            maxBuffer: ORCA_LIST_BUFFER,
            env: localOrcaEnv(this.deps.env ?? process.env),
          },
        ),
      );
      const list = (result?.result ?? {}) as { terminals?: unknown; truncated?: unknown };
      const rows = (Array.isArray(list.terminals) ? list.terminals : []).filter(
        (t): t is OrcaTerminalRow =>
          typeof t?.handle === 'string' &&
          (typeof t.worktreePath !== 'string' ||
            !t.worktreePath ||
            path.resolve(t.worktreePath) === cwd),
      );
      return {
        rows,
        complete: result?.ok === true && Array.isArray(list.terminals) && list.truncated !== true,
      };
    } catch {
      return { rows: [] as OrcaTerminalRow[], complete: false };
    }
  }
  /**
   * The terminal of a tab whose start Orca did not confirm: a handle of the same worktree that
   * the list taken before creating it did not have (so that list must be whole), titled as the
   * launch. Only the title ties a terminal to this launch: a new untitled one may be any tab the
   * person opened meanwhile, so it is never adopted and the start stays unconfirmed.
   */
  private async adopt(
    info: { root: string; name: string },
    before: { handles: Set<string>; complete: boolean },
  ): Promise<string | undefined> {
    // A terminal missing from a cut-short earlier list is not new: titles repeat (reopening the
    // same conversation), so nothing is adopted without a whole baseline.
    if (!before.complete) return undefined;
    const wait = this.deps.wait ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    for (let look = 0; look < ADOPT_LOOKS; look++) {
      await wait(ADOPT_EVERY);
      const titled = (await this.terminals(info.root)).rows.find(
        (t) => !before.handles.has(t.handle) && t.title === info.name,
      );
      if (titled) return titled.handle;
    }
    return undefined;
  }
  /**
   * Read-only, for the launch pipeline: whether this folder can take a new tab now, with the
   * reason when not (Orca missing, stopped or slow; in no local workspace). A folder inside a
   * workspace takes a tab at the workspace, its agent started in the folder. `fresh`
   * asks Orca again instead of its answer of the last 5 s. `workspace`: the reason is the
   * folder (the older status shows only that one).
   */
  async probe(
    s: OrcaLaunchSession,
    fresh = false,
  ): Promise<DestinationProbe<OrcaPlan> & { workspace?: true }> {
    const t = m().tmux;
    const l = m().launch;
    try {
      const session = await this.resolved(s);
      const own = describe(session, this.deps.platform, this.deps.env);
      const unavailable = (reason: string) => ({ available: false, reason });
      if (!(await this.deps.directory(own.cwd))) return unavailable(t.folderMissing);
      const runtime = await this.runtime(fresh);
      if (runtime !== 'ready')
        return unavailable(
          runtime === 'missing' ? l.orcaMissing : runtime === 'slow' ? l.orcaSlow : l.orcaStopped,
        );
      const check = await this.workspace(session);
      if (check.kind === 'none') return { ...unavailable(t.orcaNotWorkspace), workspace: true };
      if (check.kind === 'unknown') return unavailable(l.orcaUnknownWorkspace);
      const info =
        check.kind === 'subfolder'
          ? describe(session, this.deps.platform, this.deps.env, check.root)
          : own;
      return { available: true, command: info.command, detail: { session, info } };
    } catch (error) {
      return { available: false, reason: (error as Error).message };
    }
  }
  /**
   * Read-only: whether the action can be offered, and the command it would type. Only a reason
   * about the folder is given (the older sheets hide the Orca button otherwise).
   */
  async status(s: OrcaLaunchSession): Promise<OrcaLaunchInfo> {
    const probe = await this.probe(s);
    if (probe.available) return { available: true, command: probe.command };
    return probe.workspace ? { available: false, reason: probe.reason } : { available: false };
  }
  /**
   * Creates the tab (after the pipeline's confirmation) from the plan its probe just made. A
   * start Orca did not confirm is held pending and looked for (`adopt`); still unseen, it is
   * answered as `uncertain`, never as a refusal: its tab starts once Orca shows it.
   */
  async create(
    _s: OrcaLaunchSession,
    context: Pick<StartContext<OrcaPlan>, 'probe' | 'authorized' | 'hold'>,
  ): Promise<DestinationStart<OrcaLaunchInfo>> {
    const t = m().tmux;
    const { session, info } = context.probe.detail!;
    const before = await this.terminals(info.root);
    // Last moment before create: the listing above may take seconds while access is revoked.
    context.authorized?.();
    let out: string | undefined;
    let failure: unknown;
    try {
      out = await this.deps.run(
        this.deps.orca(),
        // The very command the confirmation showed, in the worktree the probe found.
        createArgs(info, session.background),
        { timeout: CREATE_TIMEOUT, env: localOrcaEnv(this.deps.env ?? process.env) },
      );
    } catch (error) {
      failure = error ?? new Error('failed');
      out = (error as { stdout?: string } | undefined)?.stdout;
    }
    const result = classifyOrcaCreate(out, failure);
    if (result.kind === 'refused') throw new Error(t.orcaRefused(result.reason, result.workspace));
    const launched: DestinationStart<OrcaLaunchInfo> = {
      state: 'launched',
      message: t.orcaLaunched,
      command: info.command,
      detail: { available: true, command: info.command, launched: true, message: t.orcaLaunched },
    };
    if (result.kind === 'launched') return launched;
    // Guard against a second start of this conversation while the tab is looked for.
    context.hold();
    // The person asked for this tab: Orca in front mounts it, which starts its command. A
    // background (remote) launch answers at once: its caller's request has its own deadline.
    if (!session.background) await this.reveal();
    const handle = session.background
      ? undefined
      : await this.adopt(info, {
          handles: new Set(before.rows.map((row) => row.handle)),
          complete: before.complete,
        });
    if (handle) {
      await this.deps
        .run(this.deps.orca(), ['terminal', 'switch', `--terminal=${handle}`, '--json'], {
          timeout: 8000,
          env: localOrcaEnv(this.deps.env ?? process.env),
        })
        .catch(() => '');
      return launched;
    }
    return {
      state: 'uncertain',
      message: t.orcaUncertain,
      command: info.command,
      detail: {
        available: true,
        command: info.command,
        launched: false,
        uncertain: true,
        message: t.orcaUncertain,
      },
    };
  }
  /** Orca as a launch destination of this session alone (the older entry points, tests). */
  private destination(): Destination<OrcaLaunchSession, OrcaPlan, OrcaLaunchInfo> {
    return {
      id: 'orca',
      launches: true,
      place: 'orca',
      reserves: true,
      probe: (s, fresh) => this.probe(s, fresh),
      start: (s, context) => this.create(s, context),
    };
  }
  /**
   * The launch pipeline (desktop/launch/pipeline.ts) for this one destination. `duplicate`: the
   * fresh duplicate-launch check (desktop/launch-guard.ts), run before the confirmation and
   * again after it; a conversation already running is never launched. A refusal throws.
   */
  async start(
    s: OrcaLaunchSession,
    confirm: (
      info: { name: string; cwd: string; command: string },
      duplicate: DuplicateCheck,
    ) => Promise<boolean>,
    authorized?: () => void,
    duplicate?: (fresh: boolean) => Promise<DuplicateCheck>,
  ): Promise<OrcaLaunchInfo> {
    // A new conversation's id where the agent takes one, fixed before the confirmation shows
    // the command (and the same one is typed).
    const session =
      (s.fresh || s.fork) && !s.sessionId
        ? { ...s, sessionId: chooseSessionId({ kind: kindOf(s), provider: s.provider }) }
        : s;
    const result = await startOrThrow(
      runLaunch(this.destination(), session, {
        queue: this.deps.queue ?? launchQueue,
        pending: this.pending,
        // A fresh summon is known by its agent, folder and name (its tmux summon is the same one).
        key: { ...session, name: session.alias ?? '' } satisfies PendingLaunchTarget,
        check: duplicate,
        confirm: (probe, check) => confirm(probe.detail!.info, check),
        authorized,
      }),
    );
    if ('detail' in result && result.detail) return result.detail;
    return { available: true, command: result.probe.command, launched: false };
  }
}
